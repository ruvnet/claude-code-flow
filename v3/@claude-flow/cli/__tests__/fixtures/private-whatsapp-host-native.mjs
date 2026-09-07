// Disposable actual pinned HTTP dependency + same native registry. No ingress proof.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {data,seed,NOW} from './whatsapp-approve-data.mjs';
const base='/app/node_modules/@claude-flow/cli/dist/src/';
const hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(process.env.PRIVATE_HOST_DISPOSABLE,'1');assert.equal(process.cwd(),'/data');
const dependency='/app/node_modules/@claude-flow/cli/node_modules/@claude-flow/mcp/';
assert.equal(JSON.parse(readFileSync(dependency+'package.json')).version,'3.0.0-alpha.10');
assert.equal(hash(readFileSync(dependency+'dist/server.js')),'7909acc60a53d38a4a4ef5bb17a24a26dfbfaba50bb5c93efbdc930995ff09f0');
const {getControllerRegistry,ensureBridgeSchema}=await import(base+'memory/memory-bridge.js');
process.env.RUFLO_HIERARCHICAL_PROTECTED_RETENTION=JSON.stringify({prefixes:[{tier:'semantic',keyPrefix:'ruclip:company:fixture'}],maxEntries:20});
mkdirSync('/data/.swarm',{recursive:true});
const registry=await getControllerRegistry();const db=registry.getAgentDB().database;assert(ensureBridgeSchema(db));
Date.now=()=>NOW;const f=data();
for(const [,ns,key,value]of f.records.filter(r=>r[0]==='tiered_memory'))assert.equal(registry.get('hierarchicalMemory').createIfAbsent(key,JSON.stringify(value),ns).status,'created');
seed(db,f.records.filter(r=>r[0]==='memory_entries'));
writeFileSync('/control/initial.json',JSON.stringify(f.config),{mode:0o600});
async function wait(name){const end=performance.now()+15000;while(!existsSync('/control/'+name)){assert(performance.now()<end,'host handshake deadline');await new Promise(r=>setTimeout(r,20));}}
await wait('ready');
const {createReviewedWhatsAppConfigLoader}=await import(base+'mcp-tools/private-whatsapp-config.js');
const load=createReviewedWhatsAppConfigLoader('/private-config/current.json');assert.deepEqual(JSON.parse(JSON.stringify(load())),f.config);
const {createProtectedWhatsAppHttpHost}=await import(base+'mcp-tools/private-whatsapp-host.js');
const {listMCPTools}=await import(base+'mcp-client.js');assert(!listMCPTools().some(t=>t.name.startsWith('whatsapp_approve_')||t.name.startsWith('whatsapp_consume_')||t.name.startsWith('whatsapp_request_')));
const consuming=process.env.PRIVATE_HOST_CONSUME==='1',requesting=process.env.PRIVATE_HOST_REQUEST==='1';
const host=createProtectedWhatsAppHttpHost(registry,load,{port:8081,tools:['memory_store','memory_retrieve','agentdb_health','whatsapp_approve_prepare','whatsapp_approve_apply',...(consuming?['whatsapp_consume_prepare','whatsapp_consume_apply']:[]),...(requesting?['whatsapp_request_claim_prepare','whatsapp_request_claim_apply','whatsapp_request_published_prepare','whatsapp_request_published_apply']:[])]});
await host.start();let id=0;const timings={};
async function rpc(method,params){const t=performance.now();const r=await fetch('http://127.0.0.1:8081/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(12000)});assert.equal(r.status,200);const x=await r.json();timings[method]=(timings[method]??0)+performance.now()-t;return x;}
async function tool(name,args){const x=await rpc('tools/call',{name,arguments:args});assert(!x.error,JSON.stringify(x.error));if(name.startsWith('whatsapp_approve_')||name.startsWith('whatsapp_consume_')||name.startsWith('whatsapp_request_'))assert.equal(x.result.content[0].text,JSON.stringify(JSON.parse(x.result.content[0].text)));return x.result.content?JSON.parse(x.result.content[0].text):x.result;}
assert((await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'synthetic',version:'1'}})).result);
const listed=await rpc('tools/list',{});assert.deepEqual(listed.result.tools.map(t=>t.name).sort(),[...host.tools].sort());
for(const name of ['terminal_execute','system/info','system/health','system/metrics','tools/list-detailed']){const unknown=await rpc('tools/call',{name,arguments:{}});assert(unknown.error || unknown.result?.isError);}
const stored=await tool('memory_store',{key:'host-fixture',namespace:'fixture-public',value:'public synthetic ordinary value'});assert.equal(stored.stored,true);
// Same singleton/native DB is observed by ordinary HTTP writes and fixed helper.
assert(db.prepare("SELECT count(*) n FROM memory_entries WHERE key='host-fixture' AND namespace='fixture-public'").get().n>=1);
const rows=()=>db.prepare("SELECT count(*) n FROM memory_entries WHERE namespace IN ('ruclip-api-whatsapp-group-send-approvals','ruclip-api-whatsapp-human-approval-jti')").get().n;
const before=performance.now();const p=await tool('whatsapp_approve_prepare',{requestJson:JSON.stringify(f.d)});timings.prepareMs=performance.now()-before;assert.equal(p.outcome,'prepared',JSON.stringify(p));
const raw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest}),args={requestJson:raw,serviceSeal:f.seal(raw)};
const invalid=await rpc('tools/call',{name:'whatsapp_approve_apply',arguments:{...args,namespace:'wide'}});assert(invalid.error || invalid.result?.isError || JSON.parse(invalid.result.content[0].text).outcome==='denied');assert.equal(rows(),0);
const start=performance.now();const result=await tool('whatsapp_approve_apply',args);timings.applyMs=performance.now()-start;assert.equal(result.outcome,'committed',JSON.stringify(result));assert.equal(hash(Buffer.from(JSON.stringify(result.approval))),result.digest);assert.equal(rows(),2);
assert.equal((await tool('whatsapp_approve_apply',args)).error,'approval_replayed');
if(consuming){
 const original=result.approval,approvalNs='ruclip-api-whatsapp-group-send-approvals';
 const current=()=>JSON.parse(db.prepare('SELECT content FROM memory_entries WHERE namespace=?').get(approvalNs).content);
 const restore=()=>db.prepare('UPDATE memory_entries SET content=? WHERE namespace=?').run(JSON.stringify(original),approvalNs);
 const delta={version:1,kind:'cognitum.whatsapp.consume.v1',companyId:f.d.companyId,groupId:f.d.groupId,intent:original.intent,dispatchId:'dispatch-http',expectedSnapshotDigest:null};
 const prepareConsume=()=>tool('whatsapp_consume_prepare',{requestJson:JSON.stringify(delta)});
 const consume=async()=>{const cp=await prepareConsume();assert.equal(cp.outcome,'prepared',JSON.stringify(cp));assert.equal(cp.counts.logicalRecords,8);assert.equal(cp.counts.totalStatements,30);const text=JSON.stringify({...delta,expectedSnapshotDigest:cp.digest});return {requestJson:text,serviceSeal:f.seal(text)};};
 let ca=await consume();const bad={...ca,requestJson:JSON.stringify({...JSON.parse(ca.requestJson),dispatchId:'wrong-dispatch'})};
 assert.equal((await tool('whatsapp_consume_apply',bad)).error,'service_denied');assert.equal(current().status,'approved');
 const spent=f.ledger;spent.reservations[0].status='released';spent.reservedUsd=0;
 db.prepare("UPDATE memory_entries SET content=? WHERE namespace='ruclip-api-whatsapp-group-spend'").run(JSON.stringify(spent));
 assert.equal((await prepareConsume()).error,'authority_denied');assert.equal(current().status,'approved');
 spent.reservations[0].status='reserved';spent.reservedUsd=1;db.prepare("UPDATE memory_entries SET content=? WHERE namespace='ruclip-api-whatsapp-group-spend'").run(JSON.stringify(spent));
 ca=await consume();const cr=await tool('whatsapp_consume_apply',ca);assert.equal(cr.outcome,'committed',JSON.stringify(cr));assert.equal(cr.approval.status,'consumed');assert.equal(cr.approval.dispatchId,delta.dispatchId);assert.equal(hash(Buffer.from(JSON.stringify(cr.approval))),cr.digest);assert.equal(cr.counts.recordUpdates,1);assert.equal(cr.counts.totalStatements,31);assert.deepEqual(cr.approval.originalHumanApproval,original.originalHumanApproval);assert.equal(rows(),2);
 assert.equal((await tool('whatsapp_consume_apply',ca)).error,'approval_replayed');
 // Restore only disposable fixture content to test loss after the actual COMMIT.
 restore();ca=await consume();const exec=db.exec.bind(db);let commits=0;
 db.exec=sql=>{const r=exec(sql);if(sql==='COMMIT'){commits++;throw Error('fixture lost acknowledgement');}return r;};
 assert.deepEqual(await tool('whatsapp_consume_apply',ca),{outcome:'unknown',error:'commit_unknown'});db.exec=exec;assert.equal(commits,1);assert.equal(current().status,'consumed');
 restore();ca=await consume();commits=0;
 db.exec=sql=>{const r=exec(sql);if(sql==='COMMIT'){commits++;Date.now=()=>NOW+10000;}return r;};
 const held=await tool('whatsapp_consume_apply',ca);db.exec=exec;Date.now=()=>NOW;assert.equal(held.outcome,'committed-held');assert.equal(Object.hasOwn(held,'approval'),false);assert.equal(commits,1);assert.equal(current().status,'consumed');
 restore();
}
if(requesting){
 // New synthetic reservation, preserving the original approval/consume scenario.
 const ledgerKey='ruclip:whatsapp-group-spend:fixture:group%3Aa',l=JSON.parse(db.prepare('SELECT content FROM memory_entries WHERE key=?').get(ledgerKey).content);
 l.reservations.push({...l.reservations[0],reservationId:'request-http'});l.reservedUsd+=1;db.prepare('UPDATE memory_entries SET content=? WHERE key=?').run(JSON.stringify(l),ledgerKey);
 const d={version:1,kind:'cognitum.whatsapp.approval-request.claim.v1',companyId:'fixture',groupId:'group:a',intent:{...f.published.intent,intentId:'request-http',reservationId:'request-http'},targetMemberId:null,expectedSnapshotDigest:null};
 const p=await tool('whatsapp_request_claim_prepare',{requestJson:JSON.stringify(d)});assert.equal(p.outcome,'prepared',JSON.stringify(p));
 const raw=JSON.stringify({...d,expectedSnapshotDigest:p.digest}),args={requestJson:raw,serviceSeal:f.seal(raw)},c=await tool('whatsapp_request_claim_apply',args);
 assert.equal(c.outcome,'committed',JSON.stringify(c));assert.equal(c.digest,hash(Buffer.from(JSON.stringify(c.request))));assert.equal(c.publicationPermit.claimDigest,c.digest);assert.equal(c.publicationPermit.recipient,'slack:UALICE');
 const duplicate=await tool('whatsapp_request_claim_apply',args);assert.equal(duplicate.outcome,'duplicate');assert(!duplicate.publicationPermit);
 const fresh=await tool('whatsapp_request_claim_prepare',{requestJson:JSON.stringify(d)});assert.equal(fresh.outcome,'duplicate');assert.equal(fresh.digest,c.digest);assert(!fresh.publicationPermit);
 const pub={version:1,kind:'cognitum.whatsapp.approval-request.published.v1',companyId:'fixture',groupId:'group:a',intent:d.intent,claimDigest:c.digest,eventEnvelopeId:'http-fixture-envelope',eventDelivered:false,expectedSnapshotDigest:null};
 const pp=await tool('whatsapp_request_published_prepare',{requestJson:JSON.stringify(pub)});assert.equal(pp.outcome,'prepared',JSON.stringify(pp));const pr=JSON.stringify({...pub,expectedSnapshotDigest:pp.digest});
 const published=await tool('whatsapp_request_published_apply',{requestJson:pr,serviceSeal:f.seal(pr)});assert.equal(published.outcome,'committed',JSON.stringify(published));assert.equal(published.digest,hash(Buffer.from(JSON.stringify(published.request))));assert.equal(published.request.eventDelivered,false);assert(!published.publicationPermit);
 assert.equal((await tool('whatsapp_request_published_apply',{requestJson:pr,serviceSeal:f.seal(pr)})).outcome,'duplicate');
}
writeFileSync('/control/rotate','ready');await wait('rotated');assert.equal(load().revision,'rotated');
assert.equal((await tool('whatsapp_approve_prepare',{requestJson:JSON.stringify(f.d)})).error,'configuration_changed');assert.equal(rows(),2);
if(consuming)assert.equal((await tool('whatsapp_consume_prepare',{requestJson:JSON.stringify({version:1,kind:'cognitum.whatsapp.consume.v1',companyId:f.d.companyId,groupId:f.d.groupId,intent:result.approval.intent,dispatchId:'dispatch-http',expectedSnapshotDigest:null})})).error,'configuration_changed');
await host.stop();
assert.equal(db.prepare('SELECT sqlite_version() v').get().v,'3.51.3');assert.equal(db.pragma('journal_mode',{simple:true}),'wal');assert.equal(db.pragma('synchronous',{simple:true}),2);
const modules=['mcp-tools/private-whatsapp-host.js','mcp-tools/private-whatsapp-config.js','mcp-tools/private-whatsapp-approval.js','memory/whatsapp-approve.js','memory/whatsapp-approve-proof.js','memory/whatsapp-approve-state.js','memory/authority-snapshot.js',...(consuming?['mcp-tools/private-whatsapp-consume.js','memory/whatsapp-consume.js','memory/whatsapp-consume-state.js']:[]),...(requesting?['mcp-tools/private-whatsapp-request.js','memory/whatsapp-request.js','memory/whatsapp-request-state.js']:[])];
console.log(JSON.stringify({schema:'private-whatsapp-host-native.v1',success:true,requestClaimPublicationVerified:requesting,requestDuplicateNoPermit:requesting,consumeVerified:consuming,consumeCommitUnknownVerified:consuming,consumeCommittedHeldVerified:consuming,actualPinnedHttp:true,sameRegistry:true,ordinaryPolicyPath:true,privatePolicyChecks:{prepare:8,apply:10,...(consuming?{consumePrepare:7,consumeApply:8}:{})},readOnlyDirectoryRotationObserved:true,rotationDenied:true,noGlobalRegistration:true,sqlite:'3.51.3',journal:'wal',synchronous:'FULL',timings,modules:Object.fromEntries(modules.map(p=>[p,hash(readFileSync(base+p))])),authenticatedIngress:false,coldStartProven:false,providerCalls:0,sharedDeployment:false}));process.exit(0);
