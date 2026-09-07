// Owned pinned-native, network-none fixture; no shared data or provider.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {Worker} from 'node:worker_threads';
import {data,seed,NOW} from './whatsapp-approve-data.mjs';
import {createNativeWhatsAppApprover} from '/candidate/whatsapp-approve.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(process.cwd(),'/data');assert.equal(process.env.FIXED_APPROVE_DISPOSABLE,'1');
const base='/app/node_modules/@claude-flow/cli/dist/src/memory/memory-bridge.js';
const context=JSON.parse(readFileSync('/opt/protected-bridge/context-receipt.json'));
assert.equal(hash(readFileSync(base)),context.overlayFiles['overlay/cli/dist/src/memory/memory-bridge.js']);
const bridge=await import(base);
process.env.RUFLO_HIERARCHICAL_PROTECTED_RETENTION=JSON.stringify({prefixes:[{tier:'semantic',keyPrefix:'ruclip:company:fixture'}],maxEntries:20});
const registry=await bridge.getControllerRegistry('/data/fixed-approve.sqlite');const db=registry.getAgentDB().database;
assert(bridge.ensureBridgeSchema(db));const require=createRequire('/app/node_modules/agentdb/package.json'),Database=require('better-sqlite3');assert(db instanceof Database);
const realNow=Date.now;Date.now=()=>NOW;const f=data();
const hm=registry.get('hierarchicalMemory');
for(const [table,ns,key,value]of f.records.filter(r=>r[0]==='tiered_memory'))assert.equal(hm.createIfAbsent(key,JSON.stringify(value),ns).status,'created');
seed(db,f.records.filter(r=>r[0]==='memory_entries'));
const api=createNativeWhatsAppApprover(registry,()=>f.config);
const prepared=api.prepare(JSON.stringify(f.d));assert.equal(prepared.outcome,'prepared');assert.equal(prepared.counts.logicalRecords,9);
const raw=JSON.stringify({...f.d,expectedSnapshotDigest:prepared.digest}),seal=f.seal(raw);
const rows=()=>db.prepare("SELECT count(*) n FROM memory_entries WHERE namespace IN ('ruclip-api-whatsapp-group-send-approvals','ruclip-api-whatsapp-human-approval-jti')").get().n;
// Genuine rollback after first row, using existing actual native table triggers.
db.exec(`CREATE TEMP TRIGGER fail_approval BEFORE INSERT ON memory_entries WHEN NEW.namespace='ruclip-api-whatsapp-group-send-approvals' BEGIN SELECT RAISE(ABORT,'fixture'); END;`);
assert.equal(api.apply(raw,seal).outcome,'denied');assert.equal(rows(),0);db.exec('DROP TRIGGER fail_approval');
// Current data drift bypassing warm memory cache is still observed.
const ownerKey='ruclip:company:fixture:org-member:alice';const old=db.prepare('SELECT value FROM tiered_memory WHERE key=?').get(ownerKey).value;
db.prepare('UPDATE tiered_memory SET value=? WHERE key=?').run(JSON.stringify({...JSON.parse(old),status:'inactive'}),ownerKey);
assert.equal(api.apply(raw,seal).outcome,'denied');assert.equal(rows(),0);db.prepare('UPDATE tiered_memory SET value=? WHERE key=?').run(old,ownerKey);
// SQLite serializes the full read/insert transaction against a second real handle.
const other=new Database('/data/fixed-approve.sqlite');other.pragma('synchronous=FULL');other.pragma('busy_timeout=0');
const prepare=db.prepare.bind(db);let competing=false;
db.prepare=sql=>{const s=prepare(sql);if(sql.startsWith('INSERT INTO memory_entries')){const run=s.run.bind(s);s.run=(...args)=>{if(!competing){competing=true;assert.throws(()=>other.prepare('UPDATE tiered_memory SET value=? WHERE key=?').run('{}',ownerKey),/locked/);}return run(...args);};}return s;};
const result=api.apply(raw,seal);db.prepare=prepare;assert.equal(result.outcome,'committed');assert.equal(rows(),2);assert(competing);
// Reset ONLY synthetic fixture approvals, then race two clients from absence.
// This test reset is never part of the native production helper.
db.prepare("DELETE FROM memory_entries WHERE namespace IN ('ruclip-api-whatsapp-group-send-approvals','ruclip-api-whatsapp-human-approval-jti')").run();
assert.equal(rows(),0);
// Two simultaneous independent clients contend on the same absent JTI.
const barrier=new SharedArrayBuffer(4), flag=new Int32Array(barrier);
const workerCode="const {parentPort,workerData}=require('node:worker_threads'); const {createRequire}=require('node:module'); (async()=>{const DB=createRequire('/app/node_modules/agentdb/package.json')('better-sqlite3'); const db=new DB('/data/fixed-approve.sqlite');db.pragma('synchronous=FULL');Date.now=()=>workerData.now;const {createNativeWhatsAppApprover}=await import('/candidate/whatsapp-approve.js');const api=createNativeWhatsAppApprover({getAgentDB:()=>({database:db})},()=>workerData.config);parentPort.postMessage('ready');Atomics.wait(new Int32Array(workerData.barrier),0,0);const result=api.apply(workerData.raw,workerData.seal);db.close();parentPort.postMessage(result);})();";
const workers=[0,1].map(()=>new Worker(workerCode,{eval:true,workerData:{barrier,config:f.config,now:NOW,raw,seal}}));
let readyCount=0;const outcomes=await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.on('error',reject);w.on('message',m=>{if(m==='ready'){if(++readyCount===2){Atomics.store(flag,0,1);Atomics.notify(flag,0,2);}}else resolve(m);});})));
assert.equal(outcomes.filter(r=>r.outcome==='committed').length,1);assert.equal(outcomes.filter(r=>r.outcome==='denied').length,1);assert.equal(rows(),2);for(const w of workers)await w.terminate();
assert.deepEqual(result.approval.originalHumanApproval.assertion,f.assertion);
const second=createNativeWhatsAppApprover({getAgentDB:()=>({database:other})},()=>f.config);assert.equal(second.apply(raw,seal).error,'approval_replayed');
other.close();const restart=new Database('/data/fixed-approve.sqlite');restart.pragma('synchronous=FULL');
assert.equal(createNativeWhatsAppApprover({getAgentDB:()=>({database:restart})},()=>f.config).apply(raw,seal).error,'approval_replayed');restart.close();
assert.equal(db.prepare('SELECT sqlite_version() v').get().v,'3.51.3');assert.equal(db.pragma('synchronous',{simple:true}),2);assert.equal(db.pragma('journal_mode',{simple:true}),'wal');
Date.now=realNow;
console.log(JSON.stringify({schema:'native-fixed-approve-fixture.v1',success:true,sqlite:'3.51.3',journal:'wal',synchronous:'FULL',sameOwnedHandle:true,rollback:true,ownerDrift:true,competingWriteBlocked:competing,restartReplayDenied:true,originalSignatureRetained:true,simultaneousApproveClients:2,concurrentApprovalsCommitted:1,counts:result.counts,moduleSha256:hash(readFileSync('/candidate/whatsapp-approve.js'))}));

process.exit(0);
