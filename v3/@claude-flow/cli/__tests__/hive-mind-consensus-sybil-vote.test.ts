/**
 * Regression test — hive-mind_consensus Sybil-vote authentication gap.
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
 * Fix: reject a vote whose voterId is not in state.workers, fail-closed,
 * before the vote is recorded or counted toward the threshold.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hiveMindTools } from '../src/mcp-tools/hive-mind-tools.js';

function tool(name: string) {
  const t = hiveMindTools.find(t => t.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

describe('hive-mind_consensus vote authentication (Sybil-vote gap)', () => {
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

  async function initWithWorkers(strategy: 'raft' | 'byzantine' | 'quorum', workerCount: number) {
    await tool('hive-mind_init').handler({ consensus: strategy });
    for (let i = 0; i < workerCount; i++) {
      await tool('hive-mind_join').handler({ agentId: `worker-${i}` });
    }
  }

  it('rejects votes from a voterId that never joined the hive (raft)', async () => {
    // 5 registered workers -> raft needs floor(5/2)+1 = 3 votes.
    await initWithWorkers('raft', 5);

    const propose = await tool('hive-mind_consensus').handler({
      action: 'propose',
      type: 'test',
      value: 'x',
      strategy: 'raft',
    }) as any;
    expect(propose.status).toBe('pending');

    // Attacker casts 3 votes under fabricated ids never joined via hive-mind_join.
    const forged = ['forged-1', 'forged-2', 'forged-3'];
    const results = [] as any[];
    for (const voterId of forged) {
      results.push(await tool('hive-mind_consensus').handler({
        action: 'vote',
        proposalId: propose.proposalId,
        vote: true,
        voterId,
      }));
    }

    for (const r of results) {
      expect(r.error).toMatch(/not a registered hive-mind worker/);
    }

    const status = await tool('hive-mind_consensus').handler({
      action: 'status',
      proposalId: propose.proposalId,
    }) as any;
    // Proposal must still be pending -- none of the forged votes counted.
    expect(status.status ?? status.result).not.toBe('approved');
  });

  it('accepts a vote from a voterId that legitimately joined via hive-mind_join', async () => {
    await initWithWorkers('raft', 3);

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
    }) as any;

    expect(vote.error).toBeUndefined();
  });

  it('a single caller cannot cross bft quorum by forging distinct voter identities', async () => {
    // 3 registered workers -> bft needs floor(3*2/3)+1 = 3 votes (unanimous here).
    await initWithWorkers('byzantine', 3);

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
      });
    }

    const status = await tool('hive-mind_consensus').handler({
      action: 'status',
      proposalId: propose.proposalId,
    }) as any;
    expect(status.status ?? status.result).not.toBe('approved');
  });
});
