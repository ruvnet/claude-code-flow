/**
 * Self-running daemon (auto-start).
 *
 * The self-optimizing loop's workers (distillation, backup, and the future
 * evolve worker) are inert unless the daemon runs — but it required a manual
 * `ruflo daemon start`. This ensures a daemon is running on CLI use, SAFELY:
 *
 *   - single-instance: only starts when no live daemon holds the pidfile, and
 *     the spawned `daemon start` independently enforces single-instance via its
 *     own lock + checkExistingDaemon() — so a race spawns at most one survivor,
 *   - bounded lifetime: the daemon self-terminates on TTL/idle (12h hard TTL,
 *     30m idle default; RUFLO_DAEMON_TTL_SECS / RUFLO_DAEMON_IDLE_SECS) —
 *     auto-start never means "runs forever",
 *   - opt-out: RUFLO_DAEMON_AUTOSTART=0|false|no disables it entirely, OR a
 *     project-local `daemon.autostart: false` in claude-flow.config.json —
 *     the file-based opt-out exists because the env var only reaches a
 *     process that inherited it. A non-interactive shell (cron, CI, many
 *     tool-invoked shells — bash skips ~/.bashrc entirely for these; see
 *     its own `case $- in *i*) ;; *) return;; esac` guard) never re-sources
 *     a shell rc file per invocation, so `export RUFLO_DAEMON_AUTOSTART=0`
 *     in one such shell does NOT persist to the next one. A project config
 *     field has no such gap — it's read fresh from disk every time,
 *     independent of which shell (or whether any shell at all) launched
 *     the command,
 *   - cheap: a pidfile read + a signal-0 liveness check on the fast path,
 *   - best-effort + silent: never blocks or fails a command.
 *
 * Reuses `daemon start` verbatim (all its lock/TTL/worker machinery) — this
 * module only decides WHETHER to spawn, never reimplements the daemon.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

/** True if a live daemon already holds the project's pidfile. */
export function isDaemonAlive(projectRoot: string): boolean {
  const pidFile = path.join(projectRoot, '.claude-flow', 'daemon.pid');
  try {
    if (!fs.existsSync(pidFile)) return false;
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (Number.isNaN(pid) || pid === process.pid) return false;
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    // Dead process → stale pidfile. Clean it so `daemon start` proceeds cleanly.
    try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    return false;
  }
}

/** Project-local opt-out: `{ "daemon": { "autostart": false } }` in claude-flow.config.json. */
function autostartDisabledByProjectConfig(projectRoot: string): boolean {
  // #3278: read BOTH files, and both spellings.
  //
  // This used to consult only `claude-flow.config.json` with the key
  // `daemon.autostart`. But `init` generates `.claude/settings.json` with
  // `claudeFlow.daemon.autoStart` — a different file and a different capital S —
  // and writes it `false` under the comment "Opt-in only — prevents unintended
  // token consumption (#1427, #1330)". So the one setting a fresh project
  // actually ships was never read, and the runtime spent tokens the generated
  // config existed to prevent. Accept either spelling in either file: a user who
  // wrote the word "autostart: false" anywhere sensible meant it.
  const readsFalse = (v: unknown) => v === false;
  for (const [file, pick] of [
    ['claude-flow.config.json', (c: any) => c?.daemon],
    [path.join('.claude', 'settings.json'), (c: any) => c?.claudeFlow?.daemon],
  ] as const) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(projectRoot, file), 'utf-8'));
      const d = pick(cfg);
      if (readsFalse(d?.autostart) || readsFalse(d?.autoStart)) return true;
    } catch {
      // absent/malformed config = this file says nothing; keep checking the others
    }
  }
  return false;
}

function autostartDisabled(projectRoot: string): boolean {
  if (/^(0|false|no|off)$/i.test(process.env.RUFLO_DAEMON_AUTOSTART ?? '')) return true;
  return autostartDisabledByProjectConfig(projectRoot);
}

/**
 * Return true only when the directory contains a durable Ruflo project marker.
 *
 * A bare `.claude/` is owned by Claude Code, and a bare `.claude-flow/` is not
 * sufficient either: startup-time policy/champion migration can create it
 * before this function runs. Treating that mutation as authorization caused a
 * read-only command in any Claude project to spawn a detached daemon (#2852).
 */
export function isRufloProject(projectRoot: string): boolean {
  const root = path.resolve(projectRoot);
  const directMarkers = [
    path.join(root, '.claude-flow', 'config.yaml'),
    path.join(root, '.claude-flow', 'config.yml'),
    path.join(root, '.claude-flow', 'config.json'),
    path.join(root, 'claude-flow.config.json'),
    path.join(root, '.swarm', 'memory.db'),
  ];
  if (directMarkers.some((marker) => fs.existsSync(marker))) return true;

  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf-8'),
    );
    if (settings && typeof settings === 'object' && 'claudeFlow' in settings) {
      return true;
    }
  } catch { /* absent/malformed/non-Ruflo settings */ }

  try {
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf-8'));
    const servers = mcp?.mcpServers;
    if (servers && typeof servers === 'object'
      && ('ruflo' in servers || 'claude-flow' in servers)) {
      return true;
    }
  } catch { /* absent/malformed/non-Ruflo MCP config */ }

  return false;
}

/**
 * #2877: Normalize a working directory to the project root that owns the
 * daemon lock/PID key.
 *
 * The lock (`<root>/.claude-flow/daemon.lock`) and PID file
 * (`<root>/.claude-flow/daemon.pid`) were keyed to the raw cwd, so invoking
 * the CLI from `/proj` and from `/proj/packages/foo` produced two different
 * keys for one logical project — bypassing the atomic-lockfile dedup added
 * for #2407/#2484 entirely (each cwd races against a different lock file)
 * and leaving two daemons supervising the same tree.
 *
 * Resolution walks up from `startDir` and returns the NEAREST enclosing
 * directory carrying a durable Ruflo marker (`isRufloProject`). Nearest-wins
 * is what keeps a monorepo's independently-initialized sub-project on its own
 * daemon: it matches its own marker before the walk ever reaches the parent.
 *
 * A `.git` directory is a hard stop — the repository boundary. Without it the
 * walk could escape into an unrelated ancestor (a Ruflo project living at
 * `$HOME`, say) and hand every repo below it the same daemon.
 *
 * Returns the resolved `startDir` unchanged when no marker is found, so a
 * non-Ruflo directory still fails `isRufloProject` and declines autostart.
 */
export function resolveDaemonProjectRoot(startDir: string): string {
  const start = path.resolve(startDir);
  let dir = start;
  for (;;) {
    if (isRufloProject(dir)) return dir;
    if (fs.existsSync(path.join(dir, '.git'))) return start;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export interface EnsureResult { started: boolean; reason?: string }

/** Spawn `daemon start` detached, reusing all its lock/TTL machinery. Injectable for tests. */
export type SpawnDaemonFn = (projectRoot: string) => void;

const defaultSpawn: SpawnDaemonFn = (projectRoot) => {
  const cliBin = process.argv[1]; // the running bin/cli.js
  const child = spawn(process.execPath, [cliBin, 'daemon', 'start', '--quiet'], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
};

/**
 * Ensure a daemon is running for the project enclosing `startDir`. No-op when
 * disabled or when one is already alive. Best-effort; never throws.
 *
 * #2877: `startDir` is normalized to the owning project root first, so a call
 * from a subdirectory reads the same config, pidfile, and lock as a call from
 * the root and cannot spawn a second daemon for the same project.
 */
export function ensureDaemonRunning(
  startDir: string,
  opts: { spawnFn?: SpawnDaemonFn; isAlive?: (root: string) => boolean } = {},
): EnsureResult {
  try {
    const projectRoot = resolveDaemonProjectRoot(startDir);
    if (autostartDisabled(projectRoot)) return { started: false, reason: 'disabled (RUFLO_DAEMON_AUTOSTART=0 or project config)' };
    if (!isRufloProject(projectRoot)) {
      return { started: false, reason: 'not a ruflo project' };
    }
    const alive = (opts.isAlive ?? isDaemonAlive)(projectRoot);
    if (alive) return { started: false, reason: 'already running' };
    (opts.spawnFn ?? defaultSpawn)(projectRoot);
    return { started: true };
  } catch (e) {
    return { started: false, reason: `error: ${(e as Error)?.message ?? e}` };
  }
}
