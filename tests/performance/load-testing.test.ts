/**
 * Comprehensive performance and load testing suite
 */

import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { assertEquals, assertExists } from "@std/assert";

import { 
  PerformanceTestUtils, 
  MemoryTestUtils,
  TestAssertions,
  AsyncTestUtils,
  TestDataGenerator,
  FileSystemTestUtils 
} from '../utils/test-utils.ts';
import { 
  generatePerformanceTestData,
  generateMemoryEntries,
  generateCoordinationTasks,
  getAllTestFixtures 
} from '../fixtures/generators.ts';
import { setupTestEnv, cleanupTestEnv, TEST_CONFIG } from '../test.config.ts';

describe('Performance and Load Testing Suite', () => {
  let tempDir: string;

  beforeEach(async () => {
    setupTestEnv();
    tempDir = await FileSystemTestUtils.createTempDir('perf-test-');
  });

  afterEach(async () => {
    await FileSystemTestUtils.cleanup([tempDir]);
    await cleanupTestEnv();
  });

  describe('System-wide Performance Tests', () => {
    it('should handle concurrent system initialization', async () => {
      const { stats } = await PerformanceTestUtils.benchmark(
        async () => {
          // Simulate system initialization
          await AsyncTestUtils.delay(Math.random() * 10);
          return 'initialized';
        },
        { iterations: 20, concurrency: 5 }
      );

      TestAssertions.assertInRange(stats.mean, 0, 50);
      TestAssertions.assertInRange(stats.p95, 0, 100);
      
      console.log(`System initialization: mean=${stats.mean.toFixed(2)}ms, p95=${stats.p95.toFixed(2)}ms`);
    });

    it('should maintain performance under varying load', async () => {
      const loadLevels = [1, 5, 10, 20, 50];
      const results = [];

      for (const concurrency of loadLevels) {
        const { stats } = await PerformanceTestUtils.benchmark(
          async () => {
            // Simulate typical operation
            const data = TestDataGenerator.randomString(1000);
            await AsyncTestUtils.delay(Math.random() * 5);
            return data.length;
          },
          { iterations: 50, concurrency }
        );

        results.push({
          concurrency,
          mean: stats.mean,
          p95: stats.p95,
          p99: stats.p99,
        });

        console.log(`Concurrency ${concurrency}: mean=${stats.mean.toFixed(2)}ms, p95=${stats.p95.toFixed(2)}ms`);
      }

      // Performance should scale reasonably with load
      results.forEach(result => {
        TestAssertions.assertInRange(result.mean, 0, 100);
        TestAssertions.assertInRange(result.p95, 0, 200);
      });

      // Check that performance doesn't degrade exponentially
      const firstResult = results[0];
      const lastResult = results[results.length - 1];
      const degradationRatio = lastResult.mean / firstResult.mean;
      
      TestAssertions.assertInRange(degradationRatio, 1, 10); // Should not be more than 10x slower
    });

    it('should handle stress testing scenarios', async () => {
      const stressTestResults = await PerformanceTestUtils.loadTest(
        async () => {
          // Simulate CPU-intensive operation
          const data = TestDataGenerator.largeDataset(100);
          const processed = data.map(item => ({
            ...item,
            processed: true,
            timestamp: Date.now(),
          }));
          
          return processed.length;
        },
        {
          duration: TEST_CONFIG.performance.timeout_stress_duration,
          maxConcurrency: 30,
          requestsPerSecond: 100,
        }
      );

      // System should maintain stability under stress
      TestAssertions.assertInRange(
        results.successfulRequests / results.totalRequests, 
        0.8, 
        1.0
      );
      
      TestAssertions.assertInRange(results.averageResponseTime, 0, 1000);
      assertEquals(results.errors.length < results.totalRequests * 0.1, true); // Less than 10% errors

      console.log(`Stress test results:
        - Total requests: ${results.totalRequests}
        - Successful: ${results.successfulRequests}
        - Failed: ${results.failedRequests}
        - Average response time: ${results.averageResponseTime.toFixed(2)}ms
        - Requests/sec: ${results.requestsPerSecond.toFixed(2)}
        - Error rate: ${(results.errors.length / results.totalRequests * 100).toFixed(2)}%`);
    });

    it('should handle endurance testing', async () => {
      const enduranceTest = async () => {
        const iterations = 1000;
        const memorySnapshots = [];
        
        for (let i = 0; i < iterations; i++) {
          // Simulate long-running operation
          const data = TestDataGenerator.randomObject({
            id: () => TestDataGenerator.randomString(10),
            value: () => TestDataGenerator.randomNumber(1, 1000),
            metadata: () => ({
              timestamp: Date.now(),
              iteration: i,
            }),
          });

          // Process data
          await AsyncTestUtils.delay(1);
          
          // Take memory snapshot every 100 iterations
          if (i % 100 === 0) {
            const memInfo = Deno.memoryUsage();
            memorySnapshots.push({
              iteration: i,
              heapUsed: memInfo.heapUsed,
              external: memInfo.external,
            });
          }
        }

        return memorySnapshots;
      };

      const { result: snapshots, memoryIncrease, leaked } = await MemoryTestUtils.checkMemoryLeak(
        enduranceTest,
        { threshold: 50 * 1024 * 1024 } // 50MB threshold
      );

      // Memory usage should be stable over time
      assertEquals(leaked, false);
      
      // Analyze memory trend
      const firstSnapshot = snapshots[0];
      const lastSnapshot = snapshots[snapshots.length - 1];
      const memoryGrowth = lastSnapshot.heapUsed - firstSnapshot.heapUsed;
      
      console.log(`Endurance test completed:
        - Iterations: 1000
        - Initial memory: ${(firstSnapshot.heapUsed / 1024 / 1024).toFixed(2)}MB
        - Final memory: ${(lastSnapshot.heapUsed / 1024 / 1024).toFixed(2)}MB
        - Memory growth: ${(memoryGrowth / 1024 / 1024).toFixed(2)}MB
        - Memory leak detected: ${leaked}`);

      TestAssertions.assertInRange(memoryGrowth, -10 * 1024 * 1024, 30 * 1024 * 1024); // Within 30MB growth
    });
  });

  describe('Memory Management Performance', () => {
    it('should handle large memory operations efficiently', async () => {
      const largeDatasets = [
        TestDataGenerator.largeDataset(1000),
        TestDataGenerator.largeDataset(5000),
        TestDataGenerator.largeDataset(10000),
      ];

      for (const [index, dataset] of largeDatasels.entries()) {
        const { stats } = await PerformanceTestUtils.benchmark(
          async () => {
            // Simulate memory-intensive operations
            const processed = dataset.map(item => ({
              ...item,
              processed: true,
              hash: item.id + item.name + item.value,
            }));

            const filtered = processed.filter(item => item.value > 500);
            const sorted = filtered.sort((a, b) => a.value - b.value);
            
            return sorted.length;
          },
          { iterations: 5 }
        );

        console.log(`Large dataset ${index + 1} (${dataset.length} items): ${stats.mean.toFixed(2)}ms average`);
        
        // Performance should scale sub-linearly with data size
        TestAssertions.assertInRange(stats.mean, 0, dataset.length * 0.1);
      }
    });

    it('should handle memory pressure gracefully', async () => {
      const memoryPressureTest = async () => {
        const chunks = [];
        
        try {
          // Gradually increase memory usage
          for (let i = 0; i < 100; i++) {
            const chunk = new Array(10000).fill(0).map(() => ({
              id: TestDataGenerator.randomString(100),
              data: TestDataGenerator.randomString(1000),
              timestamp: Date.now(),
            }));
            
            chunks.push(chunk);
            
            // Process chunk
            chunk.forEach(item => {
              item.processed = true;
              item.hash = item.id + item.data.slice(0, 10);
            });

            // Periodic cleanup
            if (i % 10 === 0) {
              chunks.splice(0, 5); // Remove oldest chunks
              await MemoryTestUtils.forceGC();
            }

            await AsyncTestUtils.delay(10);
          }
          
          return chunks.length;
        } catch (error) {
          // Handle out of memory gracefully
          console.log(`Memory pressure test stopped at chunk ${chunks.length}: ${error.message}`);
          return chunks.length;
        }
      };

      const { result: finalChunks, memoryIncrease } = await MemoryTestUtils.checkMemoryLeak(
        memoryPressureTest
      );

      // Should handle pressure without crashing
      assertExists(finalChunks);
      assertEquals(typeof finalChunks, 'number');
      
      console.log(`Memory pressure test completed with ${finalChunks} chunks`);
      console.log(`Memory increase: ${(memoryIncrease / 1024 / 1024).toFixed(2)}MB`);
    });

    it('should handle concurrent memory operations', async () => {
      const concurrentMemoryTest = async () => {
        const operations = Array.from({ length: 20 }, (_, i) => 
          MemoryTestUtils.monitorMemory(
            async () => {
              // Each operation works with its own data
              const localData = TestDataGenerator.largeDataset(1000);
              
              // Simulate processing
              const processed = localData.map(item => ({
                ...item,
                threadId: i,
                processed: true,
              }));

              // Simulate aggregation
              const summary = processed.reduce((acc, item) => {
                acc.count++;
                acc.totalValue += item.value;
                return acc;
              }, { count: 0, totalValue: 0 });

              return summary;
            },
            { sampleInterval: 50, maxSamples: 20 }
          )
        );

        const results = await Promise.all(operations);
        
        return results.map(r => ({
          result: r.result,
          peakMemory: Math.max(...r.memoryStats.map(s => s.heapUsed)),
          memoryGrowth: r.memoryStats[r.memoryStats.length - 1].heapUsed - r.memoryStats[0].heapUsed,
        }));
      };

      const analysisResults = await concurrentMemoryTest();
      
      // All operations should complete successfully
      assertEquals(analysisResults.length, 20);
      
      analysisResults.forEach((result, i) => {
        assertExists(result.result);
        assertEquals(result.result.count, 1000);
        
        console.log(`Operation ${i}: peak=${(result.peakMemory / 1024 / 1024).toFixed(2)}MB, growth=${(result.memoryGrowth / 1024 / 1024).toFixed(2)}MB`);
      });

      // Check for memory stability across operations
      const peakMemories = analysisResults.map(r => r.peakMemory);
      const avgPeak = peakMemories.reduce((sum, peak) => sum + peak, 0) / peakMemories.length;
      const maxVariation = Math.max(...peakMemories) - Math.min(...peakMemories);
      
      console.log(`Memory stability: avg peak=${(avgPeak / 1024 / 1024).toFixed(2)}MB, variation=${(maxVariation / 1024 / 1024).toFixed(2)}MB`);
      
      // Memory usage should be relatively stable across operations
      TestAssertions.assertInRange(maxVariation, 0, avgPeak * 0.5); // Within 50% variation
    });
  });

  describe('Database and Storage Performance', () => {
    it('should handle high-volume data operations', async () => {
      const entries = generateMemoryEntries(TEST_CONFIG.fixtures.large_memory_entries);
      
      // Test write performance
      const writeStats = await PerformanceTestUtils.benchmark(
        async () => {
          const entry = entries[Math.floor(Math.random() * entries.length)];
          
          // Simulate database write
          const serialized = JSON.stringify(entry);
          const filename = `${tempDir}/${entry.key}.json`;
          await Deno.writeTextFile(filename, serialized);
          
          return entry.key;
        },
        { iterations: 1000, concurrency: 10 }
      );

      // Test read performance
      const readStats = await PerformanceTestUtils.benchmark(
        async () => {
          const entry = entries[Math.floor(Math.random() * entries.length)];
          const filename = `${tempDir}/${entry.key}.json`;
          
          try {
            const content = await Deno.readTextFile(filename);
            const parsed = JSON.parse(content);
            return parsed.key;
          } catch {
            return null; // File might not exist yet
          }
        },
        { iterations: 500, concurrency: 5 }
      );

      console.log(`Storage performance:
        - Write: mean=${writeStats.mean.toFixed(2)}ms, p95=${writeStats.p95.toFixed(2)}ms
        - Read: mean=${readStats.mean.toFixed(2)}ms, p95=${readStats.p95.toFixed(2)}ms`);

      // Storage operations should be fast
      TestAssertions.assertInRange(writeStats.mean, 0, 50);
      TestAssertions.assertInRange(readStats.mean, 0, 20);
    });

    it('should handle batch operations efficiently', async () => {
      const batchSizes = [10, 50, 100, 500, 1000];
      const batchResults = [];

      for (const batchSize of batchSizes) {
        const batch = generateMemoryEntries(batchSize);
        
        const { stats } = await PerformanceTestUtils.benchmark(
          async () => {
            // Simulate batch write operation
            const batchData = batch.map(entry => ({
              key: entry.key,
              data: JSON.stringify(entry),
            }));

            // Write all files concurrently
            await Promise.all(
              batchData.map(async ({ key, data }) => {
                const filename = `${tempDir}/batch_${batchSize}_${key}.json`;
                await Deno.writeTextFile(filename, data);
              })
            );

            return batchSize;
          },
          { iterations: 3 }
        );

        batchResults.push({
          batchSize,
          totalTime: stats.mean,
          timePerItem: stats.mean / batchSize,
        });

        console.log(`Batch ${batchSize}: ${stats.mean.toFixed(2)}ms total, ${(stats.mean / batchSize).toFixed(2)}ms per item`);
      }

      // Batch operations should show economies of scale
      const smallBatch = batchResults[0];
      const largeBatch = batchResults[batchResults.length - 1];
      
      // Time per item should decrease with larger batches
      assertEquals(largeBatch.timePerItem < smallBatch.timePerItem, true);
    });

    it('should handle concurrent file operations', async () => {
      const concurrentOperations = Array.from({ length: 50 }, (_, i) => ({
        type: i % 3 === 0 ? 'write' : i % 3 === 1 ? 'read' : 'delete',
        id: `concurrent_${i}`,
        data: TestDataGenerator.randomObject({
          content: () => TestDataGenerator.randomString(1000),
          timestamp: () => Date.now(),
        }),
      }));

      const { stats } = await PerformanceTestUtils.benchmark(
        async () => {
          const promises = concurrentOperations.map(async (op) => {
            const filename = `${tempDir}/${op.id}.json`;
            
            try {
              switch (op.type) {
                case 'write':
                  await Deno.writeTextFile(filename, JSON.stringify(op.data));
                  return 'written';
                
                case 'read':
                  const content = await Deno.readTextFile(filename);
                  return JSON.parse(content);
                
                case 'delete':
                  await Deno.remove(filename);
                  return 'deleted';
                
                default:
                  return 'unknown';
              }
            } catch (error) {
              // Some operations may fail (e.g., reading non-existent files)
              return 'error';
            }
          });

          const results = await Promise.all(promises);
          const successful = results.filter(r => r !== 'error').length;
          
          return successful;
        },
        { iterations: 5 }
      );

      console.log(`Concurrent file operations: ${stats.mean.toFixed(2)}ms average`);
      
      // Should handle concurrent operations efficiently
      TestAssertions.assertInRange(stats.mean, 0, 1000);
    });
  });

  describe('Network and Communication Performance', () => {
    it('should handle high-frequency message processing', async () => {
      const messageProcessor = async (message: any) => {
        // Simulate message processing
        const processed = {
          ...message,
          processedAt: Date.now(),
          hash: message.id + message.type + message.timestamp,
        };
        
        await AsyncTestUtils.delay(Math.random() * 2);
        return processed;
      };

      const { stats } = await PerformanceTestUtils.benchmark(
        async () => {
          const message = {
            id: TestDataGenerator.randomString(10),
            type: 'test-message',
            timestamp: Date.now(),
            payload: TestDataGenerator.randomObject({
              data: () => TestDataGenerator.randomString(500),
              priority: () => TestDataGenerator.randomNumber(1, 5),
            }),
          };

          return messageProcessor(message);
        },
        { iterations: 1000, concurrency: 20 }
      );

      console.log(`Message processing: ${stats.mean.toFixed(2)}ms average, ${stats.p95.toFixed(2)}ms p95`);
      
      // Message processing should be fast
      TestAssertions.assertInRange(stats.mean, 0, 20);
      TestAssertions.assertInRange(stats.p95, 0, 50);
    });

    it('should handle connection pooling scenarios', async () => {
      // Simulate a connection pool
      const connectionPool = {
        connections: new Map<string, { id: string; busy: boolean; lastUsed: number }>(),
        maxConnections: 10,
        
        async getConnection(): Promise<string> {
          // Find available connection
          for (const [id, conn] of this.connections) {
            if (!conn.busy) {
              conn.busy = true;
              conn.lastUsed = Date.now();
              return id;
            }
          }
          
          // Create new connection if under limit
          if (this.connections.size < this.maxConnections) {
            const newId = `conn_${this.connections.size}`;
            this.connections.set(newId, {
              id: newId,
              busy: true,
              lastUsed: Date.now(),
            });
            return newId;
          }
          
          // Wait and retry
          await AsyncTestUtils.delay(10);
          return this.getConnection();
        },
        
        releaseConnection(id: string): void {
          const conn = this.connections.get(id);
          if (conn) {
            conn.busy = false;
          }
        },
      };

      const { stats } = await PerformanceTestUtils.benchmark(
        async () => {
          const connId = await connectionPool.getConnection();
          
          // Simulate work with connection
          await AsyncTestUtils.delay(Math.random() * 20);
          
          connectionPool.releaseConnection(connId);
          return connId;
        },
        { iterations: 200, concurrency: 15 }
      );

      console.log(`Connection pooling: ${stats.mean.toFixed(2)}ms average`);
      console.log(`Pool utilization: ${connectionPool.connections.size}/${connectionPool.maxConnections} connections`);
      
      // Connection operations should be efficient
      TestAssertions.assertInRange(stats.mean, 0, 50);
      assertEquals(connectionPool.connections.size <= connectionPool.maxConnections, true);
    });

    it('should handle event-driven communication patterns', async () => {
      // Simulate event-driven architecture
      const eventHub = new Map<string, Array<(data: any) => Promise<void>>>();
      
      const subscribe = (event: string, handler: (data: any) => Promise<void>) => {
        if (!eventHub.has(event)) {
          eventHub.set(event, []);
        }
        eventHub.get(event)!.push(handler);
      };
      
      const publish = async (event: string, data: any) => {
        const handlers = eventHub.get(event) || [];
        await Promise.all(handlers.map(handler => handler(data)));
      };

      // Set up event handlers
      const handlerStats = { callCounts: new Map<string, number>() };
      
      const events = ['user.created', 'user.updated', 'order.placed', 'payment.processed'];
      
      events.forEach(event => {
        handlerStats.callCounts.set(event, 0);
        
        subscribe(event, async (data) => {
          handlerStats.callCounts.set(event, handlerStats.callCounts.get(event)! + 1);
          await AsyncTestUtils.delay(Math.random() * 5);
        });
      });

      // Test event publishing performance
      const { stats } = await PerformanceTestUtils.benchmark(
        async () => {
          const event = events[Math.floor(Math.random() * events.length)];
          const data = {
            id: TestDataGenerator.randomString(10),
            timestamp: Date.now(),
            payload: TestDataGenerator.randomObject({
              userId: () => TestDataGenerator.randomString(8),
              action: () => event.split('.')[1],
            }),
          };

          await publish(event, data);
          return event;
        },
        { iterations: 500, concurrency: 10 }
      );

      console.log(`Event publishing: ${stats.mean.toFixed(2)}ms average`);
      
      // Event processing should be fast
      TestAssertions.assertInRange(stats.mean, 0, 20);
      
      // Verify all events were processed
      const totalEvents = Array.from(handlerStats.callCounts.values()).reduce((sum, count) => sum + count, 0);
      assertEquals(totalEvents, 500);
    });
  });

  describe('Resource Utilization and Scaling', () => {
    it('should measure CPU utilization patterns', async () => {
      const cpuIntensiveOperations = generatePerformanceTestData().cpuIntensiveOperations;
      
      const cpuResults = [];
      
      for (const [index, operation] of cpuIntensiveOperations.entries()) {
        const { stats } = await PerformanceTestUtils.benchmark(
          operation,
          { iterations: 10 }
        );

        cpuResults.push({
          operation: `CPU Operation ${index + 1}`,
          mean: stats.mean,
          stdDev: stats.stdDev,
          p95: stats.p95,
        });

        console.log(`CPU Operation ${index + 1}: ${stats.mean.toFixed(2)}ms ± ${stats.stdDev.toFixed(2)}ms`);
      }

      // CPU operations should complete within reasonable time
      cpuResults.forEach(result => {
        TestAssertions.assertInRange(result.mean, 0, 10000); // 10 seconds max
      });
    });

    it('should test horizontal scaling characteristics', async () => {
      const workerCounts = [1, 2, 4, 8];
      const scalingResults = [];

      for (const workerCount of workerCounts) {
        const workload = Array.from({ length: 100 }, (_, i) => ({
          id: i,
          data: TestDataGenerator.randomString(1000),
        }));

        const { stats } = await PerformanceTestUtils.benchmark(
          async () => {
            // Simulate distributed work across workers
            const workPerWorker = Math.ceil(workload.length / workerCount);
            const workerPromises = [];

            for (let w = 0; w < workerCount; w++) {
              const start = w * workPerWorker;
              const end = Math.min(start + workPerWorker, workload.length);
              const workerWork = workload.slice(start, end);

              workerPromises.push(
                Promise.resolve().then(async () => {
                  // Simulate worker processing
                  const results = [];
                  for (const item of workerWork) {
                    await AsyncTestUtils.delay(1); // Simulate work
                    results.push({ ...item, workerId: w, processed: true });
                  }
                  return results;
                })
              );
            }

            const results = await Promise.all(workerPromises);
            return results.flat().length;
          },
          { iterations: 5 }
        );

        const efficiency = 1 / workerCount;
        const actualEfficiency = scalingResults.length > 0 
          ? scalingResults[0].mean / stats.mean 
          : 1;

        scalingResults.push({
          workerCount,
          mean: stats.mean,
          efficiency: actualEfficiency,
          theoreticalEfficiency: efficiency,
        });

        console.log(`Workers: ${workerCount}, Time: ${stats.mean.toFixed(2)}ms, Efficiency: ${(actualEfficiency * 100).toFixed(1)}%`);
      }

      // Check scaling efficiency
      scalingResults.forEach((result, i) => {
        if (i > 0) {
          // Each doubling of workers should provide some speedup
          const previousResult = scalingResults[i - 1];
          const speedup = previousResult.mean / result.mean;
          
          // Should achieve at least 50% of theoretical speedup
          const expectedSpeedup = result.workerCount / previousResult.workerCount;
          TestAssertions.assertInRange(speedup, expectedSpeedup * 0.5, expectedSpeedup * 1.2);
        }
      });
    });

    it('should measure resource cleanup efficiency', async () => {
      const resourceTypes = ['memory', 'files', 'connections', 'handles'];
      const cleanupResults = [];

      for (const resourceType of resourceTypes) {
        const { stats } = await PerformanceTestUtils.benchmark(
          async () => {
            // Simulate resource creation and cleanup
            const resources = [];
            
            // Create resources
            for (let i = 0; i < 100; i++) {
              switch (resourceType) {
                case 'memory':
                  resources.push(new Array(1000).fill(i));
                  break;
                case 'files':
                  const filename = `${tempDir}/cleanup_${resourceType}_${i}.tmp`;
                  await Deno.writeTextFile(filename, `resource ${i}`);
                  resources.push(filename);
                  break;
                case 'connections':
                  resources.push({ id: i, connected: true, lastUsed: Date.now() });
                  break;
                case 'handles':
                  resources.push({ handle: i, active: true, references: 1 });
                  break;
              }
            }

            // Cleanup resources
            for (const resource of resources) {
              switch (resourceType) {
                case 'memory':
                  // Memory cleanup is automatic
                  break;
                case 'files':
                  try {
                    await Deno.remove(resource);
                  } catch {
                    // File might already be deleted
                  }
                  break;
                case 'connections':
                  resource.connected = false;
                  break;
                case 'handles':
                  resource.active = false;
                  resource.references = 0;
                  break;
              }
            }

            return resources.length;
          },
          { iterations: 10 }
        );

        cleanupResults.push({
          resourceType,
          mean: stats.mean,
          resourcesPerMs: 100 / stats.mean,
        });

        console.log(`${resourceType} cleanup: ${stats.mean.toFixed(2)}ms for 100 resources (${(100 / stats.mean).toFixed(1)} resources/ms)`);
      }

      // Cleanup should be efficient for all resource types
      cleanupResults.forEach(result => {
        TestAssertions.assertInRange(result.mean, 0, 1000); // Should cleanup within 1 second
        TestAssertions.assertInRange(result.resourcesPerMs, 0.1, 1000); // Reasonable throughput
      });
    });
  });

  describe('Performance Regression Detection', () => {
    it('should establish performance baselines', async () => {
      const baselineOperations = [
        {
          name: 'Simple string operations',
          operation: () => {
            const str = TestDataGenerator.randomString(1000);
            return str.toUpperCase().toLowerCase().split('').reverse().join('');
          },
        },
        {
          name: 'Array operations',
          operation: () => {
            const arr = TestDataGenerator.randomArray(() => TestDataGenerator.randomNumber(), 1000);
            return arr.filter(n => n > 50).map(n => n * 2).reduce((sum, n) => sum + n, 0);
          },
        },
        {
          name: 'Object operations',
          operation: () => {
            const obj = TestDataGenerator.randomObject({
              a: () => TestDataGenerator.randomNumber(),
              b: () => TestDataGenerator.randomString(10),
              c: () => TestDataGenerator.randomBoolean(),
            });
            return JSON.parse(JSON.stringify(obj));
          },
        },
      ];

      const baselines = [];

      for (const { name, operation } of baselineOperations) {
        const { stats } = await PerformanceTestUtils.benchmark(
          operation,
          { iterations: 1000, concurrency: 1 }
        );

        baselines.push({
          name,
          baseline: stats.mean,
          p95: stats.p95,
          stdDev: stats.stdDev,
        });

        console.log(`Baseline - ${name}: ${stats.mean.toFixed(3)}ms ± ${stats.stdDev.toFixed(3)}ms`);
      }

      // Store baselines for future regression testing
      const baselineReport = {
        timestamp: new Date().toISOString(),
        environment: {
          platform: Deno.build.os,
          arch: Deno.build.arch,
          denoVersion: Deno.version.deno,
        },
        baselines,
      };

      await Deno.writeTextFile(
        `${tempDir}/performance-baselines.json`,
        JSON.stringify(baselineReport, null, 2)
      );

      // Verify baselines are reasonable
      baselines.forEach(baseline => {
        TestAssertions.assertInRange(baseline.baseline, 0, 10); // Should be very fast
        assertEquals(baseline.stdDev < baseline.baseline, true); // Low variance
      });
    });

    it('should detect performance regressions', async () => {
      // Simulate baseline measurements
      const simulatedBaselines = [
        { name: 'Operation A', baseline: 5.0, tolerance: 0.5 },
        { name: 'Operation B', baseline: 10.0, tolerance: 1.0 },
        { name: 'Operation C', baseline: 2.0, tolerance: 0.2 },
      ];

      // Simulate current measurements (with some regression)
      const currentMeasurements = [
        { name: 'Operation A', current: 5.2 }, // Within tolerance
        { name: 'Operation B', current: 12.5 }, // Regression
        { name: 'Operation C', current: 1.8 }, // Improvement
      ];

      const regressionReport = [];

      for (const baseline of simulatedBaselines) {
        const current = currentMeasurements.find(m => m.name === baseline.name);
        if (current) {
          const change = current.current - baseline.baseline;
          const percentChange = (change / baseline.baseline) * 100;
          const isRegression = change > baseline.tolerance;
          const isImprovement = change < -baseline.tolerance;

          regressionReport.push({
            name: baseline.name,
            baseline: baseline.baseline,
            current: current.current,
            change,
            percentChange,
            isRegression,
            isImprovement,
            status: isRegression ? 'REGRESSION' : isImprovement ? 'IMPROVEMENT' : 'STABLE',
          });

          console.log(`${baseline.name}: ${baseline.baseline}ms → ${current.current}ms (${percentChange.toFixed(1)}%) - ${isRegression ? 'REGRESSION' : isImprovement ? 'IMPROVEMENT' : 'STABLE'}`);
        }
      }

      // Should detect regressions
      const regressions = regressionReport.filter(r => r.isRegression);
      const improvements = regressionReport.filter(r => r.isImprovement);
      
      assertEquals(regressions.length, 1); // Operation B
      assertEquals(improvements.length, 1); // Operation C
      
      // Report summary
      console.log(`Performance analysis: ${regressions.length} regressions, ${improvements.length} improvements`);
    });
  });
});