/**
 * #3278 — `autoStart: false` must actually prevent autostart.
 *
 * The disable check read `claude-flow.config.json` → `daemon.autostart`, while
 * `init` generates `.claude/settings.json` → `claudeFlow.daemon.autoStart`.
 * A different file and a different capital S, so the one setting a fresh project
 * ships was never consulted and the daemon spawned anyway — spending exactly the
 * tokens that generated comment says it prevents (#1427, #1330).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const load = async () => await import('../src/services/daemon-autostart.js');
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'd3278-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

function settings(json: unknown) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(json));
}

describe('#3278 daemon autostart consent', () => {
  it('honours claudeFlow.daemon.autoStart:false from the file init actually writes', async () => {
    const { ensureDaemonRunning } = await load();
    settings({ claudeFlow: { daemon: { autoStart: false, workers: ['map'] } } });
    const r = ensureDaemonRunning(dir) as { started?: boolean; reason?: string };
    expect(r.started, 'a generated autoStart:false must not spawn a daemon').not.toBe(true);
  });

  it('still honours the legacy lowercase key in claude-flow.config.json', async () => {
    const { ensureDaemonRunning } = await load();
    writeFileSync(join(dir, 'claude-flow.config.json'), JSON.stringify({ daemon: { autostart: false } }));
    const r = ensureDaemonRunning(dir) as { started?: boolean };
    expect(r.started).not.toBe(true);
  });

  it('accepts either spelling in either file, so a plausible config is not ignored', async () => {
    const { ensureDaemonRunning } = await load();
    settings({ claudeFlow: { daemon: { autostart: false } } });   // lowercase in settings.json
    expect((ensureDaemonRunning(dir) as { started?: boolean }).started).not.toBe(true);
  });

  it('a settings file with no daemon opinion is not treated as consent to disable', async () => {
    const { ensureDaemonRunning } = await load();
    settings({ claudeFlow: { hooks: {} } });
    // Nothing asserted about starting here — only that an absent opinion is not
    // read as `false`, which would be the mirror-image bug.
    const r = ensureDaemonRunning(dir) as { started?: boolean; reason?: string };
    expect(r.reason ?? '').not.toMatch(/autostart disabled/i);
  });
});
