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
const {listMCPTools}=await import(base+'mcp-client.js');assert(!listMCPTools().some(t=>t.name.startsWith('whatsapp_approve_')));
const host=createProtectedWhatsAppHttpHost(registry,load,{port:8081,tools:['memory_store','memory_retrieve','agentdb_health','whatsapp_approve_prepare','whatsapp_approve_apply']});
await host.start();let id=0;const timings={};
async function rpc(method,params){const t=performance.now();const r=await fetch('http://127.0.0.1:8081/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(12000)});assert.equal(r.status,200);const x=await r.json();timings[method]=(timings[method]??0)+performance.now()-t;return x;}
async function tool(name,args){const x=await rpc('tools/call',{name,arguments:args});assert(!x.error,JSON.stringify(x.error));if(name.startsWith('whatsapp_approve_'))assert.equal(x.result.content[0].text,JSON.stringify(JSON.parse(x.result.content[0].text)));return x.result.content?JSON.parse(x.result.content[0].text):x.result;}
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
writeFileSync('/control/rotate','ready');await wait('rotated');assert.equal(load().revision,'rotated');
assert.equal((await tool('whatsapp_approve_prepare',{requestJson:JSON.stringify(f.d)})).error,'configuration_changed');assert.equal(rows(),2);
await host.stop();
assert.equal(db.prepare('SELECT sqlite_version() v').get().v,'3.51.3');assert.equal(db.pragma('journal_mode',{simple:true}),'wal');assert.equal(db.pragma('synchronous',{simple:true}),2);
const modules=['mcp-tools/private-whatsapp-host.js','mcp-tools/private-whatsapp-config.js','mcp-tools/private-whatsapp-approval.js','memory/whatsapp-approve.js','memory/whatsapp-approve-proof.js','memory/whatsapp-approve-state.js','memory/authority-snapshot.js'];
console.log(JSON.stringify({schema:'private-whatsapp-host-native.v1',success:true,actualPinnedHttp:true,sameRegistry:true,ordinaryPolicyPath:true,privatePolicyChecks:{prepare:8,apply:10},readOnlyDirectoryRotationObserved:true,rotationDenied:true,noGlobalRegistration:true,sqlite:'3.51.3',journal:'wal',synchronous:'FULL',timings,modules:Object.fromEntries(modules.map(p=>[p,hash(readFileSync(base+p))])),authenticatedIngress:false,coldStartProven:false,providerCalls:0,sharedDeployment:false}));process.exit(0);
