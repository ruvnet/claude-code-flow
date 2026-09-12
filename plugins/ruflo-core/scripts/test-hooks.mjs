#!/usr/bin/env node
/**
 * Regression guard for ruvnet/ruflo#1859, #1862, #2721, #2816, #2856.
 *
 * Drives every hook command from `hooks/hooks.json` — PreToolUse,
 * PostToolUse, PreCompact, Stop — with synthetic Claude-Code-style stdin,
 * against a locally built CLI, executed EXACTLY as Claude Code/Codex would
 * run it: `spawnSync(command, { shell: true, ... })`, no bash wrapper of
 * our own. That's the point of this rewrite (#2721) — the old version
 * spawned `bash -c <cmd>` itself, which meant it could never have caught
 * the `/bin/bash` literal breaking on native Windows; `shell: true` uses
 * cmd.exe on Windows and /bin/sh elsewhere, matching the real hook runner.
 *
 * Two env vars steer the shim (see ../scripts/ruflo-hook.cjs) at the build
 * under test instead of whatever's on the runner's PATH:
 *   - CLAUDE_PLUGIN_ROOT       — resolves ruflo-hook.cjs's own path (real
 *                                per-hook-invocation env var, always set)
 *   - RUFLO_HOOK_CLI_OVERRIDE  — bypasses the ruflo/claude-flow/npx PATH
 *                                probe so the test exercises the exact
 *                                flag wiring users hit, pinned to the
 *                                build under test (test-only escape hatch)
 *
 * Asserts:
 *   - Exit code 0 (no parser errors like "Invalid value for --format")
 *   - Output records the *intended* value (the file path / command), not a
 *     stray boolean like "true" — the symptom that #1859 reported
 *   - Cursor PreToolUse hooks emit valid `{"permission":"allow"}` JSON
 *   - Codex PreToolUse hooks exit 0 with empty stdout, while both telemetry
 *     subcommands are still invoked (#2816)
 *   - PostToolUse hooks silently no-op (exit 0, no CLI call) when the
 *     expected field is missing from the event JSON
 *   - Malformed / empty stdin never causes a nonzero exit
 *
 * Usage (from repo root):
 *   node plugins/ruflo-core/scripts/test-hooks.mjs <path-to-cli-binary>
 *
 * Wired into .github/workflows/v3-ci.yml as the `plugin-hooks-smoke` job
 * (windows-latest, macos-latest, ubuntu-latest).
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const HOOKS_JSON = join(PLUGIN_ROOT, 'hooks', 'hooks.json');
const HOOK_RECORDER = join(__dirname, 'fixtures', 'hook-cli-recorder.cjs');

// `cliInvoke` is the literal token-string that should run the CLI — caller
// passes the full thing so this script doesn't need to guess shebangs:
//   - local node script:   "node /abs/path/to/bin/cli.js"
//   - npx fallthrough:     "npx --yes @claude-flow/cli@latest"
const cliInvoke = process.argv[2];
if (!cliInvoke) {
  console.error('Usage: node test-hooks.mjs "<cli-invocation-string>"');
  console.error('Examples:');
  console.error('  node test-hooks.mjs "node $PWD/v3/@claude-flow/cli/bin/cli.js"');
  console.error('  node test-hooks.mjs "npx --yes @claude-flow/cli@latest"');
  process.exit(2);
}

const hooks = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));

const findHook = (event, matcher) => {
  const list = hooks.hooks?.[event] ?? [];
  const hit = matcher === undefined ? list[0] : list.find(h => h.matcher === matcher);
  if (!hit) throw new Error(`No ${event} hook with matcher=${matcher}`);
  return hit.hooks[0].command;
};

const cmdModifyBash = findHook('PreToolUse', 'Bash');
const cmdModifyFile = findHook('PreToolUse', 'Write|Edit|MultiEdit');
const cmdPostCommand = findHook('PostToolUse', 'Bash');
const cmdPostEdit = findHook('PostToolUse', 'Write|Edit|MultiEdit');
const cmdPrecompactManual = findHook('PreCompact', 'manual');
const cmdPrecompactAuto = findHook('PreCompact', 'auto');
const cmdStop = findHook('Stop', undefined);

let failed = 0;
const cases = [];

const run = (name, cmd, stdin, assertions, options = {}) => {
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    RUFLO_HOOK_SKIP_NPX: '1',
    ...options.env,
  };
  if (!options.useResolver) env.RUFLO_HOOK_CLI_OVERRIDE = options.cliOverride ?? cliInvoke;
  for (const key of options.unsetEnv ?? []) delete env[key];
  if (options.debug !== false) env.RUFLO_HOOK_DEBUG_STDOUT = '1';
  else delete env.RUFLO_HOOK_DEBUG_STDOUT;

  const r = spawnSync(cmd, {
    shell: true,
    input: stdin,
    encoding: 'utf8',
    env,
    // A clean CI runner may spend more than 15 seconds starting the CLI and
    // policy/memory backends for its first Edit hook. Keep a finite timeout,
    // but allow that measured cold-start path to complete.
    timeout: 30_000,
  });
  const combined = (r.stdout ?? '') + (r.stderr ?? '');
  const errors = [];
  if (r.error) errors.push(`spawn error: ${r.error.message}`);
  if (r.status !== 0) errors.push(`exit ${r.status} (expected 0)`);
  for (const a of assertions) {
    if (a.contains && !combined.includes(a.contains)) errors.push(`missing "${a.contains}" in output`);
    if (a.absent && combined.includes(a.absent)) errors.push(`unexpected "${a.absent}" in output`);
    if (Object.hasOwn(a, 'stdoutEquals') && (r.stdout ?? '') !== a.stdoutEquals) {
      errors.push(`stdout was ${JSON.stringify(r.stdout ?? '')}, expected ${JSON.stringify(a.stdoutEquals)}`);
    }
  }
  if (errors.length === 0) {
    console.log(`ok: ${name}`);
  } else {
    console.error(`FAIL: ${name}`);
    for (const e of errors) console.error(`     - ${e}`);
    if (combined.trim()) {
      console.error('     output:');
      for (const line of combined.split('\n').slice(0, 8)) console.error(`       ${line}`);
    }
    failed++;
  }
  cases.push(name);
};

// --- PreToolUse: modify-bash / modify-file ---
const cursorEnv = { unsetEnv: ['PLUGIN_ROOT', 'PLUGIN_DATA'] };
const codexEnv = {
  env: {
    PLUGIN_ROOT,
    PLUGIN_DATA: join(PLUGIN_ROOT, '.test-data'),
  },
  cliOverride: `${process.execPath} ${HOOK_RECORDER}`,
};

run('Cursor PreToolUse (Bash) emits permission-allow JSON',
  cmdModifyBash,
  '{"tool_input":{"command":"echo hi"}}',
  [{ contains: '{"permission":"allow"}' }],
  cursorEnv);

run('Cursor PreToolUse (Edit) emits permission-allow JSON',
  cmdModifyFile,
  '{"tool_input":{"file_path":"/tmp/foo.ts"}}',
  [{ contains: '{"permission":"allow"}' }],
  cursorEnv);

run('Cursor PreToolUse (Bash) emits permission-allow even with empty stdin',
  cmdModifyBash,
  '',
  [{ contains: '{"permission":"allow"}' }],
  cursorEnv);

run('Cursor PreToolUse (Bash) emits permission-allow even with malformed JSON',
  cmdModifyBash,
  '{not json',
  [{ contains: '{"permission":"allow"}' }],
  cursorEnv);

run('Codex PreToolUse (Bash) exits 0 with empty stdout',
  cmdModifyBash,
  '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo hi"}}',
  [{ stdoutEquals: '' }],
  { ...codexEnv, debug: false });

run('Codex PreToolUse (Edit) exits 0 with empty stdout',
  cmdModifyFile,
  '{"hook_event_name":"PreToolUse","tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch"}}',
  [{ stdoutEquals: '' }],
  { ...codexEnv, debug: false });

run('Codex PreToolUse (Bash) still invokes telemetry',
  cmdModifyBash,
  '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo hi"}}',
  [{ contains: 'hook-telemetry:modify-bash' }, { absent: '{"permission":"allow"}' }],
  codexEnv);

run('Codex PreToolUse (Edit) still invokes telemetry',
  cmdModifyFile,
  '{"hook_event_name":"PreToolUse","tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch"}}',
  [{ contains: 'hook-telemetry:modify-file' }, { absent: '{"permission":"allow"}' }],
  codexEnv);

// Rule 21: host hook environments are allowed to sanitize PATH, but that must
// never make the shim download and execute a second Ruflo through npx. The
// canonical global install is a real resolution source, not merely a PATH
// convention. Exercise the resolver without the test-only CLI override.
{
  const home = mkdtempSync(join(tmpdir(), 'ruflo-hook-global-home-'));
  const binDir = join(home, '.npm-global', 'bin');
  mkdirSync(binDir, { recursive: true });
  const globalRuflo = join(binDir, process.platform === 'win32' ? 'ruflo.cmd' : 'ruflo');
  if (process.platform === 'win32') {
    writeFileSync(globalRuflo, `@echo canonical-global-ruflo\r\n@"${process.execPath}" "${HOOK_RECORDER}" %*\r\n`);
  } else {
    writeFileSync(globalRuflo, `#!${process.execPath}\nconsole.log('canonical-global-ruflo');\nrequire(${JSON.stringify(HOOK_RECORDER)});\n`);
    chmodSync(globalRuflo, 0o755);
  }
  try {
    run('sanitized PATH still uses the one canonical global Ruflo',
      cmdModifyBash,
      '{"hook_event_name":"PreToolUse","turn_id":"turn_global_ruflo","tool_name":"Bash","tool_input":{"command":"echo hi"}}',
      [{ contains: 'canonical-global-ruflo' }, { contains: 'hook-telemetry:modify-bash' }],
      {
        useResolver: true,
        env: {
          HOME: home,
          USERPROFILE: home,
          PATH: dirname(process.execPath),
          PLUGIN_ROOT,
          PLUGIN_DATA: join(PLUGIN_ROOT, '.test-data'),
        },
      });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

{
  const home = mkdtempSync(join(tmpdir(), 'ruflo-hook-no-global-home-'));
  const trapBin = join(home, 'trap-bin');
  mkdirSync(trapBin, { recursive: true });
  const npxTrap = join(trapBin, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  if (process.platform === 'win32') {
    writeFileSync(npxTrap, '@echo forbidden-npx-ruflo\r\n');
  } else {
    writeFileSync(npxTrap, '#!/bin/sh\necho forbidden-npx-ruflo\n');
    chmodSync(npxTrap, 0o755);
  }
  try {
    run('missing global Ruflo never downloads a private npx copy',
      cmdModifyBash,
      '{"hook_event_name":"PreToolUse","turn_id":"turn_no_npx","tool_name":"Bash","tool_input":{"command":"echo hi"}}',
      [{ absent: 'forbidden-npx-ruflo' }],
      {
        useResolver: true,
        env: {
          HOME: home,
          USERPROFILE: home,
          PATH: `${trapBin}${process.platform === 'win32' ? ';' : ':'}${dirname(process.execPath)}`,
          PLUGIN_ROOT,
          PLUGIN_DATA: join(PLUGIN_ROOT, '.test-data'),
          RUFLO_HOOK_SKIP_NPX: '0',
        },
      });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// #2856 — Codex's PLUGIN_ROOT/PLUGIN_DATA env vars may not be present on
// every install/config path; the `turn_id` field Codex always includes in
// the hook event JSON is a documented Codex-only extension and must be
// enough on its own to suppress the Cursor-shaped permission object.
const codexTurnIdOnlyEnv = { unsetEnv: ['PLUGIN_ROOT', 'PLUGIN_DATA'] };

run('Codex PreToolUse (Bash) detected via turn_id alone (no PLUGIN_ROOT/PLUGIN_DATA) exits 0 with empty stdout',
  cmdModifyBash,
  '{"hook_event_name":"PreToolUse","turn_id":"turn_2856","model":"gpt-5.6-sol","tool_name":"Bash","tool_input":{"command":"echo hi"}}',
  [{ stdoutEquals: '' }],
  { ...codexTurnIdOnlyEnv, debug: false });

run('Cursor PreToolUse (Bash) without turn_id still emits permission-allow JSON',
  cmdModifyBash,
  '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo hi"}}',
  [{ contains: '{"permission":"allow"}' }],
  codexTurnIdOnlyEnv);

// --- PostToolUse: post-edit ---
run('Edit hook records file_path (regression #1859: was "true")',
  cmdPostEdit,
  '{"tool_input":{"file_path":"/tmp/foo.ts"}}',
  [{ contains: '/tmp/foo.ts' }, { absent: 'Recording outcome for: true' }, { absent: 'Invalid value' }]);

run('Edit hook records legacy "path" field',
  cmdPostEdit,
  '{"tool_input":{"path":"/tmp/bar.ts"}}',
  [{ contains: '/tmp/bar.ts' }, { absent: 'Invalid value' }]);

run('Edit hook silently no-ops when no path present',
  cmdPostEdit,
  '{"tool_input":{}}',
  []);

run('Edit hook silently no-ops on malformed JSON',
  cmdPostEdit,
  '{not json',
  []);

// --- PostToolUse: post-command ---
run('Bash hook records simple command',
  cmdPostCommand,
  '{"tool_input":{"command":"echo hi"},"tool_response":{"exit_code":0}}',
  [{ contains: 'echo hi' }, { absent: 'Required option missing' }, { absent: 'Invalid value' }]);

run('Bash hook records multi-line heredoc (regression #1859)',
  cmdPostCommand,
  '{"tool_input":{"command":"cat <<EOF\\nline1\\nline2\\nEOF"},"tool_response":{"exit_code":0}}',
  [{ contains: 'cat <<EOF' }, { absent: 'Required option missing' }]);

run('Bash hook records non-zero exit (distinct from -s value)',
  cmdPostCommand,
  '{"tool_input":{"command":"echo failing-cmd"},"tool_response":{"exit_code":1}}',
  [{ contains: 'echo failing-cmd' }, { absent: 'Recording command outcome: false' }, { absent: 'Recording command outcome: true' }]);

run('Bash hook silently no-ops when no command present',
  cmdPostCommand,
  '{"tool_input":{},"tool_response":{}}',
  []);

run('Bash hook silently no-ops on empty stdin',
  cmdPostCommand,
  '',
  []);

// --- PreCompact: pure guidance text, no CLI call ---
run('PreCompact (manual) prints guidance and includes custom instructions',
  cmdPrecompactManual,
  '{"custom_instructions":"focus on the auth module"}',
  [{ contains: 'PreCompact Guidance' }, { contains: 'focus on the auth module' }]);

run('PreCompact (manual) prints guidance with no custom instructions',
  cmdPrecompactManual,
  '{}',
  [{ contains: 'PreCompact Guidance' }, { absent: 'Custom compact instructions' }]);

run('PreCompact (auto) prints guidance',
  cmdPrecompactAuto,
  '',
  [{ contains: 'Auto-Compact Guidance' }]);

// --- Stop: session-end ---
run('Stop hook runs session-end without error',
  cmdStop,
  '{}',
  [{ absent: 'Required option missing' }, { absent: 'Invalid value' }]);

// #2640 — project settings + marketplace plugin can dispatch the same event.
// The shared atomic claim makes the second side-effecting invocation a no-op.
{
  const dedupDir = mkdtempSync(join(tmpdir(), 'ruflo-hook-dedup-test-'));
  const payload = '{"tool_use_id":"toolu_dedup_2640","tool_input":{"file_path":"/tmp/dedup.ts"}}';
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    CLAUDE_PROJECT_DIR: PLUGIN_ROOT,
    RUFLO_HOOK_CLI_OVERRIDE: `${process.execPath} ${HOOK_RECORDER}`,
    RUFLO_HOOK_DEBUG_STDOUT: '1',
    RUFLO_HOOK_SKIP_NPX: '1',
    RUFLO_HOOK_DEDUP_DIR: dedupDir,
  };
  try {
    const first = spawnSync(cmdPostEdit, { shell: true, input: payload, encoding: 'utf8', env });
    const second = spawnSync(cmdPostEdit, { shell: true, input: payload, encoding: 'utf8', env });
    const ok = first.status === 0 && second.status === 0 &&
      (first.stdout || '').includes('hook-telemetry:post-edit') &&
      !(second.stdout || '').includes('hook-telemetry:post-edit');
    if (ok) {
      console.log('ok: duplicate post-edit event executes side effects exactly once');
    } else {
      console.error('FAIL: duplicate post-edit event was not deduplicated');
      failed++;
    }
    cases.push('duplicate post-edit event executes side effects exactly once');
  } finally {
    rmSync(dedupDir, { recursive: true, force: true });
  }
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);
