/**
 * V3 CLI MCP Client
 *
 * Thin wrapper for calling MCP tools from CLI commands.
 * Implements ADR-005: MCP-First API Design - CLI as thin wrapper around MCP tools
 *
 * This provides a simple interface for CLI commands to call MCP tools without
 * containing hardcoded business logic. All business logic lives in MCP tool handlers.
 */

import type { MCPTool } from './mcp-tools/types.js';

// Import MCP tool handlers from local package
import { agentTools } from './mcp-tools/agent-tools.js';
import { swarmTools } from './mcp-tools/swarm-tools.js';
import { memoryTools } from './mcp-tools/memory-tools.js';
import { configTools } from './mcp-tools/config-tools.js';
import { hooksTools } from './mcp-tools/hooks-tools.js';
import { taskTools } from './mcp-tools/task-tools.js';
import { sessionTools } from './mcp-tools/session-tools.js';
import { hiveMindTools } from './mcp-tools/hive-mind-tools.js';
import { workflowTools } from './mcp-tools/workflow-tools.js';
import { analyzeTools } from './mcp-tools/analyze-tools.js';
import { progressTools } from './mcp-tools/progress-tools.js';
import { embeddingsTools } from './mcp-tools/embeddings-tools.js';
import { claimsTools } from './mcp-tools/claims-tools.js';
import { policyTools } from './mcp-tools/policy-tools.js';
import { authorizeMcpTool, classifyMcpTool } from './services/policy-runtime.js';
import { securityTools } from './mcp-tools/security-tools.js';
import { transferTools } from './mcp-tools/transfer-tools.js';
// V2 Compatibility tools
import { systemTools } from './mcp-tools/system-tools.js';
import { terminalTools } from './mcp-tools/terminal-tools.js';
import { neuralTools } from './mcp-tools/neural-tools.js';
import { performanceTools } from './mcp-tools/performance-tools.js';
import { githubTools } from './mcp-tools/github-tools.js';
import { daaTools } from './mcp-tools/daa-tools.js';
import { coordinationTools } from './mcp-tools/coordination-tools.js';
import { browserTools } from './mcp-tools/browser-tools.js';
import { browserSessionTools } from './mcp-tools/browser-session-tools.js';
// ADR-175 — page-agent natural-language intent layer (browser_act). Always
// registered; degrades to {degraded:true} at call time when page-agent or an
// OpenAI-compatible LLM provider isn't available.
import { browserIntentTools } from './mcp-tools/browser-intent-tools.js';
import { execFileSync } from 'node:child_process';
// Phase 6: AgentDB v3 controller tools
import { agentdbTools } from './mcp-tools/agentdb-tools.js';
// RuVector WASM tools
import { ruvllmWasmTools } from './mcp-tools/ruvllm-tools.js';
import { wasmAgentTools } from './mcp-tools/wasm-agent-tools.js';
// ADR-115: Anthropic Claude Managed Agents — a cloud agent runtime alongside
// the local WASM-sandboxed `wasm_agent_*` (rvagent) tools. Lives in the
// `ruflo-agent` plugin.
import { managedAgentTools } from './mcp-tools/managed-agent-tools.js';
import {
  configureGuidanceToolProvider,
  guidanceTools,
} from './mcp-tools/guidance-tools.js';
import { autopilotTools } from './mcp-tools/autopilot-tools.js';
// ADR-150 — MetaHarness MCP tools (score / genome / mcp-scan / threat-model / oia-audit)
import { metaharnessTools } from './mcp-tools/metaharness-tools.js';
// agenticow@~0.2.3 — Copy-On-Write memory branching tools (162-byte branches);
// optional runtime dep, every handler returns `{degraded: true}` when missing.
import { agenticowTools } from './mcp-tools/agenticow-tools.js';
// agenticow step 4 — speculative branch-and-promote (A/B memory exploration).
// Optional runtime dep, degrades to `{degraded: true}` when agenticow is missing.
import { agenticowSpeculateTools } from './mcp-tools/agenticow-speculate-tools.js';
// ADR-164 — AgentBBS federated business-domain BBS rooms (Phase 1).
// Optional runtime dep, every handler returns `{degraded: true}` when missing.
import { agentbbsTools } from './mcp-tools/agentbbs-tools.js';
import { xFederationTools } from './mcp-tools/x-federation-tools.js';
import { seraphinaTools } from './mcp-tools/seraphina-tools.js';
import { xFederationJoinTools } from './mcp-tools/x-federation-join.js';
import { xFederationChannelTools } from './mcp-tools/x-federation-channels.js';
// ADR-164 Phase 2 — Business-pod template validation (pure local, no optional deps).
import { businessPodTools } from './mcp-tools/business-pod-tools.js';
// ADR-164 Phase 4 §5.1.8 — http_fetch MCP tool (secure-by-default HTTP probe
// for ops-pod synthetic-endpoint benches). Default-rejects private addresses
// + auth headers; opt-in via CLAUDE_FLOW_HTTP_FETCH_ALLOW_PRIVATE / _AUTH=1.
import { httpFetchTools } from './mcp-tools/http-fetch-tools.js';
// #1916: coverage-aware routing tools — defined in ruvector/coverage-tools.ts
// but were never registered, so the `ruflo hooks coverage-*` CLI subcommands
// failed with `Tool not found: hooks_coverage-route`.
import { coverageRouterTools } from './ruvector/coverage-tools.js';

// #1605: Only register browser tools if agent-browser is available
let _browserAvailable: boolean | null = null;
function getBrowserTools(): MCPTool[] {
  if (_browserAvailable === null) {
    try {
      execFileSync('agent-browser', ['--version'], { stdio: 'ignore', timeout: 3000 });
      _browserAvailable = true;
    } catch {
      _browserAvailable = false;
    }
  }
  return _browserAvailable ? browserTools : [];
}

/**
 * Lifecycle MCP tools for ruflo-browser session-as-skill architecture
 * (ADR-0001 ruflo-browser §7). Always registered: their handlers shell out
 * to ruvector + agent-browser + claude-flow memory and degrade gracefully
 * when those CLIs are missing.
 */
function getBrowserSessionTools(): MCPTool[] {
  return browserSessionTools;
}

/**
 * ADR-175 `browser_act` — always registered like browserSessionTools; the
 * handler itself resolves page-agent + LLM-provider availability at call
 * time and returns `{degraded: true}` rather than throwing.
 */
function getBrowserIntentTools(): MCPTool[] {
  return browserIntentTools;
}

/**
 * MCP Tool Registry
 * Maps tool names to their handler functions
 */
const TOOL_REGISTRY = new Map<string, MCPTool>();

// Register all tools
function registerTools(tools: MCPTool[]): void {
  tools.forEach(tool => {
    TOOL_REGISTRY.set(tool.name, tool);
  });
}

// Initialize registry with all available tools
registerTools([
  ...agentTools,
  ...swarmTools,
  ...memoryTools,
  ...configTools,
  ...hooksTools,
  ...taskTools,
  ...sessionTools,
  ...hiveMindTools,
  ...workflowTools,
  ...analyzeTools,
  ...progressTools,
  ...embeddingsTools,
  ...claimsTools,
  // Remote MCP exposes evaluation/status only. Administrative mutation is a
  // local CLI bootstrap/recovery operation until the server has authenticated
  // human identity propagation.
  ...policyTools.filter((tool) => ['policy_evaluate', 'policy_status'].includes(tool.name)),
  ...securityTools,
  ...transferTools,
  // V2 Compatibility tools
  ...systemTools,
  ...terminalTools,
  ...neuralTools,
  ...performanceTools,
  ...githubTools,
  ...daaTools,
  ...coordinationTools,
  ...getBrowserTools(),
  ...getBrowserSessionTools(),
  ...getBrowserIntentTools(),
  // Phase 6: AgentDB v3 controller tools
  ...agentdbTools,
  // RuVector WASM tools
  ...ruvllmWasmTools,
  ...wasmAgentTools,
  // ADR-115: Anthropic Claude Managed Agents (cloud agent runtime)
  ...managedAgentTools,
  // Guidance & discovery tools
  ...guidanceTools,
  // Autopilot persistent completion tools
  ...autopilotTools,
  // #1916: coverage-aware routing (hooks_coverage-route / -suggest / -gaps)
  ...coverageRouterTools,
  // ADR-150 — MetaHarness static-analysis tools (5)
  ...metaharnessTools,
  // agenticow@~0.2.4 — COW memory branching (9 tools: branch/checkpoint/rollback/promote + ingest/query/diff/lineage/status, graceful-degraded when missing)
  ...agenticowTools,
  // agenticow step 4 — speculative branch-and-promote (1 tool, graceful-degraded when missing)
  ...agenticowSpeculateTools,
  // ADR-164 — AgentBBS federated business-domain BBS rooms (4 tools, Phase 1, graceful-degraded)
  ...agentbbsTools,
  ...xFederationTools,
  ...seraphinaTools,
  ...xFederationJoinTools,
  ...xFederationChannelTools,
  // ADR-164 Phase 2 + Phase 3 — business_pod_validate + business_pod_route_backend
  // (2 tools, no optional dep — schema validator + §3.4 domain-affinity router)
  ...businessPodTools,
  // ADR-164 Phase 4 §5.1.8 — http_fetch (1 tool, secure-by-default HTTP probe)
  ...httpFetchTools,
]);

// The capability brain consumes the completed live registry. This is injected
// after registration to keep guidance honest and avoid a registry import cycle.
configureGuidanceToolProvider(() => Array.from(TOOL_REGISTRY.values()).map((tool) => ({
  name: tool.name,
  description: tool.description,
  category: tool.category,
  tags: tool.tags,
  version: tool.version,
})));

/**
 * MCP Client Error
 */
export class MCPClientError extends Error {
  constructor(
    message: string,
    public toolName: string,
    public cause?: Error
  ) {
    super(message);
    this.name = 'MCPClientError';
  }
}

/**
 * Call an MCP tool by name with input parameters
 *
 * @param toolName - Name of the MCP tool (e.g., 'agent_spawn', 'swarm_init')
 * @param input - Input parameters for the tool
 * @param context - Optional tool context
 * @returns Promise resolving to tool result
 * @throws {MCPClientError} If tool not found or execution fails
 *
 * @example
 * ```typescript
 * // Spawn an agent
 * const result = await callMCPTool('agent_spawn', {
 *   agentType: 'coder',
 *   priority: 'normal'
 * });
 *
 * // Initialize swarm
 * const swarm = await callMCPTool('swarm_init', {
 *   topology: 'hierarchical-mesh',
 *   maxAgents: 15
 * });
 * ```
 */
export async function callMCPTool<T = unknown>(
  toolName: string,
  input: Record<string, unknown> = {},
  context?: Record<string, unknown>
): Promise<T> {
  // Look up tool in registry
  const tool = TOOL_REGISTRY.get(toolName);

  if (!tool) {
    throw new MCPClientError(
      `MCP tool not found: ${toolName}`,
      toolName
    );
  }

  try {
    // ADR-324: one policy chokepoint for every local CLI/MCP invocation.
    // Policy administration is not exempt: authorization calls the engine
    // directly, so there is no recursive MCP dispatch. In enforce mode an
    // administrator must explicitly allow policy.* actions or use the local
    // CLI bootstrap path.
    const decision = await authorizeMcpTool(toolName, input, context, classifyMcpTool(toolName));
    if (decision.enforcedOutcome !== 'allowed') {
      throw new Error(`policy-${decision.enforcedOutcome}:${decision.reason}; receipt=${decision.receiptId}`);
    }
    // Call the tool handler
    const result = await tool.handler(input, context);
    // ADR-146 P2: scan every tool result for indirect-injection before it
    // returns to the caller. The screen is opt-in via env (default off in
    // 3.10.34 — flip to default in v4) so existing pipelines keep their
    // exact behaviour while the call site is exercised by tests and
    // adopters. Telemetry from the screen lands in the shared
    // GuardrailEvent sink (P5).
    return applyContentBoundaryGuardrail(toolName, result) as T;
  } catch (error) {
    // Wrap and re-throw with context
    throw new MCPClientError(
      `Failed to execute MCP tool '${toolName}': ${error instanceof Error ? error.message : String(error)}`,
      toolName,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * ADR-146 P2 — content-boundary screen on the MCP tool dispatch path.
 *
 * Default behaviour (3.10.34, legacy mode): returns the result unchanged.
 * With `CLAUDE_FLOW_STRICT_GUARDRAIL=true`, scans every string field of the
 * result; `reject` substitutes the field with a typed marker so the caller
 * can surface the rejection. The class itself (`ToolOutputGuardrail`)
 * shipped in ADR-131 P1; this call site is what closes #2149.
 *
 * Implementation note: we resolve the guardrail lazily so the cold-import
 * cost of `@claude-flow/security` does not hit every CLI invocation. Once
 * P5 wires structured telemetry, this also publishes a `GuardrailEvent`.
 */
let _guardrailInstance: { scanAndEnforce: (s: string) => { content: string; action: string; result: { severity: string; category: string; pattern: string } } } | null = null;
function applyContentBoundaryGuardrail(toolName: string, result: unknown): unknown {
  if (process.env.CLAUDE_FLOW_STRICT_GUARDRAIL !== 'true') return result;
  if (typeof result !== 'object' || result === null) return result;

  // Lazy-resolve the guardrail singleton to avoid hot-path import cost.
  if (_guardrailInstance === null) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sec = require('@claude-flow/security') as {
        createToolOutputGuardrail?: (cfg?: unknown) => typeof _guardrailInstance;
      };
      if (sec?.createToolOutputGuardrail) {
        _guardrailInstance = sec.createToolOutputGuardrail();
      } else {
        return result; // module shape unexpected — fail open
      }
    } catch {
      return result; // security package not installed in this consumer — fail open
    }
  }

  const guardrail = _guardrailInstance;
  if (!guardrail) return result;

  // Walk the result object one level deep. We do not deeply traverse because
  // most tool results are flat record shapes; deep recursion would change the
  // p99 latency contract. Hot strings tend to live at the top level.
  const out: Record<string, unknown> = {};
  let mutated = false;
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) {
      const decision = guardrail.scanAndEnforce(v);
      if (decision.action === 'reject') {
        out[k] = `<rejected-by-guardrail tool=${JSON.stringify(toolName)} category=${decision.result.category}>`;
        mutated = true;
        continue;
      }
      if (decision.action === 'redact') {
        out[k] = decision.content;
        mutated = true;
        continue;
      }
    }
    out[k] = v;
  }
  return mutated ? out : result;
}

/**
 * Get tool metadata by name
 *
 * @param toolName - Name of the MCP tool
 * @returns Tool metadata or undefined if not found
 */
export function getToolMetadata(toolName: string): Omit<MCPTool, 'handler'> | undefined {
  const tool = TOOL_REGISTRY.get(toolName);

  if (!tool) {
    return undefined;
  }

  // Return everything except the handler function
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    category: tool.category,
    tags: tool.tags,
    version: tool.version,
    cacheable: tool.cacheable,
    cacheTTL: tool.cacheTTL,
  };
}

/**
 * List all available MCP tools
 *
 * @param category - Optional category filter
 * @returns Array of tool metadata
 */
export function listMCPTools(category?: string): Array<Omit<MCPTool, 'handler'>> {
  const tools = Array.from(TOOL_REGISTRY.values());

  const filtered = category
    ? tools.filter(t => t.category === category)
    : tools;

  return filtered.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    category: tool.category,
    tags: tool.tags,
    version: tool.version,
    cacheable: tool.cacheable,
    cacheTTL: tool.cacheTTL,
  }));
}

/**
 * Check if an MCP tool exists
 *
 * @param toolName - Name of the MCP tool
 * @returns True if tool exists
 */
export function hasTool(toolName: string): boolean {
  return TOOL_REGISTRY.has(toolName);
}

/**
 * Get all tool categories
 *
 * @returns Array of unique categories
 */
export function getToolCategories(): string[] {
  const categories = new Set<string>();

  TOOL_REGISTRY.forEach(tool => {
    if (tool.category) {
      categories.add(tool.category);
    }
  });

  return Array.from(categories).sort();
}

/**
 * Validate tool input against schema
 *
 * @param toolName - Name of the MCP tool
 * @param input - Input to validate
 * @returns Validation result with errors if any
 */
export function validateToolInput(
  toolName: string,
  input: Record<string, unknown>
): { valid: boolean; errors?: string[] } {
  const tool = TOOL_REGISTRY.get(toolName);

  if (!tool) {
    return {
      valid: false,
      errors: [`Tool '${toolName}' not found`],
    };
  }

  // Basic validation - check required fields
  const schema = tool.inputSchema;
  const errors: string[] = [];

  if (schema.required && Array.isArray(schema.required)) {
    for (const requiredField of schema.required) {
      if (!(requiredField in input)) {
        errors.push(`Missing required field: ${requiredField}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export default {
  callMCPTool,
  getToolMetadata,
  listMCPTools,
  hasTool,
  getToolCategories,
  validateToolInput,
  MCPClientError,
};
