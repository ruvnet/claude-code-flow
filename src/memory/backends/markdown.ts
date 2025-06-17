/**
 * Markdown backend implementation for human-readable memory storage
 */

import { IMemoryBackend } from './base.ts';
import { MemoryEntry, MemoryQuery } from '../../utils/types.ts';
import { ILogger } from '../../core/logger.ts';
import { MemoryBackendError } from '../../utils/errors.ts';
import { ensureDir } from '@std/fs';

/**
 * Markdown-based memory backend
 */
export class MarkdownBackend implements IMemoryBackend {
  private entries = new Map<string, MemoryEntry>();
  private indexPath: string;

  constructor(
    private baseDir: string,
    private logger: ILogger,
  ) {
    this.indexPath = `${this.baseDir}/index.json`;
  }

  async initialize(): Promise<void> {
    this.logger.info('Initializing Markdown backend', { baseDir: this.baseDir });

    try {
      // Ensure directories exist
      await ensureDir(this.baseDir);
      await ensureDir(`${this.baseDir}/agents`);
      await ensureDir(`${this.baseDir}/sessions`);

      // Load index
      await this.loadIndex();

      this.logger.info('Markdown backend initialized');
    } catch (error) {
      throw new MemoryBackendError('Failed to initialize Markdown backend', { error });
    }
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down Markdown backend');

    // Save index before shutdown
    await this.saveIndex();
    this.entries.clear();
  }

  async store(entry: MemoryEntry): Promise<void> {
    try {
      // Store in memory
      this.entries.set(entry.id, entry);

      // Write to markdown file
      await this.writeEntryToFile(entry);

      // Update index
      await this.saveIndex();
    } catch (error) {
      throw new MemoryBackendError('Failed to store entry', { error });
    }
  }

  async retrieve(id: string): Promise<MemoryEntry | undefined> {
    return this.entries.get(id);
  }

  async update(id: string, entry: MemoryEntry): Promise<void> {
    if (!this.entries.has(id)) {
      throw new MemoryBackendError(`Entry not found: ${id}`);
    }

    await this.store(entry);
  }

  async delete(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) {
      return;
    }

    try {
      // Delete from memory
      this.entries.delete(id);

      // Delete file
      const filePath = this.getEntryFilePath(entry);
      await Deno.remove(filePath);

      // Update index
      await this.saveIndex();
    } catch (error) {
      throw new MemoryBackendError('Failed to delete entry', { error });
    }
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    let results = Array.from(this.entries.values());

    // Apply filters
    if (query.agentId) {
      results = results.filter(e => e.agentId === query.agentId);
    }

    if (query.sessionId) {
      results = results.filter(e => e.sessionId === query.sessionId);
    }

    if (query.type) {
      results = results.filter(e => e.type === query.type);
    }

    if (query.tags && query.tags.length > 0) {
      results = results.filter(e => 
        query.tags!.some(tag => e.tags.includes(tag)),
      );
    }

    if (query.startTime) {
      results = results.filter(e => 
        e.timestamp.getTime() >= query.startTime!.getTime(),
      );
    }

    if (query.endTime) {
      results = results.filter(e => 
        e.timestamp.getTime() <= query.endTime!.getTime(),
      );
    }

    if (query.search) {
      const searchLower = query.search.toLowerCase();
      results = results.filter(e => 
        e.content.toLowerCase().includes(searchLower) ||
        e.tags.some(tag => tag.toLowerCase().includes(searchLower)),
      );
    }

    // Sort by timestamp (newest first)
    results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    // Apply pagination
    const start = query.offset || 0;
    const limit = query.limit || results.length;
    results = results.slice(start, start + limit);

    return results;
  }

  async getAllEntries(): Promise<MemoryEntry[]> {
    return Array.from(this.entries.values());
  }

  async getHealthStatus(): Promise<{ 
    healthy: boolean; 
    error?: string; 
    metrics?: Record<string, number>;
  }> {
    try {
      // Check if directory is accessible
      await Deno.stat(this.baseDir);

      const entryCount = this.entries.size;
      let totalSizeBytes = 0;

      // Calculate total size
      for (const entry of this.entries.values()) {
        const filePath = this.getEntryFilePath(entry);
        try {
          const stat = await Deno.stat(filePath);
          totalSizeBytes += stat.size;
        } catch {
          // File might not exist yet
        }
      }

      return {
        healthy: true,
        metrics: {
          entryCount,
          totalSizeBytes,
        },
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async loadIndex(): Promise<void> {
    try {
      const content = await Deno.readTextFile(this.indexPath);
      const index = JSON.parse(content) as Record<string, MemoryEntry>;

      // Convert and validate entries
      for (const [id, entry] of Object.entries(index)) {
        // Reconstruct dates
        entry.timestamp = new Date(entry.timestamp);
        this.entries.set(id, entry);
      }

      this.logger.info('Loaded memory index', { entries: this.entries.size });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        this.logger.warn('Failed to load index', { error });
      }
      // Start with empty index if file doesn't exist
    }
  }

  private async saveIndex(): Promise<void> {
    const index: Record<string, MemoryEntry> = {};
    
    for (const [id, entry] of this.entries) {
      index[id] = entry;
    }

    const content = JSON.stringify(index, null, 2);
    await Deno.writeTextFile(this.indexPath, content);
  }

  private async writeEntryToFile(entry: MemoryEntry): Promise<void> {
    const filePath = this.getEntryFilePath(entry);
    const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));

    // Ensure directory exists
    await ensureDir(dirPath);

    // Generate markdown content
    const content = this.entryToMarkdown(entry);

    // Write file
    await Deno.writeTextFile(filePath, content);
  }

  private getEntryFilePath(entry: MemoryEntry): string {
    const date = entry.timestamp.toISOString().split('T')[0];
    const time = entry.timestamp.toISOString().split('T')[1].replace(/:/g, '-').split('.')[0];
    
    return `${this.baseDir}/agents/${entry.agentId}/${date}/${time}_${entry.id}.md`;
  }

  private entryToMarkdown(entry: MemoryEntry): string {
    const lines: string[] = [
      `# Memory Entry: ${entry.id}`,
      '',
      `**Agent**: ${entry.agentId}`,
      `**Session**: ${entry.sessionId}`,
      `**Type**: ${entry.type}`,
      `**Timestamp**: ${entry.timestamp.toISOString()}`,
      `**Version**: ${entry.version}`,
      '',
    ];

    if (entry.parentId) {
      lines.push(`**Parent**: ${entry.parentId}`, '');
    }

    if (entry.tags.length > 0) {
      lines.push(`**Tags**: ${entry.tags.join(', ')}`, '');
    }

    lines.push('## Content', '', entry.content, '');

    if (Object.keys(entry.context).length > 0) {
      lines.push('## Context', '', '```json');
      lines.push(JSON.stringify(entry.context, null, 2));
      lines.push('```', '');
    }

    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      lines.push('## Metadata', '', '```json');
      lines.push(JSON.stringify(entry.metadata, null, 2));
      lines.push('```', '');
    }

    return lines.join('\n');
  }
}