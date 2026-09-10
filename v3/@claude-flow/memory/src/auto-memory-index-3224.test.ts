/**
 * #3224 — a curate may grow or reorder the index, never shrink it.
 *
 * `curateIndex()` rebuilds MEMORY.md from the bridge's own topic files. The
 * #1556 guard only skips the write when NOTHING matched — but the bridge writes
 * the first topic file itself, so after the first insight the guard stops
 * applying and the rebuild replaces a hand-maintained index with a stub. The
 * reported case lost 75 lines and 49 links.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoMemoryBridge } from './auto-memory-bridge.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'm3224-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

/** A hand-maintained index: many links, no relation to the bridge's topic files. */
function writeUserIndex(): string {
  const lines = ['# Project Memory', ''];
  for (let i = 0; i < 49; i++) lines.push(`- [Note ${i}](note_${i}.md) — something I wrote`);
  const body = lines.join('\n');
  writeFileSync(join(dir, 'MEMORY.md'), body, 'utf-8');
  return body;
}

describe('#3224 curateIndex must not destroy a user index', () => {
  it('keeps a larger hand-maintained index and writes the generated view beside it', async () => {
    const before = writeUserIndex();
    // One topic file exists, so the #1556 guard no longer applies — the exact
    // state the bridge puts itself in after its first insight.
    writeFileSync(join(dir, 'patterns.md'), '# Patterns\n\n- one generated line\n', 'utf-8');

    const bridge = new AutoMemoryBridge({} as never, { memoryDir: dir } as never);
    const preserved: unknown[] = [];
    bridge.on('index:preserved', (e: unknown) => preserved.push(e));
    await bridge.curateIndex();

    const after = readFileSync(join(dir, 'MEMORY.md'), 'utf-8');
    expect(after, 'the user index must survive verbatim').toBe(before);
    expect((after.match(/\]\(/g) ?? []).length).toBe(49);
    expect(preserved.length, 'and the bridge must say it declined').toBe(1);
    expect(existsSync(join(dir, 'MEMORY.generated.md')), 'generated view goes beside it').toBe(true);
  });

  it('still writes the index when there is nothing to lose', async () => {
    writeFileSync(join(dir, 'patterns.md'), '# Patterns\n\n- generated\n', 'utf-8');
    const bridge = new AutoMemoryBridge({} as never, { memoryDir: dir } as never);
    await bridge.curateIndex();
    expect(existsSync(join(dir, 'MEMORY.md'))).toBe(true);
  });
});
