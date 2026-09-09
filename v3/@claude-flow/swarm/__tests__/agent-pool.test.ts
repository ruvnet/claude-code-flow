/**
 * AgentPool health-check tests
 *
 * Regression coverage for a dead-agent-detection bug: performHealthChecks()
 * used to stamp `lastHeartbeat = now` on every tick for any agent that had
 * not yet crossed the unhealthy threshold. Since updateAgentHeartbeat() has
 * no callers anywhere in this repo, that self-stamping was the *only* thing
 * ever touching lastHeartbeat after agent creation — so timeSinceLastActivity
 * could never grow past one health-check interval, unhealthyThresholdMs
 * (3x the interval) could never be exceeded, and a truly hung/silent agent
 * was never flagged unhealthy or replaced, no matter how long it stayed
 * silent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentPool, createAgentPool } from '../src/agent-pool.js';

describe('AgentPool health checks', () => {
  let pool: AgentPool;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await pool?.shutdown();
    vi.useRealTimers();
  });

  it('flags a silent agent unhealthy once it exceeds healthCheckIntervalMs * 3', async () => {
    pool = createAgentPool({
      name: 'silent-pool',
      minSize: 1,
      maxSize: 1,
      healthCheckIntervalMs: 1000,
    });
    await pool.initialize();

    const [agent] = pool.getAllAgents();
    expect(agent.status).toBe('idle');
    expect(agent.health).toBe(1.0);

    // Advance well past the unhealthy threshold (3 * interval = 3000ms)
    // without ever calling updateAgentHeartbeat() — simulating a hung agent
    // that has genuinely stopped reporting liveness.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    const after = pool.getAgent(agent.id.id);
    expect(after?.status).toBe('error');
    expect(after!.health).toBeLessThan(1.0);
  });

  it('replaces a silent agent once its health is fully depleted', async () => {
    pool = createAgentPool({
      name: 'replace-pool',
      minSize: 1,
      maxSize: 1,
      healthCheckIntervalMs: 1000,
    });
    await pool.initialize();

    const [original] = pool.getAllAgents();
    const replacedEvents: Array<{ oldAgentId: string }> = [];
    pool.on('agent.replaced', (evt: { oldAgentId: string }) => replacedEvents.push(evt));

    // health starts at 1.0 and decrements by 0.2 per unhealthy tick once the
    // threshold (3 intervals) is first exceeded, so it takes threshold + 5
    // more ticks (1.0 -> 0.0 in steps of 0.2) to fully deplete and replace.
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(replacedEvents).toEqual([{ oldAgentId: original.id.id }]);
    // A fresh replacement agent exists and is not the original.
    const ids = pool.getAllAgents().map(a => a.id.id);
    expect(ids).not.toContain(original.id.id);
  });

  it('keeps a genuinely alive agent healthy across many health-check ticks', async () => {
    pool = createAgentPool({
      name: 'alive-pool',
      minSize: 1,
      maxSize: 1,
      healthCheckIntervalMs: 1000,
    });
    await pool.initialize();

    const [agent] = pool.getAllAgents();

    // Real liveness signal, sent on roughly every other tick — well inside
    // the 3-interval grace window each time.
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      pool.updateAgentHeartbeat(agent.id.id);
    }

    const after = pool.getAgent(agent.id.id);
    expect(after?.status).toBe('idle');
    expect(after?.health).toBe(1.0);
  });
});
