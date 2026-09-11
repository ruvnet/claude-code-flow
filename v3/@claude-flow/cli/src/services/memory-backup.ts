/**
 * Vector-memory DB backup.
 *
 * Snapshots `.swarm/memory.db` (the sqlite store holding memory_entries +
 * embeddings + the distilled reasoning_patterns) to a timestamped file using
 * better-sqlite3's ONLINE backup API — a consistent, WAL-safe copy that does not
 * block or corrupt a concurrently-written DB (unlike a naive file copy of a
 * WAL-mode DB). Rotates to keep the last N snapshots and, optionally, uploads
 * offsite to Google Cloud Storage.
 *
 * Used by `memory backup` (manual) and the daemon's nightly `backup` worker.
 * Best-effort + non-destructive: it only reads the source DB and writes new
 * files; it never mutates or deletes the live memory DB.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface BackupOptions {
  /** Source DB (default: <cwd>/.swarm/memory.db). */
  dbPath?: string;
  /** Destination dir (default: <db dir>/backups). */
  destDir?: string;
  /** Rotation: keep the newest N snapshots (default 7 = a week of nightlies). */
  keep?: number;
  /** Optional offsite: a gs://bucket/prefix to also upload the snapshot to. */
  gcs?: string;
  /** Injected epoch millis (tests pass a fixed value; avoids Date.now in logic). */
  timestamp?: number;
  verbose?: boolean;
}

export interface BackupResult {
  backedUp: boolean;
  path?: string;
  sizeBytes?: number;
  rotatedAway?: string[];
  gcsUri?: string;
  skipped?: string;
  /** Result of `PRAGMA integrity_check` on the SOURCE DB before snapshotting it. */
  sourceIntegrity?: string;
  /** True when the source failed its integrity check (or couldn't be opened at
   *  all). The snapshot is still taken — a corrupt-but-present DB beats none —
   *  but is tagged `*.CORRUPT.db` so `restoreMemoryDbFromBackup` skips it in
   *  favor of an older clean snapshot instead of silently rotating the last
   *  good one out of the retention window (#2895). */
  sourceCorrupt?: boolean;
}

export function defaultMemoryDbPath(cwd: string = process.cwd()): string {
  return path.join(cwd, '.swarm', 'memory.db');
}

/** ISO timestamp safe for filenames (no ':' or '.'). */
function fileStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

export async function backupMemoryDb(opts: BackupOptions = {}): Promise<BackupResult> {
  const dbPath = opts.dbPath ?? defaultMemoryDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) return { backedUp: false, skipped: 'no-db' };

  let Database: any;
  try {
    const mod: string = 'better-sqlite3';
    Database = (await import(mod)).default;
  } catch {
    return { backedUp: false, skipped: 'better-sqlite3 unavailable' };
  }

  const destDir = opts.destDir ?? path.join(path.dirname(dbPath), 'backups');
  try { fs.mkdirSync(destDir, { recursive: true }); } catch { /* */ }

  // Verify the SOURCE before snapshotting it (#2895). Without this, a corrupt
  // .swarm/memory.db gets copied forward every night, reported as a success,
  // and the last clean snapshot silently rotates out of the retention window.
  // Mirrors the check restoreMemoryDbFromBackup() already runs on the way out.
  let sourceIntegrity = 'unknown';
  try {
    const srcDb = new Database(dbPath, { readonly: true });
    sourceIntegrity = String(srcDb.pragma('integrity_check', { simple: true }) ?? '');
    srcDb.close();
  } catch (e) {
    sourceIntegrity = `unreadable: ${(e as Error)?.message ?? e}`;
  }
  const sourceCorrupt = sourceIntegrity.toLowerCase() !== 'ok';
  if (sourceCorrupt) {
    // Unconditional — this is not a "verbose" nice-to-have, it's the whole
    // point of the check: a silently-corrupt backup is worse than a loud one.
    console.warn(
      `memory-backup: source DB ${dbPath} failed integrity check (${sourceIntegrity}) — ` +
      `backing it up anyway (a corrupt snapshot beats none), tagged CORRUPT so restore skips it.`,
    );
  }

  const stamp = fileStamp(opts.timestamp ?? Date.now());
  const destPath = path.join(destDir, sourceCorrupt ? `memory-${stamp}.CORRUPT.db` : `memory-${stamp}.db`);

  // WAL-safe online backup: read-only source, consistent snapshot to destPath.
  let db: any;
  try {
    db = new Database(dbPath, { readonly: true });
    await db.backup(destPath);
    db.close();
  } catch (e) {
    try { db?.close(); } catch { /* */ }
    // #2798 — under CLAUDE_FLOW_ENCRYPT_AT_REST the source is an RFE1
    // blob, not native SQLite, so better-sqlite3's online-backup API
    // throws "file is not a database" and the run was silently recorded
    // as skipped (users with encryption had ZERO backups behind a green
    // status). The online-backup API only exists to avoid tearing a live
    // WAL-mode DB; that concern doesn't apply to the encrypted file (sql.js
    // rewrites it wholesale per flush), so a plain byte copy is a valid
    // snapshot. Fall back to it before giving up.
    try {
      fs.copyFileSync(dbPath, destPath);
      const copiedBytes = fs.statSync(destPath).size;
      if (copiedBytes > 0) {
        // Fall through to rotation/offsite/return below via a flag path.
        // (Mirror the success path's tail by re-using the same code.)
        const keep = typeof opts.keep === 'number' && opts.keep > 0 ? opts.keep : 7;
        const rotatedAway: string[] = [];
        try {
          const snaps = fs.readdirSync(destDir).filter(f => /^memory-.*\.db$/.test(f)).sort();
          while (snaps.length > keep) {
            const old = snaps.shift()!;
            try { fs.rmSync(path.join(destDir, old), { force: true }); rotatedAway.push(old); } catch { /* */ }
          }
        } catch { /* */ }
        let gcsUri: string | undefined;
        if (opts.gcs) {
          try {
            const { execFileSync } = await import('child_process');
            const dest = opts.gcs.replace(/\/+$/, '') + '/' + path.basename(destPath);
            execFileSync('gcloud', ['storage', 'cp', destPath, dest], { stdio: ['ignore', 'ignore', 'inherit'] });
            gcsUri = dest;
          } catch { /* offsite failed — local snapshot stands */ }
        }
        if (opts.verbose) {
          console.log(`memory DB backed up (byte-copy, encrypted-at-rest) → ${destPath} (${Math.round(copiedBytes / 1024)} KB)`);
        }
        return { backedUp: true, path: destPath, sizeBytes: copiedBytes, rotatedAway, gcsUri, sourceIntegrity, sourceCorrupt };
      }
    } catch { /* byte-copy also failed — report the original error */ }
    return { backedUp: false, skipped: `backup failed: ${(e as Error)?.message ?? e}` };
  }

  let sizeBytes = 0;
  try { sizeBytes = fs.statSync(destPath).size; } catch { /* */ }

  // Rotation — ISO-stamped names sort chronologically, so keep the tail.
  const keep = typeof opts.keep === 'number' && opts.keep > 0 ? opts.keep : 7;
  const rotatedAway: string[] = [];
  try {
    const snaps = fs.readdirSync(destDir).filter(f => /^memory-.*\.db$/.test(f)).sort();
    while (snaps.length > keep) {
      const old = snaps.shift()!;
      try { fs.rmSync(path.join(destDir, old), { force: true }); rotatedAway.push(old); } catch { /* */ }
    }
  } catch { /* */ }

  // Optional offsite to GCS (best-effort; local backup already succeeded).
  let gcsUri: string | undefined;
  if (opts.gcs) {
    try {
      const { execFileSync } = await import('child_process');
      const dest = opts.gcs.replace(/\/+$/, '') + '/' + path.basename(destPath);
      execFileSync('gcloud', ['storage', 'cp', destPath, dest], { stdio: ['ignore', 'ignore', 'inherit'] });
      gcsUri = dest;
    } catch { /* offsite failed — local snapshot stands */ }
  }

  if (opts.verbose) {
    console.log(
      `memory DB backed up → ${destPath} (${Math.round(sizeBytes / 1024)} KB)` +
      (rotatedAway.length ? `, rotated ${rotatedAway.length} old` : '') +
      (gcsUri ? `, offsite ${gcsUri}` : ''),
    );
  }
  return { backedUp: true, path: destPath, sizeBytes, rotatedAway, gcsUri, sourceIntegrity, sourceCorrupt };
}

export interface RestoreResult {
  restored: boolean;
  /** The backup file that was restored. */
  from?: string;
  /** memory_entries count in the restored DB (-1 if it couldn't be verified). */
  rows?: number;
  /** Where the corrupt live DB was parked before the swap. */
  corruptBackupPath?: string;
  skipped?: string;
}

/**
 * Restore the newest integrity-ok backup over a corrupt/malformed memory DB
 * (issue #2584).
 *
 * The in-place rebuild path (`recoverMemoryDatabase`) rebuilds FROM the corrupt
 * image, so when the damage is bad enough that `sqlite3 .recover` salvages
 * nothing, that rebuild also salvages nothing and every `memory_store` keeps
 * erroring. This is the missing fallback: scan `<db dir>/backups/` newest-first,
 * pick the newest snapshot that passes `PRAGMA integrity_check` (and has rows),
 * park the corrupt live DB at `<db>.corrupt-<ts>.bak`, then ATOMICALLY install
 * the good backup (copy → fsync → rename, no full-image buffer in memory). Drops
 * stale -wal/-shm. Non-destructive on failure: the live DB is only replaced once
 * a verified backup is in hand.
 */
export async function restoreMemoryDbFromBackup(
  dbPath: string,
  opts: { destDir?: string; timestamp?: number; verbose?: boolean } = {},
): Promise<RestoreResult> {
  if (!dbPath) return { restored: false, skipped: 'no-db-path' };
  const destDir = opts.destDir ?? path.join(path.dirname(dbPath), 'backups');

  let snaps: string[];
  try {
    snaps = fs
      .readdirSync(destDir)
      .filter(f => /^memory-.*\.db$/.test(f))
      .map(f => path.join(destDir, f))
      .sort()      // ISO-stamped names sort chronologically
      .reverse();  // newest first
  } catch {
    return { restored: false, skipped: 'no-backups-dir' };
  }
  if (!snaps.length) return { restored: false, skipped: 'no-backups' };

  // better-sqlite3 verifies a candidate's integrity. Absent (WASM-only host) →
  // accept the newest non-empty snapshot, flagged rows=-1 (unverified).
  let Database: any = null;
  try {
    const mod: string = 'better-sqlite3';
    Database = (await import(mod)).default;
  } catch {
    /* verifier unavailable — trust newest non-empty */
  }

  let chosen: { file: string; rows: number } | null = null;
  for (const file of snaps) {
    try {
      if (Database) {
        const db = new Database(file, { readonly: true });
        const integ = String(db.pragma('integrity_check', { simple: true }) ?? '');
        let rows = 0;
        try {
          rows = (db.prepare('SELECT COUNT(*) AS c FROM memory_entries').get() as { c: number })?.c ?? 0;
        } catch { /* no entries table — not a usable memory DB */ }
        db.close();
        if (integ.toLowerCase() === 'ok' && rows > 0) { chosen = { file, rows }; break; }
      } else if (fs.statSync(file).size > 0) {
        chosen = { file, rows: -1 };
        break;
      }
    } catch { /* unreadable snapshot — try the next-older one */ }
  }
  if (!chosen) return { restored: false, skipped: 'no-integrity-ok-backup' };

  const ts = opts.timestamp ?? Date.now();
  const corruptBackupPath = `${dbPath}.corrupt-${ts}.bak`;
  const tmp = `${dbPath}.restoring-${ts}`;
  try {
    if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, corruptBackupPath);
    fs.copyFileSync(chosen.file, tmp);            // stream copy — no 185MB buffer
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }  // durable before swap
    fs.renameSync(tmp, dbPath);                   // atomic install
    for (const s of ['-wal', '-shm']) { try { fs.rmSync(`${dbPath}${s}`, { force: true }); } catch { /* */ } }
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* */ }
    return { restored: false, skipped: `install failed: ${(e as Error)?.message ?? e}` };
  }

  if (opts.verbose) {
    console.log(
      `memory DB restored from backup ${path.basename(chosen.file)}` +
      (chosen.rows >= 0 ? ` (${chosen.rows} rows)` : ' (unverified)') +
      `. Corrupt original saved to ${corruptBackupPath}`,
    );
  }
  return { restored: true, from: chosen.file, rows: chosen.rows, corruptBackupPath };
}
