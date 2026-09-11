/**
 * #2931: `security scan`'s hardcoded-secret regex for Stripe/OpenAI-shaped
 * keys (`sk-`/`sk_live_`/`sk_test_`) had two false-negative gaps:
 *
 * 1. Required 20+ chars after the prefix — missed shorter-but-real keys
 *    like `sk-1234567890abcdef` (16 chars).
 * 2. Required a quote literally adjacent to the prefix (`['"]sk-...['"]`)
 *    — missed the extremely common `Authorization: "Bearer sk_live_..."`
 *    shape, where the quote sits next to "Bearer", not the key.
 *
 * Fixed with lookaround boundaries instead of a length floor + quote
 * anchor, so the prefix matches as a standalone token wherever it
 * appears. Black-box against the real built CLI (same pattern as
 * security-scan-persistence.test.ts) — reconstructing CommandContext by
 * hand isn't done anywhere else in this repo's tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const CLI_BIN = fileURLToPath(new URL('../bin/cli.js', import.meta.url));

let scanTarget: string;

beforeEach(() => {
  scanTarget = mkdtempSync(join(tmpdir(), 'security-scan-secret-regex-'));
  writeFileSync(
    join(scanTarget, 'package.json'),
    JSON.stringify({ name: 'security-scan-secret-regex-fixture', version: '1.0.0' }),
  );
  writeFileSync(
    join(scanTarget, 'config.ts'),
    [
      "const API_KEY = 'sk-1234567890abcdef';",
      'const headers = { Authorization: "Bearer sk_live_51234567890abcdef" };',
    ].join('\n'),
  );
});

afterEach(() => {
  rmSync(scanTarget, { recursive: true, force: true });
});

describe('#2931 security scan catches shorter/embedded Stripe-shaped secrets', () => {
  it('flags both repro shapes as "API Key (Stripe/OpenAI)" findings', () => {
    // Finding real HIGH-severity secrets makes the command exit non-zero
    // (security.ts: `success: criticalCount === 0 && highCount === 0`) —
    // that's expected here, the persisted report is what this test checks.
    try {
      execFileSync(
        process.execPath,
        [CLI_BIN, 'security', 'scan', '--target', scanTarget, '--depth', 'standard', '--type', 'code', '--persist'],
        { encoding: 'utf-8', timeout: 30_000 },
      );
    } catch { /* non-zero exit expected when secrets are found */ }

    const outFile = join(scanTarget, '.claude', 'security-scans', 'scan-code-standard.json');
    expect(existsSync(outFile)).toBe(true);
    const record = JSON.parse(readFileSync(outFile, 'utf-8'));

    const stripeFindings = record.findings.filter(
      (f: { description: string }) => f.description === 'API Key (Stripe/OpenAI)',
    );
    // Pre-fix: 0 — neither line matched (one too short, one quote-detached).
    expect(stripeFindings.length).toBe(2);
  });
});
