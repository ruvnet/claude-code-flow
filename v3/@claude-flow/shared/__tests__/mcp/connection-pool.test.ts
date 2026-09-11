/**
 * Vitest suite for the V3 MCP connection pool.
 *
 * Covers the waiter-queue lifecycle (the original implementation never
 * exercised it under capacity changes) plus the basic acquire/release
 * paths so the regression surface is explicit.
 *
 * Each test uses small `acquireTimeout` and `evictionRunInterval`
 * values so a slow waiter is observable inside vitest's default
 * timeout. None of the tests rely on real wall-clock pauses longer
 * than a few hundred milliseconds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionPool } from '../../src/mcp/connection-pool.js';
import type {
  ConnectionPoolConfig,
  ILogger,
  PooledConnection,
} from '../../src/mcp/types.js';

const createLogger = (): ILogger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const FAST_CONFIG: Partial<ConnectionPoolConfig> = {
  minConnections: 0,
  maxConnections: 2,
  maxWaitingClients: 8,
  acquireTimeout: 200,
  idleTimeout: 50,
  evictionRunInterval: 10_000,
};

async function fillPool(pool: ConnectionPool, n: number): Promise<PooledConnection[]> {
  const acquired: PooledConnection[] = [];
  for (let i = 0; i < n; i++) acquired.push(await pool.acquire());
  return acquired;
}

describe('ConnectionPool', () => {
  let logger: ILogger;
  let pool: ConnectionPool;

  beforeEach(() => {
    logger = createLogger();
  });

  afterEach(async () => {
    if (!pool) return;
    // Defensive teardown: any busy connection a test forgot to release
    // would otherwise pin `clear()` for the full DRAIN_TIMEOUT_MS. We
    // destroy those before clearing so the harness fails fast on test
    // assertions rather than hook timeouts.
    for (const connection of pool.getConnections()) {
      if (connection.state === 'busy') pool.destroy(connection);
    }
    await pool.clear();
  });

  // -------------------------------------------------------------------------
  // Basic acquire / release
  // -------------------------------------------------------------------------

  it('hands out a fresh connection up to maxConnections', async () => {
    pool = new ConnectionPool(FAST_CONFIG, logger);
    const a = await pool.acquire();
    const b = await pool.acquire();
    expect(a.id).not.toBe(b.id);
    expect(pool.getStats().busyConnections).toBe(2);
    expect(pool.getStats().totalConnections).toBe(2);
  });

  it('reuses a released connection on the next acquire', async () => {
    pool = new ConnectionPool(FAST_CONFIG, logger);
    const a = await pool.acquire();
    pool.release(a);
    const b = await pool.acquire();
    expect(b.id).toBe(a.id);
  });

  it('emits lifecycle events for acquire and release', async () => {
    pool = new ConnectionPool(FAST_CONFIG, logger);
    const events: string[] = [];
    pool.on('pool:connection:acquired', () => events.push('acquired'));
    pool.on('pool:connection:released', () => events.push('released'));
    const a = await pool.acquire();
    pool.release(a);
    expect(events).toEqual(['acquired', 'released']);
  });

  it('rejects acquires after the pool starts shutting down', async () => {
    pool = new ConnectionPool(FAST_CONFIG, logger);
    void pool.drain();
    await expect(pool.acquire()).rejects.toThrow(/shutting down/);
  });

  // -------------------------------------------------------------------------
  // Waiter timeout discipline
  // -------------------------------------------------------------------------

  it('times out a queued waiter after acquireTimeout if no connection is freed', async () => {
    pool = new ConnectionPool(FAST_CONFIG, logger);
    const held = await fillPool(pool, 2);
    await expect(pool.acquire()).rejects.toThrow(/acquire timeout/);
    for (const c of held) pool.release(c);
  });

  it('clears the waiter timeout when release fulfils the waiter', async () => {
    vi.useFakeTimers();
    try {
      pool = new ConnectionPool({ ...FAST_CONFIG, acquireTimeout: 5_000 }, logger);
      const held = await fillPool(pool, 2);

      let outcome: 'resolved' | 'rejected' | 'pending' = 'pending';
      const waiting = pool
        .acquire()
        .then(() => {
          outcome = 'resolved';
        })
        .catch(() => {
          outcome = 'rejected';
        });

      // Let the wait register before releasing.
      await Promise.resolve();
      pool.release(held[0]);
      await waiting;

      expect(outcome).toBe('resolved');

      // If the timer was cleared, advancing past acquireTimeout should
      // not produce a stale rejection or any further outcome change.
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      expect(outcome).toBe('resolved');

      pool.release(held[1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears every waiter timeout when drain rejects the queue', async () => {
    vi.useFakeTimers();
    try {
      pool = new ConnectionPool({ ...FAST_CONFIG, acquireTimeout: 5_000 }, logger);
      await fillPool(pool, 2);

      const outcomes: string[] = [];
      const a = pool.acquire().catch((err: Error) => outcomes.push(`a:${err.message}`));
      const b = pool.acquire().catch((err: Error) => outcomes.push(`b:${err.message}`));
      await Promise.resolve();

      // Drain rejects both waiters with the draining message.
      const draining = pool.drain();
      await a;
      await b;
      expect(outcomes).toEqual(['a:Connection pool is draining', 'b:Connection pool is draining']);

      // If the timers were cleared, advancing past acquireTimeout adds nothing.
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      expect(outcomes).toHaveLength(2);

      // Drain still completes (no busy connections by this point).
      await draining;
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // FIFO and capacity recovery
  // -------------------------------------------------------------------------

  it('serves waiters in FIFO order on release', async () => {
    pool = new ConnectionPool(FAST_CONFIG, logger);
    const initial = await fillPool(pool, 2);

    const order: number[] = [];
    const first = pool.acquire().then((c) => {
      order.push(1);
      return c;
    });
    const second = pool.acquire().then((c) => {
      order.push(2);
      return c;
    });
    await Promise.resolve();

    // Releasing the first held connection must serve waiter #1.
    pool.release(initial[0]);
    const firstWinner = await first;
    expect(firstWinner.id).toBe(initial[0].id);

    // Releasing the second held connection must serve waiter #2.
    pool.release(initial[1]);
    const secondWinner = await second;
    expect(secondWinner.id).toBe(initial[1].id);

    expect(order).toEqual([1, 2]);

    pool.release(firstWinner);
    pool.release(secondWinner);
  });

  it('does not let a fresh acquire jump ahead of a queued waiter (FIFO)', async () => {
    pool = new ConnectionPool(FAST_CONFIG, logger);
    const held = await fillPool(pool, 2);

    const order: string[] = [];
    const queued = pool.acquire().then(() => order.push('queued'));
    await Promise.resolve();

    // A new caller must observe the queue and join it, not steal the
    // first opening. We start it AFTER the first waiter is in place.
    const newcomer = pool.acquire().then(() => order.push('newcomer'));
    await Promise.resolve();

    pool.release(held[0]);
    await queued;
    pool.release(held[1]);
    await newcomer;

    expect(order).toEqual(['queued', 'newcomer']);
  });

  it('wakes a queued waiter when destroy() opens a slot', async () => {
    pool = new ConnectionPool(FAST_CONFIG, logger);
    const held = await fillPool(pool, 2);

    let waiterResolved = false;
    const waiting = pool.acquire().then((conn) => {
      waiterResolved = true;
      pool.release(conn);
    });
    await Promise.resolve();

    // Pool capacity opens via destroy, not release. The waiter must
    // still be served instead of timing out.
    pool.destroy(held[0]);
    await waiting;
    expect(waiterResolved).toBe(true);

    pool.release(held[1]);
  });

  it('only creates as many fresh connections as queued waiters need on destroy', async () => {
    pool = new ConnectionPool(FAST_CONFIG, logger);
    const held = await fillPool(pool, 2);
    const beforeCreated = pool.getStats().totalCreated;

    const waiting = pool.acquire();
    await Promise.resolve();

    pool.destroy(held[0]);
    const granted = await waiting;
    expect(granted.id).not.toBe(held[0].id);

    // One fresh connection created for the waiter; no extras.
    expect(pool.getStats().totalCreated).toBe(beforeCreated + 1);

    pool.release(granted);
    pool.release(held[1]);
  });

  // -------------------------------------------------------------------------
  // Bounds and stats
  // -------------------------------------------------------------------------

  it('rejects acquires that overflow the maxWaitingClients ceiling', async () => {
    pool = new ConnectionPool({ ...FAST_CONFIG, maxWaitingClients: 1 }, logger);
    const held = await fillPool(pool, 2);

    const first = pool.acquire();
    await Promise.resolve();
    await expect(pool.acquire()).rejects.toThrow(/max waiting clients/);

    pool.release(held[0]);
    await first;
    pool.release(held[1]);
  });

  it('exposes pendingRequests in stats while a waiter is queued', async () => {
    pool = new ConnectionPool(FAST_CONFIG, logger);
    const held = await fillPool(pool, 2);

    const waiting = pool.acquire().catch(() => {});
    await Promise.resolve();
    expect(pool.getStats().pendingRequests).toBe(1);

    for (const c of held) pool.release(c);
    await waiting;
    expect(pool.getStats().pendingRequests).toBe(0);
  });

  it('release on an unknown connection logs a warning and does not throw', async () => {
    pool = new ConnectionPool(FAST_CONFIG, logger);
    pool.release({ id: 'ghost' } as PooledConnection);
    expect(logger.warn).toHaveBeenCalledWith(
      'Attempted to release unknown connection',
      expect.objectContaining({ id: 'ghost' }),
    );
  });
});
