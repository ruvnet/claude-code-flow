/**
 * Regression test for #2269.
 *
 * The arg parser's normalizeKey converts kebab-case CLI flags to camelCase and
 * stores ONLY the normalized key. Code in hive-mind.ts that previously read
 * `flags['dangerously-skip-permissions']` was therefore always undefined, and
 * `=== true` always evaluated false, so `--dangerously-skip-permissions` was
 * silently dropped from the spawned `claude` process — every Edit/Write call
 * landed in `permission_denials` and headless runs couldn't change any files.
 *
 * The fix mirrors the dual-key fallback used elsewhere in hive-mind.ts (e.g.
 * isNonInteractive): accept either the kebab key or the camelCase key.
 *
 * This test pins down both the parser's normalization behavior AND the
 * predicate from the fix, so a future refactor of either piece can't
 * silently regress the flag-drop bug.
 */

import { describe, it, expect } from 'vitest';
import { CommandParser } from '../src/parser.js';
import { hiveMindCommand, shouldSkipClaudePermissions } from '../src/commands/hive-mind.js';

const shouldSkipPermissions = shouldSkipClaudePermissions;

describe('#2269 hive-mind --dangerously-skip-permissions flag handling', () => {
  it('defaults the registered hive-mind spawn command to safe permission handling', () => {
    const parser = new CommandParser();
    parser.registerCommand(hiveMindCommand);

    const { flags } = parser.parse(['hive-mind', 'spawn', 'workers']);

    expect(flags.dangerouslySkipPermissions).toBe(false);
    expect(shouldSkipPermissions(flags as Record<string, unknown>)).toBe(false);
  });

  it('enables bypass only after an explicit opt-in on the registered command', () => {
    const parser = new CommandParser();
    parser.registerCommand(hiveMindCommand);

    const { flags } = parser.parse([
      'hive-mind', 'spawn', 'workers', '--dangerously-skip-permissions',
    ]);

    expect(shouldSkipPermissions(flags as Record<string, unknown>)).toBe(true);
  });
  it('parser normalizes the kebab flag to camelCase and leaves the kebab key undefined', () => {
    const parser = new CommandParser({ allowUnknownFlags: true });
    const { flags } = parser.parse(['--dangerously-skip-permissions']);

    // This is the heart of the bug: reading the kebab key alone is always
    // undefined because the parser stores the normalized key.
    expect(flags['dangerously-skip-permissions']).toBeUndefined();
    expect(flags.dangerouslySkipPermissions).toBe(true);
  });

  it('skipPermissions=true when the CLI passes --dangerously-skip-permissions', () => {
    const parser = new CommandParser({ allowUnknownFlags: true });
    const { flags } = parser.parse(['--dangerously-skip-permissions']);

    expect(shouldSkipPermissions(flags as Record<string, unknown>)).toBe(true);
  });

  it('skipPermissions=false when --no-auto-permissions is also passed', () => {
    const parser = new CommandParser({ allowUnknownFlags: true });
    const { flags } = parser.parse([
      '--dangerously-skip-permissions',
      '--no-auto-permissions',
    ]);

    expect(shouldSkipPermissions(flags as Record<string, unknown>)).toBe(false);
  });

  it('skipPermissions=false when neither key is set', () => {
    expect(shouldSkipPermissions({})).toBe(false);
  });

  it('predicate accepts the camelCase key directly (parser-independent contract)', () => {
    // Belt-and-braces: even if a future caller hand-constructs the flags
    // object with only the camelCase key, the predicate still works.
    expect(shouldSkipPermissions({ dangerouslySkipPermissions: true })).toBe(true);
    expect(shouldSkipPermissions({
      dangerouslySkipPermissions: true,
      noAutoPermissions: true,
    })).toBe(false);
  });

  it('predicate still accepts the legacy kebab key (back-compat with hand-built flag maps)', () => {
    // Some callers (tests, programmatic invocations) may build the flags
    // object manually with the kebab key. The fix is intentionally a dual
    // read, so this path keeps working.
    expect(shouldSkipPermissions({ 'dangerously-skip-permissions': true })).toBe(true);
  });

  it('parser produces the yargs-style negation autoPermissions:false for --no-auto-permissions', () => {
    // This pins the parser contract that drives the deny-clause third term.
    // If the parser ever changes its negation idiom (e.g. starts storing
    // noAutoPermissions:true instead), this test fails BEFORE the predicate
    // silently goes back to ignoring --no-auto-permissions in production.
    const parser = new CommandParser({ allowUnknownFlags: true });
    const { flags } = parser.parse(['--no-auto-permissions']);
    expect(flags.autoPermissions).toBe(false);
    expect(flags['no-auto-permissions']).toBeUndefined();
    expect(flags.noAutoPermissions).toBeUndefined();
  });

  it('predicate denies when only the yargs-style negation key is set', () => {
    // Belt-and-braces for the parser-produced shape, independent of the
    // CLI integration test above.
    expect(shouldSkipPermissions({
      dangerouslySkipPermissions: true,
      autoPermissions: false,
    })).toBe(false);
  });

  it('predicate ignores autoPermissions:true (a positive autoPermissions does NOT enable skip on its own)', () => {
    // Guard against an over-broad reading of the third term: only
    // autoPermissions === false should be treated as the negation signal.
    expect(shouldSkipPermissions({ autoPermissions: true })).toBe(false);
    // And it still allows skip when the negation is absent.
    expect(shouldSkipPermissions({
      dangerouslySkipPermissions: true,
      autoPermissions: true,
    })).toBe(true);
  });
});
