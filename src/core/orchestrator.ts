/**
 * Main orchestrator for Claude-Flow
 */

import {
  Config,
  SystemEvents,
  AgentProfile,
  AgentSession,
  Task,
  HealthStatus,
  ComponentHealth,
  TaskStatus,
  OrchestratorMetrics,
} from '../utils/types.ts';
import { IEventBus } from './event-bus.ts';
import { ILogger } from './logger.ts';
import { ITerminalManager } from '../terminal/manager.ts';
import { IMemoryManager } from '../memory/manager.ts';
import { ICoordinationManager } from '../coordination/manager.ts';
import { IMCPServer } from '../mcp/server.ts';
import { SystemError, InitializationError, ShutdownError } from '../utils/errors.ts';
import { delay, retry, circuitBreaker, CircuitBreaker } from '../utils/helpers.ts';
import { ensureDir, exists } from '@std/fs';
import { join, dirname } from '@std/path';

export interface ISessionManager {
  createSession(profile: AgentProfile): Promise<AgentSession>;
  getSession(sessionId: string): AgentSession | undefined;
  getActiveSessions(): AgentSession[];
  terminateSession(sessionId: string): Promise<void>;
  terminateAllSessions(): Promise<void>;
  persistSessions(): Promise<void>;
  restoreSessions(): Promise<void>;
  removeSession(sessionId: string): void;
}

export interface IOrchestrator {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  spawnAgent(profile: AgentProfile): Promise<string>;
  terminateAgent(agentId: string): Promise<void>;
  assignTask(task: Task): Promise<void>;
  getHealthStatus(): Promise<HealthStatus>;
  getMetrics(): Promise<OrchestratorMetrics>;
  performMaintenance(): Promise<void>;
}


export interface SessionPersistence {
  sessions: Array<AgentSession & { profile: AgentProfile }>;
  taskQueue: Task[];
  metrics: {
    completedTasks: number;
    failedTasks: number;
    totalTaskDuration: number;
  };
  savedAt: Date;
}

/**
 * Session manager implementation with persistence
 */
class SessionManager implements ISessionManager {
  private sessions = new Map<string, AgentSession>();
  private sessionProfiles = new Map<string, AgentProfile>();
  private persistencePath: string;
  private persistenceCircuitBreaker: CircuitBreaker;

  constructor(
    private terminalManager: ITerminalManager,
    private memoryManager: IMemoryManager,
    private eventBus: IEventBus,
    private logger: ILogger,
    private config: Config,
  ) {
    this.persistencePath = join(
      config.orchestrator.dataDir || './data',
      'sessions.json'
    );
    
    // Circuit breaker for persistence operations
    this.persistenceCircuitBreaker = circuitBreaker(
      'SessionPersistence',
      { threshold: 5, timeout: 30000, resetTimeout: 60000 }
    );
  }

  async createSession(profile: AgentProfile): Promise<AgentSession> {
    try {
      // Create terminal with retry logic
      const terminalId = await retry(
        () => this.terminalManager.spawnTerminal(profile),
        { maxAttempts: 3, initialDelay: 1000 }
      );

      // Create memory bank with retry logic
      const memoryBankId = await retry(
        () => this.memoryManager.createBank(profile.id),
        { maxAttempts: 3, initialDelay: 1000 }
      );

      // Create session
      const session: AgentSession = {
        id: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        agentId: profile.id,
        terminalId,
        startTime: new Date(),
        status: 'active',
        lastActivity: new Date(),
        memoryBankId,
      };

      this.sessions.set(session.id, session);
      this.sessionProfiles.set(session.id, profile);
      
      this.logger.info('Session created', { 
        sessionId: session.id, 
        agentId: profile.id,
        terminalId,
        memoryBankId 
      });
      
      // Persist sessions asynchronously
      this.persistSessions().catch(error => 
        this.logger.error('Failed to persist sessions', error)
      );
      
      return session;
    } catch (error) {
      this.logger.error('Failed to create session', { agentId: profile.id, error });
      throw new SystemError(`Failed to create session for agent ${profile.id}`, { error });
    }
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  getActiveSessions(): AgentSession[] {
    return Array.from(this.sessions.values()).filter(
      (session) => session.status === 'active' || session.status === 'idle',
    );
  }

  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    try {
      // Update session status first
      session.status = 'terminated';
      session.endTime = new Date();

      // Terminate terminal with timeout
      await Promise.race([
        this.terminalManager.terminateTerminal(session.terminalId),
        delay(5000).then(() => {
          throw new Error('Terminal termination timeout');
        })
      ]).catch(error => {
        this.logger.error('Error terminating terminal', { sessionId, error });
      });

      // Close memory bank with timeout
      await Promise.race([
        this.memoryManager.closeBank(session.memoryBankId),
        delay(5000).then(() => {
          throw new Error('Memory bank close timeout');
        })
      ]).catch(error => {
        this.logger.error('Error closing memory bank', { sessionId, error });
      });

      // Clean up
      this.sessionProfiles.delete(sessionId);

      this.logger.info('Session terminated', { sessionId, duration: session.endTime.getTime() - session.startTime.getTime() });
      
      // Persist sessions asynchronously
      this.persistSessions().catch(error => 
        this.logger.error('Failed to persist sessions', error)
      );
    } catch (error) {
      this.logger.error('Error during session termination', { sessionId, error });
      throw error;
    }
  }

  async terminateAllSessions(): Promise<void> {
    const sessions = this.getActiveSessions();
    
    // Terminate sessions in batches to avoid overwhelming the system
    const batchSize = 5;
    for (let i = 0; i < sessions.length; i += batchSize) {
      const batch = sessions.slice(i, i + batchSize);
      await Promise.allSettled(
        batch.map((session) => this.terminateSession(session.id))
      );
    }
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessionProfiles.delete(sessionId);
  }

  async persistSessions(): Promise<void> {
    if (!this.config.orchestrator.persistSessions) {
      return;
    }

    try {
      await this.persistenceCircuitBreaker.execute(async () => {
        const data: SessionPersistence = {
          sessions: Array.from(this.sessions.values()).map(session => ({
            ...session,
            profile: this.sessionProfiles.get(session.id)!
          })).filter(s => s.profile),
          taskQueue: [],
          metrics: {
            completedTasks: 0,
            failedTasks: 0,
            totalTaskDuration: 0,
          },
          savedAt: new Date(),
        };

        await ensureDir(dirname(this.persistencePath));
        await Deno.writeTextFile(this.persistencePath, JSON.stringify(data, null, 2));
        
        this.logger.debug('Sessions persisted', { count: data.sessions.length });
      });
    } catch (error) {
      this.logger.error('Failed to persist sessions', error);
    }
  }

  async restoreSessions(): Promise<void> {
    if (!this.config.orchestrator.persistSessions) {
      return;
    }

    try {
      const data = await Deno.readTextFile(this.persistencePath);
      const persistence: SessionPersistence = JSON.parse(data);
      
      // Restore only active/idle sessions
      const sessionsToRestore = persistence.sessions.filter(
        s => s.status === 'active' || s.status === 'idle'
      );
      
      for (const sessionData of sessionsToRestore) {
        try {
          // Recreate session
          const session = await this.createSession(sessionData.profile);
          
          // Update with persisted data
          Object.assign(session, {
            id: sessionData.id,
            startTime: new Date(sessionData.startTime),
            lastActivity: new Date(sessionData.lastActivity),
          });
          
          this.logger.info('Session restored', { sessionId: session.id });
        } catch (error) {
          this.logger.error('Failed to restore session', { 
            sessionId: sessionData.id, 
            error 
          });
        }
      }
    } catch (error) {
      if ((error as any).code !== 'ENOENT') {
        this.logger.error('Failed to restore sessions', error);
      }
    }
  }
}

/**
 * Main orchestrator implementation with enhanced features
 */
export class Orchestrator implements IOrchestrator {
  private initialized = false;
  private shutdownInProgress = false;
  private sessionManager: ISessionManager;
  private healthCheckInterval?: number;
  private maintenanceInterval?: number;
  private metricsInterval?: number;
  private agents = new Map<string, AgentProfile>();
  private taskQueue: Task[] = [];
  private taskHistory = new Map<string, Task>();
  private startTime = Date.now();
  
  // Metrics tracking
  private metrics = {
    completedTasks: 0,
    failedTasks: 0,
    totalTaskDuration: 0,
  };
  
  // Circuit breakers for critical operations
  private healthCheckCircuitBreaker: CircuitBreaker;
  private taskAssignmentCircuitBreaker: CircuitBreaker;

  constructor(
    private config: Config,
    private terminalManager: ITerminalManager,
    private memoryManager: IMemoryManager,
    private coordinationManager: ICoordinationManager,
    private mcpServer: IMCPServer,
    private eventBus: IEventBus,
    private logger: ILogger,
  ) {
    this.sessionManager = new SessionManager(
      terminalManager,
      memoryManager,
      eventBus,
      logger,
      config,
    );
    
    // Initialize circuit breakers
    this.healthCheckCircuitBreaker = circuitBreaker(
      'HealthCheck',
      { threshold: 3, timeout: 10000, resetTimeout: 30000 }
    );
    
    this.taskAssignmentCircuitBreaker = circuitBreaker(
      'TaskAssignment',
      { threshold: 5, timeout: 5000, resetTimeout: 20000 }
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      throw new InitializationError('Orchestrator already initialized');
    }

    this.logger.info('Initializing orchestrator...');
    const startTime = Date.now();

    try {
      // Initialize components in parallel where possible
      await Promise.all([
        this.initializeComponent('Terminal Manager', () => this.terminalManager.initialize()),
        this.initializeComponent('Memory Manager', () => this.memoryManager.initialize()),
        this.initializeComponent('Coordination Manager', () => this.coordinationManager.initialize()),
      ]);
      
      // MCP server needs to be started after other components
      await this.initializeComponent('MCP Server', () => this.mcpServer.start());

      // Restore persisted sessions
      await this.sessionManager.restoreSessions();

      // Set up event handlers
      this.setupEventHandlers();

      // Start background tasks
      this.startHealthChecks();
      this.startMaintenanceTasks();
      this.startMetricsCollection();

      this.initialized = true;

      const initDuration = Date.now() - startTime;
      this.eventBus.emit(SystemEvents.SYSTEM_READY, { timestamp: new Date() });
      this.logger.info('Orchestrator initialized successfully', { duration: initDuration });
    } catch (error) {
      this.logger.error('Failed to initialize orchestrator', error);
      
      // Attempt cleanup on initialization failure
      await this.emergencyShutdown();
      
      throw new InitializationError('Orchestrator', { error });
    }
  }

  async shutdown(): Promise<void> {
    if (!this.initialized || this.shutdownInProgress) {
      return;
    }

    this.shutdownInProgress = true;
    this.logger.info('Shutting down orchestrator...');
    const shutdownStart = Date.now();

    try {
      // Stop background tasks
      this.stopBackgroundTasks();

      // Save current state
      await this.sessionManager.persistSessions();

      // Process any remaining critical tasks
      await this.processShutdownTasks();

      // Terminate all sessions
      await this.sessionManager.terminateAllSessions();

      // Shutdown components with timeout
      await Promise.race([
        this.shutdownComponents(),
        delay(this.config.orchestrator.shutdownTimeout),
      ]);

      const shutdownDuration = Date.now() - shutdownStart;
      this.eventBus.emit(SystemEvents.SYSTEM_SHUTDOWN, { reason: 'Graceful shutdown' });
      this.logger.info('Orchestrator shutdown complete', { duration: shutdownDuration });
    } catch (error) {
      this.logger.error('Error during shutdown', error);
      
      // Force shutdown if graceful shutdown fails
      await this.emergencyShutdown();
      
      throw new ShutdownError('Failed to shutdown gracefully', { error });
    } finally {
      this.initialized = false;
      this.shutdownInProgress = false;
    }
  }

  async spawnAgent(profile: AgentProfile): Promise<string> {
    if (!this.initialized) {
      throw new SystemError('Orchestrator not initialized');
    }

    // Check agent limit
    if (this.agents.size >= this.config.orchestrator.maxConcurrentAgents) {
      throw new SystemError('Maximum concurrent agents reached');
    }

    // Validate agent profile
    this.validateAgentProfile(profile);

    this.logger.info('Spawning agent', { agentId: profile.id, type: profile.type });

    try {
      // Create session with retry
      const session = await retry(
        () => this.sessionManager.createSession(profile),
        { maxAttempts: 3, initialDelay: 2000 }
      );

      // Store agent profile
      this.agents.set(profile.id, profile);

      // Emit event
      this.eventBus.emit(SystemEvents.AGENT_SPAWNED, {
        agentId: profile.id,
        profile,
        sessionId: session.id,
      });

      // Start agent health monitoring
      this.startAgentHealthMonitoring(profile.id);

      return session.id;
    } catch (error) {
      this.logger.error('Failed to spawn agent', { agentId: profile.id, error });
      throw error;
    }
  }

  async terminateAgent(agentId: string): Promise<void> {
    if (!this.initialized) {
      throw new SystemError('Orchestrator not initialized');
    }

    const profile = this.agents.get(agentId);
    if (!profile) {
      throw new SystemError(`Agent not found: ${agentId}`);
    }

    this.logger.info('Terminating agent', { agentId });

    try {
      // Cancel any assigned tasks
      await this.cancelAgentTasks(agentId);

      // Find and terminate all sessions for this agent
      const sessions = this.sessionManager.getActiveSessions().filter(
        (session) => session.agentId === agentId,
      );

      await Promise.allSettled(
        sessions.map((session) => this.sessionManager.terminateSession(session.id)),
      );

      // Remove agent
      this.agents.delete(agentId);

      // Emit event
      this.eventBus.emit(SystemEvents.AGENT_TERMINATED, {
        agentId,
        reason: 'User requested',
      });
    } catch (error) {
      this.logger.error('Failed to terminate agent', { agentId, error });
      throw error;
    }
  }

  async assignTask(task: Task): Promise<void> {
    if (!this.initialized) {
      throw new SystemError('Orchestrator not initialized');
    }

    // Validate task
    this.validateTask(task);

    // Store task in history
    this.taskHistory.set(task.id, task);

    try {
      await this.taskAssignmentCircuitBreaker.execute(async () => {
        // Add to queue if no agent assigned
        if (!task.assignedAgent) {
          if (this.taskQueue.length >= this.config.orchestrator.taskQueueSize) {
            throw new SystemError('Task queue is full');
          }

          this.taskQueue.push(task);
          this.eventBus.emit(SystemEvents.TASK_CREATED, { task });
          
          // Try to assign immediately
          await this.processTaskQueue();
          return;
        }

        // Assign to specific agent
        const agent = this.agents.get(task.assignedAgent);
        if (!agent) {
          throw new SystemError(`Agent not found: ${task.assignedAgent}`);
        }

        await this.coordinationManager.assignTask(task, task.assignedAgent);
        
        this.eventBus.emit(SystemEvents.TASK_ASSIGNED, {
          taskId: task.id,
          agentId: task.assignedAgent,
        });
      });
    } catch (error) {
      this.logger.error('Failed to assign task', { taskId: task.id, error });
      throw error;
    }
  }

  async getHealthStatus(): Promise<HealthStatus> {
    try {
      return await this.healthCheckCircuitBreaker.execute(async () => {
        const components: Record<string, ComponentHealth> = {};

        // Check all components in parallel
        const [terminal, memory, coordination, mcp] = await Promise.allSettled([
          this.getComponentHealth(
            'Terminal Manager',
            async () => await this.terminalManager.getHealthStatus(),
          ),
          this.getComponentHealth(
            'Memory Manager',
            async () => await this.memoryManager.getHealthStatus(),
          ),
          this.getComponentHealth(
            'Coordination Manager',
            async () => await this.coordinationManager.getHealthStatus(),
          ),
          this.getComponentHealth(
            'MCP Server',
            async () => await this.mcpServer.getHealthStatus(),
          ),
        ]);

        // Process results
        components.terminal = this.processHealthResult(terminal, 'Terminal Manager');
        components.memory = this.processHealthResult(memory, 'Memory Manager');
        components.coordination = this.processHealthResult(coordination, 'Coordination Manager');
        components.mcp = this.processHealthResult(mcp, 'MCP Server');

        // Add orchestrator self-check
        components.orchestrator = {
          name: 'Orchestrator',
          status: 'healthy',
          lastCheck: new Date(),
          metrics: {
            uptime: Date.now() - this.startTime,
            activeAgents: this.agents.size,
            queuedTasks: this.taskQueue.length,
            memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024, // MB
          },
        };

        // Determine overall status
        const statuses = Object.values(components).map((c) => c.status);
        let overallStatus: HealthStatus['status'] = 'healthy';
        
        if (statuses.some((s) => s === 'unhealthy')) {
          overallStatus = 'unhealthy';
        } else if (statuses.some((s) => s === 'degraded')) {
          overallStatus = 'degraded';
        }

        return {
          status: overallStatus,
          components,
          timestamp: new Date(),
        };
      });
    } catch (error) {
      this.logger.error('Health check failed', error);
      
      // Return degraded status if health check fails
      return {
        status: 'degraded',
        components: {
          orchestrator: {
            name: 'Orchestrator',
            status: 'degraded',
            lastCheck: new Date(),
            error: 'Health check circuit breaker open',
          },
        },
        timestamp: new Date(),
      };
    }
  }

  async getMetrics(): Promise<OrchestratorMetrics> {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    const avgTaskDuration = this.metrics.completedTasks > 0
      ? this.metrics.totalTaskDuration / this.metrics.completedTasks
      : 0;

    return {
      uptime: Date.now() - this.startTime,
      totalAgents: this.agents.size,
      activeAgents: this.sessionManager.getActiveSessions().length,
      totalTasks: this.taskHistory.size,
      completedTasks: this.metrics.completedTasks,
      failedTasks: this.metrics.failedTasks,
      queuedTasks: this.taskQueue.length,
      avgTaskDuration,
      memoryUsage: memUsage,
      cpuUsage: cpuUsage,
      timestamp: new Date(),
    };
  }

  async performMaintenance(): Promise<void> {
    this.logger.debug('Performing maintenance tasks');

    try {
      // Clean up terminated sessions
      await this.cleanupTerminatedSessions();

      // Clean up old task history
      await this.cleanupTaskHistory();

      // Perform component maintenance
      await Promise.allSettled([
        this.terminalManager.performMaintenance(),
        this.memoryManager.performMaintenance(),
        this.coordinationManager.performMaintenance(),
      ]);

      // Persist current state
      await this.sessionManager.persistSessions();

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      this.logger.debug('Maintenance tasks completed');
    } catch (error) {
      this.logger.error('Error during maintenance', error);
    }
  }

  private setupEventHandlers(): void {
    // Handle task lifecycle events
    this.eventBus.on(SystemEvents.TASK_STARTED, (data: unknown) => {
      const { taskId, agentId } = data as { taskId: string; agentId: string };
      const task = this.taskHistory.get(taskId);
      if (task) {
        task.status = 'running';
        task.startedAt = new Date();
      }
    });

    this.eventBus.on(SystemEvents.TASK_COMPLETED, async (data: unknown) => {
      const { taskId, result } = data as { taskId: string; result: unknown };
      const task = this.taskHistory.get(taskId);
      if (task) {
        task.status = 'completed';
        task.completedAt = new Date();
        if (result !== undefined) {
          task.output = result as Record<string, unknown>;
        }
        
        // Update metrics
        this.metrics.completedTasks++;
        if (task.startedAt) {
          this.metrics.totalTaskDuration += task.completedAt.getTime() - task.startedAt.getTime();
        }
      }
      
      await this.processTaskQueue();
    });

    this.eventBus.on(SystemEvents.TASK_FAILED, async (data: unknown) => {
      const { taskId, error } = data as { taskId: string; error: Error };
      const task = this.taskHistory.get(taskId);
      if (task) {
        task.status = 'failed';
        task.completedAt = new Date();
        task.error = error;
        
        // Update metrics
        this.metrics.failedTasks++;
      }
      
      // Retry or requeue based on configuration
      await this.handleTaskFailure(taskId, error);
    });

    // Handle agent events
    this.eventBus.on(SystemEvents.AGENT_ERROR, async (data: unknown) => {
      const { agentId, error } = data as { agentId: string; error: Error };
      this.logger.error('Agent error', { agentId, error });
      
      // Implement agent recovery
      await this.handleAgentError(agentId, error);
    });

    this.eventBus.on(SystemEvents.AGENT_IDLE, async (data: unknown) => {
      const { agentId } = data as { agentId: string };
      // Update session status
      const sessions = this.sessionManager.getActiveSessions().filter(
        s => s.agentId === agentId
      );
      sessions.forEach(s => s.status = 'idle');
      
      // Try to assign queued tasks
      await this.processTaskQueue();
    });

    // Handle system events
    this.eventBus.on(SystemEvents.SYSTEM_ERROR, (data: unknown) => {
      const { error, component } = data as { error: Error; component: string };
      this.logger.error('System error', { component, error });
      
      // Implement system-level error recovery
      this.handleSystemError(component, error);
    });

    // Handle resource events
    this.eventBus.on(SystemEvents.DEADLOCK_DETECTED, (data: unknown) => {
      const { agents, resources } = data as { agents: string[]; resources: string[] };
      this.logger.error('Deadlock detected', { agents, resources });
      
      // Implement deadlock resolution
      this.resolveDeadlock(agents, resources);
    });
  }

  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(async () => {
      try {
        const health = await this.getHealthStatus();
        this.eventBus.emit(SystemEvents.SYSTEM_HEALTHCHECK, { status: health });
        
        if (health.status === 'unhealthy') {
          this.logger.warn('System health check failed', health);
          
          // Attempt recovery for unhealthy components
          await this.recoverUnhealthyComponents(health);
        }
      } catch (error) {
        this.logger.error('Health check error', error);
      }
    }, this.config.orchestrator.healthCheckInterval);
  }

  private startMaintenanceTasks(): void {
    this.maintenanceInterval = setInterval(async () => {
      await this.performMaintenance();
    }, this.config.orchestrator.maintenanceInterval || 300000); // 5 minutes default
  }

  private startMetricsCollection(): void {
    this.metricsInterval = setInterval(async () => {
      try {
        const metrics = await this.getMetrics();
        this.logger.debug('Metrics collected', metrics);
        
        // Emit metrics event for monitoring systems
        this.eventBus.emit('metrics:collected', metrics);
      } catch (error) {
        this.logger.error('Metrics collection error', error);
      }
    }, this.config.orchestrator.metricsInterval || 60000); // 1 minute default
  }

  private stopBackgroundTasks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
    }
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
  }

  private async shutdownComponents(): Promise<void> {
    const shutdownTasks = [
      this.shutdownComponent('Terminal Manager', () => this.terminalManager.shutdown()),
      this.shutdownComponent('Memory Manager', () => this.memoryManager.shutdown()),
      this.shutdownComponent('Coordination Manager', () => this.coordinationManager.shutdown()),
      this.shutdownComponent('MCP Server', () => this.mcpServer.stop()),
    ];

    const results = await Promise.allSettled(shutdownTasks);
    
    // Log any shutdown failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const componentName = ['Terminal Manager', 'Memory Manager', 'Coordination Manager', 'MCP Server'][index];
        this.logger.error(`Failed to shutdown ${componentName}`, result.reason);
      }
    });
  }

  private async emergencyShutdown(): Promise<void> {
    this.logger.warn('Performing emergency shutdown');
    
    try {
      // Force stop all components
      await Promise.allSettled([
        this.terminalManager.shutdown().catch(() => {}),
        this.memoryManager.shutdown().catch(() => {}),
        this.coordinationManager.shutdown().catch(() => {}),
        this.mcpServer.stop().catch(() => {}),
      ]);
    } catch (error) {
      this.logger.error('Emergency shutdown error', error);
    }
  }

  private async processTaskQueue(): Promise<void> {
    if (this.taskQueue.length === 0) {
      return;
    }

    const availableAgents = await this.getAvailableAgents();
    
    while (this.taskQueue.length > 0 && availableAgents.length > 0) {
      const task = this.taskQueue.shift()!;
      const agent = this.selectAgentForTask(task, availableAgents);
      
      if (agent) {
        task.assignedAgent = agent.id;
        task.status = 'assigned';
        
        try {
          await this.coordinationManager.assignTask(task, agent.id);
          
          this.eventBus.emit(SystemEvents.TASK_ASSIGNED, {
            taskId: task.id,
            agentId: agent.id,
          });
          
          // Remove agent from available list
          const index = availableAgents.indexOf(agent);
          availableAgents.splice(index, 1);
        } catch (error) {
          // Put task back in queue
          this.taskQueue.unshift(task);
          this.logger.error('Failed to assign task', { taskId: task.id, error });
          break;
        }
      } else {
        // No suitable agent, put task back
        this.taskQueue.unshift(task);
        break;
      }
    }
  }

  private async getAvailableAgents(): Promise<AgentProfile[]> {
    const sessions = this.sessionManager.getActiveSessions();
    const available: AgentProfile[] = [];

    for (const session of sessions) {
      if (session.status === 'idle' || session.status === 'active') {
        const profile = this.agents.get(session.agentId);
        if (profile) {
          try {
            const taskCount = await this.coordinationManager.getAgentTaskCount(profile.id);
            if (taskCount < profile.maxConcurrentTasks) {
              available.push(profile);
            }
          } catch (error) {
            this.logger.error('Failed to get agent task count', { agentId: profile.id, error });
          }
        }
      }
    }

    return available.sort((a, b) => b.priority - a.priority);
  }

  private selectAgentForTask(task: Task, agents: AgentProfile[]): AgentProfile | undefined {
    // Score agents based on capabilities, load, and priority
    const scoredAgents = agents.map(agent => {
      let score = agent.priority * 10;
      
      // Check capability match
      const requiredCapabilities = (task.metadata?.requiredCapabilities as string[]) || [];
      const matchedCapabilities = requiredCapabilities.filter(
        cap => agent.capabilities.includes(cap)
      ).length;
      
      if (requiredCapabilities.length > 0 && matchedCapabilities === 0) {
        return { agent, score: -1 }; // Can't handle task
      }
      
      score += matchedCapabilities * 5;
      
      // Prefer agents with matching type
      if (task.type === agent.type) {
        score += 20;
      }
      
      return { agent, score };
    });
    
    // Filter out agents that can't handle the task
    const eligibleAgents = scoredAgents.filter(({ score }) => score >= 0);
    
    if (eligibleAgents.length === 0) {
      return undefined;
    }
    
    // Select agent with highest score
    eligibleAgents.sort((a, b) => b.score - a.score);
    return eligibleAgents[0].agent;
  }

  private async getComponentHealth(
    name: string,
    check: () => Promise<{ healthy: boolean; error?: string; metrics?: Record<string, number> }>,
  ): Promise<ComponentHealth> {
    try {
      const result = await Promise.race([
        check(),
        delay(5000).then(() => ({ healthy: false, error: 'Health check timeout' }))
      ]);
      
      const health: ComponentHealth = {
        name,
        status: result.healthy ? 'healthy' : 'unhealthy',
        lastCheck: new Date(),
      };
      if (result.error !== undefined) {
        health.error = result.error;
      }
      if ('metrics' in result && result.metrics !== undefined) {
        health.metrics = result.metrics;
      }
      return health;
    } catch (error) {
      return {
        name,
        status: 'unhealthy',
        lastCheck: new Date(),
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private processHealthResult(
    result: PromiseSettledResult<ComponentHealth>,
    componentName: string
  ): ComponentHealth {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      return {
        name: componentName,
        status: 'unhealthy',
        lastCheck: new Date(),
        error: result.reason?.message || 'Health check failed',
      };
    }
  }

  private async initializeComponent(name: string, init: () => Promise<void>): Promise<void> {
    try {
      await retry(init, { maxAttempts: 3, initialDelay: 2000 });
      this.logger.info(`${name} initialized`);
    } catch (error) {
      this.logger.error(`Failed to initialize ${name}`, error);
      throw new InitializationError(name, { error });
    }
  }

  private async shutdownComponent(name: string, shutdown: () => Promise<void>): Promise<void> {
    try {
      await Promise.race([
        shutdown(),
        delay(10000) // 10 second timeout per component
      ]);
      this.logger.info(`${name} shut down`);
    } catch (error) {
      this.logger.error(`Failed to shutdown ${name}`, error);
      throw error;
    }
  }

  private validateAgentProfile(profile: AgentProfile): void {
    if (!profile.id || !profile.name || !profile.type) {
      throw new Error('Invalid agent profile: missing required fields');
    }
    
    if (profile.maxConcurrentTasks < 1) {
      throw new Error('Invalid agent profile: maxConcurrentTasks must be at least 1');
    }
    
    if (this.agents.has(profile.id)) {
      throw new Error(`Agent with ID ${profile.id} already exists`);
    }
  }

  private validateTask(task: Task): void {
    if (!task.id || !task.type || !task.description) {
      throw new Error('Invalid task: missing required fields');
    }
    
    if (task.priority < 0 || task.priority > 100) {
      throw new Error('Invalid task: priority must be between 0 and 100');
    }
    
    if (this.taskHistory.has(task.id)) {
      throw new Error(`Task with ID ${task.id} already exists`);
    }
  }

  private async handleAgentError(agentId: string, error: Error): Promise<void> {
    const profile = this.agents.get(agentId);
    if (!profile) {
      return;
    }

    // Log error details
    this.logger.error('Handling agent error', { agentId, error });

    // Check if agent should be restarted
    const errorCount = (profile.metadata?.errorCount as number) || 0;
    profile.metadata = { ...profile.metadata, errorCount: errorCount + 1 };

    if (errorCount < 3) {
      // Attempt to restart agent
      try {
        await this.terminateAgent(agentId);
        await delay(2000); // Wait before restart
        await this.spawnAgent({ ...profile, metadata: { ...profile.metadata, errorCount: 0 } });
        this.logger.info('Agent restarted after error', { agentId });
      } catch (restartError) {
        this.logger.error('Failed to restart agent', { agentId, error: restartError });
      }
    } else {
      // Too many errors, terminate agent
      this.logger.error('Agent exceeded error threshold, terminating', { agentId, errorCount });
      await this.terminateAgent(agentId);
    }
  }

  private async handleTaskFailure(taskId: string, error: Error): Promise<void> {
    const task = this.taskHistory.get(taskId);
    if (!task) {
      return;
    }

    const retryCount = (task.metadata?.retryCount as number) || 0;
    const maxRetries = this.config.orchestrator.taskMaxRetries || 3;

    if (retryCount < maxRetries) {
      // Retry task
      task.metadata = { ...task.metadata, retryCount: retryCount + 1 };
      task.status = 'queued';
      delete task.assignedAgent;
      
      // Add back to queue with delay
      setTimeout(() => {
        this.taskQueue.push(task);
        this.processTaskQueue();
      }, Math.pow(2, retryCount) * 1000); // Exponential backoff
      
      this.logger.info('Task queued for retry', { taskId, retryCount: retryCount + 1 });
    } else {
      this.logger.error('Task exceeded retry limit', { taskId, retryCount });
    }
  }

  private handleSystemError(component: string, error: Error): void {
    // Implement system-level error recovery strategies
    this.logger.error('Handling system error', { component, error });

    // TODO: Implement specific recovery strategies based on component and error type
  }

  private async resolveDeadlock(agents: string[], resources: string[]): Promise<void> {
    this.logger.warn('Resolving deadlock', { agents, resources });

    // Simple deadlock resolution: cancel lowest priority agent's tasks
    const agentProfiles = agents
      .map(id => this.agents.get(id))
      .filter(Boolean) as AgentProfile[];
    
    if (agentProfiles.length === 0) {
      return;
    }

    // Sort by priority (lowest first)
    agentProfiles.sort((a, b) => a.priority - b.priority);
    
    // Cancel tasks for lowest priority agent
    const targetAgent = agentProfiles[0];
    await this.cancelAgentTasks(targetAgent.id);
    
    this.logger.info('Deadlock resolved by cancelling tasks', { agentId: targetAgent.id });
  }

  private async cancelAgentTasks(agentId: string): Promise<void> {
    try {
      const tasks = await this.coordinationManager.getAgentTasks(agentId);
      
      for (const task of tasks) {
        await this.coordinationManager.cancelTask(task.id);
        
        // Update task status
        const trackedTask = this.taskHistory.get(task.id);
        if (trackedTask) {
          trackedTask.status = 'cancelled';
          trackedTask.completedAt = new Date();
        }
        
        this.eventBus.emit(SystemEvents.TASK_CANCELLED, {
          taskId: task.id,
          reason: 'Agent termination',
        });
      }
    } catch (error) {
      this.logger.error('Failed to cancel agent tasks', { agentId, error });
    }
  }

  private startAgentHealthMonitoring(agentId: string): void {
    // TODO: Implement periodic health checks for individual agents
  }

  private async recoverUnhealthyComponents(health: HealthStatus): Promise<void> {
    for (const [name, component] of Object.entries(health.components)) {
      if (component.status === 'unhealthy') {
        this.logger.warn('Attempting to recover unhealthy component', { name });
        
        // TODO: Implement component-specific recovery strategies
        switch (name) {
          case 'Terminal Manager':
            // Restart terminal pools, etc.
            break;
          case 'Memory Manager':
            // Clear cache, reconnect to backends, etc.
            break;
          case 'Coordination Manager':
            // Reset locks, clear message queues, etc.
            break;
          case 'MCP Server':
            // Restart server, reset connections, etc.
            break;
        }
      }
    }
  }

  private async cleanupTerminatedSessions(): Promise<void> {
    const allSessions = this.sessionManager.getActiveSessions();
    const terminatedSessions = allSessions.filter(s => (s as any).status === 'terminated');
    
    const cutoffTime = Date.now() - (this.config.orchestrator.sessionRetentionMs || 3600000); // 1 hour default
    
    for (const session of terminatedSessions) {
      const typedSession = session as any;
      if (typedSession.endTime && typedSession.endTime.getTime() < cutoffTime) {
        await this.sessionManager.terminateSession(typedSession.id);
        this.logger.debug('Cleaned up old session', { sessionId: typedSession.id });
      }
    }
  }

  private async cleanupTaskHistory(): Promise<void> {
    const cutoffTime = Date.now() - (this.config.orchestrator.taskHistoryRetentionMs || 86400000); // 24 hours default
    
    for (const [taskId, task] of this.taskHistory.entries()) {
      if (task.completedAt && task.completedAt.getTime() < cutoffTime) {
        this.taskHistory.delete(taskId);
        this.logger.debug('Cleaned up old task', { taskId });
      }
    }
  }

  private async processShutdownTasks(): Promise<void> {
    // Process any critical tasks before shutdown
    const criticalTasks = this.taskQueue.filter(
      t => t.priority >= 90 || t.metadata?.critical === true
    );
    
    if (criticalTasks.length > 0) {
      this.logger.info('Processing critical tasks before shutdown', { count: criticalTasks.length });
      
      // TODO: Implement critical task processing
    }
  }
}