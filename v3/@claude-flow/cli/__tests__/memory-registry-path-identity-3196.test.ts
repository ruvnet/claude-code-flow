/**
 * #3196 — an explicit database path must select that database.
 *
 * The bridge used to cache one registry globally: the first caller to touch it
 * decided the file for the whole process, and every later caller's `dbPath` was
 * accepted and then ignored. That is how a CLI write and an MCP write ended up
 * in two files while both reported success.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { siblingAgentDbPath, _resetRegistryCacheForTest } from '../src/memory/memory-bridge.js';
import { countSiblingStoreRows } from '../src/memory/sibling-store.js';

describe('#3196 sibling store identity', () => {
  beforeEach(() => _resetRegistryCacheForTest());

  it('names the AgentDB store beside a given database, and never itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem3196-'));
    const primary = join(dir, 'memory.db');
    expect(siblingAgentDbPath(primary)).toBe(join(dir, 'agentdb-memory.db'));
    // A path that already IS the sibling has no sibling of its own — otherwise a
    // disclosure would point a reader back at the file they just read.
    expect(siblingAgentDbPath(join(dir, 'agentdb-memory.db'))).toBeNull();
    expect(siblingAgentDbPath(':memory:')).toBeNull();
    expect(siblingAgentDbPath('')).toBeNull();
  });

  it('resolves relative paths so one file cannot become two registries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem3196-'));
    const a = siblingAgentDbPath(join(dir, 'memory.db'));
    const b = siblingAgentDbPath(join(dir, '.', 'memory.db'));
    expect(a).toBe(b);
  });

  it('stays silent when the sibling is absent or unreadable, rather than claiming zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem3196-'));
    // No sibling at all.
    await expect(countSiblingStoreRows(join(dir, 'memory.db'))).resolves.toBeNull();
    // Present but not a database: an unreadable store is not evidence of an
    // empty one, so the caller must get null and print nothing.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agentdb-memory.db'), 'not a database');
    await expect(countSiblingStoreRows(join(dir, 'memory.db'))).resolves.toBeNull();
  });
});
