import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandParser } from '../src/parser.js';
import type { CommandContext } from '../src/types.js';

const listEntries = vi.fn();
const printJson = vi.fn();

vi.mock('../src/memory/memory-initializer.js', () => ({
  listEntries,
  resolveDbPath: (value?: string) => value || '/default/.swarm/memory.db',
}));

vi.mock('../src/output.js', () => ({
  output: {
    writeln: vi.fn(),
    printInfo: vi.fn(),
    printError: vi.fn(),
    printWarning: vi.fn(),
    printTable: vi.fn(),
    printJson,
    bold: (value: string) => value,
  },
}));

const { memoryCommand } = await import('../src/commands/memory.js');
const listCommand = memoryCommand.subcommands?.find(command => command.name === 'list')!;

describe('memory list structural pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listEntries.mockResolvedValue({
      success: true,
      entries: [
        { key: 'k3', namespace: 'progress', size: 3, hasEmbedding: false, accessCount: 0, updatedAt: '2026-08-22T00:00:00Z' },
        { key: 'k4', namespace: 'progress', size: 4, hasEmbedding: false, accessCount: 0, updatedAt: '2026-08-22T00:00:01Z' },
      ],
      total: 5,
    });
  });

  it('exposes offset and page-info through the real command parser', () => {
    const parser = new CommandParser({ allowUnknownFlags: false });
    parser.registerCommand(memoryCommand);

    const parsed = parser.parse([
      'memory',
      'list',
      '--limit',
      '20',
      '--offset',
      '40',
      '--page-info',
      '--format',
      'json',
    ]);

    expect(parsed.command).toEqual(['memory', 'list']);
    expect(parsed.flags).toMatchObject({
      limit: 20,
      offset: 40,
      pageInfo: true,
      format: 'json',
    });
    expect(parser.validateFlags(parsed.flags, listCommand)).toEqual([]);
  });

  it('passes the requested offset and returns total plus the next offset in JSON page-info mode', async () => {
    const ctx: CommandContext = {
      args: [],
      flags: {
        _: [],
        namespace: 'progress',
        limit: 2,
        offset: 2,
        pageInfo: true,
        format: 'json',
        path: '/project/.swarm/memory.db',
      },
      cwd: '/project',
      interactive: false,
    };

    const result = await listCommand.action!(ctx);

    expect(listEntries).toHaveBeenCalledWith({
      namespace: 'progress',
      limit: 2,
      offset: 2,
      dbPath: '/project/.swarm/memory.db',
    });
    expect(result).toEqual({
      success: true,
      data: {
        entries: expect.any(Array),
        total: 5,
        limit: 2,
        offset: 2,
        nextOffset: 4,
        hasMore: true,
      },
    });
    expect(printJson).toHaveBeenCalledWith(result.data);
  });

  it('returns a null next offset on the terminal page', async () => {
    listEntries.mockResolvedValueOnce({
      success: true,
      entries: [{ key: 'k5', namespace: 'progress', size: 5, hasEmbedding: false, accessCount: 0, updatedAt: '2026-08-22T00:00:02Z' }],
      total: 5,
    });
    const ctx: CommandContext = {
      args: [],
      flags: { _: [], limit: 2, offset: 4, pageInfo: true, format: 'json' },
      cwd: '/project',
      interactive: false,
    };

    const result = await listCommand.action!(ctx);

    expect(result.data).toMatchObject({ total: 5, offset: 4, nextOffset: null, hasMore: false });
  });

  it('keeps the legacy JSON array when page metadata is not requested', async () => {
    const ctx: CommandContext = {
      args: [],
      flags: { _: [], limit: 2, offset: 0, format: 'json' },
      cwd: '/project',
      interactive: false,
    };

    const result = await listCommand.action!(ctx);

    expect(Array.isArray(result.data)).toBe(true);
    expect(printJson).toHaveBeenCalledWith(result.data);
  });

  it.each([
    ['limit', { limit: 0, offset: 0 }],
    ['offset', { limit: 2, offset: -1 }],
  ])('rejects an invalid %s before reading AgentDB', async (_label, invalid) => {
    const ctx: CommandContext = {
      args: [],
      flags: { _: [], ...invalid, pageInfo: true, format: 'json' },
      cwd: '/project',
      interactive: false,
    };

    const result = await listCommand.action!(ctx);

    expect(result).toEqual({ success: false, exitCode: 1 });
    expect(listEntries).not.toHaveBeenCalled();
  });

  it('fails instead of emitting a non-advancing page while rows remain', async () => {
    listEntries.mockResolvedValueOnce({ success: true, entries: [], total: 5 });
    const ctx: CommandContext = {
      args: [],
      flags: { _: [], limit: 2, offset: 2, pageInfo: true, format: 'json' },
      cwd: '/project',
      interactive: false,
    };

    const result = await listCommand.action!(ctx);

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});
