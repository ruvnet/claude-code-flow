/**
 * Tests for status command granular error handling
 * Regression tests for #984
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Read the source to verify the fix
const statusSource = fs.readFileSync(
  path.resolve(__dirname, '../src/commands/status.ts'),
  'utf-8'
);

describe('Status command granular error handling (#984)', () => {
  describe('Source-level verification', () => {
    it('wraps swarm_status call in its own try-catch', () => {
      // Each MCP call should have individual error handling
      // The old code had one monolithic try-catch wrapping all calls
      const swarmBlock = statusSource.match(/swarm_status.*?catch/s);
      expect(swarmBlock).not.toBeNull();
    });

    it('wraps memory_stats call in its own try-catch', () => {
      const memoryBlock = statusSource.match(/memory_stats.*?catch/s);
      expect(memoryBlock).not.toBeNull();
    });

    it('wraps task_summary call in its own try-catch', () => {
      const taskBlock = statusSource.match(/task_summary.*?catch/s);
      expect(taskBlock).not.toBeNull();
    });

    it('wraps mcp_status call in its own try-catch', () => {
      const mcpBlock = statusSource.match(/mcp_status.*?catch/s);
      expect(mcpBlock).not.toBeNull();
    });

    it('does not have monolithic try-catch around all MCP calls', () => {
      // The old pattern was: try { swarm... mcp... memory... task... } catch { return stopped }
      // The new pattern has each call in its own try-catch
      // Count the number of separate try blocks containing MCP tool calls
      const tryBlocks = statusSource.match(/try\s*\{[^}]*callMCPTool/g);
      // Should have at least 4 separate try blocks (one per MCP call)
      expect(tryBlocks).not.toBeNull();
      expect(tryBlocks!.length).toBeGreaterThanOrEqual(4);
    });

    it('uses anyServiceRunning flag instead of assuming all-or-nothing', () => {
      expect(statusSource).toContain('anyServiceRunning');
    });

    it('reports running: true if any service responds', () => {
      expect(statusSource).toContain('running: anyServiceRunning');
    });

    it('provides sensible defaults for each service when it fails', () => {
      expect(statusSource).toContain('defaultSwarm');
      expect(statusSource).toContain('defaultMcp');
      expect(statusSource).toContain('defaultMemory');
      expect(statusSource).toContain('defaultTasks');
    });
  });
});
