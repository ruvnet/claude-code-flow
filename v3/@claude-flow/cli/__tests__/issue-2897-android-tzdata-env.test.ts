/**
 * Regression coverage for issue #2897: on Android (Termux + PRoot Linux),
 * every `sqlite3` shell-out made by `.claude/helpers/statusline.cjs`'s
 * safeExec() died with SIGABRT, because Android's bionic libc hard-aborts
 * platform binaries that touch tzdata/ICU when ANDROID_TZDATA_ROOT is
 * unset, and PRoot doesn't export Android's runtime env roots. safeExec()
 * swallows the throw and returns '', so this was completely silent — the
 * statusline just showed Vectors 0 / HNSW off forever, indistinguishable
 * from a legitimately empty store.
 *
 * Fix: a module-scope EXEC_ENV, gated on detecting
 * /apex/com.android.tzdata, backfills ANDROID_ROOT / ANDROID_DATA /
 * ANDROID_TZDATA_ROOT / ANDROID_I18N_ROOT (never overriding an existing
 * value) and is passed as `env:` into safeExec()'s execSync() call.
 *
 * No real Android/PRoot hardware is available in CI, so this tests the
 * EXEC_ENV construction logic directly: the exact source block is
 * extracted from the COMMITTED helper (not reimplemented — a
 * reimplementation could silently drift from the real fix) and evaluated
 * in an isolated vm context with a stubbed `fs.existsSync` and a
 * controlled `process.env`, covering both the Android and non-Android
 * branches. The full file is never `require()`-d directly because its
 * tail unconditionally runs the render pipeline and console.log()s as a
 * side effect of import (no `require.main === module` guard).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = path.resolve(HERE, '..', '.claude', 'helpers', 'statusline.cjs');
const SOURCE = fs.readFileSync(HELPER_PATH, 'utf-8');

const EXEC_ENV_BLOCK_RE = /const EXEC_ENV = \(\(\) => \{[\s\S]*?\n\}\)\(\);/;

interface BuildOpts {
  androidDetected: boolean;
  env?: Record<string, string>;
}

/** Evaluate the committed EXEC_ENV IIFE in isolation and return its result. */
function buildExecEnv(opts: BuildOpts): Record<string, string> {
  const match = SOURCE.match(EXEC_ENV_BLOCK_RE);
  if (!match) {
    throw new Error(
      'EXEC_ENV block not found in .claude/helpers/statusline.cjs — ' +
        'issue #2897 fix is missing, or its shape changed (update this test\'s regex to match).',
    );
  }
  const sandbox: { fs: { existsSync: (p: string) => boolean }; process: { env: Record<string, string> }; result?: Record<string, string> } = {
    fs: { existsSync: (p: string) => (p === '/apex/com.android.tzdata' ? opts.androidDetected : false) },
    process: { env: { ...(opts.env || {}) } },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${match[0]}\nresult = EXEC_ENV;`, sandbox);
  return sandbox.result as Record<string, string>;
}

describe('issue #2897 — Android/PRoot ANDROID_TZDATA_ROOT SIGABRT fix', () => {
  it('the committed helper still defines the EXEC_ENV construction (guards future refactors from silently dropping the fix)', () => {
    expect(SOURCE).toMatch(EXEC_ENV_BLOCK_RE);
  });

  it('safeExec()\'s execSync call is wired with env: EXEC_ENV', () => {
    expect(SOURCE).toMatch(/function safeExec\([^)]*\)\s*\{[\s\S]*?execSync\(cmd,\s*\{[\s\S]*?env:\s*EXEC_ENV,[\s\S]*?\}\)/);
  });

  it('is a complete no-op off Android: the returned env carries no new keys', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/user' };
    const env = buildExecEnv({ androidDetected: false, env: base });
    expect(Object.keys(env).sort()).toEqual(Object.keys(base).sort());
    expect(env).toEqual(base);
  });

  it('backfills all four Android tzdata/ICU roots when /apex/com.android.tzdata exists', () => {
    const env = buildExecEnv({ androidDetected: true, env: { PATH: '/usr/bin' } });
    expect(env.ANDROID_ROOT).toBe('/system');
    expect(env.ANDROID_DATA).toBe('/data');
    expect(env.ANDROID_TZDATA_ROOT).toBe('/apex/com.android.tzdata');
    expect(env.ANDROID_I18N_ROOT).toBe('/apex/com.android.i18n');
    // Untouched pre-existing vars survive.
    expect(env.PATH).toBe('/usr/bin');
  });

  it('never overrides an already-correctly-configured ANDROID_TZDATA_ROOT (or the other three roots)', () => {
    const env = buildExecEnv({
      androidDetected: true,
      env: {
        PATH: '/usr/bin',
        ANDROID_TZDATA_ROOT: '/custom/tzdata',
        ANDROID_ROOT: '/custom/system',
        ANDROID_DATA: '/custom/data',
        ANDROID_I18N_ROOT: '/custom/i18n',
      },
    });
    expect(env.ANDROID_TZDATA_ROOT).toBe('/custom/tzdata');
    expect(env.ANDROID_ROOT).toBe('/custom/system');
    expect(env.ANDROID_DATA).toBe('/custom/data');
    expect(env.ANDROID_I18N_ROOT).toBe('/custom/i18n');
  });

  it('never overrides a single already-set var while still backfilling the rest', () => {
    // Partial ambient config: only ANDROID_TZDATA_ROOT is pre-set (e.g. a user's
    // own Termux profile). The other three should still be backfilled.
    const env = buildExecEnv({
      androidDetected: true,
      env: { PATH: '/usr/bin', ANDROID_TZDATA_ROOT: '/already/set' },
    });
    expect(env.ANDROID_TZDATA_ROOT).toBe('/already/set');
    expect(env.ANDROID_ROOT).toBe('/system');
    expect(env.ANDROID_DATA).toBe('/data');
    expect(env.ANDROID_I18N_ROOT).toBe('/apex/com.android.i18n');
  });
});

describe('issue #2897 — root .claude/helpers/statusline.cjs stays in sync', () => {
  it('the root copy carries the identical EXEC_ENV fix (repo convention: helper files are duplicated root + package and must match)', () => {
    const rootPath = path.resolve(HERE, '..', '..', '..', '..', '.claude', 'helpers', 'statusline.cjs');
    if (!fs.existsSync(rootPath)) return; // package tested in isolation outside the monorepo checkout
    const rootSource = fs.readFileSync(rootPath, 'utf-8');
    const rootMatch = rootSource.match(EXEC_ENV_BLOCK_RE);
    const pkgMatch = SOURCE.match(EXEC_ENV_BLOCK_RE);
    expect(rootMatch).not.toBeNull();
    // Normalize CRLF (root copy) vs LF (package copy) before comparing —
    // the two files intentionally use different line endings; the fix
    // itself must still be byte-identical modulo that.
    expect(rootMatch![0].replace(/\r\n/g, '\n')).toBe(pkgMatch![0].replace(/\r\n/g, '\n'));
  });
});
