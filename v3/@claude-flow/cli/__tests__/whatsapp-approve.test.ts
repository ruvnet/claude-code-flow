import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNativeWhatsAppApprover} from '../src/memory/whatsapp-approve.js';
// @ts-expect-error Shared synthetic JS fixture also executes in pinned native image.
import {data,seed,NOW} from './fixtures/whatsapp-approve-data.mjs';
const clean:Array<()=>void>=[];
afterEach(()=>{vi.restoreAllMocks();while(clean.length)clean.pop()!();});
function fixture() {
 vi.spyOn(Date,'now').mockReturnValue(NOW);
 const dir=mkdtempSync(join(tmpdir(),'fixed-approve-'));clean.push(()=>rmSync(dir,{recursive:true}));
 const path=join(dir,'native.db'),db=new Database(path);clean.push(()=>db.close());
 db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');
 db.exec(`CREATE TABLE tiered_memory(id TEXT PRIMARY KEY,key TEXT,tier TEXT,value TEXT,archived INTEGER DEFAULT 0,superseded_by TEXT,valid_from TEXT,valid_until TEXT);
 CREATE TABLE memory_entries(id TEXT PRIMARY KEY,key TEXT,namespace TEXT,content TEXT,type TEXT,created_at INTEGER,updated_at INTEGER,status TEXT DEFAULT 'active',expires_at INTEGER,UNIQUE(namespace,key));`);
 const f=data();seed(db,f.records);let config=f.config;
 const registry={getAgentDB:()=>({database:db})},api=createNativeWhatsAppApprover(registry,()=>config);
 const prepare=()=>api.prepare(JSON.stringify({...f.d,expectedSnapshotDigest:null}));
 const apply=(digest:string)=>{const raw=JSON.stringify({...f.d,expectedSnapshotDigest:digest});return api.apply(raw,f.seal(raw));};
 const count=()=>db.prepare("SELECT count(*) n FROM memory_entries WHERE namespace IN ('ruclip-api-whatsapp-group-send-approvals','ruclip-api-whatsapp-human-approval-jti')").get().n;
 const mutate=(i:number,fn:(v:any)=>void)=>{const [table,ns,key,v]=f.records[i];fn(v);db.prepare(`UPDATE ${table} SET ${table==='tiered_memory'?'value':'content'}=? WHERE key=? AND ${table==='tiered_memory'?'tier':'namespace'}=?`).run(JSON.stringify(v),key,ns);};
 return {...f,db,path,registry,api,prepare,apply,count,mutate,setConfig:(c:any)=>{config=c;}};
}
function prepared(f:ReturnType<typeof fixture>){const p=f.prepare();expect(p.outcome).toBe('prepared');if(p.outcome!=='prepared')throw Error(JSON.stringify(p));return p;}
it('commits only derived JTI and approval with original proof and full ledger unchanged',()=>{
 const f=fixture(),p=prepared(f),before=JSON.stringify(f.ledger);
 expect(p.counts).toMatchObject({logicalRecords:9,bootstrapRecords:1,rowsObserved:7,recordRowsRead:14,recordStatements:16,totalStatements:30});
 expect(f.apply(p.digest)).toMatchObject({outcome:'committed',counts:{recordInserts:2,totalStatements:32},approval:{status:'approved',consumedAt:null,dispatchId:null,originalHumanApproval:{version:1,assertion:f.assertion,approver:{memberId:'alice',identityRef:'slack:UALICE'}}}});
 expect(f.count()).toBe(2);expect(f.db.prepare('SELECT content FROM memory_entries WHERE namespace=?').get('ruclip-api-whatsapp-group-spend').content).toBe(before);
 expect(f.apply(p.digest)).toMatchObject({outcome:'denied',error:'approval_replayed'});expect(f.count()).toBe(2);
});
it('supports targeted current executive with eleven records and denies its revocation',()=>{
 const f=fixture();f.d.approvedByMemberId='bob';f.assertion.humanSubject.userId='UBOB';f.assertion.humanSubject.email='bob@cognitum.one';f.resign();
 f.mutate(6,p=>{p.recipientMemberId='bob';p.recipient='slack:UBOB';});
 f.db.prepare('INSERT INTO tiered_memory(id,key,tier,value) VALUES(?,?,?,?)').run('bob','ruclip:company:fixture:org-member:bob','semantic',JSON.stringify({id:'bob',companyId:'fixture',kind:'human',status:'active',identityRef:'slack:UBOB'}));
 const grant={version:1,companyId:'fixture',memberId:'bob',identityRef:'slack:UBOB',capability:'executive',status:'active',source:'trusted-seed'};
 f.db.prepare('INSERT INTO memory_entries(id,key,namespace,content) VALUES(?,?,?,?)').run('exec','ruclip:executive:fixture:bob','ruclip-api-authority',JSON.stringify(grant));
 const p=prepared(f);expect(p.counts.logicalRecords).toBe(11);
 f.db.prepare('UPDATE memory_entries SET content=? WHERE id=?').run(JSON.stringify({...grant,status:'inactive'}),'exec');expect(f.apply(p.digest).outcome).toBe('denied');
 f.db.prepare('UPDATE memory_entries SET content=? WHERE id=?').run(JSON.stringify(grant),'exec');expect(f.apply(p.digest).outcome).toBe('committed');
});
for(const [name,index,change]of [
 ['company',0,(v:any)=>v.status='inactive'],['owner',1,(v:any)=>v.status='inactive'],['agent',2,(v:any)=>v.status='inactive'],
 ['assignment',3,(v:any)=>v.budgetCapUsd=11],['settings',4,(v:any)=>v.autonomy='off'],['ledger',5,(v:any)=>v.reservations[0].status='released'],
 ['request',6,(v:any)=>v.recipientMemberId='bob'],['metadata',0,(v:any)=>v.note='changed']
]as const)it(`denies ${name} drift with no writes`,()=>{const f=fixture(),p=prepared(f);f.mutate(index,change);expect(f.apply(p.digest).outcome).toBe('denied');expect(f.count()).toBe(0);});
it('rolls back both inserts on final config rotation',()=>{
 const f=fixture(),p=prepared(f);let calls=0;const api=createNativeWhatsAppApprover(f.registry,()=>++calls===3?{...f.config,revision:'rotated'}:f.config);
 const raw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest});expect(api.apply(raw,f.seal(raw))).toEqual({outcome:'denied',error:'configuration_changed'});expect(f.count()).toBe(0);
});
it('rolls back first insert on second failure and cannot resurrect tombstone',()=>{
 const f=fixture(),p=prepared(f);f.db.exec(`CREATE TRIGGER reject_approval BEFORE INSERT ON memory_entries WHEN NEW.namespace='ruclip-api-whatsapp-group-send-approvals' BEGIN SELECT RAISE(ABORT,'fixture'); END;`);
 expect(f.apply(p.digest)).toEqual({outcome:'denied',error:'storage_error'});expect(f.count()).toBe(0);expect(f.db.inTransaction).toBe(false);
 f.db.exec('DROP TRIGGER reject_approval');f.db.prepare('INSERT INTO memory_entries(id,key,namespace,content,status) VALUES(?,?,?,?,?)').run('dead','ruclip:whatsapp-human-approval:jti1','ruclip-api-whatsapp-human-approval-jti','{}','deleted');
 expect(f.apply(p.digest)).toEqual({outcome:'denied',error:'expired_record'});
});
it('rejects signature tamper, canonical subject mismatch, seal binding and service expiry',()=>{
 const f=fixture(),p=prepared(f),raw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest});
 expect(f.api.apply(raw+' ',f.seal(raw))).toMatchObject({outcome:'denied'});const seal=f.seal(raw);const changed=seal.slice(0,-1)+(seal.endsWith('0')?'1':'0');expect(f.api.apply(raw,changed)).toMatchObject({outcome:'denied'});
 f.assertion.humanSubject.userId='UBOB';expect(f.apply(p.digest)).toMatchObject({error:'invalid_signature'});f.resign();expect(f.apply(p.digest)).toMatchObject({error:'authority_denied'});
 vi.mocked(Date.now).mockReturnValue(NOW+10000);expect(f.apply(p.digest)).toMatchObject({error:'service_denied'});expect(f.count()).toBe(0);
});
it('blocks competing write; commit acknowledgment loss is unknown with both rows retained',()=>{
 const f=fixture(),p=prepared(f),other=new Database(f.path);clean.push(()=>other.close());other.pragma('synchronous=FULL');other.pragma('busy_timeout=0');const exec=f.db.exec.bind(f.db);
 vi.spyOn(f.db,'exec').mockImplementation((sql:string)=>{if(sql==='COMMIT'){expect(()=>other.prepare('UPDATE tiered_memory SET value=?').run('{}')).toThrow(/locked/);exec(sql);throw Error('lost acknowledgment');}return exec(sql);});
 expect(f.apply(p.digest)).toEqual({outcome:'unknown',error:'commit_unknown'});expect(f.count()).toBe(2);
 vi.restoreAllMocks();vi.spyOn(Date,'now').mockReturnValue(NOW);expect(f.apply(p.digest)).toMatchObject({outcome:'denied',error:'approval_replayed'});
});
it('record expiry during inserts rolls back all consent',()=>{
 const f=fixture();f.db.prepare('UPDATE tiered_memory SET valid_until=? WHERE key=?').run(new Date(NOW+100).toISOString(),'ruclip:company:fixture');const p=prepared(f),prepare=f.db.prepare.bind(f.db);
 vi.spyOn(f.db,'prepare').mockImplementation((sql:string)=>{const stmt=prepare(sql);if(sql.startsWith('INSERT')){const run=stmt.run.bind(stmt);stmt.run=((...args:any[])=>{const r=run(...args);vi.mocked(Date.now).mockReturnValue(NOW+101);return r;})as typeof stmt.run;}return stmt;});
 expect(f.apply(p.digest)).toMatchObject({outcome:'denied',error:'expired_record'});expect(f.count()).toBe(0);
});
it('another client cannot reuse the same JTI after commit',()=>{
 const f=fixture(),p=prepared(f),other=new Database(f.path);clean.push(()=>other.close());other.pragma('synchronous=FULL');const api=createNativeWhatsAppApprover({getAgentDB:()=>({database:other})},()=>f.config);
 expect(f.apply(p.digest).outcome).toBe('committed');const raw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest});expect(api.apply(raw,f.seal(raw))).toMatchObject({outcome:'denied',error:'approval_replayed'});expect(f.count()).toBe(2);
});
it('does not adopt caller transaction or initialize unavailable storage',()=>{
 const f=fixture();f.db.exec('BEGIN');expect(f.prepare()).toMatchObject({error:'transaction_active'});expect(f.db.inTransaction).toBe(true);f.db.exec('ROLLBACK');
 expect(createNativeWhatsAppApprover({},()=>f.config).prepare(JSON.stringify(f.d))).toMatchObject({error:'native_unavailable'});
});
it('late commit is held as committed fact, never rolled back or denied as no mutation',()=>{
 const f=fixture(),p=prepared(f),exec=f.db.exec.bind(f.db);
 vi.spyOn(f.db,'exec').mockImplementation((sql:string)=>{const r=exec(sql);if(sql==='COMMIT')vi.mocked(Date.now).mockReturnValue(NOW+10000);return r;});
 const r=f.apply(p.digest);expect(r.outcome).toBe('committed-held');expect(r).not.toHaveProperty('approval');expect(f.count()).toBe(2);
});
it('accepts reordered published intent fields and namespaced tools',()=>{
 const f=fixture();f.mutate(6,p=>{p.intent=Object.fromEntries(Object.entries(p.intent).reverse());});f.mutate(5,l=>{l.reservations[0].routePolicy=Object.fromEntries(Object.entries(l.reservations[0].routePolicy).reverse());});
 expect(f.apply(prepared(f).digest).outcome).toBe('committed');
});
it('rejects complete-ledger corrupt history and oversized values instead of trimming',()=>{
 const f=fixture();f.mutate(5,l=>{l.reservations.push({...l.reservations[0],reservationId:'old',status:'recorded',receiptId:'oldreceipt',recordedUsd:2});});
 expect(f.prepare()).toMatchObject({outcome:'denied',error:'authority_denied'});expect(f.count()).toBe(0);
 f.mutate(5,l=>{l.note='x'.repeat(256*1024);});expect(f.prepare()).toMatchObject({error:'byte_limit'});expect(f.count()).toBe(0);
});
it('rejects key removal, wrong epoch and unavailable current configuration',()=>{
 const f=fixture(),p=prepared(f);f.setConfig({...f.config,epoch:'epoch2'});expect(f.apply(p.digest)).toMatchObject({error:'configuration_changed'});
 f.setConfig({...f.config,humanPublicKeys:{}});expect(f.apply(p.digest)).toMatchObject({error:'configuration_unavailable'});expect(f.count()).toBe(0);
});
it('rejects backward time crossing a canonical valid-from boundary',()=>{
 const f=fixture();f.db.prepare('UPDATE tiered_memory SET valid_from=? WHERE key=?').run(new Date(NOW).toISOString(),'ruclip:company:fixture');const p=prepared(f),prepare=f.db.prepare.bind(f.db);
 vi.spyOn(f.db,'prepare').mockImplementation((sql:string)=>{const stmt=prepare(sql);if(sql.startsWith('INSERT')){const run=stmt.run.bind(stmt);stmt.run=((...args:any[])=>{const r=run(...args);vi.mocked(Date.now).mockReturnValue(NOW-1);return r;})as typeof stmt.run;}return stmt;});
 expect(f.apply(p.digest)).toMatchObject({error:'expired_record'});expect(f.count()).toBe(0);
});
it('matches actual API/Rust original signature canonical bytes and signature-inclusive digest',async()=>{
 const v=(await import('./fixtures/whatsapp-approve-vector.json')).default;
 const {canonicalHuman,verifyHuman}=await import('../src/memory/whatsapp-approve-proof.js');
 const f=fixture(),c={...f.config,humanPublicKeys:v.publicKeys};
 expect(canonicalHuman(v.originalHumanApproval.assertion).toString('hex')).toBe(v.canonicalHex);
 expect(verifyHuman(v.originalHumanApproval.assertion,c,v.nowMs)).toBe(v.assertionDigestSha256);
});
for(const [name,index,change]of [
 ['wrong company payload',0,(v:any)=>v.id='other'],['wrong canonical identity',1,(v:any)=>v.identityRef='slack:UBOB'],
 ['approval disabled',3,(v:any)=>v.managementApprovalMode='disabled'],['wrong active route',3,(v:any)=>v.agents[0].maxUsdPerInvocation=0.5],
 ['future request',6,(v:any)=>v.publishedAt=new Date(NOW+1).toISOString()],['unpublished request',6,(v:any)=>v.eventState='claimed'],
 ['wrong payload',6,(v:any)=>v.intent.payloadSha256='b'.repeat(64)],['wrong recipient',6,(v:any)=>v.recipient='slack:UBOB']
]as const)it(`denies ${name} before initial snapshot`,()=>{const f=fixture();f.mutate(index,change);expect(f.prepare().outcome).toBe('denied');expect(f.count()).toBe(0);});
it('bounds reviewed keys, forbids caller fields, and rejects aliases/duplicate JSON',()=>{
 const f=fixture();expect(()=>createNativeWhatsAppApprover(f.registry,()=>({...f.config,humanPublicKeys:Object.fromEntries(Array.from({length:17},(_,n)=>['key'+n,Object.values(f.config.humanPublicKeys)[0]]))}))).toThrow();
 expect(f.api.prepare(JSON.stringify({...f.d,replacement:{}}))).toMatchObject({error:'invalid_request'});
 expect(f.api.prepare(JSON.stringify(f.d).replace('"version":1','"version":1,"version":1'))).toMatchObject({error:'invalid_request'});
 f.d.groupId='group_a';expect(f.prepare()).toMatchObject({error:'invalid_request'});expect(f.count()).toBe(0);
});
it('original human expiry during finalization rolls back both rows',()=>{
 const f=fixture(),p=prepared(f),prepare=f.db.prepare.bind(f.db);
 vi.spyOn(f.db,'prepare').mockImplementation((sql:string)=>{const stmt=prepare(sql);if(sql.startsWith('INSERT')){const run=stmt.run.bind(stmt);stmt.run=((...args:any[])=>{const r=run(...args);vi.mocked(Date.now).mockReturnValue(NOW+60000);return r;})as typeof stmt.run;}return stmt;});
 expect(f.apply(p.digest)).toMatchObject({error:'assertion_expired'});expect(f.count()).toBe(0);
});
it('current config expiry between loader validation and final clock rolls back',()=>{
 const f=fixture(),p=prepared(f);f.config.expiresAt=NOW+100;let load=0;const api=createNativeWhatsAppApprover(f.registry,()=>{
  if(++load===3){let clocks=0;vi.mocked(Date.now).mockImplementation(()=>++clocks===1?NOW:NOW+101);}return f.config;
 });const raw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest});expect(api.apply(raw,f.seal(raw))).toMatchObject({outcome:'denied',error:'configuration_unavailable'});expect(f.count()).toBe(0);
});
it('current config expiry during release holds durable commit without content',()=>{
 const f=fixture(),p=prepared(f);f.config.expiresAt=NOW+100;let load=0;const api=createNativeWhatsAppApprover(f.registry,()=>{
  if(++load===4){let clocks=0;vi.mocked(Date.now).mockImplementation(()=>++clocks===1?NOW:NOW+101);}return f.config;
 });const raw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest});expect(api.apply(raw,f.seal(raw)).outcome).toBe('committed-held');expect(f.count()).toBe(2);
});
it('final loader elapsed time cannot release late approval',()=>{
 const f=fixture(),p=prepared(f);let elapsed=0,load=0;vi.spyOn(performance,'now').mockImplementation(()=>elapsed);
 const api=createNativeWhatsAppApprover(f.registry,()=>{if(++load===4)elapsed=1001;return f.config;});
 const raw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest});const r=api.apply(raw,f.seal(raw));expect(r.outcome).toBe('committed-held');expect(r).not.toHaveProperty('approval');expect(f.count()).toBe(2);
});
