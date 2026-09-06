import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TieredMemoryStore } from '../../memory/src/tiered-memory.js';
import { __setMemoryBridgeRegistryForTests, bridgeHealthCheck, readHierarchicalExact } from '../src/memory/memory-bridge.js';

afterEach(() => __setMemoryBridgeRegistryForTests(null));

it('reports effective native protected FULL health and fails exact reads after drift', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-protected-full-'));
  const db = new Database(join(dir, 'memory.sqlite'));
  try {
    db.pragma('journal_mode=WAL'); db.pragma('synchronous=NORMAL');
    const hm = new TieredMemoryStore({ db, protectedRetention: { prefixes: [{ tier: 'semantic', keyPrefix: 'identity:' }], maxEntries: 2 } });
    hm.createIfAbsent('identity:alice', 'inactive', 'semantic');
    __setMemoryBridgeRegistryForTests({ listControllers: () => [], get: (name: string) => name === 'hierarchicalMemory' ? hm : null });
    const health = await bridgeHealthCheck();
    expect(health?.hierarchicalMemory).toMatchObject({ persistedRows: 1, protectedSqlite: { required: true, fullSynchronization: true, journalMode: 'wal' } });
    expect(health?.hierarchicalMemory?.protectedSqlite?.sqliteVersion).toBe((db.prepare('SELECT sqlite_version() AS v').get() as {v:string}).v);
    db.pragma('synchronous=NORMAL');
    expect((await bridgeHealthCheck())?.hierarchicalMemory?.protectedSqlite).toMatchObject({ required: true, fullSynchronization: false, ready: false });
    expect(readHierarchicalExact(hm, { key: 'identity:alice', tier: 'semantic' })).toMatchObject({ success: false, status: 'error', error: 'protected_durability_required' });
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
