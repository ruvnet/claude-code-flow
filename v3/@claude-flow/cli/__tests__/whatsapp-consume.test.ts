import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNativeWhatsAppApprover} from '../src/memory/whatsapp-approve.js';
import {createNativeWhatsAppConsumer} from '../src/memory/whatsapp-consume.js';
// @ts-expect-error Public synthetic fixture shared with actual native image.
import {data,seed,NOW} from './fixtures/whatsapp-approve-data.mjs';
const cleanup:Array<()=>void>=[];
afterEach(()=>{vi.restoreAllMocks();while(cleanup.length)cleanup.pop()!();});
function fixture(executive=false){
 vi.spyOn(Date,'now').mockReturnValue(NOW);
 const dir=mkdtempSync(join(tmpdir(),'fixed-consume-'));cleanup.push(()=>rmSync(dir,{recursive:true}));
 const path=join(dir,'native.db'),db=new Database(path);cleanup.push(()=>db.close());db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');
 db.exec(`CREATE TABLE tiered_memory(id TEXT PRIMARY KEY,key TEXT,tier TEXT,value TEXT,archived INTEGER DEFAULT 0,superseded_by TEXT,valid_from TEXT,valid_until TEXT);
 CREATE TABLE memory_entries(id TEXT PRIMARY KEY,key TEXT,namespace TEXT,content TEXT,type TEXT,created_at INTEGER,updated_at INTEGER,status TEXT DEFAULT 'active',expires_at INTEGER,UNIQUE(namespace,key));`);
 const f=data();
 if(executive){f.d.approvedByMemberId='bob';f.assertion.humanSubject.userId='UBOB';f.assertion.humanSubject.email='bob@cognitum.one';f.resign();f.published.recipientMemberId='bob';f.published.recipient='slack:UBOB';
 f.records.push(['tiered_memory','semantic','ruclip:company:fixture:org-member:bob',{id:'bob',companyId:'fixture',kind:'human',status:'active',identityRef:'slack:UBOB'}],
 ['memory_entries','ruclip-api-authority','ruclip:executive:fixture:bob',{version:1,companyId:'fixture',memberId:'bob',identityRef:'slack:UBOB',capability:'executive',status:'active',source:'trusted-seed'}]);}
 seed(db,f.records);const registry={getAgentDB:()=>({database:db})};let config=f.config;
 const approve=createNativeWhatsAppApprover(registry,()=>config),p=approve.prepare(JSON.stringify(f.d));expect(p.outcome).toBe('prepared');if(p.outcome!=='prepared')throw Error('prepare failed');
 const approvalRaw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest}),created=approve.apply(approvalRaw,f.seal(approvalRaw));expect(created.outcome).toBe('committed');if(created.outcome!=='committed')throw Error('approve failed');
 const d={version:1,kind:'cognitum.whatsapp.consume.v1',companyId:f.d.companyId,groupId:f.d.groupId,intent:created.approval.intent,dispatchId:'dispatch1',expectedSnapshotDigest:null};
 const api=createNativeWhatsAppConsumer(registry,()=>config);
 const prepare=()=>api.prepare(JSON.stringify({...d,expectedSnapshotDigest:null}));
 const apply=(digest:string)=>{const raw=JSON.stringify({...d,expectedSnapshotDigest:digest});return api.apply(raw,f.seal(raw));};
 const approvalKey='ruclip:whatsapp-group-send-approval:fixture:group%3Aa:reservation1';
 const stored=()=>JSON.parse(db.prepare('SELECT content FROM memory_entries WHERE key=?').get(approvalKey).content);
 const mutateApproval=(fn:(a:any)=>void)=>{const a=stored();fn(a);db.prepare('UPDATE memory_entries SET content=? WHERE key=?').run(JSON.stringify(a),approvalKey);};
 const mutate=(i:number,fn:(v:any)=>void)=>{const [t,ns,key,value]=f.records[i];fn(value);db.prepare(`UPDATE ${t} SET ${t==='tiered_memory'?'value':'content'}=? WHERE key=? AND ${t==='tiered_memory'?'tier':'namespace'}=?`).run(JSON.stringify(value),key,ns);};
 return{...f,d,db,path,registry,api,prepare,apply,stored,mutateApproval,mutate,setConfig:(c:any)=>{config=c;}};
}
function prepared(f:ReturnType<typeof fixture>){const p=f.prepare();expect(p.outcome).toBe('prepared');if(p.outcome!=='prepared')throw Error(JSON.stringify(p));return p;}
it('consumes only three approval fields, preserves full metadata/proof/history, and rejects all replay',()=>{
 const f=fixture();f.mutateApproval(a=>{a.unknownAudit={nested:['keep',1]};a.humanApproval.historicalNote={keep:'exact'};});const original=f.stored(),p=prepared(f);
 expect(p.counts).toMatchObject({logicalRecords:8,bootstrapRecords:2,rowsObserved:8,recordRowsRead:16,recordStatements:16,totalStatements:30});
 const ledger=f.db.prepare('SELECT content FROM memory_entries WHERE namespace=?').get('ruclip-api-whatsapp-group-spend').content;
 expect(f.apply(p.digest)).toMatchObject({outcome:'committed',counts:{recordUpdates:1,totalStatements:31}});
 expect(f.stored()).toEqual({...original,status:'consumed',consumedAt:new Date(NOW).toISOString(),dispatchId:'dispatch1'});
 expect(f.db.prepare('SELECT content FROM memory_entries WHERE namespace=?').get('ruclip-api-whatsapp-group-spend').content).toBe(ledger);
 expect(f.apply(p.digest)).toMatchObject({outcome:'denied',error:'approval_replayed'});f.d.dispatchId='another';expect(f.apply(p.digest)).toMatchObject({error:'approval_replayed'});
});
it('supports original current executive approval and denies revoked executive grant',()=>{
 const f=fixture(true),p=prepared(f);expect(p.counts.logicalRecords).toBe(10);f.mutate(8,e=>{e.status='inactive';});expect(f.apply(p.digest).outcome).toBe('denied');expect(f.stored().status).toBe('approved');
 f.mutate(8,e=>{e.status='active';});expect(f.apply(p.digest)).toMatchObject({outcome:'committed',counts:{totalStatements:35}});
});
for(const [name,i,fn]of [
 ['company',0,(v:any)=>v.status='inactive'],['owner',1,(v:any)=>v.identityRef='slack:OTHER'],['agent',2,(v:any)=>v.status='inactive'],
 ['assignment',3,(v:any)=>v.status='disabled'],['settings',4,(v:any)=>v.autonomy='off'],['released reservation',5,(v:any)=>{v.reservations[0].status='released';v.reservedUsd=0;}],
 ['metadata drift',0,(v:any)=>v.note='new']
]as const)it(`denies changed ${name} before consume with no mutation`,()=>{const f=fixture(),p=prepared(f);f.mutate(i,fn);expect(f.apply(p.digest).outcome).toBe('denied');expect(f.stored().status).toBe('approved');});
for(const [name,fn]of [
 ['missing original proof',(a:any)=>delete a.originalHumanApproval],['tampered signature',(a:any)=>a.originalHumanApproval.assertion.payloadSha256='b'.repeat(64)],
 ['wrong approver association',(a:any)=>a.originalHumanApproval.approver.memberId='other'],['wrong summary digest',(a:any)=>a.humanApproval.assertionDigestSha256='c'.repeat(64)],
 ['renewed expiry',(a:any)=>a.expiresAt=new Date(NOW+120000).toISOString()],['wrong approved time',(a:any)=>a.approvedAt=new Date(NOW+1).toISOString()]
]as const)it(`denies ${name}, never upgrades legacy approval`,()=>{const f=fixture();f.mutateApproval(fn);expect(f.prepare().outcome).toBe('denied');expect(f.stored().status).toBe('approved');});
it('requires exact JTI receipt and full ledger consistency',()=>{
 const f=fixture();const key='ruclip:whatsapp-human-approval:jti1',old=f.db.prepare('SELECT content FROM memory_entries WHERE key=?').get(key).content;
 const j=JSON.parse(old);j.usedAt=new Date(NOW-1).toISOString();f.db.prepare('UPDATE memory_entries SET content=? WHERE key=?').run(JSON.stringify(j),key);expect(f.prepare().outcome).toBe('denied');
 f.db.prepare('UPDATE memory_entries SET content=? WHERE key=?').run(old,key);f.mutate(5,l=>{l.reservations.push({...l.reservations[0],reservationId:'old',status:'recorded',receiptId:'r1',recordedUsd:2});});expect(f.prepare().outcome).toBe('denied');
});
it('binds exact service action, request and dispatch; extra fields and aliases deny',()=>{
 const f=fixture(),p=prepared(f),raw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest});
 expect(f.api.apply(raw.replace('dispatch1','dispatch2'),f.seal(raw))).toMatchObject({error:'service_denied'});
 expect(f.api.prepare(JSON.stringify({...f.d,replacement:{}}))).toMatchObject({error:'invalid_request'});
 f.d.groupId='group_a';expect(f.prepare().outcome).toBe('denied');expect(f.stored().status).toBe('approved');
});
it('configuration rotation after UPDATE rolls consumption back',()=>{
 const f=fixture(),p=prepared(f);let calls=0;const api=createNativeWhatsAppConsumer(f.registry,()=>++calls===3?{...f.config,revision:'rotated'}:f.config);
 const raw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest});expect(api.apply(raw,f.seal(raw))).toMatchObject({error:'configuration_changed'});expect(f.stored().status).toBe('approved');
});
it('expiry after UPDATE rolls back; late commit is held, lost acknowledgment is unknown',()=>{
 const f=fixture(),p=prepared(f),prepare=f.db.prepare.bind(f.db);
 const spy=vi.spyOn(f.db,'prepare').mockImplementation((sql:string)=>{const stmt=prepare(sql);if(sql.startsWith('UPDATE memory_entries')){const run=stmt.run.bind(stmt);stmt.run=((...args:any[])=>{const r=run(...args);vi.mocked(Date.now).mockReturnValue(NOW+60000);return r;})as typeof stmt.run;}return stmt;});
 expect(f.apply(p.digest)).toMatchObject({error:'assertion_expired'});expect(f.stored().status).toBe('approved');spy.mockRestore();vi.mocked(Date.now).mockReturnValue(NOW);
 const exec=f.db.exec.bind(f.db);vi.spyOn(f.db,'exec').mockImplementation((sql:string)=>{const r=exec(sql);if(sql==='COMMIT')vi.mocked(Date.now).mockReturnValue(NOW+10000);return r;});
 expect(f.apply(p.digest).outcome).toBe('committed-held');expect(f.stored().status).toBe('consumed');
});
it('lost COMMIT response retains consumed record and denies another client after reopening',()=>{
 const f=fixture(),p=prepared(f),exec=f.db.exec.bind(f.db);vi.spyOn(f.db,'exec').mockImplementation((sql:string)=>{const r=exec(sql);if(sql==='COMMIT')throw Error('lost ack');return r;});
 expect(f.apply(p.digest)).toEqual({outcome:'unknown',error:'commit_unknown'});expect(f.stored().status).toBe('consumed');
 const db=new Database(f.path);cleanup.push(()=>db.close());db.pragma('synchronous=FULL');const other=createNativeWhatsAppConsumer({getAgentDB:()=>({database:db})},()=>f.config);
 const raw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest});expect(other.apply(raw,f.seal(raw))).toMatchObject({error:'approval_replayed'});
});
it('does not reuse prepared token after changed intent, or adopt caller transaction',()=>{
 const f=fixture(),p=prepared(f);f.d.intent.payloadSha256='d'.repeat(64);expect(f.apply(p.digest).outcome).toBe('denied');
 f.db.exec('BEGIN');expect(f.prepare()).toMatchObject({error:'transaction_active'});expect(f.db.inTransaction).toBe(true);f.db.exec('ROLLBACK');
});
it('accepts reordered retained intent and subject without changing signature facts',()=>{
 const f=fixture();f.mutateApproval(a=>{a.intent=Object.fromEntries(Object.entries(a.intent).reverse());a.humanApproval.humanSubject=Object.fromEntries(Object.entries(a.humanApproval.humanSubject).reverse());});
 expect(f.apply(prepared(f).digest).outcome).toBe('committed');
});
it('current config expiry after loader validation rolls UPDATE back; postcommit expiry holds',()=>{
 const f=fixture(),p=prepared(f);f.config.expiresAt=NOW+100;let calls=0;
 const api=createNativeWhatsAppConsumer(f.registry,()=>{if(++calls===3){let ticks=0;vi.mocked(Date.now).mockImplementation(()=>++ticks===1?NOW:NOW+101);}return f.config;});
 const raw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest});expect(api.apply(raw,f.seal(raw))).toMatchObject({error:'configuration_unavailable'});expect(f.stored().status).toBe('approved');
 vi.mocked(Date.now).mockReturnValue(NOW);calls=0;
 const later=createNativeWhatsAppConsumer(f.registry,()=>{if(++calls===4){let ticks=0;vi.mocked(Date.now).mockImplementation(()=>++ticks===1?NOW:NOW+101);}return f.config;});
 expect(later.apply(raw,f.seal(raw)).outcome).toBe('committed-held');expect(f.stored().status).toBe('consumed');
});
it('slow final loader cannot release late approval content',()=>{
 const f=fixture(),p=prepared(f);let elapsed=0,calls=0;vi.spyOn(performance,'now').mockImplementation(()=>elapsed);
 const api=createNativeWhatsAppConsumer(f.registry,()=>{if(++calls===4)elapsed=1001;return f.config;});
 const raw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest}),r=api.apply(raw,f.seal(raw));expect(r.outcome).toBe('committed-held');expect(r).not.toHaveProperty('approval');expect(f.stored().status).toBe('consumed');
});
it('native failure at UPDATE leaves original approval unchanged',()=>{
 const f=fixture(),p=prepared(f),old=f.stored();f.db.exec(`CREATE TRIGGER reject_consume BEFORE UPDATE ON memory_entries WHEN OLD.namespace='ruclip-api-whatsapp-group-send-approvals' BEGIN SELECT RAISE(ABORT,'fixture'); END;`);
 expect(f.apply(p.digest)).toMatchObject({outcome:'denied',error:'storage_error'});expect(f.stored()).toEqual(old);expect(f.db.inTransaction).toBe(false);
});
it('valid-from and row expiry remain valid at final commit clock',()=>{
 const f=fixture();f.db.prepare('UPDATE tiered_memory SET valid_until=? WHERE key=?').run(new Date(NOW+100).toISOString(),'ruclip:company:fixture');
 const p=prepared(f),prepare=f.db.prepare.bind(f.db);vi.spyOn(f.db,'prepare').mockImplementation((sql:string)=>{const stmt=prepare(sql);if(sql.startsWith('UPDATE memory_entries')){const run=stmt.run.bind(stmt);stmt.run=((...args:any[])=>{const r=run(...args);vi.mocked(Date.now).mockReturnValue(NOW+101);return r;})as typeof stmt.run;}return stmt;});
 expect(f.apply(p.digest)).toMatchObject({error:'expired_record'});expect(f.stored().status).toBe('approved');
});
it('retains liability when current human key is removed and cannot accept oversized history',()=>{
 const f=fixture(),p=prepared(f);f.setConfig({...f.config,humanPublicKeys:{}});expect(f.apply(p.digest)).toMatchObject({error:'configuration_unavailable'});expect(f.stored().status).toBe('approved');
 f.setConfig(f.config);f.mutateApproval(a=>{a.history='x'.repeat(256*1024);});expect(f.prepare()).toMatchObject({error:'byte_limit'});expect(f.stored().status).toBe('approved');
});

it('new original-proof timestamps match canonical API UTC format',()=>{
 const f=fixture();f.mutateApproval(a=>{a.approvedAt=a.approvedAt.replace('.000Z','Z');});expect(f.prepare().outcome).toBe('denied');expect(f.stored().status).toBe('approved');
});
