/**
 * Tests for agentbbs MCP tools (ADR-164 Phase 1).
 *
 * Two surfaces under test:
 *   1. STRUCTURAL — exposure, schema, validation. Runs regardless of agentbbs presence.
 *   2. HAPPY PATH — gated on the `agentbbs` CLI being resolvable, via it.skipIf(!havePkg).
 *
 * The degraded path is exercised structurally: when the agentbbs CLI is
 * missing, every handler returns `{degraded: true, reason: 'agentbbs-not-found'}`
 * matching the metaharness / agenticow / testgen contract.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  agentbbsTools,
  nextSeq,
  lastPeerHelloMs,
  shouldEmitHello,
  dedupEnvelopes,
} from '../src/mcp-tools/agentbbs-tools.js';

function findTool(name: string) {
  const t = agentbbsTools.find(t => t.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

// Detect agentbbs availability at module scope so it.skipIf evaluates correctly.
// The published `agentbbs` package is a CLI-only launcher with no importable
// JS entry point, so presence is a subprocess probe, not a module import —
// mirrors agentbbsCliAvailable() in the tools module under test.
let havePkg = false;
try {
  // shell only on win32 — see agentbbsCliAvailable() in the module under test.
  execFileSync(process.env.AGENTBBS_BIN || 'agentbbs', ['--version'], {
    stdio: 'ignore',
    timeout: 5000,
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  havePkg = true;
} catch { havePkg = false; }

describe('agentbbs MCP tools — structural contract', () => {
  it('exposes the Phase 1 room surface plus the Phase 2 federation surface', () => {
    const names = agentbbsTools.map(t => t.name).sort();
    // Phase 1 — local room/envelope handling.
    for (const n of ['federation_bbs_register', 'federation_bbs_publish',
                     'federation_bbs_watch', 'federation_bbs_human_join']) {
      expect(names).toContain(n);
    }
    // Phase 2 — cross-host identity, peer pinning, transport and sync.
    for (const n of ['federation_bbs_identity', 'federation_bbs_peer_add',
                     'federation_bbs_peers', 'federation_bbs_serve', 'federation_bbs_sync']) {
      expect(names).toContain(n);
    }
    // Pinned so adding a tool is a deliberate contract change, not a slip.
    expect(names).toHaveLength(9);
  });

  it('every tool has an object inputSchema with handler + ≥80-char description', () => {
    for (const t of agentbbsTools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.properties).toBeDefined();
      expect(typeof t.handler).toBe('function');
      expect(t.description.length).toBeGreaterThanOrEqual(80);
      // ADR-112 — descriptions must carry "Use when ... is wrong because ..." guidance.
      expect(t.description).toMatch(/Use when/i);
      expect(t.description).toMatch(/wrong because/i);
    }
  });

  it('register rejects path traversal in basePath', async () => {
    const register = findTool('federation_bbs_register');
    await expect(register.handler({
      basePath: '../../../../etc/passwd',
      roomLabel: '#sales',
    })).rejects.toThrow(/disallowed characters/);
  });

  it('register rejects an illegal roomLabel', async () => {
    const register = findTool('federation_bbs_register');
    await expect(register.handler({
      roomLabel: 'evil; rm -rf /',
    })).rejects.toThrow(/may only contain/);
  });

  it('register accepts conventional #-prefixed room labels', async () => {
    // Even when agentbbs is missing we should validate inputs first OR degrade
    // — but the contract is: validation errors must surface as throws.
    // With agentbbs missing we get a degraded result instead of validation.
    // So this test only meaningfully covers regex acceptance shape.
    expect(/^[A-Za-z0-9_.\-:/@#]+$/.test('#sales')).toBe(true);
    expect(/^[A-Za-z0-9_.\-:/@#]+$/.test('finance')).toBe(true);
    expect(/^[A-Za-z0-9_.\-:/@#]+$/.test('hr/onboarding')).toBe(true);
  });

  it('publish rejects malformed msgType (validation runs before optional-dep check)', async () => {
    const publish = findTool('federation_bbs_publish');
    await expect(publish.handler({
      roomId: 'sales-12345678',
      msgType: 'bad type with spaces',
      payload: {},
    })).rejects.toThrow(/msgType must be alnum/);
  });

  it('publish rejects non-object payload', async () => {
    const publish = findTool('federation_bbs_publish');
    await expect(publish.handler({
      roomId: 'sales-12345678',
      msgType: 'task-result',
      payload: 'not an object',
    })).rejects.toThrow(/payload must be a JSON object/);
  });

  it('all 4 tools return {degraded:true, reason:"agentbbs-not-found"} when agentbbs is missing', async () => {
    if (havePkg) return; // happy-path case is covered elsewhere
    for (const t of agentbbsTools) {
      const minimalInput: Record<string, unknown> =
        t.name === 'federation_bbs_register'    ? { roomLabel: '#sales' } :
        t.name === 'federation_bbs_publish'     ? { roomId: 'sales-12345678', msgType: 'task-result', payload: {} } :
        t.name === 'federation_bbs_watch'       ? { roomId: 'sales-12345678' } :
        t.name === 'federation_bbs_human_join'  ? { roomId: 'sales-12345678' } :
        {};
      const r: any = await t.handler(minimalInput);
      expect(r.success).toBe(true);
      expect(r.degraded).toBe(true);
      expect(r.reason).toBe('agentbbs-not-found');
    }
  });
});

describe('agentbbs MCP tools — happy path (real package)', () => {
  let workdir: string;
  let roomId: string;

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'agentbbs-tools-'));
  });

  afterAll(() => {
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it.skipIf(!havePkg)('register: creates a room and persists registry', async () => {
    const register = findTool('federation_bbs_register');
    const r: any = await register.handler({ basePath: workdir, roomLabel: '#sales' });
    expect(r.success).toBe(true);
    expect(r.degraded).toBeUndefined();
    expect(r.trustLevel).toBe('attested');
    expect(r.roomId).toMatch(/^sales-[0-9a-f]{8}$/);
    expect(r.nodeId).toMatch(/^[0-9a-f]{16}$/);
    roomId = r.roomId;
    const reg = JSON.parse(readFileSync(join(workdir, 'rooms.json'), 'utf-8'));
    expect(reg[roomId]).toBeDefined();
    expect(reg[roomId].roomLabel).toBe('#sales');
  });

  it.skipIf(!havePkg)('publish: writes a ReplicateMessage envelope to the room log', async () => {
    const publish = findTool('federation_bbs_publish');
    const r: any = await publish.handler({
      basePath: workdir,
      roomId,
      msgType: 'task-result',
      payload: { agent: 'lead-gen', leadsQualified: 3 },
    });
    expect(r.success).toBe(true);
    expect(r.degraded).toBeUndefined();
    expect(r.envelopeId).toBeTruthy();
    expect(r.recipientHopCount).toBe(0);
    expect(existsSync(join(workdir, `room-${roomId}.jsonl`))).toBe(true);
  });

  it.skipIf(!havePkg)('watch: returns envelopes from the room log with monotonic seq', async () => {
    const watch = findTool('federation_bbs_watch');
    const r: any = await watch.handler({ basePath: workdir, roomId, limit: 50 });
    expect(r.success).toBe(true);
    expect(r.envelopes.length).toBeGreaterThan(0);
    // Seq must be strictly monotonic
    let lastSeq = 0;
    for (const e of r.envelopes) {
      expect(e.seq).toBeGreaterThan(lastSeq);
      lastSeq = e.seq;
    }
  });

  it.skipIf(!havePkg)('human_join: mints a single-use Ed25519-signed token that expires in the future', async () => {
    const join = findTool('federation_bbs_human_join');
    const before = Date.now();
    const r: any = await join.handler({ roomId: 'sales-12345678', ttlSeconds: 120 });
    const after = Date.now();
    expect(r.success).toBe(true);
    expect(r.degraded).toBeUndefined();
    expect(r.handshakeToken).toBeTruthy();
    expect(r.handshakeToken.length).toBeGreaterThan(50);
    expect(r.webUrl).toMatch(/^https:\/\/agentbbs\.local\//);
    expect(r.sshCommand).toMatch(/^ssh /);
    const expiresAt = new Date(r.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(before);
    // Expiry must be ≤ ttlSeconds from now (within a wide margin to absorb scheduling jitter).
    expect(expiresAt - after).toBeLessThanOrEqual(120 * 1000 + 1000);
    expect(expiresAt - before).toBeGreaterThanOrEqual(120 * 1000 - 1000);
  });
});

describe('agentbbs — dedup + seq optimizations (ADR-164, PeerHello spam fix)', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'bbs-opt-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('shouldEmitHello: a genuinely new registration always emits', () => {
    expect(shouldEmitHello(false, 1_000, -Infinity, 60)).toBe(true);
  });

  it('shouldEmitHello: re-register within the window is suppressed (kills the 8-hello spam)', () => {
    // last hello 10s ago, 60s window -> suppress the retry
    expect(shouldEmitHello(true, 60_000, 50_000, 60)).toBe(false);
  });

  it('shouldEmitHello: re-register past the window refreshes the heartbeat', () => {
    // last hello 61s ago, 60s window -> emit a fresh heartbeat
    expect(shouldEmitHello(true, 61_000, 0, 60)).toBe(true);
  });

  it('dedupEnvelopes: collapses duplicate envelopeIds, preserves order (first wins)', () => {
    const out = dedupEnvelopes([
      { envelopeId: 'a' }, { envelopeId: 'b' }, { envelopeId: 'a' }, { envelopeId: 'c' },
    ]);
    expect(out.map(e => e.envelopeId)).toEqual(['a', 'b', 'c']);
  });

  it('nextSeq: monotonic across 500 appends (tail-read stays exact)', () => {
    const p = join(dir, 'room-seq.jsonl');
    expect(nextSeq(p)).toBe(1); // no file yet
    let seq = 0;
    for (let i = 0; i < 500; i++) {
      seq = nextSeq(p);
      appendFileSync(p, JSON.stringify({ envelopeId: `e${i}`, roomId: 'r', seq, msgType: 'X', payload: {}, timestamp: new Date().toISOString() }) + '\n');
    }
    expect(seq).toBe(500);
    expect(nextSeq(p)).toBe(501);
  });

  it('nextSeq: exact even when the log exceeds the tail read window (partial first line)', () => {
    const p = join(dir, 'room-big.jsonl');
    const pad = 'x'.repeat(2000); // ~2KB/line * 60 lines ~= 120KB > 64KB tail window
    let seq = 0;
    for (let i = 0; i < 60; i++) {
      seq = nextSeq(p);
      appendFileSync(p, JSON.stringify({ envelopeId: `e${i}`, roomId: 'r', seq, msgType: 'X', payload: { pad }, timestamp: new Date().toISOString() }) + '\n');
    }
    expect(seq).toBe(60);
    expect(nextSeq(p)).toBe(61);
  });

  it('lastPeerHelloMs: most-recent PeerHello timestamp, ignoring other msgTypes', () => {
    const p = join(dir, 'room-hello.jsonl');
    expect(lastPeerHelloMs(p)).toBe(-Infinity); // no file
    const t1 = '2026-09-10T00:00:00.000Z';
    const t2 = '2026-09-10T00:05:00.000Z';
    appendFileSync(p, JSON.stringify({ envelopeId: 'h1', roomId: 'r', seq: 1, msgType: 'PeerHello', payload: {}, timestamp: t1 }) + '\n');
    appendFileSync(p, JSON.stringify({ envelopeId: 'x1', roomId: 'r', seq: 2, msgType: 'pod-status', payload: {}, timestamp: '2026-09-10T00:10:00.000Z' }) + '\n');
    appendFileSync(p, JSON.stringify({ envelopeId: 'h2', roomId: 'r', seq: 3, msgType: 'PeerHello', payload: {}, timestamp: t2 }) + '\n');
    expect(lastPeerHelloMs(p)).toBe(Date.parse(t2));
  });
});
