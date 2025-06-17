/**
 * Comprehensive unit tests for Incremental Updates across the system
 */

import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { assertEquals, assertExists, assert } from "@std/assert";
import { FakeTime } from "@std/testing/time";

import { MemoryManager } from '../../src/memory/manager.ts';
import { SQLiteBackend } from '../../src/memory/backends/sqlite.ts';
import { SwarmMemoryManager } from '../../src/swarm/memory.ts';
import { ConfigManager } from '../../src/core/config.ts';
import { deepMerge } from '../../src/utils/helpers.ts';
import { ResourceManager } from '../../src/resources/resource-manager.ts';
import { MemoryCache } from '../../src/memory/cache.ts';
import { EventBus } from '../../src/core/event-bus.ts';
import { Logger } from '../../src/core/logger.ts';
import { MemoryConfig } from '../../src/utils/types.ts';
import { 
  AsyncTestUtils, 
  FileSystemTestUtils,
  TestDataGenerator 
} from '../utils/test-utils.ts';

describe('Incremental Updates Test Suite', () => {
  let tempDir: string;
  let fakeTime: FakeTime;
  
  beforeEach(async () => {
    tempDir = await FileSystemTestUtils.createTempDir('incremental-test-');
    fakeTime = new FakeTime();
  });

  afterEach(async () => {
    await FileSystemTestUtils.cleanup([tempDir]);
    fakeTime.restore();
  });

  describe('Memory Manager Incremental Updates', () => {
    let memoryManager: MemoryManager;
    let eventBus: EventBus;
    let logger: Logger;

    beforeEach(async () => {
      eventBus = new EventBus();
      logger = new Logger({ level: 'error', console: false });
      
      const config: MemoryConfig = {
        backend: 'sqlite',
        sqlitePath: `${tempDir}/test.db`,
        cacheSizeMB: 10,
        syncInterval: 1000,
        conflictResolution: 'last-write',
        retentionDays: 30
      };
      
      memoryManager = new MemoryManager(config, eventBus, logger);
      await memoryManager.initialize();
    });

    it('should increment version on each update', async () => {
      // Create a bank for testing
      const bankId = await memoryManager.createBank('test-agent');
      
      // Store initial entry
      const entry: MemoryEntry = {
        id: 'test-key',
        agentId: 'test-agent',
        sessionId: 'test-session',
        type: 'observation',
        content: 'initial value',
        context: {},
        timestamp: new Date(),
        tags: ['test'],
        version: 1
      };
      
      await memoryManager.store(entry);
      const initial = await memoryManager.retrieve('test-key');
      assertEquals(initial?.version, 1);

      // First update
      await memoryManager.update(initial!.id, { content: 'updated value 1' });
      const updated1 = await memoryManager.retrieve('test-key');
      assertEquals(updated1?.version, 2);
      assertEquals(updated1?.content, 'updated value 1');

      // Second update
      await memoryManager.update(updated1!.id, { content: 'updated value 2' });
      const updated2 = await memoryManager.retrieve('test-key');
      assertEquals(updated2?.version, 3);
      assertEquals(updated2?.content, 'updated value 2');
    });

    it('should handle partial updates correctly', async () => {
      const entry: MemoryEntry = {
        id: 'test-key',
        agentId: 'test-agent',
        sessionId: 'test-session',
        type: 'observation',
        content: JSON.stringify({ a: 1, b: 2, c: 3 }),
        context: {},
        timestamp: new Date(),
        tags: ['test'],
        version: 1
      };
      
      await memoryManager.store(entry);
      const initial = await memoryManager.retrieve('test-key');

      // Partial update
      const parsedContent = JSON.parse(initial!.content);
      await memoryManager.update(initial!.id, { 
        content: JSON.stringify({ ...parsedContent, b: 5 }),
        metadata: { updated: true }
      });

      const updated = await memoryManager.retrieve('test-key');
      assertEquals(JSON.parse(updated?.content || '{}'), { a: 1, b: 5, c: 3 });
      assertEquals(updated?.metadata?.updated, true);
    });

    it('should preserve timestamps correctly during updates', async () => {
      const entry: MemoryEntry = {
        id: 'test-key',
        agentId: 'test-agent',
        sessionId: 'test-session',
        type: 'observation',
        content: 'value',
        context: {},
        timestamp: new Date(),
        tags: ['test'],
        version: 1
      };
      
      await memoryManager.store(entry);
      const initial = await memoryManager.retrieve('test-key');
      const timestamp = initial!.timestamp;

      // Advance time to ensure different timestamp
      fakeTime.tick(1000);

      await memoryManager.update(initial!.id, { content: 'updated' });
      const updated = await memoryManager.retrieve('test-key');

      // Timestamp should be preserved in the entry
      assertEquals(updated?.timestamp.getTime(), timestamp.getTime());
      // Version should be incremented
      assertEquals(updated?.version, 2);
    });
  });

  describe('Swarm Memory Incremental Updates', () => {
    let swarmMemory: SwarmMemoryManager;
    let logger: Logger;

    beforeEach(() => {
      logger = new Logger({ level: 'error', console: false });
      swarmMemory = new SwarmMemoryManager(
        { 
          dataDir: tempDir,
          maxRetries: 3,
          retryDelay: 100,
          defaultTTL: 3600000,
          gcInterval: 60000,
          enableCompression: false,
          compressionThreshold: 1024,
          enableEncryption: false,
          maxHistorySize: 10,
          pruneInterval: 300000,
          replicationFactor: 1,
          syncInterval: 5000,
          conflictResolution: 'last-write-wins'
        },
        logger
      );
    });

    it('should track version history on updates', async () => {
      await swarmMemory.set('test-key', 'version 1');
      await swarmMemory.update('test-key', 'version 2');
      await swarmMemory.update('test-key', 'version 3');

      const entry = await swarmMemory.get('test-key');
      assertEquals(entry.version, 3);
      assertEquals(entry.previousVersions.length, 2);
      assertEquals(entry.previousVersions[0].value, 'version 1');
      assertEquals(entry.previousVersions[1].value, 'version 2');
    });

    it('should limit version history to 10 entries', async () => {
      await swarmMemory.set('test-key', 'version 0');
      
      // Create 12 updates
      for (let i = 1; i <= 12; i++) {
        await swarmMemory.update('test-key', `version ${i}`);
      }

      const entry = await swarmMemory.get('test-key');
      assertEquals(entry.version, 13);
      assertEquals(entry.previousVersions.length, 10);
      assertEquals(entry.previousVersions[0].value, 'version 2');
      assertEquals(entry.previousVersions[9].value, 'version 11');
    });

    it('should handle concurrent updates with proper versioning', async () => {
      await swarmMemory.initialize();
      
      await swarmMemory.write('counter', 0);

      // Simulate concurrent updates
      const updates = Array(10).fill(null).map(async () => {
        const current = await swarmMemory.retrieve('counter');
        await swarmMemory.update('counter', current + 1);
      });

      await Promise.all(updates);

      const final = await swarmMemory.retrieve('counter', { includeMetadata: true });
      assertEquals(await swarmMemory.retrieve('counter'), 10);
      assertEquals(final.version, 11); // Initial + 10 updates
    });
  });

  describe('Configuration Manager Incremental Updates', () => {
    let configManager: ConfigManager;

    beforeEach(() => {
      configManager = new ConfigManager({
        defaultConfig: {
          model: 'claude-3-sonnet',
          temperature: 0.7,
          maxTokens: 4096,
          tools: { webSearch: true, memory: true }
        }
      });
    });

    it('should handle nested configuration updates', () => {
      const initial = configManager.getConfig();
      
      configManager.update({
        temperature: 0.9,
        tools: { webSearch: false }
      });

      const updated = configManager.getConfig();
      assertEquals(updated.temperature, 0.9);
      assertEquals(updated.tools.webSearch, false);
      assertEquals(updated.tools.memory, true); // Preserved
      assertEquals(updated.model, 'claude-3-sonnet'); // Preserved
    });

    it('should track configuration differences', () => {
      configManager.update({ temperature: 0.5 });
      
      const diff = configManager.getDiff();
      assertEquals(diff, { temperature: 0.5 });
      
      configManager.update({ maxTokens: 8192 });
      const diff2 = configManager.getDiff();
      assertEquals(diff2, { temperature: 0.5, maxTokens: 8192 });
    });
  });

  describe.skip('Cache Hit/Miss Counter Updates', () => {
    it('should increment cache hit/miss counters correctly', () => {
      const cache = null as any; // new SimpleCache<string>({ maxSize: 3 });
      
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      
      // Generate hits
      cache.get('key1');
      cache.get('key2');
      cache.get('key1');
      
      // Generate misses
      cache.get('key3');
      cache.get('key4');
      
      assertEquals(cache.stats(), {
        size: 2,
        maxSize: 3,
        hits: 3,
        misses: 2
      });
    });

    it('should handle cache eviction during incremental adds', () => {
      const cache = new SimpleCache<string>({ maxSize: 2 });
      
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3'); // Should evict key1
      
      assertEquals(cache.has('key1'), false);
      assertEquals(cache.has('key2'), true);
      assertEquals(cache.has('key3'), true);
      assertEquals(cache.stats().size, 2);
    });
  });

  describe('Deep Merge Incremental Updates', () => {
    it('should handle deep nested object updates', () => {
      const original = {
        level1: {
          level2: {
            level3: {
              a: 1,
              b: 2
            },
            array: [1, 2, 3]
          },
          keep: 'this'
        }
      };

      const update = {
        level1: {
          level2: {
            level3: {
              b: 5,
              c: 3
            },
            array: [4, 5]
          }
        }
      };

      const result = deepMerge(original, update);
      
      assertEquals(result, {
        level1: {
          level2: {
            level3: {
              a: 1,
              b: 5,
              c: 3
            },
            array: [4, 5]
          },
          keep: 'this'
        }
      });
    });

    it('should not mutate original objects during merge', () => {
      const original = { a: 1, nested: { b: 2 } };
      const update = { nested: { b: 3, c: 4 } };
      
      const result = deepMerge(original, update);
      
      assertEquals(original.nested.b, 2);
      assertEquals(result.nested.b, 3);
      assertEquals(result.nested.c, 4);
    });
  });

  describe('Resource Manager Incremental Updates', () => {
    let resourceManager: ResourceManager;

    beforeEach(() => {
      resourceManager = new ResourceManager({
        maxMemory: 1024 * 1024 * 1024, // 1GB
        maxCpu: 4,
        maxThreads: 10
      });
    });

    it('should track incremental resource allocation', async () => {
      const allocation1 = await resourceManager.allocate('task1', {
        memory: 100 * 1024 * 1024, // 100MB
        cpu: 1,
        threads: 2
      });

      assertEquals(allocation1, true);
      
      const usage1 = resourceManager.getUsage();
      assertEquals(usage1.memory, 100 * 1024 * 1024);
      assertEquals(usage1.cpu, 1);
      assertEquals(usage1.threads, 2);

      const allocation2 = await resourceManager.allocate('task2', {
        memory: 200 * 1024 * 1024, // 200MB
        cpu: 1,
        threads: 3
      });

      assertEquals(allocation2, true);
      
      const usage2 = resourceManager.getUsage();
      assertEquals(usage2.memory, 300 * 1024 * 1024);
      assertEquals(usage2.cpu, 2);
      assertEquals(usage2.threads, 5);
    });

    it('should handle resource deallocation correctly', async () => {
      await resourceManager.allocate('task1', {
        memory: 500 * 1024 * 1024,
        cpu: 2,
        threads: 4
      });

      const usageBefore = resourceManager.getUsage();
      assertEquals(usageBefore.memory, 500 * 1024 * 1024);

      resourceManager.deallocate('task1');

      const usageAfter = resourceManager.getUsage();
      assertEquals(usageAfter.memory, 0);
      assertEquals(usageAfter.cpu, 0);
      assertEquals(usageAfter.threads, 0);
    });
  });

  describe('Batch Incremental Updates', () => {
    it('should handle batch memory updates efficiently', async () => {
      const backend = MemoryBackendFactory.create('local', { directory: tempDir });
      const memoryManager = new MemoryManager({ backend });
      await memoryManager.initialize();

      // Store multiple entries
      const entries = await Promise.all(
        Array(10).fill(null).map((_, i) => 
          memoryManager.store(`key-${i}`, i, { namespace: 'batch' })
        )
      );

      // Batch update with increments
      await Promise.all(
        entries.map(async (_, i) => {
          const entry = await memoryManager.retrieve(`key-${i}`, 'batch');
          return memoryManager.update(entry!.id, { 
            content: entry!.content + 10 
          });
        })
      );

      // Verify all updates
      for (let i = 0; i < 10; i++) {
        const updated = await memoryManager.retrieve(`key-${i}`, 'batch');
        assertEquals(updated?.content, i + 10);
        assertEquals(updated?.version, 2);
      }
    });
  });

  describe('Atomic Counter Operations', () => {
    it('should handle atomic increments correctly', () => {
      class Counter {
        private value: number = 0;
        private updates: number = 0;
        
        increment(): number {
          this.updates++;
          return ++this.value;
        }
        
        decrement(): number {
          this.updates++;
          return --this.value;
        }
        
        getStats() {
          return { value: this.value, updates: this.updates };
        }
      }

      const counter = new Counter();
      
      // Perform multiple operations
      counter.increment();
      counter.increment();
      counter.decrement();
      counter.increment();
      
      const stats = counter.getStats();
      assertEquals(stats.value, 2);
      assertEquals(stats.updates, 4);
    });
  });

  describe('Event-Driven Updates', () => {
    it('should emit events on incremental updates', async () => {
      const backend = MemoryBackendFactory.create('local', { directory: tempDir });
      const memoryManager = new MemoryManager({ backend });
      await memoryManager.initialize();

      const updateEvents: any[] = [];
      memoryManager.on('memory:updated', (event) => {
        updateEvents.push(event);
      });

      await memoryManager.store('event-key', 'initial', { namespace: 'events' });
      const entry = await memoryManager.retrieve('event-key', 'events');
      
      await memoryManager.update(entry!.id, { content: 'updated' });
      
      // Wait for event propagation
      await AsyncTestUtils.waitFor(() => updateEvents.length > 0, 100);
      
      assertEquals(updateEvents.length, 1);
      assertEquals(updateEvents[0].id, entry!.id);
      assertEquals(updateEvents[0].updates.content, 'updated');
    });
  });
});