/**
 * Regression coverage for #2946: optional packages installed in a project
 * must remain resolvable when Ruflo itself runs from npx's isolated cache.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { importProjectLocalPackage } from '../src/mcp-tools/auto-install.js';

const originalCwd = process.cwd();
const originalClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
let projectDir: string;

describe('project-local optional package resolution (#2946)', () => {
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'ruflo-project-package-'));
    const packageDir = join(projectDir, 'node_modules', 'ruflo-test-optional');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: 'ruflo-test-optional', version: '1.0.0', type: 'module', exports: './index.js' }),
    );
    writeFileSync(join(packageDir, 'index.js'), 'export const source = "project-local";\n');
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalClaudeProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalClaudeProjectDir;
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('loads from cwd/node_modules instead of the importing module location', async () => {
    const module = await importProjectLocalPackage<{ source: string }>('ruflo-test-optional');
    expect(module?.source).toBe('project-local');
  });

  it('uses the explicit Claude project root when the MCP process cwd differs', async () => {
    const launchDir = mkdtempSync(join(tmpdir(), 'ruflo-mcp-launch-'));
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    process.chdir(launchDir);
    try {
      const module = await importProjectLocalPackage<{ source: string }>('ruflo-test-optional');
      expect(module?.source).toBe('project-local');
    } finally {
      process.chdir(originalCwd);
      rmSync(launchDir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid package specifier without resolving it', async () => {
    expect(await importProjectLocalPackage('../outside')).toBeNull();
  });
});
