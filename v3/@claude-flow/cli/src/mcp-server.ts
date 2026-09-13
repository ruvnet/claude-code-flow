/**
 * V3 CLI MCP Server Management
 *
 * Provides server lifecycle management for MCP integration:
 * - Start/stop/status methods with process management
 * - Health check endpoint integration
 * - Graceful shutdown handling
 * - PID file management for daemon detection
 * - Event-based status monitoring
 *
 * Performance Targets:
 * - Server startup: <400ms
 * - Health check: <10ms
 * - Graceful shutdown: <5s
 *
 * @module @claude-flow/cli/mcp-server
 * @version 3.0.0
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess, execFileSync } from 'child_process';
import { createServer, Server, request as httpRequestFn } from 'http';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { trackRequest } from './mcp-tools/request-tracker.js';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * MCP Server configuration
 */
export interface MCPServerOptions {
  transport?: 'stdio' | 'http' | 'websocket';
  host?: string;
  port?: number;
  pidFile?: string;
  logFile?: string;
  tools?: string[] | 'all';
  daemonize?: boolean;
  timeout?: number;
}

/**
 * MCP Server status
 */
export interface MCPServerStatus {
  running: boolean;
  pid?: number;
  transport?: string;
  host?: string;
  port?: number;
  uptime?: number;
  tools?: number;
  startedAt?: string;
  health?: {
    healthy: boolean;
    error?: string;
    metrics?: Record<string, number>;
  };
}

/**
 * Default configuration
 */
const DEFAULT_OPTIONS: Required<MCPServerOptions> = {
  transport: 'stdio',
  host: 'localhost',
  port: 3000,
  pidFile: path.join(os.tmpdir(), 'claude-flow-mcp.pid'),
  logFile: path.join(os.tmpdir(), 'claude-flow-mcp.log'),
  tools: 'all',
  daemonize: false,
  timeout: 30000,
};

export function parseMcpToolSelection(value: string | undefined): string[] | 'all' {
  if (!value || value.trim().toLowerCase() === 'all') return 'all';
  const selectors = value.split(',').map((item) => item.trim()).filter(Boolean);
  return selectors.length > 0 ? selectors : 'all';
}

/**
 * Apply the existing `--tools` contract to advertised schemas. A selector can
 * be an exact tool name, a category, or a namespace prefix (`memory` matches
 * `memory_store`). Execution remains registered internally; only the fixed
 * per-request schema catalogue is reduced.
 */
export function filterAdvertisedMcpTools<T extends { name: string; category?: string }>(
  tools: T[],
  selection: string[] | 'all',
): T[] {
  if (selection === 'all') return tools;
  const selectors = new Set(selection.map((item) => item.toLowerCase()));
  return tools.filter((tool) => {
    const name = tool.name.toLowerCase();
    const category = tool.category?.toLowerCase();
    return selectors.has(name)
      || (category !== undefined && selectors.has(category))
      || Array.from(selectors).some((selector) => name.startsWith(`${selector}_`));
  });
}

export interface McpSchemaOverhead {
  toolCount: number;
  bytes: number;
  estimatedTokens: number;
  contextWindowTokens?: number;
  ratio?: number;
  risk: 'normal' | 'high';
}

/** Conservative JSON-size estimate for the fixed tools/list catalogue. */
export function assessMcpSchemaOverhead(
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
  contextWindowTokens?: number,
): McpSchemaOverhead {
  const catalogue = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  const bytes = Buffer.byteLength(JSON.stringify(catalogue), 'utf8');
  const estimatedTokens = Math.ceil(bytes / 4);
  const validWindow = Number.isFinite(contextWindowTokens) && Number(contextWindowTokens) > 0
    ? Number(contextWindowTokens)
    : undefined;
  const ratio = validWindow ? estimatedTokens / validWindow : undefined;
  return {
    toolCount: tools.length,
    bytes,
    estimatedTokens,
    ...(validWindow === undefined ? {} : { contextWindowTokens: validWindow }),
    ...(ratio === undefined ? {} : { ratio }),
    risk: (ratio !== undefined ? ratio >= 0.2 : estimatedTokens >= 8_000)
      ? 'high'
      : 'normal',
  };
}

/**
 * MCP Server Manager
 *
 * Manages the lifecycle of the MCP server process
 */
export class MCPServerManager extends EventEmitter {
  private options: Required<MCPServerOptions>;
  private process?: ChildProcess;
  private server?: Server;
  private startTime?: Date;
  private healthCheckInterval?: NodeJS.Timeout;
  private mcpServers: Array<{ stop(): Promise<void> }> = [];

  constructor(options: MCPServerOptions = {}) {
    super();
    // `options.tools`, populated by the `mcp start --tools` CLI flag, is
    // spread last below and therefore takes precedence over this env fallback.
    const environmentTools = parseMcpToolSelection(process.env.CLAUDE_FLOW_MCP_TOOLS);
    this.options = {
      ...DEFAULT_OPTIONS,
      ...(environmentTools === 'all' ? {} : { tools: environmentTools }),
      ...options,
    };
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<MCPServerStatus> {
    // Check if already running (skip if status reports our own PID —
    // getStatus() returns running=true for the current process in stdio mode
    // even before the server is actually started)
    const status = await this.getStatus();
    if (status.running && status.pid !== process.pid) {
      throw new Error(`MCP Server already running (PID: ${status.pid})`);
    }

    const startTime = performance.now();
    this.startTime = new Date();

    this.emit('starting', { options: this.options });

    try {
      if (this.options.transport === 'stdio') {
        // For stdio transport, spawn the server process
        await this.startStdioServer();
      } else {
        // For HTTP/WebSocket, start in-process server
        await this.startHttpServer();
      }

      const duration = performance.now() - startTime;

      // Write PID file
      await this.writePidFile();

      // Start health check monitoring
      this.startHealthMonitoring();

      const finalStatus = await this.getStatus();

      this.emit('started', {
        ...finalStatus,
        startupTime: duration,
      });

      return finalStatus;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop the MCP server
   */
  async stop(force = false): Promise<void> {
    const status = await this.getStatus();

    if (!status.running) {
      return;
    }

    this.emit('stopping', { force });

    try {
      // Stop health monitoring
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = undefined;
      }

      if (this.process) {
        // Graceful shutdown
        if (!force) {
          this.process.kill('SIGTERM');
          await this.waitForExit(5000);
        }

        // Force kill if still running
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }

        this.process = undefined;
      }

      if (this.server) {
        await new Promise<void>((resolve) => {
          this.server!.close(() => resolve());
        });
        this.server = undefined;
      }

      if (this.mcpServers.length > 0) {
        const servers = this.mcpServers;
        this.mcpServers = [];
        await Promise.all(servers.map((server) => server.stop()));
      }

      // Remove PID file
      await this.removePidFile();

      this.startTime = undefined;
      this.emit('stopped');
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get server status
   */
  async getStatus(): Promise<MCPServerStatus> {
    // Check PID file
    const pid = await this.readPidFile();

    if (!pid) {
      // No PID file found. Detect if we are running in stdio mode
      // (e.g., launched by Claude Code via `claude mcp add`).
      const isStdio = !process.stdin.isTTY;
      const envTransport = process.env.CLAUDE_FLOW_MCP_TRANSPORT;
      if (isStdio || envTransport === 'stdio' || this.options.transport === 'stdio') {
        return {
          running: true,
          pid: process.pid,
          transport: 'stdio',
          startedAt: this.startTime?.toISOString(),
          uptime: this.startTime
            ? Math.floor((Date.now() - this.startTime.getTime()) / 1000)
            : undefined,
        };
      }
      return { running: false };
    }

    // Check if process is running
    const isRunning = this.isProcessRunning(pid);

    if (!isRunning) {
      // Clean up stale PID file
      await this.removePidFile();
      return { running: false };
    }

    // Build status
    const status: MCPServerStatus = {
      running: true,
      pid,
      transport: this.options.transport,
      host: this.options.host,
      port: this.options.port,
      startedAt: this.startTime?.toISOString(),
      uptime: this.startTime
        ? Math.floor((Date.now() - this.startTime.getTime()) / 1000)
        : undefined,
    };

    // Get health status for HTTP transport
    if (this.options.transport !== 'stdio') {
      status.health = await this.checkHealth();
    }

    return status;
  }

  /**
   * Check server health
   */
  async checkHealth(): Promise<{
    healthy: boolean;
    error?: string;
    metrics?: Record<string, number>;
  }> {
    if (this.options.transport === 'stdio') {
      // For stdio, check if process is running
      const pid = await this.readPidFile();
      if (pid === null) {
        return { healthy: false, error: 'No PID file found' };
      }
      if (!this.isProcessRunning(pid)) {
        // Clean up stale PID file
        await this.removePidFile();
        return { healthy: false, error: 'Process not running (cleaned up stale PID)' };
      }
      return { healthy: true };
    }

    // For HTTP/WebSocket, make health check request
    try {
      const response = await this.httpRequest(
        `http://${this.options.host}:${this.options.port}/health`,
        'GET',
        this.options.timeout
      );

      return {
        healthy: response.status === 'ok',
        metrics: {
          connections: response.connections || 0,
        },
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Restart the server
   */
  async restart(): Promise<MCPServerStatus> {
    await this.stop();
    return await this.start();
  }

  /**
   * Start stdio server in-process
   * Handles stdin/stdout directly like V2 implementation
   */
  private async startStdioServer(): Promise<void> {
    // ruflo#1910 — protect the JSON-RPC stdout from any stray
    // console.log/info/debug emitted by lazily-loaded modules
    // (@ruvector/router, @claude-flow/neural, transformers.js, ONNX,
    // semantic-router init, etc.). Codex closes the MCP transport
    // the moment it sees a non-JSON line on stdout, and one such
    // line during a tool batch bricked the whole session.
    //
    // Strategy: replace console.log/info/debug with stderr writers
    // for the rest of the process. JSON-RPC frames go out via the
    // dedicated `writeFrame()` helper below (process.stdout.write
    // with the original native binding, NOT console.log), so the
    // hijack can't accidentally redirect protocol frames too.
    process.env.MCP_STDIO_MODE = '1';
    const originalLog = console.log;  // eslint-disable-line no-console
    console.log = (...args: unknown[]) => process.stderr.write('[stdout→stderr] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n');
    console.info = (...args: unknown[]) => process.stderr.write('[stdout→stderr] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n');
    console.debug = (...args: unknown[]) => process.stderr.write('[stdout→stderr] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n');

    // #2426 — Force blocking writes on stdout so JSON-RPC frames larger than
    // the OS pipe buffer (64KB on macOS) are delivered atomically. Without
    // this, `process.stdout.write()` returns after a partial write when the
    // pipe buffer is full; the truncated frame is unparseable JSON and the
    // MCP client (Claude Code) silently drops all 314 tools. The MCP SDK's
    // StdioServerTransport does the same thing for this reason. `setBlocking`
    // is an internal Node API but stable since v10 and used in many MCP
    // implementations; we feature-gate it so we degrade gracefully on
    // exotic stdout handles (e.g., when not bound to a pipe in tests).
    const stdoutHandle = (process.stdout as unknown as {
      _handle?: { setBlocking?: (b: boolean) => void };
    })._handle;
    if (stdoutHandle && typeof stdoutHandle.setBlocking === 'function') {
      stdoutHandle.setBlocking(true);
    }
    // Same for stderr — long structured error messages can also exceed the
    // pipe buffer and tearing those mid-message corrupts the client's log view.
    const stderrHandle = (process.stderr as unknown as {
      _handle?: { setBlocking?: (b: boolean) => void };
    })._handle;
    if (stderrHandle && typeof stderrHandle.setBlocking === 'function') {
      stderrHandle.setBlocking(true);
    }

    /** Send a single JSON-RPC frame to the real stdout. Use this instead
     * of `console.log` so the hijack above can't redirect protocol frames. */
    const writeFrame = (msg: unknown): void => {
      process.stdout.write(JSON.stringify(msg) + '\n');
    };
    // Reference originalLog to keep the eslint-disable meaningful — also
    // gives us an escape hatch if a test wants to verify it was replaced.
    void originalLog;

    // Catch fatal errors that would otherwise close the transport
    // mid-batch with no JSON-RPC error returned to the client.
    process.on('uncaughtException', (err) => {
      process.stderr.write(`[mcp-stdio] uncaughtException: ${err.stack || err.message}\n`);
    });
    process.on('unhandledRejection', (reason) => {
      process.stderr.write(`[mcp-stdio] unhandledRejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}\n`);
    });

    // Import the tool registry
    const { listMCPTools, callMCPTool, hasTool } = await import('./mcp-client.js');

    const VERSION = '3.0.0';
    const sessionId = `mcp-${Date.now()}-${randomUUID().slice(0, 8)}`;

    // Log to stderr to not corrupt stdout
    console.error(
      `[${new Date().toISOString()}] INFO [claude-flow-mcp] (${sessionId}) Starting in stdio mode`
    );

    // Auto-initialize memory database before tools are registered (#1524)
    // This ensures memory_store and other memory tools work immediately
    // without waiting for the first tool call to trigger lazy init.
    try {
      const { initializeMemoryDatabase, checkMemoryInitialization } = await import('./memory/memory-initializer.js');
      const status = await checkMemoryInitialization();
      if (!status.initialized) {
        console.error(
          `[${new Date().toISOString()}] INFO [claude-flow-mcp] (${sessionId}) Auto-initializing memory database...`
        );
        const result = await initializeMemoryDatabase({ force: false, verbose: false });
        if (result.success) {
          console.error(
            `[${new Date().toISOString()}] INFO [claude-flow-mcp] (${sessionId}) Memory database initialized at ${result.dbPath}`
          );
        } else if (result.error && !result.error.includes('already exists')) {
          console.error(
            `[${new Date().toISOString()}] WARN [claude-flow-mcp] (${sessionId}) Memory database init returned: ${result.error}`
          );
        }
      } else {
        console.error(
          `[${new Date().toISOString()}] INFO [claude-flow-mcp] (${sessionId}) Memory database already initialized (v${status.version || 'unknown'})`
        );
      }
    } catch (memInitError) {
      // Graceful degradation: server continues even if memory init fails.
      // Memory tools will attempt lazy init on first call via ensureInitialized().
      console.error(
        `[${new Date().toISOString()}] WARN [claude-flow-mcp] (${sessionId}) Memory auto-init failed (tools will retry on first call): ${memInitError instanceof Error ? memInitError.message : String(memInitError)}`
      );
    }
    console.error(JSON.stringify({
      arch: process.arch,
      mode: 'mcp-stdio',
      nodeVersion: process.version,
      pid: process.pid,
      platform: process.platform,
      protocol: 'stdio',
      sessionId,
      version: VERSION,
    }));

    // Per MCP protocol, the server MUST NOT send any messages to stdout before
    // receiving the client's `initialize` request. The previous code sent a
    // premature `server.initialized` notification here, which broke strict
    // MCP clients like Claude Desktop (see #898).

    // Handle stdin messages (S-5: bounded buffer to prevent OOM)
    const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB
    let buffer = '';

    process.stdin.on('data', async (chunk) => {
      buffer += chunk.toString();

      if (buffer.length > MAX_BUFFER_SIZE) {
        console.error(
          `[${new Date().toISOString()}] ERROR [claude-flow-mcp] Buffer exceeded ${MAX_BUFFER_SIZE} bytes, rejecting`
        );
        buffer = '';
        writeFrame({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Request too large' },
        });
        return;
      }

      // Process complete JSON messages
      let lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            const response = await this.handleMCPMessage(message, sessionId);
            if (response) {
              writeFrame(response);
            }
          } catch (error) {
            console.error(
              `[${new Date().toISOString()}] ERROR [claude-flow-mcp] Failed to parse message:`,
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      }
    });

    process.stdin.on('end', () => {
      console.error(
        `[${new Date().toISOString()}] INFO [claude-flow-mcp] (${sessionId}) stdin closed, shutting down...`
      );
      process.exit(0);
    });

    // Handle process termination
    process.on('SIGINT', () => {
      console.error(
        `[${new Date().toISOString()}] INFO [claude-flow-mcp] (${sessionId}) Received SIGINT, shutting down...`
      );
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.error(
        `[${new Date().toISOString()}] INFO [claude-flow-mcp] (${sessionId}) Received SIGTERM, shutting down...`
      );
      process.exit(0);
    });

    // Mark as ready immediately for stdio
    this.emit('ready');
  }

  /**
   * Handle incoming MCP message
   */
  private async handleMCPMessage(
    message: { jsonrpc: string; id?: string | number; method?: string; params?: unknown },
    sessionId: string
  ): Promise<{ jsonrpc: string; id?: string | number; result?: unknown; error?: { code: number; message: string } } | null> {
    const { listMCPTools, callMCPTool, hasTool } = await import('./mcp-client.js');

    if (!message.method) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32600, message: 'Invalid Request: missing method' },
      };
    }

    const params = (message.params || {}) as Record<string, unknown>;

    try {
      switch (message.method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'ruflo', version: '3.0.0' },
              capabilities: {
                tools: { listChanged: true },
                resources: { subscribe: true, listChanged: true },
              },
            },
          };

        case 'tools/list':
          const tools = filterAdvertisedMcpTools(listMCPTools(), this.options.tools);
          return {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: tools.map(tool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            },
          };

        case 'tools/call':
          const toolName = params.name as string;
          const toolParams = (params.arguments || {}) as Record<string, unknown>;

          if (!hasTool(toolName)) {
            return {
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: `Tool not found: ${toolName}` },
            };
          }

          try {
            const result = await callMCPTool(toolName, toolParams, { sessionId });
            trackRequest(toolName, true);
            return {
              jsonrpc: '2.0',
              id: message.id,
              result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
            };
          } catch (error) {
            trackRequest(toolName, false);
            return {
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32603,
                message: error instanceof Error ? error.message : 'Tool execution failed',
              },
            };
          }

        case 'notifications/initialized':
          // Client notification - no response needed
          console.error(
            `[${new Date().toISOString()}] INFO [claude-flow-mcp] (${sessionId}) Client initialized`
          );
          return null;

        case 'ping':
          return {
            jsonrpc: '2.0',
            id: message.id,
            result: {},
          };

        default:
          return {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: `Method not found: ${message.method}` },
          };
      }
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ERROR [claude-flow-mcp] Error handling ${message.method}:`,
        error
      );
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error',
        },
      };
    }
  }

  /**
   * Start HTTP server in-process
   */
  private async startHttpServer(): Promise<void> {
    // Dynamically import the MCP server package
    // FIX for issue #942: Use proper package import instead of broken relative path
    const { createMCPServer } = await import('@claude-flow/mcp');

    const logger = {
      debug: (msg: string, data?: unknown) => this.emit('log', { level: 'debug', msg, data }),
      info: (msg: string, data?: unknown) => this.emit('log', { level: 'info', msg, data }),
      warn: (msg: string, data?: unknown) => this.emit('log', { level: 'warn', msg, data }),
      error: (msg: string, data?: unknown) => this.emit('log', { level: 'error', msg, data }),
    };

    const { listMCPTools, callMCPTool } = await import('./mcp-client.js');
    const fallbackSessionId = `http-${randomUUID()}`;
    const cliTools = filterAdvertisedMcpTools(listMCPTools(), this.options.tools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      category: tool.category,
      tags: tool.tags,
      version: tool.version,
      cacheable: tool.cacheable,
      cacheTTL: tool.cacheTTL,
      handler: async (input: unknown, context?: { sessionId?: string }) => {
        try {
          const result = await callMCPTool(
            tool.name,
            (input as Record<string, unknown>) || {},
            { sessionId: context?.sessionId || fallbackSessionId }
          );
          trackRequest(tool.name, true);
          return result;
        } catch (error) {
          trackRequest(tool.name, false);
          throw error;
        }
      },
    }));

    // Use one MCP server with two HTTP transports for the localhost default.
    // Both loopback sockets therefore share sessions, tools, and notifications.
    const dualLoopback = this.options.host === 'localhost';
    const mcpServer = createMCPServer(
      {
        name: 'Claude-Flow MCP Server V3',
        version: '3.0.0',
        transport: this.options.transport as 'http' | 'websocket',
        host: dualLoopback ? '127.0.0.1' : this.options.host,
        additionalHosts: dualLoopback && this.options.transport === 'http' ? ['::1'] : undefined,
        port: this.options.port,
        enableMetrics: true,
        enableCaching: true,
      },
      logger
    );
    const registration = mcpServer.registerTools(
      cliTools as Parameters<typeof mcpServer.registerTools>[0]
    );
    if (registration.failed.length > 0) {
      throw new Error(`Failed to register MCP tools: ${registration.failed.join(', ')}`);
    }
    await mcpServer.start();
    this.mcpServers = [mcpServer];
  }

  /**
   * Wait for server to be ready
   */
  private async waitForReady(timeout = 10000): Promise<void> {
    // For stdio transport, we're ready immediately (in-process)
    if (this.options.transport === 'stdio') {
      return;
    }

    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const health = await this.checkHealth();
      if (health.healthy) {
        return;
      }
      await this.sleep(100);
    }

    throw new Error('Server failed to start within timeout');
  }

  /**
   * Wait for process to exit
   */
  private async waitForExit(timeout: number): Promise<void> {
    if (!this.process) return;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve();
      }, timeout);

      this.process!.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(async () => {
      try {
        const health = await this.checkHealth();
        this.emit('health', health);

        if (!health.healthy) {
          this.emit('unhealthy', health);
        }
      } catch (error) {
        this.emit('health-error', error);
      }
    }, 30000);
    this.healthCheckInterval.unref();
  }

  /**
   * Write PID file
   */
  private async writePidFile(): Promise<void> {
    const pid = this.process?.pid || process.pid;
    await fs.promises.writeFile(this.options.pidFile, String(pid), 'utf8');
  }

  /**
   * Read PID file
   */
  private async readPidFile(): Promise<number | null> {
    try {
      const content = await fs.promises.readFile(this.options.pidFile, 'utf8');
      const pid = parseInt(content.trim(), 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  /**
   * Remove PID file
   */
  private async removePidFile(): Promise<void> {
    try {
      await fs.promises.unlink(this.options.pidFile);
    } catch {
      // Ignore errors
    }
    // Also clean up legacy PID file location from older versions
    try {
      const legacyPath = path.join(process.env.CLAUDE_FLOW_CWD || process.cwd(), '.claude-flow', 'mcp-server.pid');
      if (legacyPath !== this.options.pidFile) {
        await fs.promises.unlink(legacyPath);
      }
    } catch {
      // Ignore — file may not exist
    }
  }

  /**
   * Check if process is running AND is a node/claude-flow process.
   * Plain `kill -0` returns true for any process with the same owner,
   * which causes false positives when the OS recycles the PID.
   */
  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }

    // Verify it's actually a node process (guards against PID reuse)
    // DA-CRIT-3: Use execFileSync to prevent command injection via PID values
    try {
      const safePid = String(Math.floor(Math.abs(pid)));
      let cmdline = '';
      try {
        // Try /proc on Linux
        cmdline = fs.readFileSync(`/proc/${safePid}/cmdline`, 'utf8');
      } catch {
        // Fall back to ps on macOS/other
        try {
          cmdline = execFileSync('ps', ['-p', safePid, '-o', 'comm='], {
            encoding: 'utf8',
            timeout: 1000,
          }).trim();
        } catch {
          // ps failed — fall through
        }
      }
      if (!cmdline) return true; // Can't inspect, fall back to kill check
      // Must be a node process to be our MCP server
      return cmdline.includes('node') || cmdline.includes('claude-flow') || cmdline.includes('npx');
    } catch {
      // If we can't inspect the process (macOS, Windows, permissions), fall back to kill check
      return true;
    }
  }

  /**
   * Make HTTP request
   */
  private async httpRequest(
    url: string,
    method: string,
    timeout: number
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);

      const req = httpRequestFn(
        {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname,
          method,
          timeout,
        },
        (res: any) => {
          let data = '';
          res.on('data', (chunk: string) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve({ status: res.statusCode === 200 ? 'ok' : 'error' });
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.end();
    });
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create MCP server manager
 */
export function createMCPServerManager(
  options?: MCPServerOptions
): MCPServerManager {
  return new MCPServerManager(options);
}

/**
 * Singleton server manager instance
 */
let serverManager: MCPServerManager | null = null;
let currentTransport: string | undefined = undefined;

/**
 * Get or create server manager singleton
 *
 * FIX for issue #942: Recreate singleton if transport type changes
 * Previously, once created with stdio (default), HTTP options were ignored
 */
export function getServerManager(
  options?: MCPServerOptions
): MCPServerManager {
  const requestedTransport = options?.transport;

  // Recreate if transport type changes (fixes HTTP transport not working)
  if (serverManager && requestedTransport && requestedTransport !== currentTransport) {
    serverManager = new MCPServerManager(options);
    currentTransport = requestedTransport;
  }

  if (!serverManager) {
    serverManager = new MCPServerManager(options);
    currentTransport = options?.transport;
  }
  return serverManager;
}

/**
 * Quick start MCP server
 */
export async function startMCPServer(
  options?: MCPServerOptions
): Promise<MCPServerStatus> {
  const manager = getServerManager(options);
  return await manager.start();
}

/**
 * Quick stop MCP server
 */
export async function stopMCPServer(force = false): Promise<void> {
  if (serverManager) {
    await serverManager.stop(force);
  }
}

/**
 * Get MCP server status
 */
export async function getMCPServerStatus(): Promise<MCPServerStatus> {
  const manager = getServerManager();
  return await manager.getStatus();
}

export default MCPServerManager;
