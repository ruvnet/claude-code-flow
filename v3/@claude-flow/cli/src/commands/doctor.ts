/**
 * V3 CLI Doctor Command
 * System diagnostics, dependency checks, config validation
 *
 * Created with ruv.io
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import { decodeKey, isEncryptionEnabled } from '../encryption/vault.js';
import { isEncryptedBlob } from '../encryption/vault.js';
import {
  resolveMemoryPackageFromProject,
  readMemoryPackageVersion,
  recordMemoryPackagePath,
} from '../init/memory-package-resolver.js';

// Promisified exec with proper shell and env inheritance for cross-platform support
const execAsync = promisify(exec);

/**
 * Execute command asynchronously with proper environment inheritance
 * Critical for Windows where PATH may not be inherited properly
 */
async function runCommand(command: string, timeoutMs: number = 5000): Promise<string> {
  const { stdout } = await execAsync(command, {
    encoding: 'utf8' as BufferEncoding,
    timeout: timeoutMs,
    shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', // Use proper shell per platform
    env: { ...process.env }, // Explicitly inherit full environment
    windowsHide: true, // Hide window on Windows
  });
  return (stdout as string).trim();
}

interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

// Check Node.js version
async function checkNodeVersion(): Promise<HealthCheck> {
  const requiredMajor = 20;
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);

  if (major >= requiredMajor) {
    return { name: 'Node.js Version', status: 'pass', message: `${version} (>= ${requiredMajor} required)` };
  } else if (major >= 18) {
    return { name: 'Node.js Version', status: 'warn', message: `${version} (>= ${requiredMajor} recommended)`, fix: 'nvm install 20 && nvm use 20' };
  } else {
    return { name: 'Node.js Version', status: 'fail', message: `${version} (>= ${requiredMajor} required)`, fix: 'nvm install 20 && nvm use 20' };
  }
}

// Check npm version (async with proper env inheritance)
async function checkNpmVersion(): Promise<HealthCheck> {
  try {
    const version = await runCommand('npm --version');
    const major = parseInt(version.split('.')[0], 10);
    if (major >= 9) {
      return { name: 'npm Version', status: 'pass', message: `v${version}` };
    } else {
      return { name: 'npm Version', status: 'warn', message: `v${version} (>= 9 recommended)`, fix: 'npm install -g npm@latest' };
    }
  } catch {
    return { name: 'npm Version', status: 'fail', message: 'npm not found', fix: 'Install Node.js from https://nodejs.org' };
  }
}

// Check config file
async function checkConfigFile(): Promise<HealthCheck> {
  // JSON configs (parse-validated). The first three are LEGACY shapes from
  // pre-v3 init flows; v3 init writes only `.claude-flow/config.yaml`.
  const jsonPaths = [
    '.claude-flow/config.json',
    'claude-flow.config.json',
    '.claude-flow.json'
  ];
  // YAML configs (existence-checked only — no heavy yaml parser dependency).
  const yamlPaths = [
    '.claude-flow/config.yaml',
    '.claude-flow/config.yml',
    'claude-flow.config.yaml'
  ];

  // #1798 — collect ALL configs that exist instead of returning at the first
  // hit. The previous early-return masked silent collisions: if both a v2
  // JSON and a v3 YAML existed, doctor reported only the JSON while the
  // daemon was actually reading from the YAML. Surfacing both lets the user
  // see and resolve the disagreement.
  const foundJson: string[] = [];
  const invalidJson: string[] = [];
  for (const configPath of jsonPaths) {
    if (!existsSync(configPath)) continue;
    try {
      JSON.parse(readFileSync(configPath, 'utf8'));
      foundJson.push(configPath);
    } catch {
      invalidJson.push(configPath);
    }
  }
  const foundYaml = yamlPaths.filter(p => existsSync(p));

  // Hard failures first: malformed JSON wins.
  if (invalidJson.length > 0) {
    return { name: 'Config File', status: 'fail', message: `Invalid JSON: ${invalidJson.join(', ')}`, fix: 'Fix JSON syntax in config file' };
  }

  // #1798 — collision: legacy JSON + new YAML both present. Subsystems can
  // disagree on which to read; surface this as a warn with the recommended
  // resolution (keep the YAML, archive the JSON).
  if (foundJson.length > 0 && foundYaml.length > 0) {
    return {
      name: 'Config File',
      status: 'warn',
      message: `Config collision: legacy ${foundJson.join(', ')} + ${foundYaml.join(', ')} — subsystems may disagree silently`,
      fix: `Archive the legacy JSON (mv ${foundJson[0]} ${foundJson[0]}.bak) and keep ${foundYaml[0]} as the canonical config`,
    };
  }

  if (foundYaml.length > 0) {
    return { name: 'Config File', status: 'pass', message: `Found: ${foundYaml[0]}` };
  }
  if (foundJson.length > 0) {
    return { name: 'Config File', status: 'pass', message: `Found: ${foundJson[0]}` };
  }

  return { name: 'Config File', status: 'warn', message: 'No config file (using defaults)', fix: 'claude-flow config init' };
}

// Check daemon status
/**
 * #2448 / #2677 — Detect runaway `npx @claude-flow/cli@latest` commands
 * left over in `.claude/settings.json` from pre-#2337 installs.
 *
 * These fire on every Claude Code event (statusLine refires every few hundred
 * ms, hooks fire per tool-use), each spawning a cold Node process + npm
 * registry round-trip. On the reporter's 48 GB macOS box this produced
 * load average 49, jetsam, and a kernel watchdog panic two minutes after
 * boot. Severity is CRITICAL when present; users who installed before #2337
 * and never re-ran `ruflo init` still have it.
 *
 * Detection only — does not modify settings. Fix path is `ruflo init` (the
 * executor's migration logic, also patched in #2448, will now regenerate
 * the broken commands).
 */
async function checkStaleSettingsNpx(): Promise<HealthCheck> {
  // Same regex pattern the executor migration uses — kept in sync. Flag-list
  // repetition bounded at 10 (CodeQL js/redos — unbounded `*` here is
  // exponential-backtracking-prone on a crafted settings.json).
  // Every subcommand incurs the same cold npm process/registry cost. The
  // previous `hooks` literal missed `memory`, `daemon`, `swarm`, etc.
  const BROKEN_RE = /npx\s+(?:--?\S+\s+){0,10}@?claude-flow\/cli@latest\s+\S+/;

  // Look in both project-local and home-dir settings.
  const candidates = [
    join(process.cwd(), '.claude', 'settings.json'),
    join(process.env.HOME ?? '', '.claude', 'settings.json'),
  ].filter((p, i, a) => p && a.indexOf(p) === i);

  const offenders: Array<{ path: string; where: string }> = [];
  for (const settingsPath of candidates) {
    if (!existsSync(settingsPath)) continue;
    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      continue; // checkConfigFile reports JSON errors separately
    }

    // statusLine.command
    const sl = settings.statusLine as { command?: string } | undefined;
    if (sl?.command && BROKEN_RE.test(sl.command)) {
      offenders.push({ path: settingsPath, where: 'statusLine' });
    }

    // hooks.<event>[].hooks[].command
    const hooks = settings.hooks as Record<string, Array<{ hooks?: Array<{ command?: string }> }>> | undefined;
    if (hooks) {
      for (const [eventName, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups)) continue;
        for (const group of groups) {
          if (!Array.isArray(group.hooks)) continue;
          for (const h of group.hooks) {
            if (typeof h?.command === 'string' && BROKEN_RE.test(h.command)) {
              offenders.push({ path: settingsPath, where: `hooks.${eventName}` });
            }
          }
        }
      }
    }
  }

  if (offenders.length === 0) {
    return { name: 'Stale npx@latest in settings (#2448)', status: 'pass', message: 'no runaway commands detected' };
  }

  // Group by file for readable output
  const byFile = offenders.reduce((acc, o) => {
    (acc[o.path] ??= []).push(o.where);
    return acc;
  }, {} as Record<string, string[]>);
  const summary = Object.entries(byFile)
    .map(([p, wheres]) => `${p} [${[...new Set(wheres)].join(', ')}]`)
    .join('; ');

  return {
    name: 'Stale npx@latest in settings (#2448)',
    status: 'fail',
    message: `CRITICAL — runaway \`npx @claude-flow/cli@latest\` commands detected: ${summary}`,
    fix: 'Re-run `npx ruflo init` to migrate (the v3.13.3+ init migrator regenerates these to local-helper form). On macOS this prevents the process-storm / kernel-panic class reported in #2448.',
  };
}

async function checkDaemonStatus(): Promise<HealthCheck> {
  try {
    const pidFile = '.claude-flow/daemon.pid';
    if (existsSync(pidFile)) {
      const pid = readFileSync(pidFile, 'utf8').trim();
      try {
        process.kill(parseInt(pid, 10), 0); // Check if process exists
        return { name: 'Daemon Status', status: 'pass', message: `Running (PID: ${pid})` };
      } catch {
        return { name: 'Daemon Status', status: 'warn', message: 'Stale PID file', fix: 'rm .claude-flow/daemon.pid && claude-flow daemon start' };
      }
    }
    return { name: 'Daemon Status', status: 'warn', message: 'Not running', fix: 'claude-flow daemon start' };
  } catch {
    return { name: 'Daemon Status', status: 'warn', message: 'Unable to check', fix: 'claude-flow daemon status' };
  }
}

// Check memory database
//
// #2737: renamed the reported row from "Memory Database" to "Memory Database
// Presence" — this check is existsSync()+statSync() ONLY, it never opens the
// file or queries it, so it PASSES for any file that exists and can be
// stat'd, corrupt or not. It was the ONLY memory probe in the default
// `allChecks` run (the real integrity checks were --component memory only),
// so a corrupt .swarm/memory.db could sail through a bare `doctor` run as
// "healthy". The name change makes the check's actual scope honest; the
// behavior below is unchanged. See checkMemoryStructuralIntegrity below for
// the new default-run check that actually opens the file.
async function checkMemoryDatabase(): Promise<HealthCheck> {
  // Authoritative path comes from `getMemoryRoot()` (honors
  // `CLAUDE_FLOW_MEMORY_PATH`, claude-flow.config.json's `memory.persistPath`,
  // then defaults to `.swarm/`). #1946: the previous hard-coded list missed
  // `data/memory/memory.db` (a common config) and ignored the env var
  // entirely, so doctor reported "Not initialized" on perfectly-init'd DBs.
  // Try the configured path first, then fall back to the historic candidates.
  const candidates: string[] = [];
  try {
    const { getMemoryRoot } = await import('../memory/memory-initializer.js');
    candidates.push(join(getMemoryRoot(), 'memory.db'));
  } catch {
    /* memory-initializer not available — fall through to legacy candidates */
  }
  candidates.push(
    '.swarm/memory.db',
    '.claude-flow/memory.db',
    'data/memory/memory.db', // matches `CLAUDE_FLOW_MEMORY_PATH=data/memory`
    'data/memory.db',
  );

  for (const dbPath of candidates) {
    if (existsSync(dbPath)) {
      try {
        const stats = statSync(dbPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        return { name: 'Memory Database Presence', status: 'pass', message: `${dbPath} (${sizeMB} MB) — existence/size only, not a health check (see Memory Structural Integrity)` };
      } catch {
        return { name: 'Memory Database Presence', status: 'warn', message: `${dbPath} (unable to stat)` };
      }
    }
  }

  return { name: 'Memory Database Presence', status: 'warn', message: 'Not initialized', fix: 'claude-flow memory configure --backend hybrid' };
}

// ═══════════════════════════════════════════════════════════════════════════
// #2677 — memory doctor: functional checks (stuinfla)
//
// The existing `checkMemoryDatabase` above asserts existence + statability
// only, so it CANNOT distinguish a healthy DB from a 99.97%-empty or
// SQLite-malformed one. Stuinfla reported both cases live (81-store fleet).
// The checks below layer functional assertions on top, ordered so
// the earliest chain-break is always the first red the user sees:
//   1. Integrity          — can sql.js open it AND does PRAGMA integrity_check pass?
//   2. Content            — do most memory_entries rows carry non-empty content?
//   3. Embedding coverage — do most rows have a vector? (unembedded rows are
//                           both unrecallable AND undistillable per ADR-174)
//   6. Reflexion coverage — can episodes participate in retrieveRelevant's
//                           required episode_embeddings INNER JOIN?
//      Feedback critiques — do execution-tier episodes carry a real lesson?
// Ordering matters: content ratio is meaningless on a DB that can't open;
// embedding coverage is meaningless on rows with no content. First red wins.
//
// Recall probe (stuinfla check 4) still requires an isolated write+search+
// delete round trip through the CLI's own memory pipeline. It remains separate
// because doctor otherwise stays read-only.
//
// Design rules (also from stuinfla's report):
//   - "A check that cannot fail protects nothing" — every check has a
//     demonstrable red state.
//   - "UNKNOWN is never PASS" — if the check can't RUN, report warn/fail,
//     never a reassuring pass. Encrypted-DB case gets warn with the caveat
//     spelled out; corruption gets fail.
//   - "Print the measurement, not a checkmark" — messages include the
//     ratios so operators see the shape of the problem.

/** Resolve the same DB path checkMemoryDatabase above uses. Returns null
 * if no candidate exists (in which case none of these checks should
 * fire — checkMemoryDatabase will already have surfaced the missing DB). */
async function resolveMemoryDbPath(): Promise<string | null> {
  const candidates: string[] = [];
  try {
    const { getMemoryRoot } = await import('../memory/memory-initializer.js');
    candidates.push(join(getMemoryRoot(), 'memory.db'));
  } catch { /* fall through to legacy candidates */ }
  candidates.push('.swarm/memory.db', '.claude-flow/memory.db', 'data/memory/memory.db', 'data/memory.db');
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

/** Open a sql.js Database over an on-disk file, returning null when the
 * file can't be opened as a SQLite database (encrypted / corrupted / not
 * a database). Callers decide whether that's warn or fail. */
async function tryOpenSqlJs(dbPath: string): Promise<any | null> {
  try {
    const initSqlJs: any = (await import('sql.js')).default ?? (await import('sql.js'));
    const SQL = await (typeof initSqlJs === 'function' ? initSqlJs() : initSqlJs.default());
    const { readFileSync } = await import('fs');
    const buf = readFileSync(dbPath);
    return new SQL.Database(new Uint8Array(buf));
  } catch { return null; }
}

// ── #2737 shared helpers: encryption-at-rest carve-out ─────────────────────
//
// "file is not a database" / "malformed" from sql.js or better-sqlite3 is
// EXACTLY the signal a legitimately RFE1-encrypted-at-rest memory.db also
// produces when opened without decrypting (ADR-096). Before either the new
// default-run check or the strengthened checkMemoryIntegrity below concludes
// "malformed = fail", they sniff for the RFE1 magic using the SAME detector
// checkEncryptionAtRest uses (isEncryptedBlob), so the two checks can never
// disagree about what counts as "encrypted".

/** Read just the first `len` bytes of a file without loading the whole file
 * into memory — a multi-GB memory.db shouldn't get fully buffered just to
 * check a 4-byte magic. Returns fewer bytes (or empty) when the file is
 * shorter than `len`; isEncryptedBlob() correctly treats a too-short blob
 * as "not encrypted", so callers don't need to special-case that. */
function readHeaderBytes(path: string, len: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    const bytesRead = readSync(fd, buf, 0, len, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

// RFE1 wire format is magic(4) + iv(12) + ciphertext(N) + tag(16); the
// shortest possible blob is 32 bytes. 64 gives headroom without importing
// vault.ts's private MIN_BLOB_LEN constant.
const ENCRYPTION_SNIFF_LEN = 64;

/** True iff `dbPath` is a legitimately RFE1-encrypted-at-rest file. A read
 * failure (permissions, races) is treated as "not encrypted" — callers
 * still hit their own open/query error handling right after, so nothing
 * gets silently swallowed. */
function isMemoryDbEncryptedAtRest(dbPath: string): boolean {
  try {
    return isEncryptedBlob(readHeaderBytes(dbPath, ENCRYPTION_SNIFF_LEN));
  } catch {
    return false;
  }
}

/**
 * Distinguish an unavailable native addon from a database that the native
 * driver opened and found malformed. Importing better-sqlite3 can succeed even
 * when its postinstall script was skipped: the JavaScript wrapper loads, then
 * the first Database construction throws because better_sqlite3.node is absent
 * or incompatible with the active Node ABI.
 */
function isNativeSqliteBindingUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return [
    /Could not locate the bindings file/i,
    /better_sqlite3\.node/i,
    /NODE_MODULE_VERSION/i,
    /compiled against a different Node\.js version/i,
    /ERR_DLOPEN_FAILED/i,
    /invalid ELF header/i,
    /wrong ELF class/i,
    /not a valid Win32 application/i,
    /Module did not self-register/i,
    /no suitable image found/i,
  ].some((pattern) => pattern.test(message));
}

function nativeBindingUnavailableCheck(name: string, dbPath: string, error: unknown, suffix: string): HealthCheck {
  const details = error instanceof Error ? error.message : String(error);
  const summary = details.split(/\r?\n/, 1)[0].replace(/\s+Tried:\s*$/i, '');
  return {
    name,
    status: 'warn',
    message: `${dbPath} — better-sqlite3 package found, but its native binding is unavailable: ${summary} ${suffix}`,
    fix: 'reinstall with npm install scripts enabled or run `npm rebuild better-sqlite3`; then rerun this check',
  };
}

// #2737 part 1 — bare `doctor` (no --component flag) never actually opened
// memory.db: checkMemoryDatabase above is existsSync()+statSync() only, so
// it PASSES on any file that exists and can be stat'd, corrupt or not, and
// it was the ONLY memory probe `allChecks` ran. The real integrity checks
// (checkMemoryIntegrity/Content/EmbeddingCoverage below) were, and remain,
// --component memory only.
//
// This is a NEW, cheaper, native check added to the default `allChecks` run
// (not a replacement for the deep trio):
//   - better-sqlite3 (native) instead of sql.js: it's WAL-aware because
//     SQLite itself resolves any sibling -wal file next to the main image;
//     sql.js is WAL-blind — tryOpenSqlJs() above only readFileSync()s the
//     main file and hands the raw bytes to the WASM build, so any
//     committed-but-not-checkpointed rows sitting in a -wal file are
//     invisible to it.
//   - PRAGMA quick_check, not integrity_check: per sqlite.org, quick_check
//     "is like integrity_check except that it does not verify UNIQUE
//     constraints and does not verify that index content matches table
//     content" — bounded enough to run unconditionally on every bare
//     `doctor` call. The full integrity_check (with those extra
//     cross-checks) is what the strengthened checkMemoryIntegrity below
//     runs when better-sqlite3 is available.
// Explicitly labeled "structural-only" in both the row name and every
// message so nobody mistakes this cheap default-run probe for the deeper
// --component memory one.
async function checkMemoryStructuralIntegrity(): Promise<HealthCheck> {
  const NAME = 'Memory Structural Integrity (quick_check)';
  const dbPath = await resolveMemoryDbPath();
  if (!dbPath) {
    // Not-yet-initialized project — Memory Database Presence above already
    // surfaces this; "UNKNOWN is never PASS" still applies, so this stays a
    // warn rather than a silent skip, but doesn't pile on a second red for
    // the same root cause.
    return {
      name: NAME,
      status: 'warn',
      message: 'no memory.db found (see Memory Database Presence above) — structural-only check skipped',
    };
  }

  // Encryption-at-rest carve-out (#2737 part 3) — see helpers above.
  if (isMemoryDbEncryptedAtRest(dbPath)) {
    return {
      name: NAME,
      status: 'warn',
      message: `${dbPath} — RFE1-encrypted at rest; structural-only check can't run without decrypting (expected, not corruption — see Encryption at Rest)`,
    };
  }

  let Database: any;
  try {
    Database = ((await import('better-sqlite3')) as any).default;
  } catch {
    return {
      name: NAME,
      status: 'warn',
      message: `${dbPath} — better-sqlite3 not installed; native WAL-backed persistence and the structural-only check are unavailable`,
      fix: 'install better-sqlite3 with npm install scripts enabled, then rerun this check',
    };
  }

  let db: any;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    if (isNativeSqliteBindingUnavailable(e)) {
      return nativeBindingUnavailableCheck(
        NAME,
        dbPath,
        e,
        '[structural-only; durable WAL-backed persistence unavailable]',
      );
    }
    const msg = (e as Error).message || String(e);
    // Encryption already ruled out above — an unencrypted file
    // better-sqlite3 can't even open is definitive corruption.
    // #2737 part 3: fail, not warn.
    return {
      name: NAME,
      status: 'fail',
      message: `${dbPath} — better-sqlite3 failed to open: ${msg} (unencrypted; definitively malformed) [structural-only]`,
      fix: 'back up .swarm/memory.db then `claude-flow memory init --force`',
    };
  }

  try {
    const rows = db.pragma('quick_check') as Array<Record<string, unknown>>;
    const values = rows.map((r) => String(Object.values(r)[0]));
    if (values.length === 1 && values[0] === 'ok') {
      return {
        name: NAME,
        status: 'pass',
        message: `${dbPath} — PRAGMA quick_check: ok [structural-only, native + WAL-aware]`,
      };
    }
    return {
      name: NAME,
      status: 'fail',
      message: `${dbPath} — PRAGMA quick_check: ${values.slice(0, 3).join('; ')}${values.length > 3 ? ` (+${values.length - 3} more)` : ''} [structural-only]`,
      fix: 'back up .swarm/memory.db then `claude-flow memory init --force`',
    };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    // Encryption ruled out above; DB opened but the pragma itself threw —
    // still definitive, unencrypted breakage. Fail, not warn.
    return {
      name: NAME,
      status: 'fail',
      message: `${dbPath} — quick_check probe threw: ${msg} (unencrypted) [structural-only]`,
      fix: 'back up .swarm/memory.db then `claude-flow memory init --force`',
    };
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}

// #2968 option 1 — read-only doctor check for the active SQLite driver.
//
// Native better-sqlite3 (durable, WAL-capable) can silently degrade to the
// sql.js WASM fallback (non-durable — `wal_checkpoint` calls are rejected
// and the write is lost) when a postinstall script is skipped. `memory
// store` still printed "Data stored successfully" before the persistWarning
// fix in #2983/3.38.1 (see memory-store-persist-warning-2968.test.ts); this
// check gives a standing, read-only signal so the driver split is visible
// any time doctor runs, independent of any single store call.
//
// Table count in the on-disk memory.db is the cheap, reliable signal from
// the issue report: the native driver's schema produces 47 tables, the
// sql.js fallback's produces only 10. Deliberately does NOT change install
// behavior (that's option 2 from #2968, explicitly out of scope here) —
// this only reports, it never repairs.
const MEMORY_DRIVER_NATIVE_TABLE_FLOOR = 20; // roughly midpoint of sql.js's ~10 and native's ~47

async function checkMemoryPersistenceDriver(): Promise<HealthCheck> {
  const NAME = 'Memory Persistence Driver';
  const dbPath = await resolveMemoryDbPath();
  if (!dbPath) {
    return {
      name: NAME,
      status: 'warn',
      message: 'no memory.db found (see Memory Database Presence above) — driver check skipped',
    };
  }

  if (isMemoryDbEncryptedAtRest(dbPath)) {
    return {
      name: NAME,
      status: 'warn',
      message: `${dbPath} — RFE1-encrypted at rest; driver check can't run without decrypting (expected, not corruption)`,
    };
  }

  let Database: any;
  try {
    Database = ((await import('better-sqlite3')) as any).default;
  } catch {
    Database = null;
  }

  let tableCount: number | null = null;
  let nativeUnavailableReason: string | null = null;
  let nativeOpenOtherError: string | null = null;

  if (Database) {
    let db: any;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (e) {
      if (isNativeSqliteBindingUnavailable(e)) {
        nativeUnavailableReason = ((e as Error).message || String(e)).split(/\r?\n/, 1)[0];
      } else {
        nativeOpenOtherError = (e as Error).message || String(e);
      }
      db = null;
    }
    if (db) {
      try {
        const row = db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get() as { c: number };
        tableCount = Number(row?.c ?? 0);
      } catch {
        // leave null — Memory Integrity above already reports open/query failures
      } finally {
        try { db.close(); } catch { /* best-effort */ }
      }
    }
  } else {
    nativeUnavailableReason = 'better-sqlite3 not installed';
  }

  // Fall back to sql.js purely to report table count when the native path
  // couldn't — informational only, never used to claim durability.
  if (tableCount === null && (nativeUnavailableReason || nativeOpenOtherError)) {
    const sdb = await tryOpenSqlJs(dbPath);
    if (sdb) {
      try {
        const res = sdb.exec("SELECT count(*) FROM sqlite_master WHERE type='table'");
        tableCount = Number(res[0]?.values?.[0]?.[0] ?? 0);
      } catch {
        // leave null
      } finally {
        try { sdb.close(); } catch { /* best-effort */ }
      }
    }
  }

  const tableSummary = tableCount === null
    ? 'table count unavailable'
    : `${tableCount} tables (native schema ~47, sql.js-fallback schema ~10 — #2968)`;

  if (nativeUnavailableReason) {
    return {
      name: NAME,
      status: 'warn',
      message: `${dbPath} — active driver: sql.js (WASM fallback, non-durable) — native better-sqlite3 binding unavailable: ${nativeUnavailableReason} — wal_checkpoint calls silently no-op, writes may not persist across processes (#2968/#2867/#2219) [${tableSummary}]`,
      fix: 'reinstall with npm install scripts enabled, or run `npm rebuild better-sqlite3`; then rerun this check',
    };
  }

  if (nativeOpenOtherError) {
    return {
      name: NAME,
      status: 'warn',
      message: `${dbPath} — native better-sqlite3 module loadable, but could not open this database (${nativeOpenOtherError}) — see Memory Integrity above for the corruption/encryption diagnosis [${tableSummary}]`,
    };
  }

  if (tableCount !== null && tableCount < MEMORY_DRIVER_NATIVE_TABLE_FLOOR) {
    return {
      name: NAME,
      status: 'warn',
      message: `${dbPath} — active driver: native better-sqlite3, but this database has only ${tableCount} tables — that matches the sql.js-fallback schema shape (~10), not the native schema (~47); it was likely created before the native binding became available, and durable writes made before then may be missing`,
      fix: 'back up .swarm/memory.db then `claude-flow memory init --force` to rebuild under the native driver',
    };
  }

  return {
    name: NAME,
    status: 'pass',
    message: `${dbPath} — active driver: native better-sqlite3 (durable, WAL-capable) [${tableSummary}]`,
  };
}

// Check 1 (--component memory, deep path) — #2737 part 2 strengthens this:
// prefer native better-sqlite3 PRAGMA integrity_check (adds index↔table
// cross-checking + UNIQUE verification that quick_check above deliberately
// skips, and is WAL-aware — see checkMemoryStructuralIntegrity's comment)
// when better-sqlite3 is available, falling back to the original sql.js
// probe when it's not. The sql.js fallback is main-image-only (WAL-blind);
// its message says so explicitly so operators know its limits.
//
// #2737 part 3: with the encryption carve-out applied up front on BOTH
// paths, a "file is not a database" / "malformed" result is now definitive,
// unencrypted corruption in every branch below — fail, not warn (the
// previous version treated this as an ambiguous warn because it couldn't
// tell corruption from encryption; that ambiguity is what the carve-out
// resolves).
async function checkMemoryIntegrity(): Promise<HealthCheck> {
  const dbPath = await resolveMemoryDbPath();
  if (!dbPath) return { name: 'Memory Integrity', status: 'warn', message: 'no memory.db found (see Memory Database Presence check above)' };

  if (isMemoryDbEncryptedAtRest(dbPath)) {
    return {
      name: 'Memory Integrity',
      status: 'warn',
      message: `${dbPath} — RFE1-encrypted at rest; integrity check can't run without decrypting (expected, not corruption — see Encryption at Rest)`,
    };
  }

  // Prefer native better-sqlite3 (WAL-aware, full integrity_check). Module
  // load is isolated in its own try/catch so ONLY "not installed" falls
  // through to the sql.js fallback below. A loaded JavaScript wrapper can
  // still lack its native binding (#2968); that capability failure is a warn,
  // while genuine open/query failures remain authoritative failures here.
  let Database: any;
  try {
    Database = ((await import('better-sqlite3')) as any).default;
  } catch {
    Database = null; // not installed — fall through to the sql.js fallback below.
  }

  if (Database) {
    let db: any;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (e) {
      if (isNativeSqliteBindingUnavailable(e)) {
        return nativeBindingUnavailableCheck(
          'Memory Integrity',
          dbPath,
          e,
          '[native WAL-backed persistence unavailable]',
        );
      }
      const msg = (e as Error).message || String(e);
      return {
        name: 'Memory Integrity',
        status: 'fail',
        message: `${dbPath} — better-sqlite3 failed to open: ${msg} (unencrypted; definitively malformed) [native, WAL-aware]`,
        fix: 'back up .swarm/memory.db then `claude-flow memory init --force`',
      };
    }
    try {
      const rows = db.pragma('integrity_check') as Array<Record<string, unknown>>;
      const values = rows.map((r) => String(Object.values(r)[0]));
      if (values.length === 1 && values[0] === 'ok') {
        return { name: 'Memory Integrity', status: 'pass', message: `${dbPath} — PRAGMA integrity_check: ok [native, WAL-aware]` };
      }
      return {
        name: 'Memory Integrity',
        status: 'fail',
        message: `${dbPath} — PRAGMA integrity_check: ${values.slice(0, 3).join('; ')}${values.length > 3 ? ` (+${values.length - 3} more)` : ''} [native, WAL-aware]`,
        fix: 'back up .swarm/memory.db then `claude-flow memory init --force`',
      };
    } catch (e) {
      // DB opened but the pragma itself threw — still definitive,
      // unencrypted breakage (encryption ruled out above). Fail, not warn,
      // and NOT a fall-through to the sql.js fallback: better-sqlite3 IS
      // installed and just gave us the answer.
      const msg = (e as Error).message || String(e);
      return {
        name: 'Memory Integrity',
        status: 'fail',
        message: `${dbPath} — integrity_check probe threw: ${msg} (unencrypted; definitively malformed) [native, WAL-aware]`,
        fix: 'back up .swarm/memory.db then `claude-flow memory init --force`',
      };
    } finally {
      try { db.close(); } catch { /* best-effort */ }
    }
  }

  // Fallback: sql.js — main-image-only (WAL-blind). tryOpenSqlJs()
  // readFileSync()s the base file directly, so any committed-but-not-
  // checkpointed rows sitting in a sibling -wal file are invisible here.
  // Install better-sqlite3 for the WAL-aware path above.
  const db = await tryOpenSqlJs(dbPath);
  if (!db) {
    // Encryption already ruled out above — an unencrypted file sql.js can't
    // even open is definitive corruption too.
    return {
      name: 'Memory Integrity',
      status: 'fail',
      message: `${dbPath} — sql.js can't open (unencrypted; definitively malformed) [main-image-only fallback — install better-sqlite3 for WAL-aware checking]`,
      fix: 'back up .swarm/memory.db then `claude-flow memory init --force`',
    };
  }
  try {
    const res = db.exec('PRAGMA integrity_check');
    const rows: string[] = res[0]?.values?.map((v: any[]) => String(v[0])) ?? [];
    if (rows.length === 1 && rows[0] === 'ok') {
      return {
        name: 'Memory Integrity',
        status: 'warn',
        message: `${dbPath} — PRAGMA integrity_check: ok, but only for the main image [sql.js fallback; native WAL-backed persistence unavailable]`,
        fix: 'install better-sqlite3 with npm install scripts enabled, then rerun this check',
      };
    }
    return {
      name: 'Memory Integrity',
      status: 'fail',
      message: `${dbPath} — PRAGMA integrity_check: ${rows.slice(0, 3).join('; ')}${rows.length > 3 ? ` (+${rows.length - 3} more)` : ''} [main-image-only fallback]`,
      fix: 'back up .swarm/memory.db then `claude-flow memory init --force`',
    };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const definitivelyMalformed = msg.includes('file is not a database') || msg.includes('malformed');
    // Encryption already ruled out above, so — matched pattern or not —
    // this is a query refusal on a file we KNOW isn't RFE1-encrypted.
    // #2737 part 3: fail, not warn.
    return {
      name: 'Memory Integrity',
      status: 'fail',
      message: definitivelyMalformed
        ? `${dbPath} — DB refused query: ${msg} (unencrypted; definitively malformed) [main-image-only fallback]`
        : `${dbPath} — probe threw: ${msg} (unencrypted — encryption ruled out above) [main-image-only fallback]`,
      fix: 'back up .swarm/memory.db then `claude-flow memory init --force`',
    };
  } finally { try { db.close(); } catch { /* best-effort */ } }
}

// Check 2 — memory_entries rows should mostly carry non-empty content.
// Stuinfla's live case: 11,133 rows, 3 with content (0.03%). Threshold 95%
// is the number he proposed. Values below → fail with the exact ratio in
// the message ("Print the measurement, not a checkmark").
async function checkMemoryContent(): Promise<HealthCheck> {
  const dbPath = await resolveMemoryDbPath();
  if (!dbPath) return { name: 'Memory Content', status: 'warn', message: 'no memory.db found' };
  const db = await tryOpenSqlJs(dbPath);
  if (!db) return { name: 'Memory Content', status: 'warn', message: 'DB unreadable (see Memory Integrity)' };
  try {
    const tables: string[] = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries'")[0]?.values?.map((v: any[]) => String(v[0])) ?? [];
    if (tables.length === 0) return { name: 'Memory Content', status: 'warn', message: 'no memory_entries table in DB — schema mismatch or empty init' };
    const r = db.exec("SELECT count(*), sum(CASE WHEN length(trim(coalesce(content,'')))>0 THEN 1 ELSE 0 END) FROM memory_entries");
    const total = Number(r[0]?.values?.[0]?.[0] ?? 0);
    const populated = Number(r[0]?.values?.[0]?.[1] ?? 0);
    if (total === 0) return { name: 'Memory Content', status: 'pass', message: `${dbPath} — 0 rows (fresh DB, expected)` };
    const ratio = populated / total;
    const pct = (ratio * 100).toFixed(2);
    const detail = `content ${populated}/${total} (${pct}%)`;
    if (ratio < 0.95) {
      return {
        name: 'Memory Content',
        status: 'fail',
        message: `${dbPath} — ${detail} below 95% floor`,
        fix: 'schema drift likely (rename of value→content or similar). check migration state via `claude-flow migrate status`',
      };
    }
    return { name: 'Memory Content', status: 'pass', message: `${dbPath} — ${detail}` };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const encryptedOrCorrupt = msg.includes('file is not a database') || msg.includes('malformed');
    return {
      name: 'Memory Content',
      status: 'warn',
      message: encryptedOrCorrupt
        ? `${dbPath} — DB refused query: ${msg} (encrypted DB or corruption; see Memory Integrity above)`
        : `${dbPath} — probe threw: ${msg}`,
    };
  } finally { try { db.close(); } catch { /* best-effort */ } }
}

// Check 3 — most memory_entries with content should also carry an embedding
// vector. Rows without a vector are BOTH unrecallable (no similarity search
// can find them) AND undistillable (ADR-174's distill skips rows with no
// parseable vector). Same 95% threshold + fail-with-ratio pattern as check 2.
//
// Embedding storage varies across ruflo installs (agentdb migrations, HNSW
// index vs inline vector column). Discovers the shape via schema probes,
// falls back to warn if the schema is unrecognized (better than a false
// pass, per "UNKNOWN is never PASS").
async function checkMemoryEmbeddingCoverage(): Promise<HealthCheck> {
  const dbPath = await resolveMemoryDbPath();
  if (!dbPath) return { name: 'Memory Embedding Coverage', status: 'warn', message: 'no memory.db found' };
  const db = await tryOpenSqlJs(dbPath);
  if (!db) return { name: 'Memory Embedding Coverage', status: 'warn', message: 'DB unreadable (see Memory Integrity)' };
  try {
    // Schema-shape discovery. Three candidate columns / tables we've seen
    // across the agentdb / ruvector history — first match wins.
    const cols = db.exec("PRAGMA table_info(memory_entries)");
    const colNames = new Set<string>((cols[0]?.values ?? []).map((v: any[]) => String(v[1])));
    let vectorPredicate: string | null = null;
    if (colNames.has('embedding')) vectorPredicate = "embedding IS NOT NULL AND length(embedding) > 0";
    else if (colNames.has('vector')) vectorPredicate = "vector IS NOT NULL AND length(vector) > 0";
    if (!vectorPredicate) {
      const otherTables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('vector_indexes','embeddings','memory_embeddings')")[0]?.values?.map((v: any[]) => String(v[0])) ?? [];
      if (otherTables.length === 0) {
        return {
          name: 'Memory Embedding Coverage',
          status: 'warn',
          message: 'no embedding column/table recognized (agentdb schema mismatch or older format) — doctor cannot measure',
        };
      }
      const tbl = otherTables[0];
      const r = db.exec(`SELECT count(*) FROM memory_entries m WHERE EXISTS (SELECT 1 FROM ${tbl} e WHERE e.memory_id = m.id OR e.entry_id = m.id OR e.id = m.id)`);
      const withEmbedding = Number(r[0]?.values?.[0]?.[0] ?? 0);
      const total = Number(db.exec("SELECT count(*) FROM memory_entries WHERE length(trim(coalesce(content,'')))>0")[0]?.values?.[0]?.[0] ?? 0);
      if (total === 0) return { name: 'Memory Embedding Coverage', status: 'pass', message: `${dbPath} — 0 content rows (nothing to embed)` };
      const ratio = withEmbedding / total;
      const pct = (ratio * 100).toFixed(2);
      const detail = `embedded ${withEmbedding}/${total} (${pct}%) via ${tbl}`;
      if (ratio < 0.95) return { name: 'Memory Embedding Coverage', status: 'fail', message: `${dbPath} — ${detail} below 95% floor`, fix: 'unembedded rows are unrecallable + undistillable — re-run `claude-flow memory embed --namespace <name>` for populated namespaces' };
      return { name: 'Memory Embedding Coverage', status: 'pass', message: `${dbPath} — ${detail}` };
    }
    // Inline embedding column
    const r = db.exec(`SELECT count(*), sum(CASE WHEN ${vectorPredicate} THEN 1 ELSE 0 END) FROM memory_entries WHERE length(trim(coalesce(content,'')))>0`);
    const total = Number(r[0]?.values?.[0]?.[0] ?? 0);
    const withEmb = Number(r[0]?.values?.[0]?.[1] ?? 0);
    if (total === 0) return { name: 'Memory Embedding Coverage', status: 'pass', message: `${dbPath} — 0 content rows (nothing to embed)` };
    const ratio = withEmb / total;
    const pct = (ratio * 100).toFixed(2);
    const detail = `embedded ${withEmb}/${total} (${pct}%)`;
    if (ratio < 0.95) {
      return { name: 'Memory Embedding Coverage', status: 'fail', message: `${dbPath} — ${detail} below 95% floor`, fix: 'unembedded rows are unrecallable + undistillable — re-run `claude-flow memory embed --namespace <name>` for populated namespaces' };
    }
    return { name: 'Memory Embedding Coverage', status: 'pass', message: `${dbPath} — ${detail}` };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const encryptedOrCorrupt = msg.includes('file is not a database') || msg.includes('malformed');
    return {
      name: 'Memory Embedding Coverage',
      status: 'warn',
      message: encryptedOrCorrupt
        ? `${dbPath} — DB refused query: ${msg} (encrypted DB or corruption; see Memory Integrity above)`
        : `${dbPath} — probe threw: ${msg}`,
    };
  } finally { try { db.close(); } catch { /* best-effort */ } }
}

// #2677 check 6 — ReflexionMemory.retrieveRelevant() INNER JOINs episodes to
// episode_embeddings. A populated episodes table with an empty/missing partner
// table is therefore not degraded recall; it is structurally zero recall.
async function checkMemoryReflexionCoverage(): Promise<HealthCheck> {
  const dbPath = await resolveMemoryDbPath();
  if (!dbPath) return { name: 'Memory Reflexion Coverage', status: 'warn', message: 'no memory.db found' };
  const db = await tryOpenSqlJs(dbPath);
  if (!db) return { name: 'Memory Reflexion Coverage', status: 'warn', message: 'DB unreadable (see Memory Integrity)' };
  try {
    const tables = new Set<string>(
      db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('episodes','episode_embeddings')")
        [0]?.values?.map((v: any[]) => String(v[0])) ?? [],
    );
    if (!tables.has('episodes')) {
      return { name: 'Memory Reflexion Coverage', status: 'warn', message: 'episodes table absent — AgentDB Reflexion schema not initialized' };
    }
    const episodes = Number(db.exec('SELECT count(*) FROM episodes')[0]?.values?.[0]?.[0] ?? 0);
    if (episodes === 0) {
      return { name: 'Memory Reflexion Coverage', status: 'warn', message: `${dbPath} — 0 episodes (Reflexion has not been exercised)` };
    }
    if (!tables.has('episode_embeddings')) {
      return {
        name: 'Memory Reflexion Coverage',
        status: 'fail',
        message: `${dbPath} — episode embeddings 0/${episodes} (0.00%); retrieveRelevant() cannot return rows`,
        fix: 'run `claude-flow memory distill run`; current distillation creates/backfills episode_embeddings',
      };
    }
    const embedded = Number(db.exec(
      'SELECT count(*) FROM episodes e JOIN episode_embeddings ee ON ee.episode_id=e.id',
    )[0]?.values?.[0]?.[0] ?? 0);
    const ratio = embedded / episodes;
    const detail = `episode embeddings ${embedded}/${episodes} (${(ratio * 100).toFixed(2)}%)`;
    if (ratio < 0.95) {
      return {
        name: 'Memory Reflexion Coverage',
        status: 'fail',
        message: `${dbPath} — ${detail} below 95% floor; retrieveRelevant() cannot see uncovered episodes`,
        fix: 'run `claude-flow memory distill run` to populate retrievable episodes',
      };
    }
    return { name: 'Memory Reflexion Coverage', status: 'pass', message: `${dbPath} — ${detail}` };
  } catch (e) {
    return { name: 'Memory Reflexion Coverage', status: 'warn', message: `${dbPath} — probe threw: ${(e as Error).message || String(e)}` };
  } finally { try { db.close(); } catch { /* best-effort */ } }
}

// Execution-tier feedback should carry a lesson, not just reward/success bits.
// Proxy episodes intentionally remain critique-free to avoid laundering a
// structural summary into an observed failure explanation.
async function checkMemoryCritiqueCoverage(): Promise<HealthCheck> {
  const dbPath = await resolveMemoryDbPath();
  if (!dbPath) return { name: 'Memory Feedback Critiques', status: 'warn', message: 'no memory.db found' };
  const db = await tryOpenSqlJs(dbPath);
  if (!db) return { name: 'Memory Feedback Critiques', status: 'warn', message: 'DB unreadable (see Memory Integrity)' };
  try {
    const hasEpisodes = (db.exec(
      "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='episodes'",
    )[0]?.values?.[0]?.[0] ?? 0) > 0;
    if (!hasEpisodes) return { name: 'Memory Feedback Critiques', status: 'warn', message: 'episodes table absent' };
    const row = db.exec(`
      SELECT count(*),
        sum(CASE WHEN length(trim(coalesce(critique,''))) > 0 THEN 1 ELSE 0 END)
      FROM episodes WHERE session_id LIKE 'distill:feedback%'
    `)[0]?.values?.[0] ?? [0, 0];
    const feedback = Number(row[0] ?? 0);
    const withCritique = Number(row[1] ?? 0);
    if (feedback === 0) {
      return { name: 'Memory Feedback Critiques', status: 'warn', message: `${dbPath} — 0 execution-feedback episodes to assess` };
    }
    const ratio = withCritique / feedback;
    const detail = `feedback critiques ${withCritique}/${feedback} (${(ratio * 100).toFixed(2)}%)`;
    if (ratio < 0.95) {
      return {
        name: 'Memory Feedback Critiques',
        status: 'fail',
        message: `${dbPath} — ${detail} below 95% floor`,
        fix: 'run current `claude-flow memory distill run`; execution-tier episodes preserve observed critique/error text',
      };
    }
    return { name: 'Memory Feedback Critiques', status: 'pass', message: `${dbPath} — ${detail}` };
  } catch (e) {
    return { name: 'Memory Feedback Critiques', status: 'warn', message: `${dbPath} — probe threw: ${(e as Error).message || String(e)}` };
  } finally { try { db.close(); } catch { /* best-effort */ } }
}

// #2545: Check that the self-learning bridge can actually load @claude-flow/memory
// the SAME way the SessionStart auto-memory hook does. On the documented `npx ruflo`
// path the package lands in the npx cache — unreachable from the project — so the
// hook silently no-op'd with no signal anywhere. This surfaces it.
async function checkLearningBridge(): Promise<HealthCheck> {
  const cwd = process.cwd();
  const hookPath = join(cwd, '.claude', 'helpers', 'auto-memory-hook.mjs');

  // Only relevant once init has deployed the hook; otherwise stay quiet.
  if (!existsSync(hookPath)) {
    return {
      name: 'Learning Bridge',
      status: 'pass',
      message: 'auto-memory hook not installed (run: npx ruflo@latest init)',
    };
  }

  const distPath = resolveMemoryPackageFromProject(cwd);
  if (distPath) {
    const version = readMemoryPackageVersion(distPath);
    return {
      name: 'Learning Bridge',
      status: 'pass',
      message: `@claude-flow/memory resolvable${version ? ` (v${version})` : ''}`,
    };
  }

  // #2599: Self-heal on plain `doctor` (not just --fix). The project-side resolver
  // fails when the sidecar is stale or missing (e.g. npx cache generation rotated),
  // but the CLI process itself can resolve @claude-flow/memory from its own module
  // context. Write the sidecar automatically instead of hard-failing the check.
  const record = recordMemoryPackagePath(cwd, 'doctor-auto');
  if (record) {
    const version = readMemoryPackageVersion(record.distPath);
    return {
      name: 'Learning Bridge',
      status: 'pass',
      message: `@claude-flow/memory resolvable via auto-recorded sidecar${version ? ` (v${version})` : ''}`,
    };
  }

  return {
    name: 'Learning Bridge',
    status: 'fail',
    message: '@claude-flow/memory NOT resolvable — SessionStart self-learning imports are a silent no-op',
    fix: 'npm i -D @claude-flow/memory   (optional dep appears absent — likely --omit=optional install)',
  };
}

// Check API keys
async function checkApiKeys(): Promise<HealthCheck> {
  const keys = ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'OPENAI_API_KEY'];
  const found: string[] = [];

  for (const key of keys) {
    if (process.env[key]) {
      found.push(key);
    }
  }

  // Detect Claude Code environment — API keys are managed internally.
  // Claude Code sets CLAUDECODE (no underscore); CLAUDE_CODE is kept for
  // compatibility with anything else that might set it.
  const inClaudeCode = !!(process.env.CLAUDECODE || process.env.CLAUDE_CODE || process.env.CLAUDE_PROJECT_DIR || process.env.MCP_SESSION_ID);

  if (found.includes('ANTHROPIC_API_KEY') || found.includes('CLAUDE_API_KEY')) {
    return { name: 'API Keys', status: 'pass', message: `Found: ${found.join(', ')}` };
  } else if (inClaudeCode) {
    return { name: 'API Keys', status: 'pass', message: 'Claude Code (managed internally)' };
  } else if (found.length > 0) {
    return { name: 'API Keys', status: 'warn', message: `Found: ${found.join(', ')} (no Claude key)`, fix: 'export ANTHROPIC_API_KEY=your_key' };
  } else {
    return { name: 'API Keys', status: 'warn', message: 'No API keys found', fix: 'export ANTHROPIC_API_KEY=your_key' };
  }
}

// Check git (async with proper env inheritance)
async function checkGit(): Promise<HealthCheck> {
  try {
    const version = await runCommand('git --version');
    return { name: 'Git', status: 'pass', message: version.replace('git version ', 'v') };
  } catch {
    return { name: 'Git', status: 'warn', message: 'Not installed', fix: 'Install git from https://git-scm.com' };
  }
}

// Check if in git repo (async with proper env inheritance)
//
// #1791.7 — `git rev-parse` was reported as failing on hosts where `.git`
// clearly exists in cwd (linux-arm64 daemon contexts). Treat the git binary
// as authoritative when it succeeds, but fall back to a `.git` walk-up so a
// present repository is recognized even when the git invocation fails for
// environment reasons (PATH, broken global config, EBADCWD, etc.).
async function checkGitRepo(): Promise<HealthCheck> {
  try {
    await runCommand('git rev-parse --is-inside-work-tree');
    return { name: 'Git Repository', status: 'pass', message: 'In a git repository' };
  } catch {
    // Walk parents of cwd for a .git directory before reporting "not a repo"
    let dir = process.cwd();
    while (true) {
      if (existsSync(join(dir, '.git'))) {
        return {
          name: 'Git Repository',
          status: 'warn',
          message: `Repo detected on disk (${join(dir, '.git')}) but \`git rev-parse\` failed — check git installation and PATH`,
          fix: 'Verify git is on PATH (try `git --version`) and that the working tree is not corrupted',
        };
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return { name: 'Git Repository', status: 'warn', message: 'Not a git repository', fix: 'git init' };
  }
}

// Check AIDefence package availability (#1807)
//
// `aidefence_*` MCP tools (scan, analyze, has_pii, stats, learn) require
// `@claude-flow/aidefence` to be installed and loadable. The package is an
// optional dependency — present in some installs (project-local) but
// missing in others (npm-global of `claude-flow`). Without it, every
// aidefence MCP call fails at runtime with "Cannot find module".
//
// Surface that state in `doctor` so operators know BEFORE they rely on
// AI-defence scanning. The probe is the same dynamic `import()` the MCP
// tool's handler uses, so a `pass` here means the actual tools will work.
async function checkAIDefence(): Promise<HealthCheck> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    await import('@claude-flow/aidefence');
    return {
      name: 'AIDefence',
      status: 'pass',
      message: '@claude-flow/aidefence loadable — aidefence_* MCP tools functional',
    };
  } catch {
    return {
      name: 'AIDefence',
      status: 'warn',
      message: '@claude-flow/aidefence not loadable — aidefence_* MCP tools will fail (optional package)',
      fix: 'npm install --save @claude-flow/aidefence  (in your project), or run `claude-flow mcp start` from a directory that has it installed',
    };
  }
}

/**
 * ADR-097 Phase 4: federation peer-state surface for doctor.
 *
 * Probes the federation plugin loadability + asserts the breaker entity
 * layer is present in the installed version. Without the plugin
 * installed this is a "not configured" pass — federation is opt-in.
 *
 * Live coordinator state (per-peer counts) requires a running MCP server
 * with `federation_init` called; operators inspect that via the
 * `federation_breaker_status` MCP tool, not the doctor (which is a
 * one-shot CLI process with no coordinator session).
 */
async function checkFederationBreaker(): Promise<HealthCheck> {
  try {
    // Optional plugin — not a hard dep of @claude-flow/cli. Build the
    // module specifier dynamically so TypeScript cannot statically
    // resolve it (which would emit TS2307); at runtime the import
    // either resolves (plugin installed) or throws (handled below).
    const specifier = ['@claude-flow', 'plugin-agent-federation'].join('/');
    const mod: { FederationNodeState?: unknown } = await import(specifier);
    if (!mod.FederationNodeState) {
      return {
        name: 'Federation Breaker',
        status: 'warn',
        message:
          '@claude-flow/plugin-agent-federation loaded but FederationNodeState export missing — version older than ADR-097 Phase 2',
        fix: 'Upgrade: npm install @claude-flow/plugin-agent-federation@alpha',
      };
    }
    return {
      name: 'Federation Breaker',
      status: 'pass',
      message:
        'ADR-097 breaker loadable — federation_breaker_status / federation_evict / federation_reactivate MCP tools available',
    };
  } catch {
    return {
      name: 'Federation Breaker',
      status: 'pass',
      message:
        'Federation plugin not installed (optional) — install only if you need cross-installation peering',
      fix: 'npm install --save @claude-flow/plugin-agent-federation@alpha',
    };
  }
}

// Check MCP servers
async function checkMcpServers(): Promise<HealthCheck> {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  // #1842: ~/.claude.json holds project-scoped registrations under
  // parsed.projects[<projectPath>].mcpServers.ruflo, in addition to any
  // top-level mcpServers. Check both shapes plus the legacy desktop and
  // local .mcp.json paths.
  const mcpConfigPaths = [
    join(home, '.claude.json'),
    join(home, '.claude/claude_desktop_config.json'),
    join(home, '.config/claude/mcp.json'),
    '.mcp.json',
  ];

  const isRufloKey = (k: string) =>
    k === 'ruflo' || k === 'ruflo_alpha' || k === 'claude-flow' || k === 'claude-flow_alpha';
  // Canonical MCP-server key is `claude-flow` — matches the `mcp__claude-flow__*`
  // prefix that ~166 plugin tool references depend on (#2206). A `ruflo`-keyed
  // entry pointing at the same binary is the legacy duplicate created by
  // pre-rename setup docs that #2612 tracks; doctor treats it as removable.
  const isCurrentRufloKey = (k: string) => k === 'claude-flow' || k === 'claude-flow_alpha';
  const isLegacyRufloKey = (k: string) => k === 'ruflo' || k === 'ruflo_alpha';
  const isRufloServer = (server: unknown): boolean => {
    if (!server || typeof server !== 'object') return false;
    const entry = server as { command?: unknown; args?: unknown };
    const command = typeof entry.command === 'string' ? entry.command : '';
    const args = Array.isArray(entry.args)
      ? entry.args.filter((arg): arg is string => typeof arg === 'string')
      : [];
    const haystack = [command, ...args].join(' ');
    return /\b(?:ruflo|claude-flow|@claude-flow\/cli)(?:@[\w.-]+)?\b/.test(haystack);
  };

  let totalServersSeen = 0;
  const rufloLocations: string[] = [];
  const duplicateLocations: string[] = [];
  const legacyLocations: string[] = [];
  const currentLocations: string[] = [];

  const inspectServers = (
    servers: unknown,
    location: string
  ): { total: number; hasRuflo: boolean } => {
    if (!servers || typeof servers !== 'object') return { total: 0, hasRuflo: false };

    const entries = Object.entries(servers as Record<string, unknown>);
    const activeRufloEntries = entries.filter(([key, server]) => isRufloKey(key) && isRufloServer(server));
    const hasLegacy = activeRufloEntries.some(([key]) => isLegacyRufloKey(key));
    const hasCurrent = activeRufloEntries.some(([key]) => isCurrentRufloKey(key));

    if (activeRufloEntries.length > 0) {
      rufloLocations.push(`${location}: ${activeRufloEntries.map(([key]) => key).join(', ')}`);
    }
    if (hasLegacy && hasCurrent) {
      duplicateLocations.push(`${location}: ${activeRufloEntries.map(([key]) => key).join(' + ')}`);
    }
    for (const [key] of activeRufloEntries) {
      if (isLegacyRufloKey(key)) legacyLocations.push(`${location}: ${key}`);
      if (isCurrentRufloKey(key)) currentLocations.push(`${location}: ${key}`);
    }

    return { total: entries.length, hasRuflo: activeRufloEntries.length > 0 };
  };

  for (const configPath of mcpConfigPaths) {
    if (!existsSync(configPath)) continue;
    try {
      const content = JSON.parse(readFileSync(configPath, 'utf8'));
      // Top-level mcpServers (legacy / desktop form)
      const topResult = inspectServers(content.mcpServers || content.servers || {}, `${configPath} top-level`);
      totalServersSeen += topResult.total;

      // Project-scoped (Claude Code shape): projects[*].mcpServers.ruflo
      if (content.projects && typeof content.projects === 'object') {
        for (const [projectKey, projectVal] of Object.entries(content.projects)) {
          const pm = (projectVal as { mcpServers?: Record<string, unknown> })?.mcpServers;
          if (pm && typeof pm === 'object') {
            const projectResult = inspectServers(pm, `${configPath} projects[${projectKey}]`);
            totalServersSeen += projectResult.total;
          }
        }
      }
    } catch {
      // continue to next path
    }
  }

  if (duplicateLocations.length > 0 || (legacyLocations.length > 0 && currentLocations.length > 0)) {
    const locations = duplicateLocations.length > 0
      ? duplicateLocations.join('; ')
      : `legacy ${legacyLocations.join('; ')} + current ${currentLocations.join('; ')}`;
    return {
      name: 'MCP Servers',
      status: 'warn',
      message: `Duplicate Ruflo MCP registrations found (${locations}) — Claude Code will start both tool schemas`,
      fix: 'Remove the legacy `ruflo`-keyed MCP registration (pre-rename duplicate) and keep the canonical `claude-flow` entry: `claude mcp add claude-flow -- npx -y ruflo@latest mcp start`. The canonical key stays `claude-flow` so the ~166 `mcp__claude-flow__*` plugin tool references keep resolving (#2206).',
    };
  }

  if (rufloLocations.length > 0) {
    return {
      name: 'MCP Servers',
      status: 'pass',
      message: `${totalServersSeen} servers (ruflo configured: ${rufloLocations.join('; ')})`,
    };
  }

  if (totalServersSeen > 0) {
    return {
      name: 'MCP Servers',
      status: 'warn',
      message: `${totalServersSeen} servers (ruflo not found)`,
      fix: 'claude mcp add claude-flow -- npx -y ruflo@latest mcp start',
    };
  }

  return {
    name: 'MCP Servers',
    status: 'warn',
    message: 'No MCP config found',
    fix: 'claude mcp add ruflo -- npx -y ruflo@latest mcp start',
  };
}

// #2726 — tools/list is fixed prompt overhead on clients/backends that do not
// defer MCP schemas. Measure the actual live registry and warn before a small
// context window becomes unrecoverable even after compaction.
async function checkMcpSchemaOverhead(): Promise<HealthCheck> {
  try {
    const [{ listMCPTools }, {
      assessMcpSchemaOverhead,
      filterAdvertisedMcpTools,
      parseMcpToolSelection,
    }] = await Promise.all([
      import('../mcp-client.js'),
      import('../mcp-server.js'),
    ]);
    // The `mcp start --tools` CLI flag takes precedence when the server is
    // constructed. Doctor intentionally inspects the environment fallback so
    // its estimate describes the configuration inherited by MCP clients.
    const selection = parseMcpToolSelection(process.env.CLAUDE_FLOW_MCP_TOOLS);
    const tools = filterAdvertisedMcpTools(listMCPTools(), selection);
    // This is diagnostic metadata about the external client's context window,
    // not Ruflo command configuration, so there is no corresponding CLI flag.
    const rawWindow = process.env.CLAUDE_FLOW_CONTEXT_WINDOW_TOKENS;
    const contextWindow = rawWindow ? Number.parseInt(rawWindow, 10) : undefined;
    const assessment = assessMcpSchemaOverhead(tools, contextWindow);
    const ratio = assessment.ratio === undefined
      ? ''
      : `, ${(assessment.ratio * 100).toFixed(1)}% of ${assessment.contextWindowTokens}-token window`;
    const selectionLabel = selection === 'all' ? 'all tools' : `filtered: ${selection.join(',')}`;
    const message = `${assessment.toolCount} advertised tools ≈ ${assessment.estimatedTokens} schema tokens (${selectionLabel}${ratio})`;

    if (assessment.risk === 'high') {
      return {
        name: 'MCP Schema Overhead',
        status: 'warn',
        message,
        fix: 'Set CLAUDE_FLOW_MCP_TOOLS to required categories/tool names (for example: memory,swarm,agent,hooks) and optionally CLAUDE_FLOW_CONTEXT_WINDOW_TOKENS to your backend limit.',
      };
    }
    return { name: 'MCP Schema Overhead', status: 'pass', message };
  } catch (error) {
    return {
      name: 'MCP Schema Overhead',
      status: 'warn',
      message: `Unable to measure: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// Check disk space (async with proper env inheritance)
async function checkDiskSpace(): Promise<HealthCheck> {
  try {
    if (process.platform === 'win32') {
      return { name: 'Disk Space', status: 'pass', message: 'Check skipped on Windows' };
    }
    // Use df -Ph for POSIX mode (guarantees single-line output even with long device names)
    const output_str = await runCommand('df -Ph . | tail -1');
    const parts = output_str.split(/\s+/);
    // POSIX format: Filesystem Size Used Avail Capacity Mounted
    const available = parts[3];
    const usePercent = parseInt(parts[4]?.replace('%', '') || '0', 10);
    if (isNaN(usePercent)) {
      return { name: 'Disk Space', status: 'warn', message: `${available || 'unknown'} available (unable to parse usage)` };
    }

    if (usePercent > 90) {
      return { name: 'Disk Space', status: 'fail', message: `${available} available (${usePercent}% used)`, fix: 'Free up disk space' };
    } else if (usePercent > 80) {
      return { name: 'Disk Space', status: 'warn', message: `${available} available (${usePercent}% used)` };
    }
    return { name: 'Disk Space', status: 'pass', message: `${available} available` };
  } catch {
    return { name: 'Disk Space', status: 'warn', message: 'Unable to check' };
  }
}

// Check TypeScript/build (async with proper env inheritance)
async function checkBuildTools(): Promise<HealthCheck> {
  try {
    const tscVersion = await runCommand('npx tsc --version', 10000); // tsc can be slow
    if (!tscVersion || tscVersion.includes('not found')) {
      return { name: 'TypeScript', status: 'warn', message: 'Not installed locally', fix: 'npm install -D typescript' };
    }
    return { name: 'TypeScript', status: 'pass', message: tscVersion.replace('Version ', 'v') };
  } catch {
    return { name: 'TypeScript', status: 'warn', message: 'Not installed locally', fix: 'npm install -D typescript' };
  }
}

// Check for stale npx cache (version freshness)
async function checkVersionFreshness(): Promise<HealthCheck> {
  try {
    // Get current CLI version from package.json
    // Use import.meta.url to reliably locate our own package.json,
    // regardless of how deep the compiled file sits (e.g. dist/src/commands/).
    let currentVersion = '0.0.0';
    try {
      const thisFile = fileURLToPath(import.meta.url);
      let dir = dirname(thisFile);

      // Walk up from the current file's directory until we find the
      // package.json that belongs to @claude-flow/cli (or claude-flow/cli).
      // Walk until dirname(dir) === dir (filesystem root on any platform).
      for (;;) {
        const candidate = join(dir, 'package.json');
        try {
          if (existsSync(candidate)) {
            const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
            if (
              pkg.version &&
              typeof pkg.name === 'string' &&
              (pkg.name === '@claude-flow/cli' || pkg.name === 'claude-flow' || pkg.name === 'ruflo')
            ) {
              currentVersion = pkg.version;
              break;
            }
          }
        } catch {
          // Unreadable/invalid JSON -- skip and keep walking up
        }
        const parent = dirname(dir);
        if (parent === dir) break; // reached root
        dir = parent;
      }
    } catch {
      // Fall back to a default
      currentVersion = '0.0.0';
    }

    // Check if running via npx (look for _npx in process path or argv)
    const isNpx = process.argv[1]?.includes('_npx') ||
                  process.env.npm_execpath?.includes('npx') ||
                  process.cwd().includes('_npx');

    // Query npm for latest version (using alpha tag since that's what we publish to)
    let latestVersion = currentVersion;
    try {
      const npmInfo = await runCommand('npm view @claude-flow/cli@alpha version', 5000);
      latestVersion = npmInfo.trim();
    } catch {
      // Can't reach npm registry - skip check
      return {
        name: 'Version Freshness',
        status: 'warn',
        message: `v${currentVersion} (cannot check registry)`
      };
    }

    // Parse version numbers for comparison (handle prerelease like 3.0.0-alpha.84)
    const parseVersion = (v: string): { major: number; minor: number; patch: number; prerelease: number } => {
      const match = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-[a-zA-Z]+\.(\d+))?/);
      if (!match) return { major: 0, minor: 0, patch: 0, prerelease: 0 };
      return {
        major: parseInt(match[1], 10) || 0,
        minor: parseInt(match[2], 10) || 0,
        patch: parseInt(match[3], 10) || 0,
        prerelease: parseInt(match[4], 10) || 0
      };
    };

    const current = parseVersion(currentVersion);
    const latest = parseVersion(latestVersion);

    // Compare versions (including prerelease number)
    const isOutdated = (
      latest.major > current.major ||
      (latest.major === current.major && latest.minor > current.minor) ||
      (latest.major === current.major && latest.minor === current.minor && latest.patch > current.patch) ||
      (latest.major === current.major && latest.minor === current.minor && latest.patch === current.patch && latest.prerelease > current.prerelease)
    );

    if (isOutdated) {
      const fix = isNpx
        ? 'rm -rf ~/.npm/_npx/* && npx -y @claude-flow/cli@latest'
        : 'npm update @claude-flow/cli';

      return {
        name: 'Version Freshness',
        status: 'warn',
        message: `v${currentVersion} (latest: v${latestVersion})${isNpx ? ' [npx cache stale]' : ''}`,
        fix
      };
    }

    return {
      name: 'Version Freshness',
      status: 'pass',
      message: `v${currentVersion} (up to date)`
    };
  } catch (error) {
    return {
      name: 'Version Freshness',
      status: 'warn',
      message: 'Unable to check version freshness'
    };
  }
}

// Check Claude Code CLI (async with proper env inheritance)
// ADR-150 — surface MetaHarness availability + harnessFit score in
// the standard ruflo doctor flow. Graceful degradation: when metaharness
// is not installed (no network, optionalDep skipped), the check returns
// `warn` with a hint instead of `fail` — ruflo continues to function.
/**
 * iter 45 — verify the ruflo-side MetaHarness integration is intact.
 *
 * The existing `checkMetaharness` verifies the UPSTREAM `metaharness`
 * package is reachable (warn if missing — it's optional per ADR-150).
 * This check verifies the INTEGRATION LAYER (plugin scripts, production
 * module, subprocess bridge) is intact. Unlike upstream, the integration
 * layer is shipped with ruflo — missing files mean ruflo's install is
 * corrupted, not that an optional dep is absent.
 *
 * Status mapping:
 *   pass — all required files present + module loads + similarity() smoke OK
 *   fail — any required file missing OR module fails to import
 *   warn — files present but module import errored at runtime
 *
 * Verified files (iter 36-53 surfaces — full ADR-150 deep-integration set):
 *   - plugins/ruflo-metaharness/scripts/_harness.mjs                (subprocess bridge)
 *   - plugins/ruflo-metaharness/scripts/_similarity.mjs             (ADR-152 §3.1 module, iter 36)
 *   - plugins/ruflo-metaharness/scripts/similarity.mjs              (CLI skill, iter 36)
 *   - plugins/ruflo-metaharness/scripts/_spike-similarity.mjs       (regression anchor, iter 35)
 *   - plugins/ruflo-metaharness/scripts/drift-from-history.mjs      (1-command primitive, iter 53)
 *   - plugins/ruflo-metaharness/skills/harness-similarity/SKILL.md
 *   - plugins/ruflo-metaharness/skills/harness-drift-from-history/SKILL.md  (iter 53)
 */
/**
 * ADR-305 — funnel state audit. Reports the effective enabled/disabled
 * state and, critically for enterprise audit verification, WHICH
 * precedence source decided it (env > enterprise > user > default).
 * Informational: both states are `pass`; only a resolver failure warns.
 */
async function checkFunnel(): Promise<HealthCheck> {
  try {
    const { resolveFunnelEnabled, getDisclosure } = await import('../funnel/index.js');
    const decision = resolveFunnelEnabled();
    const disclosure = getDisclosure();
    return {
      name: 'Funnel (ADR-305)',
      status: 'pass',
      message: `${decision.enabled ? 'enabled' : 'disabled'} (decided by: ${decision.decidedBy}; disclosure: ${disclosure.state})`,
    };
  } catch (err) {
    return {
      name: 'Funnel (ADR-305)',
      status: 'warn',
      message: `state unreadable: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'ruflo funnel status',
    };
  }
}

/** Meta LLM Proxy — sponsored-downtime health (ADR-313). */
async function checkProxySponsoredConsent(): Promise<HealthCheck> {
  try {
    const { funnelStateDir, hasConsent, readRateLimitStatus, lastRecordedEvent } = await import('../funnel/index.js');
    const dir = funnelStateDir();
    const installed = existsSync(join(dir, 'proxy-token'));
    const consented = hasConsent('sponsored-downtime');
    const rateLimited = readRateLimitStatus();
    const lastExhausted = lastRecordedEvent('sponsor_capacity_exhausted');

    if (!installed) {
      return {
        name: 'Meta LLM Proxy (ADR-313)',
        status: 'warn',
        message: 'not installed — no proxy-token found; sponsored-downtime capacity is unavailable',
        fix: 'See cognitum-one/meta-proxy (private) for install instructions',
      };
    }

    const parts = [
      `sponsored consent: ${consented ? 'granted' : 'not granted'}`,
      `rate-limit flag: ${rateLimited.limited ? `set (since ${rateLimited.since})` : 'not set'}`,
    ];
    if (lastExhausted) parts.push(`last capacity-exhausted: ${lastExhausted}`);

    if (rateLimited.limited && !consented) {
      return {
        name: 'Meta LLM Proxy (ADR-313)',
        status: 'warn',
        message: `${parts.join('; ')} — flagged rate-limited but sponsored capacity isn't enabled`,
        fix: 'ruflo proxy sponsor-enable --yes',
      };
    }

    return { name: 'Meta LLM Proxy (ADR-313)', status: 'pass', message: parts.join('; ') };
  } catch (err) {
    return {
      name: 'Meta LLM Proxy (ADR-313)',
      status: 'warn',
      message: `state unreadable: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'ruflo proxy sponsor-status',
    };
  }
}

/**
 * Binary presence + tamper check (ADR-307). Deliberately NEVER spawns the
 * binary to probe a version — confirmed empirically (2026-07-16) that
 * `meta-proxy` has no `--version`/`--help` flag and starts the live server
 * as a side effect of ANY invocation, which a doctor health check must never
 * do. Version info instead comes from install-manifest.json (written at
 * install time) and, once running, the proxy's own `/status` endpoint via
 * checkProxyProcess below.
 */
async function checkProxyBinary(): Promise<HealthCheck> {
  const NAME = 'Meta LLM Proxy binary (ADR-307)';
  try {
    const { proxyBinaryPath, proxyInstallManifestPath } = await import('../proxy/paths.js');
    const binPath = proxyBinaryPath();
    if (!existsSync(binPath)) {
      return { name: NAME, status: 'warn', message: 'not installed', fix: 'ruflo proxy install' };
    }

    const manifestPath = proxyInstallManifestPath();
    if (!existsSync(manifestPath)) {
      return {
        name: NAME,
        status: 'warn',
        message: 'binary present but no install-manifest.json — provenance unknown (installed outside `ruflo proxy install`?)',
        fix: 'ruflo proxy update --release <x.y.z>',
      };
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      version: string;
      sha256: string;
      verifiedAt: string;
    };
    const liveSha = createHash('sha256').update(readFileSync(binPath)).digest('hex');
    if (liveSha !== manifest.sha256) {
      return {
        name: NAME,
        status: 'fail',
        message: `binary sha256 does not match the recorded install manifest — possible tampering or a manual overwrite (expected ${manifest.sha256.slice(0, 12)}…, got ${liveSha.slice(0, 12)}…)`,
        fix: 'ruflo proxy update --release <x.y.z>',
      };
    }

    return { name: NAME, status: 'pass', message: `v${manifest.version}, signature-verified at install (${manifest.verifiedAt})` };
  } catch (err) {
    return { name: NAME, status: 'warn', message: `check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** PID-file liveness (ADR-307) — mirrors daemon.ts's signal-0 probe pattern. */
async function checkProxyProcess(): Promise<HealthCheck> {
  const NAME = 'Meta LLM Proxy process (ADR-307)';
  try {
    const { proxyPidFilePath } = await import('../proxy/paths.js');
    const pidPath = proxyPidFilePath();
    if (!existsSync(pidPath)) {
      return { name: NAME, status: 'warn', message: 'not running (no PID file)', fix: 'ruflo proxy start' };
    }

    const pidRaw = readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(pidRaw, 10);
    if (!Number.isFinite(pid)) {
      return { name: NAME, status: 'warn', message: `PID file is malformed: ${JSON.stringify(pidRaw)}`, fix: 'ruflo proxy stop && ruflo proxy start' };
    }

    try {
      process.kill(pid, 0); // signal-0 liveness probe — throws if the process is dead
    } catch {
      return { name: NAME, status: 'warn', message: `PID file points at ${pid}, which is not running — stale PID file`, fix: 'ruflo proxy start' };
    }

    // Live version-compat + data-plane info, ONLY once PID liveness already
    // confirmed a process is running (never spawns anything — see
    // checkProxyBinary's comment on why probing via process launch is unsafe).
    // GET /status shape confirmed against the real v0.1.0 binary:
    // {"version","data_plane","bind","sponsored_available","proxy_token_valid"}.
    const { proxyConfigPath, proxyTokenPath, proxyInstallManifestPath } = await import('../proxy/paths.js');
    const bindMatch = existsSync(proxyConfigPath())
      ? readFileSync(proxyConfigPath(), 'utf-8').match(/^bind\s*=\s*"([^"]*)"/m)
      : null;
    const bind = bindMatch ? bindMatch[1] : '127.0.0.1:11435';

    let token: string;
    try {
      token = readFileSync(proxyTokenPath(), 'utf-8').trim();
    } catch {
      return { name: NAME, status: 'pass', message: `running (pid ${pid}); no proxy-token to query /status` };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const resp = await fetch(`http://${bind}/status`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        return { name: NAME, status: 'warn', message: `running (pid ${pid}); /status returned HTTP ${resp.status}` };
      }
      const body = (await resp.json()) as { version?: string; data_plane?: string };

      let versionNote = '';
      if (existsSync(proxyInstallManifestPath())) {
        const manifest = JSON.parse(readFileSync(proxyInstallManifestPath(), 'utf-8')) as { version?: string };
        if (manifest.version && body.version && manifest.version !== body.version) {
          return {
            name: NAME,
            status: 'warn',
            message: `running (pid ${pid}) reports v${body.version}, but the installed binary is v${manifest.version} — a stale process from a previous version?`,
            fix: 'ruflo proxy stop && ruflo proxy start',
          };
        }
        versionNote = body.version ? ` v${body.version}` : '';
      }

      return {
        name: NAME,
        status: 'pass',
        message: `running (pid ${pid})${versionNote}; data plane: ${body.data_plane ?? 'unknown'}`,
      };
    } catch (err) {
      // Live process but /status unreachable (still starting up, or a
      // network hiccup) — not a failure, PID liveness already passed.
      return {
        name: NAME,
        status: 'pass',
        message: `running (pid ${pid}); /status unreachable (${err instanceof Error ? err.message : String(err)})`,
      };
    }
  } catch (err) {
    return { name: NAME, status: 'warn', message: `check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Non-loopback bind exposure warning (ADR-307's mandated startup warning, surfaced in doctor too). */
async function checkProxyBindAddress(): Promise<HealthCheck> {
  const NAME = 'Meta LLM Proxy bind address (ADR-307)';
  try {
    const { proxyConfigPath, isLoopbackBind } = await import('../proxy/paths.js');
    const cfgPath = proxyConfigPath();
    if (!existsSync(cfgPath)) {
      return { name: NAME, status: 'pass', message: 'no config file yet — defaults to loopback-only (127.0.0.1:11435)' };
    }

    const raw = readFileSync(cfgPath, 'utf-8');
    const match = raw.match(/^bind\s*=\s*"([^"]*)"/m);
    const bind = match ? match[1] : '127.0.0.1:11435';

    if (!isLoopbackBind(bind)) {
      return {
        name: NAME,
        status: 'warn',
        message: `bound to non-loopback address ${bind} — this exposes the proxy to your network`,
        fix: 'Set bind back to 127.0.0.1:<port> in proxy-config.toml unless external exposure is intended',
      };
    }

    return { name: NAME, status: 'pass', message: `loopback-only (${bind})` };
  } catch (err) {
    return { name: NAME, status: 'warn', message: `check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** `ruflo auth` health (ADR-306). Warn (never fail) on absence — auth is never required for core functionality. */
async function checkAuth(): Promise<HealthCheck> {
  const NAME = 'Cognitum identity (ADR-306)';
  try {
    const { listProfiles } = await import('../auth/state.js');
    const { domainForScope } = await import('../auth/scopes.js');
    const { hasConsent } = await import('../funnel/index.js');
    const { profiles } = listProfiles();

    if (profiles.length === 0) {
      return { name: NAME, status: 'warn', message: 'not logged in', fix: 'ruflo auth login' };
    }

    let keychainAvailable: boolean | 'unknown' = 'unknown';
    try {
      const sec = await import('@claude-flow/security');
      keychainAvailable = await (await sec.createKeychainAdapter()).isAvailable();
    } catch {
      keychainAvailable = 'unknown'; // security package unavailable — surfaced by checkProxyBinary's sibling concerns, not duplicated here
    }

    // Scope-vs-receipt consistency check (ADR-306: "fail-closed... reports").
    // Unlike every other check in this file, a violation here is a FAIL, not
    // a warn — a scope present without a matching consent receipt is exactly
    // the condition ADR-306 says must never silently pass.
    const violations: string[] = [];
    for (const p of profiles) {
      for (const scope of p.scopes) {
        const domain = domainForScope(scope);
        if (domain && !hasConsent(domain)) violations.push(`${p.profile}: ${scope}`);
      }
    }
    if (violations.length > 0) {
      return {
        name: NAME,
        status: 'fail',
        message: `scope granted without a matching consent receipt: ${violations.join(', ')}`,
        fix: 'ruflo auth logout && ruflo auth login',
      };
    }

    const names = profiles.map((p) => p.profile).join(', ');
    const sessionOnly = profiles.filter((p) => !p.keychainRef).map((p) => p.profile);
    const parts = [`profiles: ${names}`];
    if (keychainAvailable === false) parts.push('keychain backend unreachable — falling back to session-only tokens');
    if (sessionOnly.length > 0) parts.push(`session-only (no persisted refresh token): ${sessionOnly.join(', ')}`);

    return { name: NAME, status: 'pass', message: parts.join('; ') };
  } catch (err) {
    return { name: NAME, status: 'warn', message: `check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function checkMetaharnessIntegration(): Promise<HealthCheck> {
  // Locate plugins dir.
  //
  // Pre-#2437 fix this only walked up from `process.cwd()` + checked one
  // hard-coded `<cwd>/node_modules/@claude-flow/cli/...` candidate. That
  // missed the two cases users actually run from:
  //   (a) `npx @claude-flow/cli@<tag>` → resolves to a per-version cache
  //       under `~/.npm/_npx/<hash>/node_modules/@claude-flow/cli/...`
  //   (b) `npm install -g @claude-flow/cli` → lives at
  //       `$(npm prefix -g)/lib/node_modules/@claude-flow/cli/...`
  //
  // The bulletproof fix: resolve relative to THIS file's own location via
  // `import.meta.url`. The plugins dir is always a sibling of the package
  // root regardless of where the package was installed. Walk up from
  // `dist/src/commands/doctor.js` (built) or `src/commands/doctor.ts`
  // (dev) until we find a directory containing `plugins/ruflo-metaharness/`.
  const candidates: string[] = [];

  // Strategy 1: walk up from this module's own URL — covers npx + global install.
  try {
    const selfDir = dirname(fileURLToPath(import.meta.url));
    let q = selfDir;
    for (let i = 0; i < 8; i++) {
      candidates.push(join(q, 'plugins', 'ruflo-metaharness'));
      q = dirname(q);
    }
  } catch {
    // import.meta.url unavailable under some bundlers — fall through to cwd walk.
  }

  // Strategy 2: walk up from cwd — covers monorepo dev (running from a sub-package).
  let p = process.cwd();
  for (let i = 0; i < 8; i++) {
    candidates.push(join(p, 'plugins', 'ruflo-metaharness'));
    p = dirname(p);
  }

  // Strategy 3: explicit node_modules path relative to cwd — covers project-local install.
  candidates.push(join(process.cwd(), 'node_modules', '@claude-flow', 'cli', 'plugins', 'ruflo-metaharness'));

  let pluginDir: string | null = null;
  for (const c of candidates) {
    if (existsSync(join(c, 'scripts', '_harness.mjs'))) {
      pluginDir = c;
      break;
    }
  }

  if (!pluginDir) {
    // #2437: MetaHarness is documented as an optional dependency in
    // optionalDependencies (per ADR-150 architectural constraint #2 —
    // "Optional in package.json"). A genuinely-absent plugin therefore
    // warrants WARN, not FAIL — same posture as the runtime path which
    // returns {degraded: true, exit 0}. FAIL is reserved for misconfigured
    // installs where the plugin SHOULD be present but is broken.
    return {
      name: 'MetaHarness integration (ADR-150)',
      status: 'warn',
      message: 'plugins/ruflo-metaharness/ not found — MetaHarness skills will degrade gracefully',
      fix: 'Optional: install via `npm i -D @metaharness/darwin metaharness` or run `ruflo plugins install ruflo-metaharness`',
    };
  }

  // Required files (iter 36+44 surfaces, +ADR-153 darwin surfaces in v3.13.0)
  const required = [
    'scripts/_harness.mjs',
    'scripts/_similarity.mjs',
    'scripts/similarity.mjs',
    'scripts/_spike-similarity.mjs',
    // iter 53 surfaces — gated against silent deletion
    'scripts/drift-from-history.mjs',
    'skills/harness-similarity/SKILL.md',
    'skills/harness-drift-from-history/SKILL.md',
    // ADR-153 Darwin Mode surfaces (v3.13.0) — added to gate against silent deletion
    'scripts/_darwin.mjs',
    'scripts/evolve.mjs',
    'scripts/security-bench.mjs',
    'scripts/bench.mjs',
    'skills/harness-evolve/SKILL.md',
    'skills/harness-security-bench/SKILL.md',
    'skills/harness-bench/SKILL.md',
  ];
  const missing = required.filter((f) => !existsSync(join(pluginDir, f)));
  if (missing.length > 0) {
    return {
      name: 'MetaHarness integration (ADR-150)',
      status: 'fail',
      message: `Missing files: ${missing.join(', ')}`,
      fix: 'Reinstall ruflo or restore from git: `git checkout HEAD -- plugins/ruflo-metaharness/`',
    };
  }

  // Runtime smoke: import the similarity module and exercise it
  try {
    const modPath = join(pluginDir, 'scripts', '_similarity.mjs');
    const mod = await import(modPath) as { similarity?: (a: unknown, b: unknown) => { overall?: number } };
    if (typeof mod.similarity !== 'function') {
      return {
        name: 'MetaHarness integration (ADR-150)',
        status: 'fail',
        message: '_similarity.mjs does not export similarity()',
        fix: 'Reinstall ruflo or restore the file from git',
      };
    }
    const result = mod.similarity({}, {});
    if (typeof result?.overall !== 'number') {
      return {
        name: 'MetaHarness integration (ADR-150)',
        status: 'warn',
        message: 'similarity() returned unexpected shape; module may be stale',
      };
    }

    // iter 52 — also verify the iter-50 mcp-scan text parser exports
    // correctly. parseMcpScanText is the shared util both mcp-scan.mjs
    // and oia-audit.mjs depend on; if it's missing the audit-trend
    // introduced/cleared diff silently degrades to dead code.
    //
    // iter 61 — additionally verify iter-56's async exports
    // (runHarnessAsync / runMetaharnessAsync). These are the
    // parallelization primitives oia-audit depends on; if they're
    // missing, oia-audit's import fails and the whole pipeline breaks.
    const harnessPath = join(pluginDir, 'scripts', '_harness.mjs');
    const harnessMod = await import(harnessPath) as {
      parseMcpScanText?: (s: string) => unknown;
      runHarnessAsync?: (args: string[]) => Promise<unknown>;
      runMetaharnessAsync?: (args: string[]) => Promise<unknown>;
    };
    if (typeof harnessMod.parseMcpScanText !== 'function') {
      return {
        name: 'MetaHarness integration (ADR-150)',
        status: 'fail',
        message: '_harness.mjs does not export parseMcpScanText (iter 50 — needed by mcp-scan + oia-audit)',
        fix: 'Reinstall ruflo or restore _harness.mjs from git',
      };
    }
    if (typeof harnessMod.runHarnessAsync !== 'function' || typeof harnessMod.runMetaharnessAsync !== 'function') {
      return {
        name: 'MetaHarness integration (ADR-150)',
        status: 'fail',
        message: '_harness.mjs missing iter-56 async exports (runHarnessAsync / runMetaharnessAsync) — oia-audit parallelization will fail',
        fix: 'Reinstall ruflo or restore _harness.mjs from git',
      };
    }
    // Smoke: parser handles empty input gracefully
    const parsed = harnessMod.parseMcpScanText('') as { findings?: unknown };
    if (!Array.isArray(parsed?.findings)) {
      return {
        name: 'MetaHarness integration (ADR-150)',
        status: 'warn',
        message: 'parseMcpScanText returned unexpected shape on empty input',
      };
    }

    return {
      name: 'MetaHarness integration (ADR-150)',
      status: 'pass',
      message: 'plugin scripts intact, _similarity.mjs + parseMcpScanText load, smoke OK',
    };
  } catch (e) {
    return {
      name: 'MetaHarness integration (ADR-150)',
      status: 'warn',
      message: `Module import errored: ${(e as Error).message.slice(0, 60)}`,
    };
  }
}

/**
 * Dependency-contract check: every `@metaharness/*` package this CLI DECLARES
 * in its own optionalDependencies must actually resolve at runtime. Declared
 * packages are advertised integration surfaces (`ruflo metaharness evolve`,
 * flywheel receipt interop, radio coordination) — a declared-but-absent
 * package means the install dropped an optional dep (or the declaration
 * regressed to peer-only), so the advertised integration silently degrades.
 * That is a FAIL, not a warn: warn is reserved for surfaces that were never
 * advertised as installed (the `npx metaharness` umbrella path above).
 */
async function checkMetaharnessDeclaredPackages(): Promise<HealthCheck> {
  const NAME = 'MetaHarness declared packages (ADR-150)';
  try {
    // Walk up from this module to the CLI package root (works for npx cache,
    // global install, project-local install, and monorepo dev alike).
    let root: string | null = null;
    let q = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const pj = join(q, 'package.json');
      if (existsSync(pj)) {
        try {
          if ((JSON.parse(readFileSync(pj, 'utf-8')) as { name?: string }).name === '@claude-flow/cli') { root = q; break; }
        } catch { /* keep walking */ }
      }
      q = dirname(q);
    }
    if (!root) return { name: NAME, status: 'warn', message: 'could not locate the @claude-flow/cli package root' };

    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { optionalDependencies?: Record<string, string> };
    const declared = Object.keys(pkg.optionalDependencies ?? {}).filter((n) => n === 'metaharness' || n.startsWith('@metaharness/'));
    if (declared.length === 0) {
      return {
        name: NAME,
        status: 'fail',
        message: 'no @metaharness/* packages declared in optionalDependencies — the dependency contract regressed (peer-only declarations are never installed)',
        fix: 'Restore @metaharness/darwin, @metaharness/flywheel, @metaharness/radio, @metaharness/turn-credit to optionalDependencies in @claude-flow/cli',
      };
    }

    // Node resolution: nearest node_modules wins, walking upward from the CLI root.
    const resolves = (name: string): boolean => {
      let d = root as string;
      for (let i = 0; i < 10; i++) {
        if (existsSync(join(d, 'node_modules', name, 'package.json'))) return true;
        const parent = dirname(d);
        if (parent === d) break;
        d = parent;
      }
      return false;
    };
    const missing = declared.filter((n) => !resolves(n));
    if (missing.length > 0) {
      return {
        name: NAME,
        status: 'fail',
        message: `declared but not installed: ${missing.join(', ')} — advertised MetaHarness surfaces are degraded`,
        fix: 'npm install --include=optional  # optional deps were skipped or pruned',
      };
    }
    return { name: NAME, status: 'pass', message: `${declared.length} declared package(s) resolve: ${declared.join(', ')}` };
  } catch (err) {
    return { name: NAME, status: 'warn', message: `check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function checkMetaharness(): Promise<HealthCheck> {
  try {
    // `metaharness` has no --version flag (it falls through to the usage
    // banner, which never matches a version regex) and shelling out via
    // `npx metaharness@latest` ignores the installed version and hits the
    // network every run. Resolve the version from the installed package's
    // own package.json instead. `import.meta.resolve` is the reliable route:
    // `require('metaharness/package.json')` is blocked by the package's
    // `exports` map, and `createRequire().resolve()` fails on its ESM-only
    // entry point.
    const resolved = import.meta.resolve('metaharness');
    let dir = dirname(fileURLToPath(resolved));
    let version: string | null = null;
    for (let i = 0; i < 8; i++) {
      const pj = join(dir, 'package.json');
      if (existsSync(pj)) {
        try {
          const j = JSON.parse(readFileSync(pj, 'utf-8')) as { name?: string; version?: string };
          if (j.name === 'metaharness') { version = j.version ?? null; break; }
        } catch { /* keep walking */ }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!version) {
      return {
        name: 'MetaHarness (ADR-150)',
        status: 'warn',
        message: 'Installed but its package.json was not found while walking up from the resolved module; integration may still work',
      };
    }
    return {
      name: 'MetaHarness (ADR-150)',
      status: 'pass',
      message: `v${version} — run \`npx ruflo metaharness score\` for the full scorecard`,
    };
  } catch {
    return {
      name: 'MetaHarness (ADR-150)',
      status: 'warn',
      message: 'Not installed — `npx ruflo metaharness *` commands will degrade gracefully',
      fix: 'npm install --include=optional  # to enable the metaharness optional dep',
    };
  }
}

async function checkClaudeCode(): Promise<HealthCheck> {
  try {
    const version = await runCommand('claude --version');
    // Parse version from output like "claude 1.0.0" or "Claude Code v1.0.0"
    const versionMatch = version.match(/v?(\d+\.\d+\.\d+)/);
    const versionStr = versionMatch ? `v${versionMatch[1]}` : version;
    return { name: 'Claude Code CLI', status: 'pass', message: versionStr };
  } catch {
    return {
      name: 'Claude Code CLI',
      status: 'warn',
      message: 'Not installed',
      fix: 'npm install -g @anthropic-ai/claude-code'
    };
  }
}

// Install Claude Code CLI
async function installClaudeCode(): Promise<boolean> {
  try {
    output.writeln();
    output.writeln(output.bold('Installing Claude Code CLI...'));
    execSync('npm install -g @anthropic-ai/claude-code', {
      encoding: 'utf8',
      stdio: 'inherit'
    });
    output.writeln(output.success('Claude Code CLI installed successfully!'));
    return true;
  } catch (error) {
    output.writeln(output.error('Failed to install Claude Code CLI'));
    if (error instanceof Error) {
      output.writeln(output.dim(error.message));
    }
    return false;
  }
}

// Check agentic-flow v3 integration (filesystem-based to avoid slow WASM/DB init)
async function checkAgenticFlow(): Promise<HealthCheck> {
  try {
    // Walk common node_modules paths to find agentic-flow/package.json
    const candidates = [
      join(process.cwd(), 'node_modules', 'agentic-flow', 'package.json'),
      join(process.cwd(), '..', 'node_modules', 'agentic-flow', 'package.json'),
    ];
    let pkgJsonPath: string | null = null;
    for (const p of candidates) {
      if (existsSync(p)) { pkgJsonPath = p; break; }
    }
    if (!pkgJsonPath) {
      return {
        name: 'agentic-flow',
        status: 'warn',
        message: 'Not installed (optional — embeddings/routing will use fallbacks)',
        fix: 'npm install agentic-flow@latest'
      };
    }
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    const version = pkg.version || 'unknown';
    const exports = pkg.exports || {};
    const features = [
      exports['./reasoningbank'] ? 'ReasoningBank' : null,
      exports['./router'] ? 'Router' : null,
      exports['./transport/quic'] ? 'QUIC' : null,
    ].filter(Boolean);
    return {
      name: 'agentic-flow',
      status: 'pass',
      message: `v${version} (${features.join(', ')})`
    };
  } catch {
    return { name: 'agentic-flow', status: 'warn', message: 'Check failed' };
  }
}

// Check encryption-at-rest status (ADR-096 Phase 5)
//
// Reports four facets without disclosing the key itself:
//   1. Gate status — is CLAUDE_FLOW_ENCRYPT_AT_REST set?
//   2. Key resolution — does CLAUDE_FLOW_ENCRYPTION_KEY resolve to a valid
//      32-byte key (env-var path only; keychain/passphrase are deferred)?
//   3. Key fingerprint — first 16 hex chars of sha256(key) so users can
//      sanity-check across machines without ever logging the key bytes.
//   4. High-tier store presence — for sessions/, terminals/, .swarm/memory.db
//      report whether on-disk bytes carry the RFE1 magic (encrypted) or not.
async function checkEncryptionAtRest(): Promise<HealthCheck> {
  if (!isEncryptionEnabled()) {
    return {
      name: 'Encryption at Rest',
      status: 'warn',
      message: 'Off — session/terminal/memory stores are plaintext (mode 0600 only)',
      fix: 'export CLAUDE_FLOW_ENCRYPT_AT_REST=1 && export CLAUDE_FLOW_ENCRYPTION_KEY=<64-char-hex>',
    };
  }

  // Gate is on — try to resolve the key. Fail-closed if missing or malformed.
  const rawKey = process.env.CLAUDE_FLOW_ENCRYPTION_KEY;
  if (!rawKey) {
    return {
      name: 'Encryption at Rest',
      status: 'fail',
      message: 'Gate is on but CLAUDE_FLOW_ENCRYPTION_KEY is unset (fail-closed)',
      fix: 'Generate a key: openssl rand -hex 32 → export CLAUDE_FLOW_ENCRYPTION_KEY=<value>',
    };
  }
  let keyFingerprint: string;
  try {
    const key = decodeKey(rawKey);
    keyFingerprint = createHash('sha256').update(key).digest('hex').slice(0, 16);
  } catch (err) {
    return {
      name: 'Encryption at Rest',
      status: 'fail',
      message: `CLAUDE_FLOW_ENCRYPTION_KEY invalid: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Provide a 64-char hex or 44-char base64 key (32 bytes)',
    };
  }

  // Check the three high-tier store paths for RFE1 magic
  const cwd = process.cwd();
  const stores: Array<{ label: string; path: string }> = [
    { label: 'sessions/', path: join(cwd, '.claude-flow', 'sessions') },
    { label: 'terminals', path: join(cwd, '.claude-flow', 'terminals', 'store.json') },
    { label: 'memory.db', path: join(cwd, '.swarm', 'memory.db') },
  ];
  const status: string[] = [];
  for (const s of stores) {
    if (!existsSync(s.path)) {
      status.push(`${s.label}=∅`);
      continue;
    }
    try {
      const stat = statSync(s.path);
      if (stat.isDirectory()) {
        // Sessions: probe the first .json file
        const { readdirSync } = await import('fs');
        const files = readdirSync(s.path).filter(f => f.endsWith('.json'));
        if (files.length === 0) { status.push(`${s.label}=∅`); continue; }
        const first = readFileSync(join(s.path, files[0]));
        status.push(`${s.label}=${isEncryptedBlob(first) ? 'enc' : 'plain'}`);
      } else {
        const buf = readFileSync(s.path);
        status.push(`${s.label}=${isEncryptedBlob(buf) ? 'enc' : 'plain'}`);
      }
    } catch {
      status.push(`${s.label}=err`);
    }
  }

  return {
    name: 'Encryption at Rest',
    status: 'pass',
    message: `On — key fp:${keyFingerprint}… (${status.join(' ')})`,
  };
}

// Format health check result
function formatCheck(check: HealthCheck): string {
  const icon = check.status === 'pass' ? output.success('✓') :
               check.status === 'warn' ? output.warning('⚠') :
               output.error('✗');
  return `${icon} ${check.name}: ${check.message}`;
}

// Main doctor command
export const doctorCommand: Command = {
  name: 'doctor',
  description: 'System diagnostics and health checks',
  options: [
    {
      name: 'fix',
      short: 'f',
      // #1791.5 — flag name was misleading: it does NOT auto-apply fixes,
      // it only prints the suggested commands so the user can run them
      // themselves. Make that explicit in the help output.
      description: 'Print suggested fix commands (does not auto-apply — copy/paste them yourself)',
      type: 'boolean',
      default: false
    },
    {
      name: 'install',
      short: 'i',
      description: 'Auto-install missing dependencies (Claude Code CLI)',
      type: 'boolean',
      default: false
    },
    {
      name: 'component',
      short: 'c',
      description: 'Check specific component (version, node, npm, config, daemon, memory, api, git, mcp, mcp-overhead, claude, disk, typescript, agentic-flow, encryption, federation, funnel, proxy, auth, metaharness)',
      type: 'string'
    },
    {
      name: 'verbose',
      short: 'v',
      description: 'Verbose output',
      type: 'boolean',
      default: false
    },
    {
      name: 'fix-handles',
      // Windows-only mitigation for anthropics/claude-code#67888 — Claude Code's
      // Bash tool spawns cmd.exe/bash.exe without cleaning up child conhost.exe
      // handles, so a long session accumulates dozens (observed live: 26+
      // orphaned conhost.exe after a ~4h session). Each holds a kernel object
      // + ~1MB, and combined with memory pressure this measurably slows the
      // machine. This flag kills orphan conhost.exe (safe — Windows respawns
      // on demand). Deliberately does NOT touch cmd.exe/bash.exe — those can
      // be the invoking shell, and killing them 255's the caller.
      description: 'Windows only: kill orphaned conhost.exe processes leaked by Claude Code (mitigation for anthropics/claude-code#67888)',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow doctor', description: 'Run full health check' },
    { command: 'claude-flow doctor --fix', description: 'Print suggested fix commands (does not auto-apply)' },
    { command: 'claude-flow doctor --install', description: 'Auto-install missing dependencies' },
    { command: 'claude-flow doctor -c version', description: 'Check for stale npx cache' },
    { command: 'claude-flow doctor -c claude', description: 'Check Claude Code CLI only' },
    { command: 'claude-flow doctor --fix-handles', description: 'Windows: kill leaked conhost.exe from Claude Code sessions' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const showFix = ctx.flags.fix as boolean;
    const autoInstall = ctx.flags.install as boolean;
    const component = ctx.flags.component as string;
    const verbose = ctx.flags.verbose as boolean;
    // Parser camelCases kebab-case flag names — read via `fixHandles`, not `['fix-handles']`.
    const fixHandles = ctx.flags.fixHandles as boolean;

    // Early-return short-circuit: `--fix-handles` is a targeted mitigation, not
    // part of the health-check flow. Runs, reports, exits.
    if (fixHandles) {
      output.writeln();
      output.writeln(output.bold('RuFlo Doctor — fix-handles'));
      output.writeln(output.dim('─'.repeat(50)));
      output.writeln();

      if (process.platform !== 'win32') {
        output.printInfo('--fix-handles is a Windows-only mitigation. On this platform (' + process.platform + '), no action taken.');
        return { success: true };
      }

      const { spawnSync } = await import('child_process');
      // PowerShell one-liner: read before-count, kill conhost, read after-count, report delta.
      const psScript = [
        "$before = (Get-Process conhost -EA SilentlyContinue).Count",
        "$mem_before = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 2)",
        "$killed = 0",
        "Get-Process conhost -EA SilentlyContinue | ForEach-Object {",
        "  try { Stop-Process -Id $_.Id -Force -EA Stop; $killed++ } catch {}",
        "}",
        "Start-Sleep -Seconds 1",
        "$after = (Get-Process conhost -EA SilentlyContinue).Count",
        "$mem_after = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 2)",
        "Write-Output ('BEFORE_COUNT=' + $before)",
        "Write-Output ('KILLED=' + $killed)",
        "Write-Output ('AFTER_COUNT=' + $after)",
        "Write-Output ('MEM_BEFORE_GB=' + $mem_before)",
        "Write-Output ('MEM_AFTER_GB=' + $mem_after)",
      ].join('; ');

      const res = spawnSync('powershell', ['-NoProfile', '-Command', psScript], {
        encoding: 'utf-8', timeout: 30000, windowsHide: true,
      });

      if (res.status !== 0) {
        output.printError('PowerShell exited with code ' + res.status);
        if (res.stderr) output.writeln(output.dim(res.stderr));
        return { success: false, exitCode: 1 };
      }

      const parse = (key: string): string => {
        const line = (res.stdout || '').split('\n').find((l) => l.startsWith(key + '='));
        return line ? line.slice(key.length + 1).trim() : '?';
      };
      const before = parse('BEFORE_COUNT');
      const killed = parse('KILLED');
      const after = parse('AFTER_COUNT');
      const memBefore = parse('MEM_BEFORE_GB');
      const memAfter = parse('MEM_AFTER_GB');

      output.writeln('conhost.exe processes:');
      output.writeln('  before:  ' + before);
      output.writeln('  killed:  ' + output.success(killed));
      output.writeln('  after:   ' + after);
      output.writeln('');
      output.writeln('Free RAM:');
      output.writeln('  before:  ' + memBefore + ' GB');
      output.writeln('  after:   ' + memAfter + ' GB');
      output.writeln('');
      output.writeln(output.dim('Note: does NOT touch cmd.exe/bash.exe/node.exe — those may be the invoking shell'));
      output.writeln(output.dim('      or an active MCP server. Kill them manually if you need to.'));
      output.writeln('');
      output.writeln(output.dim('Upstream tracking: https://github.com/anthropics/claude-code/issues/67888'));
      return { success: true };
    }

    output.writeln();
    output.writeln(output.bold('RuFlo Doctor'));
    output.writeln(output.dim('System diagnostics and health check'));
    output.writeln(output.dim('─'.repeat(50)));
    output.writeln();

    const allChecks: (() => Promise<HealthCheck>)[] = [
      checkVersionFreshness,
      checkNodeVersion,
      checkNpmVersion,
      checkClaudeCode,
      checkGit,
      checkGitRepo,
      checkConfigFile,
      checkStaleSettingsNpx, // #2448/#2677 — runaway `npx @latest` in settings
      checkDaemonStatus,
      checkMemoryDatabase,
      checkMemoryStructuralIntegrity, // #2737 — bounded, native quick_check on every default run
      checkMemoryPersistenceDriver, // #2968 — native better-sqlite3 vs sql.js fallback, read-only
      checkLearningBridge, // #2545 — can the auto-memory hook actually load @claude-flow/memory?
      checkApiKeys,
      checkMcpServers,
      checkMcpSchemaOverhead, // #2726 — fixed tools/list prompt cost
      checkAIDefence, // #1807
      checkDiskSpace,
      checkBuildTools,
      checkAgenticFlow,
      checkEncryptionAtRest, // ADR-096 Phase 5
      checkFederationBreaker, // ADR-097 Phase 4
      checkMetaharness, // ADR-150 — MetaHarness upstream package
      checkMetaharnessDeclaredPackages, // dependency contract — declared optional deps must resolve
      checkMetaharnessIntegration, // iter 45 — ruflo-side integration layer
      checkFunnel, // ADR-305 — effective funnel state + deciding precedence source
      checkProxySponsoredConsent, // ADR-313 — Meta LLM Proxy sponsored-downtime health
      checkAuth, // ADR-306 — Cognitum identity (warn-only; never fails bare `ruflo doctor`)
    ];

    // #2677: `--component memory` now runs the whole memory-health suite,
    // not just the existence check. Values can be a single check or an
    // array — expanded at execution time. Stuinfla's report showed the
    // existence-only check reporting PASS on a 99.97%-empty and even a
    // SQLite-malformed DB; the array here layers integrity → content →
    // embedding coverage over the existing existence probe; check 6 then
    // verifies that distilled episodes are actually Reflexion-retrievable and
    // execution feedback carries a lesson.
    const componentMap: Record<string, (() => Promise<HealthCheck>) | Array<() => Promise<HealthCheck>>> = {
      'version': checkVersionFreshness,
      'freshness': checkVersionFreshness,
      'node': checkNodeVersion,
      'npm': checkNpmVersion,
      'claude': checkClaudeCode,
      'config': checkConfigFile,
      'stale-settings': checkStaleSettingsNpx, // #2448
      'daemon': checkDaemonStatus,
      'memory': [
        checkMemoryDatabase,         // existing: exists + statable (unchanged)
        checkMemoryIntegrity,        // #2677 check 1: sql.js open + PRAGMA integrity_check
        checkMemoryPersistenceDriver, // #2968: native better-sqlite3 vs sql.js fallback
        checkMemoryContent,          // #2677 check 2: memory_entries content coverage
        checkMemoryEmbeddingCoverage, // #2677 check 3: vector coverage on populated rows
        checkMemoryReflexionCoverage, // #2677 check 6: episodes are retrievable
        checkMemoryCritiqueCoverage,  // #2677 check 6: feedback carries lessons
      ],
      'learning': checkLearningBridge, // #2545
      'learning-bridge': checkLearningBridge, // #2545
      'api': checkApiKeys,
      'git': checkGit,
      'mcp': checkMcpServers,
      'mcp-overhead': checkMcpSchemaOverhead,
      'aidefence': checkAIDefence, // #1807
      'disk': checkDiskSpace,
      'typescript': checkBuildTools,
      'agentic-flow': checkAgenticFlow,
      'encryption': checkEncryptionAtRest, // ADR-096 Phase 5
      'federation': checkFederationBreaker, // ADR-097 Phase 4
      'metaharness': [checkMetaharness, checkMetaharnessDeclaredPackages, checkMetaharnessIntegration], // ADR-150 — upstream + declared deps + ruflo-side
      'metaharness-integration': checkMetaharnessIntegration, // iter 45 — ruflo-side
      'funnel': checkFunnel, // ADR-305
      // ADR-307 — deep-dive array, same pattern as 'memory' above: the cheap
      // sponsored-consent check first, then binary/process/bind in the order
      // a user would actually debug them (is it installed? running? exposed?).
      'proxy': [checkProxySponsoredConsent, checkProxyBinary, checkProxyProcess, checkProxyBindAddress],
      'auth': checkAuth, // ADR-306
    };

    let checksToRun = allChecks;
    if (component && componentMap[component]) {
      const entry = componentMap[component];
      checksToRun = Array.isArray(entry) ? entry : [entry];
    }

    const results: HealthCheck[] = [];
    const fixes: string[] = [];

    // OPTIMIZATION: Run all checks in parallel for 3-5x faster execution
    const spinner = output.createSpinner({ text: 'Running health checks in parallel...', spinner: 'dots' });
    spinner.start();

    try {
      // Execute all checks concurrently
      const checkResults = await Promise.allSettled(checksToRun.map(check => check()));
      spinner.stop();

      // Process results in order
      for (const settledResult of checkResults) {
        if (settledResult.status === 'fulfilled') {
          const result = settledResult.value;
          results.push(result);
          output.writeln(formatCheck(result));

          if (result.fix && (result.status === 'fail' || result.status === 'warn')) {
            fixes.push(`${result.name}: ${result.fix}`);
          }
        } else {
          const errorResult: HealthCheck = {
            name: 'Check',
            status: 'fail',
            message: settledResult.reason?.message || 'Unknown error'
          };
          results.push(errorResult);
          output.writeln(formatCheck(errorResult));
        }
      }
    } catch (error) {
      spinner.stop();
      output.writeln(output.error('Failed to run health checks'));
    }

    // #2545: --fix / --install can actually repair the Learning Bridge by
    // recording the resolver sidecar. When doctor runs via `npx ruflo`, the CLI
    // CAN resolve its optional @claude-flow/memory dep (it is in the same npx
    // cache), so writing the sidecar makes the SessionStart hook find it.
    if ((showFix || autoInstall)) {
      const lbResult = results.find(r => r.name === 'Learning Bridge');
      if (lbResult && lbResult.status === 'fail') {
        const record = recordMemoryPackagePath(process.cwd(), 'doctor');
        if (record) {
          const newCheck = await checkLearningBridge();
          const idx = results.findIndex(r => r.name === 'Learning Bridge');
          if (idx !== -1) results[idx] = newCheck;
          const fixIdx = fixes.findIndex(f => f.startsWith('Learning Bridge:'));
          if (fixIdx !== -1 && newCheck.status === 'pass') fixes.splice(fixIdx, 1);
          output.writeln(output.success(`Repaired Learning Bridge — wrote .claude-flow/memory-package.json → ${record.distPath}`));
          output.writeln(formatCheck(newCheck));
        }
      }
    }

    // Auto-install missing dependencies if requested
    if (autoInstall) {
      const claudeCodeResult = results.find(r => r.name === 'Claude Code CLI');
      if (claudeCodeResult && claudeCodeResult.status !== 'pass') {
        const installed = await installClaudeCode();
        if (installed) {
          // Re-check Claude Code after installation
          const newCheck = await checkClaudeCode();
          const idx = results.findIndex(r => r.name === 'Claude Code CLI');
          if (idx !== -1) {
            results[idx] = newCheck;
            // Update fixes list
            const fixIdx = fixes.findIndex(f => f.startsWith('Claude Code CLI:'));
            if (fixIdx !== -1 && newCheck.status === 'pass') {
              fixes.splice(fixIdx, 1);
            }
          }
          output.writeln(formatCheck(newCheck));
        }
      }
    }

    // Summary
    const passed = results.filter(r => r.status === 'pass').length;
    const warnings = results.filter(r => r.status === 'warn').length;
    const failed = results.filter(r => r.status === 'fail').length;

    output.writeln();
    output.writeln(output.dim('─'.repeat(50)));
    output.writeln();

    const summaryParts = [
      output.success(`${passed} passed`),
      warnings > 0 ? output.warning(`${warnings} warnings`) : null,
      failed > 0 ? output.error(`${failed} failed`) : null
    ].filter(Boolean);

    output.writeln(`Summary: ${summaryParts.join(', ')}`);

    // Show fixes — #1791.5: header makes it explicit these are commands you
    // run yourself, not actions doctor took.
    if (showFix && fixes.length > 0) {
      output.writeln();
      output.writeln(output.bold('Suggested commands (run them yourself):'));
      output.writeln();
      for (const fix of fixes) {
        output.writeln(output.dim(`  ${fix}`));
      }
    } else if (fixes.length > 0 && !showFix) {
      output.writeln();
      output.writeln(output.dim(`Run with --fix to see ${fixes.length} suggested command${fixes.length > 1 ? 's' : ''} (does not auto-apply)`));
    }

    // Overall result
    if (failed > 0) {
      output.writeln();
      output.writeln(output.error('Some checks failed. Please address the issues above.'));
      return { success: false, exitCode: 1, data: { passed, warnings, failed, results } };
    } else if (warnings > 0) {
      output.writeln();
      output.writeln(output.warning('All checks passed with some warnings.'));
      return { success: true, data: { passed, warnings, failed, results } };
    } else {
      output.writeln();
      output.writeln(output.success('All checks passed! System is healthy.'));
      return { success: true, data: { passed, warnings, failed, results } };
    }
  }
};

export default doctorCommand;
