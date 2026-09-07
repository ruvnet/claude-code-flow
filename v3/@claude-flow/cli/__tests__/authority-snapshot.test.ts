import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readAuthoritySnapshot } from '../src/memory/authority-snapshot.js';
import { bridgeAuthoritySnapshot, __setMemoryBridgeRegistryForTests } from '../src/memory/memory-bridge.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); __setMemoryBridgeRegistryForTests(null); while (cleanup.length) cleanup.pop()!(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'authority-snapshot-')); cleanup.push(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'native.sqlite'); const db = new Database(path); cleanup.push(() => db.close());
  db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL');
  db.exec(`CREATE TABLE tiered_memory(id TEXT,key TEXT,tier TEXT,value TEXT,archived INTEGER DEFAULT 0,superseded_by TEXT,valid_from TEXT,valid_until TEXT);
    CREATE INDEX tiered_key ON tiered_memory(key,tier);
    CREATE TABLE memory_entries(id TEXT,key TEXT,namespace TEXT,content TEXT,status TEXT DEFAULT 'active',expires_at INTEGER);
    CREATE INDEX memory_key ON memory_entries(key,namespace);`);
  let counter = 0;
  const tier = (key: string, value: string) => db.prepare('INSERT INTO tiered_memory(id,key,tier,value) VALUES(?,?,?,?)').run(`row${counter++}`, key, 'semantic', value);
  const memory = (namespace: string, key: string, value: string) => db.prepare('INSERT INTO memory_entries(id,key,namespace,content) VALUES(?,?,?,?)').run(`row${counter++}`, key, namespace, value);
  const registry = { getAgentDB: () => ({ database: db }), get: vi.fn(() => { throw Error('cache forbidden'); }) };
  return { db, path, registry, tier, memory };
}
const companyKey = 'ruclip:company:fixture';
const company = { kind: 'company' };
const request = (selectors: unknown[] = [company]) => ({ companyId: 'fixture', selectors });
const spendNs = 'ruclip-api-whatsapp-group-spend';
const spendKey = (group: string) => `ruclip:whatsapp-group-spend:fixture:${encodeURIComponent(group)}`;

describe('unexposed actual native authority snapshot', () => {
  it('uses the already-owned handle, never cache/init/fallback; observes current durable content', () => {
    const f = fixture(); f.tier(companyKey, '{"status":"active"}');
    __setMemoryBridgeRegistryForTests(f.registry);
    const first = bridgeAuthoritySnapshot(request());
    expect(first).toMatchObject({ success: true, cache: false, records: [{ value: '{"status":"active"}' }],
      counts: { selectors: 1, logicalRecords: 1, rowsObserved: 1, recordRowsRead: 2, recordStatements: 2, totalStatements: 16 } });
    f.db.prepare('UPDATE tiered_memory SET value=? WHERE key=?').run('{"status":"inactive"}', companyKey);
    expect(bridgeAuthoritySnapshot(request())).toMatchObject({ success: true, records: [{ value: '{"status":"inactive"}' }] });
    expect(f.registry.get).not.toHaveBeenCalled();
    __setMemoryBridgeRegistryForTests(null);
    expect(bridgeAuthoritySnapshot(request())).toEqual({ success: false, error: 'native_unavailable' });
  });
  it('keeps persisted colon/underscore and namespace tuples distinct', () => {
    const f = fixture();
    f.memory(spendNs, spendKey('group:a'), '{"groupId":"group:a"}');
    f.memory(spendNs, spendKey('group_a'), '{"groupId":"group_a"}');
    f.memory('other', spendKey('group:a'), '{"poison":true}');
    const r = readAuthoritySnapshot(f.registry, request([{ kind: 'spend', groupId: 'group:a' }, { kind: 'spend', groupId: 'group_a' }]));
    expect(r).toMatchObject({ success: true, records: [{ key: spendKey('group:a'), namespace: spendNs, value: '{"groupId":"group:a"}' },
      { key: spendKey('group_a'), value: '{"groupId":"group_a"}' }] });
  });
  it('holds one real WAL read transaction across a committed independent-connection change', () => {
    const f = fixture(); f.tier(companyKey, '{"generation":1}'); f.memory(spendNs, spendKey('g'), '{"generation":1}');
    const other = new Database(f.path); cleanup.push(() => other.close());
    const prepare = f.db.prepare.bind(f.db); let changed = false;
    vi.spyOn(f.db, 'prepare').mockImplementation(((sql: string) => {
      const stmt = prepare(sql);
      if (sql.startsWith('SELECT length') && sql.includes('tiered_memory')) {
        const all = stmt.all.bind(stmt);
        stmt.all = ((...args: unknown[]) => {
          const rows = all(...args);
          if (!changed) { changed = true; expect(f.db.inTransaction).toBe(true);
            other.prepare('UPDATE memory_entries SET content=? WHERE key=?').run('{"generation":2}', spendKey('g')); }
          return rows;
        }) as typeof stmt.all;
      }
      return stmt;
    }) as typeof f.db.prepare);
    const input = request([company, { kind: 'spend', groupId: 'g' }]);
    expect(readAuthoritySnapshot(f.registry, input)).toMatchObject({ success: true, records: [{ value: '{"generation":1}' }, { value: '{"generation":1}' }] });
    expect(readAuthoritySnapshot(f.registry, input)).toMatchObject({ success: true, records: [{ value: '{"generation":1}' }, { value: '{"generation":2}' }] });
    expect(f.db.inTransaction).toBe(false);
  });
  it('requires both exact identity mirrors and rejects disagreement without preference', () => {
    const f = fixture(); const hash = createHash('sha256').update(JSON.stringify(['fixture', 'slack:U1'])).digest('hex');
    const key = `ruclip:company:fixture:identity-legacy:${hash}`;
    const input = request([{ kind: 'identity-locator', identityRef: 'slack:U1' }]);
    f.memory('ruclip-identity-v1', `identity-${hash}`, '{"memberId":"alice"}');
    expect(readAuthoritySnapshot(f.registry, input)).toMatchObject({ success: false, error: 'missing_record' });
    f.tier(key, '{"memberId":"bob"}');
    expect(readAuthoritySnapshot(f.registry, input)).toMatchObject({ success: false, error: 'mirror_conflict' });
    f.db.prepare('UPDATE tiered_memory SET value=? WHERE key=?').run('{"memberId":"alice"}', key);
    expect(readAuthoritySnapshot(f.registry, input)).toMatchObject({ success: true, counts: { selectors: 1, logicalRecords: 2, recordRowsRead: 4 } });
  });
  it('bounds selectors and expanded mirror records before touching the database', () => {
    const registry = { getAgentDB: vi.fn(() => { throw Error('must not read'); }) };
    for (const input of [request([]), request(Array(13).fill(company)), request([company, company]),
      request(Array.from({ length: 7 }, (_, i) => ({ kind: 'identity-locator', identityRef: `slack:U${i}` }))),
      { ...request(), companyId: '../evil' }, request([{ kind: 'spend', groupId: 'g', namespace: 'other' }]),
      request([{ kind: 'member', memberId: 'a:b' }]), { ...request(), dbPath: '/foreign' }]) {
      expect(readAuthoritySnapshot(registry, input)).toEqual({ success: false, error: 'invalid_request' });
    }
    expect(registry.getAgentDB).not.toHaveBeenCalled();
  });
  it('distinguishes explicitly permitted creation absence from required missing and expired rows', () => {
    const f = fixture(); const input = request([{ kind: 'approval', groupId: 'g', reservationId: 'r', allowAbsent: true }]);
    expect(readAuthoritySnapshot(f.registry, input)).toMatchObject({ success: true, records: [{ value: null }], counts: { rowsObserved: 0, recordStatements: 1 } });
    expect(readAuthoritySnapshot(f.registry, request())).toMatchObject({ success: false, error: 'missing_record' });
    f.memory('ruclip-api-whatsapp-group-send-approvals', 'ruclip:whatsapp-group-send-approval:fixture:g:r', '{"status":"approved"}');
    f.db.exec('UPDATE memory_entries SET expires_at=1');
    expect(readAuthoritySnapshot(f.registry, input)).toMatchObject({ success: false, error: 'expired_record' });
    expect(f.db.inTransaction).toBe(false);
  });
  it('rejects duplicate rows, duplicate JSON fields and noncanonical historical JSON without normalizing', () => {
    const f = fixture(); f.tier(companyKey, '{"a":1,"a":2}');
    expect(readAuthoritySnapshot(f.registry, request())).toMatchObject({ error: 'malformed_record' });
    f.db.prepare('UPDATE tiered_memory SET value=?').run('{ "a":2 }');
    expect(readAuthoritySnapshot(f.registry, request())).toMatchObject({ error: 'malformed_record' });
    f.tier(companyKey, '{"a":3}');
    expect(readAuthoritySnapshot(f.registry, request())).toMatchObject({ error: 'ambiguous_record' });
  });
  it('rejects oversized content before materializing it and rejects aggregate output beyond2MiB', () => {
    const f = fixture(); f.tier(companyKey, JSON.stringify({ text: 'x'.repeat(256 * 1024) }));
    const spy = vi.spyOn(f.db, 'prepare');
    expect(readAuthoritySnapshot(f.registry, request())).toMatchObject({ error: 'byte_limit' });
    expect(spy.mock.calls.some(([sql]) => sql.startsWith('SELECT id,'))).toBe(false);
    f.db.exec('DELETE FROM tiered_memory');
    const selectors = Array.from({ length: 9 }, (_, i) => ({ kind: 'member', memberId: `m${i}` }));
    for (const s of selectors) f.tier(`${companyKey}:org-member:${s.memberId}`, JSON.stringify({ text: 'x'.repeat(250 * 1024) }));
    expect(readAuthoritySnapshot(f.registry, request(selectors))).toMatchObject({ error: 'byte_limit' });
    expect(f.db.inTransaction).toBe(false);
  });
  it('denies wrong driver, non-FULL, nested transactions and malformed temporal metadata', () => {
    expect(readAuthoritySnapshot({ getAgentDB: () => ({ database: {} }) }, request())).toMatchObject({ error: 'native_unavailable' });
    const f = fixture(); f.tier(companyKey, '{"a":1}'); f.db.pragma('synchronous=NORMAL');
    expect(readAuthoritySnapshot(f.registry, request())).toMatchObject({ error: 'durability_required' });
    f.db.pragma('synchronous=FULL'); f.db.exec('BEGIN');
    expect(readAuthoritySnapshot(f.registry, request())).toMatchObject({ error: 'transaction_active' });
    expect(f.db.inTransaction).toBe(true); f.db.exec('ROLLBACK');
    f.db.exec("UPDATE tiered_memory SET valid_until='not-a-date'");
    expect(readAuthoritySnapshot(f.registry, request())).toMatchObject({ error: 'malformed_record' });
  });
  it('returns fixed errors with no private SQLite details and rolls back on deadline', () => {
    const f = fixture(); f.tier(companyKey, '{"a":1}');
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(1001);
    expect(readAuthoritySnapshot(f.registry, request())).toEqual({ success: false, error: 'deadline' });
    expect(f.db.inTransaction).toBe(false); vi.restoreAllMocks();
    vi.spyOn(f.db, 'prepare').mockImplementation(() => { throw Error('/private/secret/path'); });
    expect(readAuthoritySnapshot(f.registry, request())).toEqual({ success: false, error: 'storage_error' });
  });
  it('binds row identity and validity metadata in the snapshot digest', () => {
    const f = fixture(); f.tier(companyKey, '{"a":1}');
    const before = readAuthoritySnapshot(f.registry, request()); expect(before.success).toBe(true);
    f.db.prepare('UPDATE tiered_memory SET valid_until=?').run('2099-01-01T00:00:00Z');
    const after = readAuthoritySnapshot(f.registry, request()); expect(after.success).toBe(true);
    if (before.success && after.success) {
      expect(before.digest).not.toBe(after.digest);
      expect(after.records[0].metadata).toMatchObject({ validUntil: '2099-01-01T00:00:00Z' });
    }
    f.db.prepare('UPDATE tiered_memory SET id=?').run('x'.repeat(257));
    expect(readAuthoritySnapshot(f.registry, request())).toMatchObject({ error: 'byte_limit' });
  });
  it('rejects normalized invalid dates and invalid clocks, accepting valid offsets/fractions', () => {
    const f = fixture(); f.tier(companyKey, '{"a":1}');
    for (const date of ['2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-01-01T24:00:00Z', '2026-13-01T00:00:00Z']) {
      f.db.prepare('UPDATE tiered_memory SET valid_from=?').run(date);
      expect(readAuthoritySnapshot(f.registry, request())).toMatchObject({ error: 'malformed_record' });
    }
    f.db.prepare('UPDATE tiered_memory SET valid_from=?').run('2024-02-29T12:34:56.123456+05:30');
    expect(readAuthoritySnapshot(f.registry, request())).toMatchObject({ success: true });
    for (const clock of [NaN, Infinity, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      vi.spyOn(Date, 'now').mockReturnValue(clock);
      expect(readAuthoritySnapshot(f.registry, request())).toMatchObject({ error: 'clock_unavailable' });
    }
  });
});
