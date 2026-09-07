/** Host-owned configuration only; no request-selected path or environment grant. */
import {constants,openSync,closeSync,readSync,fstatSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import {reviewedConfig,strict,requireThat as need} from '../memory/whatsapp-approve-proof.js';
const MAX_FILE=32768,MAX_MOUNTS=1024*1024;
function readBounded(fd:number,max:number):Buffer {
 const b=Buffer.alloc(max+1);let n=0;
 while(n<b.length){const got=readSync(fd,b,n,b.length-n,null);if(!got)break;n+=got;}
 need(n<=max,'configuration_unavailable');return b.subarray(0,n);
}
function utf8(bytes:Buffer):string {
 try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{need(false,'configuration_unavailable');throw new Error('configuration_unavailable');}
}
function mountPath(s:string):string {
 // Kernel mountinfo permits precisely these escapes. Reject everything else,
 // including decoded line separators and noncanonical/relative path segments.
 need(!/\\(?!040|011|012|134)/.test(s),'configuration_unavailable');
 const out=s.replace(/\\(040|011|012|134)/g,(_,n)=>String.fromCharCode(parseInt(n,8)));
 need(!/[\u0000-\u001f\u007f]/.test(out) && isAbsolute(out) && resolve(out)===out,'configuration_unavailable');return out;
}
/** Exact mount directory must be independently mounted read-only. A file bind
 * would retain its old inode across host atomic replacement and is rejected.
 */
export function assertReadOnlyConfigDirectory(mountInfo:string,directory:string):void {
 need(Buffer.byteLength(mountInfo)<=MAX_MOUNTS && mountInfo.endsWith('\n') && !mountInfo.endsWith('\n\n'),'configuration_unavailable');
 const mounts:Array<{point:string,readOnly:boolean}>=[];const ids=new Set();
 for(const line of mountInfo.slice(0,-1).split('\n')){
  const halves=line.split(' - ');need(halves.length===2,'configuration_unavailable');
  const left=halves[0].split(' '),right=halves[1].split(' ');
  need(left.length>=6 && right.length===3 && /^[1-9][0-9]*$/.test(left[0]) && /^[0-9]+$/.test(left[1])
    && /^[0-9]+:[0-9]+$/.test(left[2]) && !ids.has(left[0]),'configuration_unavailable');ids.add(left[0]);
  need(left.slice(6).every(x=>/^(?:shared|master|propagate_from):[1-9][0-9]*$/.test(x)||x==='unbindable') && new Set(left.slice(6)).size===left.length-6
    && /^[A-Za-z0-9_.-]+$/.test(right[0]) && right[1].length>0 && right[2].length>0,'configuration_unavailable');
  mountPath(left[3]);const point=mountPath(left[4]),options=left[5].split(',');
  need(options.every(x=>/^[A-Za-z0-9_=.-]+$/.test(x)) && new Set(options).size===options.length
    && options.includes('ro')!==options.includes('rw'),'configuration_unavailable');
  mounts.push({point,readOnly:options.includes('ro')});
 }
 const exact=mounts.filter(m=>m.point===directory);need(exact.length===1 && exact[0].readOnly,'configuration_unavailable');
 // No nested file mount or duplicate covered path can hide directory rotation.
 need(!mounts.some(m=>m.point.startsWith(directory+'/')),'configuration_unavailable');
}
function mounts(directory:string):string {
 const fd=openSync('/proc/self/mountinfo',constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const raw=utf8(readBounded(fd,MAX_MOUNTS));assertReadOnlyConfigDirectory(raw,directory);return raw;}finally{closeSync(fd);}
}
type Metadata=ReturnType<typeof metadata>;
function metadata(pathOrFd:string|number){return typeof pathOrFd==='string'?lstatSync(pathOrFd,{bigint:true}):fstatSync(pathOrFd,{bigint:true});}
function same(a:Metadata,b:Metadata):boolean {
 return (['dev','ino','size','mode','uid','gid','nlink','mtimeNs','ctimeNs'] as const).every(k=>a[k]===b[k]);
}
export function createReviewedWhatsAppConfigLoader(path:string):()=>unknown {
 need(typeof path==='string' && isAbsolute(path) && resolve(path)===path && !/[\u0000-\u001f\u007f]/.test(path),'configuration_unavailable');
 const directory=dirname(path);need(directory!=='/','configuration_unavailable');
 return()=>{
  need(realpathSync(directory)===directory && realpathSync(path)===path,'configuration_unavailable');
  const uid=process.getuid?.();need(uid!==undefined,'configuration_unavailable');
  const dir=metadata(directory);need(dir.isDirectory() && dir.uid===BigInt(uid) && (dir.mode&0o7777n)===0o700n,'configuration_unavailable');
  const mountBefore=mounts(directory);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const before=metadata(fd);need(before.isFile() && before.nlink===1n && before.uid===BigInt(uid) && (before.mode&0o7777n)===0o600n
     && before.size>0n && before.size<=BigInt(MAX_FILE),'configuration_unavailable');
   const bytes=readBounded(fd,MAX_FILE);
   // Strict compact JSON rejects duplicates; reviewedConfig validates/copies/freezes
   // all six fields and current expiry. Native factory compares this projection.
   const config=reviewedConfig(strict(utf8(bytes)));
   const after=metadata(fd),current=metadata(path),currentDir=metadata(directory);
   need(BigInt(bytes.length)===before.size && same(before,after) && same(after,current) && same(dir,currentDir)
     && realpathSync(path)===path && realpathSync(directory)===directory && mounts(directory)===mountBefore,'configuration_unavailable');
   return config;
  }finally{closeSync(fd);}
 };
}
