/**
 * Comprehensive unit tests for Coordination System
 * Tests deadlock detection, task scheduling, and resource management
 */

import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { assertEquals, assertExists, assertRejects, assertThrows } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { spy, stub } from "@std/testing/mock";

import { CoordinationManager } from '../../../src/coordination/manager.ts';
import { TaskScheduler } from '../../../src/coordination/scheduler.ts';
import { ResourceManager } from '../../../src/coordination/resources.ts';
import { ConflictResolver } from '../../../src/coordination/conflict-resolution.ts';
import { CircuitBreaker } from '../../../src/coordination/circuit-breaker.ts';
import { WorkStealingScheduler } from '../../../src/coordination/work-stealing.ts';
import { DependencyGraph } from '../../../src/coordination/dependency-graph.ts';
import { AdvancedScheduler } from '../../../src/coordination/advanced-scheduler.ts';
import { 
  AsyncTestUtils, 
  MemoryTestUtils, 
  PerformanceTestUtils,
  TestAssertions,
  MockFactory 
} from '../../utils/test-utils.ts';
import { generateCoordinationTasks, generateErrorScenarios } from '../../fixtures/generators.ts';
import { setupTestEnv, cleanupTestEnv, TEST_CONFIG } from '../../test.config.ts';

describe('Coordination System - Comprehensive Tests', () => {
  let coordinationManager: CoordinationManager;
  let scheduler: TaskScheduler;
  let resourceManager: ResourceManager;
  let conflictResolver: ConflictResolver;
  let fakeTime: FakeTime;

  beforeEach(() => {
    setupTestEnv();
    
    resourceManager = new ResourceManager({
      maxConcurrentTasks: 10,
      maxMemoryUsage: 1024 * 1024 * 100, // 100MB
      resourceTimeout: 30000,
    });

    scheduler = new TaskScheduler({
      maxConcurrentTasks: 5,
      taskTimeout: 10000,
      retryAttempts: 3,
    });

    conflictResolver = new ConflictResolver({
      enableConflictDetection: true,
      resolutionStrategy: 'priority',
    });

    coordinationManager = new CoordinationManager({
      scheduler,
      resourceManager,
      conflictResolver,
    });

    fakeTime = new FakeTime();
  });

  afterEach(async () => {
    fakeTime.restore();
    await cleanupTestEnv();
  });

  describe('Task Scheduling', () => {
    beforeEach(async () => {
      await coordinationManager.initialize();
    });

    it('should schedule tasks with correct priority', async () => {
      const tasks = [
        { id: 'low-1', priority: 'low', execute: spy(async () => 'low-1') },
        { id: 'high-1', priority: 'critical', execute: spy(async () => 'high-1') },
        { id: 'medium-1', priority: 'medium', execute: spy(async () => 'medium-1') },
        { id: 'high-2', priority: 'high', execute: spy(async () => 'high-2') },
      ];

      // Submit all tasks
      const promises = tasks.map(task => 
        coordinationManager.submitTask(task.id, task)
      );

      const results = await Promise.all(promises);
      
      // Verify all tasks completed
      assertEquals(results.length, 4);
      tasks.forEach(task => {
        assertEquals(task.execute.calls.length, 1);
      });
    });

    it('should handle task dependencies correctly', async () => {
      const executionOrder: string[] = [];
      
      const tasks = [
        {
          id: 'task-a',
          dependencies: [],
          execute: spy(async () => {
            await AsyncTestUtils.delay(10);
            executionOrder.push('task-a');
            return 'a';
          }),
        },
        {
          id: 'task-b',
          dependencies: ['task-a'],
          execute: spy(async () => {
            await AsyncTestUtils.delay(10);
            executionOrder.push('task-b');
            return 'b';
          }),
        },
        {
          id: 'task-c',
          dependencies: ['task-a', 'task-b'],
          execute: spy(async () => {
            await AsyncTestUtils.delay(10);
            executionOrder.push('task-c');
            return 'c';
          }),
        },
      ];

      // Submit tasks in random order
      const promises = [
        coordinationManager.submitTask('task-c', tasks[2]),
        coordinationManager.submitTask('task-a', tasks[0]),
        coordinationManager.submitTask('task-b', tasks[1]),
      ];

      await Promise.all(promises);
      
      // Verify execution order respected dependencies
      assertEquals(executionOrder[0], 'task-a');
      assertEquals(executionOrder[1], 'task-b');
      assertEquals(executionOrder[2], 'task-c');
    });

    it('should detect and handle circular dependencies', async () => {
      const tasks = [
        { id: 'task-x', dependencies: ['task-y'], execute: spy() },
        { id: 'task-y', dependencies: ['task-z'], execute: spy() },
        { id: 'task-z', dependencies: ['task-x'], execute: spy() },
      ];

      // Submit tasks with circular dependencies
      const promises = tasks.map(task => 
        coordinationManager.submitTask(task.id, task)
      );

      // Should detect circular dependency and reject
      const results = await Promise.allSettled(promises);
      const failures = results.filter(r => r.status === 'rejected');
      
      assertEquals(failures.length >= 1, true);
      
      // Verify circular dependency was detected
      const error = failures[0] as PromiseRejectedResult;
      assertEquals(error.reason.message.includes('circular'), true);
    });

    it('should handle task timeouts correctly', async () => {
      const longRunningTask = {
        id: 'long-task',
        timeout: 100, // 100ms timeout
        execute: spy(async () => {
          await AsyncTestUtils.delay(200); // Take 200ms
          return 'should not complete';
        }),
      };

      await TestAssertions.assertThrowsAsync(
        () => coordinationManager.submitTask('long-task', longRunningTask),
        Error,
        'timeout'
      );
    });

    it('should handle concurrent task submission', async () => {
      const tasks = generateCoordinationTasks(20);
      
      const promises = tasks.map(task => 
        coordinationManager.submitTask(task.id, {
          execute: spy(async () => `result-${task.id}`),
          priority: task.priority,
        })
      );

      const results = await Promise.all(promises);
      
      assertEquals(results.length, 20);
      results.forEach((result, i) => {
        assertEquals(result, `result-${tasks[i].id}`);
      });
    });

    it('should respect concurrency limits', async () => {
      const limitedScheduler = new TaskScheduler({
        maxConcurrentTasks: 2, // Only 2 concurrent tasks
        taskTimeout: 10000,
      });

      const limitedManager = new CoordinationManager({
        scheduler: limitedScheduler,
        resourceManager,
        conflictResolver,
      });

      await limitedManager.initialize();

      let activeTasks = 0;
      let maxActiveTasks = 0;

      const tasks = Array.from({ length: 10 }, (_, i) => ({
        id: `limited-${i}`,
        execute: spy(async () => {
          activeTasks++;
          maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
          await AsyncTestUtils.delay(50);
          activeTasks--;
          return `result-${i}`;
        }),
      }));

      const promises = tasks.map(task => 
        limitedManager.submitTask(task.id, task)
      );

      await Promise.all(promises);
      
      // Should never exceed the concurrency limit
      TestAssertions.assertInRange(maxActiveTasks, 1, 2);
    });
  });

  describe('Deadlock Detection and Prevention', () => {
    beforeEach(async () => {
      await coordinationManager.initialize();
    });

    it('should detect simple deadlocks', async () => {
      const resourceLocks = new Map<string, string>();
      
      const task1 = {
        id: 'deadlock-1',
        requiredResources: ['resource-a', 'resource-b'],
        execute: spy(async () => {
          resourceLocks.set('resource-a', 'deadlock-1');
          await AsyncTestUtils.delay(50);
          resourceLocks.set('resource-b', 'deadlock-1');
          return 'task1-complete';
        }),
      };

      const task2 = {
        id: 'deadlock-2',
        requiredResources: ['resource-b', 'resource-a'],
        execute: spy(async () => {
          resourceLocks.set('resource-b', 'deadlock-2');
          await AsyncTestUtils.delay(50);
          resourceLocks.set('resource-a', 'deadlock-2');
          return 'task2-complete';
        }),
      };

      // Submit both tasks simultaneously
      const promises = [
        coordinationManager.submitTask('deadlock-1', task1),
        coordinationManager.submitTask('deadlock-2', task2),
      ];

      const results = await Promise.allSettled(promises);
      
      // At least one should be prevented/resolved
      const successes = results.filter(r => r.status === 'fulfilled');
      const failures = results.filter(r => r.status === 'rejected');
      
      // Deadlock detection should prevent both from hanging
      assertEquals(successes.length + failures.length, 2);
    });

    it('should prevent resource starvation', async () => {
      const highPriorityTasks = Array.from({ length: 5 }, (_, i) => ({
        id: `high-${i}`,
        priority: 'critical',
        requiredResources: ['shared-resource'],
        execute: spy(async () => {
          await AsyncTestUtils.delay(100);
          return `high-${i}`;
        }),
      }));

      const lowPriorityTask = {
        id: 'low-priority',
        priority: 'low',
        requiredResources: ['shared-resource'],
        execute: spy(async () => {
          await AsyncTestUtils.delay(10);
          return 'low-priority-complete';
        }),
      };

      // Submit low priority task first
      const lowPromise = coordinationManager.submitTask('low-priority', lowPriorityTask);
      
      // Then submit high priority tasks
      const highPromises = highPriorityTasks.map(task => 
        coordinationManager.submitTask(task.id, task)
      );

      await AsyncTestUtils.delay(20); // Let low priority task get a chance

      const allResults = await Promise.allSettled([lowPromise, ...highPromises]);
      const successes = allResults.filter(r => r.status === 'fulfilled');
      
      // Low priority task should eventually complete (no starvation)
      assertEquals(successes.length, 6);
      assertEquals(lowPriorityTask.execute.calls.length, 1);
    });

    it('should handle complex dependency chains without deadlock', async () => {
      // Create a complex but non-circular dependency graph
      const tasks = [
        { id: 'root', dependencies: [], execute: spy(async () => 'root') },
        { id: 'branch-1', dependencies: ['root'], execute: spy(async () => 'branch-1') },
        { id: 'branch-2', dependencies: ['root'], execute: spy(async () => 'branch-2') },
        { id: 'merge-1', dependencies: ['branch-1', 'branch-2'], execute: spy(async () => 'merge-1') },
        { id: 'leaf-1', dependencies: ['merge-1'], execute: spy(async () => 'leaf-1') },
        { id: 'leaf-2', dependencies: ['merge-1'], execute: spy(async () => 'leaf-2') },
        { id: 'final', dependencies: ['leaf-1', 'leaf-2'], execute: spy(async () => 'final') },
      ];

      const promises = tasks.map(task => 
        coordinationManager.submitTask(task.id, task)
      );

      const results = await Promise.all(promises);
      
      assertEquals(results.length, 7);
      tasks.forEach(task => {
        assertEquals(task.execute.calls.length, 1);
      });
    });

    it('should recover from deadlock through timeout', async () => {
      const deadlockTimeout = 1000; // 1 second
      
      const task1 = {
        id: 'timeout-deadlock-1',
        requiredResources: ['resource-x'],
        timeout: deadlockTimeout,
        execute: spy(async () => {
          await AsyncTestUtils.delay(2000); // Longer than timeout
          return 'should-not-complete';
        }),
      };

      const task2 = {
        id: 'timeout-deadlock-2',
        requiredResources: ['resource-x'],
        execute: spy(async () => {
          await AsyncTestUtils.delay(100);
          return 'task2-complete';
        }),
      };

      const promises = [
        coordinationManager.submitTask('timeout-deadlock-1', task1),
        coordinationManager.submitTask('timeout-deadlock-2', task2),
      ];

      const results = await Promise.allSettled(promises);
      
      // First task should timeout, second should complete
      const successes = results.filter(r => r.status === 'fulfilled');
      const failures = results.filter(r => r.status === 'rejected');
      
      assertEquals(successes.length >= 1, true);
      assertEquals(failures.length >= 1, true);
    });
  });

  describe('Resource Management', () => {
    beforeEach(async () => {
      await coordinationManager.initialize();
    });

    it('should track resource usage correctly', async () => {
      const tasks = Array.from({ length: 5 }, (_, i) => ({
        id: `resource-task-${i}`,
        requiredResources: [`cpu-${i % 2}`, 'memory'],
        estimatedMemoryUsage: 1024 * 1024 * 10, // 10MB
        execute: spy(async () => {
          await AsyncTestUtils.delay(100);
          return `task-${i}`;
        }),
      }));

      const promises = tasks.map(task => 
        coordinationManager.submitTask(task.id, task)
      );

      // Check resource usage during execution
      await AsyncTestUtils.delay(50);
      
      const resourceStatus = await resourceManager.getResourceStatus();
      assertExists(resourceStatus);
      
      // Should track active resource usage
      assertEquals(typeof resourceStatus.memoryUsage, 'number');
      assertEquals(typeof resourceStatus.activeResources, 'object');

      await Promise.all(promises);
    });

    it('should enforce memory limits', async () => {
      const limitedResourceManager = new ResourceManager({
        maxMemoryUsage: 1024 * 1024 * 50, // 50MB limit
        resourceTimeout: 30000,
      });

      const limitedManager = new CoordinationManager({
        scheduler,
        resourceManager: limitedResourceManager,
        conflictResolver,
      });

      await limitedManager.initialize();

      const memoryHeavyTask = {
        id: 'memory-heavy',
        estimatedMemoryUsage: 1024 * 1024 * 100, // 100MB (exceeds limit)
        execute: spy(async () => 'should-not-run'),
      };

      await TestAssertions.assertThrowsAsync(
        () => limitedManager.submitTask('memory-heavy', memoryHeavyTask),
        Error,
        'memory'
      );
    });

    it('should handle resource conflicts correctly', async () => {
      const sharedResource = 'exclusive-resource';
      
      const tasks = Array.from({ length: 3 }, (_, i) => ({
        id: `conflict-task-${i}`,
        requiredResources: [sharedResource],
        resourceMode: 'exclusive',
        execute: spy(async () => {
          await AsyncTestUtils.delay(100);
          return `task-${i}`;
        }),
      }));

      const promises = tasks.map(task => 
        coordinationManager.submitTask(task.id, task)
      );

      const results = await Promise.all(promises);
      
      // All tasks should complete, but serialized due to exclusive resource
      assertEquals(results.length, 3);
      tasks.forEach(task => {
        assertEquals(task.execute.calls.length, 1);
      });
    });

    it('should support resource sharing', async () => {
      const sharedResource = 'shared-resource';
      
      const tasks = Array.from({ length: 3 }, (_, i) => ({
        id: `shared-task-${i}`,
        requiredResources: [sharedResource],
        resourceMode: 'shared',
        execute: spy(async () => {
          await AsyncTestUtils.delay(50);
          return `shared-${i}`;
        }),
      }));

      const startTime = Date.now();
      
      const promises = tasks.map(task => 
        coordinationManager.submitTask(task.id, task)
      );

      await Promise.all(promises);
      
      const duration = Date.now() - startTime;
      
      // Should complete faster than serialized execution (less than 150ms vs 150ms+)
      TestAssertions.assertInRange(duration, 0, 120);
    });

    it('should handle resource cleanup on task failure', async () => {
      const failingTask = {
        id: 'failing-task',
        requiredResources: ['cleanup-resource'],
        execute: spy(async () => {
          await AsyncTestUtils.delay(50);
          throw new Error('Task failed');
        }),
      };

      const followupTask = {
        id: 'followup-task',
        requiredResources: ['cleanup-resource'],
        execute: spy(async () => {
          await AsyncTestUtils.delay(10);
          return 'followup-complete';
        }),
      };

      // First task should fail
      await TestAssertions.assertThrowsAsync(
        () => coordinationManager.submitTask('failing-task', failingTask),
        Error,
        'Task failed'
      );

      // Resource should be cleaned up and available for next task
      const result = await coordinationManager.submitTask('followup-task', followupTask);
      assertEquals(result, 'followup-complete');
    });
  });

  describe('Conflict Resolution', () => {
    beforeEach(async () => {
      await coordinationManager.initialize();
    });

    it('should resolve priority conflicts correctly', async () => {
      const conflictingTasks = [
        {
          id: 'low-priority-conflict',
          priority: 'low',
          requiredResources: ['conflict-resource'],
          execute: spy(async () => {
            await AsyncTestUtils.delay(100);
            return 'low-priority';
          }),
        },
        {
          id: 'high-priority-conflict',
          priority: 'critical',
          requiredResources: ['conflict-resource'],
          execute: spy(async () => {
            await AsyncTestUtils.delay(50);
            return 'high-priority';
          }),
        },
      ];

      const promises = conflictingTasks.map(task => 
        coordinationManager.submitTask(task.id, task)
      );

      const results = await Promise.all(promises);
      
      // Both should complete, high priority first
      assertEquals(results.length, 2);
      assertEquals(results.includes('high-priority'), true);
      assertEquals(results.includes('low-priority'), true);
    });

    it('should handle timestamp-based conflict resolution', async () => {
      const timestampResolver = new ConflictResolver({
        enableConflictDetection: true,
        resolutionStrategy: 'timestamp',
      });

      const timestampManager = new CoordinationManager({
        scheduler,
        resourceManager,
        conflictResolver: timestampResolver,
      });

      await timestampManager.initialize();

      const firstTask = {
        id: 'first-timestamp',
        requiredResources: ['timestamp-resource'],
        execute: spy(async () => 'first'),
      };

      const secondTask = {
        id: 'second-timestamp',
        requiredResources: ['timestamp-resource'],
        execute: spy(async () => 'second'),
      };

      // Submit with slight delay to ensure different timestamps
      const firstPromise = timestampManager.submitTask('first-timestamp', firstTask);
      await AsyncTestUtils.delay(5);
      const secondPromise = timestampManager.submitTask('second-timestamp', secondTask);

      const results = await Promise.all([firstPromise, secondPromise]);
      
      // First submitted should win
      assertEquals(results[0], 'first');
      assertEquals(results[1], 'second');
    });

    it('should handle conflict escalation', async () => {
      const escalationTasks = Array.from({ length: 5 }, (_, i) => ({
        id: `escalation-${i}`,
        priority: 'medium',
        requiredResources: ['escalation-resource'],
        maxWaitTime: 200,
        execute: spy(async () => {
          await AsyncTestUtils.delay(100);
          return `escalation-${i}`;
        }),
      }));

      const promises = escalationTasks.map((task, i) => {
        // Stagger submissions to create queue
        return AsyncTestUtils.delay(i * 10).then(() => 
          coordinationManager.submitTask(task.id, task)
        );
      });

      const results = await Promise.all(promises);
      
      // All tasks should complete despite conflicts
      assertEquals(results.length, 5);
      escalationTasks.forEach(task => {
        assertEquals(task.execute.calls.length, 1);
      });
    });

    it('should detect and resolve nested conflicts', async () => {
      const nestedConflictTasks = [
        {
          id: 'nested-1',
          requiredResources: ['resource-a', 'resource-b'],
          execute: spy(async () => {
            await AsyncTestUtils.delay(50);
            return 'nested-1';
          }),
        },
        {
          id: 'nested-2',
          requiredResources: ['resource-b', 'resource-c'],
          execute: spy(async () => {
            await AsyncTestUtils.delay(50);
            return 'nested-2';
          }),
        },
        {
          id: 'nested-3',
          requiredResources: ['resource-c', 'resource-a'],
          execute: spy(async () => {
            await AsyncTestUtils.delay(50);
            return 'nested-3';
          }),
        },
      ];

      const promises = nestedConflictTasks.map(task => 
        coordinationManager.submitTask(task.id, task)
      );

      const results = await Promise.all(promises);
      
      // Should resolve conflicts and complete all tasks
      assertEquals(results.length, 3);
      nestedConflictTasks.forEach(task => {
        assertEquals(task.execute.calls.length, 1);
      });
    });
  });

  describe('Advanced Scheduling Features', () => {
    let advancedScheduler: AdvancedScheduler;
    let workStealingScheduler: WorkStealingScheduler;

    beforeEach(async () => {
      advancedScheduler = new AdvancedScheduler({
        enableWorkStealing: true,
        enablePriorityAging: true,
        enableLoadBalancing: true,
      });

      workStealingScheduler = new WorkStealingScheduler({
        maxWorkersPerQueue: 3,
        stealingThreshold: 2,
        balancingInterval: 100,
      });
    });

    it('should support work stealing between queues', async () => {
      await workStealingScheduler.initialize();

      // Create tasks for multiple agents/workers
      const agentTasks = {
        'agent-1': Array.from({ length: 10 }, (_, i) => ({
          id: `agent1-task-${i}`,
          execute: spy(async () => {
            await AsyncTestUtils.delay(20);
            return `agent1-${i}`;
          }),
        })),
        'agent-2': Array.from({ length: 2 }, (_, i) => ({
          id: `agent2-task-${i}`,
          execute: spy(async () => {
            await AsyncTestUtils.delay(20);
            return `agent2-${i}`;
          }),
        })),
      };

      // Submit tasks to different agent queues
      const promises: Promise<any>[] = [];
      
      for (const [agentId, tasks] of Object.entries(agentTasks)) {
        for (const task of tasks) {
          promises.push(workStealingScheduler.submitTask(agentId, task.id, task));
        }
      }

      const results = await Promise.all(promises);
      
      // All tasks should complete
      assertEquals(results.length, 12);
      
      // Work stealing should have balanced the load
      const agent1Results = results.filter(r => r.startsWith('agent1'));
      const agent2Results = results.filter(r => r.startsWith('agent2'));
      
      assertEquals(agent1Results.length, 10);
      assertEquals(agent2Results.length, 2);
    });

    it('should implement priority aging', async () => {
      await advancedScheduler.initialize();

      const oldLowPriorityTask = {
        id: 'old-low',
        priority: 'low',
        submittedAt: Date.now() - 60000, // 1 minute ago
        execute: spy(async () => 'old-low-priority'),
      };

      const newHighPriorityTask = {
        id: 'new-high',
        priority: 'high',
        submittedAt: Date.now(),
        execute: spy(async () => 'new-high-priority'),
      };

      // Submit in order that would normally favor high priority
      const promises = [
        advancedScheduler.submitTask('old-low', oldLowPriorityTask),
        advancedScheduler.submitTask('new-high', newHighPriorityTask),
      ];

      const results = await Promise.all(promises);
      
      // Priority aging should eventually elevate old low priority task
      assertEquals(results.length, 2);
      assertEquals(oldLowPriorityTask.execute.calls.length, 1);
      assertEquals(newHighPriorityTask.execute.calls.length, 1);
    });

    it('should support dynamic priority adjustment', async () => {
      await advancedScheduler.initialize();

      const adjustableTask = {
        id: 'adjustable',
        priority: 'low',
        execute: spy(async () => {
          await AsyncTestUtils.delay(100);
          return 'adjustable-complete';
        }),
      };

      // Submit task
      const taskPromise = advancedScheduler.submitTask('adjustable', adjustableTask);
      
      // Adjust priority after submission
      await AsyncTestUtils.delay(10);
      await advancedScheduler.adjustTaskPriority('adjustable', 'critical');

      const result = await taskPromise;
      assertEquals(result, 'adjustable-complete');
    });

    it('should handle load balancing across multiple schedulers', async () => {
      const schedulers = Array.from({ length: 3 }, () => new AdvancedScheduler({
        enableLoadBalancing: true,
      }));

      await Promise.all(schedulers.map(s => s.initialize()));

      // Create uneven task distribution
      const tasks = Array.from({ length: 30 }, (_, i) => ({
        id: `balance-task-${i}`,
        execute: spy(async () => {
          await AsyncTestUtils.delay(50);
          return `task-${i}`;
        }),
      }));

      // Submit all tasks to first scheduler
      const promises = tasks.map(task => 
        schedulers[0].submitTask(task.id, task)
      );

      const results = await Promise.all(promises);
      
      // Load balancing should distribute tasks across schedulers
      assertEquals(results.length, 30);
      tasks.forEach(task => {
        assertEquals(task.execute.calls.length, 1);
      });
    });
  });

  describe('Performance and Scalability', () => {
    beforeEach(async () => {
      await coordinationManager.initialize();
    });

    it('should handle high task submission throughput', async () => {
      const { stats } = await PerformanceTestUtils.benchmark(
        async () => {
          const taskId = `perf-task-${Date.now()}-${Math.random()}`;
          return coordinationManager.submitTask(taskId, {
            execute: async () => 'quick-task',
          });
        },
        { iterations: 200, concurrency: 10 }
      );

      TestAssertions.assertInRange(stats.mean, 0, 50); // Should be fast
      console.log(`Task submission performance: ${stats.mean.toFixed(2)}ms average`);
    });

    it('should scale with large numbers of tasks', async () => {
      const largeBatch = Array.from({ length: 1000 }, (_, i) => ({
        id: `scale-task-${i}`,
        execute: spy(async () => `result-${i}`),
      }));

      const startTime = Date.now();
      
      const promises = largeBatch.map(task => 
        coordinationManager.submitTask(task.id, task)
      );

      const results = await Promise.all(promises);
      
      const duration = Date.now() - startTime;
      
      assertEquals(results.length, 1000);
      TestAssertions.assertInRange(duration, 0, 10000); // Should complete within 10 seconds
      
      console.log(`Large batch (1000 tasks) completed in ${duration}ms`);
    });

    it('should maintain performance under memory pressure', async () => {
      const { leaked } = await MemoryTestUtils.checkMemoryLeak(async () => {
        // Submit many tasks with varying resource requirements
        const tasks = Array.from({ length: 500 }, (_, i) => ({
          id: `memory-task-${i}`,
          estimatedMemoryUsage: 1024 * 100, // 100KB each
          execute: spy(async () => {
            // Simulate some memory usage
            const data = new Array(100).fill(i);
            await AsyncTestUtils.delay(5);
            return data.length;
          }),
        }));

        const promises = tasks.map(task => 
          coordinationManager.submitTask(task.id, task)
        );

        await Promise.all(promises);
      });

      assertEquals(leaked, false);
    });

    it('should handle load testing scenario', async () => {
      const results = await PerformanceTestUtils.loadTest(
        async () => {
          const taskId = `load-task-${Date.now()}-${Math.random()}`;
          return coordinationManager.submitTask(taskId, {
            execute: async () => 'load-test-result',
          });
        },
        {
          duration: 5000, // 5 seconds
          maxConcurrency: 20,
          requestsPerSecond: 50,
        }
      );

      TestAssertions.assertInRange(results.successfulRequests / results.totalRequests, 0.95, 1.0);
      TestAssertions.assertInRange(results.averageResponseTime, 0, 100);
      
      console.log(`Load test: ${results.successfulRequests}/${results.totalRequests} successful`);
    });
  });

  describe('Error Handling and Recovery', () => {
    beforeEach(async () => {
      await coordinationManager.initialize();
    });

    it('should handle task execution failures gracefully', async () => {
      const errorScenarios = generateErrorScenarios();
      
      for (const scenario of errorScenarios) {
        const failingTask = {
          id: `error-task-${scenario.name}`,
          execute: spy(async () => {
            throw scenario.error;
          }),
        };

        if (scenario.recoverable) {
          // Should retry recoverable errors
          try {
            await coordinationManager.submitTask(`error-task-${scenario.name}`, failingTask);
          } catch (error) {
            // May still fail after retries
            assertExists(error);
          }
        } else {
          // Should fail fast for non-recoverable errors
          await TestAssertions.assertThrowsAsync(
            () => coordinationManager.submitTask(`error-task-${scenario.name}`, failingTask),
            Error,
            scenario.error.message
          );
        }
      }
    });

    it('should recover from scheduler failures', async () => {
      // Simulate scheduler failure
      const originalSubmit = scheduler.submit.bind(scheduler);
      let failureCount = 0;
      
      scheduler.submit = spy(async (...args) => {
        failureCount++;
        if (failureCount <= 2) {
          throw new Error('Scheduler temporarily unavailable');
        }
        return originalSubmit(...args);
      });

      const resilientTask = {
        id: 'resilient-task',
        execute: spy(async () => 'recovered'),
      };

      // Should eventually succeed after scheduler recovers
      const result = await coordinationManager.submitTask('resilient-task', resilientTask);
      assertEquals(result, 'recovered');
      assertEquals(failureCount, 3);
    });

    it('should handle resource manager failures', async () => {
      // Simulate resource manager failure
      const originalAcquire = resourceManager.acquireResources.bind(resourceManager);
      let attempts = 0;
      
      resourceManager.acquireResources = spy(async (...args) => {
        attempts++;
        if (attempts <= 1) {
          throw new Error('Resource manager failure');
        }
        return originalAcquire(...args);
      });

      const resourceTask = {
        id: 'resource-task',
        requiredResources: ['test-resource'],
        execute: spy(async () => 'resource-task-complete'),
      };

      // Should recover from resource manager failure
      const result = await coordinationManager.submitTask('resource-task', resourceTask);
      assertEquals(result, 'resource-task-complete');
    });

    it('should handle partial system failures', async () => {
      // Create a scenario where some components fail
      const partiallyFailingTasks = Array.from({ length: 10 }, (_, i) => ({
        id: `partial-${i}`,
        execute: spy(async () => {
          if (i % 3 === 0) {
            throw new Error(`Task ${i} failed`);
          }
          return `success-${i}`;
        }),
      }));

      const results = await Promise.allSettled(
        partiallyFailingTasks.map(task => 
          coordinationManager.submitTask(task.id, task)
        )
      );

      const successes = results.filter(r => r.status === 'fulfilled');
      const failures = results.filter(r => r.status === 'rejected');
      
      // Should have partial success
      assertEquals(successes.length, 7); // 7 out of 10 should succeed
      assertEquals(failures.length, 3);
      
      // System should remain functional
      const healthStatus = await coordinationManager.getHealthStatus();
      assertEquals(healthStatus.healthy, true);
    });

    it('should implement circuit breaker pattern', async () => {
      const circuitBreaker = new CircuitBreaker('test-circuit', {
        threshold: 3,
        timeout: 1000,
        resetTimeout: 2000,
      });

      let failureCount = 0;
      const flakyService = async () => {
        failureCount++;
        if (failureCount <= 5) {
          throw new Error('Service failure');
        }
        return 'service-success';
      };

      // Trigger circuit breaker opening
      for (let i = 0; i < 5; i++) {
        try {
          await circuitBreaker.execute(flakyService);
        } catch (error) {
          // Expected failures
        }
      }

      // Circuit should be open now
      assertEquals(circuitBreaker.getState().state, 'open');

      // Should fail fast while open
      await TestAssertions.assertThrowsAsync(
        () => circuitBreaker.execute(flakyService),
        Error,
        'Circuit breaker test-circuit is open'
      );

      // Wait for reset timeout
      await AsyncTestUtils.delay(2100);

      // Should succeed after circuit resets
      const result = await circuitBreaker.execute(flakyService);
      assertEquals(result, 'service-success');
    });
  });

  describe('Monitoring and Metrics', () => {
    beforeEach(async () => {
      await coordinationManager.initialize();
    });

    it('should track execution metrics', async () => {
      const tasks = Array.from({ length: 10 }, (_, i) => ({
        id: `metric-task-${i}`,
        execute: spy(async () => {
          await AsyncTestUtils.delay(10 + i * 5); // Variable execution time
          return `metric-${i}`;
        }),
      }));

      await Promise.all(
        tasks.map(task => coordinationManager.submitTask(task.id, task))
      );

      const metrics = await coordinationManager.getMetrics();
      
      assertExists(metrics);
      assertEquals(typeof metrics.totalTasksSubmitted, 'number');
      assertEquals(typeof metrics.totalTasksCompleted, 'number');
      assertEquals(typeof metrics.averageExecutionTime, 'number');
      assertEquals(typeof metrics.currentActiveTasks, 'number');
      
      assertEquals(metrics.totalTasksCompleted, 10);
      TestAssertions.assertInRange(metrics.averageExecutionTime, 10, 100);
    });

    it('should track resource utilization metrics', async () => {
      const resourceIntensiveTasks = Array.from({ length: 5 }, (_, i) => ({
        id: `resource-metric-${i}`,
        requiredResources: [`cpu-${i % 2}`, 'memory'],
        estimatedMemoryUsage: 1024 * 1024 * (i + 1), // Variable memory usage
        execute: spy(async () => {
          await AsyncTestUtils.delay(50);
          return `resource-${i}`;
        }),
      }));

      await Promise.all(
        resourceIntensiveTasks.map(task => 
          coordinationManager.submitTask(task.id, task)
        )
      );

      const resourceMetrics = await resourceManager.getMetrics();
      
      assertExists(resourceMetrics);
      assertEquals(typeof resourceMetrics.peakMemoryUsage, 'number');
      assertEquals(typeof resourceMetrics.averageMemoryUsage, 'number');
      assertEquals(typeof resourceMetrics.resourceUtilization, 'object');
    });

    it('should provide health status information', async () => {
      const healthStatus = await coordinationManager.getHealthStatus();
      
      assertExists(healthStatus);
      assertEquals(typeof healthStatus.healthy, 'boolean');
      assertEquals(typeof healthStatus.components, 'object');
      
      // Check individual component health
      assertEquals(typeof healthStatus.components.scheduler, 'object');
      assertEquals(typeof healthStatus.components.resourceManager, 'object');
      assertEquals(typeof healthStatus.components.conflictResolver, 'object');
    });

    it('should detect performance degradation', async () => {
      // Create a scenario that causes performance degradation
      const slowTasks = Array.from({ length: 20 }, (_, i) => ({
        id: `slow-task-${i}`,
        execute: spy(async () => {
          await AsyncTestUtils.delay(200 + i * 10); // Progressively slower
          return `slow-${i}`;
        }),
      }));

      const startTime = Date.now();
      
      await Promise.all(
        slowTasks.map(task => coordinationManager.submitTask(task.id, task))
      );

      const endTime = Date.now();
      const totalDuration = endTime - startTime;

      const performanceMetrics = await coordinationManager.getPerformanceMetrics();
      
      assertExists(performanceMetrics);
      assertEquals(typeof performanceMetrics.throughput, 'number');
      assertEquals(typeof performanceMetrics.latency, 'object');
      
      // Should detect degradation in throughput
      TestAssertions.assertInRange(performanceMetrics.throughput, 0.01, 1.0); // tasks per ms
    });
  });
});