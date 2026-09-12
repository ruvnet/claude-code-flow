/**
 * Restricted-permission file helpers.
 *
 * audit_1776853149979: session/memory/terminal stores were written with the
 * process umask, which on most macOS/Linux setups leaves them world-readable
 * (mode 0644). They contain conversation snapshots, agent prompts, and
 * terminal command history — anyone else on the host can read them.
 *
 * These helpers write atomically and force mode 0600 (files) / 0700 (dirs).
 * chmod fails silently on Windows, where POSIX modes don't apply — that's
 * fine, the OS-level ACL surface there is different.
 *
 * ADR-096 Phase 2: optional opt-in encryption-at-rest. When the caller
 * passes `encrypt: true` AND the env-gated vault is enabled, payloads are
 * AES-256-GCM-encrypted before hitting disk. Reads use the magic-byte
 * sniff so legacy plaintext files keep working unchanged during the
 * incremental migration.
 */

import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  decryptBuffer,
  encryptBuffer,
  getKey,
  isEncryptedBlob,
  isEncryptionEnabled,
} from './encryption/vault.js';

/**
 * Crash-safe atomic file write (issue #2584).
 *
 * A plain `writeFileSync(dbPath, db.export())` of a large sql.js image is NOT
 * crash-safe: a kill/OOM mid-write — or a second process rewriting the same
 * path concurrently — leaves a half-written image, and reopening it yields
 * `database disk image is malformed`. The corruption window scales with file
 * size, so a 185 MB monolithic flush is especially exposed.
 *
 * This writes to a unique temp sibling, fsyncs the bytes to disk, then
 * `rename()`s over the target. rename() is atomic on POSIX within one
 * filesystem, so a reader/reopen sees either the old complete image or the new
 * complete image — never a torn one. The directory entry is best-effort fsynced
 * so the rename itself survives a crash. On any failure the temp file is
 * removed and the original is left untouched.
 */
export function writeFileAtomic(
  path: string,
  data: Buffer,
  opts: { mode?: number } = {},
): void {
  const mode = opts.mode ?? 0o600;
  const dir = dirname(path);
  const tmp = join(
    dir,
    `.${basename(path)}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', mode);
    if (data.length > 0) writeSync(fd, data, 0, data.length, 0);
    fsyncSync(fd); // durability: force bytes to disk BEFORE the rename
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path); // atomic swap — readers never see a torn image
    try {
      chmodSync(path, mode);
    } catch {
      // Windows / FS without POSIX modes — silently skip.
    }
    // Best-effort: fsync the directory so the rename survives a power loss.
    try {
      const dfd = openSync(dir, 'r');
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      // Directory fsync unsupported (e.g. Windows) — the rename is still atomic.
    }
  } catch (e) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* temp never created / already gone */
    }
    throw e;
  }
}

/**
 * Create a directory tree with mode 0700 (owner-only). No-op if exists.
 * Uses recursive: true so missing parents are created with the same mode.
 */
export function mkdirRestricted(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/**
 * Options for writeFileRestricted. Object form so we can grow the API
 * without churning every call site.
 */
export interface WriteOptions {
  /** Buffer encoding when `data` is a string. Ignored for Buffer payloads. */
  encoding?: BufferEncoding;
  /**
   * If true AND encryption is globally enabled (CLAUDE_FLOW_ENCRYPT_AT_REST),
   * encrypt the payload with AES-256-GCM before writing. If encryption is
   * NOT enabled, this flag is silently ignored — the legacy plaintext path
   * runs unchanged. Default: false.
   */
  encrypt?: boolean;
}

/**
 * Write a file and tighten its permissions to mode 0600 (owner read/write).
 *
 * Two call signatures, both supported (the legacy positional one keeps
 * existing call sites working without churn):
 *
 *   writeFileRestricted(path, data)                      // plaintext, utf-8
 *   writeFileRestricted(path, data, 'utf-8')             // legacy: encoding only
 *   writeFileRestricted(path, data, { encrypt: true })   // opt-in encryption
 */
export function writeFileRestricted(
  path: string,
  data: string | Buffer,
  optsOrEncoding: BufferEncoding | WriteOptions = 'utf-8',
): void {
  const opts: WriteOptions =
    typeof optsOrEncoding === 'string'
      ? { encoding: optsOrEncoding }
      : optsOrEncoding;
  const encoding = opts.encoding ?? 'utf-8';

  let payload: string | Buffer = data;
  if (opts.encrypt && isEncryptionEnabled()) {
    const plaintext = Buffer.isBuffer(data) ? data : Buffer.from(data, encoding);
    payload = encryptBuffer(plaintext, getKey());
  }

  // Atomic write (temp → fsync → rename) so a torn/concurrent flush can never
  // leave a half-written file — the failure mode behind issue #2584. Buffers go
  // straight through; strings are encoded first (default utf-8).
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, encoding);
  writeFileAtomic(path, buf, { mode: 0o600 });
}

/**
 * Read a file and transparently decrypt if it carries the RFE1 magic.
 *
 * Returns a string when the caller asks for one (default utf-8). Returns
 * a Buffer when `encoding` is null. This matches Node's readFileSync
 * shape so the function is a near-drop-in replacement.
 *
 * Migration semantics:
 *   - If the file IS encrypted, decrypt and return.
 *   - If the file is NOT encrypted, return its raw bytes (string-decoded
 *     under `encoding` if requested).
 *
 * That means a reader can be migrated *first*, before its writer flips
 * `encrypt: true`, without breaking on the legacy plaintext path.
 */
export function readFileMaybeEncrypted(
  path: string,
  encoding?: BufferEncoding,
): string;
export function readFileMaybeEncrypted(
  path: string,
  encoding: null,
): Buffer;
export function readFileMaybeEncrypted(
  path: string,
  encoding: BufferEncoding | null = 'utf-8',
): string | Buffer {
  const raw = readFileSync(path);
  let plain: Buffer;
  if (isEncryptedBlob(raw)) {
    // 'decrypt': the blob on disk is RFE1-encrypted but the enable flag may
    // be unset (e.g. store restored from another machine) — see #3212.
    plain = decryptBuffer(raw, getKey('decrypt'));
  } else {
    plain = raw;
  }
  return encoding === null ? plain : plain.toString(encoding);
}
