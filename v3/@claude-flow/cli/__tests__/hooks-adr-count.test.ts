/**
 * Regression tests for #1047: Statusline ADR count hardcoded to 0/0
 *
 * The statusline displayed `ADRs ●0/0` but the count was never computed.
 * Fix: scan well-known ADR directories and count ADR markdown files.
 *
 * Tests verify:
 * 1. ADR scanning counts files in expected directories
 * 2. Only files matching ADR naming conventions are counted
 * 3. Accepted/Implemented status detection works
 * 4. Source guard: hardcoded ●0/0 is no longer in hooks.ts
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Helper to simulate ADR counting logic (mirrors the fix in hooks.ts)
function countADRs(cwd: string): { count: number; implemented: number } {
  const fs = require('fs');
  const path = require('path');

  const adrStats = { count: 0, implemented: 0 };
  const adrPaths = [
    path.join(cwd, 'v3', 'implementation', 'adrs'),
    path.join(cwd, 'docs', 'adrs'),
    path.join(cwd, 'docs', 'adr'),
    path.join(cwd, '.claude-flow', 'adrs'),
  ];

  for (const adrPath of adrPaths) {
    try {
      if (fs.existsSync(adrPath)) {
        const files = fs.readdirSync(adrPath).filter((f: string) =>
          f.endsWith('.md') && (f.startsWith('ADR-') || f.startsWith('adr-') || /^\d{4}-/.test(f))
        );
        adrStats.count = files.length;
        for (const file of files) {
          try {
            const content = fs.readFileSync(path.join(adrPath, file), 'utf-8');
            if (/Status\s*[:\*]*\s*(Accepted|Implemented)/i.test(content)) {
              adrStats.implemented++;
            }
          } catch { /* ignore */ }
        }
        if (adrStats.count === 0) continue;
        break;
      }
    } catch { /* ignore */ }
  }

  return adrStats;
}

describe('ADR count in hooks statusline (#1047)', () => {
  let tmpDir: string;

  it('returns 0/0 when no ADR directory exists', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'adr-test-'));
    try {
      const result = countADRs(tmpDir);
      expect(result.count).toBe(0);
      expect(result.implemented).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('counts ADR files in docs/adrs directory', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'adr-test-'));
    const adrDir = join(tmpDir, 'docs', 'adrs');
    mkdirSync(adrDir, { recursive: true });
    writeFileSync(join(adrDir, 'ADR-001-use-typescript.md'), '# ADR-001\n\nStatus: Proposed\n\nBody here.');
    writeFileSync(join(adrDir, 'ADR-002-use-vitest.md'), '# ADR-002\n\nStatus: Accepted\n\nBody here.');
    writeFileSync(join(adrDir, 'ADR-003-memory-backend.md'), '# ADR-003\n\nStatus: Implemented\n\nBody here.');
    writeFileSync(join(adrDir, 'README.md'), '# ADR Index'); // should not count

    try {
      const result = countADRs(tmpDir);
      expect(result.count).toBe(3);        // 3 ADR- files, not README
      expect(result.implemented).toBe(2);  // ADR-002 (Accepted) + ADR-003 (Implemented)
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('counts ADRs with bold markdown Status: **Accepted**', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'adr-test-'));
    const adrDir = join(tmpDir, 'docs', 'adrs');
    mkdirSync(adrDir, { recursive: true });
    writeFileSync(join(adrDir, 'ADR-010-bold-status.md'), '# ADR-010\n\n**Status**: Accepted\n\nBody.');

    try {
      const result = countADRs(tmpDir);
      expect(result.count).toBe(1);
      expect(result.implemented).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('counts numeric-prefixed ADR files (e.g. 0001-use-postgres.md)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'adr-test-'));
    const adrDir = join(tmpDir, 'docs', 'adrs');
    mkdirSync(adrDir, { recursive: true });
    writeFileSync(join(adrDir, '0001-use-postgres.md'), '# ADR\n\nStatus: Accepted\n');
    writeFileSync(join(adrDir, '0002-use-redis.md'), '# ADR\n\nStatus: Proposed\n');

    try {
      const result = countADRs(tmpDir);
      expect(result.count).toBe(2);
      expect(result.implemented).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});

// ============================================================================
// Source guard: the hardcoded ●0/0 must be gone from hooks.ts
// ============================================================================
describe('hooks.ts source guard (#1047)', () => {
  it('must not contain hardcoded ADR count ●0/0', async () => {
    const { readFileSync } = await import('fs');
    const source = readFileSync(
      new URL('../src/commands/hooks.ts', import.meta.url),
      'utf-8'
    );

    // The literal hardcoded string that caused the bug must be gone
    expect(source).not.toContain('●0/0');

    // The dynamic ADR counting must be present
    expect(source).toContain('adrStats');
    expect(source).toContain('adrPaths');
  });
});
