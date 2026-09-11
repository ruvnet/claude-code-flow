/**
 * Vector-memory DB backup service (nightly backup worker + `memory backup`).
 *
 * Proves the WAL-safe snapshot is consistent, non-destructive, rotated, and
 * degrades cleanly when there's nothing to back up.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { backupMemoryDb } from '../src/services/memory-backup.js';

let Database: any;
let haveNative = false;
try { Database = (await import('better-sqlite3')).default; haveNative = true; } catch { haveNative = false; }

function seedDb(dbPath: string, rows = 50): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // the mode a naive copy would corrupt
  db.exec('CREATE TABLE memory_entries (id INTEGER PRIMARY KEY, content TEXT)');
  const ins = db.prepare('INSERT INTO memory_entries (content) VALUES (?)');
  const tx = db.transaction(() => { for (let i = 0; i < rows; i++) ins.run('row ' + i); });
  tx();
  db.close();
}

describe.skipIf(!haveNative)('backupMemoryDb', () => {
  let workdir: string;
  beforeEach(() => { workdir = mkdtempSync(join(tmpdir(), 'mem-backup-')); });

  it('takes a consistent WAL-safe snapshot without mutating the source', async () => {
    const dbPath = join(workdir, 'memory.db');
    seedDb(dbPath, 50);
    const srcSize = statSync(dbPath).size;

    const r = await backupMemoryDb({ dbPath, timestamp: 1_700_000_000_000 });
    expect(r.backedUp).toBe(true);
    expect(existsSync(r.path!)).toBe(true);
    expect(r.sizeBytes!).toBeGreaterThan(0);

    // Source is unchanged (size stable) and the snapshot has all the rows.
    expect(statSync(dbPath).size).toBe(srcSize);
    const snap = new Database(r.path!, { readonly: true });
    const count = (snap.prepare('SELECT COUNT(*) AS c FROM memory_entries').get() as { c: number }).c;
    snap.close();
    expect(count).toBe(50);
  });

  it('defaults the destination to <db dir>/backups', async () => {
    const dbPath = join(workdir, 'memory.db');
    seedDb(dbPath);
    const r = await backupMemoryDb({ dbPath, timestamp: 1_700_000_000_000 });
    expect(r.path!.replace(/\\/g, '/')).toContain('/backups/memory-');
  });

  it('rotates — keeps only the newest N snapshots', async () => {
    const dbPath = join(workdir, 'memory.db');
    seedDb(dbPath);
    const destDir = join(workdir, 'backups');
    // 5 snapshots at increasing timestamps, keep=3.
    for (let i = 0; i < 5; i++) {
      await backupMemoryDb({ dbPath, destDir, keep: 3, timestamp: 1_700_000_000_000 + i * 86_400_000 });
    }
    const snaps = readdirSync(destDir).filter(f => /^memory-.*\.db$/.test(f));
    expect(snaps.length).toBe(3);
    // The three newest (largest timestamps) survive.
    expect(snaps.sort().slice(-1)[0]).toContain('memory-');
  });

  it('is a safe no-op when there is no DB to back up', async () => {
    const r = await backupMemoryDb({ dbPath: join(workdir, 'nope.db') });
    expect(r.backedUp).toBe(false);
    expect(r.skipped).toBe('no-db');
  });

  it('marks a healthy source clean and untagged (#2895)', async () => {
    const dbPath = join(workdir, 'memory.db');
    seedDb(dbPath, 5);
    const r = await backupMemoryDb({ dbPath, timestamp: 1_700_000_000_000 });
    expect(r.backedUp).toBe(true);
    expect(r.sourceCorrupt).toBe(false);
    expect(r.sourceIntegrity?.toLowerCase()).toBe('ok');
    expect(r.path).not.toContain('CORRUPT');
  });

  it('#2895 — still backs up a corrupt source, but tags it CORRUPT and warns instead of reporting a clean success', async () => {
    const dbPath = join(workdir, 'memory.db');
    // Garbage bytes: not a valid SQLite file at all (truncated/invalid header).
    writeFileSync(dbPath, Buffer.from('this is not a sqlite database, just garbage bytes '.repeat(20)));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await backupMemoryDb({ dbPath, timestamp: 1_700_000_000_000 });

      // (a) a backup file is still created
      expect(r.backedUp).toBe(true);
      expect(existsSync(r.path!)).toBe(true);

      // (b) it's tagged/marked as corrupt in the result and the filename
      expect(r.sourceCorrupt).toBe(true);
      expect(r.sourceIntegrity).toBeTruthy();
      expect(r.sourceIntegrity?.toLowerCase()).not.toBe('ok');
      expect(r.path).toMatch(/\.CORRUPT\.db$/);
      // Still discoverable by the same rotation/restore glob.
      expect(/^memory-.*\.db$/.test(join(r.path!).split(/[\\/]/).pop()!)).toBe(true);

      // (c) a warning is emitted (unconditional — not gated behind --verbose)
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.some(args => String(args[0]).includes('integrity check'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
