import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const CLI_BIN = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
let scanTarget: string;

beforeEach(() => {
  scanTarget = mkdtempSync(join(tmpdir(), 'security-scan-formats-'));
  writeFileSync(join(scanTarget, 'unsafe.ts'), 'export const value = eval(userInput);\n');
});

afterEach(() => rmSync(scanTarget, { recursive: true, force: true }));

function scan(format: 'text' | 'json' | 'sarif') {
  return spawnSync(process.execPath, [
    CLI_BIN, 'security', 'scan', '--target', scanTarget,
    '--depth', 'standard', '--type', 'code', '--output', format,
  ], { encoding: 'utf8', timeout: 30_000 });
}

describe('security scan output formats', () => {
  it('emits human-readable text only in text mode', () => {
    const result = scan('text');
    expect(result.stdout).toContain('Security Scan');
    expect(result.stdout).toContain('Total Issues: 1');
  });

  it('emits one machine-consumable scan record in json mode', () => {
    const result = scan('json');
    const record = JSON.parse(result.stdout);
    expect(record.summary.total).toBe(1);
    expect(record.findings[0]).toMatchObject({ severity: 'medium', type: 'Eval Usage' });
    expect(result.stdout).not.toContain('Security Scan');
  });

  it('emits SARIF 2.1.0 with rule IDs, levels, and source locations', () => {
    const result = scan('sarif');
    const sarif = JSON.parse(result.stdout);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results[0]).toMatchObject({
      ruleId: 'eval-usage',
      level: 'warning',
      locations: [{ physicalLocation: { region: { startLine: 1 } } }],
    });
    expect(sarif.summary).toBeUndefined();
  });
});
