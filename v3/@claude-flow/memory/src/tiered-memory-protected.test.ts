import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TieredMemoryStore, type ProtectedTieredRetention } from './tiered-memory.js';
const prefix='ruclip:company:acme:';
const member=prefix+'org-member:alice';
const config=(maxEntries=8):ProtectedTieredRetention=>({prefixes:[{tier:'semantic',keyPrefix:prefix}],maxEntries});
const dirs:string[]=[],connections:Database.Database[]=[];
function fixture(maxEntries=8) {
  const dir=mkdtempSync(join(tmpdir(),'tiered-protected-'));dirs.push(dir);
  const file=join(dir,'memory.sqlite'),db=new Database(file);connections.push(db);db.pragma('journal_mode=WAL');
  return {file,db,store:new TieredMemoryStore({db,protectedRetention:config(maxEntries)})};
}
afterEach(()=>{for(const db of connections.splice(0))if(db.open)db.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const child=promisify(execFile);
const sourceUrl=new URL('./tiered-memory.ts',import.meta.url).href;
const databaseModule=createRequire(import.meta.url).resolve('better-sqlite3');
function childCreate(file:string,key:string,value:string,start:number) {
  const script=`import {createRequire} from 'node:module'; import {TieredMemoryStore} from ${JSON.stringify(sourceUrl)};
    const require=createRequire(import.meta.url),Database=require(${JSON.stringify(databaseModule)}),db=new Database(process.argv[1]);
    const store=new TieredMemoryStore({db});await new Promise(r=>setTimeout(r,Math.max(0,Number(process.argv[4])-Date.now())));
    console.log(JSON.stringify(store.createIfAbsent(process.argv[2],process.argv[3],'semantic')));db.close();`;
  return child(process.execPath,['--experimental-strip-types','--input-type=module','-e',script,file,key,value,String(start)],
    {env:{PATH:process.env.PATH,NODE_NO_WARNINGS:'1'},timeout:10_000}).then(r=>JSON.parse(r.stdout));
}
describe('protected canonical tiered records',()=>{
  it('creates once, returns existing inactive/expired record, and never silently truncates',()=>{
    const {store,db}=fixture();
    expect(store.createIfAbsent(member,'inactive','semantic')).toMatchObject({status:'created',retention:'protected',durable:true});
    const first=store.getExact(member,'semantic');
    expect(store.createIfAbsent(member,'active','semantic')).toMatchObject({status:'existing',entry:{value:'inactive'}});
    expect(store.getExact(member,'semantic')).toEqual(first);
    db.prepare('UPDATE tiered_memory SET valid_until=? WHERE key=?').run('2000-01-01T00:00:00.000Z',member);
    expect(store.getExact(member,'semantic')).toEqual({status:'missing'});
    expect(store.createIfAbsent(member,'active','semantic')).toMatchObject({status:'existing',entry:{value:'inactive',validUntil:'2000-01-01T00:00:00.000Z'}});
    expect(store.createIfAbsent(prefix+'large','x'.repeat(100001),'semantic')).toEqual({status:'error',error:'invalid_request'});
  });
  it('keeps authority and issue rows through more than5000 FIFO writes and across reopen',()=>{
    const {store,file,db}=fixture();const issue=prefix+'goal:g1:issue:i1';
    store.store(member,'inactive','semantic');store.store(issue,'owner-alice','semantic');
    for(let i=0;i<5100;i++)store.store(`ordinary-${i}`,'cache-value','semantic');
    expect(store.getExact(member,'semantic')).toMatchObject({status:'found',entry:{value:'inactive'}});
    expect(store.getExact(issue,'semantic')).toMatchObject({status:'found'});
    expect(store.getTierStats().semantic).toBeLessThanOrEqual(5000);
    const reopened=new Database(file);connections.push(reopened);const other=new TieredMemoryStore({db:reopened});
    expect(other.createIfAbsent(member,'active','semantic')).toMatchObject({status:'existing',entry:{value:'inactive'}});
    expect(()=>db.prepare('DELETE FROM tiered_memory WHERE key=?').run(member)).toThrow(/protected_entry_delete_forbidden/);
    expect(()=>store.supersede(member,'new')).toThrow(/protected_temporal_mutation_forbidden/);
    expect(()=>store.remove(member)).toThrow(/protected_entry_delete_forbidden/);
    expect(()=>db.prepare('UPDATE tiered_memory SET archived=1 WHERE key=?').run(member)).toThrow(/protected_entry_archive_or_rekey_forbidden/);
    expect(()=>db.prepare('UPDATE tiered_memory SET key=? WHERE key=?').run('ordinary',member)).toThrow(/protected_entry_archive_or_rekey_forbidden/);
  });
  it('rejects new protected capacity without evicting, while updates and exact retries remain available',()=>{
    const {store}=fixture(1);store.store(member,'active','semantic');
    expect(store.createIfAbsent(prefix+'org-member:bob','active','semantic')).toEqual({status:'error',error:'protected_capacity_exceeded'});
    expect(()=>store.store(prefix+'goal:g:issue:i','issue','semantic')).toThrow(/protected_capacity_exceeded/);
    store.store(member,'inactive','semantic');
    expect(store.createIfAbsent(member,'active','semantic')).toMatchObject({status:'existing',entry:{value:'inactive'}});
    expect(store.countPersisted()).toBe(1);
  });
  it('serializes competing creates across real processes and preserves the winning bytes',async()=>{
    const {file,store,db}=fixture();const start=Date.now()+500;
    const results=await Promise.all(Array.from({length:8},(_,i)=>childCreate(file,member,`identity-${i}`,start)));
    expect(results.filter(r=>r.status==='created')).toHaveLength(1);expect(results.filter(r=>r.status==='existing')).toHaveLength(7);
    const winner=results.find(r=>r.status==='created').entry;
    expect(results.every(r=>r.entry.id===winner.id && r.entry.value===winner.value)).toBe(true);
    expect(store.getExact(member,'semantic')).toMatchObject({entry:winner});
    expect(db.prepare('SELECT COUNT(*) n FROM tiered_memory WHERE key=? AND tier=? AND archived=0').get(member,'semantic')).toEqual({n:1});
  });
  it('enforces the protected capacity atomically across real processes creating different keys',async()=>{
    const {file,db}=fixture(3);const start=Date.now()+500;
    const results=await Promise.all(Array.from({length:8},(_,i)=>childCreate(file,`${prefix}org-member:p${i}`,'inactive',start)));
    expect(results.filter(r=>r.status==='created')).toHaveLength(3);
    expect(results.filter(r=>r.error==='protected_capacity_exceeded')).toHaveLength(5);
    expect(db.prepare('SELECT COUNT(*) n FROM tiered_memory').get()).toEqual({n:3});
  });
  it('honors protection configured after an existing process hydrated and sees current updates',()=>{
    const db=new Database(':memory:');connections.push(db);
    const stale=new TieredMemoryStore({db});stale.store(member,'active','semantic');
    const configured=new TieredMemoryStore({db,protectedRetention:config(1)});
    configured.store(member,'inactive','semantic');stale.store(member,'disabled','semantic');
    expect(configured.getExact(member,'semantic')).toMatchObject({entry:{value:'disabled'}});
    expect(configured.createIfAbsent(member,'active','semantic')).toMatchObject({status:'existing',entry:{value:'disabled'}});
    expect(db.prepare('SELECT COUNT(*) n FROM tiered_memory').get()).toEqual({n:1});
  });
  it('fails closed on unsupported scopes/backend, malformed policy, changed policy, or unsafe legacy data',()=>{
    const {store,db}=fixture();expect(store.createIfAbsent('other:member','value','semantic')).toEqual({status:'unsupported',error:'protected_namespace_required'});
    expect(new TieredMemoryStore().createIfAbsent(member,'value','semantic')).toEqual({status:'unsupported',error:'durable_storage_required'});
    expect(()=>new TieredMemoryStore({protectedRetention:config()})).toThrow(/requires_durable/);
    expect(()=>new TieredMemoryStore({db,protectedRetention:config(7)})).toThrow(/policy_conflict/);
    for(const maxEntries of [0,-1,5001,NaN,1.5])expect(()=>new TieredMemoryStore({db,protectedRetention:config(maxEntries)})).toThrow(/invalid_protected/);
    const old=new Database(':memory:');connections.push(old);const a=new TieredMemoryStore({db:old}),b=new TieredMemoryStore({db:old});
    a.store(member,'active','semantic');b.store(member,'inactive','semantic');
    expect(()=>new TieredMemoryStore({db:old,protectedRetention:config()})).toThrow(/protected_ambiguous_key/);
    expect(old.prepare('SELECT COUNT(*) n FROM tiered_memory').get()).toEqual({n:2});
  });
});
