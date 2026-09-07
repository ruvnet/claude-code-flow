import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateWhatsAppConsumeTools } from '../src/mcp-tools/private-whatsapp-consume.js';
// @ts-expect-error Shared synthetic JS fixture also executes in the native image.
import { data, seed, NOW } from './fixtures/whatsapp-approve-data.mjs';
import {createNativeWhatsAppApprover} from '../src/memory/whatsapp-approve.js';
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); while (cleanup.length) cleanup.pop()!(); });
function fixture() {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const dir = mkdtempSync(join(tmpdir(), 'private-consume-'));
  cleanup.push(() => rmSync(dir, { recursive: true }));
  const db = new Database(join(dir, 'native.db')); cleanup.push(() => db.close());
  db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL');
  db.exec(`CREATE TABLE tiered_memory(id TEXT PRIMARY KEY,key TEXT,tier TEXT,value TEXT,archived INTEGER DEFAULT 0,superseded_by TEXT,valid_from TEXT,valid_until TEXT);
    CREATE TABLE memory_entries(id TEXT PRIMARY KEY,key TEXT,namespace TEXT,content TEXT,type TEXT,created_at INTEGER,updated_at INTEGER,status TEXT DEFAULT 'active',expires_at INTEGER,UNIQUE(namespace,key));`);
  const f = data(); seed(db, f.records); let config = f.config;
  const registry = { getAgentDB: () => ({ database: db }) };
  const approver=createNativeWhatsAppApprover(registry,()=>config);
  const initial=approver.prepare(JSON.stringify(f.d));if(initial.outcome!=='prepared')throw Error(JSON.stringify(initial));
  const approvalRaw=JSON.stringify({...f.d,expectedSnapshotDigest:initial.digest});
  const approved=approver.apply(approvalRaw,f.seal(approvalRaw));if(approved.outcome!=='committed')throw Error(JSON.stringify(approved));
  const consume={version:1,kind:'cognitum.whatsapp.consume.v1',companyId:f.d.companyId,groupId:f.d.groupId,intent:approved.approval.intent,dispatchId:'dispatch1',expectedSnapshotDigest:null};
  f.d=consume;
  const tools = createPrivateWhatsAppConsumeTools(registry, () => config);
  const prepare = () => tools[0].handler({ requestJson: JSON.stringify(f.d) }) as Promise<any>;
  const apply = (digest: string) => {
    const raw = JSON.stringify({ ...f.d, expectedSnapshotDigest: digest });
    return tools[1].handler({ requestJson: raw, serviceSeal: f.seal(raw) }) as Promise<any>;
  };
  const state=()=>JSON.parse((db.prepare("SELECT content FROM memory_entries WHERE namespace='ruclip-api-whatsapp-group-send-approvals'").get() as any).content);
  const count = () => (db.prepare("SELECT count(*) n FROM memory_entries WHERE namespace IN ('ruclip-api-whatsapp-group-send-approvals','ruclip-api-whatsapp-human-approval-jti')").get() as any).n;
  return { ...f, state, db, registry, tools, prepare, apply, count, setConfig: (v: any) => { config = v; } };
}
it('private descriptor dispatch reaches actual SQLite and retains original proof/counts', async () => {
  const f = fixture(), p = await f.prepare();
  expect(p).toMatchObject({ outcome: 'prepared', counts: { logicalRecords: 8, totalStatements: 30 } });
  expect(f.count()).toBe(2);expect(f.state().status).toBe('approved');
  const r = await f.apply(p.digest);
  expect(r).toMatchObject({ outcome: 'committed', counts: { recordUpdates: 1, totalStatements: 31 },
    approval: { originalHumanApproval: { assertion: f.assertion } } });
  expect(f.count()).toBe(2);expect(f.state().status).toBe('consumed');
  expect(await f.apply(p.digest)).toMatchObject({ outcome: 'denied', error: 'approval_replayed' });
});
it('rejects extra selectors, inherited fields, accessors and oversized UTF-8 before database access', async () => {
  const f = fixture(), get = vi.spyOn(f.registry, 'getAgentDB');
  const getter = vi.fn(() => JSON.stringify(f.d));
  for (const input of [null, [], {}, { requestJson: JSON.stringify(f.d), namespace: 'authority' },
    Object.create({ requestJson: JSON.stringify(f.d) }), Object.defineProperty({}, 'requestJson', { get: getter, enumerable: true }),
    { requestJson: 'é'.repeat(140000) }, { requestJson: JSON.stringify(f.d), [Symbol('config')]: {} }]) {
    expect(await f.tools[0].handler(input as any)).toEqual({ outcome: 'denied', error: 'invalid_request' });
  }
  expect(getter).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
});
it('requires exact inner signed bytes and both fixed apply fields; context cannot supply them', async () => {
  const f = fixture(), p = await f.prepare(), raw = JSON.stringify({ ...f.d, expectedSnapshotDigest: p.digest });
  expect(await f.tools[1].handler({ requestJson: raw }, { serviceSeal: f.seal(raw) })).toMatchObject({ error: 'invalid_request' });
  expect(await f.tools[1].handler({ requestJson: raw + ' ', serviceSeal: f.seal(raw) })).toMatchObject({ outcome: 'denied' });
  expect(await f.tools[1].handler({ requestJson: raw, serviceSeal: f.seal(raw), config: f.config })).toMatchObject({ error: 'invalid_request' });
  expect(f.count()).toBe(2);expect(f.state().status).toBe('approved');
});
it('captures reviewed configuration; rotation denies rather than adopting caller configuration', async () => {
  const f = fixture(), p = await f.prepare(); f.setConfig({ ...f.config, revision: 'rotated' });
  expect(await f.apply(p.digest)).toMatchObject({ outcome: 'denied', error: 'configuration_changed' });
  expect(f.count()).toBe(2);expect(f.state().status).toBe('approved');
  expect(() => createPrivateWhatsAppConsumeTools(f.registry, () => undefined)).toThrow();
});
it('does not initialize an absent registry or fall back to another store', async () => {
  const f = fixture();
  const [tool] = createPrivateWhatsAppConsumeTools(null, () => f.config);
  expect(await tool.handler({ requestJson: JSON.stringify(f.d) })).toMatchObject({ outcome: 'denied', error: 'native_unavailable' });
});
it('preserves unknown commit acknowledgement without retrying the transaction', async () => {
  const f = fixture(), p = await f.prepare(), exec = f.db.exec.bind(f.db);
  let commits = 0;
  vi.spyOn(f.db, 'exec').mockImplementation((sql: string) => {
    const r = exec(sql); if (sql === 'COMMIT') { commits++; throw Error('lost acknowledgement'); } return r;
  });
  expect(await f.apply(p.digest)).toEqual({ outcome: 'unknown', error: 'commit_unknown' });
  expect(commits).toBe(1); expect(f.count()).toBe(2);expect(f.state().status).toBe('consumed');
});
it('preserves committed-held with no approval release when final currentness fails', async () => {
  const f = fixture(), p = await f.prepare(), exec = f.db.exec.bind(f.db);
  vi.spyOn(f.db, 'exec').mockImplementation((sql: string) => {
    const r = exec(sql); if (sql === 'COMMIT') vi.mocked(Date.now).mockReturnValue(NOW + 10000); return r;
  });
  const r = await f.apply(p.digest);
  expect(r.outcome).toBe('committed-held'); expect(r).not.toHaveProperty('approval'); expect(f.count()).toBe(2);expect(f.state().status).toBe('consumed');
});
it('is immutable, non-cacheable and not automatically installed in public registries', () => {
  const f = fixture(); expect(Object.isFrozen(f.tools)).toBe(true);
  for (const t of f.tools) {
    expect(t.cacheable).toBe(false);
    expect(Object.isFrozen(t)).toBe(true); expect(Object.isFrozen(t.inputSchema)).toBe(true);
    expect(Object.isFrozen(t.inputSchema.properties)).toBe(true); expect(Object.isFrozen(t.inputSchema.required)).toBe(true);
    expect(() => { t.name = 'memory_store'; }).toThrow();
  }
  for (const file of ['index.ts', 'agentdb-tools.ts']) {
    const source = readFileSync(new URL('../src/mcp-tools/' + file, import.meta.url), 'utf8');
    expect(source).not.toContain('private-whatsapp-consume');
    expect(source).not.toContain('whatsapp_consume_apply');
  }
});

it('released reservation and missing original proof cannot become consume admission',async()=>{
 const f=fixture();f.ledger.reservations[0].status='released';f.ledger.reservedUsd=0;
 f.db.prepare("UPDATE memory_entries SET content=? WHERE namespace='ruclip-api-whatsapp-group-spend'").run(JSON.stringify(f.ledger));
 expect(await f.prepare()).toMatchObject({outcome:'denied',error:'authority_denied'});expect(f.state().status).toBe('approved');
 const a=f.state();delete a.originalHumanApproval;f.db.prepare("UPDATE memory_entries SET content=? WHERE namespace='ruclip-api-whatsapp-group-send-approvals'").run(JSON.stringify(a));
 expect(await f.prepare()).toMatchObject({outcome:'denied',error:'original_proof_required'});
});
it('dispatch substitutions invalidate the exact inner seal and only one approval row changes',async()=>{
 const f=fixture(),p=await f.prepare(),raw=JSON.stringify({...f.d,expectedSnapshotDigest:p.digest}),before=f.db.prepare('SELECT * FROM memory_entries ORDER BY id').all();
 expect(await f.tools[1].handler({requestJson:JSON.stringify({...f.d,expectedSnapshotDigest:p.digest,dispatchId:'other'}),serviceSeal:f.seal(raw)})).toMatchObject({outcome:'denied',error:'service_denied'});
 expect(f.state().status).toBe('approved');const r=await f.apply(p.digest);expect(r.outcome).toBe('committed');
 const after=f.db.prepare('SELECT * FROM memory_entries ORDER BY id').all();
 expect(after.filter((row,i)=>JSON.stringify(row)!==JSON.stringify(before[i]))).toHaveLength(1);
 expect(f.state().dispatchId).toBe('dispatch1');
});
