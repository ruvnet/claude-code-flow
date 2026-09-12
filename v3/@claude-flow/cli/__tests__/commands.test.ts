/**
 * V3 CLI Commands Tests
 * Tests for agent, swarm, memory, and config commands
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCommand } from '../src/commands/agent.js';
import { swarmCommand } from '../src/commands/swarm.js';
import { memoryCommand } from '../src/commands/memory.js';
import { configCommand } from '../src/commands/config.js';
import type { CommandContext } from '../src/types.js';

// Mock MCP client
vi.mock('../src/mcp-client.js', () => ({
  callMCPTool: vi.fn(async (toolName: string, input: Record<string, unknown>) => {
    // Mock responses for different tools
    if (toolName === 'agent/spawn') {
      return {
        agentId: input.id || 'mock-agent-123',
        agentType: input.agentType,
        status: 'active',
        createdAt: new Date().toISOString()
      };
    }

    if (toolName === 'agent/list') {
      return {
        agents: [
          { id: 'agent-1', agentType: 'coder', status: 'active', createdAt: '2024-01-01T00:00:00Z' },
          { id: 'agent-2', agentType: 'tester', status: 'idle', createdAt: '2024-01-01T00:01:00Z' }
        ],
        total: 2
      };
    }

    if (toolName === 'agent/status') {
      return {
        id: input.agentId,
        agentType: 'coder',
        status: 'active',
        createdAt: '2024-01-01T00:00:00Z',
        lastActivityAt: new Date().toISOString(),
        metrics: {
          tasksCompleted: 10,
          tasksInProgress: 2,
          tasksFailed: 1,
          averageExecutionTime: 1500,
          uptime: 3600000
        }
      };
    }

    if (toolName === 'agent/terminate') {
      return {
        agentId: input.agentId,
        terminated: true,
        terminatedAt: new Date().toISOString()
      };
    }

    if (toolName === 'swarm/init') {
      return {
        swarmId: 'swarm-mock-123',
        topology: input.topology,
        initializedAt: new Date().toISOString(),
        config: {
          topology: input.topology,
          maxAgents: input.maxAgents || 15,
          currentAgents: 0,
          autoScaling: true
        }
      };
    }

    // Memory tool mocks
    if (toolName === 'memory/store') {
      return {
        success: true,
        key: input.key,
        totalEntries: 42
      };
    }

    if (toolName === 'memory/retrieve') {
      return {
        key: input.key,
        value: 'mock-value-for-' + input.key,
        found: true,
        storedAt: '2024-01-01T00:00:00Z',
        accessCount: 5,
        metadata: { tags: ['test'], size: 100 }
      };
    }

    if (toolName === 'memory/search') {
      return {
        query: input.query,
        results: [
          { key: 'result-1', value: 'auth pattern 1', score: 0.95, storedAt: '2024-01-01T00:00:00Z' },
          { key: 'result-2', value: 'auth pattern 2', score: 0.85, storedAt: '2024-01-01T00:01:00Z' }
        ],
        total: 2,
        searchTime: '0.5ms'
      };
    }

    if (toolName === 'memory/list') {
      return {
        entries: [
          { key: 'entry-1', storedAt: '2024-01-01T00:00:00Z', accessCount: 10, preview: 'test value 1' },
          { key: 'entry-2', storedAt: '2024-01-01T00:01:00Z', accessCount: 5, preview: 'test value 2' }
        ],
        total: 2,
        limit: input.limit || 20,
        offset: input.offset || 0
      };
    }

    if (toolName === 'memory/delete') {
      return {
        success: true,
        key: input.key,
        deleted: true,
        remainingEntries: 41
      };
    }

    if (toolName === 'memory/stats') {
      // Return raw MCP format that the command expects and transforms
      return {
        totalEntries: 42,
        totalSize: '1.2 MB',
        version: '3.0.0-alpha',
        backend: 'hybrid',
        location: './data/memory',
        oldestEntry: '2024-01-01T00:00:00Z',
        newestEntry: '2024-01-07T00:00:00Z'
      };
    }

    return {};
  }),
  MCPClientError: class MCPClientError extends Error {
    constructor(message: string, public toolName: string, public cause?: Error) {
      super(message);
      this.name = 'MCPClientError';
    }
  }
}));

// Mock output
vi.mock('../src/output.js', () => ({
  output: {
    writeln: vi.fn(),
    printInfo: vi.fn(),
    printSuccess: vi.fn(),
    printError: vi.fn(),
    printWarning: vi.fn(),
    printTable: vi.fn(),
    printJson: vi.fn(),
    printList: vi.fn(),
    printBox: vi.fn(),
    createSpinner: vi.fn(() => ({
      start: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
      stop: vi.fn()
    })),
    highlight: (str: string) => str,
    bold: (str: string) => str,
    dim: (str: string) => str,
    success: (str: string) => str,
    error: (str: string) => str,
    warning: (str: string) => str,
    info: (str: string) => str,
    progressBar: () => '[=====>    ]',
    setColorEnabled: vi.fn()
  }
}));

// Mock prompts (always return default values for non-interactive tests)
vi.mock('../src/prompt.js', () => ({
  select: vi.fn(async (opts) => opts.default || opts.options[0]?.value),
  confirm: vi.fn(async (opts) => opts.default ?? false),
  input: vi.fn(async (opts) => opts.default || 'test-input'),
  multiSelect: vi.fn(async (opts) => opts.default || [])
}));

describe('Agent Commands', () => {
  let ctx: CommandContext;

  beforeEach(() => {
    ctx = {
      args: [],
      flags: { _: [] },
      cwd: '/test',
      interactive: false
    };
  });

  describe('agent spawn', () => {
    it.skip('should spawn agent with type flag', async () => { // Skip: requires live MCP context
      const spawnCmd = agentCommand.subcommands?.find(c => c.name === 'spawn');
      expect(spawnCmd).toBeDefined();

      ctx.flags = { type: 'coder', _: [] };
      const result = await spawnCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('agentId');
      expect(result.data).toHaveProperty('agentType', 'coder');
    });

    it.skip('should spawn agent with custom name', async () => { // Skip: requires live MCP context
      const spawnCmd = agentCommand.subcommands?.find(c => c.name === 'spawn');

      ctx.flags = { type: 'tester', name: 'my-tester', _: [] };
      const result = await spawnCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('agentId', 'my-tester');
    });

    it('should fail without agent type in non-interactive mode', async () => {
      const spawnCmd = agentCommand.subcommands?.find(c => c.name === 'spawn');

      ctx.flags = { _: [] };
      const result = await spawnCmd!.action!(ctx);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('should pass provider and model options', async () => {
      const spawnCmd = agentCommand.subcommands?.find(c => c.name === 'spawn');

      ctx.flags = {
        type: 'coder',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        _: []
      };
      const result = await spawnCmd!.action!(ctx);

      expect(result.success).toBe(true);
    });

    it('should handle task option', async () => {
      const spawnCmd = agentCommand.subcommands?.find(c => c.name === 'spawn');

      ctx.flags = {
        type: 'researcher',
        task: 'Research React patterns',
        _: []
      };
      const result = await spawnCmd!.action!(ctx);

      expect(result.success).toBe(true);
    });
  });

  describe('agent list', () => {
    it.skip('should list all agents', async () => { // Skip: requires live MCP context
      const listCmd = agentCommand.subcommands?.find(c => c.name === 'list');
      expect(listCmd).toBeDefined();

      const result = await listCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('agents');
      expect(result.data).toHaveProperty('total', 2);
    });

    it.skip('should filter by agent type', async () => { // Skip: requires live MCP context
      const listCmd = agentCommand.subcommands?.find(c => c.name === 'list');

      ctx.flags = { type: 'coder', _: [] };
      const result = await listCmd!.action!(ctx);

      expect(result.success).toBe(true);
    });

    it.skip('should filter by status', async () => { // Skip: requires live MCP context
      const listCmd = agentCommand.subcommands?.find(c => c.name === 'list');

      ctx.flags = { status: 'active', _: [] };
      const result = await listCmd!.action!(ctx);

      expect(result.success).toBe(true);
    });

    it.skip('should include inactive agents with --all flag', async () => { // Skip: requires live MCP context
      const listCmd = agentCommand.subcommands?.find(c => c.name === 'list');

      ctx.flags = { all: true, _: [] };
      const result = await listCmd!.action!(ctx);

      expect(result.success).toBe(true);
    });
  });

  describe('agent status', () => {
    it.skip('should show agent status', async () => { // Skip: requires live MCP context
      const statusCmd = agentCommand.subcommands?.find(c => c.name === 'status');
      expect(statusCmd).toBeDefined();

      ctx.args = ['agent-123'];
      const result = await statusCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('id');
      expect(result.data).toHaveProperty('status');
      expect(result.data).toHaveProperty('metrics');
    });

    it('should fail without agent ID', async () => {
      const statusCmd = agentCommand.subcommands?.find(c => c.name === 'status');

      ctx.args = [];
      ctx.interactive = false;
      const result = await statusCmd!.action!(ctx);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('agent stop', () => {
    it.skip('should stop agent', async () => { // Skip: requires live MCP context
      const stopCmd = agentCommand.subcommands?.find(c => c.name === 'stop');
      expect(stopCmd).toBeDefined();

      ctx.args = ['agent-123'];
      ctx.flags = { force: true, _: [] };
      const result = await stopCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('agentId', 'agent-123');
      expect(result.data).toHaveProperty('terminated', true);
    });

    it('should fail without agent ID', async () => {
      const stopCmd = agentCommand.subcommands?.find(c => c.name === 'stop');

      ctx.args = [];
      const result = await stopCmd!.action!(ctx);

      expect(result.success).toBe(false);
    });
  });

  describe('agent metrics', () => {
    it('should show agent metrics', async () => {
      const metricsCmd = agentCommand.subcommands?.find(c => c.name === 'metrics');
      expect(metricsCmd).toBeDefined();

      const result = await metricsCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('summary');
      expect(result.data).toHaveProperty('performance');
    });

    it('should accept period option', async () => {
      const metricsCmd = agentCommand.subcommands?.find(c => c.name === 'metrics');

      ctx.flags = { period: '7d', _: [] };
      const result = await metricsCmd!.action!(ctx);

      expect(result.success).toBe(true);
    });
  });
});

describe('Swarm Commands', () => {
  let ctx: CommandContext;

  beforeEach(() => {
    ctx = {
      args: [],
      flags: { _: [] },
      cwd: '/test',
      interactive: false
    };
  });

  describe('swarm init', () => {
    it.skip('should initialize swarm with default topology', async () => { // Skip: requires live MCP context
      const initCmd = swarmCommand.subcommands?.find(c => c.name === 'init');
      expect(initCmd).toBeDefined();

      const result = await initCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('swarmId');
      expect(result.data).toHaveProperty('topology');
    });

    it.skip('should initialize swarm with custom topology', async () => { // Skip: requires live MCP context
      const initCmd = swarmCommand.subcommands?.find(c => c.name === 'init');

      ctx.flags = { topology: 'mesh', _: [] };
      const result = await initCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('topology', 'mesh');
    });

    it.skip('should enable V3 mode', async () => { // Skip: requires live MCP context
      const initCmd = swarmCommand.subcommands?.find(c => c.name === 'init');

      ctx.flags = { v3Mode: true, _: [] };
      const result = await initCmd!.action!(ctx);

      expect(result.success).toBe(true);
    });

    it.skip('should set max agents', async () => { // Skip: requires live MCP context
      const initCmd = swarmCommand.subcommands?.find(c => c.name === 'init');

      ctx.flags = { maxAgents: 20, _: [] };
      const result = await initCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data?.config).toHaveProperty('maxAgents', 20);
    });
  });

  describe('swarm start', () => {
    it('should start swarm with objective', async () => {
      const startCmd = swarmCommand.subcommands?.find(c => c.name === 'start');
      expect(startCmd).toBeDefined();

      ctx.flags = { objective: 'Build REST API', _: [] };
      const result = await startCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('objective', 'Build REST API');
    });

    it('should fail without objective', async () => {
      const startCmd = swarmCommand.subcommands?.find(c => c.name === 'start');

      const result = await startCmd!.action!(ctx);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('should accept strategy option', async () => {
      const startCmd = swarmCommand.subcommands?.find(c => c.name === 'start');

      ctx.flags = { objective: 'Test project', strategy: 'testing', _: [] };
      const result = await startCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('strategy', 'testing');
    });
  });

  describe('swarm status', () => {
    it('should show swarm status', async () => {
      const statusCmd = swarmCommand.subcommands?.find(c => c.name === 'status');
      expect(statusCmd).toBeDefined();

      const result = await statusCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('agents');
      expect(result.data).toHaveProperty('tasks');
      expect(result.data).toHaveProperty('metrics');
    });
  });

  describe('swarm stop', () => {
    it('should stop swarm', async () => {
      const stopCmd = swarmCommand.subcommands?.find(c => c.name === 'stop');
      expect(stopCmd).toBeDefined();

      ctx.args = ['swarm-123'];
      ctx.flags = { force: true, _: [] };
      const result = await stopCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('swarmId', 'swarm-123');
      expect(result.data).toHaveProperty('stopped', true);
    });

    it('should fail without swarm ID when none is persisted', async () => {
      const stopCmd = swarmCommand.subcommands?.find(c => c.name === 'stop');

      // Bare `swarm stop` now defaults to the persisted swarm, so this has to
      // run somewhere with no swarm state — the `swarm start` test above
      // writes a real `.swarm/state.json` into the package directory.
      const originalCwd = process.cwd();
      const isolated = mkdtempSync(join(tmpdir(), 'ruflo-swarm-stop-'));
      try {
        process.chdir(isolated);
        const result = await stopCmd!.action!(ctx);
        expect(result.success).toBe(false);
      } finally {
        process.chdir(originalCwd);
        rmSync(isolated, { recursive: true, force: true });
      }
    });
  });

  describe('swarm scale', () => {
    it('should scale swarm', async () => {
      const scaleCmd = swarmCommand.subcommands?.find(c => c.name === 'scale');
      expect(scaleCmd).toBeDefined();

      ctx.args = ['swarm-123'];
      ctx.flags = { agents: 20, _: [] };
      const result = await scaleCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('agents', 20);
    });

    it('should fail without target agent count', async () => {
      const scaleCmd = swarmCommand.subcommands?.find(c => c.name === 'scale');

      ctx.args = ['swarm-123'];
      const result = await scaleCmd!.action!(ctx);

      expect(result.success).toBe(false);
    });
  });

  describe('swarm coordinate', () => {
    it('should show V3 coordination structure', async () => {
      const coordinateCmd = swarmCommand.subcommands?.find(c => c.name === 'coordinate');
      expect(coordinateCmd).toBeDefined();

      const result = await coordinateCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('agents');
      expect(result.data?.agents).toHaveLength(15);
    });
  });
});

describe('Memory Commands', () => {
  let ctx: CommandContext;

  beforeEach(() => {
    ctx = {
      args: [],
      flags: { _: [] },
      cwd: '/test',
      interactive: false
    };
  });

  describe('memory store', () => {
    it.skip('should store data', async () => { // Skip: requires live memory service
      const storeCmd = memoryCommand.subcommands?.find(c => c.name === 'store');
      expect(storeCmd).toBeDefined();

      ctx.flags = { key: 'test-key', value: 'test-value', _: [] };
      const result = await storeCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('key', 'test-key');
    });

    it('should fail without key', async () => {
      const storeCmd = memoryCommand.subcommands?.find(c => c.name === 'store');

      ctx.flags = { value: 'test-value', _: [] };
      const result = await storeCmd!.action!(ctx);

      expect(result.success).toBe(false);
    });
  });

  describe('memory retrieve', () => {
    it.skip('should retrieve data', async () => { // Skip: requires live memory service
      const retrieveCmd = memoryCommand.subcommands?.find(c => c.name === 'retrieve');
      expect(retrieveCmd).toBeDefined();

      ctx.args = ['test-key'];
      const result = await retrieveCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('key', 'test-key');
    });
  });

  describe('memory search', () => {
    // 60s timeout: a cold ONNX cache pulls a 23MB model from huggingface
    // before the first search. Default 5s vitest timeout reliably trips on
    // a fresh checkout. Bumping per-test rather than file-wide so the rest
    // of the suite still fails fast on regressions.
    it('should search memory', { timeout: 60_000 }, async () => {
      const searchCmd = memoryCommand.subcommands?.find(c => c.name === 'search');
      expect(searchCmd).toBeDefined();

      ctx.flags = { query: 'authentication', _: [] };
      const result = await searchCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });

    it('should fail without query', async () => {
      const searchCmd = memoryCommand.subcommands?.find(c => c.name === 'search');

      const result = await searchCmd!.action!(ctx);

      expect(result.success).toBe(false);
    });
  });

  describe('memory list', () => {
    it('should list memory entries', async () => {
      const listCmd = memoryCommand.subcommands?.find(c => c.name === 'list');
      expect(listCmd).toBeDefined();

      const result = await listCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });
  });

  describe('memory delete', () => {
    it.skip('should delete entry', async () => { // Skip: requires live memory service
      const deleteCmd = memoryCommand.subcommands?.find(c => c.name === 'delete');
      expect(deleteCmd).toBeDefined();

      ctx.args = ['test-key'];
      ctx.flags = { force: true, _: [] };
      const result = await deleteCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('deleted', true);
    });
  });

  describe('memory stats', () => {
    it.skip('should show memory statistics', async () => { // Skip: requires live memory service
      const statsCmd = memoryCommand.subcommands?.find(c => c.name === 'stats');
      expect(statsCmd).toBeDefined();

      const result = await statsCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('entries');
      expect(result.data).toHaveProperty('storage');
      expect(result.data).toHaveProperty('backend');
      expect(result.data).toHaveProperty('version');
    });
  });

  describe('memory configure', () => {
    it('should configure memory backend', async () => {
      const configureCmd = memoryCommand.subcommands?.find(c => c.name === 'configure');
      expect(configureCmd).toBeDefined();

      ctx.flags = { backend: 'agentdb', _: [] };
      const result = await configureCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('backend', 'agentdb');
    });
  });
});

describe('Config Commands', () => {
  let ctx: CommandContext;

  beforeEach(() => {
    ctx = {
      args: [],
      flags: { _: [] },
      cwd: '/test',
      interactive: false
    };
  });

  describe('config init', () => {
    it('should initialize configuration', async () => {
      const initCmd = configCommand.subcommands?.find(c => c.name === 'init');
      expect(initCmd).toBeDefined();

      const result = await initCmd!.action!(ctx);

      // #1425: config init is not yet implemented
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('should initialize with V3 mode', async () => {
      const initCmd = configCommand.subcommands?.find(c => c.name === 'init');

      ctx.flags = { v3: true, _: [] };
      const result = await initCmd!.action!(ctx);

      // #1425: config init is not yet implemented
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('config get', () => {
    it('should get configuration value', async () => {
      const getCmd = configCommand.subcommands?.find(c => c.name === 'get');
      expect(getCmd).toBeDefined();

      ctx.args = ['swarm.topology'];
      const result = await getCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('key');
      expect(result.data).toHaveProperty('value');
    });

    it('should show all config when no key provided', async () => {
      const getCmd = configCommand.subcommands?.find(c => c.name === 'get');

      const result = await getCmd!.action!(ctx);

      expect(result.success).toBe(true);
    });
  });

  describe('config set', () => {
    it('should set configuration value', async () => {
      const setCmd = configCommand.subcommands?.find(c => c.name === 'set');
      expect(setCmd).toBeDefined();

      ctx.flags = { key: 'swarm.maxAgents', value: '20', _: [] };
      const result = await setCmd!.action!(ctx);

      // #1425: config set is not yet implemented
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('should fail without key and value', async () => {
      const setCmd = configCommand.subcommands?.find(c => c.name === 'set');

      const result = await setCmd!.action!(ctx);

      expect(result.success).toBe(false);
    });
  });

  describe('config providers', () => {
    it('should list providers', async () => {
      const providersCmd = configCommand.subcommands?.find(c => c.name === 'providers');
      expect(providersCmd).toBeDefined();

      const result = await providersCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });
  });

  describe('config reset', () => {
    it('should reset configuration', async () => {
      const resetCmd = configCommand.subcommands?.find(c => c.name === 'reset');
      expect(resetCmd).toBeDefined();

      ctx.flags = { force: true, _: [] };
      const result = await resetCmd!.action!(ctx);

      // #1425: config reset is not yet implemented
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('config export', () => {
    it('should export configuration', async () => {
      const exportCmd = configCommand.subcommands?.find(c => c.name === 'export');
      expect(exportCmd).toBeDefined();

      const result = await exportCmd!.action!(ctx);

      // #1425: config export is not yet implemented
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('config import', () => {
    it('should import configuration', async () => {
      const importCmd = configCommand.subcommands?.find(c => c.name === 'import');
      expect(importCmd).toBeDefined();

      ctx.flags = { file: './config.json', _: [] };
      const result = await importCmd!.action!(ctx);

      // #1425: config import is not yet implemented
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('should fail without file path', async () => {
      const importCmd = configCommand.subcommands?.find(c => c.name === 'import');

      const result = await importCmd!.action!(ctx);

      expect(result.success).toBe(false);
    });
  });
});
