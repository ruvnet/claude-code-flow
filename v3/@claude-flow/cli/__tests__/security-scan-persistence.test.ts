/**
 * `security scan` persists its result (commit 7cf3b1084) so the statusline's
 * getSecurityStatus (funnel/local-signals.ts) can reflect real scan state
 * instead of being permanently stuck at PENDING/0 no matter how many real
 * scans run. Black-box against the real built CLI binary — the same
 * invocation shape used to manually verify this feature — rather than
 * reconstructing CommandContext by hand (no existing test in this repo does
 * that for any command; the CLI-binary route is the well-trodden path).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { getSecurityStatus } from '../src/funnel/local-signals.js';

const CLI_BIN = fileURLToPath(new URL('../bin/cli.js', import.meta.url));

let scanTarget: string;

beforeEach(() => {
  // A tiny, throwaway target with no real vulnerabilities and no source
  // files to pattern-scan — keeps the real `npm audit` + secret/code scan
  // fast and deterministic instead of running against this whole repo.
  scanTarget = mkdtempSync(join(tmpdir(), 'security-scan-persist-'));
  writeFileSync(
    join(scanTarget, 'package.json'),
    JSON.stringify({ name: 'security-scan-persist-fixture', version: '1.0.0' }),
  );
});

afterEach(() => {
  rmSync(scanTarget, { recursive: true, force: true });
});

describe('security scan — result persistence (statusline CVE counter wiring)', () => {
  it('getSecurityStatus is PENDING/0 before any scan has run', () => {
    const before = getSecurityStatus(scanTarget);
    expect(before.status).toBe('PENDING');
    expect(before.cvesFixed).toBe(0);
  });

  it('is read-only by default', () => {
    execFileSync(
      process.execPath,
      [CLI_BIN, 'security', 'scan', '--target', scanTarget, '--depth', 'quick', '--type', 'deps'],
      { encoding: 'utf-8', timeout: 30_000 },
    );
    expect(existsSync(join(scanTarget, '.claude'))).toBe(false);
    expect(getSecurityStatus(scanTarget).status).toBe('PENDING');
  }, 30_000);

  it('writes .claude/security-scans/scan-<type>-<depth>.json with --persist', () => {
    execFileSync(
      process.execPath,
      [CLI_BIN, 'security', 'scan', '--target', scanTarget, '--depth', 'quick', '--type', 'deps', '--persist'],
      { encoding: 'utf-8', timeout: 30_000 },
    );
    const outFile = join(scanTarget, '.claude', 'security-scans', 'scan-deps-quick.json');
    expect(existsSync(outFile)).toBe(true);
    const record = JSON.parse(readFileSync(outFile, 'utf-8'));
    expect(record.target).toBe(scanTarget);
    expect(record.depth).toBe('quick');
    expect(record.type).toBe('deps');
    expect(typeof record.timestamp).toBe('string');
    expect(record.summary).toMatchObject({
      critical: expect.any(Number),
      high: expect.any(Number),
      medium: expect.any(Number),
      low: expect.any(Number),
      total: expect.any(Number),
    });
  }, 30_000);

  it('getSecurityStatus reflects the real scan afterward — CLEAN when 0 findings', () => {
    // The scan target is an empty fixture (no deps, no source) so it has 0
    // findings. Pre-#2694 this returned cvesFixed>=1 because the old code
    // counted scan *files* as fixed CVEs; now it reads the scan's findings.
    execFileSync(
      process.execPath,
      [CLI_BIN, 'security', 'scan', '--target', scanTarget, '--depth', 'quick', '--type', 'deps', '--persist'],
      { encoding: 'utf-8', timeout: 30_000 },
    );
    const after = getSecurityStatus(scanTarget);
    expect(after.cvesFixed).toBe(0);
    expect(after.totalCves).toBe(0);
    expect(after.status).toBe('CLEAN');
  }, 30_000);

  it('repeated scans overwrite the deterministic filename rather than accumulate', () => {
    for (let i = 0; i < 3; i++) {
      execFileSync(
        process.execPath,
        [CLI_BIN, 'security', 'scan', '--target', scanTarget, '--depth', 'quick', '--type', 'deps', '--persist'],
        { encoding: 'utf-8', timeout: 30_000 },
      );
    }
    const scanDir = join(scanTarget, '.claude', 'security-scans');
    const files = readdirSync(scanDir).filter((f: string) => f.endsWith('.json'));
    expect(files).toEqual(['scan-deps-quick.json']);
  }, 60_000);
});
