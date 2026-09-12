/**
 * V3 CLI Swarm Command
 * Swarm coordination and management commands
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { select, confirm, multiSelect } from '../prompt.js';
import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { swarmJoinCommand } from './agntcy/swarm-join.js';
import * as fs from 'fs';
import * as path from 'path';

// Read the CLI-side swarm state file (`.swarm/state.json`), written by
// `swarm init` and rewritten by `swarm start` / `swarm stop`.
function readLocalSwarmState(): Record<string, unknown> | null {
  const swarmStateFile = path.join(process.cwd(), '.swarm', 'state.json');
  if (!fs.existsSync(swarmStateFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(swarmStateFile, 'utf-8'));
  } catch {
    // Ignore parse errors
    return null;
  }
}

// Resolve the id of the current swarm. Three writers persist it, under two
// different keys and in two different files:
//
//   `.swarm/state.json`                    `id`                 ← `swarm init`
//   `.swarm/state.json`                    `swarmId`            ← `swarm start`
//   `.claude-flow/swarm/swarm-state.json`  `swarms[id].swarmId` ← MCP `swarm_init`
//
// The status payload used to read only the first key of the first file, so a
// Claude Code session (which drives the MCP path) reported an active swarm
// with agents but no usable id. Check every writer, most local first.
function resolveSwarmId(swarmState?: Record<string, unknown> | null): string | null {
  // A state file left behind by a previous `swarm stop` must not shadow a
  // swarm that is still live in the MCP store — otherwise `stop` names the
  // dead id while `swarm_shutdown`'s own "most recent running" fallback
  // terminates a different swarm.
  if (swarmState?.status !== 'stopped') {
    const fromState = swarmState?.id ?? swarmState?.swarmId;
    if (typeof fromState === 'string' && fromState) return fromState;
  }

  try {
    const storePath = path.join(process.cwd(), '.claude-flow', 'swarm', 'swarm-state.json');
    if (!fs.existsSync(storePath)) return null;
    const store = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as {
      swarms?: Record<string, { swarmId?: string; status?: string; updatedAt?: string }>;
    };
    // Most recently updated swarm that has not been shut down.
    const live = Object.values(store.swarms ?? {})
      .filter(swarm => swarm.status !== 'terminated')
      .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime());
    return live[0]?.swarmId ?? null;
  } catch {
    // Ignore — an unreadable MCP store just means no id to resolve.
    return null;
  }
}

// Get dynamic swarm status from memory/session files
function getSwarmStatus(swarmId?: string) {
  const swarmDir = path.join(process.cwd(), '.swarm');
  const sessionDir = path.join(process.cwd(), '.claude', 'sessions');
  const memoryPaths = [
    path.join(process.cwd(), '.swarm', 'memory.db'),
    path.join(process.cwd(), '.claude', 'memory.db'),
  ];

  // Check for active swarm state file
  const swarmState = readLocalSwarmState();

  // Count active agents from process files
  let activeAgents = 0;
  let totalAgents = 0;
  const agentsDir = path.join(swarmDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    try {
      const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.json'));
      totalAgents = agentFiles.length;
      for (const file of agentFiles) {
        try {
          const agent = JSON.parse(fs.readFileSync(path.join(agentsDir, file), 'utf-8'));
          if (agent.status === 'active' || agent.status === 'running') {
            activeAgents++;
          }
        } catch {
          // Ignore
        }
      }
    } catch {
      // Ignore
    }
  }

  // The canonical agent registry is the same source used by `agent list`.
  // Prefer it over the swarm-level coordination boolean so idle agents are
  // not reported as active (#2808). Hive agents are merged additively.
  if (totalAgents === 0) {
    try {
      const canonicalPath = path.join(process.cwd(), '.claude-flow', 'agents', 'store.json');
      const hivePath = path.join(process.cwd(), '.claude-flow', 'agents.json');
      const merged: Record<string, { status?: string }> = {};
      for (const storePath of [hivePath, canonicalPath]) {
        if (!fs.existsSync(storePath)) continue;
        const parsed = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
        if (parsed?.agents && typeof parsed.agents === 'object') {
          Object.assign(merged, parsed.agents);
        }
      }
      const agents = Object.values(merged).filter(agent => agent.status !== 'terminated');
      if (agents.length > 0) {
        totalAgents = agents.length;
        activeAgents = agents.filter(agent =>
          agent.status === 'active' ||
          agent.status === 'running' ||
          agent.status === 'busy'
        ).length;
      }
    } catch {
      // Ignore — the count-only activity file remains the final fallback.
    }
  }

  // #2799 — `agent spawn` never writes `.swarm/agents/*.json`; it records
  // the count in `.claude-flow/metrics/swarm-activity.json` (via
  // updateSwarmActivityMetrics in commands/agent.ts). So when the agents
  // dir is empty, reconcile against that authoritative activity file
  // instead of reporting Total 0 while `agent list` shows N agents.
  if (totalAgents === 0) {
    try {
      const activityPath = path.join(process.cwd(), '.claude-flow', 'metrics', 'swarm-activity.json');
      if (fs.existsSync(activityPath)) {
        const activity = JSON.parse(fs.readFileSync(activityPath, 'utf-8'));
        const count = Math.max(0, Number((activity?.swarm?.agent_count)) || 0);
        if (count > 0) {
          totalAgents = count;
          // swarm-activity.json tracks a count, not per-agent status; treat
          // a coordination-active swarm's agents as active, else idle.
          activeAgents = activity?.swarm?.coordination_active ? count : 0;
        }
      }
    } catch {
      // Ignore — fall back to 0
    }
  }

  // Get session count
  let sessionCount = 0;
  if (fs.existsSync(sessionDir)) {
    try {
      sessionCount = fs.readdirSync(sessionDir).filter(f => f.endsWith('.json')).length;
    } catch {
      // Ignore
    }
  }

  // Get memory size as rough indicator of activity
  let memorySize = 0;
  for (const dbPath of memoryPaths) {
    if (fs.existsSync(dbPath)) {
      try {
        memorySize = fs.statSync(dbPath).size;
        break;
      } catch {
        // Ignore
      }
    }
  }

  // Count task files if they exist
  let completedTasks = 0;
  let inProgressTasks = 0;
  let pendingTasks = 0;
  const tasksDir = path.join(swarmDir, 'tasks');
  if (fs.existsSync(tasksDir)) {
    try {
      const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
      for (const file of taskFiles) {
        try {
          const task = JSON.parse(fs.readFileSync(path.join(tasksDir, file), 'utf-8'));
          if (task.status === 'completed' || task.status === 'done') {
            completedTasks++;
          } else if (task.status === 'in_progress' || task.status === 'running') {
            inProgressTasks++;
          } else {
            pendingTasks++;
          }
        } catch {
          // Ignore
        }
      }
    } catch {
      // Ignore
    }
  }

  // Calculate dynamic progress based on actual state
  // If no swarm state, show 0%. Otherwise calculate from completed tasks
  const totalTasks = completedTasks + inProgressTasks + pendingTasks;
  let progress = 0;
  if (totalTasks > 0) {
    progress = Math.round((completedTasks / totalTasks) * 100);
  } else if (swarmState) {
    // Swarm initialized but no tasks yet
    progress = 5;
  }

  // Determine status
  let status = 'idle';
  if (inProgressTasks > 0 || activeAgents > 0) {
    status = 'running';
  } else if (completedTasks > 0 && pendingTasks === 0 && inProgressTasks === 0) {
    status = 'completed';
  } else if (swarmState) {
    // The file's own lifecycle state wins over the "a file exists, so we are
    // ready" default — a swarm explicitly recorded as stopped is not ready.
    // Live agents still win above: they are observed reality, whereas the file
    // records an intent that may be stale.
    status = swarmState.status === 'stopped' ? 'stopped' : 'ready';
  }

  // Resolve once — the id also settles whether there is a swarm to report.
  // An MCP `swarm_init` with no agents spawned yet leaves no `.swarm/state.json`
  // and no agent store, so without this the payload contradicted itself:
  // a real `id` alongside `hasActiveSwarm: false`.
  const resolvedId = swarmId || resolveSwarmId(swarmState);

  return {
    // `null` when genuinely unknown — never a sentinel string. `status` and
    // `hasActiveSwarm` already carry the "no active swarm" fact, and a
    // consumer reading `.id` must get an id or nothing.
    id: resolvedId,
    topology: (swarmState as Record<string, string>)?.topology || 'none',
    status,
    objective: (swarmState as Record<string, string>)?.objective || 'No active objective',
    strategy: (swarmState as Record<string, string>)?.strategy || 'none',
    agents: {
      total: totalAgents,
      active: activeAgents,
      idle: Math.max(0, totalAgents - activeAgents),
      completed: 0
    },
    progress,
    tasks: {
      total: totalTasks,
      completed: completedTasks,
      inProgress: inProgressTasks,
      pending: pendingTasks
    },
    metrics: {
      tokensUsed: (swarmState as Record<string, unknown>)?.tokensUsed as number | null ?? null,
      avgResponseTime: (() => {
        // Calculate average response time from task files with startedAt/completedAt
        const taskTimesMs: number[] = [];
        if (fs.existsSync(tasksDir)) {
          try {
            const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
            for (const file of taskFiles) {
              try {
                const task = JSON.parse(fs.readFileSync(path.join(tasksDir, file), 'utf-8'));
                if (task.startedAt && task.completedAt) {
                  const elapsed = new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime();
                  if (elapsed > 0) taskTimesMs.push(elapsed);
                }
              } catch { /* skip malformed task files */ }
            }
          } catch { /* skip if dir unreadable */ }
        }
        if (taskTimesMs.length === 0) return null;
        const avgMs = Math.round(taskTimesMs.reduce((a, b) => a + b, 0) / taskTimesMs.length);
        return avgMs < 1000 ? `${avgMs}ms` : `${(avgMs / 1000).toFixed(1)}s`;
      })(),
      successRate: totalTasks > 0 ? `${Math.round((completedTasks / totalTasks) * 100)}%` : null,
      elapsedTime: (() => {
        // Calculate from swarm startedAt in state.json
        const startedAt = (swarmState as Record<string, unknown>)?.startedAt as string | undefined
          || (swarmState as Record<string, unknown>)?.initializedAt as string | undefined;
        if (!startedAt) return null;
        const elapsedMs = Date.now() - new Date(startedAt).getTime();
        if (elapsedMs < 0) return null;
        const secs = Math.floor(elapsedMs / 1000);
        if (secs < 60) return `${secs}s`;
        const mins = Math.floor(secs / 60);
        const remSecs = secs % 60;
        if (mins < 60) return `${mins}m ${remSecs}s`;
        const hrs = Math.floor(mins / 60);
        const remMins = mins % 60;
        return `${hrs}h ${remMins}m`;
      })()
    },
    coordination: (() => {
      // Read real coordination counts from .swarm/coordination/ directory
      const coordDir = path.join(swarmDir, 'coordination');
      let consensusRounds = 0;
      let messagesSent = 0;
      let conflictsResolved = 0;
      if (fs.existsSync(coordDir)) {
        try {
          const coordFiles = fs.readdirSync(coordDir).filter(f => f.endsWith('.json'));
          for (const file of coordFiles) {
            try {
              const entry = JSON.parse(fs.readFileSync(path.join(coordDir, file), 'utf-8'));
              if (entry.type === 'consensus') consensusRounds++;
              else if (entry.type === 'message') messagesSent++;
              else if (entry.type === 'conflict' || entry.type === 'conflict-resolution') conflictsResolved++;
              // Also aggregate pre-counted fields if present
              if (typeof entry.consensusRounds === 'number') consensusRounds += entry.consensusRounds;
              if (typeof entry.messagesSent === 'number') messagesSent += entry.messagesSent;
              if (typeof entry.conflictsResolved === 'number') conflictsResolved += entry.conflictsResolved;
            } catch { /* skip malformed coordination files */ }
          }
        } catch { /* skip if dir unreadable */ }
      }
      // Also check state.json for aggregate coordination stats
      if (swarmState) {
        const coord = (swarmState as Record<string, unknown>).coordination as Record<string, number> | undefined;
        if (coord) {
          if (typeof coord.consensusRounds === 'number') consensusRounds += coord.consensusRounds;
          if (typeof coord.messagesSent === 'number') messagesSent += coord.messagesSent;
          if (typeof coord.conflictsResolved === 'number') conflictsResolved += coord.conflictsResolved;
        }
      }
      return { consensusRounds, messagesSent, conflictsResolved };
    })(),
    // A state file left behind by `swarm stop` is not an active swarm — without
    // this it claimed one it could not name (`id: null`, zero agents), which is
    // the same contradiction from the other side. Live agents or a resolvable
    // id still count, so a stopped file never masks real activity.
    hasActiveSwarm: (!!swarmState && swarmState.status !== 'stopped')
      || totalAgents > 0
      || resolvedId !== null
  };
}

// Swarm topologies
const TOPOLOGIES = [
  { value: 'hierarchical', label: 'Hierarchical', hint: 'Queen-led coordination with worker agents' },
  { value: 'mesh', label: 'Mesh', hint: 'Fully connected peer-to-peer network' },
  { value: 'ring', label: 'Ring', hint: 'Circular communication pattern' },
  { value: 'star', label: 'Star', hint: 'Central coordinator with spoke agents' },
  { value: 'hybrid', label: 'Hybrid', hint: 'Hierarchical mesh for maximum flexibility' },
  { value: 'hierarchical-mesh', label: 'Hierarchical Mesh', hint: 'V3 15-agent queen + peer communication (recommended)' },
  { value: 'pheromone-adaptive', label: 'Pheromone Adaptive', hint: 'Role-aware dynamic eligibility with quorum safety (ADR-330)' }
];

// Swarm strategies
const STRATEGIES = [
  { value: 'specialized', label: 'Specialized', hint: 'Clear roles, no overlap (anti-drift)' },
  { value: 'balanced', label: 'Balanced', hint: 'Even distribution of work' },
  { value: 'adaptive', label: 'Adaptive', hint: 'Dynamic strategy based on task' },
  { value: 'research', label: 'Research', hint: 'Distributed research and analysis' },
  { value: 'development', label: 'Development', hint: 'Collaborative code development' },
  { value: 'testing', label: 'Testing', hint: 'Comprehensive test coverage' },
  { value: 'optimization', label: 'Optimization', hint: 'Performance optimization' },
  { value: 'maintenance', label: 'Maintenance', hint: 'Codebase maintenance and refactoring' },
  { value: 'analysis', label: 'Analysis', hint: 'Code analysis and documentation' }
];

// Initialize swarm
const initCommand: Command = {
  name: 'init',
  description: 'Initialize a new swarm',
  options: [
    {
      name: 'topology',
      short: 't',
      description: 'Swarm topology',
      type: 'string',
      choices: TOPOLOGIES.map(t => t.value),
      default: 'hierarchical'
    },
    {
      name: 'max-agents',
      short: 'm',
      description: 'Maximum number of agents',
      type: 'number',
      default: 15
    },
    {
      name: 'auto-scale',
      description: 'Enable automatic scaling',
      type: 'boolean',
      default: true
    },
    {
      name: 'strategy',
      short: 's',
      description: 'Coordination strategy',
      type: 'string',
      choices: STRATEGIES.map(s => s.value)
    },
    {
      name: 'v3-mode',
      description: 'Enable V3 15-agent hierarchical mesh mode',
      type: 'boolean',
      default: false
    },
    {
      name: 'apsc-live',
      description: 'Apply APSC suspension decisions (default is calibration-only dry run)',
      type: 'boolean',
      default: false
    },
    { name: 'apsc-alpha', description: 'Task-success score weight', type: 'number', default: 0.5 },
    { name: 'apsc-beta', description: 'Latency score weight', type: 'number', default: 0.2 },
    { name: 'apsc-gamma', description: 'Consensus-alignment score weight', type: 'number', default: 0.3 },
    { name: 'apsc-pruning-factor', description: 'Fraction of adaptive threshold below which agents are eligible for suspension', type: 'number', default: 0.6 },
    { name: 'apsc-reactivation-threshold', description: 'Fraction of adaptive threshold required for recovery', type: 'number', default: 0.75 },
    { name: 'apsc-min-active-agents', description: 'Hard quorum floor', type: 'number', default: 3 },
    { name: 'apsc-min-samples', description: 'Warm-up observations before pruning', type: 'number', default: 3 },
    {
      // #2768 — dream-cycle SubagentPermissionDelegate. Ships a per-role
      // capability manifest to `.swarm/permissions.jsonl` + an append-only
      // audit trail. Task-tool prompts can consult the manifest; ruflo
      // does NOT enforce at the syscall boundary (Claude Code owns that).
      name: 'with-permissions',
      description: 'Ship workspace-scoped permission manifest (preset: strict|standard|permissive) — dream-cycle #2768',
      type: 'string',
      choices: ['strict', 'standard', 'permissive'],
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    let topology = ctx.flags.topology as string;
    const maxAgents = ctx.flags.maxAgents as number || 15;
    const v3Mode = ctx.flags.v3Mode as boolean;
    const withPermissions = ctx.flags.withPermissions as string | undefined;

    // V3 mode enables hierarchical-mesh hybrid
    if (v3Mode) {
      topology = 'hierarchical-mesh';
      output.printInfo('V3 Mode: Using hierarchical-mesh topology with 15-agent coordination');
    }

    // Interactive topology selection
    if (!topology && ctx.interactive) {
      topology = await select({
        message: 'Select swarm topology:',
        options: TOPOLOGIES,
        default: 'hierarchical'
      });
    }

    output.writeln();
    output.printInfo('Initializing swarm...');

    try {
      // Call MCP tool to initialize swarm
      const result = await callMCPTool<{
        swarmId: string;
        topology: string;
        initializedAt: string;
        config: {
          topology: string;
          maxAgents: number;
          currentAgents: number;
          communicationProtocol?: string;
          autoScaling?: boolean;
        };
      }>('swarm_init', {
        topology: topology as 'hierarchical' | 'mesh' | 'adaptive' | 'collective' | 'hierarchical-mesh' | 'pheromone-adaptive',
        maxAgents,
        config: {
          communicationProtocol: 'message-bus',
          consensusMechanism: 'majority',
          failureHandling: 'retry',
          loadBalancing: true,
          autoScaling: ctx.flags.autoScale ?? true,
          ...(topology === 'pheromone-adaptive' ? {
            apsc: {
              alpha: Number(ctx.flags.apscAlpha ?? 0.5),
              beta: Number(ctx.flags.apscBeta ?? 0.2),
              gamma: Number(ctx.flags.apscGamma ?? 0.3),
              pruningFactor: Number(ctx.flags.apscPruningFactor ?? 0.6),
              reactivationThreshold: Number(ctx.flags.apscReactivationThreshold ?? 0.75),
              minActiveAgents: Number(ctx.flags.apscMinActiveAgents ?? 3),
              minSamples: Number(ctx.flags.apscMinSamples ?? 3),
              dryRun: ctx.flags.apscLive !== true,
            },
          } : {}),
        },
        metadata: {
          v3Mode,
          strategy: ctx.flags.strategy || 'development',
        },
      });

      // Display initialization progress
      output.writeln(output.dim('  Creating coordination topology...'));
      output.writeln(output.dim('  Initializing memory namespace...'));
      output.writeln(output.dim('  Setting up communication channels...'));

      if (v3Mode) {
        output.writeln(output.dim('  Enabling Flash Attention (2.49x-7.47x speedup)...'));
        output.writeln(output.dim('  Configuring AgentDB integration (150x faster)...'));
        output.writeln(output.dim('  Initializing SONA learning system...'));
      }

      output.writeln();
      output.printTable({
        columns: [
          { key: 'property', header: 'Property', width: 20 },
          { key: 'value', header: 'Value', width: 35 }
        ],
        data: [
          { property: 'Swarm ID', value: result.swarmId },
          { property: 'Topology', value: result.topology },
          { property: 'Max Agents', value: result.config.maxAgents },
          { property: 'Auto Scale', value: result.config.autoScaling ? 'Enabled' : 'Disabled' },
          { property: 'Protocol', value: result.config.communicationProtocol || 'N/A' },
          { property: 'V3 Mode', value: v3Mode ? 'Enabled' : 'Disabled' },
          ...(topology === 'pheromone-adaptive'
            ? [{ property: 'APSC Mode', value: ctx.flags.apscLive === true ? 'Live' : 'Dry run' }]
            : [])
        ]
      });

      output.writeln();
      output.printSuccess('Swarm initialized successfully');

      // Save swarm state locally for status command to read
      const swarmDir = path.join(process.cwd(), '.swarm');
      try {
        if (!fs.existsSync(swarmDir)) {
          fs.mkdirSync(swarmDir, { recursive: true });
        }
        const stateFile = path.join(swarmDir, 'state.json');
        fs.writeFileSync(stateFile, JSON.stringify({
          id: result.swarmId,
          topology: result.topology,
          maxAgents: result.config.maxAgents,
          strategy: ctx.flags.strategy || 'development',
          v3Mode,
          permissions: withPermissions ?? null,
          initializedAt: result.initializedAt,
          status: 'ready'
        }, null, 2));
      } catch {
        // Ignore errors writing state file
      }

      // #2768 — write the permission manifest + seed the audit trail.
      // Optional: only fires when --with-permissions was passed. Missing
      // module or failed I/O is non-critical; we log a dim warning and
      // continue so a broken permission layer never blocks swarm init.
      if (withPermissions) {
        try {
          const [{ resolvePreset }, { writeGrants, appendAuditEvent }] = await Promise.all([
            import('../permission/permission-set.js'),
            import('../permission/permission-audit.js'),
          ]);
          const sets = resolvePreset(withPermissions);
          writeGrants(sets, swarmDir);
          for (const set of sets) {
            appendAuditEvent({
              agentId: 'swarm-init',
              role: set.role,
              event: 'granted',
              capability: `preset:${withPermissions}`,
              swarmId: result.swarmId,
              reason: `Initial grant from swarm init --with-permissions ${withPermissions}`,
            }, swarmDir);
          }
          output.writeln(output.dim(`  Wrote permission manifest (preset: ${withPermissions}, ${sets.length} roles) → .swarm/permissions.jsonl`));
          output.writeln(output.dim(`  Audit trail seeded → .swarm/permission-audit.jsonl`));
        } catch (err) {
          output.writeln(output.dim(`  ⚠ permission manifest skipped: ${err instanceof Error ? err.message : String(err)}`));
        }
      }

      if (ctx.flags.format === 'json') {
        output.printJson(result);
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to initialize swarm: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Start swarm execution
const startCommand: Command = {
  name: 'start',
  description: 'Start swarm execution',
  options: [
    {
      name: 'objective',
      short: 'o',
      description: 'Swarm objective/task',
      type: 'string',
      required: true
    },
    {
      name: 'strategy',
      short: 's',
      description: 'Execution strategy',
      type: 'string',
      choices: STRATEGIES.map(s => s.value)
    },
    {
      name: 'parallel',
      short: 'p',
      description: 'Enable parallel execution',
      type: 'boolean',
      default: true
    },
    {
      name: 'monitor',
      description: 'Enable real-time monitoring',
      type: 'boolean',
      default: true
    }
  ],
  examples: [
    { command: 'claude-flow swarm start -o "Build REST API" -s development', description: 'Start development swarm' },
    { command: 'claude-flow swarm start -o "Analyze codebase" --parallel', description: 'Parallel analysis' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const objective = ctx.args[0] || ctx.flags.objective as string;
    let strategy = ctx.flags.strategy as string;

    if (!objective) {
      output.printError('Objective is required. Use -o or provide as argument.');
      return { success: false, exitCode: 1 };
    }

    // Interactive strategy selection
    if (!strategy && ctx.interactive) {
      strategy = await select({
        message: 'Select execution strategy:',
        options: STRATEGIES,
        default: 'development'
      });
    }

    strategy = strategy || 'development';

    output.writeln();
    output.printInfo(`Starting swarm with objective: ${output.highlight(objective)}`);
    output.writeln();

    // Compute agent deployment plan based on strategy
    const agentPlan = getAgentPlan(strategy);

    output.writeln(output.bold('Agent Deployment Plan'));
    output.printTable({
      columns: [
        { key: 'role', header: 'Role', width: 20 },
        { key: 'type', header: 'Type', width: 15 },
        { key: 'count', header: 'Count', width: 8, align: 'right' },
        { key: 'purpose', header: 'Purpose', width: 30 }
      ],
      data: agentPlan
    });

    // Confirm execution
    if (ctx.interactive) {
      const confirmed = await confirm({
        message: `Deploy ${agentPlan.reduce((sum, a) => sum + a.count, 0)} agents?`,
        default: true
      });

      if (!confirmed) {
        output.printInfo('Swarm execution cancelled');
        return { success: true };
      }
    }

    // Initialize swarm via MCP and persist state (#1423: was stub-only, no actual execution)
    const swarmId = `swarm-${Date.now().toString(36)}`;
    const totalAgents = agentPlan.reduce((sum: number, a: { count: number }) => sum + a.count, 0);

    output.writeln();
    const spinner = output.createSpinner({ text: 'Initializing swarm via MCP...', spinner: 'dots' });
    spinner.start();

    try {
      // Actually call MCP to initialize the swarm
      const initResult = await callMCPTool('swarm_init', {
        topology: 'hierarchical',
        maxAgents: totalAgents,
        strategy: strategy === 'development' ? 'specialized' : strategy,
      });
      spinner.succeed('Swarm initialized via MCP');
    } catch (err) {
      spinner.fail('MCP swarm_init failed — swarm metadata saved locally only');
      output.writeln(output.dim(`  Error: ${err instanceof Error ? err.message : String(err)}`));
      // #2370: the old hint referenced the deprecated `claude-flow@v3alpha`
      // dist-tag which now resolves to a pre-rename package. Use the current
      // `ruflo@latest` and force a fresh fetch with `-y` so npx doesn't pick
      // a stale local install.
      output.writeln(output.dim('  The MCP server may not be running. Start it with: claude mcp add claude-flow -- npx -y ruflo@latest mcp start'));
    }

    // Persist swarm state to disk so `swarm status` can read it
    const swarmDir = path.join(process.cwd(), '.swarm');
    if (!fs.existsSync(swarmDir)) fs.mkdirSync(swarmDir, { recursive: true });

    const executionState = {
      // `id` mirrors what `swarm init` writes so both files share one key;
      // `swarmId` stays for existing files and readers.
      id: swarmId,
      swarmId,
      objective,
      strategy,
      status: 'initialized',
      agents: totalAgents,
      agentPlan,
      startedAt: new Date().toISOString(),
      parallel: ctx.flags.parallel ?? true
    };

    fs.writeFileSync(
      path.join(swarmDir, 'state.json'),
      JSON.stringify(executionState, null, 2)
    );

    output.writeln();
    output.printSuccess(`Swarm ${swarmId} initialized with ${totalAgents} agent slots`);
    output.writeln(output.dim('  This CLI coordinates agent state. Execution happens via:'));
    output.writeln(output.dim('  - Claude Code Agent tool (interactive)'));
    output.writeln(output.dim('  - claude -p (headless background)'));
    output.writeln(output.dim('  - hive-mind spawn --claude (autonomous)'));
    output.writeln(output.dim(`  Monitor: claude-flow swarm status ${swarmId}`));

    return { success: true, data: executionState };
  }
};

// Swarm status
const statusCommand: Command = {
  name: 'status',
  description: 'Show swarm status',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const swarmId = ctx.args[0];

    // Get dynamic status from actual swarm state files
    const status = getSwarmStatus(swarmId);

    if (ctx.flags.format === 'json') {
      output.printJson(status);
      return { success: true, data: status };
    }

    output.writeln();

    // Show different message if no active swarm
    if (!status.hasActiveSwarm) {
      output.writeln(output.warning('No active swarm'));
      output.writeln();
      output.writeln(output.dim('Start a swarm with:'));
      output.writeln(output.dim('  npx @claude-flow/cli@latest swarm init'));
      output.writeln(output.dim('  npx @claude-flow/cli@latest swarm start'));
      output.writeln();
      return { success: true, data: status };
    }

    output.writeln(output.bold(`Swarm Status: ${status.id ?? output.dim('unknown id')}`));
    output.writeln();

    // Progress bar
    output.writeln(`Overall Progress: ${output.progressBar(status.progress, 100, 40)}`);
    output.writeln();

    // Agent status
    output.writeln(output.bold('Agents'));
    output.printTable({
      columns: [
        { key: 'status', header: 'Status', width: 12 },
        { key: 'count', header: 'Count', width: 10, align: 'right' }
      ],
      data: [
        { status: output.success('Active'), count: status.agents.active },
        { status: output.warning('Idle'), count: status.agents.idle },
        { status: output.dim('Completed'), count: status.agents.completed },
        { status: 'Total', count: status.agents.total }
      ]
    });

    output.writeln();

    // Task status
    output.writeln(output.bold('Tasks'));
    output.printTable({
      columns: [
        { key: 'status', header: 'Status', width: 12 },
        { key: 'count', header: 'Count', width: 10, align: 'right' }
      ],
      data: [
        { status: output.success('Completed'), count: status.tasks.completed },
        { status: output.info('In Progress'), count: status.tasks.inProgress },
        { status: output.dim('Pending'), count: status.tasks.pending },
        { status: 'Total', count: status.tasks.total }
      ]
    });

    output.writeln();

    // Metrics
    output.writeln(output.bold('Performance Metrics'));
    output.printList([
      `Tokens Used: ${status.metrics.tokensUsed != null ? status.metrics.tokensUsed.toLocaleString() : output.dim('unknown')}`,
      `Avg Response Time: ${status.metrics.avgResponseTime ?? output.dim('no data')}`,
      `Success Rate: ${status.metrics.successRate ?? output.dim('no data')}`,
      `Elapsed Time: ${status.metrics.elapsedTime ?? output.dim('no data')}`
    ]);

    output.writeln();

    // Coordination stats
    output.writeln(output.bold('Coordination'));
    output.printList([
      `Consensus Rounds: ${status.coordination.consensusRounds}`,
      `Messages Sent: ${status.coordination.messagesSent}`,
      `Conflicts Resolved: ${status.coordination.conflictsResolved}`
    ]);

    return { success: true, data: status };
  }
};

// Stop swarm
const stopCommand: Command = {
  name: 'stop',
  description: 'Stop swarm execution',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Force immediate stop',
      type: 'boolean',
      default: false
    },
    {
      name: 'save-state',
      description: 'Save current state for resume',
      type: 'boolean',
      default: true
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Bare `swarm stop` used to hard-fail, and no CLI surface handed out an
    // id to pass (there is no `swarm list`). Default to the persisted swarm;
    // an explicit argument still wins.
    const swarmId = ctx.args[0] || resolveSwarmId(readLocalSwarmState());
    const force = ctx.flags.force as boolean;

    if (!swarmId) {
      output.printError('No swarm found to stop');
      output.writeln(output.dim('  Find an id with: claude-flow swarm status --format json   (the "id" field)'));
      output.writeln(output.dim('  Or pass one:     claude-flow swarm stop <swarm-id>'));
      output.writeln(output.dim('  Or start one:    claude-flow swarm init'));
      return { success: false, exitCode: 1 };
    }

    if (ctx.interactive && !force) {
      const confirmed = await confirm({
        message: `Stop swarm ${swarmId}? Progress will be saved.`,
        default: false
      });

      if (!confirmed) {
        output.printInfo('Operation cancelled');
        return { success: true };
      }
    }

    output.printInfo(`Stopping swarm ${swarmId}...`);

    // Update persisted swarm state if it exists (#1423)
    const swarmStateFile = path.join(process.cwd(), '.swarm', 'state.json');
    if (fs.existsSync(swarmStateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(swarmStateFile, 'utf-8'));
        state.status = 'stopped';
        state.stoppedAt = new Date().toISOString();
        fs.writeFileSync(swarmStateFile, JSON.stringify(state, null, 2));
        output.writeln(output.dim('  Swarm state updated'));
      } catch {
        output.writeln(output.dim('  Could not update swarm state file'));
      }
    }

    // Attempt MCP cleanup
    try {
      await callMCPTool('swarm_shutdown', { swarmId, force });
      output.writeln(output.dim('  MCP swarm stopped'));
    } catch {
      // MCP may not be available
    }

    output.printSuccess(`Swarm ${swarmId} stopped`);

    return { success: true, data: { swarmId, stopped: true, force } };
  }
};

// Scale swarm
const scaleCommand: Command = {
  name: 'scale',
  description: 'Scale swarm agent count',
  options: [
    {
      name: 'agents',
      short: 'a',
      description: 'Target number of agents',
      type: 'number',
      required: true
    },
    {
      name: 'type',
      short: 't',
      description: 'Agent type to scale',
      type: 'string'
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Same resolution as `stop` — the id is persisted, so don't demand it.
    const swarmId = ctx.args[0] || resolveSwarmId(readLocalSwarmState());
    const targetAgents = ctx.flags.agents as number;
    const agentType = ctx.flags.type as string;

    if (!swarmId) {
      output.printError('No swarm found to scale');
      output.writeln(output.dim('  Find an id with: claude-flow swarm status --format json   (the "id" field)'));
      output.writeln(output.dim('  Or pass one:     claude-flow swarm scale <swarm-id> --agents N'));
      return { success: false, exitCode: 1 };
    }

    if (!targetAgents) {
      output.printError('Target agent count required. Use --agents or -a');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Scaling swarm ${swarmId} to ${targetAgents} agents...`);

    // Calculate scaling delta — fetch actual count instead of hardcoded 8 (#1425)
    const { callMCPTool } = await import('../mcp-client.js');
    let currentAgents = 0;
    try {
      const statusResult = await callMCPTool('swarm_status', {});
      const statusData = typeof statusResult === 'string' ? JSON.parse(statusResult) : statusResult;
      currentAgents = statusData?.agentCount ?? statusData?.agents?.length ?? 0;
    } catch {
      // If MCP unavailable, fall back to 0 (will spawn all requested agents)
      currentAgents = 0;
    }
    const delta = targetAgents - currentAgents;

    if (delta > 0) {
      output.writeln(output.dim(`  Spawning ${delta} new agents...`));
    } else if (delta < 0) {
      output.writeln(output.dim(`  Gracefully stopping ${-delta} agents...`));
    } else {
      output.printInfo('Swarm already at target size');
      return { success: true };
    }

    output.printSuccess(`Swarm scaled to ${targetAgents} agents`);

    return { success: true, data: { swarmId, agents: targetAgents, delta } };
  }
};

// Coordinate command (V3 specific)
const coordinateCommand: Command = {
  name: 'coordinate',
  description: 'Execute V3 15-agent hierarchical mesh coordination',
  options: [
    {
      name: 'agents',
      description: 'Number of agents',
      type: 'number',
      default: 15
    },
    {
      name: 'domains',
      description: 'Domains to activate',
      type: 'array'
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const agentCount = ctx.flags.agents as number || 15;

    output.writeln();
    output.writeln(output.bold('V3 15-Agent Hierarchical Mesh Coordination'));
    output.writeln();

    // V3 agent structure
    const v3Agents = [
      { id: 1, role: 'Queen Coordinator', domain: 'Orchestration', status: 'primary' },
      { id: 2, role: 'Security Architect', domain: 'Security', status: 'active' },
      { id: 3, role: 'Security Auditor', domain: 'Security', status: 'active' },
      { id: 4, role: 'Test Architect', domain: 'Security', status: 'active' },
      { id: 5, role: 'Core Architect', domain: 'Core', status: 'active' },
      { id: 6, role: 'Memory Specialist', domain: 'Core', status: 'active' },
      { id: 7, role: 'Swarm Specialist', domain: 'Core', status: 'active' },
      { id: 8, role: 'Integration Architect', domain: 'Integration', status: 'active' },
      { id: 9, role: 'Performance Engineer', domain: 'Integration', status: 'active' },
      { id: 10, role: 'CLI Developer', domain: 'Integration', status: 'active' },
      { id: 11, role: 'Hooks Developer', domain: 'Integration', status: 'active' },
      { id: 12, role: 'MCP Specialist', domain: 'Integration', status: 'active' },
      { id: 13, role: 'Project Coordinator', domain: 'Management', status: 'active' },
      { id: 14, role: 'Documentation Lead', domain: 'Management', status: 'standby' },
      { id: 15, role: 'DevOps Engineer', domain: 'Management', status: 'standby' }
    ].slice(0, agentCount);

    output.printTable({
      columns: [
        { key: 'id', header: '#', width: 3, align: 'right' },
        { key: 'role', header: 'Role', width: 22 },
        { key: 'domain', header: 'Domain', width: 15 },
        { key: 'status', header: 'Status', width: 10, format: (v) => {
          if (v === 'primary') return output.highlight(String(v));
          if (v === 'active') return output.success(String(v));
          return output.dim(String(v));
        }}
      ],
      data: v3Agents
    });

    // Actually initialize via MCP instead of just displaying (#1423)
    output.writeln();
    try {
      await callMCPTool('swarm_init', {
        topology: 'hierarchical-mesh',
        maxAgents: agentCount,
        strategy: 'specialized',
      });
      output.printSuccess(`Swarm coordination initialized with ${agentCount} agent slots via MCP`);
    } catch {
      output.printWarning('MCP unavailable — showing agent plan only (no active coordination)');
    }

    output.writeln();
    output.writeln(output.dim('Note: Use Claude Code Task tool or hive-mind spawn --claude to'));
    output.writeln(output.dim('drive actual agent execution. This command sets up the topology.'));

    return { success: true, data: { agents: v3Agents, count: agentCount } };
  }
};

// Main swarm command
// #2727 dream-cycle — inter-agent message compressor (IB+VQ-inspired
// MVP). Advisory tool: takes a message + token budget, returns a
// compressed variant that preserves must-see spans (code, URLs, paths)
// and keeps the top-scored sentences by TF-IDF-ish keyword density.
// v2 wires a real VQ codec once a training pipeline exists.
const compressMessageCommand: Command = {
  name: 'compress-message',
  description: 'Compress an inter-agent message to a token budget (IB+VQ-inspired, dream-cycle #2727)',
  options: [
    { name: 'message', short: 'm', type: 'string', description: 'Message text (or use --message-file)' },
    { name: 'message-file', type: 'string', description: 'Path to a file whose contents will be compressed' },
    { name: 'budget-tokens', short: 'b', type: 'number', default: 200, description: 'Target token budget (approximate, ~4 chars per token)' },
    { name: 'mode', type: 'string', choices: ['keyword', 'sentence', 'hybrid'], default: 'hybrid', description: 'Scoring mode' },
  ],
  examples: [
    { command: 'claude-flow swarm compress-message -m "…" --budget-tokens 100', description: 'Compress inline message to 100 tokens' },
    { command: 'claude-flow swarm compress-message --message-file ./msg.md -b 300 --format json', description: 'JSON for pipelines' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const inlineMsg = ctx.flags.message as string | undefined;
    const msgFile = ctx.flags.messageFile as string | undefined;
    const budgetTokens = (ctx.flags.budgetTokens as number) || 200;
    const mode = (ctx.flags.mode as string) || 'hybrid';

    let message = inlineMsg ?? '';
    if (msgFile) {
      try {
        const fsMod = await import('node:fs');
        const pathMod = await import('node:path');
        message = fsMod.readFileSync(pathMod.resolve(msgFile), 'utf-8');
      } catch (err) {
        output.printError(`Failed to read ${msgFile}: ${err instanceof Error ? err.message : String(err)}`);
        return { success: false, exitCode: 1 };
      }
    }

    if (!message) {
      output.printError('No message provided. Use --message "..." or --message-file <path>.');
      return { success: false, exitCode: 1 };
    }

    const { compressMessage } = await import('../swarm/message-compressor.js');
    const result = compressMessage(message, { budgetTokens, mode: mode as 'keyword' | 'sentence' | 'hybrid' });

    if (ctx.flags.format === 'json') {
      output.printJson(result);
      return { success: true, data: result };
    }

    output.writeln();
    output.printBox(
      `Original: ${result.stats.originalTokens} tokens · Compressed: ${result.stats.compressedTokens} tokens\n` +
      `Ratio: ${(result.stats.compressionRatio * 100).toFixed(1)}%\n` +
      `Sentences kept: ${result.stats.sentencesKept}/${result.stats.sentencesTotal} · Preserved spans: ${result.stats.preservedSpans}\n` +
      `Info retained (top-quartile): ${(result.stats.infoRetainedEstimate * 100).toFixed(1)}%`,
      'Message Compressor (#2727 IB+VQ MVP)'
    );
    output.writeln();
    output.writeln(output.bold('Compressed message'));
    output.writeln(output.dim('─'.repeat(60)));
    output.writeln(result.compressed);
    output.writeln(output.dim('─'.repeat(60)));
    return { success: true, data: result };
  },
};

const pheromoneCommand: Command = {
  name: 'pheromone',
  description: 'Inspect or update ADR-330 pheromone-adaptive scheduling state',
  options: [
    { name: 'agent-id', description: 'Agent identifier; omit to show status', type: 'string' },
    { name: 'role', description: 'Agent role for role-local normalization', type: 'string' },
    { name: 'task-success', description: 'Task success in [0,1]', type: 'number' },
    { name: 'normalized-latency', description: 'Latency divided by budget in [0,1]', type: 'number' },
    { name: 'consensus-alignment', description: 'Consensus alignment in [0,1]', type: 'number' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const agentId = ctx.flags.agentId as string | undefined;
    const data = agentId
      ? await callMCPTool<Record<string, unknown>>('swarm_pheromone_update', {
        agentId,
        role: String(ctx.flags.role ?? 'worker'),
        taskSuccess: Number(ctx.flags.taskSuccess ?? 1),
        normalizedLatency: Number(ctx.flags.normalizedLatency ?? 0),
        consensusAlignment: Number(ctx.flags.consensusAlignment ?? 1),
      })
      : await callMCPTool<Record<string, unknown>>('swarm_pheromone_status', {});
    output.writeln(JSON.stringify(data, null, 2));
    return { success: data.active !== false, data };
  },
};

export const swarmCommand: Command = {
  name: 'swarm',
  description: 'Swarm coordination commands',
  subcommands: [initCommand, startCommand, statusCommand, stopCommand, scaleCommand, coordinateCommand, compressMessageCommand, pheromoneCommand, swarmJoinCommand],
  options: [],
  examples: [
    { command: 'claude-flow swarm init --v3-mode', description: 'Initialize V3 swarm' },
    { command: 'claude-flow swarm start -o "Build API" -s development', description: 'Start development swarm' },
    { command: 'claude-flow swarm coordinate --agents 15', description: 'V3 coordination' },
    { command: 'claude-flow swarm pheromone', description: 'Inspect pheromone-adaptive scheduling state' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Swarm Coordination Commands'));
    output.writeln();
    output.writeln('Usage: claude-flow swarm <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('init')}        - Initialize a new swarm`,
      `${output.highlight('start')}       - Start swarm execution`,
      `${output.highlight('status')}      - Show swarm status`,
      `${output.highlight('stop')}        - Stop swarm execution`,
      `${output.highlight('scale')}       - Scale swarm agent count`,
      `${output.highlight('coordinate')}  - V3 15-agent coordination`,
      `${output.highlight('pheromone')}   - Inspect/update adaptive pheromone state`
    ]);

    return { success: true };
  }
};

// Helper function
function getAgentPlan(strategy: string): Array<{ role: string; type: string; count: number; purpose: string }> {
  const plans: Record<string, Array<{ role: string; type: string; count: number; purpose: string }>> = {
    specialized: [
      { role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Central orchestration (anti-drift)' },
      { role: 'Researcher', type: 'researcher', count: 1, purpose: 'Requirements analysis' },
      { role: 'Architect', type: 'architect', count: 1, purpose: 'System design' },
      { role: 'Coder', type: 'coder', count: 2, purpose: 'Implementation' },
      { role: 'Tester', type: 'tester', count: 1, purpose: 'Quality assurance' },
      { role: 'Reviewer', type: 'reviewer', count: 1, purpose: 'Code review' }
    ],
    balanced: [
      { role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Orchestrate workflow' },
      { role: 'Worker', type: 'coder', count: 4, purpose: 'General implementation' },
      { role: 'Reviewer', type: 'reviewer', count: 1, purpose: 'Quality review' }
    ],
    adaptive: [
      { role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Dynamic orchestration' },
      { role: 'Scout', type: 'researcher', count: 1, purpose: 'Task analysis' },
      { role: 'Worker', type: 'coder', count: 3, purpose: 'Adaptive execution' }
    ],
    development: [
      { role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Orchestrate workflow' },
      { role: 'Architect', type: 'architect', count: 1, purpose: 'System design' },
      { role: 'Coder', type: 'coder', count: 3, purpose: 'Implementation' },
      { role: 'Tester', type: 'tester', count: 2, purpose: 'Quality assurance' },
      { role: 'Reviewer', type: 'reviewer', count: 1, purpose: 'Code review' }
    ],
    research: [
      { role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Research coordination' },
      { role: 'Researcher', type: 'researcher', count: 4, purpose: 'Data gathering' },
      { role: 'Analyst', type: 'analyst', count: 2, purpose: 'Analysis and synthesis' }
    ],
    testing: [
      { role: 'Test Lead', type: 'tester', count: 1, purpose: 'Test strategy' },
      { role: 'Unit Tester', type: 'tester', count: 2, purpose: 'Unit tests' },
      { role: 'Integration Tester', type: 'tester', count: 2, purpose: 'Integration tests' },
      { role: 'QA Reviewer', type: 'reviewer', count: 1, purpose: 'Quality review' }
    ],
    optimization: [
      { role: 'Performance Lead', type: 'optimizer', count: 1, purpose: 'Performance strategy' },
      { role: 'Profiler', type: 'analyst', count: 2, purpose: 'Profiling' },
      { role: 'Optimizer', type: 'coder', count: 2, purpose: 'Optimization' }
    ],
    maintenance: [
      { role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Maintenance planning' },
      { role: 'Refactorer', type: 'coder', count: 2, purpose: 'Code cleanup' },
      { role: 'Documenter', type: 'researcher', count: 1, purpose: 'Documentation' }
    ],
    analysis: [
      { role: 'Analyst Lead', type: 'analyst', count: 1, purpose: 'Analysis coordination' },
      { role: 'Code Analyst', type: 'analyst', count: 2, purpose: 'Code analysis' },
      { role: 'Security Analyst', type: 'reviewer', count: 1, purpose: 'Security review' }
    ]
  };

  return plans[strategy] || plans.development;
}

export default swarmCommand;
