/**
 * Test suite for SystemMonitor
 */

import { assertEquals, assertExists } from '@std/assert';
import { beforeEach, describe, it } from '@std/testing/bdd';
import { SystemMonitor } from '../../../../src/cli/commands/start/system-monitor.ts';
import { ProcessManager } from '../../../../src/cli/commands/start/process-manager.ts';
import { eventBus } from '../../../../src/core/event-bus.ts';
import { SystemEvents } from '../../../../src/utils/types.ts';

describe('SystemMonitor', () => {
  let processManager: ProcessManager;
  let systemMonitor: SystemMonitor;

  beforeEach(() => {
    processManager = new ProcessManager();
    systemMonitor = new SystemMonitor(processManager);
  });

  describe('initialization', () => {
    it('should create SystemMonitor instance', () => {
      assertExists(systemMonitor);
    });

    it('should setup event listeners', () => {
      // Monitor should track events
      const monitor = new SystemMonitor(processManager);
      
      // Emit some events
      eventBus.emit(SystemEvents.AGENT_SPAWNED, { agentId: 'test-1', profile: { type: 'researcher' } });
      eventBus.emit(SystemEvents.TASK_COMPLETED, { taskId: 'task-1' });
      
      const events = monitor.getRecentEvents(10);
      assertEquals(events.length >= 2, true);
    });
  });

  describe('event tracking', () => {
    it('should track agent spawned events', () => {
      eventBus.emit(SystemEvents.AGENT_SPAWNED, { 
        agentId: 'agent-123', 
        profile: { type: 'researcher' } 
      });
      
      const events = systemMonitor.getRecentEvents(10);
      const agentEvent = events.find(e => e.type === 'agent_spawned');
      
      assertExists(agentEvent);
      assertEquals(agentEvent?.data.agentId, 'agent-123');
      assertEquals(agentEvent?.level, 'info');
    });

    it('should track agent terminated events', () => {
      eventBus.emit(SystemEvents.AGENT_TERMINATED, { 
        agentId: 'agent-123', 
        reason: 'Task completed' 
      });
      
      const events = systemMonitor.getRecentEvents(10);
      const event = events.find(e => e.type === 'agent_terminated');
      
      assertExists(event);
      assertEquals(event?.data.reason, 'Task completed');
      assertEquals(event?.level, 'warning');
    });

    it('should track task events', () => {
      eventBus.emit(SystemEvents.TASK_ASSIGNED, { 
        taskId: 'task-1', 
        agentId: 'agent-1' 
      });
      
      eventBus.emit(SystemEvents.TASK_COMPLETED, { 
        taskId: 'task-1' 
      });
      
      eventBus.emit(SystemEvents.TASK_FAILED, { 
        taskId: 'task-2',
        error: new Error('Test error')
      });
      
      const events = systemMonitor.getRecentEvents(10);
      
      const assigned = events.find(e => e.type === 'task_assigned');
      const completed = events.find(e => e.type === 'task_completed');
      const failed = events.find(e => e.type === 'task_failed');
      
      assertExists(assigned);
      assertExists(completed);
      assertExists(failed);
      
      assertEquals(assigned?.level, 'info');
      assertEquals(completed?.level, 'success');
      assertEquals(failed?.level, 'error');
    });

    it('should track system errors', () => {
      eventBus.emit(SystemEvents.SYSTEM_ERROR, { 
        component: 'TestComponent',
        error: new Error('System failure')
      });
      
      const events = systemMonitor.getRecentEvents(10);
      const errorEvent = events.find(e => e.type === 'system_error');
      
      assertExists(errorEvent);
      assertEquals(errorEvent?.data.component, 'TestComponent');
      assertEquals(errorEvent?.level, 'error');
    });

    it('should track process manager events', () => {
      processManager.emit('processStarted', { 
        processId: 'test-process',
        process: { name: 'Test Process' }
      });
      
      processManager.emit('processStopped', { 
        processId: 'test-process'
      });
      
      processManager.emit('processError', { 
        processId: 'test-process',
        error: new Error('Process error')
      });
      
      const events = systemMonitor.getRecentEvents(10);
      
      const started = events.find(e => e.type === 'process_started');
      const stopped = events.find(e => e.type === 'process_stopped');
      const error = events.find(e => e.type === 'process_error');
      
      assertExists(started);
      assertExists(stopped);
      assertExists(error);
    });

    it('should limit stored events to maxEvents', () => {
      // Add more than maxEvents (100)
      for (let i = 0; i < 150; i++) {
        eventBus.emit(SystemEvents.AGENT_SPAWNED, { 
          agentId: `agent-${i}`,
          profile: { type: 'test' }
        });
      }
      
      const events = systemMonitor.getRecentEvents(200);
      assertEquals(events.length <= 100, true);
    });
  });

  describe('event formatting', () => {
    it('should format event messages correctly', () => {
      const formatMessage = systemMonitor['formatEventMessage'].bind(systemMonitor);
      
      const agentSpawnedMsg = formatMessage({
        type: 'agent_spawned',
        data: { agentId: 'agent-1', profile: { type: 'researcher' } }
      });
      assertEquals(agentSpawnedMsg.includes('Agent spawned'), true);
      assertEquals(agentSpawnedMsg.includes('agent-1'), true);
      assertEquals(agentSpawnedMsg.includes('researcher'), true);
      
      const taskCompletedMsg = formatMessage({
        type: 'task_completed',
        data: { taskId: 'task-1' }
      });
      assertEquals(taskCompletedMsg.includes('Task completed'), true);
      assertEquals(taskCompletedMsg.includes('task-1'), true);
      
      const systemErrorMsg = formatMessage({
        type: 'system_error',
        data: { component: 'TestComp', error: { message: 'Error msg' } }
      });
      assertEquals(systemErrorMsg.includes('System error'), true);
      assertEquals(systemErrorMsg.includes('TestComp'), true);
      assertEquals(systemErrorMsg.includes('Error msg'), true);
    });

    it('should get correct event icons', () => {
      const getIcon = systemMonitor['getEventIcon'].bind(systemMonitor);
      
      assertEquals(getIcon('agent_spawned'), '🤖');
      assertEquals(getIcon('agent_terminated'), '🔚');
      assertEquals(getIcon('task_assigned'), '📌');
      assertEquals(getIcon('task_completed'), '✅');
      assertEquals(getIcon('task_failed'), '❌');
      assertEquals(getIcon('system_error'), '⚠️');
      assertEquals(getIcon('process_started'), '▶️');
      assertEquals(getIcon('process_stopped'), '⏹️');
      assertEquals(getIcon('process_error'), '🚨');
      assertEquals(getIcon('unknown'), '•');
    });
  });

  describe('metrics collection', () => {
    it('should start and stop metrics collection', () => {
      let intervalId: number | undefined;
      const originalSetInterval = globalThis.setInterval;
      const originalClearInterval = globalThis.clearInterval;
      
      globalThis.setInterval = ((fn: any, ms: number) => {
        intervalId = 123;
        return intervalId;
      }) as any;
      
      globalThis.clearInterval = ((id: number) => {
        assertEquals(id, intervalId);
      }) as any;
      
      systemMonitor.start();
      assertExists(intervalId);
      
      systemMonitor.stop();
      
      // Restore
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    });

    it('should collect metrics for running processes', async () => {
      await processManager.initialize();
      await processManager.startProcess('event-bus');
      
      // Manually trigger metrics collection
      systemMonitor['collectMetrics']();
      
      const process = processManager.getProcess('event-bus');
      assertExists(process?.metrics?.cpu);
      assertExists(process?.metrics?.memory);
      assertEquals(typeof process?.metrics?.cpu, 'number');
      assertEquals(typeof process?.metrics?.memory, 'number');
    });
  });

  describe('event log printing', () => {
    it('should print event log', () => {
      // Add some events
      eventBus.emit(SystemEvents.AGENT_SPAWNED, { agentId: 'test-1', profile: { type: 'test' } });
      eventBus.emit(SystemEvents.TASK_COMPLETED, { taskId: 'task-1' });
      
      // Mock console output
      const originalLog = console.log;
      let logOutput: string[] = [];
      console.log = (...args) => {
        logOutput.push(args.join(' '));
      };
      
      systemMonitor.printEventLog(5);
      
      // Check output contains expected content
      const output = logOutput.join('\n');
      assertEquals(output.includes('Recent System Events'), true);
      assertEquals(output.includes('Agent spawned'), true);
      assertEquals(output.includes('Task completed'), true);
      
      // Restore
      console.log = originalLog;
    });
  });

  describe('system health printing', () => {
    it('should print system health', async () => {
      await processManager.initialize();
      await processManager.startProcess('event-bus');
      
      // Mock console output
      const originalLog = console.log;
      let logOutput: string[] = [];
      console.log = (...args) => {
        logOutput.push(args.join(' '));
      };
      
      systemMonitor.printSystemHealth();
      
      // Check output contains expected content
      const output = logOutput.join('\n');
      assertEquals(output.includes('System Health'), true);
      assertEquals(output.includes('Status:'), true);
      assertEquals(output.includes('Uptime:'), true);
      assertEquals(output.includes('Process Status:'), true);
      assertEquals(output.includes('System Metrics:'), true);
      
      // Restore
      console.log = originalLog;
    });

    it('should show recent errors in health output', () => {
      // Add an error event
      eventBus.emit(SystemEvents.SYSTEM_ERROR, { 
        component: 'TestComponent',
        error: new Error('Test error')
      });
      
      // Mock console output
      const originalLog = console.log;
      let logOutput: string[] = [];
      console.log = (...args) => {
        logOutput.push(args.join(' '));
      };
      
      systemMonitor.printSystemHealth();
      
      // Check output contains error section
      const output = logOutput.join('\n');
      assertEquals(output.includes('Recent Errors:'), true);
      assertEquals(output.includes('TestComponent'), true);
      
      // Restore
      console.log = originalLog;
    });
  });

  describe('uptime formatting', () => {
    it('should format uptime correctly', () => {
      const formatUptime = systemMonitor['formatUptime'].bind(systemMonitor);
      
      assertEquals(formatUptime(1000), '1s');
      assertEquals(formatUptime(60000), '1m 0s');
      assertEquals(formatUptime(3600000), '1h 0m 0s');
      assertEquals(formatUptime(86400000), '1d 0h 0m');
      assertEquals(formatUptime(90061000), '1d 1h 1m'); 
    });
  });
});