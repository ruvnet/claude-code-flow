/**
 * Tests for the pre-import version fast-path (#2256 / #2561).
 *
 * The `isVersionFastPath` predicate is duplicated inline in
 *   - v3/@claude-flow/cli/bin/cli.js
 *   - ruflo/bin/ruflo.js
 * because it must run before any dist import. This suite is the reference
 * contract those inline copies pledge to match.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { isVersionFastPath } from '../src/cli-fast-paths.js';

describe('isVersionFastPath (unit)', () => {
  it('matches bare --version', () => {
    expect(isVersionFastPath(['--version'])).toBe(true);
  });

  it('matches bare -V', () => {
    expect(isVersionFastPath(['-V'])).toBe(true);
  });

  it('matches --version with a trailing presentation flag (regression #2561)', () => {
    // The pre-#2561 single-arg guard missed this and fell through to the
    // full dist import, timing out the verification harness.
    expect(isVersionFastPath(['--version', '--no-color'])).toBe(true);
  });

  it('matches --version with a leading presentation flag', () => {
    expect(isVersionFastPath(['--no-color', '--version'])).toBe(true);
  });

  it('matches --version with --quiet', () => {
    expect(isVersionFastPath(['--version', '--quiet'])).toBe(true);
  });

  it('matches -V with --format=json', () => {
    expect(isVersionFastPath(['-V', '--format=json'])).toBe(true);
  });

  it('does not match empty argv', () => {
    expect(isVersionFastPath([])).toBe(false);
  });

  it('does not match unrelated flags', () => {
    expect(isVersionFastPath(['--help'])).toBe(false);
    expect(isVersionFastPath(['-v'])).toBe(false); // lowercase -v is --verbose, not version
  });

  it('does not match when a command name precedes the flag', () => {
    // `ruflo memory --version` should be handled by the command's own parser,
    // not the top-level version fast path.
    expect(isVersionFastPath(['memory', '--version'])).toBe(false);
    expect(isVersionFastPath(['agent', 'spawn', '--version'])).toBe(false);
  });

  it('does not match a --version that comes after `--`', () => {
    // POSIX end-of-flags separator turns everything after into positionals.
    expect(isVersionFastPath(['--', '--version'])).toBe(false);
  });
});

describe('bin/cli.js --version fast path (integration, #2561)', () => {
  const binPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'bin',
    'cli.js'
  );
  // 3 s is 10× the observed cold-start floor (~120 ms) but well under both
  // the npx default (~30 s) and the MCP stdio window (30 s). If we cannot
  // complete `--version` inside this budget, the fast path is broken.
  const BUDGET_MS = 3000;

  const runBin = (args: string[]) => {
    const start = Date.now();
    const res = spawnSync(process.execPath, [binPath, ...args], {
      encoding: 'utf8',
      timeout: BUDGET_MS,
      // Ensure stdin is NOT piped so the MCP auto-detect path is skipped.
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    return { ...res, elapsedMs: Date.now() - start };
  };

  it('exits 0 with version output for --version alone', () => {
    const res = runBin(['--version']);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/ruflo v\d+\.\d+\.\d+/);
    expect(res.elapsedMs).toBeLessThan(BUDGET_MS);
  });

  it('exits 0 with version output for -V alone', () => {
    const res = runBin(['-V']);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/ruflo v\d+\.\d+\.\d+/);
    expect(res.elapsedMs).toBeLessThan(BUDGET_MS);
  });

  it('regression #2561: --version --no-color still fast-paths (no dist import)', () => {
    // Before the fix, this argv shape bypassed the single-arg guard and
    // fell through to `import('../dist/src/index.js')`, which pulls in
    // ruvector's ONNX loader and can block 60 s+ on cold cache. The
    // clearest positive signal that we did NOT take that path: no dist
    // resolution error is printed to stderr in a repo where dist is not
    // built, and the whole invocation finishes inside the tight budget.
    const res = runBin(['--version', '--no-color']);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/ruflo v\d+\.\d+\.\d+/);
    expect(res.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(res.stderr).not.toMatch(/dist[\\/]src[\\/]index\.js/);
    expect(res.elapsedMs).toBeLessThan(BUDGET_MS);
  });

  it('regression #2561: --no-color --version (flag-before-version) also fast-paths', () => {
    const res = runBin(['--no-color', '--version']);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/ruflo v\d+\.\d+\.\d+/);
    expect(res.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(res.elapsedMs).toBeLessThan(BUDGET_MS);
  });
});
