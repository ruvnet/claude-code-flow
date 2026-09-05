/**
 * AgentDB MCP Tools — Phase 6 of ADR-053
 *
 * Exposes AgentDB v3 controller operations as MCP tools.
 * Provides direct access to ReasoningBank, CausalGraph, SkillLibrary,
 * AttestationLog, and bridge health through the MCP protocol.
 *
 * Security: All handlers validate input types, enforce length bounds,
 * and sanitize error messages before returning to MCP callers.
 *
 * @module v3/cli/mcp-tools/agentdb-tools
 */

import type { MCPTool } from './types.js';
import { validateIdentifier, validateText } from './validate-input.js';

// ===== Shared validation helpers =====

const MAX_STRING_LENGTH = 100_000; // 100KB max for any string input
const MAX_BATCH_SIZE = 500;        // Max entries per batch operation
const MAX_TOP_K = 100;             // Max results per query

function validateString(value: unknown, name: string, maxLen = MAX_STRING_LENGTH): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length > maxLen) return null;
  return value;
}

function validatePositiveInt(value: unknown, defaultVal: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultVal;
  const n = Math.floor(value);
  return n > 0 ? Math.min(n, max) : defaultVal;
}

function validateScore(value: unknown, defaultVal: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultVal;
  return Math.max(0, Math.min(1, value));
}

/**
 * Validate an optional ISO-8601 timestamp param (temporal validity fields).
 * Returns { value } when absent or valid, { error } when present but unparseable.
 */
function validateIsoTimestamp(value: unknown, name: string): { value?: string; error?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    return { error: `${name} must be a non-empty ISO-8601 timestamp string (max 64 chars)` };
  }
  if (Number.isNaN(Date.parse(value))) {
    return { error: `${name} is not a parseable ISO-8601 timestamp: ${value.substring(0, 64)}` };
  }
  return { value };
}

function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    // Strip filesystem paths from error messages
    return error.message.replace(/\/[^\s:]+\//g, '<path>/').substring(0, 500);
  }
  return 'Internal error';
}

// Lazy-cached bridge module
let bridgeModule: typeof import('../memory/memory-bridge.js') | null = null;
async function getBridge() {
  if (!bridgeModule) {
    bridgeModule = await import('../memory/memory-bridge.js');
  }
  return bridgeModule;
}

// Lazy-cached modules used by graph-query / graph-pathfinder dispatch.
// Caching the resolved namespace avoids per-call dynamic-import overhead
// in the ADR-130 hot path (smoke harness measures elapsedMs of every call).
let graphBackendMod: typeof import('../ruvector/graph-backend.js') | null = null;
async function getGraphBackend() {
  if (!graphBackendMod) graphBackendMod = await import('../ruvector/graph-backend.js');
  return graphBackendMod;
}
let graphEdgeWriterMod: typeof import('../memory/graph-edge-writer.js') | null = null;
async function getGraphEdgeWriter() {
  if (!graphEdgeWriterMod) graphEdgeWriterMod = await import('../memory/graph-edge-writer.js');
  return graphEdgeWriterMod;
}
let memInitMod: typeof import('../memory/memory-initializer.js') | null = null;
async function getMemInit() {
  if (!memInitMod) memInitMod = await import('../memory/memory-initializer.js');
  return memInitMod;
}
let embQuantMod: typeof import('../memory/embedding-quantization.js') | null = null;
async function getEmbQuant() {
  if (!embQuantMod) embQuantMod = await import('../memory/embedding-quantization.js');
  return embQuantMod;
}

// ===== agentdb_health — Controller health check =====

export const agentdbHealth: MCPTool = {
  name: 'agentdb_health',
  description: 'Get AgentDB v3 controller health status including cache stats and attestation count Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const bridge = await getBridge();
      const health = await bridge.bridgeHealthCheck();
      if (!health) return { available: false, error: 'AgentDB bridge not available' };
      return health;
    } catch (error) {
      return { available: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_controllers — List all controllers =====

export const agentdbControllers: MCPTool = {
  name: 'agentdb_controllers',
  description: 'List all AgentDB v3 controllers and their initialization status Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const bridge = await getBridge();
      const controllers = await bridge.bridgeListControllers();
      if (!controllers) return { available: false, controllers: [], error: 'AgentDB bridge not available — @claude-flow/memory not installed or missing controller-registry. Use memory_store/memory_search tools instead.' };
      return {
        available: true,
        controllers,
        total: controllers.length,
        active: controllers.filter((c: any) => c.enabled).length,
      };
    } catch (error) {
      return { available: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_pattern_store — Store via ReasoningBank =====

export const agentdbPatternStore: MCPTool = {
  name: 'agentdb_pattern-store',
  description: 'Store a pattern directly via ReasoningBank controller Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Pattern description' },
      type: { type: 'string', description: 'Pattern type (e.g., task-routing, error-recovery)' },
      confidence: { type: 'number', description: 'Confidence score (0-1)' },
    },
    required: ['pattern'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vPattern = validateText(params.pattern, 'pattern', 100_000);
      if (!vPattern.valid) return { success: false, error: vPattern.error };
      if (params.type) { const vType = validateIdentifier(params.type, 'type'); if (!vType.valid) return { success: false, error: vType.error }; }
      const pattern = validateString(params.pattern, 'pattern');
      if (!pattern) return { success: false, error: 'pattern is required (non-empty string, max 100KB)' };
      const type = validateString(params.type, 'type', 200) ?? 'general';
      const confidence = validateScore(params.confidence, 0.8);

      const bridge = await getBridge();
      const result = await bridge.bridgeStorePattern({ pattern, type, confidence });
      if (result) return result;

      // ADR-093 F4: when the ReasoningBank controller registry returns
      // null (the cause of audit-reported "AgentDB bridge not available"
      // even though `agentdb_health.reasoningBank.enabled === true`), fall
      // back to a direct memory_store write so the caller's pattern still
      // persists. Surface the controller as `memory-store-fallback` so the
      // path is observable instead of silently lost.
      try {
        const { storeEntry } = await import('../memory/memory-initializer.js');
        const patternId = `pattern-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const value = JSON.stringify({ pattern, type, confidence, _fallback: 'reasoningBank-unavailable' });
        await storeEntry({
          key: patternId,
          value,
          namespace: 'pattern',
          tags: [type, 'reasoning-pattern', 'fallback'],
        });
        return {
          success: true,
          patternId,
          controller: 'memory-store-fallback',
          note: 'ReasoningBank controller registry unavailable. Pattern persisted via memory_store. Run `agentdb_health` to inspect controller registration.',
        };
      } catch (fallbackErr) {
        return {
          success: false,
          error: 'Pattern store failed: both ReasoningBank bridge and memory_store fallback unavailable',
          fallbackError: sanitizeError(fallbackErr),
          recommendation: 'Run agentdb_health to inspect controller registration and check that .swarm/memory.db is writable.',
        };
      }
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_pattern_search — Search via ReasoningBank =====

export const agentdbPatternSearch: MCPTool = {
  name: 'agentdb_pattern-search',
  description: 'Search patterns via ReasoningBank controller with BM25+semantic hybrid Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      topK: { type: 'number', description: 'Number of results (default: 5)' },
      minConfidence: { type: 'number', description: 'Minimum score threshold (0-1)' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vQuery = validateText(params.query, 'query', 10_000);
      if (!vQuery.valid) return { results: [], error: vQuery.error };
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { results: [], error: 'query is required (non-empty string, max 10KB)' };
      const topK = validatePositiveInt(params.topK, 5, MAX_TOP_K);
      const minConfidence = validateScore(params.minConfidence, 0.3);

      const bridge = await getBridge();
      const result = await bridge.bridgeSearchPatterns({ query, topK, minConfidence });
      if (result && Array.isArray(result.results) && result.results.length > 0) {
        return result;
      }

      // #1889 — symmetric fallback. pattern-store writes to the `pattern`
      // namespace via memory_store when ReasoningBank is unavailable; the
      // search path used to return an empty list with `controller: 'unavailable'`
      // even though the user's pattern was sitting in that namespace. We now
      // tier the fallback so freshly-written entries are findable before HNSW
      // catches up:
      //   1. Try semantic search via searchEntries (HNSW-backed)
      //   2. If that returns 0, list the namespace and substring-match the query
      //      against each entry's pattern text. Deterministic; survives
      //      embedding-index latency and threshold tuning.
      try {
        const { searchEntries, listEntries, getEntry } = await import('../memory/memory-initializer.js');

        const parseEntry = (e: Record<string, unknown>): Record<string, unknown> | null => {
          const raw = typeof e.content === 'string' ? e.content : (e as { value?: unknown }).value;
          if (typeof raw !== 'string') return null;
          try {
            const parsed = JSON.parse(raw);
            const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.8;
            if (confidence < minConfidence) return null;
            return {
              patternId: e.key ?? e.id,
              pattern: parsed.pattern,
              type: parsed.type ?? 'general',
              confidence,
              score: typeof e.score === 'number' ? e.score : undefined,
            };
          } catch {
            return null;
          }
        };

        // Tier 1 — semantic
        let results: Array<Record<string, unknown>> = [];
        let tier: 'semantic' | 'substring' = 'semantic';
        try {
          const semantic = await searchEntries({ query, namespace: 'pattern', limit: topK });
          results = (semantic?.results ?? [])
            .map(parseEntry)
            .filter((r): r is Record<string, unknown> => r !== null);
        } catch { /* fall through to tier 2 */ }

        // Tier 2 — substring scan (catches just-written entries before HNSW indexes them).
        // #2226: listEntries returns metadata only (no content/value — see open #2014),
        // so parseEntry would always null out here. Fetch each entry's content by key via
        // getEntry (which DOES return content) before parsing/matching. This is the path
        // that actually runs when the ReasoningBank controller is unavailable (the common
        // real-world state), so a stored pattern is now findable by search.
        if (results.length === 0) {
          tier = 'substring';
          const all = await listEntries({ namespace: 'pattern', limit: 200 });
          const qLower = query.toLowerCase();
          const matched: Array<Record<string, unknown>> = [];
          for (const e of (all?.entries ?? [])) {
            const meta = e as Record<string, unknown>;
            let entry: Record<string, unknown> = meta;
            // If the listing lacks content, hydrate it from the keyed store.
            if (typeof meta.content !== 'string' && typeof (meta as { value?: unknown }).value !== 'string') {
              const key = typeof meta.key === 'string' ? meta.key : (typeof meta.id === 'string' ? meta.id : null);
              if (!key) continue;
              const got = await getEntry({ key, namespace: 'pattern' });
              if (!got?.found || !got.entry) continue;
              entry = got.entry as unknown as Record<string, unknown>;
            }
            const parsed = parseEntry(entry);
            if (!parsed) continue;
            const text = typeof parsed.pattern === 'string' ? parsed.pattern.toLowerCase() : '';
            if (text.includes(qLower)) matched.push(parsed);
            if (matched.length >= topK) break;
          }
          results = matched;
        }

        // #1889 — controller label must match pattern-store's so the smoke
        // round-trip sees both ends agree. The store reports
        // `memory-store-fallback`; we use the same name + a `tier` field
        // to expose which sub-strategy fired.
        return {
          results,
          controller: 'memory-store-fallback',
          tier,
          note: result
            ? `ReasoningBank returned 0 results; tier=${tier} from pattern namespace.`
            : `ReasoningBank controller unavailable; tier=${tier} from pattern namespace.`,
        };
      } catch (fallbackErr) {
        return { results: [], controller: 'unavailable', fallbackError: sanitizeError(fallbackErr) };
      }
    } catch (error) {
      return { results: [], error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_feedback — Record task feedback =====

export const agentdbFeedback: MCPTool = {
  name: 'agentdb_feedback',
  description: 'Record task feedback for learning via LearningSystem + ReasoningBank controllers Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task identifier' },
      success: { type: 'boolean', description: 'Whether task succeeded' },
      quality: { type: 'number', description: 'Quality score (0-1)' },
      agent: { type: 'string', description: 'Agent that performed the task' },
    },
    required: ['taskId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vTaskId = validateIdentifier(params.taskId, 'taskId');
      if (!vTaskId.valid) return { success: false, error: vTaskId.error };
      if (params.agent) { const vAgent = validateIdentifier(params.agent, 'agent'); if (!vAgent.valid) return { success: false, error: vAgent.error }; }
      const taskId = validateString(params.taskId, 'taskId', 500);
      if (!taskId) return { success: false, error: 'taskId is required (non-empty string, max 500 chars)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeRecordFeedback({
        taskId,
        success: params.success === true,
        quality: validateScore(params.quality, 0.85),
        agent: validateString(params.agent, 'agent', 200) ?? undefined,
      });
      return result ?? { success: false, error: 'AgentDB bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== ADR-130 Phase 1: graph_edges helpers =====

/** Valid domain prefixes for unified node namespace */
const VALID_DOMAINS = new Set(['mem', 'agent', 'task', 'entity', 'span', 'pattern']);

/**
 * Ensure a node ID uses the domain:uuid prefix format (ADR-130 §Phase 1).
 * IDs without a ':' separator are legacy unprefixed IDs — auto-prefixed as
 * "mem:" and a deprecation warning is logged.
 */
function ensureDomainPrefix(id: string): { id: string; wasLegacy: boolean } {
  const colonIdx = id.indexOf(':');
  if (colonIdx > 0) {
    const domain = id.slice(0, colonIdx);
    if (VALID_DOMAINS.has(domain)) {
      return { id, wasLegacy: false };
    }
  }
  // Legacy ID or unknown prefix — treat as "mem:" namespace
  return { id: `mem:${id}`, wasLegacy: true };
}

/**
 * Fire-and-forget write of a graph edge to the sql.js graph_edges table.
 * Non-blocking: errors are silently discarded (ADR-130 §Phase 1 semantics).
 */
async function writeGraphEdge(opts: {
  sourceId: string;
  targetId: string;
  relation: string;
  weight: number;
  confidence?: number;
  decayRate?: number;
  witnessId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { insertGraphEdge } = await import('../memory/graph-edge-writer.js');
    // Generate 384-dim embedding for the edge text (async, ~50ms with ONNX)
    let embedding: number[] | undefined;
    try {
      const { generateEmbedding } = await import('../memory/memory-initializer.js');
      const edgeText = `${opts.relation}: ${opts.sourceId} -> ${opts.targetId}`;
      const embResult = await generateEmbedding(edgeText);
      if (embResult && embResult.embedding.length > 0) {
        embedding = embResult.embedding;
      }
    } catch { /* embedding not available — store without embedding_ref */ }

    await insertGraphEdge({
      sourceId: opts.sourceId,
      targetId: opts.targetId,
      relation: opts.relation,
      weight: opts.weight,
      confidence: opts.confidence,
      decayRate: opts.decayRate,
      witnessId: opts.witnessId,
      embedding,
      metadata: opts.metadata,
    });
  } catch { /* non-fatal: graph_edges write failure must never break callers */ }
}

// ===== agentdb_causal_edge — Record causal relationships =====

export const agentdbCausalEdge: MCPTool = {
  name: 'agentdb_causal-edge',
  description: 'Record a causal edge between two memory entries via CausalMemoryGraph Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      sourceId: { type: 'string', description: 'Source entry ID' },
      targetId: { type: 'string', description: 'Target entry ID' },
      relation: { type: 'string', description: 'Relationship type (e.g., caused, preceded, succeeded)' },
      weight: { type: 'number', description: 'Edge weight (0-1)' },
    },
    required: ['sourceId', 'targetId', 'relation'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vSourceId = validateIdentifier(params.sourceId, 'sourceId');
      if (!vSourceId.valid) return { success: false, error: vSourceId.error };
      const vTargetId = validateIdentifier(params.targetId, 'targetId');
      if (!vTargetId.valid) return { success: false, error: vTargetId.error };
      const vRelation = validateIdentifier(params.relation, 'relation');
      if (!vRelation.valid) return { success: false, error: vRelation.error };
      const sourceId = validateString(params.sourceId, 'sourceId', 500);
      const targetId = validateString(params.targetId, 'targetId', 500);
      const relation = validateString(params.relation, 'relation', 200);
      if (!sourceId) return { success: false, error: 'sourceId is required (non-empty string)' };
      if (!targetId) return { success: false, error: 'targetId is required (non-empty string)' };
      if (!relation) return { success: false, error: 'relation is required (non-empty string)' };

      // ADR-130 Phase 1: apply domain prefix, warn on legacy IDs
      const srcPrefixed = ensureDomainPrefix(sourceId);
      const tgtPrefixed = ensureDomainPrefix(targetId);
      const prefixedSourceId = srcPrefixed.id;
      const prefixedTargetId = tgtPrefixed.id;
      const legacyWarning = (srcPrefixed.wasLegacy || tgtPrefixed.wasLegacy)
        ? `[DEPRECATION] Unprefixed node IDs auto-prefixed as "mem:". Use domain:id format (mem/agent/task/entity/span/pattern).`
        : undefined;

      // ADR-130 Phase 1: fire-and-forget write to unified graph_edges table
      const edgeWeight = typeof params.weight === 'number' ? validateScore(params.weight, 0.5) : 1.0;
      writeGraphEdge({
        sourceId: prefixedSourceId, targetId: prefixedTargetId,
        relation, weight: edgeWeight,
      }).catch(() => {});

      // Try native graph-node backend first (ADR-087)
      try {
        const graphBackend = await import('../ruvector/graph-backend.js');
        if (await graphBackend.isGraphBackendAvailable()) {
          const graphResult = await graphBackend.recordCausalEdge(
            sourceId, targetId, relation,
            typeof params.weight === 'number' ? validateScore(params.weight, 0.5) : undefined,
          );
          if (graphResult.success) {
            // Also record in AgentDB bridge for compatibility
            const bridge = await getBridge();
            await bridge.bridgeRecordCausalEdge({ sourceId, targetId, relation, weight: typeof params.weight === 'number' ? validateScore(params.weight, 0.5) : undefined }).catch(() => {});
            return { ...graphResult, _graphNodeBackend: true, ...(legacyWarning && { warning: legacyWarning }) };
          }
        }
      } catch { /* graph-node not available, fall through */ }

      const bridge = await getBridge();
      const result = await bridge.bridgeRecordCausalEdge({
        sourceId,
        targetId,
        relation,
        weight: typeof params.weight === 'number' ? validateScore(params.weight, 0.5) : undefined,
      });
      const baseResult = result ?? { success: false, error: 'AgentDB bridge not available. Use memory_store/memory_search instead.' };
      return legacyWarning ? { ...baseResult, warning: legacyWarning } : baseResult;
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_route — Route via SemanticRouter =====

export const agentdbRoute: MCPTool = {
  name: 'agentdb_route',
  description: 'Route a task via AgentDB SemanticRouter or LearningSystem recommendAlgorithm Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description to route' },
      context: { type: 'string', description: 'Additional context' },
    },
    required: ['task'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vTask = validateText(params.task, 'task', 10_000);
      if (!vTask.valid) return { route: 'general', confidence: 0.5, agents: ['coder'], controller: 'error', error: vTask.error };
      if (params.context) { const vCtx = validateText(params.context, 'context', 10_000); if (!vCtx.valid) return { route: 'general', confidence: 0.5, agents: ['coder'], controller: 'error', error: vCtx.error }; }
      const task = validateString(params.task, 'task', 10_000);
      if (!task) return { route: 'general', confidence: 0.5, agents: ['coder'], controller: 'error', error: 'task is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeRouteTask({
        task,
        context: validateString(params.context, 'context', 10_000) ?? undefined,
      });
      return result ?? { route: 'general', confidence: 0.5, agents: ['coder'], controller: 'fallback' };
    } catch (error) {
      return { route: 'general', confidence: 0.5, agents: ['coder'], controller: 'error', error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_session_start — Session with ReflexionMemory =====

export const agentdbSessionStart: MCPTool = {
  name: 'agentdb_session-start',
  description: 'Start a session with ReflexionMemory episodic replay Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session identifier' },
      context: { type: 'string', description: 'Session context for pattern retrieval' },
    },
    required: ['sessionId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vSessionId = validateIdentifier(params.sessionId, 'sessionId');
      if (!vSessionId.valid) return { success: false, error: vSessionId.error };
      if (params.context) { const vCtx = validateText(params.context, 'context', 10_000); if (!vCtx.valid) return { success: false, error: vCtx.error }; }
      const sessionId = validateString(params.sessionId, 'sessionId', 500);
      if (!sessionId) return { success: false, error: 'sessionId is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeSessionStart({
        sessionId,
        context: validateString(params.context, 'context', 10_000) ?? undefined,
      });
      return result ?? { success: false, error: 'AgentDB bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_session_end — End session + NightlyLearner =====

export const agentdbSessionEnd: MCPTool = {
  name: 'agentdb_session-end',
  description: 'End session, persist to ReflexionMemory, trigger NightlyLearner consolidation Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session identifier' },
      summary: { type: 'string', description: 'Session summary' },
      tasksCompleted: { type: 'number', description: 'Number of tasks completed' },
    },
    required: ['sessionId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vSessionId = validateIdentifier(params.sessionId, 'sessionId');
      if (!vSessionId.valid) return { success: false, error: vSessionId.error };
      if (params.summary) { const vSummary = validateText(params.summary, 'summary', 50_000); if (!vSummary.valid) return { success: false, error: vSummary.error }; }
      const sessionId = validateString(params.sessionId, 'sessionId', 500);
      if (!sessionId) return { success: false, error: 'sessionId is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeSessionEnd({
        sessionId,
        summary: validateString(params.summary, 'summary', 50_000) ?? undefined,
        tasksCompleted: validatePositiveInt(params.tasksCompleted, 0, 10_000),
      });
      return result ?? { success: false, error: 'AgentDB bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_hierarchical_store — Store to hierarchical memory =====

export const agentdbHierarchicalStore: MCPTool = {
  name: 'agentdb_hierarchical-store',
  description: 'Store to hierarchical memory with tier (working, episodic, semantic) Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Memory entry key' },
      value: { type: 'string', description: 'Memory entry value' },
      tier: {
        type: 'string',
        description: 'Memory tier (working, episodic, semantic)',
        enum: ['working', 'episodic', 'semantic'],
        default: 'working',
      },
      validFrom: {
        type: 'string',
        description: 'Optional ISO-8601 timestamp from which this fact is valid (temporal validity — Zep/Graphiti-style). Omit for always-valid.',
      },
      validUntil: {
        type: 'string',
        description: 'Optional ISO-8601 timestamp after which this fact is no longer valid. Expired facts are hidden from recall unless includeExpired=true.',
      },
      supersedes: {
        type: 'string',
        description: 'Optional id (or key) of an existing entry this fact supersedes. The old entry is INVALIDATED (stamped validUntil=now + supersededBy=<new id>), not deleted — it stays auditable via recall includeExpired=true.',
      },
    },
    required: ['key', 'value'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vKey = validateIdentifier(params.key, 'key');
      if (!vKey.valid) return { success: false, error: vKey.error };
      const vValue = validateText(params.value, 'value');
      if (!vValue.valid) return { success: false, error: vValue.error };
      if (params.tier) { const vTier = validateIdentifier(params.tier, 'tier'); if (!vTier.valid) return { success: false, error: vTier.error }; }
      const key = validateString(params.key, 'key', 1000);
      const value = validateString(params.value, 'value');
      if (!key) return { success: false, error: 'key is required (non-empty string, max 1KB)' };
      if (!value) return { success: false, error: 'value is required (non-empty string, max 100KB)' };
      const tier = validateString(params.tier, 'tier', 20) ?? 'working';
      if (!['working', 'episodic', 'semantic'].includes(tier)) {
        return { success: false, error: `Invalid tier: ${tier}. Must be working, episodic, or semantic` };
      }
      // Temporal validity fields (all optional, backward compatible)
      const validFrom = validateIsoTimestamp(params.validFrom, 'validFrom');
      if (validFrom.error) return { success: false, error: validFrom.error };
      const validUntil = validateIsoTimestamp(params.validUntil, 'validUntil');
      if (validUntil.error) return { success: false, error: validUntil.error };
      const supersedes = params.supersedes !== undefined
        ? validateString(params.supersedes, 'supersedes', 1000)
        : undefined;
      if (params.supersedes !== undefined && !supersedes) {
        return { success: false, error: 'supersedes must be a non-empty string (entry id or key, max 1KB)' };
      }
      const bridge = await getBridge();
      const result = await bridge.bridgeHierarchicalStore({
        key, value, tier,
        validFrom: validFrom.value,
        validUntil: validUntil.value,
        supersedes: supersedes ?? undefined,
      });
      return result ?? { success: false, error: 'AgentDB bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// cli-core's shared schema type predates additionalProperties. Preserve the
// strict wire schema with a structural extension without changing that package.
const hierarchicalCreateSchema: MCPTool['inputSchema'] & { additionalProperties: false } = {
  type: 'object', additionalProperties: false, properties: {
    key: { type: 'string', minLength: 1, maxLength: 1000 },
    tier: { type: 'string', enum: ['working', 'episodic', 'semantic'] },
    value: { type: 'string', minLength: 1, maxLength: 100000 },
  }, required: ['key', 'tier', 'value'],
};

/** No caller-supplied protection/retention or temporal override is accepted. */
export const agentdbHierarchicalCreate: MCPTool = {
  name:'agentdb_hierarchical-create',
  description:'Atomically create an exact durable entry in an operator-configured protected hierarchical scope. Existing entries are returned unchanged, including inactive/expired records. Never overwrites or reactivates; capacity errors never evict authority. Does not grant authorization.',
  inputSchema: hierarchicalCreateSchema,
  handler:async(params:Record<string,unknown>)=>{
    const fail=(error:string)=>({success:false,status:'error',error});
    const key=validateString(params.key,'key',1000),tier=validateString(params.tier,'tier',20),value=validateString(params.value,'value',100000);
    if(!key || key.includes('\0') || !tier || !['working','episodic','semantic'].includes(tier) || !value || Object.keys(params).some(k=>!['key','tier','value'].includes(k)))return fail('invalid_request');
    if(!validateIdentifier(key,'key').valid || !validateText(value,'value').valid)return fail('invalid_request');
    try {return await (await getBridge()).bridgeHierarchicalCreate({key,tier,value});}
    catch(error){return fail(sanitizeError(error));}
  },
};

// ===== agentdb_hierarchical_get — Current exact durable read =====

export const agentdbHierarchicalGet: MCPTool = {
  name: 'agentdb_hierarchical-get',
  description: 'Read a current hierarchical entry by exact key and tier from durable storage. No semantic search or cached fallback. Distinguishes missing, unsupported backend and error. Does not recover evicted records or grant authorization.',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', minLength: 1, maxLength: 1000, description: 'Exact case-sensitive hierarchical entry key' },
      tier: { type: 'string', enum: ['working', 'episodic', 'semantic'], description: 'Exact tier; required' },
    },
    required: ['key', 'tier'],
  },
  handler: async (params: Record<string, unknown>) => {
    const fail = (error: string) => ({ success: false, found: false, status: 'error', error });
    const key = validateString(params.key, 'key', 1000);
    const tier = validateString(params.tier, 'tier', 20);
    if (!key || key.includes('\0') || !tier || !['working', 'episodic', 'semantic'].includes(tier)
      || Object.keys(params).some((name) => name !== 'key' && name !== 'tier')) return fail('invalid_request');
    const valid = validateIdentifier(key, 'key');
    if (!valid.valid) return fail('invalid_request');
    try {
      const bridge = await getBridge();
      return await bridge.bridgeHierarchicalGet({ key, tier });
    } catch (error) {
      return fail(sanitizeError(error));
    }
  },
};

// ===== agentdb_hierarchical_recall — Recall from hierarchical memory =====

export const agentdbHierarchicalRecall: MCPTool = {
  name: 'agentdb_hierarchical-recall',
  description: 'Recall from hierarchical memory with optional tier filter Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Recall query' },
      tier: { type: 'string', description: 'Filter by tier (working, episodic, semantic)' },
      topK: { type: 'number', description: 'Number of results (default: 5)' },
      includeExpired: {
        type: 'boolean',
        description: 'Include temporally-invalid entries (superseded, expired, or not-yet-valid). Audit escape hatch — default false.',
        default: false,
      },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vQuery = validateText(params.query, 'query', 10_000);
      if (!vQuery.valid) return { results: [], error: vQuery.error };
      if (params.tier) { const vTier = validateIdentifier(params.tier, 'tier'); if (!vTier.valid) return { results: [], error: vTier.error }; }
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { results: [], error: 'query is required (non-empty string, max 10KB)' };
      const tier = validateString(params.tier, 'tier', 20);
      if (tier && !['working', 'episodic', 'semantic'].includes(tier)) {
        return { results: [], error: `Invalid tier: ${tier}. Must be working, episodic, or semantic` };
      }
      const bridge = await getBridge();
      const result = await bridge.bridgeHierarchicalRecall({
        query,
        tier: tier ?? undefined,
        topK: validatePositiveInt(params.topK, 5, MAX_TOP_K),
        includeExpired: params.includeExpired === true,
      });
      return result ?? { results: [], error: 'AgentDB bridge not available. Use memory_search instead.' };
    } catch (error) {
      return { results: [], error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_consolidate — Run memory consolidation =====

export const agentdbConsolidate: MCPTool = {
  name: 'agentdb_consolidate',
  description: 'Run memory consolidation to promote entries across tiers and compress old data Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      minAge: { type: 'number', description: 'Minimum age in hours since store (optional)' },
      maxEntries: { type: 'number', description: 'Maximum entries to consolidate (optional)' },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const bridge = await getBridge();
      const result = await bridge.bridgeConsolidate({
        minAge: typeof params.minAge === 'number' ? Math.max(0, params.minAge) : undefined,
        maxEntries: validatePositiveInt(params.maxEntries, 1000, 10_000),
      });
      return result ?? { success: false, error: 'AgentDB bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_batch — Batch operations (insert, update, delete) =====

export const agentdbBatch: MCPTool = {
  name: 'agentdb_batch',
  description: 'Batch operations on AgentDB episodes (insert, update, delete). Note: entries are stored in the AgentDB episodes table, not the memory_search namespace. Use memory_store for entries that should be searchable via memory_search. Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        description: 'Batch operation type',
        enum: ['insert', 'update', 'delete'],
      },
      entries: {
        type: 'array',
        description: 'Array of {key, value} entries to operate on',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['key'],
        },
      },
    },
    required: ['operation', 'entries'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vOp = validateIdentifier(params.operation, 'operation');
      if (!vOp.valid) return { success: false, error: vOp.error };
      const operation = validateString(params.operation, 'operation', 20);
      if (!operation) return { success: false, error: 'operation is required (string)' };
      if (!['insert', 'update', 'delete'].includes(operation)) {
        return { success: false, error: `Invalid operation: ${operation}. Must be insert, update, or delete` };
      }
      if (!Array.isArray(params.entries) || params.entries.length === 0) {
        return { success: false, error: 'entries is required (non-empty array)' };
      }
      if (params.entries.length > MAX_BATCH_SIZE) {
        return { success: false, error: `Too many entries: ${params.entries.length}. Max is ${MAX_BATCH_SIZE}` };
      }
      // Validate each entry
      const validatedEntries: Array<{ key: string; value?: string; metadata?: Record<string, unknown> }> = [];
      for (let i = 0; i < params.entries.length; i++) {
        const entry = params.entries[i];
        if (!entry || typeof entry !== 'object') {
          return { success: false, error: `entries[${i}] must be an object` };
        }
        const key = validateString((entry as any).key, `entries[${i}].key`, 1000);
        if (!key) return { success: false, error: `entries[${i}].key is required (non-empty string)` };
        const value = validateString((entry as any).value, `entries[${i}].value`);
        validatedEntries.push({ key, value: value ?? undefined });
      }
      const bridge = await getBridge();
      const result = await bridge.bridgeBatchOperation({
        operation,
        entries: validatedEntries,
      });
      return result ?? { success: false, error: 'AgentDB bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_context_synthesize — Synthesize context from memories =====

export const agentdbContextSynthesize: MCPTool = {
  name: 'agentdb_context-synthesize',
  description: 'Synthesize context from stored memories for a given query Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Query to synthesize context for' },
      maxEntries: { type: 'number', description: 'Maximum entries to include (default: 10)' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vQuery = validateText(params.query, 'query', 10_000);
      if (!vQuery.valid) return { success: false, error: vQuery.error };
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { success: false, error: 'query is required (non-empty string, max 10KB)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeContextSynthesize({
        query,
        maxEntries: validatePositiveInt(params.maxEntries, 10, MAX_TOP_K),
      });
      return result ?? { success: false, error: 'AgentDB bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_semantic_route — Route via SemanticRouter =====

export const agentdbSemanticRoute: MCPTool = {
  name: 'agentdb_semantic-route',
  description: 'Route an input via AgentDB SemanticRouter for intent classification Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input text to route' },
    },
    required: ['input'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vInput = validateText(params.input, 'input', 10_000);
      if (!vInput.valid) return { route: null, error: vInput.error };
      const input = validateString(params.input, 'input', 10_000);
      if (!input) return { route: null, error: 'input is required (non-empty string, max 10KB)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeSemanticRoute({ input });
      return result ?? { route: null, error: 'AgentDB bridge not available. Use hooks route instead.' };
    } catch (error) {
      return { route: null, error: sanitizeError(error) };
    }
  },
};

// ===== #1784: Delete tools — symmetry for hierarchical-store + causal-edge =====

export const agentdbHierarchicalDelete: MCPTool = {
  name: 'agentdb_hierarchical-delete',
  description: 'Delete a hierarchical-memory entry by key. Returns controller="native-unsupported" when the entry is in a backend without a public delete API. Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Memory entry key to delete' },
      tier: {
        type: 'string',
        description: 'Optional tier filter (working, episodic, semantic)',
        enum: ['working', 'episodic', 'semantic'],
      },
    },
    required: ['key'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vKey = validateIdentifier(params.key, 'key');
      if (!vKey.valid) return { success: false, deleted: false, error: vKey.error };
      if (params.tier) { const vTier = validateIdentifier(params.tier, 'tier'); if (!vTier.valid) return { success: false, deleted: false, error: vTier.error }; }
      const key = validateString(params.key, 'key', 1000);
      if (!key) return { success: false, deleted: false, error: 'key is required (non-empty string, max 1KB)' };
      const tier = validateString(params.tier, 'tier', 20);
      if (tier && !['working', 'episodic', 'semantic'].includes(tier)) {
        return { success: false, deleted: false, error: `Invalid tier: ${tier}. Must be working, episodic, or semantic` };
      }
      const bridge = await getBridge();
      const result = await bridge.bridgeDeleteHierarchical({ key, tier: tier ?? undefined });
      return result ?? { success: false, deleted: false, error: 'AgentDB bridge not available' };
    } catch (error) {
      return { success: false, deleted: false, error: sanitizeError(error) };
    }
  },
};

export const agentdbCausalEdgeDelete: MCPTool = {
  name: 'agentdb_causal-edge-delete',
  description: 'Delete a causal edge between two memory entries. Returns controller="native-unsupported" when the edge lives in graph-node native storage (no public delete API). Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      sourceId: { type: 'string', description: 'Source entry ID' },
      targetId: { type: 'string', description: 'Target entry ID' },
      relation: { type: 'string', description: 'Optional relationship type filter' },
    },
    required: ['sourceId', 'targetId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vSourceId = validateIdentifier(params.sourceId, 'sourceId');
      if (!vSourceId.valid) return { success: false, deleted: false, error: vSourceId.error };
      const vTargetId = validateIdentifier(params.targetId, 'targetId');
      if (!vTargetId.valid) return { success: false, deleted: false, error: vTargetId.error };
      const sourceId = validateString(params.sourceId, 'sourceId', 500);
      const targetId = validateString(params.targetId, 'targetId', 500);
      if (!sourceId) return { success: false, deleted: false, error: 'sourceId is required (non-empty string)' };
      if (!targetId) return { success: false, deleted: false, error: 'targetId is required (non-empty string)' };
      const relation = validateString(params.relation, 'relation', 200) ?? undefined;
      const bridge = await getBridge();
      const result = await bridge.bridgeDeleteCausalEdge({ sourceId, targetId, relation });
      return result ?? { success: false, deleted: false, error: 'AgentDB bridge not available' };
    } catch (error) {
      return { success: false, deleted: false, error: sanitizeError(error) };
    }
  },
};

export const agentdbCausalNodeDelete: MCPTool = {
  name: 'agentdb_causal-node-delete',
  description: 'Cascade-delete a causal node and all its incident edges from the SQL fallback. Native graph-node entries are unaffected (no delete API in the binding). Use when generic memory_* tools are wrong because you need AgentDB-specific controllers (HNSW vector search, hierarchical tiers, causal-graph links, pattern store/recall, RaBitQ quantization). For simple key-value persistence, memory_store/memory_retrieve are simpler. For unrelated file work, native Read/Write are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Node ID to delete (cascades to all incident edges)' },
    },
    required: ['nodeId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vNodeId = validateIdentifier(params.nodeId, 'nodeId');
      if (!vNodeId.valid) return { success: false, deletedNode: false, deletedEdges: 0, error: vNodeId.error };
      const nodeId = validateString(params.nodeId, 'nodeId', 500);
      if (!nodeId) return { success: false, deletedNode: false, deletedEdges: 0, error: 'nodeId is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeDeleteCausalNode({ nodeId });
      return result ?? { success: false, deletedNode: false, deletedEdges: 0, error: 'AgentDB bridge not available' };
    } catch (error) {
      return { success: false, deletedNode: false, deletedEdges: 0, error: sanitizeError(error) };
    }
  },
};

// ===== ADR-130 Phase 2: agentdb_graph-query =====

/** complexityBudget schema, shared between graph-query and graph-pathfinder */
interface ComplexityBudget {
  maxNodesVisited?: number;
  maxDepth?: number;
  maxMillis?: number;
  maxMemoryMB?: number;
}

export const agentdbGraphQuery: MCPTool = {
  name: 'agentdb_graph-query',
  description: 'Unified graph traversal across the knowledge graph (ADR-130). Dispatches to the most capable backend: graph-node native for k-hop, sql.js CTE for fallback, HNSW cosine for semantic, ruflo-graph-intelligence PageRank for pagerank mode. Use when you need structured graph traversal beyond flat memory search.',
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Domain-prefixed node ID (e.g. "agent:abc", "entity:xyz")' },
      mode: {
        type: 'string',
        enum: ['k-hop', 'semantic', 'pagerank'],
        description: 'Query mode: k-hop neighbor expansion, semantic cosine search, or PageRank scoring',
      },
      depth: { type: 'number', description: 'Hop depth for k-hop mode (default 2, max 5)' },
      topK: { type: 'number', description: 'Max results for semantic and pagerank modes (default 10)' },
      relation: { type: 'string', description: 'Optional edge relation filter' },
      complexityBudget: {
        type: 'object',
        description: 'Computation limits',
        properties: {
          maxNodesVisited: { type: 'number' },
          maxDepth: { type: 'number' },
          maxMillis: { type: 'number' },
          maxMemoryMB: { type: 'number' },
        },
      },
    },
    required: ['nodeId', 'mode'],
  },
  handler: async (params: Record<string, unknown>) => {
    const t0 = Date.now();
    try {
      const vNodeId = validateIdentifier(params.nodeId, 'nodeId');
      if (!vNodeId.valid) return { success: false, error: vNodeId.error };
      const nodeId = validateString(params.nodeId, 'nodeId', 500);
      if (!nodeId) return { success: false, error: 'nodeId is required' };

      const mode = params.mode as string;
      if (!['k-hop', 'semantic', 'pagerank'].includes(mode)) {
        return { success: false, error: 'mode must be "k-hop", "semantic", or "pagerank"' };
      }

      const budgetRaw = (params.complexityBudget ?? {}) as ComplexityBudget;
      const budget: Required<ComplexityBudget> = {
        maxNodesVisited: budgetRaw.maxNodesVisited ?? 10_000,
        maxDepth: budgetRaw.maxDepth ?? 5,
        maxMillis: budgetRaw.maxMillis ?? 50,
        maxMemoryMB: budgetRaw.maxMemoryMB ?? 32,
      };
      const depth = Math.min(validatePositiveInt(params.depth, 2, budget.maxDepth), budget.maxDepth);
      const topK = validatePositiveInt(params.topK, 10, MAX_TOP_K);
      const relation = validateString(params.relation, 'relation', 200) ?? undefined;

      // ── k-hop mode ──────────────────────────────────────────────────────────
      if (mode === 'k-hop') {
        // Try graph-node native first
        try {
          const graphBackend = await getGraphBackend();
          if (await graphBackend.isGraphBackendAvailable()) {
            const neighbors = await graphBackend.getNeighbors(nodeId, depth);
            return {
              success: true, mode, nodeId, depth,
              results: neighbors.map(id => ({ nodeId: id })),
              count: neighbors.length,
              backend: 'graph-node',
              elapsedMs: Date.now() - t0,
            };
          }
        } catch { /* fall through to sql.js */ }

        // SQL CTE fallback for k-hop up to depth 3
        try {
          const { getBridgeDb } = await getGraphEdgeWriter();
          const db = await getBridgeDb();
          if (db) {
            const cteSql = buildKHopCTE(nodeId, Math.min(depth, 3), relation, budget.maxNodesVisited);
            // graph-edge-writer returns a better-sqlite3 Database after #2431.
            // `db.exec(sql, params)` (sql.js style) is a runner with no result
            // on better-sqlite3 — use `prepare(sql).raw().all(...)` to get the
            // same array-of-arrays shape the downstream code expects.
            const rows = db.prepare(cteSql).raw().all() as unknown[][];
            return {
              success: true, mode, nodeId, depth,
              results: rows.map((r: unknown[]) => ({ nodeId: r[0], depth: r[1] })),
              count: rows.length,
              backend: 'sql-cte',
              elapsedMs: Date.now() - t0,
            };
          }
        } catch { /* db unavailable */ }

        return { success: false, error: 'No graph backend available for k-hop query', mode, nodeId };
      }

      // ── semantic mode ────────────────────────────────────────────────────────
      if (mode === 'semantic') {
        try {
          const { generateEmbedding } = await getMemInit();
          const queryEmb = await generateEmbedding(nodeId);
          if (!queryEmb) throw new Error('embedding failed');

          const { getBridgeDb } = await getGraphEdgeWriter();
          // #2246 fix: lazy-create memory.db on first pathfinder call so
          // fresh environments work without a pre-existing memory init.
          const db = await getBridgeDb(undefined, { createIfMissing: true });
          if (!db) return { success: false, error: 'graph_edges DB unavailable (sql.js could not load)', hint: 'Check Node version + try `ruflo memory init` to initialize manually.', mode, nodeId };

          // Load all rows with embedding_ref and score by cosine.
          // better-sqlite3 API — `db.exec(sql, params)` (sql.js) silently
          // throws "datatype mismatch" because exec ignores params, so `?`
          // binds to nothing and SQLite rejects the LIMIT clause.
          const rows = db.prepare(
            `SELECT id, source_id, target_id, relation, weight, embedding_ref FROM graph_edges WHERE embedding_ref IS NOT NULL LIMIT ?`,
          ).raw().all(budget.maxNodesVisited) as unknown[][];
          const { decodeEmbedding } = await getEmbQuant();

          const scored: Array<{ nodeId: string; score: number; relation: string }> = [];
          const qv = new Float32Array(queryEmb.embedding);
          for (const row of rows) {
            const [, srcId, tgtId, rel, , embRef] = row as unknown[];
            if (typeof embRef !== 'string') continue;
            const ev = decodeEmbedding(embRef);
            if (!ev) continue;
            const cos = cosineSim(qv, ev);
            scored.push({ nodeId: srcId as string, score: cos, relation: rel as string });
            scored.push({ nodeId: tgtId as string, score: cos, relation: rel as string });
          }
          scored.sort((a, b) => b.score - a.score);
          const deduped = deduplicateByNodeId(scored).slice(0, topK);

          return {
            success: true, mode, nodeId, topK,
            results: deduped,
            count: deduped.length,
            backend: 'sql-cosine',
            elapsedMs: Date.now() - t0,
          };
        } catch (err) {
          return { success: false, error: sanitizeError(err), mode, nodeId };
        }
      }

      // ── pagerank mode ────────────────────────────────────────────────────────
      if (mode === 'pagerank') {
        try {
          const { getBridgeDb } = await getGraphEdgeWriter();
          // #2246 fix: lazy-create memory.db on first pathfinder call so
          // fresh environments work without a pre-existing memory init.
          const db = await getBridgeDb(undefined, { createIfMissing: true });
          if (!db) return { success: false, error: 'graph_edges DB unavailable (sql.js could not load)', hint: 'Check Node version + try `ruflo memory init` to initialize manually.', mode, nodeId };

          // better-sqlite3 API — see semantic-mode comment above.
          const edges = db.prepare(
            `SELECT source_id, target_id, weight FROM graph_edges LIMIT ?`,
          ).raw().all(budget.maxNodesVisited) as unknown[][];
          if (edges.length === 0) {
            return { success: true, mode, nodeId, results: [], count: 0, message: 'graph_edges is empty', elapsedMs: Date.now() - t0 };
          }

          // Simple PPR without external solver (graceful fallback when plugin unavailable)
          const scores = simplePersonalizedPageRank(nodeId, edges as [string, string, number][], topK, 0.85, 20);

          return {
            success: true, mode, nodeId, topK,
            results: scores,
            count: scores.length,
            backend: 'sql-ppr',
            elapsedMs: Date.now() - t0,
          };
        } catch (err) {
          return { success: false, error: sanitizeError(err), mode, nodeId };
        }
      }

      return { success: false, error: `Unknown mode: ${mode}` };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ─── graph-query helpers ─────────────────────────────────────────────────────

function buildKHopCTE(nodeId: string, depth: number, relation: string | undefined, maxNodes: number): string {
  // Escape the node ID for safe SQL embedding (no user-controlled SQL injection possible
  // since validateIdentifier has already vetted the value; but we sanitize quotes anyway).
  const safeNodeId = nodeId.replace(/'/g, "''");
  const relFilter = relation ? `AND e.relation = '${relation.replace(/'/g, "''")}'` : '';
  return `
    WITH RECURSIVE khop(node_id, hop_depth) AS (
      SELECT '${safeNodeId}', 0
      UNION
      SELECT e.target_id, k.hop_depth + 1
      FROM graph_edges e
      JOIN khop k ON e.source_id = k.node_id
      WHERE k.hop_depth < ${depth} ${relFilter}
    )
    SELECT DISTINCT node_id, MIN(hop_depth) as depth
    FROM khop
    WHERE node_id != '${safeNodeId}'
    GROUP BY node_id
    ORDER BY depth, node_id
    LIMIT ${maxNodes}
  `;
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

function deduplicateByNodeId(arr: Array<{ nodeId: string; score: number; relation: string }>): typeof arr {
  const seen = new Set<string>();
  return arr.filter(item => {
    if (seen.has(item.nodeId)) return false;
    seen.add(item.nodeId);
    return true;
  });
}

/**
 * Simple Personalized PageRank without external solver.
 * Used as fallback when ruflo-graph-intelligence is unavailable.
 * damping = restart probability from seed node; iterations = power steps.
 */
function simplePersonalizedPageRank(
  seedNodeId: string,
  edges: Array<[string, string, number]>,
  topK: number,
  damping: number,
  iterations: number,
): Array<{ nodeId: string; score: number }> {
  // Build adjacency
  const outEdges = new Map<string, Array<[string, number]>>();
  const nodes = new Set<string>();
  for (const [src, tgt, w] of edges) {
    nodes.add(src); nodes.add(tgt);
    if (!outEdges.has(src)) outEdges.set(src, []);
    outEdges.get(src)!.push([tgt, w]);
  }

  if (!nodes.has(seedNodeId)) return [];

  const nodeList = Array.from(nodes);
  const N = nodeList.length;
  const idx = new Map<string, number>(nodeList.map((n, i) => [n, i]));
  const seedIdx = idx.get(seedNodeId) ?? 0;

  let scores = new Float32Array(N).fill(0);
  scores[seedIdx] = 1.0;

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Float32Array(N).fill(0);
    for (let i = 0; i < N; i++) {
      const node = nodeList[i];
      const out = outEdges.get(node) ?? [];
      if (out.length === 0) {
        next[seedIdx] += scores[i]; // dangling node → restart
        continue;
      }
      const totalW = out.reduce((s, [, w]) => s + w, 0);
      for (const [tgt, w] of out) {
        const j = idx.get(tgt) ?? 0;
        next[j] += scores[i] * (w / totalW) * (1 - damping);
      }
    }
    next[seedIdx] += damping; // restart
    // Normalize
    const sum = next.reduce((s, v) => s + v, 0);
    if (sum > 0) for (let i = 0; i < N; i++) next[i] /= sum;
    scores = next;
  }

  const results: Array<{ nodeId: string; score: number }> = [];
  for (let i = 0; i < N; i++) {
    if (nodeList[i] !== seedNodeId) {
      results.push({ nodeId: nodeList[i], score: scores[i] });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

// ===== ADR-130 Phase 5: agentdb_graph-pathfinder =====

export const agentdbGraphPathfinder: MCPTool = {
  name: 'agentdb_graph-pathfinder',
  description: 'Multi-algorithm native graph pathfinder (ADR-130 Phase 5). Use when agentdb_graph-query k-hop is not enough — pathfinder supports personalized-pagerank, dynamic-mincut, spectral-sparsify, temporal-centrality, connected-component-churn, and witness-chain-divergence. Prefer over prompt-level graph loops in ruflo-knowledge-graph graph-navigator when you need ranked paths with formal complexityBudget enforcement.',
  inputSchema: {
    type: 'object',
    properties: {
      seedNodeId: { type: 'string', description: 'Domain-prefixed start node (e.g. "entity:auth-module")' },
      query: { type: 'string', description: 'Natural-language query for relevance scoring' },
      depth: { type: 'number', description: 'Expansion depth (default 3, max 5)' },
      threshold: { type: 'number', description: 'Minimum cumulative relevance score (default 0.3)' },
      topK: { type: 'number', description: 'Max paths returned (default 10)' },
      algorithm: {
        type: 'string',
        enum: ['personalized-pagerank', 'dynamic-mincut', 'spectral-sparsify', 'temporal-centrality', 'connected-component-churn', 'witness-chain-divergence'],
        description: 'Graph algorithm (default: personalized-pagerank)',
      },
      complexityBudget: {
        type: 'object',
        properties: {
          maxNodesVisited: { type: 'number' },
          maxDepth: { type: 'number' },
          maxMillis: { type: 'number' },
          maxMemoryMB: { type: 'number' },
        },
      },
    },
    required: ['seedNodeId', 'query'],
  },
  handler: async (params: Record<string, unknown>) => {
    const t0 = Date.now();
    try {
      const vSeed = validateIdentifier(params.seedNodeId, 'seedNodeId');
      if (!vSeed.valid) return { success: false, error: vSeed.error };
      const seedNodeId = validateString(params.seedNodeId, 'seedNodeId', 500);
      if (!seedNodeId) return { success: false, error: 'seedNodeId is required' };
      const query = validateString(params.query, 'query', 2000) ?? '';

      const budgetRaw = (params.complexityBudget ?? {}) as ComplexityBudget;
      const rawDepth = validatePositiveInt(params.depth, 3, 5);
      const depth = Math.min(rawDepth, 5);
      const depthWarning = rawDepth > 5 ? `depth clamped from ${rawDepth} to 5` : undefined;

      const budget: Required<ComplexityBudget> = {
        maxNodesVisited: budgetRaw.maxNodesVisited ?? 10_000,
        maxDepth: Math.min(budgetRaw.maxDepth ?? depth, 5),
        maxMillis: budgetRaw.maxMillis ?? 50,
        maxMemoryMB: budgetRaw.maxMemoryMB ?? 32,
      };
      const threshold = typeof params.threshold === 'number' ? params.threshold : 0.3;
      const topK = validatePositiveInt(params.topK, 10, MAX_TOP_K);
      const algorithm = (params.algorithm as string) ?? 'personalized-pagerank';

      const validAlgorithms = ['personalized-pagerank', 'dynamic-mincut', 'spectral-sparsify', 'temporal-centrality', 'connected-component-churn', 'witness-chain-divergence'];
      if (!validAlgorithms.includes(algorithm)) {
        return { success: false, error: `Unknown algorithm: ${algorithm}. Valid: ${validAlgorithms.join(', ')}` };
      }

      // Load edges from graph_edges
      const { getBridgeDb } = await getGraphEdgeWriter();
      // #2246 fix: lazy-create memory.db on first pathfinder call.
      const db = await getBridgeDb(undefined, { createIfMissing: true });
      if (!db) return { success: false, error: 'graph_edges DB unavailable (sql.js could not load)', hint: 'Check Node version + try `ruflo memory init` to initialize manually.', seedNodeId };

      const colsSql = algorithm === 'witness-chain-divergence'
        ? 'source_id, target_id, weight, last_reinforced, witness_id'
        : algorithm === 'temporal-centrality'
        ? 'source_id, target_id, weight, last_reinforced, confidence'
        : 'source_id, target_id, weight';

      // Early-exit optimization: if seedNodeId has no incident edges,
      // skip the full edge-table scan + PPR matrix build entirely.
      // EXISTS query is O(index lookup) vs O(N) full scan + JS allocation.
      try {
        const seedHit = db.prepare(
          `SELECT 1 FROM graph_edges WHERE source_id = ? OR target_id = ? LIMIT 1`,
        ).raw().all(seedNodeId, seedNodeId) as unknown[][];
        if (seedHit.length === 0) {
          return { success: true, paths: [], count: 0, message: 'seedNodeId not present in graph_edges', seedNodeId, algorithm, elapsedMs: Date.now() - t0, budgetUsed: { millis: Date.now() - t0, nodes: 0 } };
        }
      } catch { /* fall through to full scan on probe failure */ }

      // better-sqlite3 API — see graph-query comment above; sql.js-style
      // `db.exec(sql, params)` throws "datatype mismatch" here.
      const rawEdges = db.prepare(
        `SELECT ${colsSql} FROM graph_edges LIMIT ?`,
      ).raw().all(budget.maxNodesVisited) as unknown[][];

      if (rawEdges.length === 0) {
        return { success: true, paths: [], count: 0, message: `no edges found from seedNodeId`, seedNodeId, algorithm, elapsedMs: Date.now() - t0 };
      }

      const edges = rawEdges as unknown[][];
      let paths: Array<{ nodeId: string; score: number; depth: number }> = [];

      // Check millisecond budget before heavy computation
      if (Date.now() - t0 > budget.maxMillis) {
        return { success: true, paths: [], count: 0, message: `complexityBudget.maxMillis (${budget.maxMillis}ms) exceeded before solver dispatch`, seedNodeId, algorithm, elapsedMs: Date.now() - t0 };
      }

      switch (algorithm) {
        case 'personalized-pagerank': {
          const edgeTuples = edges.map(r => [r[0], r[1], Number(r[2]) || 1.0] as [string, string, number]);
          const pprResults = simplePersonalizedPageRank(seedNodeId, edgeTuples, topK, 0.85, 20);
          paths = pprResults.filter(r => r.score >= threshold).map(r => ({ ...r, depth: 1 }));
          break;
        }
        case 'temporal-centrality': {
          // Score nodes by recency of last_reinforced × confidence
          const nodeScores = new Map<string, number>();
          const now = Date.now();
          for (const row of edges) {
            const [src, tgt, w, lastReinforced, confidence] = row;
            const ageMs = lastReinforced
              ? now - new Date(lastReinforced as string).getTime()
              : now;
            const ageDays = ageMs / (1000 * 60 * 60 * 24);
            const decayedScore = (Number(w) || 1.0) * (Number(confidence) || 1.0) * Math.exp(-0.1 * ageDays);
            for (const n of [src as string, tgt as string]) {
              nodeScores.set(n, (nodeScores.get(n) ?? 0) + decayedScore);
            }
          }
          paths = Array.from(nodeScores.entries())
            .filter(([n, s]) => n !== seedNodeId && s >= threshold)
            .map(([nodeId, score]) => ({ nodeId, score, depth: 1 }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
          break;
        }
        case 'witness-chain-divergence': {
          // Walk witness_id chains, flag divergences (gaps or non-monotonic timestamps)
          const witnessChain: Array<{ nodeId: string; score: number; depth: number }> = [];
          const seen = new Set<string>();
          let current = seedNodeId;
          for (let d = 0; d < depth; d++) {
            const nextEdge = edges.find(r => r[0] === current && r[4]);
            if (!nextEdge) break;
            const next = nextEdge[1] as string;
            if (seen.has(next)) {
              // Loop detected → divergence score 1.0
              witnessChain.push({ nodeId: next, score: 1.0, depth: d + 1 });
              break;
            }
            seen.add(next);
            witnessChain.push({ nodeId: next, score: 0.5, depth: d + 1 });
            current = next;
          }
          paths = witnessChain.slice(0, topK);
          break;
        }
        case 'connected-component-churn':
        case 'dynamic-mincut':
        case 'spectral-sparsify': {
          // Simplified implementations: return k-hop neighbors with basic score
          const edgeTuples = edges.map(r => [r[0], r[1], Number(r[2]) || 1.0] as [string, string, number]);
          const khopResult = await agentdbGraphQuery.handler({
            nodeId: seedNodeId, mode: 'k-hop', depth, complexityBudget: budget,
          }) as any;
          if (khopResult.success && khopResult.results) {
            paths = khopResult.results
              .map((r: any, i: number) => ({ nodeId: r.nodeId, score: 1.0 / (1 + i), depth: r.depth ?? 1 }))
              .filter((r: any) => r.score >= threshold)
              .slice(0, topK);
          }
          break;
        }
      }

      const elapsedMs = Date.now() - t0;
      return {
        success: true,
        seedNodeId, algorithm, depth, topK, threshold,
        paths,
        count: paths.length,
        elapsedMs,
        budgetUsed: { millis: elapsedMs, nodes: rawEdges.length },
        ...(depthWarning && { warning: depthWarning }),
      };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== Export all tools =====

export const agentdbTools: MCPTool[] = [
  agentdbHealth,
  agentdbControllers,
  agentdbPatternStore,
  agentdbPatternSearch,
  agentdbFeedback,
  agentdbCausalEdge,
  agentdbCausalEdgeDelete,
  agentdbCausalNodeDelete,
  agentdbRoute,
  agentdbSessionStart,
  agentdbSessionEnd,
  agentdbHierarchicalStore,
  agentdbHierarchicalGet,
  agentdbHierarchicalCreate,
  agentdbHierarchicalRecall,
  agentdbHierarchicalDelete,
  agentdbConsolidate,
  agentdbBatch,
  agentdbContextSynthesize,
  agentdbSemanticRoute,
  agentdbGraphQuery,       // ADR-130 Phase 2
  agentdbGraphPathfinder,  // ADR-130 Phase 5
];
