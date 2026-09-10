/**
 * #3196: report the store this interface is NOT reading.
 *
 * `memory.db` (sql.js, encrypted at rest when enabled) and `agentdb-memory.db`
 * (native better-sqlite3, plaintext) are deliberately separate files — see
 * #2786; pointing native at an encrypted file fails and silently disables the
 * learning system. Both are legitimate stores, and a read of one is not a read
 * of the other.
 *
 * The danger is not the split. It is a count that describes one file as though
 * it described the memory. This module exists so the CLI can say what it did
 * not read, without opening, migrating or modifying that file.
 */
import { existsSync } from 'node:fs';
import { siblingAgentDbPath } from './memory-bridge.js';

export interface SiblingStoreReport {
  path: string;
  rows: number;
}

/**
 * Count rows in the sibling AgentDB store, read-only. Returns null when there
 * is no sibling, it does not exist, or it cannot be read — an unreadable store
 * is not evidence of an empty one, so we stay silent rather than claim zero.
 */
export async function countSiblingStoreRows(dbPath: string): Promise<SiblingStoreReport | null> {
  const sibling = siblingAgentDbPath(dbPath);
  if (!sibling || !existsSync(sibling)) return null;
  try {
    const require = (await import('node:module')).createRequire(import.meta.url);
    // Optional native dependency: absence must degrade to silence, never throw.
    const Database = require('better-sqlite3');
    const db = new Database(sibling, { readonly: true, fileMustExist: true });
    try {
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries'")
        .get();
      if (!table) return null;
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE (status = 'active' OR status IS NULL)")
        .get() as { n?: number } | undefined;
      const rows = Number(row?.n ?? 0);
      return rows > 0 ? { path: sibling, rows } : null;
    } finally {
      try { db.close(); } catch { /* best effort */ }
    }
  } catch {
    return null;
  }
}
