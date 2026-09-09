/**
 * Tests for @ruvector/rvagent-wasm integration module
 *
 * Mocks the WASM module since it may not be installed in CI.
 * Tests the integration layer: lifecycle, tool execution, gallery, RVF.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// ── Mock fs and module for initAgentWasm ─────────────────────

vi.mock('node:fs', () => ({
  readFileSync: vi.fn().mockReturnValue(new Uint8Array([0])),
}));

vi.mock('node:module', () => ({
  createRequire: vi.fn().mockReturnValue({
    resolve: vi.fn().mockReturnValue('/fake/rvagent_wasm_bg.wasm'),
  }),
}));

// ── Mock @ruvector/rvagent-wasm ──────────────────────────────

const mockToolResult = { success: true, output: 'wrote 10 bytes to test.ts' };

class MockWasmAgent {
  _model: string;
  _turnCount = 0;
  _fileCount = 0;
  constructor(configJson: string) {
    const cfg = JSON.parse(configJson);
    this._model = cfg.model ?? 'default';
  }
  prompt = vi.fn().mockResolvedValue('Hello from WASM agent');
  set_model_provider = vi.fn();
  reset = vi.fn();
  free = vi.fn();
  get_state = vi.fn().mockReturnValue({ messages: [], turn_count: 0, stopped: false });
  get_todos = vi.fn().mockReturnValue([]);
  get_tools = vi.fn().mockReturnValue(['read_file', 'write_file', 'edit_file', 'write_todos', 'list_files']);
  execute_tool = vi.fn().mockResolvedValue(mockToolResult);
  model() { return this._model; }
  name() { return undefined; }
  turn_count() { return this._turnCount; }
  file_count() { return this._fileCount; }
  is_stopped() { return false; }
}

const mockTemplates = [
  { id: 'coder', name: 'Coder Agent', description: 'Coding assistant', category: 'development', tags: ['code'], version: '1.0.0', author: 'RuVector', builtin: true },
  { id: 'tester', name: 'Testing Agent', description: 'QA agent', category: 'testing', tags: ['test'], version: '1.0.0', author: 'RuVector', builtin: true },
];

const mockTemplateDetail = {
  ...mockTemplates[0],
  tools: [{ name: 'read_file', description: 'Read', parameters: [{ name: 'path', type: 'string', required: true }], returns: 'content' }],
  prompts: [{ name: 'coder', system_prompt: 'You are an expert coder.', version: '1.0.0' }],
  skills: [{ name: 'refactor', description: 'Refactor', trigger: '/refactor', content: 'Improve code' }],
  mcp_tools: [],
  capabilities: [],
};

class MockWasmGallery {
  list = vi.fn().mockReturnValue(mockTemplates);
  get = vi.fn().mockImplementation((id: string) => id === 'coder' ? mockTemplateDetail : undefined);
  search = vi.fn().mockReturnValue([{ ...mockTemplates[0], relevance: 0.7 }]);
  count = vi.fn().mockReturnValue(2);
  getCategories = vi.fn().mockReturnValue({ development: 1, testing: 1 });
  free = vi.fn();
}

class MockWasmMcpServer {
  handle_request = vi.fn().mockResolvedValue('{"jsonrpc":"2.0","id":1,"result":{}}');
  free = vi.fn();
  constructor(_agent: any) {}
}

class MockWasmRvfBuilder {
  _prompts: string[] = [];
  _tools: string[] = [];
  _skills: string[] = [];
  addPrompt(json: string) { this._prompts.push(json); }
  addTool(json: string) { this._tools.push(json); }
  addSkill(json: string) { this._skills.push(json); }
  addPrompts = vi.fn();
  addTools = vi.fn();
  addSkills = vi.fn();
  addCapabilities = vi.fn();
  addMcpTools = vi.fn();
  setOrchestrator = vi.fn();
  build = vi.fn().mockReturnValue(new Uint8Array([0x52, 0x56, 0x46, 0x01]));
  free = vi.fn();
}

vi.mock('@ruvector/rvagent-wasm', () => ({
  default: vi.fn().mockResolvedValue(undefined),
  initSync: vi.fn(),
  WasmAgent: MockWasmAgent,
  WasmGallery: MockWasmGallery,
  WasmMcpServer: MockWasmMcpServer,
  WasmRvfBuilder: MockWasmRvfBuilder,
  JsModelProvider: vi.fn(),
}));

// ── Import after mocking ─────────────────────────────────────

import {
  isAgentWasmAvailable,
  initAgentWasm,
  createWasmAgent,
  promptWasmAgent,
  executeWasmTool,
  getWasmAgent,
  listWasmAgents,
  terminateWasmAgent,
  getWasmAgentState,
  getWasmAgentTools,
  getWasmAgentTodos,
  exportWasmState,
  createWasmMcpServer,
  listGalleryTemplates,
  getGalleryCount,
  getGalleryCategories,
  searchGalleryTemplates,
  getGalleryTemplate,
  createAgentFromTemplate,
  buildRvfContainer,
  buildRvfFromTemplate,
} from '../../src/ruvector/agent-wasm.js';

// ── Tests ────────────────────────────────────────────────────

// Skip in CI — the WASM init crashes during module load even with the
// vi.mock above, because the mock replaces *some* of the loading path but
// the real @ruvector/rvagent-wasm import still happens. Local runs where
// the WASM binary is built work fine; CI without postinstall doesn't.
// See ruvllm-wasm.test.ts for the same pattern.
// Skip when CI (see above) OR when the optional WASM package simply is not
// installed — it is an optionalDependency, so a normal dev install may not
// have it. Asserting `available === true` in that case tests the developer's
// node_modules, not this code.
const __WASM_INSTALLED = await (async () => {
  try { await import('@ruvector/rvagent-wasm'); return true; } catch { return false; }
})();
const __SKIP_IN_CI = process.env.CI === 'true';
const __SKIP_WASM_TESTS = __SKIP_IN_CI || !__WASM_INSTALLED;

describe.skipIf(__SKIP_WASM_TESTS)('agent-wasm integration', () => {
  describe('detection and init', () => {
    it('detects module availability', async () => {
      expect(await isAgentWasmAvailable()).toBe(true);
    });

    it('initializes WASM (idempotent)', async () => {
      await expect(initAgentWasm()).resolves.toBeUndefined();
      await expect(initAgentWasm()).resolves.toBeUndefined();
    });
  });

  describe('agent lifecycle', () => {
    let agentId: string;

    afterEach(() => {
      if (agentId) terminateWasmAgent(agentId);
    });

    it('creates agent with defaults', async () => {
      const info = await createWasmAgent();
      agentId = info.id;
      expect(info.id).toMatch(/^wasm-agent-/);
      expect(info.state).toBe('idle');
      expect(info.model).toBe('anthropic:claude-sonnet-4-6');
      expect(info.fileCount).toBe(0);
      expect(info.isStopped).toBe(false);
    });

    it('creates agent with custom config', async () => {
      const info = await createWasmAgent({ model: 'custom-model', maxTurns: 10 });
      agentId = info.id;
      expect(info.model).toBe('custom-model');
      expect(info.config.maxTurns).toBe(10);
    });

    it('lists agents', async () => {
      const info = await createWasmAgent();
      agentId = info.id;
      const agents = listWasmAgents();
      expect(agents.some(a => a.id === agentId)).toBe(true);
    });

    it('gets agent by id', async () => {
      const info = await createWasmAgent();
      agentId = info.id;
      expect(getWasmAgent(agentId)).not.toBeNull();
      expect(getWasmAgent(agentId)!.id).toBe(agentId);
    });


    it('terminates agent', async () => {
      const info = await createWasmAgent();
      agentId = info.id;
      expect(terminateWasmAgent(agentId)).toBe(true);
      expect(getWasmAgent(agentId)).toBeNull();
      agentId = ''; // prevent double-terminate
    });

  });

  describe('prompting', () => {
    let agentId: string;

    afterEach(() => { terminateWasmAgent(agentId); });

    it('sends prompt and gets response', async () => {
      const info = await createWasmAgent();
      agentId = info.id;
      const result = await promptWasmAgent(agentId, 'Hello');
      expect(result).toBe('Hello from WASM agent');
    });

  });

  describe('tool execution', () => {
    let agentId: string;

    afterEach(() => { terminateWasmAgent(agentId); });

    it('executes tool with flat format', async () => {
      const info = await createWasmAgent();
      agentId = info.id;
      const result = await executeWasmTool(agentId, { tool: 'write_file', path: 'test.ts', content: 'const x = 1;' });
      expect(result.success).toBe(true);
    });

  });

  describe('agent state accessors', () => {
    let agentId: string;

    afterEach(() => { terminateWasmAgent(agentId); });

    it('returns state, tools, todos', async () => {
      const info = await createWasmAgent();
      agentId = info.id;

      const state = getWasmAgentState(agentId);
      expect(state).toBeDefined();

      const tools = getWasmAgentTools(agentId);
      expect(tools).toContain('read_file');

      const todos = getWasmAgentTodos(agentId);
      expect(Array.isArray(todos)).toBe(true);
    });

    it('exports full state as JSON', async () => {
      const info = await createWasmAgent();
      agentId = info.id;
      const exported = exportWasmState(agentId);
      const parsed = JSON.parse(exported);
      expect(parsed).toHaveProperty('agentState');
      expect(parsed).toHaveProperty('tools');
      expect(parsed).toHaveProperty('todos');
      expect(parsed).toHaveProperty('info');
    });

  });

  describe('MCP server bridge', () => {
    let agentId: string;

    afterEach(() => { terminateWasmAgent(agentId); });

    it('creates handler and processes requests', async () => {
      const info = await createWasmAgent();
      agentId = info.id;
      const handler = await createWasmMcpServer(agentId);
      expect(typeof handler).toBe('function');
      const resp = await handler('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
      expect(resp).toContain('jsonrpc');
    });

  });

  describe('gallery templates', () => {
    it('lists templates', async () => {
      const templates = await listGalleryTemplates();
      expect(templates).toHaveLength(2);
      expect(templates[0].id).toBe('coder');
    });

    it('counts templates', async () => {
      expect(await getGalleryCount()).toBe(2);
    });

    it('gets categories', async () => {
      const cats = await getGalleryCategories();
      expect(cats.development).toBe(1);
      expect(cats.testing).toBe(1);
    });

    it('searches templates', async () => {
      const results = await searchGalleryTemplates('code');
      expect(results).toHaveLength(1);
      expect(results[0].relevance).toBeGreaterThan(0);
    });

    it('gets template detail', async () => {
      const detail = await getGalleryTemplate('coder');
      expect(detail).not.toBeNull();
      expect(detail!.prompts).toHaveLength(1);
      expect(detail!.tools).toHaveLength(1);
    });

    it('returns null for unknown template', async () => {
      expect(await getGalleryTemplate('nonexistent')).toBeNull();
    });

    it('creates agent from template', async () => {
      const info = await createAgentFromTemplate('coder');
      expect(info.id).toMatch(/^wasm-agent-/);
      // #1810 — gallery templates pass `model: undefined` and must
      // inherit the current default. Pin the assertion here so a
      // future regression of the default surfaces in the gallery path
      // too, not just in the bare `createWasmAgent` path.
      expect(info.model).toBe('anthropic:claude-sonnet-4-6');
      terminateWasmAgent(info.id);
    });

    it('throws for unknown template', async () => {
      await expect(createAgentFromTemplate('nonexistent')).rejects.toThrow('Gallery template not found');
    });
  });

  describe('RVF container operations', () => {
    it('builds container with prompts/tools/skills', async () => {
      const container = await buildRvfContainer({
        prompts: [{ name: 'test', system_prompt: 'You are a test.', version: '1.0.0' }],
        tools: [{ name: 'read_file', description: 'Read', parameters: [{ name: 'path', type: 'string', required: true }], returns: 'content' }],
        skills: [{ name: 'refactor', description: 'Refactor', trigger: '/refactor', content: 'Improve code' }],
      });
      expect(container).toBeInstanceOf(Uint8Array);
      expect(container[0]).toBe(0x52); // 'R'
    });

    it('builds container from gallery template', async () => {
      const container = await buildRvfFromTemplate('coder');
      expect(container).toBeInstanceOf(Uint8Array);
    });

    it('throws for unknown template', async () => {
      await expect(buildRvfFromTemplate('nonexistent')).rejects.toThrow('Gallery template not found');
    });
  });
});

// These assertions never touch the WASM module — they exercise the
// unknown-agent error paths, which resolve from the local registry before any
// dynamic import. So they are gated on CI only (exactly as before), NOT on
// whether @ruvector/rvagent-wasm is installed: skipping them when the optional
// package is absent would test nothing but the developer's node_modules.
describe.skipIf(__SKIP_IN_CI)('agent-wasm integration (no WASM module required)', () => {
  it('returns null for unknown agent', () => {
      expect(getWasmAgent('nonexistent')).toBeNull();
    });
  it('returns false for terminating nonexistent', () => {
      expect(terminateWasmAgent('nonexistent')).toBe(false);
    });
  it('throws for unknown agent', async () => {
      await expect(promptWasmAgent('nope', 'test')).rejects.toThrow('WASM agent not found');
    });
  it('throws for unknown agent', async () => {
      await expect(executeWasmTool('nope', { tool: 'list_files' })).rejects.toThrow('WASM agent not found');
    });
  it('throws for unknown agent', () => {
      expect(() => getWasmAgentState('nope')).toThrow('WASM agent not found');
      expect(() => getWasmAgentTools('nope')).toThrow('WASM agent not found');
      expect(() => getWasmAgentTodos('nope')).toThrow('WASM agent not found');
      expect(() => exportWasmState('nope')).toThrow('WASM agent not found');
    });
  it('throws for unknown agent', async () => {
      await expect(createWasmMcpServer('nope')).rejects.toThrow('WASM agent not found');
    });
});
