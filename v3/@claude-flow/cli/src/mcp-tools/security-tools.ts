/**
 * Security MCP Tools - AIDefence Integration
 *
 * Provides MCP tools for AI manipulation defense:
 * - aidefence_scan: Scan input for threats
 * - aidefence_analyze: Deep analysis of threats
 * - aidefence_stats: Get detection statistics
 * - aidefence_learn: Learn from detection feedback
 *
 * Created with ❤️ by ruv.io
 */

import type { MCPTool, MCPToolResult } from './types.js';
import { validateText, validateIdentifier } from './validate-input.js';
import { autoInstallPackage, importProjectLocalPackage } from './auto-install.js';
import { createRequire } from 'module';

// Create require for resolving module paths
const require = createRequire(import.meta.url);

// AIDefence instance type
type AIDefenceInstance = ReturnType<typeof import('@claude-flow/aidefence').createAIDefence>;

// Lazy-loaded AIDefence instance
let aidefenceInstance: AIDefenceInstance | null = null;

// Track if we've attempted install this session
let installAttempted = false;

// ADR-093 follow-up: wrapper-level counters for the lightweight aidefence
// tools (has_pii, is_safe, scan-quick) that bypass the package's own
// stats tracking. The audit flagged that aidefence_stats stayed at zero
// regardless of detections from these paths. Stats now combine the
// underlying defender.getStats() with our wrapper counters so the user
// sees a true reflection of how often each tool category fired.
const wrapperStats = {
  hasPiiCalls: 0,
  hasPiiHits: 0,
  isSafeCalls: 0,
  isSafeUnsafeVerdicts: 0,
  quickScanCalls: 0,
  quickScanThreats: 0,
};

/**
 * Get or create AIDefence instance (throws if unavailable)
 */
async function getAIDefence(): Promise<AIDefenceInstance> {
  if (aidefenceInstance) {
    return aidefenceInstance;
  }

  const packageName = '@claude-flow/aidefence';

  // First attempt - try to load via dynamic import (ESM)
  try {
    const aidefence = await import(packageName);
    const instance = aidefence.createAIDefence({ enableLearning: true });
    if (!instance) {
      throw new Error('createAIDefence returned null');
    }
    aidefenceInstance = instance;
    return instance;
  } catch (e) {
    // Package not found or failed to load
    const error = e as Error;
    if (!error.message?.includes('Cannot find package') && !error.message?.includes('ERR_MODULE_NOT_FOUND')) {
      // Different error - might be a real issue
      throw new Error(`AIDefence failed to load: ${error.message}`);
    }
  }

  // npx keeps Ruflo in an isolated cache, so a bare import above cannot see a
  // package installed in the user's project. Resolve explicitly from cwd
  // before attempting installation; this is the persistent optional-package
  // path documented for npx-launched MCP servers (#2946).
  const projectLocal = await importProjectLocalPackage<typeof import('@claude-flow/aidefence')>(packageName);
  if (projectLocal) {
    const instance = projectLocal.createAIDefence({ enableLearning: true });
    if (instance) {
      aidefenceInstance = instance;
      return instance;
    }
  }

  // Don't attempt install more than once per session
  if (installAttempted) {
    throw new Error('AIDefence package not available. Install with: npm install @claude-flow/aidefence');
  }
  installAttempted = true;

  // Second attempt - auto-install and retry
  console.error(`[claude-flow] ${packageName} not found, attempting auto-install...`);
  const installed = await autoInstallPackage(packageName);

  if (!installed) {
    throw new Error('AIDefence package not available. Install with: npm install @claude-flow/aidefence');
  }

  const installedProjectLocal = await importProjectLocalPackage<typeof import('@claude-flow/aidefence')>(packageName);
  if (installedProjectLocal) {
    const instance = installedProjectLocal.createAIDefence({ enableLearning: true });
    if (instance) {
      aidefenceInstance = instance;
      console.error(`[claude-flow] ${packageName} loaded after install (project-local path)`);
      return instance;
    }
  }

  // #1807 — auto-install lands the package somewhere Node's standard
  // resolver couldn't find on the FIRST attempt (npm-global installs are
  // a common offender). Try Node's resolver again first (it may have
  // picked up the new node_modules directory), then fall back to the
  // file:// + cache-bust import dance, then surface a clearly actionable
  // error if everything still fails.
  // Plain re-import (covers project-local installs that landed where Node
  // looks). This often succeeds where the first attempt failed because
  // the module cache is stable across the await boundary.
  try {
    const aidefence = await import(packageName);
    const instance = aidefence.createAIDefence({ enableLearning: true });
    if (instance) {
      aidefenceInstance = instance;
      console.error(`[claude-flow] ${packageName} loaded after install (resolver path)`);
      return instance;
    }
  } catch { /* fall through to file:// attempt */ }

  // file:// + cache-bust attempt (covers globally-installed packages whose
  // path the standard resolver missed but require.resolve can locate).
  try {
    const modulePath = require.resolve(packageName);
    const cacheBust = `?t=${Date.now()}`;
    const aidefence = await import(`file://${modulePath}${cacheBust}`);
    const instance = aidefence.createAIDefence({ enableLearning: true });
    if (!instance) {
      throw new Error('createAIDefence returned null after install');
    }
    aidefenceInstance = instance;
    console.error(`[claude-flow] ${packageName} loaded after install (file:// path)`);
    return instance;
  } catch (retryError) {
    throw new Error(
      `AIDefence installed but failed to load: ${retryError}.\n` +
      `This usually means npm installed the package somewhere Node's module resolver doesn't search ` +
      `(common with global installs of \`claude-flow\`). Recovery options:\n` +
      `  1. Run \`npm install --save @claude-flow/aidefence\` in your project's working directory.\n` +
      `  2. Or run \`npx ruflo@latest mcp start\` from the project where the package is installed.\n` +
      `  3. Or restart the MCP server after the install completes.`
    );
  }
}

/**
 * Scan input for AI manipulation threats
 */
const aidefenceScanTool: MCPTool = {
  name: 'aidefence_scan',
  description: 'Scan input text for AI manipulation threats (prompt injection, jailbreaks, PII). Returns threat assessment with <10ms latency. Use when nothing native exists — Claude Code does not have a PII / prompt-injection / adversarial-text scanner. Pair with any tool that ingests untrusted input (browser scrape, federation envelope, memory_import_claude).',
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Text to scan for threats',
      },
      quick: {
        type: 'boolean',
        description: 'Quick scan mode (faster, less detailed)',
        default: false,
      },
    },
    required: ['input'],
  },
  handler: async (args: Record<string, unknown>): Promise<MCPToolResult> => {
    { const v = validateText(args.input, 'input'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
    const input = args.input as string;
    const quick = args.quick as boolean;

    try {
      const defender = await getAIDefence();

      if (quick) {
        const result = defender.quickScan(input);
        // Audit-flagged: quickScan focuses on prompt-injection/jailbreak
        // patterns and missed obvious PII (email + API key). Layer a fast
        // PII check so quick mode catches both threat classes.
        let piiPresent = false;
        try { piiPresent = !!defender.hasPII(input); } catch { /* hasPII unavailable */ }
        const threatDetected = result.threat || piiPresent;
        wrapperStats.quickScanCalls++;
        if (threatDetected) wrapperStats.quickScanThreats++;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              safe: !threatDetected,
              threatDetected,
              confidence: result.confidence,
              piiDetected: piiPresent,
              promptInjectionDetected: result.threat,
              mode: 'quick',
            }, null, 2),
          }],
        };
      }

      const result = await defender.detect(input);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            safe: result.safe,
            threats: result.threats.map(t => ({
              type: t.type,
              severity: t.severity,
              confidence: t.confidence,
              description: t.description,
            })),
            piiFound: result.piiFound,
            detectionTimeMs: result.detectionTimeMs,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: String(error) }),
        }],
        isError: true,
      };
    }
  },
};

/**
 * Deep analysis of specific threat
 */
const aidefenceAnalyzeTool: MCPTool = {
  name: 'aidefence_analyze',
  description: 'Deep analysis of input for specific threat types with similar pattern search and mitigation recommendations. Use when nothing native exists — Claude Code does not have a PII / prompt-injection / adversarial-text scanner. Pair with any tool that ingests untrusted input (browser scrape, federation envelope, memory_import_claude).',
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Text to analyze',
      },
      searchSimilar: {
        type: 'boolean',
        description: 'Search for similar known threats',
        default: true,
      },
      k: {
        type: 'number',
        description: 'Number of similar patterns to retrieve',
        default: 5,
      },
    },
    required: ['input'],
  },
  handler: async (args: Record<string, unknown>): Promise<MCPToolResult> => {
    { const v = validateText(args.input, 'input'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
    const input = args.input as string;
    const searchSimilar = args.searchSimilar !== false;
    const k = (args.k as number) || 5;

    try {
      const defender = await getAIDefence();
      const result = await defender.detect(input);

      const analysis: Record<string, unknown> = {
        detection: {
          safe: result.safe,
          threats: result.threats,
          piiFound: result.piiFound,
        },
        mitigations: [] as Array<{ threatType: string; strategy: string; effectiveness: number }>,
        similarPatterns: [] as Array<unknown>,
      };

      // Get mitigations for detected threats
      for (const threat of result.threats) {
        const mitigation = await defender.getBestMitigation(threat.type as Parameters<typeof defender.getBestMitigation>[0]);
        if (mitigation) {
          (analysis.mitigations as Array<unknown>).push({
            threatType: threat.type,
            strategy: mitigation.strategy,
            effectiveness: mitigation.effectiveness,
          });
        }
      }

      // Search similar patterns
      if (searchSimilar) {
        const similar = await defender.searchSimilarThreats(input, { k });
        analysis.similarPatterns = similar.map(p => ({
          pattern: p.pattern,
          type: p.type,
          effectiveness: p.effectiveness,
        }));
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(analysis, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: String(error) }),
        }],
        isError: true,
      };
    }
  },
};

/**
 * Get detection statistics
 */
const aidefenceStatsTool: MCPTool = {
  name: 'aidefence_stats',
  description: 'Get AIDefence detection and learning statistics. Use when nothing native exists — Claude Code does not have a PII / prompt-injection / adversarial-text scanner. Pair with any tool that ingests untrusted input (browser scrape, federation envelope, memory_import_claude).',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (): Promise<MCPToolResult> => {
    try {
      const defender = await getAIDefence();
      const stats = await defender.getStats();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            // Underlying defender stats (from full detect() calls via aidefence_scan/aidefence_analyze)
            detectionCount: stats.detectionCount,
            avgDetectionTimeMs: stats.avgDetectionTimeMs,
            learnedPatterns: stats.learnedPatterns,
            mitigationStrategies: stats.mitigationStrategies,
            avgMitigationEffectiveness: stats.avgMitigationEffectiveness,
            // ADR-093 follow-up: wrapper-level stats for the lightweight
            // tools that bypass the defender's own counters. Audit found
            // these stayed at 0 even after has_pii/is_safe/scan-quick
            // calls — these counters surface real activity.
            wrapper: {
              hasPiiCalls: wrapperStats.hasPiiCalls,
              hasPiiHits: wrapperStats.hasPiiHits,
              isSafeCalls: wrapperStats.isSafeCalls,
              isSafeUnsafeVerdicts: wrapperStats.isSafeUnsafeVerdicts,
              quickScanCalls: wrapperStats.quickScanCalls,
              quickScanThreats: wrapperStats.quickScanThreats,
            },
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: String(error) }),
        }],
        isError: true,
      };
    }
  },
};

/**
 * Record detection feedback for learning
 */
const aidefenceLearnTool: MCPTool = {
  name: 'aidefence_learn',
  description: 'Record detection feedback for pattern learning. Improves future detection accuracy. Use when nothing native exists — Claude Code does not have a PII / prompt-injection / adversarial-text scanner. Pair with any tool that ingests untrusted input (browser scrape, federation envelope, memory_import_claude).',
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Original input that was scanned',
      },
      wasAccurate: {
        type: 'boolean',
        description: 'Whether the detection was accurate',
      },
      verdict: {
        type: 'string',
        description: 'User verdict or correction',
      },
      threatType: {
        type: 'string',
        description: 'Threat type for mitigation recording',
      },
      mitigationStrategy: {
        type: 'string',
        description: 'Mitigation strategy used',
        enum: ['block', 'sanitize', 'warn', 'log', 'escalate', 'transform', 'redirect'],
      },
      mitigationSuccess: {
        type: 'boolean',
        description: 'Whether the mitigation was successful',
      },
    },
    required: ['input', 'wasAccurate'],
  },
  handler: async (args: Record<string, unknown>): Promise<MCPToolResult> => {
    { const v = validateText(args.input, 'input'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
    if (args.verdict) { const v = validateText(args.verdict, 'verdict'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
    if (args.threatType) { const v = validateIdentifier(args.threatType, 'threatType'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
    const input = args.input as string;
    const wasAccurate = args.wasAccurate as boolean;
    const verdict = args.verdict as string | undefined;
    const threatType = args.threatType as string | undefined;
    const mitigationStrategy = args.mitigationStrategy as string | undefined;
    const mitigationSuccess = args.mitigationSuccess as boolean | undefined;

    try {
      const defender = await getAIDefence();

      // Re-detect to get result for learning
      const result = await defender.detect(input);

      // Learn from detection
      await defender.learnFromDetection(input, result, {
        wasAccurate,
        userVerdict: verdict,
      });

      // Record mitigation if provided
      if (threatType && mitigationStrategy && mitigationSuccess !== undefined) {
        await defender.recordMitigation(
          threatType as Parameters<typeof defender.recordMitigation>[0],
          mitigationStrategy as Parameters<typeof defender.recordMitigation>[1],
          mitigationSuccess
        );
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'Feedback recorded for pattern learning',
            learnedFrom: {
              input: input.slice(0, 50) + (input.length > 50 ? '...' : ''),
              wasAccurate,
              threatCount: result.threats.length,
            },
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: String(error) }),
        }],
        isError: true,
      };
    }
  },
};

/**
 * Check if input is safe (simple boolean check)
 */
const aidefenceIsSafeTool: MCPTool = {
  name: 'aidefence_is_safe',
  description: 'Quick boolean check if input is safe. Fastest option for simple validation. Use when nothing native exists — Claude Code does not have a PII / prompt-injection / adversarial-text scanner. Pair with any tool that ingests untrusted input (browser scrape, federation envelope, memory_import_claude).',
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Text to check',
      },
    },
    required: ['input'],
  },
  handler: async (args: Record<string, unknown>): Promise<MCPToolResult> => {
    { const v = validateText(args.input, 'input'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
    const input = args.input as string;

    try {
      // Route through the singleton so wrapper stats track this call,
      // and so a single defender controls both the prompt-injection model
      // and the PII detector.
      const defender = await getAIDefence();
      const { isSafe } = await import('@claude-flow/aidefence');
      const promptSafe = isSafe(input);
      let piiPresent = false;
      try { piiPresent = !!defender.hasPII(input); } catch { /* hasPII unavailable */ }
      const safe = promptSafe && !piiPresent;
      wrapperStats.isSafeCalls++;
      if (!safe) wrapperStats.isSafeUnsafeVerdicts++;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            safe,
            promptSafe,
            piiPresent,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: String(error) }),
        }],
        isError: true,
      };
    }
  },
};

/**
 * Check for PII in input
 */
const aidefenceHasPIITool: MCPTool = {
  name: 'aidefence_has_pii',
  description: 'Check if input contains PII (emails, SSNs, API keys, passwords, etc.). Use when nothing native exists — Claude Code does not have a PII / prompt-injection / adversarial-text scanner. Pair with any tool that ingests untrusted input (browser scrape, federation envelope, memory_import_claude).',
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Text to check for PII',
      },
    },
    required: ['input'],
  },
  handler: async (args: Record<string, unknown>): Promise<MCPToolResult> => {
    { const v = validateText(args.input, 'input'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
    const input = args.input as string;

    try {
      const defender = await getAIDefence();
      const hasPII = defender.hasPII(input);
      wrapperStats.hasPiiCalls++;
      if (hasPII) wrapperStats.hasPiiHits++;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ hasPII }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: String(error) }),
        }],
        isError: true,
      };
    }
  },
};

/**
 * Export all security tools
 */
export const securityTools: MCPTool[] = [
  aidefenceScanTool,
  aidefenceAnalyzeTool,
  aidefenceStatsTool,
  aidefenceLearnTool,
  aidefenceIsSafeTool,
  aidefenceHasPIITool,
];

export default securityTools;
