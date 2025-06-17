/**
 * Comprehensive test suite for ProcessManager
 */

import { assertEquals, assertExists, assertRejects, assertThrows } from '@std/assert';
import { beforeEach, describe, it } from '@std/testing/bdd';
import { ProcessManager } from '../../../../src/cli/commands/start/process-manager.ts';
import { ProcessStatus, ProcessType } from '../../../../src/cli/commands/start/types.ts';

describe('ProcessManager', () => {
  let processManager: ProcessManager;

  beforeEach(() => {
    processManager = new ProcessManager();
  });

  describe('initialization', () => {
    it('should initialize with all process definitions', () => {
      const processes = processManager.getAllProcesses();
      assertEquals(processes.length, 6);
      
      const processIds = processes.map(p => p.id);
      assertEquals(processIds.includes('event-bus'), true);
      assertEquals(processIds.includes('orchestrator'), true);
      assertEquals(processIds.includes('memory-manager'), true);
      assertEquals(processIds.includes('terminal-pool'), true);
      assertEquals(processIds.includes('mcp-server'), true);
      assertEquals(processIds.includes('coordinator'), true);
    });

    it('should initialize all processes with STOPPED status', () => {
      const processes = processManager.getAllProcesses();
      processes.forEach(process => {
        assertEquals(process.status, ProcessStatus.STOPPED);
      });
    });

    it('should load configuration', async () => {
      await processManager.initialize();
      // Configuration should be loaded without errors
      assertExists(processManager);
    });
  });

  describe('getProcess', () => {
    it('should return process by id', () => {
      const process = processManager.getProcess('orchestrator');
      assertExists(process);
      assertEquals(process?.id, 'orchestrator');
      assertEquals(process?.type, ProcessType.ORCHESTRATOR);
    });

    it('should return undefined for unknown process', () => {
      const process = processManager.getProcess('unknown');
      assertEquals(process, undefined);
    });
  });

  describe('getAllProcesses', () => {
    it('should return all processes', () => {
      const processes = processManager.getAllProcesses();
      assertEquals(Array.isArray(processes), true);
      assertEquals(processes.length, 6);
    });
  });

  describe('getSystemStats', () => {
    it('should return correct initial stats', () => {
      const stats = processManager.getSystemStats();
      assertEquals(stats.totalProcesses, 6);
      assertEquals(stats.runningProcesses, 0);
      assertEquals(stats.stoppedProcesses, 6);
      assertEquals(stats.errorProcesses, 0);
      assertEquals(stats.systemUptime, 0);
    });
  });

  describe('startProcess', () => {
    it('should reject starting unknown process', async () => {
      await assertRejects(
        () => processManager.startProcess('unknown'),
        Error,
        'Unknown process: unknown'
      );
    });

    it('should update process status to STARTING then RUNNING', async () => {
      const processId = 'event-bus';
      
      // Listen for status changes
      const statusChanges: ProcessStatus[] = [];
      processManager.on('statusChanged', ({ status }) => {
        statusChanges.push(status);
      });

      await processManager.initialize();
      await processManager.startProcess(processId);
      
      const process = processManager.getProcess(processId);
      assertEquals(process?.status, ProcessStatus.RUNNING);
      assertEquals(statusChanges.includes(ProcessStatus.STARTING), true);
      assertEquals(statusChanges.includes(ProcessStatus.RUNNING), true);
    });

    it('should set process start time', async () => {
      const processId = 'event-bus';
      await processManager.initialize();
      await processManager.startProcess(processId);
      
      const process = processManager.getProcess(processId);
      assertExists(process?.startTime);
      assertEquals(typeof process?.startTime, 'number');
    });

    it('should reject starting already running process', async () => {
      const processId = 'event-bus';
      await processManager.initialize();
      await processManager.startProcess(processId);
      
      await assertRejects(
        () => processManager.startProcess(processId),
        Error,
        'Process event-bus is already running'
      );
    });

    it('should emit processStarted event', async () => {
      const processId = 'event-bus';
      let eventData: any = null;
      
      processManager.on('processStarted', (data) => {
        eventData = data;
      });
      
      await processManager.initialize();
      await processManager.startProcess(processId);
      
      assertExists(eventData);
      assertEquals(eventData.processId, processId);
      assertExists(eventData.process);
    });

    it('should handle process start errors', async () => {
      const processId = 'orchestrator'; // This requires other components
      let errorEvent: any = null;
      
      processManager.on('processError', (data) => {
        errorEvent = data;
      });
      
      await processManager.initialize();
      
      // Should fail because required components are not initialized
      await assertRejects(
        () => processManager.startProcess(processId),
        Error,
        'Required components not initialized'
      );
      
      assertExists(errorEvent);
      assertEquals(errorEvent.processId, processId);
    });
  });

  describe('stopProcess', () => {
    it('should reject stopping unknown process', async () => {
      await assertRejects(
        () => processManager.stopProcess('unknown'),
        Error,
        'Process unknown is not running'
      );
    });

    it('should reject stopping non-running process', async () => {
      await assertRejects(
        () => processManager.stopProcess('event-bus'),
        Error,
        'Process event-bus is not running'
      );
    });

    it('should stop running process', async () => {
      const processId = 'event-bus';
      await processManager.initialize();
      await processManager.startProcess(processId);
      
      await processManager.stopProcess(processId);
      
      const process = processManager.getProcess(processId);
      assertEquals(process?.status, ProcessStatus.STOPPED);
    });

    it('should emit processStopped event', async () => {
      const processId = 'event-bus';
      let stoppedEvent: any = null;
      
      processManager.on('processStopped', (data) => {
        stoppedEvent = data;
      });
      
      await processManager.initialize();
      await processManager.startProcess(processId);
      await processManager.stopProcess(processId);
      
      assertExists(stoppedEvent);
      assertEquals(stoppedEvent.processId, processId);
    });
  });

  describe('restartProcess', () => {
    it('should restart a running process', async () => {
      const processId = 'event-bus';
      await processManager.initialize();
      await processManager.startProcess(processId);
      
      const firstStartTime = processManager.getProcess(processId)?.startTime;
      
      // Wait a bit to ensure different start times
      await new Promise(resolve => setTimeout(resolve, 100));
      
      await processManager.restartProcess(processId);
      
      const process = processManager.getProcess(processId);
      assertEquals(process?.status, ProcessStatus.RUNNING);
      assertExists(process?.startTime);
      // New start time should be different
      assertEquals(process?.startTime !== firstStartTime, true);
    });
  });

  describe('startAll', () => {
    it('should start all processes in correct order', async () => {
      await processManager.initialize();
      
      const startedProcesses: string[] = [];
      processManager.on('processStarted', ({ processId }) => {
        startedProcesses.push(processId);
      });
      
      await processManager.startAll();
      
      // Check order matches dependency order
      const expectedOrder = [
        'event-bus',
        'memory-manager',
        'terminal-pool',
        'coordinator',
        'mcp-server',
        'orchestrator'
      ];
      
      assertEquals(startedProcesses.slice(0, 5), expectedOrder.slice(0, 5));
      // Orchestrator might fail due to missing dependencies, that's ok
    });

    it('should update system stats after starting all', async () => {
      await processManager.initialize();
      await processManager.startAll();
      
      const stats = processManager.getSystemStats();
      assertEquals(stats.runningProcesses >= 5, true); // At least core processes
    });
  });

  describe('stopAll', () => {
    it('should stop all processes in reverse order', async () => {
      await processManager.initialize();
      
      // Start some processes
      await processManager.startProcess('event-bus');
      await processManager.startProcess('memory-manager');
      
      const stoppedProcesses: string[] = [];
      processManager.on('processStopped', ({ processId }) => {
        stoppedProcesses.push(processId);
      });
      
      await processManager.stopAll();
      
      // Should stop in reverse order
      assertEquals(stoppedProcesses[0], 'memory-manager');
      assertEquals(stoppedProcesses[1], 'event-bus');
    });

    it('should handle stopping already stopped processes', async () => {
      await processManager.initialize();
      // No processes running
      await processManager.stopAll(); // Should not throw
      
      const stats = processManager.getSystemStats();
      assertEquals(stats.runningProcesses, 0);
    });
  });

  describe('process logs', () => {
    it('should return placeholder logs', async () => {
      const logs = await processManager.getProcessLogs('event-bus', 10);
      assertEquals(Array.isArray(logs), true);
      assertEquals(logs.length, 2); // Placeholder returns 2 logs
    });
  });

  describe('event emission', () => {
    it('should emit initialized event', async () => {
      let initialized = false;
      processManager.on('initialized', () => {
        initialized = true;
      });
      
      await processManager.initialize();
      assertEquals(initialized, true);
    });

    it('should emit error event on initialization failure', async () => {
      // Create a new manager with invalid config path
      const manager = new ProcessManager();
      let errorEmitted = false;
      
      manager.on('error', () => {
        errorEmitted = true;
      });
      
      try {
        await manager.initialize('/invalid/path/to/config.json');
      } catch {
        // Expected to throw
      }
      
      assertEquals(errorEmitted, true);
    });
  });

  describe('process metrics', () => {
    it('should track last error in metrics', async () => {
      const processId = 'orchestrator';
      await processManager.initialize();
      
      try {
        await processManager.startProcess(processId);
      } catch {
        // Expected to fail
      }
      
      const process = processManager.getProcess(processId);
      assertExists(process?.metrics?.lastError);
      assertEquals(process?.metrics?.lastError, 'Required components not initialized');
    });
  });
});