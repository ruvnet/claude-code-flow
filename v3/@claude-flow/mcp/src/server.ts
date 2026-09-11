/**
 * @claude-flow/mcp - MCP Server
 *
 * High-performance MCP server implementation
 */

import { AsyncLocalStorage } from 'async_hooks';
import { EventEmitter } from 'events';
import { platform, arch } from 'os';
import type {
  MCPServerConfig,
  MCPRequest,
  MCPResponse,
  MCPNotification,
  MCPSession,
  MCPTool,
  MCPInitializeParams,
  MCPInitializeResult,
  MCPCapabilities,
  MCPProtocolVersion,
  MCPServerMetrics,
  ITransport,
  ILogger,
  ToolContext,
} from './types.js';
import { MCPServerError, ErrorCodes } from './types.js';
import type { MCPRequestContext } from './request-context.js';
import {
  MCP_2026_07_28,
  attachResponseTransportMetadata,
  authorityKey,
  isModernStatelessContext,
} from './request-context.js';
import {
  ToolRegistry,
  createToolRegistry,
  type ToolAuthorizer,
} from './tool-registry.js';
import { SessionManager, createSessionManager } from './session-manager.js';
import { ConnectionPool, createConnectionPool } from './connection-pool.js';
import { ResourceRegistry, createResourceRegistry } from './resource-registry.js';
import { PromptRegistry, createPromptRegistry } from './prompt-registry.js';
import { TaskManager, createTaskManager } from './task-manager.js';
import { createTransport, TransportManager, createTransportManager } from './transport/index.js';
import { RateLimiter, createRateLimiter } from './rate-limiter.js';
import { SamplingManager, createSamplingManager, type LLMProvider } from './sampling.js';

const DEFAULT_CONFIG: Partial<MCPServerConfig> = {
  name: 'Claude-Flow MCP Server V3',
  version: '3.0.0',
  transport: 'stdio',
  host: 'localhost',
  port: 3000,
  enableMetrics: true,
  enableCaching: true,
  cacheTTL: 10000,
  logLevel: 'info',
  requestTimeout: 30000,
  maxRequestSize: 10 * 1024 * 1024,
};

export interface IMCPServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  registerTool(tool: MCPTool): boolean;
  registerTools(tools: MCPTool[]): { registered: number; failed: string[] };
  setToolAuthorizer(authorizer?: ToolAuthorizer): void;
  getHealthStatus(): Promise<{
    healthy: boolean;
    error?: string;
    metrics?: Record<string, number>;
  }>;
  getMetrics(): MCPServerMetrics;
  getSessions(): MCPSession[];
  getSession(sessionId: string): MCPSession | undefined;
  terminateSession(sessionId: string): boolean;
}

export class MCPServer extends EventEmitter implements IMCPServer {
  private readonly config: MCPServerConfig;
  private readonly toolRegistry: ToolRegistry;
  private readonly sessionManager: SessionManager;
  private readonly resourceRegistry: ResourceRegistry;
  private readonly promptRegistry: PromptRegistry;
  private readonly taskManager: TaskManager;
  private readonly connectionPool?: ConnectionPool;
  private readonly transportManager: TransportManager;
  private readonly rateLimiter: RateLimiter;
  private readonly samplingManager: SamplingManager;
  private readonly requestContext = new AsyncLocalStorage<MCPRequestContext>();
  private readonly authoritySessions = new Map<string, string>();
  private transports: ITransport[] = [];
  private running = false;
  private startTime?: Date;
  private startupDuration?: number;
  /** Contextless fallback retained only for transports that cannot supply request context. */
  private currentSession?: MCPSession;
  private resourceSubscriptions: Map<string, Set<string>> = new Map();

  private readonly serverInfo = {
    name: 'Claude-Flow MCP Server V3',
    version: '3.0.0',
  };

  /** Legacy initialization response version. Modern clients use server/discover. */
  private readonly protocolVersion: MCPProtocolVersion = '2025-11-25';

  private capabilities: MCPCapabilities = {
    logging: { level: 'info' },
    tools: { listChanged: true },
    resources: { listChanged: true, subscribe: true },
    prompts: { listChanged: true },
    sampling: {},
  };

  private requestStats = {
    total: 0,
    successful: 0,
    failed: 0,
    totalResponseTime: 0,
  };

  constructor(
    config: Partial<MCPServerConfig>,
    private readonly logger: ILogger,
    private readonly orchestrator?: unknown,
    private readonly swarmCoordinator?: unknown,
    toolAuthorizer?: ToolAuthorizer,
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config } as MCPServerConfig;

    this.toolRegistry = createToolRegistry(logger);
    if (this.config.requireToolAuthorization && !toolAuthorizer) {
      throw new Error('tool authorization is required but no authorizer was provided');
    }
    this.toolRegistry.setAuthorizer(toolAuthorizer);
    this.sessionManager = createSessionManager(logger, {
      maxSessions: 100,
      sessionTimeout: 30 * 60 * 1000,
    });
    this.resourceRegistry = createResourceRegistry(logger, {
      enableSubscriptions: true,
      cacheEnabled: true,
      cacheTTL: 60000,
    });
    this.promptRegistry = createPromptRegistry(logger);
    this.taskManager = createTaskManager(logger, {
      maxConcurrentTasks: 10,
      taskTimeout: 300000,
    });
    this.transportManager = createTransportManager(logger);
    this.rateLimiter = createRateLimiter(logger, {
      requestsPerSecond: 100,
      burstSize: 200,
      perSessionLimit: 50,
    });
    this.samplingManager = createSamplingManager(logger);

    if (this.config.connectionPool) {
      this.connectionPool = createConnectionPool(
        this.config.connectionPool,
        logger,
        this.config.transport
      );
    }

    this.setupEventHandlers();
  }

  getResourceRegistry(): ResourceRegistry {
    return this.resourceRegistry;
  }

  getPromptRegistry(): PromptRegistry {
    return this.promptRegistry;
  }

  getTaskManager(): TaskManager {
    return this.taskManager;
  }

  getRateLimiter(): RateLimiter {
    return this.rateLimiter;
  }

  getSamplingManager(): SamplingManager {
    return this.samplingManager;
  }

  registerLLMProvider(provider: LLMProvider, isDefault: boolean = false): void {
    this.samplingManager.registerProvider(provider, isDefault);
  }

  async start(): Promise<void> {
    if (this.running) throw new MCPServerError('Server already running');

    const startTime = performance.now();
    this.startTime = new Date();

    this.logger.info('Starting MCP server', {
      name: this.config.name,
      version: this.config.version,
      transport: this.config.transport,
    });

    try {
      const hosts = this.config.transport === 'http'
        ? [...new Set([this.config.host, ...(this.config.additionalHosts ?? [])])]
        : [this.config.host];
      const transports = hosts.map((host) => createTransport(this.config.transport, this.logger, {
        type: this.config.transport,
        host,
        port: this.config.port,
        corsEnabled: this.config.corsEnabled,
        corsOrigins: this.config.corsOrigins,
        auth: this.config.auth,
        maxRequestSize: String(this.config.maxRequestSize),
        requestTimeout: this.config.requestTimeout,
      } as any));

      for (const transport of transports) {
        transport.onRequest(async (request, context?: MCPRequestContext) => this.handleRequest(request, context));
        transport.onNotification(async (notification, context?: MCPRequestContext) => this.handleNotification(notification, context));
      }

      const started: ITransport[] = [];
      try {
        for (const transport of transports) {
          await transport.start();
          started.push(transport);
        }
      } catch (error) {
        await Promise.all(started.map((transport) => transport.stop()));
        throw error;
      }
      this.transports = started;
      await this.registerBuiltInTools();

      this.running = true;
      this.startupDuration = performance.now() - startTime;
      this.logger.info('MCP server started', {
        startupTime: `${this.startupDuration.toFixed(2)}ms`,
        tools: this.toolRegistry.getToolCount(),
      });
      this.emit('server:started', {
        startupTime: this.startupDuration,
        tools: this.toolRegistry.getToolCount(),
      });
    } catch (error) {
      this.logger.error('Failed to start MCP server', { error });
      throw new MCPServerError('Failed to start server', ErrorCodes.INTERNAL_ERROR, { error });
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.logger.info('Stopping MCP server');
    try {
      if (this.transports.length > 0) {
        const transports = this.transports;
        this.transports = [];
        await Promise.all(transports.map((transport) => transport.stop()));
      }

      this.sessionManager.clearAll();
      this.taskManager.destroy();
      this.resourceSubscriptions.clear();
      this.authoritySessions.clear();
      this.rateLimiter.destroy();

      if (this.connectionPool) await this.connectionPool.clear();

      this.running = false;
      this.currentSession = undefined;
      this.logger.info('MCP server stopped');
      this.emit('server:stopped');
    } catch (error) {
      this.logger.error('Error stopping MCP server', { error });
      throw error;
    }
  }

  registerTool(tool: MCPTool): boolean {
    return this.toolRegistry.register(tool);
  }

  registerTools(tools: MCPTool[]): { registered: number; failed: string[] } {
    return this.toolRegistry.registerBatch(tools);
  }

  setToolAuthorizer(authorizer?: ToolAuthorizer): void {
    if (this.config.requireToolAuthorization && !authorizer) {
      throw new Error('tool authorization is required and cannot be disabled');
    }
    this.toolRegistry.setAuthorizer(authorizer);
  }

  unregisterTool(name: string): boolean {
    return this.toolRegistry.unregister(name);
  }

  async getHealthStatus(): Promise<{
    healthy: boolean;
    error?: string;
    metrics?: Record<string, number>;
  }> {
    try {
      const transportHealth = this.transports.length > 0
        ? await Promise.all(this.transports.map((transport) => transport.getHealthStatus()))
        : [{ healthy: false, error: 'Transport not initialized' }];
      const sessionMetrics = this.sessionManager.getSessionMetrics();
      const poolStats = this.connectionPool?.getStats();
      const metrics: Record<string, number> = {
        registeredTools: this.toolRegistry.getToolCount(),
        totalRequests: this.requestStats.total,
        successfulRequests: this.requestStats.successful,
        failedRequests: this.requestStats.failed,
        totalSessions: sessionMetrics.total,
        activeSessions: sessionMetrics.active,
        ...Object.assign({}, ...transportHealth.map((health) => health.metrics || {})),
      };
      if (poolStats) {
        metrics.poolConnections = poolStats.totalConnections;
        metrics.poolIdleConnections = poolStats.idleConnections;
        metrics.poolBusyConnections = poolStats.busyConnections;
      }
      return {
        healthy: this.running && transportHealth.every((health) => health.healthy),
        error: transportHealth.map((health) => health.error).filter(Boolean).join('; ') || undefined,
        metrics,
      };
    } catch (error) {
      return { healthy: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  getMetrics(): MCPServerMetrics {
    const sessionMetrics = this.sessionManager.getSessionMetrics();
    const registryStats = this.toolRegistry.getStats();
    return {
      totalRequests: this.requestStats.total,
      successfulRequests: this.requestStats.successful,
      failedRequests: this.requestStats.failed,
      averageResponseTime: this.requestStats.total > 0
        ? this.requestStats.totalResponseTime / this.requestStats.total
        : 0,
      activeSessions: sessionMetrics.active,
      toolInvocations: Object.fromEntries(registryStats.topTools.map((t) => [t.name, t.calls])),
      errors: {},
      lastReset: this.startTime || new Date(),
      startupTime: this.startupDuration,
      uptime: this.startTime ? Date.now() - this.startTime.getTime() : 0,
    };
  }

  getSessions(): MCPSession[] {
    return this.sessionManager.getActiveSessions();
  }

  getSession(sessionId: string): MCPSession | undefined {
    return this.sessionManager.getSession(sessionId);
  }

  terminateSession(sessionId: string): boolean {
    const result = this.sessionManager.closeSession(sessionId, 'Terminated by server');
    if (this.currentSession?.id === sessionId) this.currentSession = undefined;
    for (const [key, boundSessionId] of this.authoritySessions) {
      if (boundSessionId === sessionId) this.authoritySessions.delete(key);
    }
    return result;
  }

  private async handleRequest(request: MCPRequest, context?: MCPRequestContext): Promise<MCPResponse> {
    if (context) {
      return this.requestContext.run(context, async () => this.handleRequestScoped(request));
    }
    return this.handleRequestScoped(request);
  }

  private async handleRequestScoped(request: MCPRequest): Promise<MCPResponse> {
    const startTime = performance.now();
    this.requestStats.total++;
    const context = this.requestContext.getStore();

    this.logger.debug('Handling request', {
      id: request.id,
      method: request.method,
      requestContextId: context?.requestId,
      principal: context?.principal.subject,
    });

    if (isModernStatelessContext(context) && request.method === 'initialize') {
      this.requestStats.failed++;
      return this.createErrorResponse(
        request.id,
        ErrorCodes.INVALID_REQUEST,
        'initialize is not valid for MCP 2026-07-28 stateless requests; use server/discover'
      );
    }

    if (request.method !== 'initialize') {
      const scopeId = this.resolveRequestScopeId();
      const rateLimitResult = this.rateLimiter.check(scopeId);
      if (!rateLimitResult.allowed) {
        this.requestStats.failed++;
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32000,
            message: 'Rate limit exceeded',
            data: { retryAfter: rateLimitResult.retryAfter },
          },
        };
      }
      this.rateLimiter.consume(scopeId);
    }

    try {
      if (request.method === 'initialize') return this.handleInitialize(request);

      if (!isModernStatelessContext(context)) {
        const session = this.resolveRequestSession();
        if (!session?.isInitialized && request.method !== 'initialized') {
          return this.createErrorResponse(
            request.id,
            ErrorCodes.SERVER_NOT_INITIALIZED,
            'Server not initialized for this request authority context'
          );
        }
        if (session) this.sessionManager.updateActivity(session.id);
      }

      const response = await this.routeRequest(request);
      const duration = performance.now() - startTime;
      this.requestStats.successful++;
      this.requestStats.totalResponseTime += duration;
      this.logger.debug('Request completed', {
        id: request.id,
        method: request.method,
        duration: `${duration.toFixed(2)}ms`,
        requestContextId: context?.requestId,
      });
      return response;
    } catch (error) {
      const duration = performance.now() - startTime;
      this.requestStats.failed++;
      this.requestStats.totalResponseTime += duration;
      this.logger.error('Request failed', {
        id: request.id,
        method: request.method,
        error,
        requestContextId: context?.requestId,
      });
      return this.createErrorResponse(
        request.id,
        ErrorCodes.INTERNAL_ERROR,
        error instanceof Error ? error.message : 'Internal error'
      );
    }
  }

  private async handleNotification(
    notification: MCPNotification,
    context?: MCPRequestContext
  ): Promise<void> {
    if (context) {
      await this.requestContext.run(context, async () => this.handleNotificationScoped(notification));
      return;
    }
    await this.handleNotificationScoped(notification);
  }

  private async handleNotificationScoped(notification: MCPNotification): Promise<void> {
    const context = this.requestContext.getStore();
    this.logger.debug('Handling notification', {
      method: notification.method,
      requestContextId: context?.requestId,
      principal: context?.principal.subject,
    });

    switch (notification.method) {
      case 'initialized':
        this.logger.info('Client initialized notification received', {
          sessionId: this.resolveRequestSession()?.id,
        });
        break;
      case 'notifications/cancelled':
        this.logger.debug('Request cancelled', {
          ...notification.params,
          authorityScope: this.resolveRequestScopeId(),
        });
        break;
      default:
        this.logger.debug('Unknown notification', { method: notification.method });
    }
  }

  private async handleInitialize(request: MCPRequest): Promise<MCPResponse> {
    const params = request.params as unknown as MCPInitializeParams | undefined;
    if (!params) {
      return this.createErrorResponse(request.id, ErrorCodes.INVALID_PARAMS, 'Invalid params');
    }

    const session = this.sessionManager.createSession(this.config.transport);
    this.sessionManager.initializeSession(session.id, params);
    this.bindSessionToRequestAuthority(session);

    const result: MCPInitializeResult = {
      protocolVersion: this.protocolVersion,
      capabilities: this.capabilities,
      serverInfo: this.serverInfo,
      instructions: 'Claude-Flow MCP Server V3 ready for tool execution',
    };

    this.logger.info('Session initialized', {
      sessionId: session.id,
      clientInfo: params.clientInfo,
      principal: this.requestContext.getStore()?.principal.subject,
    });

    return attachResponseTransportMetadata({
      jsonrpc: '2.0',
      id: request.id,
      result,
    }, { legacySessionId: session.id });
  }

  private async routeRequest(request: MCPRequest): Promise<MCPResponse> {
    switch (request.method) {
      case 'server/discover': return this.handleServerDiscover(request);
      case 'tools/list': return this.handleToolsList(request);
      case 'tools/call': return this.handleToolsCall(request);
      case 'resources/list': return this.handleResourcesList(request);
      case 'resources/read': return this.handleResourcesRead(request);
      case 'resources/subscribe': return this.handleResourcesSubscribe(request);
      case 'resources/unsubscribe': return this.handleResourcesUnsubscribe(request);
      case 'prompts/list': return this.handlePromptsList(request);
      case 'prompts/get': return this.handlePromptsGet(request);
      case 'tasks/status': return this.handleTasksStatus(request);
      case 'tasks/cancel': return this.handleTasksCancel(request);
      case 'completion/complete': return this.handleCompletion(request);
      case 'logging/setLevel': return this.handleLoggingSetLevel(request);
      case 'sampling/createMessage': return this.handleSamplingCreateMessage(request);
      case 'ping':
        return { jsonrpc: '2.0', id: request.id, result: { pong: true, timestamp: Date.now() } };
      default:
        if (this.toolRegistry.hasTool(request.method)) return this.handleToolExecution(request);
        return this.createErrorResponse(request.id, ErrorCodes.METHOD_NOT_FOUND, `Method not found: ${request.method}`);
    }
  }

  private handleServerDiscover(request: MCPRequest): MCPResponse {
    const modernCapabilities: MCPCapabilities = {
      ...this.capabilities,
      resources: this.capabilities.resources
        ? { ...this.capabilities.resources, subscribe: false }
        : undefined,
    };
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: MCP_2026_07_28,
        serverInfo: this.serverInfo,
        capabilities: modernCapabilities,
        transport: {
          requestLocalAuthority: true,
          sessionsRequired: false,
          resourceSubscriptions: 'legacy-only-until-targeted-delivery',
        },
      },
    };
  }

  private handleToolsList(request: MCPRequest): MCPResponse {
    const tools = this.toolRegistry.listTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: this.toolRegistry.getTool(t.name)?.inputSchema,
    }));
    return { jsonrpc: '2.0', id: request.id, result: { tools } };
  }

  private async handleToolsCall(request: MCPRequest): Promise<MCPResponse> {
    const params = request.params as { name: string; arguments?: Record<string, unknown> };
    if (!params?.name) {
      return this.createErrorResponse(request.id, ErrorCodes.INVALID_PARAMS, 'Tool name is required');
    }
    const result = await this.toolRegistry.execute(
      params.name,
      params.arguments || {},
      this.createToolContext(request)
    );
    return { jsonrpc: '2.0', id: request.id, result };
  }

  private async handleToolExecution(request: MCPRequest): Promise<MCPResponse> {
    const result = await this.toolRegistry.execute(
      request.method,
      (request.params as Record<string, unknown>) || {},
      this.createToolContext(request)
    );
    return { jsonrpc: '2.0', id: request.id, result };
  }

  private handleResourcesList(request: MCPRequest): MCPResponse {
    const params = request.params as { cursor?: string } | undefined;
    return { jsonrpc: '2.0', id: request.id, result: this.resourceRegistry.list(params?.cursor) };
  }

  private async handleResourcesRead(request: MCPRequest): Promise<MCPResponse> {
    const params = request.params as { uri: string } | undefined;
    if (!params?.uri) {
      return this.createErrorResponse(request.id, ErrorCodes.INVALID_PARAMS, 'Resource URI is required');
    }
    try {
      return { jsonrpc: '2.0', id: request.id, result: await this.resourceRegistry.read(params.uri) };
    } catch (error) {
      return this.createErrorResponse(
        request.id,
        ErrorCodes.INVALID_PARAMS,
        error instanceof Error ? error.message : 'Resource read failed'
      );
    }
  }

  private handleResourcesSubscribe(request: MCPRequest): MCPResponse {
    const params = request.params as { uri: string } | undefined;
    const requestContext = this.requestContext.getStore();
    if (isModernStatelessContext(requestContext)) {
      return this.createErrorResponse(
        request.id,
        ErrorCodes.METHOD_NOT_FOUND,
        'Stateless resource subscriptions are disabled until targeted notification delivery is available'
      );
    }
    const sessionId = this.resolveRequestScopeId();
    if (!params?.uri) {
      return this.createErrorResponse(request.id, ErrorCodes.INVALID_PARAMS, 'Resource URI is required');
    }
    if (!sessionId) {
      return this.createErrorResponse(request.id, ErrorCodes.SERVER_NOT_INITIALIZED, 'No active request authority scope');
    }

    try {
      let sessionSubs = this.resourceSubscriptions.get(sessionId);
      if (!sessionSubs) {
        sessionSubs = new Set();
        this.resourceSubscriptions.set(sessionId, sessionSubs);
      }
      const subscriptionId = this.resourceRegistry.subscribe(params.uri, (uri) => {
        this.sendNotification('notifications/resources/updated', { uri });
      });
      sessionSubs.add(params.uri);
      return { jsonrpc: '2.0', id: request.id, result: { subscriptionId } };
    } catch (error) {
      return this.createErrorResponse(
        request.id,
        ErrorCodes.INTERNAL_ERROR,
        error instanceof Error ? error.message : 'Subscription failed'
      );
    }
  }

  private handleResourcesUnsubscribe(request: MCPRequest): MCPResponse {
    const params = request.params as { uri: string } | undefined;
    const requestContext = this.requestContext.getStore();
    if (isModernStatelessContext(requestContext)) {
      return this.createErrorResponse(
        request.id,
        ErrorCodes.METHOD_NOT_FOUND,
        'Stateless resource subscriptions are disabled until targeted notification delivery is available'
      );
    }
    const sessionId = this.resolveRequestScopeId();
    if (!params?.uri) {
      return this.createErrorResponse(request.id, ErrorCodes.INVALID_PARAMS, 'Resource URI is required');
    }
    if (sessionId) this.resourceSubscriptions.get(sessionId)?.delete(params.uri);
    return { jsonrpc: '2.0', id: request.id, result: { success: true } };
  }

  private handlePromptsList(request: MCPRequest): MCPResponse {
    const params = request.params as { cursor?: string } | undefined;
    return { jsonrpc: '2.0', id: request.id, result: this.promptRegistry.list(params?.cursor) };
  }

  private async handlePromptsGet(request: MCPRequest): Promise<MCPResponse> {
    const params = request.params as { name: string; arguments?: Record<string, string> } | undefined;
    if (!params?.name) {
      return this.createErrorResponse(request.id, ErrorCodes.INVALID_PARAMS, 'Prompt name is required');
    }
    try {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: await this.promptRegistry.get(params.name, params.arguments),
      };
    } catch (error) {
      return this.createErrorResponse(
        request.id,
        ErrorCodes.INVALID_PARAMS,
        error instanceof Error ? error.message : 'Prompt get failed'
      );
    }
  }

  private handleTasksStatus(request: MCPRequest): MCPResponse {
    const params = request.params as { taskId?: string } | undefined;
    if (params?.taskId) {
      const task = this.taskManager.getTask(params.taskId);
      if (!task) {
        return this.createErrorResponse(request.id, ErrorCodes.INVALID_PARAMS, `Task not found: ${params.taskId}`);
      }
      return { jsonrpc: '2.0', id: request.id, result: task };
    }
    return { jsonrpc: '2.0', id: request.id, result: { tasks: this.taskManager.getAllTasks() } };
  }

  private handleTasksCancel(request: MCPRequest): MCPResponse {
    const params = request.params as { taskId: string; reason?: string } | undefined;
    if (!params?.taskId) {
      return this.createErrorResponse(request.id, ErrorCodes.INVALID_PARAMS, 'Task ID is required');
    }
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { success: this.taskManager.cancelTask(params.taskId, params.reason) },
    };
  }

  private handleCompletion(request: MCPRequest): MCPResponse {
    const params = request.params as {
      ref: { type: string; name?: string; uri?: string };
      argument: { name: string; value: string };
    } | undefined;
    if (!params?.ref || !params?.argument) {
      return this.createErrorResponse(
        request.id,
        ErrorCodes.INVALID_PARAMS,
        'Completion reference and argument are required'
      );
    }

    const completions: string[] = [];
    if (params.ref.type === 'ref/prompt') {
      const prompt = this.promptRegistry.getPrompt(params.ref.name || '');
      if (prompt?.arguments) {
        for (const arg of prompt.arguments) {
          if (arg.name === params.argument.name) {
            // Domain-specific completions can be added here.
          }
        }
      }
    } else if (params.ref.type === 'ref/resource') {
      const { resources } = this.resourceRegistry.list();
      for (const resource of resources) {
        if (resource.uri.startsWith(params.argument.value)) completions.push(resource.uri);
      }
    }
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        completion: {
          values: completions.slice(0, 10),
          total: completions.length,
          hasMore: completions.length > 10,
        },
      },
    };
  }

  private handleLoggingSetLevel(request: MCPRequest): MCPResponse {
    const params = request.params as { level: string } | undefined;
    if (!params?.level) {
      return this.createErrorResponse(request.id, ErrorCodes.INVALID_PARAMS, 'Log level is required');
    }
    this.capabilities.logging = { level: params.level as 'debug' | 'info' | 'warn' | 'error' };
    this.logger.info('Log level updated', { level: params.level });
    return { jsonrpc: '2.0', id: request.id, result: { success: true } };
  }

  private async handleSamplingCreateMessage(request: MCPRequest): Promise<MCPResponse> {
    const params = request.params as {
      messages: Array<{ role: string; content: { type: string; text?: string } }>;
      maxTokens: number;
      systemPrompt?: string;
      modelPreferences?: {
        hints?: Array<{ name?: string }>;
        intelligencePriority?: number;
        speedPriority?: number;
        costPriority?: number;
      };
      includeContext?: string;
      temperature?: number;
      stopSequences?: string[];
      metadata?: Record<string, unknown>;
    } | undefined;
    if (!params?.messages || !params?.maxTokens) {
      return this.createErrorResponse(request.id, ErrorCodes.INVALID_PARAMS, 'messages and maxTokens are required');
    }
    if (!(await this.samplingManager.isAvailable())) {
      return this.createErrorResponse(request.id, ErrorCodes.INTERNAL_ERROR, 'No LLM provider available for sampling');
    }

    try {
      const result = await this.samplingManager.createMessage(
        {
          messages: params.messages.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content as any,
          })),
          maxTokens: params.maxTokens,
          systemPrompt: params.systemPrompt,
          modelPreferences: params.modelPreferences,
          includeContext: params.includeContext as 'none' | 'thisServer' | 'allServers' | undefined,
          temperature: params.temperature,
          stopSequences: params.stopSequences,
          metadata: params.metadata,
        },
        {
          sessionId: this.resolveRequestScopeId() || 'unknown',
          serverId: this.serverInfo.name,
        }
      );
      return { jsonrpc: '2.0', id: request.id, result };
    } catch (error) {
      return this.createErrorResponse(
        request.id,
        ErrorCodes.INTERNAL_ERROR,
        error instanceof Error ? error.message : 'Sampling failed'
      );
    }
  }

  private async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    await Promise.all(this.transports.map(async (transport) => {
      if (transport.sendNotification) {
        await transport.sendNotification({ jsonrpc: '2.0', method, params });
      }
    }));
  }

  private bindSessionToRequestAuthority(session: MCPSession): void {
    const context = this.requestContext.getStore();
    if (!context) {
      this.currentSession = session;
      return;
    }
    const incomingKey = authorityKey(context);
    if (incomingKey) this.authoritySessions.set(incomingKey, session.id);
    this.authoritySessions.set(`${context.principal.subject}:${session.id}`, session.id);
  }

  private resolveRequestSession(): MCPSession | undefined {
    const context = this.requestContext.getStore();
    if (!context) return this.currentSession;
    if (isModernStatelessContext(context)) return undefined;
    const key = authorityKey(context);
    if (!key) return undefined;
    const sessionId = this.authoritySessions.get(key);
    return sessionId ? this.sessionManager.getSession(sessionId) : undefined;
  }

  private resolveRequestScopeId(): string | undefined {
    const context = this.requestContext.getStore();
    if (context) {
      if (isModernStatelessContext(context)) return `stateless:${context.principal.subject}`;
      return this.resolveRequestSession()?.id ?? authorityKey(context);
    }
    return this.currentSession?.id;
  }

  private createToolContext(request: MCPRequest): ToolContext {
    const requestContext = this.requestContext.getStore();
    return {
      sessionId: this.resolveRequestScopeId() || 'unknown',
      requestId: request.id,
      orchestrator: this.orchestrator,
      swarmCoordinator: this.swarmCoordinator,
      metadata: requestContext ? {
        principal: requestContext.principal.subject,
        protocolVersion: requestContext.protocolVersion,
        requestContextId: requestContext.requestId,
        traceparent: requestContext.traceparent,
      } : undefined,
    };
  }

  private createErrorResponse(id: string | number | null, code: number, message: string): MCPResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  private async registerBuiltInTools(): Promise<void> {
    this.registerTool({
      name: 'system/info',
      description: 'Get system information',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        name: this.serverInfo.name,
        version: this.serverInfo.version,
        platform: platform(),
        arch: arch(),
        runtime: 'Node.js',
        uptime: this.startTime ? Date.now() - this.startTime.getTime() : 0,
      }),
      category: 'system',
    });
    this.registerTool({
      name: 'system/health',
      description: 'Get system health status',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => this.getHealthStatus(),
      category: 'system',
      cacheable: true,
      cacheTTL: 2000,
    });
    this.registerTool({
      name: 'system/metrics',
      description: 'Get server metrics',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => this.getMetrics(),
      category: 'system',
      cacheable: true,
      cacheTTL: 1000,
    });
    this.registerTool({
      name: 'tools/list-detailed',
      description: 'List all registered tools with details',
      inputSchema: {
        type: 'object',
        properties: { category: { type: 'string', description: 'Filter by category' } },
      },
      handler: async (input: unknown) => {
        const params = input as { category?: string };
        return params.category ? this.toolRegistry.getByCategory(params.category) : this.toolRegistry.listTools();
      },
      category: 'system',
    });
    this.logger.info('Built-in tools registered', { count: 4 });
  }

  private setupEventHandlers(): void {
    this.toolRegistry.on('tool:registered', (name) => this.emit('tool:registered', name));
    this.toolRegistry.on('tool:called', (data) => this.emit('tool:called', data));
    this.toolRegistry.on('tool:completed', (data) => this.emit('tool:completed', data));
    this.toolRegistry.on('tool:error', (data) => this.emit('tool:error', data));
    this.sessionManager.on('session:created', (session) => this.emit('session:created', session));
    this.sessionManager.on('session:closed', (data) => this.emit('session:closed', data));
    this.sessionManager.on('session:expired', (session) => this.emit('session:expired', session));
  }
}

export function createMCPServer(
  config: Partial<MCPServerConfig>,
  logger: ILogger,
  orchestrator?: unknown,
  swarmCoordinator?: unknown,
  toolAuthorizer?: ToolAuthorizer,
): MCPServer {
  return new MCPServer(config, logger, orchestrator, swarmCoordinator, toolAuthorizer);
}
