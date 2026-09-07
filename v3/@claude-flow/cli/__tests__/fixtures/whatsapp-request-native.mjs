// Owned disposable native only. Never contacts BBS or any provider.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {Worker} from 'node:worker_threads';
import {fork} from 'node:child_process';
import {requestData,seed,NOW} from './whatsapp-request-data.mjs';
import {createNativeWhatsAppRequester} from '/candidate/whatsapp-request.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(process.cwd(),'/data');assert.equal(process.env.FIXED_REQUEST_DISPOSABLE,'1');
const base='/app/node_modules/@claude-flow/cli/dist/src/memory/memory-bridge.js',context=JSON.parse(readFileSync('/opt/protected-bridge/context-receipt.json'));
assert.equal(hash(readFileSync(base)),context.overlayFiles['overlay/cli/dist/src/memory/memory-bridge.js']);
const bridge=await import(base);process.env.RUFLO_HIERARCHICAL_PROTECTED_RETENTION=JSON.stringify({prefixes:[{tier:'semantic',keyPrefix:'ruclip:company:fixture'}],maxEntries:20});
const registry=await bridge.getControllerRegistry('/data/fixed-request.sqlite'),db=registry.getAgentDB().database;assert(bridge.ensureBridgeSchema(db));
const Database=createRequire('/app/node_modules/agentdb/package.json')('better-sqlite3');assert(db instanceof Database);Date.now=()=>NOW;
const f=requestData(),hm=registry.get('hierarchicalMemory');
for(const [table,ns,key,value]of f.records.filter(r=>r[0]==='tiered_memory'))assert.equal(hm.createIfAbsent(key,JSON.stringify(value),ns).status,'created');
seed(db,f.records.filter(r=>r[0]==='memory_entries'));
const api=createNativeWhatsAppRequester(registry,()=>f.config),key=id=>`ruclip:whatsapp-group-send-approval-request:fixture:group%3Aa:${id}`;
const stored=id=>db.prepare('SELECT * FROM memory_entries WHERE key=?').get(key(id));
const prep=api.claimPrepare(JSON.stringify(f.d));assert.equal(prep.outcome,'prepared');
const raw=JSON.stringify({...f.d,expectedSnapshotDigest:prep.digest}),seal=f.seal(raw);
// Independent connections and actual simultaneous barrier; not synchronous Promise.all.
const barrier=new SharedArrayBuffer(4),flag=new Int32Array(barrier);
const code="const {parentPort,workerData}=require('node:worker_threads');const {createRequire}=require('node:module');(async()=>{const DB=createRequire('/app/node_modules/agentdb/package.json')('better-sqlite3');const db=new DB('/data/fixed-request.sqlite');db.pragma('synchronous=FULL');Date.now=()=>workerData.now;const {createNativeWhatsAppRequester}=await import('/candidate/whatsapp-request.js');const api=createNativeWhatsAppRequester({getAgentDB:()=>({database:db})},()=>workerData.config);parentPort.postMessage('ready');Atomics.wait(new Int32Array(workerData.barrier),0,0);const r=api.claimApply(workerData.raw,workerData.seal);db.close();parentPort.postMessage(r);})();";
const workers=[0,1].map(()=>new Worker(code,{eval:true,workerData:{barrier,config:f.config,now:NOW,raw,seal}}));let count=0;
const results=await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.on('error',reject);w.on('message',m=>{if(m==='ready'){if(++count===2){Atomics.store(flag,0,1);Atomics.notify(flag,0,2);}}else resolve(m);});})));
assert.equal(results.filter(r=>r.outcome==='committed').length,1);assert.equal(results.filter(r=>r.outcome==='duplicate').length,1);assert.equal(results.filter(r=>r.publicationPermit).length,1);for(const w of workers)await w.terminate();
const claimed=results.find(r=>r.outcome==='committed'),row=stored('reservation1');
const pub={version:1,kind:'cognitum.whatsapp.approval-request.published.v1',companyId:f.d.companyId,groupId:f.d.groupId,intent:f.d.intent,claimDigest:claimed.digest,eventEnvelopeId:'event-fixture1',eventDelivered:false,expectedSnapshotDigest:null};
const pp=api.publishedPrepare(JSON.stringify(pub));assert.equal(pp.outcome,'prepared');const pr=JSON.stringify({...pub,expectedSnapshotDigest:pp.digest});
let calls=0;const rotating=createNativeWhatsAppRequester(registry,()=>++calls===3?{...f.config,revision:'rotated'}:f.config);
assert.equal(rotating.publishedApply(pr,f.seal(pr)).error,'configuration_changed');assert.equal(stored('reservation1').content,row.content);
const result=api.publishedApply(pr,f.seal(pr));assert.equal(result.outcome,'committed');assert.equal(result.request.eventDelivered,false);assert(!result.publicationPermit);
assert.deepEqual({...stored('reservation1'),content:''},{...row,content:''});assert.equal(api.publishedApply(pr,f.seal(pr)).outcome,'duplicate');
// Add owned synthetic reservations without trimming previous history.
const ledgerKey='ruclip:whatsapp-group-spend:fixture:group%3Aa';
function add(id){const l=JSON.parse(db.prepare('SELECT content FROM memory_entries WHERE key=?').get(ledgerKey).content);l.reservations.push({...l.reservations[0],reservationId:id});l.reservedUsd+=1;db.prepare('UPDATE memory_entries SET content=? WHERE key=?').run(JSON.stringify(l),ledgerKey);return {...f.d,intent:{...f.d.intent,intentId:id,reservationId:id}};}
const child='/data/crash-claim.cjs';writeFileSync(child,"const {createRequire}=require('node:module');process.on('message',async d=>{const DB=createRequire('/app/node_modules/agentdb/package.json')('better-sqlite3');const db=new DB('/data/fixed-request.sqlite');db.pragma('synchronous=FULL');Date.now=()=>d.now;const {createNativeWhatsAppRequester}=await import('/candidate/whatsapp-request.js');const api=createNativeWhatsAppRequester({getAgentDB:()=>({database:db})},()=>d.config);const exec=db.exec.bind(db);db.exec=s=>{if(s==='COMMIT'&&d.mode==='before'){process.send('boundary');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}const r=exec(s);if(s==='COMMIT'&&d.mode==='after'){process.send('boundary');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return r;};api.claimApply(d.raw,d.seal);process.send('unexpected-return');});");
async function crash(mode,id){const d=add(id),p=api.claimPrepare(JSON.stringify(d));assert.equal(p.outcome,'prepared');const raw=JSON.stringify({...d,expectedSnapshotDigest:p.digest});
 const childProcess=fork(child,[],{stdio:['ignore','ignore','inherit','ipc']});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{childProcess.kill('SIGKILL');reject(Error('crash-boundary-timeout'));},5000);childProcess.once('error',reject);childProcess.once('message',m=>{clearTimeout(timer);assert.equal(m,'boundary');resolve();});childProcess.send({mode,raw,seal:f.seal(raw),config:f.config,now:NOW});});
 await new Promise(resolve=>{childProcess.once('exit',resolve);childProcess.kill('SIGKILL');});
 const reopened=new Database('/data/fixed-request.sqlite');reopened.pragma('synchronous=FULL');
 const next=createNativeWhatsAppRequester({getAgentDB:()=>({database:reopened})},()=>f.config).claimPrepare(JSON.stringify(d));
 assert.equal(next.outcome,mode==='before'?'prepared':'duplicate');assert(!next.publicationPermit);reopened.close();
}
await crash('before','crash-before');assert(!stored('crash-before'));
await crash('after','crash-after');assert(stored('crash-after'));
assert.equal(db.prepare('SELECT sqlite_version() v').get().v,'3.51.3');assert.equal(db.pragma('synchronous',{simple:true}),2);assert.equal(db.pragma('journal_mode',{simple:true}),'wal');
console.log(JSON.stringify({schema:'native-fixed-request-fixture.v1',success:true,sqlite:'3.51.3',journal:'wal',synchronous:'FULL',sameOwnedHandle:true,independentConcurrentClients:2,claimPermits:1,duplicatePermits:0,publicationFieldsOnly:true,configAfterUpdateRollback:true,realProcessKillBeforeCommitRolledBack:true,realProcessKillAfterCommitRetained:true,restartNeverRecreatesPermit:true,providerCalls:0,claimCounts:claimed.counts,publishedCounts:result.counts,moduleSha256:hash(readFileSync('/candidate/whatsapp-request.js'))}));process.exit(0);
