/**
 * Enhanced Model Router with Agent Booster AST Integration
 *
 * Implements ADR-026: 3-tier intelligent model routing:
 * - Tier 1: Agent Booster (WASM) - <1ms, $0 for simple transforms
 * - Tier 2: Haiku - ~500ms for low complexity
 * - Tier 3: Sonnet/Opus - 2-5s for high complexity
 *
 * @module enhanced-model-router
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { extname, isAbsolute, resolve as resolvePath } from 'path';
import { ClaudeModel, getModelRouter, ModelRouter, ModelRoutingResult } from './model-router.js';
import { applyCodemod, isDeterministicCodemod, type CodemodLanguage } from './codemods/engine.js';

/** Map a file path to the codemod engine's language, falling back to a hint. */
function codemodLanguageFor(filePath: string, fallback?: string): CodemodLanguage {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.tsx') return 'tsx';
  if (ext === '.jsx') return 'jsx';
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'typescript';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  return fallback === 'typescript' ? 'typescript' : 'javascript';
}

// ============================================================================
// Types
// ============================================================================

/**
 * Code editing intent types that Agent Booster can handle
 */
export type EditIntentType =
  | 'var-to-const'
  | 'add-types'
  | 'add-error-handling'
  | 'async-await'
  | 'add-logging'
  | 'remove-console';

/**
 * Detected edit intent from task analysis
 */
export interface EditIntent {
  type: EditIntentType;
  confidence: number;
  filePath?: string;
  language?: string;
  description: string;
}

/**
 * Enhanced routing result with Agent Booster support
 */
export interface EnhancedRouteResult {
  tier: 1 | 2 | 3;
  handler: 'codemod' | 'agent-booster' | 'haiku' | 'sonnet' | 'opus';
  model?: ClaudeModel;
  confidence: number;
  complexity?: number;
  reasoning: string;
  /** The detected edit intent (Tier 1 only). */
  codemodIntent?: EditIntent;
  /**
   * Back-compat alias for {@link codemodIntent}. Older callers read this field.
   * @deprecated use {@link codemodIntent}
   */
  agentBoosterIntent?: EditIntent;
  /** true when a deterministic, $0 codemod can fully apply this edit (no LLM). */
  deterministic?: boolean;
  canSkipLLM?: boolean;
  estimatedLatencyMs: number;
  estimatedCost: number;
  // ADR-149 — forwarded from the underlying ModelRouter when the cost-optimal
  // neural backend contributed. `modelId` is the concrete picked model
  // (e.g. `inclusionai/ling-2.6-flash`); `routedBy` reflects the decision
  // mechanism ('hybrid' | 'bandit-fallback' | 'heuristic'); `provider` +
  // `openrouterModel` are the execution-layer hint pair.
  modelId?: string;
  routedBy?: 'hybrid' | 'bandit-fallback' | 'heuristic';
  provider?: 'anthropic' | 'openrouter';
  openrouterModel?: string;
}

/**
 * Enhanced model router configuration
 */
export interface EnhancedModelRouterConfig {
  agentBoosterEnabled: boolean;
  agentBoosterConfidenceThreshold: number;
  enabledIntents: EditIntentType[];
  complexityThresholds: {
    haiku: number;
    sonnet: number;
    opus: number;
  };
  preferCost: boolean;
  preferQuality: boolean;
}

// ============================================================================
// Intent Detection Patterns
// ============================================================================

/**
 * Pattern definitions for Agent Booster intent detection
 */
const INTENT_PATTERNS: Record<EditIntentType, {
  patterns: RegExp[];
  weight: number;
  description: string;
}> = {
  'var-to-const': {
    patterns: [
      /convert\s+var\s+to\s+const/i,
      /change\s+var\s+to\s+const/i,
      /change\s+var\s+declarations?\s+to\s+const/i,
      /replace\s+var\s+with\s+const/i,
      /var\s*(?:→|->|to)\s*const/i,
      /use\s+const\s+instead\s+of\s+var/i,
    ],
    weight: 1.0,
    description: 'Convert var declarations to const/let',
  },
  'add-types': {
    patterns: [
      /add\s+type\s+annotations?/i,
      /add\s+typescript\s+types?/i,
      /type\s+this\s+function/i,
      /add\s+types?\s+to/i,
      /annotate\s+with\s+types?/i,
    ],
    weight: 0.9,
    description: 'Add TypeScript type annotations',
  },
  'add-error-handling': {
    patterns: [
      /add\s+error\s+handling/i,
      /wrap\s+in\s+try\s*[/-]?\s*catch/i,
      /add\s+try\s*[/-]?\s*catch/i,
      /handle\s+errors?/i,
      /add\s+exception\s+handling/i,
    ],
    weight: 0.7, // Lower weight - often needs more context
    description: 'Wrap code in try/catch blocks',
  },
  'async-await': {
    patterns: [
      /convert\s+to\s+async\s*[/-]?\s*await/i,
      /convert\s+\w+\s+to\s+async/i,
      /use\s+async\s*[/-]?\s*await/i,
      /change\s+promises?\s+to\s+async/i,
      /refactor\s+to\s+async/i,
      /\.then\s*(?:→|->|to)\s*await/i,
      /callback\s+to\s+async/i,
      /callbacks?\s+to\s+async/i,
    ],
    weight: 0.8,
    description: 'Convert callbacks/promises to async/await',
  },
  'add-logging': {
    patterns: [
      /add\s+logging/i,
      /add\s+console\.log/i,
      /add\s+debug\s+logs?/i,
      /log\s+this\s+function/i,
      /add\s+trace\s+logging/i,
    ],
    weight: 0.85,
    description: 'Add console.log or logging statements',
  },
  'remove-console': {
    patterns: [
      /remove\s+(?:all\s+)?console\.log/i,
      /remove\s+(?:all\s+)?console\s+statements?/i,
      /delete\s+(?:all\s+)?console\s+statements?/i,
      /strip\s+console/i,
      /clean\s+up\s+console/i,
      /clean\s+up\s+debug\s+logs?/i,
      /remove\s+(?:all\s+)?debug\s+logs?/i,
      /delete\s+(?:all\s+)?console\.log/i,
    ],
    weight: 0.95,
    description: 'Remove console.* calls',
  },
};

/**
 * File path extraction patterns
 */
const FILE_PATH_PATTERNS: RegExp[] = [
  /(?:in|from|to|file|path)\s+[`"']?([a-zA-Z0-9_./\\-]+\.[a-zA-Z]+)[`"']?/i,
  /[`"']([a-zA-Z0-9_./\\-]+\.[a-zA-Z]+)[`"']/,
  /(\S+\.[tj]sx?)\b/i,
  /(\S+\.(?:js|ts|jsx|tsx|py|rb|go|rs|java|kt|swift|c|cpp|h))\b/i,
];

/**
 * Language detection by extension
 */
/**
 * High-complexity keywords that indicate Tier 3 (Opus) routing
 * These tasks require deep reasoning and architectural understanding
 */
const TIER3_KEYWORDS: RegExp[] = [
  // Architecture & Design
  /\b(microservices?|architecture|system\s+design|distributed)\b/i,
  /\b(design|architect|plan)\s+(a|an|the|complex)\b/i,
  /\b(design)\s+\w+\s+(schema|system|architecture)\b/i,

  // Security
  /\b(oauth2?|pkce|jwt|rbac|authentication\s+system|security\s+audit)\b/i,
  /\b(refresh\s+token|token\s+rotation|role-based|permission|authorization)\b/i,
  /\b(encryption|cryptograph|certificate|ssl|tls)\b/i,
  /\b(end-to-end\s+encryption|key\s+rotation|secure\s+channel)\b/i,

  // Distributed Systems
  /\b(consensus|distributed|byzantine|raft|paxos)\b/i,
  /\b(replication|sharding|partitioning|eventual\s+consistency)\b/i,
  /\b(load\s+balanc|fault[- ]toleran|high\s+availability)\b/i,
  /\b(message\s+queue|event\s+sourc|cqrs|saga)\b/i,

  // Complex Algorithms
  /\b(algorithm|machine\s+learning|neural|optimization)\b/i,
  /\b(graph\s+algorithm|tree\s+traversal|dynamic\s+programming)\b/i,

  // Database Design
  /\b(schema\s+design|database\s+architect|data\s+model)\b/i,
  /\b(database\s+schema|multi[- ]tenant)\b/i,
  /\b(normalization|denormalization|index\s+strateg)\b/i,

  // Performance Critical
  /\b(performance\s+critical|low\s+latency|high\s+throughput)\b/i,
  /\b(memory\s+optimi|cache\s+strateg|concurrent)\b/i,
];

const LANGUAGE_MAP: Record<string, string> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
};

// ============================================================================
// Enhanced Model Router Implementation
// ============================================================================

/**
 * Enhanced Model Router with Agent Booster AST integration
 *
 * Provides intelligent 3-tier routing:
 * - Tier 1: Agent Booster for simple code transforms (352x faster, $0)
 * - Tier 2: Haiku for low complexity tasks
 * - Tier 3: Sonnet/Opus for complex reasoning tasks
 */
export class EnhancedModelRouter {
  private config: EnhancedModelRouterConfig;
  // The base text-routing path delegated to here is the local
  // heuristic + Thompson-bandit ModelRouter — NOT the @ruvector/tiny-dancer
  // neural router that an earlier design (ADR-026) described (#2329). The
  // public `getStats()` return still exposes the field as `tinyDancerStats`
  // for telemetry-schema stability.
  private baseRouter: ModelRouter;

  constructor(config?: Partial<EnhancedModelRouterConfig>) {
    this.config = {
      agentBoosterEnabled: true,
      agentBoosterConfidenceThreshold: 0.7,
      enabledIntents: [
        'var-to-const',
        'add-types',
        'add-error-handling',
        'async-await',
        'add-logging',
        'remove-console',
      ],
      complexityThresholds: {
        haiku: 0.3,
        sonnet: 0.6,
        opus: 1.0,
      },
      preferCost: false,
      preferQuality: false,
      ...config,
    };

    this.baseRouter = getModelRouter();
  }

  /**
   * Detect code editing intent from task description
   */
  detectIntent(task: string): EditIntent | null {
    const taskLower = task.toLowerCase();
    let bestIntent: EditIntent | null = null;
    let bestScore = 0;

    for (const [intentType, config] of Object.entries(INTENT_PATTERNS)) {
      if (!this.config.enabledIntents.includes(intentType as EditIntentType)) {
        continue;
      }

      for (const pattern of config.patterns) {
        if (pattern.test(taskLower)) {
          const score = config.weight;
          if (score > bestScore) {
            bestScore = score;
            bestIntent = {
              type: intentType as EditIntentType,
              confidence: score,
              description: config.description,
            };
          }
        }
      }
    }

    // Extract file path if intent found
    if (bestIntent) {
      const filePath = this.extractFilePath(task);
      if (filePath) {
        bestIntent.filePath = filePath;
        bestIntent.language = this.detectLanguage(filePath);
        // Boost confidence if file exists
        if (existsSync(filePath)) {
          bestIntent.confidence = Math.min(1.0, bestIntent.confidence + 0.1);
        }
      }
    }

    return bestIntent;
  }

  /**
   * Extract file path from task description
   */
  private extractFilePath(task: string): string | null {
    for (const pattern of FILE_PATH_PATTERNS) {
      const match = task.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  }

  /**
   * Detect language from file extension
   */
  private detectLanguage(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    return LANGUAGE_MAP[ext] || 'javascript';
  }

  /**
   * Check if task contains Tier 3 (Opus) keywords
   */
  private containsTier3Keywords(task: string): { matches: boolean; count: number } {
    let count = 0;
    for (const pattern of TIER3_KEYWORDS) {
      if (pattern.test(task)) {
        count++;
      }
    }
    return { matches: count > 0, count };
  }

  /**
   * Route a task to the optimal tier and handler
   */
  async route(task: string, context?: { filePath?: string; embedding?: number[] }): Promise<EnhancedRouteResult> {
    // Step 1: Deterministic codemod detection (ADR-143).
    // Only intents that a codemod can apply *deterministically and safely* skip
    // the LLM. Intents that need inference (add-types, add-error-handling,
    // async-await) are detected but fall through to model routing below.
    if (this.config.agentBoosterEnabled) {
      const intent = this.detectIntent(task);

      if (
        intent &&
        intent.confidence >= this.config.agentBoosterConfidenceThreshold &&
        isDeterministicCodemod(intent.type)
      ) {
        // Route-time dry-run (ADR-143 #3): when a target file is known, only
        // claim Tier-1 if the codemod actually changes something. This avoids
        // recommending [CODEMOD_AVAILABLE] for no-ops (e.g. "remove console" on
        // a file with no console calls). With no file to check, recommend Tier-1
        // best-effort — the executor (hooks_codemod) verifies before writing.
        // Prefer the caller-provided path (authoritative, usually absolute) over
        // the path heuristically extracted from the task text; resolve relatives.
        const fpRaw = context?.filePath || intent.filePath;
        const fp = fpRaw ? (isAbsolute(fpRaw) ? fpRaw : resolvePath(process.cwd(), fpRaw)) : undefined;
        let tier1 = true;
        let edits: number | undefined;
        if (fp && existsSync(fp)) {
          try {
            const code = readFileSync(fp, 'utf-8');
            const res = applyCodemod(intent.type, code, { language: codemodLanguageFor(fp, intent.language) });
            if (res.success && res.changed) {
              edits = res.edits;
            } else {
              tier1 = false; // verified no-op / can't apply → fall through to model routing
            }
          } catch {
            // read error → leave best-effort Tier-1 (executor will verify)
          }
        }

        if (tier1) {
          const editsNote = edits !== undefined ? ` (${edits} edit${edits === 1 ? '' : 's'})` : '';
          return {
            tier: 1,
            handler: 'codemod',
            confidence: intent.confidence,
            reasoning: `Deterministic codemod can apply "${intent.type}" with ${(intent.confidence * 100).toFixed(0)}% confidence — $0, no LLM${editsNote}`,
            codemodIntent: intent,
            agentBoosterIntent: intent,
            deterministic: true,
            canSkipLLM: true,
            estimatedLatencyMs: 1,
            estimatedCost: 0,
          };
        }
        // verified no-op: fall through to model routing below
      }
    }

    // Step 2: Check for Tier 3 keywords (architecture, security, distributed)
    const tier3Check = this.containsTier3Keywords(task);
    if (tier3Check.matches && tier3Check.count >= 2) {
      // Strong signal for Opus - multiple complex keywords
      return {
        tier: 3,
        handler: 'opus',
        model: 'opus',
        confidence: Math.min(0.95, 0.7 + tier3Check.count * 0.1),
        complexity: 0.8 + tier3Check.count * 0.05,
        reasoning: `High complexity task (${tier3Check.count} architectural keywords) - using opus`,
        canSkipLLM: false,
        estimatedLatencyMs: 5000,
        estimatedCost: 0.015,
      };
    }

    // Step 3: AST complexity analysis (if file path provided)
    let astComplexity: number | undefined;
    const targetFile = context?.filePath || this.extractFilePath(task);

    if (targetFile && existsSync(targetFile)) {
      try {
        astComplexity = await this.analyzeASTComplexity(targetFile);
      } catch {
        // AST analysis not available, continue with text-based routing
      }
    }

    // Step 4: Text-based complexity via the local heuristic + bandit router.
    // ADR-149 — forward the optional embedding so the cost-optimal neural
    // path can fire. Without it, base routing falls back to heuristic+bandit
    // and the per-model Pareto wins from the measured seed corpus are lost.
    const baseResult = await this.baseRouter.route(task, context?.embedding);

    // Step 5: Combine AST complexity with the text-routing result.
    // Also boost if a single tier3 keyword is found.
    let finalComplexity = astComplexity !== undefined
      ? (astComplexity + baseResult.complexity) / 2
      : baseResult.complexity;

    // Boost complexity if tier3 keywords found (even just one)
    if (tier3Check.matches) {
      finalComplexity = Math.min(1.0, finalComplexity + 0.25);
    }

    // Step 6: Determine tier based on complexity
    const { haiku, sonnet } = this.config.complexityThresholds;

    // ADR-149 — forward the per-model fields from baseResult onto the
    // tier-2/3 return, but ONLY when the tier being returned here still
    // matches the tier baseResult.model was chosen for. `finalComplexity`
    // (AST-adjusted / tier3-keyword-boosted, Step 5-6 above) can escalate
    // the returned tier past what the base bandit router saw when it picked
    // `modelId` — forwarding it unconditionally would attach a cheaper
    // tier's concrete model (e.g. `inclusionai/ling-2.6-flash`, chosen for
    // 'haiku') to an escalated 'opus' decision. `agent-execute-core.ts`
    // treats a present `modelId` as an override that skips tier-based
    // dispatch entirely, so a stale, wrong-tier `modelId` silently defeats
    // the escalation this function just computed. Dropping the mismatched
    // fields (rather than trying to re-resolve modelId for the new tier)
    // keeps this fix small and fail-safe: an escalated decision falls back
    // to the plain `model` field, never to a cheaper model's identity.
    const neuralFieldsFor = (model: ClaudeModel) =>
      baseResult.model === model
        ? {
            ...(baseResult.modelId ? { modelId: baseResult.modelId } : {}),
            ...(baseResult.routedBy ? { routedBy: baseResult.routedBy } : {}),
            ...(baseResult.provider ? { provider: baseResult.provider } : {}),
            ...(baseResult.openrouterModel ? { openrouterModel: baseResult.openrouterModel } : {}),
          }
        : {};

    if (finalComplexity < haiku) {
      return {
        tier: 2,
        handler: 'haiku',
        model: 'haiku',
        confidence: baseResult.confidence,
        complexity: finalComplexity,
        reasoning: `Low complexity (${(finalComplexity * 100).toFixed(0)}%) - using haiku`,
        canSkipLLM: false,
        estimatedLatencyMs: 500,
        estimatedCost: 0.0002,
        ...neuralFieldsFor('haiku'),
      };
    }

    if (finalComplexity < sonnet) {
      return {
        tier: 2,
        handler: 'sonnet',
        model: 'sonnet',
        confidence: baseResult.confidence,
        complexity: finalComplexity,
        reasoning: `Medium complexity (${(finalComplexity * 100).toFixed(0)}%) - using sonnet`,
        canSkipLLM: false,
        estimatedLatencyMs: 2000,
        estimatedCost: 0.003,
        ...neuralFieldsFor('sonnet'),
      };
    }

    return {
      tier: 3,
      handler: 'opus',
      model: 'opus',
      confidence: baseResult.confidence,
      complexity: finalComplexity,
      reasoning: `High complexity (${(finalComplexity * 100).toFixed(0)}%) - using opus`,
      canSkipLLM: false,
      estimatedLatencyMs: 5000,
      estimatedCost: 0.015,
      ...neuralFieldsFor('opus'),
    };
  }

  /**
   * Analyze AST complexity of a file
   * Returns normalized complexity score (0-1)
   */
  private async analyzeASTComplexity(filePath: string): Promise<number> {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      // Simple heuristics for complexity
      let complexity = 0;

      // Line count contribution
      complexity += Math.min(0.3, lines.length / 1000);

      // Nesting depth estimation (count indentation)
      const avgIndent = lines
        .filter((l) => l.trim().length > 0)
        .map((l) => l.match(/^(\s*)/)?.[1].length || 0)
        .reduce((sum, indent) => sum + indent, 0) / Math.max(1, lines.length);
      complexity += Math.min(0.2, avgIndent / 20);

      // Control flow complexity (count keywords)
      const controlFlowCount = (content.match(/\b(if|else|for|while|switch|case|try|catch|async|await)\b/g) || []).length;
      complexity += Math.min(0.3, controlFlowCount / 100);

      // Function/class count
      const functionCount = (content.match(/\b(function|class|=>)\b/g) || []).length;
      complexity += Math.min(0.2, functionCount / 50);

      return Math.min(1, complexity);
    } catch {
      return 0.5; // Default to medium complexity on error
    }
  }

  /**
   * Execute task using the appropriate tier.
   *
   * For Tier-1 deterministic intents this applies the codemod directly (writing
   * the file back when a path is given) — $0, no LLM. Otherwise it returns the
   * routing result and the caller invokes the recommended model.
   */
  async execute(
    task: string,
    context?: { filePath?: string; originalCode?: string }
  ): Promise<{
    result: string | { applied: boolean; changed: boolean; edits: number };
    routeResult: EnhancedRouteResult;
  }> {
    const routeResult = await this.route(task, context);
    const intent = routeResult.codemodIntent ?? routeResult.agentBoosterIntent;

    if (routeResult.tier === 1 && routeResult.deterministic && intent) {
      const cm = this.tryCodemod(intent, context);

      if (cm.success) {
        return {
          result: { applied: true, changed: cm.changed, edits: cm.edits },
          routeResult,
        };
      }

      // Codemod could not apply (no file / parse issue) — fall back to a model.
      routeResult.tier = 2;
      routeResult.handler = 'sonnet';
      routeResult.model = 'sonnet';
      routeResult.deterministic = false;
      routeResult.canSkipLLM = false;
      routeResult.reasoning += ' (codemod fallback to LLM)';
    }

    // Return routing result - caller handles LLM invocation
    return { result: routeResult.reasoning, routeResult };
  }

  /**
   * Apply a deterministic codemod to the intent's target file.
   *
   * This is the real Tier-1 execution path (ADR-143). It uses the in-process
   * TypeScript-compiler codemod engine — no `agent-booster` import, no subprocess,
   * no LLM. Writes the transformed source back to disk when it changes.
   */
  private tryCodemod(
    intent: EditIntent,
    context?: { filePath?: string; originalCode?: string }
  ): { success: boolean; changed: boolean; edits: number } {
    const filePath = intent.filePath || context?.filePath;
    if (!filePath || !existsSync(filePath)) {
      return { success: false, changed: false, edits: 0 };
    }

    const originalCode = context?.originalCode ?? readFileSync(filePath, 'utf-8');
    const language = codemodLanguageFor(filePath, intent.language);
    const result = applyCodemod(intent.type, originalCode, { language });

    if (!result.success) {
      return { success: false, changed: false, edits: 0 };
    }
    if (result.changed && !context?.originalCode) {
      writeFileSync(filePath, result.output, 'utf-8');
    }
    return { success: true, changed: result.changed, edits: result.edits };
  }

  /**
   * Get router statistics
   */
  getStats(): {
    config: EnhancedModelRouterConfig;
    tinyDancerStats: ReturnType<ModelRouter['getStats']>;
  } {
    return {
      config: { ...this.config },
      // Field name kept as `tinyDancerStats` for telemetry-schema
      // stability; the underlying router is the local heuristic + bandit
      // ModelRouter, not @ruvector/tiny-dancer. See #2329.
      tinyDancerStats: this.baseRouter.getStats(),
    };
  }
}

// ============================================================================
// Singleton & Factory Functions
// ============================================================================

let enhancedRouterInstance: EnhancedModelRouter | null = null;

/**
 * Get or create the singleton EnhancedModelRouter instance
 */
export function getEnhancedModelRouter(
  config?: Partial<EnhancedModelRouterConfig>
): EnhancedModelRouter {
  if (!enhancedRouterInstance) {
    enhancedRouterInstance = new EnhancedModelRouter(config);
  }
  return enhancedRouterInstance;
}

/**
 * Reset the singleton instance
 */
export function resetEnhancedModelRouter(): void {
  enhancedRouterInstance = null;
}

/**
 * Create a new EnhancedModelRouter instance (non-singleton)
 */
export function createEnhancedModelRouter(
  config?: Partial<EnhancedModelRouterConfig>
): EnhancedModelRouter {
  return new EnhancedModelRouter(config);
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Quick route function with enhanced routing
 */
export async function enhancedRouteToModel(
  task: string,
  context?: { filePath?: string }
): Promise<EnhancedRouteResult> {
  const router = getEnhancedModelRouter();
  return router.route(task, context);
}

/**
 * Detect if a task can be applied by a deterministic, $0 codemod (ADR-143).
 * Only the deterministic intents qualify — others need a model.
 */
export function canUseCodemod(task: string): {
  canUse: boolean;
  intent?: EditIntent;
} {
  const router = getEnhancedModelRouter();
  const intent = router.detectIntent(task);

  if (intent && intent.confidence >= 0.7 && isDeterministicCodemod(intent.type)) {
    return { canUse: true, intent };
  }

  return { canUse: false };
}

/**
 * @deprecated Agent Booster never performed these transforms. Use {@link canUseCodemod}.
 */
export const canUseAgentBooster = canUseCodemod;
