/**
 * Enhanced comprehensive unit tests for Orchestrator
 */

import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { assertEquals, assertExists, assertRejects, assertThrows } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { stub, spy } from "@std/testing/mock";

import { Orchestrator } from '../../../src/core/orchestrator.ts';
import { 
  MockEventBus, 
  MockLogger, 
  MockTerminalManager, 
  MockMemoryManager, 
  MockCoordinationManager,
  MockMCPServer,
  createMocks 
} from '../../mocks/index.ts';
import { 
  AsyncTestUtils, 
  MemoryTestUtils, 
  PerformanceTestUtils,
  TestAssertions 
} from '../../utils/test-utils.ts';
import { generateCoordinationTasks, generateErrorScenarios } from '../../fixtures/generators.ts';
import { setupTestEnv, cleanupTestEnv, TEST_CONFIG } from '../../test.config.ts';

describe('Orchestrator - Enhanced Tests', () => {
  let orchestrator: Orchestrator;
  let mocks: ReturnType<typeof createMocks>;
  let fakeTime: FakeTime;

  beforeEach(() => {
    setupTestEnv();
    mocks = createMocks();
    
    orchestrator = new Orchestrator({
      eventBus: mocks.eventBus,
      logger: mocks.logger,
      terminalManager: mocks.terminalManager,
      memoryManager: mocks.memoryManager,
      coordinationManager: mocks.coordinationManager,
      mcpServer: mocks.mcpServer,
    });

    fakeTime = new FakeTime();
  });

  afterEach(async () => {
    fakeTime.restore();
    await cleanupTestEnv();
    
    // Reset all mock spies
    Object.values(mocks).forEach(mock => {
      if (typeof mock === 'object' && mock !== null) {
        Object.values(mock).forEach(method => {
          if (typeof method === 'function' && 'calls' in method) {
            method.calls = [];
          }
        });
      }
    });
  });

  describe('Initialization', () => {
    it('should initialize all components in correct order', async () => {
      await orchestrator.initialize();

      // Verify initialization order and calls
      assertEquals(mocks.eventBus.clearEvents().length, 0);
      assertEquals(mocks.terminalManager.initialize.calls.length, 1);
      assertEquals(mocks.memoryManager.initialize.calls.length, 1);
      assertEquals(mocks.coordinationManager.initialize.calls.length, 1);
      assertEquals(mocks.mcpServer.start.calls.length, 1);
      
      // Check that events were emitted
      const events = mocks.eventBus.getEvents();
      const initEvent = events.find(e => e.event === 'orchestrator.initialized');
      assertExists(initEvent);
    });

    it('should handle partial initialization failure gracefully', async () => {
      // Make memory manager fail
      mocks.memoryManager.initialize = spy(async () => {
        throw new Error('Memory initialization failed');
      });

      await assertRejects(
        () => orchestrator.initialize(),
        Error,
        'Memory initialization failed'
      );

      // Verify cleanup was attempted
      assertEquals(mocks.terminalManager.shutdown.calls.length, 1);
    });

    it('should timeout initialization after configured time', async () => {
      // Make terminal manager hang
      mocks.terminalManager.initialize = spy(async () => {
        await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute
      });

      await TestAssertions.assertThrowsAsync(
        () => AsyncTestUtils.withTimeout(orchestrator.initialize(), 5000),
        Error,
        'timeout'
      );
    });

    it('should handle concurrent initialization attempts', async () => {
      const promises = Array.from({ length: 5 }, () => orchestrator.initialize());
      
      // Only first should succeed, others should be rejected
      const results = await Promise.allSettled(promises);
      
      const successful = results.filter(r => r.status === 'fulfilled');
      const failed = results.filter(r => r.status === 'rejected');
      
      assertEquals(successful.length, 1);
      assertEquals(failed.length, 4);
    });
  });

  describe('Task Management', () => {
    beforeEach(async () => {
      await orchestrator.initialize();
    });

    it('should create and execute tasks correctly', async () => {
      const agentProfile = { id: 'test-agent', name: 'Test Agent' };
      const task = {
        id: 'test-task-1',
        type: 'shell',
        command: 'echo "Hello World"',
        priority: 'high' as const,
      };

      const result = await orchestrator.createAndExecuteTask(agentProfile, task);

      assertEquals(mocks.terminalManager.spawnTerminal.calls.length, 1);
      assertEquals(mocks.terminalManager.sendCommand.calls.length, 1);
      assertEquals(mocks.coordinationManager.assignTask.calls.length, 1);
      assertExists(result);
    });

    it('should handle task dependencies correctly', async () => {
      const tasks = generateCoordinationTasks(5);
      const agentProfile = { id: 'test-agent', name: 'Test Agent' };

      // Create tasks with dependencies
      for (const task of tasks) {
        await orchestrator.createAndExecuteTask(agentProfile, task);
      }

      // Verify task scheduling respected dependencies
      assertEquals(mocks.coordinationManager.assignTask.calls.length, 5);
    });

    it('should handle concurrent task execution', async () => {
      const agentProfile = { id: 'test-agent', name: 'Test Agent' };
      const tasks = Array.from({ length: 10 }, (_, i) => ({
        id: `task-${i}`,
        type: 'shell',
        command: `echo "Task ${i}"`,
        priority: 'medium' as const,
      }));

      const promises = tasks.map(task => 
        orchestrator.createAndExecuteTask(agentProfile, task)
      );

      const results = await Promise.all(promises);
      assertEquals(results.length, 10);
      
      // Verify all tasks were processed
      assertEquals(mocks.coordinationManager.assignTask.calls.length, 10);
    });

    it('should handle task timeouts properly', async () => {
      // Mock a task that hangs
      mocks.terminalManager.sendCommand = spy(async () => {
        await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute
        return 'Never reached';
      });

      const agentProfile = { id: 'test-agent', name: 'Test Agent' };
      const task = {
        id: 'hanging-task',
        type: 'shell',
        command: 'sleep 60',
        priority: 'medium' as const,
        timeout: 1000, // 1 second timeout
      };

      await TestAssertions.assertThrowsAsync(
        () => orchestrator.createAndExecuteTask(agentProfile, task),
        Error,
        'timeout'
      );
    });

    it('should handle task retry logic', async () => {
      let attemptCount = 0;
      mocks.terminalManager.sendCommand = spy(async () => {
        attemptCount++;
        if (attemptCount < 3) {
          throw new Error('Temporary failure');
        }
        return 'Success on third attempt';
      });

      const agentProfile = { id: 'test-agent', name: 'Test Agent' };
      const task = {
        id: 'retry-task',
        type: 'shell',
        command: 'flaky-command',
        priority: 'medium' as const,
        retryAttempts: 3,
      };

      const result = await orchestrator.createAndExecuteTask(agentProfile, task);
      assertEquals(result, 'Success on third attempt');
      assertEquals(mocks.terminalManager.sendCommand.calls.length, 3);
    });
  });

  describe('Health Monitoring', () => {
    beforeEach(async () => {
      await orchestrator.initialize();
    });

    it('should report overall health status correctly', async () => {
      const health = await orchestrator.getHealthStatus();
      
      assertEquals(health.healthy, true);
      assertExists(health.components);
      assertEquals(Object.keys(health.components).length, 5); // 5 components
      
      // All components should be healthy in this test
      Object.values(health.components).forEach(componentHealth => {
        assertEquals(componentHealth.healthy, true);
      });
    });

    it('should detect unhealthy components', async () => {
      // Make terminal manager unhealthy
      mocks.terminalManager.getHealthStatus = spy(async () => ({
        healthy: false,
        error: 'Terminal manager is down',
        metrics: { activeTerminals: 0 },
      }));

      const health = await orchestrator.getHealthStatus();
      
      assertEquals(health.healthy, false);
      assertEquals(health.components.terminal.healthy, false);
      assertEquals(health.components.terminal.error, 'Terminal manager is down');
    });

    it('should track performance metrics', async () => {
      // Execute some tasks to generate metrics
      const agentProfile = { id: 'test-agent', name: 'Test Agent' };
      const tasks = Array.from({ length: 5 }, (_, i) => ({
        id: `metric-task-${i}`,
        type: 'shell',
        command: `echo "Task ${i}"`,
        priority: 'medium' as const,
      }));

      for (const task of tasks) {
        await orchestrator.createAndExecuteTask(agentProfile, task);
      }

      const health = await orchestrator.getHealthStatus();
      assertExists(health.metrics);
      
      if (health.metrics) {
        assertEquals(typeof health.metrics.tasksExecuted, 'number');
        assertEquals(typeof health.metrics.averageExecutionTime, 'number');
      }
    });
  });

  describe('Memory Management', () => {
    beforeEach(async () => {
      await orchestrator.initialize();
    });

    it('should manage agent memory banks correctly', async () => {
      const agentId = 'test-agent';
      const bankId = await orchestrator.createMemoryBank(agentId);
      
      assertExists(bankId);
      assertEquals(mocks.memoryManager.createBank.calls.length, 1);
      assertEquals(mocks.memoryManager.createBank.calls[0].args[0], agentId);
      
      await orchestrator.storeMemory(bankId, 'test-key', { data: 'test-value' });
      assertEquals(mocks.memoryManager.store.calls.length, 1);
      
      const retrieved = await orchestrator.retrieveMemory(bankId, 'test-key');
      assertEquals(retrieved, { data: 'test-value' });
    });

    it('should handle memory operations under load', async () => {
      const agentId = 'load-test-agent';
      const bankId = await orchestrator.createMemoryBank(agentId);
      
      // Perform many memory operations concurrently
      const operations = Array.from({ length: 100 }, async (_, i) => {
        await orchestrator.storeMemory(bankId, `key-${i}`, { value: i });
        return orchestrator.retrieveMemory(bankId, `key-${i}`);
      });

      const results = await Promise.all(operations);
      assertEquals(results.length, 100);
      
      // Verify all values were stored and retrieved correctly
      results.forEach((result, i) => {
        assertEquals(result, { value: i });
      });
    });

    it('should check for memory leaks during operations', async () => {
      const agentId = 'memory-leak-test';
      const bankId = await orchestrator.createMemoryBank(agentId);
      
      const { leaked } = await MemoryTestUtils.checkMemoryLeak(async () => {
        // Perform memory-intensive operations
        for (let i = 0; i < 1000; i++) {
          await orchestrator.storeMemory(bankId, `key-${i}`, {
            largeData: 'x'.repeat(1000), // 1KB per entry
            index: i,
          });
        }
        
        // Clean up
        for (let i = 0; i < 1000; i++) {
          await orchestrator.retrieveMemory(bankId, `key-${i}`);
        }
      });

      // Should not leak significant memory
      assertEquals(leaked, false);
    });
  });

  describe('Performance Testing', () => {
    beforeEach(async () => {
      await orchestrator.initialize();
    });

    it('should handle high task throughput', async () => {
      const agentProfile = { id: 'perf-agent', name: 'Performance Agent' };
      
      const { stats } = await PerformanceTestUtils.benchmark(
        () => orchestrator.createAndExecuteTask(agentProfile, {
          id: `perf-task-${Date.now()}-${Math.random()}`,
          type: 'shell',
          command: 'echo "performance test"',
          priority: 'medium' as const,
        }),
        { iterations: 50, concurrency: 5 }
      );

      // Performance assertions
      TestAssertions.assertInRange(stats.mean, 0, 1000); // Should complete within 1s on average
      TestAssertions.assertInRange(stats.p95, 0, 2000); // 95th percentile under 2s
      
      console.log(`Performance stats: mean=${stats.mean.toFixed(2)}ms, p95=${stats.p95.toFixed(2)}ms`);
    });

    it('should maintain performance under memory pressure', async () => {
      const agentId = 'memory-pressure-agent';
      const bankId = await orchestrator.createMemoryBank(agentId);
      
      // Fill memory with data
      for (let i = 0; i < 1000; i++) {
        await orchestrator.storeMemory(bankId, `pressure-key-${i}`, {
          data: 'x'.repeat(10000), // 10KB per entry
          index: i,
        });
      }

      // Test task performance under memory pressure
      const agentProfile = { id: 'pressure-agent', name: 'Pressure Agent' };
      
      const { stats } = await PerformanceTestUtils.benchmark(
        () => orchestrator.createAndExecuteTask(agentProfile, {
          id: `pressure-task-${Date.now()}-${Math.random()}`,
          type: 'shell',
          command: 'echo "under pressure"',
          priority: 'medium' as const,
        }),
        { iterations: 10 }
      );

      // Should still maintain reasonable performance
      TestAssertions.assertInRange(stats.mean, 0, 2000); // Under 2s mean
    });

    it('should handle load testing scenario', async () => {
      const agentProfile = { id: 'load-agent', name: 'Load Agent' };
      
      const results = await PerformanceTestUtils.loadTest(
        () => orchestrator.createAndExecuteTask(agentProfile, {
          id: `load-task-${Date.now()}-${Math.random()}`,
          type: 'shell',
          command: 'echo "load test"',
          priority: 'medium' as const,
        }),
        {
          duration: 5000, // 5 seconds
          maxConcurrency: 10,
          requestsPerSecond: 20,
        }
      );

      // Load test assertions
      TestAssertions.assertInRange(results.successfulRequests / results.totalRequests, 0.95, 1.0);
      assertEquals(results.failedRequests, 0);
      TestAssertions.assertInRange(results.averageResponseTime, 0, 1000);
      
      console.log(`Load test results: ${results.successfulRequests}/${results.totalRequests} successful, avg=${results.averageResponseTime.toFixed(2)}ms`);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    beforeEach(async () => {
      await orchestrator.initialize();
    });

    it('should handle component failures gracefully', async () => {
      const errorScenarios = generateErrorScenarios();
      
      for (const scenario of errorScenarios) {
        // Inject the error into terminal manager
        mocks.terminalManager.sendCommand = spy(async () => {
          throw scenario.error;
        });

        const agentProfile = { id: 'error-agent', name: 'Error Agent' };
        const task = {
          id: `error-task-${scenario.name}`,
          type: 'shell',
          command: 'failing-command',
          priority: 'medium' as const,
        };

        if (scenario.recoverable) {
          // Should retry or handle gracefully
          await TestAssertions.assertThrowsAsync(
            () => orchestrator.createAndExecuteTask(agentProfile, task),
            Error,
            scenario.error.message
          );
        } else {
          // Should fail fast
          await TestAssertions.assertThrowsAsync(
            () => orchestrator.createAndExecuteTask(agentProfile, task),
            Error,
            scenario.error.message
          );
        }
      }
    });

    it('should handle malformed task data', async () => {
      const agentProfile = { id: 'malformed-agent', name: 'Malformed Agent' };
      
      const malformedTasks = [
        { id: '', type: 'shell', command: 'echo test' }, // Empty ID
        { id: 'test', type: '', command: 'echo test' }, // Empty type
        { id: 'test', type: 'shell', command: '' }, // Empty command
        { id: 'test', type: 'shell' }, // Missing command
        { type: 'shell', command: 'echo test' }, // Missing ID
      ];

      for (const task of malformedTasks) {
        await TestAssertions.assertThrowsAsync(
          () => orchestrator.createAndExecuteTask(agentProfile, task as any),
          Error
        );
      }
    });

    it('should handle resource exhaustion scenarios', async () => {
      // Simulate resource exhaustion by creating many concurrent tasks
      const agentProfile = { id: 'resource-agent', name: 'Resource Agent' };
      
      const tasks = Array.from({ length: 100 }, (_, i) => ({
        id: `resource-task-${i}`,
        type: 'shell',
        command: `echo "Resource task ${i}"`,
        priority: 'medium' as const,
      }));

      // Should handle gracefully without crashing
      const results = await Promise.allSettled(
        tasks.map(task => orchestrator.createAndExecuteTask(agentProfile, task))
      );

      // Some may fail due to resource limits, but shouldn't crash system
      const successful = results.filter(r => r.status === 'fulfilled');
      const failed = results.filter(r => r.status === 'rejected');
      
      console.log(`Resource test: ${successful.length} successful, ${failed.length} failed`);
      
      // System should still be healthy
      const health = await orchestrator.getHealthStatus();
      assertEquals(health.healthy, true);
    });

    it('should recover from temporary component failures', async () => {
      let failureCount = 0;
      
      // Make terminal manager fail first 3 times, then succeed
      mocks.terminalManager.sendCommand = spy(async (terminalId: string, command: any) => {
        failureCount++;
        if (failureCount <= 3) {
          throw new Error('Temporary failure');
        }
        return `Success after ${failureCount} attempts`;
      });

      const agentProfile = { id: 'recovery-agent', name: 'Recovery Agent' };
      const task = {
        id: 'recovery-task',
        type: 'shell',
        command: 'recovery-command',
        priority: 'medium' as const,
        retryAttempts: 5,
      };

      const result = await orchestrator.createAndExecuteTask(agentProfile, task);
      assertEquals(result, 'Success after 4 attempts');
      assertEquals(failureCount, 4);
    });
  });

  describe('Shutdown and Cleanup', () => {
    it('should shutdown gracefully', async () => {
      await orchestrator.initialize();
      
      // Create some resources
      const agentProfile = { id: 'shutdown-agent', name: 'Shutdown Agent' };
      await orchestrator.createMemoryBank('shutdown-agent');
      
      await orchestrator.shutdown();
      
      // Verify all components were shut down
      assertEquals(mocks.terminalManager.shutdown.calls.length, 1);
      assertEquals(mocks.memoryManager.shutdown.calls.length, 1);
      assertEquals(mocks.coordinationManager.shutdown.calls.length, 1);
      assertEquals(mocks.mcpServer.stop.calls.length, 1);
      
      // Check shutdown event was emitted
      const events = mocks.eventBus.getEvents();
      const shutdownEvent = events.find(e => e.event === 'orchestrator.shutdown');
      assertExists(shutdownEvent);
    });

    it('should handle shutdown with active tasks', async () => {
      await orchestrator.initialize();
      
      const agentProfile = { id: 'active-agent', name: 'Active Agent' };
      
      // Start a long-running task
      const taskPromise = orchestrator.createAndExecuteTask(agentProfile, {
        id: 'long-task',
        type: 'shell',
        command: 'sleep 10',
        priority: 'medium' as const,
      });

      // Shutdown while task is running
      const shutdownPromise = orchestrator.shutdown();
      
      // Both should complete (task should be cancelled)
      await Promise.allSettled([taskPromise, shutdownPromise]);
      
      // Verify shutdown completed
      assertEquals(mocks.terminalManager.shutdown.calls.length, 1);
    });

    it('should timeout shutdown if components hang', async () => {
      await orchestrator.initialize();
      
      // Make terminal manager hang during shutdown
      mocks.terminalManager.shutdown = spy(async () => {
        await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute
      });

      await TestAssertions.assertCompletesWithin(
        () => orchestrator.shutdown(),
        10000 // Should timeout shutdown after 10 seconds
      );
    });
  });
});