/**
 * V3 MCP Connection Pool Manager
 *
 * High-performance connection pooling for MCP server:
 * - Reusable connections to reduce overhead
 * - Configurable bounds (min/max connections, max waiting clients)
 * - Idle timeout handling with automatic eviction
 * - Connection health monitoring
 * - Graceful shutdown support
 * - FIFO fairness for waiting acquirers
 * - Capacity recovery: a waiter is woken whenever a slot opens, whether
 *   that slot comes from a release, a destroy, or eviction.
 *
 * Performance Targets:
 * - Connection acquire: <5ms
 * - Connection release: <1ms
 */

import { EventEmitter } from 'events';
import {
  PooledConnection,
  ConnectionPoolStats,
  ConnectionPoolConfig,
  ConnectionState,
  IConnectionPool,
  ILogger,
  TransportType,
} from './types.js';

/**
 * Default connection pool configuration. Public consumers may override
 * any subset; the unspecified keys fall back to these defaults.
 */
const DEFAULT_POOL_CONFIG: ConnectionPoolConfig = {
  maxConnections: 10,
  minConnections: 2,
  idleTimeout: 30_000, // 30 seconds
  acquireTimeout: 5_000, // 5 seconds
  maxWaitingClients: 50,
  evictionRunInterval: 10_000, // 10 seconds
};

/**
 * How long `drain()` waits for in-flight connections to be released
 * before returning. Independent of `idleTimeout` because drain is a
 * shutdown hook, not steady-state cleanup.
 */
const DRAIN_TIMEOUT_MS = 10_000;
const DRAIN_POLL_INTERVAL_MS = 100;

/**
 * Connection wrapper with lifecycle management.
 */
class ManagedConnection implements PooledConnection {
  public state: ConnectionState = 'idle';
  public lastUsedAt: Date;
  public useCount: number = 0;

  constructor(
    public readonly id: string,
    public readonly transport: TransportType,
    public readonly createdAt: Date = new Date(),
    public metadata?: Record<string, unknown>,
  ) {
    this.lastUsedAt = this.createdAt;
  }

  /** Mark connection as busy and stamp last-used. */
  acquire(): void {
    this.state = 'busy';
    this.lastUsedAt = new Date();
    this.useCount++;
  }

  /** Mark connection as idle and stamp last-used. */
  release(): void {
    this.state = 'idle';
    this.lastUsedAt = new Date();
  }

  /** True iff the connection is idle and has exceeded `idleTimeout`. */
  isExpired(idleTimeout: number): boolean {
    if (this.state !== 'idle') return false;
    return Date.now() - this.lastUsedAt.getTime() > idleTimeout;
  }

  /** True iff the connection has not entered an error/closed terminal state. */
  isHealthy(): boolean {
    return this.state !== 'error' && this.state !== 'closed';
  }
}

/**
 * Internal queue entry for an acquirer that is waiting for a connection
 * to become available.
 *
 * `served` guards against double-fulfilment: the timeout path and the
 * resolve path race naturally, and either one flipping the flag makes
 * the other a no-op. `timer` is captured here so both paths can clear
 * it without leaking timers into the Node event loop.
 */
interface WaitingClient {
  resolve: (connection: PooledConnection) => void;
  reject: (error: Error) => void;
  timestamp: number;
  timer: NodeJS.Timeout;
  served: boolean;
}

/**
 * Connection Pool Manager.
 *
 * Manages a pool of reusable connections for optimal performance.
 *
 * @remarks
 * The pool guarantees FIFO ordering for waiters: once any caller has
 * been queued, subsequent `acquire()` calls join the queue at the back
 * even if an idle connection happens to be available. Without this,
 * a steady stream of new acquirers can starve queued waiters whenever
 * a slot opens up (e.g. from a `destroy()`).
 */
export class ConnectionPool extends EventEmitter implements IConnectionPool {
  private readonly config: ConnectionPoolConfig;
  private readonly connections: Map<string, ManagedConnection> = new Map();
  private readonly waitingClients: WaitingClient[] = [];
  private evictionTimer?: NodeJS.Timeout;
  private connectionCounter: number = 0;
  private isShuttingDown: boolean = false;
  private replenishScheduled: boolean = false;

  // Statistics
  private stats = {
    totalAcquired: 0,
    totalReleased: 0,
    totalCreated: 0,
    totalDestroyed: 0,
    acquireTimeTotal: 0,
    acquireCount: 0,
  };

  constructor(
    config: Partial<ConnectionPoolConfig> = {},
    private readonly logger: ILogger,
    private readonly transportType: TransportType = 'in-process',
  ) {
    super();
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
    this.startEvictionTimer();
    void this.initializeMinConnections();
  }

  // --------------------------------------------------------------------------
  // Public API (IConnectionPool)
  // --------------------------------------------------------------------------

  /**
   * Acquire a connection from the pool.
   *
   * Order of operations:
   * 1. If callers are already queued, the new caller joins the queue at
   *    the back (FIFO; this prevents starvation on capacity recovery).
   * 2. Otherwise, hand back any idle healthy connection.
   * 3. Otherwise, grow the pool up to `maxConnections`.
   * 4. Otherwise, queue and wait for `acquireTimeout`.
   *
   * @throws if the pool is shutting down or the wait queue is full.
   */
  async acquire(): Promise<PooledConnection> {
    const startTime = performance.now();

    if (this.isShuttingDown) {
      throw new Error('Connection pool is shutting down');
    }

    // FIFO: existing waiters take precedence over a new arrival even if
    // an idle slot or growth budget is available right now. Otherwise a
    // steady stream of fresh acquirers can starve callers that are
    // already waiting (e.g. after a destroy() opened a slot).
    if (this.waitingClients.length === 0) {
      const idle = this.findIdleConnection();
      if (idle) {
        return this.handOut(idle, startTime);
      }
      if (this.connections.size < this.config.maxConnections) {
        const fresh = await this.createConnection();
        return this.handOut(fresh, startTime);
      }
    }

    return this.waitForConnection(startTime);
  }

  /**
   * Release a connection back to the pool.
   *
   * If a waiter is queued, the connection is handed directly to them;
   * otherwise it returns to the idle set. Releasing an unknown
   * connection (e.g. one that was already destroyed) is logged and
   * ignored; that path has no recovery to drive.
   */
  release(connection: PooledConnection): void {
    const managed = this.connections.get(connection.id);
    if (!managed) {
      this.logger.warn('Attempted to release unknown connection', { id: connection.id });
      return;
    }

    if (this.serveWaiterWith(managed)) return;

    managed.release();
    this.stats.totalReleased++;

    this.emit('pool:connection:released', { connectionId: connection.id });
    this.logger.debug('Connection released to pool', { id: connection.id });
  }

  /**
   * Destroy a connection (remove from pool).
   *
   * Removing a connection frees a growth slot, so we kick the
   * replenishment loop to (a) hand fresh connections to any queued
   * waiters and (b) restore the minimum-connection invariant. The
   * replenishment is scheduled via microtask coalescing so a burst of
   * destroys does not spawn a stampede of `createConnection()` calls.
   */
  destroy(connection: PooledConnection): void {
    const managed = this.connections.get(connection.id);
    if (!managed) return;

    managed.state = 'closed';
    this.connections.delete(connection.id);
    this.stats.totalDestroyed++;

    this.emit('pool:connection:destroyed', { connectionId: connection.id });
    this.logger.debug('Connection destroyed', { id: connection.id });

    if (!this.isShuttingDown) {
      this.scheduleReplenish();
    }
  }

  /** Snapshot of current pool statistics. Cheap, allocation-light. */
  getStats(): ConnectionPoolStats {
    let idleCount = 0;
    let busyCount = 0;

    for (const connection of this.connections.values()) {
      if (connection.state === 'idle') idleCount++;
      else if (connection.state === 'busy') busyCount++;
    }

    return {
      totalConnections: this.connections.size,
      idleConnections: idleCount,
      busyConnections: busyCount,
      pendingRequests: this.waitingClients.length,
      totalAcquired: this.stats.totalAcquired,
      totalReleased: this.stats.totalReleased,
      totalCreated: this.stats.totalCreated,
      totalDestroyed: this.stats.totalDestroyed,
      avgAcquireTime: this.stats.acquireCount > 0
        ? this.stats.acquireTimeTotal / this.stats.acquireCount
        : 0,
    };
  }

  /**
   * Drain the pool: reject all waiters, then wait up to `DRAIN_TIMEOUT_MS`
   * for in-flight connections to be released. Idempotent.
   */
  async drain(): Promise<void> {
    this.isShuttingDown = true;
    this.logger.info('Draining connection pool');

    while (this.waitingClients.length > 0) {
      const waiter = this.waitingClients.shift()!;
      this.rejectWaiter(waiter, new Error('Connection pool is draining'));
    }

    const startTime = Date.now();
    while (Date.now() - startTime < DRAIN_TIMEOUT_MS) {
      let busyCount = 0;
      for (const connection of this.connections.values()) {
        if (connection.state === 'busy') busyCount++;
      }
      if (busyCount === 0) break;
      await this.delay(DRAIN_POLL_INTERVAL_MS);
    }

    this.logger.info('Connection pool drained');
  }

  /** Stop the eviction timer, drain in-flight, and clear remaining state. */
  async clear(): Promise<void> {
    this.stopEvictionTimer();
    await this.drain();

    for (const connection of this.connections.values()) {
      connection.state = 'closed';
    }

    this.connections.clear();
    this.logger.info('Connection pool cleared');
  }

  /** All connections (for debugging / monitoring). */
  getConnections(): PooledConnection[] {
    return Array.from(this.connections.values());
  }

  /** Healthy iff the pool is not shutting down and meets the floor. */
  isHealthy(): boolean {
    return !this.isShuttingDown && this.connections.size >= this.config.minConnections;
  }

  // --------------------------------------------------------------------------
  // Internal: connection lifecycle
  // --------------------------------------------------------------------------

  private async initializeMinConnections(): Promise<void> {
    const promises: Promise<ManagedConnection>[] = [];
    for (let i = 0; i < this.config.minConnections; i++) {
      promises.push(this.createConnection());
    }
    await Promise.all(promises);
    this.logger.debug('Connection pool initialized', {
      minConnections: this.config.minConnections,
    });
  }

  private async createConnection(): Promise<ManagedConnection> {
    const id = `conn-${++this.connectionCounter}-${Date.now()}`;
    const connection = new ManagedConnection(id, this.transportType);

    this.connections.set(id, connection);
    this.stats.totalCreated++;

    this.emit('pool:connection:created', { connectionId: id });
    this.logger.debug('Connection created', { id, total: this.connections.size });

    return connection;
  }

  private findIdleConnection(): ManagedConnection | undefined {
    for (const connection of this.connections.values()) {
      if (connection.state === 'idle' && connection.isHealthy()) {
        return connection;
      }
    }
    return undefined;
  }

  /**
   * Mark `managed` busy, record stats, and return it. Used by the
   * synchronous fast paths in `acquire()`.
   */
  private handOut(managed: ManagedConnection, startTime: number): PooledConnection {
    managed.acquire();
    this.stats.totalAcquired++;
    this.recordAcquireTime(startTime);
    this.emit('pool:connection:acquired', { connectionId: managed.id });
    this.logger.debug('Connection acquired from pool', { id: managed.id });
    return managed;
  }

  // --------------------------------------------------------------------------
  // Internal: waiter queue
  // --------------------------------------------------------------------------

  private waitForConnection(startTime: number): Promise<PooledConnection> {
    return new Promise((resolve, reject) => {
      if (this.waitingClients.length >= this.config.maxWaitingClients) {
        reject(new Error('Connection pool exhausted - max waiting clients reached'));
        return;
      }

      const client: WaitingClient = {
        resolve: (connection) => {
          this.recordAcquireTime(startTime);
          resolve(connection);
        },
        reject,
        timestamp: Date.now(),
        served: false,
        // Real timer assigned just below so the closure can refer to
        // `client` by reference. The placeholder is replaced before any
        // code path can observe it.
        timer: undefined as unknown as NodeJS.Timeout,
      };

      client.timer = setTimeout(() => {
        if (client.served) return;
        const index = this.waitingClients.indexOf(client);
        if (index !== -1) this.waitingClients.splice(index, 1);
        this.rejectWaiter(
          client,
          new Error(`Connection acquire timeout after ${this.config.acquireTimeout}ms`),
        );
      }, this.config.acquireTimeout);

      this.waitingClients.push(client);
    });
  }

  /**
   * Hand `managed` to the next FIFO waiter, if any.
   *
   * Returns `true` if a waiter was served; the connection is then in
   * the busy state. Returns `false` if the queue was empty, leaving
   * `managed` untouched.
   */
  private serveWaiterWith(managed: ManagedConnection): boolean {
    while (this.waitingClients.length > 0) {
      const waiter = this.waitingClients.shift()!;
      // A waiter whose timeout already fired but is still in the queue
      // (the timer ran first this tick) should be skipped quietly so
      // we don't burn the connection on it.
      if (waiter.served) continue;
      waiter.served = true;
      clearTimeout(waiter.timer);

      managed.acquire();
      this.stats.totalAcquired++;
      this.emit('pool:connection:acquired', { connectionId: managed.id });
      waiter.resolve(managed);
      return true;
    }
    return false;
  }

  /**
   * Reject a waiter, mark it served, and clear its timer. Centralised
   * so every termination path (timeout, drain, replenish failure) uses
   * the same teardown sequence.
   */
  private rejectWaiter(waiter: WaitingClient, error: Error): void {
    if (waiter.served) return;
    waiter.served = true;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  /**
   * Coalesce replenishment kicks across the current microtask. Multiple
   * destroy()/eviction calls in the same tick share a single async
   * pass; this avoids a stampede of `createConnection()` calls when an
   * upstream cascade tears down many connections at once.
   */
  private scheduleReplenish(): void {
    if (this.replenishScheduled) return;
    this.replenishScheduled = true;
    queueMicrotask(() => {
      this.replenishScheduled = false;
      void this.replenish();
    });
  }

  /**
   * Hand fresh connections to any queued waiters until either the queue
   * empties or the pool reaches `maxConnections`, then top the pool up
   * to `minConnections` if it shrank below it.
   *
   * This is the single recovery driver shared by `destroy()` and the
   * eviction sweep; it is idempotent and safe to call repeatedly.
   */
  private async replenish(): Promise<void> {
    if (this.isShuttingDown) return;

    while (
      this.waitingClients.length > 0 &&
      this.connections.size < this.config.maxConnections
    ) {
      let connection: ManagedConnection;
      try {
        connection = await this.createConnection();
      } catch (err) {
        this.logger.error('Failed to create connection for waiter', err as Error);
        // Reject the head waiter so it doesn't sit until acquireTimeout
        // when we already know we cannot satisfy it right now.
        const waiter = this.waitingClients.shift();
        if (waiter) {
          this.rejectWaiter(waiter, err as Error);
        }
        return;
      }

      if (!this.serveWaiterWith(connection)) {
        // Every queued waiter timed out between iteration boundaries.
        // The fresh connection is still useful as an idle resource.
        connection.release();
      }
    }

    while (
      this.connections.size < this.config.minConnections &&
      !this.isShuttingDown
    ) {
      try {
        await this.createConnection();
      } catch (err) {
        this.logger.error('Failed to create replacement connection', err as Error);
        return;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Internal: eviction
  // --------------------------------------------------------------------------

  private startEvictionTimer(): void {
    this.evictionTimer = setInterval(() => {
      this.evictIdleConnections();
    }, this.config.evictionRunInterval);
    // Eviction is bookkeeping; it should not pin the Node event loop
    // open if the hosting process has nothing else to do.
    this.evictionTimer.unref?.();
  }

  private stopEvictionTimer(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = undefined;
    }
  }

  private evictIdleConnections(): void {
    if (this.isShuttingDown) return;

    const toEvict: ManagedConnection[] = [];

    for (const connection of this.connections.values()) {
      if (
        connection.isExpired(this.config.idleTimeout) &&
        this.connections.size - toEvict.length > this.config.minConnections
      ) {
        toEvict.push(connection);
      }
    }

    for (const connection of toEvict) {
      this.destroy(connection);
      this.logger.debug('Evicted idle connection', { id: connection.id });
    }

    if (toEvict.length > 0) {
      this.logger.info('Evicted idle connections', { count: toEvict.length });
    }
  }

  // --------------------------------------------------------------------------
  // Internal: misc
  // --------------------------------------------------------------------------

  private recordAcquireTime(startTime: number): void {
    const duration = performance.now() - startTime;
    this.stats.acquireTimeTotal += duration;
    this.stats.acquireCount++;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create a connection pool with default settings.
 */
export function createConnectionPool(
  config: Partial<ConnectionPoolConfig> = {},
  logger: ILogger,
  transportType: TransportType = 'in-process',
): ConnectionPool {
  return new ConnectionPool(config, logger, transportType);
}
