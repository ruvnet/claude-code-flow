#!/usr/bin/env node
/**
 * ruflo-hook.cjs — cross-platform Windows shim for cost-tracker's Stop hook (#2132)
 *
 * The cost-tracker hooks.json declares `"_platform": "posix"` because its
 * Stop hook uses bash:
 *
 *   /bin/bash -c 'TRACK_QUIET=1 node "${CLAUDE_PLUGIN_ROOT}/scripts/track.mjs" >/dev/null 2>&1 || true'
 *
 * On Windows, `ruflo init` writes a `.claude/settings.json` that overrides
 * the Stop hook to invoke this shim instead — `node ruflo-hook.cjs` —
 * so cost tracking continues to capture session data without bash.
 *
 * Behaviour mirrors the bash hook:
 *   1. Reads hook event payload from stdin (best effort — discarded).
 *   2. Spawns track.mjs with TRACK_QUIET=1 and swallows all output.
 *   3. Always exits 0 — telemetry is best-effort, must NEVER block a turn.
 *   4. Times out at 30s so a hung track.mjs can't stall session shutdown.
 *   5. Records spawn/track failures as one line in <pluginRoot>/logs/
 *      hook-errors.log plus a one-line stderr warning (#3227) — reporting
 *      a failure is independent of blocking on it, so exit 0 is kept.
 *
 * Usage: node ruflo-hook.cjs [hook-args ignored]
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function done() {
  process.exit(0);
}

// Best-effort drain of stdin so the pipe doesn't EPIPE on the parent
try {
  fs.readFileSync(0);
} catch {
  /* ignore */
}

// CLAUDE_PLUGIN_ROOT is set by Claude Code; fall back to this script's parent
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
  || path.resolve(__dirname, '..');
const trackScript = path.join(pluginRoot, 'scripts', 'track.mjs');

/**
 * Record a hook failure without ever blocking session end (#3227).
 * Best-effort: logging itself must not throw. Exit code stays 0.
 */
function logFailure(reason) {
  try {
    const logDir = path.join(pluginRoot, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'hook-errors.log'),
      `${new Date().toISOString()} ruflo-hook: cost-track failed: ${reason}\n`,
    );
  } catch {
    /* ignore — logging must never break the hook contract */
  }
  try {
    console.warn(
      `[ruflo-cost-tracker] cost-track failed (best-effort, session end continues): ${reason}`,
    );
  } catch {
    /* ignore */
  }
}

if (!fs.existsSync(trackScript)) {
  // Plugin layout drifted — record it, exit clean, never block the turn
  logFailure(`track script not found: ${trackScript}`);
  done();
}

const result = spawnSync(process.execPath, [trackScript], {
  env: { ...process.env, TRACK_QUIET: '1' },
  stdio: 'ignore',
  timeout: 30_000,
});

if (result.error || result.status !== 0) {
  const reason = result.error
    ? `spawn error: ${result.error.message}`
    : result.signal
      ? `killed by ${result.signal} (30s timeout)`
      : `track.mjs exited with status ${result.status}`;
  logFailure(reason);
}

done();
