/**
 * Claims MCP Tools for CLI
 *
 * Implements MCP tools for ADR-016: Collaborative Issue Claims
 * Provides programmatic access to claim operations for MCP clients.
 *
 * @module @claude-flow/cli/mcp-tools/claims
 */

import { type MCPTool, getProjectCwd } from './types.js';
import { validateIdentifier, validateText } from './validate-input.js';

// Inline claim service since we can't import external modules
interface Claimant {
  type: 'human' | 'agent';
  userId?: string;
  name?: string;
  agentId?: string;
  agentType?: string;
}

type ClaimStatus = 'active' | 'paused' | 'handoff-pending' | 'review-requested' | 'blocked' | 'stealable' | 'completed';
type StealReason = 'overloaded' | 'stale' | 'blocked-timeout' | 'voluntary';

interface IssueClaim {
  issueId: string;
  claimant: Claimant;
  claimedAt: string;
  status: ClaimStatus;
  statusChangedAt: string;
  expiresAt?: string;
  handoffTo?: Claimant;
  handoffReason?: string;
  blockReason?: string;
  progress: number;
  context?: string;
}

interface ClaimsStore {
  claims: Record<string, IssueClaim>;
  stealable: Record<string, { reason: StealReason; stealableAt: string; preferredTypes?: string[]; progress: number; context?: string }>;
  contests: Record<string, { originalClaimant: Claimant; contestedAt: string; reason: string }>;
}

// File-based persistence
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const CLAIMS_DIR = '.claude-flow/claims';
const CLAIMS_FILE = 'claims.json';

function getClaimsPath(): string {
  return resolve(getProjectCwd(), CLAIMS_DIR, CLAIMS_FILE);
}

function ensureClaimsDir(): void {
  const dir = resolve(getProjectCwd(), CLAIMS_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadClaims(): ClaimsStore {
  try {
    const path = getClaimsPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    // Return empty store on error
  }
  return { claims: {}, stealable: {}, contests: {} };
}

function saveClaims(store: ClaimsStore): void {
  ensureClaimsDir();
  writeFileSync(getClaimsPath(), JSON.stringify(store, null, 2), 'utf-8');
}

function formatClaimant(claimant: Claimant): string {
  return claimant.type === 'human'
    ? `human:${claimant.userId}:${claimant.name}`
    : `agent:${claimant.agentId}:${claimant.agentType}`;
}

function parseClaimant(str: string): Claimant | null {
  const parts = str.split(':');
  if (parts[0] === 'human' && parts.length >= 3) {
    return { type: 'human', userId: parts[1], name: parts.slice(2).join(':') };
  } else if (parts[0] === 'agent' && parts.length >= 3) {
    return { type: 'agent', agentId: parts[1], agentType: parts[2] };
  }
  return null;
}

export const claimsTools: MCPTool[] = [
  {
    name: 'claims_claim',
    description: 'Claim an issue for work (human or agent) Use when nothing native covers per-agent capability gating — Claude Code agents have file-system access by default. Pair claims_grant + claims_check before letting an agent run privileged ops. For trusted in-session work, no claims call is needed.',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID or GitHub issue number',
        },
        claimant: {
          type: 'string',
          description: 'Claimant identifier (e.g., "human:user-1:Alice" or "agent:coder-1:coder")',
        },
        context: {
          type: 'string',
          description: 'Optional context about the work approach',
        },
      },
      required: ['issueId', 'claimant'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const claimantStr = input.claimant as string;
      const context = input.context as string | undefined;

      { const v = validateIdentifier(issueId, 'issueId'); if (!v.valid) return { success: false, error: v.error }; }
      { const v = validateText(claimantStr, 'claimant'); if (!v.valid) return { success: false, error: v.error }; }
      if (context) { const v = validateText(context, 'context'); if (!v.valid) return { success: false, error: v.error }; }

      const claimant = parseClaimant(claimantStr);
      if (!claimant) {
        return { success: false, error: 'Invalid claimant format. Use "human:userId:name" or "agent:agentId:agentType"' };
      }

      const store = loadClaims();

      // Check if already claimed
      if (store.claims[issueId]) {
        const existing = store.claims[issueId];
        return {
          success: false,
          error: `Issue already claimed by ${formatClaimant(existing.claimant)}`,
          existingClaim: existing,
        };
      }

      const now = new Date().toISOString();
      const claim: IssueClaim = {
        issueId,
        claimant,
        claimedAt: now,
        status: 'active',
        statusChangedAt: now,
        progress: 0,
        context,
      };

      store.claims[issueId] = claim;
      saveClaims(store);

      return {
        success: true,
        claim,
        message: `Issue ${issueId} claimed by ${formatClaimant(claimant)}`,
      };
    },
  },

  {
    name: 'claims_release',
    description: 'Release a claim on an issue Use when nothing native covers per-agent capability gating — Claude Code agents have file-system access by default. Pair claims_grant + claims_check before letting an agent run privileged ops. For trusted in-session work, no claims call is needed.',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID to release',
        },
        claimant: {
          type: 'string',
          description: 'Claimant identifier (must match current owner)',
        },
        reason: {
          type: 'string',
          description: 'Reason for releasing',
        },
      },
      required: ['issueId', 'claimant'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const claimantStr = input.claimant as string;
      const reason = input.reason as string | undefined;

      { const v = validateIdentifier(issueId, 'issueId'); if (!v.valid) return { success: false, error: v.error }; }
      { const v = validateText(claimantStr, 'claimant'); if (!v.valid) return { success: false, error: v.error }; }
      if (reason) { const v = validateText(reason, 'reason'); if (!v.valid) return { success: false, error: v.error }; }

      const claimant = parseClaimant(claimantStr);
      if (!claimant) {
        return { success: false, error: 'Invalid claimant format' };
      }

      const store = loadClaims();
      const claim = store.claims[issueId];

      if (!claim) {
        return { success: false, error: 'Issue is not claimed' };
      }

      // Verify ownership
      if (formatClaimant(claim.claimant) !== formatClaimant(claimant)) {
        return { success: false, error: 'Only the current claimant can release' };
      }

      delete store.claims[issueId];
      delete store.stealable[issueId];
      saveClaims(store);

      return {
        success: true,
        message: `Issue ${issueId} released`,
        reason,
        previousClaim: claim,
      };
    },
  },

  {
    name: 'claims_handoff',
    description: 'Request handoff of an issue to another claimant Use when nothing native covers per-agent capability gating — Claude Code agents have file-system access by default. Pair claims_grant + claims_check before letting an agent run privileged ops. For trusted in-session work, no claims call is needed.',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID to handoff',
        },
        from: {
          type: 'string',
          description: 'Current claimant identifier',
        },
        to: {
          type: 'string',
          description: 'Target claimant identifier',
        },
        reason: {
          type: 'string',
          description: 'Reason for handoff',
        },
        progress: {
          type: 'number',
          description: 'Current progress percentage (0-100)',
        },
      },
      required: ['issueId', 'from', 'to'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const fromStr = input.from as string;
      const toStr = input.to as string;
      const reason = input.reason as string | undefined;
      const progress = (input.progress as number) || 0;

      { const v = validateIdentifier(issueId, 'issueId'); if (!v.valid) return { success: false, error: v.error }; }
      { const v = validateText(fromStr, 'from'); if (!v.valid) return { success: false, error: v.error }; }
      { const v = validateText(toStr, 'to'); if (!v.valid) return { success: false, error: v.error }; }
      if (reason) { const v = validateText(reason, 'reason'); if (!v.valid) return { success: false, error: v.error }; }

      const from = parseClaimant(fromStr);
      const to = parseClaimant(toStr);

      if (!from || !to) {
        return { success: false, error: 'Invalid claimant format' };
      }

      const store = loadClaims();
      const claim = store.claims[issueId];

      if (!claim) {
        return { success: false, error: 'Issue is not claimed' };
      }

      if (formatClaimant(claim.claimant) !== formatClaimant(from)) {
        return { success: false, error: 'Only the current claimant can request handoff' };
      }

      const now = new Date().toISOString();
      claim.status = 'handoff-pending';
      claim.statusChangedAt = now;
      claim.handoffTo = to;
      claim.handoffReason = reason;
      claim.progress = progress;

      store.claims[issueId] = claim;
      saveClaims(store);

      return {
        success: true,
        claim,
        message: `Handoff requested from ${formatClaimant(from)} to ${formatClaimant(to)}`,
      };
    },
  },

  {
    name: 'claims_accept-handoff',
    description: 'Accept a pending handoff Use when nothing native covers per-agent capability gating — Claude Code agents have file-system access by default. Pair claims_grant + claims_check before letting an agent run privileged ops. For trusted in-session work, no claims call is needed.',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID with pending handoff',
        },
        claimant: {
          type: 'string',
          description: 'Claimant accepting the handoff',
        },
      },
      required: ['issueId', 'claimant'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const claimantStr = input.claimant as string;

      { const v = validateIdentifier(issueId, 'issueId'); if (!v.valid) return { success: false, error: v.error }; }
      { const v = validateText(claimantStr, 'claimant'); if (!v.valid) return { success: false, error: v.error }; }

      const claimant = parseClaimant(claimantStr);
      if (!claimant) {
        return { success: false, error: 'Invalid claimant format' };
      }

      const store = loadClaims();
      const claim = store.claims[issueId];

      if (!claim) {
        return { success: false, error: 'Issue is not claimed' };
      }

      if (claim.status !== 'handoff-pending') {
        return { success: false, error: 'No pending handoff for this issue' };
      }

      if (!claim.handoffTo || formatClaimant(claim.handoffTo) !== formatClaimant(claimant)) {
        return { success: false, error: 'You are not the target of this handoff' };
      }

      const previousOwner = claim.claimant;
      const now = new Date().toISOString();

      claim.claimant = claimant;
      claim.status = 'active';
      claim.statusChangedAt = now;
      claim.handoffTo = undefined;
      claim.handoffReason = undefined;

      store.claims[issueId] = claim;
      saveClaims(store);

      return {
        success: true,
        claim,
        previousOwner,
        message: `Handoff accepted. ${formatClaimant(claimant)} now owns issue ${issueId}`,
      };
    },
  },

  {
    name: 'claims_status',
    description: 'Update claim status Use when nothing native covers per-agent capability gating — Claude Code agents have file-system access by default. Pair claims_grant + claims_check before letting an agent run privileged ops. For trusted in-session work, no claims call is needed.',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID',
        },
        status: {
          type: 'string',
          description: 'New status',
          enum: ['active', 'paused', 'blocked', 'review-requested', 'completed'],
        },
        note: {
          type: 'string',
          description: 'Status note or reason',
        },
        progress: {
          type: 'number',
          description: 'Current progress percentage',
        },
      },
      required: ['issueId', 'status'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const status = input.status as ClaimStatus;
      const note = input.note as string | undefined;
      const progress = input.progress as number | undefined;

      { const v = validateIdentifier(issueId, 'issueId'); if (!v.valid) return { success: false, error: v.error }; }
      if (note) { const v = validateText(note, 'note'); if (!v.valid) return { success: false, error: v.error }; }

      const store = loadClaims();
      const claim = store.claims[issueId];

      if (!claim) {
        return { success: false, error: 'Issue is not claimed' };
      }

      const now = new Date().toISOString();
      claim.status = status;
      claim.statusChangedAt = now;
      if (status === 'blocked') {
        claim.blockReason = note;
      }
      if (progress !== undefined) {
        claim.progress = Math.min(100, Math.max(0, progress));
      }

      store.claims[issueId] = claim;
      saveClaims(store);

      return {
        success: true,
        claim,
        message: `Issue ${issueId} status updated to ${status}`,
      };
    },
  },

  {
    name: 'claims_list',
    description: 'List all claims or filter by criteria Use when nothing native covers per-agent capability gating — Claude Code agents have file-system access by default. Pair claims_grant + claims_check before letting an agent run privileged ops. For trusted in-session work, no claims call is needed.',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status',
          enum: ['active', 'paused', 'blocked', 'stealable', 'completed', 'all'],
        },
        claimant: {
          type: 'string',
          description: 'Filter by claimant',
        },
        agentType: {
          type: 'string',
          description: 'Filter by agent type',
        },
      },
    },
    handler: async (input) => {
      const status = input.status as string | undefined;
      const claimantFilter = input.claimant as string | undefined;
      const agentType = input.agentType as string | undefined;

      if (claimantFilter) { const v = validateText(claimantFilter, 'claimant'); if (!v.valid) return { success: false, error: v.error }; }
      if (agentType) { const v = validateIdentifier(agentType, 'agentType'); if (!v.valid) return { success: false, error: v.error }; }

      const store = loadClaims();
      let claims = Object.values(store.claims);

      if (status && status !== 'all') {
        claims = claims.filter(c => c.status === status);
      }

      if (claimantFilter) {
        claims = claims.filter(c => formatClaimant(c.claimant).includes(claimantFilter));
      }

      if (agentType) {
        claims = claims.filter(c =>
          c.claimant.type === 'agent' && c.claimant.agentType === agentType
        );
      }

      return {
        success: true,
        claims,
        count: claims.length,
        stealableCount: Object.keys(store.stealable).length,
      };
    },
  },

  {
    name: 'claims_mark-stealable',
    description: 'Mark an issue as stealable by other agents Use when nothing native covers per-agent capability gating — Claude Code agents have file-system access by default. Pair claims_grant + claims_check before letting an agent run privileged ops. For trusted in-session work, no claims call is needed.',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID to mark stealable',
        },
        reason: {
          type: 'string',
          description: 'Reason for marking stealable',
          enum: ['overloaded', 'stale', 'blocked-timeout', 'voluntary'],
        },
        preferredTypes: {
          type: 'array',
          description: 'Preferred agent types to steal',
          items: { type: 'string' },
        },
        context: {
          type: 'string',
          description: 'Handoff context for the stealer',
        },
      },
      required: ['issueId', 'reason'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const reason = input.reason as StealReason;
      const preferredTypes = input.preferredTypes as string[] | undefined;
      const context = input.context as string | undefined;

      { const v = validateIdentifier(issueId, 'issueId'); if (!v.valid) return { success: false, error: v.error }; }
      if (context) { const v = validateText(context, 'context'); if (!v.valid) return { success: false, error: v.error }; }

      const store = loadClaims();
      const claim = store.claims[issueId];

      if (!claim) {
        return { success: false, error: 'Issue is not claimed' };
      }

      const now = new Date().toISOString();
      claim.status = 'stealable';
      claim.statusChangedAt = now;

      store.stealable[issueId] = {
        reason,
        stealableAt: now,
        preferredTypes,
        progress: claim.progress,
        context,
      };

      store.claims[issueId] = claim;
      saveClaims(store);

      return {
        success: true,
        claim,
        stealableInfo: store.stealable[issueId],
        message: `Issue ${issueId} marked as stealable (${reason})`,
      };
    },
  },

  {
    name: 'claims_steal',
    description: 'Steal a stealable issue Use when nothing native covers per-agent capability gating — Claude Code agents have file-system access by default. Pair claims_grant + claims_check before letting an agent run privileged ops. For trusted in-session work, no claims call is needed.',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID to steal',
        },
        stealer: {
          type: 'string',
          description: 'Claimant stealing the issue',
        },
      },
      required: ['issueId', 'stealer'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const stealerStr = input.stealer as string;

      { const v = validateIdentifier(issueId, 'issueId'); if (!v.valid) return { success: false, error: v.error }; }
      { const v = validateText(stealerStr, 'stealer'); if (!v.valid) return { success: false, error: v.error }; }

      const stealer = parseClaimant(stealerStr);
      if (!stealer) {
        return { success: false, error: 'Invalid claimant format' };
      }

      const store = loadClaims();
      const claim = store.claims[issueId];
      const stealableInfo = store.stealable[issueId];

      if (!claim) {
        return { success: false, error: 'Issue is not claimed' };
      }

      if (!stealableInfo) {
        return { success: false, error: 'Issue is not stealable' };
      }

      // Check preferred types
      if (stealableInfo.preferredTypes && stealableInfo.preferredTypes.length > 0) {
        if (stealer.type === 'agent' && !stealableInfo.preferredTypes.includes(stealer.agentType!)) {
          return {
            success: false,
            error: `Issue prefers agent types: ${stealableInfo.preferredTypes.join(', ')}`,
          };
        }
      }

      const previousOwner = claim.claimant;
      const now = new Date().toISOString();

      claim.claimant = stealer;
      claim.status = 'active';
      claim.statusChangedAt = now;
      claim.context = stealableInfo.context;

      delete store.stealable[issueId];
      store.claims[issueId] = claim;
      saveClaims(store);

      return {
        success: true,
        claim,
        previousOwner,
        stealableInfo,
        message: `Issue ${issueId} stolen by ${formatClaimant(stealer)}`,
      };
    },
  },

  {
    name: 'claims_stealable',
    description: 'List all stealable issues Use when nothing native covers per-agent capability gating — Claude Code agents have file-system access by default. Pair claims_grant + claims_check before letting an agent run privileged ops. For trusted in-session work, no claims call is needed.',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        agentType: {
          type: 'string',
          description: 'Filter by preferred agent type',
        },
      },
    },
    handler: async (input) => {
      const agentType = input.agentType as string | undefined;

      if (agentType) { const v = validateIdentifier(agentType, 'agentType'); if (!v.valid) return { success: false, error: v.error }; }

      const store = loadClaims();
      let stealableIssues = Object.entries(store.stealable).map(([issueId, info]) => ({
        issueId,
        ...info,
        claim: store.claims[issueId],
      }));

      if (agentType) {
        stealableIssues = stealableIssues.filter(s =>
          !s.preferredTypes || s.preferredTypes.length === 0 || s.preferredTypes.includes(agentType)
        );
      }

      return {
        success: true,
        stealable: stealableIssues,
        count: stealableIssues.length,
      };
    },
  },

  {
    name: 'claims_load',
    description: 'Get agent load information Use when nothing native covers per-agent capability gating — Claude Code agents have file-system access by default. Pair claims_grant + claims_check before letting an agent run privileged ops. For trusted in-session work, no claims call is needed.',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Specific agent ID (optional)',
        },
        agentType: {
          type: 'string',
          description: 'Filter by agent type',
        },
      },
    },
    handler: async (input) => {
      const agentId = input.agentId as string | undefined;
      const agentType = input.agentType as string | undefined;

      if (agentId) { const v = validateIdentifier(agentId, 'agentId'); if (!v.valid) return { success: false, error: v.error }; }
      if (agentType) { const v = validateIdentifier(agentType, 'agentType'); if (!v.valid) return { success: false, error: v.error }; }

      const store = loadClaims();
      const claims = Object.values(store.claims);

      // Group claims by agent
      const agentLoads = new Map<string, {
        agentId: string;
        agentType: string;
        claims: IssueClaim[];
        blockedCount: number;
      }>();

      for (const claim of claims) {
        if (claim.claimant.type !== 'agent') continue;

        const key = claim.claimant.agentId!;
        if (!agentLoads.has(key)) {
          agentLoads.set(key, {
            agentId: key,
            agentType: claim.claimant.agentType!,
            claims: [],
            blockedCount: 0,
          });
        }

        const load = agentLoads.get(key)!;
        load.claims.push(claim);
        if (claim.status === 'blocked') {
          load.blockedCount++;
        }
      }

      let loads = Array.from(agentLoads.values());

      if (agentId) {
        loads = loads.filter(l => l.agentId === agentId);
      }

      if (agentType) {
        loads = loads.filter(l => l.agentType === agentType);
      }

      const result = loads.map(l => ({
        agentId: l.agentId,
        agentType: l.agentType,
        claimCount: l.claims.length,
        maxClaims: 5, // Default max
        utilization: l.claims.length / 5,
        blockedCount: l.blockedCount,
        claims: l.claims.map(c => ({
          issueId: c.issueId,
          status: c.status,
          progress: c.progress,
        })),
      }));

      return {
        success: true,
        loads: result,
        totalAgents: result.length,
        totalClaims: claims.filter(c => c.claimant.type === 'agent').length,
        avgUtilization: result.length > 0
          ? result.reduce((sum, l) => sum + l.utilization, 0) / result.length
          : 0,
      };
    },
  },

  {
    name: 'claims_board',
    description: 'Get a visual board view of all claims Use when nothing native covers per-agent capability gating — Claude Code agents have file-system access by default. Pair claims_grant + claims_check before letting an agent run privileged ops. For trusted in-session work, no claims call is needed.',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const store = loadClaims();
      const claims = Object.values(store.claims);

      const byStatus: Record<string, IssueClaim[]> = {
        active: [],
        paused: [],
        blocked: [],
        'handoff-pending': [],
        'review-requested': [],
        stealable: [],
        completed: [],
      };

      for (const claim of claims) {
        if (byStatus[claim.status]) {
          byStatus[claim.status].push(claim);
        }
      }

      const humanClaims = claims.filter(c => c.claimant.type === 'human');
      const agentClaims = claims.filter(c => c.claimant.type === 'agent');

      return {
        success: true,
        board: {
          active: byStatus.active.map(c => ({ issueId: c.issueId, claimant: formatClaimant(c.claimant), progress: c.progress })),
          paused: byStatus.paused.map(c => ({ issueId: c.issueId, claimant: formatClaimant(c.claimant) })),
          blocked: byStatus.blocked.map(c => ({ issueId: c.issueId, claimant: formatClaimant(c.claimant), reason: c.blockReason })),
          'handoff-pending': byStatus['handoff-pending'].map(c => ({ issueId: c.issueId, from: formatClaimant(c.claimant), to: c.handoffTo ? formatClaimant(c.handoffTo) : null })),
          'review-requested': byStatus['review-requested'].map(c => ({ issueId: c.issueId, claimant: formatClaimant(c.claimant) })),
          stealable: byStatus.stealable.map(c => ({ issueId: c.issueId, claimant: formatClaimant(c.claimant) })),
          completed: byStatus.completed.map(c => ({ issueId: c.issueId, claimant: formatClaimant(c.claimant) })),
        },
        summary: {
          total: claims.length,
          active: byStatus.active.length,
          blocked: byStatus.blocked.length,
          stealable: byStatus.stealable.length,
          humanClaims: humanClaims.length,
          agentClaims: agentClaims.length,
        },
      };
    },
  },

  {
    name: 'claims_rebalance',
    description: 'Suggest or apply load rebalancing across agents Use when nothing native covers per-agent capability gating — Claude Code agents have file-system access by default. Pair claims_grant + claims_check before letting an agent run privileged ops. For trusted in-session work, no claims call is needed.',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: {
          type: 'boolean',
          description: 'Preview rebalancing without applying',
          default: true,
        },
        targetUtilization: {
          type: 'number',
          description: 'Target utilization (0-1)',
          default: 0.7,
        },
      },
    },
    handler: async (input) => {
      const dryRun = input.dryRun !== false;
      const targetUtilization = (input.targetUtilization as number) || 0.7;

      const store = loadClaims();
      const claims = Object.values(store.claims);

      // Group by agent
      const agentLoads = new Map<string, { agentId: string; agentType: string; claims: IssueClaim[] }>();

      for (const claim of claims) {
        if (claim.claimant.type !== 'agent') continue;

        const key = claim.claimant.agentId!;
        if (!agentLoads.has(key)) {
          agentLoads.set(key, { agentId: key, agentType: claim.claimant.agentType!, claims: [] });
        }
        agentLoads.get(key)!.claims.push(claim);
      }

      const loads = Array.from(agentLoads.values());
      const maxClaims = 5;
      const avgLoad = loads.length > 0
        ? loads.reduce((sum, l) => sum + l.claims.length, 0) / loads.length
        : 0;

      const overloaded = loads.filter(l => l.claims.length > maxClaims * targetUtilization * 1.5);
      const underloaded = loads.filter(l => l.claims.length < maxClaims * targetUtilization * 0.5);

      const suggestions: Array<{ issueId: string; from: string; to: string; reason: string }> = [];

      for (const over of overloaded) {
        // Find low-progress claims to redistribute
        const movable = over.claims
          .filter(c => c.progress < 25 && c.status === 'active')
          .slice(0, over.claims.length - Math.ceil(maxClaims * targetUtilization));

        for (const claim of movable) {
          const target = underloaded.find(u => u.agentType === over.agentType && u.claims.length < maxClaims);
          if (target) {
            suggestions.push({
              issueId: claim.issueId,
              from: `agent:${over.agentId}:${over.agentType}`,
              to: `agent:${target.agentId}:${target.agentType}`,
              reason: 'Load balancing',
            });
          }
        }
      }

      // When not a dry run, execute the suggested moves
      if (!dryRun) {
        for (const suggestion of suggestions) {
          const claim = store.claims[suggestion.issueId];
          if (claim) {
            const newOwner = parseClaimant(suggestion.to);
            if (newOwner) {
              claim.claimant = newOwner;
              claim.statusChangedAt = new Date().toISOString();
              store.claims[suggestion.issueId] = claim;
            }
          }
        }
        saveClaims(store);
      }

      return {
        success: true,
        dryRun,
        suggestions,
        metrics: {
          totalAgents: loads.length,
          avgLoad,
          overloadedCount: overloaded.length,
          underloadedCount: underloaded.length,
          targetUtilization,
        },
        message: dryRun
          ? `Found ${suggestions.length} rebalancing opportunities (dry run)`
          : `Applied ${suggestions.length} rebalancing moves`,
      };
    },
  },
];

export default claimsTools;
