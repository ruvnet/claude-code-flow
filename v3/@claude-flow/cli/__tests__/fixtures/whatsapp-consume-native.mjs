// Disposable native fixture only; no exposed tool, shared mount or provider.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {Worker} from 'node:worker_threads';
import {data,seed,NOW} from './whatsapp-approve-data.mjs';
import {createNativeWhatsAppApprover} from '/candidate/whatsapp-approve.js';
import {createNativeWhatsAppConsumer} from '/candidate/whatsapp-consume.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(process.cwd(),'/data');assert.equal(process.env.FIXED_CONSUME_DISPOSABLE,'1');
const base='/app/node_modules/@claude-flow/cli/dist/src/memory/memory-bridge.js',context=JSON.parse(readFileSync('/opt/protected-bridge/context-receipt.json'));
assert.equal(hash(readFileSync(base)),context.overlayFiles['overlay/cli/dist/src/memory/memory-bridge.js']);
const bridge=await import(base);process.env.RUFLO_HIERARCHICAL_PROTECTED_RETENTION=JSON.stringify({prefixes:[{tier:'semantic',keyPrefix:'ruclip:company:fixture'}],maxEntries:20});
const registry=await bridge.getControllerRegistry('/data/fixed-consume.sqlite'),db=registry.getAgentDB().database;assert(bridge.ensureBridgeSchema(db));
const Database=createRequire('/app/node_modules/agentdb/package.json')('better-sqlite3');assert(db instanceof Database);
Date.now=()=>NOW;const f=data(),hm=registry.get('hierarchicalMemory');
for(const [table,ns,key,value]of f.records.filter(r=>r[0]==='tiered_memory'))assert.equal(hm.createIfAbsent(key,JSON.stringify(value),ns).status,'created');
seed(db,f.records.filter(r=>r[0]==='memory_entries'));
const approve=createNativeWhatsAppApprover(registry,()=>f.config),pa=approve.prepare(JSON.stringify(f.d));assert.equal(pa.outcome,'prepared');
const ar=JSON.stringify({...f.d,expectedSnapshotDigest:pa.digest}),approved=approve.apply(ar,f.seal(ar));assert.equal(approved.outcome,'committed');
const key='ruclip:whatsapp-group-send-approval:fixture:group%3Aa:reservation1',ledgerKey='ruclip:whatsapp-group-spend:fixture:group%3Aa';
const original={...approved.approval,humanApproval:{...approved.approval.humanApproval,historicalNote:{keep:'exact'}},unknownAudit:{retain:['all','history']}};
db.prepare('UPDATE memory_entries SET content=? WHERE key=?').run(JSON.stringify(original),key);
const stored=()=>JSON.parse(db.prepare('SELECT content FROM memory_entries WHERE key=?').get(key).content);
const ledger=db.prepare('SELECT content FROM memory_entries WHERE key=?').get(ledgerKey).content;
const d={version:1,kind:'cognitum.whatsapp.consume.v1',companyId:f.d.companyId,groupId:f.d.groupId,intent:approved.approval.intent,dispatchId:'dispatch1',expectedSnapshotDigest:null};
const api=createNativeWhatsAppConsumer(registry,()=>f.config),p=api.prepare(JSON.stringify(d));assert.equal(p.outcome,'prepared');assert.equal(p.counts.logicalRecords,8);
const raw=JSON.stringify({...d,expectedSnapshotDigest:p.digest}),seal=f.seal(raw);
// A released row cannot be consumed; preserve fixture ledger before race.
const released=JSON.parse(ledger);released.reservations[0].status='released';released.reservedUsd=0;
db.prepare('UPDATE memory_entries SET content=? WHERE key=?').run(JSON.stringify(released),ledgerKey);
assert.equal(api.apply(raw,seal).outcome,'denied');assert.equal(stored().status,'approved');db.prepare('UPDATE memory_entries SET content=? WHERE key=?').run(ledger,ledgerKey);
// Final config rotation after UPDATE must rollback, not leave consumed state.
let calls=0;const rotating=createNativeWhatsAppConsumer(registry,()=>++calls===3?{...f.config,revision:'rotated'}:f.config);
assert.equal(rotating.apply(raw,seal).error,'configuration_changed');assert.deepEqual(stored(),original);
// Two independent worker threads/connections start together; exactly one consume.
const barrier=new SharedArrayBuffer(4),flag=new Int32Array(barrier);
const code="const {parentPort,workerData}=require('node:worker_threads');const {createRequire}=require('node:module');(async()=>{const DB=createRequire('/app/node_modules/agentdb/package.json')('better-sqlite3');const db=new DB('/data/fixed-consume.sqlite');db.pragma('synchronous=FULL');Date.now=()=>workerData.now;const {createNativeWhatsAppConsumer}=await import('/candidate/whatsapp-consume.js');const api=createNativeWhatsAppConsumer({getAgentDB:()=>({database:db})},()=>workerData.config);parentPort.postMessage('ready');Atomics.wait(new Int32Array(workerData.barrier),0,0);const r=api.apply(workerData.raw,workerData.seal);db.close();parentPort.postMessage(r);})();";
const workers=[0,1].map(()=>new Worker(code,{eval:true,workerData:{barrier,config:f.config,now:NOW,raw,seal}}));let count=0;
const results=await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.on('error',reject);w.on('message',m=>{if(m==='ready'){if(++count===2){Atomics.store(flag,0,1);Atomics.notify(flag,0,2);}}else resolve(m);});})));
assert.equal(results.filter(r=>r.outcome==='committed').length,1);assert.equal(results.filter(r=>r.outcome==='denied').length,1);for(const w of workers)await w.terminate();
const result=results.find(r=>r.outcome==='committed');assert.deepEqual(stored(),{...original,status:'consumed',consumedAt:new Date(NOW).toISOString(),dispatchId:'dispatch1'});
assert.equal(db.prepare('SELECT content FROM memory_entries WHERE key=?').get(ledgerKey).content,ledger);
const reopened=new Database('/data/fixed-consume.sqlite');reopened.pragma('synchronous=FULL');assert.equal(createNativeWhatsAppConsumer({getAgentDB:()=>({database:reopened})},()=>f.config).apply(raw,seal).error,'approval_replayed');reopened.close();
assert.equal(db.prepare('SELECT sqlite_version() v').get().v,'3.51.3');assert.equal(db.pragma('synchronous',{simple:true}),2);assert.equal(db.pragma('journal_mode',{simple:true}),'wal');
console.log(JSON.stringify({schema:'native-fixed-consume-fixture.v1',success:true,sqlite:'3.51.3',journal:'wal',synchronous:'FULL',sameOwnedHandle:true,releaseBeforeConsumeDenied:true,rollbackAfterUpdate:true,independentConcurrentClients:2,committedConsumes:1,restartReplayDenied:true,fullProofAndUnknownHistoryPreserved:true,ledgerUnchanged:true,counts:result.counts,moduleSha256:hash(readFileSync('/candidate/whatsapp-consume.js'))}));process.exit(0);
