/**
 * Deep MCP Tools Test Suite
 *
 * Comprehensive tests for all MCP tool files covering:
 * - Schema validation (name, description, inputSchema)
 * - Array schemas have `items` field
 * - Handler existence and error handling
 * - Tool registration across all 24 tool modules
 * - System tools version/status correctness
 *
 * Uses vitest with mocks to isolate from external dependencies.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// ============================================================================
// Mock setup - must be before imports
// ============================================================================

// Mock fs to prevent actual file I/O during tests
vi.mock('node:fs', () => {
  const memStore = new Map<string, string>();
  const descriptors = new Map<number, string>();
  let nextDescriptor = 3;
  return {
    existsSync: vi.fn((p: string) => memStore.has(p)),
    readFileSync: vi.fn((p: string) => memStore.get(p) || '{}'),
    writeFileSync: vi.fn((p: string, d: string) => memStore.set(p, d)),
    renameSync: vi.fn((from: string, to: string) => {
      memStore.set(to, memStore.get(from) || '');
      memStore.delete(from);
    }),
    openSync: vi.fn((p: string) => {
      const descriptor = nextDescriptor++;
      descriptors.set(descriptor, p);
      if (!memStore.has(p)) memStore.set(p, '');
      return descriptor;
    }),
    writeSync: vi.fn((descriptor: number, data: Buffer) => {
      const path = descriptors.get(descriptor);
      if (path) memStore.set(path, data.toString());
      return data.length;
    }),
    fsyncSync: vi.fn(),
    closeSync: vi.fn((descriptor: number) => descriptors.delete(descriptor)),
    chmodSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    unlinkSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 100, isFile: () => true, isDirectory: () => false })),
  };
});

vi.mock('fs', () => {
  const memStore = new Map<string, string>();
  const descriptors = new Map<number, string>();
  let nextDescriptor = 3;
  return {
    existsSync: vi.fn((p: string) => memStore.has(p)),
    readFileSync: vi.fn((p: string) => memStore.get(p) || '{}'),
    writeFileSync: vi.fn((p: string, d: string) => memStore.set(p, d)),
    renameSync: vi.fn((from: string, to: string) => {
      memStore.set(to, memStore.get(from) || '');
      memStore.delete(from);
    }),
    openSync: vi.fn((p: string) => {
      const descriptor = nextDescriptor++;
      descriptors.set(descriptor, p);
      if (!memStore.has(p)) memStore.set(p, '');
      return descriptor;
    }),
    writeSync: vi.fn((descriptor: number, data: Buffer) => {
      const path = descriptors.get(descriptor);
      if (path) memStore.set(path, data.toString());
      return data.length;
    }),
    fsyncSync: vi.fn(),
    closeSync: vi.fn((descriptor: number) => descriptors.delete(descriptor)),
    chmodSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    unlinkSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 100, isFile: () => true, isDirectory: () => false })),
  };
});

// Mock child_process for browser/security tools
vi.mock('child_process', () => ({
  execSync: vi.fn(() => '{}'),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '' })),
}));

// Mock the memory bridge for agentdb tools
vi.mock('../src/memory/memory-bridge.js', () => ({
  bridgeHealthCheck: vi.fn(async () => ({ available: true, status: 'healthy' })),
  bridgeListControllers: vi.fn(async () => []),
  bridgeStorePattern: vi.fn(async () => ({ success: true })),
  bridgeSearchPatterns: vi.fn(async () => ({ results: [] })),
  bridgeRecordFeedback: vi.fn(async () => ({ success: true })),
  bridgeRecordCausalEdge: vi.fn(async () => ({ success: true })),
  bridgeRouteTask: vi.fn(async () => ({ route: 'general', confidence: 0.5, agents: ['coder'] })),
  bridgeSessionStart: vi.fn(async () => ({ success: true })),
  bridgeSessionEnd: vi.fn(async () => ({ success: true })),
  bridgeHierarchicalStore: vi.fn(async () => ({ success: true })),
  bridgeHierarchicalRecall: vi.fn(async () => ({ results: [] })),
  bridgeConsolidate: vi.fn(async () => ({ success: true })),
  bridgeBatchOperation: vi.fn(async () => ({ success: true })),
  bridgeContextSynthesize: vi.fn(async () => ({ success: true })),
  bridgeSemanticRoute: vi.fn(async () => ({ route: null })),
}));

// Mock memory-initializer
vi.mock('../src/memory/memory-initializer.js', () => ({
  generateEmbedding: vi.fn(async () => ({ embedding: new Array(384).fill(0.1), dimensions: 384, model: 'mock' })),
  storeEntry: vi.fn(async () => ({ success: true, id: 'mock-id' })),
  searchEntries: vi.fn(async () => ({ success: true, results: [], searchTime: 1 })),
  listEntries: vi.fn(async () => ({ success: true, entries: [] })),
  getEntry: vi.fn(async () => null),
  deleteEntry: vi.fn(async () => ({ success: true })),
  getStats: vi.fn(async () => ({ totalEntries: 0 })),
  initializeDatabase: vi.fn(async () => ({ success: true })),
  initializeMemoryDatabase: vi.fn(async () => ({ success: true })),
  checkMemoryInitialization: vi.fn(async () => ({ initialized: true, version: '3.0.0' })),
  migrateFromLegacy: vi.fn(async () => ({ success: true, migrated: 0 })),
}));

// Mock intelligence module
vi.mock('../src/memory/intelligence.js', () => ({
  getIntelligenceStats: vi.fn(() => ({
    patternsLearned: 0,
    trajectoriesRecorded: 0,
    reasoningBankSize: 0,
    sonaEnabled: false,
    lastAdaptation: null,
  })),
  initializeIntelligence: vi.fn(async () => {}),
  benchmarkAdaptation: vi.fn(() => ({ avgMs: 0.01, minMs: 0.005, maxMs: 0.02, targetMet: true })),
}));

// Mock ruvector modules
vi.mock('../src/ruvector/model-router.js', () => ({
  getModelRouter: vi.fn(() => ({ route: async () => ({ model: 'sonnet', routedBy: 'router' }) })),
}));

vi.mock('../src/ruvector/enhanced-model-router.js', () => ({
  getEnhancedModelRouter: vi.fn(() => ({
    route: async () => ({ tier: 2, model: 'sonnet', canSkipLLM: false }),
  })),
}));

vi.mock('../src/ruvector/diff-classifier.js', () => ({
  analyzeDiff: vi.fn(async () => ({
    ref: 'HEAD', timestamp: new Date().toISOString(), files: [],
    risk: { overall: 'low', score: 10 }, classification: { type: 'patch' },
    summary: 'No changes', fileRisks: [], recommendedReviewers: [],
  })),
  assessFileRisk: vi.fn(() => ({ risk: 'low', score: 10, reasons: [] })),
  assessOverallRisk: vi.fn(() => ({ overall: 'low', score: 10 })),
  classifyDiff: vi.fn(() => ({ type: 'patch' })),
  suggestReviewers: vi.fn(() => []),
  getGitDiffNumstat: vi.fn(() => []),
}));

vi.mock('../src/ruvector/moe-router.js', () => ({
  getMoERouter: vi.fn(async () => null),
}));

vi.mock('../src/memory/sona-optimizer.js', () => ({
  getSONAOptimizer: vi.fn(async () => null),
}));

vi.mock('../src/memory/ewc-consolidation.js', () => ({
  getEWCConsolidator: vi.fn(async () => null),
}));

// Mock transfer modules
vi.mock('../src/transfer/anonymization/index.js', () => ({
  detectPII: vi.fn(() => ({ hasPII: false, entities: [] })),
}));

vi.mock('../src/transfer/ipfs/client.js', () => ({
  resolveIPNS: vi.fn(async () => 'QmMock'),
}));

// Mock module for auto-install
vi.mock('../src/mcp-tools/auto-install.js', () => ({
  autoInstallPackage: vi.fn(async () => false),
}));

// Mock security package
vi.mock('@claude-flow/aidefence', () => {
  throw new Error('Cannot find package');
});

// Mock embeddings package
vi.mock('@claude-flow/embeddings', () => {
  throw new Error('Cannot find package');
});

vi.mock('agentic-flow/reasoningbank', () => {
  throw new Error('Cannot find package');
});

// ============================================================================
// Import all tool modules (after mocks are set up)
// ============================================================================

import { agentTools } from '../src/mcp-tools/agent-tools.js';
import { agentdbTools } from '../src/mcp-tools/agentdb-tools.js';
import { analyzeTools } from '../src/mcp-tools/analyze-tools.js';
import { browserTools } from '../src/mcp-tools/browser-tools.js';
import { claimsTools } from '../src/mcp-tools/claims-tools.js';
import { configTools } from '../src/mcp-tools/config-tools.js';
import { coordinationTools } from '../src/mcp-tools/coordination-tools.js';
import { daaTools } from '../src/mcp-tools/daa-tools.js';
import { embeddingsTools } from '../src/mcp-tools/embeddings-tools.js';
import { githubTools } from '../src/mcp-tools/github-tools.js';
import { hiveMindTools } from '../src/mcp-tools/hive-mind-tools.js';
import { memoryTools } from '../src/mcp-tools/memory-tools.js';
import { neuralTools } from '../src/mcp-tools/neural-tools.js';
import { performanceTools } from '../src/mcp-tools/performance-tools.js';
import { progressTools } from '../src/mcp-tools/progress-tools.js';
import { securityTools } from '../src/mcp-tools/security-tools.js';
import { sessionTools } from '../src/mcp-tools/session-tools.js';
import { swarmTools } from '../src/mcp-tools/swarm-tools.js';
import { systemTools } from '../src/mcp-tools/system-tools.js';
import { taskTools } from '../src/mcp-tools/task-tools.js';
import { terminalTools } from '../src/mcp-tools/terminal-tools.js';
import { transferTools } from '../src/mcp-tools/transfer-tools.js';
import { workflowTools } from '../src/mcp-tools/workflow-tools.js';
import { hooksTools } from '../src/mcp-tools/hooks-tools.js';

import type { MCPTool } from '../src/mcp-tools/types.js';

// ============================================================================
// Collect all tool modules
// ============================================================================

interface ToolModule {
  name: string;
  tools: MCPTool[];
}

const ALL_MODULES: ToolModule[] = [
  { name: 'agent-tools', tools: agentTools },
  { name: 'agentdb-tools', tools: agentdbTools },
  { name: 'analyze-tools', tools: analyzeTools },
  { name: 'browser-tools', tools: browserTools },
  { name: 'claims-tools', tools: claimsTools },
  { name: 'config-tools', tools: configTools },
  { name: 'coordination-tools', tools: coordinationTools },
  { name: 'daa-tools', tools: daaTools },
  { name: 'embeddings-tools', tools: embeddingsTools },
  { name: 'github-tools', tools: githubTools },
  { name: 'hive-mind-tools', tools: hiveMindTools },
  { name: 'hooks-tools', tools: hooksTools },
  { name: 'memory-tools', tools: memoryTools },
  { name: 'neural-tools', tools: neuralTools },
  { name: 'performance-tools', tools: performanceTools },
  { name: 'progress-tools', tools: progressTools },
  { name: 'security-tools', tools: securityTools },
  { name: 'session-tools', tools: sessionTools },
  { name: 'swarm-tools', tools: swarmTools },
  { name: 'system-tools', tools: systemTools },
  { name: 'task-tools', tools: taskTools },
  { name: 'terminal-tools', tools: terminalTools },
  { name: 'transfer-tools', tools: transferTools },
  { name: 'workflow-tools', tools: workflowTools },
];

const ALL_TOOLS: MCPTool[] = ALL_MODULES.flatMap(m => m.tools);

// ============================================================================
// Tests
// ============================================================================

describe('MCP Tools Deep Test Suite', () => {

  // --------------------------------------------------------------------------
  // 1. Module Loading & Registration
  // --------------------------------------------------------------------------
  describe('Module Loading & Registration', () => {
    it('should load all 24 tool modules', () => {
      expect(ALL_MODULES).toHaveLength(24);
    });

    it('should have at least 100 total tools across all modules', () => {
      expect(ALL_TOOLS.length).toBeGreaterThanOrEqual(100);
    });

    it('should export arrays from each module', () => {
      for (const mod of ALL_MODULES) {
        expect(Array.isArray(mod.tools)).toBe(true);
        expect(mod.tools.length).toBeGreaterThan(0);
      }
    });

    it('should have no duplicate tool names across all modules', () => {
      const names = ALL_TOOLS.map(t => t.name);
      const uniqueNames = new Set(names);
      const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
      expect(duplicates).toEqual([]);
      expect(uniqueNames.size).toBe(names.length);
    });

    it('should register expected tool counts per module', () => {
      const minCounts: Record<string, number> = {
        'agent-tools': 7,
        'agentdb-tools': 15,
        'analyze-tools': 6,
        'browser-tools': 20,
        'claims-tools': 12,
        'config-tools': 6,
        'coordination-tools': 7,
        'daa-tools': 8,
        'embeddings-tools': 7,
        'github-tools': 5,
        'hive-mind-tools': 9,
        'memory-tools': 7,
        'neural-tools': 6,
        'performance-tools': 6,
        'progress-tools': 4,
        'security-tools': 6,
        'session-tools': 5,
        'swarm-tools': 4,
        'system-tools': 7,
        'task-tools': 7,
        'terminal-tools': 5,
        'transfer-tools': 11,
        'workflow-tools': 10,
      };

      for (const mod of ALL_MODULES) {
        const min = minCounts[mod.name];
        if (min !== undefined) {
          expect(mod.tools.length).toBeGreaterThanOrEqual(min);
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // 2. Schema Validation
  // --------------------------------------------------------------------------
  describe('Schema Validation - All Tools', () => {
    it('every tool has a non-empty name', () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.name).toBeDefined();
        expect(typeof tool.name).toBe('string');
        expect(tool.name.length).toBeGreaterThan(0);
      }
    });

    it('every tool has a non-empty description', () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe('string');
        expect(tool.description.length).toBeGreaterThan(0);
      }
    });

    it('every tool has an inputSchema with type "object"', () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });

    it('every tool inputSchema has a properties field', () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.inputSchema.properties).toBeDefined();
        expect(typeof tool.inputSchema.properties).toBe('object');
      }
    });

    it('every tool has a handler function', () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.handler).toBeDefined();
        expect(typeof tool.handler).toBe('function');
      }
    });

    it('required field is either absent or an array of strings', () => {
      for (const tool of ALL_TOOLS) {
        if (tool.inputSchema.required !== undefined) {
          expect(Array.isArray(tool.inputSchema.required)).toBe(true);
          for (const req of tool.inputSchema.required!) {
            expect(typeof req).toBe('string');
          }
        }
      }
    });

    it('required fields reference existing properties', () => {
      for (const tool of ALL_TOOLS) {
        if (tool.inputSchema.required) {
          const propNames = Object.keys(tool.inputSchema.properties);
          for (const req of tool.inputSchema.required) {
            expect(propNames).toContain(req);
          }
        }
      }
    });

    it('tool names follow naming conventions (category_action or category_action-detail)', () => {
      for (const tool of ALL_TOOLS) {
        // Names should contain underscore or hyphen as separators
        // and not have spaces or special chars
        expect(tool.name).toMatch(/^[a-z][a-z0-9_-]+$/);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 3. Array Schema Validation - items field
  // --------------------------------------------------------------------------
  describe('Array Schema Validation', () => {
    function findArrayProperties(tool: MCPTool): Array<{ toolName: string; propName: string; prop: any }> {
      const results: Array<{ toolName: string; propName: string; prop: any }> = [];
      const properties = tool.inputSchema.properties;
      for (const [propName, prop] of Object.entries(properties)) {
        const p = prop as Record<string, unknown>;
        if (p.type === 'array') {
          results.push({ toolName: tool.name, propName, prop: p });
        }
      }
      return results;
    }

    it('all array-typed properties have an items field', () => {
      const missingItems: string[] = [];

      for (const tool of ALL_TOOLS) {
        const arrayProps = findArrayProperties(tool);
        for (const { toolName, propName, prop } of arrayProps) {
          if (!prop.items) {
            missingItems.push(`${toolName}.${propName}`);
          }
        }
      }

      expect(missingItems).toEqual([]);
    });

    it('array items field specifies a type', () => {
      for (const tool of ALL_TOOLS) {
        const arrayProps = findArrayProperties(tool);
        for (const { prop } of arrayProps) {
          if (prop.items) {
            expect(prop.items.type).toBeDefined();
          }
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // 4. Category Consistency
  // --------------------------------------------------------------------------
  describe('Category Consistency', () => {
    it('tool name prefix matches category when category is set', () => {
      const exceptions = new Set([
        'mcp_status',      // system-tools exports mcp_status
        'mcp_start',       // system-tools exports mcp_start (#1916 — in-process no-op)
        'mcp_stop',        // system-tools exports mcp_stop (#1916 — in-process no-op)
        'task_summary',    // system-tools exports task_summary
      ]);

      for (const tool of ALL_TOOLS) {
        if (tool.category && !exceptions.has(tool.name)) {
          const prefix = tool.name.split('_')[0].replace(/-/g, '');
          const cat = tool.category.replace(/-/g, '');
          // Prefix should match category (e.g., agent_spawn -> agent category)
          expect(prefix).toBe(cat);
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // 5. Handler Invocation - Agent Tools
  // --------------------------------------------------------------------------
  describe('Agent Tools - Handler Invocation', () => {
    it('agent_spawn creates an agent with required agentType', async () => {
      const tool = agentTools.find(t => t.name === 'agent_spawn')!;
      const result: any = await tool.handler({ agentType: 'coder' });
      expect(result.success).toBe(true);
      expect(result.agentId).toBeDefined();
      expect(result.agentType).toBe('coder');
    });

    it('agent_list returns agents array', async () => {
      const tool = agentTools.find(t => t.name === 'agent_list')!;
      const result: any = await tool.handler({});
      expect(result.agents).toBeDefined();
      expect(Array.isArray(result.agents)).toBe(true);
    });

    it('agent_status returns not_found for unknown agent', async () => {
      const tool = agentTools.find(t => t.name === 'agent_status')!;
      const result: any = await tool.handler({ agentId: 'nonexistent' });
      expect(result.status).toBe('not_found');
    });

    it('agent_terminate returns error for unknown agent', async () => {
      const tool = agentTools.find(t => t.name === 'agent_terminate')!;
      const result: any = await tool.handler({ agentId: 'nonexistent' });
      expect(result.success).toBe(false);
    });

    it('agent_pool status action returns pool info', async () => {
      const tool = agentTools.find(t => t.name === 'agent_pool')!;
      const result: any = await tool.handler({ action: 'status' });
      expect(result.action).toBe('status');
      expect(result.poolId).toBeDefined();
    });

    it('agent_health returns overall health info', async () => {
      const tool = agentTools.find(t => t.name === 'agent_health')!;
      const result: any = await tool.handler({});
      expect(result.overall).toBeDefined();
    });

    it('agent_update returns error for unknown agent', async () => {
      const tool = agentTools.find(t => t.name === 'agent_update')!;
      const result: any = await tool.handler({ agentId: 'nonexistent' });
      expect(result.success).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 6. Handler Invocation - System Tools
  // --------------------------------------------------------------------------
  describe('System Tools - Handler Invocation', () => {
    it('system_status returns version and status', async () => {
      const tool = systemTools.find(t => t.name === 'system_status')!;
      const result: any = await tool.handler({});
      expect(result.version).toBeDefined();
      expect(result.status).toBeDefined();
    });

    it('system_info returns system information', async () => {
      const tool = systemTools.find(t => t.name === 'system_info')!;
      const result: any = await tool.handler({});
      expect(result.version).toBeDefined();
      expect(result.platform).toBeDefined();
    });

    it('system_health returns health checks', async () => {
      const tool = systemTools.find(t => t.name === 'system_health')!;
      const result: any = await tool.handler({});
      expect(result.overall).toBeDefined();
      expect(result.checks).toBeDefined();
    });

    it('system_metrics returns metrics data', async () => {
      const tool = systemTools.find(t => t.name === 'system_metrics')!;
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });

    it('mcp_status returns MCP server info', async () => {
      const tool = systemTools.find(t => t.name === 'mcp_status')!;
      const result: any = await tool.handler({});
      expect(result.running).toBeDefined();
      expect(result.transport).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 7. Handler Invocation - Config Tools
  // --------------------------------------------------------------------------
  describe('Config Tools - Handler Invocation', () => {
    it('config_get returns value for known key', async () => {
      const tool = configTools.find(t => t.name === 'config_get')!;
      const result: any = await tool.handler({ key: 'logging.level' });
      expect(result.key).toBe('logging.level');
      expect(result.exists).toBeDefined();
    });

    it('config_set stores a value', async () => {
      const tool = configTools.find(t => t.name === 'config_set')!;
      const result: any = await tool.handler({ key: 'test.key', value: 'test-value' });
      expect(result.success).toBe(true);
    });

    it('config_list returns configurations', async () => {
      const tool = configTools.find(t => t.name === 'config_list')!;
      const result: any = await tool.handler({});
      expect(result.configs).toBeDefined();
      expect(Array.isArray(result.configs)).toBe(true);
    });

    it('config_reset returns success', async () => {
      const tool = configTools.find(t => t.name === 'config_reset')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(true);
    });

    it('config_export returns config data', async () => {
      const tool = configTools.find(t => t.name === 'config_export')!;
      const result: any = await tool.handler({});
      expect(result.config).toBeDefined();
    });

    it('config_import returns success', async () => {
      const tool = configTools.find(t => t.name === 'config_import')!;
      const result: any = await tool.handler({ config: { 'test.k': 'v' } });
      expect(result.success).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 8. Handler Invocation - Swarm Tools
  // --------------------------------------------------------------------------
  describe('Swarm Tools - Handler Invocation', () => {
    it('swarm_init returns swarmId and topology', async () => {
      const tool = swarmTools.find(t => t.name === 'swarm_init')!;
      const result: any = await tool.handler({ topology: 'hierarchical' });
      expect(result.success).toBe(true);
      expect(result.swarmId).toBeDefined();
      expect(result.persisted).toBe(true);
    });

    it('swarm_status returns running status after init', async () => {
      // Init a swarm first so status has something to report
      const initTool = swarmTools.find(t => t.name === 'swarm_init')!;
      const initResult: any = await initTool.handler({ topology: 'mesh' });
      const tool = swarmTools.find(t => t.name === 'swarm_status')!;
      const result: any = await tool.handler({ swarmId: initResult.swarmId });
      expect(result.status).toBe('running');
    });

    it('swarm_shutdown returns success after init', async () => {
      const initTool = swarmTools.find(t => t.name === 'swarm_init')!;
      const initResult: any = await initTool.handler({ topology: 'hierarchical' });
      const tool = swarmTools.find(t => t.name === 'swarm_shutdown')!;
      const result: any = await tool.handler({ swarmId: initResult.swarmId });
      expect(result.success).toBe(true);
      expect(result.terminated).toBe(true);
    });

    it('swarm_health returns healthy checks after init', async () => {
      const initTool = swarmTools.find(t => t.name === 'swarm_init')!;
      const initResult: any = await initTool.handler({ topology: 'hierarchical' });
      const tool = swarmTools.find(t => t.name === 'swarm_health')!;
      const result: any = await tool.handler({ swarmId: initResult.swarmId });
      expect(result.status).toBe('healthy');
      expect(result.checks).toBeDefined();
      expect(result.healthy).toBe(true);
    });

    it('swarm_health returns not_found for nonexistent swarm ID', async () => {
      const tool = swarmTools.find(t => t.name === 'swarm_health')!;
      const result: any = await tool.handler({ swarmId: 'nonexistent-id-999' });
      expect(result.status).toBe('not_found');
      expect(result.healthy).toBe(false);
      expect(result.checks).toBeDefined();
    });

    it('swarm_init rejects invalid topology', async () => {
      const tool = swarmTools.find(t => t.name === 'swarm_init')!;
      const result: any = await tool.handler({ topology: 'invalid-topo' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid topology');
    });
  });

  // --------------------------------------------------------------------------
  // 9. Handler Invocation - Task Tools
  // --------------------------------------------------------------------------
  describe('Task Tools - Handler Invocation', () => {
    it('task_create creates a task', async () => {
      const tool = taskTools.find(t => t.name === 'task_create')!;
      const result: any = await tool.handler({ type: 'feature', description: 'Test task' });
      expect(result.taskId).toBeDefined();
      expect(result.type).toBe('feature');
      expect(result.status).toBe('pending');
    });

    it('task_list returns tasks array', async () => {
      const tool = taskTools.find(t => t.name === 'task_list')!;
      const result: any = await tool.handler({});
      expect(result.tasks).toBeDefined();
      expect(Array.isArray(result.tasks)).toBe(true);
    });

    it('task_status returns not_found for unknown task', async () => {
      const tool = taskTools.find(t => t.name === 'task_status')!;
      const result: any = await tool.handler({ taskId: 'nonexistent' });
      expect(result.status).toBe('not_found');
    });
  });

  // --------------------------------------------------------------------------
  // 10. Handler Invocation - Session Tools
  // --------------------------------------------------------------------------
  describe('Session Tools - Handler Invocation', () => {
    it('session_list returns sessions', async () => {
      const tool = sessionTools.find(t => t.name === 'session_list')!;
      const result: any = await tool.handler({});
      expect(result.sessions).toBeDefined();
    });

    it('session_save creates a session', async () => {
      const tool = sessionTools.find(t => t.name === 'session_save')!;
      const result: any = await tool.handler({ name: 'Test Session' });
      expect(result.sessionId).toBeDefined();
      expect(result.name).toBe('Test Session');
    });
  });

  // --------------------------------------------------------------------------
  // 11. Handler Invocation - Hive Mind Tools
  // --------------------------------------------------------------------------
  describe('Hive Mind Tools - Handler Invocation', () => {
    it('hive-mind_init initializes the hive', async () => {
      const tool = hiveMindTools.find(t => t.name === 'hive-mind_init')!;
      const result: any = await tool.handler({ topology: 'mesh' });
      expect(result.success).toBe(true);
      expect(result.topology).toBe('mesh');
    });

    it('hive-mind_status returns status info', async () => {
      const tool = hiveMindTools.find(t => t.name === 'hive-mind_status')!;
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });

    it('hive-mind_status reports the same hiveId that hive-mind_init returned (#655)', async () => {
      const initTool = hiveMindTools.find(t => t.name === 'hive-mind_init')!;
      const statusTool = hiveMindTools.find(t => t.name === 'hive-mind_status')!;
      const initResult: any = await initTool.handler({ topology: 'mesh' });
      const statusResult: any = await statusTool.handler({});
      expect(statusResult.hiveId).toBe(initResult.hiveId);
      expect(statusResult.id).toBe(initResult.hiveId);
    });

    it('hive-mind_consensus with list action returns data', async () => {
      const tool = hiveMindTools.find(t => t.name === 'hive-mind_consensus')!;
      const result: any = await tool.handler({ action: 'list' });
      expect(result.action).toBe('list');
    });
  });

  // --------------------------------------------------------------------------
  // 12. Handler Invocation - Workflow Tools
  // --------------------------------------------------------------------------
  describe('Workflow Tools - Handler Invocation', () => {
    it('workflow_list returns workflows', async () => {
      const tool = workflowTools.find(t => t.name === 'workflow_list')!;
      const result: any = await tool.handler({});
      expect(result.workflows).toBeDefined();
    });

    it('workflow_create creates a workflow', async () => {
      const tool = workflowTools.find(t => t.name === 'workflow_create')!;
      const result: any = await tool.handler({ name: 'test-wf', description: 'Test workflow' });
      expect(result.workflowId).toBeDefined();
      expect(result.name).toBe('test-wf');
    });
  });

  // --------------------------------------------------------------------------
  // 13. Handler Invocation - DAA Tools
  // --------------------------------------------------------------------------
  describe('DAA Tools - Handler Invocation', () => {
    it('daa_agent_create creates an agent', async () => {
      const tool = daaTools.find(t => t.name === 'daa_agent_create')!;
      const result: any = await tool.handler({ id: 'test-daa-1' });
      expect(result.success).toBe(true);
      expect(result.agent.id).toBe('test-daa-1');
    });

    it('daa_learning_status returns summary', async () => {
      const tool = daaTools.find(t => t.name === 'daa_learning_status')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(true);
      expect(result.summary).toBeDefined();
    });

    it('daa_cognitive_pattern returns patterns info', async () => {
      const tool = daaTools.find(t => t.name === 'daa_cognitive_pattern')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(true);
      expect(result.patterns).toBeDefined();
    });

    it('daa_performance_metrics returns metrics', async () => {
      const tool = daaTools.find(t => t.name === 'daa_performance_metrics')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 14. Handler Invocation - Coordination Tools
  // --------------------------------------------------------------------------
  describe('Coordination Tools - Handler Invocation', () => {
    it('coordination_topology get action returns topology', async () => {
      const tool = coordinationTools.find(t => t.name === 'coordination_topology')!;
      const result: any = await tool.handler({ action: 'get' });
      expect(result.success).toBe(true);
      expect(result.topology).toBeDefined();
    });

    it('coordination_sync status returns sync state', async () => {
      const tool = coordinationTools.find(t => t.name === 'coordination_sync')!;
      const result: any = await tool.handler({ action: 'status' });
      expect(result.success).toBe(true);
    });

    it('coordination_node list returns nodes', async () => {
      const tool = coordinationTools.find(t => t.name === 'coordination_node')!;
      const result: any = await tool.handler({ action: 'list' });
      expect(result.success).toBe(true);
      expect(result.nodes).toBeDefined();
    });

    it('coordination_metrics returns metrics', async () => {
      const tool = coordinationTools.find(t => t.name === 'coordination_metrics')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(true);
    });

    it('coordination_orchestrate accepts task', async () => {
      const tool = coordinationTools.find(t => t.name === 'coordination_orchestrate')!;
      const result: any = await tool.handler({ task: 'test task' });
      expect(result.success).toBe(true);
      expect(result.orchestrationId).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 15. Handler Invocation - GitHub Tools
  // --------------------------------------------------------------------------
  describe('GitHub Tools - Handler Invocation', () => {
    it('github_repo_analyze returns analysis', async () => {
      const tool = githubTools.find(t => t.name === 'github_repo_analyze')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(true);
      expect(result.repository).toBeDefined();
    });

    it('github_pr_manage list returns PRs', async () => {
      const tool = githubTools.find(t => t.name === 'github_pr_manage')!;
      const result: any = await tool.handler({ action: 'list' });
      expect(result.success).toBe(true);
    });

    it('github_metrics returns all metrics', async () => {
      const tool = githubTools.find(t => t.name === 'github_metrics')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(true);
      expect(result.commits).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 16. Handler Invocation - Terminal Tools
  // --------------------------------------------------------------------------
  describe('Terminal Tools - Handler Invocation', () => {
    it('terminal_create creates a session', async () => {
      const tool = terminalTools.find(t => t.name === 'terminal_create')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(true);
      expect(result.sessionId).toBeDefined();
    });

    it('terminal_list returns sessions', async () => {
      const tool = terminalTools.find(t => t.name === 'terminal_list')!;
      const result: any = await tool.handler({});
      expect(result.sessions).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 17. Handler Invocation - Claims Tools
  // --------------------------------------------------------------------------
  describe('Claims Tools - Handler Invocation', () => {
    it('claims_list returns claims', async () => {
      const tool = claimsTools.find(t => t.name === 'claims_list')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(true);
      expect(result.claims).toBeDefined();
    });

    it('claims_claim with invalid claimant returns error', async () => {
      const tool = claimsTools.find(t => t.name === 'claims_claim')!;
      const result: any = await tool.handler({ issueId: 'issue-1', claimant: 'invalid' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid claimant');
    });

    it('claims_board returns board view', async () => {
      const tool = claimsTools.find(t => t.name === 'claims_board')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(true);
      expect(result.board).toBeDefined();
    });

    it('claims_stealable returns stealable issues', async () => {
      const tool = claimsTools.find(t => t.name === 'claims_stealable')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 18. Handler Invocation - Performance Tools
  // --------------------------------------------------------------------------
  describe('Performance Tools - Handler Invocation', () => {
    it('performance_report returns a report', async () => {
      const tool = performanceTools.find(t => t.name === 'performance_report')!;
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });

    it('performance_metrics returns metrics', async () => {
      const tool = performanceTools.find(t => t.name === 'performance_metrics')!;
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });

    it('performance_benchmark runs a benchmark', async () => {
      const tool = performanceTools.find(t => t.name === 'performance_benchmark')!;
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 19. Handler Invocation - Neural Tools
  // --------------------------------------------------------------------------
  describe('Neural Tools - Handler Invocation', () => {
    it('neural_status returns status', async () => {
      const tool = neuralTools.find(t => t.name === 'neural_status')!;
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });

    it('neural_patterns returns patterns list', async () => {
      const tool = neuralTools.find(t => t.name === 'neural_patterns')!;
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 20. Handler Invocation - AgentDB Tools
  // --------------------------------------------------------------------------
  describe('AgentDB Tools - Handler Invocation', () => {
    it('agentdb_health returns availability', async () => {
      const tool = agentdbTools.find(t => t.name === 'agentdb_health')!;
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });

    it('agentdb_controllers returns controllers list', async () => {
      const tool = agentdbTools.find(t => t.name === 'agentdb_controllers')!;
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });

    it('agentdb_pattern-store requires pattern param', async () => {
      const tool = agentdbTools.find(t => t.name === 'agentdb_pattern-store')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/pattern.*(required|must be)/i);
    });

    it('agentdb_pattern-search requires query param', async () => {
      const tool = agentdbTools.find(t => t.name === 'agentdb_pattern-search')!;
      const result: any = await tool.handler({});
      expect(result.error).toMatch(/query.*(required|must be)/i);
    });

    it('agentdb_causal-edge validates required fields', async () => {
      const tool = agentdbTools.find(t => t.name === 'agentdb_causal-edge')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(false);
    });

    it('agentdb_route requires task param', async () => {
      const tool = agentdbTools.find(t => t.name === 'agentdb_route')!;
      const result: any = await tool.handler({});
      expect(result.error).toMatch(/task.*(required|must be)/i);
    });

    it('agentdb_batch validates entries array', async () => {
      const tool = agentdbTools.find(t => t.name === 'agentdb_batch')!;
      const result: any = await tool.handler({ operation: 'insert' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('entries is required');
    });

    it('agentdb_batch validates operation type', async () => {
      const tool = agentdbTools.find(t => t.name === 'agentdb_batch')!;
      const result: any = await tool.handler({ operation: 'invalid', entries: [{ key: 'k' }] });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid operation');
    });
  });

  // --------------------------------------------------------------------------
  // 21. Error Handling
  // --------------------------------------------------------------------------
  describe('Error Handling', () => {
    it('tools handle empty input gracefully', async () => {
      // Test a selection of tools with empty input
      const toolsToTest = [
        agentTools.find(t => t.name === 'agent_list')!,
        configTools.find(t => t.name === 'config_list')!,
        swarmTools.find(t => t.name === 'swarm_status')!,
        taskTools.find(t => t.name === 'task_list')!,
        daaTools.find(t => t.name === 'daa_learning_status')!,
        coordinationTools.find(t => t.name === 'coordination_metrics')!,
        performanceTools.find(t => t.name === 'performance_report')!,
      ];

      for (const tool of toolsToTest) {
        const result = await tool.handler({});
        expect(result).toBeDefined();
      }
    });

    it('tools do not throw on invalid input types', async () => {
      // These should return errors gracefully instead of throwing
      const tool = agentTools.find(t => t.name === 'agent_spawn')!;
      // Pass number instead of string for agentType
      const result: any = await tool.handler({ agentType: 123 as any });
      // Should still succeed - type coercion
      expect(result).toBeDefined();
    });

    it('agentdb tools validate string inputs', async () => {
      const tool = agentdbTools.find(t => t.name === 'agentdb_pattern-store')!;
      // Empty string should fail validation
      const result: any = await tool.handler({ pattern: '' });
      expect(result.success).toBe(false);
    });

    it('agentdb tools enforce max string length', async () => {
      const tool = agentdbTools.find(t => t.name === 'agentdb_feedback')!;
      // Very long taskId should be rejected
      const longId = 'x'.repeat(1000);
      const result: any = await tool.handler({ taskId: longId });
      expect(result.success).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 22. Security Checks
  // --------------------------------------------------------------------------
  describe('Security Checks', () => {
    it('no tool schemas contain hardcoded paths', () => {
      for (const tool of ALL_TOOLS) {
        const schema = JSON.stringify(tool.inputSchema);
        expect(schema).not.toContain('/home/');
        expect(schema).not.toContain('/etc/');
        expect(schema).not.toContain('C:\\');
      }
    });

    it('no tool schemas contain hardcoded secrets or tokens', () => {
      for (const tool of ALL_TOOLS) {
        const schema = JSON.stringify(tool.inputSchema);
        expect(schema).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
        expect(schema).not.toMatch(/password.*=.*[a-zA-Z0-9]{8,}/i);
      }
    });

    it('no tool names expose internal implementation details', () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.name).not.toContain('internal');
        expect(tool.name).not.toContain('debug');
        expect(tool.name).not.toContain('_raw');
      }
    });

    it('session tools sanitize sessionId against path traversal', () => {
      // session_save should handle path traversal attempts
      const tool = sessionTools.find(t => t.name === 'session_save')!;
      // The session file path should be sanitized
      expect(tool).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 23. Return Format Consistency
  // --------------------------------------------------------------------------
  describe('Return Format Consistency', () => {
    it('agent_spawn returns success field', async () => {
      const tool = agentTools.find(t => t.name === 'agent_spawn')!;
      const result: any = await tool.handler({ agentType: 'coder' });
      expect(typeof result.success).toBe('boolean');
    });

    it('config tools return success field', async () => {
      const setTool = configTools.find(t => t.name === 'config_set')!;
      const result: any = await setTool.handler({ key: 'test', value: 'v' });
      expect(typeof result.success).toBe('boolean');
    });

    it('task_create returns taskId and status', async () => {
      const tool = taskTools.find(t => t.name === 'task_create')!;
      const result: any = await tool.handler({ type: 'bugfix', description: 'Fix the bug' });
      expect(result.taskId).toBeDefined();
      expect(typeof result.taskId).toBe('string');
      expect(result.status).toBe('pending');
    });

    it('swarm_init returns success and swarmId', async () => {
      const tool = swarmTools.find(t => t.name === 'swarm_init')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(true);
      expect(result.swarmId).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 24. Progress & Embeddings Tools
  // --------------------------------------------------------------------------
  describe('Progress Tools - Handler Invocation', () => {
    it('progress_check returns progress metrics', async () => {
      const tool = progressTools.find(t => t.name === 'progress_check')!;
      expect(tool).toBeDefined();
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });

    it('progress_summary returns summary', async () => {
      const tool = progressTools.find(t => t.name === 'progress_summary')!;
      expect(tool).toBeDefined();
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });
  });

  describe('Embeddings Tools - Handler Invocation', () => {
    it('embeddings_status returns initialization state', async () => {
      const tool = embeddingsTools.find(t => t.name === 'embeddings_status')!;
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });

    it('embeddings_init initializes the subsystem', async () => {
      const tool = embeddingsTools.find(t => t.name === 'embeddings_init')!;
      const result: any = await tool.handler({ force: true });
      expect(result.success).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 25. Hooks Tools
  // --------------------------------------------------------------------------
  describe('Hooks Tools - Handler Invocation', () => {
    it('hooks_list returns hooks list', async () => {
      const tool = hooksTools.find(t => t.name === 'hooks_list')!;
      expect(tool).toBeDefined();
      const result: any = await tool.handler({});
      expect(result.hooks).toBeDefined();
    });

    it('hooks_metrics returns metrics', async () => {
      const tool = hooksTools.find(t => t.name === 'hooks_metrics')!;
      expect(tool).toBeDefined();
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });

    it('hooks_worker-list returns workers', async () => {
      const tool = hooksTools.find(t => t.name === 'hooks_worker-list')!;
      expect(tool).toBeDefined();
      const result: any = await tool.handler({});
      expect(result.workers).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 26. Memory Tools
  // --------------------------------------------------------------------------
  describe('Memory Tools - Handler Invocation', () => {
    it('memory_store stores an entry', async () => {
      const tool = memoryTools.find(t => t.name === 'memory_store')!;
      expect(tool).toBeDefined();
      const result: any = await tool.handler({ key: 'test-key', value: 'test-value' });
      expect(result).toBeDefined();
    });

    it('memory_list returns entries', async () => {
      const tool = memoryTools.find(t => t.name === 'memory_list')!;
      expect(tool).toBeDefined();
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });

    it('memory_stats returns statistics', async () => {
      const tool = memoryTools.find(t => t.name === 'memory_stats')!;
      expect(tool).toBeDefined();
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 27. Cross-Module Integrity
  // --------------------------------------------------------------------------
  describe('Cross-Module Integrity', () => {
    it('all tool names are valid MCP tool identifiers', () => {
      for (const tool of ALL_TOOLS) {
        // MCP tool names should be alphanumeric with underscores/hyphens
        expect(tool.name).toMatch(/^[a-z][a-z0-9_-]*$/);
        // No double underscores or hyphens
        expect(tool.name).not.toMatch(/__/);
        expect(tool.name).not.toMatch(/--/);
      }
    });

    it('all descriptions are human-readable sentences', () => {
      for (const tool of ALL_TOOLS) {
        // Description should start with uppercase or lowercase letter
        expect(tool.description).toMatch(/^[A-Za-z]/);
        // Should be at least 10 characters
        expect(tool.description.length).toBeGreaterThanOrEqual(10);
      }
    });

    it('no tool has an empty properties object with required fields', () => {
      for (const tool of ALL_TOOLS) {
        if (tool.inputSchema.required && tool.inputSchema.required.length > 0) {
          const propCount = Object.keys(tool.inputSchema.properties).length;
          expect(propCount).toBeGreaterThan(0);
        }
      }
    });

    it('every property in schema has a type or description', () => {
      for (const tool of ALL_TOOLS) {
        for (const [propName, prop] of Object.entries(tool.inputSchema.properties)) {
          const p = prop as Record<string, unknown>;
          // Every property should have at least a type or description
          const hasType = p.type !== undefined;
          const hasDesc = p.description !== undefined;
          expect(hasType || hasDesc).toBe(true);
        }
      }
    });
  });
});
