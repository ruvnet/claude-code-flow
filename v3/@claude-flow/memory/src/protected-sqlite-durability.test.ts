import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import initSqlJs from 'sql.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { TieredMemoryStore, type TieredMemoryDb } from './tiered-memory.js';
import { hasWalResetFix, ProtectedSqliteDurability } from './protected-sqlite-durability.js';

const directories: string[] = [], connections: Database.Database[] = [];
const policy = { prefixes: [{ tier: 'semantic' as const, keyPrefix: 'protected:' }], maxEntries: 2 };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'protected-full-')); directories.push(directory);
  const file = join(directory, 'memory.sqlite'), db = new Database(file); connections.push(db);
  db.pragma('journal_mode=WAL'); db.pragma('synchronous=NORMAL');
  return { db, file };
}
function wrapped(db: Database.Database, overrides: Record<string, unknown>): TieredMemoryDb {
  return Object.assign({ exec: db.exec.bind(db), prepare: db.prepare.bind(db), pragma: db.pragma.bind(db), get open() { return db.open; }, get readonly() { return db.readonly; }, get memory() { return db.memory; }, get inTransaction() { return db.inTransaction; } }, overrides);
}
afterEach(() => { vi.restoreAllMocks(); for (const db of connections.splice(0)) if (db.open) db.close(); for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('effective protected SQLite synchronization', () => {
  it('changes the actual native NORMAL connection to FULL before its first protected DDL', () => {
    const { db } = fixture(), exec = db.exec.bind(db);
    vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      expect(db.pragma('synchronous', { simple: true })).toBe(2); return exec(sql);
    });
    const store = new TieredMemoryStore({ db, protectedRetention: policy });
    expect(store.createIfAbsent('protected:alice', 'inactive', 'semantic').status).toBe('created');
    expect(store.getProtectedDurability()).toMatchObject({ required: true, fullSynchronization: true, journalMode: 'wal' });
  });
  it('leaves a legacy unconfigured connection NORMAL', () => {
    const { db } = fixture(), store = new TieredMemoryStore({ db });
    store.store('ordinary', 'unchanged');
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(store.getProtectedDurability()).toMatchObject({ required: false, ready: false });
  });
  it('preserves native caller ownership of an ordinary transaction', () => {
    const { db } = fixture(), store = new TieredMemoryStore({ db });
    db.exec('BEGIN IMMEDIATE'); store.store('ordinary:a', 'a'); store.store('ordinary:b', 'b');
    expect(db.inTransaction).toBe(true);
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    db.exec('ROLLBACK'); expect(db.prepare('SELECT value FROM tiered_memory').all()).toEqual([]);
  });
  it('adopts persisted protection on a fresh connection without environment configuration', () => {
    const { db, file } = fixture(); new TieredMemoryStore({ db, protectedRetention: policy }).store('protected:alice', 'inactive', 'semantic');
    const second = new Database(file); connections.push(second); second.pragma('synchronous=NORMAL');
    const reopened = new TieredMemoryStore({ db: second });
    expect(second.pragma('synchronous', { simple: true })).toBe(2);
    expect(reopened.createIfAbsent('protected:alice', 'active', 'semantic')).toMatchObject({ status: 'existing', entry: { value: 'inactive' } });
  });
  it('adopts a policy installed after an unconfigured connection was constructed', () => {
    const { db, file } = fixture(), stale = new TieredMemoryStore({ db });
    const other = new Database(file); connections.push(other); new TieredMemoryStore({ db: other, protectedRetention: policy });
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    stale.store('protected:alice', 'inactive', 'semantic');
    expect(db.pragma('synchronous', { simple: true })).toBe(2);
  });
  it('cannot insert under NORMAL when protection is installed between routing and the legacy write', () => {
    const { db, file } = fixture(), stale = new TieredMemoryStore({ db });
    const other = new Database(file); connections.push(other);
    const exec = db.exec.bind(db), prepare = db.prepare.bind(db); let installed = false;
    const install = () => { if (!installed) { installed = true; new TieredMemoryStore({ db: other, protectedRetention: policy }); } };
    // Original code had no writer lock and reached prepare(INSERT) first;
    // fixed code discovers the intervening policy after taking its own lock.
    vi.spyOn(db, 'exec').mockImplementation((sql: string) => { if (sql === 'BEGIN IMMEDIATE') install(); return exec(sql); });
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => { if (sql.includes('INSERT INTO tiered_memory (')) install(); return prepare(sql); }) as typeof db.prepare);
    expect(() => stale.store('protected:alice', 'active', 'semantic')).toThrow(/protected_durability_/);
    expect(installed).toBe(true); expect(db.inTransaction).toBe(false);
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.prepare('SELECT value FROM tiered_memory').all()).toEqual([]);
  });
  it('rejects NORMAL drift without repairing it, replaying a receipt or changing rows', () => {
    const { db } = fixture(), store = new TieredMemoryStore({ db, protectedRetention: policy });
    const first = store.createIfAbsent('protected:alice', 'inactive', 'semantic');
    db.pragma('synchronous=NORMAL');
    expect(store.createIfAbsent('protected:alice', 'active', 'semantic')).toEqual({ status: 'error', error: 'protected_durability_required' });
    expect(store.createIfAbsent('protected:bob', 'active', 'semantic')).toEqual({ status: 'error', error: 'protected_durability_required' });
    expect(() => store.store('protected:alice', 'active', 'semantic')).toThrow(/protected_durability_full_required/);
    expect(store.getExact('protected:alice', 'semantic')).toEqual({ status: 'error', error: 'protected_durability_required' });
    expect(store.getProtectedDurability()).toMatchObject({ required: true, fullSynchronization: false, ready: false });
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.prepare('SELECT value FROM tiered_memory').all()).toEqual([{ value: 'inactive' }]);
    db.pragma('synchronous=FULL'); expect(store.createIfAbsent('protected:alice', 'active', 'semantic')).toMatchObject({ status: 'existing', entry: 'entry' in first ? first.entry : null });
  });
  it('leaves a caller-owned transaction open when newly installed protection cannot be adopted', () => {
    const { db, file } = fixture(), stale = new TieredMemoryStore({ db });
    const other = new Database(file); connections.push(other);
    new TieredMemoryStore({ db: other, protectedRetention: policy });
    db.exec('BEGIN IMMEDIATE');
    expect(() => stale.store('protected:alice', 'active', 'semantic')).toThrow(/transaction_active/);
    expect(db.inTransaction).toBe(true);
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.prepare('SELECT value FROM tiered_memory').all()).toEqual([]);
    db.exec('ROLLBACK');
    expect(stale.createIfAbsent('protected:alice', 'inactive', 'semantic').status).toBe('created');
    expect(db.pragma('synchronous', { simple: true })).toBe(2);
  });
  it('cannot upgrade a stale caller-owned read snapshot to a NORMAL protected write', () => {
    const { db, file } = fixture(), stale = new TieredMemoryStore({ db });
    db.exec('BEGIN'); db.prepare('SELECT policy FROM tiered_memory_protected_config').all();
    const other = new Database(file); connections.push(other);
    new TieredMemoryStore({ db: other, protectedRetention: policy });
    expect(() => stale.store('protected:alice', 'active', 'semantic')).toThrow(/locked/);
    expect(db.inTransaction).toBe(true);
    db.exec('ROLLBACK');
    expect(other.prepare('SELECT value FROM tiered_memory').all()).toEqual([]);
    expect(stale.createIfAbsent('protected:alice', 'inactive', 'semantic').status).toBe('created');
  });
  it('does not set FULL or migrate when the caller already owns a transaction', () => {
    const { db } = fixture(); db.exec('BEGIN IMMEDIATE');
    expect(() => new TieredMemoryStore({ db, protectedRetention: policy })).toThrow(/transaction_active/);
    expect(db.inTransaction).toBe(true); db.exec('ROLLBACK');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='tiered_memory'").get()).toBeUndefined();
  });
  it('fails before migration when setting FULL is ignored or throws', () => {
    for (const behavior of ['ignored', 'throws']) {
      const { db } = fixture(), pragma = db.pragma.bind(db);
      const adapter = wrapped(db, { pragma: (sql: string, options?: object) => { if (sql === 'synchronous = FULL') { if (behavior === 'throws') throw new Error('readonly pragma'); return []; } return pragma(sql, options); } });
      expect(() => new TieredMemoryStore({ db: adapter, protectedRetention: policy })).toThrow();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='tiered_memory_protected_config'").get()).toBeUndefined();
    }
  });
  it('requires independent numeric FULL readback instead of coercing adapter output', () => {
    for (const wrong of ['2', 2n, [2], undefined]) {
      const { db } = fixture(), pragma = db.pragma.bind(db);
      const adapter = wrapped(db, { pragma: (sql: string, options?: object) => sql === 'synchronous' ? wrong : pragma(sql, options) });
      expect(() => new TieredMemoryStore({ db: adapter, protectedRetention: policy })).toThrow(/full_required/);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='tiered_memory'").get()).toBeUndefined();
    }
    const { db } = fixture();
    const adapter = wrapped(db, { prepare: (sql: string) => sql === 'PRAGMA synchronous' ? { get: () => ({ synchronous: 1 }) } : db.prepare(sql) });
    expect(() => new TieredMemoryStore({ db: adapter, protectedRetention: policy })).toThrow(/full_readback_failed/);
  });
  it('rejects unsupported fake, memory and sql.js-shaped adapters for protection', () => {
    const { db } = fixture();
    const minimal = { exec: db.exec.bind(db), prepare: db.prepare.bind(db) };
    expect(() => new TieredMemoryStore({ db: minimal, protectedRetention: policy })).toThrow(/file_driver_required/);
    const sqlJsShape = { ...minimal, pragma: () => 2 };
    expect(() => new TieredMemoryStore({ db: sqlJsShape, protectedRetention: policy })).toThrow(/file_driver_required/);
    const memory = new Database(':memory:'); connections.push(memory);
    expect(() => new TieredMemoryStore({ db: memory, protectedRetention: policy })).toThrow(/file_driver_required/);
  });
  it('consumes rejected asynchronous pragma results and never writes protected state', async () => {
    const { db } = fixture();
    const adapter = wrapped(db, { pragma: () => Promise.reject(new Error('asynchronous driver')) });
    expect(() => new TieredMemoryStore({ db: adapter, protectedRetention: policy })).toThrow(/synchronous_driver_required/);
    await new Promise(resolve => setImmediate(resolve));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='tiered_memory'").get()).toBeUndefined();
  });
  it('rejects the actual sql.js engine before protected schema creation', async () => {
    const SQL = await initSqlJs(), db = new SQL.Database();
    try {
      // This is the compatibility shape used around sql.js; it cannot attest a
      // native file-backed commit even though PRAGMA synchronous is available.
      const adapter = { exec: (sql: string) => db.run(sql), prepare: (sql: string) => ({
        get: () => { const s = db.prepare(sql); try { return s.step() ? s.getAsObject() : undefined; } finally { s.free(); } },
        all: () => [], run: () => db.run(sql),
      }), pragma: (sql: string) => db.exec(`PRAGMA ${sql}`) };
      expect(() => new TieredMemoryStore({ db: adapter, protectedRetention: policy })).toThrow(/file_driver_required/);
      expect(db.exec("SELECT name FROM sqlite_master WHERE name LIKE 'tiered_memory%'")).toEqual([]);
    } finally { db.close(); }
  });
  it('checks FULL after acquiring the write lock and again before commit', () => {
    const { db } = fixture(), store = new TieredMemoryStore({ db, protectedRetention: policy });
    store.store('protected:alice', 'inactive', 'semantic');
    const pragma = db.pragma.bind(db); let transactionalReads = 0;
    vi.spyOn(db, 'pragma').mockImplementation(((sql: string, options?: object) => {
      if (sql === 'synchronous' && db.inTransaction && ++transactionalReads === 2) return 1;
      return pragma(sql, options);
    }) as typeof db.pragma);
    expect(() => store.store('protected:alice', 'active', 'semantic')).toThrow(/protected_durability_required/);
    expect(db.inTransaction).toBe(false);
    expect(db.prepare('SELECT value FROM tiered_memory').all()).toEqual([{ value: 'inactive' }]);
  });
  it('reopens in another process with FULL without a new protected policy', () => {
    const { db, file } = fixture(); new TieredMemoryStore({ db, protectedRetention: policy }).store('protected:alice','inactive','semantic');
    const databaseModule = createRequire(import.meta.url).resolve('better-sqlite3');
    const source = new URL('./tiered-memory.ts', import.meta.url).href;
    const code = `import {createRequire,registerHooks} from 'node:module';
      registerHooks({resolve(specifier,context,next){return next(specifier==='./protected-sqlite-durability.js'&&context.parentURL===${JSON.stringify(source)}?new URL('./protected-sqlite-durability.ts',context.parentURL).href:specifier,context)}});
      const {TieredMemoryStore}=await import(${JSON.stringify(source)});
      const D=createRequire(import.meta.url)(${JSON.stringify(databaseModule)});const db=new D(process.argv[1]);
      db.pragma('synchronous=NORMAL');const store=new TieredMemoryStore({db});
      console.log(JSON.stringify({synchronous:db.pragma('synchronous',{simple:true}),read:store.getExact('protected:alice','semantic')}));db.close();`;
    const result=JSON.parse(execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',code,file],{encoding:'utf8'}));
    expect(result).toMatchObject({synchronous:2,read:{status:'found',entry:{value:'inactive'}}});
  });
});

describe('release-readiness version metadata', () => {
  it('recognizes exact documented WAL-reset fixes without treating every newer-looking input as proof', () => {
    for (const version of ['3.51.3','3.51.4','3.52.0','3.53.0','3.50.7','3.44.6']) expect(hasWalResetFix(version)).toBe(true);
    for (const version of ['3.49.2','3.51.2','3.50.6','3.44.5']) expect(hasWalResetFix(version)).toBe(false);
    for (const version of [null, ['3.53.0'], '3.53.0\n','3.53.0-custom','4.0.0']) expect(hasWalResetFix(version)).toBeNull();
  });
  it('reports old/unknown engines as not release-ready without changing ordinary APIs', () => {
    const { db } = fixture();
    const adapter = wrapped(db, { prepare: (sql: string) => sql === 'SELECT sqlite_version() AS version' ? { get: () => ({ version: '3.49.2' }) } : db.prepare(sql) });
    const guard = new ProtectedSqliteDurability(adapter); guard.enable();
    expect(guard.inspect()).toMatchObject({ fullSynchronization: true, walResetFixed: false, ready: false, reason: 'sqlite_wal_reset_fix_unverified' });
  });
});
