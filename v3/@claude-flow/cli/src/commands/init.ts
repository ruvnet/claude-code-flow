/**
 * V3 CLI Init Command
 * Comprehensive initialization for Claude Flow with Claude Code integration
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { confirm, select, multiSelect, input } from '../prompt.js';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import {
  executeInit,
  executeUpgrade,
  executeUpgradeWithMissing,
  DEFAULT_INIT_OPTIONS,
  MINIMAL_INIT_OPTIONS,
  FULL_INIT_OPTIONS,
  type InitOptions,
} from '../init/index.js';
import {
  ENROLLMENT_SCREEN,
  recordEnrollmentOutcome,
  shouldOfferEnrollment,
} from '../funnel/enrollment.js';
import { commandExists } from '../services/harness-hosts.js';

/**
 * ADR-302 post-init capability enrollment. One-time, interactive-TTY-only,
 * skippable with --no-signup, auto-skipped in CI/automation. Never throws
 * and never affects init's exit code. Accepting records the `account`
 * consent receipt only — no other capability is enabled by this prompt.
 */
async function offerCapabilityEnrollment(ctx: CommandContext): Promise<void> {
  try {
    const noSignup = Boolean(ctx.flags['no-signup'] || ctx.flags.noSignup);
    if (ctx.flags.format === 'json') return; // scripted output stays pure
    if (!shouldOfferEnrollment({ noSignup, cwd: ctx.cwd })) return;
    output.writeln();
    output.writeln(ENROLLMENT_SCREEN);
    output.writeln();
    const accepted = await confirm({
      message: 'Create a free Cognitum account now?',
      default: false,
    });
    recordEnrollmentOutcome(Boolean(accepted));
    output.writeln();
    if (accepted) {
      output.printInfo('Create your free account at https://cognitum.one');
      output.writeln(output.dim('  CLI sign-in (`ruflo auth login`) ships with the ADR-306 auth release.'));
    } else {
      output.writeln(output.dim('You can enable later at https://cognitum.one — this prompt will not repeat.'));
    }
  } catch {
    // Enrollment is optional; init success is never affected.
  }
}

// Dynamic import of the optional @claude-flow/codex package. Returns
// undefined (never throws) when the package isn't resolvable anywhere —
// callers decide whether that's a hard error (explicit --codex/--dual) or a
// silent skip (auto-detect during a plain `ruflo init`).
interface CodexInitResult {
  success: boolean;
  errors?: string[];
  filesCreated: string[];
  skillsGenerated: string[];
  warnings?: string[];
}
type CodexInitializerCtor = new () => { initialize: (options: Record<string, unknown>) => Promise<CodexInitResult> };

async function resolveCodexInitializer(cwd: string): Promise<CodexInitializerCtor | undefined> {
  // Use a variable to prevent TypeScript from statically resolving the optional module
  const codexModuleId = '@claude-flow/codex';
  const resolutionStrategies = [
    // Strategy 1: Direct import (works if installed as CLI dependency)
    async () => (await import(codexModuleId)).CodexInitializer,
    // Strategy 2: Project node_modules (works if installed in user's project)
    async () => {
      const projectPath = path.join(cwd, 'node_modules', '@claude-flow', 'codex', 'dist', 'index.js');
      if (fs.existsSync(projectPath)) {
        const mod = await import(`file://${projectPath}`);
        return mod.CodexInitializer;
      }
      throw new Error('Not found in project');
    },
    // Strategy 3: Global node_modules
    async () => {
      const { execSync } = await import('child_process');
      const globalPath = execSync('npm root -g', { encoding: 'utf-8' }).trim();
      const codexPath = path.join(globalPath, '@claude-flow', 'codex', 'dist', 'index.js');
      if (fs.existsSync(codexPath)) {
        const mod = await import(`file://${codexPath}`);
        return mod.CodexInitializer;
      }
      throw new Error('Not found globally');
    },
  ];

  for (const strategy of resolutionStrategies) {
    try {
      const ctor = await strategy();
      if (ctor) return ctor;
    } catch {
      // Try next strategy
    }
  }
  return undefined;
}

// Keep Codex out of the CLI dependency graph so cold `npx ruflo --version`
// remains fast (#2561). An explicit `init --codex` may fetch the small,
// stable adapter on demand when it is not already installed by an umbrella
// package, the current project, or the global npm prefix.
export function runCodexInitializerCli(
  cwd: string,
  options: { template: string; force: boolean; dual: boolean },
): boolean {
  const npxArgs = [
    '-y',
    '@claude-flow/codex@latest',
    'init',
    '--template',
    options.template,
    ...(options.force ? ['--force'] : []),
    ...(options.dual ? ['--dual'] : []),
  ];

  const result = process.platform === 'win32'
    ? spawnSync(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', ['npx', ...npxArgs].join(' ')],
        { cwd, stdio: 'inherit', windowsHide: true },
      )
    : spawnSync('npx', npxArgs, { cwd, stdio: 'inherit' });

  if (result.error) throw result.error;
  return result.status === 0;
}

// #2666-adjacent — quietly wire up Codex too when a plain `ruflo init` (no
// --codex/--dual) runs on a machine that also has the OpenAI Codex CLI on
// PATH: registers its MCP server and installs skills alongside the Claude
// Code setup that just happened. Best-effort and silent-by-default — must
// never fail or noisily interrupt a normal init. Opt out with
// --no-codex-detect. Skipped entirely under --skip-claude (runtime-only
// init) and scripted `--format json` output.
async function maybeAutoDetectCodex(
  ctx: CommandContext,
  options: { force: boolean; minimal: boolean; full: boolean },
): Promise<void> {
  try {
    if (ctx.flags['no-codex-detect'] === true) return;
    if (ctx.flags.format === 'json') return; // scripted output stays pure
    if (!commandExists('codex')) return;

    const CodexInitializer = await resolveCodexInitializer(ctx.cwd);
    if (!CodexInitializer) {
      output.writeln();
      output.printInfo('Detected the OpenAI Codex CLI — install @claude-flow/codex to auto-configure its MCP server and skills:');
      output.writeln(output.dim('  npm install @claude-flow/codex && ruflo init --codex'));
      return;
    }

    const initializer = new CodexInitializer();
    const result = await initializer.initialize({
      projectPath: ctx.cwd,
      template: (options.minimal ? 'minimal' : options.full ? 'full' : 'default') as 'minimal' | 'default' | 'full' | 'enterprise',
      force: options.force,
      dual: false, // Claude Code files were already written by the main init flow above
    });

    if (!result.success) return; // best-effort — never fail the primary init over this

    output.writeln();
    output.printBox(
      [
        `AGENTS.md:            Codex project instructions`,
        `.agents/config.toml:  MCP server + skills config`,
        `.agents/skills/:      ${result.skillsGenerated.length} skills`,
      ].join('\n'),
      'OpenAI Codex detected — configured'
    );
  } catch {
    // Codex auto-detect is a bonus, never a requirement — swallow everything.
  }
}

// Cross-agent skill registration. Materializes the *single* canonical ruflo
// platform skill at `.agents/skills/ruflo/SKILL.md` so any agent in the
// project (Claude Code, Cursor, Copilot, Gemini, Cline, …) that reads
// `.agents/skills/` picks it up. Users who want the full plugin skill catalog
// can run `npx skills add ruvnet/ruflo --all` themselves.
//
// #2777 — earlier versions shelled out to `npx --yes skills add ruvnet/ruflo
// --skill ruflo --yes`, but the skills CLI implements its `--skill` filter by
// cloning the entire target repo and copying `dirname(SKILL.md)` recursively.
// Because ruflo's canonical SKILL.md sits at the ruvnet/ruflo repo root, that
// dirname *is* the whole repository — the "one file" install pulled in ~97MB
// of Cargo.toml, crates/, docs/, agentdb.rvf, and 384 unrelated plugin
// SKILL.md descriptors. We now write the single ~2KB SKILL.md directly, no
// repo clone at all.
//
// Best-effort — never fails init. Opt-out: --no-skills-sh flag OR
// RUFLO_NO_SKILLS_SH=1. Skipped under --skip-claude and scripted
// `--format json` output.
const RUFLO_PLATFORM_SKILL_MD = `---
name: ruflo
description: Ruflo is a multi-agent orchestration platform for AI coding agents (Claude Code, Cursor, Codex, Copilot, Gemini, Amp, +12 more). Use this skill when the user wants to (1) install/init ruflo in a project, (2) run multi-agent swarms with hierarchical coordination, (3) use ruflo's 314+ MCP tools for memory, routing, hooks, sub-agents, or workflows, (4) check ruflo status/version/doctor health, or (5) discover which of ruflo's 30+ plugins fits their task.
---

# Ruflo

Ruflo is a cross-agent orchestration layer that ships as three npm packages: \`ruflo\` (thin wrapper), \`claude-flow\` (umbrella), and \`@claude-flow/cli\` (implementation). Users invoke it as \`npx ruflo <command>\`.

## When to invoke ruflo

Suggest ruflo when the task involves any of:

- **Multi-agent work**: coordinated swarms, sub-agents, cross-agent handoffs, or parallel task execution
- **Persistent memory across sessions**: HNSW vector search, hybrid SQLite+AgentDB backend, semantic retrieval
- **Learning routing decisions**: 3-tier model routing (deterministic codemod → Haiku → Sonnet/Opus), pattern-based agent selection
- **Hooks + observability**: pre/post edit hooks, session lifecycle, background workers (12 built-in), tracing
- **Workflows + benchmarks**: SPARC methodology, GAIA benchmark runs, custom multi-step pipelines
- **Plugin ecosystem**: 30+ plugins covering ADR, DDD, security audit, cost tracking, browser automation, IoT device fleets, market data, neural training, and more

Do NOT suggest ruflo for one-shot edits, simple bug fixes, or tasks a single agent can complete in one turn — the orchestration overhead isn't worth it.

## Getting started (three commands)

\`\`\`bash
# 1. Initialize ruflo in the current project (creates .claude/, MCP config, hooks)
npx ruflo init

# 2. Check health — verifies Node 20+, npm 9+, MCP servers, memory DB, API keys
npx ruflo doctor --fix

# 3. Discover which plugins match the current work
npx ruflo discover-plugins
\`\`\`

## MCP tools (314 available)

After \`ruflo init\`, Claude Code (or any MCP-compatible agent) auto-loads ruflo's MCP servers. Key namespaces:

- \`mcp__claude-flow__memory_*\` — store/search/list/retrieve with HNSW-indexed semantic search
- \`mcp__claude-flow__swarm_*\` — init hierarchical/mesh swarms with anti-drift topology
- \`mcp__claude-flow__agent_spawn\` — spawn specialized agents (coder, reviewer, tester, security-architect, +55 more)
- \`mcp__claude-flow__hooks_*\` — routing, pattern learning, background worker dispatch
- \`mcp__claude-flow__task_*\` — task lifecycle (create/assign/complete/summary)
- \`mcp__claude-flow__intelligence_*\` — 4-step pipeline (RETRIEVE → JUDGE → DISTILL → CONSOLIDATE)

Full catalog: \`npx ruflo mcp list\`.

## Plugin discovery

Ruflo ships 30+ optional plugins. Some highlights:

- \`ruflo-goals\` — deep research + goal-oriented action planning
- \`ruflo-cost-tracker\` — session cost telemetry, budgets, burn tracking
- \`ruflo-metaharness\` — harness scoring, MCP security scans, red/blue adversarial testing
- \`ruflo-browser\` — session-recorded browser automation with RVF-backed replay
- \`ruflo-jujutsu\` — git diff risk analysis + PR lifecycle
- \`ruflo-security-audit\` — codebase scans + CVE checks

Full plugin list + descriptions: \`npx ruflo plugins list\`.

## Cross-agent installation

Ruflo installs into whatever agent the project uses. To pull the full plugin
skill catalog (30+ plugins, ~267 skills), run:

\`\`\`bash
npx skills add ruvnet/ruflo --all
\`\`\`

## Documentation

- Repository: https://github.com/ruvnet/ruflo
- Issues: https://github.com/ruvnet/ruflo/issues
- Sponsor: https://github.com/sponsors/ruvnet
`;

// #2777 — detect the "bloated" install left behind by earlier versions that
// shelled out to `npx skills add`. If the .agents/skills/ruflo directory
// contains any of Cargo.toml, crates/, package.json, .git, or its recursive
// on-disk size exceeds a small budget (~1MB), it was almost certainly created
// by the full-repo clone bug — return true so the caller can wipe + rewrite
// just the single SKILL.md. Any recursive-stat or read errors are swallowed
// and reported as "not bloated" to avoid false-positive deletions.
function isBloatedRufloSkillDir(dir: string): boolean {
  try {
    const bloatMarkers = ['Cargo.toml', 'crates', 'package.json', '.git', 'agentdb.rvf', 'docs', 'plugins'];
    for (const marker of bloatMarkers) {
      if (fs.existsSync(path.join(dir, marker))) return true;
    }
    const BLOAT_BYTES_THRESHOLD = 1_048_576; // 1 MB — a canonical SKILL.md is ~2KB
    let bytes = 0;
    const walk = (p: string): void => {
      const entries = fs.readdirSync(p, { withFileTypes: true });
      for (const entry of entries) {
        const child = path.join(p, entry.name);
        if (entry.isDirectory()) {
          walk(child);
        } else if (entry.isFile()) {
          try {
            bytes += fs.statSync(child).size;
            if (bytes > BLOAT_BYTES_THRESHOLD) throw new Error('__bloat_threshold__');
          } catch (err) {
            if (err instanceof Error && err.message === '__bloat_threshold__') throw err;
            // Ignore stat errors for individual files.
          }
        }
        if (bytes > BLOAT_BYTES_THRESHOLD) return;
      }
    };
    try {
      walk(dir);
    } catch (err) {
      if (err instanceof Error && err.message === '__bloat_threshold__') return true;
      // Any other walk error → don't declare bloat.
    }
    return bytes > BLOAT_BYTES_THRESHOLD;
  } catch {
    return false;
  }
}

async function maybeInstallSkillsSh(ctx: CommandContext): Promise<void> {
  try {
    if (ctx.flags['no-skills-sh'] === true) return;
    if (ctx.flags.format === 'json') return;
    if (/^(1|true|on|yes)$/i.test(String(process.env.RUFLO_NO_SKILLS_SH || ''))) return;

    const skillDir = path.join(ctx.cwd, '.agents', 'skills', 'ruflo');
    const skillFile = path.join(skillDir, 'SKILL.md');

    // Idempotency gate. Three cases:
    //   1. Directory absent → materialize.
    //   2. Directory present but "bloated" (Cargo.toml/crates/ or >1MB) →
    //      previous `npx skills add` full-repo clone left junk behind
    //      (#2777). Wipe and re-materialize so `rm -rf .agents/skills/ruflo`
    //      + re-init is a valid recovery path.
    //   3. Directory present and healthy (just our SKILL.md) → skip.
    let mode: 'create' | 'rewrite' | 'skip' = 'create';
    if (fs.existsSync(skillDir)) {
      if (isBloatedRufloSkillDir(skillDir)) {
        mode = 'rewrite';
      } else {
        mode = 'skip';
      }
    }

    if (mode === 'skip') {
      output.writeln();
      output.writeln(output.dim('  skills.sh registration already present at .agents/skills/ruflo — skipping'));
      return;
    }

    output.writeln();
    if (mode === 'rewrite') {
      output.printInfo('Cleaning up bloated .agents/skills/ruflo/ from a prior init (#2777) and re-materializing the single platform SKILL.md…');
      try {
        fs.rmSync(skillDir, { recursive: true, force: true });
      } catch (err) {
        output.writeln(output.dim(`  Could not remove ${skillDir}: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
    } else {
      output.printInfo('Registering the core `ruflo` skill for cross-agent discovery (.agents/skills/ruflo/SKILL.md)…');
    }

    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(skillFile, RUFLO_PLATFORM_SKILL_MD, 'utf-8');
      output.writeln(output.success('  ✓ ruflo skill materialized at .agents/skills/ruflo/SKILL.md — available to any agent in this project'));
      output.writeln(output.dim('    Want all 267 plugin skills? npx skills add ruvnet/ruflo --all'));
      output.writeln(output.dim('    Opt out next time: --no-skills-sh or RUFLO_NO_SKILLS_SH=1'));
    } catch (err) {
      output.writeln(output.dim(`  skills.sh registration skipped (write failed: ${err instanceof Error ? err.message : String(err)})`));
    }
  } catch {
    // Skills.sh registration is a bonus, never a requirement — swallow everything.
  }
}

// Codex initialization action
async function initCodexAction(
  ctx: CommandContext,
  options: { codexMode: boolean; dualMode: boolean; force: boolean; minimal: boolean; full: boolean }
): Promise<CommandResult> {
  const { force, minimal, full, dualMode } = options;

  output.writeln();
  output.writeln(output.bold('Initializing RuFlo V3 for OpenAI Codex'));
  output.writeln();

  // Determine template
  const template = minimal ? 'minimal' : full ? 'full' : 'default';

  const spinner = output.createSpinner({ text: 'Initializing Codex project...' });
  spinner.start();

  try {
    const CodexInitializer = await resolveCodexInitializer(ctx.cwd);

    if (!CodexInitializer) {
      spinner.stop();
      output.printInfo('Fetching the stable Codex adapter for this initialization...');
      const success = runCodexInitializerCli(ctx.cwd, { template, force, dual: dualMode });
      if (!success) {
        output.printError('Codex initialization failed while running @claude-flow/codex@latest.');
        return { success: false, exitCode: 1 };
      }
      return { success: true, data: { adapter: '@claude-flow/codex@latest' } };
    }

    const initializer = new CodexInitializer();

    const result = await initializer.initialize({
      projectPath: ctx.cwd,
      template: template as 'minimal' | 'default' | 'full' | 'enterprise',
      force,
      dual: dualMode,
    });

    if (!result.success) {
      spinner.fail('Codex initialization failed');
      if (result.errors) {
        for (const error of result.errors) {
          output.printError(error);
        }
      }
      return { success: false, exitCode: 1 };
    }

    spinner.succeed('Codex project initialized successfully!');
    output.writeln();

    // Display summary
    const summary: string[] = [];
    summary.push(`Files: ${result.filesCreated.length} created`);
    summary.push(`Skills: ${result.skillsGenerated.length} installed`);

    output.printBox(summary.join('\n'), 'Summary');
    output.writeln();

    // Show what was created
    output.printBox(
      [
        `AGENTS.md:     Main project instructions`,
        `.agents/config.toml: Project configuration`,
        `.agents/skills/: ${result.skillsGenerated.length} skills`,
        `.codex/: Local overrides (gitignored)`,
        dualMode ? `CLAUDE.md: Claude Code compatibility` : '',
      ].filter(Boolean).join('\n'),
      'OpenAI Codex Integration'
    );
    output.writeln();

    // Warnings
    if (result.warnings && result.warnings.length > 0) {
      output.printWarning('Warnings:');
      for (const warning of result.warnings.slice(0, 5)) {
        output.printInfo(`  • ${warning}`);
      }
      if (result.warnings.length > 5) {
        output.printInfo(`  ... and ${result.warnings.length - 5} more`);
      }
      output.writeln();
    }

    // Next steps
    output.writeln(output.bold('Next steps:'));
    output.printList([
      `Review ${output.highlight('AGENTS.md')} for project instructions`,
      `Add skills with ${output.highlight('$skill-name')} syntax`,
      `Configure ${output.highlight('.agents/config.toml')} for your project`,
      dualMode ? `Claude Code users can use ${output.highlight('CLAUDE.md')}` : '',
    ].filter(Boolean));

    return { success: true, data: result };
  } catch (error) {
    spinner.fail('Codex initialization failed');
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Handle module not found error gracefully
    if (errorMessage.includes('Cannot find module') || errorMessage.includes('@claude-flow/codex')) {
      output.printError('The @claude-flow/codex package is not installed.');
      output.printInfo('Install it with: npm install @claude-flow/codex');
      output.writeln();
      output.printInfo('Alternatively, copy skills manually from .claude/skills/ to .agents/skills/');
    } else {
      output.printError(`Failed to initialize: ${errorMessage}`);
    }

    return { success: false, exitCode: 1 };
  }
}

// Check if project is already initialized with ruflo.
// #2207: .claude/settings.json alone is NOT a ruflo marker — it's created by
// Claude Code itself and exists in every Claude Code project. We require a
// ruflo-specific signal: either a claudeFlow section in settings.json, OR a
// .mcp.json with a 'claude-flow' or 'ruflo' server key, OR the ruflo-only
// .claude-flow/config.yaml. Using the bare file-existence check was causing
// false-positives for new users whose only existing file was Claude Code's own
// settings.json.
function isInitialized(cwd: string): { claude: boolean; claudeFlow: boolean } {
  const claudeFlowPath = path.join(cwd, '.claude-flow', 'config.yaml');
  const mcpJsonPath = path.join(cwd, '.mcp.json');
  const settingsPath = path.join(cwd, '.claude', 'settings.json');

  // Check .claude-flow/config.yaml — ruflo-specific, always reliable
  const hasClaudeFlow = fs.existsSync(claudeFlowPath);

  // Check .claude/settings.json for ruflo-specific content (claudeFlow section)
  let hasRufloSettings = false;
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      hasRufloSettings =
        parsed != null &&
        typeof parsed === 'object' &&
        'claudeFlow' in parsed;
    } catch { /* malformed — ignore */ }
  }

  // Check .mcp.json for ruflo/claude-flow server key
  let hasRufloMcp = false;
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
      hasRufloMcp =
        parsed != null &&
        typeof parsed === 'object' &&
        parsed.mcpServers != null &&
        typeof parsed.mcpServers === 'object' &&
        ('claude-flow' in (parsed.mcpServers as Record<string, unknown>) ||
         'ruflo' in (parsed.mcpServers as Record<string, unknown>));
    } catch { /* malformed — ignore */ }
  }

  return {
    claude: hasRufloSettings || hasRufloMcp,
    claudeFlow: hasClaudeFlow,
  };
}

// Init subcommand (default)
const initClaudeAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const force = ctx.flags.force as boolean;
  const minimal = ctx.flags.minimal as boolean;
  const full = ctx.flags.full as boolean;
  // #2952 — every long-flag write path in the parser goes through
  // normalizeKey() (parser.ts:399-402), which converts kebab-case to
  // camelCase before storing. `--skip-claude`/`--only-claude`/
  // `--all-agents`/`--cloud-mcp` land as `flags.skipClaude`/`flags.onlyClaude`/
  // `flags.allAgents`/`flags.cloudMcp` — there is no code path that ever
  // stores the literal kebab-case key. Reading `ctx.flags['skip-claude']`
  // etc. was always undefined, so all four flags were silent no-ops. Same
  // bug class as #2098A below, just never applied to these siblings.
  const skipClaude = ctx.flags.skipClaude as boolean;
  const onlyClaude = ctx.flags.onlyClaude as boolean;
  // #2098A — the parser handles `--no-foo` by stripping the prefix and
  // storing `flags.foo = false` (parser.ts:291-294), not by storing
  // `flags['no-foo'] = true`. So `--no-global` lands as
  // `ctx.flags.global === false`. The old read of `flags['no-global']`
  // was always undefined and silently no-op'd — every user with the flag
  // set still got `~/.claude/CLAUDE.md` modified. Read the real key.
  const noGlobal = ctx.flags['no-global'] === true || ctx.flags['global'] === false;
  const allAgents = ctx.flags.allAgents as boolean;
  const cloudMcp = ctx.flags.cloudMcp as boolean;
  const cwd = ctx.cwd;

  // Check if already initialized
  const initialized = isInitialized(cwd);
  const hasExisting = initialized.claude || initialized.claudeFlow;

  if (hasExisting && !force) {
    output.printWarning('RuFlo appears to be already initialized');
    if (initialized.claude) output.printInfo('  Found: .claude/settings.json');
    if (initialized.claudeFlow) output.printInfo('  Found: .claude-flow/config.yaml');
    output.printInfo('Use --force to reinitialize');

    if (ctx.interactive) {
      const proceed = await confirm({
        message: 'Do you want to reinitialize? This will overwrite existing configuration.',
        default: false,
      });

      if (!proceed) {
        return { success: true, message: 'Initialization cancelled' };
      }
    } else {
      return { success: false, exitCode: 1, message: 'Already initialized' };
    }
  }

  output.writeln();
  output.writeln(output.bold('Initializing RuFlo V3'));
  output.writeln();

  // Build init options based on flags
  let options: InitOptions;

  if (minimal) {
    options = { ...MINIMAL_INIT_OPTIONS, targetDir: cwd, force };
  } else if (full) {
    options = { ...FULL_INIT_OPTIONS, targetDir: cwd, force };
    // #2356: keep auth-gated cloud MCP servers opt-in even under --full. They
    // require a login, get committed into .mcp.json, and add per-session MCP
    // tool-definition token cost. --cloud-mcp restores the all-three behavior.
    if (!cloudMcp) {
      options.mcp = { ...options.mcp, ruvSwarm: false, flowNexus: false };
    }
  } else {
    options = { ...DEFAULT_INIT_OPTIONS, targetDir: cwd, force };
  }

  // Handle --skip-claude and --only-claude flags
  if (skipClaude) {
    options.components.settings = false;
    options.components.skills = false;
    options.components.commands = false;
    options.components.agents = false;
    options.components.helpers = false;
    options.components.statusline = false;
    options.components.mcp = false;
    options.components.claudeMd = false;
  }

  if (onlyClaude) {
    options.components.runtime = false;
  }

  // ADR-128 Phase 3 — restore full agent set (98 agents) when user explicitly
  // requests it. Default is the ~24-agent substrate (core, consensus, swarm,
  // sparc, testing). Pass --all-agents to get the old behavior.
  if (allAgents) {
    options.agents.all = true;
  }

  // #1744 — opt-out of the user-global ~/.claude/CLAUDE.md "Ruflo Integration"
  // pointer block. Default behavior (off) preserves current install for users
  // who rely on it; opting in via --no-global keeps the global file pristine.
  if (noGlobal) {
    options.skipGlobalClaudeMd = true;
  }

  // Create spinner
  const spinner = output.createSpinner({ text: 'Initializing...' });
  spinner.start();

  try {
    // Execute initialization
    const result = await executeInit(options);

    if (!result.success) {
      spinner.fail('Initialization failed');
      for (const error of result.errors) {
        output.printError(error);
      }
      return { success: false, exitCode: 1 };
    }

    spinner.succeed('RuFlo V3 initialized successfully!');
    output.writeln();

    // Display summary
    const summary: string[] = [];

    if (result.created.directories.length > 0) {
      summary.push(`Directories: ${result.created.directories.length} created`);
    }

    if (result.created.files.length > 0) {
      summary.push(`Files: ${result.created.files.length} created`);
    }

    if (result.skipped.length > 0) {
      summary.push(`Skipped: ${result.skipped.length} (already exist)`);
    }

    output.printBox(summary.join('\n'), 'Summary');
    output.writeln();

    // Security: surface anything settings-risk-scanner.ts flagged in a
    // pre-existing settings.json this init carried forward unexamined.
    if (result.warnings && result.warnings.length > 0) {
      output.printWarning('Settings review recommended:');
      for (const warning of result.warnings.slice(0, 5)) {
        output.printInfo(`  • ${warning}`);
      }
      if (result.warnings.length > 5) {
        output.printInfo(`  ... and ${result.warnings.length - 5} more`);
      }
      output.writeln();
    }

    // Show what was created
    if (options.components.claudeMd || options.components.settings || options.components.skills || options.components.commands || options.components.agents) {
      output.printBox(
        [
          options.components.claudeMd ? `CLAUDE.md:   Swarm guidance & configuration` : '',
          options.components.settings ? `Settings:    .claude/settings.json` : '',
          options.components.skills ? `Skills:      .claude/skills/ (${result.summary.skillsCount} skills)` : '',
          options.components.commands ? `Commands:    .claude/commands/ (${result.summary.commandsCount} commands)` : '',
          options.components.agents ? `Agents:      .claude/agents/ (${result.summary.agentsCount} agents)` : '',
          options.components.helpers ? `Helpers:     .claude/helpers/` : '',
          options.components.mcp ? `MCP:         .mcp.json` : '',
        ].filter(Boolean).join('\n'),
        'Claude Code Integration'
      );
      output.writeln();
    }

    if (options.components.runtime) {
      output.printBox(
        [
          `Config:      .claude-flow/config.yaml`,
          `Data:        .claude-flow/data/`,
          `Logs:        .claude-flow/logs/`,
          `Sessions:    .claude-flow/sessions/`,
        ].join('\n'),
        'V3 Runtime'
      );
      output.writeln();
    }

    // Hooks summary
    if (result.summary.hooksEnabled > 0) {
      output.printInfo(`Hooks: ${result.summary.hooksEnabled} hook types enabled in settings.json`);
      output.writeln();
    }

    // #2666-adjacent — auto-detect + configure OpenAI Codex CLI if present
    if (!skipClaude) {
      await maybeAutoDetectCodex(ctx, { force, minimal, full });
      await maybeInstallSkillsSh(ctx);
    }

    // Handle --start-all or --start-daemon
    const startAll = ctx.flags['start-all'] || ctx.flags.startAll;
    const startDaemon = ctx.flags['start-daemon'] || ctx.flags.startDaemon || startAll;

    if (startDaemon || startAll) {
      output.writeln();
      output.printInfo('Starting services...');

      const { execSync } = await import('child_process');

      // Initialize memory database
      if (startAll) {
        try {
          output.writeln(output.dim('  Initializing memory database...'));
          execSync('npx @claude-flow/cli@latest memory init 2>/dev/null', {
            stdio: 'pipe',
            cwd: ctx.cwd,
            timeout: 30000
          });
          output.writeln(output.success('  ✓ Memory initialized'));
        } catch {
          output.writeln(output.dim('  Memory database already exists'));
        }
      }

      // Start daemon — #2407 fix
      //
      // The previous version used `daemon start ... &` (shell background)
      // which made execSync return as soon as the shell forked, BEFORE the
      // daemon process wrote its PID file. Concurrent init runs
      // (devcontainer setup + VS Code task + MCP hook firing within ~500 ms)
      // all saw an empty PID file via getBackgroundDaemonPid(), so
      // daemon.ts:99-103's dedup short-circuit didn't fire — every caller
      // spawned its own daemon. One incident accumulated 39 zombie daemons
      // holding ~8.5 GiB resident, which together with macOS compressor
      // pressure (27 GiB compressed) caused the configd watchdog timeout
      // and the 2026-06-15 21:06 kernel panic.
      //
      // Fix: drop the shell `&`. `daemon start` (default non-foreground
      // mode) already forks its own detached background process via
      // startBackgroundDaemon() AND writes the PID file BEFORE returning,
      // so execSync without `&` waits for the dedup-relevant PID-file
      // write but does NOT wait for the daemon itself to exit. Timeout
      // bumped to 30s for npx cold-cache scenarios.
      if (startDaemon) {
        try {
          output.writeln(output.dim('  Starting daemon...'));
          execSync('npx @claude-flow/cli@latest daemon start 2>/dev/null', {
            stdio: 'pipe',
            cwd: ctx.cwd,
            timeout: 30000
          });
          output.writeln(output.success('  ✓ Daemon started'));
        } catch {
          // Daemon dedup hit (already running) OR spawn timed out.
          // Either way the worst case is a single retry on next init,
          // not a forked race producing N zombies.
          output.writeln(output.warning('  Daemon may already be running'));
        }
      }

      // Initialize swarm
      if (startAll) {
        try {
          output.writeln(output.dim('  Initializing swarm...'));
          execSync('npx @claude-flow/cli@latest swarm init --topology hierarchical 2>/dev/null', {
            stdio: 'pipe',
            cwd: ctx.cwd,
            timeout: 30000
          });
          output.writeln(output.success('  ✓ Swarm initialized'));
        } catch {
          output.writeln(output.dim('  Swarm initialization skipped'));
        }
      }

      output.writeln();
      output.printSuccess('All services started');
    }

    // Handle --with-embeddings
    const withEmbeddings = ctx.flags['with-embeddings'] || ctx.flags.withEmbeddings;
    const embeddingModel = (ctx.flags['embedding-model'] || ctx.flags.embeddingModel || 'Xenova/all-MiniLM-L6-v2') as string;

    if (withEmbeddings) {
      output.writeln();
      output.printInfo('Initializing ONNX embedding subsystem...');

      const { execFileSync: execFileInit } = await import('child_process');

      // Validate embeddingModel: must match pattern org/model-name (CRIT-02)
      if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/.test(embeddingModel)) {
        throw new Error(`Invalid embedding model name: ${embeddingModel}`);
      }

      try {
        output.writeln(output.dim(`  Model: ${embeddingModel}`));
        output.writeln(output.dim('  Hyperbolic: Enabled (Poincaré ball)'));
        // #2770: On Windows, `npx` ships as `npx.cmd`; execFileSync cannot spawn
        // a .cmd file without going through cmd.exe. Enable shell on win32 so
        // cmd.exe resolves the .cmd extension. POSIX keeps shell:false.
        // NOTE: shell:true joins args by spaces and passes to cmd.exe — the args
        // here are hard-coded flags + an npm package name pre-validated against
        // /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/, so no injection risk. If
        // user-controlled args are ever added, escape them before spawn.
        execFileInit('npx', [
          '@claude-flow/cli@latest', 'embeddings', 'init',
          '--model', embeddingModel,
          '--no-download', '--force',
        ], {
          stdio: 'pipe',
          cwd: ctx.cwd,
          timeout: 30000,
          shell: process.platform === 'win32',
          windowsHide: true,
        });
        output.writeln(output.success('  ✓ Embeddings initialized'));
        output.writeln(output.dim('    Run "embeddings init --download" to download model'));
      } catch (err) {
        output.writeln(output.warning('  Embedding initialization skipped (run manually)'));
      }
    }

    if (!startDaemon && !startAll) {
      const bin = (process.argv[1] || '').includes('ruflo') ? 'ruflo' : 'claude-flow';
      output.writeln(output.bold('Next steps:'));
      output.printList([
        `Run ${output.highlight(`${bin} daemon start`)} to start background workers`,
        // Memory is initialized automatically during init (persistent by
        // default — see executor.ts) — no separate `memory init` step needed
        // unless the DB was skipped (MINIMAL_INIT_OPTIONS) or needs --force.
        `Run ${output.highlight(`${bin} swarm init`)} to initialize a swarm`,
        `Or use ${output.highlight(`${bin} init --start-all`)} to do all of the above`,
        options.components.settings ? `Review ${output.highlight('.claude/settings.json')} for hook configurations` : '',
        // ADR-150 — surface the new metaharness scorecard to every new user.
        // Optional dep; the command degrades gracefully when not installed.
        `Run ${output.highlight(`${bin} metaharness score`)} for a 5-dim harness readiness scorecard (ADR-150)`,
      ].filter(Boolean));
    }

    if (ctx.flags.format === 'json') {
      output.printJson(result);
    }

    await offerCapabilityEnrollment(ctx);

    return { success: true, data: result };
  } catch (error) {
    spinner.fail('Initialization failed');
    output.printError(`Failed to initialize: ${error instanceof Error ? error.message : String(error)}`);
    return { success: false, exitCode: 1 };
  }
};

/**
 * Route platform initialization. Dual mode deliberately runs both native
 * initializers: Claude Code first, then Codex without its compatibility
 * CLAUDE.md stub so the full native Claude scaffold remains authoritative.
 */
const initAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const force = ctx.flags.force as boolean;
  const minimal = ctx.flags.minimal as boolean;
  const full = ctx.flags.full as boolean;
  const codexMode = ctx.flags.codex as boolean;
  const dualMode = ctx.flags.dual as boolean;

  if (codexMode && !dualMode) {
    return initCodexAction(ctx, { codexMode, dualMode: false, force, minimal, full });
  }
  if (!dualMode) {
    return initClaudeAction(ctx);
  }

  const claudeContext: CommandContext = {
    ...ctx,
    flags: {
      ...ctx.flags,
      codex: false,
      dual: false,
      // The explicit Codex pass below owns Codex setup.
      'no-codex-detect': true,
    },
  };
  const claudeResult = await initClaudeAction(claudeContext);
  if (!claudeResult.success) return claudeResult;

  const codexResult = await initCodexAction(ctx, {
    codexMode: true,
    // Preserve the full CLAUDE.md and .claude/ scaffold just generated.
    dualMode: false,
    force,
    minimal,
    full,
  });
  if (!codexResult.success) {
    return {
      ...codexResult,
      message: 'Claude Code initialized, but Codex initialization failed',
      data: { claude: claudeResult.data, codex: codexResult.data },
    };
  }

  return {
    success: true,
    data: { claude: claudeResult.data, codex: codexResult.data },
  };
};

// Wizard subcommand for interactive setup
const wizardCommand: Command = {
  name: 'wizard',
  description: 'Interactive setup wizard for comprehensive configuration',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('RuFlo V3 Setup Wizard'));
    output.writeln(output.dim('Answer questions to configure your project'));
    output.writeln();

    try {
      // Start with base options
      const options: InitOptions = { ...DEFAULT_INIT_OPTIONS, targetDir: ctx.cwd };

      // Configuration preset
      const preset = await select({
        message: 'Select configuration preset:',
        options: [
          { value: 'default', label: 'Default', hint: 'Recommended settings for most projects' },
          { value: 'minimal', label: 'Minimal', hint: 'Core features only' },
          { value: 'full', label: 'Full', hint: 'All features enabled' },
          { value: 'custom', label: 'Custom', hint: 'Choose each component' },
        ],
      });

      if (preset === 'minimal') {
        Object.assign(options, MINIMAL_INIT_OPTIONS);
        options.targetDir = ctx.cwd;
      } else if (preset === 'full') {
        Object.assign(options, FULL_INIT_OPTIONS);
        options.targetDir = ctx.cwd;
      } else if (preset === 'custom') {
        // Component selection
        const components = await multiSelect({
          message: 'Select components to initialize:',
          options: [
            { value: 'claudeMd', label: 'CLAUDE.md', hint: 'Swarm guidance and project configuration', selected: true },
            { value: 'settings', label: 'settings.json', hint: 'Claude Code hooks configuration', selected: true },
            { value: 'skills', label: 'Skills', hint: 'Claude Code skills in .claude/skills/', selected: true },
            { value: 'commands', label: 'Commands', hint: 'Claude Code commands in .claude/commands/', selected: true },
            { value: 'agents', label: 'Agents', hint: 'Agent definitions in .claude/agents/', selected: true },
            { value: 'helpers', label: 'Helpers', hint: 'Utility scripts in .claude/helpers/', selected: true },
            { value: 'statusline', label: 'Statusline', hint: 'Shell statusline integration', selected: false },
            { value: 'mcp', label: 'MCP', hint: '.mcp.json for MCP server configuration', selected: true },
            { value: 'runtime', label: 'Runtime', hint: '.claude-flow/ directory for V3 runtime', selected: true },
          ],
        });

        options.components.claudeMd = components.includes('claudeMd');
        options.components.settings = components.includes('settings');
        options.components.skills = components.includes('skills');
        options.components.commands = components.includes('commands');
        options.components.agents = components.includes('agents');
        options.components.helpers = components.includes('helpers');
        options.components.statusline = components.includes('statusline');
        options.components.mcp = components.includes('mcp');
        options.components.runtime = components.includes('runtime');

        // Skills selection
        if (options.components.skills) {
          const skillSets = await multiSelect({
            message: 'Select skill sets:',
            options: [
              { value: 'core', label: 'Core', hint: 'Swarm, memory, SPARC skills', selected: true },
              { value: 'agentdb', label: 'AgentDB', hint: 'Vector database skills', selected: true },
              { value: 'github', label: 'GitHub', hint: 'GitHub integration skills', selected: true },
              { value: 'flowNexus', label: 'Flow Nexus', hint: 'Cloud platform skills', selected: false },
              { value: 'v3', label: 'V3', hint: 'V3 implementation skills', selected: true },
            ],
          });

          options.skills.core = skillSets.includes('core');
          options.skills.agentdb = skillSets.includes('agentdb');
          options.skills.github = skillSets.includes('github');
          options.skills.flowNexus = skillSets.includes('flowNexus');
          options.skills.v3 = skillSets.includes('v3');
        }

        // Hooks selection
        if (options.components.settings) {
          const hooks = await multiSelect({
            message: 'Select hooks to enable:',
            options: [
              { value: 'preToolUse', label: 'PreToolUse', hint: 'Before tool execution', selected: true },
              { value: 'postToolUse', label: 'PostToolUse', hint: 'After tool execution', selected: true },
              { value: 'userPromptSubmit', label: 'UserPromptSubmit', hint: 'Task routing', selected: true },
              { value: 'sessionStart', label: 'SessionStart', hint: 'Session initialization', selected: true },
              { value: 'stop', label: 'Stop', hint: 'Task completion evaluation', selected: true },
              { value: 'notification', label: 'Notification', hint: 'Swarm notifications', selected: true },
              { value: 'permissionRequest', label: 'PermissionRequest', hint: 'Auto-allow claude-flow tools', selected: true },
            ],
          });

          options.hooks.preToolUse = hooks.includes('preToolUse');
          options.hooks.postToolUse = hooks.includes('postToolUse');
          options.hooks.userPromptSubmit = hooks.includes('userPromptSubmit');
          options.hooks.sessionStart = hooks.includes('sessionStart');
          options.hooks.stop = hooks.includes('stop');
          options.hooks.notification = hooks.includes('notification');
        }
      }

      // Swarm topology (for all presets)
      const topology = await select({
        message: 'Select swarm topology:',
        options: [
          { value: 'hierarchical-mesh', label: 'Hierarchical Mesh', hint: 'Best for complex projects (recommended)' },
          { value: 'mesh', label: 'Mesh', hint: 'Peer-to-peer coordination' },
          { value: 'hierarchical', label: 'Hierarchical', hint: 'Tree-based coordination' },
          { value: 'adaptive', label: 'Adaptive', hint: 'Dynamic topology switching' },
        ],
      });
      options.runtime.topology = topology as InitOptions['runtime']['topology'];

      // Max agents
      const maxAgents = await input({
        message: 'Maximum concurrent agents:',
        default: String(options.runtime.maxAgents),
        validate: (v) => {
          const n = parseInt(v);
          return (!isNaN(n) && n > 0 && n <= 50) || 'Enter a number between 1 and 50';
        },
      });
      options.runtime.maxAgents = parseInt(maxAgents);

      // Memory backend
      const memoryBackend = await select({
        message: 'Select memory backend:',
        options: [
          { value: 'hybrid', label: 'Hybrid', hint: 'SQLite + AgentDB (recommended)' },
          { value: 'agentdb', label: 'AgentDB', hint: '150x faster vector search' },
          { value: 'sqlite', label: 'SQLite', hint: 'Standard SQL storage' },
          { value: 'memory', label: 'In-Memory', hint: 'Fast but non-persistent' },
        ],
      });
      options.runtime.memoryBackend = memoryBackend as InitOptions['runtime']['memoryBackend'];

      // HNSW indexing
      if (memoryBackend === 'agentdb' || memoryBackend === 'hybrid') {
        const enableHNSW = await confirm({
          message: 'Enable HNSW indexing for faster vector search?',
          default: true,
        });
        options.runtime.enableHNSW = enableHNSW;
      }

      // Neural learning
      const enableNeural = await confirm({
        message: 'Enable neural pattern learning?',
        default: options.runtime.enableNeural,
      });
      options.runtime.enableNeural = enableNeural;

      // ADR-049: Self-Learning Memory capabilities
      if (memoryBackend === 'agentdb' || memoryBackend === 'hybrid') {
        const enableSelfLearning = await confirm({
          message: 'Enable self-learning memory? (LearningBridge + Knowledge Graph + Agent Scopes)',
          default: true,
        });
        options.runtime.enableLearningBridge = enableSelfLearning && enableNeural;
        options.runtime.enableMemoryGraph = enableSelfLearning;
        options.runtime.enableAgentScopes = enableSelfLearning;
      } else {
        options.runtime.enableLearningBridge = false;
        options.runtime.enableMemoryGraph = false;
        options.runtime.enableAgentScopes = false;
      }

      // Embeddings configuration
      const enableEmbeddings = await confirm({
        message: 'Enable ONNX embedding system with hyperbolic support?',
        default: true,
      });

      let embeddingModel = 'Xenova/all-MiniLM-L6-v2';
      if (enableEmbeddings) {
        embeddingModel = await select({
          message: 'Select embedding model:',
          options: [
            { value: 'Xenova/all-MiniLM-L6-v2', label: 'MiniLM L6 (384d)', hint: 'Fast, good quality (recommended)' },
            { value: 'Xenova/all-mpnet-base-v2', label: 'MPNet Base (768d)', hint: 'Higher quality, more memory' },
          ],
        });
      }

      // Execute initialization
      output.writeln();
      const spinner = output.createSpinner({ text: 'Initializing...' });
      spinner.start();

      const result = await executeInit(options);

      if (!result.success) {
        spinner.fail('Initialization failed');
        for (const error of result.errors) {
          output.printError(error);
        }
        return { success: false, exitCode: 1 };
      }

      spinner.succeed('Setup complete!');

      // Security: surface anything settings-risk-scanner.ts flagged in a
      // pre-existing settings.json this wizard run carried forward unexamined.
      if (result.warnings && result.warnings.length > 0) {
        output.writeln();
        output.printWarning('Settings review recommended:');
        for (const warning of result.warnings.slice(0, 5)) {
          output.printInfo(`  • ${warning}`);
        }
        if (result.warnings.length > 5) {
          output.printInfo(`  ... and ${result.warnings.length - 5} more`);
        }
      }

      // Initialize embeddings if enabled
      let embeddingsInitialized = false;
      if (enableEmbeddings) {
        output.writeln();
        output.printInfo('Initializing ONNX embedding subsystem...');
        const { execFileSync } = await import('child_process');

        // Validate embeddingModel: must match pattern org/model-name (CRIT-02)
        if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/.test(embeddingModel)) {
          throw new Error(`Invalid embedding model name: ${embeddingModel}`);
        }

        try {
          // #2770: On Windows, `npx` ships as `npx.cmd`; execFileSync cannot spawn
          // a .cmd file without going through cmd.exe. Enable shell on win32 so
          // cmd.exe resolves the .cmd extension. POSIX keeps shell:false.
          // NOTE: shell:true joins args by spaces and passes to cmd.exe — the args
          // here are hard-coded flags + an npm package name pre-validated against
          // /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/, so no injection risk. If
          // user-controlled args are ever added, escape them before spawn.
          execFileSync('npx', [
            '@claude-flow/cli@latest', 'embeddings', 'init',
            '--model', embeddingModel,
            '--no-download', '--force',
          ], {
            stdio: 'pipe',
            cwd: ctx.cwd,
            timeout: 30000,
            shell: process.platform === 'win32',
            windowsHide: true,
          });
          output.writeln(output.success('  ✓ Embeddings configured'));
          embeddingsInitialized = true;
        } catch {
          output.writeln(output.dim('  Embeddings will be configured on first use'));
        }
      }

      output.writeln();

      // Summary table
      output.printTable({
        columns: [
          { key: 'setting', header: 'Setting', width: 20 },
          { key: 'value', header: 'Value', width: 40 },
        ],
        data: [
          { setting: 'Preset', value: preset },
          { setting: 'Topology', value: options.runtime.topology },
          { setting: 'Max Agents', value: String(options.runtime.maxAgents) },
          { setting: 'Memory Backend', value: options.runtime.memoryBackend },
          { setting: 'HNSW Indexing', value: options.runtime.enableHNSW ? 'Enabled' : 'Disabled' },
          { setting: 'Neural Learning', value: options.runtime.enableNeural ? 'Enabled' : 'Disabled' },
          { setting: 'Self-Learning', value: options.runtime.enableLearningBridge ? 'LearningBridge + Graph + Scopes' : 'Disabled' },
          { setting: 'Embeddings', value: enableEmbeddings ? `${embeddingModel} (hyperbolic)` : 'Disabled' },
          { setting: 'Skills', value: `${result.summary.skillsCount} installed` },
          { setting: 'Commands', value: `${result.summary.commandsCount} installed` },
          { setting: 'Agents', value: `${result.summary.agentsCount} installed` },
          { setting: 'Hooks', value: `${result.summary.hooksEnabled} enabled` },
        ],
      });

      await offerCapabilityEnrollment(ctx);

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof Error && error.message === 'User cancelled') {
        output.printInfo('Setup cancelled');
        return { success: true };
      }
      throw error;
    }
  },
};

// Check subcommand
const checkCommand: Command = {
  name: 'check',
  description: 'Check if RuFlo is initialized',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const initialized = isInitialized(ctx.cwd);

    const result = {
      initialized: initialized.claude || initialized.claudeFlow,
      claude: initialized.claude,
      claudeFlow: initialized.claudeFlow,
      paths: {
        claudeSettings: initialized.claude ? path.join(ctx.cwd, '.claude', 'settings.json') : null,
        claudeFlowConfig: initialized.claudeFlow ? path.join(ctx.cwd, '.claude-flow', 'config.yaml') : null,
      },
    };

    if (ctx.flags.format === 'json') {
      output.printJson(result);
      return { success: true, data: result };
    }

    if (result.initialized) {
      output.printSuccess('RuFlo is initialized');
      if (initialized.claude) {
        output.printInfo(`  Claude Code: .claude/settings.json`);
      }
      if (initialized.claudeFlow) {
        output.printInfo(`  V3 Runtime: .claude-flow/config.yaml`);
      }
    } else {
      output.printWarning('RuFlo is not initialized in this directory');
      output.printInfo('Run "ruflo init" to initialize');
    }

    return { success: true, data: result };
  },
};

// Skills subcommand
const skillsCommand: Command = {
  name: 'skills',
  description: 'Initialize only skills',
  options: [
    { name: 'all', description: 'Install all skills', type: 'boolean', default: false },
    { name: 'core', description: 'Install core skills', type: 'boolean', default: true },
    { name: 'agentdb', description: 'Install AgentDB skills', type: 'boolean', default: false },
    { name: 'github', description: 'Install GitHub skills', type: 'boolean', default: false },
    { name: 'v3', description: 'Install V3 skills', type: 'boolean', default: false },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const options: InitOptions = {
      ...MINIMAL_INIT_OPTIONS,
      targetDir: ctx.cwd,
      force: ctx.flags.force as boolean,
      components: {
        settings: false,
        skills: true,
        commands: false,
        agents: false,
        helpers: false,
        statusline: false,
        mcp: false,
        runtime: false,
        claudeMd: false,
      },
      skills: {
        all: ctx.flags.all as boolean,
        core: ctx.flags.core as boolean,
        agentdb: ctx.flags.agentdb as boolean,
        github: ctx.flags.github as boolean,
        flowNexus: false,
        browser: false,
        v3: ctx.flags.v3 as boolean,
        dualMode: false,
      },
    };

    const spinner = output.createSpinner({ text: 'Installing skills...' });
    spinner.start();

    const result = await executeInit(options);

    if (result.success) {
      spinner.succeed(`Installed ${result.summary.skillsCount} skills`);
      if (result.warnings && result.warnings.length > 0) {
        output.printWarning('Settings review recommended:');
        for (const warning of result.warnings.slice(0, 5)) {
          output.printInfo(`  • ${warning}`);
        }
        if (result.warnings.length > 5) {
          output.printInfo(`  ... and ${result.warnings.length - 5} more`);
        }
      }
    } else {
      spinner.fail('Failed to install skills');
      for (const error of result.errors) {
        output.printError(error);
      }
    }

    return { success: result.success, data: result };
  },
};

// Hooks subcommand
const hooksCommand: Command = {
  name: 'hooks',
  description: 'Initialize only hooks configuration',
  options: [
    { name: 'all', description: 'Enable all hooks', type: 'boolean', default: true },
    { name: 'minimal', description: 'Enable only essential hooks', type: 'boolean', default: false },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const minimal = ctx.flags.minimal as boolean;

    const options: InitOptions = {
      ...DEFAULT_INIT_OPTIONS,
      targetDir: ctx.cwd,
      force: ctx.flags.force as boolean,
      components: {
        settings: true,
        skills: false,
        commands: false,
        agents: false,
        // #2350: helpers MUST ship with the hooks subcommand. The hook entries
        // in settings.json point at `.claude/helpers/hook-handler.cjs`; if
        // that file doesn't exist, settings-generator (#1744 fix) drops the
        // hooks block entirely — so the one subcommand whose stated purpose
        // is "Initialize only hooks configuration" produced settings.json
        // with no `hooks` key while reporting "N hooks enabled".
        helpers: true,
        statusline: false,
        mcp: false,
        runtime: false,
        claudeMd: false,
      },
      hooks: minimal
        ? {
            preToolUse: true,
            postToolUse: true,
            userPromptSubmit: false,
            sessionStart: false,
            stop: false,
            preCompact: false,
            notification: false,
            teammateIdle: false,
            taskCompleted: false,
            timeout: 10000,
            continueOnError: true,
          }
        : DEFAULT_INIT_OPTIONS.hooks,
    };

    const spinner = output.createSpinner({ text: 'Creating hooks configuration...' });
    spinner.start();

    const result = await executeInit(options);

    if (result.success) {
      spinner.succeed(`Created settings.json with ${result.summary.hooksEnabled} hooks enabled`);
      if (result.warnings && result.warnings.length > 0) {
        output.printWarning('Settings review recommended:');
        for (const warning of result.warnings.slice(0, 5)) {
          output.printInfo(`  • ${warning}`);
        }
        if (result.warnings.length > 5) {
          output.printInfo(`  ... and ${result.warnings.length - 5} more`);
        }
      }
    } else {
      spinner.fail('Failed to create hooks configuration');
      for (const error of result.errors) {
        output.printError(error);
      }
    }

    return { success: result.success, data: result };
  },
};

// Upgrade subcommand - updates helpers without losing user data
const upgradeCommand: Command = {
  name: 'upgrade',
  description: 'Update statusline and helpers while preserving existing data',
  options: [
    {
      name: 'verbose',
      short: 'v',
      description: 'Show detailed output',
      type: 'boolean',
      default: false,
    },
    {
      name: 'add-missing',
      short: 'a',
      description: 'Add any new skills, agents, and commands that are missing',
      type: 'boolean',
      default: false,
    },
    {
      name: 'settings',
      short: 's',
      description: 'Merge new settings (Agent Teams, hooks) into existing settings.json',
      type: 'boolean',
      default: false,
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const addMissing = (ctx.flags['add-missing'] || ctx.flags.addMissing) as boolean;
    const upgradeSettings = (ctx.flags.settings) as boolean;

    output.writeln();
    output.writeln(output.bold('Upgrading RuFlo'));
    if (addMissing && upgradeSettings) {
      output.writeln(output.dim('Updates helpers, settings, and adds any missing skills/agents/commands'));
    } else if (addMissing) {
      output.writeln(output.dim('Updates helpers and adds any missing skills/agents/commands'));
    } else if (upgradeSettings) {
      output.writeln(output.dim('Updates helpers and merges new settings (Agent Teams, hooks)'));
    } else {
      output.writeln(output.dim('Updates helpers while preserving your existing data'));
    }
    output.writeln();

    const spinnerText = upgradeSettings
      ? 'Upgrading helpers and settings...'
      : (addMissing ? 'Upgrading and adding missing assets...' : 'Upgrading...');
    const spinner = output.createSpinner({ text: spinnerText });
    spinner.start();

    try {
      const result = addMissing
        ? await executeUpgradeWithMissing(ctx.cwd, upgradeSettings)
        : await executeUpgrade(ctx.cwd, upgradeSettings);

      if (!result.success) {
        spinner.fail('Upgrade failed');
        for (const error of result.errors) {
          output.printError(error);
        }
        return { success: false, exitCode: 1 };
      }

      spinner.succeed('Upgrade complete!');
      output.writeln();

      // Show what was updated
      if (result.updated.length > 0) {
        output.printBox(
          result.updated.map(f => `✓ ${f}`).join('\n'),
          'Updated (latest version)'
        );
        output.writeln();
      }

      // Show what was created
      if (result.created.length > 0) {
        output.printBox(
          result.created.map(f => `+ ${f}`).join('\n'),
          'Created (new files)'
        );
        output.writeln();
      }

      // Show what was preserved
      if (result.preserved.length > 0 && ctx.flags.verbose) {
        output.printBox(
          result.preserved.map(f => `• ${f}`).join('\n'),
          'Preserved (existing data kept)'
        );
        output.writeln();
      } else if (result.preserved.length > 0) {
        output.printInfo(`Preserved ${result.preserved.length} existing data files`);
        output.writeln();
      }

      // Show added assets (when --add-missing flag is used)
      if (result.addedSkills && result.addedSkills.length > 0) {
        output.printBox(
          result.addedSkills.map(s => `+ ${s}`).join('\n'),
          `Added Skills (${result.addedSkills.length} new)`
        );
        output.writeln();
      }

      if (result.addedAgents && result.addedAgents.length > 0) {
        output.printBox(
          result.addedAgents.map(a => `+ ${a}`).join('\n'),
          `Added Agents (${result.addedAgents.length} new)`
        );
        output.writeln();
      }

      if (result.addedCommands && result.addedCommands.length > 0) {
        output.printBox(
          result.addedCommands.map(c => `+ ${c}`).join('\n'),
          `Added Commands (${result.addedCommands.length} new)`
        );
        output.writeln();
      }

      // Show settings updates
      if (result.settingsUpdated && result.settingsUpdated.length > 0) {
        output.printBox(
          result.settingsUpdated.map(s => `+ ${s}`).join('\n'),
          'Settings Updated'
        );
        output.writeln();
      }

      // Security: surface anything settings-risk-scanner.ts flagged in the
      // pre-existing settings.json this upgrade carried forward unexamined.
      if (result.warnings && result.warnings.length > 0) {
        output.printWarning('Settings review recommended:');
        for (const warning of result.warnings.slice(0, 5)) {
          output.printInfo(`  • ${warning}`);
        }
        if (result.warnings.length > 5) {
          output.printInfo(`  ... and ${result.warnings.length - 5} more`);
        }
        output.writeln();
      }

      output.printSuccess('Your statusline helper has been updated to the latest version');
      output.printInfo('Existing metrics and learning data were preserved');

      // Show settings summary
      if (upgradeSettings && result.settingsUpdated && result.settingsUpdated.length > 0) {
        output.printSuccess('Settings.json updated with new Agent Teams configuration');
      }

      // Show summary for --add-missing
      if (addMissing) {
        const totalAdded = (result.addedSkills?.length || 0) + (result.addedAgents?.length || 0) + (result.addedCommands?.length || 0);
        if (totalAdded > 0) {
          output.printSuccess(`Added ${totalAdded} missing assets to your project`);
        } else {
          output.printInfo('All skills, agents, and commands are already up to date');
        }
      }

      if (ctx.flags.format === 'json') {
        output.printJson(result);
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Upgrade failed');
      output.printError(`Failed to upgrade: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  },
};

// Main init command
export const initCommand: Command = {
  name: 'init',
  description: 'Initialize RuFlo in the current directory',
  subcommands: [wizardCommand, checkCommand, skillsCommand, hooksCommand, upgradeCommand],
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Overwrite existing configuration',
      type: 'boolean',
      default: false,
    },
    {
      name: 'minimal',
      short: 'm',
      description: 'Create minimal configuration',
      type: 'boolean',
      default: false,
    },
    {
      name: 'full',
      description: 'Create full configuration with all components',
      type: 'boolean',
      default: false,
    },
    {
      // #2356: under --full, the auth-gated cloud MCP servers (ruv-swarm,
      // flow-nexus) get written into a committed .mcp.json and add MCP
      // tool-definition token cost every session. Keep them opt-in even with
      // --full; pass --cloud-mcp to register them.
      name: 'cloud-mcp',
      description: 'Register auth-gated cloud MCP servers (ruv-swarm, flow-nexus) in .mcp.json (only relevant with --full)',
      type: 'boolean',
      default: false,
    },
    {
      name: 'skip-claude',
      description: 'Skip .claude/ directory creation (runtime only)',
      type: 'boolean',
      default: false,
    },
    {
      // ADR-302 — skip the one-time post-init capability enrollment prompt.
      name: 'no-signup',
      description: 'Skip the post-init Cognitum capability enrollment prompt',
      type: 'boolean',
      default: false,
    },
    {
      name: 'only-claude',
      description: 'Only create .claude/ directory (skip runtime)',
      type: 'boolean',
      default: false,
    },
    {
      name: 'no-global',
      description: 'Skip the ~/.claude/CLAUDE.md "Ruflo Integration" pointer block (#1744)',
      type: 'boolean',
      default: false,
    },
    {
      name: 'start-all',
      description: 'Auto-start daemon, memory, and swarm after init',
      type: 'boolean',
      default: false,
    },
    {
      name: 'start-daemon',
      description: 'Auto-start daemon after init',
      type: 'boolean',
      default: false,
    },
    {
      name: 'with-embeddings',
      description: 'Initialize ONNX embedding subsystem with hyperbolic support',
      type: 'boolean',
      default: false,
    },
    {
      name: 'embedding-model',
      description: 'ONNX embedding model to use',
      type: 'string',
      default: 'Xenova/all-MiniLM-L6-v2',
      choices: ['Xenova/all-MiniLM-L6-v2', 'Xenova/all-mpnet-base-v2'],
    },
    {
      name: 'codex',
      description: 'Initialize for OpenAI Codex CLI (creates AGENTS.md, .agents/)',
      type: 'boolean',
      default: false,
    },
    {
      name: 'dual',
      description: 'Initialize for both Claude Code and OpenAI Codex',
      type: 'boolean',
      default: false,
    },
    {
      name: 'no-codex-detect',
      description: 'Skip auto-detecting the OpenAI Codex CLI and configuring its MCP server + skills',
      type: 'boolean',
      default: false,
    },
    {
      name: 'no-skills-sh',
      description: 'Skip the post-init `npx skills add ruvnet/ruflo` registration (also honored via RUFLO_NO_SKILLS_SH=1)',
      type: 'boolean',
      default: false,
    },
    {
      name: 'all-agents',
      description: 'Install all agent categories (ADR-128: default is ~24 substrate agents; this restores the full set of ~89)',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'claude-flow init', description: 'Initialize with default configuration' },
    { command: 'claude-flow init --start-all', description: 'Initialize and start daemon, memory, swarm' },
    { command: 'claude-flow init --start-daemon', description: 'Initialize and start daemon only' },
    { command: 'claude-flow init --minimal', description: 'Initialize with minimal configuration' },
    { command: 'claude-flow init --full', description: 'Initialize with all components' },
    { command: 'claude-flow init --force', description: 'Reinitialize and overwrite existing config' },
    { command: 'claude-flow init --only-claude', description: 'Only create Claude Code integration' },
    { command: 'claude-flow init --skip-claude', description: 'Only create V3 runtime' },
    { command: 'claude-flow init wizard', description: 'Interactive setup wizard' },
    { command: 'claude-flow init --with-embeddings', description: 'Initialize with ONNX embeddings' },
    { command: 'claude-flow init --with-embeddings --embedding-model Xenova/all-mpnet-base-v2', description: 'Use larger embedding model' },
    { command: 'claude-flow init skills --all', description: 'Install all available skills' },
    { command: 'claude-flow init hooks --minimal', description: 'Create minimal hooks configuration' },
    { command: 'claude-flow init upgrade', description: 'Update helpers while preserving data' },
    { command: 'claude-flow init upgrade --settings', description: 'Update helpers and merge new settings (Agent Teams)' },
    { command: 'claude-flow init upgrade --verbose', description: 'Show detailed upgrade info' },
    { command: 'claude-flow init --codex', description: 'Initialize for OpenAI Codex (AGENTS.md)' },
    { command: 'claude-flow init --codex --full', description: 'Codex init with all canonical packaged skills' },
    { command: 'claude-flow init --dual', description: 'Initialize for both Claude Code and Codex' },
    { command: 'claude-flow init --no-codex-detect', description: 'Skip auto-configuring OpenAI Codex even if it is installed' },
    { command: 'claude-flow init --no-skills-sh', description: 'Skip the post-init skills.sh registration' },
    { command: 'claude-flow init --all-agents', description: 'Install all agent categories (~89 agents; ADR-128 opt-in)' },
  ],
  action: initAction,
};

export default initCommand;
