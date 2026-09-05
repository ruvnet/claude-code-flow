import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { TieredMemoryStore } from '../../memory/src/tiered-memory.js';
import * as bridge from '../src/memory/memory-bridge.js';
import { agentdbHierarchicalGet, agentdbTools } from '../src/mcp-tools/agentdb-tools.js';

afterEach(() => vi.restoreAllMocks());

describe('hierarchical exact getter bridge contract', () => {
  it('uses the supported durable controller getter and preserves exact found/missing distinctions', () => {
    const db = new Database(':memory:');
    try {
      const hm = new TieredMemoryStore({ db });
      hm.store('tenant-a:member', 'inactive', 'semantic');
      vi.spyOn(hm, 'recall').mockImplementation(() => { throw new Error('semantic fallback forbidden'); });
      expect(bridge.readHierarchicalExact(hm, { key: 'tenant-a:member', tier: 'semantic' }))
        .toMatchObject({ success: true, found: true, status: 'found', durable: true, entry: { value: 'inactive' } });
      expect(bridge.readHierarchicalExact(hm, { key: 'tenant-b:member', tier: 'semantic' }))
        .toMatchObject({ success: true, found: false, status: 'missing', durable: true });
    } finally { db.close(); }
  });

  it('never falls back to native recall or volatile hydrated maps', () => {
    const recall = vi.fn(() => [{ key: 'member', value: 'active' }]);
    for (const hm of [null, { recall, getStats: () => ({}), promote: () => {} }, new TieredMemoryStore()]) {
      expect(bridge.readHierarchicalExact(hm, { key: 'member', tier: 'semantic' }))
        .toMatchObject({ success: false, found: false, status: 'unsupported' });
    }
    expect(recall).not.toHaveBeenCalled();
  });

  it('preserves storage/integrity failure and rejects a getter returning another key or tier', () => {
    const base = { isDurable: () => true, getPersistence: () => 'sqlite' };
    for (const error of ['storage_error', 'ambiguous_key', 'invalid_temporal_metadata']) {
      expect(bridge.readHierarchicalExact({ ...base, getExact: () => ({ status: 'error', error }) }, { key: 'k', tier: 'semantic' }))
        .toMatchObject({ success: false, found: false, status: 'error', error });
    }
    for (const entry of [{ key: 'other', tier: 'semantic' }, { key: 'k', tier: 'working' }]) {
      expect(bridge.readHierarchicalExact({ ...base, getExact: () => ({ status: 'found', entry }) }, { key: 'k', tier: 'semantic' }))
        .toMatchObject({ success: false, found: false, status: 'error' });
    }
    expect(bridge.readHierarchicalExact({ ...base, getExact: () => { throw new Error('/private/path/db'); } }, { key: 'k', tier: 'semantic' }))
      .toEqual({ success: false, found: false, status: 'error', error: 'exact_get_failed' });
  });
});

describe('agentdb_hierarchical-get MCP surface', () => {
  it('registers an exact key + required tier contract without search or audit escape hatch', () => {
    expect(agentdbTools).toContain(agentdbHierarchicalGet);
    expect(agentdbHierarchicalGet.inputSchema.required).toEqual(['key', 'tier']);
    expect(Object.keys(agentdbHierarchicalGet.inputSchema.properties)).toEqual(['key', 'tier']);
  });

  it('rejects missing/invalid tier, unsafe key and semantic or expired overrides before dispatch', async () => {
    const get = vi.spyOn(bridge, 'bridgeHierarchicalGet').mockResolvedValue({ unexpected: true });
    for (const params of [{ key: 'k' }, { key: 'k', tier: 'all' }, { key: '', tier: 'semantic' },
      { key: 'k', tier: 'semantic', query: 'anything' }, { key: 'k', tier: 'semantic', includeExpired: true },
      { key: 'x'.repeat(1001), tier: 'semantic' }, { key: 'a\0b', tier: 'semantic' }]) {
      expect(await agentdbHierarchicalGet.handler(params)).toEqual({ success: false, found: false, status: 'error', error: 'invalid_request' });
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('passes only the exact validated request and preserves unsupported/error rather than returning a miss', async () => {
    const get = vi.spyOn(bridge, 'bridgeHierarchicalGet');
    for (const result of [{ success: false, found: false, status: 'unsupported', error: 'durable_exact_get_unsupported' },
      { success: false, found: false, status: 'error', error: 'ambiguous_key' },
      { success: true, found: false, status: 'missing' }]) {
      get.mockResolvedValue(result);
      expect(await agentdbHierarchicalGet.handler({ key: 'ruclip:company:a:member:u', tier: 'semantic' })).toEqual(result);
      expect(get).toHaveBeenLastCalledWith({ key: 'ruclip:company:a:member:u', tier: 'semantic' });
    }
  });
});
