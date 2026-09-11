/**
 * Regression test — hive-mind_consensus / join / leave authentication gap.
 *
 * hive-mind_consensus's 'vote' action recorded `proposal.votes[voterId] =
 * voteValue` for ANY caller-supplied voterId string, with no check against
 * `state.workers` (the roster populated by hive-mind_join). The required
 * vote threshold (calculateRequiredVotes) is derived from
 * `state.workers.length`, so a single caller could cross that threshold —
 * for raft, bft, AND quorum strategies alike — by voting repeatedly under
 * fabricated ids (`fake-1`, `fake-2`, ...). The existing double-vote guard
 * and Byzantine-flip detector only catch one identity contradicting its OWN
 * prior vote; neither does anything against many distinct forged identities
 * each voting once, which is exactly the Sybil pattern.
 *
 * Review feedback on the first version of this fix (roster-membership check
 * alone) correctly pointed out that hive-mind_join/leave were themselves
 * unauthenticated: an attacker could just legitimately join under fake
 * names, sidestepping the vote-side check entirely. The fix now binds
 * join/leave/vote to a capability token minted once by hive-mind_init
 * (`state.hiveToken`) -- every mutating call must present it, and a denied
 * call makes literally zero state change (no membership write, no vote
 * write), verified below by reloading state fresh from disk (simulating a
 * process restart/reopen) after each denial.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hiveMindTools } from '../src/mcp-tools/hive-mind-tools.js';

function tool(name: string) {
  const t = hiveMindTools.find(t => t.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

// Reads the persisted state file directly -- a fresh read from disk, not
// anything cached in-process, so it stands in for "the process restarted
// and reopened the hive" between a denied call and this check.
function readPersistedState(dir: string): { workers: string[]; consensus: { pending: Array<{ proposalId: string; votes: Record<string, boolean> }> } } {
  const raw = readFileSync(join(dir, '.claude-flow', 'hive-mind', 'state.json'), 'utf-8');
  return JSON.parse(raw);
}

describe('hive-mind_consensus / join / leave capability-token authentication', () => {
  let dir: string;
  let prevCwd: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hive-mind-sybil-'));
    prevCwd = process.env.CLAUDE_FLOW_CWD;
    process.env.CLAUDE_FLOW_CWD = dir;
  });

  afterEach(() => {
    if (prevCwd === undefined) delete process.env.CLAUDE_FLOW_CWD;
    else process.env.CLAUDE_FLOW_CWD = prevCwd;
    rmSync(dir, { recursive: true, force: true });
  });

  async function initHive(strategy: 'raft' | 'byzantine' | 'quorum'): Promise<string> {
    const init = await tool('hive-mind_init').handler({ consensus: strategy }) as any;
    expect(init.success).toBe(true);
    expect(typeof init.hiveToken).toBe('string');
    expect(init.hiveToken.length).toBeGreaterThanOrEqual(32);
    return init.hiveToken as string;
  }

  async function joinWorkers(token: string, count: number) {
    for (let i = 0; i < count; i++) {
      const r = await tool('hive-mind_join').handler({ agentId: `worker-${i}`, hiveToken: token }) as any;
      expect(r.success).toBe(true);
    }
  }

  it('hive-mind_join is denied without the capability token, and makes zero membership change (verified after a fresh state reload)', async () => {
    await initHive('raft');

    const denied = await tool('hive-mind_join').handler({ agentId: 'attacker-1' }) as any;
    expect(denied.success).toBe(false);
    expect(denied.error).toMatch(/hiveToken is required/);

    const deniedWrongToken = await tool('hive-mind_join').handler({ agentId: 'attacker-2', hiveToken: 'not-the-real-token' }) as any;
    expect(deniedWrongToken.success).toBe(false);
    expect(deniedWrongToken.error).toMatch(/Invalid hiveToken/);

    // Simulate restart/reopen: read state.json fresh off disk, not the
    // in-memory object any handler above touched.
    const persisted = readPersistedState(dir);
    expect(persisted.workers).toEqual([]);
    expect(persisted.workers).not.toContain('attacker-1');
    expect(persisted.workers).not.toContain('attacker-2');
  });

  it('hive-mind_join succeeds with the correct token', async () => {
    const token = await initHive('raft');
    const r = await tool('hive-mind_join').handler({ agentId: 'worker-0', hiveToken: token }) as any;
    expect(r.success).toBe(true);
    expect(r.totalWorkers).toBe(1);

    const persisted = readPersistedState(dir);
    expect(persisted.workers).toEqual(['worker-0']);
  });

  it('hive-mind_leave is denied without the capability token, and makes zero membership change (verified after a fresh state reload)', async () => {
    const token = await initHive('raft');
    await joinWorkers(token, 1);

    const denied = await tool('hive-mind_leave').handler({ agentId: 'worker-0' }) as any;
    expect(denied.success).toBe(false);
    expect(denied.error).toMatch(/hiveToken is required/);

    const deniedWrongToken = await tool('hive-mind_leave').handler({ agentId: 'worker-0', hiveToken: 'forged' }) as any;
    expect(deniedWrongToken.success).toBe(false);
    expect(deniedWrongToken.error).toMatch(/Invalid hiveToken/);

    const persisted = readPersistedState(dir);
    expect(persisted.workers).toEqual(['worker-0']);
  });

  it('rejects votes from a voterId that never joined the hive (raft), and denies a vote without the token even from a real workerId', async () => {
    // 5 registered workers -> raft needs floor(5/2)+1 = 3 votes.
    const token = await initHive('raft');
    await joinWorkers(token, 5);

    const propose = await tool('hive-mind_consensus').handler({
      action: 'propose',
      type: 'test',
      value: 'x',
      strategy: 'raft',
    }) as any;
    expect(propose.status).toBe('pending');

    // Attacker casts 3 votes under fabricated ids never joined via hive-mind_join,
    // all with the correct token (proving the roster check, not just the token
    // check, is doing real work here).
    const forged = ['forged-1', 'forged-2', 'forged-3'];
    const forgedResults = [] as any[];
    for (const voterId of forged) {
      forgedResults.push(await tool('hive-mind_consensus').handler({
        action: 'vote',
        proposalId: propose.proposalId,
        vote: true,
        voterId,
        hiveToken: token,
      }));
    }
    for (const r of forgedResults) {
      expect(r.error).toMatch(/not a registered hive-mind worker/);
    }

    // A genuine registered worker voting WITHOUT the token is denied too.
    const noToken = await tool('hive-mind_consensus').handler({
      action: 'vote',
      proposalId: propose.proposalId,
      vote: true,
      voterId: 'worker-0',
    }) as any;
    expect(noToken.error).toMatch(/hiveToken is required/);

    const status = await tool('hive-mind_consensus').handler({
      action: 'status',
      proposalId: propose.proposalId,
    }) as any;
    // Proposal must still be pending -- none of the denied votes counted.
    expect(status.status ?? status.result).not.toBe('approved');

    const persisted = readPersistedState(dir);
    const persistedProposal = persisted.consensus.pending.find(p => p.proposalId === propose.proposalId);
    expect(persistedProposal?.votes ?? {}).toEqual({});
  });

  it('accepts a vote from a voterId that legitimately joined and presents the correct token', async () => {
    const token = await initHive('raft');
    await joinWorkers(token, 3);

    const propose = await tool('hive-mind_consensus').handler({
      action: 'propose',
      type: 'test',
      value: 'x',
      strategy: 'raft',
    }) as any;

    const vote = await tool('hive-mind_consensus').handler({
      action: 'vote',
      proposalId: propose.proposalId,
      vote: true,
      voterId: 'worker-0',
      hiveToken: token,
    }) as any;

    expect(vote.error).toBeUndefined();

    const persisted = readPersistedState(dir);
    const persistedProposal = persisted.consensus.pending.find(p => p.proposalId === propose.proposalId);
    expect(persistedProposal?.votes).toEqual({ 'worker-0': true });
  });

  it('a single caller cannot cross bft quorum by forging distinct voter identities, even while holding the real token', async () => {
    // 3 registered workers -> bft needs floor(3*2/3)+1 = 3 votes (unanimous here).
    const token = await initHive('byzantine');
    await joinWorkers(token, 3);

    const propose = await tool('hive-mind_consensus').handler({
      action: 'propose',
      type: 'test',
      value: 'x',
      strategy: 'bft',
    }) as any;

    for (const voterId of ['sybil-a', 'sybil-b', 'sybil-c']) {
      await tool('hive-mind_consensus').handler({
        action: 'vote',
        proposalId: propose.proposalId,
        vote: true,
        voterId,
        hiveToken: token,
      });
    }

    const status = await tool('hive-mind_consensus').handler({
      action: 'status',
      proposalId: propose.proposalId,
    }) as any;
    expect(status.status ?? status.result).not.toBe('approved');
  });
});
