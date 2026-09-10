/**
 * V3 CLI Commands Index
 * Central registry for all CLI commands
 *
 * NOTE: All commands are synchronously imported at module load time (lines below).
 * The commandLoaders/loadCommand infrastructure provides an async fallback for
 * commands looked up via getCommandAsync() but does NOT reduce startup time since
 * all modules are already imported synchronously for the commands array and
 * commandsByCategory exports.
 */

import type { Command } from '../types.js';

// =============================================================================
// Lazy Loading Infrastructure
// =============================================================================

type CommandLoader = () => Promise<{ default?: Command; [key: string]: Command | unknown }>;

/**
 * Command loaders - commands are only imported when needed
 * This reduces initial bundle parse time by ~200ms
 */
const commandLoaders: Record<string, CommandLoader> = {
  // P1 Core Commands (frequently used - load first)
  init: () => import('./init.js'),
  start: () => import('./start.js'),
  status: () => import('./status.js'),
  task: () => import('./task.js'),
  session: () => import('./session.js'),
  // Original Commands
  agent: () => import('./agent.js'),
  swarm: () => import('./swarm.js'),
  memory: () => import('./memory.js'),
  mcp: () => import('./mcp.js'),
  config: () => import('./config.js'),
  migrate: () => import('./migrate.js'),
  hooks: () => import('./hooks.js'),
  workflow: () => import('./workflow.js'),
  'hive-mind': () => import('./hive-mind.js'),
  process: () => import('./process.js'),
  daemon: () => import('./daemon.js'),
  version: () => import('./version.js'),
  // V3 Advanced Commands (less frequently used - lazy load)
  neural: () => import('./neural.js'),
  security: () => import('./security.js'),
  performance: () => import('./performance.js'),
  providers: () => import('./providers.js'),
  plugins: () => import('./plugins.js'),
  deployment: () => import('./deployment.js'),
  claims: () => import('./claims.js'),
  policy: () => import('./policy.js'),
  embeddings: () => import('./embeddings.js'),
  // P0 Commands
  completions: () => import('./completions.js'),
  doctor: () => import('./doctor.js'),
  // Verification (ADR-095, signed witness manifest)
  verify: () => import('./verify.js'),
  // Analysis Commands
  analyze: () => import('./analyze.js'),
  // Q-Learning Routing Commands
  route: () => import('./route.js'),
  // Progress Commands
  progress: () => import('./progress.js'),
  // Issue Claims Commands (ADR-016)
  issues: () => import('./issues.js'),
  // Auto-update System (ADR-025)
  update: () => import('./update.js'),
  // RuVector PostgreSQL Bridge
  ruvector: () => import('./ruvector/index.js'),
  // Benchmark Suite (Pre-training, Neural, Memory)
  benchmark: () => import('./benchmark.js'),
  // Guidance Control Plane
  guidance: () => import('./guidance.js'),
  // RVFA Appliance Management
  appliance: () => import('./appliance.js'),
  'appliance-advanced': () => import('./appliance-advanced.js'),
  'transfer-store': () => import('./transfer-store.js'),
  cleanup: () => import('./cleanup.js'),
  autopilot: () => import('./autopilot.js'),
  // GAIA Benchmark Harness (ADR-133)
  'gaia-bench': () => import('./gaia-bench.js'),
  // MetaHarness integration (ADR-150) — dispatcher over plugins/ruflo-metaharness/
  metaharness: () => import('./metaharness.js'),
  // Eject (ADR-150 Phase 2) — lift ruflo project into a renamed standalone harness
  eject: () => import('./eject.js'),
  // Cognitum lifecycle funnel controls (ADR-301/305/309)
  funnel: () => import('./funnel.js'),
  // User-facing preferences wrapper (ADR-311 copy discipline — no "funnel" in
  // the user surface). Forwards to the funnel primitives internally.
  settings: () => import('./settings.js'),
  // Cognitum identity — login/logout/status (ADR-306)
  auth: () => import('./auth.js'),
  // Meta LLM Proxy — sponsored downtime capacity (ADR-304/307/313)
  proxy: () => import('./proxy.js'),
  // Fable co-pilot advisor tip in the statusline insight ticker (ADR-316)
  advisor: () => import('./advisor.js'),
  // Ruflo verbs in Claude Code's spinnerVerbs rotation (ADR-318)
  spinner: () => import('./spinner.js'),
  // Ruflo entries in Claude Code's companyAnnouncements startup rotation (ADR-319)
  announcements: () => import('./announcements.js'),
  // AGNTCY/Outshift runtime transport selection (ADR-324 §2) — optional,
  // removable augmentation; no-ops to local transport when AGNTCY/SLIM is
  // not configured (RUFLO_AGNTCY_SLIM_ENDPOINT unset).
  transport: () => import('./agntcy/transport.js'),
};

// Cache for loaded commands
const loadedCommands = new Map<string, Command>();

/**
 * Load a command lazily
 */
async function loadCommand(name: string): Promise<Command | undefined> {
  if (loadedCommands.has(name)) {
    return loadedCommands.get(name);
  }

  const loader = commandLoaders[name];
  if (!loader) return undefined;

  try {
    const module = await loader();
    // Try to find the command export (either default or named)
    const command = (module.default || module[`${name}Command`] || Object.values(module).find(
      (v): v is Command => typeof v === 'object' && v !== null && 'name' in v && 'description' in v
    )) as Command | undefined;

    if (command) {
      loadedCommands.set(name, command);
      return command;
    }
  } catch (error) {
    // Silently fail for missing optional commands
    if (process.env.DEBUG) {
      console.error(`Failed to load command ${name}:`, error);
    }
  }
  return undefined;
}

// =============================================================================
// Synchronous Imports for Core Commands (needed immediately at startup)
// These are the most commonly used commands that need instant access
// =============================================================================

// PERF-03: Only import core commands synchronously (~10 most-used).
// All other commands are lazy-loaded via commandLoaders on demand.
import { initCommand } from './init.js';
import { startCommand } from './start.js';
import { statusCommand } from './status.js';
import { taskCommand } from './task.js';
import { sessionCommand } from './session.js';
import { agentCommand } from './agent.js';
import { swarmCommand } from './swarm.js';
import { memoryCommand } from './memory.js';
import { federationCommand } from './federation.js';
import { mcpCommand } from './mcp.js';
import { hooksCommand } from './hooks.js';

// Pre-populate cache with core commands only
loadedCommands.set('init', initCommand);
loadedCommands.set('start', startCommand);
loadedCommands.set('status', statusCommand);
loadedCommands.set('task', taskCommand);
loadedCommands.set('session', sessionCommand);
loadedCommands.set('agent', agentCommand);
loadedCommands.set('swarm', swarmCommand);
loadedCommands.set('memory', memoryCommand);
loadedCommands.set('federation', federationCommand);
loadedCommands.set('mcp', mcpCommand);
loadedCommands.set('hooks', hooksCommand);

// =============================================================================
// Exports (maintain backwards compatibility)
// =============================================================================

// Export core commands (synchronous)
export { initCommand } from './init.js';
export { startCommand } from './start.js';
export { statusCommand } from './status.js';
export { taskCommand } from './task.js';
export { sessionCommand } from './session.js';
export { agentCommand } from './agent.js';
export { swarmCommand } from './swarm.js';
export { memoryCommand } from './memory.js';
export { federationCommand } from './federation.js';
export { mcpCommand } from './mcp.js';
export { hooksCommand } from './hooks.js';

// Lazy-loaded command re-exports (for backwards compatibility, but async-only)
export async function getConfigCommand() { return loadCommand('config'); }
export async function getMigrateCommand() { return loadCommand('migrate'); }
export async function getWorkflowCommand() { return loadCommand('workflow'); }
export async function getHiveMindCommand() { return loadCommand('hive-mind'); }
export async function getProcessCommand() { return loadCommand('process'); }
export async function getTaskCommand() { return loadCommand('task'); }
export async function getSessionCommand() { return loadCommand('session'); }
export async function getNeuralCommand() { return loadCommand('neural'); }
export async function getSecurityCommand() { return loadCommand('security'); }
export async function getPerformanceCommand() { return loadCommand('performance'); }
export async function getProvidersCommand() { return loadCommand('providers'); }
export async function getPluginsCommand() { return loadCommand('plugins'); }
export async function getDeploymentCommand() { return loadCommand('deployment'); }
export async function getClaimsCommand() { return loadCommand('claims'); }
export async function getPolicyCommand() { return loadCommand('policy'); }
export async function getEmbeddingsCommand() { return loadCommand('embeddings'); }
export async function getCompletionsCommand() { return loadCommand('completions'); }
export async function getAnalyzeCommand() { return loadCommand('analyze'); }
export async function getRouteCommand() { return loadCommand('route'); }
export async function getProgressCommand() { return loadCommand('progress'); }
export async function getIssuesCommand() { return loadCommand('issues'); }
export async function getRuvectorCommand() { return loadCommand('ruvector'); }
export async function getGuidanceCommand() { return loadCommand('guidance'); }
export async function getApplianceCommand() { return loadCommand('appliance'); }
export async function getCleanupCommand() { return loadCommand('cleanup'); }
export async function getAutopilotCommand() { return loadCommand('autopilot'); }
export async function getTransportCommand() { return loadCommand('transport'); }

/**
 * Core commands loaded synchronously (available immediately)
 * Advanced commands loaded on-demand for faster startup
 */
export const commands: Command[] = [
  // Core commands (synchronously loaded) — PERF-03
  initCommand,
  startCommand,
  statusCommand,
  taskCommand,
  sessionCommand,
  agentCommand,
  swarmCommand,
  memoryCommand,
  federationCommand,
  mcpCommand,
  hooksCommand,
];

/**
 * Commands organized by category for help display (synchronous core only).
 * @deprecated Use getCommandsByCategory() for full categorized listing.
 */
export const commandsByCategory = {
  primary: [
    initCommand,
    startCommand,
    statusCommand,
    agentCommand,
    swarmCommand,
    memoryCommand,
    taskCommand,
    sessionCommand,
    mcpCommand,
    hooksCommand,
  ],
  advanced: [] as Command[],
  utility: [] as Command[],
  analysis: [] as Command[],
  management: [] as Command[],
};

/**
 * Async version that loads all commands by category (PERF-03).
 * Use this for help display and full command listings.
 */
export async function getCommandsByCategory(): Promise<Record<string, Command[]>> {
  const [
    daemonCmd, doctorCmd, embeddingsCmd, neuralCmd,
    performanceCmd, securityCmd, ruvectorCmd, hiveMindCmd,
    configCmd, completionsCmd, migrateCmd, workflowCmd,
    analyzeCmd, routeCmd, progressCmd, providersCmd,
    pluginsCmd, deploymentCmd, claimsCmd, issuesCmd,
    updateCmd, processCmd, guidanceCmd, applianceCmd,
    cleanupCmd, autopilotCmd, policyCmd,
  ] = await Promise.all([
    loadCommand('daemon'), loadCommand('doctor'), loadCommand('embeddings'), loadCommand('neural'),
    loadCommand('performance'), loadCommand('security'), loadCommand('ruvector'), loadCommand('hive-mind'),
    loadCommand('config'), loadCommand('completions'), loadCommand('migrate'), loadCommand('workflow'),
    loadCommand('analyze'), loadCommand('route'), loadCommand('progress'), loadCommand('providers'),
    loadCommand('plugins'), loadCommand('deployment'), loadCommand('claims'), loadCommand('issues'),
    loadCommand('update'), loadCommand('process'), loadCommand('guidance'), loadCommand('appliance'),
    loadCommand('cleanup'), loadCommand('autopilot'), loadCommand('policy'),
  ]);

  return {
    primary: [
      initCommand, startCommand, statusCommand, agentCommand,
      swarmCommand, memoryCommand, taskCommand, sessionCommand,
      mcpCommand, hooksCommand,
    ],
    advanced: [
      neuralCmd, securityCmd, policyCmd, performanceCmd, embeddingsCmd,
      hiveMindCmd, ruvectorCmd, guidanceCmd, autopilotCmd,
    ].filter(Boolean) as Command[],
    utility: [
      configCmd, doctorCmd, daemonCmd, completionsCmd,
      migrateCmd, workflowCmd,
    ].filter(Boolean) as Command[],
    analysis: [
      analyzeCmd, routeCmd, progressCmd,
    ].filter(Boolean) as Command[],
    management: [
      providersCmd, pluginsCmd, deploymentCmd, claimsCmd,
      issuesCmd, updateCmd, processCmd, applianceCmd, cleanupCmd,
    ].filter(Boolean) as Command[],
  };
}

/**
 * Command registry map for quick lookup
 * Supports both sync (core commands) and async (lazy-loaded) commands
 */
export const commandRegistry = new Map<string, Command>();

// Register core commands and their aliases
for (const cmd of commands) {
  commandRegistry.set(cmd.name, cmd);
  if (cmd.aliases) {
    for (const alias of cmd.aliases) {
      commandRegistry.set(alias, cmd);
    }
  }
}

/**
 * Get command by name (sync for core commands, returns undefined for lazy commands)
 * Use getCommandAsync for lazy-loaded commands
 */
export function getCommand(name: string): Command | undefined {
  return loadedCommands.get(name) || commandRegistry.get(name);
}

/**
 * Get command by name (async - supports lazy loading)
 */
export async function getCommandAsync(name: string): Promise<Command | undefined> {
  // Check already-loaded commands first
  const cached = loadedCommands.get(name);
  if (cached) return cached;

  // Check sync registry
  const synced = commandRegistry.get(name);
  if (synced) return synced;

  // Try lazy loading
  return loadCommand(name);
}

/**
 * Check if command exists (sync check for core commands)
 */
export function hasCommand(name: string): boolean {
  return loadedCommands.has(name) || commandRegistry.has(name) || name in commandLoaders;
}

/**
 * Get the names of all lazy-loadable commands (the commandLoaders keys).
 * Used by the CLI constructor to register these names with the parser so
 * the two-pass argument walker can recognize them as commands before their
 * modules have been imported. Fix for #1596.
 */
export function getLazyCommandNames(): string[] {
  return Object.keys(commandLoaders);
}

/**
 * Get all command names (including aliases and lazy-loadable)
 */
export function getCommandNames(): string[] {
  const names = new Set([
    ...Array.from(commandRegistry.keys()),
    ...Array.from(loadedCommands.keys()),
    ...Object.keys(commandLoaders),
  ]);
  return Array.from(names);
}

/**
 * Get all unique commands (excluding aliases)
 */
export function getUniqueCommands(): Command[] {
  return commands.filter(cmd => !cmd.hidden);
}

/**
 * Load all commands (populates lazy-loaded commands)
 * Use this when you need all commands available synchronously
 */
export async function loadAllCommands(): Promise<Command[]> {
  const allCommands: Command[] = [...commands];

  for (const name of Object.keys(commandLoaders)) {
    if (!loadedCommands.has(name)) {
      const cmd = await loadCommand(name);
      if (cmd && !allCommands.includes(cmd)) {
        allCommands.push(cmd);
      }
    }
  }

  return allCommands;
}

/**
 * Setup commands in a CLI instance
 */
export function setupCommands(cli: { command: (cmd: Command) => void }): void {
  for (const cmd of commands) {
    cli.command(cmd);
  }
}

/**
 * Setup all commands including lazy-loaded (async)
 */
export async function setupAllCommands(cli: { command: (cmd: Command) => void }): Promise<void> {
  const allCommands = await loadAllCommands();
  for (const cmd of allCommands) {
    cli.command(cmd);
  }
}
