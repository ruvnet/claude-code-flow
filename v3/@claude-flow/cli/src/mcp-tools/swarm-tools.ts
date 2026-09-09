/**
 * Swarm MCP Tools for CLI
 *
 * Tool definitions for swarm coordination with file-based state persistence.
 * Replaces previous stub implementations with real state tracking.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type MCPTool, getProjectCwd } from './types.js';
import { validateIdentifier } from './validate-input.js';
import {
  createApscState,
  isApscAgentEligible,
  normalizeApscConfig,
  recordApscSignal,
  type ApscDecision,
  type ApscSignal,
  type ApscState,
} from '../services/pheromone-adaptive.js';

// Swarm state persistence
const SWARM_DIR = '.claude-flow/swarm';
const SWARM_STATE_FILE = 'swarm-state.json';
const SWARM_STATE_LOCK = 'swarm-state.lock';
const SWARM_LOCK_STALE_MS = 10_000;

interface SwarmState {
  swarmId: string;
  topology: string;
  maxAgents: number;
  status: 'initializing' | 'running' | 'paused' | 'shutting_down' | 'terminated';
  agents: string[];
  tasks: string[];
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /**
   * #1799 — process that initialized this swarm. Used by reconciliation
   * on `loadSwarmStore()` to detect orphan entries whose host process has
   * already exited (common on Windows where backgrounded daemons don't
   * always survive shell exit). Optional for backward compat with
   * pre-#1799 stores.
   */
  pid?: number;
  /** Reason set when status was forced to 'terminated' by reconciliation. */
  terminationReason?: string;
}

interface SwarmStore {
  swarms: Record<string, SwarmState>;
  version: string;
}

export interface ActiveSwarmHealth {
  status: 'healthy' | 'degraded' | 'unknown';
  stateFileExists: boolean;
  swarmId?: string;
  message: string;
}

function getSwarmDir(): string {
  return join(getProjectCwd(), SWARM_DIR);
}

function getSwarmStatePath(): string {
  return join(getSwarmDir(), SWARM_STATE_FILE);
}

function ensureSwarmDir(): void {
  const dir = getSwarmDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * #1799 — return true when `pid` belongs to a live process. process.kill(pid, 0)
 * with signal 0 is the documented liveness probe: ESRCH ⇒ dead, EPERM ⇒ alive
 * but owned by another user (still alive — don't reap), success ⇒ alive.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * #1799 — Walk swarms with status='running' and mark orphans as 'terminated':
 *
 *   - PID-based: if `pid` is set and the process is dead, the swarm is an
 *     orphan (host crashed / shell exited / daemon backgrounded poorly).
 *   - TTL fallback: pre-#1799 entries have no `pid`; reap them when their
 *     `updatedAt` is older than 24h. This is conservative — long-idle but
 *     legitimately running swarms can recover by writing a heartbeat.
 *
 * Mutates `store` in place; returns the count for the caller to decide
 * whether to persist.
 */
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;
function reconcileOrphanSwarms(store: SwarmStore): number {
  let reconciled = 0;
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  for (const swarm of Object.values(store.swarms)) {
    if (swarm.status !== 'running') continue;
    let orphanReason: string | null = null;
    if (typeof swarm.pid === 'number') {
      if (!isPidAlive(swarm.pid)) {
        orphanReason = `host process ${swarm.pid} exited`;
      }
    } else {
      const ageMs = nowMs - new Date(swarm.updatedAt).getTime();
      if (Number.isFinite(ageMs) && ageMs > ORPHAN_TTL_MS) {
        orphanReason = `no pid recorded and heartbeat is ${Math.round(ageMs / 3600000)}h stale`;
      }
    }
    if (orphanReason) {
      swarm.status = 'terminated';
      swarm.terminationReason = orphanReason;
      swarm.updatedAt = nowIso;
      reconciled++;
    }
  }
  return reconciled;
}

// #2085 — exported so `agent-tools.ts agent_spawn` can push into
// `swarm.agents` (the field `swarm_status` reads).
export function loadSwarmStore(): SwarmStore {
  let store: SwarmStore = { swarms: {}, version: '3.0.0' };
  try {
    const path = getSwarmStatePath();
    if (existsSync(path)) {
      store = JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch { /* fall through with default */ }

  // #1799 — reconcile orphans on every load and persist if anything changed.
  // Cheap (process.kill(pid, 0) is sub-millisecond) and means
  // `swarm_status`/`swarm_health` never see ghost "running" entries.
  const reconciled = reconcileOrphanSwarms(store);
  if (reconciled > 0) {
    try { saveSwarmStore(store); } catch { /* best-effort */ }
  }
  return store;
}

export function saveSwarmStore(store: SwarmStore): void {
  ensureSwarmDir();
  const target = getSwarmStatePath();
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* already renamed or never created */ }
    throw error;
  }
}

function withSwarmStoreLock<T>(operation: () => T): T {
  ensureSwarmDir();
  const lockPath = join(getSwarmDir(), SWARM_STATE_LOCK);
  let descriptor: number | undefined;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > SWARM_LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch { /* another writer released it */ }
      Atomics.wait(waiter, 0, 0, 10);
    }
  }
  if (descriptor === undefined) throw new Error('swarm state is busy; retry the outcome update');
  try {
    return operation();
  } finally {
    try { closeSync(descriptor); } catch { /* best effort */ }
    try { unlinkSync(lockPath); } catch { /* best effort */ }
  }
}

// Input validation
const VALID_TOPOLOGIES = new Set([
  'hierarchical', 'mesh', 'hierarchical-mesh', 'ring', 'star', 'hybrid', 'adaptive', 'pheromone-adaptive',
]);

function latestRunningSwarm(store: SwarmStore): SwarmState | undefined {
  return Object.values(store.swarms)
    .filter((swarm) => swarm.status === 'running')
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
}

/** Real, persisted swarm state for aggregate system health reporting. */
export function inspectActiveSwarmHealth(): ActiveSwarmHealth {
  const store = loadSwarmStore();
  const active = latestRunningSwarm(store);
  const stateFileExists = existsSync(getSwarmStatePath());

  if (active) {
    return {
      status: stateFileExists ? 'healthy' : 'degraded',
      stateFileExists,
      swarmId: active.swarmId,
      message: stateFileExists
        ? `Active swarm ${active.swarmId} is running with persisted state`
        : `Active swarm ${active.swarmId} is running but its state file is missing`,
    };
  }

  const latest = Object.values(store.swarms)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
  return {
    status: 'unknown',
    stateFileExists,
    swarmId: latest?.swarmId,
    message: latest
      ? `No active swarm; latest swarm ${latest.swarmId} is ${latest.status}`
      : 'No active swarm found',
  };
}

function apscStateOf(swarm: SwarmState | undefined): ApscState | undefined {
  if (!swarm || swarm.topology !== 'pheromone-adaptive') return undefined;
  const state = swarm.config.apscState as ApscState | undefined;
  return state?.schemaVersion ? state : undefined;
}

/** Shared by hooks_post-task so outcome labels immediately drive APSC. */
export function recordSwarmPheromoneSignal(
  signal: ApscSignal,
): { active: false; reason: string } | { active: true; swarmId: string; decision: ApscDecision } {
  return withSwarmStoreLock(() => {
    const store = loadSwarmStore();
    const swarm = latestRunningSwarm(store);
    const current = apscStateOf(swarm);
    if (!swarm || !current) return { active: false, reason: 'no running pheromone-adaptive swarm' };
    const result = recordApscSignal(current, signal);
    swarm.config.apscState = result.state;
    swarm.updatedAt = new Date().toISOString();
    saveSwarmStore(store);
    return { active: true, swarmId: swarm.swarmId, decision: result.decision };
  });
}

/** Scheduling gate used by agent_execute. Dry-run topologies remain eligible. */
export function pheromoneAgentEligibility(agentId: string): {
  eligible: boolean;
  active: boolean;
  reason?: string;
} {
  const current = apscStateOf(latestRunningSwarm(loadSwarmStore()));
  if (!current) return { eligible: true, active: false };
  const eligible = isApscAgentEligible(current, agentId);
  return {
    eligible,
    active: true,
    reason: eligible ? undefined : 'agent suspended by pheromone-adaptive scheduling gate',
  };
}

export const swarmTools: MCPTool[] = [
  {
    name: 'swarm_init',
    description: 'Initialize a swarm with persistent state tracking Use when native Task tool is wrong because you need multi-agent coordination — topology (hierarchical/mesh/star), consensus (raft/byzantine/gossip/crdt/quorum), shared memory namespace, or anti-drift gates. For independent one-shot subagents, native Task is fine; spawn each separately.',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        topology: { type: 'string', description: 'Swarm topology type (hierarchical, mesh, hierarchical-mesh, ring, star, hybrid, adaptive, pheromone-adaptive)' },
        maxAgents: { type: 'number', description: 'Maximum number of agents (1-50)' },
        strategy: { type: 'string', description: 'Agent strategy (specialized, balanced, adaptive)' },
        config: { type: 'object', description: 'Additional swarm configuration' },
      },
    },
    handler: async (input) => {
      // Validate user-provided input (#1425)
      if (input.topology) {
        const v = validateIdentifier(input.topology, 'topology');
        if (!v.valid) return { success: false, error: v.error };
      }
      if (input.strategy) {
        const v = validateIdentifier(input.strategy, 'strategy');
        if (!v.valid) return { success: false, error: v.error };
      }

      const topology = (input.topology as string) || 'hierarchical-mesh';
      const maxAgents = Math.min(Math.max((input.maxAgents as number) || 15, 1), 50);
      const strategy = (input.strategy as string) || 'specialized';
      const config = (input.config || {}) as Record<string, unknown>;

      if (!VALID_TOPOLOGIES.has(topology)) {
        return {
          success: false,
          error: `Invalid topology: ${topology}. Valid: ${[...VALID_TOPOLOGIES].join(', ')}`,
        };
      }
      let apscState: ApscState | undefined;
      if (topology === 'pheromone-adaptive') {
        try {
          const apscConfig = normalizeApscConfig((config.apsc ?? {}) as Partial<ApscState['config']>);
          if (apscConfig.minActiveAgents > maxAgents) {
            return { success: false, error: 'APSC minActiveAgents cannot exceed maxAgents' };
          }
          apscState = createApscState(apscConfig);
        } catch (error) {
          return { success: false, error: `Invalid APSC config: ${(error as Error).message}` };
        }
      }

      const swarmId = `swarm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();

      const swarmState: SwarmState = {
        swarmId,
        topology,
        maxAgents,
        status: 'running',
        agents: [],
        tasks: [],
        config: {
          topology,
          maxAgents,
          strategy,
          communicationProtocol: (config.communicationProtocol as string) || 'message-bus',
          autoScaling: (config.autoScaling as boolean) ?? true,
          consensusMechanism: (config.consensusMechanism as string) || 'majority',
          ...(apscState ? { apscState } : {}),
        },
        createdAt: now,
        updatedAt: now,
        // A normal CLI invocation exits immediately after creating this
        // coordination record; its PID is therefore not the swarm lifetime.
        // Long-lived hosts may opt into PID ownership explicitly.
        pid: config.trackHostProcess === true ? process.pid : undefined,
      };

      const store = loadSwarmStore();
      store.swarms[swarmId] = swarmState;
      saveSwarmStore(store);

      return {
        success: true,
        swarmId,
        topology,
        strategy,
        maxAgents,
        initializedAt: now,
        config: swarmState.config,
        persisted: true,
        apsc: apscState ? {
          dryRun: apscState.config.dryRun,
          minActiveAgents: apscState.config.minActiveAgents,
          minSamples: apscState.config.minSamples,
        } : undefined,
      };
    },
  },
  {
    name: 'swarm_pheromone_update',
    description: 'Record a normalized per-agent task outcome for a running pheromone-adaptive swarm. Use when a static agent pool is wrong because repeated task evidence should update role-aware EMA fitness and produce a bounded keep/suspend/reactivate decision; native Task has no persistent swarm eligibility gate.',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Stable tracked agent identifier' },
        role: { type: 'string', description: 'Agent role used for role-local normalization' },
        taskSuccess: { type: 'number', description: 'Observed task success in [0,1]' },
        normalizedLatency: { type: 'number', description: 'Latency divided by the configured budget, clamped to [0,1]' },
        consensusAlignment: { type: 'number', description: 'Agreement with the accepted consensus in [0,1]' },
      },
      required: ['agentId', 'role', 'taskSuccess', 'normalizedLatency', 'consensusAlignment'],
    },
    handler: async (input) => {
      try {
        return recordSwarmPheromoneSignal({
          agentId: String(input.agentId),
          role: String(input.role),
          taskSuccess: Number(input.taskSuccess),
          normalizedLatency: Number(input.normalizedLatency),
          consensusAlignment: Number(input.consensusAlignment),
        });
      } catch (error) {
        return { active: false, reason: (error as Error).message };
      }
    },
  },
  {
    name: 'swarm_pheromone_status',
    description: 'Inspect the threshold, safety configuration, per-agent EMA scores, and scheduling eligibility of the active pheromone-adaptive swarm. Use when aggregate swarm status is wrong because calibration requires the exact APSC threshold and per-agent evidence before switching from dry-run to live suspension.',
    category: 'swarm',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const store = loadSwarmStore();
      const swarm = latestRunningSwarm(store);
      const state = apscStateOf(swarm);
      if (!swarm || !state) return { active: false, reason: 'no running pheromone-adaptive swarm' };
      return {
        active: true,
        swarmId: swarm.swarmId,
        threshold: state.threshold,
        round: state.round,
        config: state.config,
        agents: Object.values(state.agents).sort((a, b) => a.agentId.localeCompare(b.agentId)),
      };
    },
  },
  {
    name: 'swarm_status',
    description: 'Get swarm status from persistent state Use when native Task tool is wrong because you need multi-agent coordination — topology (hierarchical/mesh/star), consensus (raft/byzantine/gossip/crdt/quorum), shared memory namespace, or anti-drift gates. For independent one-shot subagents, native Task is fine; spawn each separately.',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'Swarm ID (omit for most recent)' },
      },
    },
    handler: async (input) => {
      // Validate user-provided input (#1425)
      if (input.swarmId) {
        const v = validateIdentifier(input.swarmId, 'swarmId');
        if (!v.valid) return { success: false, error: v.error };
      }

      const store = loadSwarmStore();
      const swarmId = input.swarmId as string;

      if (swarmId && store.swarms[swarmId]) {
        const swarm = store.swarms[swarmId];
        return {
          swarmId: swarm.swarmId,
          status: swarm.status,
          topology: swarm.topology,
          maxAgents: swarm.maxAgents,
          agentCount: swarm.agents.length,
          taskCount: swarm.tasks.length,
          config: swarm.config,
          apsc: apscStateOf(swarm),
          createdAt: swarm.createdAt,
          updatedAt: swarm.updatedAt,
        };
      }

      // Return most recent swarm if no ID specified
      const swarmIds = Object.keys(store.swarms);
      if (swarmIds.length === 0) {
        return {
          status: 'no_swarm',
          message: 'No active swarms. Use swarm_init to create one.',
          totalSwarms: 0,
        };
      }

      const latest = swarmIds
        .map(id => store.swarms[id])
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];

      return {
        swarmId: latest.swarmId,
        status: latest.status,
        topology: latest.topology,
        maxAgents: latest.maxAgents,
        agentCount: latest.agents.length,
        taskCount: latest.tasks.length,
        config: latest.config,
        apsc: apscStateOf(latest),
        createdAt: latest.createdAt,
        updatedAt: latest.updatedAt,
        totalSwarms: swarmIds.length,
      };
    },
  },
  {
    name: 'swarm_shutdown',
    description: 'Shutdown a swarm and update persistent state Use when native Task tool is wrong because you need multi-agent coordination — topology (hierarchical/mesh/star), consensus (raft/byzantine/gossip/crdt/quorum), shared memory namespace, or anti-drift gates. For independent one-shot subagents, native Task is fine; spawn each separately.',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'Swarm ID to shutdown' },
        graceful: { type: 'boolean', description: 'Graceful shutdown (default: true)' },
      },
    },
    handler: async (input) => {
      // Validate user-provided input (#1425)
      if (input.swarmId) {
        const v = validateIdentifier(input.swarmId, 'swarmId');
        if (!v.valid) return { success: false, error: v.error };
      }

      const store = loadSwarmStore();
      const swarmId = input.swarmId as string;

      // Find the swarm
      let target: SwarmState | undefined;
      if (swarmId && store.swarms[swarmId]) {
        target = store.swarms[swarmId];
      } else {
        // Shutdown most recent running swarm
        const running = Object.values(store.swarms)
          .filter(s => s.status === 'running')
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        target = running[0];
      }

      if (!target) {
        return {
          success: false,
          error: swarmId ? `Swarm ${swarmId} not found` : 'No running swarms to shutdown',
        };
      }

      if (target.status === 'terminated') {
        return {
          success: false,
          swarmId: target.swarmId,
          error: 'Swarm already terminated',
        };
      }

      target.status = 'terminated';
      target.updatedAt = new Date().toISOString();
      saveSwarmStore(store);

      return {
        success: true,
        swarmId: target.swarmId,
        terminated: true,
        graceful: (input.graceful as boolean) ?? true,
        agentsTerminated: target.agents.length,
        terminatedAt: target.updatedAt,
      };
    },
  },
  {
    name: 'swarm_health',
    description: 'Check swarm health status with real state inspection Use when native Task tool is wrong because you need multi-agent coordination — topology (hierarchical/mesh/star), consensus (raft/byzantine/gossip/crdt/quorum), shared memory namespace, or anti-drift gates. For independent one-shot subagents, native Task is fine; spawn each separately.',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'Swarm ID to check' },
      },
    },
    handler: async (input) => {
      // Validate user-provided input (#1425)
      if (input.swarmId) {
        const v = validateIdentifier(input.swarmId, 'swarmId');
        if (!v.valid) return { success: false, error: v.error };
      }

      const store = loadSwarmStore();
      const swarmId = input.swarmId as string;

      // Find the swarm
      let target: SwarmState | undefined;
      if (swarmId) {
        target = store.swarms[swarmId];
        if (!target) {
          return {
            status: 'not_found',
            healthy: false,
            checks: [
              { name: 'swarm_exists', status: 'fail', message: `Swarm ${swarmId} not found` },
            ],
            checkedAt: new Date().toISOString(),
          };
        }
      } else {
        const running = Object.values(store.swarms)
          .filter(s => s.status === 'running')
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        target = running[0];
      }

      if (!target) {
        return {
          status: 'no_swarm',
          healthy: false,
          checks: [
            { name: 'swarm_exists', status: 'fail', message: 'No active swarm found' },
          ],
          checkedAt: new Date().toISOString(),
        };
      }

      const isRunning = target.status === 'running';
      const stateFileExists = existsSync(getSwarmStatePath());

      const checks = [
        {
          name: 'coordinator',
          status: isRunning ? 'ok' : 'warn',
          message: isRunning ? 'Coordinator active' : `Swarm status: ${target.status}`,
        },
        {
          name: 'agents',
          status: target.agents.length > 0 ? 'ok' : 'info',
          message: `${target.agents.length} agents registered (max: ${target.maxAgents})`,
        },
        {
          name: 'persistence',
          status: stateFileExists ? 'ok' : 'warn',
          message: stateFileExists ? 'State file persisted' : 'State file missing',
        },
        {
          name: 'topology',
          status: 'ok',
          message: `Topology: ${target.topology}`,
        },
      ];

      const healthy = isRunning && stateFileExists;

      return {
        status: healthy ? 'healthy' : 'degraded',
        healthy,
        swarmId: target.swarmId,
        topology: target.topology,
        agentCount: target.agents.length,
        checks,
        checkedAt: new Date().toISOString(),
      };
    },
  },
];
