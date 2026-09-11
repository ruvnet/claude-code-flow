/**
 * Regression test for #570.
 *
 * Multi-line objectives are error-prone to quote/escape directly on the
 * shell command line. `hive-mind spawn --claude` now accepts `--objective-file
 * <path>` (short: `-f`) to read the objective from a file instead, which
 * preserves newlines natively.
 *
 * Like hive-mind-skip-permissions.test.ts (#2269), this pins down the
 * CommandParser's kebab-case -> camelCase flag normalization AND the
 * resolution helper from hive-mind.ts, so a future parser or helper
 * refactor can't silently regress the flag-drop bug that class of issue
 * describes: the parser stores flags ONLY under the normalized camelCase
 * key, so reading `flags['objective-file']` alone is always undefined.
 */

import { describe, it, expect } from 'vitest';
import { CommandParser } from '../src/parser.js';
import { resolveObjectiveFile } from '../src/commands/hive-mind.js';

describe('#570 hive-mind --objective-file flag handling', () => {
  it('parser normalizes the kebab flag to camelCase and leaves the kebab key undefined', () => {
    const parser = new CommandParser({ allowUnknownFlags: true });
    const { flags } = parser.parse(['--objective-file', 'objective.txt']);

    expect(flags['objective-file']).toBeUndefined();
    expect(flags.objectiveFile).toBe('objective.txt');
  });

  it('parser handles the short -f alias', () => {
    const parser = new CommandParser({ allowUnknownFlags: true });
    const { flags } = parser.parse(['-f', 'objective.txt']);

    expect(flags.f).toBe('objective.txt');
  });

  it('resolveObjectiveFile reads the parser-normalized camelCase key', () => {
    const parser = new CommandParser({ allowUnknownFlags: true });
    const { flags } = parser.parse(['--objective-file', 'objective.txt']);

    expect(resolveObjectiveFile(flags as Record<string, unknown>)).toBe('objective.txt');
  });

  it('resolveObjectiveFile still accepts the legacy kebab key (back-compat with hand-built flag maps)', () => {
    expect(resolveObjectiveFile({ 'objective-file': 'objective.txt' })).toBe('objective.txt');
  });

  it('resolveObjectiveFile returns undefined when the flag is absent', () => {
    expect(resolveObjectiveFile({})).toBeUndefined();
    expect(resolveObjectiveFile({ objective: 'inline objective' })).toBeUndefined();
  });

  it('resolveObjectiveFile ignores a non-string value', () => {
    expect(resolveObjectiveFile({ objectiveFile: true })).toBeUndefined();
    expect(resolveObjectiveFile({ objectiveFile: '' })).toBeUndefined();
  });
});
