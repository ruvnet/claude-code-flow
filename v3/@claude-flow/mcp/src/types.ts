/**
 * @claude-flow/mcp - Standalone Types
 *
 * Complete type definitions for MCP server implementation
 * Zero external @claude-flow dependencies
 */

import type { MCPRequestContext } from './request-context.js';

// ============================================================================
// Core Protocol Types
// ============================================================================

export type JsonRpcVersion = '2.0';

/**
 * MCP protocol version. Per the [MCP spec](https://spec.modelcontextprotocol.io/specification/basic/lifecycle/#initialization)
 * this must be a `YYYY-MM-DD` date string (e.g. `'2024-11-05'`, `'2025-06-18'`).
 *
 * Earlier versions of this type used `{major,minor,patch}`, which Claude
 * Code's Zod validator rejects with `Invalid input: expected string,
 * received object` (#1874). The string form is canonical and cross-client
 * compatible.
 */
export type MCPProtocolVersion = string;

export type RequestId = string | number | null;

export interface MCPMessage {
  jsonrpc: JsonRpcVersion;
}

export interface MCPRequest extends MCPMessage {
  id: RequestId;
  method: string;
  params?: Record<string, unknown>;
}

export interface MCPNotification extends MCPMessage {
  method: string;
  params?: Record<string, unknown>;
}

export interface MCPError {
  code: number;
  message: string;
  data?: unknown;
}

export interface MCPResponse extends MCPMessage {
  id: RequestId;
  result?: unknown;
  error?: MCPError;
}

// ============================================================================
// Server Configuration
// ============================================================================

export type TransportType = 'stdio' | 'http' | 'websocket' | 'in-process';

export type AuthMethod = 'token' | 'oauth' | 'api-key' | 'none';

export interface AuthConfig {
  enabled: boolean;
  method: AuthMethod;
  tokens?: string[];
  apiKeys?: string[];
  jwtSecret?: string;
  oauth?: {
    clientId: string;
    clientSecret: string;
    authorizationUrl: string;
    tokenUrl: string;
  };
}

export interface LoadBalancerConfig {
  enabled: boolean;
  maxConcurrentRequests: number;
  rateLimit?: {
    requestsPerSecond: number;
    burstSize: number;
  };
  circuitBreaker?: {
    failureThreshold: number;
    resetTimeout: number;
  };
}

export interface ConnectionPoolConfig {
  maxConnections: number;
  minConnections: number;
  idleTimeout: number;
  acquireTimeout: number;
  maxWaitingClients: number;
  evictionRunInterval: number;
}

export interface MCPServerConfig {
  name: string;
  version: string;
  transport: TransportType;
  host?: string;
  /** Additional HTTP bind addresses that share the same MCP server state. */
  additionalHosts?: string[];
  port?: number;
  tlsEnabled?: boolean;
  tlsCert?: string;
  tlsKey?: string;
  auth?: AuthConfig;
  loadBalancer?: LoadBalancerConfig;
  connectionPool?: ConnectionPoolConfig;
  corsEnabled?: boolean;
  corsOrigins?: string[];
  maxRequestSize?: number;
  requestTimeout?: number;
  enableMetrics?: boolean;
  enableCaching?: boolean;
  cacheTTL?: number;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** Fail construction unless a ToolAuthorizer is installed. */
  requireToolAuthorization?: boolean;
}

// ============================================================================
// Session Types
// ============================================================================

export type SessionState = 'created' | 'initializing' | 'ready' | 'closing' | 'closed' | 'error';

export interface MCPSession {
  id: string;
  state: SessionState;
  transport: TransportType;
  createdAt: Date;
  lastActivityAt: Date;
  isInitialized: boolean;
  isAuthenticated: boolean;
  clientInfo?: MCPClientInfo;
  protocolVersion?: MCPProtocolVersion;
  capabilities?: MCPCapabilities;
  metadata?: Record<string, unknown>;
}

export interface MCPClientInfo {
  name: string;
  version: string;
}

// ============================================================================
// Capability Types
// ============================================================================

export interface MCPCapabilities {
  logging?: {
    level: 'debug' | 'info' | 'warn' | 'error';
  };
  tools?: {
    listChanged: boolean;
  };
  resources?: {
    listChanged: boolean;
    subscribe: boolean;
  };
  prompts?: {
    listChanged: boolean;
  };
  sampling?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}

export interface MCPInitializeParams {
  protocolVersion: MCPProtocolVersion;
  capabilities: MCPCapabilities;
  clientInfo: MCPClientInfo;
}

export interface MCPInitializeResult {
  protocolVersion: MCPProtocolVersion;
  capabilities: MCPCapabilities;
  serverInfo: {
    name: string;
    version: string;
  };
  instructions?: string;
}

// ============================================================================
// Tool Types
// ============================================================================

export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: string[];
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | JSONSchema;
}

export interface ToolContext {
  sessionId: string;
  requestId?: RequestId;
  orchestrator?: unknown;
  swarmCoordinator?: unknown;
  agentManager?: unknown;
  resourceManager?: unknown;
  messageBus?: unknown;
  monitor?: unknown;
  metadata?: Record<string, unknown>;
}

export type ToolHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context?: ToolContext
) => Promise<TOutput>;

export interface MCPTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  handler: ToolHandler<TInput, TOutput>;
  category?: string;
  tags?: string[];
  version?: string;
  deprecated?: boolean;
  cacheable?: boolean;
  cacheTTL?: number;
  timeout?: number;
}

export interface ToolCallResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError: boolean;
}

export interface ToolRegistrationOptions {
  override?: boolean;
  validate?: boolean;
  preload?: boolean;
}

// ============================================================================
// Resource Types (MCP 2025-11-25)
// ============================================================================

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  annotations?: ContentAnnotations;
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceListResult {
  resources: MCPResource[];
  nextCursor?: string;
}

export interface ResourceReadResult {
  contents: ResourceContent[];
}

// ============================================================================
// Prompt Types (MCP 2025-11-25)
// ============================================================================

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface MCPPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: PromptArgument[];
}

export type PromptRole = 'user' | 'assistant';

export interface ContentAnnotations {
  audience?: Array<'user' | 'assistant'>;
  priority?: number;
  createdAt?: string;
  modifiedAt?: string;
}

export interface TextContent {
  type: 'text';
  text: string;
  annotations?: ContentAnnotations;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
  annotations?: ContentAnnotations;
}

export interface AudioContent {
  type: 'audio';
  data: string;
  mimeType: string;
  annotations?: ContentAnnotations;
}

export interface EmbeddedResource {
  type: 'resource';
  resource: ResourceContent;
  annotations?: ContentAnnotations;
}

export type PromptContent = TextContent | ImageContent | AudioContent | EmbeddedResource;

export interface PromptMessage {
  role: PromptRole;
  content: PromptContent;
}

export interface PromptListResult {
  prompts: MCPPrompt[];
  nextCursor?: string;
}

export interface PromptGetResult {
  description?: string;
  messages: PromptMessage[];
}

// ============================================================================
// Task Types (MCP 2025-11-25 - Async Operations)
// ============================================================================

export type TaskState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface MCPTask {
  id: string;
  state: TaskState;
  progress?: TaskProgress;
  result?: unknown;
  error?: MCPError;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface TaskProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface TaskResult {
  taskId: string;
  state: TaskState;
  progress?: TaskProgress;
  result?: unknown;
  error?: MCPError;
}

// ============================================================================
// Pagination Types (MCP 2025-11-25)
// ============================================================================

export interface PaginatedRequest {
  cursor?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor?: string;
}

// ============================================================================
// Progress & Cancellation Types (MCP 2025-11-25)
// ============================================================================

export interface ProgressNotification {
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
}

export interface CancellationParams {
  requestId: RequestId;
  reason?: string;
}

// ============================================================================
// Sampling Types (MCP 2025-11-25 - Server-initiated LLM)
// ============================================================================

export interface SamplingMessage {
  role: PromptRole;
  content: PromptContent;
}

export interface ModelPreferences {
  hints?: Array<{ name?: string }>;
  costPriority?: number;
  speedPriority?: number;
  intelligencePriority?: number;
}

export interface CreateMessageRequest {
  messages: SamplingMessage[];
  modelPreferences?: ModelPreferences;
  systemPrompt?: string;
  includeContext?: 'none' | 'thisServer' | 'allServers';
  temperature?: number;
  maxTokens: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
}

export interface CreateMessageResult {
  role: 'assistant';
  content: PromptContent;
  model: string;
  stopReason?: 'endTurn' | 'stopSequence' | 'maxTokens';
}

// ============================================================================
// Roots Types (MCP 2025-11-25)
// ============================================================================

export interface Root {
  uri: string;
  name?: string;
}

export interface RootsListResult {
  roots: Root[];
}

// ============================================================================
// Logging Types (MCP 2025-11-25)
// ============================================================================

export type MCPLogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';

export interface LoggingMessage {
  level: MCPLogLevel;
  logger?: string;
  data?: unknown;
}

// ============================================================================
// Completion Types (MCP 2025-11-25)
// ============================================================================

export interface CompletionReference {
  type: 'ref/prompt' | 'ref/resource';
  name?: string;
  uri?: string;
}

export interface CompletionArgument {
  name: string;
  value: string;
}

export interface CompletionResult {
  values: string[];
  total?: number;
  hasMore?: boolean;
}

// ============================================================================
// Transport Types
// ============================================================================

export type RequestHandler = (
  request: MCPRequest,
  context?: MCPRequestContext
) => Promise<MCPResponse>;

export type NotificationHandler = (
  notification: MCPNotification,
  context?: MCPRequestContext
) => Promise<void>;

export interface TransportHealthStatus {
  healthy: boolean;
  error?: string;
  metrics?: Record<string, number>;
}

export interface ITransport {
  readonly type: TransportType;
  start(): Promise<void>;
  stop(): Promise<void>;
  onRequest(handler: RequestHandler): void;
  onNotification(handler: NotificationHandler): void;
  sendNotification?(notification: MCPNotification): Promise<void>;
  getHealthStatus(): Promise<TransportHealthStatus>;
}

// ============================================================================
// Connection Pool Types
// ============================================================================

export type ConnectionState = 'idle' | 'busy' | 'closing' | 'closed' | 'error';

export interface PooledConnection {
  id: string;
  state: ConnectionState;
  createdAt: Date;
  lastUsedAt: Date;
  useCount: number;
  transport: TransportType;
  metadata?: Record<string, unknown>;
}

export interface ConnectionPoolStats {
  totalConnections: number;
  idleConnections: number;
  busyConnections: number;
  pendingRequests: number;
  totalAcquired: number;
  totalReleased: number;
  totalCreated: number;
  totalDestroyed: number;
  avgAcquireTime: number;
}

export interface IConnectionPool {
  acquire(): Promise<PooledConnection>;
  release(connection: PooledConnection): void;
  destroy(connection: PooledConnection): void;
  getStats(): ConnectionPoolStats;
  drain(): Promise<void>;
  clear(): Promise<void>;
}

// ============================================================================
// Metrics Types
// ============================================================================

export interface ToolCallMetrics {
  toolName: string;
  duration: number;
  success: boolean;
  timestamp: number;
  transport: TransportType;
  cached?: boolean;
}

export interface MCPServerMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  activeSessions: number;
  toolInvocations: Record<string, number>;
  errors: Record<string, number>;
  lastReset: Date;
  startupTime?: number;
  uptime?: number;
}

export interface SessionMetrics {
  total: number;
  active: number;
  authenticated: number;
  expired: number;
}

// ============================================================================
// Event Types
// ============================================================================

export type MCPEventType =
  | 'server:started'
  | 'server:stopped'
  | 'server:error'
  | 'session:created'
  | 'session:initialized'
  | 'session:closed'
  | 'session:error'
  | 'tool:registered'
  | 'tool:unregistered'
  | 'tool:called'
  | 'tool:completed'
  | 'tool:error'
  | 'transport:connected'
  | 'transport:disconnected'
  | 'transport:error'
  | 'pool:connection:acquired'
  | 'pool:connection:released'
  | 'pool:connection:created'
  | 'pool:connection:destroyed';

export interface MCPEvent {
  type: MCPEventType;
  timestamp: Date;
  data?: unknown;
}

export type EventHandler = (event: MCPEvent) => void;

// ============================================================================
// Logger Interface
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ILogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

// ============================================================================
// Error Codes
// ============================================================================

export const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_NOT_INITIALIZED: -32002,
  UNKNOWN_ERROR: -32001,
  REQUEST_CANCELLED: -32800,
  RATE_LIMITED: -32000,
  AUTHENTICATION_REQUIRED: -32001,
  AUTHORIZATION_FAILED: -32002,
} as const;

export class MCPServerError extends Error {
  constructor(
    message: string,
    public code: number = ErrorCodes.INTERNAL_ERROR,
    public data?: unknown
  ) {
    super(message);
    this.name = 'MCPServerError';
  }

  toMCPError(): MCPError {
    return {
      code: this.code,
      message: this.message,
      data: this.data,
    };
  }
}
