import type { TieredMemoryDb } from './tiered-memory.js';

/** This is a trusted driver contract, not authentication of an arbitrary object.
 * Requiring effective settings and a file-backed transactional handle excludes
 * the existing sql.js compatibility adapters, which cannot attest native commits. */
export interface ProtectedSqliteConnection extends TieredMemoryDb {
  pragma(statement: string, options?: { simple: boolean }): unknown;
  readonly open: boolean;
  readonly readonly: boolean;
  readonly memory: boolean;
  readonly inTransaction: boolean;
}
export interface ProtectedSqliteReadiness {
  required: boolean;
  fullSynchronization: boolean;
  sqliteVersion: string | null;
  journalMode: string | null;
  walResetFixed: boolean | null;
  ready: boolean;
  reason?: string;
}
function error(code: string): never { throw new Error(`protected_durability_${code}`); }
function sync(value: unknown): unknown {
  if (value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function') {
    void Promise.resolve(value).catch(() => {});
    error('synchronous_driver_required');
  }
  return value;
}

/** Primary SQLite advisory: https://www.sqlite.org/wal.html#walreset . This
 * narrowly detects the known fix, not overall engine or deployment safety. */
export function hasWalResetFix(version: unknown): boolean | null {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  const [major, minor, patch] = version.split('.').map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  if (major !== 3) return null;
  return minor > 51 || (minor === 51 && patch >= 3) || (minor === 50 && patch >= 7) || (minor === 44 && patch >= 6);
}

export class ProtectedSqliteDurability {
  private required = false;
  private readonly db: TieredMemoryDb;
  constructor(db: TieredMemoryDb) { this.db = db; }

  private connection(): ProtectedSqliteConnection {
    const d = this.db as Partial<ProtectedSqliteConnection>;
    if (typeof d.pragma !== 'function' || d.open !== true || d.readonly !== false || d.memory !== false || typeof d.inTransaction !== 'boolean') error('file_driver_required');
    return d as ProtectedSqliteConnection;
  }

  /** One-time connection adoption. Never silently repairs later drift. */
  enable(): void {
    if (this.required) { this.assertFull(); return; }
    const d = this.connection();
    if (d.inTransaction !== false) error('transaction_active');
    sync(d.pragma('synchronous = FULL'));
    this.assertFull();
    this.required = true;
  }

  assertFull(): void {
    const d = this.connection();
    if (sync(d.pragma('synchronous', { simple: true })) !== 2) error('full_required');
    const row = sync(d.prepare('PRAGMA synchronous').get()) as { synchronous?: unknown } | undefined;
    if (row?.synchronous !== 2) error('full_readback_failed');
  }

  /** Diagnostics are metadata only and never turn an unsupported engine into
   * release authority. Unknown/failing inspection is explicitly not ready. */
  inspect(): ProtectedSqliteReadiness {
    const result: ProtectedSqliteReadiness = { required: this.required, fullSynchronization: false, sqliteVersion: null, journalMode: null, walResetFixed: null, ready: false };
    if (!this.required) return { ...result, reason: 'protection_not_configured' };
    try {
      this.assertFull(); result.fullSynchronization = true;
      const d = this.connection();
      const row = sync(d.prepare('SELECT sqlite_version() AS version').get()) as { version?: unknown } | undefined;
      if (typeof row?.version === 'string' && /^\d+\.\d+\.\d+$/.test(row.version)) result.sqliteVersion = row.version;
      const mode = sync(d.pragma('journal_mode', { simple: true }));
      if (typeof mode === 'string' && ['wal', 'delete', 'truncate', 'persist', 'memory', 'off'].includes(mode)) result.journalMode = mode;
      this.assertFull();
      result.walResetFixed = hasWalResetFix(result.sqliteVersion);
      // Require reviewed durable journaling. A version diagnostic does not
      // enforce a broad dependency/API break on existing legacy installations.
      result.ready = result.walResetFixed === true && ['wal', 'delete', 'truncate', 'persist'].includes(result.journalMode ?? '');
      if (!result.ready) result.reason = result.walResetFixed !== true ? 'sqlite_wal_reset_fix_unverified' : 'durable_journal_unverified';
      return result;
    } catch { return { ...result, fullSynchronization: false, ready: false, reason: 'effective_full_unverified' }; }
  }
}

/** Do not create policy tables just to discover whether protection exists. */
export function hasPersistedProtection(db: TieredMemoryDb): boolean {
  const table = sync(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tiered_memory_protected_config'").get());
  if (!table) return false;
  return !!sync(db.prepare('SELECT policy FROM tiered_memory_protected_config WHERE singleton=1').get());
}
