import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createNativeWhatsAppRequester} from '../src/memory/whatsapp-request.js';
// @ts-expect-error Shared synthetic data with native image fixture.
import {requestData,seed,NOW} from './fixtures/whatsapp-request-data.mjs';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const clean:Array<()=>void>=[];afterEach(()=>{vi.restoreAllMocks();while(clean.length)clean.pop()!();});
function fixture(executive=false){
 vi.spyOn(Date,'now').mockReturnValue(NOW);const dir=mkdtempSync(join(tmpdir(),'fixed-request-'));clean.push(()=>rmSync(dir,{recursive:true}));
 const path=join(dir,'native.db'),db=new Database(path);clean.push(()=>db.close());db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');
 db.exec(`CREATE TABLE tiered_memory(id TEXT PRIMARY KEY,key TEXT,tier TEXT,value TEXT,archived INTEGER DEFAULT 0,superseded_by TEXT,valid_from TEXT,valid_until TEXT);
 CREATE TABLE memory_entries(id TEXT PRIMARY KEY,key TEXT,namespace TEXT,content TEXT,type TEXT,created_at INTEGER,updated_at INTEGER,status TEXT DEFAULT 'active',expires_at INTEGER,UNIQUE(namespace,key));`);
 const f=requestData(executive);seed(db,f.records);const registry={getAgentDB:()=>({database:db})};let config=f.config;
 const api=createNativeWhatsAppRequester(registry,()=>config),raw=()=>JSON.stringify(f.d);
 const key='ruclip:whatsapp-group-send-approval-request:fixture:group%3Aa:reservation1';
 const stored=()=>db.prepare('SELECT * FROM memory_entries WHERE key=?').get(key) as any;
 const prep=()=>api.claimPrepare(raw());
 const apply=(digest:string)=>{const r=JSON.stringify({...f.d,expectedSnapshotDigest:digest});return api.claimApply(r,f.seal(r));};
 const claim=()=>{const p=prep();if(p.outcome!=='prepared')throw Error(JSON.stringify(p));const r=apply(p.digest);if(r.outcome!=='committed')throw Error(JSON.stringify(r));return r;};
 const pub=(digest:string)=>({version:1,kind:'cognitum.whatsapp.approval-request.published.v1',companyId:f.d.companyId,groupId:f.d.groupId,intent:f.d.intent,claimDigest:digest,eventEnvelopeId:'evt1',eventDelivered:false,expectedSnapshotDigest:null});
 const publish=(d:any)=>{const p=api.publishedPrepare(JSON.stringify(d));if(p.outcome!=='prepared')throw Error(JSON.stringify(p));const r=JSON.stringify({...d,expectedSnapshotDigest:p.digest});return api.publishedApply(r,f.seal(r));};
 const mutate=(i:number,fn:(v:any)=>void)=>{const [t,ns,key,v]=f.records[i];fn(v);db.prepare(`UPDATE ${t} SET ${t==='tiered_memory'?'value':'content'}=? WHERE key=? AND ${t==='tiered_memory'?'tier':'namespace'}=?`).run(JSON.stringify(v),key,ns);};
 return {...f,db,path,registry,api,raw,prep,apply,claim,pub,publish,stored,mutate,setConfig:(c:any)=>{config=c;}};
}
it('strict claim has one transient permit; every duplicate/reopen has none',()=>{
 const f=fixture(),p=f.prep();expect(p).toMatchObject({outcome:'prepared',counts:{logicalRecords:8,bootstrapRecords:2,rowsObserved:6,recordRowsRead:12,recordStatements:14,totalStatements:28}});if(p.outcome!=='prepared')throw Error();
 const r=f.apply(p.digest);expect(r).toMatchObject({outcome:'committed',counts:{recordInserts:1,recordUpdates:0,totalStatements:29},publicationPermit:{subject:f.config.subject,nonce:'operation1',recipient:'slack:UALICE'}});
 const duplicate=f.apply(p.digest);expect(duplicate).toMatchObject({outcome:'duplicate',counts:{rowsObserved:7,totalStatements:29}});expect(duplicate).not.toHaveProperty('publicationPermit');
 const db=new Database(f.path);clean.push(()=>db.close());db.pragma('synchronous=FULL');const other=createNativeWhatsAppRequester({getAgentDB:()=>({database:db})},()=>f.config);
 const read=other.claimPrepare(f.raw());expect(read.outcome).toBe('duplicate');expect(read).not.toHaveProperty('publicationPermit');
 expect(JSON.parse(f.stored().content).eventState).toBe('claimed');
});
it('conditional publication only updates four fields; record metadata/full history and ledger survive',()=>{
 const f=fixture();f.claim();const row=f.stored(),old=JSON.parse(row.content);old.unknownHistory={retain:[1,'all']};const content=JSON.stringify(old);
 f.db.prepare('UPDATE memory_entries SET content=? WHERE id=?').run(content,row.id);const d=f.pub(sha(content));
 const before=f.db.prepare('SELECT content FROM memory_entries WHERE namespace=?').get('ruclip-api-whatsapp-group-spend') as any;
 const r=f.publish(d);expect(r).toMatchObject({outcome:'committed',counts:{recordUpdates:1,recordInserts:0,totalStatements:30}});expect(r).not.toHaveProperty('publicationPermit');
 const after=f.stored();expect({...after,content:''}).toEqual({...row,content:''});expect(JSON.parse(after.content)).toEqual({...old,eventState:'published',eventDelivered:false,eventEnvelopeId:'evt1',publishedAt:new Date(NOW).toISOString()});
 expect(f.db.prepare('SELECT content FROM memory_entries WHERE namespace=?').get('ruclip-api-whatsapp-group-spend')).toEqual(before);
 const dup=f.api.publishedPrepare(JSON.stringify(d));expect(dup.outcome).toBe('duplicate');expect(dup).not.toHaveProperty('publicationPermit');
 expect(f.api.publishedPrepare(JSON.stringify({...d,eventEnvelopeId:'other'}))).toMatchObject({error:'publication_conflict'});
});
it('allows current executive target, denies revoked or wrong explicit target',()=>{
 const f=fixture(true);expect(f.prep()).toMatchObject({outcome:'prepared',counts:{logicalRecords:10,totalStatements:32}});const r=f.claim();expect(r.request.recipient).toBe('slack:UBOB');
 f.mutate(7,e=>e.status='inactive');expect(f.prep().outcome).toBe('denied');expect(f.publish.bind(null,f.pub(r.digest))).toThrow();
});
for(const [name,index,change]of [
 ['company',0,(v:any)=>v.status='inactive'],['owner',1,(v:any)=>v.identityRef='slack:UOTHER'],['agent',2,(v:any)=>v.status='inactive'],
 ['assignment',3,(v:any)=>v.status='disabled'],['settings',4,(v:any)=>v.autonomy='off'],['released',5,(v:any)=>{v.reservations[0].status='released';v.reservedUsd=0;}],
 ['ledger inconsistency',5,(v:any)=>v.reservedUsd=2],['exact-byte drift',0,(v:any)=>v.note='new']
]as const)it(`changed ${name} before claim denies without insert`,()=>{const f=fixture(),p=f.prep();if(p.outcome!=='prepared')throw Error();f.mutate(index,change);expect(f.apply(p.digest).outcome).toBe('denied');expect(f.stored()).toBeUndefined();});
it('duplicate freshness does not bypass recipient or reservation revalidation',()=>{const f=fixture();f.claim();f.mutate(1,v=>v.status='inactive');expect(f.prep().outcome).toBe('denied');});
it('rejects consumed approval even while reservation remains reserved',()=>{const f=fixture();seed(f.db,[['memory_entries','ruclip-api-whatsapp-group-send-approvals','ruclip:whatsapp-group-send-approval:fixture:group%3Aa:reservation1',{status:'consumed'}]]);expect(f.prep()).toMatchObject({error:'approval_replayed'});});
it('exact service action/body/target/config and strict JSON bind each action',()=>{
 const f=fixture(),p=f.prep();if(p.outcome!=='prepared')throw Error();const raw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest});
 for(const patch of [{action:'whatsapp.approval-request.published'},{subject:'other'},{epoch:'other'},{target:'wrong'},{bodySha256:'b'.repeat(64)}])expect(f.api.claimApply(raw,f.seal(raw,patch))).toMatchObject({error:'service_denied'});
 for(const bad of [raw+' ',raw.replace('"version":1','"version":1,"version":1'),JSON.stringify({...f.d,namespace:'other'}),JSON.stringify({...f.d,targetMemberId:undefined})])expect(f.api.claimPrepare(bad)).toMatchObject({error:'invalid_request'});
 f.setConfig({...f.config,revision:'next'});expect(f.apply(p.digest)).toMatchObject({error:'configuration_changed'});
});
it('rollback after insert/config change; lost commit holds state and restart cannot regain permit',()=>{
 const f=fixture(),p=f.prep();if(p.outcome!=='prepared')throw Error();let calls=0;const api=createNativeWhatsAppRequester(f.registry,()=>++calls===3?{...f.config,revision:'changed'}:f.config);
 const raw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest});expect(api.claimApply(raw,f.seal(raw))).toMatchObject({error:'configuration_changed'});expect(f.stored()).toBeUndefined();
 const exec=f.db.exec.bind(f.db);const spy=vi.spyOn(f.db,'exec').mockImplementation((s:string)=>{const r=exec(s);if(s==='COMMIT')throw Error('lost response');return r;});
 expect(f.apply(p.digest)).toEqual({outcome:'unknown',error:'commit_unknown'});expect(JSON.parse(f.stored().content).eventState).toBe('claimed');spy.mockRestore();
 const dup=f.prep();expect(dup.outcome).toBe('duplicate');expect(dup).not.toHaveProperty('publicationPermit');
});
it('late committed claim hides record/permit and never rolls it back',()=>{
 const f=fixture(),p=f.prep();if(p.outcome!=='prepared')throw Error();const exec=f.db.exec.bind(f.db);
 vi.spyOn(f.db,'exec').mockImplementation((s:string)=>{const r=exec(s);if(s==='COMMIT')vi.mocked(Date.now).mockReturnValue(NOW+10000);return r;});
 const r=f.apply(p.digest);expect(r.outcome).toBe('committed-held');expect(r).not.toHaveProperty('publicationPermit');expect(r).not.toHaveProperty('request');expect(f.stored()).toBeTruthy();
});
it('published lost commit remains published; replay cannot update or permit another event',()=>{
 const f=fixture(),claim=f.claim(),d=f.pub(claim.digest),p=f.api.publishedPrepare(JSON.stringify(d));if(p.outcome!=='prepared')throw Error();
 const raw=JSON.stringify({...d,expectedSnapshotDigest:p.digest}),exec=f.db.exec.bind(f.db);const spy=vi.spyOn(f.db,'exec').mockImplementation((s:string)=>{const r=exec(s);if(s==='COMMIT')throw Error('lost');return r;});
 expect(f.api.publishedApply(raw,f.seal(raw))).toMatchObject({outcome:'unknown'});expect(JSON.parse(f.stored().content).eventState).toBe('published');spy.mockRestore();
 expect(f.api.publishedApply(raw,f.seal(raw))).toMatchObject({outcome:'duplicate'});
});
it('cannot adopt caller transaction, alias a group key, or publish mismatched claim digest',()=>{
 const f=fixture();f.db.exec('BEGIN');expect(f.prep()).toMatchObject({error:'transaction_active'});expect(f.db.inTransaction).toBe(true);f.db.exec('ROLLBACK');
 f.d.groupId='group_a';expect(f.prep().outcome).toBe('denied');f.d.groupId='group:a';f.claim();expect(f.api.publishedPrepare(JSON.stringify(f.pub('b'.repeat(64))))).toMatchObject({error:'request_mismatch'});
});
it('request-claim optional row does not relax original required-request selector',async()=>{
 const f=fixture(),{readAuthorityRows}=await import('../src/memory/authority-snapshot.js');
 f.db.exec('BEGIN');expect(()=>readAuthorityRows(f.db,{companyId:'fixture',selectors:[{kind:'request',groupId:'group:a',reservationId:'reservation1'}]},NOW,()=>{})).toThrow('missing_record');f.db.exec('ROLLBACK');
 expect(f.prep().outcome).toBe('prepared');seed(f.db,[['memory_entries','ruclip-api-whatsapp-group-send-approval-requests','ruclip:whatsapp-group-send-approval-request:fixture:group%3Aa:reservation1',{malformed:true}]]);expect(f.prep()).toMatchObject({error:'request_mismatch'});
});
for(const sql of ["UPDATE memory_entries SET status='inactive' WHERE namespace='ruclip-api-whatsapp-group-send-approval-requests'",`UPDATE memory_entries SET expires_at=${NOW-1} WHERE namespace='ruclip-api-whatsapp-group-send-approval-requests'`])it('never resurrects inactive/expired request rows',()=>{const f=fixture(),r=f.claim();f.db.exec(sql);expect(f.prep().outcome).toBe('denied');expect(f.api.publishedPrepare(JSON.stringify(f.pub(r.digest))).outcome).toBe('denied');});
it('bounds existing history without trimming it',()=>{const f=fixture();f.claim();const row=f.stored(),v=JSON.parse(row.content);v.history='x'.repeat(262144);f.db.prepare('UPDATE memory_entries SET content=? WHERE id=?').run(JSON.stringify(v),row.id);expect(f.prep()).toMatchObject({error:'byte_limit'});expect(f.stored().content).toContain(v.history);});
it('precommit expiry rolls back and late final loader withholds committed permit',()=>{
 const f=fixture(),p=f.prep();if(p.outcome!=='prepared')throw Error();let calls=0;const api=createNativeWhatsAppRequester(f.registry,()=>{if(++calls===3)vi.mocked(Date.now).mockReturnValue(NOW+10000);return f.config;});const raw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest});
 expect(api.claimApply(raw,f.seal(raw))).toMatchObject({error:'service_denied'});expect(f.stored()).toBeUndefined();vi.mocked(Date.now).mockReturnValue(NOW);calls=0;let elapsed=0;vi.spyOn(performance,'now').mockImplementation(()=>elapsed);
 const later=createNativeWhatsAppRequester(f.registry,()=>{if(++calls===4)elapsed=1001;return f.config;});const r=later.claimApply(raw,f.seal(raw));expect(r.outcome).toBe('committed-held');expect(r).not.toHaveProperty('publicationPermit');expect(f.stored()).toBeTruthy();
});
it('SQL write failures rollback without invented publication',()=>{
 const f=fixture(),p=f.prep();if(p.outcome!=='prepared')throw Error();f.db.exec("CREATE TRIGGER reject_request BEFORE INSERT ON memory_entries WHEN NEW.namespace='ruclip-api-whatsapp-group-send-approval-requests' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
 expect(f.apply(p.digest)).toMatchObject({error:'storage_error'});expect(f.stored()).toBeUndefined();f.db.exec('DROP TRIGGER reject_request');const c=f.claim(),old=f.stored().content;
 f.db.exec("CREATE TRIGGER reject_publish BEFORE UPDATE ON memory_entries WHEN OLD.namespace='ruclip-api-whatsapp-group-send-approval-requests' BEGIN SELECT RAISE(ABORT,'fixture'); END;");expect(f.publish(f.pub(c.digest))).toMatchObject({error:'storage_error'});expect(f.stored().content).toBe(old);
});
it('retained request timestamps must be valid strings, not numeric or normalized invalid dates',()=>{
 const f=fixture();f.claim();const row=f.stored(),old=JSON.parse(row.content);
 for(const createdAt of [NOW,'2026-02-30T00:00:00Z','2023-11-14T24:00:00Z']){f.db.prepare('UPDATE memory_entries SET content=? WHERE id=?').run(JSON.stringify({...old,createdAt}),row.id);expect(f.prep()).toMatchObject({error:'malformed_record'});}
});
