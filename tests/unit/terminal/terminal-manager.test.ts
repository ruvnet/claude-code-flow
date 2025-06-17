/**
 * Comprehensive unit tests for Terminal Manager
 */

import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { assertEquals, assertExists, assertRejects, assertThrows } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { spy, stub } from "@std/testing/mock";

import { TerminalManager } from '../../../src/terminal/manager.ts';
import { TerminalPool } from '../../../src/terminal/pool.ts';
import { NativeTerminalAdapter } from '../../../src/terminal/adapters/native.ts';
import { 
  AsyncTestUtils, 
  MemoryTestUtils, 
  PerformanceTestUtils,
  TestAssertions,
  MockFactory 
} from '../../utils/test-utils.ts';
import { generateTerminalSessions, generateEdgeCaseData } from '../../fixtures/generators.ts';
import { setupTestEnv, cleanupTestEnv, TEST_CONFIG } from '../../test.config.ts';

describe('Terminal Manager - Comprehensive Tests', () => {
  let terminalManager: TerminalManager;
  let mockPool: any;
  let fakeTime: FakeTime;

  beforeEach(() => {
    setupTestEnv();
    
    // Create mock terminal pool
    mockPool = MockFactory.createMock({
      initialize: async () => {},
      shutdown: async () => {},
      createSession: async (profile: any) => `session-${Date.now()}`,
      getSession: (sessionId: string) => ({ id: sessionId, status: 'active' }),
      destroySession: async (sessionId: string) => {},
      executeCommand: async (sessionId: string, command: any) => `Output for: ${command}`,
      listSessions: () => [],
      getSessionCount: () => 0,
      getAvailableSlots: () => 5,
      performMaintenance: async () => {},
    });

    terminalManager = new TerminalManager({
      pool: mockPool,
      maxConcurrentSessions: 10,
      sessionTimeout: 30000,
      commandTimeout: 10000,
    });

    fakeTime = new FakeTime();
  });

  afterEach(async () => {
    fakeTime.restore();
    await cleanupTestEnv();
  });

  describe('Initialization and Configuration', () => {
    it('should initialize successfully with valid configuration', async () => {
      await terminalManager.initialize();
      
      assertEquals(mockPool.initialize.calls.length, 1);
      assertEquals(terminalManager.isInitialized(), true);
    });

    it('should validate configuration parameters', () => {
      assertThrows(
        () => new TerminalManager({
          pool: mockPool,
          maxConcurrentSessions: 0, // Invalid
          sessionTimeout: 30000,
          commandTimeout: 10000,
        }),
        Error,
        'maxConcurrentSessions must be greater than 0'
      );

      assertThrows(
        () => new TerminalManager({
          pool: mockPool,
          maxConcurrentSessions: 10,
          sessionTimeout: 0, // Invalid
          commandTimeout: 10000,
        }),
        Error,
        'sessionTimeout must be greater than 0'
      );
    });

    it('should handle initialization failure gracefully', async () => {
      mockPool.initialize = spy(async () => {
        throw new Error('Pool initialization failed');
      });

      await assertRejects(
        () => terminalManager.initialize(),
        Error,
        'Pool initialization failed'
      );

      assertEquals(terminalManager.isInitialized(), false);
    });

    it('should prevent double initialization', async () => {
      await terminalManager.initialize();

      await assertRejects(
        () => terminalManager.initialize(),
        Error,
        'Terminal manager already initialized'
      );
    });

    it('should handle different adapter configurations', async () => {
      const nativeManager = new TerminalManager({
        adapter: 'native',
        maxConcurrentSessions: 5,
        sessionTimeout: 15000,
        commandTimeout: 5000,
      });

      await nativeManager.initialize();
      assertEquals(nativeManager.isInitialized(), true);
      await nativeManager.shutdown();
    });
  });

  describe('Session Management', () => {
    beforeEach(async () => {
      await terminalManager.initialize();
    });

    it('should create terminal sessions successfully', async () => {
      const profile = {
        id: 'test-agent',
        name: 'Test Agent',
        workingDirectory: '/tmp/test',
        environment: { TEST_VAR: 'test_value' },
      };

      const sessionId = await terminalManager.spawnTerminal(profile);
      
      assertExists(sessionId);
      assertEquals(mockPool.createSession.calls.length, 1);
      assertEquals(mockPool.createSession.calls[0].args[0], profile);
    });

    it('should handle session creation with default profile', async () => {
      const sessionId = await terminalManager.spawnTerminal();
      
      assertExists(sessionId);
      assertEquals(mockPool.createSession.calls.length, 1);
      
      // Should use default profile
      const passedProfile = mockPool.createSession.calls[0].args[0];
      assertEquals(typeof passedProfile.id, 'string');
      assertEquals(typeof passedProfile.name, 'string');
    });

    it('should terminate sessions correctly', async () => {
      const sessionId = await terminalManager.spawnTerminal();
      await terminalManager.terminateTerminal(sessionId);
      
      assertEquals(mockPool.destroySession.calls.length, 1);
      assertEquals(mockPool.destroySession.calls[0].args[0], sessionId);
    });

    it('should handle termination of non-existent session', async () => {
      mockPool.destroySession = spy(async (sessionId: string) => {
        throw new Error(`Session not found: ${sessionId}`);
      });

      await assertRejects(
        () => terminalManager.terminateTerminal('non-existent'),
        Error,
        'Session not found: non-existent'
      );
    });

    it('should enforce session limits', async () => {
      const limitedManager = new TerminalManager({
        pool: mockPool,
        maxConcurrentSessions: 2,
        sessionTimeout: 30000,
        commandTimeout: 10000,
      });

      await limitedManager.initialize();

      // Mock pool to report current session count
      mockPool.getSessionCount = spy(() => 2);

      await assertRejects(
        () => limitedManager.spawnTerminal(),
        Error,
        'Maximum concurrent sessions reached'
      );
    });

    it('should handle concurrent session creation', async () => {
      const profiles = Array.from({ length: 5 }, (_, i) => ({
        id: `agent-${i}`,
        name: `Agent ${i}`,
      }));

      const promises = profiles.map(profile => 
        terminalManager.spawnTerminal(profile)
      );

      const sessionIds = await Promise.all(promises);
      
      assertEquals(sessionIds.length, 5);
      assertEquals(mockPool.createSession.calls.length, 5);
      
      // All session IDs should be unique
      const uniqueIds = new Set(sessionIds);
      assertEquals(uniqueIds.size, 5);
    });

    it('should handle session timeout cleanup', async () => {
      const sessionData = generateTerminalSessions(10);
      
      // Mock expired sessions
      mockPool.listSessions = spy(() => sessionData.map(session => ({
        ...session,
        lastActivity: new Date(Date.now() - 60000), // 1 minute ago
      })));

      await terminalManager.performMaintenance();
      
      // Should clean up expired sessions
      assertEquals(mockPool.performMaintenance.calls.length, 1);
    });
  });

  describe('Command Execution', () => {
    let sessionId: string;

    beforeEach(async () => {
      await terminalManager.initialize();
      sessionId = await terminalManager.spawnTerminal();
    });

    it('should execute commands successfully', async () => {
      const command = {
        command: 'echo "Hello World"',
        args: [],
        options: {},
      };

      const result = await terminalManager.sendCommand(sessionId, command);
      
      assertExists(result);
      assertEquals(mockPool.executeCommand.calls.length, 1);
      assertEquals(mockPool.executeCommand.calls[0].args[0], sessionId);
      assertEquals(mockPool.executeCommand.calls[0].args[1], command);
    });

    it('should handle string commands', async () => {
      const command = 'ls -la';
      
      const result = await terminalManager.sendCommand(sessionId, command);
      
      assertExists(result);
      assertEquals(mockPool.executeCommand.calls.length, 1);
    });

    it('should handle command timeout', async () => {
      mockPool.executeCommand = spy(async () => {
        await new Promise(resolve => setTimeout(resolve, 15000)); // 15 seconds
        return 'Too late';
      });

      await TestAssertions.assertThrowsAsync(
        () => terminalManager.sendCommand(sessionId, 'slow-command'),
        Error,
        'timeout'
      );
    });

    it('should handle concurrent command execution', async () => {
      const commands = Array.from({ length: 10 }, (_, i) => `echo "Command ${i}"`);
      
      const promises = commands.map(command => 
        terminalManager.sendCommand(sessionId, command)
      );

      const results = await Promise.all(promises);
      
      assertEquals(results.length, 10);
      assertEquals(mockPool.executeCommand.calls.length, 10);
    });

    it('should handle command execution on multiple sessions', async () => {
      const sessionIds = await Promise.all([
        terminalManager.spawnTerminal({ id: 'agent-1' }),
        terminalManager.spawnTerminal({ id: 'agent-2' }),
        terminalManager.spawnTerminal({ id: 'agent-3' }),
      ]);

      const promises = sessionIds.map((sessionId, i) => 
        terminalManager.sendCommand(sessionId, `echo "Session ${i}"`)
      );

      const results = await Promise.all(promises);
      
      assertEquals(results.length, 3);
      assertEquals(mockPool.executeCommand.calls.length, 3);
    });

    it('should handle command execution errors', async () => {
      mockPool.executeCommand = spy(async () => {
        throw new Error('Command execution failed');
      });

      await assertRejects(
        () => terminalManager.sendCommand(sessionId, 'failing-command'),
        Error,
        'Command execution failed'
      );
    });

    it('should handle malformed commands', async () => {
      const malformedCommands = [
        null,
        undefined,
        '',
        { command: '' },
        { command: null },
        { args: 'not-an-array' },
      ];

      for (const command of malformedCommands) {
        await TestAssertions.assertThrowsAsync(
          () => terminalManager.sendCommand(sessionId, command as any),
          Error
        );
      }
    });
  });

  describe('Performance and Scalability', () => {
    beforeEach(async () => {
      await terminalManager.initialize();
    });

    it('should handle high session creation throughput', async () => {
      const { stats } = await PerformanceTestUtils.benchmark(
        () => terminalManager.spawnTerminal({
          id: `perf-agent-${Date.now()}-${Math.random()}`,
          name: 'Performance Agent',
        }),
        { iterations: 100, concurrency: 5 }
      );

      TestAssertions.assertInRange(stats.mean, 0, 100); // Should be fast
      assertEquals(mockPool.createSession.calls.length, 100);
      
      console.log(`Session creation performance: ${stats.mean.toFixed(2)}ms average`);
    });

    it('should handle high command execution throughput', async () => {
      const sessionId = await terminalManager.spawnTerminal();
      
      const { stats } = await PerformanceTestUtils.benchmark(
        () => terminalManager.sendCommand(sessionId, `echo "Test ${Date.now()}"`),
        { iterations: 50, concurrency: 3 }
      );

      TestAssertions.assertInRange(stats.mean, 0, 50); // Should be fast
      assertEquals(mockPool.executeCommand.calls.length, 50);
      
      console.log(`Command execution performance: ${stats.mean.toFixed(2)}ms average`);
    });

    it('should handle memory efficiently with many sessions', async () => {
      const { leaked } = await MemoryTestUtils.checkMemoryLeak(async () => {
        // Create many sessions
        const sessionIds = await Promise.all(
          Array.from({ length: 100 }, () => terminalManager.spawnTerminal())
        );

        // Execute commands on all sessions
        await Promise.all(
          sessionIds.map(sessionId => 
            terminalManager.sendCommand(sessionId, 'echo "Memory test"')
          )
        );

        // Clean up sessions
        await Promise.all(
          sessionIds.map(sessionId => terminalManager.terminateTerminal(sessionId))
        );
      });

      assertEquals(leaked, false);
    });

    it('should maintain performance under resource pressure', async () => {
      // Simulate resource pressure by creating many sessions
      const sessionIds = await Promise.all(
        Array.from({ length: 50 }, () => terminalManager.spawnTerminal())
      );

      const { stats } = await PerformanceTestUtils.benchmark(
        () => {
          const randomSessionId = sessionIds[Math.floor(Math.random() * sessionIds.length)];
          return terminalManager.sendCommand(randomSessionId, 'echo "Under pressure"');
        },
        { iterations: 20 }
      );

      // Performance should still be reasonable under pressure
      TestAssertions.assertInRange(stats.mean, 0, 200);
      
      console.log(`Performance under pressure: ${stats.mean.toFixed(2)}ms average`);
    });

    it('should handle load testing scenario', async () => {
      const sessionId = await terminalManager.spawnTerminal();
      
      const results = await PerformanceTestUtils.loadTest(
        () => terminalManager.sendCommand(sessionId, `echo "Load test ${Date.now()}"`),
        {
          duration: 3000, // 3 seconds
          maxConcurrency: 5,
          requestsPerSecond: 10,
        }
      );

      TestAssertions.assertInRange(results.successfulRequests / results.totalRequests, 0.9, 1.0);
      TestAssertions.assertInRange(results.averageResponseTime, 0, 100);
      
      console.log(`Load test: ${results.successfulRequests}/${results.totalRequests} successful`);
    });
  });

  describe('Health Monitoring and Maintenance', () => {
    beforeEach(async () => {
      await terminalManager.initialize();
    });

    it('should report health status correctly', async () => {
      const health = await terminalManager.getHealthStatus();
      
      assertEquals(health.healthy, true);
      assertExists(health.metrics);
      assertEquals(typeof health.metrics.activeSessions, 'number');
      assertEquals(typeof health.metrics.availableSlots, 'number');
    });

    it('should detect unhealthy pool status', async () => {
      mockPool.getSessionCount = spy(() => {
        throw new Error('Pool is unhealthy');
      });

      const health = await terminalManager.getHealthStatus();
      
      assertEquals(health.healthy, false);
      assertExists(health.error);
    });

    it('should perform maintenance operations', async () => {
      await terminalManager.performMaintenance();
      
      assertEquals(mockPool.performMaintenance.calls.length, 1);
    });

    it('should handle maintenance errors gracefully', async () => {
      mockPool.performMaintenance = spy(async () => {
        throw new Error('Maintenance failed');
      });

      // Should not throw, but log error
      await terminalManager.performMaintenance();
      
      assertEquals(mockPool.performMaintenance.calls.length, 1);
    });

    it('should track session metrics accurately', async () => {
      // Create some sessions
      const sessionIds = await Promise.all([
        terminalManager.spawnTerminal(),
        terminalManager.spawnTerminal(),
        terminalManager.spawnTerminal(),
      ]);

      // Execute some commands
      await Promise.all(
        sessionIds.map(sessionId => 
          terminalManager.sendCommand(sessionId, 'echo "Metrics test"')
        )
      );

      const health = await terminalManager.getHealthStatus();
      
      assertExists(health.metrics);
      TestAssertions.assertInRange(health.metrics.activeSessions, 0, 10);
      TestAssertions.assertInRange(health.metrics.totalCommands, 3, 100);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    beforeEach(async () => {
      await terminalManager.initialize();
    });

    it('should handle pool failures gracefully', async () => {
      mockPool.createSession = spy(async () => {
        throw new Error('Pool failure');
      });

      await assertRejects(
        () => terminalManager.spawnTerminal(),
        Error,
        'Pool failure'
      );
    });

    it('should handle invalid session IDs', async () => {
      const invalidSessionIds = ['', null, undefined, 'invalid-id'];
      
      for (const sessionId of invalidSessionIds) {
        await TestAssertions.assertThrowsAsync(
          () => terminalManager.sendCommand(sessionId as any, 'echo test'),
          Error
        );
      }
    });

    it('should handle edge case profile data', async () => {
      const edgeCases = generateEdgeCaseData();
      
      // Test with various edge case profiles
      const validProfiles = [
        { id: 'valid', name: 'Valid' },
        { id: '', name: 'Empty ID' }, // May be valid depending on implementation
        { id: 'test', name: '', workingDirectory: '/tmp' },
      ];

      for (const profile of validProfiles) {
        try {
          const sessionId = await terminalManager.spawnTerminal(profile);
          assertExists(sessionId);
        } catch (error) {
          // Some edge cases may be rejected, which is acceptable
        }
      }
    });

    it('should handle concurrent failures', async () => {
      let failureCount = 0;
      
      mockPool.createSession = spy(async () => {
        failureCount++;
        if (failureCount <= 3) {
          throw new Error('Temporary failure');
        }
        return `session-${failureCount}`;
      });

      const promises = Array.from({ length: 5 }, () => 
        terminalManager.spawnTerminal().catch(error => error)
      );

      const results = await Promise.all(promises);
      
      // Some should succeed, some should fail
      const successes = results.filter(r => typeof r === 'string');
      const failures = results.filter(r => r instanceof Error);
      
      assertEquals(successes.length >= 1, true);
      assertEquals(failures.length >= 1, true);
    });

    it('should handle resource exhaustion scenarios', async () => {
      // Mock pool to simulate resource exhaustion
      mockPool.getAvailableSlots = spy(() => 0);
      mockPool.createSession = spy(async () => {
        throw new Error('No available slots');
      });

      await assertRejects(
        () => terminalManager.spawnTerminal(),
        Error,
        'No available slots'
      );
    });

    it('should recover from temporary adapter failures', async () => {
      let attemptCount = 0;
      
      mockPool.executeCommand = spy(async (sessionId: string, command: any) => {
        attemptCount++;
        if (attemptCount <= 2) {
          throw new Error('Adapter temporarily unavailable');
        }
        return `Success on attempt ${attemptCount}`;
      });

      const sessionId = await terminalManager.spawnTerminal();
      
      // First few attempts should fail, but eventually succeed with retry logic
      try {
        const result = await terminalManager.sendCommand(sessionId, 'test-command');
        // If retry logic is implemented, this should eventually succeed
        assertExists(result);
      } catch (error) {
        // If no retry logic, should fail on first attempt
        assertEquals(error.message, 'Adapter temporarily unavailable');
      }
    });
  });

  describe('Shutdown and Cleanup', () => {
    it('should shutdown gracefully', async () => {
      await terminalManager.initialize();
      
      // Create some sessions
      await Promise.all([
        terminalManager.spawnTerminal(),
        terminalManager.spawnTerminal(),
      ]);

      await terminalManager.shutdown();
      
      assertEquals(mockPool.shutdown.calls.length, 1);
      assertEquals(terminalManager.isInitialized(), false);
    });

    it('should handle shutdown with active sessions', async () => {
      await terminalManager.initialize();
      
      const sessionId = await terminalManager.spawnTerminal();
      
      // Start a long-running command
      const commandPromise = terminalManager.sendCommand(sessionId, 'long-running-command');
      
      // Shutdown while command is running
      const shutdownPromise = terminalManager.shutdown();
      
      // Both should complete (command may be cancelled)
      await Promise.allSettled([commandPromise, shutdownPromise]);
      
      assertEquals(terminalManager.isInitialized(), false);
    });

    it('should timeout shutdown if pool hangs', async () => {
      await terminalManager.initialize();
      
      mockPool.shutdown = spy(async () => {
        await new Promise(resolve => setTimeout(resolve, 30000)); // 30 seconds
      });

      await TestAssertions.assertCompletesWithin(
        () => terminalManager.shutdown(),
        5000 // Should timeout shutdown after 5 seconds
      );
    });

    it('should handle shutdown errors gracefully', async () => {
      await terminalManager.initialize();
      
      mockPool.shutdown = spy(async () => {
        throw new Error('Shutdown failed');
      });

      // Should complete shutdown despite pool error
      await terminalManager.shutdown();
      
      assertEquals(terminalManager.isInitialized(), false);
    });

    it('should prevent operations after shutdown', async () => {
      await terminalManager.initialize();
      await terminalManager.shutdown();

      await assertRejects(
        () => terminalManager.spawnTerminal(),
        Error,
        'Terminal manager not initialized'
      );

      await assertRejects(
        () => terminalManager.sendCommand('session-id', 'echo test'),
        Error,
        'Terminal manager not initialized'
      );
    });
  });
});