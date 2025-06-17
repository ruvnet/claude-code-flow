/**
 * Test suite for ProcessUI
 */

import { assertEquals, assertExists } from '@std/assert';
import { beforeEach, describe, it } from '@std/testing/bdd';
import { ProcessUI } from '../../../../src/cli/commands/start/process-ui.ts';
import { ProcessManager } from '../../../../src/cli/commands/start/process-manager.ts';
import { ProcessStatus } from '../../../../src/cli/commands/start/types.ts';

describe('ProcessUI', () => {
  let processManager: ProcessManager;
  let processUI: ProcessUI;

  beforeEach(() => {
    processManager = new ProcessManager();
    processUI = new ProcessUI(processManager);
  });

  describe('initialization', () => {
    it('should create ProcessUI instance', () => {
      assertExists(processUI);
    });

    it('should setup event listeners on ProcessManager', () => {
      // UI should react to process manager events
      let renderCalled = false;
      const originalRender = ProcessUI.prototype['render'];
      ProcessUI.prototype['render'] = function() {
        renderCalled = true;
      };

      // Create new instance to test event setup
      const ui = new ProcessUI(processManager);
      processManager.emit('statusChanged', { processId: 'test', status: ProcessStatus.RUNNING });
      
      // Restore original
      ProcessUI.prototype['render'] = originalRender;
    });
  });

  describe('formatting helpers', () => {
    it('should format uptime correctly', () => {
      const formatUptime = processUI['formatUptime'].bind(processUI);
      
      assertEquals(formatUptime(1000), '1s');
      assertEquals(formatUptime(60000), '1m 0s');
      assertEquals(formatUptime(3600000), '1h 0m');
      assertEquals(formatUptime(86400000), '1d 0h');
      assertEquals(formatUptime(90061000), '1d 1h'); // 1 day, 1 hour, 1 minute, 1 second
    });

    it('should display correct status icons', () => {
      const getStatusDisplay = processUI['getStatusDisplay'].bind(processUI);
      
      // Check each status has a unique display
      const displays = {
        [ProcessStatus.RUNNING]: getStatusDisplay(ProcessStatus.RUNNING),
        [ProcessStatus.STOPPED]: getStatusDisplay(ProcessStatus.STOPPED),
        [ProcessStatus.STARTING]: getStatusDisplay(ProcessStatus.STARTING),
        [ProcessStatus.STOPPING]: getStatusDisplay(ProcessStatus.STOPPING),
        [ProcessStatus.ERROR]: getStatusDisplay(ProcessStatus.ERROR),
        [ProcessStatus.CRASHED]: getStatusDisplay(ProcessStatus.CRASHED),
      };
      
      // All should be defined and unique
      const values = Object.values(displays);
      assertEquals(values.length, 6);
      assertEquals(new Set(values).size, 6); // All unique
    });
  });

  describe('command handling', () => {
    it('should handle help command', async () => {
      const handleCommand = processUI['handleCommand'].bind(processUI);
      
      // Mock console output
      const originalLog = console.log;
      let helpShown = false;
      console.log = (...args) => {
        if (args.join(' ').includes('Help')) {
          helpShown = true;
        }
      };
      
      await handleCommand('h');
      assertEquals(helpShown, true);
      
      // Restore
      console.log = originalLog;
    });

    it('should handle refresh command', async () => {
      const handleCommand = processUI['handleCommand'].bind(processUI);
      let renderCalled = false;
      
      processUI['render'] = () => {
        renderCalled = true;
      };
      
      await handleCommand('r');
      assertEquals(renderCalled, true);
    });

    it('should handle invalid commands', async () => {
      const handleCommand = processUI['handleCommand'].bind(processUI);
      
      // Mock console output
      const originalLog = console.log;
      let invalidMessageShown = false;
      console.log = (...args) => {
        if (args.join(' ').includes('Invalid command')) {
          invalidMessageShown = true;
        }
      };
      
      await handleCommand('xyz');
      assertEquals(invalidMessageShown, true);
      
      // Restore
      console.log = originalLog;
    });

    it('should handle numeric process selection', async () => {
      const handleCommand = processUI['handleCommand'].bind(processUI);
      await processManager.initialize();
      
      // Mock showProcessMenu
      let menuShownForProcess: any = null;
      processUI['showProcessMenu'] = async (process) => {
        menuShownForProcess = process;
      };
      
      await handleCommand('1');
      assertExists(menuShownForProcess);
      assertEquals(menuShownForProcess.id, 'event-bus');
    });
  });

  describe('process actions', () => {
    beforeEach(async () => {
      await processManager.initialize();
    });

    it('should start process', async () => {
      const startProcess = processUI['startProcess'].bind(processUI);
      
      await startProcess('event-bus');
      
      const process = processManager.getProcess('event-bus');
      assertEquals(process?.status, ProcessStatus.RUNNING);
    });

    it('should stop process', async () => {
      const stopProcess = processUI['stopProcess'].bind(processUI);
      
      // Start first
      await processManager.startProcess('event-bus');
      
      await stopProcess('event-bus');
      
      const process = processManager.getProcess('event-bus');
      assertEquals(process?.status, ProcessStatus.STOPPED);
    });

    it('should restart process', async () => {
      const restartProcess = processUI['restartProcess'].bind(processUI);
      
      // Start first
      await processManager.startProcess('event-bus');
      const firstStartTime = processManager.getProcess('event-bus')?.startTime;
      
      await new Promise(resolve => setTimeout(resolve, 100));
      await restartProcess('event-bus');
      
      const process = processManager.getProcess('event-bus');
      assertEquals(process?.status, ProcessStatus.RUNNING);
      assertEquals(process?.startTime !== firstStartTime, true);
    });

    it('should start all processes', async () => {
      const startAll = processUI['startAll'].bind(processUI);
      
      await startAll();
      
      const stats = processManager.getSystemStats();
      assertEquals(stats.runningProcesses >= 5, true);
    });

    it('should stop all processes', async () => {
      const stopAll = processUI['stopAll'].bind(processUI);
      
      // Start some processes first
      await processManager.startProcess('event-bus');
      await processManager.startProcess('memory-manager');
      
      await stopAll();
      
      const stats = processManager.getSystemStats();
      assertEquals(stats.runningProcesses, 0);
    });
  });

  describe('process details', () => {
    it('should show process details', () => {
      const showProcessDetails = processUI['showProcessDetails'].bind(processUI);
      
      // Mock console output
      const originalLog = console.log;
      let detailsShown = false;
      console.log = (...args) => {
        if (args.join(' ').includes('Process Details')) {
          detailsShown = true;
        }
      };
      
      const mockProcess = processManager.getProcess('event-bus')!;
      showProcessDetails(mockProcess);
      
      assertEquals(detailsShown, true);
      
      // Restore
      console.log = originalLog;
    });

    it('should display metrics when available', () => {
      const showProcessDetails = processUI['showProcessDetails'].bind(processUI);
      
      // Mock console output
      const originalLog = console.log;
      let metricsShown = false;
      console.log = (...args) => {
        if (args.join(' ').includes('Metrics:')) {
          metricsShown = true;
        }
      };
      
      const mockProcess = processManager.getProcess('event-bus')!;
      mockProcess.metrics = {
        cpu: 25.5,
        memory: 128,
        restarts: 2,
        lastError: 'Test error'
      };
      
      showProcessDetails(mockProcess);
      
      assertEquals(metricsShown, true);
      
      // Restore
      console.log = originalLog;
    });
  });

  describe('exit handling', () => {
    it('should prompt to stop running processes on exit', async () => {
      const handleExit = processUI['handleExit'].bind(processUI);
      
      // Start a process
      await processManager.initialize();
      await processManager.startProcess('event-bus');
      
      // Mock console and stdin
      const originalLog = console.log;
      let promptShown = false;
      console.log = (...args) => {
        if (args.join(' ').includes('processes are still running')) {
          promptShown = true;
        }
      };
      
      // Mock stdin to return 'n'
      const originalRead = Deno.stdin.read;
      Deno.stdin.read = async (buf: Uint8Array) => {
        buf[0] = 110; // 'n'
        return 1;
      };
      
      // Mock stop method
      let stopCalled = false;
      processUI['stop'] = async () => {
        stopCalled = true;
      };
      
      await handleExit();
      
      assertEquals(promptShown, true);
      assertEquals(stopCalled, true);
      
      // Restore
      console.log = originalLog;
      Deno.stdin.read = originalRead;
    });
  });
});