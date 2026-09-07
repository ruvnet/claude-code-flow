// Real files/permissions and atomic replacement; only mountinfo is synthetic here.
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
const hook=vi.hoisted(()=>({mountFile:'',afterRead:null as null|(()=>void)}));
vi.mock('node:fs',async original=>{
 const actual=await original<typeof import('node:fs')>();
 return {...actual,openSync:(path:any,...args:any[])=>actual.openSync(path==='/proc/self/mountinfo'?hook.mountFile:path,...args as [any]),
  readSync:(...args:any[])=>{const n=(actual.readSync as any)(...args);if(hook.afterRead){const f=hook.afterRead;hook.afterRead=null;f();}return n;}};
});
import {createReviewedWhatsAppConfigLoader} from '../src/mcp-tools/private-whatsapp-config.js';
let root:string,dir:string,path:string,config:any;
beforeEach(()=>{root=fs.mkdtempSync(join(tmpdir(),'private-config-test-'));dir=join(root,'config');fs.mkdirSync(dir,{mode:0o700});path=join(dir,'current.json');
 const pub=()=>generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).subarray(12).toString('base64url');
 config={subject:'fixture-api',epoch:'one',revision:'one',expiresAt:Date.now()+60000,attesterPublicKey:pub(),humanPublicKeys:{human:pub()}};
 fs.writeFileSync(path,JSON.stringify(config),{mode:0o600});hook.mountFile=join(root,'mountinfo');fs.writeFileSync(hook.mountFile,`10 1 8:1 / / rw - ext4 /dev/root rw\n11 10 8:1 /fixture ${dir} ro - ext4 /dev/root rw\n`);
 hook.afterRead=null;
});
afterEach(()=>{hook.afterRead=null;fs.chmodSync(dir,0o700);fs.rmSync(root,{recursive:true,force:true});});
it('returns separately owned config and observes host atomic replacement at same directory path',()=>{const load=createReviewedWhatsAppConfigLoader(path);const first:any=load();expect(Object.isFrozen(first)).toBe(true);expect(first).toEqual(config);
 fs.writeFileSync(join(dir,'next'),JSON.stringify({...config,revision:'two'}),{mode:0o600});fs.renameSync(join(dir,'next'),path);expect((load() as any).revision).toBe('two');expect(first.revision).toBe('one');});
for(const mode of [0o400,0o700,0o640,0o1600])it(`denies file mode ${mode.toString(8)}`,()=>{fs.chmodSync(path,mode);expect(()=>createReviewedWhatsAppConfigLoader(path)()).toThrow();});
for(const mode of [0o500,0o750,0o1700])it(`denies directory mode ${mode.toString(8)}`,()=>{fs.chmodSync(dir,mode);expect(()=>createReviewedWhatsAppConfigLoader(path)()).toThrow();});
it('denies hard-linked config and symlink replacement',()=>{fs.linkSync(path,join(dir,'linked'));expect(()=>createReviewedWhatsAppConfigLoader(path)()).toThrow();fs.unlinkSync(path);fs.symlinkSync(join(dir,'linked'),path);expect(()=>createReviewedWhatsAppConfigLoader(path)()).toThrow();});
it('denies directory metadata change during load',()=>{hook.afterRead=()=>fs.chmodSync(dir,0o750);expect(()=>createReviewedWhatsAppConfigLoader(path)()).toThrow('configuration_unavailable');});
it('denies mount evidence changing while loading',()=>{hook.afterRead=()=>fs.writeFileSync(hook.mountFile,fs.readFileSync(hook.mountFile,'utf8').replace(`${dir} ro`,`${dir} rw`));expect(()=>createReviewedWhatsAppConfigLoader(path)()).toThrow('configuration_unavailable');});
it('denies unknown or duplicate config keys and oversized files',()=>{fs.writeFileSync(path,JSON.stringify({...config,projectRoot:'/caller'}));expect(()=>createReviewedWhatsAppConfigLoader(path)()).toThrow();fs.writeFileSync(path,JSON.stringify(config).replace('"epoch":"one"','"epoch":"one","epoch":"two"'));expect(()=>createReviewedWhatsAppConfigLoader(path)()).toThrow();fs.writeFileSync(path,'x'.repeat(32769));expect(()=>createReviewedWhatsAppConfigLoader(path)()).toThrow();});

it('denies malformed UTF-8 mount evidence and configuration bytes',()=>{
 fs.appendFileSync(hook.mountFile,Buffer.from([0xff,0x0a]));expect(()=>createReviewedWhatsAppConfigLoader(path)()).toThrow('configuration_unavailable');
 fs.writeFileSync(hook.mountFile,`10 1 8:1 / / rw - ext4 /dev/root rw\n11 10 8:1 /fixture ${dir} ro - ext4 /dev/root rw\n`);
 fs.writeFileSync(path,Buffer.concat([Buffer.from(JSON.stringify(config)),Buffer.from([0xff])]));expect(()=>createReviewedWhatsAppConfigLoader(path)()).toThrow('configuration_unavailable');
});
