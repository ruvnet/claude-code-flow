/**
 * V3 CLI Status Command
 * System status display for Claude Flow
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { callMCPTool, MCPClientError } from '../mcp-client.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Status refresh interval (ms)
const DEFAULT_WATCH_INTERVAL = 2000;

// Track CPU usage over time
let lastCpuUsage: { user: number; system: number } | null = null;
let lastCpuTime = Date.now();

// Get real process CPU usage percentage
function getProcessCpuUsage(): number {
  const cpuUsage = process.cpuUsage(lastCpuUsage ? { user: lastCpuUsage.user, system: lastCpuUsage.system } : undefined);
  const now = Date.now();
  const elapsed = now - lastCpuTime;

  // Calculate percentage (cpuUsage is in microseconds)
  const totalCpu = (cpuUsage.user + cpuUsage.system) / 1000; // Convert to ms
  const percentage = elapsed > 0 ? (totalCpu / elapsed) * 100 : 0;

  // Update for next call
  lastCpuUsage = cpuUsage;
  lastCpuTime = now;

  return Math.min(100, Math.max(0, percentage));
}

// Get real process memory usage percentage
function getProcessMemoryUsage(): number {
  const memoryUsage = process.memoryUsage();
  const totalMemory = os.totalmem();
  const usedMemory = memoryUsage.heapUsed + memoryUsage.external;

  return (usedMemory / totalMemory) * 100;
}

// Check if project is initialized
//
// #2120 — the old check required `.claude-flow/config.yaml`, which
// missed projects that were initialized via `ruflo memory init` (writes
// `.swarm/memory.db` but no config.yaml) or via the auto-memory bridge.
// Reporter @alexandrelealbess on WSL2 had a 251-entry `.swarm/memory.db`
// and a running MCP, yet `ruflo status` reported "not initialized".
//
// Now: any of these signals counts as initialized:
//   - `.claude-flow/config.yaml`   (the canonical `ruflo init` output)
//   - `.claude-flow/config.json`   (same, alt format)
//   - `.swarm/memory.db`           (the `ruflo memory init` output)
//   - `.claude/settings.json`      (the Claude Code hook surface)
function isInitialized(cwd: string): boolean {
  const candidates = [
    path.join(cwd, '.claude-flow', 'config.yaml'),
    path.join(cwd, '.claude-flow', 'config.json'),
    path.join(cwd, '.swarm', 'memory.db'),
    path.join(cwd, '.claude', 'settings.json'),
  ];
  return candidates.some((p) => fs.existsSync(p));
}

// Format uptime
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

// Format bytes
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

// Get system status data
async function getSystemStatus(): Promise<{
  initialized: boolean;
  running: boolean;
  swarm: {
    id: string | null;
    topology: string;
    agents: { total: number; active: number; idle: number };
    health: string;
    uptime: number;
  };
  mcp: {
    running: boolean;
    port: number | null;
    transport: string;
  };
  memory: {
    entries: number;
    size: string;
    backend: string;
    performance: { searchTime: number; cacheHitRate: number };
  };
  tasks: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  };
  performance: {
    cpuUsage: number;
    memoryUsage: number;
    flashAttention: string;
    searchSpeed: string;
  };
}> {
  // Each service is queried independently so one failure doesn't hide others
  const defaultSwarm = { id: null as string | null, topology: 'none', agents: { total: 0, active: 0, idle: 0 }, health: 'stopped', uptime: 0 };
  const defaultMcp = { running: false, port: null as number | null, transport: 'stdio' };
  const defaultMemory = { entries: 0, size: '0 B', backend: 'none', performance: { searchTime: 0, cacheHitRate: 0 } };
  const defaultTasks = { total: 0, pending: 0, running: 0, completed: 0, failed: 0 };

  let anyServiceRunning = false;

  // Get swarm status
  let swarm = defaultSwarm;
  try {
    const s = await callMCPTool<{
      swarmId: string;
      topology: string;
      agents: { total: number; active: number; idle: number; terminated: number };
      health: string;
      uptime: number;
    }>('swarm_status', { includeMetrics: true });
    swarm = { id: s.swarmId, topology: s.topology, agents: { total: s.agents.total, active: s.agents.active, idle: s.agents.idle }, health: s.health, uptime: s.uptime };
    anyServiceRunning = true;
  } catch { /* swarm not running */ }

  // Get MCP status
  let mcp = defaultMcp;
  try {
    const m = await callMCPTool<{ running: boolean; port: number; transport: string }>('mcp_status', {});
    mcp = m;
    if (m.running) anyServiceRunning = true;
  } catch { /* MCP not running */ }

  // Get memory status
  let memory = defaultMemory;
  try {
    const mem = await callMCPTool<{
      entries: number;
      size: number;
      backend: string;
      performance: { avgSearchTime: number; cacheHitRate: number };
    }>('memory_stats', {});
    memory = { entries: mem.entries, size: formatBytes(mem.size), backend: mem.backend, performance: { searchTime: mem.performance.avgSearchTime, cacheHitRate: mem.performance.cacheHitRate } };
    anyServiceRunning = true;
  } catch { /* memory not available */ }

  // Get task status
  let tasks = defaultTasks;
  try {
    tasks = await callMCPTool<{ total: number; pending: number; running: number; completed: number; failed: number }>('task_summary', {});
    anyServiceRunning = true;
  } catch { /* task store not available */ }

  return {
    initialized: true,
    running: anyServiceRunning,
    swarm,
    mcp,
    memory,
    tasks,
    performance: {
      cpuUsage: getProcessCpuUsage(),
      memoryUsage: getProcessMemoryUsage(),
      flashAttention: 'not measured',
      searchSpeed: 'not measured'
    }
  };
}

// Display status in text format
function displayStatus(status: Awaited<ReturnType<typeof getSystemStatus>>): void {
  output.writeln();

  // Header with overall status
  const statusIcon = status.running
    ? output.success('[RUNNING]')
    : output.warning('[STOPPED]');
  output.writeln(`${output.bold('RuFlo V3')} ${statusIcon}`);
  output.writeln();

  // Swarm section
  output.writeln(output.bold('Swarm'));
  if (status.running) {
    output.printTable({
      columns: [
        { key: 'property', header: 'Property', width: 15 },
        { key: 'value', header: 'Value', width: 30 }
      ],
      data: [
        { property: 'ID', value: status.swarm.id },
        { property: 'Topology', value: status.swarm.topology },
        { property: 'Health', value: formatHealth(status.swarm.health) },
        { property: 'Uptime', value: formatUptime(status.swarm.uptime) }
      ]
    });
  } else {
    output.printInfo('  Swarm not running');
  }
  output.writeln();

  // Agents section
  output.writeln(output.bold('Agents'));
  output.printTable({
    columns: [
      { key: 'status', header: 'Status', width: 12 },
      { key: 'count', header: 'Count', width: 10, align: 'right' }
    ],
    data: [
      { status: 'Active', count: status.swarm.agents.active },
      { status: 'Idle', count: status.swarm.agents.idle },
      { status: output.bold('Total'), count: status.swarm.agents.total }
    ]
  });
  output.writeln();

  // Tasks section
  output.writeln(output.bold('Tasks'));
  output.printTable({
    columns: [
      { key: 'status', header: 'Status', width: 12 },
      { key: 'count', header: 'Count', width: 10, align: 'right' }
    ],
    data: [
      { status: 'Pending', count: status.tasks.pending },
      { status: 'Running', count: status.tasks.running },
      { status: 'Completed', count: status.tasks.completed },
      { status: 'Failed', count: status.tasks.failed },
      { status: output.bold('Total'), count: status.tasks.total }
    ]
  });
  output.writeln();

  // Memory section
  output.writeln(output.bold('Memory'));
  output.printTable({
    columns: [
      { key: 'property', header: 'Property', width: 18 },
      { key: 'value', header: 'Value', width: 20, align: 'right' }
    ],
    data: [
      { property: 'Backend', value: status.memory.backend },
      { property: 'Entries', value: status.memory.entries },
      { property: 'Size', value: status.memory.size },
      { property: 'Search Time', value: `${status.memory.performance.searchTime.toFixed(2)}ms` },
      { property: 'Cache Hit Rate', value: `${(status.memory.performance.cacheHitRate * 100).toFixed(1)}%` }
    ]
  });
  output.writeln();

  // MCP section
  output.writeln(output.bold('MCP Server'));
  if (status.mcp.running) {
    if (status.mcp.transport === 'stdio') {
      output.printInfo('  Running (stdio mode)');
    } else {
      output.printInfo(`  Running on port ${status.mcp.port} (${status.mcp.transport})`);
    }
  } else {
    output.printInfo('  Not running');
  }
  output.writeln();

  // Performance section
  if (status.running) {
    output.writeln(output.bold('V3 Performance Gains'));
    output.printList([
      `Flash Attention: ${output.success(status.performance.flashAttention)}`,
      `Vector Search: ${output.success(status.performance.searchSpeed)}`,
      `CPU Usage: ${status.performance.cpuUsage.toFixed(1)}%`,
      `Memory Usage: ${status.performance.memoryUsage.toFixed(1)}%`
    ]);
  }
}

// Format health status with color
function formatHealth(health: string): string {
  switch (health) {
    case 'healthy':
      return output.success(health);
    case 'degraded':
      return output.warning(health);
    case 'unhealthy':
    case 'stopped':
      return output.error(health);
    default:
      return health;
  }
}

// Main status action
const statusAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const watch = ctx.flags.watch as boolean;
  const interval = (ctx.flags.interval as number) || DEFAULT_WATCH_INTERVAL / 1000;
  const healthCheck = ctx.flags['health-check'] as boolean;
  const cwd = ctx.cwd;

  // Check initialization
  if (!isInitialized(cwd)) {
    output.printError('RuFlo is not initialized in this directory');
    output.printInfo('Run "ruflo init" to initialize');
    return { success: false, exitCode: 1 };
  }

  // Get status
  const status = await getSystemStatus();

  // Health check mode
  if (healthCheck) {
    return performHealthCheck(status);
  }

  // JSON output
  if (ctx.flags.format === 'json') {
    output.printJson(status);
    return { success: true, data: status };
  }

  // Watch mode
  if (watch) {
    return watchStatus(interval);
  }

  // Single status display
  displayStatus(status);

  return { success: true, data: status };
};

// Perform health checks
async function performHealthCheck(
  status: Awaited<ReturnType<typeof getSystemStatus>>
): Promise<CommandResult> {
  output.writeln();
  output.writeln(output.bold('Health Check'));
  output.writeln();

  const checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; message: string }> = [];

  // Check if system is running
  checks.push({
    name: 'System Running',
    status: status.running ? 'pass' : 'fail',
    message: status.running ? 'System is running' : 'System is not running'
  });

  // Check swarm health
  if (status.running) {
    checks.push({
      name: 'Swarm Health',
      status: status.swarm.health === 'healthy' ? 'pass' :
              status.swarm.health === 'degraded' ? 'warn' : 'fail',
      message: `Swarm is ${status.swarm.health}`
    });

    // Check agent count
    checks.push({
      name: 'Agents Available',
      status: status.swarm.agents.active > 0 ? 'pass' :
              status.swarm.agents.idle > 0 ? 'warn' : 'fail',
      message: `${status.swarm.agents.active} active, ${status.swarm.agents.idle} idle`
    });

    // Check MCP
    checks.push({
      name: 'MCP Server',
      status: status.mcp.running ? 'pass' : 'warn',
      message: status.mcp.running
        ? (status.mcp.transport === 'stdio' ? 'Running (stdio mode)' : `Running on port ${status.mcp.port}`)
        : 'Not running'
    });

    // Check memory backend
    checks.push({
      name: 'Memory Backend',
      status: status.memory.backend !== 'none' ? 'pass' : 'fail',
      message: `Using ${status.memory.backend} backend`
    });

    // Check for failed tasks
    const failRate = status.tasks.total > 0
      ? status.tasks.failed / status.tasks.total
      : 0;
    checks.push({
      name: 'Task Success Rate',
      status: failRate < 0.05 ? 'pass' : failRate < 0.2 ? 'warn' : 'fail',
      message: `${((1 - failRate) * 100).toFixed(1)}% success rate`
    });
  }

  // Display results
  for (const check of checks) {
    const icon = check.status === 'pass' ? output.success('[PASS]') :
                 check.status === 'warn' ? output.warning('[WARN]') :
                 output.error('[FAIL]');
    output.writeln(`${icon} ${check.name}: ${check.message}`);
  }

  output.writeln();

  const passed = checks.filter(c => c.status === 'pass').length;
  const warned = checks.filter(c => c.status === 'warn').length;
  const failed = checks.filter(c => c.status === 'fail').length;

  if (failed === 0) {
    output.printSuccess(`All checks passed (${passed} passed, ${warned} warnings)`);
  } else {
    output.printError(`Health check failed (${passed} passed, ${warned} warnings, ${failed} failed)`);
  }

  return {
    success: failed === 0,
    exitCode: failed > 0 ? 1 : 0,
    data: { checks, summary: { passed, warned, failed } }
  };
}

// Watch mode - continuous status updates
async function watchStatus(intervalSeconds: number): Promise<CommandResult> {
  output.writeln();
  output.writeln(output.bold('Watch Mode'));
  output.writeln(output.dim(`Refreshing every ${intervalSeconds}s. Press Ctrl+C to exit.`));
  output.writeln();

  const refresh = async () => {
    // Clear screen
    process.stdout.write('\x1b[2J\x1b[H');

    output.writeln(output.dim(`Last updated: ${new Date().toLocaleTimeString()}`));
    output.writeln();

    const status = await getSystemStatus();
    displayStatus(status);
  };

  // Initial display
  await refresh();

  // Set up interval
  const intervalId = setInterval(refresh, intervalSeconds * 1000);

  // Handle exit
  return new Promise((resolve) => {
    process.on('SIGINT', () => {
      clearInterval(intervalId);
      output.writeln();
      output.printInfo('Watch mode stopped');
      resolve({ success: true });
    });
  });
}

// Agents subcommand
const agentsCommand: Command = {
  name: 'agents',
  description: 'Show detailed agent status',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      const result = await callMCPTool<{
        agents: Array<{
          id: string;
          type: string;
          status: string;
          task?: string;
          uptime: number;
          metrics: { tasksCompleted: number; successRate: number };
        }>;
      }>('agent_list', { includeMetrics: true, status: 'all' });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Agent Status'));
      output.writeln();

      if (result.agents.length === 0) {
        output.printInfo('No agents running');
        return { success: true, data: result };
      }

      output.printTable({
        columns: [
          { key: 'id', header: 'ID', width: 20 },
          { key: 'type', header: 'Type', width: 12 },
          { key: 'status', header: 'Status', width: 10 },
          { key: 'task', header: 'Current Task', width: 25 },
          { key: 'uptime', header: 'Uptime', width: 12 },
          { key: 'success', header: 'Success', width: 8 }
        ],
        data: result.agents.map(a => ({
          id: a.id,
          type: a.type,
          status: formatHealth(a.status),
          task: a.task || '-',
          uptime: formatUptime(a.uptime),
          success: `${(a.metrics.successRate * 100).toFixed(0)}%`
        }))
      });

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to get agent status: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Tasks subcommand
const tasksCommand: Command = {
  name: 'tasks',
  description: 'Show detailed task status',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      const result = await callMCPTool<{
        tasks: Array<{
          id: string;
          type: string;
          status: string;
          priority: string;
          agent?: string;
          progress: number;
          createdAt: string;
        }>;
      }>('task_list', { status: 'all', limit: 50 });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Task Status'));
      output.writeln();

      if (result.tasks.length === 0) {
        output.printInfo('No tasks');
        return { success: true, data: result };
      }

      output.printTable({
        columns: [
          { key: 'id', header: 'ID', width: 15 },
          { key: 'type', header: 'Type', width: 15 },
          { key: 'status', header: 'Status', width: 12 },
          { key: 'priority', header: 'Priority', width: 10 },
          { key: 'agent', header: 'Agent', width: 15 },
          { key: 'progress', header: 'Progress', width: 10 }
        ],
        data: result.tasks.map(t => ({
          id: t.id,
          type: t.type,
          status: formatHealth(t.status),
          priority: t.priority,
          agent: t.agent || '-',
          progress: `${t.progress}%`
        }))
      });

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to get task status: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Memory subcommand
const memoryCommand: Command = {
  name: 'memory',
  description: 'Show detailed memory status',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      const result = await callMCPTool<{
        backend: string;
        entries: number;
        size: number;
        namespaces: Array<{ name: string; entries: number }>;
        performance: {
          avgSearchTime: number;
          avgWriteTime: number;
          cacheHitRate: number;
          hnswEnabled: boolean;
        };
        v3Gains: {
          searchImprovement: string;
          memoryReduction: string;
        };
      }>('memory_detailed-stats', {});

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Memory Status'));
      output.writeln();

      output.printTable({
        columns: [
          { key: 'property', header: 'Property', width: 20 },
          { key: 'value', header: 'Value', width: 25 }
        ],
        data: [
          { property: 'Backend', value: result.backend },
          { property: 'Total Entries', value: result.entries.toLocaleString() },
          { property: 'Storage Size', value: formatBytes(result.size) },
          { property: 'HNSW Index', value: result.performance.hnswEnabled ? 'Enabled' : 'Disabled' }
        ]
      });

      output.writeln();
      output.writeln(output.bold('Performance'));
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 20 },
          { key: 'value', header: 'Value', width: 20, align: 'right' }
        ],
        data: [
          { metric: 'Avg Search Time', value: `${result.performance.avgSearchTime.toFixed(2)}ms` },
          { metric: 'Avg Write Time', value: `${result.performance.avgWriteTime.toFixed(2)}ms` },
          { metric: 'Cache Hit Rate', value: `${(result.performance.cacheHitRate * 100).toFixed(1)}%` }
        ]
      });

      output.writeln();
      output.writeln(output.bold('V3 Performance Gains'));
      output.printList([
        `Search Speed: ${output.success(result.v3Gains.searchImprovement)}`,
        `Memory Usage: ${output.success(result.v3Gains.memoryReduction)}`
      ]);

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to get memory status: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Main status command
export const statusCommand: Command = {
  name: 'status',
  description: 'Show system status',
  subcommands: [agentsCommand, tasksCommand, memoryCommand],
  options: [
    {
      name: 'watch',
      short: 'w',
      description: 'Watch mode - continuously update status',
      type: 'boolean',
      default: false
    },
    {
      name: 'interval',
      short: 'i',
      description: 'Watch mode update interval in seconds',
      type: 'number',
      default: 2
    },
    {
      name: 'health-check',
      description: 'Perform health checks and exit',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow status', description: 'Show current system status' },
    { command: 'claude-flow status --watch', description: 'Watch mode with live updates' },
    { command: 'claude-flow status --watch -i 5', description: 'Watch mode updating every 5 seconds' },
    { command: 'claude-flow status --health-check', description: 'Run health checks' },
    { command: 'claude-flow status --json', description: 'Output status as JSON' },
    { command: 'claude-flow status agents', description: 'Show detailed agent status' },
    { command: 'claude-flow status tasks', description: 'Show detailed task status' },
    { command: 'claude-flow status memory', description: 'Show detailed memory status' }
  ],
  action: statusAction
};

export default statusCommand;
