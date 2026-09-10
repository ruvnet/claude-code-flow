/**
 * Self-running daemon auto-start — single-instance, opt-out, safe.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureDaemonRunning,
  isDaemonAlive,
  isRufloProject,
  resolveDaemonProjectRoot,
} from '../src/services/daemon-autostart.js';
import { applyChampion } from '../src/config/harness-feedback-applier.js';

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'daemon-as-'));
  mkdirSync(join(cwd, '.claude-flow'), { recursive: true });
  writeFileSync(join(cwd, '.claude-flow', 'config.yaml'), 'version: 3\n');
  return cwd;
}

describe('ensureDaemonRunning', () => {
  const saved = process.env.RUFLO_DAEMON_AUTOSTART;
  afterEach(() => { if (saved === undefined) delete process.env.RUFLO_DAEMON_AUTOSTART; else process.env.RUFLO_DAEMON_AUTOSTART = saved; });

  it('starts (spawns) when no daemon is alive in a ruflo project', () => {
    delete process.env.RUFLO_DAEMON_AUTOSTART;
    const cwd = project();
    let spawned = 0;
    const r = ensureDaemonRunning(cwd, { isAlive: () => false, spawnFn: () => { spawned++; } });
    expect(r.started).toBe(true);
    expect(spawned).toBe(1);
  });

  it('is a no-op when a daemon is already alive (single-instance)', () => {
    delete process.env.RUFLO_DAEMON_AUTOSTART;
    let spawned = 0;
    const r = ensureDaemonRunning(project(), { isAlive: () => true, spawnFn: () => { spawned++; } });
    expect(r.started).toBe(false);
    expect(r.reason).toMatch(/already running/);
    expect(spawned).toBe(0);
  });

  it('respects the opt-out (RUFLO_DAEMON_AUTOSTART=0)', () => {
    process.env.RUFLO_DAEMON_AUTOSTART = '0';
    let spawned = 0;
    const r = ensureDaemonRunning(project(), { isAlive: () => false, spawnFn: () => { spawned++; } });
    expect(r.started).toBe(false);
    expect(r.reason).toMatch(/disabled/);
    expect(spawned).toBe(0);
  });

  it('does not spawn in a non-ruflo directory', () => {
    delete process.env.RUFLO_DAEMON_AUTOSTART;
    const cwd = mkdtempSync(join(tmpdir(), 'not-ruflo-'));
    let spawned = 0;
    const r = ensureDaemonRunning(cwd, { isAlive: () => false, spawnFn: () => { spawned++; } });
    expect(r.started).toBe(false);
    expect(spawned).toBe(0);
  });

  it('does not treat a Claude Code-only .claude directory as Ruflo initialization (#2834)', () => {
    delete process.env.RUFLO_DAEMON_AUTOSTART;
    const cwd = mkdtempSync(join(tmpdir(), 'claude-only-'));
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.json'), '{}');
    let spawned = 0;
    const r = ensureDaemonRunning(cwd, { isAlive: () => false, spawnFn: () => { spawned++; } });
    expect(r).toEqual({ started: false, reason: 'not a ruflo project' });
    expect(spawned).toBe(0);
    expect(existsSync(join(cwd, '.claude-flow'))).toBe(false);
  });

  it('does not let startup-created policy state authorize daemon auto-start (#2852)', () => {
    delete process.env.RUFLO_DAEMON_AUTOSTART;
    const cwd = mkdtempSync(join(tmpdir(), 'claude-policy-only-'));
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      join(cwd, '.claude', 'proven-config.json'),
      JSON.stringify({ championId: `sha256:${'a'.repeat(64)}` }),
    );

    // This mirrors the startup ordering in CLI.run(): applying a shipped
    // champion creates .claude-flow before daemon auto-start is evaluated.
    expect(applyChampion(cwd).applied).toBe(true);
    expect(existsSync(join(cwd, '.claude-flow'))).toBe(true);
    expect(isRufloProject(cwd)).toBe(false);

    let spawned = 0;
    const result = ensureDaemonRunning(cwd, {
      isAlive: () => false,
      spawnFn: () => { spawned++; },
    });
    expect(result).toEqual({ started: false, reason: 'not a ruflo project' });
    expect(spawned).toBe(0);
  });

  it('recognizes only explicit Ruflo markers, not generic state directories', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ruflo-markers-'));
    mkdirSync(join(cwd, '.claude-flow'), { recursive: true });
    expect(isRufloProject(cwd)).toBe(false);

    writeFileSync(join(cwd, '.claude-flow', 'config.json'), '{}');
    expect(isRufloProject(cwd)).toBe(true);
  });

  it('respects a project-local claude-flow.config.json opt-out (survives env vars not propagating)', () => {
    // The real-world gap this closes: a non-interactive shell never sources
    // ~/.bashrc (its own top-of-file `case $- in *i*) ;; *) return;; esac`
    // guard skips it outright), so `export RUFLO_DAEMON_AUTOSTART=0` in one
    // such shell does not carry to the next command's shell. A file on disk
    // has no such gap.
    delete process.env.RUFLO_DAEMON_AUTOSTART;
    const cwd = project();
    writeFileSync(join(cwd, 'claude-flow.config.json'), JSON.stringify({ daemon: { autostart: false } }));
    let spawned = 0;
    const r = ensureDaemonRunning(cwd, { isAlive: () => false, spawnFn: () => { spawned++; } });
    expect(r.started).toBe(false);
    expect(r.reason).toMatch(/disabled/);
    expect(spawned).toBe(0);
  });

  it('a malformed claude-flow.config.json is treated as not-disabled (fails open on parse errors, not silently blocking)', () => {
    delete process.env.RUFLO_DAEMON_AUTOSTART;
    const cwd = project();
    writeFileSync(join(cwd, 'claude-flow.config.json'), 'this is not valid json {{{');
    let spawned = 0;
    const r = ensureDaemonRunning(cwd, { isAlive: () => false, spawnFn: () => { spawned++; } });
    expect(r.started).toBe(true);
    expect(spawned).toBe(1);
  });

  it('a config file present but without daemon.autostart:false does not disable it', () => {
    delete process.env.RUFLO_DAEMON_AUTOSTART;
    const cwd = project();
    writeFileSync(join(cwd, 'claude-flow.config.json'), JSON.stringify({ funnel: { enabled: false } }));
    let spawned = 0;
    const r = ensureDaemonRunning(cwd, { isAlive: () => false, spawnFn: () => { spawned++; } });
    expect(r.started).toBe(true);
    expect(spawned).toBe(1);
  });

  it('respects the .claude/settings.json opt-out (claudeFlow.daemon.autoStart: false) — the exact field `ruflo init` generates by default', () => {
    // Without this check the field is a decoy: `ruflo init` writes it into
    // every generated project, defaulted to false, and nothing here ever
    // read it — a user who trusts the file `init` handed them (or an agent
    // reading it on their behalf) gets no working opt-out at all.
    delete process.env.RUFLO_DAEMON_AUTOSTART;
    const cwd = project();
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({ claudeFlow: { daemon: { autoStart: false, workers: ['map', 'audit', 'optimize'] } } }),
    );
    let spawned = 0;
    const r = ensureDaemonRunning(cwd, { isAlive: () => false, spawnFn: () => { spawned++; } });
    expect(r.started).toBe(false);
    expect(r.reason).toMatch(/disabled/);
    expect(spawned).toBe(0);
  });

  it('a settings.json present but without claudeFlow.daemon.autoStart:false does not disable it', () => {
    delete process.env.RUFLO_DAEMON_AUTOSTART;
    const cwd = project();
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ claudeFlow: { daemon: { autoStart: true } } }));
    let spawned = 0;
    const r = ensureDaemonRunning(cwd, { isAlive: () => false, spawnFn: () => { spawned++; } });
    expect(r.started).toBe(true);
    expect(spawned).toBe(1);
  });

  it('a malformed .claude/settings.json is treated as not-disabled (fails open on parse errors, not silently blocking)', () => {
    delete process.env.RUFLO_DAEMON_AUTOSTART;
    const cwd = project();
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.json'), 'this is not valid json {{{');
    let spawned = 0;
    const r = ensureDaemonRunning(cwd, { isAlive: () => false, spawnFn: () => { spawned++; } });
    expect(r.started).toBe(true);
    expect(spawned).toBe(1);
  });
});

describe('resolveDaemonProjectRoot (#2877)', () => {
  const saved = process.env.RUFLO_DAEMON_AUTOSTART;
  beforeEach(() => { delete process.env.RUFLO_DAEMON_AUTOSTART; });
  afterEach(() => { if (saved === undefined) delete process.env.RUFLO_DAEMON_AUTOSTART; else process.env.RUFLO_DAEMON_AUTOSTART = saved; });

  it('resolves the project root to itself', () => {
    const root = project();
    expect(resolveDaemonProjectRoot(root)).toBe(root);
  });

  it('resolves a nested subdirectory to the owning project root', () => {
    const root = project();
    const sub = join(root, 'packages', 'foo');
    mkdirSync(sub, { recursive: true });
    expect(resolveDaemonProjectRoot(sub)).toBe(root);
  });

  it('keeps an independently-initialized sub-project on its own root (nearest marker wins)', () => {
    const root = project();
    const sub = join(root, 'packages', 'independent');
    mkdirSync(join(sub, '.claude-flow'), { recursive: true });
    writeFileSync(join(sub, '.claude-flow', 'config.yaml'), 'version: 3\n');
    expect(resolveDaemonProjectRoot(sub)).toBe(sub);
  });

  it('stops at the repository boundary instead of escaping into an ancestor project', () => {
    const outer = project();
    const repo = join(outer, 'vendor', 'unrelated-repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const inside = join(repo, 'src');
    mkdirSync(inside, { recursive: true });
    expect(resolveDaemonProjectRoot(inside)).toBe(inside);
  });

  it('returns the start directory unchanged when no marker is found', () => {
    const plain = mkdtempSync(join(tmpdir(), 'no-marker-'));
    expect(resolveDaemonProjectRoot(plain)).toBe(plain);
  });

  it('autostart from the root spawns a daemon keyed to the root', () => {
    const root = project();
    const spawnedFor: string[] = [];
    const r = ensureDaemonRunning(root, { isAlive: () => false, spawnFn: (p) => { spawnedFor.push(p); } });
    expect(r.started).toBe(true);
    expect(spawnedFor).toEqual([root]);
  });

  it('autostart from a subdirectory does NOT spawn a duplicate for the same project', () => {
    const root = project();
    const sub = join(root, 'packages', 'foo');
    mkdirSync(sub, { recursive: true });

    // A live daemon already holds the ROOT's pidfile. Before #2877 the
    // subdirectory read `<sub>/.claude-flow/daemon.pid` — a different key —
    // saw nothing, and spawned a second daemon for the same project.
    writeFileSync(join(root, '.claude-flow', 'daemon.pid'), String(process.ppid));

    let spawned = 0;
    const r = ensureDaemonRunning(sub, { spawnFn: () => { spawned++; } });
    expect(r).toEqual({ started: false, reason: 'already running' });
    expect(spawned).toBe(0);
    expect(existsSync(join(sub, '.claude-flow'))).toBe(false);
  });

  it('a genuinely separate project still gets its own daemon', () => {
    const projectA = project();
    const projectB = project();
    writeFileSync(join(projectA, '.claude-flow', 'daemon.pid'), String(process.ppid));

    const spawnedFor: string[] = [];
    const r = ensureDaemonRunning(projectB, { spawnFn: (p) => { spawnedFor.push(p); } });
    expect(r.started).toBe(true);
    expect(spawnedFor).toEqual([projectB]);
  });

  it('reads the project-local opt-out from the root when invoked from a subdirectory', () => {
    const root = project();
    writeFileSync(join(root, 'claude-flow.config.json'), JSON.stringify({ daemon: { autostart: false } }));
    const sub = join(root, 'packages', 'foo');
    mkdirSync(sub, { recursive: true });

    let spawned = 0;
    const r = ensureDaemonRunning(sub, { isAlive: () => false, spawnFn: () => { spawned++; } });
    expect(r.started).toBe(false);
    expect(r.reason).toMatch(/disabled/);
    expect(spawned).toBe(0);
  });
});

describe('isDaemonAlive', () => {
  it('false + cleans a stale pidfile for a dead pid', () => {
    const cwd = project();
    const pidFile = join(cwd, '.claude-flow', 'daemon.pid');
    writeFileSync(pidFile, '999999999'); // almost certainly not a live pid
    expect(isDaemonAlive(cwd)).toBe(false);
    expect(existsSync(pidFile)).toBe(false); // stale file cleaned
  });

  it('false when no pidfile', () => {
    expect(isDaemonAlive(project())).toBe(false);
  });

  it('true for a live pid (our own test process, written as the pid)', () => {
    // Using a DIFFERENT live pid: the test can only prove liveness of a real pid.
    // process.ppid is alive and != our pid, so it should read as alive.
    const cwd = project();
    writeFileSync(join(cwd, '.claude-flow', 'daemon.pid'), String(process.ppid));
    expect(isDaemonAlive(cwd)).toBe(true);
  });
});
