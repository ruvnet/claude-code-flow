/**
 * @claude-flow/mcp - HTTP Transport
 *
 * HTTP/REST transport with WebSocket support
 */

import { EventEmitter } from 'events';
import express, { Express, Request, Response, NextFunction } from 'express';
import { createServer, Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID, timingSafeEqual } from 'crypto';
import type {
  ITransport,
  TransportType,
  MCPRequest,
  MCPResponse,
  MCPNotification,
  RequestHandler,
  NotificationHandler,
  TransportHealthStatus,
  ILogger,
  AuthConfig,
} from '../types.js';
import type { AuthenticatedPrincipal, MCPRequestContext } from '../request-context.js';
import {
  MCP_2026_07_28,
  anonymousPrincipal,
  freezeRequestContext,
  getResponseTransportMetadata,
  principalFromSecret,
  validateRoutingHeaders,
} from '../request-context.js';

export interface HttpTransportConfig {
  host: string;
  port: number;
  tlsEnabled?: boolean;
  tlsCert?: string;
  tlsKey?: string;
  corsEnabled?: boolean;
  corsOrigins?: string[];
  auth?: AuthConfig;
  maxRequestSize?: string;
  requestTimeout?: number;
  rateLimit?: {
    windowMs?: number;
    limit?: number;
  };
}

type ContextualRequestHandler = (
  request: MCPRequest,
  context?: MCPRequestContext
) => Promise<MCPResponse>;

type ContextualNotificationHandler = (
  notification: MCPNotification,
  context?: MCPRequestContext
) => Promise<void>;

interface AuthValidationResult {
  valid: boolean;
  principal?: AuthenticatedPrincipal;
  error?: string;
}

export class HttpTransport extends EventEmitter implements ITransport {
  public readonly type: TransportType = 'http';

  private requestHandler?: ContextualRequestHandler;
  private notificationHandler?: ContextualNotificationHandler;
  private app: Express;
  private server?: Server;
  private wss?: WebSocketServer;
  private running = false;
  private activeConnections = new Set<WebSocket>();
  private sseClients = new Map<string, Response>();
  private wsPrincipals = new WeakMap<WebSocket, AuthenticatedPrincipal>();
  private wsSessions = new WeakMap<WebSocket, string>();
  private wsProtocolVersions = new WeakMap<WebSocket, string>();

  private messagesReceived = 0;
  private messagesSent = 0;
  private errors = 0;
  private httpRequests = 0;
  private wsMessages = 0;

  constructor(
    private readonly logger: ILogger,
    private readonly config: HttpTransportConfig
  ) {
    super();
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('HTTP transport already running');
    }

    this.logger.info('Starting HTTP transport', {
      host: this.config.host,
      port: this.config.port,
    });

    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
    this.setupWebSocketHandlers();

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => resolve());
      this.server!.on('error', reject);
    });

    this.running = true;
    this.logger.info('HTTP transport started', {
      url: `http://${this.config.host}:${this.config.port}`,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.logger.info('Stopping HTTP transport');
    this.running = false;

    for (const ws of this.activeConnections) {
      try {
        ws.close(1000, 'Server shutting down');
      } catch {
        // Ignore close races.
      }
    }
    this.activeConnections.clear();

    for (const response of this.sseClients.values()) response.end();
    this.sseClients.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = undefined;
    }

    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }

    this.logger.info('HTTP transport stopped');
  }

  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler as ContextualRequestHandler;
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler as ContextualNotificationHandler;
  }

  async getHealthStatus(): Promise<TransportHealthStatus> {
    return {
      healthy: this.running,
      metrics: {
        messagesReceived: this.messagesReceived,
        messagesSent: this.messagesSent,
        errors: this.errors,
        httpRequests: this.httpRequests,
        wsMessages: this.wsMessages,
        activeConnections: this.activeConnections.size,
      },
    };
  }

  async sendNotification(notification: MCPNotification): Promise<void> {
    const message = JSON.stringify(notification);

    for (const ws of this.activeConnections) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message);
          this.messagesSent++;
        }
      } catch (error) {
        this.logger.error('Failed to send notification', { error });
        this.errors++;
      }
    }

    for (const response of this.sseClients.values()) {
      response.write(`event: message\ndata: ${message}\n\n`);
      this.messagesSent++;
    }
  }

  private setupMiddleware(): void {
    this.app.use(helmet({ contentSecurityPolicy: false }));

    if (this.config.corsEnabled !== false) {
      const allowedOrigins = this.config.corsOrigins;
      if (!allowedOrigins || allowedOrigins.length === 0) {
        this.logger.warn('CORS: No origins configured, restricting to same-origin only');
      }

      this.app.use(cors({
        origin: (origin, callback) => {
          if (!origin) return callback(null, true);
          if (allowedOrigins && allowedOrigins.length > 0) {
            if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
              callback(null, true);
            } else {
              callback(new Error(`CORS: Origin '${origin}' not allowed`));
            }
          } else {
            callback(new Error('CORS: Cross-origin requests not allowed'));
          }
        },
        credentials: true,
        maxAge: 86400,
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: [
          'Content-Type', 'Authorization', 'X-Request-ID', 'MCP-Protocol-Version',
          'Mcp-Method', 'Mcp-Name', 'Mcp-Session-Id', 'traceparent', 'tracestate',
        ],
        exposedHeaders: ['Mcp-Session-Id'],
      }));
    }

    this.app.use(express.json({ limit: this.config.maxRequestSize || '10mb' }));

    this.app.use(['/rpc', '/mcp'], rateLimit({
      windowMs: this.config.rateLimit?.windowMs ?? 60_000,
      limit: this.config.rateLimit?.limit ?? 120,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: {
        jsonrpc: '2.0', id: null,
        error: { code: -32000, message: 'Rate limit exceeded' },
      },
    }));

    if (this.config.requestTimeout) {
      this.app.use((req, res, next) => {
        res.setTimeout(this.config.requestTimeout!, () => {
          res.status(408).json({
            jsonrpc: '2.0', id: null,
            error: { code: -32000, message: 'Request timeout' },
          });
        });
        next();
      });
    }

    this.app.use((req, res, next) => {
      const startTime = performance.now();
      res.on('finish', () => {
        this.logger.debug('HTTP request', {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration: `${(performance.now() - startTime).toFixed(2)}ms`,
        });
      });
      next();
    });
  }

  private setupRoutes(): void {
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString(), connections: this.activeConnections.size });
    });

    this.app.post('/rpc', async (req, res) => this.handleHttpRequest(req, res));

    this.app.get('/mcp', (req, res) => {
      if (this.config.auth?.enabled) {
        const authResult = this.validateAuth(req);
        if (!authResult.valid) {
          res.status(401).json({ error: authResult.error || 'Unauthorized' });
          return;
        }
      }

      const sessionId = randomUUID();
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      this.sseClients.set(sessionId, res);
      res.write(`event: endpoint\ndata: /mcp?sessionId=${encodeURIComponent(sessionId)}\n\n`);
      res.on('close', () => {
        if (this.sseClients.get(sessionId) === res) this.sseClients.delete(sessionId);
      });
    });

    this.app.post('/mcp', async (req, res) => this.handleHttpRequest(req, res));

    this.app.get('/info', (_req, res) => {
      res.json({
        name: 'Claude-Flow MCP Server V3',
        version: '3.0.0',
        transport: 'http',
        capabilities: { jsonrpc: true, websocket: true, requestLocalAuthority: true },
      });
    });

    this.app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));

    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      this.logger.error('Express error', { error: err });
      this.errors++;
      res.status(500).json({
        jsonrpc: '2.0', id: null,
        error: { code: -32603, message: 'Internal error' },
      });
    });
  }

  private setupWebSocketHandlers(): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws, req) => {
      let principal = anonymousPrincipal();
      const protocolVersionHeader = req.headers['mcp-protocol-version'];
      if (typeof protocolVersionHeader === 'string') {
        this.wsProtocolVersions.set(ws, protocolVersionHeader);
      }

      if (this.config.auth?.enabled) {
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const token = url.searchParams.get('token') || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
        if (!token) {
          this.logger.warn('WebSocket connection rejected: no authentication token');
          ws.close(4001, 'Authentication required');
          return;
        }

        const valid = !this.config.auth.tokens?.length ||
          this.config.auth.tokens.some((candidate) => this.timingSafeCompare(token, candidate));
        if (!valid) {
          this.logger.warn('WebSocket connection rejected: invalid token');
          ws.close(4003, 'Invalid token');
          return;
        }
        principal = principalFromSecret(token, 'token');
      }

      this.wsPrincipals.set(ws, principal);
      this.activeConnections.add(ws);
      this.logger.info('WebSocket client connected', {
        total: this.activeConnections.size,
        authenticated: !!this.config.auth?.enabled,
      });

      ws.on('message', async (data) => this.handleWebSocketMessage(ws, data.toString()));
      ws.on('close', () => {
        this.activeConnections.delete(ws);
        this.logger.info('WebSocket client disconnected', { total: this.activeConnections.size });
      });
      ws.on('error', (error) => {
        this.logger.error('WebSocket error', { error });
        this.errors++;
        this.activeConnections.delete(ws);
      });
    });
  }

  private async handleHttpRequest(req: Request, res: Response): Promise<void> {
    this.httpRequests++;
    this.messagesReceived++;

    const requiresAuth = this.config.auth?.enabled !== false;
    let principal = anonymousPrincipal();

    if (requiresAuth && this.config.auth) {
      const authResult = this.validateAuth(req);
      if (!authResult.valid || !authResult.principal) {
        this.logger.warn('Authentication failed', { ip: req.ip, path: req.path, error: authResult.error });
        res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
        return;
      }
      principal = authResult.principal;
    } else if (requiresAuth && !this.config.auth) {
      this.logger.warn('No authentication configured - running in development mode');
    }

    const message = req.body;
    if (message.jsonrpc !== '2.0') {
      res.status(400).json({ jsonrpc: '2.0', id: message.id || null, error: { code: -32600, message: 'Invalid JSON-RPC version' } });
      return;
    }
    if (!message.method) {
      res.status(400).json({ jsonrpc: '2.0', id: message.id || null, error: { code: -32600, message: 'Missing method' } });
      return;
    }

    const sseSessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const sseResponse = sseSessionId ? this.sseClients.get(sseSessionId) : undefined;
    const context = this.createHttpContext(req, principal, sseSessionId);

    if (context.protocolVersion === MCP_2026_07_28 && context.legacySessionId) {
      this.errors++;
      res.status(400).json({
        jsonrpc: '2.0', id: message.id ?? null,
        error: { code: -32600, message: 'Mcp-Session-Id is invalid for MCP 2026-07-28 stateless requests' },
      });
      return;
    }

    const routing = validateRoutingHeaders(message as MCPRequest, context);
    if (!routing.valid) {
      this.errors++;
      res.status(400).json({
        jsonrpc: '2.0', id: message.id ?? null,
        error: { code: -32600, message: routing.error || 'Routing header mismatch' },
      });
      return;
    }

    if (message.id === undefined) {
      if (this.notificationHandler) await this.notificationHandler(message as MCPNotification, context);
      res.status(sseResponse ? 202 : 204).end();
      return;
    }

    if (!this.requestHandler) {
      res.status(500).json({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'No request handler' } });
      return;
    }

    try {
      const response = await this.requestHandler(message as MCPRequest, context);
      const transportMetadata = getResponseTransportMetadata(response);
      if (transportMetadata?.legacySessionId && context.protocolVersion !== MCP_2026_07_28) {
        res.setHeader('Mcp-Session-Id', transportMetadata.legacySessionId);
      }

      if (sseResponse) {
        sseResponse.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        res.status(202).end();
      } else {
        res.json(response);
      }
      this.messagesSent++;
    } catch (error) {
      this.errors++;
      res.status(500).json({
        jsonrpc: '2.0', id: message.id,
        error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' },
      });
    }
  }

  private async handleWebSocketMessage(ws: WebSocket, data: string): Promise<void> {
    this.wsMessages++;
    this.messagesReceived++;

    try {
      const message = JSON.parse(data);
      if (message.jsonrpc !== '2.0') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id || null, error: { code: -32600, message: 'Invalid JSON-RPC version' } }));
        return;
      }

      const protocolVersion = this.wsProtocolVersions.get(ws);
      const legacySessionId = this.wsSessions.get(ws);
      if (protocolVersion === MCP_2026_07_28 && legacySessionId) {
        this.wsSessions.delete(ws);
      }
      const context = freezeRequestContext({
        requestId: randomUUID(),
        transport: 'websocket',
        principal: this.wsPrincipals.get(ws) ?? anonymousPrincipal(),
        protocolVersion,
        legacySessionId: protocolVersion === MCP_2026_07_28 ? undefined : legacySessionId,
      });

      if (message.id === undefined) {
        if (this.notificationHandler) await this.notificationHandler(message as MCPNotification, context);
        return;
      }
      if (!this.requestHandler) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'No request handler' } }));
        return;
      }

      const response = await this.requestHandler(message as MCPRequest, context);
      const metadata = getResponseTransportMetadata(response);
      if (metadata?.legacySessionId && protocolVersion !== MCP_2026_07_28) {
        this.wsSessions.set(ws, metadata.legacySessionId);
      }
      ws.send(JSON.stringify(response));
      this.messagesSent++;
    } catch (error) {
      this.errors++;
      this.logger.error('WebSocket message error', { error });
      try {
        const parsed = JSON.parse(data);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: parsed.id || null, error: { code: -32700, message: 'Parse error' } }));
      } catch {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      }
    }
  }

  private createHttpContext(req: Request, principal: AuthenticatedPrincipal, sseSessionId?: string): MCPRequestContext {
    return freezeRequestContext({
      requestId: this.singleHeader(req, 'x-request-id') ?? randomUUID(),
      transport: 'http',
      principal,
      protocolVersion: this.singleHeader(req, 'mcp-protocol-version'),
      legacySessionId: this.singleHeader(req, 'mcp-session-id') ?? sseSessionId,
      routingMethod: this.singleHeader(req, 'mcp-method'),
      routingName: this.singleHeader(req, 'mcp-name'),
      traceparent: this.singleHeader(req, 'traceparent'),
      tracestate: this.singleHeader(req, 'tracestate'),
      remoteAddress: req.ip,
    });
  }

  private singleHeader(req: Request, name: string): string | undefined {
    const value = req.headers[name.toLowerCase()];
    return typeof value === 'string' ? value : undefined;
  }

  private timingSafeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf-8');
    const bufB = Buffer.from(b, 'utf-8');
    if (bufA.length !== bufB.length) {
      timingSafeEqual(bufA, bufA);
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  }

  private validateAuth(req: Request): AuthValidationResult {
    const auth = req.headers.authorization;
    if (!auth) return { valid: false, error: 'Authorization header required' };

    const tokenMatch = auth.match(/^Bearer\s+(.+)$/i);
    if (!tokenMatch) return { valid: false, error: 'Invalid authorization format' };
    const token = tokenMatch[1];

    if (this.config.auth?.tokens?.length &&
        !this.config.auth.tokens.some((candidate) => this.timingSafeCompare(token, candidate))) {
      return { valid: false, error: 'Invalid token' };
    }

    return { valid: true, principal: principalFromSecret(token, 'token') };
  }
}

export function createHttpTransport(logger: ILogger, config: HttpTransportConfig): HttpTransport {
  return new HttpTransport(logger, config);
}
