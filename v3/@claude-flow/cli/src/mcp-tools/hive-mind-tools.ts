/**
 * Hive-Mind MCP Tools for CLI
 *
 * Tool definitions for collective intelligence and swarm coordination.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type MCPTool, getProjectCwd } from './types.js';
import { validateIdentifier, validateText } from './validate-input.js';

// Storage paths
const STORAGE_DIR = '.claude-flow';
const HIVE_DIR = 'hive-mind';
const HIVE_FILE = 'state.json';

// ADR-093 F3: persist the consensus *strategy* alongside the existing
// `consensus` field (which holds protocol pending/history). #1700 item 4
// reported that init params for consensus didn't round-trip — they didn't,
// because the schema lacked the parameter and the state had nowhere to
// keep it. consensusStrategy fixes both.
type ConsensusStrategyName = 'raft' | 'byzantine' | 'gossip' | 'crdt' | 'quorum';

interface HiveState {
  initialized: boolean;
  // #655 — persist the hiveId generated at init time so every subsequent
  // hive-mind_status call reports the SAME id the user saw at init/spawn,
  // instead of re-deriving a differently-formatted id from createdAt.
  hiveId?: string;
  topology: 'mesh' | 'hierarchical' | 'ring' | 'star';
  consensusStrategy?: ConsensusStrategyName;
  queen?: {
    agentId: string;
    electedAt: string;
    term: number;
  };
  workers: string[];
  consensus: {
    pending: ConsensusProposal[];
    history: ConsensusResult[];
  };
  sharedMemory: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

type ConsensusStrategy = 'bft' | 'raft' | 'quorum';
type QuorumPreset = 'unanimous' | 'majority' | 'supermajority';

interface ConsensusProposal {
  proposalId: string;
  type: string;
  value: unknown;
  proposedBy: string;
  proposedAt: string;
  votes: Record<string, boolean>;
  status: 'pending' | 'approved' | 'rejected';
  strategy: ConsensusStrategy;
  term?: number;              // Raft: term number
  quorumPreset?: QuorumPreset; // Quorum: threshold preset
  byzantineVoters?: string[]; // BFT: detected Byzantine voters
  timeoutAt?: string;         // Raft: timeout for re-proposal
}

interface ConsensusResult {
  proposalId: string;
  type: string;
  result: 'approved' | 'rejected';
  votes: { for: number; against: number };
  decidedAt: string;
  strategy: ConsensusStrategy;
  term?: number;
  byzantineDetected?: string[];
}

/**
 * Calculate required votes for a given strategy and total node count.
 */
function calculateRequiredVotes(
  strategy: ConsensusStrategy,
  totalNodes: number,
  quorumPreset: QuorumPreset = 'majority',
): number {
  if (totalNodes <= 0) return 1;
  switch (strategy) {
    case 'bft':
      // BFT: requires 2/3 + 1 of total nodes
      return Math.floor((totalNodes * 2) / 3) + 1;
    case 'raft':
      // Raft: simple majority
      return Math.floor(totalNodes / 2) + 1;
    case 'quorum':
      switch (quorumPreset) {
        case 'unanimous':
          return totalNodes;
        case 'supermajority':
          return Math.floor((totalNodes * 2) / 3) + 1;
        case 'majority':
        default:
          return Math.floor(totalNodes / 2) + 1;
      }
    default:
      return Math.floor(totalNodes / 2) + 1;
  }
}

/**
 * Detect Byzantine behavior: a voter who has cast conflicting votes
 * across proposals in the same round (same type, overlapping time).
 * Here we check if the voter already voted differently on this proposal
 * (which shouldn't happen if we block double-votes, so this checks
 * cross-proposal conflicting votes for same type within the pending set).
 */
function detectByzantineVoters(
  pending: ConsensusProposal[],
  currentProposal: ConsensusProposal,
  voterId: string,
  newVote: boolean,
): boolean {
  // Check if voter cast opposite votes on proposals of the same type
  for (const p of pending) {
    if (p.proposalId === currentProposal.proposalId) continue;
    if (p.type !== currentProposal.type) continue;
    if (voterId in p.votes && p.votes[voterId] !== newVote) {
      return true; // Conflicting vote detected
    }
  }
  return false;
}

/**
 * Try to resolve a proposal based on its strategy.
 * Returns 'approved', 'rejected', or null if still pending.
 */
function tryResolveProposal(
  proposal: ConsensusProposal,
  totalNodes: number,
): 'approved' | 'rejected' | null {
  const votesFor = Object.values(proposal.votes).filter(v => v).length;
  const votesAgainst = Object.values(proposal.votes).filter(v => !v).length;
  const required = calculateRequiredVotes(
    proposal.strategy,
    totalNodes,
    proposal.quorumPreset,
  );

  if (votesFor >= required) return 'approved';
  if (votesAgainst >= required) return 'rejected';

  // For quorum with 'unanimous', also reject if any vote is against
  if (proposal.strategy === 'quorum' && proposal.quorumPreset === 'unanimous' && votesAgainst > 0) {
    return 'rejected';
  }

  // Check if it's impossible to reach quorum (remaining potential votes can't tip it)
  const totalVotes = Object.keys(proposal.votes).length;
  const remaining = totalNodes - totalVotes;
  if (votesFor + remaining < required && votesAgainst + remaining < required) {
    // Deadlock: neither side can win -- reject
    return 'rejected';
  }

  return null;
}

function getHiveDir(): string {
  return join(getProjectCwd(), STORAGE_DIR, HIVE_DIR);
}

function getHivePath(): string {
  return join(getHiveDir(), HIVE_FILE);
}

function ensureHiveDir(): void {
  const dir = getHiveDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadHiveState(): HiveState {
  try {
    const path = getHivePath();
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Return default state on error
  }
  return {
    initialized: false,
    topology: 'mesh',
    workers: [],
    consensus: { pending: [], history: [] },
    sharedMemory: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function saveHiveState(state: HiveState): void {
  ensureHiveDir();
  state.updatedAt = new Date().toISOString();
  writeFileSync(getHivePath(), JSON.stringify(state, null, 2), 'utf-8');
}

// Import agent store helpers for spawn functionality
import { existsSync as agentStoreExists, readFileSync as readAgentStore, writeFileSync as writeAgentStore, mkdirSync as mkdirAgentStore } from 'node:fs';

function loadAgentStore(): { agents: Record<string, unknown> } {
  const storePath = join(getProjectCwd(), '.claude-flow', 'agents.json');
  try {
    if (agentStoreExists(storePath)) {
      return JSON.parse(readAgentStore(storePath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { agents: {} };
}

function saveAgentStore(store: { agents: Record<string, unknown> }): void {
  const storeDir = join(getProjectCwd(), '.claude-flow');
  if (!agentStoreExists(storeDir)) {
    mkdirAgentStore(storeDir, { recursive: true });
  }
  writeAgentStore(join(storeDir, 'agents.json'), JSON.stringify(store, null, 2), 'utf-8');
}

export const hiveMindTools: MCPTool[] = [
  {
    name: 'hive-mind_spawn',
    description: 'Spawn workers and automatically join them to the hive-mind (combines agent/spawn + hive-mind/join) Use when native Task is wrong because you need queen-led collective intelligence — Byzantine-FT consensus, broadcast across many worker agents, shared memory with bounded conflict. For a single subagent, native Task is fine. Pair with swarm_init first to set topology.',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of workers to spawn (default: 1)', default: 1 },
        role: { type: 'string', enum: ['worker', 'specialist', 'scout'], description: 'Worker role in hive', default: 'worker' },
        agentType: { type: 'string', description: 'Agent type for spawned workers', default: 'worker' },
        prefix: { type: 'string', description: 'Prefix for worker IDs', default: 'hive-worker' },
      },
    },
    handler: async (input) => {
      const state = loadHiveState();

      if (!state.initialized) {
        return { success: false, error: 'Hive-mind not initialized. Run hive-mind/init first.' };
      }

      if (input.agentType) { const v = validateIdentifier(input.agentType as string, 'agentType'); if (!v.valid) return { success: false, error: v.error }; }
      if (input.prefix) { const v = validateIdentifier(input.prefix as string, 'prefix'); if (!v.valid) return { success: false, error: v.error }; }

      const count = Math.min(Math.max(1, (input.count as number) || 1), 20); // Cap at 20
      const role = (input.role as string) || 'worker';
      const agentType = (input.agentType as string) || 'worker';
      const prefix = (input.prefix as string) || 'hive-worker';
      const agentStore = loadAgentStore();

      const spawnedWorkers: Array<{ agentId: string; role: string; joinedAt: string }> = [];

      for (let i = 0; i < count; i++) {
        const agentId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        // Create agent record (like agent/spawn)
        agentStore.agents[agentId] = {
          agentId,
          agentType,
          status: 'idle',
          health: 1.0,
          taskCount: 0,
          config: { role, hiveRole: role },
          createdAt: new Date().toISOString(),
          domain: 'hive-mind',
        };

        // Join to hive-mind (like hive-mind/join)
        if (!state.workers.includes(agentId)) {
          state.workers.push(agentId);
        }

        spawnedWorkers.push({
          agentId,
          role,
          joinedAt: new Date().toISOString(),
        });
      }

      saveAgentStore(agentStore);
      saveHiveState(state);

      return {
        success: true,
        spawned: count,
        workers: spawnedWorkers,
        totalWorkers: state.workers.length,
        hiveStatus: 'active',
        message: `Spawned ${count} worker(s) and joined them to the hive-mind`,
      };
    },
  },
  {
    name: 'hive-mind_init',
    description: 'Initialize the hive-mind collective Use when native Task is wrong because you need queen-led collective intelligence — Byzantine-FT consensus, broadcast across many worker agents, shared memory with bounded conflict. For a single subagent, native Task is fine. Pair with swarm_init first to set topology.',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        topology: { type: 'string', enum: ['mesh', 'hierarchical', 'ring', 'star'], description: 'Network topology' },
        // ADR-093 F3: schema now exposes the consensus strategy so callers
        // can actually request raft / byzantine / quorum / etc. Default
        // matches the documented anti-drift posture (raft).
        consensus: {
          type: 'string',
          enum: ['raft', 'byzantine', 'gossip', 'crdt', 'quorum'],
          description: 'Consensus strategy. Default: raft (anti-drift). Use byzantine for f<n/3 fault tolerance.',
        },
        queenId: { type: 'string', description: 'Initial queen agent ID' },
      },
    },
    handler: async (input) => {
      if (input.queenId) { const v = validateIdentifier(input.queenId as string, 'queenId'); if (!v.valid) return { success: false, error: v.error }; }

      const state = loadHiveState();
      const hiveId = `hive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const queenId = (input.queenId as string) || `queen-${Date.now()}`;

      const requestedConsensus = (input.consensus as ConsensusStrategyName) || 'raft';
      state.initialized = true;
      // #655 — persist the id we're about to return so status/spawn read it
      // back verbatim instead of recomputing a different-looking id.
      state.hiveId = hiveId;
      state.topology = (input.topology as HiveState['topology']) || 'mesh';
      state.consensusStrategy = requestedConsensus;
      state.createdAt = new Date().toISOString();
      state.queen = {
        agentId: queenId,
        electedAt: new Date().toISOString(),
        term: 1,
      };

      saveHiveState(state);

      return {
        success: true,
        hiveId,
        topology: state.topology,
        consensus: state.consensusStrategy,
        queenId,
        status: 'initialized',
        config: {
          topology: state.topology,
          consensus: state.consensusStrategy,
          maxAgents: input.maxAgents || 15,
          persist: input.persist !== false,
          memoryBackend: input.memoryBackend || 'hybrid',
        },
        createdAt: state.createdAt,
      };
    },
  },
  {
    name: 'hive-mind_status',
    description: 'Get hive-mind status Use when native Task is wrong because you need queen-led collective intelligence — Byzantine-FT consensus, broadcast across many worker agents, shared memory with bounded conflict. For a single subagent, native Task is fine. Pair with swarm_init first to set topology.',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Include detailed information' },
      },
    },
    handler: async (input) => {
      const state = loadHiveState();

      const uptime = state.createdAt ? Date.now() - new Date(state.createdAt).getTime() : 0;

      // Load agent store once for all workers
      const agentStore = loadAgentStore();

      // Compute real task metrics from task store
      const taskStorePath = join(getProjectCwd(), '.claude-flow', 'tasks', 'store.json');
      let pendingTaskCount = 0;
      let activeTaskCount = 0;
      let completedTaskCount = 0;
      try {
        if (existsSync(taskStorePath)) {
          const taskStore = JSON.parse(readFileSync(taskStorePath, 'utf-8'));
          for (const task of Object.values(taskStore.tasks || {}) as Array<{ status: string }>) {
            if (task.status === 'pending') pendingTaskCount++;
            else if (task.status === 'in_progress') activeTaskCount++;
            else if (task.status === 'completed') completedTaskCount++;
          }
        }
      } catch { /* ignore */ }

      const workerCount = Math.max(1, state.workers.length);
      const realLoad = activeTaskCount / workerCount;

      // #655 — fall back to the old derived-from-createdAt format only for
      // state files persisted before this field existed; a freshly
      // initialized hive always has state.hiveId set by hive-mind_init.
      const hiveId = state.hiveId ?? `hive-${state.createdAt ? new Date(state.createdAt).getTime() : Date.now()}`;

      const status = {
        // CLI expected fields
        hiveId,
        status: state.initialized ? 'active' : 'offline',
        topology: state.topology,
        // ADR-093 F3: surface the persisted strategy instead of a hardcoded "byzantine".
        consensus: state.consensusStrategy ?? 'byzantine',
        queen: state.queen ? {
          id: state.queen.agentId,
          agentId: state.queen.agentId,
          status: 'active',
          load: Math.round(realLoad * 1000) / 1000,
          tasksQueued: pendingTaskCount,
          electedAt: state.queen.electedAt,
          term: state.queen.term,
        } : { id: 'N/A', status: 'offline', load: 0, tasksQueued: 0 },
        workers: state.workers.map(w => {
          const agent = agentStore.agents[w] as Record<string, unknown> | undefined;
          return {
            id: w,
            type: (agent?.agentType as string) || 'worker',
            status: (agent?.status as string) || 'unknown',
            currentTask: (agent?.currentTask as string) || null,
            tasksCompleted: (agent?.taskCount as number) || 0,
          };
        }),
        metrics: {
          totalTasks: pendingTaskCount + activeTaskCount + completedTaskCount,
          completedTasks: completedTaskCount,
          activeTasks: activeTaskCount,
          pendingTasks: pendingTaskCount,
          failedTasks: 0,
          consensusRounds: state.consensus.history.length,
          memoryUsage: `${Object.keys(state.sharedMemory).length * 2} KB`,
        },
        health: {
          overall: 'healthy',
          queen: state.queen ? 'healthy' : 'unhealthy',
          workers: state.workers.length > 0 ? 'healthy' : 'degraded',
          consensus: 'healthy',
          memory: 'healthy',
        },
        // Additional fields
        id: hiveId,
        initialized: state.initialized,
        workerCount: state.workers.length,
        pendingConsensus: state.consensus.pending.length,
        sharedMemoryKeys: Object.keys(state.sharedMemory).length,
        uptime,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      };

      if (input.verbose) {
        return {
          ...status,
          workerDetails: state.workers,
          consensusHistory: state.consensus.history.slice(-10),
          sharedMemory: state.sharedMemory,
        };
      }

      return status;
    },
  },
  {
    name: 'hive-mind_join',
    description: 'Join an agent to the hive-mind Use when native Task is wrong because you need queen-led collective intelligence — Byzantine-FT consensus, broadcast across many worker agents, shared memory with bounded conflict. For a single subagent, native Task is fine. Pair with swarm_init first to set topology.',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID to join' },
        role: { type: 'string', enum: ['worker', 'specialist', 'scout'], description: 'Agent role in hive' },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      const state = loadHiveState();
      const agentId = input.agentId as string;

      { const v = validateIdentifier(agentId, 'agentId'); if (!v.valid) return { success: false, error: v.error }; }

      if (!state.initialized) {
        return { success: false, error: 'Hive-mind not initialized' };
      }

      if (!state.workers.includes(agentId)) {
        state.workers.push(agentId);
        saveHiveState(state);
      }

      return {
        success: true,
        agentId,
        role: input.role || 'worker',
        totalWorkers: state.workers.length,
        joinedAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'hive-mind_leave',
    description: 'Remove an agent from the hive-mind Use when native Task is wrong because you need queen-led collective intelligence — Byzantine-FT consensus, broadcast across many worker agents, shared memory with bounded conflict. For a single subagent, native Task is fine. Pair with swarm_init first to set topology.',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID to remove' },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      const state = loadHiveState();
      const agentId = input.agentId as string;

      { const v = validateIdentifier(agentId, 'agentId'); if (!v.valid) return { success: false, agentId, error: v.error }; }

      const index = state.workers.indexOf(agentId);
      if (index > -1) {
        state.workers.splice(index, 1);
        saveHiveState(state);
        return {
          success: true,
          agentId,
          leftAt: new Date().toISOString(),
          remainingWorkers: state.workers.length,
        };
      }

      return { success: false, agentId, error: 'Agent not in hive' };
    },
  },
  {
    name: 'hive-mind_consensus',
    description: 'Propose or vote on consensus with BFT, Raft, or Quorum strategies Use when native Task is wrong because you need queen-led collective intelligence — Byzantine-FT consensus, broadcast across many worker agents, shared memory with bounded conflict. For a single subagent, native Task is fine. Pair with swarm_init first to set topology.',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['propose', 'vote', 'status', 'list'], description: 'Consensus action' },
        proposalId: { type: 'string', description: 'Proposal ID (for vote/status)' },
        type: { type: 'string', description: 'Proposal type (for propose)' },
        value: { description: 'Proposal value (for propose)' },
        vote: { type: 'boolean', description: 'Vote (true=for, false=against)' },
        voterId: { type: 'string', description: 'Voter agent ID' },
        strategy: { type: 'string', enum: ['bft', 'raft', 'quorum'], description: 'Consensus strategy (default: raft)' },
        quorumPreset: { type: 'string', enum: ['unanimous', 'majority', 'supermajority'], description: 'Quorum threshold preset (for quorum strategy, default: majority)' },
        term: { type: 'number', description: 'Term number (for raft strategy)' },
        timeoutMs: { type: 'number', description: 'Timeout in ms for raft re-proposal (default: 30000)' },
      },
      required: ['action'],
    },
    handler: async (input) => {
      if (input.proposalId) { const v = validateIdentifier(input.proposalId as string, 'proposalId'); if (!v.valid) return { action: input.action, error: v.error }; }
      if (input.voterId) { const v = validateIdentifier(input.voterId as string, 'voterId'); if (!v.valid) return { action: input.action, error: v.error }; }
      if (input.type) { const v = validateText(input.type as string, 'type'); if (!v.valid) return { action: input.action, error: v.error }; }

      const state = loadHiveState();
      const action = input.action as string;
      const strategy = (input.strategy as ConsensusStrategy) || 'raft';
      const totalNodes = state.workers.length || 1;

      if (action === 'propose') {
        const proposalId = `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const quorumPreset = (input.quorumPreset as QuorumPreset) || 'majority';
        const term = (input.term as number) || (state.queen?.term ?? 1);
        const timeoutMs = (input.timeoutMs as number) || 30000;

        // Raft: check if there's already a pending proposal for this term
        if (strategy === 'raft') {
          const existingTermProposal = state.consensus.pending.find(
            p => p.strategy === 'raft' && p.term === term && p.status === 'pending',
          );
          if (existingTermProposal) {
            return {
              action,
              error: `Raft term ${term} already has a pending proposal: ${existingTermProposal.proposalId}. Wait for resolution or use a higher term.`,
              existingProposalId: existingTermProposal.proposalId,
              term,
            };
          }
        }

        const required = calculateRequiredVotes(strategy, totalNodes, quorumPreset);

        const proposal: ConsensusProposal = {
          proposalId,
          type: (input.type as string) || 'general',
          value: input.value,
          proposedBy: (input.voterId as string) || 'system',
          proposedAt: new Date().toISOString(),
          votes: {},
          status: 'pending',
          strategy,
          term: strategy === 'raft' ? term : undefined,
          quorumPreset: strategy === 'quorum' ? quorumPreset : undefined,
          byzantineVoters: strategy === 'bft' ? [] : undefined,
          timeoutAt: strategy === 'raft' ? new Date(Date.now() + timeoutMs).toISOString() : undefined,
        };

        state.consensus.pending.push(proposal);
        saveHiveState(state);

        return {
          action,
          proposalId,
          type: proposal.type,
          strategy,
          status: 'pending',
          required,
          totalNodes,
          term: proposal.term,
          quorumPreset: proposal.quorumPreset,
          timeoutAt: proposal.timeoutAt,
        };
      }

      if (action === 'vote') {
        const proposal = state.consensus.pending.find(p => p.proposalId === input.proposalId);
        if (!proposal) {
          return { action, error: 'Proposal not found or already resolved' };
        }

        const voterId = input.voterId as string;
        if (!voterId) {
          return { action, error: 'voterId is required for voting' };
        }

        const voteValue = input.vote as boolean;
        const proposalStrategy = proposal.strategy || 'raft';
        const required = calculateRequiredVotes(
          proposalStrategy,
          totalNodes,
          proposal.quorumPreset,
        );

        // Prevent double-voting
        if (voterId in proposal.votes) {
          const previousVote = proposal.votes[voterId];
          if (previousVote === voteValue) {
            return {
              action,
              error: `Voter ${voterId} has already cast the same vote on this proposal`,
              proposalId: proposal.proposalId,
              existingVote: previousVote,
            };
          }
          // Conflicting vote from same voter
          if (proposalStrategy === 'bft') {
            // BFT: detect as Byzantine behavior
            if (!proposal.byzantineVoters) proposal.byzantineVoters = [];
            if (!proposal.byzantineVoters.includes(voterId)) {
              proposal.byzantineVoters.push(voterId);
            }
            // Remove their vote entirely -- Byzantine voter is excluded
            delete proposal.votes[voterId];
            saveHiveState(state);

            return {
              action,
              proposalId: proposal.proposalId,
              voterId,
              byzantineDetected: true,
              message: `Byzantine behavior detected: voter ${voterId} attempted conflicting vote. Vote invalidated.`,
              byzantineVoters: proposal.byzantineVoters,
              status: proposal.status,
            };
          }
          if (proposalStrategy === 'raft') {
            // Raft: only one vote per node per term, reject the change
            return {
              action,
              error: `Raft: voter ${voterId} already voted in term ${proposal.term}. Cannot change vote.`,
              proposalId: proposal.proposalId,
              term: proposal.term,
            };
          }
          // Quorum: reject double-vote
          return {
            action,
            error: `Voter ${voterId} has already voted on this proposal`,
            proposalId: proposal.proposalId,
          };
        }

        // BFT: check for cross-proposal Byzantine behavior
        if (proposalStrategy === 'bft') {
          const isByzantine = detectByzantineVoters(
            state.consensus.pending,
            proposal,
            voterId,
            voteValue,
          );
          if (isByzantine) {
            if (!proposal.byzantineVoters) proposal.byzantineVoters = [];
            if (!proposal.byzantineVoters.includes(voterId)) {
              proposal.byzantineVoters.push(voterId);
            }
            saveHiveState(state);
            return {
              action,
              proposalId: proposal.proposalId,
              voterId,
              byzantineDetected: true,
              message: `Byzantine behavior detected: voter ${voterId} cast conflicting votes across proposals of same type. Vote rejected.`,
              byzantineVoters: proposal.byzantineVoters,
              status: proposal.status,
            };
          }
        }

        // Record the vote
        proposal.votes[voterId] = voteValue;

        const votesFor = Object.values(proposal.votes).filter(v => v).length;
        const votesAgainst = Object.values(proposal.votes).filter(v => !v).length;

        // Try to resolve
        const resolution = tryResolveProposal(proposal, totalNodes);
        let resolved = false;

        if (resolution !== null) {
          resolved = true;
          proposal.status = resolution;
          state.consensus.history.push({
            proposalId: proposal.proposalId,
            type: proposal.type,
            result: resolution,
            votes: { for: votesFor, against: votesAgainst },
            decidedAt: new Date().toISOString(),
            strategy: proposalStrategy,
            term: proposal.term,
            byzantineDetected: proposal.byzantineVoters?.length ? proposal.byzantineVoters : undefined,
          });
          state.consensus.pending = state.consensus.pending.filter(
            p => p.proposalId !== proposal.proposalId,
          );
        }

        saveHiveState(state);

        // Persist consensus result in AgentDB for searchable history
        if (resolved) {
          try {
            const bridge = await import('../memory/memory-bridge.js');
            await bridge.bridgeStoreEntry({
              key: `consensus-${proposal.proposalId}`,
              value: JSON.stringify({
                proposalId: proposal.proposalId,
                type: proposal.type,
                strategy: proposalStrategy,
                status: proposal.status,
                votes: proposal.votes,
                resolvedAt: new Date().toISOString(),
              }),
              namespace: 'hive-consensus',
              tags: [proposal.type, proposalStrategy || 'raft', proposal.status],
            });
          } catch { /* AgentDB not available — JSON store is primary */ }
        }

        return {
          action,
          proposalId: proposal.proposalId,
          voterId,
          vote: voteValue,
          strategy: proposalStrategy,
          votesFor,
          votesAgainst,
          required,
          totalNodes,
          resolved,
          result: resolved ? resolution : undefined,
          status: proposal.status,
          term: proposal.term,
          byzantineVoters: proposal.byzantineVoters?.length ? proposal.byzantineVoters : undefined,
        };
      }

      if (action === 'status') {
        const proposal = state.consensus.pending.find(p => p.proposalId === input.proposalId);
        if (!proposal) {
          // Check history
          const historical = state.consensus.history.find(h => h.proposalId === input.proposalId);
          if (historical) {
            return { action, ...historical, historical: true, resolved: true };
          }
          return { action, error: 'Proposal not found' };
        }

        const votesFor = Object.values(proposal.votes).filter(v => v).length;
        const votesAgainst = Object.values(proposal.votes).filter(v => !v).length;
        const proposalStrategy = proposal.strategy || 'raft';
        const required = calculateRequiredVotes(
          proposalStrategy,
          totalNodes,
          proposal.quorumPreset,
        );

        // Raft: check timeout
        let timedOut = false;
        if (proposalStrategy === 'raft' && proposal.timeoutAt) {
          timedOut = new Date().getTime() > new Date(proposal.timeoutAt).getTime();
        }

        return {
          action,
          proposalId: proposal.proposalId,
          type: proposal.type,
          strategy: proposalStrategy,
          status: proposal.status,
          votesFor,
          votesAgainst,
          totalVotes: Object.keys(proposal.votes).length,
          required,
          totalNodes,
          resolved: false,
          term: proposal.term,
          quorumPreset: proposal.quorumPreset,
          byzantineVoters: proposal.byzantineVoters?.length ? proposal.byzantineVoters : undefined,
          timedOut,
          timeoutAt: proposal.timeoutAt,
          hint: timedOut ? `Raft timeout reached. Re-propose with term ${(proposal.term || 1) + 1}.` : undefined,
        };
      }

      if (action === 'list') {
        return {
          action,
          pending: state.consensus.pending.map(p => ({
            proposalId: p.proposalId,
            type: p.type,
            strategy: p.strategy || 'raft',
            proposedAt: p.proposedAt,
            totalVotes: Object.keys(p.votes).length,
            required: calculateRequiredVotes(
              p.strategy || 'raft',
              totalNodes,
              p.quorumPreset,
            ),
            term: p.term,
            status: p.status,
          })),
          recentHistory: state.consensus.history.slice(-5),
        };
      }

      return { action, error: 'Unknown action' };
    },
  },
  {
    name: 'hive-mind_broadcast',
    description: 'Broadcast message to all workers Use when native Task is wrong because you need queen-led collective intelligence — Byzantine-FT consensus, broadcast across many worker agents, shared memory with bounded conflict. For a single subagent, native Task is fine. Pair with swarm_init first to set topology.',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to broadcast' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'Message priority' },
        fromId: { type: 'string', description: 'Sender agent ID' },
      },
      required: ['message'],
    },
    handler: async (input) => {
      const state = loadHiveState();

      if (!state.initialized) {
        return { success: false, error: 'Hive-mind not initialized' };
      }

      { const v = validateText(input.message as string, 'message'); if (!v.valid) return { success: false, error: v.error }; }
      if (input.fromId) { const v = validateIdentifier(input.fromId as string, 'fromId'); if (!v.valid) return { success: false, error: v.error }; }

      const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Store in shared memory
      const messages = (state.sharedMemory.broadcasts as Array<unknown>) || [];
      messages.push({
        messageId,
        message: input.message,
        priority: input.priority || 'normal',
        fromId: input.fromId || 'system',
        timestamp: new Date().toISOString(),
      });

      // Keep only last 100 broadcasts
      state.sharedMemory.broadcasts = messages.slice(-100);
      saveHiveState(state);

      return {
        success: true,
        messageId,
        recipients: state.workers.length,
        priority: input.priority || 'normal',
        broadcastAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'hive-mind_shutdown',
    description: 'Shutdown the hive-mind and terminate all workers Use when native Task is wrong because you need queen-led collective intelligence — Byzantine-FT consensus, broadcast across many worker agents, shared memory with bounded conflict. For a single subagent, native Task is fine. Pair with swarm_init first to set topology.',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        graceful: { type: 'boolean', description: 'Graceful shutdown (wait for pending tasks)', default: true },
        force: { type: 'boolean', description: 'Force immediate shutdown', default: false },
      },
    },
    handler: async (input) => {
      const state = loadHiveState();

      if (!state.initialized) {
        return { success: false, error: 'Hive-mind not initialized or already shut down' };
      }

      const graceful = input.graceful !== false;
      const force = input.force === true;
      const workerCount = state.workers.length;
      const pendingConsensus = state.consensus.pending.length;

      // If graceful and there are pending consensus items, warn (unless forced)
      if (graceful && pendingConsensus > 0 && !force) {
        return {
          success: false,
          error: `Cannot gracefully shutdown with ${pendingConsensus} pending consensus items. Use force: true to override.`,
          pendingConsensus,
          workerCount,
        };
      }

      // Clear workers from agent store
      const agentStore = loadAgentStore();
      for (const workerId of state.workers) {
        if (agentStore.agents[workerId]) {
          delete agentStore.agents[workerId];
        }
      }
      saveAgentStore(agentStore);

      // Reset hive state
      const shutdownTime = new Date().toISOString();
      const previousQueen = state.queen?.agentId;

      state.initialized = false;
      state.queen = undefined;
      state.workers = [];
      state.consensus.pending = [];
      // Keep history for reference
      state.sharedMemory = {};
      saveHiveState(state);

      return {
        success: true,
        shutdownAt: shutdownTime,
        graceful,
        workersTerminated: workerCount,
        previousQueen,
        consensusCleared: pendingConsensus,
        message: `Hive-mind shutdown complete. ${workerCount} workers terminated.`,
      };
    },
  },
  {
    name: 'hive-mind_memory',
    description: 'Access hive shared memory Use when native Task is wrong because you need queen-led collective intelligence — Byzantine-FT consensus, broadcast across many worker agents, shared memory with bounded conflict. For a single subagent, native Task is fine. Pair with swarm_init first to set topology.',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'delete', 'list'], description: 'Memory action' },
        key: { type: 'string', description: 'Memory key' },
        value: { description: 'Value to store (for set)' },
      },
      required: ['action'],
    },
    handler: async (input) => {
      if (input.key) { const v = validateIdentifier(input.key as string, 'key'); if (!v.valid) return { action: input.action, error: v.error }; }

      const state = loadHiveState();
      const action = input.action as string;
      const key = input.key as string;

      if (action === 'get') {
        if (!key) return { action, error: 'Key required' };
        return {
          action,
          key,
          value: state.sharedMemory[key],
          exists: key in state.sharedMemory,
        };
      }

      if (action === 'set') {
        if (!key) return { action, error: 'Key required' };
        state.sharedMemory[key] = input.value;
        saveHiveState(state);

        // Also store in AgentDB for searchable hive memory
        try {
          const bridge = await import('../memory/memory-bridge.js');
          await bridge.bridgeStoreEntry({
            key: `hive-memory-${key}`,
            value: JSON.stringify(input.value),
            namespace: 'hive-memory',
          });
        } catch { /* AgentDB not available */ }

        return {
          action,
          key,
          success: true,
          updatedAt: new Date().toISOString(),
        };
      }

      if (action === 'delete') {
        if (!key) return { action, error: 'Key required' };
        const existed = key in state.sharedMemory;
        delete state.sharedMemory[key];
        saveHiveState(state);
        return {
          action,
          key,
          deleted: existed,
        };
      }

      if (action === 'list') {
        return {
          action,
          keys: Object.keys(state.sharedMemory),
          count: Object.keys(state.sharedMemory).length,
        };
      }

      return { action, error: 'Unknown action' };
    },
  },
  {
    // #1916: `ruflo hive-mind optimize-memory` referenced an unregistered
    // `hive-mind_optimize-memory` tool. Best-effort today: prunes obviously-
    // empty shared-memory keys and reports the before/after counts; pattern
    // quality consolidation is a follow-up (it belongs in the intelligence
    // pipeline / agentdb curator, not here).
    name: 'hive-mind_optimize-memory',
    description: 'Compact the hive-mind shared-memory store (drops null/empty keys) and report before/after pattern counts. Use when native conversation memory is wrong because you need the queen-led collective\'s persisted shared state cleaned up between phases. For one-shot scratch state, no tool needed. (Pattern-quality consolidation is delegated to the intelligence pipeline — this only does the cheap structural pass for now.)',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        qualityThreshold: { type: 'number', description: 'Quality threshold for pattern retention (advisory — not enforced yet)' },
      },
    },
    handler: async () => {
      const t0 = Date.now();
      const state = loadHiveState();
      if (!state.initialized) return { optimized: false, error: 'Hive-mind not initialized', before: { patterns: 0, memory: '0' }, after: { patterns: 0, memory: '0' }, removed: 0, consolidated: 0, timeMs: 0 };
      const beforeKeys = Object.keys(state.sharedMemory);
      const before = beforeKeys.length;
      for (const k of beforeKeys) {
        const v = state.sharedMemory[k];
        if (v === null || v === undefined || (typeof v === 'object' && v !== null && Object.keys(v as object).length === 0)) {
          delete state.sharedMemory[k];
        }
      }
      const after = Object.keys(state.sharedMemory).length;
      const removed = before - after;
      if (removed > 0) saveHiveState(state);
      const sizeStr = (n: number) => `${Buffer.byteLength(JSON.stringify(state.sharedMemory))}B (~${n} keys)`;
      return {
        optimized: removed > 0,
        before: { patterns: before, memory: `~${before} keys` },
        after: { patterns: after, memory: sizeStr(after) },
        removed,
        consolidated: 0,
        timeMs: Date.now() - t0,
        note: 'structural compaction only; pattern-quality consolidation is delegated to the intelligence pipeline (#1916 follow-up)',
      };
    },
  },
];
