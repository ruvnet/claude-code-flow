/**
 * End-to-end tests for the start command
 */

import { assertEquals, assertExists } from '@std/assert';
import { describe, it } from '@std/testing/bdd';

describe('Start Command E2E', () => {
  describe('JavaScript CLI', () => {
    it('should show help with UI option', async () => {
      const command = new Deno.Command(Deno.execPath(), {
        args: ['run', '--allow-all', 'src/cli/simple-cli.js', 'start', '--help'],
        stdout: 'piped',
        stderr: 'piped',
      });

      const { stdout, stderr, success } = await command.output();
      const output = new TextDecoder().decode(stdout);
      const error = new TextDecoder().decode(stderr);

      assertEquals(success, true);
      assertEquals(output.includes('--ui'), true);
      assertEquals(output.includes('Launch interactive process management UI'), true);
      assertEquals(output.includes('Process Management UI:'), true);
    });

    it('should handle UI flag', async () => {
      const command = new Deno.Command(Deno.execPath(), {
        args: ['run', '--allow-all', 'src/cli/simple-cli.js', 'start', '--ui'],
        stdout: 'piped',
        stderr: 'piped',
      });

      const { stdout, stderr, success } = await command.output();
      const output = new TextDecoder().decode(stdout);

      assertEquals(success, true);
      assertEquals(output.includes('Launching interactive process management UI'), true);
    });
  });

  describe('ProcessManager functionality', () => {
    it('should manage process lifecycle', async () => {
      const testScript = `
        import { ProcessManager } from './src/cli/commands/start/process-manager.ts';
        
        const manager = new ProcessManager();
        await manager.initialize();
        
        // Test process lifecycle
        const processes = manager.getAllProcesses();
        console.log('PROCESSES:' + processes.length);
        
        // Start a process
        await manager.startProcess('event-bus');
        const eventBus = manager.getProcess('event-bus');
        console.log('STATUS:' + eventBus?.status);
        
        // Stop the process
        await manager.stopProcess('event-bus');
        const stopped = manager.getProcess('event-bus');
        console.log('STOPPED:' + stopped?.status);
        
        // Get stats
        const stats = manager.getSystemStats();
        console.log('STATS:' + stats.totalProcesses);
      `;

      const tempFile = await Deno.makeTempFile({ suffix: '.ts' });
      await Deno.writeTextFile(tempFile, testScript);

      const command = new Deno.Command(Deno.execPath(), {
        args: ['run', '--allow-all', tempFile],
        stdout: 'piped',
        stderr: 'piped',
      });

      const { stdout, success } = await command.output();
      const output = new TextDecoder().decode(stdout);

      await Deno.remove(tempFile);

      assertEquals(success, true);
      assertEquals(output.includes('PROCESSES:6'), true);
      assertEquals(output.includes('STATUS:running'), true);
      assertEquals(output.includes('STOPPED:stopped'), true);
      assertEquals(output.includes('STATS:6'), true);
    });
  });

  describe('SystemMonitor functionality', () => {
    it('should track events', async () => {
      const testScript = `
        import { ProcessManager } from './src/cli/commands/start/process-manager.ts';
        import { SystemMonitor } from './src/cli/commands/start/system-monitor.ts';
        import { eventBus } from './src/core/event-bus.ts';
        import { SystemEvents } from './src/utils/types.ts';
        
        const manager = new ProcessManager();
        const monitor = new SystemMonitor(manager);
        
        // Emit some events
        eventBus.emit(SystemEvents.AGENT_SPAWNED, { agentId: 'test-1', profile: { type: 'test' } });
        eventBus.emit(SystemEvents.TASK_COMPLETED, { taskId: 'task-1' });
        
        // Check events were tracked
        const events = monitor.getRecentEvents(10);
        console.log('EVENTS:' + events.length);
        console.log('HAS_AGENT:' + events.some(e => e.type === 'agent_spawned'));
        console.log('HAS_TASK:' + events.some(e => e.type === 'task_completed'));
      `;

      const tempFile = await Deno.makeTempFile({ suffix: '.ts' });
      await Deno.writeTextFile(tempFile, testScript);

      const command = new Deno.Command(Deno.execPath(), {
        args: ['run', '--allow-all', tempFile],
        stdout: 'piped',
        stderr: 'piped',
      });

      const { stdout, success } = await command.output();
      const output = new TextDecoder().decode(stdout);

      await Deno.remove(tempFile);

      assertEquals(success, true);
      assertEquals(output.includes('EVENTS:2'), true);
      assertEquals(output.includes('HAS_AGENT:true'), true);
      assertEquals(output.includes('HAS_TASK:true'), true);
    });
  });

  describe('Backward compatibility', () => {
    it('should support all original CLI options', async () => {
      // Test daemon flag
      const daemonTest = new Deno.Command(Deno.execPath(), {
        args: ['run', '--allow-all', 'src/cli/simple-cli.js', 'start', '--help'],
        stdout: 'piped',
      });
      const { stdout: daemonOut } = await daemonTest.output();
      const daemonHelp = new TextDecoder().decode(daemonOut);
      assertEquals(daemonHelp.includes('--daemon'), true);

      // Test port flag
      assertEquals(daemonHelp.includes('--port'), true);

      // Test verbose flag
      assertEquals(daemonHelp.includes('--verbose'), true);
    });

    it('should maintain existing functionality', async () => {
      // Create test directories
      const testDir = await Deno.makeTempDir();
      const originalCwd = Deno.cwd();
      
      try {
        Deno.chdir(testDir);
        await Deno.mkdir('memory', { recursive: true });
        await Deno.mkdir('coordination', { recursive: true });

        const command = new Deno.Command(Deno.execPath(), {
          args: ['run', '--allow-all', originalCwd + '/src/cli/simple-cli.js', 'start', '--daemon'],
          stdout: 'piped',
          stderr: 'piped',
        });

        const { stdout, success } = await command.output();
        const output = new TextDecoder().decode(stdout);

        assertEquals(success, true);
        assertEquals(output.includes('Starting in daemon mode'), true);
        assertEquals(output.includes('Process ID:'), true);

        // Check PID file was created
        const pidExists = await Deno.stat('.claude-flow.pid').then(() => true).catch(() => false);
        assertEquals(pidExists, true);

      } finally {
        Deno.chdir(originalCwd);
        await Deno.remove(testDir, { recursive: true });
      }
    });
  });
});