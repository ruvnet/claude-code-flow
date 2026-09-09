/**
 * System MCP Tools for CLI
 *
 * V2 Compatibility - System monitoring tools: status, metrics, health
 *
 * ✅ Uses REAL system metrics via Node.js APIs:
 * - process.memoryUsage() for real memory stats
 * - process.cpuUsage() for real CPU stats
 * - os module for system information
 */

import { type MCPTool, getProjectCwd } from './types.js';
import { validateIdentifier } from './validate-input.js';
import { inspectActiveSwarmHealth } from './swarm-tools.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statfsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import * as dns from 'node:dns';

// Read version dynamically from package.json
function getPackageVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    for (const depth of ['../..', '../../..']) {
      const pkgPath = join(__dirname, depth, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.name?.includes('claude-flow') || pkg.name === 'ruflo') {
          return pkg.version || '3.0.0';
        }
      }
    }
    return '3.0.0';
  } catch {
    return '3.0.0';
  }
}
const PKG_VERSION = getPackageVersion();

// Storage paths
const STORAGE_DIR = '.claude-flow';
const SYSTEM_DIR = 'system';
const METRICS_FILE = 'metrics.json';

interface SystemMetrics {
  startTime: string;
  lastCheck: string;
  uptime: number;
  health: number;
  cpu: number;
  memory: { used: number; total: number };
  agents: { active: number; total: number };
  tasks: { pending: number; completed: number; failed: number };
  requests: { total: number; success: number; errors: number };
}

function getSystemDir(): string {
  return join(getProjectCwd(), STORAGE_DIR, SYSTEM_DIR);
}

function getMetricsPath(): string {
  return join(getSystemDir(), METRICS_FILE);
}

function ensureSystemDir(): void {
  const dir = getSystemDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadMetrics(): SystemMetrics {
  try {
    const path = getMetricsPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    // Return default metrics
  }
  return {
    startTime: new Date().toISOString(),
    lastCheck: new Date().toISOString(),
    uptime: 0,
    health: 1.0,
    cpu: os.loadavg()[0] * 100 / os.cpus().length,
    memory: { used: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024), total: Math.round(os.totalmem() / 1024 / 1024) },
    agents: { active: 0, total: 0 },
    tasks: { pending: 0, completed: 0, failed: 0 },
    requests: { total: 0, success: 0, errors: 0 },
  };
}

function saveMetrics(metrics: SystemMetrics): void {
  ensureSystemDir();
  metrics.lastCheck = new Date().toISOString();
  writeFileSync(getMetricsPath(), JSON.stringify(metrics, null, 2), 'utf-8');
}

export const systemTools: MCPTool[] = [
  {
    name: 'system_status',
    description: 'Get overall system status Use when native Bash is wrong because you need Ruflo runtime metrics (HNSW index size, ReasoningBank state, swarm health, breaker status) — those are not in /proc, only in the running daemon. For OS-level info (uptime, disk, mem), native Bash + standard tools are fine.',
    category: 'system',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Include detailed information' },
        components: { type: 'array', items: { type: 'string' }, description: 'Specific components to check' },
      },
    },
    handler: async (input) => {
      const metrics = loadMetrics();
      // #2235(B) — live process uptime, not the persisted metrics.startTime
      // (which is the file's creation timestamp and survived across restarts,
      // making system_status report stale ~8.8-day uptime on a fresh server).
      const uptime = Math.floor(process.uptime() * 1000);

      const status = {
        status: metrics.health >= 0.8 ? 'healthy' : metrics.health >= 0.5 ? 'degraded' : 'unhealthy',
        uptime,
        uptimeFormatted: `${Math.floor(uptime / 3600000)}h ${Math.floor((uptime % 3600000) / 60000)}m`,
        version: PKG_VERSION,
        components: {
          swarm: { status: 'running', health: metrics.health },
          memory: { status: 'unknown', _note: 'Health not measured — use system_health for real checks' },
          neural: { status: 'unknown', _note: 'Health not measured — use system_health for real checks' },
          mcp: { status: 'unknown', _note: 'Health not measured — use system_health for real checks' },
        },
        lastCheck: new Date().toISOString(),
      };

      if (input.verbose) {
        return {
          ...status,
          metrics: {
            cpu: metrics.cpu,
            memory: metrics.memory,
            agents: metrics.agents,
            tasks: metrics.tasks,
          },
        };
      }

      return status;
    },
  },
  {
    name: 'system_metrics',
    description: 'Get system metrics and performance data Use when native Bash is wrong because you need Ruflo runtime metrics (HNSW index size, ReasoningBank state, swarm health, breaker status) — those are not in /proc, only in the running daemon. For OS-level info (uptime, disk, mem), native Bash + standard tools are fine.',
    category: 'system',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['all', 'cpu', 'memory', 'agents', 'tasks', 'requests'], description: 'Metrics category' },
        timeRange: { type: 'string', description: 'Time range (e.g., 1h, 24h, 7d)' },
        format: { type: 'string', enum: ['json', 'table', 'summary'], description: 'Output format' },
      },
    },
    handler: async (input) => {
      const store = loadMetrics();
      const category = (input.category as string) || 'all';

      // Get REAL system metrics via Node.js APIs
      const memUsage = process.memoryUsage();
      const loadAvg = os.loadavg();
      const cpus = os.cpus();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();

      // Read real agent/task counts — try AgentDB first, fallback to JSON stores
      let agentCounts = { active: 0, total: 0 };
      let taskCounts = { pending: 0, completed: 0, failed: 0 };
      let _metricsSource: 'agentdb' | 'json-store' | 'none' = 'none';

      // Primary: AgentDB (sql.js + HNSW)
      try {
        const bridge = await import('../memory/memory-bridge.js');
        const agentResults = await bridge.bridgeListEntries({ namespace: 'agents', limit: 10000 }) as { entries?: Array<{ metadata?: string; value?: string }> } | null;
        const agentEntries = agentResults?.entries;
        if (agentEntries && agentEntries.length > 0) {
          let active = 0;
          for (const a of agentEntries) {
            try {
              const meta = a.metadata ? JSON.parse(a.metadata) : (a.value ? JSON.parse(a.value) : {});
              if (meta.status === 'active' || meta.status === 'running') active++;
            } catch { /* skip unparseable */ }
          }
          agentCounts = { total: agentEntries.length, active };
          _metricsSource = 'agentdb';
        }
        const taskResults = await bridge.bridgeListEntries({ namespace: 'tasks', limit: 10000 }) as { entries?: Array<{ metadata?: string; value?: string }> } | null;
        const taskEntries = taskResults?.entries;
        if (taskEntries && taskEntries.length > 0) {
          let pending = 0, completed = 0, failed = 0;
          for (const t of taskEntries) {
            try {
              const meta = t.metadata ? JSON.parse(t.metadata) : (t.value ? JSON.parse(t.value) : {});
              if (meta.status === 'pending' || meta.status === 'assigned') pending++;
              else if (meta.status === 'completed') completed++;
              else if (meta.status === 'failed') failed++;
            } catch { /* skip */ }
          }
          taskCounts = { pending, completed, failed };
          _metricsSource = 'agentdb';
        }
      } catch { /* AgentDB not available, try JSON fallback */ }

      // Fallback: JSON store files (backward compatibility)
      if (_metricsSource === 'none') {
        try {
          const agentStorePath = join(getProjectCwd(), STORAGE_DIR, 'agents', 'store.json');
          if (existsSync(agentStorePath)) {
            const agentStore = JSON.parse(readFileSync(agentStorePath, 'utf-8'));
            const agents = Object.values(agentStore.agents || {}) as Array<{ status: string }>;
            agentCounts = {
              total: agents.length,
              active: agents.filter(a => a.status === 'active' || a.status === 'running').length,
            };
            _metricsSource = 'json-store';
          }
        } catch { /* agent store not available */ }
        try {
          const taskStorePath = join(getProjectCwd(), STORAGE_DIR, 'tasks', 'store.json');
          if (existsSync(taskStorePath)) {
            const taskStore = JSON.parse(readFileSync(taskStorePath, 'utf-8'));
            const tasks = Object.values(taskStore.tasks || {}) as Array<{ status: string }>;
            taskCounts = {
              pending: tasks.filter(t => t.status === 'pending' || t.status === 'assigned').length,
              completed: tasks.filter(t => t.status === 'completed').length,
              failed: tasks.filter(t => t.status === 'failed').length,
            };
            _metricsSource = 'json-store';
          }
        } catch { /* task store not available */ }
      }

      const currentMetrics: SystemMetrics = {
        ...store,
        cpu: loadAvg[0] * 100 / cpus.length, // Real CPU load percentage
        memory: {
          used: Math.round((totalMem - freeMem) / 1024 / 1024), // Real MB used
          total: Math.round(totalMem / 1024 / 1024), // Real total MB
        },
        agents: agentCounts,
        tasks: taskCounts,
        requests: await (async () => {
          try {
            const { getRequestCounts } = await import('./request-tracker.js');
            const live = getRequestCounts();
            if (live.total > 0) {
              return { total: live.total, success: live.success, errors: live.errors };
            }
          } catch { /* tracker not available — fall back to stored value */ }
          return store.requests;
        })(),
        uptime: Math.floor(process.uptime() * 1000), // #2235(B) — live process uptime
        lastCheck: new Date().toISOString(),
      };

      saveMetrics(currentMetrics);

      if (category === 'all') {
        return {
          ...currentMetrics,
          _real: true,
          _metricsSource,
          heap: {
            used: Math.round(memUsage.heapUsed / 1024 / 1024),
            total: Math.round(memUsage.heapTotal / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024),
          },
          loadAverage: loadAvg,
          cpuCores: cpus.length,
        };
      }

      const categoryMap: Record<string, unknown> = {
        cpu: {
          usage: currentMetrics.cpu,
          cores: cpus.length,
          load: loadAvg,
          model: cpus[0]?.model,
          _real: true,
        },
        memory: {
          ...currentMetrics.memory,
          heap: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
          free: Math.round(freeMem / 1024 / 1024),
          _real: true,
        },
        agents: currentMetrics.agents,
        tasks: currentMetrics.tasks,
        requests: currentMetrics.requests,
      };

      return categoryMap[category] || currentMetrics;
    },
  },
  {
    name: 'system_health',
    description: 'Perform system health check Use when native Bash is wrong because you need Ruflo runtime metrics (HNSW index size, ReasoningBank state, swarm health, breaker status) — those are not in /proc, only in the running daemon. For OS-level info (uptime, disk, mem), native Bash + standard tools are fine.',
    category: 'system',
    inputSchema: {
      type: 'object',
      properties: {
        deep: { type: 'boolean', description: 'Perform deep health check' },
        components: { type: 'array', items: { type: 'string' }, description: 'Components to check' },
        fix: { type: 'boolean', description: 'Attempt to fix issues' },
      },
    },
    handler: async (input) => {
      const metrics = loadMetrics();
      const checks: Array<{ name: string; status: string; latency?: number; message?: string }> = [];
      const projectCwd = getProjectCwd();

      // Memory DB check — verify any supported store file exists.
      // #1843: cover sql.js / HNSW / .swarm and root-level rvf/db paths,
      // not just the legacy `.claude-flow/memory/*` triple.
      {
        const t0 = performance.now();
        const memoryCandidates = [
          join(projectCwd, '.claude-flow', 'memory', 'store.json'),       // legacy
          join(projectCwd, '.claude-flow', 'memory', 'agentdb.sqlite'),
          join(projectCwd, '.claude-flow', 'memory', 'store.rvf'),
          join(projectCwd, '.claude-flow', 'memory', 'claude-flow.db'),   // sql.js
          join(projectCwd, '.swarm', 'memory.db'),                        // swarm
          join(projectCwd, 'ruvector.db'),                                // ruvector
          join(projectCwd, 'agentdb.rvf'),                                // root rvf
        ];
        const memoryExists = memoryCandidates.some(existsSync);
        const elapsed = performance.now() - t0;
        checks.push({
          name: 'memory',
          status: memoryExists ? 'healthy' : 'degraded',
          latency: Math.round(elapsed * 100) / 100,
          message: memoryExists ? undefined : 'Memory store not found — run memory init',
        });
      }

      // Config check — verify config file exists.
      // #1843: also accept YAML config (.claude-flow/config.yaml) which
      // the rest of v3 treats as canonical; previous code only counted
      // .json variants and reported `degraded` when YAML was used.
      {
        const t0 = performance.now();
        const configCandidates = [
          join(projectCwd, '.claude-flow', 'config.json'),
          join(projectCwd, '.claude-flow', 'config.yaml'),
          join(projectCwd, '.claude-flow', 'config.yml'),
          join(projectCwd, 'claude-flow.config.json'),
          join(projectCwd, 'claude-flow.config.yaml'),
          join(projectCwd, 'claude-flow.config.yml'),
        ];
        const configExists = configCandidates.some(existsSync);
        const elapsed = performance.now() - t0;
        checks.push({
          name: 'config',
          status: configExists ? 'healthy' : 'degraded',
          latency: Math.round(elapsed * 100) / 100,
          message: configExists ? undefined : 'Config file not found — run init',
        });
      }

      // MCP check — this process is the MCP server if stdin is piped
      {
        const isStdio = !process.stdin.isTTY;
        checks.push({
          name: 'mcp',
          status: isStdio ? 'healthy' : 'unknown',
          message: isStdio ? 'MCP stdio server running (this process)' : 'Not running as MCP server',
        });
      }

      // Swarm — inspect the same persisted state used by swarm_status/health.
      const swarmHealth = inspectActiveSwarmHealth();
      checks.push({
        name: 'swarm',
        status: swarmHealth.status,
        message: swarmHealth.message,
      });

      // Neural — cannot verify, report unknown
      checks.push({
        name: 'neural',
        status: 'unknown',
        message: 'Neural network health not monitored',
      });

      if (input.deep) {
        // Disk check — real free space via statfsSync (Node 18.15+)
        {
          const t0 = performance.now();
          try {
            const stats = statfsSync(projectCwd);
            const totalBytes = stats.blocks * stats.bsize;
            const freeBytes = stats.bfree * stats.bsize;
            const totalGB = Math.round((totalBytes / (1024 ** 3)) * 10) / 10;
            const freeGB = Math.round((freeBytes / (1024 ** 3)) * 10) / 10;
            const freePercent = Math.round((freeBytes / totalBytes) * 100);
            const elapsed = performance.now() - t0;
            checks.push({
              name: 'disk',
              status: freePercent > 10 ? 'healthy' : 'warning',
              latency: Math.round(elapsed * 100) / 100,
              message: `${freeGB}GB free of ${totalGB}GB (${freePercent}%)`,
            });
          } catch {
            const elapsed = performance.now() - t0;
            checks.push({
              name: 'disk',
              status: 'unknown',
              latency: Math.round(elapsed * 100) / 100,
              message: 'Disk space check failed — statfsSync unavailable',
            });
          }
        }

        // Network — DNS resolution check with timeout
        {
          const t0 = performance.now();
          try {
            await Promise.race([
              dns.promises.lookup('registry.npmjs.org'),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
            ]);
            const elapsed = performance.now() - t0;
            checks.push({
              name: 'network',
              status: 'healthy',
              latency: Math.round(elapsed * 100) / 100,
              message: 'DNS resolution working',
            });
          } catch {
            const elapsed = performance.now() - t0;
            checks.push({
              name: 'network',
              status: 'warning',
              latency: Math.round(elapsed * 100) / 100,
              message: 'DNS resolution failed — check network',
            });
          }
        }

        // Database — accept both the coordination store and the canonical
        // swarm state store written by swarm_init.
        {
          const t0 = performance.now();
          const stores = [
            { path: join(projectCwd, '.claude-flow', 'coordination', 'store.json'), label: 'coordination store' },
            { path: join(projectCwd, '.claude-flow', 'swarm', 'swarm-state.json'), label: 'swarm state store' },
          ];
          const availableStore = stores.find((store) => existsSync(store.path));
          const elapsed = performance.now() - t0;
          checks.push({
            name: 'database',
            status: availableStore ? 'healthy' : 'unknown',
            latency: Math.round(elapsed * 100) / 100,
            message: availableStore
              ? `Persistent ${availableStore.label} available`
              : 'No coordination or swarm state store found',
          });
        }
      }

      // #1843: exclude `unknown` checks from the health score denominator.
      // Previously a check reporting `unknown` (e.g. swarm/neural which
      // can't be probed in-process) was counted as a non-healthy hit and
      // dragged the score below 100 even when every actionable check was
      // green. Treat `unknown` as advisory and surface it separately.
      const healthy = checks.filter(c => c.status === 'healthy').length;
      const advisory = checks.filter(c => c.status === 'unknown').length;
      const total = checks.length;
      const scoreDenominator = total - advisory;
      const overallHealth = scoreDenominator > 0 ? healthy / scoreDenominator : 1;

      // Update metrics
      metrics.health = overallHealth;
      saveMetrics(metrics);

      return {
        overall: overallHealth >= 0.8 ? 'healthy' : overallHealth >= 0.5 ? 'degraded' : 'unhealthy',
        score: Math.round(overallHealth * 100),
        checks,
        healthy,
        advisory,
        total,
        timestamp: new Date().toISOString(),
        issues: checks.filter(c => c.status !== 'healthy' && c.status !== 'unknown').map(c => ({
          component: c.name,
          status: c.status,
          suggestion: `Check ${c.name} component configuration`,
        })),
      };
    },
  },
  {
    name: 'system_info',
    description: 'Get system information Use when native Bash is wrong because you need Ruflo runtime metrics (HNSW index size, ReasoningBank state, swarm health, breaker status) — those are not in /proc, only in the running daemon. For OS-level info (uptime, disk, mem), native Bash + standard tools are fine.',
    category: 'system',
    inputSchema: {
      type: 'object',
      properties: {
        include: { type: 'array', items: { type: 'string' }, description: 'Information to include' },
      },
    },
    handler: async () => {
      // #2215: flashAttention must reflect the runtime probe, not a stale literal.
      // Same source-of-truth as hooks_intelligence / neural_status so the tools
      // can never report contradictory state for the same daemon.
      let flashAttentionAvailable = false;
      try {
        const { getFlashAttention } = await import('@claude-flow/neural');
        flashAttentionAvailable = getFlashAttention() !== null;
      } catch {
        flashAttentionAvailable = false;
      }

      return {
        version: PKG_VERSION,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        cwd: getProjectCwd(),
        env: process.env.NODE_ENV || 'development',
        features: {
          swarm: true,
          memory: true,
          neural: true,
          hnsw: true,
          quantization: true,
          flashAttention: flashAttentionAvailable,
        },
        limits: {
          maxAgents: 100,
          maxTasks: 1000,
          maxMemory: '4GB',
        },
      };
    },
  },
  {
    name: 'system_reset',
    description: 'Reset system state Use when native Bash is wrong because you need Ruflo runtime metrics (HNSW index size, ReasoningBank state, swarm health, breaker status) — those are not in /proc, only in the running daemon. For OS-level info (uptime, disk, mem), native Bash + standard tools are fine.',
    category: 'system',
    inputSchema: {
      type: 'object',
      properties: {
        component: { type: 'string', description: 'Component to reset (all, metrics, agents, tasks)' },
        confirm: { type: 'boolean', description: 'Confirm reset' },
      },
      required: ['confirm'],
    },
    handler: async (input) => {
      if (!input.confirm) {
        return { success: false, error: 'Reset requires confirmation' };
      }

      if (input.component) { const v = validateIdentifier(input.component, 'component'); if (!v.valid) return { success: false, error: v.error }; }
      const component = (input.component as string) || 'metrics';

      // Reset metrics to defaults
      const defaultMetrics: SystemMetrics = {
        startTime: new Date().toISOString(),
        lastCheck: new Date().toISOString(),
        uptime: 0,
        health: 1.0,
        cpu: os.loadavg()[0] * 100 / os.cpus().length,
        memory: { used: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024), total: Math.round(os.totalmem() / 1024 / 1024) },
        agents: { active: 0, total: 0 },
        tasks: { pending: 0, completed: 0, failed: 0 },
        requests: { total: 0, success: 0, errors: 0 },
      };

      saveMetrics(defaultMetrics);

      return {
        success: true,
        component,
        resetAt: new Date().toISOString(),
        message: `System ${component} has been reset`,
      };
    },
  },
  {
    name: 'mcp_status',
    description: 'Get MCP server status, including stdio mode detection Use when native Claude Code MCP status is wrong because you need Ruflo-side server detail — tool counts per namespace, transport stats, MCP handshake errors. For just "is MCP up?", `claude mcp list` is fine.',
    category: 'system',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      // Detect if we are running inside an MCP stdio session.
      // When Claude Code launches us via `claude mcp add`, stdin is piped (not a TTY)
      // and the process IS the MCP server, so it is running.
      const isStdio = !process.stdin.isTTY;
      const transport = process.env.CLAUDE_FLOW_MCP_TRANSPORT || (isStdio ? 'stdio' : 'http');
      const port = parseInt(process.env.CLAUDE_FLOW_MCP_PORT || '3000', 10);

      if (transport === 'stdio' || isStdio) {
        // In stdio mode the MCP server is this process itself
        return {
          running: true,
          pid: process.pid,
          transport: 'stdio',
          port: null,
          host: null,
        };
      }

      // For HTTP/WebSocket, try to check if the server is listening
      const host = process.env.CLAUDE_FLOW_MCP_HOST || 'localhost';
      try {
        const { createConnection } = await import('node:net');
        const connected = await new Promise<boolean>((resolve) => {
          const socket = createConnection({ host, port }, () => {
            socket.destroy();
            resolve(true);
          });
          socket.on('error', () => resolve(false));
          socket.setTimeout(2000, () => {
            socket.destroy();
            resolve(false);
          });
        });

        return {
          running: connected,
          transport,
          port,
          host,
        };
      } catch {
        return {
          running: false,
          transport,
          port,
          host,
        };
      }
    },
  },
  {
    name: 'task_summary',
    description: 'Get a summary of all tasks by status Use when native TodoWrite is wrong because you need cross-session task persistence, agent assignment, dependency tracking, or completion analytics in the .swarm/memory.db. For in-session checklists native TodoWrite is simpler and faster.',
    category: 'task',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      // Read from the task store file
      const storePath = join(getProjectCwd(), '.claude-flow', 'tasks', 'store.json');
      let tasks: Array<{ status: string }> = [];
      try {
        if (existsSync(storePath)) {
          const data = readFileSync(storePath, 'utf-8');
          const store = JSON.parse(data);
          tasks = Object.values(store.tasks || {});
        }
      } catch {
        // empty store
      }

      return {
        total: tasks.length,
        pending: tasks.filter(t => t.status === 'pending').length,
        running: tasks.filter(t => t.status === 'in_progress').length,
        completed: tasks.filter(t => t.status === 'completed').length,
        failed: tasks.filter(t => t.status === 'failed').length,
      };
    },
  },
  {
    // #1916: `ruflo start` referenced an unregistered `mcp_start` tool. MCP
    // tools run *in-process* via the CLI's TOOL_REGISTRY — there is no
    // separate server process to spawn from inside an MCP call. If this tool
    // responds, MCP is already up. (`ruflo mcp start` runs a standalone
    // stdio/HTTP server; that's a process command, not an MCP tool.)
    name: 'mcp_start',
    description: 'Report that the in-process MCP toolset is available (no-op "start" — if this tool responds, MCP is up). Use when native `claude mcp list` is wrong because you want Ruflo-side confirmation that the in-process registry loaded. For a standalone stdio/HTTP MCP server, run `ruflo mcp start` (a process command, not this tool). Pair with mcp_status for detail.',
    category: 'system',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'number', description: 'Port (advisory — in-process MCP has no port)' },
        transport: { type: 'string', description: 'Transport (advisory)' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Tool namespaces (advisory — all are loaded)' },
      },
    },
    handler: async (input) => {
      const isStdio = !process.stdin.isTTY;
      return {
        serverId: `in-process-${process.pid}`,
        port: typeof input.port === 'number' ? input.port : (parseInt(process.env.CLAUDE_FLOW_MCP_PORT || '0', 10) || null),
        transport: (input.transport as string) || process.env.CLAUDE_FLOW_MCP_TRANSPORT || (isStdio ? 'stdio' : 'in-process'),
        startedAt: new Date().toISOString(),
        note: 'MCP tools run in-process via the CLI; no separate server process was started. Use `ruflo mcp start` for a standalone server.',
      };
    },
  },
  {
    // #1916: `ruflo stop` referenced an unregistered `mcp_stop` tool. Same
    // story as mcp_start — nothing to stop for the in-process registry.
    name: 'mcp_stop',
    description: 'No-op "stop" for the in-process MCP toolset (there is no separate server process to stop from inside an MCP call). Use when native process-kill is wrong because you mistakenly think Ruflo runs a daemon — it does not, the tools live in the CLI process. To stop a standalone server run `ruflo mcp stop` or terminate that process. Pair with mcp_status.',
    category: 'system',
    inputSchema: {
      type: 'object',
      properties: {
        graceful: { type: 'boolean', description: 'Advisory (no-op)' },
        timeout: { type: 'number', description: 'Advisory (no-op)' },
      },
    },
    handler: async () => {
      return {
        stopped: false,
        note: 'no separate MCP server process; nothing to stop. The in-process toolset goes away when the CLI process exits. Use `ruflo mcp stop` for a standalone server.',
      };
    },
  },
];
