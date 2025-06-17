/**
 * Integration tests for terminal functionality
 */

import { assertEquals, assertExists, assertRejects } from '@std/assert';
import { TerminalManager } from '../../src/terminal/manager.ts';
import { NativeAdapter } from '../../src/terminal/adapters/native.ts';
import { VSCodeAdapter } from '../../src/terminal/adapters/vscode.ts';
import { TerminalPool } from '../../src/terminal/pool.ts';
import { TerminalSession } from '../../src/terminal/session.ts';
import { EventBus } from '../../src/core/event-bus.ts';
import { Logger } from '../../src/core/logger.ts';
import { TerminalConfig, AgentProfile } from '../../src/utils/types.ts';
import { delay } from '../../src/utils/helpers.ts';

/**
 * Test fixtures
 */
const createTestConfig = (): TerminalConfig => ({
  type: 'native',
  poolSize: 2,
  recycleAfter: 3,
  healthCheckInterval: 5000,
  commandTimeout: 10000,
});

const createTestProfile = (id: string): AgentProfile => ({
  id,
  name: `Test Agent ${id}`,
  type: 'custom',
  capabilities: ['execute', 'test'],
  systemPrompt: 'You are a test agent',
  maxConcurrentTasks: 1,
  priority: 1,
  metadata: {
    workingDirectory: Deno.cwd(),
    initCommands: ['echo "Test agent initialized"'],
    cleanupCommands: ['echo "Test agent cleanup"'],
  },
});

/**
 * Native adapter tests
 */
Deno.test('NativeAdapter - creates and destroys terminals', async () => {
  const logger = new Logger({ level: 'debug', format: 'text', destination: 'console' });
  const adapter = new NativeAdapter(logger);

  await adapter.initialize();

  // Create terminal
  const terminal = await adapter.createTerminal();
  assertExists(terminal);
  assertExists(terminal.id);
  assertEquals(terminal.isAlive(), true);

  // Execute command
  const output = await terminal.executeCommand('echo "Hello World"');
  assertEquals(output.trim(), 'Hello World');

  // Destroy terminal
  await adapter.destroyTerminal(terminal);
  assertEquals(terminal.isAlive(), false);

  await adapter.shutdown();
});

Deno.test('NativeAdapter - handles multiple shells', async () => {
  const logger = new Logger({ level: 'debug', format: 'text', destination: 'console' });
  const adapter = new NativeAdapter(logger);

  await adapter.initialize();

  const terminal = await adapter.createTerminal();
  
  // Test shell-specific commands
  const platform = Deno.build.os;
  if (platform === 'windows') {
    // Windows specific test
    const output = await terminal.executeCommand('echo %CLAUDE_FLOW_TERMINAL%');
    assertEquals(output.trim(), 'true');
  } else {
    // Unix-like specific test
    const output = await terminal.executeCommand('echo $CLAUDE_FLOW_TERMINAL');
    assertEquals(output.trim(), 'true');
  }

  await adapter.destroyTerminal(terminal);
  await adapter.shutdown();
});

/**
 * Terminal pool tests
 */
Deno.test('TerminalPool - manages terminal lifecycle', async () => {
  const logger = new Logger({ level: 'debug', format: 'text', destination: 'console' });
  const adapter = new NativeAdapter(logger);
  await adapter.initialize();

  const pool = new TerminalPool(3, 2, adapter, logger);
  await pool.initialize();

  // Acquire terminals
  const term1 = await pool.acquire();
  const term2 = await pool.acquire();
  
  assertExists(term1);
  assertExists(term2);
  assertEquals(term1.id !== term2.id, true);

  // Release terminals
  await pool.release(term1);
  await pool.release(term2);

  // Check health status
  const health = await pool.getHealthStatus();
  assertEquals(health.healthy, true);
  assertEquals(health.size >= 2, true);

  await pool.shutdown();
  await adapter.shutdown();
});

Deno.test('TerminalPool - recycles terminals after use count', async () => {
  const logger = new Logger({ level: 'debug', format: 'text', destination: 'console' });
  const adapter = new NativeAdapter(logger);
  await adapter.initialize();

  const pool = new TerminalPool(2, 2, adapter, logger); // Recycle after 2 uses
  await pool.initialize();

  const terminal = await pool.acquire();
  const originalId = terminal.id;

  // Use and release twice to trigger recycling
  await pool.release(terminal);
  const term2 = await pool.acquire();
  assertEquals(term2.id, originalId); // Should get same terminal
  
  await pool.release(term2);
  const term3 = await pool.acquire();
  assertEquals(term3.id !== originalId, true); // Should get new terminal after recycling

  await pool.shutdown();
  await adapter.shutdown();
});

/**
 * Terminal session tests
 */
Deno.test('TerminalSession - manages command execution', async () => {
  const logger = new Logger({ level: 'debug', format: 'text', destination: 'console' });
  const adapter = new NativeAdapter(logger);
  await adapter.initialize();

  const terminal = await adapter.createTerminal();
  const profile = createTestProfile('test-1');
  const session = new TerminalSession(terminal, profile, 5000, logger);

  await session.initialize();

  // Execute command
  const output = await session.executeCommand('echo "Session test"');
  assertEquals(output.trim(), 'Session test');

  // Check command history
  const history = session.getCommandHistory();
  assertEquals(history.length, 1);
  assertEquals(history[0], 'echo "Session test"');

  // Check health
  assertEquals(session.isHealthy(), true);

  await session.cleanup();
  await adapter.destroyTerminal(terminal);
  await adapter.shutdown();
});

Deno.test('TerminalSession - handles output streaming', async () => {
  const logger = new Logger({ level: 'debug', format: 'text', destination: 'console' });
  const adapter = new NativeAdapter(logger);
  await adapter.initialize();

  const terminal = await adapter.createTerminal();
  const profile = createTestProfile('test-2');
  const session = new TerminalSession(terminal, profile, 5000, logger);

  await session.initialize();

  // Set up output streaming
  const outputs: string[] = [];
  const unsubscribe = session.streamOutput((data) => {
    outputs.push(data);
  });

  // Execute commands
  await session.executeCommand('echo "Line 1"');
  await session.executeCommand('echo "Line 2"');

  // Check streamed output
  await delay(100); // Allow output to be processed
  assertEquals(outputs.length > 0, true);

  unsubscribe();
  await session.cleanup();
  await adapter.destroyTerminal(terminal);
  await adapter.shutdown();
});

/**
 * Terminal manager tests
 */
Deno.test('TerminalManager - complete workflow', async () => {
  const eventBus = new EventBus();
  const logger = new Logger({ level: 'debug', format: 'text', destination: 'console' });
  const config = createTestConfig();
  
  const manager = new TerminalManager(config, eventBus, logger);
  await manager.initialize();

  // Spawn terminal for agent
  const profile = createTestProfile('manager-test');
  const terminalId = await manager.spawnTerminal(profile);
  assertExists(terminalId);

  // Execute command
  const output = await manager.executeCommand(terminalId, 'echo "Manager test"');
  assertEquals(output.trim(), 'Manager test');

  // Get active sessions
  const sessions = manager.getActiveSessions();
  assertEquals(sessions.length, 1);
  assertEquals(sessions[0].agentId, profile.id);

  // Check health
  const health = await manager.getHealthStatus();
  assertEquals(health.healthy, true);
  assertEquals(health.metrics?.activeSessions, 1);

  // Terminate terminal
  await manager.terminateTerminal(terminalId);
  
  // Verify cleanup
  const sessionsAfter = manager.getActiveSessions();
  assertEquals(sessionsAfter.length, 0);

  await manager.shutdown();
});

Deno.test('TerminalManager - handles maintenance', async () => {
  const eventBus = new EventBus();
  const logger = new Logger({ level: 'debug', format: 'text', destination: 'console' });
  const config = createTestConfig();
  
  const manager = new TerminalManager(config, eventBus, logger);
  await manager.initialize();

  // Track maintenance events
  let maintenanceEvent: any;
  eventBus.on('terminal:maintenance', (event) => {
    maintenanceEvent = event;
  });

  // Spawn terminal
  const profile = createTestProfile('maintenance-test');
  const terminalId = await manager.spawnTerminal(profile);

  // Perform maintenance
  await manager.performMaintenance();

  // Check event was emitted
  assertExists(maintenanceEvent);
  assertEquals(maintenanceEvent.activeSessions, 1);

  await manager.terminateTerminal(terminalId);
  await manager.shutdown();
});

/**
 * Error handling tests
 */
Deno.test('TerminalManager - handles spawn errors gracefully', async () => {
  const eventBus = new EventBus();
  const logger = new Logger({ level: 'debug', format: 'text', destination: 'console' });
  const config: TerminalConfig = {
    ...createTestConfig(),
    poolSize: 0, // Force pool exhaustion
  };
  
  const manager = new TerminalManager(config, eventBus, logger);
  await manager.initialize();

  const profile = createTestProfile('error-test');
  
  // Should throw when pool is exhausted
  await assertRejects(
    async () => await manager.spawnTerminal(profile),
    Error,
  );

  await manager.shutdown();
});

Deno.test('TerminalSession - handles command timeout', async () => {
  const logger = new Logger({ level: 'debug', format: 'text', destination: 'console' });
  const adapter = new NativeAdapter(logger);
  await adapter.initialize();

  const terminal = await adapter.createTerminal();
  const profile = createTestProfile('timeout-test');
  const session = new TerminalSession(terminal, profile, 1000, logger); // 1 second timeout

  await session.initialize();

  // Execute command that takes too long
  await assertRejects(
    async () => await session.executeCommand('sleep 2'),
    Error,
    'timeout',
  );

  await session.cleanup();
  await adapter.destroyTerminal(terminal);
  await adapter.shutdown();
});

/**
 * Cross-platform tests
 */
Deno.test('Terminal - handles cross-platform commands', async () => {
  const logger = new Logger({ level: 'debug', format: 'text', destination: 'console' });
  const adapter = new NativeAdapter(logger);
  await adapter.initialize();

  const terminal = await adapter.createTerminal();
  
  // Platform-agnostic commands
  const outputs = await Promise.all([
    terminal.executeCommand('echo "Test 1"'),
    terminal.executeCommand('echo "Test 2"'),
    terminal.executeCommand('echo "Test 3"'),
  ]);

  assertEquals(outputs[0].trim(), 'Test 1');
  assertEquals(outputs[1].trim(), 'Test 2');
  assertEquals(outputs[2].trim(), 'Test 3');

  await adapter.destroyTerminal(terminal);
  await adapter.shutdown();
});

/**
 * VSCode adapter tests (only run when in VSCode context)
 */
if (typeof (globalThis as any).vscode !== 'undefined') {
  Deno.test('VSCodeAdapter - integrates with VSCode terminals', async () => {
    const logger = new Logger({ level: 'debug', format: 'text', destination: 'console' });
    const adapter = new VSCodeAdapter(logger);

    await adapter.initialize();

    const terminal = await adapter.createTerminal();
    assertExists(terminal);
    assertExists(terminal.id);

    const output = await terminal.executeCommand('echo "VSCode test"');
    assertEquals(output.trim(), 'VSCode test');

    await adapter.destroyTerminal(terminal);
    await adapter.shutdown();
  });
}