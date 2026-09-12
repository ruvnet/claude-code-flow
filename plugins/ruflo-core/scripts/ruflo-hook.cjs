#!/usr/bin/env node
/**
 * ruflo-hook.cjs — cross-platform Node.js port of ruflo-hook.sh (#2132, #2721)
 *
 * The bash shim (ruflo-hook.sh) works on Mac/Linux but fails outright on
 * native Windows: hooks.json wrapped it in `/bin/bash -c '...'`, and
 * `/bin/bash` is not a valid Windows path — Codex/Claude Code report
 * "PreToolUse hook (failed) — exit code 1" on every tool call (#2721).
 *
 * This file is now the ONLY hook implementation `hooks.json` invokes, on
 * every OS (see the `node -e` bootstrap command in ../hooks/hooks.json).
 * It replicates, in pure Node with no shell/jq dependency:
 *   - modify-bash / modify-file  (PreToolUse)  — best-effort CLI call, then
 *     emit `{"permission":"allow"}` for Cursor/Claude compatibility. Codex
 *     plugin hooks are detected by their Codex-specific PLUGIN_ROOT /
 *     PLUGIN_DATA variables, falling back to the `turn_id` field Codex
 *     always includes in the hook event JSON, and intentionally receive
 *     empty stdout: a bare Cursor permission object is not valid Codex
 *     hook JSON and is rejected with "hook returned invalid pre-tool-use
 *     JSON output" (#2816, #2856).
 *   - post-command / post-edit  (PostToolUse)  — parse the hook event JSON
 *     from stdin (no jq), extract the same fields the bash version pulled
 *     with jq, and forward them as CLI flags.
 *   - precompact-manual / precompact-auto  (PreCompact) — static guidance
 *     text, no CLI call at all (matches the bash version's plain echoes).
 *   - session-end  (Stop) — forwarded as-is, same flags as before.
 *
 * Shared behaviour:
 *   1. Prefers the one canonical global Ruflo, then a PATH-installed
 *      `ruflo` or `claude-flow` binary.
 *   2. Never downloads a private npx copy from a hook invocation.
 *   3. ALWAYS exits 0 — hook subcommands are best-effort telemetry; a
 *      failure must never surface an error or block a turn.
 *   4. Swallows all stdout/stderr from the invoked CLI.
 *
 * Usage: node ruflo-hook.cjs <hook-subcommand>
 *   (invoked via the `node -e` bootstrap in hooks.json, which resolves
 *   this script's path from `process.env.CLAUDE_PLUGIN_ROOT` — no shell
 *   env-var expansion needed, so there is no `${VAR}` vs `%VAR%` split)
 */

'use strict';

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/** Exit 0 unconditionally — hooks must never block a turn */
function done() {
  process.exit(0);
}

/** Check if a binary is available on PATH */
function commandExists(cmd) {
  try {
    const result = execSync(
      process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the one canonical global Ruflo even when a host sanitizes PATH.
 * Hook execution must not manufacture a second CLI under ~/.npm/_npx.
 */
function canonicalGlobalRuflo() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const candidate = path.join(home, '.npm-global', 'bin', process.platform === 'win32' ? 'ruflo.cmd' : 'ruflo');
  try {
    fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Spawn the CLI with the hook subcommand + args, forwarding stdinData.
 * Returns true on success (exit 0), false otherwise. Never throws.
 */
function invokeHook(bin, binArgs, hookSubcommand, hookArgs, stdinData) {
  const args = [...binArgs, 'hooks', hookSubcommand, ...hookArgs];
  // On Windows, shell: true is needed to resolve .cmd/.ps1 shims that npm
  // creates for globally-installed bins (`ruflo`, `claude-flow`, `npx`) —
  // CreateProcess cannot execute those directly. BUT shell:true hands the
  // whole command line to cmd.exe, which re-tokenizes it (no automatic
  // quoting of array elements), corrupting any argument containing spaces
  // or shell metacharacters — e.g. a `post-command` value of "echo hi"
  // silently truncates to "echo", and a heredoc value containing `<<`
  // errors outright. `node` itself is always a real .exe (never a shim),
  // so skip the shell entirely there — CreateProcess gets the argv array
  // verbatim, byte-for-byte, no re-tokenization possible. This covers the
  // common `node <cli.js>` invocation (test harness, npx-resolved runs).
  // A real global `ruflo`/`claude-flow` install still goes through the
  // shim path below and inherits cmd.exe's pre-existing argv-mangling
  // limitation for complex values — not a regression from this change,
  // just not fully solved by it; tracked as a follow-up.
  const useShell = process.platform === 'win32' && bin !== 'node' && bin !== process.execPath;
  // Test-only: RUFLO_HOOK_DEBUG_STDOUT surfaces the invoked CLI's own
  // stdout/stderr instead of swallowing them, so test-hooks.mjs can assert
  // on the CLI's actual recorded value (e.g. catching #1859/#1862-style
  // flag-wiring regressions). Production never sets this — hooks must
  // never leak CLI output into the host (Cursor's PreToolUse contract).
  const debug = process.env.RUFLO_HOOK_DEBUG_STDOUT === '1';
  try {
    const result = spawnSync(bin, args, {
      shell: useShell,
      input: stdinData || '',
      encoding: 'utf8',
      stdio: debug ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'ignore', 'ignore'],
      timeout: 30_000,
    });
    if (debug) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Best-effort: try the canonical global, then PATH. Never downloads. */
function invokeCli(hookSubcommand, hookArgs, stdinData) {
  // Test-only escape hatch: point at a specific local build instead of the
  // commandExists() PATH probe (used by test-hooks.mjs and the plugin-hooks
  // real-command smoke so tests exercise the build under test, not whatever
  // happens to be on the runner's PATH). Space-split — always a simple
  // "node /abs/path/cli.js" invocation in practice, never quoted args.
  const override = process.env.RUFLO_HOOK_CLI_OVERRIDE;
  if (override) {
    const [bin, ...binArgs] = override.split(' ').filter(Boolean);
    invokeHook(bin, binArgs, hookSubcommand, hookArgs, stdinData);
    return;
  }
  const canonical = canonicalGlobalRuflo();
  if (canonical) {
    invokeHook(canonical, [], hookSubcommand, hookArgs, stdinData);
    return;
  }
  if (commandExists('ruflo')) {
    invokeHook('ruflo', [], hookSubcommand, hookArgs, stdinData);
    return;
  }
  if (commandExists('claude-flow')) {
    invokeHook('claude-flow', [], hookSubcommand, hookArgs, stdinData);
    return;
  }
  // Telemetry is best-effort. If the global CLI is absent, no-op instead of
  // installing or running an untracked second Ruflo from the npx cache.
}

/** Read all of stdin synchronously. Returns '' on any failure (best effort). */
function readStdinRaw() {
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let buf = '';
    let bytesRead;
    while (true) {
      try {
        bytesRead = fs.readSync(0 /* STDIN_FILENO */, chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        buf += chunk.slice(0, bytesRead).toString('utf8');
      } catch {
        break;
      }
    }
    return buf;
  } catch {
    return '';
  }
}

/** Parse stdinData as JSON, returning {} on any parse failure. */
function parseEventJson(stdinData) {
  try {
    const trimmed = (stdinData || '').trim();
    return trimmed ? JSON.parse(trimmed) : {};
  } catch {
    return {};
  }
}

/**
 * Project-installed hooks and marketplace-plugin hooks can receive the same
 * event. Claim side-effecting events atomically so post-edit learning and
 * session-end consolidation execute exactly once (#2640).
 */
function claimSideEffectEvent(family, stdinData, event) {
  if (/^(1|true|yes|on)$/i.test(process.env.RUFLO_DISABLE_HOOK_DEDUP || '')) return true;
  try {
    const eventId = event?.tool_use_id || event?.toolUseId ||
      event?.session_id || event?.sessionId || event?.hook_event_id;
    const payloadIdentity = eventId
      ? `event:${eventId}`
      : `payload:${(stdinData || '').trim()}|bucket:${Math.floor(Date.now() / 2000)}`;
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const digest = crypto.createHash('sha256')
      .update(`ruflo-hook-dedup-v1\0${path.resolve(projectRoot)}\0${family}\0${payloadIdentity}`)
      .digest('hex');
    const dir = process.env.RUFLO_HOOK_DEDUP_DIR ||
      path.join(os.tmpdir(), 'ruflo-hook-dedup-v1');
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(path.join(dir, digest), 'wx', 0o600);
    fs.writeFileSync(fd, String(Date.now()));
    fs.closeSync(fd);
    return true;
  } catch (error) {
    return error?.code === 'EEXIST' ? false : true;
  }
}

/**
 * Codex sets PLUGIN_ROOT and PLUGIN_DATA for plugin-bundled hooks, in
 * addition to the cross-host CLAUDE_PLUGIN_* compatibility variables.
 * Cursor and Claude Code use CLAUDE_PLUGIN_ROOT without these Codex-specific
 * variables. Keep this positive Codex check narrow so existing Cursor
 * installations retain their permission response.
 *
 * Fallback: Codex's PreToolUse input JSON always carries a `turn_id` string
 * field (verified against codex-rs' pre-tool-use.command.input schema —
 * it is Codex's own documented extension, not present in Claude Code's or
 * Cursor's hook payloads). This catches any install/config path where the
 * PLUGIN_ROOT/PLUGIN_DATA env vars aren't injected, so a stray Cursor-shaped
 * `{"permission":"allow"}` object never reaches Codex's stricter parser
 * (#2856): Codex's output_parser rejects unknown top-level keys outright
 * and reports "hook returned invalid pre-tool-use JSON output" for any
 * JSON-shaped stdout it can't fit into its schema, whereas empty stdout is
 * treated as no-opinion/implicit-allow with no error.
 */
function isCodexPluginHost(event) {
  if (process.env.PLUGIN_ROOT || process.env.PLUGIN_DATA) return true;
  return typeof event?.turn_id === 'string' && event.turn_id.length > 0;
}

/**
 * PreCompact guidance text — matches the bash `echo` lines verbatim.
 * Not a CLI call at all; pure stdout guidance for the transcript/context.
 */
function precompactManual(event) {
  const custom = typeof event?.custom_instructions === 'string' ? event.custom_instructions : '';
  const lines = [
    '🔄 PreCompact Guidance:',
    '📋 IMPORTANT: Review CLAUDE.md in project root for:',
    '   • 54 available agents and concurrent usage patterns',
    '   • Swarm coordination strategies (hierarchical, mesh, adaptive)',
    '   • SPARC methodology workflows with batchtools optimization',
    '   • Critical concurrent execution rules (GOLDEN RULE: 1 MESSAGE = ALL OPERATIONS)',
  ];
  if (custom) lines.push(`🎯 Custom compact instructions: ${custom}`);
  lines.push('✅ Ready for compact operation');
  process.stdout.write(lines.join('\n') + '\n');
}

function precompactAuto() {
  const lines = [
    '🔄 Auto-Compact Guidance (Context Window Full):',
    '📋 CRITICAL: Before compacting, ensure you understand:',
    '   • All 54 agents available in .claude/agents/ directory',
    '   • Concurrent execution patterns from CLAUDE.md',
    '   • Batchtools optimization for 300% performance gains',
    '   • Swarm coordination strategies for complex tasks',
    '⚡ Apply GOLDEN RULE: Always batch operations in single messages',
    '✅ Auto-compact proceeding with full agent context',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

function main() {
  const [subcommand] = process.argv.slice(2);
  if (!subcommand) done(); // no subcommand — no-op, same as bash version

  // PreCompact: pure guidance text, no CLI call, no stdin required beyond
  // (optionally) custom_instructions for the manual variant.
  if (subcommand === 'precompact-manual') {
    precompactManual(parseEventJson(readStdinRaw()));
    done();
  }
  if (subcommand === 'precompact-auto') {
    precompactAuto();
    done();
  }

  const stdinData = readStdinRaw();
  const event = parseEventJson(stdinData);

  if ((subcommand === 'post-edit' || subcommand === 'session-end') &&
      !claimSideEffectEvent(subcommand, stdinData, event)) {
    done();
  }

  // PostToolUse: derive CLI flags from the hook event JSON (replaces jq).
  if (subcommand === 'post-command') {
    const cmd = event?.tool_input?.command;
    if (!cmd) done(); // bash version: `[ -z "$CMD" ] && exit 0`
    const exitCode = event?.tool_response?.exit_code ?? 0;
    invokeCli('post-command', ['-c', String(cmd), '-s', String(exitCode === 0), '-e', String(exitCode)], stdinData);
    done();
  }
  if (subcommand === 'post-edit') {
    const file = event?.tool_input?.file_path ?? event?.tool_input?.path;
    if (!file) done(); // bash version: `[ -z "$FILE" ] && exit 0`
    invokeCli('post-edit', ['-f', String(file), '-s', 'true'], stdinData);
    done();
  }

  // PreToolUse: telemetry always runs. Cursor retains its permission verdict;
  // Codex unconditional allow is exit 0 with empty stdout (#2816).
  if (subcommand === 'modify-bash' || subcommand === 'modify-file') {
    invokeCli(subcommand, [], stdinData);
    if (!isCodexPluginHost(event)) {
      process.stdout.write('{"permission":"allow"}');
    }
    done();
  }

  // Stop / session-end and anything else: forward remaining argv unchanged
  // (matches ruflo-hook.sh's generic `ruflo hooks "$@"` passthrough).
  const extraArgs = process.argv.slice(3);
  invokeCli(subcommand, extraArgs, stdinData);
  done();
}

main();
