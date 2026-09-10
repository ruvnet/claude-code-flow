/**
 * Regression coverage for #3249: `checkMemoryInitialization` must release the
 * sql.js handle on the failure path too.
 *
 * With encryption at rest the on-disk `memory.db` is an RFE1 ciphertext image.
 * sql.js accepts those bytes, but the schema query cannot parse them as SQLite
 * and throws — so `checkMemoryInitialization` fell through to its catch and
 * returned `{ initialized: false }` without ever reaching the inline
 * `db.close()`. That left the sql.js Database and its MEMFS copy open for the
 * life of the process, and every memory MCP tool call runs this check first, so
 * a long session accumulates one unclosed handle per call.
 *
 * The sql.js module is mocked so the assertion is on the observable contract
 * (was a handle opened, and was it closed?) rather than on process memory,
 * which would make the test slow and flaky.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const handle = vi.hoisted(() => ({
  instances: [] as Array<{ closed: boolean }>,
}));

// Set per test: what `db.exec()` does once the handle exists.
const behaviour = vi.hoisted(() => ({
  exec: (() => {
    throw new Error('file is not a database');
  }) as () => unknown,
}));

vi.mock('sql.js', () => {
  class Database {
    closed = false;

    constructor(_data?: unknown) {
      handle.instances.push(this);
    }

    exec(_sql: string): unknown {
      return behaviour.exec();
    }

    close(): void {
      this.closed = true;
    }
  }

  return { default: async () => ({ Database }) };
});

const {
  _resetMemoryRootCache,
  checkMemoryInitialization,
} = await import('../src/memory/memory-initializer.js');

let testDir: string;
let originalMemoryPath: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'memory-init-leak-3249-'));
  originalMemoryPath = process.env.CLAUDE_FLOW_MEMORY_PATH;
  process.env.CLAUDE_FLOW_MEMORY_PATH = testDir;
  _resetMemoryRootCache();
  handle.instances.length = 0;
  behaviour.exec = () => {
    throw new Error('file is not a database');
  };
});

afterEach(() => {
  if (originalMemoryPath === undefined) delete process.env.CLAUDE_FLOW_MEMORY_PATH;
  else process.env.CLAUDE_FLOW_MEMORY_PATH = originalMemoryPath;
  _resetMemoryRootCache();
  rmSync(testDir, { recursive: true, force: true });
});

describe('checkMemoryInitialization handle lifecycle (#3249)', () => {
  it('closes the handle when the schema query rejects the image', async () => {
    const dbPath = join(testDir, 'memory.db');
    // RFE1 ciphertext: bytes sql.js will accept but cannot parse as SQLite.
    writeFileSync(dbPath, Buffer.from('RFE1\x00\x01\x02 not a sqlite image', 'utf8'));

    const result = await checkMemoryInitialization(dbPath);

    expect(result.initialized).toBe(false);
    expect(handle.instances).toHaveLength(1);
    // The regression: this was `false` before the fix — the handle leaked.
    expect(handle.instances[0].closed).toBe(true);
  });

  it('closes the handle on the parsed path as well', async () => {
    const dbPath = join(testDir, 'memory.db');
    writeFileSync(dbPath, Buffer.from('SQLite format 3\x00', 'utf8'));
    behaviour.exec = () => [{ values: [['memory_entries'], ['metadata'], ['patterns']] }];

    const result = await checkMemoryInitialization(dbPath);

    expect(result.initialized).toBe(true);
    expect(result.tables).toContain('memory_entries');
    expect(handle.instances).toHaveLength(1);
    expect(handle.instances[0].closed).toBe(true);
  });

  it('opens no handle at all when the file is absent', async () => {
    const result = await checkMemoryInitialization(join(testDir, 'missing.db'));

    expect(result.initialized).toBe(false);
    expect(handle.instances).toHaveLength(0);
  });
});
