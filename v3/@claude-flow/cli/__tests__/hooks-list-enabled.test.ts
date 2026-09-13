/**
 * Tests for hooks_list MCP tool reading .claude/settings.json
 * Regression tests for #1038
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('hooks_list reads .claude/settings.json (#1038)', () => {
  // Read the source to verify the fix at the source level
  const hooksToolsSource = fs.readFileSync(
    path.resolve(__dirname, '../src/mcp-tools/hooks-tools.ts'),
    'utf-8'
  );

  describe('Source-level verification', () => {
    it('reads settings.json to determine enabled hooks', () => {
      expect(hooksToolsSource).toContain('settings.json');
      expect(hooksToolsSource).toContain('configuredTypes');
    });

    it('does not return hardcoded enabled status', () => {
      // The old code had only { name, type, status: "active" } without any enabled field
      // The new code should have configuredTypes.has() to dynamically determine enabled
      expect(hooksToolsSource).toContain("configuredTypes.has(h.type)");
    });

    it('returns enabled field in hook objects', () => {
      expect(hooksToolsSource).toContain("enabled: configuredTypes.has(h.type)");
    });

    it('checks for PreToolUse hook type', () => {
      expect(hooksToolsSource).toContain("type: 'PreToolUse'");
    });

    it('checks for PostToolUse hook type', () => {
      expect(hooksToolsSource).toContain("type: 'PostToolUse'");
    });

    it('checks for SessionStart hook type', () => {
      expect(hooksToolsSource).toContain("type: 'SessionStart'");
    });

    it('checks for Stop hook type for session-end', () => {
      // session-end maps to the Claude Code 'Stop' hook type
      expect(hooksToolsSource).toContain("type: 'Stop'");
    });
  });

  describe('Handler behavior with settings.json', () => {
    let tmpDir: string;
    let origCwd: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-list-test-'));
      origCwd = process.cwd();
      // Create .claude directory
      fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    });

    afterEach(() => {
      process.chdir(origCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('shows hooks as enabled when their type is configured in settings.json', async () => {
      // Write a settings.json with PreToolUse and PostToolUse configured
      const settings = {
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre-bash' }] }
          ],
          PostToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo post-bash' }] }
          ]
        }
      };
      fs.writeFileSync(
        path.join(tmpDir, '.claude', 'settings.json'),
        JSON.stringify(settings)
      );

      // Temporarily set CLAUDE_FLOW_CWD to our temp dir
      const origEnv = process.env.CLAUDE_FLOW_CWD;
      process.env.CLAUDE_FLOW_CWD = tmpDir;

      try {
        // Dynamically import the hooks_list tool
        const mod = await import('../src/mcp-tools/hooks-tools.js');
        const result = await mod.hooksList.handler({});

        // PreToolUse hooks should be enabled
        const preEdit = result.hooks.find((h: any) => h.name === 'pre-edit');
        expect(preEdit).toBeDefined();
        expect(preEdit.enabled).toBe(true);
        expect(preEdit.status).toBe('active');

        // PostToolUse hooks should be enabled
        const postEdit = result.hooks.find((h: any) => h.name === 'post-edit');
        expect(postEdit).toBeDefined();
        expect(postEdit.enabled).toBe(true);

        // SessionStart hooks should NOT be enabled (not in settings)
        const sessionStart = result.hooks.find((h: any) => h.name === 'session-start');
        expect(sessionStart).toBeDefined();
        expect(sessionStart.enabled).toBe(false);
        expect(sessionStart.status).toBe('inactive');
      } finally {
        if (origEnv !== undefined) {
          process.env.CLAUDE_FLOW_CWD = origEnv;
        } else {
          delete process.env.CLAUDE_FLOW_CWD;
        }
      }
    });

    it('shows all hooks as disabled when no settings.json exists', async () => {
      // Point to a dir without settings.json
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-empty-'));
      const origEnv = process.env.CLAUDE_FLOW_CWD;
      process.env.CLAUDE_FLOW_CWD = emptyDir;

      try {
        const mod = await import('../src/mcp-tools/hooks-tools.js');
        const result = await mod.hooksList.handler({});

        // All hooks should be disabled
        for (const hook of result.hooks) {
          expect(hook.enabled).toBe(false);
        }
      } finally {
        if (origEnv !== undefined) {
          process.env.CLAUDE_FLOW_CWD = origEnv;
        } else {
          delete process.env.CLAUDE_FLOW_CWD;
        }
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('returns correct total count', async () => {
      const origEnv = process.env.CLAUDE_FLOW_CWD;
      process.env.CLAUDE_FLOW_CWD = tmpDir;

      try {
        const mod = await import('../src/mcp-tools/hooks-tools.js');
        const result = await mod.hooksList.handler({});
        expect(result.total).toBe(result.hooks.length);
        expect(result.total).toBeGreaterThanOrEqual(17);
      } finally {
        if (origEnv !== undefined) {
          process.env.CLAUDE_FLOW_CWD = origEnv;
        } else {
          delete process.env.CLAUDE_FLOW_CWD;
        }
      }
    });
  });
});
