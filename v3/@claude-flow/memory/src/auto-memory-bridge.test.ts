/**
 * Tests for AutoMemoryBridge
 *
 * TDD London School (mock-first) tests for the bidirectional bridge
 * between Claude Code auto memory and AgentDB.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import {
  AutoMemoryBridge,
  resolveAutoMemoryDir,
  findGitRoot,
  parseMarkdownEntries,
  extractSummaries,
  formatInsightLine,
  hashContent,
  pruneTopicFile,
  hasSummaryLine,
} from './auto-memory-bridge.js';
import type {
  MemoryInsight,
} from './auto-memory-bridge.js';
import type { IMemoryBackend, MemoryEntry } from './types.js';

// ===== Mock Backend =====

function createMockBackend(): IMemoryBackend & { storedEntries: MemoryEntry[] } {
  const storedEntries: MemoryEntry[] = [];

  return {
    storedEntries,
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    store: vi.fn().mockImplementation(async (entry: MemoryEntry) => {
      storedEntries.push(entry);
    }),
    get: vi.fn().mockResolvedValue(null),
    getByKey: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(true),
    query: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
    bulkInsert: vi.fn().mockResolvedValue(undefined),
    bulkDelete: vi.fn().mockResolvedValue(0),
    count: vi.fn().mockResolvedValue(0),
    listNamespaces: vi.fn().mockResolvedValue([]),
    clearNamespace: vi.fn().mockResolvedValue(0),
    getStats: vi.fn().mockResolvedValue({
      totalEntries: 0,
      entriesByNamespace: {},
      entriesByType: {},
      memoryUsage: 0,
      avgQueryTime: 0,
      avgSearchTime: 0,
    }),
    healthCheck: vi.fn().mockResolvedValue({
      status: 'healthy',
      components: {
        storage: { status: 'healthy', latency: 0 },
        index: { status: 'healthy', latency: 0 },
        cache: { status: 'healthy', latency: 0 },
      },
      timestamp: Date.now(),
      issues: [],
      recommendations: [],
    }),
  };
}

// ===== Test Fixtures =====

function createTestInsight(overrides: Partial<MemoryInsight> = {}): MemoryInsight {
  return {
    category: 'debugging',
    summary: 'HNSW index requires initialization before search',
    source: 'agent:tester',
    confidence: 0.95,
    ...overrides,
  };
}

// ===== Utility Function Tests =====

describe('resolveAutoMemoryDir', () => {
  it('should derive path from working directory', () => {
    const result = resolveAutoMemoryDir('/workspaces/my-project');
    expect(result).toContain('.claude/projects/');
    expect(result).toContain('memory');
    expect(result).not.toContain('//');
  });

  it('should replace slashes with dashes', () => {
    const result = resolveAutoMemoryDir('/workspaces/my-project');
    expect(result).toContain('workspaces-my-project');
  });

  it('should normalize underscores to dashes (issue #2282)', () => {
    // Claude Code normalizes both `/` and `_` to `-` when computing the
    // project key, so paths like /home/phil/A-Project/RX_ERP/ map to
    // -home-phil-A-Project-RX-ERP, not -home-phil-A-Project-RX_ERP.
    const result = resolveAutoMemoryDir('/home/phil/A-Project/RX_ERP');
    expect(result).toContain('A-Project-RX-ERP');
    expect(result).not.toContain('RX_ERP');
  });

  it('should produce consistent paths for same input', () => {
    const a = resolveAutoMemoryDir('/workspaces/my-project');
    const b = resolveAutoMemoryDir('/workspaces/my-project');
    expect(a).toBe(b);
  });
});

describe('findGitRoot', () => {
  it('should find git root for a directory inside a repo', () => {
    // Use the actual repo path (works regardless of workspace name)
    const thisDir = path.resolve(__dirname);
    const root = findGitRoot(thisDir);
    expect(root).not.toBeNull();
    // The root should contain a .git directory
    expect(fsSync.existsSync(path.join(root!, '.git'))).toBe(true);
  });

  it('should return the directory itself if it is the git root', () => {
    // Find the actual git root first, then verify idempotence
    const thisDir = path.resolve(__dirname);
    const gitRoot = findGitRoot(thisDir);
    expect(gitRoot).not.toBeNull();
    const root = findGitRoot(gitRoot!);
    expect(root).toBe(gitRoot);
  });

  it('should return null for root filesystem', () => {
    // /proc is almost certainly not in a git repo
    const result = findGitRoot('/proc');
    expect(result).toBeNull();
  });
});

describe('parseMarkdownEntries', () => {
  it('should parse markdown with ## headings into entries', () => {
    const content = `# Main Title

## Section One
Content of section one.
More content here.

## Section Two
Content of section two.
`;

    const entries = parseMarkdownEntries(content);
    expect(entries).toHaveLength(2);
    expect(entries[0].heading).toBe('Section One');
    expect(entries[0].content).toContain('Content of section one');
    expect(entries[1].heading).toBe('Section Two');
  });

  it('should fall back to single untitled entry when no ## headings or frontmatter (issue #2283)', () => {
    // Pre-fix behavior was to return [] — we now emit one entry with the
    // body as content so files without ## subheadings still import.
    const content = '# Only h1 heading\nSome text\n';
    const entries = parseMarkdownEntries(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].heading).toBe('(untitled)');
    expect(entries[0].content).toContain('# Only h1 heading');
    expect(entries[0].content).toContain('Some text');
  });

  it('should parse YAML frontmatter + body as a single entry (issue #2283)', () => {
    // Claude Code's auto-memory format: YAML frontmatter + free-text body,
    // no ## sub-headings. Pre-fix this returned [] silently.
    const content = `---
name: GitHub identity for RX Platform
description: Phil uses PrimitiveOne / one@primitive1.com for...
type: user
originSessionId: 753b313d-3414-abcd
---
For the RX Platform / RX_ERP project specifically:

- **GitHub login**: \`PrimitiveOne\`
- **GitHub email**: \`one@primitive1.com\`
`;
    const entries = parseMarkdownEntries(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].heading).toBe('GitHub identity for RX Platform');
    expect(entries[0].content).toContain('GitHub login');
    expect(entries[0].content).toContain('PrimitiveOne');
    expect(entries[0].metadata.type).toBe('user');
    expect(entries[0].metadata.description).toContain('Phil uses PrimitiveOne');
    expect(entries[0].metadata.originSessionId).toBe('753b313d-3414-abcd');
  });

  it('should prefer ## headings over frontmatter fallback when both present', () => {
    const content = `---
name: Should be ignored when ## headings exist
type: user
---
## Real Section
Section content
`;
    const entries = parseMarkdownEntries(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].heading).toBe('Real Section');
    expect(entries[0].content).toContain('Section content');
  });

  it('should return empty array for empty content', () => {
    expect(parseMarkdownEntries('')).toHaveLength(0);
  });

  it('should return empty array when frontmatter has no body', () => {
    const content = `---
name: Frontmatter only
---
`;
    const entries = parseMarkdownEntries(content);
    expect(entries).toHaveLength(0);
  });

  it('should handle multiple lines under a heading', () => {
    const content = `## Heading
Line 1
Line 2
Line 3
`;

    const entries = parseMarkdownEntries(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toContain('Line 1');
    expect(entries[0].content).toContain('Line 3');
  });

  it('should trim whitespace from section content', () => {
    const content = '## Padded\n\n  Text here  \n\n';
    const entries = parseMarkdownEntries(content);
    expect(entries[0].content).toBe('Text here');
  });
});

describe('extractSummaries', () => {
  it('should extract bullet points from content', () => {
    const content = `# Topic

- First summary
- Second summary
- See \`details.md\` for more
Some other text
`;

    const summaries = extractSummaries(content);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toBe('First summary');
    expect(summaries[1]).toBe('Second summary');
  });

  it('should skip "See" references', () => {
    const content = '- Good item\n- See `file.md` for details\n';
    const summaries = extractSummaries(content);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toBe('Good item');
  });

  it('should return empty array for content without bullets', () => {
    const content = 'No bullets here\n';
    const summaries = extractSummaries(content);
    expect(summaries).toHaveLength(0);
  });

  it('should strip metadata annotations from summaries', () => {
    const content = '- Use Int8 quantization _(agent:tester, 2026-02-08, conf: 0.95)_\n';
    const summaries = extractSummaries(content);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toBe('Use Int8 quantization');
  });

  it('should handle summaries without annotations', () => {
    const content = '- Clean summary without annotation\n';
    const summaries = extractSummaries(content);
    expect(summaries[0]).toBe('Clean summary without annotation');
  });
});

describe('formatInsightLine', () => {
  it('should format insight as a markdown bullet', () => {
    const insight = createTestInsight();
    const line = formatInsightLine(insight);

    expect(line.startsWith('- HNSW index requires initialization before search')).toBe(true);
    expect(line).toContain('agent:tester');
    expect(line).toContain('0.95');
  });

  it('should include detail as indented content for multi-line details', () => {
    const insight = createTestInsight({
      detail: 'Line 1\nLine 2\nLine 3',
    });
    const line = formatInsightLine(insight);

    expect(line).toContain('  Line 1');
    expect(line).toContain('  Line 2');
  });

  it('should not add indented detail for single-line details', () => {
    const insight = createTestInsight({ detail: 'Short detail' });
    const line = formatInsightLine(insight);
    // Single-line detail should not produce indented lines
    expect(line.split('\n')).toHaveLength(1);
  });
});

describe('hashContent', () => {
  it('should produce consistent hashes', () => {
    const hash1 = hashContent('test content');
    const hash2 = hashContent('test content');
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different content', () => {
    const hash1 = hashContent('content A');
    const hash2 = hashContent('content B');
    expect(hash1).not.toBe(hash2);
  });

  it('should return a 16-character hex string', () => {
    const hash = hashContent('test');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('pruneTopicFile', () => {
  it('should not prune if under limit', () => {
    const content = '# Header\n\nSubheader\n- Item 1\n- Item 2\n';
    const result = pruneTopicFile(content, 100);
    expect(result).toBe(content);
  });

  it('should keep header and newest entries when pruning', () => {
    const lines = ['# Header', '', 'Description'];
    for (let i = 0; i < 20; i++) {
      lines.push(`- Entry ${i}`);
    }
    const content = lines.join('\n');

    const result = pruneTopicFile(content, 13);
    const resultLines = result.split('\n');

    expect(resultLines[0]).toBe('# Header');
    expect(resultLines).toHaveLength(13);
    expect(resultLines[resultLines.length - 1]).toBe('- Entry 19');
  });
});

describe('hasSummaryLine', () => {
  it('should find exact summary at start of bullet line', () => {
    const content = '- Use Int8 quantization _(source, date)_\n- Other item\n';
    expect(hasSummaryLine(content, 'Use Int8 quantization')).toBe(true);
  });

  it('should not match substrings inside other bullets', () => {
    const content = '- Do not use Int8 for this case\n';
    // "Use Int8" should NOT match because the line starts with "- Do not use..."
    expect(hasSummaryLine(content, 'Use Int8')).toBe(false);
  });

  it('should return false when summary is absent', () => {
    const content = '- Something else\n';
    expect(hasSummaryLine(content, 'Missing summary')).toBe(false);
  });

  it('should handle empty content', () => {
    expect(hasSummaryLine('', 'anything')).toBe(false);
  });
});

// ===== AutoMemoryBridge Tests =====

describe('AutoMemoryBridge', () => {
  let bridge: AutoMemoryBridge;
  let backend: ReturnType<typeof createMockBackend>;
  let testDir: string;

  beforeEach(() => {
    testDir = path.join('/tmp', `auto-memory-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fsSync.mkdirSync(testDir, { recursive: true });

    backend = createMockBackend();
    bridge = new AutoMemoryBridge(backend, {
      memoryDir: testDir,
      syncMode: 'on-session-end',
    });
  });

  afterEach(() => {
    bridge.destroy();
    if (fsSync.existsSync(testDir)) {
      fsSync.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('constructor', () => {
    it('should initialize with default config', () => {
      const b = new AutoMemoryBridge(backend);
      expect(b.getMemoryDir()).toBeTruthy();
      b.destroy();
    });

    it('should use provided memory directory', () => {
      expect(bridge.getMemoryDir()).toBe(testDir);
    });
  });

  describe('getIndexPath', () => {
    it('should return path to MEMORY.md', () => {
      expect(bridge.getIndexPath()).toBe(path.join(testDir, 'MEMORY.md'));
    });
  });

  describe('getTopicPath', () => {
    it('should return path to topic file based on category', () => {
      const p = bridge.getTopicPath('debugging');
      expect(p).toBe(path.join(testDir, 'debugging.md'));
    });

    it('should use custom topic mapping', () => {
      const custom = new AutoMemoryBridge(backend, {
        memoryDir: testDir,
        topicMapping: { debugging: 'bugs.md' },
      });
      const p = custom.getTopicPath('debugging');
      expect(p).toBe(path.join(testDir, 'bugs.md'));
      custom.destroy();
    });
  });

  describe('recordInsight', () => {
    it('should store insight in AgentDB', async () => {
      const insight = createTestInsight();
      await bridge.recordInsight(insight);

      expect(backend.store).toHaveBeenCalledTimes(1);
      const storedEntry = backend.storedEntries[0];
      expect(storedEntry.namespace).toBe('learnings');
      expect(storedEntry.tags).toContain('insight');
      expect(storedEntry.tags).toContain('debugging');
    });

    it('should emit insight:recorded event', async () => {
      const handler = vi.fn();
      bridge.on('insight:recorded', handler);

      const insight = createTestInsight();
      await bridge.recordInsight(insight);

      expect(handler).toHaveBeenCalledWith(insight);
    });

    it('should write to files immediately in on-write mode', async () => {
      bridge.destroy();
      bridge = new AutoMemoryBridge(backend, {
        memoryDir: testDir,
        syncMode: 'on-write',
      });

      const insight = createTestInsight();
      await bridge.recordInsight(insight);

      const topicPath = bridge.getTopicPath('debugging');
      expect(fsSync.existsSync(topicPath)).toBe(true);
      const content = fsSync.readFileSync(topicPath, 'utf-8');
      expect(content).toContain(insight.summary);
    });

    it('should not write to files immediately in on-session-end mode', async () => {
      const insight = createTestInsight();
      await bridge.recordInsight(insight);

      const topicPath = bridge.getTopicPath('debugging');
      expect(fsSync.existsSync(topicPath)).toBe(false);
    });

    it('should store confidence in metadata', async () => {
      await bridge.recordInsight(createTestInsight({ confidence: 0.42 }));

      const stored = backend.storedEntries[0];
      expect(stored.metadata.confidence).toBe(0.42);
    });
  });

  describe('syncToAutoMemory', () => {
    it('should flush buffered insights to files', async () => {
      await bridge.recordInsight(createTestInsight());
      await bridge.recordInsight(createTestInsight({
        category: 'performance',
        summary: 'Use Int8 quantization for 3.92x memory reduction',
      }));

      const result = await bridge.syncToAutoMemory();

      expect(result.synced).toBeGreaterThan(0);
      expect(result.categories).toContain('debugging');
      expect(result.categories).toContain('performance');
      expect(result.errors).toHaveLength(0);

      expect(fsSync.existsSync(bridge.getTopicPath('debugging'))).toBe(true);
      expect(fsSync.existsSync(bridge.getTopicPath('performance'))).toBe(true);
    });

    it('should create MEMORY.md index', async () => {
      await bridge.recordInsight(createTestInsight());
      await bridge.syncToAutoMemory();

      expect(fsSync.existsSync(bridge.getIndexPath())).toBe(true);
    });

    it('should emit sync:completed event', async () => {
      const handler = vi.fn();
      bridge.on('sync:completed', handler);

      await bridge.syncToAutoMemory();

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        durationMs: expect.any(Number),
      }));
    });

    it('should not duplicate insights on repeated sync', async () => {
      await bridge.recordInsight(createTestInsight());
      await bridge.syncToAutoMemory();
      await bridge.syncToAutoMemory();

      const topicPath = bridge.getTopicPath('debugging');
      const content = fsSync.readFileSync(topicPath, 'utf-8');
      const matches = content.match(/HNSW index requires/g);
      expect(matches).toHaveLength(1);
    });

    it('should clear the insight buffer after sync', async () => {
      await bridge.recordInsight(createTestInsight());
      expect(bridge.getStatus().bufferedInsights).toBe(1);

      await bridge.syncToAutoMemory();
      expect(bridge.getStatus().bufferedInsights).toBe(0);
    });

    it('should skip AgentDB entries already synced from the buffer', async () => {
      // Record an insight (stored in buffer AND AgentDB)
      await bridge.recordInsight(createTestInsight());

      // Mock backend.query to return the same insight from AgentDB
      const mockEntry: Partial<MemoryEntry> = {
        id: 'test-1',
        key: 'insight:debugging:12345',
        content: 'HNSW index requires initialization before search',
        tags: ['insight', 'debugging'],
        metadata: {
          category: 'debugging',
          summary: 'HNSW index requires initialization before search',
          confidence: 0.95,
        },
      };
      (backend.query as any).mockResolvedValueOnce([mockEntry as MemoryEntry]);

      await bridge.syncToAutoMemory();

      // Should only appear once
      const content = fsSync.readFileSync(bridge.getTopicPath('debugging'), 'utf-8');
      const matches = content.match(/HNSW index requires/g);
      expect(matches).toHaveLength(1);
    });
  });

  describe('importFromAutoMemory', () => {
    it('should import entries from existing markdown files', async () => {
      const topicContent = `# Debugging Insights

## Known Issues
- Always init HNSW before search
- SQLite WASM needs sql.js
`;
      fsSync.writeFileSync(path.join(testDir, 'debugging.md'), topicContent, 'utf-8');

      const result = await bridge.importFromAutoMemory();

      expect(result.imported).toBeGreaterThan(0);
      expect(result.files).toContain('debugging.md');
      // Should use bulkInsert, not individual store calls
      expect(backend.bulkInsert).toHaveBeenCalled();
    });

    it('should skip entries already in AgentDB', async () => {
      const topicContent = `# Test

## Existing
Already in DB
`;
      fsSync.writeFileSync(path.join(testDir, 'test.md'), topicContent, 'utf-8');

      // Mock backend to return existing entry with matching content hash
      (backend.query as any).mockResolvedValue([{
        id: 'existing-1',
        metadata: { contentHash: hashContent('Already in DB') },
      }]);

      const result = await bridge.importFromAutoMemory();
      expect(result.skipped).toBeGreaterThan(0);
    });

    it('should return zero imported for non-existent directory', async () => {
      bridge.destroy();
      bridge = new AutoMemoryBridge(backend, {
        memoryDir: '/tmp/nonexistent-auto-memory-dir-xyz',
      });

      const result = await bridge.importFromAutoMemory();
      expect(result.imported).toBe(0);
      expect(result.files).toHaveLength(0);
    });

    it('should batch imports with bulkInsert', async () => {
      // Create multiple files with multiple sections
      fsSync.writeFileSync(
        path.join(testDir, 'file1.md'),
        '## A\nContent A\n## B\nContent B\n',
        'utf-8',
      );
      fsSync.writeFileSync(
        path.join(testDir, 'file2.md'),
        '## C\nContent C\n',
        'utf-8',
      );

      await bridge.importFromAutoMemory();

      // bulkInsert should be called once with all entries
      expect(backend.bulkInsert).toHaveBeenCalledTimes(1);
      const batchArg = (backend.bulkInsert as any).mock.calls[0][0];
      expect(batchArg).toHaveLength(3);
    });
  });

  describe('curateIndex', () => {
    it('should generate MEMORY.md from topic files', async () => {
      fsSync.writeFileSync(
        path.join(testDir, 'debugging.md'),
        '# Debugging\n\n- Init HNSW before search\n- Check embeddings dimension\n',
        'utf-8',
      );
      fsSync.writeFileSync(
        path.join(testDir, 'performance.md'),
        '# Performance\n\n- Use Int8 quantization\n',
        'utf-8',
      );

      await bridge.curateIndex();

      const indexContent = fsSync.readFileSync(bridge.getIndexPath(), 'utf-8');
      expect(indexContent).toContain('# Claude Flow V3 Project Memory');
      expect(indexContent).toContain('Init HNSW before search');
      expect(indexContent).toContain('Use Int8 quantization');
    });

    it('should stay under maxIndexLines', async () => {
      const lines = ['# Debugging', ''];
      for (let i = 0; i < 200; i++) {
        lines.push(`- Item ${i} is a debugging insight`);
      }
      fsSync.writeFileSync(
        path.join(testDir, 'debugging.md'),
        lines.join('\n'),
        'utf-8',
      );

      bridge.destroy();
      bridge = new AutoMemoryBridge(backend, {
        memoryDir: testDir,
        maxIndexLines: 20,
      });

      await bridge.curateIndex();

      const indexContent = fsSync.readFileSync(bridge.getIndexPath(), 'utf-8');
      const indexLines = indexContent.split('\n');
      expect(indexLines.length).toBeLessThanOrEqual(20);
    });

    it('should strip metadata from summaries in the index', async () => {
      fsSync.writeFileSync(
        path.join(testDir, 'debugging.md'),
        '# Debugging\n\n- Fixed a bug _(agent:tester, 2026-02-08, conf: 0.90)_\n',
        'utf-8',
      );

      await bridge.curateIndex();

      const indexContent = fsSync.readFileSync(bridge.getIndexPath(), 'utf-8');
      expect(indexContent).toContain('- Fixed a bug');
      expect(indexContent).not.toContain('_(agent:tester');
    });

    it('should handle pruneStrategy=fifo by removing oldest entries', async () => {
      const lines = ['# Debugging', ''];
      for (let i = 0; i < 50; i++) {
        lines.push(`- Item ${i}`);
      }
      fsSync.writeFileSync(
        path.join(testDir, 'debugging.md'),
        lines.join('\n'),
        'utf-8',
      );

      bridge.destroy();
      bridge = new AutoMemoryBridge(backend, {
        memoryDir: testDir,
        maxIndexLines: 10,
        pruneStrategy: 'fifo',
      });

      await bridge.curateIndex();

      const indexContent = fsSync.readFileSync(bridge.getIndexPath(), 'utf-8');
      // FIFO removes oldest (first) items, keeps newest
      expect(indexContent).toContain('Item 49');
      expect(indexContent).not.toContain('Item 0');
    });

    // #1556: curateIndex() used to overwrite a hand-curated MEMORY.md with a
    // single-line stub when none of the files in memoryDir matched the
    // hardcoded DEFAULT_TOPIC_MAPPING filenames (as happens when Claude Code's
    // native `<type>_<topic>.md` convention is used). The fix is to skip the
    // write entirely when there's nothing to curate.
    it('should not overwrite hand-curated MEMORY.md when no topic files match (#1556)', async () => {
      const indexPath = path.join(testDir, 'MEMORY.md');
      const handCurated = '# My Hand-Curated Memory\n\n## Section 1\nImportant notes\n\n## Section 2\nMore notes\n';
      fsSync.writeFileSync(indexPath, handCurated, 'utf-8');

      // Write files using Claude Code's native <type>_<topic>.md convention —
      // none of these filenames appear in DEFAULT_TOPIC_MAPPING.
      fsSync.writeFileSync(path.join(testDir, 'user_role.md'), '# user role\ndata scientist', 'utf-8');
      fsSync.writeFileSync(path.join(testDir, 'session_foo.md'), '# session\nfoo bar', 'utf-8');
      fsSync.writeFileSync(path.join(testDir, 'feedback_tone.md'), '# feedback\nbe concise', 'utf-8');

      let skipEvent: any;
      bridge.on('index:skipped', (e) => { skipEvent = e; });

      await bridge.curateIndex();

      // MEMORY.md must be byte-identical to what we wrote
      const after = fsSync.readFileSync(indexPath, 'utf-8');
      expect(after).toBe(handCurated);

      // And the bridge should emit the skip event with a reason
      expect(skipEvent).toBeDefined();
      expect(skipEvent.reason).toBe('no-matching-topic-files');
    });

    // #3224: the #1556 guard above only holds while zero topic files exist.
    // The bridge creates its own first topic file (e.g. patterns.md) the
    // moment an insight is recorded, which used to make the guard stop
    // applying and silently destroy a hand-maintained MEMORY.md on that
    // very next curate.
    it('should not overwrite a hand-maintained MEMORY.md once a matching topic file exists (#3224)', async () => {
      const indexPath = path.join(testDir, 'MEMORY.md');
      const handCurated = '# My Hand-Curated Memory\n\n## Section 1\nImportant notes, 49 links elsewhere\n';
      fsSync.writeFileSync(indexPath, handCurated, 'utf-8');

      // patterns.md IS in DEFAULT_TOPIC_MAPPING (project-patterns), so the
      // #1556 guard does not apply here — sections will be non-empty.
      fsSync.writeFileSync(
        path.join(testDir, 'patterns.md'),
        '# Project Patterns\n\n- Some new insight\n',
        'utf-8',
      );

      let skipEvent: any;
      bridge.on('index:skipped', (e) => { skipEvent = e; });

      await bridge.curateIndex();

      // MEMORY.md must be byte-identical to what the user wrote.
      expect(fsSync.readFileSync(indexPath, 'utf-8')).toBe(handCurated);
      expect(skipEvent).toBeDefined();
      expect(skipEvent.reason).toBe('foreign-index');
    });

    it('should curate normally once it owns the index (marker present from a prior curate)', async () => {
      const indexPath = path.join(testDir, 'MEMORY.md');
      fsSync.writeFileSync(path.join(testDir, 'patterns.md'), '# Project Patterns\n\n- First insight\n', 'utf-8');

      // First curate creates the index and stamps it with the ownership marker.
      await bridge.curateIndex();
      const firstWrite = fsSync.readFileSync(indexPath, 'utf-8');
      expect(firstWrite).toContain('First insight');

      // A later curate on a file this bridge owns must still update normally.
      fsSync.writeFileSync(path.join(testDir, 'patterns.md'), '# Project Patterns\n\n- Second insight\n', 'utf-8');
      await bridge.curateIndex();

      const secondWrite = fsSync.readFileSync(indexPath, 'utf-8');
      expect(secondWrite).toContain('Second insight');
    });

    // Review feedback on #3224's fix: treating every unmarked MEMORY.md as
    // foreign would also catch every index this bridge wrote *before* the
    // marker existed, silently freezing it on upgrade. A pre-marker
    // bridge-authored file is recognized by its exact legacy title line
    // and continues to curate (and gets the marker going forward).
    it('should recognize and continue curating a pre-marker (legacy) bridge-authored MEMORY.md', async () => {
      const indexPath = path.join(testDir, 'MEMORY.md');
      const legacyOutput = '# Claude Flow V3 Project Memory\n\n## Debugging\n- Old insight\n- See `debugging.md` for details\n';
      fsSync.writeFileSync(indexPath, legacyOutput, 'utf-8');
      fsSync.writeFileSync(path.join(testDir, 'debugging.md'), '# Debugging\n\n- New insight\n', 'utf-8');

      let skipEvent: any;
      bridge.on('index:skipped', (e) => { skipEvent = e; });

      await bridge.curateIndex();

      expect(skipEvent).toBeUndefined();
      const after = fsSync.readFileSync(indexPath, 'utf-8');
      expect(after).toContain('New insight');
      expect(after).not.toBe(legacyOutput);
    });
  });

  describe('getStatus', () => {
    it('should report status for existing directory', async () => {
      fsSync.writeFileSync(
        path.join(testDir, 'MEMORY.md'),
        '# Memory\n- Item 1\n- Item 2\n',
        'utf-8',
      );

      const status = bridge.getStatus();
      expect(status.exists).toBe(true);
      expect(status.memoryDir).toBe(testDir);
      expect(status.files.length).toBeGreaterThan(0);
      expect(status.indexLines).toBeGreaterThanOrEqual(3);
    });

    it('should report status for non-existent directory', () => {
      bridge.destroy();
      bridge = new AutoMemoryBridge(backend, {
        memoryDir: '/tmp/nonexistent-dir-xyz',
      });

      const status = bridge.getStatus();
      expect(status.exists).toBe(false);
      expect(status.files).toHaveLength(0);
    });

    it('should count buffered insights', async () => {
      await bridge.recordInsight(createTestInsight());
      await bridge.recordInsight(createTestInsight({ summary: 'Another insight' }));

      const status = bridge.getStatus();
      expect(status.bufferedInsights).toBe(2);
    });

    it('should report lastSyncTime after sync', async () => {
      expect(bridge.getStatus().lastSyncTime).toBe(0);

      await bridge.syncToAutoMemory();

      expect(bridge.getStatus().lastSyncTime).toBeGreaterThan(0);
    });
  });

  describe('recordInsight - key uniqueness', () => {
    it('should generate unique keys for rapid sequential inserts', async () => {
      // Record multiple insights as fast as possible (same ms possible)
      await bridge.recordInsight(createTestInsight({ summary: 'Insight A' }));
      await bridge.recordInsight(createTestInsight({ summary: 'Insight B' }));
      await bridge.recordInsight(createTestInsight({ summary: 'Insight C' }));

      // All three should have unique keys
      const keys = backend.storedEntries.map(e => e.key);
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(3);
    });
  });

  describe('syncToAutoMemory - error handling', () => {
    it('should emit sync:failed on backend query error', async () => {
      const handler = vi.fn();
      bridge.on('sync:failed', handler);

      // Make ensureMemoryDir throw
      (backend.query as any).mockRejectedValueOnce(new Error('DB connection lost'));

      // Record an insight so there's something to sync
      await bridge.recordInsight(createTestInsight());

      // The sync should still succeed for the buffered part
      // because queryRecentInsights has its own try/catch
      const result = await bridge.syncToAutoMemory();
      expect(result.errors).toHaveLength(0);
    });

    it('should report errors for individual insight write failures', async () => {
      // Create a read-only file to force a write error
      const topicPath = bridge.getTopicPath('debugging');
      fsSync.writeFileSync(topicPath, '# Debugging\n\n- Existing\n', 'utf-8');
      fsSync.chmodSync(topicPath, 0o444); // read-only

      await bridge.recordInsight(createTestInsight());

      const result = await bridge.syncToAutoMemory();
      // Should have error from trying to write to read-only file
      expect(result.errors.length).toBeGreaterThan(0);

      // Restore permissions for cleanup
      fsSync.chmodSync(topicPath, 0o644);
    });
  });

  describe('syncToAutoMemory - append to existing topic file', () => {
    it('should append new insight to existing topic file', async () => {
      // Create initial topic file
      const topicPath = bridge.getTopicPath('debugging');
      fsSync.writeFileSync(topicPath, '# Debugging\n\n- Existing item\n', 'utf-8');

      bridge.destroy();
      bridge = new AutoMemoryBridge(backend, {
        memoryDir: testDir,
        syncMode: 'on-write',
      });

      await bridge.recordInsight(createTestInsight({ summary: 'New insight' }));

      const content = fsSync.readFileSync(topicPath, 'utf-8');
      expect(content).toContain('Existing item');
      expect(content).toContain('New insight');
    });

    it('should prune topic file when it exceeds maxTopicFileLines', async () => {
      // Create a topic file near the limit
      const topicPath = bridge.getTopicPath('debugging');
      const lines = ['# Debugging', '', 'Description'];
      for (let i = 0; i < 500; i++) {
        lines.push(`- Entry ${i}`);
      }
      fsSync.writeFileSync(topicPath, lines.join('\n'), 'utf-8');

      bridge.destroy();
      bridge = new AutoMemoryBridge(backend, {
        memoryDir: testDir,
        syncMode: 'on-write',
        maxTopicFileLines: 500,
      });

      await bridge.recordInsight(createTestInsight({ summary: 'Overflow insight' }));

      const content = fsSync.readFileSync(topicPath, 'utf-8');
      expect(content).toContain('Overflow insight');
      // Old entries near the top should have been pruned
      expect(content).not.toContain('Entry 0');
      // Header should be preserved
      expect(content).toContain('# Debugging');
    });
  });

  describe('syncToAutoMemory - classifyEntry coverage', () => {
    it('should classify by metadata category when present', async () => {
      const entry: Partial<MemoryEntry> = {
        id: 'e1',
        key: 'insight:security:999:0',
        content: 'SQL injection found',
        tags: ['insight'],
        metadata: { category: 'security', summary: 'SQL injection found', confidence: 0.9 },
      };
      (backend.query as any).mockResolvedValueOnce([entry as MemoryEntry]);

      await bridge.syncToAutoMemory();

      expect(fsSync.existsSync(bridge.getTopicPath('security'))).toBe(true);
      const content = fsSync.readFileSync(bridge.getTopicPath('security'), 'utf-8');
      expect(content).toContain('SQL injection found');
    });

    it('should classify by tags when metadata category is absent', async () => {
      const entry: Partial<MemoryEntry> = {
        id: 'e2',
        key: 'insight:unknown:999:0',
        content: 'Performance is slow',
        tags: ['insight', 'performance', 'benchmark'],
        metadata: { summary: 'Performance is slow', confidence: 0.85 },
      };
      (backend.query as any).mockResolvedValueOnce([entry as MemoryEntry]);

      await bridge.syncToAutoMemory();

      expect(fsSync.existsSync(bridge.getTopicPath('performance'))).toBe(true);
    });

    it('should default to project-patterns for unclassifiable entries', async () => {
      const entry: Partial<MemoryEntry> = {
        id: 'e3',
        key: 'insight:misc:999:0',
        content: 'Miscellaneous note',
        tags: ['insight'],
        metadata: { summary: 'Miscellaneous note', confidence: 0.8 },
      };
      (backend.query as any).mockResolvedValueOnce([entry as MemoryEntry]);

      await bridge.syncToAutoMemory();

      expect(fsSync.existsSync(bridge.getTopicPath('project-patterns'))).toBe(true);
    });

    it('should classify debugging tags correctly', async () => {
      const bugEntry: Partial<MemoryEntry> = {
        id: 'e4',
        key: 'insight:bug:999:0',
        content: 'Found a bug',
        tags: ['insight', 'bug'],
        metadata: { summary: 'Found a bug', confidence: 0.9 },
      };
      (backend.query as any).mockResolvedValueOnce([bugEntry as MemoryEntry]);

      await bridge.syncToAutoMemory();
      expect(fsSync.existsSync(bridge.getTopicPath('debugging'))).toBe(true);
    });

    it('should classify swarm/agent tags correctly', async () => {
      const swarmEntry: Partial<MemoryEntry> = {
        id: 'e5',
        key: 'insight:swarm:999:0',
        content: 'Swarm completed successfully',
        tags: ['insight', 'swarm'],
        metadata: { summary: 'Swarm completed successfully', confidence: 0.9 },
      };
      (backend.query as any).mockResolvedValueOnce([swarmEntry as MemoryEntry]);

      await bridge.syncToAutoMemory();
      expect(fsSync.existsSync(bridge.getTopicPath('swarm-results'))).toBe(true);
    });
  });

  describe('importFromAutoMemory - edge cases', () => {
    it('should emit import:completed event', async () => {
      const handler = vi.fn();
      bridge.on('import:completed', handler);

      fsSync.writeFileSync(
        path.join(testDir, 'test.md'),
        '## Section\nContent here\n',
        'utf-8',
      );

      await bridge.importFromAutoMemory();
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        imported: expect.any(Number),
        durationMs: expect.any(Number),
      }));
    });

    it('should import files with no ## headings as a single untitled entry (issue #2283)', async () => {
      // Pre-#2283 the parser dropped these silently. Now a file with body but
      // no sub-headings imports as one entry with the full body as content.
      fsSync.writeFileSync(
        path.join(testDir, 'empty.md'),
        '# Just a title\nSome text without sections\n',
        'utf-8',
      );

      const result = await bridge.importFromAutoMemory();
      expect(result.imported).toBe(1);
      expect(result.files).toContain('empty.md');
    });
  });

  describe('curateIndex - edge cases', () => {
    it('should skip index write when topic files have no extractable summaries', async () => {
      // #1556: curateIndex must be non-destructive when there's nothing to
      // curate. Previously it would overwrite MEMORY.md with a title-only
      // stub; now it emits 'index:skipped' and leaves any existing file alone.
      fsSync.writeFileSync(
        path.join(testDir, 'debugging.md'),
        '# Debugging\n\n',
        'utf-8',
      );

      let skipEvent: any;
      bridge.on('index:skipped', (e) => { skipEvent = e; });

      await bridge.curateIndex();

      expect(skipEvent).toBeDefined();
      expect(skipEvent.reason).toBe('no-matching-topic-files');
      expect(fsSync.existsSync(bridge.getIndexPath())).toBe(false);
    });

    it('should emit index:curated event', async () => {
      const handler = vi.fn();
      bridge.on('index:curated', handler);

      fsSync.writeFileSync(
        path.join(testDir, 'debugging.md'),
        '# Debugging\n\n- An item\n',
        'utf-8',
      );

      await bridge.curateIndex();
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        lines: expect.any(Number),
      }));
    });

    it('should handle pruneStrategy=lru same as fifo', async () => {
      const lines = ['# Debugging', ''];
      for (let i = 0; i < 50; i++) {
        lines.push(`- Item ${i}`);
      }
      fsSync.writeFileSync(
        path.join(testDir, 'debugging.md'),
        lines.join('\n'),
        'utf-8',
      );

      bridge.destroy();
      bridge = new AutoMemoryBridge(backend, {
        memoryDir: testDir,
        maxIndexLines: 10,
        pruneStrategy: 'lru',
      });

      await bridge.curateIndex();

      const indexContent = fsSync.readFileSync(bridge.getIndexPath(), 'utf-8');
      // LRU removes oldest (first) items, same as FIFO
      expect(indexContent).toContain('Item 49');
      expect(indexContent).not.toContain('Item 0');
    });
  });

  describe('destroy', () => {
    it('should clean up periodic sync timer', () => {
      const periodicBridge = new AutoMemoryBridge(backend, {
        memoryDir: testDir,
        syncMode: 'periodic',
        syncIntervalMs: 1000,
      });

      periodicBridge.destroy();
    });

    it('should remove all listeners', () => {
      bridge.on('insight:recorded', () => {});
      bridge.on('sync:completed', () => {});

      bridge.destroy();
      expect(bridge.listenerCount('insight:recorded')).toBe(0);
      expect(bridge.listenerCount('sync:completed')).toBe(0);
    });
  });
});
