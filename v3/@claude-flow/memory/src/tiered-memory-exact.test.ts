import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { TieredMemoryStore } from './tiered-memory.js';

const connections: Database.Database[] = [];
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tiered-exact-'));
  dirs.push(dir);
  const path = join(dir, 'memory.sqlite');
  const db = new Database(path);
  connections.push(db);
  db.pragma('journal_mode=WAL');
  return { path, db, store: new TieredMemoryStore({ db }) };
}
afterEach(() => {
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('TieredMemoryStore.getExact durable current read', () => {
  it('finds an exact key behind over 1,000 distracting key/value matches without recall', () => {
    const { store } = fixture();
    const key = 'ruclip:company:tenant-a:org-member:owner';
    store.store(key, 'active-owner', 'semantic');
    for (let i = 0; i < 1200; i++) store.store(`${key}-other-${i}`, `mentions ${key}`, 'semantic');
    // The old search cannot guarantee the target; exact get bypasses its cap.
    expect(store.recall(key, 1000).length).toBeLessThanOrEqual(100);
    expect(store.getExact(key, 'semantic')).toMatchObject({ status: 'found', entry: { key, value: 'active-owner' } });
    expect(store.getExact(key.toUpperCase(), 'semantic')).toEqual({ status: 'missing' });
    expect(store.getExact(`${key}-absent`, 'semantic')).toEqual({ status: 'missing' });
  });

  it('requires the exact tenant key and tier, ignoring matching content and other tiers', () => {
    const { store } = fixture();
    store.store('tenant-a:member', 'semantic-a', 'semantic');
    store.store('tenant-a:member', 'working-a', 'working');
    store.store('tenant-b:member', 'tenant-a:missing', 'semantic');
    expect(store.getExact('tenant-a:member', 'semantic')).toMatchObject({ status: 'found', entry: { value: 'semantic-a' } });
    expect(store.getExact('tenant-a:member', 'working')).toMatchObject({ status: 'found', entry: { value: 'working-a' } });
    expect(store.getExact('tenant-a:member', 'episodic')).toEqual({ status: 'missing' });
    expect(store.getExact('tenant-a:missing', 'semantic')).toEqual({ status: 'missing' });
  });

  it('does not return expired, future or archived records; malformed validity fails closed', () => {
    const { store } = fixture();
    store.store('expired', 'active', 'semantic', { validUntil: '2000-01-01T00:00:00.000Z' });
    store.store('future', 'active', 'semantic', { validFrom: '2999-01-01T00:00:00.000Z' });
    store.store('old', 'active', 'semantic');
    store.store('new', 'inactive', 'semantic', { supersedes: 'old' });
    store.store('invalid', 'active', 'semantic', { validUntil: 'invalid-date' });
    store.store('valid', 'active', 'semantic', { validFrom: '2000-01-01T00:00:00.000Z', validUntil: '2999-01-01T00:00:00.000Z' });
    for (const key of ['expired', 'future', 'old']) expect(store.getExact(key, 'semantic')).toEqual({ status: 'missing' });
    expect(store.getExact('invalid', 'semantic')).toEqual({ status: 'error', error: 'invalid_temporal_metadata' });
    expect(store.getExact('valid', 'semantic')).toMatchObject({ status: 'found' });
  });

  it('observes a separate process update, restart and deletion while the reader map stays stale', () => {
    const { store, path } = fixture();
    store.store('member', 'active', 'semantic');
    const sourceUrl = new URL('./tiered-memory.ts', import.meta.url).href;
    const databaseModule = createRequire(import.meta.url).resolve('better-sqlite3');
    const script = `
      import { createRequire } from 'node:module';
      import { TieredMemoryStore } from ${JSON.stringify(sourceUrl)};
      const require = createRequire(import.meta.url);
      const Database = require(${JSON.stringify(databaseModule)});
      const db = new Database(process.argv[1]);
      const store = new TieredMemoryStore({ db });
      if (process.argv[2] === 'delete') store.remove('member');
      else store.store('member', 'inactive', 'semantic');
      db.close();
    `;
    const child = (action: string) => execFileSync(process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', script, path, action],
      { env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' }, timeout: 10_000 });
    child('update');
    expect(store.recall('member')[0]?.value).toBe('active'); // proves stale map exists
    expect(store.getExact('member', 'semantic')).toMatchObject({ status: 'found', entry: { value: 'inactive' } });
    child('delete'); // new process reopens, observes and removes the updated row
    expect(store.getExact('member', 'semantic')).toEqual({ status: 'missing' });
  });

  it('does not choose an active row when competing writes create ambiguous durable rows', () => {
    const { store, path } = fixture();
    const otherDb = new Database(path);
    connections.push(otherDb);
    const other = new TieredMemoryStore({ db: otherDb }); // both hydrate before either writes
    store.store('member', 'active', 'semantic');
    other.store('member', 'inactive', 'semantic');
    expect(store.getExact('member', 'semantic')).toEqual({ status: 'error', error: 'ambiguous_key' });
    expect(other.getExact('member', 'semantic')).toEqual({ status: 'error', error: 'ambiguous_key' });
  });

  it('distinguishes unsupported volatile storage, invalid arguments and storage failures from missing', () => {
    const volatile = new TieredMemoryStore();
    volatile.store('member', 'active', 'semantic');
    expect(volatile.getExact('member', 'semantic')).toEqual({ status: 'unsupported', error: 'durable_storage_required' });
    const { store, db } = fixture();
    for (const [key, tier] of [['', 'semantic'], ['a\0b', 'semantic'], ['x'.repeat(1001), 'semantic'], ['k', 'all']]) {
      expect(store.getExact(key!, tier!)).toEqual({ status: 'error', error: 'invalid_request' });
    }
    expect(store.getExact("' OR 1=1 --", 'semantic')).toEqual({ status: 'missing' });
    db.close();
    expect(store.getExact('member', 'semantic')).toEqual({ status: 'error', error: 'storage_error' });
  });
});
