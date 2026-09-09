/**
 * V3 Agent Pool
 * Manages agent lifecycle, pooling, and auto-scaling
 */

import { EventEmitter } from 'events';
import {
  AgentState,
  AgentType,
  AgentStatus,
  AgentCapabilities,
  AgentMetrics,
  AgentPoolConfig,
  AgentPoolState,
  IAgentPool,
  SWARM_CONSTANTS,
} from './types.js';

interface PooledAgent {
  agent: AgentState;
  acquiredAt?: Date;
  lastUsed: Date;
  usageCount: number;
}

export class AgentPool extends EventEmitter implements IAgentPool {
  private config: AgentPoolConfig;
  private pooledAgents: Map<string, PooledAgent> = new Map();
  private available: Set<string> = new Set();
  private busy: Set<string> = new Set();
  private pendingScale: number = 0;
  private lastScaleOperation?: Date;
  private healthCheckInterval?: NodeJS.Timeout;
  private agentCounter: number = 0;

  constructor(config: Partial<AgentPoolConfig> = {}) {
    super();
    this.config = {
      name: config.name ?? 'default-pool',
      type: config.type ?? 'worker',
      minSize: config.minSize ?? 1,
      maxSize: config.maxSize ?? 10,
      scaleUpThreshold: config.scaleUpThreshold ?? 0.8,
      scaleDownThreshold: config.scaleDownThreshold ?? 0.2,
      cooldownMs: config.cooldownMs ?? 30000,
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? SWARM_CONSTANTS.DEFAULT_HEALTH_CHECK_INTERVAL_MS,
    };
  }

  async initialize(config?: AgentPoolConfig): Promise<void> {
    if (config) {
      this.config = { ...this.config, ...config };
    }

    // Start with minimum pool size - create agents in parallel
    const createPromises = Array.from(
      { length: this.config.minSize },
      () => this.createPooledAgent()
    );
    await Promise.all(createPromises);

    // Start health checks
    this.startHealthChecks();

    this.emit('initialized', {
      poolName: this.config.name,
      size: this.pooledAgents.size
    });
  }

  async shutdown(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }

    // Mark all agents as terminated
    for (const pooled of this.pooledAgents.values()) {
      pooled.agent.status = 'terminated';
    }

    this.pooledAgents.clear();
    this.available.clear();
    this.busy.clear();

    this.emit('shutdown');
  }

  async acquire(): Promise<AgentState | undefined> {
    // Try to get an available agent
    const availableId = this.available.values().next().value as string | undefined;

    if (availableId) {
      const pooled = this.pooledAgents.get(availableId);
      if (pooled) {
        this.available.delete(availableId);
        this.busy.add(availableId);
        pooled.acquiredAt = new Date();
        pooled.usageCount++;
        pooled.agent.status = 'busy';

        this.emit('agent.acquired', { agentId: availableId });

        // Check if we need to scale up
        await this.checkScaling();

        return pooled.agent;
      }
    }

    // No available agents, try to scale up
    if (this.pooledAgents.size < this.config.maxSize) {
      const agent = await this.createPooledAgent();
      if (agent) {
        const pooled = this.pooledAgents.get(agent.id.id)!;
        this.available.delete(agent.id.id);
        this.busy.add(agent.id.id);
        pooled.acquiredAt = new Date();
        pooled.usageCount++;
        agent.status = 'busy';

        this.emit('agent.acquired', { agentId: agent.id.id });

        return agent;
      }
    }

    // Pool exhausted
    this.emit('pool.exhausted');
    return undefined;
  }

  async release(agentId: string): Promise<void> {
    const pooled = this.pooledAgents.get(agentId);
    if (!pooled) {
      return;
    }

    this.busy.delete(agentId);
    this.available.add(agentId);
    pooled.acquiredAt = undefined;
    pooled.lastUsed = new Date();
    pooled.agent.status = 'idle';
    pooled.agent.currentTask = undefined;

    this.emit('agent.released', { agentId });

    // Check if we need to scale down
    await this.checkScaling();
  }

  async add(agent: AgentState): Promise<void> {
    if (this.pooledAgents.size >= this.config.maxSize) {
      throw new Error(`Pool ${this.config.name} is at maximum capacity`);
    }

    const pooled: PooledAgent = {
      agent,
      lastUsed: new Date(),
      usageCount: 0,
    };

    this.pooledAgents.set(agent.id.id, pooled);
    this.available.add(agent.id.id);

    this.emit('agent.added', { agentId: agent.id.id });
  }

  async remove(agentId: string): Promise<void> {
    const pooled = this.pooledAgents.get(agentId);
    if (!pooled) {
      return;
    }

    this.pooledAgents.delete(agentId);
    this.available.delete(agentId);
    this.busy.delete(agentId);
    pooled.agent.status = 'terminated';

    this.emit('agent.removed', { agentId });
  }

  async scale(delta: number): Promise<void> {
    const now = new Date();

    // Check cooldown
    if (this.lastScaleOperation) {
      const timeSinceLastScale = now.getTime() - this.lastScaleOperation.getTime();
      if (timeSinceLastScale < this.config.cooldownMs) {
        return;
      }
    }

    if (delta > 0) {
      // Scale up - create agents in parallel
      const targetSize = Math.min(
        this.pooledAgents.size + delta,
        this.config.maxSize
      );
      const toCreate = targetSize - this.pooledAgents.size;

      const createPromises = Array.from(
        { length: toCreate },
        () => this.createPooledAgent()
      );
      await Promise.all(createPromises);

      this.emit('pool.scaled_up', { added: toCreate });
    } else if (delta < 0) {
      // Scale down - remove agents in parallel
      const targetSize = Math.max(
        this.pooledAgents.size + delta,
        this.config.minSize
      );
      const toRemove = this.pooledAgents.size - targetSize;

      // Remove least recently used available agents
      const sortedAvailable = Array.from(this.available)
        .map(id => this.pooledAgents.get(id)!)
        .filter(p => p !== undefined)
        .sort((a, b) => a.lastUsed.getTime() - b.lastUsed.getTime());

      const agentsToRemove = sortedAvailable.slice(0, toRemove);
      await Promise.all(agentsToRemove.map(pooled => this.remove(pooled.agent.id.id)));

      this.emit('pool.scaled_down', { removed: agentsToRemove.length });
    }

    this.lastScaleOperation = now;
  }

  getState(): AgentPoolState {
    return {
      id: `pool_${this.config.name}`,
      config: { ...this.config },
      agents: new Map(
        Array.from(this.pooledAgents.entries()).map(
          ([id, pooled]) => [id, pooled.agent]
        )
      ),
      availableAgents: Array.from(this.available),
      busyAgents: Array.from(this.busy),
      pendingScale: this.pendingScale,
      lastScaleOperation: this.lastScaleOperation,
    };
  }

  getAvailableCount(): number {
    return this.available.size;
  }

  getBusyCount(): number {
    return this.busy.size;
  }

  getTotalCount(): number {
    return this.pooledAgents.size;
  }

  getUtilization(): number {
    if (this.pooledAgents.size === 0) return 0;
    return this.busy.size / this.pooledAgents.size;
  }

  // ===== PRIVATE METHODS =====

  private async createPooledAgent(): Promise<AgentState | undefined> {
    if (this.pooledAgents.size >= this.config.maxSize) {
      return undefined;
    }

    this.agentCounter++;
    const agentId = `${this.config.name}_agent_${this.agentCounter}`;

    const agent: AgentState = {
      id: {
        id: agentId,
        swarmId: 'pool',
        type: this.config.type,
        instance: this.agentCounter,
      },
      name: `${this.config.name}-${this.agentCounter}`,
      type: this.config.type,
      status: 'idle',
      capabilities: this.createDefaultCapabilities(),
      metrics: this.createDefaultMetrics(),
      workload: 0,
      health: 1.0,
      lastHeartbeat: new Date(),
      connections: [],
    };

    const pooled: PooledAgent = {
      agent,
      lastUsed: new Date(),
      usageCount: 0,
    };

    this.pooledAgents.set(agentId, pooled);
    this.available.add(agentId);

    this.emit('agent.created', { agentId });

    return agent;
  }

  private createDefaultCapabilities(): AgentCapabilities {
    return {
      codeGeneration: true,
      codeReview: true,
      testing: true,
      documentation: true,
      research: true,
      analysis: true,
      coordination: this.config.type === 'coordinator',
      languages: ['typescript', 'javascript', 'python'],
      frameworks: ['node', 'deno', 'react'],
      domains: ['development', 'testing', 'analysis'],
      tools: ['git', 'npm', 'editor'],
      maxConcurrentTasks: 3,
      maxMemoryUsage: 512 * 1024 * 1024,
      maxExecutionTime: SWARM_CONSTANTS.DEFAULT_TASK_TIMEOUT_MS,
      reliability: 0.95,
      speed: 1.0,
      quality: 0.9,
    };
  }

  private createDefaultMetrics(): AgentMetrics {
    return {
      tasksCompleted: 0,
      tasksFailed: 0,
      averageExecutionTime: 0,
      successRate: 1.0,
      cpuUsage: 0,
      memoryUsage: 0,
      messagesProcessed: 0,
      lastActivity: new Date(),
      responseTime: 0,
      health: 1.0,
    };
  }

  private async checkScaling(): Promise<void> {
    const utilization = this.getUtilization();

    if (utilization >= this.config.scaleUpThreshold &&
        this.pooledAgents.size < this.config.maxSize) {
      // Scale up by 1
      this.pendingScale = 1;
      await this.scale(1);
      this.pendingScale = 0;
    } else if (utilization <= this.config.scaleDownThreshold &&
               this.pooledAgents.size > this.config.minSize) {
      // Scale down by 1
      this.pendingScale = -1;
      await this.scale(-1);
      this.pendingScale = 0;
    }
  }

  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(() => {
      this.performHealthChecks();
    }, this.config.healthCheckIntervalMs);
  }

  private performHealthChecks(): void {
    const now = new Date();
    const unhealthyThresholdMs = this.config.healthCheckIntervalMs * 3;

    for (const [agentId, pooled] of this.pooledAgents) {
      const timeSinceLastActivity = now.getTime() - pooled.agent.lastHeartbeat.getTime();

      if (timeSinceLastActivity > unhealthyThresholdMs) {
        // Agent is unhealthy
        pooled.agent.health = Math.max(0, pooled.agent.health - 0.2);
        pooled.agent.status = 'error';

        this.emit('agent.unhealthy', { agentId, health: pooled.agent.health });

        // If completely unhealthy, remove and replace
        if (pooled.agent.health <= 0) {
          this.replaceUnhealthyAgent(agentId);
        }
      } else {
        // Update health positively. Do NOT touch lastHeartbeat here — merely
        // being under the unhealthy threshold on this tick is not a liveness
        // signal. lastHeartbeat must only advance on a real external signal
        // (updateAgentHeartbeat(), or agent creation/replacement), matching
        // the pattern used by UnifiedSwarmCoordinator.checkHeartbeats()/
        // handleHeartbeat() in this same package. Stamping it here made
        // timeSinceLastActivity reset to ~0 on every health-check tick for
        // every agent, so unhealthyThresholdMs could never be exceeded and
        // replaceUnhealthyAgent() could never fire, regardless of whether
        // the agent was actually still alive.
        pooled.agent.health = Math.min(1.0, pooled.agent.health + 0.1);
      }
    }
  }

  private async replaceUnhealthyAgent(agentId: string): Promise<void> {
    const pooled = this.pooledAgents.get(agentId);
    if (!pooled) return;

    const wasBusy = this.busy.has(agentId);
    await this.remove(agentId);

    // Create replacement if below min size or was busy
    if (this.pooledAgents.size < this.config.minSize || wasBusy) {
      await this.createPooledAgent();
    }

    this.emit('agent.replaced', { oldAgentId: agentId });
  }

  // ===== UTILITY METHODS =====

  getAgent(agentId: string): AgentState | undefined {
    return this.pooledAgents.get(agentId)?.agent;
  }

  getAllAgents(): AgentState[] {
    return Array.from(this.pooledAgents.values()).map(p => p.agent);
  }

  getAvailableAgents(): AgentState[] {
    return Array.from(this.available)
      .map(id => this.pooledAgents.get(id)?.agent)
      .filter((a): a is AgentState => a !== undefined);
  }

  getBusyAgents(): AgentState[] {
    return Array.from(this.busy)
      .map(id => this.pooledAgents.get(id)?.agent)
      .filter((a): a is AgentState => a !== undefined);
  }

  updateAgentHeartbeat(agentId: string): void {
    const pooled = this.pooledAgents.get(agentId);
    if (pooled) {
      pooled.agent.lastHeartbeat = new Date();
      pooled.agent.health = Math.min(1.0, pooled.agent.health + 0.05);
    }
  }

  updateAgentMetrics(agentId: string, metrics: Partial<AgentMetrics>): void {
    const pooled = this.pooledAgents.get(agentId);
    if (pooled) {
      pooled.agent.metrics = { ...pooled.agent.metrics, ...metrics };
      pooled.agent.lastHeartbeat = new Date();
    }
  }

  getPoolStats(): {
    total: number;
    available: number;
    busy: number;
    utilization: number;
    avgHealth: number;
    avgUsageCount: number;
  } {
    const agents = Array.from(this.pooledAgents.values());
    const avgHealth = agents.length > 0
      ? agents.reduce((sum, p) => sum + p.agent.health, 0) / agents.length
      : 1.0;
    const avgUsageCount = agents.length > 0
      ? agents.reduce((sum, p) => sum + p.usageCount, 0) / agents.length
      : 0;

    return {
      total: this.pooledAgents.size,
      available: this.available.size,
      busy: this.busy.size,
      utilization: this.getUtilization(),
      avgHealth,
      avgUsageCount,
    };
  }
}

export function createAgentPool(config?: Partial<AgentPoolConfig>): AgentPool {
  return new AgentPool(config);
}
