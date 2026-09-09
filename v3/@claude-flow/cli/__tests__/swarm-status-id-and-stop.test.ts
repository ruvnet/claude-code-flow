/**
 * Regression guards for two `swarm` defects reproduced on a live desktop
 * running ruflo v3.38.21:
 *
 *   1. `swarm status --format json` emitted the literal string
 *      'no-active-swarm' as the value of `id` while also reporting
 *      `hasActiveSwarm: true` and 9 agents. The id is persisted by three
 *      writers under two keys (`.swarm/state.json` `id` from `swarm init`,
 *      `.swarm/state.json` `swarmId` from `swarm start`, and
 *      `.claude-flow/swarm/swarm-state.json` from MCP `swarm_init`) and the
 *      reader checked only the first.
 *   2. `swarm stop` with no argument always failed, and no CLI surface handed
 *      out an id to pass (there is no `swarm list` subcommand).
 *
 * Exercised via real execFileSync against bin/cli.js in temp cwds, matching
 * the harness in hooks-metrics-swarm-backup-2797-2798-2799.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(__dirname, '..', 'bin', 'cli.js');

function run(args: string[], cwd: string): { stdout: string; exit: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, exit: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return { stdout: (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? ''), exit: e.status ?? -1 };
  }
}

function statusJson(cwd: string): Record<string, unknown> {
  const { stdout } = run(['swarm', 'status', '--format', 'json'], cwd);
  return JSON.parse(stdout.slice(stdout.indexOf('{')));
}

/** `.swarm/state.json` as written by `swarm start`. */
function writeStartState(cwd: string, swarmId: string): void {
  mkdirSync(join(cwd, '.swarm'), { recursive: true });
  writeFileSync(join(cwd, '.swarm', 'state.json'), JSON.stringify({
    swarmId,
    objective: 'test objective',
    strategy: 'development',
    status: 'initialized',
    agents: 3,
    startedAt: new Date().toISOString(),
  }, null, 2));
}

/** `.claude-flow/swarm/swarm-state.json` as written by MCP `swarm_init`. */
function writeMcpState(cwd: string, swarmId: string): void {
  mkdirSync(join(cwd, '.claude-flow', 'swarm'), { recursive: true });
  writeFileSync(join(cwd, '.claude-flow', 'swarm', 'swarm-state.json'), JSON.stringify({
    version: '3.0.0',
    swarms: {
      [swarmId]: {
        swarmId,
        topology: 'hierarchical',
        maxAgents: 8,
        status: 'running',
        agents: ['agent-1'],
        tasks: [],
        config: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  }, null, 2));
}

/**
 * The exact on-disk fixture captured from the live desktop (machine
 * 8dd713ae391948) whose `swarm status --format json` returned the sentinel:
 * `.swarm/state.json` carrying `swarmId` and NO `id`, no `topology`,
 * `status: "initialized"`, `.claude-flow/swarm/` never created, and 9 agents
 * registered. Produced by the console wizard running CLI `swarm init` then
 * `swarm start` with the MCP server unavailable, so only `start`'s write —
 * which uses the key `swarmId` — survived.
 */
function writeLiveDesktopFixture(cwd: string): void {
  mkdirSync(join(cwd, '.swarm'), { recursive: true });
  writeFileSync(join(cwd, '.swarm', 'state.json'), JSON.stringify({
    swarmId: 'swarm-mtultyxy',
    objective: 'ruOS console wizard deployment',
    strategy: 'specialized',
    status: 'initialized',
    agents: 9,
    agentPlan: [{ role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Orchestrate workflow' }],
    startedAt: new Date().toISOString(),
    parallel: true,
  }, null, 2));

  // Agents present, registered the way `agent spawn` registers them.
  mkdirSync(join(cwd, '.claude-flow', 'agents'), { recursive: true });
  const agents: Record<string, { status: string }> = {};
  for (let i = 1; i <= 9; i++) agents[`agent-${i}`] = { status: 'active' };
  writeFileSync(join(cwd, '.claude-flow', 'agents', 'store.json'), JSON.stringify({ agents }, null, 2));
  // Deliberately NO .claude-flow/swarm/ — the MCP store never existed.
}

describe('live desktop fixture (machine 8dd713ae391948)', () => {
  it('resolves swarmId with no `id` key and no MCP store at all', () => {
    const wd = mkdtempSync(join(tmpdir(), 'ruflo-swarm-live-'));
    try {
      writeLiveDesktopFixture(wd);
      expect(existsSync(join(wd, '.claude-flow', 'swarm'))).toBe(false);

      const status = statusJson(wd);
      expect(status.id).toBe('swarm-mtultyxy');
      expect(JSON.stringify(status)).not.toContain('no-active-swarm');
      expect(status.hasActiveSwarm).toBe(true);
      expect(status.agents).toMatchObject({ total: 9, active: 9 });
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);

  it('bare `swarm stop` targets that swarm', () => {
    const wd = mkdtempSync(join(tmpdir(), 'ruflo-swarm-live-'));
    try {
      writeLiveDesktopFixture(wd);
      const { stdout, exit } = run(['swarm', 'stop'], wd);
      expect(exit).toBe(0);
      expect(stdout).toContain('swarm-mtultyxy');
      const state = JSON.parse(readFileSync(join(wd, '.swarm', 'state.json'), 'utf-8'));
      expect(state.status).toBe('stopped');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('swarm status reports an honest id', () => {
  it('emits null — not a sentinel string — when there is no swarm', () => {
    const wd = mkdtempSync(join(tmpdir(), 'ruflo-swarm-id-'));
    try {
      const status = statusJson(wd);
      expect(status.id).toBeNull();
      expect(JSON.stringify(status)).not.toContain('no-active-swarm');
      expect(status.hasActiveSwarm).toBe(false);
      expect(status.status).toBe('idle');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);

  it('resolves the id `swarm start` persists as `swarmId`', () => {
    const wd = mkdtempSync(join(tmpdir(), 'ruflo-swarm-id-'));
    try {
      writeStartState(wd, 'swarm-from-start');
      const status = statusJson(wd);
      expect(status.id).toBe('swarm-from-start');
      expect(status.hasActiveSwarm).toBe(true);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);

  it('resolves the id MCP `swarm_init` persists, with no .swarm/state.json', () => {
    const wd = mkdtempSync(join(tmpdir(), 'ruflo-swarm-id-'));
    try {
      // No agents spawned yet, so neither the CLI state file nor the agent
      // store exists — the payload must still agree with itself.
      writeMcpState(wd, 'swarm-from-mcp');
      const status = statusJson(wd);
      expect(status.id).toBe('swarm-from-mcp');
      expect(status.hasActiveSwarm).toBe(true);

      // ...and the human view must print the swarm, not bail out early.
      const human = run(['swarm', 'status'], wd).stdout;
      expect(human).toContain('Swarm Status: swarm-from-mcp');
      expect(human).not.toContain('No active swarm');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);

  it('does not let a stopped state file shadow a live MCP swarm', () => {
    const wd = mkdtempSync(join(tmpdir(), 'ruflo-swarm-id-'));
    try {
      writeStartState(wd, 'swarm-already-stopped');
      writeFileSync(join(wd, '.swarm', 'state.json'), JSON.stringify({
        id: 'swarm-already-stopped',
        swarmId: 'swarm-already-stopped',
        status: 'stopped',
        stoppedAt: new Date().toISOString(),
      }, null, 2));
      writeMcpState(wd, 'swarm-still-running');
      expect(statusJson(wd).id).toBe('swarm-still-running');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);

  it('a stopped state file does not claim an active swarm it cannot name', () => {
    const wd = mkdtempSync(join(tmpdir(), 'ruflo-swarm-id-'));
    try {
      mkdirSync(join(wd, '.swarm'), { recursive: true });
      writeFileSync(join(wd, '.swarm', 'state.json'), JSON.stringify({
        id: 'swarm-x', swarmId: 'swarm-x', status: 'stopped',
      }, null, 2));

      // All three fields must agree that this swarm is not active.
      const status = statusJson(wd);
      expect(status.id).toBeNull();
      expect(status.hasActiveSwarm).toBe(false);
      expect(status.status).toBe('stopped');
      expect(run(['swarm', 'status'], wd).stdout).toContain('No active swarm');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);

  it('a stopped state file still reports genuinely live agents', () => {
    const wd = mkdtempSync(join(tmpdir(), 'ruflo-swarm-id-'));
    try {
      mkdirSync(join(wd, '.swarm'), { recursive: true });
      writeFileSync(join(wd, '.swarm', 'state.json'), JSON.stringify({
        id: 'swarm-x', swarmId: 'swarm-x', status: 'stopped',
      }, null, 2));
      mkdirSync(join(wd, '.claude-flow', 'agents'), { recursive: true });
      writeFileSync(join(wd, '.claude-flow', 'agents', 'store.json'),
        JSON.stringify({ agents: { a1: { status: 'active' } } }, null, 2));

      // Agents are real activity, so `hasActiveSwarm` stays true even though no
      // swarm id resolves — "agents running, no swarm registered" is a genuine
      // state, not a contradiction. A stopped file must not mask it.
      const status = statusJson(wd);
      expect(status.hasActiveSwarm).toBe(true);
      expect(status.agents).toMatchObject({ total: 1, active: 1 });
      // Observed reality wins over the file's recorded intent.
      expect(status.status).toBe('running');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);

  it('prefers an explicitly supplied id over the persisted one', () => {
    const wd = mkdtempSync(join(tmpdir(), 'ruflo-swarm-id-'));
    try {
      writeStartState(wd, 'swarm-from-start');
      const { stdout } = run(['swarm', 'status', 'swarm-explicit', '--format', 'json'], wd);
      expect(JSON.parse(stdout.slice(stdout.indexOf('{'))).id).toBe('swarm-explicit');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('swarm stop works without an argument', () => {
  it('stops the persisted swarm and records it in the state file', () => {
    const wd = mkdtempSync(join(tmpdir(), 'ruflo-swarm-stop-'));
    try {
      writeStartState(wd, 'swarm-from-start');
      const { stdout, exit } = run(['swarm', 'stop'], wd);
      expect(exit).toBe(0);
      expect(stdout).toContain('swarm-from-start');
      const state = JSON.parse(readFileSync(join(wd, '.swarm', 'state.json'), 'utf-8'));
      expect(state.status).toBe('stopped');
      expect(state.stoppedAt).toBeTruthy();
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);

  it('resolves an MCP-only swarm id', () => {
    const wd = mkdtempSync(join(tmpdir(), 'ruflo-swarm-stop-'));
    try {
      writeMcpState(wd, 'swarm-from-mcp');
      const { stdout, exit } = run(['swarm', 'stop'], wd);
      expect(exit).toBe(0);
      expect(stdout).toContain('swarm-from-mcp');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);

  it('stops the live MCP swarm, not the id in a stopped state file', () => {
    const wd = mkdtempSync(join(tmpdir(), 'ruflo-swarm-stop-'));
    try {
      mkdirSync(join(wd, '.swarm'), { recursive: true });
      writeFileSync(join(wd, '.swarm', 'state.json'), JSON.stringify({
        id: 'swarm-already-stopped',
        swarmId: 'swarm-already-stopped',
        status: 'stopped',
        stoppedAt: new Date().toISOString(),
      }, null, 2));
      writeMcpState(wd, 'swarm-still-running');

      const { stdout, exit } = run(['swarm', 'stop'], wd);
      expect(exit).toBe(0);
      expect(stdout).toContain('swarm-still-running');
      expect(stdout).not.toContain('swarm-already-stopped');

      const store = JSON.parse(readFileSync(join(wd, '.claude-flow', 'swarm', 'swarm-state.json'), 'utf-8'));
      expect(store.swarms['swarm-still-running'].status).toBe('terminated');

      // Nothing live is left, so a second bare stop must say so rather than
      // report success against the stale local id again.
      const second = run(['swarm', 'stop'], wd);
      expect(second.exit).toBe(1);
      expect(second.stdout).toContain('No swarm found to stop');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);

  it('still honours an explicit id argument', () => {
    const wd = mkdtempSync(join(tmpdir(), 'ruflo-swarm-stop-'));
    try {
      writeStartState(wd, 'swarm-from-start');
      const { stdout, exit } = run(['swarm', 'stop', 'swarm-explicit'], wd);
      expect(exit).toBe(0);
      expect(stdout).toContain('swarm-explicit');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails with guidance on how to find an id when there is nothing to stop', () => {
    const wd = mkdtempSync(join(tmpdir(), 'ruflo-swarm-stop-'));
    try {
      const { stdout, exit } = run(['swarm', 'stop'], wd);
      expect(exit).toBe(1);
      expect(stdout).toContain('No swarm found to stop');
      expect(stdout).toContain('swarm status --format json');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);
});
