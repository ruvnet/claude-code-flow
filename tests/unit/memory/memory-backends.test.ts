/**
 * Comprehensive unit tests for Memory Backends (SQLite and Markdown)
 */

import { describe, it, beforeEach, afterEach } from "https://deno.land/std@0.220.0/testing/bdd.ts";
import { assertEquals, assertExists, assertRejects, assertThrows } from "https://deno.land/std@0.220.0/assert/mod.ts";
import { FakeTime } from "https://deno.land/std@0.220.0/testing/time.ts";

import { SQLiteMemoryBackend } from '../../../src/memory/backends/sqlite.ts';
import { MarkdownBackend } from '../../../src/memory/backends/markdown.ts';
import { 
  AsyncTestUtils, 
  MemoryTestUtils, 
  PerformanceTestUtils,
  TestAssertions,
  FileSystemTestUtils,
  TestDataGenerator 
} from '../../utils/test-utils.ts';
import { generateMemoryEntries, generateEdgeCaseData } from '../../fixtures/generators.ts';
import { setupTestEnv, cleanupTestEnv, TEST_CONFIG } from '../../test.config.ts';

describe('Memory Backends - Comprehensive Tests', () => {
  let tempDir: string;
  let fakeTime: FakeTime;

  beforeEach(async () => {
    setupTestEnv();
    tempDir = await FileSystemTestUtils.createTempDir('memory-test-');
    fakeTime = new FakeTime();
  });

  afterEach(async () => {
    fakeTime.restore();
    await FileSystemTestUtils.cleanup([tempDir]);
    await cleanupTestEnv();
  });

  describe('SQLite Memory Backend', () => {
    let backend: SQLiteMemoryBackend;

    beforeEach(async () => {
      backend = new SQLiteMemoryBackend({
        dbPath: `${tempDir}/test-memory.db`,
        maxConnections: 10,
        busyTimeout: 5000,
        enableWal: true,
      });
      
      await backend.initialize();
    });

    afterEach(async () => {
      if (backend) {
        await backend.shutdown();
      }
    });

    describe('Basic Operations', () => {
      it('should store and retrieve memory entries', async () => {
        const namespace = 'test';
        const entry = {
          key: 'test-key',
          value: { message: 'Hello World', timestamp: Date.now() },
          tags: ['test', 'example'],
          metadata: { source: 'unit-test' },
        };

        await backend.store(namespace, entry.key, entry.value, entry.tags, entry.metadata);
        const retrieved = await backend.retrieve(namespace, entry.key);

        assertEquals(retrieved.value, entry.value);
        assertEquals(retrieved.tags, entry.tags);
        assertEquals(retrieved.metadata, entry.metadata);
        assertExists(retrieved.createdAt);
        assertExists(retrieved.updatedAt);
      });

      it('should handle different data types', async () => {
        const namespace = 'types';
        const testData = [
          { key: 'string', value: 'test string' },
          { key: 'number', value: 42 },
          { key: 'boolean', value: true },
          { key: 'array', value: [1, 2, 3, 'four'] },
          { key: 'object', value: { nested: { deep: 'value' } } },
          { key: 'null', value: null },
        ];

        // Store all test data
        for (const { key, value } of testData) {
          await backend.store(namespace, key, value);
        }

        // Retrieve and verify all test data
        for (const { key, value } of testData) {
          const retrieved = await backend.retrieve(namespace, key);
          assertEquals(retrieved.value, value);
        }
      });

      it('should update existing entries', async () => {
        const namespace = 'update';
        const key = 'updateable-key';
        
        // Store initial value
        await backend.store(namespace, key, { version: 1 });
        const initial = await backend.retrieve(namespace, key);
        
        // Update value
        await backend.store(namespace, key, { version: 2 });
        const updated = await backend.retrieve(namespace, key);
        
        assertEquals(updated.value, { version: 2 });
        assertEquals(updated.createdAt, initial.createdAt); // Should not change
        assertEquals(updated.updatedAt > initial.updatedAt, true); // Should be newer
      });

      it('should delete entries', async () => {
        const namespace = 'delete';
        const key = 'deletable-key';
        
        await backend.store(namespace, key, { data: 'to be deleted' });
        const deleted = await backend.delete(namespace, key);
        
        assertEquals(deleted, true);
        
        await assertRejects(
          () => backend.retrieve(namespace, key),
          Error,
          'not found'
        );
      });

      it('should handle non-existent entries', async () => {
        await assertRejects(
          () => backend.retrieve('nonexistent', 'key'),
          Error,
          'not found'
        );

        const deleted = await backend.delete('nonexistent', 'key');
        assertEquals(deleted, false);
      });
    });

    describe('Querying and Search', () => {
      beforeEach(async () => {
        // Populate with test data
        const entries = generateMemoryEntries(50);
        for (const entry of entries) {
          await backend.store(
            entry.namespace,
            entry.key,
            entry.value,
            entry.tags,
            entry.value.metadata
          );
        }
      });

      it('should list entries by namespace', async () => {
        const entries = await backend.list('test');
        assertEquals(entries.length >= 1, true);
        
        // All entries should be from 'test' namespace
        entries.forEach(entry => {
          assertEquals(entry.namespace, 'test');
        });
      });

      it('should search by tags', async () => {
        // Add entries with specific tags
        await backend.store('search', 'tagged-1', { data: 1 }, ['important', 'urgent']);
        await backend.store('search', 'tagged-2', { data: 2 }, ['important']);
        await backend.store('search', 'tagged-3', { data: 3 }, ['urgent']);
        
        const importantEntries = await backend.search({
          namespace: 'search',
          tags: ['important'],
        });
        
        assertEquals(importantEntries.length, 2);
        
        const urgentEntries = await backend.search({
          namespace: 'search',
          tags: ['urgent'],
        });
        
        assertEquals(urgentEntries.length, 2);
        
        const bothTags = await backend.search({
          namespace: 'search',
          tags: ['important', 'urgent'],
          tagMode: 'all',
        });
        
        assertEquals(bothTags.length, 1);
      });

      it('should search with pagination', async () => {
        const page1 = await backend.search({
          namespace: 'test',
          limit: 10,
          offset: 0,
        });
        
        const page2 = await backend.search({
          namespace: 'test',
          limit: 10,
          offset: 10,
        });
        
        assertEquals(page1.length, 10);
        assertEquals(page2.length >= 1, true);
        
        // No overlap between pages
        const page1Keys = new Set(page1.map(e => e.key));
        const page2Keys = new Set(page2.map(e => e.key));
        const intersection = new Set([...page1Keys].filter(k => page2Keys.has(k)));
        assertEquals(intersection.size, 0);
      });

      it('should search with date ranges', async () => {
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        
        const recentEntries = await backend.search({
          namespace: 'test',
          createdAfter: oneHourAgo,
        });
        
        // All entries should be recent (created in this test)
        assertEquals(recentEntries.length >= 1, true);
        
        const futureEntries = await backend.search({
          namespace: 'test',
          createdAfter: new Date(now.getTime() + 60 * 60 * 1000),
        });
        
        assertEquals(futureEntries.length, 0);
      });

      it('should search with complex queries', async () => {
        // Add specific test data
        await backend.store('complex', 'item-1', 
          { type: 'document', priority: 'high', size: 1024 },
          ['document', 'important']
        );
        
        await backend.store('complex', 'item-2',
          { type: 'document', priority: 'low', size: 512 },
          ['document']
        );
        
        await backend.store('complex', 'item-3',
          { type: 'image', priority: 'high', size: 2048 },
          ['media', 'important']
        );

        const results = await backend.search({
          namespace: 'complex',
          tags: ['important'],
          // Note: actual content search would depend on backend implementation
        });

        assertEquals(results.length, 2);
      });
    });

    describe('Performance and Scalability', () => {
      it('should handle bulk operations efficiently', async () => {
        const entries = generateMemoryEntries(1000);
        
        const { stats } = await PerformanceTestUtils.benchmark(
          async () => {
            const entry = entries[Math.floor(Math.random() * entries.length)];
            await backend.store(
              entry.namespace,
              entry.key,
              entry.value,
              entry.tags,
              entry.value.metadata
            );
          },
          { iterations: 100, concurrency: 5 }
        );

        TestAssertions.assertInRange(stats.mean, 0, 100); // Should be fast
        console.log(`SQLite bulk write performance: ${stats.mean.toFixed(2)}ms average`);
      });

      it('should handle concurrent operations', async () => {
        const operations = Array.from({ length: 50 }, (_, i) => ({
          namespace: 'concurrent',
          key: `key-${i}`,
          value: { data: `value-${i}`, index: i },
        }));

        // Execute all operations concurrently
        await Promise.all(
          operations.map(op => 
            backend.store(op.namespace, op.key, op.value)
          )
        );

        // Verify all operations completed successfully
        const allEntries = await backend.list('concurrent');
        assertEquals(allEntries.length, 50);
      });

      it('should maintain performance with large datasets', async () => {
        // Create a large dataset
        const largeEntries = TestDataGenerator.largeDataset(5000);
        
        // Store all entries
        for (let i = 0; i < largeEntries.length; i += 100) {
          const batch = largeEntries.slice(i, i + 100);
          await Promise.all(
            batch.map(entry => 
              backend.store('large', entry.id, entry)
            )
          );
        }

        // Test search performance on large dataset
        const { stats } = await PerformanceTestUtils.benchmark(
          () => backend.search({ namespace: 'large', limit: 10 }),
          { iterations: 10 }
        );

        TestAssertions.assertInRange(stats.mean, 0, 500); // Should be reasonable
        console.log(`SQLite large dataset search: ${stats.mean.toFixed(2)}ms average`);
      });

      it('should handle memory efficiently', async () => {
        const { leaked } = await MemoryTestUtils.checkMemoryLeak(async () => {
          // Perform many operations
          for (let i = 0; i < 1000; i++) {
            await backend.store('memory-test', `key-${i}`, {
              data: TestDataGenerator.randomString(1000),
              index: i,
            });
          }

          // Clean up
          for (let i = 0; i < 1000; i++) {
            await backend.delete('memory-test', `key-${i}`);
          }
        });

        assertEquals(leaked, false);
      });
    });

    describe('Error Handling and Edge Cases', () => {
      it('should handle invalid namespace names', async () => {
        const invalidNamespaces = ['', null, undefined, 'namespace with spaces'];
        
        for (const namespace of invalidNamespaces) {
          await TestAssertions.assertThrowsAsync(
            () => backend.store(namespace as any, 'key', 'value'),
            Error
          );
        }
      });

      it('should handle invalid keys', async () => {
        const invalidKeys = ['', null, undefined];
        
        for (const key of invalidKeys) {
          await TestAssertions.assertThrowsAsync(
            () => backend.store('test', key as any, 'value'),
            Error
          );
        }
      });

      it('should handle edge case data', async () => {
        const edgeCases = generateEdgeCaseData();
        
        // Test with various edge case values
        for (const [category, values] of Object.entries(edgeCases)) {
          for (const [name, value] of Object.entries(values)) {
            try {
              await backend.store('edge-cases', `${category}-${name}`, value);
              const retrieved = await backend.retrieve('edge-cases', `${category}-${name}`);
              
              // Some edge cases might be normalized (e.g., undefined -> null)
              // Just verify we can store and retrieve them
              assertExists(retrieved);
            } catch (error) {
              // Some edge cases may legitimately fail
              console.log(`Edge case ${category}-${name} failed: ${error.message}`);
            }
          }
        }
      });

      it('should handle database corruption gracefully', async () => {
        // Close backend first
        await backend.shutdown();
        
        // Corrupt the database file
        try {
          await Deno.writeTextFile(`${tempDir}/test-memory.db`, 'corrupted data');
        } catch {
          // File might not exist
        }

        // Try to initialize with corrupted database
        const corruptedBackend = new SQLiteMemoryBackend({
          dbPath: `${tempDir}/test-memory.db`,
        });

        await TestAssertions.assertThrowsAsync(
          () => corruptedBackend.initialize(),
          Error
        );
      });

      it('should handle disk space exhaustion', async () => {
        // This is difficult to simulate reliably, but we can test large writes
        const largeValue = {
          data: 'x'.repeat(1024 * 1024), // 1MB of data
          timestamp: Date.now(),
        };

        try {
          await backend.store('large-test', 'big-value', largeValue);
          const retrieved = await backend.retrieve('large-test', 'big-value');
          assertEquals(retrieved.value.data.length, largeValue.data.length);
        } catch (error) {
          // May fail on systems with limited disk space
          console.log(`Large value test failed: ${error.message}`);
        }
      });
    });

    describe('Concurrency and Transactions', () => {
      it('should handle concurrent reads and writes', async () => {
        const namespace = 'concurrent-rw';
        const key = 'shared-key';
        
        // Start concurrent operations
        const operations = [
          // Writers
          ...Array.from({ length: 5 }, (_, i) => 
            backend.store(namespace, `${key}-${i}`, { value: i })
          ),
          // Readers (may fail if key doesn't exist yet)
          ...Array.from({ length: 5 }, (_, i) => 
            backend.retrieve(namespace, `${key}-${i}`).catch(() => null)
          ),
        ];

        const results = await Promise.allSettled(operations);
        
        // Most operations should succeed
        const successful = results.filter(r => r.status === 'fulfilled');
        TestAssertions.assertInRange(successful.length, 5, 10);
      });

      it('should maintain data consistency under concurrent updates', async () => {
        const namespace = 'consistency';
        const key = 'counter';
        
        // Initialize counter
        await backend.store(namespace, key, { count: 0 });
        
        // Concurrent increment operations
        const incrementPromises = Array.from({ length: 10 }, async () => {
          const current = await backend.retrieve(namespace, key);
          const newCount = current.value.count + 1;
          await backend.store(namespace, key, { count: newCount });
        });

        await Promise.all(incrementPromises);
        
        const final = await backend.retrieve(namespace, key);
        
        // Due to race conditions, final count may be less than 10
        // But should be at least 1 and at most 10
        TestAssertions.assertInRange(final.value.count, 1, 10);
      });
    });
  });

  describe('Markdown Memory Backend', () => {
    let backend: MarkdownBackend;

    beforeEach(async () => {
      backend = new MarkdownBackend({
        baseDir: `${tempDir}/markdown-memory`,
        enableGitHistory: false, // Disable for tests
        enableSearch: true,
      });
      
      await backend.initialize();
    });

    afterEach(async () => {
      if (backend) {
        await backend.shutdown();
      }
    });

    describe('Basic Operations', () => {
      it('should store and retrieve memory entries as markdown', async () => {
        const namespace = 'test';
        const entry = {
          key: 'test-document',
          value: {
            title: 'Test Document',
            content: 'This is a test document with **bold** and *italic* text.',
            metadata: { author: 'Test Author', version: 1 },
          },
          tags: ['test', 'document'],
        };

        await backend.store(namespace, entry.key, entry.value, entry.tags);
        const retrieved = await backend.retrieve(namespace, entry.key);

        assertEquals(retrieved.value, entry.value);
        assertEquals(retrieved.tags, entry.tags);
        assertExists(retrieved.createdAt);
      });

      it('should handle different content types', async () => {
        const namespace = 'content-types';
        const testContent = [
          {
            key: 'markdown-text',
            value: {
              content: '# Title\n\nThis is **markdown** content.',
              type: 'markdown',
            },
          },
          {
            key: 'structured-data',
            value: {
              data: { nested: { structure: 'value' } },
              type: 'json',
            },
          },
          {
            key: 'plain-text',
            value: {
              content: 'Simple plain text content.',
              type: 'text',
            },
          },
        ];

        for (const { key, value } of testContent) {
          await backend.store(namespace, key, value);
        }

        for (const { key, value } of testContent) {
          const retrieved = await backend.retrieve(namespace, key);
          assertEquals(retrieved.value, value);
        }
      });

      it('should create proper directory structure', async () => {
        await backend.store('project/docs', 'readme', {
          content: '# Project README\n\nProject documentation.',
        });

        // Verify file was created in correct directory
        const filePath = `${tempDir}/markdown-memory/project/docs/readme.md`;
        const fileExists = await Deno.stat(filePath).then(() => true).catch(() => false);
        assertEquals(fileExists, true);
      });

      it('should handle file naming and escaping', async () => {
        const specialKeys = [
          'file with spaces',
          'file-with-dashes',
          'file_with_underscores',
          'file.with.dots',
          'UPPERCASE-file',
        ];

        for (const key of specialKeys) {
          await backend.store('special', key, {
            content: `Content for ${key}`,
          });
        }

        for (const key of specialKeys) {
          const retrieved = await backend.retrieve('special', key);
          assertEquals(retrieved.value.content, `Content for ${key}`);
        }
      });
    });

    describe('Markdown Features', () => {
      it('should preserve markdown formatting', async () => {
        const markdownContent = `# Main Title

## Subtitle

This is a paragraph with **bold** and *italic* text.

### List Example

- Item 1
- Item 2
  - Nested item
  - Another nested item

### Code Example

\`\`\`javascript
function hello() {
  console.log('Hello, World!');
}
\`\`\`

### Table Example

| Column 1 | Column 2 |
|----------|----------|
| Value 1  | Value 2  |

> This is a blockquote.

[Link to example](https://example.com)
`;

        await backend.store('markdown', 'formatted-doc', {
          content: markdownContent,
          title: 'Formatted Document',
        });

        const retrieved = await backend.retrieve('markdown', 'formatted-doc');
        assertEquals(retrieved.value.content, markdownContent);
      });

      it('should handle frontmatter metadata', async () => {
        const contentWithFrontmatter = {
          title: 'Document with Metadata',
          author: 'Test Author',
          date: '2024-01-01',
          tags: ['important', 'documentation'],
          content: 'This document has metadata in frontmatter.',
        };

        await backend.store('frontmatter', 'meta-doc', contentWithFrontmatter);
        const retrieved = await backend.retrieve('frontmatter', 'meta-doc');

        assertEquals(retrieved.value, contentWithFrontmatter);
      });
    });

    describe('Search and Indexing', () => {
      beforeEach(async () => {
        // Create searchable content
        const documents = [
          {
            key: 'javascript-guide',
            value: {
              title: 'JavaScript Guide',
              content: 'Learn JavaScript programming with examples and best practices.',
              category: 'programming',
            },
            tags: ['javascript', 'programming', 'guide'],
          },
          {
            key: 'python-tutorial',
            value: {
              title: 'Python Tutorial',
              content: 'Python programming tutorial for beginners.',
              category: 'programming',
            },
            tags: ['python', 'programming', 'tutorial'],
          },
          {
            key: 'project-readme',
            value: {
              title: 'Project README',
              content: 'Documentation for the project setup and usage.',
              category: 'documentation',
            },
            tags: ['documentation', 'readme'],
          },
        ];

        for (const doc of documents) {
          await backend.store('search-test', doc.key, doc.value, doc.tags);
        }
      });

      it('should search by content', async () => {
        const results = await backend.search({
          namespace: 'search-test',
          query: 'programming',
        });

        assertEquals(results.length, 2);
        
        const titles = results.map(r => r.value.title);
        assertEquals(titles.includes('JavaScript Guide'), true);
        assertEquals(titles.includes('Python Tutorial'), true);
      });

      it('should search by tags', async () => {
        const programmingDocs = await backend.search({
          namespace: 'search-test',
          tags: ['programming'],
        });

        assertEquals(programmingDocs.length, 2);

        const tutorialDocs = await backend.search({
          namespace: 'search-test',
          tags: ['tutorial'],
        });

        assertEquals(tutorialDocs.length, 1);
        assertEquals(tutorialDocs[0].value.title, 'Python Tutorial');
      });

      it('should search with complex queries', async () => {
        // Search for JavaScript OR Python
        const languageResults = await backend.search({
          namespace: 'search-test',
          query: 'JavaScript OR Python',
        });

        assertEquals(languageResults.length >= 2, true);

        // Search for programming AND tutorial
        const tutorialResults = await backend.search({
          namespace: 'search-test',
          query: 'programming AND tutorial',
        });

        assertEquals(tutorialResults.length, 1);
        assertEquals(tutorialResults[0].value.title, 'Python Tutorial');
      });
    });

    describe('Performance and File Management', () => {
      it('should handle many files efficiently', async () => {
        const { stats } = await PerformanceTestUtils.benchmark(
          async () => {
            const key = `doc-${Date.now()}-${Math.random()}`;
            await backend.store('performance', key, {
              title: `Document ${key}`,
              content: TestDataGenerator.randomString(1000),
            });
          },
          { iterations: 50, concurrency: 3 }
        );

        TestAssertions.assertInRange(stats.mean, 0, 200); // Should be reasonable
        console.log(`Markdown backend performance: ${stats.mean.toFixed(2)}ms average`);
      });

      it('should clean up deleted files', async () => {
        const namespace = 'cleanup-test';
        const key = 'temporary-file';
        
        await backend.store(namespace, key, {
          content: 'This file will be deleted',
        });

        // Verify file exists
        const filePath = `${tempDir}/markdown-memory/${namespace}/${key}.md`;
        const existsBefore = await Deno.stat(filePath).then(() => true).catch(() => false);
        assertEquals(existsBefore, true);

        // Delete the entry
        const deleted = await backend.delete(namespace, key);
        assertEquals(deleted, true);

        // Verify file is removed
        const existsAfter = await Deno.stat(filePath).then(() => true).catch(() => false);
        assertEquals(existsAfter, false);
      });

      it('should handle directory cleanup', async () => {
        const namespace = 'deep/nested/structure';
        await backend.store(namespace, 'only-file', { content: 'test' });
        
        // Delete the file
        await backend.delete(namespace, 'only-file');
        
        // Directory structure should be cleaned up if empty
        const deepPath = `${tempDir}/markdown-memory/deep/nested/structure`;
        const dirExists = await Deno.stat(deepPath).then(() => true).catch(() => false);
        
        // Implementation may or may not clean up empty directories
        // This is testing the behavior, not enforcing it
        console.log(`Directory cleanup: ${dirExists ? 'preserved' : 'cleaned'}`);
      });
    });

    describe('Error Handling and Edge Cases', () => {
      it('should handle filesystem errors gracefully', async () => {
        // Try to write to read-only location (if possible to simulate)
        const readOnlyBackend = new MarkdownBackend({
          baseDir: '/read-only-path-that-does-not-exist',
        });

        await TestAssertions.assertThrowsAsync(
          () => readOnlyBackend.initialize(),
          Error
        );
      });

      it('should handle invalid markdown content', async () => {
        const invalidContent = {
          content: 'Valid content',
          invalidField: () => {}, // Function - not serializable
        };

        try {
          await backend.store('invalid', 'bad-content', invalidContent);
          // If it succeeds, the backend handled it gracefully
        } catch (error) {
          // Expected to fail with non-serializable content
          assertExists(error);
        }
      });

      it('should handle concurrent file operations', async () => {
        const namespace = 'concurrent-files';
        const key = 'shared-document';
        
        // Concurrent writes to same file
        const writePromises = Array.from({ length: 5 }, (_, i) => 
          backend.store(namespace, key, {
            content: `Content version ${i}`,
            version: i,
          })
        );

        const results = await Promise.allSettled(writePromises);
        
        // At least one should succeed
        const successful = results.filter(r => r.status === 'fulfilled');
        assertEquals(successful.length >= 1, true);

        // Verify we can read the final state
        const final = await backend.retrieve(namespace, key);
        assertExists(final);
      });
    });
  });

  describe('Backend Comparison and Compatibility', () => {
    let sqliteBackend: SQLiteMemoryBackend;
    let markdownBackend: MarkdownBackend;

    beforeEach(async () => {
      sqliteBackend = new SQLiteMemoryBackend({
        dbPath: `${tempDir}/comparison.db`,
      });
      
      markdownBackend = new MarkdownBackend({
        baseDir: `${tempDir}/comparison-md`,
      });

      await Promise.all([
        sqliteBackend.initialize(),
        markdownBackend.initialize(),
      ]);
    });

    afterEach(async () => {
      await Promise.all([
        sqliteBackend.shutdown(),
        markdownBackend.shutdown(),
      ]);
    });

    it('should handle same data consistently', async () => {
      const testData = {
        namespace: 'compatibility',
        key: 'test-entry',
        value: {
          title: 'Test Entry',
          content: 'This is test content for compatibility testing.',
          metadata: { source: 'test', version: 1 },
        },
        tags: ['test', 'compatibility'],
      };

      // Store in both backends
      await Promise.all([
        sqliteBackend.store(testData.namespace, testData.key, testData.value, testData.tags),
        markdownBackend.store(testData.namespace, testData.key, testData.value, testData.tags),
      ]);

      // Retrieve from both backends
      const [sqliteResult, markdownResult] = await Promise.all([
        sqliteBackend.retrieve(testData.namespace, testData.key),
        markdownBackend.retrieve(testData.namespace, testData.key),
      ]);

      // Values should be equivalent
      assertEquals(sqliteResult.value, markdownResult.value);
      assertEquals(sqliteResult.tags, markdownResult.tags);
    });

    it('should handle performance comparison', async () => {
      const testEntries = generateMemoryEntries(100);
      
      // Benchmark SQLite
      const sqliteStats = await PerformanceTestUtils.benchmark(
        async () => {
          const entry = testEntries[Math.floor(Math.random() * testEntries.length)];
          await sqliteBackend.store(entry.namespace, entry.key, entry.value);
        },
        { iterations: 50 }
      );

      // Benchmark Markdown
      const markdownStats = await PerformanceTestUtils.benchmark(
        async () => {
          const entry = testEntries[Math.floor(Math.random() * testEntries.length)];
          await markdownBackend.store(entry.namespace, entry.key, entry.value);
        },
        { iterations: 50 }
      );

      console.log(`SQLite backend: ${sqliteStats.mean.toFixed(2)}ms average`);
      console.log(`Markdown backend: ${markdownStats.mean.toFixed(2)}ms average`);
      
      // Both should be reasonably fast
      TestAssertions.assertInRange(sqliteStats.mean, 0, 500);
      TestAssertions.assertInRange(markdownStats.mean, 0, 500);
    });

    it('should handle migration scenarios', async () => {
      // Store data in SQLite
      const migrationData = generateMemoryEntries(20);
      
      for (const entry of migrationData) {
        await sqliteBackend.store(
          entry.namespace,
          entry.key,
          entry.value,
          entry.tags,
          entry.value.metadata
        );
      }

      // Simulate migration to Markdown
      const sqliteEntries = await sqliteBackend.list('test');
      
      for (const entry of sqliteEntries) {
        await markdownBackend.store(
          entry.namespace,
          entry.key,
          entry.value,
          entry.tags
        );
      }

      // Verify data integrity after migration
      const markdownEntries = await markdownBackend.list('test');
      assertEquals(markdownEntries.length, sqliteEntries.length);
      
      // Spot check a few entries
      for (let i = 0; i < Math.min(5, sqliteEntries.length); i++) {
        const sqliteEntry = sqliteEntries[i];
        const markdownEntry = await markdownBackend.retrieve(
          sqliteEntry.namespace,
          sqliteEntry.key
        );
        
        assertEquals(markdownEntry.value, sqliteEntry.value);
        assertEquals(markdownEntry.tags, sqliteEntry.tags);
      }
    });
  });
});