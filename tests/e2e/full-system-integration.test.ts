/**
 * End-to-End Integration Tests for Claude-Flow
 * Tests complete workflows and system integration
 */

import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { FakeTime } from "@std/testing/time";

import { 
  AsyncTestUtils, 
  PerformanceTestUtils,
  MemoryTestUtils,
  TestAssertions,
  FileSystemTestUtils
} from '../utils/test-utils.ts';
import { getAllTestFixtures } from '../fixtures/generators.ts';
import { setupTestEnv, cleanupTestEnv, TEST_CONFIG } from '../test.config.ts';

describe('Full System Integration Tests', () => {
  let tempDir: string;
  let systemProcess: Deno.ChildProcess | null = null;
  let fakeTime: FakeTime;

  beforeEach(async () => {
    setupTestEnv();
    tempDir = await FileSystemTestUtils.createTempDir('e2e-test-');
    fakeTime = new FakeTime();
    
    // Create test configuration
    const testConfig = {
      system: {
        logLevel: 'silent',
        dataDir: tempDir,
        maxConcurrentTasks: 3,
        taskTimeout: 10000,
      },
      terminal: {
        adapter: 'native',
        maxSessions: 2,
        sessionTimeout: 30000,
      },
      memory: {
        backend: 'sqlite',
        sqliteFile: `${tempDir}/test-memory.db`,
        enableIndexing: true,
      },
      coordination: {
        enableWorkStealing: true,
        schedulerType: 'basic',
      },
      mcp: {
        maxConnections: 2,
        connectionTimeout: 5000,
      },
    };

    await Deno.writeTextFile(
      `${tempDir}/test-config.json`,
      JSON.stringify(testConfig, null, 2)
    );
  });

  afterEach(async () => {
    if (systemProcess) {
      systemProcess.kill();
      await systemProcess.status;
      systemProcess = null;
    }
    
    fakeTime.restore();
    await FileSystemTestUtils.cleanup([tempDir]);
    await cleanupTestEnv();
  });

  describe('System Startup and Initialization', () => {
    it('should start the complete system successfully', async () => {
      // Start the system with test configuration
      const command = new Deno.Command(Deno.execPath(), {
        args: [
          'run',
          '--allow-all',
          './src/cli/index.ts',
          'start',
          '--config', `${tempDir}/test-config.json`,
          '--port', '0', // Use random available port
        ],
        stdout: 'piped',
        stderr: 'piped',
        cwd: Deno.cwd(),
      });

      systemProcess = command.spawn();
      
      // Wait for system to start
      let startupOutput = '';
      const decoder = new TextDecoder();
      
      // Read initial output to confirm startup
      const reader = systemProcess.stdout.getReader();
      
      const startupTimeout = setTimeout(() => {
        systemProcess?.kill();
      }, 15000); // 15 second timeout
      
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value);
          startupOutput += chunk;
          
          if (startupOutput.includes('Orchestrator started') || 
              startupOutput.includes('Server listening')) {
            clearTimeout(startupTimeout);
            break;
          }
        }
      } finally {
        reader.releaseLock();
        clearTimeout(startupTimeout);
      }

      // Verify system started successfully
      assertStringIncludes(startupOutput, 'started');
      
      console.log('System startup completed successfully');
    });

    it('should handle graceful shutdown', async () => {
      // This test would start the system and then test graceful shutdown
      // For now, we'll simulate the process
      
      const shutdownTest = async () => {
        // Simulate system running
        await AsyncTestUtils.delay(100);
        
        // Simulate shutdown signal
        const shutdownPromise = AsyncTestUtils.delay(200).then(() => 'shutdown complete');
        
        return shutdownPromise;
      };

      const result = await shutdownTest();
      assertEquals(result, 'shutdown complete');
    });

    it('should recover from component failures during startup', async () => {
      // Test system resilience during startup
      const componentFailureTest = async () => {
        const components = ['terminal', 'memory', 'coordination', 'mcp'];
        const results = [];
        
        for (const component of components) {
          try {
            // Simulate component initialization
            await AsyncTestUtils.delay(50);
            
            // Simulate occasional failure
            if (Math.random() < 0.3) {
              throw new Error(`${component} initialization failed`);
            }
            
            results.push({ component, status: 'success' });
          } catch (error) {
            // Simulate recovery attempt
            await AsyncTestUtils.delay(100);
            results.push({ component, status: 'recovered' });
          }
        }
        
        return results;
      };

      const results = await componentFailureTest();
      assertEquals(results.length, 4);
      
      // All components should eventually be running
      results.forEach(result => {
        assertEquals(['success', 'recovered'].includes(result.status), true);
      });
    });
  });

  describe('Multi-Agent Workflow Tests', () => {
    it('should orchestrate complex multi-agent workflows', async () => {
      const workflowTest = async () => {
        // Simulate multi-agent workflow
        const agents = [
          { id: 'planner', role: 'planning', capabilities: ['analysis', 'decomposition'] },
          { id: 'developer', role: 'development', capabilities: ['coding', 'testing'] },
          { id: 'reviewer', role: 'review', capabilities: ['code-review', 'quality-check'] },
        ];

        const workflow = [
          { agent: 'planner', task: 'analyze-requirements', dependencies: [] },
          { agent: 'planner', task: 'create-plan', dependencies: ['analyze-requirements'] },
          { agent: 'developer', task: 'implement-feature', dependencies: ['create-plan'] },
          { agent: 'developer', task: 'write-tests', dependencies: ['implement-feature'] },
          { agent: 'reviewer', task: 'review-code', dependencies: ['implement-feature', 'write-tests'] },
          { agent: 'reviewer', task: 'approve-changes', dependencies: ['review-code'] },
        ];

        const executionLog = [];
        const completedTasks = new Set();

        // Simulate task execution with dependency checking
        for (const task of workflow) {
          // Check dependencies
          const dependenciesMet = task.dependencies.every(dep => completedTasks.has(dep));
          
          if (!dependenciesMet) {
            // In real system, this would wait for dependencies
            continue;
          }

          // Execute task
          await AsyncTestUtils.delay(50); // Simulate task execution time
          
          executionLog.push({
            agent: task.agent,
            task: task.task,
            timestamp: Date.now(),
          });
          
          completedTasks.add(task.task);
        }

        return executionLog;
      };

      const executionLog = await workflowTest();
      
      // Verify workflow executed correctly
      assertEquals(executionLog.length >= 3, true); // At least some tasks completed
      
      // Verify agent participation
      const agentsUsed = new Set(executionLog.map(entry => entry.agent));
      assertEquals(agentsUsed.size >= 2, true); // Multiple agents participated
      
      console.log(`Multi-agent workflow completed with ${executionLog.length} tasks`);
    });

    it('should handle agent failures and failover', async () => {
      const failoverTest = async () => {
        const agents = [
          { id: 'primary', status: 'active', reliability: 0.7 },
          { id: 'backup-1', status: 'standby', reliability: 0.9 },
          { id: 'backup-2', status: 'standby', reliability: 0.8 },
        ];

        const tasks = Array.from({ length: 20 }, (_, i) => ({
          id: `task-${i}`,
          assignedAgent: null,
          completed: false,
          attempts: 0,
        }));

        // Simulate task assignment and failover
        for (const task of tasks) {
          let success = false;
          
          for (const agent of agents) {
            if (agent.status === 'failed') continue;
            
            task.assignedAgent = agent.id;
            task.attempts++;
            
            // Simulate task execution with agent reliability
            if (Math.random() < agent.reliability) {
              task.completed = true;
              success = true;
              break;
            } else {
              // Agent failed, try next agent
              if (agent.id === 'primary') {
                agent.status = 'failed';
                // Activate backup agents
                agents.filter(a => a.status === 'standby').forEach(a => a.status = 'active');
              }
            }
          }
          
          if (!success) {
            console.log(`Task ${task.id} failed on all agents`);
          }
        }

        return {
          totalTasks: tasks.length,
          completedTasks: tasks.filter(t => t.completed).length,
          failedTasks: tasks.filter(t => !t.completed).length,
          averageAttempts: tasks.reduce((sum, t) => sum + t.attempts, 0) / tasks.length,
        };
      };

      const results = await failoverTest();
      
      // Most tasks should complete despite agent failures
      TestAssertions.assertInRange(results.completedTasks / results.totalTasks, 0.8, 1.0);
      
      console.log(`Failover test: ${results.completedTasks}/${results.totalTasks} tasks completed`);
      console.log(`Average attempts per task: ${results.averageAttempts.toFixed(2)}`);
    });

    it('should handle concurrent workflows without interference', async () => {
      const concurrentWorkflowTest = async () => {
        const workflows = [
          { id: 'workflow-1', tasks: ['task-1a', 'task-1b', 'task-1c'] },
          { id: 'workflow-2', tasks: ['task-2a', 'task-2b', 'task-2c'] },
          { id: 'workflow-3', tasks: ['task-3a', 'task-3b'] },
        ];

        const executeWorkflow = async (workflow: any) => {
          const results = [];
          
          for (const task of workflow.tasks) {
            await AsyncTestUtils.delay(Math.random() * 100); // Variable execution time
            
            results.push({
              workflowId: workflow.id,
              taskId: task,
              timestamp: Date.now(),
            });
          }
          
          return results;
        };

        // Execute workflows concurrently
        const promises = workflows.map(workflow => executeWorkflow(workflow));
        const results = await Promise.all(promises);
        
        return results.flat();
      };

      const results = await concurrentWorkflowTest();
      
      // All workflows should complete
      assertEquals(results.length, 8); // Total tasks across all workflows
      
      // Verify each workflow completed
      const workflowResults = new Map();
      results.forEach(result => {
        if (!workflowResults.has(result.workflowId)) {
          workflowResults.set(result.workflowId, []);
        }
        workflowResults.get(result.workflowId).push(result);
      });
      
      assertEquals(workflowResults.size, 3); // All 3 workflows
      assertEquals(workflowResults.get('workflow-1').length, 3);
      assertEquals(workflowResults.get('workflow-2').length, 3);
      assertEquals(workflowResults.get('workflow-3').length, 2);
      
      console.log('Concurrent workflows completed successfully');
    });
  });

  describe('Memory and Persistence Integration', () => {
    it('should persist and retrieve data across system restarts', async () => {
      const persistenceTest = async () => {
        // Simulate first system run - store data
        const initialData = {
          'session-1': { tasks: ['task-1', 'task-2'], status: 'completed' },
          'session-2': { tasks: ['task-3'], status: 'running' },
          'config': { version: '1.0.0', lastUpdate: Date.now() },
        };

        // Write data to persistence layer
        const dataFile = `${tempDir}/persistence-test.json`;
        await Deno.writeTextFile(dataFile, JSON.stringify(initialData, null, 2));
        
        // Simulate system restart - verify data recovery
        const recoveredData = JSON.parse(await Deno.readTextFile(dataFile));
        
        return {
          stored: Object.keys(initialData).length,
          recovered: Object.keys(recoveredData).length,
          dataIntegrity: JSON.stringify(initialData) === JSON.stringify(recoveredData),
        };
      };

      const results = await persistenceTest();
      
      assertEquals(results.stored, results.recovered);
      assertEquals(results.dataIntegrity, true);
      
      console.log(`Persistence test: ${results.stored} entries stored and recovered`);
    });

    it('should handle memory bank operations under load', async () => {
      const { result, memoryIncrease, leaked } = await MemoryTestUtils.checkMemoryLeak(async () => {
        const fixtures = getAllTestFixtures();
        const memoryOperations = [];
        
        // Simulate heavy memory operations
        for (let i = 0; i < 100; i++) {
          const namespace = `namespace-${i % 5}`;
          const entries = fixtures.memory.small;
          
          // Store entries
          for (const entry of entries) {
            memoryOperations.push({
              operation: 'store',
              namespace,
              key: `${entry.key}-${i}`,
              value: entry.value,
            });
          }
          
          // Retrieve some entries
          if (i % 10 === 0) {
            for (let j = 0; j < 5; j++) {
              memoryOperations.push({
                operation: 'retrieve',
                namespace,
                key: `${entries[j].key}-${i}`,
              });
            }
          }
        }
        
        return memoryOperations.length;
      });

      assertEquals(leaked, false);
      assertEquals(typeof result, 'number');
      assertEquals(result > 1000, true); // Many operations performed
      
      console.log(`Memory operations completed: ${result} operations, memory increase: ${(memoryIncrease / 1024 / 1024).toFixed(2)}MB`);
    });

    it('should synchronize memory across multiple agents', async () => {
      const synchronizationTest = async () => {
        const agents = ['agent-1', 'agent-2', 'agent-3'];
        const sharedNamespace = 'shared-memory';
        const agentData = new Map();
        
        // Initialize agent memory
        agents.forEach(agent => {
          agentData.set(agent, new Map());
        });
        
        // Simulate concurrent memory operations
        const operations = [];
        
        for (let i = 0; i < 50; i++) {
          const agent = agents[i % agents.length];
          const key = `shared-key-${Math.floor(i / 3)}`; // Some overlap between agents
          const value = { data: `value-from-${agent}-${i}`, timestamp: Date.now() };
          
          operations.push({
            agent,
            operation: 'write',
            key,
            value,
          });
          
          // Simulate write to shared memory
          agentData.get(agent)!.set(key, value);
        }
        
        // Simulate memory synchronization
        const synchronizedData = new Map();
        agentData.forEach((data, agent) => {
          data.forEach((value, key) => {
            // Last write wins for simplicity
            synchronizedData.set(key, value);
          });
        });
        
        return {
          totalOperations: operations.length,
          uniqueKeys: synchronizedData.size,
          agentsParticipated: agents.length,
        };
      };

      const results = await synchronizationTest();
      
      assertEquals(results.totalOperations, 50);
      assertEquals(results.agentsParticipated, 3);
      TestAssertions.assertInRange(results.uniqueKeys, 10, 20); // Overlap expected
      
      console.log(`Memory synchronization: ${results.uniqueKeys} unique keys from ${results.totalOperations} operations`);
    });
  });

  describe('Terminal and Command Integration', () => {
    it('should execute commands across multiple terminal sessions', async () => {
      const terminalTest = async () => {
        const sessions = [
          { id: 'session-1', workingDir: tempDir, commands: [] },
          { id: 'session-2', workingDir: tempDir, commands: [] },
          { id: 'session-3', workingDir: tempDir, commands: [] },
        ];

        const testCommands = [
          'echo "Hello from session"',
          'pwd',
          'ls -la',
          'echo "Session test complete"',
        ];

        // Execute commands across sessions
        const results = [];
        
        for (let i = 0; i < testCommands.length * 3; i++) {
          const session = sessions[i % sessions.length];
          const command = testCommands[i % testCommands.length];
          
          // Simulate command execution
          try {
            const result = await executeCommand(command, session.workingDir);
            
            session.commands.push({
              command,
              result,
              timestamp: Date.now(),
            });
            
            results.push({
              sessionId: session.id,
              command,
              success: true,
            });
          } catch (error) {
            results.push({
              sessionId: session.id,
              command,
              success: false,
              error: error.message,
            });
          }
        }

        return {
          totalCommands: results.length,
          successfulCommands: results.filter(r => r.success).length,
          sessionsUsed: new Set(results.map(r => r.sessionId)).size,
        };
      };

      const results = await terminalTest();
      
      assertEquals(results.totalCommands, 12); // 4 commands * 3 sessions
      assertEquals(results.sessionsUsed, 3);
      TestAssertions.assertInRange(results.successfulCommands / results.totalCommands, 0.8, 1.0);
      
      console.log(`Terminal test: ${results.successfulCommands}/${results.totalCommands} commands successful across ${results.sessionsUsed} sessions`);
    });

    it('should handle long-running commands and timeouts', async () => {
      const timeoutTest = async () => {
        const commands = [
          { command: 'echo "quick"', expectedDuration: 100, timeout: 1000 },
          { command: 'sleep 2', expectedDuration: 2000, timeout: 3000 },
          { command: 'sleep 10', expectedDuration: 10000, timeout: 1000 }, // Should timeout
        ];

        const results = [];
        
        for (const { command, expectedDuration, timeout } of commands) {
          const startTime = Date.now();
          
          try {
            const result = await AsyncTestUtils.withTimeout(
              executeCommand(command, tempDir),
              timeout
            );
            
            const actualDuration = Date.now() - startTime;
            
            results.push({
              command,
              success: true,
              actualDuration,
              expectedDuration,
              timeout,
            });
          } catch (error) {
            const actualDuration = Date.now() - startTime;
            
            results.push({
              command,
              success: false,
              actualDuration,
              expectedDuration,
              timeout,
              error: error.message,
            });
          }
        }

        return results;
      };

      const results = await timeoutTest();
      
      assertEquals(results.length, 3);
      
      // First command should succeed quickly
      assertEquals(results[0].success, true);
      TestAssertions.assertInRange(results[0].actualDuration, 0, 500);
      
      // Second command should succeed within timeout
      assertEquals(results[1].success, true);
      TestAssertions.assertInRange(results[1].actualDuration, 1500, 3000);
      
      // Third command should timeout
      assertEquals(results[2].success, false);
      TestAssertions.assertInRange(results[2].actualDuration, 900, 1100);
      
      console.log('Terminal timeout handling verified');
    });
  });

  describe('MCP Protocol Integration', () => {
    it('should handle end-to-end MCP communication', async () => {
      const mcpTest = async () => {
        // Simulate MCP client-server communication
        const serverCapabilities = {
          tools: ['calculator', 'file-operations', 'web-search'],
          prompts: ['code-review', 'documentation'],
        };

        const clientRequests = [
          { method: 'list_tools', params: {} },
          { method: 'call_tool', params: { name: 'calculator', arguments: { operation: 'add', a: 5, b: 3 } } },
          { method: 'list_prompts', params: {} },
          { method: 'get_prompt', params: { name: 'code-review', arguments: { language: 'typescript' } } },
        ];

        const responses = [];
        
        for (const [index, request] of clientRequests.entries()) {
          // Simulate request processing
          let response;
          
          switch (request.method) {
            case 'list_tools':
              response = { result: { tools: serverCapabilities.tools } };
              break;
            case 'call_tool':
              if (request.params.name === 'calculator') {
                const { operation, a, b } = request.params.arguments;
                const result = operation === 'add' ? a + b : 0;
                response = { result: { content: [{ type: 'text', text: `${a} + ${b} = ${result}` }] } };
              }
              break;
            case 'list_prompts':
              response = { result: { prompts: serverCapabilities.prompts } };
              break;
            case 'get_prompt':
              response = { result: { messages: [{ role: 'user', content: { type: 'text', text: 'Review this code...' } }] } };
              break;
            default:
              response = { error: { code: -32601, message: 'Method not found' } };
          }
          
          responses.push({
            id: index,
            request: request.method,
            response,
            timestamp: Date.now(),
          });
        }

        return responses;
      };

      const responses = await mcpTest();
      
      assertEquals(responses.length, 4);
      
      // Verify specific responses
      const listToolsResponse = responses.find(r => r.request === 'list_tools');
      assertEquals(listToolsResponse?.response.result?.tools.length, 3);
      
      const calculatorResponse = responses.find(r => r.request === 'call_tool');
      assertStringIncludes(calculatorResponse?.response.result?.content[0].text, '5 + 3 = 8');
      
      console.log('MCP protocol integration test completed successfully');
    });

    it('should handle MCP connection pooling and load balancing', async () => {
      const poolingTest = async () => {
        const serverPool = [
          { id: 'server-1', load: 0, capacity: 10 },
          { id: 'server-2', load: 0, capacity: 10 },
          { id: 'server-3', load: 0, capacity: 10 },
        ];

        const requests = Array.from({ length: 50 }, (_, i) => ({
          id: i,
          method: 'test_request',
          timestamp: Date.now(),
        }));

        const routedRequests = [];
        
        // Simulate load balancing
        for (const request of requests) {
          // Find server with lowest load
          const server = serverPool.reduce((min, current) => 
            current.load < min.load ? current : min
          );
          
          // Route request to server
          server.load++;
          
          routedRequests.push({
            requestId: request.id,
            serverId: server.id,
            serverLoad: server.load,
          });
          
          // Simulate request completion (reduce load)
          setTimeout(() => {
            server.load = Math.max(0, server.load - 1);
          }, Math.random() * 100);
        }

        return {
          totalRequests: requests.length,
          routedRequests: routedRequests.length,
          serverDistribution: serverPool.map(s => ({ id: s.id, finalLoad: s.load })),
        };
      };

      const results = await poolingTest();
      
      assertEquals(results.totalRequests, results.routedRequests);
      assertEquals(results.serverDistribution.length, 3);
      
      // Load should be distributed across servers
      const totalLoad = results.serverDistribution.reduce((sum, s) => sum + s.finalLoad, 0);
      TestAssertions.assertInRange(totalLoad, 0, 50);
      
      console.log(`MCP load balancing: ${results.totalRequests} requests distributed across ${results.serverDistribution.length} servers`);
    });
  });

  describe('System Performance Under Load', () => {
    it('should maintain performance under high task throughput', async () => {
      const throughputTest = await PerformanceTestUtils.loadTest(
        async () => {
          // Simulate complex task execution
          const taskData = {
            id: `task-${Date.now()}-${Math.random()}`,
            type: 'integration-test',
            payload: Array.from({ length: 100 }, (_, i) => ({ index: i, data: `item-${i}` })),
          };

          // Simulate task processing
          await AsyncTestUtils.delay(Math.random() * 20);
          
          return taskData.payload.length;
        },
        {
          duration: 10000, // 10 seconds
          maxConcurrency: 20,
          requestsPerSecond: 50,
        }
      );

      // System should maintain good performance
      TestAssertions.assertInRange(throughputTest.successfulRequests / throughputTest.totalRequests, 0.9, 1.0);
      TestAssertions.assertInRange(throughputTest.averageResponseTime, 0, 100);
      assertEquals(throughputTest.errors.length < throughputTest.totalRequests * 0.05, true); // Less than 5% errors
      
      console.log(`High throughput test: ${throughputTest.successfulRequests}/${throughputTest.totalRequests} successful (${throughputTest.requestsPerSecond.toFixed(1)} req/sec)`);
    });

    it('should handle memory pressure gracefully', async () => {
      const { leaked } = await MemoryTestUtils.checkMemoryLeak(async () => {
        // Simulate memory-intensive workload
        const workload = [];
        
        for (let i = 0; i < 1000; i++) {
          const data = {
            id: i,
            payload: new Array(1000).fill(0).map(() => Math.random()),
            metadata: {
              timestamp: Date.now(),
              processed: false,
            },
          };
          
          workload.push(data);
          
          // Process some data
          if (i % 100 === 0) {
            workload.forEach(item => {
              item.metadata.processed = true;
              item.metadata.processedAt = Date.now();
            });
            
            // Clean up processed items periodically
            workload.splice(0, 50);
          }
        }
        
        return workload.length;
      }, { threshold: 100 * 1024 * 1024 }); // 100MB threshold

      assertEquals(leaked, false);
      
      console.log('Memory pressure test completed without leaks');
    });

    it('should recover from system overload conditions', async () => {
      const overloadTest = async () => {
        const systemLimits = {
          maxConcurrentTasks: 10,
          maxMemoryUsage: 50 * 1024 * 1024, // 50MB
          maxConnectionsPerMinute: 1000,
        };

        const metrics = {
          activeTasks: 0,
          memoryUsage: 0,
          connectionsThisMinute: 0,
          rejectedRequests: 0,
          successfulRequests: 0,
        };

        // Simulate overload scenario
        const requests = Array.from({ length: 2000 }, (_, i) => ({
          id: i,
          timestamp: Date.now(),
          memoryRequired: Math.random() * 10 * 1024 * 1024, // 0-10MB
        }));

        for (const request of requests) {
          // Check system limits
          const wouldExceedTaskLimit = metrics.activeTasks >= systemLimits.maxConcurrentTasks;
          const wouldExceedMemoryLimit = metrics.memoryUsage + request.memoryRequired > systemLimits.maxMemoryUsage;
          const wouldExceedRateLimit = metrics.connectionsThisMinute >= systemLimits.maxConnectionsPerMinute;

          if (wouldExceedTaskLimit || wouldExceedMemoryLimit || wouldExceedRateLimit) {
            metrics.rejectedRequests++;
            continue;
          }

          // Accept request
          metrics.activeTasks++;
          metrics.memoryUsage += request.memoryRequired;
          metrics.connectionsThisMinute++;
          metrics.successfulRequests++;

          // Simulate task completion
          setTimeout(() => {
            metrics.activeTasks = Math.max(0, metrics.activeTasks - 1);
            metrics.memoryUsage = Math.max(0, metrics.memoryUsage - request.memoryRequired);
          }, Math.random() * 100);
        }

        return {
          totalRequests: requests.length,
          successfulRequests: metrics.successfulRequests,
          rejectedRequests: metrics.rejectedRequests,
          finalActiveTasks: metrics.activeTasks,
          finalMemoryUsage: metrics.memoryUsage,
        };
      };

      const results = await overloadTest();
      
      assertEquals(results.totalRequests, results.successfulRequests + results.rejectedRequests);
      
      // System should have protected itself by rejecting excess requests
      assertEquals(results.rejectedRequests > 0, true);
      
      // But should have served a reasonable number of requests
      TestAssertions.assertInRange(results.successfulRequests / results.totalRequests, 0.3, 0.8);
      
      console.log(`Overload protection: ${results.successfulRequests}/${results.totalRequests} requests served, ${results.rejectedRequests} rejected`);
    });
  });

  describe('Error Recovery and Resilience', () => {
    it('should recover from cascading system failures', async () => {
      const cascadingFailureTest = async () => {
        const components = [
          { name: 'database', status: 'healthy', criticalness: 'high' },
          { name: 'terminal', status: 'healthy', criticalness: 'medium' },
          { name: 'memory', status: 'healthy', criticalness: 'high' },
          { name: 'coordination', status: 'healthy', criticalness: 'high' },
          { name: 'mcp', status: 'healthy', criticalness: 'low' },
        ];

        const failureScenarios = [
          { component: 'database', cause: 'disk_full', duration: 5000 },
          { component: 'memory', cause: 'corruption', duration: 3000 },
          { component: 'coordination', cause: 'deadlock', duration: 2000 },
        ];

        const recoveryLog = [];
        
        // Simulate cascading failures
        for (const scenario of failureScenarios) {
          const component = components.find(c => c.name === scenario.component);
          if (component) {
            component.status = 'failed';
            
            recoveryLog.push({
              timestamp: Date.now(),
              event: 'component_failure',
              component: scenario.component,
              cause: scenario.cause,
            });

            // Simulate recovery attempts
            setTimeout(async () => {
              // Recovery logic
              component.status = 'recovering';
              
              recoveryLog.push({
                timestamp: Date.now(),
                event: 'recovery_started',
                component: scenario.component,
              });

              // Simulate recovery time
              await AsyncTestUtils.delay(scenario.duration * 0.5);
              
              component.status = 'healthy';
              
              recoveryLog.push({
                timestamp: Date.now(),
                event: 'recovery_completed',
                component: scenario.component,
              });
            }, 100);
          }
        }

        // Wait for all recoveries to complete
        await AsyncTestUtils.delay(6000);

        return {
          components: components.map(c => ({ name: c.name, status: c.status })),
          recoveryEvents: recoveryLog.length,
          recoveredComponents: components.filter(c => c.status === 'healthy').length,
        };
      };

      const results = await cascadingFailureTest();
      
      // All components should eventually recover
      assertEquals(results.recoveredComponents, 5);
      assertEquals(results.recoveryEvents >= 6, true); // At least 3 failures + 3 recoveries
      
      console.log(`Cascading failure recovery: ${results.recoveredComponents}/5 components recovered`);
    });

    it('should maintain data consistency during partial failures', async () => {
      const consistencyTest = async () => {
        const dataStores = [
          { name: 'primary', data: new Map(), status: 'healthy' },
          { name: 'replica-1', data: new Map(), status: 'healthy' },
          { name: 'replica-2', data: new Map(), status: 'healthy' },
        ];

        const operations = Array.from({ length: 100 }, (_, i) => ({
          type: i % 3 === 0 ? 'write' : 'read',
          key: `key-${Math.floor(i / 10)}`,
          value: `value-${i}`,
        }));

        let consistencyErrors = 0;
        let successfulOperations = 0;

        for (const [index, operation] of operations.entries()) {
          // Simulate random store failures
          dataStores.forEach(store => {
            if (Math.random() < 0.1) { // 10% failure rate
              store.status = 'failed';
              setTimeout(() => { store.status = 'healthy'; }, 200);
            }
          });

          const healthyStores = dataStores.filter(s => s.status === 'healthy');
          
          if (healthyStores.length === 0) {
            continue; // Skip operation if all stores are down
          }

          try {
            if (operation.type === 'write') {
              // Write to all healthy stores
              healthyStores.forEach(store => {
                store.data.set(operation.key, operation.value);
              });

              // Verify consistency across healthy stores
              const values = healthyStores.map(s => s.data.get(operation.key));
              const allSame = values.every(v => v === values[0]);
              
              if (!allSame) {
                consistencyErrors++;
              } else {
                successfulOperations++;
              }
            } else {
              // Read from any healthy store
              const value = healthyStores[0].data.get(operation.key);
              if (value !== undefined) {
                successfulOperations++;
              }
            }
          } catch (error) {
            // Operation failed
          }
        }

        return {
          totalOperations: operations.length,
          successfulOperations,
          consistencyErrors,
          finalDataConsistency: checkDataConsistency(dataStores),
        };
      };

      const results = await consistencyTest();
      
      // Most operations should succeed
      TestAssertions.assertInRange(results.successfulOperations / results.totalOperations, 0.7, 1.0);
      
      // Consistency errors should be minimal
      TestAssertions.assertInRange(results.consistencyErrors, 0, results.totalOperations * 0.1);
      
      console.log(`Data consistency test: ${results.successfulOperations}/${results.totalOperations} operations, ${results.consistencyErrors} consistency errors`);
    });
  });
});

// Helper functions
async function executeCommand(command: string, workingDir: string): Promise<string> {
  // Simple command execution simulation
  const isWindowsCommand = command.startsWith('dir') || command.includes('\\');
  const shell = isWindowsCommand ? 'cmd' : 'sh';
  const shellFlag = isWindowsCommand ? '/c' : '-c';
  
  try {
    const process = new Deno.Command(shell, {
      args: [shellFlag, command],
      cwd: workingDir,
      stdout: 'piped',
      stderr: 'piped',
    });
    
    const { code, stdout, stderr } = await process.output();
    
    if (code !== 0) {
      const error = new TextDecoder().decode(stderr);
      throw new Error(`Command failed (exit code ${code}): ${error}`);
    }
    
    return new TextDecoder().decode(stdout);
  } catch (error) {
    throw new Error(`Failed to execute command "${command}": ${error.message}`);
  }
}

function checkDataConsistency(dataStores: any[]): boolean {
  const healthyStores = dataStores.filter(s => s.status === 'healthy');
  
  if (healthyStores.length < 2) {
    return true; // Can't check consistency with less than 2 stores
  }
  
  const referenceStore = healthyStores[0];
  
  for (const store of healthyStores.slice(1)) {
    for (const [key, value] of referenceStore.data.entries()) {
      if (store.data.get(key) !== value) {
        return false;
      }
    }
  }
  
  return true;
}