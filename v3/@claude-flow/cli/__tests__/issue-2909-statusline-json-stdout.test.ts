/**
 * Regression coverage for issue #2909: `hooks statusline --json` interleaved
 * diagnostics with its payload on **stdout**, so callers doing
 * `JSON.parse(stdout)` failed with `Unexpected token 'W', "[WARN] Fail"...`.
 * ruflo's own V3 statusline helper parses this command's stdout and calls it
 * the single source of truth, so a polluted line silently demoted it to the
 * local file probes that #2195 existed to remove.
 *
 * Current source routes every diagnostic to stderr (`OutputFormatter.printInfo`
 * / `printWarning` → `writeErrorln`), so this is a regression guard, not a
 * reproduction. `output.test.ts` already asserts that routing at the unit level
 * by spying on the streams; the gap this closes is end-to-end, on a real
 * process, where anything else writing to stdout also counts.
 *
 * Two conditions have to be forced, and both are easy to get wrong:
 *
 *  1. **A daemon must actually start.** `daemon-autostart.ts` gates on
 *     `isRufloProject()`, so a bare `mkdtemp` directory yields
 *     `{ started: false, reason: 'not a ruflo project' }` and never emits the
 *     `[INFO] Started Ruflo background daemon` line at all. Each case plants a
 *     `.claude-flow/config.json` marker so autostart is genuinely exercised.
 *  2. **The directory must be cold.** Autostart is single-instance per cwd, so
 *     a reused directory returns clean JSON regardless of routing. Each case
 *     gets its own directory.
 *
 * The notice is also a race against daemon readiness rather than a
 * deterministic "first call only" event, so the cold case asserts across three
 * sequential invocations; correct routing passes all three every time.
 *
 * The CLI is spawned as a real subprocess because the routing under test is a
 * property of the process's streams, not of any exported function.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'bin', 'cli.js');
// `bin/cli.js` is tracked, so its presence proves nothing; the build artifact it
// imports is the gitignored one. Standard flow is `npm run build && npm test`.
const CLI_BUILT = fs.existsSync(path.resolve(HERE, '..', 'dist', 'src', 'index.js'));

/** Any OutputFormatter level prefix. None of them belongs on stdout. */
const DIAGNOSTIC_MARKER = /\[(?:WARN|INFO|ERROR|DEBUG|TRACE)\]/;

const tempDirs: string[] = [];

/**
 * A directory that (a) no daemon has claimed yet and (b) autostart recognises
 * as a ruflo project, so the run is genuinely cold rather than skipped.
 *
 * `realpathSync` matters: on macOS `os.tmpdir()` reports `/var/folders/...`, a
 * symlink to `/private/var/folders/...`, and the daemon keys its lock on the
 * resolved cwd. Resolving up front keeps "fresh directory" and "cold daemon"
 * the same statement on every platform.
 */
function freshRufloCwd(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ruflo-2909-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.claude-flow'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-flow', 'config.json'), '{}', 'utf8');
  return dir;
}

function statuslineStdout(cwd: string): string {
  return execFileSync('node', [CLI, 'hooks', 'statusline', '--json'], {
    cwd,
    input: JSON.stringify({ model: { display_name: 'Sonnet 4.6 (1M context)' } }),
    encoding: 'utf8',
    // stderr is piped, not inherited: diagnostics legitimately belong there, so
    // capturing them keeps a passing run quiet while still failing this test on
    // anything that reaches stdout.
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Keep the run off the developer's real install: helper auto-refresh
      // writes to ~/.claude/helpers and funnel state to ~/.ruflo.
      HOME: cwd,
      USERPROFILE: cwd,
      RUFLO_STATE_DIR: path.join(cwd, '.ruflo-state'),
      // `checkForUpdatesOnStartup` is fire-and-forget, network-bound, and writes
      // to stdout via `writeln` with no level prefix — a genuine flake source
      // that the regex would miss and the raw parse would catch at random.
      CLAUDE_FLOW_AUTO_UPDATE: 'false',
      CI: 'true',
    },
    timeout: 60_000,
  });
}

function assertStdoutIsOnlyJson(raw: string, label: string): void {
  // Parsed whole, deliberately without an `indexOf('{')` slice: the contract is
  // that stdout *is* the JSON document, not that a JSON document can be
  // recovered from somewhere inside it. Slicing — as a sibling statusline test
  // does — passes on the build that prompted this issue.
  expect(() => JSON.parse(raw), `${label}: stdout was not JSON: ${raw.slice(0, 160)}`).not.toThrow();
  expect(raw, `${label}: stdout carried a diagnostic`).not.toMatch(DIAGNOSTIC_MARKER);
}

// Explicit hook timeout: every case leaves a real detached daemon behind, and
// stopping them exceeds vitest's 10s hook default.
afterAll(() => {
  for (const dir of tempDirs) {
    // Stop before removing: the daemon holds its cwd, so on Windows `rmSync`
    // first can fail outright. Defaults are a 12h hard TTL / 30m idle, so
    // leaving them would hold one process per case for that window.
    try {
      execFileSync('node', [CLI, 'daemon', 'stop'], {
        cwd: dir,
        stdio: 'ignore',
        timeout: 20_000,
      });
    } catch {
      /* already gone, or never started */
    }
    try {
      // Retries because a stopping daemon can still hold the directory for a
      // moment on Windows (EPERM/EBUSY). Swallowed entirely: a leftover temp
      // directory is inconsequential, and cleanup must never turn a suite whose
      // assertions passed into a red one.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* the OS temp sweeper can have it */
    }
  }
}, 120_000);

describe.skipIf(!CLI_BUILT)('hooks statusline --json keeps stdout parseable — issue #2909', () => {
  it(
    'emits only JSON on stdout while the daemon autostarts',
    () => {
      const dir = freshRufloCwd();
      for (let call = 1; call <= 3; call++) {
        assertStdoutIsOnlyJson(statuslineStdout(dir), `call ${call}`);
      }
    },
    120_000
  );

  it(
    'emits only JSON on stdout when the config in cwd is malformed',
    () => {
      const dir = freshRufloCwd();
      // Triggers the `Failed to load config from ...` warning pushed in
      // shared/src/core/config/loader.ts — the diagnostic the reporter actually
      // saw on stdout. A malformed config does not disable autostart: the
      // parse error is caught and autostart fails open.
      fs.writeFileSync(
        path.join(dir, 'claude-flow.config.json'),
        '{ "features": [ this is not valid json',
        'utf8'
      );

      assertStdoutIsOnlyJson(statuslineStdout(dir), 'malformed config');
    },
    120_000
  );
});
