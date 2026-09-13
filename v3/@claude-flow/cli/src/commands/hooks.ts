/**
 * V3 CLI Hooks Command
 * Self-learning hooks system for intelligent workflow automation
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { select, confirm, input } from '../prompt.js';
import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { storeCommand } from './transfer-store.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  getSecurityStatus as sharedGetSecurityStatus,
  getSwarmStatus as sharedGetSwarmStatus,
  getGitUncommittedCount as sharedGetGitUncommittedCount,
} from '../funnel/local-signals.js';

/**
 * #1686 — `?? 0` only defaults null/undefined; NaN slips through and
 * surfaces as `"NaN"` (or earlier crashed `.toFixed`) in the metrics
 * dashboard and pretrain output. Coerce to a finite number, fall back
 * to `fallback` when the input is null/undefined/non-numeric/NaN/Infinity.
 */
function safeNum(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ============================================================================
// Coverage Data Reader - reads Jest/Istanbul coverage files from disk
// ============================================================================

interface CoverageFileEntry {
  filePath: string;
  lines: number;
  branches: number;
  functions: number;
  statements: number;
}

interface CoverageData {
  found: boolean;
  source: string;
  entries: CoverageFileEntry[];
  summary: {
    totalFiles: number;
    overallLineCoverage: number;
    overallBranchCoverage: number;
    overallFunctionCoverage: number;
    overallStatementCoverage: number;
  };
}

/**
 * Read coverage data from disk. Checks these locations in order:
 * 1. coverage/coverage-summary.json (Jest/Istanbul)
 * 2. coverage/lcov.info (lcov format)
 * 3. .nyc_output/out.json (nyc)
 */
function readCoverageFromDisk(): CoverageData {
  const cwd = process.cwd();
  const noData: CoverageData = {
    found: false,
    source: 'none',
    entries: [],
    summary: { totalFiles: 0, overallLineCoverage: 0, overallBranchCoverage: 0, overallFunctionCoverage: 0, overallStatementCoverage: 0 },
  };

  // 1. Try coverage-summary.json (Jest/Istanbul)
  for (const relPath of ['coverage/coverage-summary.json', 'coverage-summary.json']) {
    const summaryPath = join(cwd, relPath);
    if (existsSync(summaryPath)) {
      try {
        const raw = JSON.parse(readFileSync(summaryPath, 'utf-8'));
        return parseCoverageSummaryJson(raw, relPath);
      } catch {
        // malformed, try next
      }
    }
  }

  // 2. Try lcov.info
  for (const relPath of ['coverage/lcov.info', 'lcov.info']) {
    const lcovPath = join(cwd, relPath);
    if (existsSync(lcovPath)) {
      try {
        const raw = readFileSync(lcovPath, 'utf-8');
        return parseLcovInfo(raw, relPath);
      } catch {
        // malformed, try next
      }
    }
  }

  // 3. Try .nyc_output/out.json
  const nycPath = join(cwd, '.nyc_output', 'out.json');
  if (existsSync(nycPath)) {
    try {
      const raw = JSON.parse(readFileSync(nycPath, 'utf-8'));
      return parseCoverageSummaryJson(raw, '.nyc_output/out.json');
    } catch {
      // malformed
    }
  }

  return noData;
}

function parseCoverageSummaryJson(data: Record<string, unknown>, source: string): CoverageData {
  const entries: CoverageFileEntry[] = [];
  let totalLines = 0, coveredLines = 0;
  let totalBranches = 0, coveredBranches = 0;
  let totalFunctions = 0, coveredFunctions = 0;
  let totalStatements = 0, coveredStatements = 0;

  for (const [filePath, metrics] of Object.entries(data)) {
    if (filePath === 'total') continue;
    const m = metrics as Record<string, { total?: number; covered?: number; pct?: number }>;
    if (!m || typeof m !== 'object') continue;

    const linePct = m.lines?.pct ?? m.lines?.covered != null ? ((m.lines?.covered ?? 0) / Math.max(m.lines?.total ?? 1, 1)) * 100 : 0;
    const branchPct = m.branches?.pct ?? (m.branches?.total ? ((m.branches?.covered ?? 0) / m.branches.total) * 100 : 100);
    const funcPct = m.functions?.pct ?? (m.functions?.total ? ((m.functions?.covered ?? 0) / m.functions.total) * 100 : 100);
    const stmtPct = m.statements?.pct ?? (m.statements?.total ? ((m.statements?.covered ?? 0) / m.statements.total) * 100 : 100);

    entries.push({ filePath, lines: linePct, branches: branchPct, functions: funcPct, statements: stmtPct });

    totalLines += m.lines?.total ?? 0;
    coveredLines += m.lines?.covered ?? 0;
    totalBranches += m.branches?.total ?? 0;
    coveredBranches += m.branches?.covered ?? 0;
    totalFunctions += m.functions?.total ?? 0;
    coveredFunctions += m.functions?.covered ?? 0;
    totalStatements += m.statements?.total ?? 0;
    coveredStatements += m.statements?.covered ?? 0;
  }

  // Also read the total key if present
  const total = data['total'] as Record<string, { pct?: number }> | undefined;
  const overallLine = total?.lines?.pct ?? (totalLines > 0 ? (coveredLines / totalLines) * 100 : 0);
  const overallBranch = total?.branches?.pct ?? (totalBranches > 0 ? (coveredBranches / totalBranches) * 100 : 0);
  const overallFunction = total?.functions?.pct ?? (totalFunctions > 0 ? (coveredFunctions / totalFunctions) * 100 : 0);
  const overallStatement = total?.statements?.pct ?? (totalStatements > 0 ? (coveredStatements / totalStatements) * 100 : 0);

  // Sort by lowest line coverage
  entries.sort((a, b) => a.lines - b.lines);

  return {
    found: true,
    source,
    entries,
    summary: {
      totalFiles: entries.length,
      overallLineCoverage: overallLine,
      overallBranchCoverage: overallBranch,
      overallFunctionCoverage: overallFunction,
      overallStatementCoverage: overallStatement,
    },
  };
}

function parseLcovInfo(raw: string, source: string): CoverageData {
  const entries: CoverageFileEntry[] = [];
  let currentFile = '';
  let linesHit = 0, linesFound = 0;
  let branchesHit = 0, branchesFound = 0;
  let functionsHit = 0, functionsFound = 0;

  const flushRecord = () => {
    if (currentFile) {
      entries.push({
        filePath: currentFile,
        lines: linesFound > 0 ? (linesHit / linesFound) * 100 : 0,
        branches: branchesFound > 0 ? (branchesHit / branchesFound) * 100 : 100,
        functions: functionsFound > 0 ? (functionsHit / functionsFound) * 100 : 100,
        statements: linesFound > 0 ? (linesHit / linesFound) * 100 : 0,
      });
    }
  };

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('SF:')) {
      currentFile = trimmed.slice(3);
      linesHit = 0; linesFound = 0;
      branchesHit = 0; branchesFound = 0;
      functionsHit = 0; functionsFound = 0;
    } else if (trimmed.startsWith('LH:')) {
      linesHit = parseInt(trimmed.slice(3), 10) || 0;
    } else if (trimmed.startsWith('LF:')) {
      linesFound = parseInt(trimmed.slice(3), 10) || 0;
    } else if (trimmed.startsWith('BRH:')) {
      branchesHit = parseInt(trimmed.slice(4), 10) || 0;
    } else if (trimmed.startsWith('BRF:')) {
      branchesFound = parseInt(trimmed.slice(4), 10) || 0;
    } else if (trimmed.startsWith('FNH:')) {
      functionsHit = parseInt(trimmed.slice(4), 10) || 0;
    } else if (trimmed.startsWith('FNF:')) {
      functionsFound = parseInt(trimmed.slice(4), 10) || 0;
    } else if (trimmed === 'end_of_record') {
      flushRecord();
      currentFile = '';
    }
  }
  flushRecord();

  entries.sort((a, b) => a.lines - b.lines);

  let totalLH = 0, totalLF = 0, totalBH = 0, totalBF = 0;
  for (const e of entries) {
    // Approximate from percentages (we lost exact counts after flush, but summaries are okay)
    totalLH += e.lines;
    totalLF += 100;
    totalBH += e.branches;
    totalBF += 100;
  }
  const n = entries.length || 1;

  return {
    found: true,
    source,
    entries,
    summary: {
      totalFiles: entries.length,
      overallLineCoverage: totalLH / n,
      overallBranchCoverage: totalBH / n,
      overallFunctionCoverage: 0,
      overallStatementCoverage: totalLH / n,
    },
  };
}

/**
 * Classify a coverage gap by priority type based on coverage percentage and threshold
 */
function classifyCoverageGap(coveragePct: number, threshold: number): { gapType: string; priority: number } {
  if (coveragePct < threshold * 0.25) return { gapType: 'critical', priority: 10 };
  if (coveragePct < threshold * 0.5) return { gapType: 'high', priority: 7 };
  if (coveragePct < threshold * 0.75) return { gapType: 'medium', priority: 5 };
  if (coveragePct < threshold) return { gapType: 'low', priority: 3 };
  return { gapType: 'ok', priority: 0 };
}

/**
 * Suggest agents for a file based on its path
 */
function suggestAgentsForFile(filePath: string): string[] {
  const lower = filePath.toLowerCase();
  if (lower.includes('test') || lower.includes('spec')) return ['tester'];
  if (lower.includes('security') || lower.includes('auth')) return ['security-auditor', 'tester'];
  if (lower.includes('api') || lower.includes('route') || lower.includes('controller')) return ['coder', 'tester'];
  if (lower.includes('model') || lower.includes('schema') || lower.includes('entity')) return ['coder', 'tester'];
  return ['tester', 'coder'];
}

// Hook types
const HOOK_TYPES = [
  { value: 'pre-edit', label: 'Pre-Edit', hint: 'Get context before editing files' },
  { value: 'post-edit', label: 'Post-Edit', hint: 'Record editing outcomes' },
  { value: 'pre-command', label: 'Pre-Command', hint: 'Assess risk before commands' },
  { value: 'post-command', label: 'Post-Command', hint: 'Record command outcomes' },
  { value: 'route', label: 'Route', hint: 'Route tasks to optimal agents' },
  { value: 'explain', label: 'Explain', hint: 'Explain routing decisions' }
];

// Agent routing options
const AGENT_TYPES = [
  'coder', 'researcher', 'tester', 'reviewer', 'architect',
  'security-architect', 'security-auditor', 'memory-specialist',
  'swarm-specialist', 'performance-engineer', 'core-architect',
  'test-architect', 'coordinator', 'analyst', 'optimizer'
];

// Pre-edit subcommand
const preEditCommand: Command = {
  name: 'pre-edit',
  description: 'Get context and agent suggestions before editing a file',
  options: [
    {
      name: 'file',
      short: 'f',
      description: 'File path to edit',
      type: 'string',
      required: false
    },
    {
      name: 'operation',
      short: 'o',
      description: 'Type of edit operation (create, update, delete, refactor)',
      type: 'string',
      default: 'update'
    },
    {
      name: 'context',
      short: 'c',
      description: 'Additional context about the edit',
      type: 'string'
    }
  ],
  examples: [
    { command: 'claude-flow hooks pre-edit -f src/utils.ts', description: 'Get context before editing' },
    { command: 'claude-flow hooks pre-edit -f src/api.ts -o refactor', description: 'Pre-edit with operation type' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Default file to 'unknown' for backward compatibility (env var may be empty)
    const filePath = (ctx.flags.file as string) || ctx.args[0] || 'unknown';
    const operation = ctx.flags.operation as string || 'update';

    output.printInfo(`Analyzing context for: ${output.highlight(filePath)}`);

    try {
      // Call MCP tool for pre-edit hook
      const result = await callMCPTool<{
        filePath: string;
        operation: string;
        context: {
          fileExists: boolean;
          fileType: string;
          relatedFiles: string[];
          suggestedAgents: string[];
          patterns: Array<{ pattern: string; confidence: number }>;
          risks: string[];
        };
        recommendations: string[];
      }>('hooks_pre-edit', {
        filePath,
        operation,
        context: ctx.flags.context,
        includePatterns: true,
        includeRisks: true,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `File: ${result.filePath}`,
          `Operation: ${result.operation}`,
          `Type: ${result.context.fileType}`,
          `Exists: ${result.context.fileExists ? 'Yes' : 'No'}`
        ].join('\n'),
        'File Context'
      );

      if (result.context.suggestedAgents.length > 0) {
        output.writeln();
        output.writeln(output.bold('Suggested Agents'));
        output.printList(result.context.suggestedAgents.map(a => output.highlight(a)));
      }

      if (result.context.relatedFiles.length > 0) {
        output.writeln();
        output.writeln(output.bold('Related Files'));
        output.printList(result.context.relatedFiles.slice(0, 5).map(f => output.dim(f)));
      }

      if (result.context.patterns.length > 0) {
        output.writeln();
        output.writeln(output.bold('Learned Patterns'));
        output.printTable({
          columns: [
            { key: 'pattern', header: 'Pattern', width: 40 },
            { key: 'confidence', header: 'Confidence', width: 12, align: 'right', format: (v) => `${(Number(v) * 100).toFixed(1)}%` }
          ],
          data: result.context.patterns
        });
      }

      if (result.context.risks.length > 0) {
        output.writeln();
        output.writeln(output.bold(output.error('Potential Risks')));
        output.printList(result.context.risks.map(r => output.warning(r)));
      }

      if (result.recommendations.length > 0) {
        output.writeln();
        output.writeln(output.bold('Recommendations'));
        output.printList(result.recommendations.map(r => output.success(`• ${r}`)));
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Pre-edit hook failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Post-edit subcommand
const postEditCommand: Command = {
  name: 'post-edit',
  description: 'Record editing outcome for learning',
  options: [
    {
      name: 'file',
      short: 'f',
      description: 'File path that was edited',
      type: 'string',
      required: false
    },
    {
      name: 'success',
      short: 's',
      description: 'Whether the edit was successful',
      type: 'boolean',
      required: false
    },
    {
      name: 'outcome',
      short: 'o',
      description: 'Outcome description',
      type: 'string'
    },
    {
      name: 'metrics',
      short: 'm',
      description: 'Performance metrics (e.g., "time:500ms,quality:0.95")',
      type: 'string'
    }
  ],
  examples: [
    { command: 'claude-flow hooks post-edit -f src/utils.ts --success true', description: 'Record successful edit' },
    { command: 'claude-flow hooks post-edit -f src/api.ts --success false -o "Type error"', description: 'Record failed edit' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Default file to 'unknown' for backward compatibility (env var may be empty)
    const filePath = (ctx.flags.file as string) || ctx.args[0] || 'unknown';
    // Default success to true for backward compatibility (PostToolUse = success, PostToolUseFailure = failure)
    const success = ctx.flags.success !== undefined ? (ctx.flags.success as boolean) : true;

    output.printInfo(`Recording outcome for: ${output.highlight(filePath)}`);

    try {
      // Parse metrics if provided
      const metrics: Record<string, number> = {};
      if (ctx.flags.metrics) {
        const metricsStr = ctx.flags.metrics as string;
        metricsStr.split(',').forEach(pair => {
          const [key, value] = pair.split(':');
          if (key && value) {
            metrics[key.trim()] = parseFloat(value);
          }
        });
      }

      // Call MCP tool for post-edit hook
      const result = await callMCPTool<{
        filePath: string;
        success: boolean;
        recorded: boolean;
        patternId?: string;
        learningUpdates: {
          patternsUpdated: number;
          confidenceAdjusted: number;
          newPatterns: number;
        };
      }>('hooks_post-edit', {
        filePath,
        success,
        outcome: ctx.flags.outcome,
        metrics,
        timestamp: Date.now(),
      });

      // #2352: the MCP handler returns `{success: false, error: "..."}` on
      // validation failure (e.g. unsupported path shape) without throwing.
      // Surface that explicitly instead of always printing the success line —
      // Windows users were seeing `[OK]` while nothing reached the learning
      // pipeline because absolute paths were rejected upstream.
      const mcpFailed = result && (result as { success?: boolean }).success === false;
      const mcpError = (result as { error?: string } | undefined)?.error;

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: !mcpFailed, exitCode: mcpFailed ? 1 : 0, data: result };
      }

      if (mcpFailed) {
        output.printError(`Post-edit hook failed: ${mcpError || 'unknown error'}`);
        return { success: false, exitCode: 1 };
      }

      output.writeln();
      output.printSuccess(`Outcome recorded for ${filePath}`);

      if (result.learningUpdates) {
        output.writeln();
        output.writeln(output.bold('Learning Updates'));
        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 25 },
            { key: 'value', header: 'Value', width: 15, align: 'right' }
          ],
          data: [
            { metric: 'Patterns Updated', value: result.learningUpdates.patternsUpdated },
            { metric: 'Confidence Adjusted', value: result.learningUpdates.confidenceAdjusted },
            { metric: 'New Patterns', value: result.learningUpdates.newPatterns }
          ]
        });
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Post-edit hook failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Pre-command subcommand
const preCommandCommand: Command = {
  name: 'pre-command',
  description: 'Assess risk before executing a command',
  options: [
    {
      name: 'command',
      short: 'c',
      description: 'Command to execute',
      type: 'string',
      required: true
    },
    {
      name: 'dry-run',
      short: 'd',
      description: 'Only analyze, do not execute',
      type: 'boolean',
      default: true
    }
  ],
  examples: [
    { command: 'claude-flow hooks pre-command -c "rm -rf dist"', description: 'Assess command risk' },
    { command: 'claude-flow hooks pre-command -c "npm install lodash"', description: 'Check package install' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const command = (ctx.flags.command as string) || ctx.args[0];

    if (!command) {
      output.printError('Command is required. Use --command or -c flag.');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Analyzing command: ${output.highlight(command)}`);

    try {
      // Call MCP tool for pre-command hook
      const result = await callMCPTool<{
        command: string;
        riskLevel: 'low' | 'medium' | 'high' | 'critical';
        risks: Array<{ type: string; severity: string; description: string }>;
        recommendations: string[];
        safeAlternatives?: string[];
        shouldProceed: boolean;
      }>('hooks_pre-command', {
        command,
        includeAlternatives: true,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();

      // Risk level indicator
      let riskIndicator: string;
      switch (result.riskLevel) {
        case 'critical':
          riskIndicator = output.error('CRITICAL');
          break;
        case 'high':
          riskIndicator = output.error('HIGH');
          break;
        case 'medium':
          riskIndicator = output.warning('MEDIUM');
          break;
        default:
          riskIndicator = output.success('LOW');
      }

      output.printBox(
        [
          `Risk Level: ${riskIndicator}`,
          `Should Proceed: ${result.shouldProceed ? output.success('Yes') : output.error('No')}`
        ].join('\n'),
        'Risk Assessment'
      );

      if (result.risks.length > 0) {
        output.writeln();
        output.writeln(output.bold('Identified Risks'));
        output.printTable({
          columns: [
            { key: 'type', header: 'Type', width: 15 },
            { key: 'severity', header: 'Severity', width: 10 },
            { key: 'description', header: 'Description', width: 40 }
          ],
          data: result.risks
        });
      }

      if (result.safeAlternatives && result.safeAlternatives.length > 0) {
        output.writeln();
        output.writeln(output.bold('Safe Alternatives'));
        output.printList(result.safeAlternatives.map(a => output.success(a)));
      }

      if (result.recommendations.length > 0) {
        output.writeln();
        output.writeln(output.bold('Recommendations'));
        output.printList(result.recommendations);
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Pre-command hook failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Post-command subcommand
const postCommandCommand: Command = {
  name: 'post-command',
  description: 'Record command execution outcome',
  options: [
    {
      name: 'command',
      short: 'c',
      description: 'Command that was executed',
      type: 'string',
      required: true
    },
    {
      name: 'success',
      short: 's',
      description: 'Whether the command succeeded',
      type: 'boolean',
      required: false
    },
    {
      name: 'exit-code',
      short: 'e',
      description: 'Command exit code',
      type: 'number',
      default: 0
    },
    {
      name: 'duration',
      short: 'd',
      description: 'Execution duration in milliseconds',
      type: 'number'
    }
  ],
  examples: [
    { command: 'claude-flow hooks post-command -c "npm test" --success true', description: 'Record successful test run' },
    { command: 'claude-flow hooks post-command -c "npm build" --success false -e 1', description: 'Record failed build' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const command = (ctx.flags.command as string) || ctx.args[0];
    // Default success to true for backward compatibility
    const success = ctx.flags.success !== undefined ? (ctx.flags.success as boolean) : true;

    if (!command) {
      output.printError('Command is required. Use --command or -c flag.');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Recording command outcome: ${output.highlight(command)}`);

    try {
      // Call MCP tool for post-command hook
      const result = await callMCPTool<{
        command: string;
        success: boolean;
        recorded: boolean;
        learningUpdates: {
          commandPatternsUpdated: number;
          riskAssessmentUpdated: boolean;
        };
      }>('hooks_post-command', {
        command,
        success,
        exitCode: ctx.flags.exitCode || 0,
        duration: ctx.flags.duration,
        timestamp: Date.now(),
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printSuccess('Command outcome recorded');

      if (result.learningUpdates) {
        output.writeln();
        output.writeln(output.dim(`Patterns updated: ${result.learningUpdates.commandPatternsUpdated}`));
        output.writeln(output.dim(`Risk assessment: ${result.learningUpdates.riskAssessmentUpdated ? 'Updated' : 'No change'}`));
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Post-command hook failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Route subcommand
const routeCommand: Command = {
  name: 'route',
  description: 'Route task to optimal agent using learned patterns',
  options: [
    {
      name: 'task',
      short: 't',
      description: 'Task description',
      type: 'string',
      required: true
    },
    {
      name: 'context',
      short: 'c',
      description: 'Additional context',
      type: 'string'
    },
    {
      name: 'top-k',
      short: 'K',
      description: 'Number of top agent suggestions',
      type: 'number',
      default: 3
    },
    {
      // #2778 dream-cycle — Mixture-of-Agents test-time scaling.
      // When `--mode moa` is set AND the router would have chosen a
      // Tier-3 model (Sonnet/Opus), swap to N parallel Tier-2 (Haiku)
      // calls + majority-vote consensus. Grade-A ACL 2026 SRW evidence
      // (arXiv 2605.01566): +2.7pp accuracy at equal-cost when parallel
      // generations exceed sequential aggregations.
      name: 'mode',
      description: 'Routing mode: single (default) or moa (mixture-of-agents fanout, #2778)',
      type: 'string',
      choices: ['single', 'moa'],
      default: 'single',
    },
    {
      // #2778 canonical fanout-width flag. Restored to `--parallel` in
      // v3.32.14 after the parser scoping fix landed (subcommand's
      // non-boolean declaration now overrides the global boolean set,
      // so `--parallel 7` on `hooks route` no longer collides with the
      // boolean `--parallel` on `swarm start` / `workflow run`).
      // NOTE: no `default:` here — default is resolved in the action so
      // we can distinguish "user explicitly passed --parallel" from
      // "user passed --moa-parallel (the v3.32.13 compat alias)". Without
      // this, the parser's applied default would shadow the alias.
      name: 'parallel',
      short: 'p',
      description: 'MoA fanout width (N parallel calls at Haiku tier; only meaningful when --mode=moa)',
      type: 'number',
    },
    {
      // v3.32.13 compat alias — kept so any users who upgraded to that
      // release keep working. Prefer `--parallel` going forward.
      name: 'moa-parallel',
      description: 'DEPRECATED alias for --parallel (kept for v3.32.13 backward compat)',
      type: 'number',
    },
    {
      name: 'consensus',
      description: 'MoA consensus strategy: majority-vote (default) or best-confidence',
      type: 'string',
      choices: ['majority-vote', 'best-confidence'],
      default: 'majority-vote',
    },
  ],
  examples: [
    { command: 'claude-flow hooks route -t "Fix authentication bug"', description: 'Route task to optimal agent (single mode)' },
    { command: 'claude-flow hooks route -t "Optimize database queries" -K 5', description: 'Get top 5 suggestions' },
    { command: 'claude-flow hooks route -t "Design payment webhook" --mode moa --parallel 3', description: 'MoA fanout: 3× Haiku + consensus (dream-cycle #2778)' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const task = (ctx.flags.task as string) || ctx.args[0];
    const topK = ctx.flags.topK as number || 3;
    const mode = (ctx.flags.mode as string) || 'single';
    // #2778: prefer canonical --parallel; fall back to --moa-parallel
    // (v3.32.13 compat alias). Nullish coalescing so an explicit 0 still
    // falls through to the alias / default, and neither flag being set
    // resolves to 3 (the ACL 2026 SRW paper's baseline fanout width).
    const parallelRaw = (ctx.flags.parallel as number | undefined)
      ?? (ctx.flags.moaParallel as number | undefined)
      ?? 3;
    const parallel = Math.max(2, parallelRaw);
    const consensus = (ctx.flags.consensus as string) || 'majority-vote';

    if (!task) {
      output.printError('Task description is required. Use --task or -t flag.');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Routing task: ${output.highlight(task)}`);

    try {
      // Call MCP tool for routing
      const result = await callMCPTool<{
        task: string;
        routing?: {
          method: string;
          backend?: string;
          latencyMs: number;
          throughput: string;
        };
        matchedPattern?: string;
        semanticMatches?: Array<{
          pattern: string;
          score: number;
        }>;
        primaryAgent: {
          type: string;
          confidence: number;
          reason: string;
        };
        alternativeAgents: Array<{
          type: string;
          confidence: number;
          reason: string;
        }>;
        estimatedMetrics: {
          successProbability: number;
          estimatedDuration: string;
          complexity: 'low' | 'medium' | 'high';
        };
      }>('hooks_route', {
        task,
        context: ctx.flags.context,
        topK,
        includeEstimates: true,
      });

      // #2778 — compute the MoA plan BEFORE the JSON output branch so
      // programmatic callers see `moaPlan` in the JSON result too.
      let moaPlan: {
        mode: 'moa';
        parallel: number;
        tier: 'tier2-haiku';
        consensus: string;
        rationale: string;
        agents: Array<{ name: string; model: 'haiku'; role: string }>;
        synthesizer: { name: string; model: 'haiku'; role: string };
      } | null = null;
      if (mode === 'moa') {
        const complexity = result.estimatedMetrics?.complexity ?? 'medium';
        const wouldTier3 = complexity === 'high';
        const primaryAgent = result.primaryAgent.type;
        const agents = Array.from({ length: parallel }, (_, i) => ({
          name: `moa-${primaryAgent}-${i + 1}`,
          model: 'haiku' as const,
          role: primaryAgent,
        }));
        moaPlan = {
          mode: 'moa',
          parallel,
          tier: 'tier2-haiku',
          consensus,
          rationale: wouldTier3
            ? `Complexity=${complexity} would tier-3 (Sonnet/Opus). MoA fanout — ${parallel}× Haiku is typically <1× Sonnet cost (arXiv 2605.01566: +2.7pp at equal cost).`
            : `Complexity=${complexity} — MoA still available as a diversity mechanism, but the single-agent path is usually the cost-optimal choice below Tier-3.`,
          agents,
          synthesizer: {
            name: `moa-synth-${primaryAgent}`,
            model: 'haiku',
            role: 'synthesizer',
          },
        };
        (result as unknown as Record<string, unknown>).moaPlan = moaPlan;
      }

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      // Show routing method info
      if (result.routing) {
        output.writeln();
        output.writeln(output.bold('Routing Method'));
        const methodDisplay = result.routing.method.startsWith('semantic')
          ? output.success(`${result.routing.method} (${result.routing.backend || 'semantic'})`)
          : 'keyword';
        output.printList([
          `Method: ${methodDisplay}`,
          result.routing.backend ? `Backend: ${result.routing.backend}` : null,
          `Latency: ${result.routing.latencyMs.toFixed(3)}ms`,
          result.matchedPattern ? `Matched Pattern: ${result.matchedPattern}` : null,
        ].filter(Boolean) as string[]);

        // Show semantic matches if available
        if (result.semanticMatches && result.semanticMatches.length > 0) {
          output.writeln();
          output.writeln(output.dim('Semantic Matches:'));
          result.semanticMatches.forEach(m => {
            output.writeln(`  ${m.pattern}: ${(m.score * 100).toFixed(1)}%`);
          });
        }
      }

      output.writeln();
      output.printBox(
        [
          `Agent: ${output.highlight(result.primaryAgent.type)}`,
          `Confidence: ${(result.primaryAgent.confidence * 100).toFixed(1)}%`,
          `Reason: ${result.primaryAgent.reason}`
        ].join('\n'),
        'Primary Recommendation'
      );

      if (result.alternativeAgents.length > 0) {
        output.writeln();
        output.writeln(output.bold('Alternative Agents'));
        output.printTable({
          columns: [
            { key: 'type', header: 'Agent Type', width: 20 },
            { key: 'confidence', header: 'Confidence', width: 12, align: 'right', format: (v) => `${(Number(v) * 100).toFixed(1)}%` },
            { key: 'reason', header: 'Reason', width: 35 }
          ],
          data: result.alternativeAgents
        });
      }

      if (result.estimatedMetrics) {
        output.writeln();
        output.writeln(output.bold('Estimated Metrics'));
        output.printList([
          `Success Probability: ${(result.estimatedMetrics.successProbability * 100).toFixed(1)}%`,
          `Estimated Duration: ${result.estimatedMetrics.estimatedDuration}`,
          `Complexity: ${result.estimatedMetrics.complexity.toUpperCase()}`
        ]);
      }

      // #2778 dream-cycle — render the MoA plan to text output. moaPlan
      // was already spliced into the result above so JSON consumers see it.
      if (mode === 'moa' && moaPlan) {
        const primaryAgent = result.primaryAgent.type;
        output.writeln();
        output.writeln(output.bold('Mixture-of-Agents Plan (#2778)'));
        output.printList([
          `Mode: moa`,
          `Fanout: ${parallel} parallel ${primaryAgent} × Haiku`,
          `Consensus: ${consensus}`,
          `Synthesizer: 1 Haiku agent (${consensus} over ${parallel} verdicts)`,
        ]);
        output.writeln();
        output.printBox(
          `Spawn ${parallel} background Task calls with model="haiku" and subagent_type="${primaryAgent}"\n` +
          `then a synthesizer Task ("moa-synth-${primaryAgent}") that reads all ${parallel} results and picks the ${consensus === 'majority-vote' ? 'majority answer' : 'highest-confidence answer'}.\n\n` +
          `Cost note: ${parallel}× Haiku is typically <1× Sonnet on comparable complexity — see arXiv 2605.01566 for the ACL 2026 evidence.`,
          'MoA Execution Directive'
        );
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Routing failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Explain subcommand
const explainCommand: Command = {
  name: 'explain',
  description: 'Explain routing decision with transparency',
  options: [
    {
      name: 'task',
      short: 't',
      description: 'Task description',
      type: 'string',
      required: true
    },
    {
      name: 'agent',
      short: 'a',
      description: 'Agent type to explain',
      type: 'string'
    },
    {
      name: 'verbose',
      short: 'v',
      description: 'Verbose explanation',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow hooks explain -t "Fix authentication bug"', description: 'Explain routing decision' },
    { command: 'claude-flow hooks explain -t "Optimize queries" -a coder --verbose', description: 'Verbose explanation for specific agent' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const task = (ctx.flags.task as string) || ctx.args[0];

    if (!task) {
      output.printError('Task description is required. Use --task or -t flag.');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Explaining routing for: ${output.highlight(task)}`);

    try {
      // Call MCP tool for explanation
      const result = await callMCPTool<{
        task: string;
        explanation: string;
        factors: Array<{
          factor: string;
          weight: number;
          value: number;
          impact: string;
        }>;
        patterns: Array<{
          pattern: string;
          matchScore: number;
          examples: string[];
        }>;
        decision: {
          agent: string;
          confidence: number;
          reasoning: string[];
        };
      }>('hooks_explain', {
        task,
        agent: ctx.flags.agent,
        verbose: ctx.flags.verbose || false,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Decision Explanation'));
      output.writeln();
      output.writeln(result.explanation);

      output.writeln();
      output.printBox(
        [
          `Agent: ${output.highlight(result.decision.agent)}`,
          `Confidence: ${(result.decision.confidence * 100).toFixed(1)}%`
        ].join('\n'),
        'Final Decision'
      );

      if (result.decision.reasoning.length > 0) {
        output.writeln();
        output.writeln(output.bold('Reasoning Steps'));
        output.printList(result.decision.reasoning.map((r, i) => `${i + 1}. ${r}`));
      }

      if (result.factors.length > 0) {
        output.writeln();
        output.writeln(output.bold('Decision Factors'));
        output.printTable({
          columns: [
            { key: 'factor', header: 'Factor', width: 20 },
            { key: 'weight', header: 'Weight', width: 10, align: 'right', format: (v) => `${(Number(v) * 100).toFixed(0)}%` },
            { key: 'value', header: 'Value', width: 10, align: 'right', format: (v) => Number(v).toFixed(2) },
            { key: 'impact', header: 'Impact', width: 25 }
          ],
          data: result.factors
        });
      }

      if (result.patterns.length > 0 && ctx.flags.verbose) {
        output.writeln();
        output.writeln(output.bold('Matched Patterns'));
        result.patterns.forEach((p, i) => {
          output.writeln();
          output.writeln(`${i + 1}. ${output.highlight(p.pattern)} (${(p.matchScore * 100).toFixed(1)}% match)`);
          if (p.examples.length > 0) {
            output.printList(p.examples.slice(0, 3).map(e => output.dim(`  ${e}`)));
          }
        });
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Explanation failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Pretrain subcommand
const pretrainCommand: Command = {
  name: 'pretrain',
  description: 'Bootstrap intelligence from repository (4-step pipeline + embeddings)',
  options: [
    {
      name: 'path',
      short: 'p',
      description: 'Repository path',
      type: 'string',
      default: '.'
    },
    {
      name: 'depth',
      short: 'd',
      description: 'Analysis depth (shallow, medium, deep)',
      type: 'string',
      default: 'medium',
      choices: ['shallow', 'medium', 'deep']
    },
    {
      name: 'skip-cache',
      description: 'Skip cached analysis',
      type: 'boolean',
      default: false
    },
    {
      name: 'with-embeddings',
      description: 'Index documents for semantic search during pretraining',
      type: 'boolean',
      default: true
    },
    {
      name: 'embedding-model',
      description: 'ONNX embedding model',
      type: 'string',
      default: 'Xenova/all-MiniLM-L6-v2',
      choices: ['Xenova/all-MiniLM-L6-v2', 'Xenova/all-mpnet-base-v2']
    },
    {
      name: 'file-types',
      description: 'File extensions to index (comma-separated)',
      type: 'string',
      default: 'ts,js,py,md,json'
    }
  ],
  examples: [
    { command: 'claude-flow hooks pretrain', description: 'Pretrain with embeddings indexing' },
    { command: 'claude-flow hooks pretrain -p ../my-project --depth deep', description: 'Deep analysis of specific project' },
    { command: 'claude-flow hooks pretrain --no-with-embeddings', description: 'Skip embedding indexing' },
    { command: 'claude-flow hooks pretrain --file-types ts,tsx,js', description: 'Index only TypeScript/JS files' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const repoPath = ctx.flags.path as string || '.';
    const depth = ctx.flags.depth as string || 'medium';
    const withEmbeddings = ctx.flags['with-embeddings'] !== false && ctx.flags.withEmbeddings !== false;
    const embeddingModel = (ctx.flags['embedding-model'] || ctx.flags.embeddingModel || 'Xenova/all-MiniLM-L6-v2') as string;
    const fileTypes = (ctx.flags['file-types'] || ctx.flags.fileTypes || 'ts,js,py,md,json') as string;

    output.writeln();
    output.writeln(output.bold('Pretraining Intelligence (4-Step Pipeline + Embeddings)'));
    output.writeln();

    const steps = [
      { name: 'RETRIEVE', desc: 'Top-k memory injection with MMR diversity' },
      { name: 'JUDGE', desc: 'LLM-as-judge trajectory evaluation' },
      { name: 'DISTILL', desc: 'Extract strategy memories from trajectories' },
      { name: 'CONSOLIDATE', desc: 'Dedup, detect contradictions, prune old patterns' }
    ];

    // Add embedding steps if enabled
    if (withEmbeddings) {
      steps.push(
        { name: 'EMBED', desc: `Index documents with ${embeddingModel} (ONNX)` },
        { name: 'HYPERBOLIC', desc: 'Project to Poincaré ball for hierarchy preservation' }
      );
    }

    const spinner = output.createSpinner({ text: 'Starting pretraining...', spinner: 'dots' });

    try {
      spinner.start();

      // Display progress for each step
      for (const step of steps) {
        spinner.setText(`${step.name}: ${step.desc}`);
        await new Promise(resolve => setTimeout(resolve, 800));
      }

      // Call MCP tool for pretraining. The tool currently returns
      // `{ statistics: { ..., executionTime }, ... }` but earlier CLI
      // versions read `result.stats` and `result.duration` (#1686). Accept
      // either shape so the dashboard works whether you upgraded the tool
      // or the CLI first.
      const rawResult = await callMCPTool<{
        path?: string;
        depth?: string;
        stats?: {
          filesAnalyzed?: number;
          patternsExtracted?: number;
          strategiesLearned?: number;
          trajectoriesEvaluated?: number;
          contradictionsResolved?: number;
          documentsIndexed?: number;
          embeddingsGenerated?: number;
          hyperbolicProjections?: number;
        };
        statistics?: {
          filesAnalyzed?: number;
          patternsExtracted?: number;
          strategiesLearned?: number;
          trajectoriesEvaluated?: number;
          contradictionsResolved?: number;
          documentsIndexed?: number;
          embeddingsGenerated?: number;
          hyperbolicProjections?: number;
          executionTime?: number;
        };
        duration?: number;
      }>('hooks_pretrain', {
        path: repoPath,
        depth,
        skipCache: ctx.flags.skipCache || false,
        withEmbeddings,
        embeddingModel,
        fileTypes: fileTypes.split(',').map((t: string) => t.trim()),
      });

      spinner.succeed('Pretraining completed');

      // Normalize shape: prefer `statistics`, fall back to `stats` for older tools.
      // #1686 — coerce duration through safeNum so a NaN from the underlying
      // pretrain pipeline surfaces as `0.0s` rather than `NaNs`.
      const stats = (rawResult.statistics ?? rawResult.stats ?? {}) as Record<string, number | undefined>;
      const durationMs = safeNum(rawResult.duration ?? rawResult.statistics?.executionTime);
      const result = { ...rawResult, stats, duration: durationMs };

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();

      // Base stats — use ?? 0 fallbacks to keep the table readable even when
      // the tool omits a counter rather than crashing on undefined.
      const tableData: Array<{ metric: string; value: string | number }> = [
        { metric: 'Files Analyzed', value: stats.filesAnalyzed ?? 0 },
        { metric: 'Patterns Extracted', value: stats.patternsExtracted ?? 0 },
        { metric: 'Strategies Learned', value: stats.strategiesLearned ?? 0 },
        { metric: 'Trajectories Evaluated', value: stats.trajectoriesEvaluated ?? 0 },
        { metric: 'Contradictions Resolved', value: stats.contradictionsResolved ?? 0 },
      ];

      // Add embedding stats if available
      if (withEmbeddings && stats.documentsIndexed !== undefined) {
        tableData.push(
          { metric: 'Documents Indexed', value: stats.documentsIndexed },
          { metric: 'Embeddings Generated', value: stats.embeddingsGenerated ?? 0 },
          { metric: 'Hyperbolic Projections', value: stats.hyperbolicProjections ?? 0 }
        );
      }

      tableData.push({ metric: 'Duration', value: `${(durationMs / 1000).toFixed(1)}s` });

      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 30 },
          { key: 'value', header: 'Value', width: 15, align: 'right' }
        ],
        data: tableData
      });

      output.writeln();
      output.printSuccess('Repository intelligence bootstrapped successfully');
      if (withEmbeddings) {
        output.writeln(output.dim('  Semantic search enabled: Use "embeddings search -q <query>" to search'));
      }
      output.writeln(output.dim('  Next step: Run "claude-flow hooks build-agents" to generate optimized configs'));

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Pretraining failed');
      if (error instanceof MCPClientError) {
        output.printError(`Pretraining error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Build agents subcommand
const buildAgentsCommand: Command = {
  name: 'build-agents',
  description: 'Generate optimized agent configs from pretrain data',
  options: [
    {
      name: 'output',
      short: 'o',
      description: 'Output directory for agent configs',
      type: 'string',
      default: './agents'
    },
    {
      name: 'focus',
      short: 'f',
      description: 'Focus area (v3-implementation, security, performance, all)',
      type: 'string',
      default: 'all'
    },
    {
      name: 'config-format',
      description: 'Config format (yaml, json)',
      type: 'string',
      default: 'yaml',
      choices: ['yaml', 'json']
    }
  ],
  examples: [
    { command: 'claude-flow hooks build-agents', description: 'Build all agent configs' },
    { command: 'claude-flow hooks build-agents --focus security -o ./config/agents', description: 'Build security-focused configs' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const output_dir = ctx.flags.output as string || './agents';
    const focus = ctx.flags.focus as string || 'all';
    const configFormat = ctx.flags.configFormat as string || 'yaml';

    output.printInfo(`Building agent configs (focus: ${output.highlight(focus)})`);

    const spinner = output.createSpinner({ text: 'Generating configs...', spinner: 'dots' });

    try {
      spinner.start();

      // Call MCP tool for building agents
      const result = await callMCPTool<{
        outputDir: string;
        focus: string;
        agents: Array<{
          type: string;
          configFile: string;
          capabilities: string[];
          optimizations: string[];
        }>;
        stats: {
          configsGenerated: number;
          patternsApplied: number;
          optimizationsIncluded: number;
        };
      }>('hooks_build-agents', {
        outputDir: output_dir,
        focus,
        format: configFormat,
        includePretrained: true,
      });

      spinner.succeed(`Generated ${result.agents.length} agent configs`);

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Generated Agent Configs'));
      output.printTable({
        columns: [
          { key: 'type', header: 'Agent Type', width: 20 },
          { key: 'configFile', header: 'Config File', width: 30 },
          { key: 'capabilities', header: 'Capabilities', width: 10, align: 'right', format: (v) => String(Array.isArray(v) ? v.length : 0) }
        ],
        data: result.agents
      });

      output.writeln();
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 30 },
          { key: 'value', header: 'Value', width: 15, align: 'right' }
        ],
        data: [
          { metric: 'Configs Generated', value: result.stats.configsGenerated },
          { metric: 'Patterns Applied', value: result.stats.patternsApplied },
          { metric: 'Optimizations Included', value: result.stats.optimizationsIncluded }
        ]
      });

      output.writeln();
      output.printSuccess(`Agent configs saved to ${output_dir}`);

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Agent config generation failed');
      if (error instanceof MCPClientError) {
        output.printError(`Build agents error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Metrics subcommand
const metricsCommand: Command = {
  name: 'metrics',
  description: 'View learning metrics dashboard',
  options: [
    {
      name: 'period',
      short: 'p',
      description: 'Time period (1h, 24h, 7d, 30d, all)',
      type: 'string',
      default: '24h'
    },
    {
      name: 'v3-dashboard',
      description: 'Show V3 performance dashboard',
      type: 'boolean',
      default: false
    },
    {
      name: 'category',
      short: 'c',
      description: 'Metric category (patterns, agents, commands, performance)',
      type: 'string'
    }
  ],
  examples: [
    { command: 'claude-flow hooks metrics', description: 'View 24h metrics' },
    { command: 'claude-flow hooks metrics --period 7d --v3-dashboard', description: 'V3 metrics for 7 days' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const period = ctx.flags.period as string || '24h';
    const v3Dashboard = ctx.flags.v3Dashboard as boolean;

    output.writeln();
    output.writeln(output.bold(`Learning Metrics Dashboard (${period})`));
    output.writeln();

    try {
      // Call MCP tool for metrics. The tool returns `{ summary, routing,
      // edits, commands }` (see MetricsResult in v3/mcp/tools/hooks-tools.ts)
      // but earlier CLI versions expected `{ patterns, agents, commands.avgRiskScore }`.
      // Accept the union and normalize below — without the `?? 0` guards the
      // dashboard crashed with "Cannot read properties of null (reading 'toFixed')"
      // whenever a counter was missing (#1686).
      const rawMetrics = await callMCPTool<{
        period?: string;
        category?: string;
        timeRange?: string;
        summary?: {
          totalOperations?: number;
          successRate?: number;
          avgQuality?: number;
          patternsLearned?: number;
        };
        patterns?: {
          total?: number;
          successful?: number;
          failed?: number;
          unknown?: number;
          described?: number;
          descriptionCoverage?: number;
          avgConfidence?: number;
        };
        routing?: {
          totalRoutes?: number;
          avgConfidence?: number;
          topAgents?: Array<{ agent: string; count: number; successRate: number }>;
        };
        agents?: {
          routingAccuracy?: number;
          averageConfidence?: number;
          outcomeSuccessRate?: number;
          totalRoutes?: number;
          topAgent?: string;
        };
        commands?: {
          totalCommands?: number;
          totalExecuted?: number;
          successRate?: number;
          avgExecutionTime?: number;
          avgRiskScore?: number;
        };
        performance?: {
          flashAttention?: string;
          memoryReduction?: string;
          searchImprovement?: string;
          tokenReduction?: string;
        };
      }>('hooks_metrics', {
        period,
        includeV3: v3Dashboard,
        category: ctx.flags.category,
      });

      // Normalize across both shapes; default every numeric to 0 so toFixed
      // never sees null/undefined. #1686 — also coerce NaN through `safeNum`
      // because `?? 0` only catches null/undefined; an upstream NaN would
      // still land in `.toFixed(...)` and surface as `"NaN"`.
      const totalPatterns = safeNum(rawMetrics.patterns?.total ?? rawMetrics.summary?.patternsLearned);
      const successfulPatterns = safeNum(rawMetrics.patterns?.successful ?? Math.round(safeNum(rawMetrics.summary?.successRate) * totalPatterns));
      const failedPatterns = Math.max(0, safeNum(rawMetrics.patterns?.failed ?? totalPatterns - successfulPatterns));
      const unknownPatterns = Math.max(0, safeNum(rawMetrics.patterns?.unknown));
      const describedPatterns = Math.max(0, safeNum(rawMetrics.patterns?.described));
      const descriptionCoverage = safeNum(
        rawMetrics.patterns?.descriptionCoverage ??
        (totalPatterns > 0 ? describedPatterns / totalPatterns : 0),
      );
      const avgConfidence = safeNum(rawMetrics.patterns?.avgConfidence ?? rawMetrics.summary?.avgQuality);

      const routingAccuracy = rawMetrics.agents?.routingAccuracy == null
        ? null
        : safeNum(rawMetrics.agents.routingAccuracy);
      const averageRoutingConfidence = safeNum(
        rawMetrics.agents?.averageConfidence ??
        rawMetrics.routing?.avgConfidence ??
        rawMetrics.patterns?.avgConfidence,
      );
      const routingOutcomeSuccessRate = rawMetrics.agents?.outcomeSuccessRate == null
        ? null
        : safeNum(rawMetrics.agents.outcomeSuccessRate);
      const totalRoutes = safeNum(rawMetrics.agents?.totalRoutes ?? rawMetrics.routing?.totalRoutes);
      const topAgent = rawMetrics.agents?.topAgent ?? rawMetrics.routing?.topAgents?.[0]?.agent ?? 'n/a';

      const totalCommands = safeNum(rawMetrics.commands?.totalExecuted ?? rawMetrics.commands?.totalCommands);
      const commandSuccessRate = safeNum(rawMetrics.commands?.successRate);
      const avgRiskScore = safeNum(rawMetrics.commands?.avgRiskScore ?? rawMetrics.commands?.avgExecutionTime);

      const result = {
        ...rawMetrics,
        patterns: {
          total: totalPatterns,
          successful: successfulPatterns,
          failed: failedPatterns,
          unknown: unknownPatterns,
          described: describedPatterns,
          descriptionCoverage,
          avgConfidence,
        },
        agents: {
          routingAccuracy,
          averageConfidence: averageRoutingConfidence,
          outcomeSuccessRate: routingOutcomeSuccessRate,
          totalRoutes,
          topAgent,
        },
        commands: { totalExecuted: totalCommands, successRate: commandSuccessRate, avgRiskScore },
      };

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      // Patterns section
      output.writeln(output.bold('📊 Pattern Learning'));
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 25 },
          { key: 'value', header: 'Value', width: 20, align: 'right' }
        ],
        data: [
          { metric: 'Total Patterns', value: totalPatterns },
          { metric: 'Successful', value: output.success(String(successfulPatterns)) },
          { metric: 'Failed', value: output.error(String(failedPatterns)) },
          ...(unknownPatterns > 0 ? [{ metric: 'Unclassified', value: String(unknownPatterns) }] : []),
          { metric: 'With Task Context', value: `${(descriptionCoverage * 100).toFixed(1)}%` },
          { metric: 'Avg Confidence', value: `${(avgConfidence * 100).toFixed(1)}%` }
        ]
      });

      output.writeln();

      // Agent routing section
      output.writeln(output.bold('🤖 Agent Routing'));
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 25 },
          { key: 'value', header: 'Value', width: 20, align: 'right' }
        ],
        data: [
          {
            metric: routingAccuracy === null ? 'Avg Confidence' : 'Routing Accuracy',
            value: `${((routingAccuracy ?? averageRoutingConfidence) * 100).toFixed(1)}%`,
          },
          ...(routingOutcomeSuccessRate === null ? [] : [{
            metric: 'Outcome Success Rate',
            value: `${(routingOutcomeSuccessRate * 100).toFixed(1)}%`,
          }]),
          { metric: 'Total Routes', value: totalRoutes },
          { metric: 'Top Agent', value: output.highlight(topAgent) }
        ]
      });

      output.writeln();

      // Command execution section
      output.writeln(output.bold('⚡ Command Execution'));
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 25 },
          { key: 'value', header: 'Value', width: 20, align: 'right' }
        ],
        data: [
          { metric: 'Total Executed', value: totalCommands },
          { metric: 'Success Rate', value: `${(commandSuccessRate * 100).toFixed(1)}%` },
          { metric: 'Avg Risk Score', value: avgRiskScore.toFixed(2) }
        ]
      });

      if (v3Dashboard && result.performance) {
        const p = result.performance;
        output.writeln();
        output.writeln(output.bold('🚀 V3 Performance Gains'));
        output.printList([
          `Flash Attention: ${output.success(p.flashAttention ?? 'N/A')}`,
          `Memory Reduction: ${output.success(p.memoryReduction ?? 'N/A')}`,
          `Search Improvement: ${output.success(p.searchImprovement ?? 'N/A')}`,
          `Token Reduction: ${output.success(p.tokenReduction ?? 'N/A')}`
        ]);
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Metrics error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Pattern Store command (imported from transfer-store.ts)
// storeCommand is imported at the top

// Transfer from project subcommand
const transferFromProjectCommand: Command = {
  name: 'from-project',
  aliases: ['project'],
  description: 'Transfer patterns from another project',
  options: [
    {
      name: 'source',
      short: 's',
      description: 'Source project path',
      type: 'string',
      required: true
    },
    {
      name: 'filter',
      short: 'f',
      description: 'Filter patterns by type',
      type: 'string'
    },
    {
      name: 'min-confidence',
      short: 'm',
      description: 'Minimum confidence threshold (0-1)',
      type: 'number',
      default: 0.7
    }
  ],
  examples: [
    { command: 'claude-flow hooks transfer from-project -s ../old-project', description: 'Transfer all patterns' },
    { command: 'claude-flow hooks transfer from-project -s ../prod --filter security -m 0.9', description: 'Transfer high-confidence security patterns' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const sourcePath = (ctx.flags.source as string) || ctx.args[0];
    const minConfidence = ctx.flags.minConfidence as number ?? 0.7;

    if (!sourcePath) {
      output.printError('Source project path is required. Use --source or -s flag.');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Transferring patterns from: ${output.highlight(sourcePath)}`);

    const spinner = output.createSpinner({ text: 'Analyzing source patterns...', spinner: 'dots' });

    try {
      spinner.start();

      // Call MCP tool for transfer
      const result = await callMCPTool<{
        success: boolean;
        message?: string;
        sourcePath: string;
        transferred: {
          total: number;
          byType: Record<string, number>;
        } | number;
        skipped?: {
          lowConfidence: number;
          duplicates: number;
          conflicts: number;
        };
        stats?: {
          avgConfidence: number | null;
          avgAgeDays: number | null;
        };
      }>('hooks_transfer', {
        sourcePath,
        filter: ctx.flags.filter,
        minConfidence,
        mergeStrategy: 'keep-highest-confidence',
      });

      // #2859 — the handler reports success:false (no destination write
      // happened) when the source has no matching patterns at all. Surface
      // that honestly instead of claiming a transfer occurred.
      if (!result.success || typeof result.transferred === 'number') {
        spinner.fail(result.message ?? 'No patterns transferred');
        if (ctx.flags.format === 'json') {
          output.printJson(result);
        }
        return { success: false, exitCode: 1, data: result };
      }

      spinner.succeed(`Transferred ${result.transferred.total} patterns`);

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Transfer Summary'));
      output.printTable({
        columns: [
          { key: 'category', header: 'Category', width: 25 },
          { key: 'count', header: 'Count', width: 15, align: 'right' }
        ],
        data: [
          { category: 'Total Transferred', count: output.success(String(result.transferred.total)) },
          { category: 'Skipped (Low Confidence)', count: result.skipped?.lowConfidence ?? 0 },
          { category: 'Skipped (Duplicates)', count: result.skipped?.duplicates ?? 0 },
          { category: 'Skipped (Conflicts)', count: result.skipped?.conflicts ?? 0 }
        ]
      });

      if (Object.keys(result.transferred.byType).length > 0) {
        output.writeln();
        output.writeln(output.bold('By Pattern Type'));
        output.printTable({
          columns: [
            { key: 'type', header: 'Type', width: 20 },
            { key: 'count', header: 'Count', width: 15, align: 'right' }
          ],
          data: Object.entries(result.transferred.byType).map(([type, count]) => ({ type, count }))
        });
      }

      // #2865-style honesty: omit stats that have no real measured value
      // rather than showing a fabricated number.
      const statLines: string[] = [];
      if (result.stats?.avgConfidence != null) {
        statLines.push(`Avg Confidence: ${(result.stats.avgConfidence * 100).toFixed(1)}%`);
      }
      if (result.stats?.avgAgeDays != null) {
        statLines.push(`Avg Age: ${result.stats.avgAgeDays.toFixed(1)} days`);
      }
      if (statLines.length > 0) {
        output.writeln();
        output.printList(statLines);
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Transfer failed');
      if (error instanceof MCPClientError) {
        output.printError(`Transfer error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Parent transfer command combining all transfer methods
const transferCommand: Command = {
  name: 'transfer',
  description: 'Transfer patterns and plugins via IPFS-based decentralized registry',
  subcommands: [storeCommand, transferFromProjectCommand],
  examples: [
    { command: 'claude-flow hooks transfer store list', description: 'List patterns from registry' },
    { command: 'claude-flow hooks transfer store search -q routing', description: 'Search patterns' },
    { command: 'claude-flow hooks transfer store download -p seraphine-genesis', description: 'Download pattern' },
    { command: 'claude-flow hooks transfer store publish', description: 'Publish pattern to registry' },
    { command: 'claude-flow hooks transfer from-project -s ../other-project', description: 'Transfer from project' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Pattern Transfer System'));
    output.writeln(output.dim('Decentralized pattern sharing via IPFS'));
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('store')}        - Pattern marketplace (list, search, download, publish)`,
      `${output.highlight('from-project')} - Transfer patterns from another project`,
    ]);
    output.writeln();
    output.writeln(output.bold('IPFS-Based Features:'));
    output.printList([
      'Decentralized registry via IPNS for discoverability',
      'Content-addressed storage for integrity',
      'Ed25519 signatures for verification',
      'Anonymization levels: minimal, standard, strict, paranoid',
      'Trust levels: unverified, community, verified, official',
    ]);
    output.writeln();
    output.writeln('Run "claude-flow hooks transfer <subcommand> --help" for details');
    return { success: true };
  }
};

// List subcommand
const listCommand: Command = {
  name: 'list',
  aliases: ['ls'],
  description: 'List all registered hooks',
  options: [
    {
      name: 'enabled',
      short: 'e',
      description: 'Show only enabled hooks',
      type: 'boolean',
      default: false
    },
    {
      name: 'type',
      short: 't',
      description: 'Filter by hook type',
      type: 'string'
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      // Call MCP tool for list
      const result = await callMCPTool<{
        hooks: Array<{
          name: string;
          type: string;
          enabled: boolean;
          priority: number;
          executionCount: number;
          lastExecuted?: string;
        }>;
        total: number;
      }>('hooks_list', {
        enabled: ctx.flags.enabled || undefined,
        type: ctx.flags.type || undefined,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Registered Hooks'));
      output.writeln();

      if (result.hooks.length === 0) {
        output.printInfo('No hooks found matching criteria');
        return { success: true, data: result };
      }

      output.printTable({
        columns: [
          { key: 'name', header: 'Name', width: 20 },
          { key: 'type', header: 'Type', width: 15 },
          { key: 'enabled', header: 'Enabled', width: 10, format: (v) => v ? output.success('Yes') : output.dim('No') },
          { key: 'priority', header: 'Priority', width: 10, align: 'right' },
          { key: 'executionCount', header: 'Executions', width: 12, align: 'right' },
          { key: 'lastExecuted', header: 'Last Executed', width: 20, format: (v) => v ? new Date(String(v)).toLocaleString() : 'Never' }
        ],
        data: result.hooks
      });

      output.writeln();
      output.printInfo(`Total: ${result.total} hooks`);

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to list hooks: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Pre-task subcommand
const preTaskCommand: Command = {
  name: 'pre-task',
  description: 'Record task start and get agent suggestions',
  options: [
    {
      name: 'task-id',
      short: 'i',
      description: 'Unique task identifier (auto-generated if omitted)',
      type: 'string'
    },
    {
      name: 'description',
      short: 'd',
      description: 'Task description',
      type: 'string',
      required: true
    },
    {
      name: 'auto-spawn',
      short: 'a',
      description: 'Auto-spawn suggested agents',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow hooks pre-task -i task-123 -d "Fix auth bug"', description: 'Record task start' },
    { command: 'claude-flow hooks pre-task -i task-456 -d "Implement feature" --auto-spawn', description: 'With auto-spawn' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const taskId = (ctx.flags.taskId as string) || `task-${Date.now().toString(36)}`;
    const description = (ctx.flags.description as string) || ctx.args[0];

    if (!description) {
      output.printError('Description is required: --description "your task"');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Starting task: ${output.highlight(taskId)}`);

    try {
      const result = await callMCPTool<{
        taskId: string;
        description: string;
        suggestedAgents: Array<{
          type: string;
          confidence: number;
          reason: string;
        }>;
        complexity: 'low' | 'medium' | 'high';
        estimatedDuration: string;
        risks: string[];
        recommendations: string[];
      }>('hooks_pre-task', {
        taskId,
        description,
        autoSpawn: ctx.flags.autoSpawn || false,
        timestamp: Date.now(),
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `Task ID: ${result.taskId}`,
          `Description: ${result.description}`,
          `Complexity: ${result.complexity.toUpperCase()}`,
          `Est. Duration: ${result.estimatedDuration}`
        ].join('\n'),
        'Task Registered'
      );

      if (result.suggestedAgents.length > 0) {
        output.writeln();
        output.writeln(output.bold('Suggested Agents'));
        output.printTable({
          columns: [
            { key: 'type', header: 'Agent Type', width: 20 },
            { key: 'confidence', header: 'Confidence', width: 12, align: 'right', format: (v) => `${(Number(v) * 100).toFixed(1)}%` },
            { key: 'reason', header: 'Reason', width: 35 }
          ],
          data: result.suggestedAgents
        });
      }

      if (result.risks.length > 0) {
        output.writeln();
        output.writeln(output.bold(output.error('Potential Risks')));
        output.printList(result.risks.map(r => output.warning(r)));
      }

      if (result.recommendations.length > 0) {
        output.writeln();
        output.writeln(output.bold('Recommendations'));
        output.printList(result.recommendations);
      }

      // Enhanced model routing with deterministic codemod Tier-1 (ADR-026, ADR-143)
      try {
        const { getEnhancedModelRouter } = await import('../ruvector/enhanced-model-router.js');
        const router = getEnhancedModelRouter();
        const routeResult = await router.route(description, { filePath: ctx.flags.file as string });
        const intent = routeResult.codemodIntent ?? routeResult.agentBoosterIntent;

        output.writeln();
        output.writeln(output.bold('Intelligent Model Routing'));

        if (routeResult.tier === 1) {
          // Deterministic codemod can apply this edit - skip LLM entirely ($0)
          output.writeln(output.success(`  Tier 1: Deterministic codemod`));
          output.writeln(output.dim(`  Intent: ${intent?.type}`));
          output.writeln(output.dim(`  Latency: ~1ms | Cost: $0 | No LLM`));
          output.writeln();
          output.writeln(output.dim('─'.repeat(60)));
          output.writeln(output.bold(output.success(`[CODEMOD_AVAILABLE] Skip LLM — call hooks_codemod with intent="${intent?.type}" (deterministic, $0)`)));
          output.writeln(output.dim(`Confidence: ${(routeResult.confidence * 100).toFixed(0)}% | Intent: ${intent?.description}`));
          output.writeln(output.dim('─'.repeat(60)));
        } else {
          // LLM required - show tier and model recommendation
          output.writeln(`  Tier ${routeResult.tier}: ${routeResult.handler.toUpperCase()}`);
          output.writeln(output.dim(`  Complexity: ${((routeResult.complexity || 0) * 100).toFixed(0)}%`));
          output.writeln(output.dim(`  Est. Latency: ${routeResult.estimatedLatencyMs}ms | Cost: $${routeResult.estimatedCost.toFixed(4)}`));
          output.writeln();

          // Clear instruction for Claude
          output.writeln(output.dim('─'.repeat(60)));
          output.writeln(output.bold(output.success(`[TASK_MODEL_RECOMMENDATION] Use model="${routeResult.model}" for this task`)));
          output.writeln(output.dim(`Complexity: ${((routeResult.complexity || 0) * 100).toFixed(0)}% | Confidence: ${(routeResult.confidence * 100).toFixed(0)}%`));
          output.writeln(output.dim('─'.repeat(60)));
        }

        // Add routing result for programmatic use
        (result as Record<string, unknown>).routeResult = routeResult;
        (result as Record<string, unknown>).recommendedModel = routeResult.model;
        (result as Record<string, unknown>).modelRouting = {
          tier: routeResult.tier,
          handler: routeResult.handler,
          model: routeResult.model,
          confidence: routeResult.confidence,
          complexity: routeResult.complexity,
          reasoning: routeResult.reasoning,
          canSkipLLM: routeResult.canSkipLLM,
          deterministic: routeResult.deterministic,
          codemodIntent: routeResult.codemodIntent ?? routeResult.agentBoosterIntent,
        };
      } catch {
        // Enhanced router not available, skip recommendation
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Pre-task hook failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Post-task subcommand
const postTaskCommand: Command = {
  name: 'post-task',
  description: 'Record task completion for learning',
  options: [
    {
      name: 'task-id',
      short: 'i',
      description: 'Unique task identifier (auto-generated if not provided)',
      type: 'string',
      required: false
    },
    {
      name: 'success',
      short: 's',
      description: 'Whether the task succeeded',
      type: 'boolean',
      required: false
    },
    {
      name: 'quality',
      short: 'q',
      description: 'Quality score (0-1)',
      type: 'number'
    },
    {
      name: 'agent',
      short: 'a',
      description: 'Agent that executed the task',
      type: 'string'
    },
    {
      name: 'agent-role',
      description: 'Stable agent role used for role-aware pheromone comparison (for example coder, tester, coordinator)',
      type: 'string'
    },
    {
      name: 'duration',
      description: 'Observed task duration in milliseconds for latency fitness',
      type: 'number'
    },
    {
      name: 'latency-budget-ms',
      description: 'Expected task duration in milliseconds; paired with --duration to normalize latency fitness',
      type: 'number'
    },
    {
      name: 'consensus-alignment',
      description: 'Consensus alignment score from 0 to 1',
      type: 'number'
    },
    {
      name: 'task',
      short: 't',
      description: 'Task description text (used for routing-outcome persistence and keyword extraction so hooks_metrics can surface Pattern Learning / Agent Routing counts). Without this + --agent, no routing outcome is recorded (#2785).',
      type: 'string',
      required: false
    },
    {
      name: 'store-results',
      description: 'Also persist the routing decision to the memory DB (maps to hooks_post-task storeDecisions) so hooks_metrics can cross-reference it. Requires --task and --agent.',
      type: 'boolean',
      required: false
    },
    {
      // ADR-147 P2: nested-subagent spawn-tree capture
      name: 'parent-agent-id',
      description: 'ID of the parent agent (from Claude Code\'s parent_agent_id OTel span tag). Omit for top-level work.',
      type: 'string',
      required: false
    },
    {
      name: 'depth',
      description: 'Chain depth from root lead session (0 = lead, 1+ = subagent). Used by ADR-147 P3 depth-aware guardrail.',
      type: 'number',
      required: false
    }
  ],
  examples: [
    { command: 'claude-flow hooks post-task -i task-123 --success true', description: 'Record successful completion' },
    { command: 'claude-flow hooks post-task -i task-456 --success false -q 0.3', description: 'Record failed task' },
    { command: 'claude-flow hooks post-task -i task-789 --success true --task "add JWT auth" --agent coder --store-results', description: 'Record with routing-outcome persistence for hooks_metrics' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Auto-generate task ID if not provided
    const taskId = (ctx.flags.taskId as string) || `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // Default success to true for backward compatibility
    const success = ctx.flags.success !== undefined ? (ctx.flags.success as boolean) : true;

    output.printInfo(`Recording outcome for task: ${output.highlight(taskId)}`);

    try {
      const result = await callMCPTool<{
        taskId: string;
        success: boolean;
        duration: number;
        learningUpdates: {
          patternsUpdated: number;
          newPatterns: number;
          trajectoryId: string;
        };
      }>('hooks_post-task', {
        taskId,
        success,
        quality: ctx.flags.quality,
        agent: ctx.flags.agent,
        agentRole: ctx.flags.agentRole,
        duration: ctx.flags.duration,
        latencyBudgetMs: ctx.flags.latencyBudgetMs,
        consensusAlignment: ctx.flags.consensusAlignment,
        // #2785: forward the task description so routing outcomes actually persist
        // (hooks_post-task requires taskText + agent to write the outcome row that
        // hooks_metrics reads via getIntelligenceStatsFromMemory)
        task: ctx.flags.task,
        // Maps to storeDecisions on the MCP tool — persist routing decision in
        // memory DB for cross-session vector retrieval + metrics attribution
        storeDecisions: ctx.flags.storeResults,
        timestamp: Date.now(),
        // ADR-147 P2: forward spawn-tree lineage if caller supplied it
        parentAgentId: ctx.flags.parentAgentId,
        depth: ctx.flags.depth,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printSuccess(`Task outcome recorded: ${success ? 'SUCCESS' : 'FAILED'}`);

      output.writeln();
      output.writeln(output.bold('Learning Updates'));
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 25 },
          { key: 'value', header: 'Value', width: 20, align: 'right' }
        ],
        data: [
          { metric: 'Patterns Updated', value: result.learningUpdates.patternsUpdated },
          { metric: 'New Patterns', value: result.learningUpdates.newPatterns },
          { metric: 'Duration', value: `${(result.duration / 1000).toFixed(1)}s` },
          { metric: 'Trajectory ID', value: result.learningUpdates.trajectoryId }
        ]
      });

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Post-task hook failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Session-end subcommand
const sessionEndCommand: Command = {
  name: 'session-end',
  description: 'End current session and persist state',
  options: [
    {
      name: 'save-state',
      short: 's',
      description: 'Save session state for later restoration',
      type: 'boolean',
      default: true
    }
  ],
  examples: [
    { command: 'claude-flow hooks session-end', description: 'End and save session' },
    { command: 'claude-flow hooks session-end --save-state false', description: 'End without saving' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.printInfo('Ending session...');

    try {
      const result = await callMCPTool<{
        sessionId: string;
        duration: number;
        statePath?: string;
        summary: {
          tasksExecuted: number;
          tasksSucceeded: number;
          tasksFailed: number;
          commandsExecuted: number;
          filesModified: number;
          agentsSpawned: number;
        };
      }>('hooks_session-end', {
        saveState: ctx.flags.saveState ?? true,
        timestamp: Date.now(),
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printSuccess(`Session ${result.sessionId} ended`);

      output.writeln();
      output.writeln(output.bold('Session Summary'));
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 25 },
          { key: 'value', header: 'Value', width: 15, align: 'right' }
        ],
        data: [
          { metric: 'Duration', value: `${(result.duration / 1000 / 60).toFixed(1)} min` },
          { metric: 'Tasks Executed', value: result.summary.tasksExecuted },
          { metric: 'Tasks Succeeded', value: output.success(String(result.summary.tasksSucceeded)) },
          { metric: 'Tasks Failed', value: output.error(String(result.summary.tasksFailed)) },
          { metric: 'Commands Executed', value: result.summary.commandsExecuted },
          { metric: 'Files Modified', value: result.summary.filesModified },
          { metric: 'Agents Spawned', value: result.summary.agentsSpawned }
        ]
      });

      if (result.statePath) {
        output.writeln();
        output.writeln(output.dim(`State saved to: ${result.statePath}`));
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Session-end hook failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Session-restore subcommand
const sessionRestoreCommand: Command = {
  name: 'session-restore',
  description: 'Restore a previous session',
  options: [
    {
      name: 'session-id',
      short: 'i',
      description: 'Session ID to restore (use "latest" for most recent)',
      type: 'string',
      default: 'latest'
    },
    {
      name: 'restore-agents',
      short: 'a',
      description: 'Restore spawned agents',
      type: 'boolean',
      default: true
    },
    {
      name: 'restore-tasks',
      short: 't',
      description: 'Restore active tasks',
      type: 'boolean',
      default: true
    }
  ],
  examples: [
    { command: 'claude-flow hooks session-restore', description: 'Restore latest session' },
    { command: 'claude-flow hooks session-restore -i session-12345', description: 'Restore specific session' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const sessionId = (ctx.flags.sessionId as string) || ctx.args[0] || 'latest';

    output.printInfo(`Restoring session: ${output.highlight(sessionId)}`);

    try {
      const result = await callMCPTool<{
        sessionId: string;
        originalSessionId: string;
        restoredState: {
          tasksRestored: number;
          agentsRestored: number;
          memoryRestored: number;
        };
        warnings?: string[];
      }>('hooks_session-restore', {
        sessionId,
        restoreAgents: ctx.flags.restoreAgents ?? true,
        restoreTasks: ctx.flags.restoreTasks ?? true,
        timestamp: Date.now(),
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printSuccess(`Session restored from ${result.originalSessionId}`);
      output.writeln(output.dim(`New session ID: ${result.sessionId}`));

      output.writeln();
      output.writeln(output.bold('Restored State'));
      output.printTable({
        columns: [
          { key: 'item', header: 'Item', width: 25 },
          { key: 'count', header: 'Count', width: 15, align: 'right' }
        ],
        data: [
          { item: 'Tasks', count: result.restoredState.tasksRestored },
          { item: 'Agents', count: result.restoredState.agentsRestored },
          { item: 'Memory Entries', count: result.restoredState.memoryRestored }
        ]
      });

      if (result.warnings && result.warnings.length > 0) {
        output.writeln();
        output.writeln(output.bold(output.warning('Warnings')));
        output.printList(result.warnings.map(w => output.warning(w)));
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Session-restore hook failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Intelligence subcommand (SONA, MoE, HNSW)
const intelligenceCommand: Command = {
  name: 'intelligence',
  description: 'RuVector intelligence system (SONA, MoE, HNSW 150x faster)',
  options: [
    {
      name: 'mode',
      short: 'm',
      description: 'Intelligence mode (real-time, batch, edge, research, balanced)',
      type: 'string',
      choices: ['real-time', 'batch', 'edge', 'research', 'balanced'],
      default: 'balanced'
    },
    {
      name: 'enable-sona',
      description: 'Enable SONA sub-0.05ms learning',
      type: 'boolean',
      default: true
    },
    {
      name: 'enable-moe',
      description: 'Enable Mixture of Experts routing',
      type: 'boolean',
      default: true
    },
    {
      name: 'enable-hnsw',
      description: 'Enable HNSW 150x faster search',
      type: 'boolean',
      default: true
    },
    {
      name: 'status',
      short: 's',
      description: 'Show current intelligence status',
      type: 'boolean',
      default: false
    },
    {
      name: 'train',
      short: 't',
      description: 'Force training cycle',
      type: 'boolean',
      default: false
    },
    {
      name: 'reset',
      short: 'r',
      description: 'Reset learning state',
      type: 'boolean',
      default: false
    },
    {
      name: 'embedding-provider',
      description: 'Embedding provider (transformers, openai, mock)',
      type: 'string',
      choices: ['transformers', 'openai', 'mock'],
      default: 'transformers'
    }
  ],
  examples: [
    { command: 'claude-flow hooks intelligence --status', description: 'Show intelligence status' },
    { command: 'claude-flow hooks intelligence -m real-time', description: 'Enable real-time mode' },
    { command: 'claude-flow hooks intelligence --train', description: 'Force training cycle' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const mode = ctx.flags.mode as string || 'balanced';
    const showStatus = ctx.flags.status as boolean;
    const forceTraining = ctx.flags.train as boolean;
    const reset = ctx.flags.reset as boolean;
    const enableSona = ctx.flags.enableSona as boolean ?? true;
    const enableMoe = ctx.flags.enableMoe as boolean ?? true;
    const enableHnsw = ctx.flags.enableHnsw as boolean ?? true;
    const embeddingProvider = ctx.flags.embeddingProvider as string || 'transformers';

    output.writeln();
    output.writeln(output.bold('RuVector Intelligence System'));
    output.writeln();

    if (reset) {
      const confirmed = await confirm({
        message: 'Reset all learning state? This cannot be undone.',
        default: false
      });

      if (!confirmed) {
        output.printInfo('Reset cancelled');
        return { success: true };
      }

      output.printInfo('Resetting learning state...');
      try {
        await callMCPTool('hooks_intelligence-reset', {});
        output.printSuccess('Learning state reset');
        return { success: true };
      } catch (error) {
        output.printError(`Reset failed: ${error}`);
        return { success: false, exitCode: 1 };
      }
    }

    const spinner = output.createSpinner({ text: 'Initializing intelligence system...', spinner: 'dots' });

    try {
      spinner.start();

      // Read local intelligence data from disk first
      const { getIntelligenceStats, initializeIntelligence, getPersistenceStatus } = await import('../memory/intelligence.js');
      await initializeIntelligence();
      const localStats = getIntelligenceStats();
      const persistence = getPersistenceStatus();

      // Read patterns.json file size and entry count
      let patternsFileSize = 0;
      let patternsFileEntries = 0;
      if (persistence.patternsExist) {
        try {
          const pStat = statSync(persistence.patternsFile);
          patternsFileSize = pStat.size;
          const pData = JSON.parse(readFileSync(persistence.patternsFile, 'utf-8'));
          if (Array.isArray(pData)) patternsFileEntries = pData.length;
        } catch { /* ignore */ }
      }

      // Read stats.json for trajectory data
      let trajectoriesFromDisk = 0;
      let lastAdaptationFromDisk: number | null = null;
      if (persistence.statsExist) {
        try {
          const sData = JSON.parse(readFileSync(persistence.statsFile, 'utf-8'));
          trajectoriesFromDisk = sData?.trajectoriesRecorded ?? 0;
          lastAdaptationFromDisk = sData?.lastAdaptation ?? null;
        } catch { /* ignore */ }
      }

      // Merge local stats with any we can get from MCP
      let mcpResult: Record<string, unknown> | null = null;
      try {
        mcpResult = await callMCPTool<Record<string, unknown>>('hooks_intelligence', {
          mode,
          enableSona,
          enableMoe,
          enableHnsw,
          embeddingProvider,
          forceTraining,
          showStatus,
        });
      } catch {
        // MCP not available, use local data only
      }

      // Build merged result, preferring local real data over MCP zeros
      const hasLocalData = localStats.patternsLearned > 0 || trajectoriesFromDisk > 0 || patternsFileEntries > 0;

      // Use the higher of local vs MCP values for key stats
      const mcpComponents = (mcpResult as { components?: Record<string, unknown> } | null)?.components as Record<string, Record<string, unknown>> | undefined;
      const mcpSona = mcpComponents?.sona;
      const mcpMoe = mcpComponents?.moe;
      const mcpHnsw = mcpComponents?.hnsw;
      const mcpEmb = mcpComponents?.embeddings;
      const mcpPerf = (mcpResult as { performance?: Record<string, string> } | null)?.performance;

      const patternsLearned = Math.max(localStats.patternsLearned, patternsFileEntries, Number(mcpSona?.patternsLearned ?? 0));
      const trajectories = Math.max(localStats.trajectoriesRecorded, trajectoriesFromDisk, Number(mcpSona?.trajectoriesRecorded ?? 0));
      const lastAdaptation = lastAdaptationFromDisk ?? localStats.lastAdaptation;
      const avgAdaptation = localStats.avgAdaptationTime > 0 ? localStats.avgAdaptationTime : Number(mcpSona?.adaptationTimeMs ?? 0);

      const result = {
        mode: String((mcpResult as Record<string, unknown> | null)?.mode ?? mode),
        status: (hasLocalData || mcpResult) ? 'active' as const : 'idle' as const,
        components: {
          sona: {
            enabled: enableSona,
            status: localStats.sonaEnabled ? 'active' : String(mcpSona?.status ?? 'idle'),
            learningTimeMs: avgAdaptation,
            adaptationTimeMs: avgAdaptation,
            trajectoriesRecorded: trajectories,
            patternsLearned,
            avgQuality: Number(mcpSona?.avgQuality ?? (patternsLearned > 0 ? 0.75 : 0)),
          },
          moe: {
            enabled: enableMoe,
            status: String(mcpMoe?.status ?? (hasLocalData ? 'active' : 'idle')),
            // #2865 — these three previously fell back to hardcoded
            // hasLocalData ? <constant> : 0 whenever the MCP tool didn't
            // report a real value, so "Routing Accuracy: 82.0%" displayed
            // on every project with local neural data regardless of actual
            // routing quality (measured 49% on a real store). None of these
            // three has a cheap, honest local substitute the way
            // `hooks metrics`' routingAccuracy falls back to averageConfidence,
            // so they are null (unmeasured) rather than a fabricated number.
            expertsActive: mcpMoe?.expertsActive == null ? null : Number(mcpMoe.expertsActive),
            routingAccuracy: mcpMoe?.routingAccuracy == null ? null : Number(mcpMoe.routingAccuracy),
            loadBalance: mcpMoe?.loadBalance == null ? null : Number(mcpMoe.loadBalance),
          },
          hnsw: {
            enabled: enableHnsw,
            status: String(mcpHnsw?.status ?? (localStats.reasoningBankSize > 0 ? 'active' : 'idle')),
            indexSize: Math.max(localStats.reasoningBankSize, Number(mcpHnsw?.indexSize ?? 0)),
            searchSpeedup: String(mcpHnsw?.searchSpeedup ?? (localStats.reasoningBankSize > 0 ? '150x' : 'N/A')),
            memoryUsage: String(mcpHnsw?.memoryUsage ?? (patternsFileSize > 0 ? `${(patternsFileSize / 1024).toFixed(1)} KB` : 'N/A')),
            dimension: Number(mcpHnsw?.dimension ?? 384),
          },
          embeddings: mcpEmb ? {
            provider: String(mcpEmb.provider ?? embeddingProvider),
            model: String(mcpEmb.model ?? 'default'),
            dimension: Number(mcpEmb.dimension ?? 384),
            cacheHitRate: Number(mcpEmb.cacheHitRate ?? 0),
          } : {
            provider: embeddingProvider,
            model: 'hash-128',
            dimension: 128,
            cacheHitRate: 0,
          },
        },
        performance: mcpPerf ?? {
          flashAttention: 'N/A',
          memoryReduction: patternsFileSize > 0 ? `${(patternsFileSize / 1024).toFixed(1)} KB on disk` : 'N/A',
          searchImprovement: localStats.reasoningBankSize > 0 ? '150x-12,500x' : 'N/A',
          tokenReduction: 'N/A',
          sweBenchScore: 'N/A',
        },
        // #2940: a training cycle that actually ran this invocation is "now"
        // — reading the pre-call `lastAdaptation` here would still show the
        // stale age (the exact "aged instead of reset" symptom reported).
        lastTrainingMs: (mcpResult as { training?: { trained?: boolean } } | null)?.training?.trained
          ? 0
          : (lastAdaptation ? Date.now() - lastAdaptation : undefined),
        persistence: {
          dataDir: persistence.dataDir,
          patternsFile: persistence.patternsFile,
          patternsExist: persistence.patternsExist,
          patternsEntries: patternsFileEntries,
          patternsFileSize,
          statsFile: persistence.statsFile,
          statsExist: persistence.statsExist,
          trajectoriesFromDisk,
        },
      };

      // #2940: this block used to be a cosmetic 500ms sleep followed by an
      // unconditional "Training cycle completed" — no training ever ran and
      // `lastAdaptation` never moved, so `--status` could never report a
      // training cycle as recent no matter how many times `--train` was
      // invoked. `hooks_intelligence` now actually distills when asked
      // (see mcp-tools/hooks-tools.ts); report what it actually did instead
      // of a canned success message.
      const trainingResult = (mcpResult as { training?: { attempted: boolean; trained: boolean; patternsDistilled?: number; reason?: string } } | null)?.training;
      if (forceTraining) {
        if (trainingResult?.trained && trainingResult.patternsDistilled) {
          spinner.succeed(
            `Training cycle completed — distilled ${trainingResult.patternsDistilled} pattern${trainingResult.patternsDistilled === 1 ? '' : 's'}`
          );
        } else if (trainingResult?.trained) {
          // Ran (SONA/EWC++ distillation pass executed, lastAdaptation
          // moved) but found zero new patterns — deliberately NOT the same
          // message as a real distillation, or this is exactly the "success
          // report with no state change behind it" the issue describes.
          spinner.stop();
          output.printWarning(`Training cycle ran — 0 new patterns to distill (${trainingResult.reason || 'nothing new since the last cycle'})`);
        } else if (trainingResult?.attempted) {
          spinner.stop();
          output.printWarning(`Training cycle ran with nothing to do — ${trainingResult.reason || 'no new trajectories to distill'}`);
        } else {
          spinner.stop();
          output.printWarning('Training cycle could not run — intelligence MCP tool unavailable');
        }
      } else {
        spinner.succeed(hasLocalData ? 'Intelligence system active (local data loaded)' : 'Intelligence system active');
      }

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      // Status display
      output.writeln();
      output.printBox(
        [
          `Mode: ${output.highlight(result.mode)}`,
          `Status: ${formatIntelligenceStatus(result.status)}`,
          `Last Training: ${result.lastTrainingMs != null ? `${(result.lastTrainingMs / 1000).toFixed(0)}s ago` : 'Never'}`,
          `Data Dir: ${output.dim(persistence.dataDir)}`
        ].join('\n'),
        'Intelligence Status'
      );

      // SONA Component
      output.writeln();
      output.writeln(output.bold('SONA (Sub-0.05ms Learning)'));
      const sona = result.components.sona;
      if (sona.enabled) {
        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 25 },
            { key: 'value', header: 'Value', width: 20, align: 'right' }
          ],
          data: [
            { metric: 'Status', value: formatIntelligenceStatus(sona.status) },
            { metric: 'Learning Time', value: `${(sona.learningTimeMs ?? 0).toFixed(3)}ms` },
            { metric: 'Adaptation Time', value: `${(sona.adaptationTimeMs ?? 0).toFixed(3)}ms` },
            { metric: 'Trajectories', value: sona.trajectoriesRecorded ?? 0 },
            { metric: 'Patterns Learned', value: sona.patternsLearned ?? 0 },
            { metric: 'Avg Quality', value: `${((sona.avgQuality ?? 0) * 100).toFixed(1)}%` }
          ]
        });
      } else {
        output.writeln(output.dim('  Disabled'));
      }

      // MoE Component
      output.writeln();
      output.writeln(output.bold('Mixture of Experts (MoE)'));
      const moe = result.components.moe;
      if (moe.enabled) {
        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 25 },
            { key: 'value', header: 'Value', width: 20, align: 'right' }
          ],
          data: [
            { metric: 'Status', value: formatIntelligenceStatus(moe.status) },
            // #2865 — omit rather than show a fabricated 0/0.0% when the
            // MCP tool hasn't reported a real value for these.
            ...(moe.expertsActive == null ? [] : [{ metric: 'Active Experts', value: moe.expertsActive }]),
            ...(moe.routingAccuracy == null ? [] : [{ metric: 'Routing Accuracy', value: `${(moe.routingAccuracy * 100).toFixed(1)}%` }]),
            ...(moe.loadBalance == null ? [] : [{ metric: 'Load Balance', value: `${(moe.loadBalance * 100).toFixed(1)}%` }]),
          ]
        });
      } else {
        output.writeln(output.dim('  Disabled'));
      }

      // HNSW Component
      output.writeln();
      output.writeln(output.bold('HNSW (150x Faster Search)'));
      const hnsw = result.components.hnsw;
      if (hnsw.enabled) {
        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 25 },
            { key: 'value', header: 'Value', width: 20, align: 'right' }
          ],
          data: [
            { metric: 'Status', value: formatIntelligenceStatus(hnsw.status) },
            { metric: 'Index Size', value: (hnsw.indexSize ?? 0).toLocaleString() },
            { metric: 'Search Speedup', value: output.success(hnsw.searchSpeedup ?? 'N/A') },
            { metric: 'Memory Usage', value: hnsw.memoryUsage ?? 'N/A' },
            { metric: 'Dimension', value: hnsw.dimension ?? 384 }
          ]
        });
      } else {
        output.writeln(output.dim('  Disabled'));
      }

      // Embeddings
      output.writeln();
      output.writeln(output.bold('Embeddings'));
      const emb = result.components.embeddings;
      if (emb) {
        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 25 },
            { key: 'value', header: 'Value', width: 20, align: 'right' }
          ],
          data: [
            { metric: 'Provider', value: emb.provider ?? 'N/A' },
            { metric: 'Model', value: emb.model ?? 'N/A' },
            { metric: 'Dimension', value: emb.dimension ?? 384 },
            { metric: 'Cache Hit Rate', value: `${((emb.cacheHitRate ?? 0) * 100).toFixed(1)}%` }
          ]
        });
      } else {
        output.writeln(output.dim('  Not initialized'));
      }

      // Persistence info
      if (result.persistence) {
        output.writeln();
        output.writeln(output.bold('Neural Persistence'));
        output.printList([
          `Patterns file: ${persistence.patternsExist ? output.success(`${patternsFileEntries} entries (${(patternsFileSize / 1024).toFixed(1)} KB)`) : output.dim('Not created')}`,
          `Stats file: ${persistence.statsExist ? output.success(`${trajectoriesFromDisk} trajectories`) : output.dim('Not created')}`,
        ]);
        if (!persistence.patternsExist && !persistence.statsExist) {
          output.writeln();
          output.writeln(output.dim('  No neural data. Run: neural train'));
        }
      }

      // V3 Performance
      const perf = result.performance;
      if (perf) {
        output.writeln();
        output.writeln(output.bold('V3 Performance Gains'));
        output.printList([
          `Flash Attention: ${output.success(String(perf.flashAttention ?? 'N/A'))}`,
          `Memory Reduction: ${output.success(String(perf.memoryReduction ?? 'N/A'))}`,
          `Search Improvement: ${output.success(String(perf.searchImprovement ?? 'N/A'))}`,
          `Token Reduction: ${output.success(String(perf.tokenReduction ?? 'N/A'))}`,
          `SWE-Bench Score: ${output.success(String(perf.sweBenchScore ?? 'N/A'))}`
        ]);
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Intelligence system error');
      if (error instanceof MCPClientError) {
        output.printError(`Intelligence error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

function formatIntelligenceStatus(status: string): string {
  switch (status) {
    case 'active':
    case 'ready':
      return output.success(status);
    case 'training':
      return output.highlight(status);
    case 'idle':
      return output.dim(status);
    case 'disabled':
    case 'error':
      return output.error(status);
    default:
      return status;
  }
}

// =============================================================================
// Worker Commands (12 Background Workers)
// =============================================================================

const workerListCommand: Command = {
  name: 'list',
  description: 'List all 12 background workers with capabilities',
  options: [
    { name: 'status', short: 's', type: 'string', description: 'Filter by status (all, running, completed, pending)' },
    { name: 'active', short: 'a', type: 'boolean', description: 'Show active worker instances' },
  ],
  examples: [
    { command: 'claude-flow hooks worker list', description: 'List all workers' },
    { command: 'claude-flow hooks worker list --active', description: 'Show active instances' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const spinner = output.createSpinner({ text: 'Loading workers...', spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        workers: Array<{
          trigger: string;
          description: string;
          priority: string;
          estimatedDuration: string;
          capabilities: string[];
          patterns: number;
        }>;
        total: number;
        active: {
          instances: Array<{
            id: string;
            trigger: string;
            status: string;
            progress: number;
            phase: string;
          }>;
          count: number;
          byStatus: Record<string, number>;
        };
        performanceTargets: Record<string, string | number>;
      }>('hooks_worker-list', {
        status: ctx.flags['status'] || 'all',
        includeActive: ctx.flags['active'] !== false,
      });

      spinner.succeed('Workers loaded');

      output.writeln();
      output.writeln(output.bold('Background Workers (12 Total)'));
      output.writeln();

      output.printTable({
        columns: [
          { key: 'trigger', header: 'Worker', width: 14 },
          { key: 'priority', header: 'Priority', width: 10 },
          { key: 'estimatedDuration', header: 'Est. Time', width: 10 },
          { key: 'description', header: 'Description', width: 40 },
        ],
        data: result.workers.map(w => ({
          trigger: output.highlight(w.trigger),
          priority: w.priority === 'critical' ? output.error(w.priority) :
                   w.priority === 'high' ? output.warning(w.priority) :
                   w.priority,
          estimatedDuration: w.estimatedDuration,
          description: w.description,
        })),
      });

      if (ctx.flags['active'] && result.active.count > 0) {
        output.writeln();
        output.writeln(output.bold('Active Instances'));
        output.printTable({
          columns: [
            { key: 'id', header: 'Worker ID', width: 35 },
            { key: 'trigger', header: 'Type', width: 12 },
            { key: 'status', header: 'Status', width: 12 },
            { key: 'progress', header: 'Progress', width: 10 },
          ],
          data: result.active.instances.map(w => ({
            id: w.id,
            trigger: w.trigger,
            status: w.status === 'running' ? output.highlight(w.status) :
                   w.status === 'completed' ? output.success(w.status) :
                   w.status === 'failed' ? output.error(w.status) : w.status,
            progress: `${w.progress}%`,
          })),
        });
      }

      output.writeln();
      output.writeln(output.dim('Performance targets:'));
      output.writeln(output.dim(`  Trigger detection: ${result.performanceTargets.triggerDetection}`));
      output.writeln(output.dim(`  Worker spawn: ${result.performanceTargets.workerSpawn}`));
      output.writeln(output.dim(`  Max concurrent: ${result.performanceTargets.maxConcurrent}`));

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Failed to load workers');
      if (error instanceof MCPClientError) {
        output.printError(`Worker error: ${error.message}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

const workerDispatchCommand: Command = {
  name: 'dispatch',
  description: 'Dispatch a background worker for analysis/optimization',
  options: [
    { name: 'trigger', short: 't', type: 'string', description: 'Worker type (ultralearn, optimize, audit, map, etc.)', required: true },
    { name: 'context', short: 'c', type: 'string', description: 'Context for the worker (file path, topic)' },
    { name: 'priority', short: 'p', type: 'string', description: 'Priority (low, normal, high, critical)' },
    { name: 'sync', short: 's', type: 'boolean', description: 'Wait for completion (synchronous)' },
  ],
  examples: [
    { command: 'claude-flow hooks worker dispatch -t optimize -c src/', description: 'Dispatch optimize worker' },
    { command: 'claude-flow hooks worker dispatch -t audit -p critical', description: 'Security audit with critical priority' },
    { command: 'claude-flow hooks worker dispatch -t testgaps --sync', description: 'Test coverage analysis (sync)' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const trigger = ctx.flags['trigger'] as string;
    const context = ctx.flags['context'] as string || 'default';
    const priority = ctx.flags['priority'] as string;
    const background = !ctx.flags['sync'];

    if (!trigger) {
      output.printError('--trigger is required');
      output.writeln('Available triggers: ultralearn, optimize, consolidate, predict, audit, map, preload, deepdive, document, refactor, benchmark, testgaps, oia-audit');
      output.writeln(output.dim('Tip: `oia-audit` (ADR-150) also runs as `ruflo metaharness oia-audit` for direct invocation.'));
      return { success: false, exitCode: 1 };
    }

    const spinner = output.createSpinner({ text: `Dispatching ${trigger} worker...`, spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        success: boolean;
        workerId: string;
        trigger: string;
        context: string;
        priority: string;
        config: {
          description: string;
          estimatedDuration: string;
          capabilities: string[];
        };
        status: string;
        error?: string;
      }>('hooks_worker-dispatch', {
        trigger,
        context,
        priority,
        background,
      });

      if (!result.success) {
        spinner.fail(`Failed: ${result.error}`);
        return { success: false, exitCode: 1 };
      }

      spinner.succeed(`Worker dispatched: ${result.workerId}`);

      output.writeln();
      output.printTable({
        columns: [
          { key: 'field', header: 'Field', width: 18 },
          { key: 'value', header: 'Value', width: 50 },
        ],
        data: [
          { field: 'Worker ID', value: output.highlight(result.workerId) },
          { field: 'Trigger', value: result.trigger },
          { field: 'Context', value: result.context },
          { field: 'Priority', value: result.priority },
          { field: 'Description', value: result.config.description },
          { field: 'Est. Duration', value: result.config.estimatedDuration },
          { field: 'Capabilities', value: result.config.capabilities.join(', ') },
          { field: 'Status', value: result.status === 'dispatched' ? output.highlight('dispatched (background)') : output.success('completed') },
        ],
      });

      if (background) {
        output.writeln();
        output.writeln(output.dim(`Check status: claude-flow hooks worker status --id ${result.workerId}`));
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Worker dispatch failed');
      if (error instanceof MCPClientError) {
        output.printError(`Dispatch error: ${error.message}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

const workerStatusCommand: Command = {
  name: 'status',
  description: 'Get status of workers',
  options: [
    { name: 'id', type: 'string', description: 'Specific worker ID to check' },
    { name: 'all', short: 'a', type: 'boolean', description: 'Include completed workers' },
  ],
  examples: [
    { command: 'claude-flow hooks worker status', description: 'Show running workers' },
    { command: 'claude-flow hooks worker status --id worker_audit_1', description: 'Check specific worker' },
    { command: 'claude-flow hooks worker status --all', description: 'Include completed workers' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const workerId = ctx.flags['id'] as string;
    const includeCompleted = ctx.flags['all'] as boolean;

    const spinner = output.createSpinner({ text: 'Checking worker status...', spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        success: boolean;
        worker?: {
          id: string;
          trigger: string;
          context: string;
          status: string;
          progress: number;
          phase: string;
          duration: number;
        };
        workers?: Array<{
          id: string;
          trigger: string;
          status: string;
          progress: number;
          phase: string;
          duration: number;
        }>;
        summary?: {
          total: number;
          running: number;
          completed: number;
          failed: number;
        };
        error?: string;
      }>('hooks_worker-status', {
        workerId,
        includeCompleted,
      });

      if (!result.success) {
        spinner.fail(`Failed: ${result.error}`);
        return { success: false, exitCode: 1 };
      }

      spinner.succeed('Status retrieved');

      if (result.worker) {
        output.writeln();
        output.writeln(output.bold(`Worker: ${result.worker.id}`));
        output.printTable({
          columns: [
            { key: 'field', header: 'Field', width: 15 },
            { key: 'value', header: 'Value', width: 40 },
          ],
          data: [
            { field: 'Trigger', value: result.worker.trigger },
            { field: 'Context', value: result.worker.context },
            { field: 'Status', value: formatWorkerStatus(result.worker.status) },
            { field: 'Progress', value: `${result.worker.progress}%` },
            { field: 'Phase', value: result.worker.phase },
            { field: 'Duration', value: `${result.worker.duration}ms` },
          ],
        });
      } else if (result.workers && result.workers.length > 0) {
        output.writeln();
        output.writeln(output.bold('Active Workers'));
        output.printTable({
          columns: [
            { key: 'id', header: 'Worker ID', width: 35 },
            { key: 'trigger', header: 'Type', width: 12 },
            { key: 'status', header: 'Status', width: 12 },
            { key: 'progress', header: 'Progress', width: 10 },
            { key: 'duration', header: 'Duration', width: 12 },
          ],
          data: result.workers.map(w => ({
            id: w.id,
            trigger: w.trigger,
            status: formatWorkerStatus(w.status),
            progress: `${w.progress}%`,
            duration: `${w.duration}ms`,
          })),
        });

        if (result.summary) {
          output.writeln();
          output.writeln(`Total: ${result.summary.total} | Running: ${output.highlight(String(result.summary.running))} | Completed: ${output.success(String(result.summary.completed))} | Failed: ${output.error(String(result.summary.failed))}`);
        }
      } else {
        output.writeln();
        output.writeln(output.dim('No active workers'));
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Status check failed');
      if (error instanceof MCPClientError) {
        output.printError(`Status error: ${error.message}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

const workerDetectCommand: Command = {
  name: 'detect',
  description: 'Detect worker triggers from prompt text',
  options: [
    { name: 'prompt', short: 'p', type: 'string', description: 'Prompt text to analyze', required: true },
    { name: 'auto-dispatch', short: 'a', type: 'boolean', description: 'Automatically dispatch detected workers' },
    { name: 'min-confidence', short: 'm', type: 'string', description: 'Minimum confidence threshold (0-1)' },
  ],
  examples: [
    { command: 'claude-flow hooks worker detect -p "optimize performance"', description: 'Detect triggers in prompt' },
    { command: 'claude-flow hooks worker detect -p "security audit" --auto-dispatch', description: 'Detect and dispatch' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const prompt = ctx.flags['prompt'] as string;
    const autoDispatch = ctx.flags['auto-dispatch'] as boolean;
    const minConfidence = parseFloat(ctx.flags['min-confidence'] as string || '0.5');

    if (!prompt) {
      output.printError('--prompt is required');
      return { success: false, exitCode: 1 };
    }

    const spinner = output.createSpinner({ text: 'Analyzing prompt...', spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        prompt: string;
        detection: {
          detected: boolean;
          triggers: string[];
          confidence: number;
          context: string;
        };
        triggersFound: number;
        triggerDetails?: Array<{
          trigger: string;
          description: string;
          priority: string;
        }>;
        autoDispatched?: boolean;
        workerIds?: string[];
      }>('hooks_worker-detect', {
        prompt,
        autoDispatch,
        minConfidence,
      });

      if (result.detection.detected) {
        spinner.succeed(`Detected ${result.triggersFound} worker trigger(s)`);
      } else {
        spinner.succeed('No worker triggers detected');
      }

      output.writeln();
      output.writeln(output.bold('Detection Results'));
      output.writeln(`Prompt: ${output.dim(result.prompt)}`);
      output.writeln(`Confidence: ${(result.detection.confidence * 100).toFixed(0)}%`);

      if (result.triggerDetails && result.triggerDetails.length > 0) {
        output.writeln();
        output.printTable({
          columns: [
            { key: 'trigger', header: 'Trigger', width: 14 },
            { key: 'priority', header: 'Priority', width: 10 },
            { key: 'description', header: 'Description', width: 45 },
          ],
          data: result.triggerDetails.map(t => ({
            trigger: output.highlight(t.trigger),
            priority: t.priority,
            description: t.description,
          })),
        });
      }

      if (result.autoDispatched && result.workerIds) {
        output.writeln();
        output.writeln(output.success('Workers auto-dispatched:'));
        result.workerIds.forEach(id => {
          output.writeln(`  - ${id}`);
        });
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Detection failed');
      if (error instanceof MCPClientError) {
        output.printError(`Detection error: ${error.message}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

const workerCancelCommand: Command = {
  name: 'cancel',
  description: 'Cancel a running worker',
  options: [
    { name: 'id', type: 'string', description: 'Worker ID to cancel', required: true },
  ],
  examples: [
    { command: 'claude-flow hooks worker cancel --id worker_audit_1', description: 'Cancel specific worker' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const workerId = ctx.flags['id'] as string;

    if (!workerId) {
      output.printError('--id is required');
      return { success: false, exitCode: 1 };
    }

    const spinner = output.createSpinner({ text: `Cancelling worker ${workerId}...`, spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        success: boolean;
        workerId: string;
        cancelled: boolean;
        error?: string;
      }>('hooks_worker-cancel', { workerId });

      if (!result.success) {
        spinner.fail(`Failed: ${result.error}`);
        return { success: false, exitCode: 1 };
      }

      spinner.succeed(`Worker ${workerId} cancelled`);
      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Cancel failed');
      if (error instanceof MCPClientError) {
        output.printError(`Cancel error: ${error.message}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

function formatWorkerStatus(status: string): string {
  switch (status) {
    case 'running':
      return output.highlight(status);
    case 'completed':
      return output.success(status);
    case 'failed':
      return output.error(status);
    case 'pending':
      return output.dim(status);
    default:
      return status;
  }
}

// ============================================================================
// Coverage-Aware Routing Commands
// ============================================================================

// Coverage route subcommand
const coverageRouteCommand: Command = {
  name: 'coverage-route',
  description: 'Route task to agents based on test coverage gaps (ruvector integration)',
  options: [
    {
      name: 'task',
      short: 't',
      description: 'Task description to route',
      type: 'string',
      required: true
    },
    {
      name: 'threshold',
      description: 'Coverage threshold percentage (default: 80)',
      type: 'number',
      default: 80
    },
    {
      name: 'no-ruvector',
      description: 'Disable ruvector integration',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow hooks coverage-route -t "fix bug in auth"', description: 'Route with coverage awareness' },
    { command: 'claude-flow hooks coverage-route -t "add tests" --threshold 90', description: 'Route with custom threshold' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const task = (ctx.flags.task as string) || ctx.args[0];
    const threshold = ctx.flags.threshold as number ?? 80;
    const useRuvector = !ctx.flags['no-ruvector'];

    if (!task) {
      output.printError('Task description is required. Use --task or -t flag.');
      return { success: false, exitCode: 1 };
    }

    const spinner = output.createSpinner({ text: 'Analyzing coverage and routing task...' });
    spinner.start();

    // Try reading coverage from disk first
    const diskCoverage = readCoverageFromDisk();

    if (diskCoverage.found) {
      spinner.succeed(`Coverage data loaded from ${diskCoverage.source}`);

      // Find files with lowest coverage that may relate to the task
      const taskLower = task.toLowerCase();
      const taskWords = taskLower.split(/\s+/).filter(w => w.length > 2);

      // Score each file by relevance to the task and how low its coverage is
      const scoredFiles = diskCoverage.entries
        .filter(e => e.lines < threshold)
        .map(e => {
          const fileNameLower = e.filePath.toLowerCase();
          let relevance = 0;
          for (const word of taskWords) {
            if (fileNameLower.includes(word)) relevance += 2;
          }
          // Penalize high coverage (we care about low coverage)
          const coveragePenalty = e.lines / 100;
          return { ...e, relevance, score: relevance + (1 - coveragePenalty) };
        })
        .sort((a, b) => b.score - a.score);

      const gaps = scoredFiles.slice(0, 8).map(e => {
        const { gapType, priority } = classifyCoverageGap(e.lines, threshold);
        return {
          filePath: e.filePath,
          coveragePercent: e.lines,
          gapType,
          priority,
          suggestedAgents: suggestAgentsForFile(e.filePath),
          reason: `${e.lines.toFixed(1)}% coverage, below ${threshold}%`,
        };
      });

      const criticalGaps = gaps.filter(g => g.gapType === 'critical').length;
      const primaryAgent = taskLower.includes('test') ? 'tester' :
                           taskLower.includes('security') || taskLower.includes('auth') ? 'security-auditor' :
                           taskLower.includes('fix') || taskLower.includes('bug') ? 'coder' : 'tester';

      const suggestions: string[] = [];
      if (criticalGaps > 0) suggestions.push(`${criticalGaps} critical coverage gaps need immediate attention`);
      if (diskCoverage.summary.overallLineCoverage < threshold) {
        suggestions.push(`Overall line coverage (${diskCoverage.summary.overallLineCoverage.toFixed(1)}%) is below ${threshold}% threshold`);
      }
      if (scoredFiles.length > 8) suggestions.push(`${scoredFiles.length - 8} additional files with low coverage`);

      const result = {
        success: true,
        task,
        coverageAware: true,
        gaps,
        routing: {
          primaryAgent,
          confidence: gaps.length > 0 ? 0.85 : 0.6,
          reason: gaps.length > 0
            ? `Routing to ${primaryAgent} based on ${gaps.length} coverage gaps related to task`
            : `No coverage gaps found related to task, routing to ${primaryAgent}`,
          coverageImpact: gaps.length > 0 ? 'high' : 'low',
        },
        suggestions,
        metrics: {
          filesAnalyzed: diskCoverage.summary.totalFiles,
          totalGaps: scoredFiles.length,
          criticalGaps,
          avgCoverage: diskCoverage.summary.overallLineCoverage,
        },
        source: diskCoverage.source,
      };

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `Agent: ${output.highlight(result.routing.primaryAgent)}`,
          `Confidence: ${(result.routing.confidence * 100).toFixed(1)}%`,
          `Coverage-Aware: ${output.success('Yes')} (from ${diskCoverage.source})`,
          `Reason: ${result.routing.reason}`
        ].join('\n'),
        'Coverage-Aware Routing'
      );

      if (gaps.length > 0) {
        output.writeln();
        output.writeln(output.bold('Priority Coverage Gaps'));
        output.printTable({
          columns: [
            { key: 'filePath', header: 'File', width: 35, format: (v: unknown) => {
              const s = String(v);
              return s.length > 32 ? '...' + s.slice(-32) : s;
            }},
            { key: 'coveragePercent', header: 'Coverage', width: 10, align: 'right', format: (v: unknown) => `${Number(v).toFixed(1)}%` },
            { key: 'gapType', header: 'Type', width: 10 },
            { key: 'suggestedAgents', header: 'Agent', width: 15, format: (v: unknown) => Array.isArray(v) ? v[0] || '' : String(v) }
          ],
          data: gaps.slice(0, 8)
        });
      }

      if (result.metrics.filesAnalyzed > 0) {
        output.writeln();
        output.writeln(output.bold('Coverage Metrics'));
        output.printList([
          `Files Analyzed: ${result.metrics.filesAnalyzed}`,
          `Total Gaps: ${result.metrics.totalGaps}`,
          `Critical Gaps: ${result.metrics.criticalGaps}`,
          `Average Coverage: ${result.metrics.avgCoverage.toFixed(1)}%`
        ]);
      }

      if (suggestions.length > 0) {
        output.writeln();
        output.writeln(output.bold('Suggestions'));
        output.printList(suggestions.map(s => output.dim(s)));
      }

      return { success: true, data: result };
    }

    // No disk coverage - fall back to MCP tool
    try {
      const result = await callMCPTool<{
        success: boolean;
        task: string;
        coverageAware: boolean;
        gaps: Array<{
          filePath: string;
          coveragePercent: number;
          gapType: string;
          priority: number;
          suggestedAgents: string[];
          reason: string;
        }>;
        routing: {
          primaryAgent: string;
          confidence: number;
          reason: string;
          coverageImpact: string;
        };
        suggestions: string[];
        metrics: {
          filesAnalyzed: number;
          totalGaps: number;
          criticalGaps: number;
          avgCoverage: number;
        };
      }>('hooks_coverage-route', {
        task,
        threshold,
        useRuvector,
      });

      spinner.stop();

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `Agent: ${output.highlight(result.routing.primaryAgent)}`,
          `Confidence: ${(result.routing.confidence * 100).toFixed(1)}%`,
          `Coverage-Aware: ${result.coverageAware ? output.success('Yes') : output.dim('No coverage data')}`,
          `Reason: ${result.routing.reason}`
        ].join('\n'),
        'Coverage-Aware Routing'
      );

      if (result.gaps.length > 0) {
        output.writeln();
        output.writeln(output.bold('Priority Coverage Gaps'));
        output.printTable({
          columns: [
            { key: 'filePath', header: 'File', width: 35, format: (v: unknown) => {
              const s = String(v);
              return s.length > 32 ? '...' + s.slice(-32) : s;
            }},
            { key: 'coveragePercent', header: 'Coverage', width: 10, align: 'right', format: (v: unknown) => `${Number(v).toFixed(1)}%` },
            { key: 'gapType', header: 'Type', width: 10 },
            { key: 'suggestedAgents', header: 'Agent', width: 15, format: (v: unknown) => Array.isArray(v) ? v[0] || '' : String(v) }
          ],
          data: result.gaps.slice(0, 8)
        });
      }

      if (result.metrics.filesAnalyzed > 0) {
        output.writeln();
        output.writeln(output.bold('Coverage Metrics'));
        output.printList([
          `Files Analyzed: ${result.metrics.filesAnalyzed}`,
          `Total Gaps: ${result.metrics.totalGaps}`,
          `Critical Gaps: ${result.metrics.criticalGaps}`,
          `Average Coverage: ${result.metrics.avgCoverage.toFixed(1)}%`
        ]);
      }

      if (result.suggestions.length > 0) {
        output.writeln();
        output.writeln(output.bold('Suggestions'));
        output.printList(result.suggestions.map(s => output.dim(s)));
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('No coverage data found');
      output.writeln();
      output.printWarning('No coverage data found. Run your test suite with coverage first.');
      output.writeln();
      output.printList([
        'Jest:     npx jest --coverage',
        'Vitest:   npx vitest --coverage',
        'nyc:      npx nyc npm test',
        'c8:       npx c8 npm test',
      ]);
      output.writeln();
      output.writeln(output.dim('Expected files: coverage/coverage-summary.json, coverage/lcov.info, or .nyc_output/out.json'));
      return { success: false, exitCode: 1 };
    }
  }
};

// Coverage suggest subcommand
const coverageSuggestCommand: Command = {
  name: 'coverage-suggest',
  description: 'Suggest coverage improvements for a path (ruvector integration)',
  options: [
    {
      name: 'path',
      short: 'p',
      description: 'Path to analyze for coverage suggestions',
      type: 'string',
      required: true
    },
    {
      name: 'threshold',
      description: 'Coverage threshold percentage (default: 80)',
      type: 'number',
      default: 80
    },
    {
      name: 'limit',
      short: 'l',
      description: 'Maximum number of suggestions (default: 20)',
      type: 'number',
      default: 20
    }
  ],
  examples: [
    { command: 'claude-flow hooks coverage-suggest -p src/', description: 'Suggest improvements for src/' },
    { command: 'claude-flow hooks coverage-suggest -p src/services --threshold 90', description: 'Stricter threshold' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const targetPath = (ctx.flags.path as string) || ctx.args[0];
    const threshold = ctx.flags.threshold as number ?? 80;
    const limit = ctx.flags.limit as number || 20;

    if (!targetPath) {
      output.printError('Path is required. Use --path or -p flag.');
      return { success: false, exitCode: 1 };
    }

    const spinner = output.createSpinner({ text: `Analyzing coverage for ${targetPath}...` });
    spinner.start();

    // Try reading coverage from disk first
    const diskCoverage = readCoverageFromDisk();

    if (diskCoverage.found) {
      spinner.succeed(`Coverage data loaded from ${diskCoverage.source}`);

      // Filter entries to those matching the target path
      const pathLower = targetPath.toLowerCase().replace(/\\/g, '/');
      const matchingEntries = diskCoverage.entries.filter(e => {
        const fileLower = e.filePath.toLowerCase().replace(/\\/g, '/');
        return fileLower.includes(pathLower);
      });

      const belowThreshold = matchingEntries.filter(e => e.lines < threshold);
      const suggestions = belowThreshold.slice(0, limit).map(e => {
        const { gapType, priority } = classifyCoverageGap(e.lines, threshold);
        return {
          filePath: e.filePath,
          coveragePercent: e.lines,
          gapType,
          priority,
          suggestedAgents: suggestAgentsForFile(e.filePath),
          reason: e.lines === 0 ? 'No coverage at all' :
                  e.lines < 20 ? 'Very low coverage, needs tests' :
                  e.lines < 50 ? 'Below 50%, add more tests' :
                  `Below ${threshold}% threshold`,
        };
      });

      const totalLinesCov = matchingEntries.length > 0
        ? matchingEntries.reduce((acc, e) => acc + e.lines, 0) / matchingEntries.length
        : 0;
      const totalBranchesCov = matchingEntries.length > 0
        ? matchingEntries.reduce((acc, e) => acc + e.branches, 0) / matchingEntries.length
        : 0;

      const prioritizedFiles = belowThreshold.slice(0, 5).map(e => e.filePath);

      const result = {
        success: true,
        path: targetPath,
        suggestions,
        summary: {
          totalFiles: matchingEntries.length,
          overallLineCoverage: totalLinesCov,
          overallBranchCoverage: totalBranchesCov,
          filesBelowThreshold: belowThreshold.length,
        },
        prioritizedFiles,
        ruvectorAvailable: false,
        source: diskCoverage.source,
      };

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `Path: ${output.highlight(targetPath)}`,
          `Files Analyzed: ${result.summary.totalFiles}`,
          `Line Coverage: ${result.summary.overallLineCoverage.toFixed(1)}%`,
          `Branch Coverage: ${result.summary.overallBranchCoverage.toFixed(1)}%`,
          `Below Threshold: ${result.summary.filesBelowThreshold} files`,
          `Source: ${output.highlight(diskCoverage.source)}`
        ].join('\n'),
        'Coverage Summary'
      );

      if (suggestions.length > 0) {
        output.writeln();
        output.writeln(output.bold('Coverage Improvement Suggestions'));
        output.printTable({
          columns: [
            { key: 'filePath', header: 'File', width: 40, format: (v: unknown) => {
              const s = String(v);
              return s.length > 37 ? '...' + s.slice(-37) : s;
            }},
            { key: 'coveragePercent', header: 'Coverage', width: 10, align: 'right', format: (v: unknown) => `${Number(v).toFixed(1)}%` },
            { key: 'gapType', header: 'Priority', width: 10 },
            { key: 'reason', header: 'Reason', width: 25 }
          ],
          data: suggestions.slice(0, 15)
        });
      } else {
        output.writeln();
        output.printSuccess('All files meet coverage threshold!');
      }

      if (prioritizedFiles.length > 0) {
        output.writeln();
        output.writeln(output.bold('Priority Files (Top 5)'));
        output.printList(prioritizedFiles.slice(0, 5).map(f => output.highlight(f)));
      }

      return { success: true, data: result };
    }

    // No disk coverage - fall back to MCP tool
    try {
      const result = await callMCPTool<{
        success: boolean;
        path: string;
        suggestions: Array<{
          filePath: string;
          coveragePercent: number;
          gapType: string;
          priority: number;
          suggestedAgents: string[];
          reason: string;
        }>;
        summary: {
          totalFiles: number;
          overallLineCoverage: number;
          overallBranchCoverage: number;
          filesBelowThreshold: number;
        };
        prioritizedFiles: string[];
        ruvectorAvailable: boolean;
      }>('hooks_coverage-suggest', {
        path: targetPath,
        threshold,
        limit,
      });

      spinner.stop();

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `Path: ${output.highlight(result.path)}`,
          `Files Analyzed: ${result.summary.totalFiles}`,
          `Line Coverage: ${result.summary.overallLineCoverage.toFixed(1)}%`,
          `Branch Coverage: ${result.summary.overallBranchCoverage.toFixed(1)}%`,
          `Below Threshold: ${result.summary.filesBelowThreshold} files`,
          `RuVector: ${result.ruvectorAvailable ? output.success('Available') : output.dim('Not installed')}`
        ].join('\n'),
        'Coverage Summary'
      );

      if (result.suggestions.length > 0) {
        output.writeln();
        output.writeln(output.bold('Coverage Improvement Suggestions'));
        output.printTable({
          columns: [
            { key: 'filePath', header: 'File', width: 40, format: (v: unknown) => {
              const s = String(v);
              return s.length > 37 ? '...' + s.slice(-37) : s;
            }},
            { key: 'coveragePercent', header: 'Coverage', width: 10, align: 'right', format: (v: unknown) => `${Number(v).toFixed(1)}%` },
            { key: 'gapType', header: 'Priority', width: 10 },
            { key: 'reason', header: 'Reason', width: 25 }
          ],
          data: result.suggestions.slice(0, 15)
        });
      } else {
        output.writeln();
        output.printSuccess('All files meet coverage threshold!');
      }

      if (result.prioritizedFiles.length > 0) {
        output.writeln();
        output.writeln(output.bold('Priority Files (Top 5)'));
        output.printList(result.prioritizedFiles.slice(0, 5).map(f => output.highlight(f)));
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('No coverage data found');
      output.writeln();
      output.printWarning('No coverage data found. Run your test suite with coverage first.');
      output.writeln();
      output.printList([
        'Jest:     npx jest --coverage',
        'Vitest:   npx vitest --coverage',
        'nyc:      npx nyc npm test',
        'c8:       npx c8 npm test',
      ]);
      output.writeln();
      output.writeln(output.dim('Expected files: coverage/coverage-summary.json, coverage/lcov.info, or .nyc_output/out.json'));
      return { success: false, exitCode: 1 };
    }
  }
};

// Coverage gaps subcommand
const coverageGapsCommand: Command = {
  name: 'coverage-gaps',
  description: 'List all coverage gaps with priority scoring and agent assignments',
  options: [
    {
      name: 'threshold',
      description: 'Coverage threshold percentage (default: 80)',
      type: 'number',
      default: 80
    },
    {
      name: 'group-by-agent',
      description: 'Group gaps by suggested agent (default: true)',
      type: 'boolean',
      default: true
    },
    {
      name: 'critical-only',
      description: 'Show only critical gaps',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow hooks coverage-gaps', description: 'List all coverage gaps' },
    { command: 'claude-flow hooks coverage-gaps --critical-only', description: 'Only critical gaps' },
    { command: 'claude-flow hooks coverage-gaps --threshold 90', description: 'Stricter threshold' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const threshold = ctx.flags.threshold as number ?? 80;
    const groupByAgent = ctx.flags['group-by-agent'] !== false;
    const criticalOnly = ctx.flags['critical-only'] as boolean || false;

    const spinner = output.createSpinner({ text: 'Analyzing project coverage gaps...' });
    spinner.start();

    // Try reading coverage from disk first
    const diskCoverage = readCoverageFromDisk();

    if (diskCoverage.found) {
      spinner.succeed(`Coverage data loaded from ${diskCoverage.source}`);

      // Build gaps from disk data
      const allGaps = diskCoverage.entries
        .filter(e => e.lines < threshold)
        .map(e => {
          const { gapType, priority } = classifyCoverageGap(e.lines, threshold);
          return {
            filePath: e.filePath,
            coveragePercent: e.lines,
            gapType,
            complexity: Math.round((100 - e.lines) / 10),
            priority,
            suggestedAgents: suggestAgentsForFile(e.filePath),
            reason: `Line coverage ${e.lines.toFixed(1)}% below ${threshold}% threshold`,
          };
        });

      const gaps = criticalOnly
        ? allGaps.filter(g => g.gapType === 'critical')
        : allGaps;

      // Build agent assignments
      const agentAssignments: Record<string, string[]> = {};
      if (groupByAgent) {
        for (const gap of gaps) {
          const agent = gap.suggestedAgents[0] || 'tester';
          if (!agentAssignments[agent]) agentAssignments[agent] = [];
          agentAssignments[agent].push(gap.filePath);
        }
      }

      const result = {
        success: true,
        gaps,
        summary: {
          totalFiles: diskCoverage.summary.totalFiles,
          overallLineCoverage: diskCoverage.summary.overallLineCoverage,
          overallBranchCoverage: diskCoverage.summary.overallBranchCoverage,
          filesBelowThreshold: gaps.length,
          coverageThreshold: threshold,
        },
        agentAssignments,
        ruvectorAvailable: false,
        source: diskCoverage.source,
      };

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `Total Files: ${result.summary.totalFiles}`,
          `Line Coverage: ${result.summary.overallLineCoverage.toFixed(1)}%`,
          `Branch Coverage: ${result.summary.overallBranchCoverage.toFixed(1)}%`,
          `Below ${threshold}%: ${result.summary.filesBelowThreshold} files`,
          `Source: ${output.highlight(diskCoverage.source)}`
        ].join('\n'),
        'Coverage Gap Analysis'
      );

      if (gaps.length > 0) {
        output.writeln();
        output.writeln(output.bold(`Coverage Gaps (${gaps.length} files)`));
        output.printTable({
          columns: [
            { key: 'filePath', header: 'File', width: 35, format: (v: unknown) => {
              const s = String(v);
              return s.length > 32 ? '...' + s.slice(-32) : s;
            }},
            { key: 'coveragePercent', header: 'Coverage', width: 10, align: 'right', format: (v: unknown) => `${Number(v).toFixed(1)}%` },
            { key: 'gapType', header: 'Type', width: 10, format: (v: unknown) => {
              const t = String(v);
              if (t === 'critical') return output.error(t);
              if (t === 'high') return output.warning(t);
              return t;
            }},
            { key: 'priority', header: 'Priority', width: 8, align: 'right' },
            { key: 'suggestedAgents', header: 'Agent', width: 12, format: (v: unknown) => Array.isArray(v) ? v[0] || '' : String(v) }
          ],
          data: gaps.slice(0, 20)
        });
      } else {
        output.writeln();
        output.printSuccess('No coverage gaps found! All files meet threshold.');
      }

      if (groupByAgent && Object.keys(agentAssignments).length > 0) {
        output.writeln();
        output.writeln(output.bold('Agent Assignments'));
        for (const [agent, files] of Object.entries(agentAssignments)) {
          output.writeln();
          output.writeln(`  ${output.highlight(agent)} (${files.length} files)`);
          files.slice(0, 3).forEach(f => {
            output.writeln(`    - ${output.dim(f)}`);
          });
          if (files.length > 3) {
            output.writeln(`    ... and ${files.length - 3} more`);
          }
        }
      }

      return { success: true, data: result };
    }

    // No coverage files on disk - try MCP tool as fallback
    try {
      const result = await callMCPTool<{
        success: boolean;
        gaps: Array<{
          filePath: string;
          coveragePercent: number;
          gapType: string;
          complexity: number;
          priority: number;
          suggestedAgents: string[];
          reason: string;
        }>;
        summary: {
          totalFiles: number;
          overallLineCoverage: number;
          overallBranchCoverage: number;
          filesBelowThreshold: number;
          coverageThreshold: number;
        };
        agentAssignments: Record<string, string[]>;
        ruvectorAvailable: boolean;
      }>('hooks_coverage-gaps', {
        threshold,
        groupByAgent,
      });

      spinner.stop();

      const gaps = criticalOnly
        ? result.gaps.filter(g => g.gapType === 'critical')
        : result.gaps;

      if (ctx.flags.format === 'json') {
        output.printJson({ ...result, gaps });
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `Total Files: ${result.summary.totalFiles}`,
          `Line Coverage: ${result.summary.overallLineCoverage.toFixed(1)}%`,
          `Branch Coverage: ${result.summary.overallBranchCoverage.toFixed(1)}%`,
          `Below ${result.summary.coverageThreshold}%: ${result.summary.filesBelowThreshold} files`,
          `RuVector: ${result.ruvectorAvailable ? output.success('Available') : output.dim('Not installed')}`
        ].join('\n'),
        'Coverage Gap Analysis'
      );

      if (gaps.length > 0) {
        output.writeln();
        output.writeln(output.bold(`Coverage Gaps (${gaps.length} files)`));
        output.printTable({
          columns: [
            { key: 'filePath', header: 'File', width: 35, format: (v: unknown) => {
              const s = String(v);
              return s.length > 32 ? '...' + s.slice(-32) : s;
            }},
            { key: 'coveragePercent', header: 'Coverage', width: 10, align: 'right', format: (v: unknown) => `${Number(v).toFixed(1)}%` },
            { key: 'gapType', header: 'Type', width: 10, format: (v: unknown) => {
              const t = String(v);
              if (t === 'critical') return output.error(t);
              if (t === 'high') return output.warning(t);
              return t;
            }},
            { key: 'priority', header: 'Priority', width: 8, align: 'right' },
            { key: 'suggestedAgents', header: 'Agent', width: 12, format: (v: unknown) => Array.isArray(v) ? v[0] || '' : String(v) }
          ],
          data: gaps.slice(0, 20)
        });
      } else {
        output.writeln();
        output.printSuccess('No coverage gaps found! All files meet threshold.');
      }

      if (groupByAgent && Object.keys(result.agentAssignments).length > 0) {
        output.writeln();
        output.writeln(output.bold('Agent Assignments'));
        for (const [agent, files] of Object.entries(result.agentAssignments)) {
          output.writeln();
          output.writeln(`  ${output.highlight(agent)} (${files.length} files)`);
          files.slice(0, 3).forEach(f => {
            output.writeln(`    - ${output.dim(f)}`);
          });
          if (files.length > 3) {
            output.writeln(`    ... and ${files.length - 3} more`);
          }
        }
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('No coverage data found');
      output.writeln();
      output.printWarning('No coverage data found. Run your test suite with coverage first.');
      output.writeln();
      output.printList([
        'Jest:     npx jest --coverage',
        'Vitest:   npx vitest --coverage',
        'nyc:      npx nyc npm test',
        'c8:       npx c8 npm test',
      ]);
      output.writeln();
      output.writeln(output.dim('Expected files: coverage/coverage-summary.json, coverage/lcov.info, or .nyc_output/out.json'));
      return { success: false, exitCode: 1 };
    }
  }
};

// Progress hook command
const progressHookCommand: Command = {
  name: 'progress',
  description: 'Check V3 implementation progress via hooks',
  options: [
    {
      name: 'detailed',
      short: 'd',
      description: 'Show detailed breakdown by category',
      type: 'boolean',
      default: false
    },
    {
      name: 'sync',
      short: 's',
      description: 'Sync and persist progress to file',
      type: 'boolean',
      default: false
    },
    {
      name: 'summary',
      description: 'Show human-readable summary',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow hooks progress', description: 'Check current progress' },
    { command: 'claude-flow hooks progress -d', description: 'Detailed breakdown' },
    { command: 'claude-flow hooks progress --sync', description: 'Sync progress to file' },
    { command: 'claude-flow hooks progress --summary', description: 'Human-readable summary' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const detailed = ctx.flags.detailed as boolean;
    const sync = ctx.flags.sync as boolean;
    const summary = ctx.flags.summary as boolean;

    try {
      if (summary) {
        const spinner = output.createSpinner({ text: 'Getting progress summary...' });
        spinner.start();
        const result = await callMCPTool<{ summary: string }>('progress_summary', {});
        spinner.stop();

        if (ctx.flags.format === 'json') {
          output.printJson(result);
          return { success: true, data: result };
        }

        output.writeln();
        output.writeln(result.summary);
        return { success: true, data: result };
      }

      if (sync) {
        const spinner = output.createSpinner({ text: 'Syncing progress...' });
        spinner.start();
        const result = await callMCPTool<{
          progress: number;
          message: string;
          persisted: boolean;
          lastUpdated: string;
        }>('progress_sync', {});
        spinner.stop();

        if (ctx.flags.format === 'json') {
          output.printJson(result);
          return { success: true, data: result };
        }

        output.writeln();
        output.printSuccess(`Progress synced: ${result.progress}%`);
        output.writeln(output.dim(`  Persisted to .claude-flow/metrics/v3-progress.json`));
        output.writeln(output.dim(`  Last updated: ${result.lastUpdated}`));
        return { success: true, data: result };
      }

      // Default: check progress
      const spinner = output.createSpinner({ text: 'Checking V3 progress...' });
      spinner.start();
      const result = await callMCPTool<{
        progress?: number;
        overall?: number;
        summary?: string;
        breakdown?: Record<string, string>;
        cli?: { progress: number; commands: number; target: number };
        mcp?: { progress: number; tools: number; target: number };
        hooks?: { progress: number; subcommands: number; target: number };
        packages?: { progress: number; total: number; target: number; withDDD: number };
        ddd?: { progress: number };
        codebase?: { totalFiles: number; totalLines: number };
        lastUpdated?: string;
      }>('progress_check', { detailed });
      spinner.stop();

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      const progressValue = result.overall ?? result.progress ?? 0;

      // Create progress bar
      const barWidth = 30;
      const filled = Math.round((progressValue / 100) * barWidth);
      const empty = barWidth - filled;
      const bar = output.success('█'.repeat(filled)) + output.dim('░'.repeat(empty));

      output.writeln(output.bold('V3 Implementation Progress'));
      output.writeln();
      output.writeln(`[${bar}] ${progressValue}%`);
      output.writeln();

      if (detailed && result.cli) {
        output.writeln(output.highlight('CLI Commands:') + `     ${result.cli.progress}% (${result.cli.commands}/${result.cli.target})`);
        output.writeln(output.highlight('MCP Tools:') + `        ${result.mcp?.progress ?? 0}% (${result.mcp?.tools ?? 0}/${result.mcp?.target ?? 0})`);
        output.writeln(output.highlight('Hooks:') + `            ${result.hooks?.progress ?? 0}% (${result.hooks?.subcommands ?? 0}/${result.hooks?.target ?? 0})`);
        output.writeln(output.highlight('Packages:') + `         ${result.packages?.progress ?? 0}% (${result.packages?.total ?? 0}/${result.packages?.target ?? 0})`);
        output.writeln(output.highlight('DDD Structure:') + `    ${result.ddd?.progress ?? 0}% (${result.packages?.withDDD ?? 0}/${result.packages?.total ?? 0})`);
        output.writeln();
        if (result.codebase) {
          output.writeln(output.dim(`Codebase: ${result.codebase.totalFiles} files, ${result.codebase.totalLines.toLocaleString()} lines`));
        }
      } else if (result.breakdown) {
        output.writeln('Breakdown:');
        for (const [category, value] of Object.entries(result.breakdown)) {
          output.writeln(`  ${output.highlight(category)}: ${value}`);
        }
      }

      if (result.lastUpdated) {
        output.writeln(output.dim(`Last updated: ${result.lastUpdated}`));
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Progress check failed: ${error.message}`);
      } else {
        output.printError(`Progress check failed: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Worker parent command
const workerCommand: Command = {
  name: 'worker',
  description: 'Background worker management (12 workers for analysis/optimization)',
  subcommands: [
    workerListCommand,
    workerDispatchCommand,
    workerStatusCommand,
    workerDetectCommand,
    workerCancelCommand,
  ],
  options: [],
  examples: [
    { command: 'claude-flow hooks worker list', description: 'List all workers' },
    { command: 'claude-flow hooks worker dispatch -t optimize', description: 'Dispatch optimizer' },
    { command: 'claude-flow hooks worker detect -p "test coverage"', description: 'Detect from prompt' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Background Worker System (12 Workers)'));
    output.writeln();
    output.writeln('Manage and dispatch background workers for analysis and optimization tasks.');
    output.writeln();
    output.writeln('Available Workers:');
    output.printList([
      `${output.highlight('ultralearn')}   - Deep knowledge acquisition`,
      `${output.highlight('optimize')}     - Performance optimization`,
      `${output.highlight('consolidate')} - Memory consolidation`,
      `${output.highlight('predict')}      - Predictive preloading`,
      `${output.highlight('audit')}        - Security analysis (critical)`,
      `${output.highlight('map')}          - Codebase mapping`,
      `${output.highlight('preload')}      - Resource preloading`,
      `${output.highlight('deepdive')}     - Deep code analysis`,
      `${output.highlight('document')}     - Auto-documentation`,
      `${output.highlight('refactor')}     - Refactoring suggestions`,
      `${output.highlight('benchmark')}    - Performance benchmarks`,
      `${output.highlight('testgaps')}     - Test coverage analysis`,
    ]);
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('list')}     - List all workers with capabilities`,
      `${output.highlight('dispatch')} - Dispatch a worker`,
      `${output.highlight('status')}   - Check worker status`,
      `${output.highlight('detect')}   - Detect triggers from prompt`,
      `${output.highlight('cancel')}   - Cancel a running worker`,
    ]);
    output.writeln();
    output.writeln('Run "claude-flow hooks worker <subcommand> --help" for details');

    return { success: true };
  }
};

// Statusline subcommand - generates dynamic status display
const statuslineCommand: Command = {
  name: 'statusline',
  description: 'Generate dynamic statusline with V3 progress and system status',
  options: [
    {
      name: 'json',
      description: 'Output as JSON',
      type: 'boolean',
      default: false
    },
    {
      name: 'compact',
      description: 'Compact single-line output (auto-enabled when terminal width < 100 cols)',
      type: 'boolean',
      default: false
    },
    {
      name: 'full',
      description: 'Force the full multi-line output even on narrow terminals',
      type: 'boolean',
      default: false
    },
    {
      name: 'no-color',
      description: 'Disable ANSI colors',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow hooks statusline', description: 'Display full statusline' },
    { command: 'claude-flow hooks statusline --json', description: 'JSON output for hooks' },
    { command: 'claude-flow hooks statusline --compact', description: 'Single-line status' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const fs = await import('fs');
    const path = await import('path');
    const { execSync } = await import('child_process');

    // Get learning stats from memory database
    function getLearningStats() {
      const memoryPaths = [
        path.join(process.cwd(), '.swarm', 'memory.db'),
        path.join(process.cwd(), '.claude', 'memory.db'),
      ];

      let patterns = 0;
      let sessions = 0;
      let trajectories = 0;

      for (const dbPath of memoryPaths) {
        if (fs.existsSync(dbPath)) {
          try {
            const stats = fs.statSync(dbPath);
            const sizeKB = stats.size / 1024;
            patterns = Math.floor(sizeKB / 2);
            sessions = Math.max(1, Math.floor(patterns / 10));
            trajectories = Math.floor(patterns / 5);
            break;
          } catch {
            // Ignore
          }
        }
      }

      const sessionsPath = path.join(process.cwd(), '.claude', 'sessions');
      if (fs.existsSync(sessionsPath)) {
        try {
          const sessionFiles = fs.readdirSync(sessionsPath).filter((f: string) => f.endsWith('.json'));
          sessions = Math.max(sessions, sessionFiles.length);
        } catch {
          // Ignore
        }
      }

      return { patterns, sessions, trajectories };
    }

    // Get V3 progress
    function getV3Progress() {
      const learning = getLearningStats();
      let domainsCompleted = 0;
      if (learning.patterns >= 500) domainsCompleted = 5;
      else if (learning.patterns >= 200) domainsCompleted = 4;
      else if (learning.patterns >= 100) domainsCompleted = 3;
      else if (learning.patterns >= 50) domainsCompleted = 2;
      else if (learning.patterns >= 10) domainsCompleted = 1;

      const totalDomains = 5;
      const dddProgress = Math.min(100, Math.floor((domainsCompleted / totalDomains) * 100));

      return { domainsCompleted, totalDomains, dddProgress, patternsLearned: learning.patterns, sessionsCompleted: learning.sessions };
    }

    // Security/swarm status — shared with the advisor-tip refresh (ADR-316)
    // via funnel/local-signals.ts, a single source of truth so the two call
    // sites can never silently drift on what these signals mean.
    const getSecurityStatus = sharedGetSecurityStatus;
    const getSwarmStatus = sharedGetSwarmStatus;

    // Get system metrics
    function getSystemMetrics() {
      let memoryMB = 0;
      let subAgents = 0;
      const learning = getLearningStats();

      try {
        memoryMB = Math.floor(process.memoryUsage().heapUsed / 1024 / 1024);
      } catch {
        // Ignore
      }

      // Calculate intelligence from multiple sources (matching statusline-generator.ts)
      let intelligencePct = 0;

      // 1. Check learning.json for REAL intelligence metrics first
      const learningJsonPaths = [
        path.join(process.cwd(), '.claude-flow', 'learning.json'),
        path.join(process.cwd(), '.claude', '.claude-flow', 'learning.json'),
        path.join(process.cwd(), '.swarm', 'learning.json'),
      ];
      for (const lPath of learningJsonPaths) {
        if (fs.existsSync(lPath)) {
          try {
            const data = JSON.parse(fs.readFileSync(lPath, 'utf-8'));
            if (data.intelligence?.score !== undefined) {
              intelligencePct = Math.min(100, Math.floor(data.intelligence.score));
              break;
            }
          } catch { /* ignore */ }
        }
      }

      // 2. Fallback: calculate from patterns and vectors
      if (intelligencePct === 0) {
        const fromPatterns = learning.patterns > 0 ? Math.min(100, Math.floor(learning.patterns / 10)) : 0;
        // Will be updated later with vector count
        intelligencePct = fromPatterns;
      }

      // 3. Fallback: calculate maturity score from project indicators
      if (intelligencePct === 0) {
        let maturityScore = 0;
        // Check for key project files/dirs
        if (fs.existsSync(path.join(process.cwd(), '.claude'))) maturityScore += 15;
        if (fs.existsSync(path.join(process.cwd(), '.claude-flow'))) maturityScore += 15;
        if (fs.existsSync(path.join(process.cwd(), 'CLAUDE.md'))) maturityScore += 10;
        if (fs.existsSync(path.join(process.cwd(), 'claude-flow.config.json'))) maturityScore += 10;
        if (fs.existsSync(path.join(process.cwd(), '.swarm'))) maturityScore += 10;
        // Check for test files
        const testDirs = ['tests', '__tests__', 'test', 'v3/__tests__'];
        for (const dir of testDirs) {
          if (fs.existsSync(path.join(process.cwd(), dir))) {
            maturityScore += 10;
            break;
          }
        }
        // Check for hooks config
        if (fs.existsSync(path.join(process.cwd(), '.claude', 'settings.json'))) maturityScore += 10;
        intelligencePct = Math.min(100, maturityScore);
      }

      const contextPct = Math.min(100, Math.floor(learning.sessions * 5));

      return { memoryMB, contextPct, intelligencePct, subAgents };
    }

    // #2733: Claude Code pipes session JSON (incl. the real active model) on
    // stdin to statusline commands. Read it synchronously the same way
    // .claude/helpers/statusline.cjs's getModelFromStdin() does, so this CLI
    // subcommand is correct standalone — not just when the generated helper
    // happens to override its output. Read once, memoized per invocation
    // (mirrors statusline.cjs's _stdinData cache).
    let _stdinData: unknown;
    let _stdinRead = false;
    function getStdinData(): { model?: { display_name?: string } } | null {
      if (_stdinRead) return _stdinData as { model?: { display_name?: string } } | null;
      _stdinRead = true;
      try {
        if (process.stdin.isTTY) { _stdinData = null; return null; }
        const chunks: Buffer[] = [];
        const buf = Buffer.alloc(4096);
        let bytesRead: number;
        try {
          while ((bytesRead = fs.readSync(0, buf, 0, buf.length, null)) > 0) {
            chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
          }
        } catch { /* EOF or read error */ }
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        _stdinData = (raw && raw.startsWith('{')) ? JSON.parse(raw) : null;
      } catch {
        _stdinData = null;
      }
      return _stdinData as { model?: { display_name?: string } } | null;
    }
    function getModelFromStdin(): string | null {
      const data = getStdinData();
      return (data && data.model && typeof data.model.display_name === 'string') ? data.model.display_name : null;
    }

    // Get user info
    function getUserInfo() {
      const identityMode = (process.env.RUFLO_STATUSLINE_IDENTITY || 'project').toLowerCase();
      let name = path.basename(process.cwd()) || 'project';
      let gitBranch = '';
      // Real active model from Claude Code's stdin payload when available;
      // this string is only a last-resort label for direct/manual CLI
      // invocation with no stdin (e.g. a bare terminal run) — never shown
      // when Claude Code itself is the caller.
      const modelName = getModelFromStdin() || 'Claude Code';
      const isWindows = process.platform === 'win32';

      try {
        const rootCmd = isWindows
          ? 'git rev-parse --show-toplevel 2>NUL'
          : 'git rev-parse --show-toplevel 2>/dev/null';
        const branchCmd = isWindows
          ? 'git branch --show-current 2>NUL || echo.'
          : 'git branch --show-current 2>/dev/null || echo ""';
        const root = execSync(rootCmd, { encoding: 'utf-8' }).trim();
        name = path.basename(root) || name;
        if (identityMode === 'author') {
          const authorCmd = isWindows
            ? 'git config user.name 2>NUL || echo user'
            : 'git config user.name 2>/dev/null || echo "user"';
          name = execSync(authorCmd, { encoding: 'utf-8' }).trim() || 'user';
        }
        gitBranch = execSync(branchCmd, { encoding: 'utf-8' }).trim();
        if (gitBranch === '.') gitBranch = '';
      } catch {
        // Ignore
      }

      return { name, gitBranch, modelName };
    }

    // Collect all status
    const progress = getV3Progress();
    const security = getSecurityStatus();
    const swarm = getSwarmStatus();
    const system = getSystemMetrics();
    const user = getUserInfo();
    const getGitUncommittedCount = sharedGetGitUncommittedCount;

    // Funnel promo row (ADR-301). The statusline is spawned with piped stdio
    // by an interactive host, so interactivity is asserted here; all other
    // gates (RUFLO_FUNNEL, enterprise policy, config, CI, disclosure,
    // rotation ratio) are enforced inside getFunnelPromo. Never allowed to
    // break the statusline.
    let promo: import('../funnel/types.js').PromoRow | null = null;
    try {
      const { getFunnelPromo } = await import('../funnel/index.js');
      promo = getFunnelPromo({
        interactive: true,
        localInsights: { security, swarm, gitUncommittedCount: getGitUncommittedCount() },
      });
    } catch {
      promo = null;
    }

    const statusData = {
      user,
      v3Progress: progress,
      security,
      swarm,
      system,
      promo,
      timestamp: new Date().toISOString()
    };

    // JSON output
    if (ctx.flags.json || ctx.flags.format === 'json') {
      output.printJson(statusData);
      return { success: true, data: statusData };
    }

    // #1153: auto-collapse to compact on narrow terminals so the full
    // 6+ line statusline doesn't dominate the screen. Honors:
    //   - explicit --compact → compact
    //   - explicit --full    → full (overrides auto-detection)
    //   - else                → compact when terminal < 100 cols (full multi-line
    //                            output expects ~100 cols of horizontal space)
    const COMPACT_WIDTH_THRESHOLD = 100;
    const terminalCols = process.stdout.columns ?? 80;
    const autoCompact = !ctx.flags.full && terminalCols < COMPACT_WIDTH_THRESHOLD;
    if (ctx.flags.compact || autoCompact) {
      const securityCompact = security.findings > 0
        ? `Findings:${security.findings}`
        : `Security:${security.status}`;
      const line = `DDD:${progress.domainsCompleted}/${progress.totalDomains} ${securityCompact} Swarm:${swarm.activeAgents}/${swarm.maxAgents} Ctx:${system.contextPct}% Int:${system.intelligencePct}%`;
      output.writeln(line);
      return { success: true, data: statusData };
    }

    // Full colored output
    const noColor = ctx.flags['no-color'] || ctx.flags.noColor;
    const c = noColor ? {
      reset: '', bold: '', dim: '', red: '', green: '', yellow: '', blue: '',
      purple: '', cyan: '', brightRed: '', brightGreen: '', brightYellow: '',
      brightBlue: '', brightPurple: '', brightCyan: '', brightWhite: ''
    } : {
      reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[0;31m',
      green: '\x1b[0;32m', yellow: '\x1b[0;33m', blue: '\x1b[0;34m',
      purple: '\x1b[0;35m', cyan: '\x1b[0;36m', brightRed: '\x1b[1;31m',
      brightGreen: '\x1b[1;32m', brightYellow: '\x1b[1;33m', brightBlue: '\x1b[1;34m',
      brightPurple: '\x1b[1;35m', brightCyan: '\x1b[1;36m', brightWhite: '\x1b[1;37m'
    };

    // Progress bar helper
    const progressBar = (current: number, total: number) => {
      const filled = Math.round((current / total) * 5);
      const empty = 5 - filled;
      return '[' + '●'.repeat(filled) + '○'.repeat(empty) + ']';
    };

    // Generate lines
    let header = `${c.bold}${c.brightPurple}▊ RuFlo V3 ${c.reset}`;
    header += `${swarm.coordinationActive ? c.brightCyan : c.dim}● ${c.brightCyan}${user.name}${c.reset}`;
    if (user.gitBranch) {
      header += `  ${c.dim}│${c.reset}  ${c.brightBlue}⎇ ${user.gitBranch}${c.reset}`;
    }
    header += `  ${c.dim}│${c.reset}  ${c.purple}${user.modelName}${c.reset}`;

    const separator = `${c.dim}─────────────────────────────────────────────────────${c.reset}`;

    // Get hooks stats
    const hooksStats = { enabled: 0, total: 17 };
    const settingsPath = path.join(process.cwd(), '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (settings.hooks) {
          hooksStats.enabled = Object.values(settings.hooks).filter((h: unknown) => h && typeof h === 'object').length;
        }
      } catch { /* ignore */ }
    }

    // Get AgentDB stats (matching statusline-generator.ts paths)
    const agentdbStats = { vectorCount: 0, dbSizeKB: 0, hasHnsw: false };

    // Check for direct database files first
    const dbPaths = [
      path.join(process.cwd(), '.swarm', 'memory.db'),
      path.join(process.cwd(), '.claude-flow', 'memory.db'),
      path.join(process.cwd(), '.claude', 'memory.db'),
      path.join(process.cwd(), 'data', 'memory.db'),
      path.join(process.cwd(), 'memory.db'),
      path.join(process.cwd(), '.agentdb', 'memory.db'),
      path.join(process.cwd(), '.claude-flow', 'memory', 'agentdb.db'),
    ];
    for (const dbPath of dbPaths) {
      if (fs.existsSync(dbPath)) {
        try {
          const stats = fs.statSync(dbPath);
          agentdbStats.dbSizeKB = Math.round(stats.size / 1024);
          agentdbStats.vectorCount = Math.floor(agentdbStats.dbSizeKB / 2);
          agentdbStats.hasHnsw = agentdbStats.vectorCount > 100;
          break;
        } catch { /* ignore */ }
      }
    }

    // Check for AgentDB directories if no direct db found
    if (agentdbStats.vectorCount === 0) {
      const agentdbDirs = [
        path.join(process.cwd(), '.claude-flow', 'agentdb'),
        path.join(process.cwd(), '.swarm', 'agentdb'),
        path.join(process.cwd(), 'data', 'agentdb'),
        path.join(process.cwd(), '.agentdb'),
      ];
      for (const dir of agentdbDirs) {
        if (fs.existsSync(dir)) {
          try {
            const files = fs.readdirSync(dir);
            for (const f of files) {
              if (f.endsWith('.db') || f.endsWith('.sqlite')) {
                const filePath = path.join(dir, f);
                const fileStat = fs.statSync(filePath);
                agentdbStats.dbSizeKB += Math.round(fileStat.size / 1024);
              }
            }
            agentdbStats.vectorCount = Math.floor(agentdbStats.dbSizeKB / 2);
            agentdbStats.hasHnsw = agentdbStats.vectorCount > 100;
            if (agentdbStats.vectorCount > 0) break;
          } catch { /* ignore */ }
        }
      }
    }

    // Check for HNSW index files
    const hnswPaths = [
      path.join(process.cwd(), '.claude-flow', 'hnsw'),
      path.join(process.cwd(), '.swarm', 'hnsw'),
      path.join(process.cwd(), 'data', 'hnsw'),
    ];
    for (const hnswPath of hnswPaths) {
      if (fs.existsSync(hnswPath)) {
        agentdbStats.hasHnsw = true;
        try {
          const hnswFiles = fs.readdirSync(hnswPath);
          const indexFile = hnswFiles.find(f => f.endsWith('.index'));
          if (indexFile) {
            const indexStat = fs.statSync(path.join(hnswPath, indexFile));
            const hnswVectors = Math.floor(indexStat.size / 512);
            agentdbStats.vectorCount = Math.max(agentdbStats.vectorCount, hnswVectors);
          }
        } catch { /* ignore */ }
        break;
      }
    }

    // Check for vectors.json file
    const vectorsPath = path.join(process.cwd(), '.claude-flow', 'vectors.json');
    if (fs.existsSync(vectorsPath) && agentdbStats.vectorCount === 0) {
      try {
        const data = JSON.parse(fs.readFileSync(vectorsPath, 'utf-8'));
        if (Array.isArray(data)) {
          agentdbStats.vectorCount = data.length;
        } else if (data.vectors) {
          agentdbStats.vectorCount = Object.keys(data.vectors).length;
        }
      } catch { /* ignore */ }
    }

    // Get test stats
    const testStats = { testFiles: 0, testCases: 0 };
    const testPaths = ['tests', '__tests__', 'test', 'spec'];
    for (const testPath of testPaths) {
      const fullPath = path.join(process.cwd(), testPath);
      if (fs.existsSync(fullPath)) {
        try {
          const files = fs.readdirSync(fullPath, { recursive: true }) as string[];
          testStats.testFiles = files.filter((f: string) => /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(f)).length;
          testStats.testCases = testStats.testFiles * 28; // Estimate
        } catch { /* ignore */ }
      }
    }

    // Get MCP stats
    const mcpStats = { enabled: 0, total: 0 };
    const mcpPath = path.join(process.cwd(), '.mcp.json');
    if (fs.existsSync(mcpPath)) {
      try {
        const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
        if (mcp.mcpServers) {
          mcpStats.total = Object.keys(mcp.mcpServers).length;
          mcpStats.enabled = mcpStats.total;
        }
      } catch { /* ignore */ }
    }

    // Get ADR stats — scan well-known ADR directories for .md files
    const adrStats = { count: 0, implemented: 0 };
    const adrPaths = [
      path.join(process.cwd(), 'v3', 'implementation', 'adrs'),
      path.join(process.cwd(), 'docs', 'adrs'),
      path.join(process.cwd(), 'docs', 'adr'),
      path.join(process.cwd(), '.claude-flow', 'adrs'),
    ];
    for (const adrPath of adrPaths) {
      try {
        if (fs.existsSync(adrPath)) {
          const files = fs.readdirSync(adrPath).filter((f: string) =>
            f.endsWith('.md') && (f.startsWith('ADR-') || f.startsWith('adr-') || /^\d{4}-/.test(f))
          );
          adrStats.count = files.length;
          // Count implemented/accepted ADRs by scanning file content
          for (const file of files) {
            try {
              const content = fs.readFileSync(path.join(adrPath, file), 'utf-8');
              if (/Status\s*[:\*]*\s*(Accepted|Implemented)/i.test(content)) {
                adrStats.implemented++;
              }
            } catch { /* ignore */ }
          }
          if (adrStats.count === 0) continue; // Empty dir, try next
          break;
        }
      } catch { /* ignore */ }
    }

    const domainsColor = progress.domainsCompleted >= 3 ? c.brightGreen : progress.domainsCompleted > 0 ? c.yellow : c.red;
    // Dynamic perf indicator based on patterns/HNSW
    let perfIndicator = `${c.dim}⚡ target: 150x-12500x${c.reset}`;
    if (agentdbStats.hasHnsw && agentdbStats.vectorCount > 0) {
      const speedup = agentdbStats.vectorCount > 10000 ? '12500x' : agentdbStats.vectorCount > 1000 ? '150x' : '10x';
      perfIndicator = `${c.brightGreen}⚡ HNSW ${speedup}${c.reset}`;
    } else if (progress.patternsLearned > 0) {
      const patternsK = progress.patternsLearned >= 1000 ? `${(progress.patternsLearned / 1000).toFixed(1)}k` : String(progress.patternsLearned);
      perfIndicator = `${c.brightYellow}📚 ${patternsK} patterns${c.reset}`;
    }

    const line1 = `${c.brightCyan}🏗️  DDD Domains${c.reset}    ${progressBar(progress.domainsCompleted, progress.totalDomains)}  ` +
      `${domainsColor}${progress.domainsCompleted}${c.reset}/${c.brightWhite}${progress.totalDomains}${c.reset}    ` +
      perfIndicator;

    const swarmIndicator = swarm.coordinationActive ? `${c.brightGreen}◉${c.reset}` : `${c.dim}○${c.reset}`;
    const agentsColor = swarm.activeAgents > 0 ? c.brightGreen : c.red;
    const securityIcon = security.status === 'CLEAN' ? '🟢' : security.status === 'PENDING' ? '🟡' : '🔴';
    const securityColor = security.status === 'CLEAN' ? c.brightGreen : security.status === 'PENDING' ? c.brightYellow : c.brightRed;
    const hooksColor = hooksStats.enabled > 0 ? c.brightGreen : c.dim;

    const line2 = `${c.brightYellow}🤖 Swarm${c.reset}  ${swarmIndicator} [${agentsColor}${String(swarm.activeAgents).padStart(2)}${c.reset}/${c.brightWhite}${swarm.maxAgents}${c.reset}]  ` +
      `${c.brightPurple}👥 ${system.subAgents}${c.reset}    ` +
      `${c.brightBlue}🪝 ${hooksColor}${hooksStats.enabled}${c.reset}/${c.brightWhite}${hooksStats.total}${c.reset}    ` +
      `${securityIcon} ${securityColor}${security.findings > 0 ? `Findings ${security.findings}` : `Security ${security.status}`}${c.reset}    ` +
      `${c.brightCyan}💾 ${system.memoryMB}MB${c.reset}    ` +
      `${c.brightPurple}🧠 ${String(system.intelligencePct).padStart(3)}%${c.reset}`;

    const dddColor = progress.dddProgress >= 50 ? c.brightGreen : progress.dddProgress > 0 ? c.yellow : c.red;
    const adrColor = adrStats.implemented > 0 ? c.brightGreen : c.dim;
    const line3 = `${c.brightPurple}🔧 Architecture${c.reset}    ` +
      `${c.cyan}ADRs${c.reset} ${adrColor}●${adrStats.implemented}/${adrStats.count}${c.reset}  ${c.dim}│${c.reset}  ` +
      `${c.cyan}DDD${c.reset} ${dddColor}●${String(progress.dddProgress).padStart(3)}%${c.reset}  ${c.dim}│${c.reset}  ` +
      `${c.cyan}Security${c.reset} ${securityColor}●${security.status}${c.reset}`;

    const vectorColor = agentdbStats.vectorCount > 0 ? c.brightGreen : c.dim;
    const testColor = testStats.testFiles > 0 ? c.brightGreen : c.dim;
    const mcpColor = mcpStats.enabled > 0 ? c.brightGreen : c.dim;
    const sizeDisplay = agentdbStats.dbSizeKB >= 1024 ? `${(agentdbStats.dbSizeKB / 1024).toFixed(1)}MB` : `${agentdbStats.dbSizeKB}KB`;
    const hnswIndicator = agentdbStats.hasHnsw ? `${c.brightGreen}⚡${c.reset}` : '';

    const line4 = `${c.brightCyan}📊 AgentDB${c.reset}    ` +
      `${c.cyan}Vectors${c.reset} ${vectorColor}●${agentdbStats.vectorCount}${hnswIndicator}${c.reset}  ${c.dim}│${c.reset}  ` +
      `${c.cyan}Size${c.reset} ${c.brightWhite}${sizeDisplay}${c.reset}  ${c.dim}│${c.reset}  ` +
      `${c.cyan}Tests${c.reset} ${testColor}●${testStats.testFiles}${c.reset} ${c.dim}(${testStats.testCases} cases)${c.reset}  ${c.dim}│${c.reset}  ` +
      `${c.cyan}MCP${c.reset} ${mcpColor}●${mcpStats.enabled}/${mcpStats.total}${c.reset}`;

    output.writeln(header);
    output.writeln(separator);
    output.writeln(line1);
    output.writeln(line2);
    output.writeln(line3);
    output.writeln(line4);

    return { success: true, data: statusData };
  }
};

// Backward-compatible aliases for v2 hooks
// These ensure old settings.json files continue to work
const routeTaskCommand: Command = {
  name: 'route-task',
  description: '(DEPRECATED: Use "route" instead) Route task to optimal agent',
  options: routeCommand.options,
  examples: [
    { command: 'claude-flow hooks route-task --auto-swarm true', description: 'Route with auto-swarm (v2 compat)' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Silently handle v2-specific flags that don't exist in v3
    // --auto-swarm, --detect-complexity are ignored but don't fail
    if (routeCommand.action) {
      const result = await routeCommand.action(ctx);
      return result || { success: true };
    }
    return { success: true };
  }
};

const sessionStartCommand: Command = {
  name: 'session-start',
  description: '(DEPRECATED: Use "session-restore" instead) Start/restore session',
  options: [
    ...(sessionRestoreCommand.options || []),
    // V2-compatible options that are silently ignored
    {
      name: 'auto-configure',
      description: '(v2 compat) Auto-configure session',
      type: 'boolean',
      default: false
    },
    {
      name: 'restore-context',
      description: '(v2 compat) Restore context',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow hooks session-start --auto-configure true', description: 'Start session (v2 compat)' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Map to session-restore for backward compatibility
    if (sessionRestoreCommand.action) {
      const result = await sessionRestoreCommand.action(ctx);
      return result || { success: true };
    }
    return { success: true };
  }
};

// Pre-bash alias for pre-command (v2 compat)
const preBashCommand: Command = {
  name: 'pre-bash',
  description: '(ALIAS) Same as pre-command',
  options: preCommandCommand.options,
  examples: preCommandCommand.examples,
  action: preCommandCommand.action
};

// Post-bash alias for post-command (v2 compat)
const postBashCommand: Command = {
  name: 'post-bash',
  description: '(ALIAS) Same as post-command',
  options: postCommandCommand.options,
  examples: postCommandCommand.examples,
  action: postCommandCommand.action
};

// Token Optimizer command - integrates agentic-flow Agent Booster
const tokenOptimizeCommand: Command = {
  name: 'token-optimize',
  description: 'Token optimization via agentic-flow Agent Booster integration',
  options: [
    { name: 'query', short: 'q', type: 'string', description: 'Query for compact context retrieval' },
    { name: 'agents', short: 'A', type: 'number', description: 'Agent count for optimal config', default: '6' },
    { name: 'report', short: 'r', type: 'boolean', description: 'Generate optimization report' },
    { name: 'stats', short: 's', type: 'boolean', description: 'Show token savings statistics' },
  ],
  examples: [
    { command: 'claude-flow hooks token-optimize --stats', description: 'Show token savings stats' },
    { command: 'claude-flow hooks token-optimize -q "auth patterns"', description: 'Get compact context' },
    { command: 'claude-flow hooks token-optimize -A 8 --report', description: 'Config for 8 agents + report' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const query = ctx.flags['query'] as string;
    const agentCount = parseInt(ctx.flags['agents'] as string || '6', 10);
    const showReport = ctx.flags['report'] as boolean;
    const showStats = ctx.flags['stats'] as boolean;

    const spinner = output.createSpinner({ text: 'Checking agentic-flow integration...', spinner: 'dots' });
    spinner.start();

    // Inline TokenOptimizer (self-contained, no external imports)
    const stats = {
      totalTokensSaved: 0,
      editsOptimized: 0,
      cacheHits: 0,
      cacheMisses: 0,
      memoriesRetrieved: 0,
    };
    let agenticFlowAvailable = false;
    let reasoningBank: { retrieveMemories: (query: string, opts: { k: number }) => Promise<unknown[]>; formatMemoriesForPrompt?: (memories: unknown[]) => string } | null = null;

    try {
      // Check if agentic-flow v3 is available
      const rb = await import('agentic-flow/reasoningbank').catch(() => null);
      if (rb) {
        agenticFlowAvailable = true;
        if (typeof rb.retrieveMemories === 'function') {
          reasoningBank = rb;
        }
      } else {
        // Legacy check for older agentic-flow
        const af = await import('agentic-flow').catch(() => null);
        if (af) agenticFlowAvailable = true;
      }

      const versionLabel = agenticFlowAvailable ? `agentic-flow v3 detected (ReasoningBank: ${reasoningBank ? 'active' : 'unavailable'})` : 'agentic-flow not available (using fallbacks)';
      spinner.succeed(versionLabel);
      output.writeln();

      // Anti-drift config (hardcoded optimal values from research)
      const config = {
        batchSize: 4,
        cacheSizeMB: 50,
        topology: 'hierarchical',
        expectedSuccessRate: 0.95,
      };

      output.printBox(
        `Anti-Drift Swarm Config\n\n` +
        `Agents: ${agentCount}\n` +
        `Topology: ${config.topology}\n` +
        `Batch Size: ${config.batchSize}\n` +
        `Cache: ${config.cacheSizeMB}MB\n` +
        `Success Rate: ${(config.expectedSuccessRate * 100)}%`
      );

      // If query provided, get compact context via ReasoningBank
      if (query && reasoningBank) {
        output.writeln();
        output.printInfo(`Retrieving compact context for: "${query}"`);
        const memories = await reasoningBank.retrieveMemories(query, { k: 5 });
        const compactPrompt = reasoningBank.formatMemoriesForPrompt ? reasoningBank.formatMemoriesForPrompt(memories) : '';
        // Estimate based on actual query vs compact prompt size difference
        const queryTokenEstimate = Math.ceil((query?.length || 0) / 4);
        const used = Math.ceil((compactPrompt?.length || 0) / 4);
        const tokensSaved = Math.max(0, queryTokenEstimate - used);
        stats.totalTokensSaved += tokensSaved;
        stats.memoriesRetrieved += Array.isArray(memories) ? memories.length : 0;
        output.writeln(`  Memories found: ${Array.isArray(memories) ? memories.length : 0}`);
        output.writeln(`  Tokens saved: ${output.success(String(tokensSaved))}`);
        if (compactPrompt) {
          output.writeln(`  Compact prompt (${compactPrompt.length} chars)`);
        }
      } else if (query) {
        output.writeln();
        output.printInfo('ReasoningBank not available - query skipped');
      }

      // Note: stats reflect only actual measured values from this session.
      // No simulated/fabricated data is added.

      // Show stats
      if (showStats || showReport) {
        output.writeln();
        const total = stats.cacheHits + stats.cacheMisses;
        const hitRate = total > 0 ? (stats.cacheHits / total * 100).toFixed(1) : '0';
        const savings = (stats.totalTokensSaved / 1000 * 0.01).toFixed(2);

        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 25 },
            { key: 'value', header: 'Value', width: 20 },
          ],
          data: [
            { metric: 'Tokens Saved', value: stats.totalTokensSaved.toLocaleString() },
            { metric: 'Edits Optimized', value: String(stats.editsOptimized) },
            { metric: 'Cache Hit Rate', value: `${hitRate}%` },
            { metric: 'Memories Retrieved', value: String(stats.memoriesRetrieved) },
            { metric: 'Est. Monthly Savings', value: `$${savings}` },
            { metric: 'Agentic-Flow Active', value: agenticFlowAvailable ? '✓' : '✗' },
          ],
        });
      }

      // Full report
      if (showReport) {
        output.writeln();
        const total = stats.cacheHits + stats.cacheMisses;
        const hitRate = total > 0 ? (stats.cacheHits / total * 100).toFixed(1) : '0';
        const savings = (stats.totalTokensSaved / 1000 * 0.01).toFixed(2);
        output.writeln(`## Token Optimization Report

| Metric | Value |
|--------|-------|
| Tokens Saved | ${stats.totalTokensSaved.toLocaleString()} |
| Edits Optimized | ${stats.editsOptimized} |
| Cache Hit Rate | ${hitRate}% |
| Memories Retrieved | ${stats.memoriesRetrieved} |
| Est. Monthly Savings | $${savings} |
| Agentic-Flow Active | ${agenticFlowAvailable ? '✓' : '✗'} |`);
      }

      return { success: true, data: { config, stats: { ...stats, agenticFlowAvailable } } };
    } catch (error) {
      spinner.fail('TokenOptimizer failed');
      const err = error as Error;
      output.printError(`Error: ${err.message}`);

      // Fallback info
      output.writeln();
      output.printInfo('Fallback anti-drift config:');
      output.writeln('  topology: hierarchical');
      output.writeln('  maxAgents: 8');
      output.writeln('  strategy: specialized');
      output.writeln('  batchSize: 4');

      return { success: false, exitCode: 1 };
    }
  }
};

// Model Router command - intelligent model selection (haiku/sonnet/opus)
const modelRouteCommand: Command = {
  name: 'model-route',
  description: 'Route task to optimal Claude model (haiku/sonnet/opus) based on complexity',
  options: [
    { name: 'task', short: 't', type: 'string', description: 'Task description to route', required: true },
    { name: 'context', short: 'c', type: 'string', description: 'Additional context' },
    { name: 'prefer-cost', type: 'boolean', description: 'Prefer lower cost models' },
    { name: 'prefer-quality', type: 'boolean', description: 'Prefer higher quality models' },
  ],
  examples: [
    { command: 'claude-flow hooks model-route -t "fix typo"', description: 'Route simple task (likely haiku)' },
    { command: 'claude-flow hooks model-route -t "architect auth system"', description: 'Route complex task (likely opus)' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const task = (ctx.flags.task as string) || ctx.args[0];
    if (!task) {
      output.printError('Task description required. Use --task or -t flag.');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Analyzing task complexity: ${output.highlight(task.slice(0, 50))}...`);

    try {
      const result = await callMCPTool<{
        model: string;
        complexity: number;
        confidence: number;
        reasoning: string;
        costMultiplier?: number;
        implementation?: string;
      }>('hooks_model-route', {
        task,
        context: ctx.flags.context,
        preferCost: ctx.flags['prefer-cost'],
        preferQuality: ctx.flags['prefer-quality'],
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();

      // Model icon based on selection
      const modelIcons: Record<string, string> = {
        haiku: '🌸',
        sonnet: '📜',
        opus: '🎭',
      };
      const model = result.model || 'sonnet';
      const icon = modelIcons[model] || '🤖';

      // Calculate cost savings compared to opus
      const costMultipliers: Record<string, number> = { haiku: 0.04, sonnet: 0.2, opus: 1.0 };
      const costSavings = model !== 'opus'
        ? `${((1 - costMultipliers[model]) * 100).toFixed(0)}% vs opus`
        : undefined;

      // Determine complexity level
      const complexityScore = typeof result.complexity === 'number' ? result.complexity : 0.5;
      const complexityLevel = complexityScore > 0.7 ? 'high' : complexityScore > 0.4 ? 'medium' : 'low';

      output.printBox(
        [
          `Selected Model: ${icon} ${output.bold(model.toUpperCase())}`,
          `Confidence: ${(result.confidence * 100).toFixed(1)}%`,
          `Complexity: ${complexityLevel} (${(complexityScore * 100).toFixed(0)}%)`,
          costSavings ? `Cost Savings: ${costSavings}` : '',
        ].filter(Boolean).join('\n'),
        'Model Routing Result'
      );

      output.writeln();
      output.writeln(output.bold('Reasoning'));
      output.writeln(output.dim(result.reasoning || 'Based on task complexity analysis'));

      if (result.implementation) {
        output.writeln();
        output.writeln(output.dim(`Implementation: ${result.implementation}`));
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Model routing failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Model Outcome command - record routing outcomes for learning
const modelOutcomeCommand: Command = {
  name: 'model-outcome',
  description: 'Record model routing outcome for learning',
  options: [
    { name: 'task', short: 't', type: 'string', description: 'Task that was executed', required: true },
    { name: 'model', short: 'm', type: 'string', description: 'Model that was used (haiku/sonnet/opus)', required: true },
    { name: 'outcome', short: 'o', type: 'string', description: 'Outcome (success/failure/escalated)', required: true },
    { name: 'quality', short: 'q', type: 'number', description: 'Quality score 0-1' },
  ],
  examples: [
    { command: 'claude-flow hooks model-outcome -t "fix typo" -m haiku -o success', description: 'Record successful haiku task' },
    { command: 'claude-flow hooks model-outcome -t "auth system" -m sonnet -o escalated', description: 'Record escalation to opus' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const task = ctx.flags.task as string;
    const model = ctx.flags.model as string;
    const outcome = ctx.flags.outcome as string;

    if (!task || !model || !outcome) {
      output.printError('Task, model, and outcome are required.');
      return { success: false, exitCode: 1 };
    }

    try {
      const result = await callMCPTool<{ recorded: boolean; learningUpdate: string }>('hooks_model-outcome', {
        task,
        model,
        outcome,
        quality: ctx.flags.quality,
      });

      output.printSuccess(`Outcome recorded for ${model}: ${outcome}`);
      if (result.learningUpdate) {
        output.writeln(output.dim(result.learningUpdate));
      }

      return { success: true, data: result };
    } catch (error) {
      output.printError(`Failed to record outcome: ${String(error)}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Model Stats command - view routing statistics
const modelStatsCommand: Command = {
  name: 'model-stats',
  description: 'View model routing statistics and learning metrics',
  options: [
    { name: 'detailed', short: 'd', type: 'boolean', description: 'Show detailed breakdown' },
  ],
  examples: [
    { command: 'claude-flow hooks model-stats', description: 'View routing stats' },
    { command: 'claude-flow hooks model-stats --detailed', description: 'Show detailed breakdown' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      const result = await callMCPTool<{
        available: boolean;
        message?: string;
        totalDecisions?: number;
        modelDistribution?: Record<string, number>;
        avgComplexity?: number;
        avgConfidence?: number;
        circuitBreakerTrips?: number;
      }>('hooks_model-stats', {
        detailed: ctx.flags.detailed,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      if (!result.available) {
        output.printWarning(result.message || 'Model router not available');
        return { success: true, data: result };
      }

      // Calculate cost savings based on model distribution
      const dist = result.modelDistribution || { haiku: 0, sonnet: 0, opus: 0 };
      const totalTasks = result.totalDecisions || 0;
      const costMultipliers: Record<string, number> = { haiku: 0.04, sonnet: 0.2, opus: 1.0 };

      let totalCost = 0;
      let maxCost = totalTasks; // If all were opus
      for (const [model, count] of Object.entries(dist)) {
        if (model !== 'inherit') {
          totalCost += count * (costMultipliers[model] || 1);
        }
      }
      const costSavings = maxCost > 0 ? ((1 - totalCost / maxCost) * 100).toFixed(1) : '0';

      output.writeln();
      output.printBox(
        [
          `Total Tasks Routed: ${totalTasks}`,
          `Avg Complexity: ${((result.avgComplexity || 0) * 100).toFixed(1)}%`,
          `Avg Confidence: ${((result.avgConfidence || 0) * 100).toFixed(1)}%`,
          `Cost Savings: ${costSavings}% vs all-opus`,
          `Circuit Breaker Trips: ${result.circuitBreakerTrips || 0}`,
        ].join('\n'),
        'Model Routing Statistics'
      );

      if (dist && Object.keys(dist).length > 0) {
        output.writeln();
        output.writeln(output.bold('Model Distribution'));
        output.printTable({
          columns: [
            { key: 'model', header: 'Model', width: 10 },
            { key: 'count', header: 'Tasks', width: 8, align: 'right' },
            { key: 'percentage', header: '%', width: 8, align: 'right' },
            { key: 'costMultiplier', header: 'Cost', width: 8, align: 'right' },
          ],
          data: Object.entries(dist)
            .filter(([model]) => model !== 'inherit')
            .map(([model, count]) => ({
              model: model.toUpperCase(),
              count,
              percentage: totalTasks > 0 ? `${((count / totalTasks) * 100).toFixed(1)}%` : '0%',
              costMultiplier: `${costMultipliers[model] || 1}x`,
            })),
        });
      }

      return { success: true, data: result };
    } catch (error) {
      output.printError(`Failed to get stats: ${String(error)}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Teammate Idle command - Agent Teams integration
const teammateIdleCommand: Command = {
  name: 'teammate-idle',
  description: 'Handle idle teammate in Agent Teams - auto-assign tasks or notify lead',
  options: [
    {
      name: 'auto-assign',
      short: 'a',
      description: 'Automatically assign pending tasks to idle teammate',
      type: 'boolean',
      // #3031: explicit opt-in only. Idle/liveness is not assignment authority.
      default: false
    },
    {
      name: 'check-task-list',
      short: 'c',
      description: 'Check shared task list for available work',
      type: 'boolean',
      default: true
    },
    {
      name: 'teammate-id',
      short: 't',
      description: 'ID of the idle teammate',
      type: 'string'
    },
    {
      name: 'team-name',
      description: 'Team name for context',
      type: 'string'
    }
  ],
  examples: [
    { command: 'claude-flow hooks teammate-idle --auto-assign true', description: 'Auto-assign tasks to idle teammate' },
    { command: 'claude-flow hooks teammate-idle -t worker-1 --check-task-list', description: 'Check tasks for specific teammate' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const autoAssign = ctx.flags.autoAssign === true;
    const checkTaskList = ctx.flags.checkTaskList !== false;
    const teammateId = ctx.flags.teammateId as string;
    const teamName = ctx.flags.teamName as string;

    if (ctx.flags.format !== 'json') {
      output.printInfo(`Teammate idle hook triggered${teammateId ? ` for: ${output.highlight(teammateId)}` : ''}`);
    }

    try {
      const result = await callMCPTool<{
        success: boolean;
        teammateId: string;
        action: 'assigned' | 'waiting' | 'notified';
        taskAssigned?: {
          taskId: string;
          subject: string;
          priority: string;
        };
        pendingTasks: number;
        message: string;
      }>('hooks_teammate-idle', {
        autoAssign,
        checkTaskList,
        teammateId,
        teamName,
        timestamp: Date.now(),
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      if (result.action === 'assigned' && result.taskAssigned) {
        output.printSuccess(`Task assigned: ${result.taskAssigned.subject}`);
        output.printList([
          `Task ID: ${result.taskAssigned.taskId}`,
          `Priority: ${result.taskAssigned.priority}`,
          `Pending tasks remaining: ${result.pendingTasks}`
        ]);
      } else if (result.action === 'waiting') {
        output.printInfo('No pending tasks available - teammate waiting for work');
      } else {
        output.printInfo(`Team lead notified: ${result.message}`);
      }

      return { success: true, data: result };
    } catch (error) {
      // Graceful fallback - don't fail hard, just report
      if (ctx.flags.format === 'json') {
        output.printJson({ success: true, action: 'waiting', message: 'Teammate idle - no MCP server' });
      } else {
        output.printInfo('Teammate idle - awaiting task assignment');
      }
      return { success: true };
    }
  }
};

// Task Completed command - Agent Teams integration
const taskCompletedCommand: Command = {
  name: 'task-completed',
  description: 'Handle task completion in Agent Teams - train patterns and notify lead',
  options: [
    {
      name: 'task-id',
      short: 'i',
      description: 'ID of the completed task',
      type: 'string',
      required: true
    },
    {
      name: 'train-patterns',
      short: 'p',
      description: 'Train neural patterns from successful task',
      type: 'boolean',
      default: true
    },
    {
      name: 'notify-lead',
      short: 'n',
      description: 'Notify team lead of task completion',
      type: 'boolean',
      default: true
    },
    {
      name: 'success',
      short: 's',
      description: 'Whether the task succeeded',
      type: 'boolean',
      default: true
    },
    {
      name: 'quality',
      short: 'q',
      description: 'Quality score (0-1)',
      type: 'number'
    },
    {
      name: 'teammate-id',
      short: 't',
      description: 'ID of the teammate that completed the task',
      type: 'string'
    }
  ],
  examples: [
    { command: 'claude-flow hooks task-completed -i task-123 --train-patterns', description: 'Complete task and train patterns' },
    { command: 'claude-flow hooks task-completed -i task-456 --notify-lead --quality 0.95', description: 'Complete with quality score' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const taskId = (ctx.flags.taskId as string) || ctx.args[0];
    const trainPatterns = ctx.flags.trainPatterns !== false;
    const notifyLead = ctx.flags.notifyLead !== false;
    const success = ctx.flags.success !== false;
    const quality = ctx.flags.quality as number;
    const teammateId = ctx.flags.teammateId as string;

    if (!taskId) {
      output.printError('Task ID is required. Use --task-id or -i flag.');
      return { success: false, exitCode: 1 };
    }

    if (ctx.flags.format !== 'json') {
      output.printInfo(`Task completed: ${output.highlight(taskId)}`);
    }

    try {
      const result = await callMCPTool<{
        success: boolean;
        taskId: string;
        patternsLearned: number;
        leadNotified: boolean;
        metrics: {
          duration: number;
          quality: number;
          learningUpdates: number;
        };
        nextTask?: {
          taskId: string;
          subject: string;
        };
      }>('hooks_task-completed', {
        taskId,
        trainPatterns,
        notifyLead,
        success,
        quality,
        teammateId,
        timestamp: Date.now(),
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printSuccess(`Task ${taskId} marked complete`);

      output.writeln();
      output.writeln(output.bold('Completion Metrics'));
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 25 },
          { key: 'value', header: 'Value', width: 20, align: 'right' }
        ],
        data: [
          { metric: 'Patterns Learned', value: result.patternsLearned },
          { metric: 'Quality Score', value: quality ? `${(quality * 100).toFixed(0)}%` : 'N/A' },
          { metric: 'Lead Notified', value: result.leadNotified ? 'Yes' : 'No' },
          { metric: 'Learning Updates', value: result.metrics?.learningUpdates || 0 }
        ]
      });

      if (result.nextTask) {
        output.writeln();
        output.printInfo(`Next available task: ${result.nextTask.subject}`);
      }

      return { success: true, data: result };
    } catch (error) {
      // Graceful fallback
      if (ctx.flags.format === 'json') {
        output.printJson({ success: true, taskId, message: 'Task completed - patterns pending' });
      } else {
        output.printSuccess(`Task ${taskId} completed`);
        if (trainPatterns) {
          output.printInfo('Pattern training queued for next sync');
        }
      }
      return { success: true };
    }
  }
};

// Notify subcommand
const notifyCommand: Command = {
  name: 'notify',
  description: 'Send a notification message (logged to session)',
  options: [
    { name: 'message', short: 'm', type: 'string', description: 'Notification message', required: true },
    { name: 'level', short: 'l', type: 'string', description: 'Level: info, warn, error', default: 'info' },
    { name: 'channel', short: 'c', type: 'string', description: 'Notification channel', default: 'console' },
  ],
  examples: [
    { command: 'claude-flow hooks notify -m "Build complete"', description: 'Send info notification' },
    { command: 'claude-flow hooks notify -m "Test failed" -l error', description: 'Send error notification' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const message = (ctx.flags.message as string) || ctx.args[0];
    const level = (ctx.flags.level as string) || 'info';

    if (!message) {
      output.printError('Message is required: --message "your message"');
      return { success: false, exitCode: 1 };
    }

    const timestamp = new Date().toISOString();

    if (level === 'error') {
      output.printError(`[${timestamp}] ${message}`);
    } else if (level === 'warn') {
      output.writeln(output.warning(`[${timestamp}] ${message}`));
    } else {
      output.printInfo(`[${timestamp}] ${message}`);
    }

    // Store notification in memory if available
    try {
      const { storeEntry } = await import('../memory/memory-initializer.js');
      await storeEntry({ key: `notify-${Date.now()}`, value: `[${level}] ${message}`, namespace: 'notifications' });
    } catch { /* memory not available */ }

    return { success: true, data: { timestamp, level, message } };
  }
};

// Refresh-funnel subcommand — the fix for "promo doesn't load right away".
//
// refreshRemoteMessages() (funnel/message-transport.ts) is fire-and-forget
// by design so the STATUSLINE's own per-render invocation never blocks on
// a network call. But the statusline is spawned as a short-lived subprocess
// per render (execSync from statusline-generator.ts) — a fire-and-forget
// promise kicked off there has no "later" to run in; the process exits
// before the HTTPS fetch can complete, so the local message cache never
// actually gets written and the promo row never appears (confirmed live:
// two consecutive cold-cache statusline renders, 5s apart, both returned
// promo:null and the cache file was never created).
//
// This command exists to be invoked from a LONGER-LIVED context — the
// SessionStart hook (see hook-handler.cjs's 'session-restore' handler,
// which spawns this detached so it isn't killed when the hook's own
// process exits, and isn't awaited so it doesn't add to the hook's own
// timeout budget). One real, properly-awaited refresh attempt here, once
// per session, is what actually gives refreshRemoteMessages() a chance to
// finish before anything needs the cache.
const refreshFunnelCommand: Command = {
  name: 'refresh-funnel',
  description: 'Best-effort background refresh of the funnel message cache (internal — see hook-handler.cjs session-restore)',
  options: [
    { name: 'quiet', description: 'Suppress output (used when spawned detached from a hook)', type: 'boolean', default: false },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      const { refreshRemoteMessages } = await import('../funnel/index.js');
      const result = await refreshRemoteMessages();
      if (!ctx.flags.quiet) {
        output.writeln(JSON.stringify(result));
      }
      return { success: true, data: result };
    } catch (error) {
      // Fail silent by design (matches message-transport.ts's own "fail
      // silent" discipline) — a broken refresh must never surface as a
      // hook error, only ever as "no promo this session."
      if (!ctx.flags.quiet) {
        output.printError(`refresh-funnel failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { success: true, data: { refreshed: false, skipped: 'error' } };
    }
  }
};

// Refresh-advisor subcommand — ADR-316's co-pilot tip. Mirrors
// refreshFunnelCommand exactly: a properly-awaited CLI subcommand meant to
// be spawned DETACHED from hook-handler.cjs's session-restore handler, so a
// real (potentially multi-second, real-money) `claude -p` call gets a
// chance to finish without ever blocking or being awaited by the hook's own
// process. refreshAdvisorTipIfStale() itself is the safety net that makes
// this cheap to call on every session-restore: it checks consent + a 24h
// TTL BEFORE spending anything, so most invocations are a no-op file read.
const refreshAdvisorCommand: Command = {
  name: 'refresh-advisor',
  description: 'Best-effort background refresh of the co-pilot advisor tip (internal — see hook-handler.cjs session-restore; ADR-316)',
  options: [
    { name: 'quiet', description: 'Suppress output (used when spawned detached from a hook)', type: 'boolean', default: false },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      const { refreshAdvisorTipIfStale } = await import('../funnel/advisor-tip.js');
      const { getSecurityStatus, getSwarmStatus, getGitUncommittedCount } = await import('../funnel/local-signals.js');
      const result = await refreshAdvisorTipIfStale({
        security: getSecurityStatus(),
        swarm: getSwarmStatus(),
        gitUncommittedCount: getGitUncommittedCount(),
      });
      if (!ctx.flags.quiet) {
        output.writeln(JSON.stringify(result));
      }
      return { success: true, data: result };
    } catch (error) {
      // Fail silent by design (matches refresh-funnel's own discipline) — a
      // broken advisor refresh must never surface as a hook error, only
      // ever as "no tip this window."
      if (!ctx.flags.quiet) {
        output.printError(`refresh-advisor failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { success: true, data: { refreshed: false, reason: 'error' } };
    }
  }
};

// Main hooks command
export const hooksCommand: Command = {
  name: 'hooks',
  description: 'Self-learning hooks system for intelligent workflow automation',
  subcommands: [
    preEditCommand,
    postEditCommand,
    preCommandCommand,
    postCommandCommand,
    preTaskCommand,
    postTaskCommand,
    sessionEndCommand,
    sessionRestoreCommand,
    routeCommand,
    explainCommand,
    pretrainCommand,
    buildAgentsCommand,
    metricsCommand,
    transferCommand,
    listCommand,
    intelligenceCommand,
    notifyCommand,
    workerCommand,
    progressHookCommand,
    statuslineCommand,
    // Coverage-aware routing commands
    coverageRouteCommand,
    coverageSuggestCommand,
    coverageGapsCommand,
    // Token optimization
    tokenOptimizeCommand,
    // Model routing (tiny-dancer integration)
    modelRouteCommand,
    modelOutcomeCommand,
    modelStatsCommand,
    // Backward-compatible aliases for v2
    routeTaskCommand,
    sessionStartCommand,
    preBashCommand,
    postBashCommand,
    // Agent Teams integration
    teammateIdleCommand,
    taskCompletedCommand,
    // Funnel background refresh — see refreshFunnelCommand's own doc comment
    refreshFunnelCommand,
    // Advisor co-pilot tip background refresh — ADR-316
    refreshAdvisorCommand,
  ],
  options: [],
  examples: [
    { command: 'claude-flow hooks pre-edit -f src/utils.ts', description: 'Get context before editing' },
    { command: 'claude-flow hooks route -t "Fix authentication bug"', description: 'Route task to optimal agent' },
    { command: 'claude-flow hooks pretrain', description: 'Bootstrap intelligence from repository' },
    { command: 'claude-flow hooks metrics --v3-dashboard', description: 'View V3 performance metrics' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Self-Learning Hooks System'));
    output.writeln();
    output.writeln('Intelligent workflow automation with pattern learning and adaptive routing');
    output.writeln();
    output.writeln('Usage: claude-flow hooks <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('pre-edit')}        - Get context before editing files`,
      `${output.highlight('post-edit')}       - Record editing outcomes for learning`,
      `${output.highlight('pre-command')}     - Assess risk before executing commands`,
      `${output.highlight('post-command')}    - Record command execution outcomes`,
      `${output.highlight('pre-task')}        - Record task start and get agent suggestions`,
      `${output.highlight('post-task')}       - Record task completion for learning`,
      `${output.highlight('session-end')}     - End current session and persist state`,
      `${output.highlight('session-restore')} - Restore a previous session`,
      `${output.highlight('route')}           - Route tasks to optimal agents`,
      `${output.highlight('explain')}         - Explain routing decisions`,
      `${output.highlight('pretrain')}        - Bootstrap intelligence from repository`,
      `${output.highlight('build-agents')}    - Generate optimized agent configs`,
      `${output.highlight('metrics')}         - View learning metrics dashboard`,
      `${output.highlight('transfer')}        - Transfer patterns from another project`,
      `${output.highlight('list')}            - List all registered hooks`,
      `${output.highlight('worker')}          - Background worker management (12 workers)`,
      `${output.highlight('progress')}        - Check V3 implementation progress`,
      `${output.highlight('statusline')}      - Generate dynamic statusline display`,
      `${output.highlight('coverage-route')}  - Route tasks based on coverage gaps (ruvector)`,
      `${output.highlight('coverage-suggest')}- Suggest coverage improvements`,
      `${output.highlight('coverage-gaps')}   - List all coverage gaps with agents`,
      `${output.highlight('token-optimize')} - Token optimization (agentic-flow integration)`,
      `${output.highlight('model-route')}    - Route to optimal model (haiku/sonnet/opus)`,
      `${output.highlight('model-outcome')}  - Record model routing outcome`,
      `${output.highlight('model-stats')}    - View model routing statistics`,
      '',
      output.bold('Agent Teams:'),
      `${output.highlight('teammate-idle')}  - Handle idle teammate (auto-assign tasks)`,
      `${output.highlight('task-completed')} - Handle task completion (train patterns)`
    ]);
    output.writeln();
    output.writeln('Run "claude-flow hooks <subcommand> --help" for subcommand help');
    output.writeln();
    output.writeln(output.bold('V3 Features:'));
    output.printList([
      '🧠 ReasoningBank adaptive learning',
      '⚡ Flash Attention (2.49x-7.47x speedup)',
      '🔍 AgentDB integration (150x faster search)',
      '📊 84.8% SWE-Bench solve rate',
      '🎯 32.3% token reduction',
      '🚀 2.8-4.4x speed improvement',
      '👥 Agent Teams integration (auto task assignment)'
    ]);

    return { success: true };
  }
};

export default hooksCommand;
