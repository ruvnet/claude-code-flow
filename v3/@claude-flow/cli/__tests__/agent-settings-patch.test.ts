import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNativeAgentSettingsPatcher} from '../src/memory/agent-settings-patch.js';
import {readAuthoritySnapshot} from '../src/memory/authority-snapshot.js';
import {settingsData,seed,NOW} from './fixtures/agent-settings-data.mjs';
const clean:Array<()=>void>=[];afterEach(()=>{vi.restoreAllMocks();while(clean.length)clean.pop()!();});
function fixture(missing=false){
 vi.spyOn(Date,'now').mockReturnValue(NOW);const dir=mkdtempSync(join(tmpdir(),'fixed-settings-'));clean.push(()=>rmSync(dir,{recursive:true}));
 const path=join(dir,'native.db'),db=new Database(path);clean.push(()=>db.close());db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');
 db.exec(`CREATE TABLE tiered_memory(id TEXT PRIMARY KEY,key TEXT,tier TEXT,value TEXT,archived INTEGER DEFAULT 0,superseded_by TEXT,valid_from TEXT,valid_until TEXT);
 CREATE TABLE memory_entries(id TEXT PRIMARY KEY,key TEXT,namespace TEXT,content TEXT,type TEXT,created_at INTEGER,updated_at INTEGER,status TEXT DEFAULT 'active',expires_at INTEGER,UNIQUE(namespace,key));`);
 const f=settingsData();seed(db,missing?f.records.slice(0,3):f.records);let config=f.config;
 const registry={getAgentDB:()=>({database:db})},api=createNativeAgentSettingsPatcher(registry,()=>config);
 const raw=()=>JSON.stringify(f.d),prep=()=>api.prepare(raw());
 const apply=(digest:string)=>{const r=JSON.stringify({...f.d,expectedSnapshotDigest:digest});return api.apply(r,f.seal(r));};
 const stored=()=>db.prepare('SELECT * FROM memory_entries WHERE namespace=?').get('ruclip-api-agent-settings') as any;
 const change=(i:number,fn:(v:any)=>void)=>{const [t,ns,key,v]=f.records[i];fn(v);db.prepare(`UPDATE ${t} SET ${t==='tiered_memory'?'value':'content'}=? WHERE key=? AND ${t==='tiered_memory'?'tier':'namespace'}=?`).run(JSON.stringify(v),key,ns);};
 return{...f,db,path,api,registry,raw,prep,apply,stored,change,setConfig:(c:any)=>{config=c;}};
}
it('preserves partial legacy defaults, unknown data and physical metadata',()=>{
 const f=fixture();f.change(3,v=>{v.future={history:['all',1]};});const old=f.stored(),p=f.prep();
 expect(p).toMatchObject({outcome:'prepared',counts:{logicalRecords:4,bootstrapRecords:0,rowsObserved:4,recordRowsRead:8,recordStatements:8,totalStatements:22}});
 if(p.outcome!=='prepared')throw Error();const r=f.apply(p.digest);
 expect(r).toMatchObject({outcome:'committed',settings:{autonomy:'suggest-only',learningEnabled:true,memoryScope:'none',future:{history:['all',1]}},counts:{recordUpdates:1,recordInserts:0,totalStatements:23}});
 expect({...f.stored(),content:''}).toEqual({...old,content:''});
 expect(f.apply(p.digest)).toMatchObject({outcome:'denied',error:'snapshot_drift'});
});
it('proven absent initializes safe defaults; original settings selector still requires presence',()=>{
 const f=fixture(true);f.d.patch={memoryScope:'own-dms-only'};
 expect(readAuthoritySnapshot(f.registry,{companyId:'fixture',selectors:[{kind:'settings',memberId:'agent1'}]})).toMatchObject({error:'missing_record'});
 const p=f.prep();expect(p).toMatchObject({outcome:'prepared',counts:{rowsObserved:3,recordStatements:7,totalStatements:21}});if(p.outcome!=='prepared')throw Error();
 expect(f.apply(p.digest)).toMatchObject({outcome:'committed',settings:{autonomy:'off',learningEnabled:false,memoryScope:'own-dms-only'},counts:{recordInserts:1,recordUpdates:0,totalStatements:22}});
});
it('empty patch remains compatible and retains existing future fields',()=>{const f=fixture();f.d.patch={};f.change(3,v=>v.extra=123);const p=f.prep();if(p.outcome!=='prepared')throw Error();expect(f.apply(p.digest)).toMatchObject({settings:{extra:123,learningEnabled:false}});});
for(const [label,index,fn]of [
 ['company inactive',0,(v:any)=>v.status='inactive'],['company substitution',0,(v:any)=>v.id='other'],
 ['owner inactive',1,(v:any)=>v.status='inactive'],['owner identity',1,(v:any)=>v.identityRef='slack:UBOB'],
 ['owner kind',1,(v:any)=>v.kind='agent'],['agent inactive',2,(v:any)=>v.status='inactive'],
 ['agent kind',2,(v:any)=>v.kind='human'],['manager transfer',2,(v:any)=>v.managerId='bob'],
 ['owner company',1,(v:any)=>v.companyId='other'],['agent company',2,(v:any)=>v.companyId='other'],
 ['settings changed',3,(v:any)=>v.memoryScope='own-dms-only'],['authority metadata',0,(v:any)=>v.note='changed']
]as const)it(`current ${label} denies stale apply without patch`,()=>{const f=fixture(),p=f.prep();if(p.outcome!=='prepared')throw Error();f.change(index,fn);const row=f.stored();expect(f.apply(p.digest).outcome).toBe('denied');expect(f.stored()).toEqual(row);});
for(const patch of [{autonomy:null},{learningEnabled:'yes'},{memoryScope:'all'}])it(`malformed known settings never defaults into overwrite ${JSON.stringify(patch)}`,()=>{
 const f=fixture();f.change(3,v=>Object.assign(v,patch));expect(f.prep()).toMatchObject({outcome:'denied',error:'settings_malformed'});
});
it('strict request grammar rejects unknown fields, duplicate JSON, owner aliases and invalid patch',()=>{
 const f=fixture();for(const d of [{...f.d,patch:{extra:1}},{...f.d,namespace:'other'},{...f.d,ownerIdentityRef:'email:alice'},
  {...f.d,patch:{learningEnabled:1}},{...f.d,ownerMemberId:'agent1'}])expect(f.api.prepare(JSON.stringify(d)).outcome).toBe('denied');
 expect(f.api.prepare(f.raw().replace('"version":1','"version":1,"version":1')).outcome).toBe('denied');
});
it('action, raw bytes, target, service subject/epoch and expiry are independently bound',()=>{
 const f=fixture(),p=f.prep();if(p.outcome!=='prepared')throw Error();const raw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest});
 for(const patch of [{action:'whatsapp.send.consume'},{subject:'other'},{epoch:'other'},{target:'wrong'},{bodySha256:'b'.repeat(64)},{expiresAt:NOW}])
  expect(f.api.apply(raw,f.seal(raw,patch))).toMatchObject({outcome:'denied',error:'service_denied'});
});
it('inactive/expired/malformed rows and uncertain native reads are never missing defaults',()=>{
 const f=fixture();f.db.prepare("UPDATE memory_entries SET status='inactive'").run();expect(f.prep()).toMatchObject({error:'expired_record'});
 f.db.prepare("UPDATE memory_entries SET status='active',expires_at=?").run(NOW);expect(f.prep()).toMatchObject({error:'expired_record'});
 f.db.prepare("UPDATE memory_entries SET expires_at=NULL,content='not-json'").run();expect(f.prep()).toMatchObject({outcome:'denied'});
});
it('configuration change after update rolls back; lost actual commit is unknown and retained',()=>{
 const f=fixture(),p=f.prep();if(p.outcome!=='prepared')throw Error();const old=f.stored(),raw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest});
 let calls=0;const rotating=createNativeAgentSettingsPatcher(f.registry,()=>++calls===3?{...f.config,revision:'new'}:f.config);
 expect(rotating.apply(raw,f.seal(raw))).toMatchObject({error:'configuration_changed'});expect(f.stored()).toEqual(old);
 const exec=f.db.exec.bind(f.db);vi.spyOn(f.db,'exec').mockImplementation((sql:string)=>{const r=exec(sql);if(sql==='COMMIT')throw Error('lost commit result');return r;});
 expect(f.apply(p.digest)).toEqual({outcome:'unknown',error:'commit_unknown'});expect(JSON.parse(f.stored().content).learningEnabled).toBe(true);
});
it('postcommit authority release failure returns held, never rollback or success settings',()=>{
 const f=fixture(),p=f.prep();if(p.outcome!=='prepared')throw Error();const exec=f.db.exec.bind(f.db);
 vi.spyOn(f.db,'exec').mockImplementation((sql:string)=>{const r=exec(sql);if(sql==='COMMIT')f.setConfig({...f.config,revision:'rotated'});return r;});
 const result=f.apply(p.digest);expect(result).toMatchObject({outcome:'committed-held'});expect(result).not.toHaveProperty('settings');expect(JSON.parse(f.stored().content).learningEnabled).toBe(true);
});
it('does not adopt caller transaction or reopen a missing handle',()=>{const f=fixture();f.db.exec('BEGIN');expect(f.prep()).toMatchObject({error:'transaction_active'});expect(f.db.inTransaction).toBe(true);f.db.exec('ROLLBACK');expect(createNativeAgentSettingsPatcher({},()=>f.config).prepare(f.raw())).toMatchObject({error:'native_unavailable'});});
