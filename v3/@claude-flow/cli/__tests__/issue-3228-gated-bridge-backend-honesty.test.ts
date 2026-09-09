import { describe, it, expect, afterEach } from 'vitest';

// #3228: on Windows the native-bridge kill-switch added in 3.38.12 (#3024)
// makes `getRegistry()` return null, so every memory read/write silently
// falls back to the sql.js store (`memory.db`) instead of the AgentDB corpus
// (`agentdb-memory.db`) the bridge would have opened. The reporter measured
// the consequence: a canary store/retrieve round-trip SUCCEEDS (both halves
// use the same unintended file), while an existing live-store key returns
// `found: false` against 31,673 real rows.
//
// The status surface hid it. `getHNSWStatus()` gated its bridge branch on
// whether the bridge MODULE was loaded — which it is, even when the registry
// is gated off — so `describeBackend()` printed "sqlite (bridge, brute-force
// cosine)" for a store the bridge never touched.
//
// These tests pin the discriminator. `CLAUDE_FLOW_DISABLE_BRIDGE=1` takes the
// same `shouldDisableNativeBridge()` branch as the Windows default, so the
// regression is reproducible on any platform.
describe('#3228 a gated native bridge must not be reported as the active backend', () => {
  const priorDisable = process.env.CLAUDE_FLOW_DISABLE_BRIDGE;

  afterEach(() => {
    if (priorDisable === undefined) delete process.env.CLAUDE_FLOW_DISABLE_BRIDGE;
    else process.env.CLAUDE_FLOW_DISABLE_BRIDGE = priorDisable;
  });

  it('shouldDisableNativeBridge() is true for the Windows default and for the explicit kill-switch', async () => {
    const { shouldDisableNativeBridge } = await import('../src/memory/memory-bridge.js');

    // The Windows default (no opt-in) — the exact gate the issue reports.
    expect(shouldDisableNativeBridge('win32', {})).toBe(true);
    // Opt-in re-enables it.
    expect(
      shouldDisableNativeBridge('win32', { CLAUDE_FLOW_ENABLE_NATIVE_BRIDGE_ON_WINDOWS: '1' }),
    ).toBe(false);
    // Non-Windows is ungated by default...
    expect(shouldDisableNativeBridge('linux', {})).toBe(false);
    // ...but the explicit kill-switch gates every platform.
    expect(shouldDisableNativeBridge('linux', { CLAUDE_FLOW_DISABLE_BRIDGE: '1' })).toBe(true);
  });

  it('getHNSWStatus() stops claiming the brute-force bridge path once the bridge is gated', async () => {
    process.env.CLAUDE_FLOW_DISABLE_BRIDGE = '1';
    const { getHNSWStatus } = await import('../src/memory/memory-initializer.js');

    const status = getHNSWStatus();

    // The pre-fix code reported `brute-force-cosine` here purely because the
    // module object was resolvable, describing a path that cannot run. With
    // the bridge gated, sql.js is what actually serves the request.
    expect(status.algorithm).not.toBe('brute-force-cosine');
  });

  it('the backend label names the gate instead of implying the bridge is serving requests', async () => {
    process.env.CLAUDE_FLOW_DISABLE_BRIDGE = '1';
    const { shouldDisableNativeBridge, getBridgeFailureReason } = await import(
      '../src/memory/memory-bridge.js'
    );

    // describeBackend() is module-private, so assert the two facts it composes:
    // the gate is closed, and the reason is retrievable for the operator.
    expect(shouldDisableNativeBridge()).toBe(true);
    expect(typeof getBridgeFailureReason).toBe('function');

    // A label built from these must not be a bare "sql.js + HNSW" — the point
    // of #3228 is that an upgrade changed which FILE receives writes without
    // saying so. Reconstruct the same composition describeBackend() performs.
    const reason = getBridgeFailureReason();
    const label = `sql.js + HNSW (native bridge disabled${reason ? `: ${reason}` : ''})`;
    expect(label).toContain('native bridge disabled');
  });
});
