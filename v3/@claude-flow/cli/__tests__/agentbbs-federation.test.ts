/**
 * agentbbs Phase 2 cross-host federation.
 *
 * The happy path here is small; most of this file is the trust boundary.
 * Merge ingests bytes from another machine, so the tests that matter are the
 * ones that prove a hostile peer cannot get an envelope past verification —
 * forged signatures, key substitution, replay, oversize, hop exhaustion, and
 * cross-room injection.
 *
 * Two nodes are run against real temp directories and a real HTTP server, so
 * this exercises the actual transport rather than a mocked one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';

import {
  getNodeIdentity,
  signEnvelope,
  verifyEnvelope,
  canonicalEnvelopeBytes,
  addPeer,
  removePeer,
  readPeers,
  readEnvelopes,
  mergeEnvelopes,
  syncRoomFromPeer,
  serveFederation,
  validatePeerUrl,
  validateRoomId,
  MAX_HOPS,
  MAX_ENVELOPE_BYTES,
  type SignedEnvelope,
} from '../src/mcp-tools/agentbbs-federation.js';

let dirA: string, dirB: string;
const servers: Server[] = [];

function tmp(p: string) { return mkdtempSync(join(tmpdir(), p)); }

function envelope(over: Partial<SignedEnvelope> = {}): SignedEnvelope {
  return {
    envelopeId: 'e-' + Math.random().toString(36).slice(2, 10),
    roomId: 'sales-dd6531eb',
    seq: 1,
    msgType: 'Note',
    payload: { hello: 'world' },
    timestamp: '2026-09-09T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => { dirA = tmp('abbs-a-'); dirB = tmp('abbs-b-'); });
afterEach(() => {
  for (const s of servers.splice(0)) { try { s.close(); } catch { /* already closed */ } }
  for (const d of [dirA, dirB]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
});

describe('node identity', () => {
  it('creates a stable identity and reuses it across calls', async () => {
    const a = await getNodeIdentity(dirA);
    const b = await getNodeIdentity(dirA);
    expect(a.nodeId).toBe(b.nodeId);
    expect(a.nodeId).toMatch(/^[0-9a-f]{16}$/);
    expect(a.publicKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives different hosts different identities', async () => {
    const a = await getNodeIdentity(dirA);
    const b = await getNodeIdentity(dirB);
    expect(a.nodeId).not.toBe(b.nodeId);
  });

  it('persists the private key 0600 and never widens it', async () => {
    await getNodeIdentity(dirA);
    const mode = statSync(join(dirA, 'node-identity.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('rejects a malformed identity file rather than trusting it', async () => {
    await getNodeIdentity(dirA);
    const p = join(dirA, 'node-identity.json');
    const bad = JSON.parse(readFileSync(p, 'utf-8'));
    bad.nodeId = 'not-hex';
    require('node:fs').writeFileSync(p, JSON.stringify(bad));
    await expect(getNodeIdentity(dirA)).rejects.toThrow(/malformed/);
  });
});

describe('signing and verification', () => {
  it('signs and verifies a round trip', async () => {
    const id = await getNodeIdentity(dirA);
    const signed = await signEnvelope(dirA, envelope());
    expect(signed.origin).toBe(id.nodeId);
    expect(await verifyEnvelope(signed, id.publicKey)).toBe(true);
  });

  it('survives a JSON round trip — the receiver reconstructs identical bytes', async () => {
    const id = await getNodeIdentity(dirA);
    const signed = await signEnvelope(dirA, envelope({ payload: { b: 2, a: 1, nested: { z: 1, y: [3, 2] } } }));
    const overWire = JSON.parse(JSON.stringify(signed));
    expect(await verifyEnvelope(overWire, id.publicKey)).toBe(true);
  });

  it('canonicalizes payload key order, so equal values sign equally', () => {
    // Pin envelopeId — the helper randomizes it, and we are isolating payload
    // key order as the only difference between the two inputs.
    const one = canonicalEnvelopeBytes(envelope({ envelopeId: 'fixed', payload: { a: 1, b: 2 } }));
    const two = canonicalEnvelopeBytes(envelope({ envelopeId: 'fixed', payload: { b: 2, a: 1 } }));
    expect(Buffer.from(one).toString()).toBe(Buffer.from(two).toString());
  });

  it('excludes hops from the signature so relaying does not invalidate it', async () => {
    const id = await getNodeIdentity(dirA);
    const signed = await signEnvelope(dirA, envelope());
    const relayed = { ...signed, hops: 3 };
    expect(await verifyEnvelope(relayed, id.publicKey)).toBe(true);
  });

  describe('adversarial', () => {
    it('rejects a tampered payload', async () => {
      const id = await getNodeIdentity(dirA);
      const signed = await signEnvelope(dirA, envelope());
      expect(await verifyEnvelope({ ...signed, payload: { hello: 'tampered' } }, id.publicKey)).toBe(false);
    });

    it('rejects a tampered origin — you cannot claim to be another node', async () => {
      const id = await getNodeIdentity(dirA);
      const signed = await signEnvelope(dirA, envelope());
      expect(await verifyEnvelope({ ...signed, origin: 'deadbeefdeadbeef' }, id.publicKey)).toBe(false);
    });

    it('rejects verification against a different key (key substitution)', async () => {
      const idB = await getNodeIdentity(dirB);
      const signedByA = await signEnvelope(dirA, envelope());
      expect(await verifyEnvelope(signedByA, idB.publicKey)).toBe(false);
    });

    it('rejects an unsigned or malformed-signature envelope', async () => {
      const id = await getNodeIdentity(dirA);
      expect(await verifyEnvelope(envelope(), id.publicKey)).toBe(false);
      expect(await verifyEnvelope(envelope({ signature: 'zz' }), id.publicKey)).toBe(false);
      expect(await verifyEnvelope(envelope({ signature: 'a'.repeat(128) }), id.publicKey)).toBe(false);
    });
  });
});

describe('peer registry', () => {
  const KEY = 'a'.repeat(64);

  it('pins a peer and lists it', () => {
    const p = addPeer(dirA, { nodeId: '0123456789abcdef', url: 'http://127.0.0.1:9999', publicKey: KEY });
    expect(p.nodeId).toBe('0123456789abcdef');
    expect(readPeers(dirA)).toHaveLength(1);
    expect(removePeer(dirA, '0123456789abcdef')).toBe(true);
    expect(readPeers(dirA)).toHaveLength(0);
  });

  it('refuses to silently re-pin a known nodeId to a different key', () => {
    addPeer(dirA, { nodeId: '0123456789abcdef', url: 'http://127.0.0.1:1', publicKey: KEY });
    expect(() => addPeer(dirA, { nodeId: '0123456789abcdef', url: 'http://127.0.0.1:1', publicKey: 'b'.repeat(64) }))
      .toThrow(/already pinned/);
  });

  it('rejects malformed identifiers and hostile URLs', () => {
    expect(() => addPeer(dirA, { nodeId: 'short', url: 'http://x', publicKey: KEY })).toThrow(/nodeId/);
    expect(() => addPeer(dirA, { nodeId: '0123456789abcdef', url: 'http://x', publicKey: 'nothex' })).toThrow(/publicKey/);
    expect(() => validatePeerUrl('file:///etc/passwd')).toThrow(/http or https/);
    expect(() => validatePeerUrl('http://user:pw@host')).toThrow(/credentials/);
    expect(() => validatePeerUrl('not a url')).toThrow();
  });

  it('rejects room ids that could escape the log directory', () => {
    expect(() => validateRoomId('../../etc/passwd')).toThrow();
    expect(() => validateRoomId('a/../../b')).toThrow(/\.\./);
    expect(() => validateRoomId('')).toThrow();
    expect(() => validateRoomId('x'.repeat(129))).toThrow(/128/);
  });
});

describe('union merge', () => {
  it('merges verified envelopes from a peer', async () => {
    const idB = await getNodeIdentity(dirB);
    const e1 = await signEnvelope(dirB, envelope({ seq: 1 }));
    const e2 = await signEnvelope(dirB, envelope({ seq: 2 }));
    const r = await mergeEnvelopes(dirA, 'sales-dd6531eb', [e1, e2], idB.publicKey);
    expect(r.merged).toBe(2);
    expect(readEnvelopes(dirA, 'sales-dd6531eb')).toHaveLength(2);
  });

  it('is idempotent — replaying the same batch merges nothing new', async () => {
    const idB = await getNodeIdentity(dirB);
    const e1 = await signEnvelope(dirB, envelope());
    await mergeEnvelopes(dirA, 'sales-dd6531eb', [e1], idB.publicKey);
    const again = await mergeEnvelopes(dirA, 'sales-dd6531eb', [e1], idB.publicKey);
    expect(again.merged).toBe(0);
    expect(again.skippedDuplicate).toBe(1);
    expect(readEnvelopes(dirA, 'sales-dd6531eb')).toHaveLength(1);
  });

  it('is order independent — A then B equals B then A', async () => {
    const idB = await getNodeIdentity(dirB);
    const e1 = await signEnvelope(dirB, envelope({ seq: 1 }));
    const e2 = await signEnvelope(dirB, envelope({ seq: 2 }));
    const forward = tmp('abbs-f-'); const backward = tmp('abbs-r-');
    try {
      await mergeEnvelopes(forward, 'sales-dd6531eb', [e1, e2], idB.publicKey);
      await mergeEnvelopes(backward, 'sales-dd6531eb', [e2, e1], idB.publicKey);
      const ids = (d: string) => readEnvelopes(d, 'sales-dd6531eb').map(e => e.envelopeId).sort();
      expect(ids(forward)).toEqual(ids(backward));
    } finally {
      rmSync(forward, { recursive: true, force: true });
      rmSync(backward, { recursive: true, force: true });
    }
  });

  describe('adversarial', () => {
    it('drops forged envelopes rather than replicating them', async () => {
      const idB = await getNodeIdentity(dirB);
      const good = await signEnvelope(dirB, envelope());
      const forged = { ...good, envelopeId: 'forged-1', payload: { hello: 'evil' } };
      const r = await mergeEnvelopes(dirA, 'sales-dd6531eb', [forged], idB.publicKey);
      expect(r.merged).toBe(0);
      expect(r.skippedUnverified).toBe(1);
      expect(readEnvelopes(dirA, 'sales-dd6531eb')).toHaveLength(0);
    });

    it('drops envelopes signed by a key other than the pinned one', async () => {
      const idB = await getNodeIdentity(dirB);
      const rogue = tmp('abbs-rogue-');
      try {
        const signedByRogue = await signEnvelope(rogue, envelope());
        const r = await mergeEnvelopes(dirA, 'sales-dd6531eb', [signedByRogue], idB.publicKey);
        expect(r.merged).toBe(0);
        expect(r.skippedUnverified).toBe(1);
      } finally { rmSync(rogue, { recursive: true, force: true }); }
    });

    it('drops cross-room injection — an envelope for another room', async () => {
      const idB = await getNodeIdentity(dirB);
      const other = await signEnvelope(dirB, envelope({ roomId: 'finance-f6552ffe' }));
      const r = await mergeEnvelopes(dirA, 'sales-dd6531eb', [other], idB.publicKey);
      expect(r.merged).toBe(0);
      expect(r.skippedUnverified).toBe(1);
    });

    it('drops envelopes at or past the hop limit', async () => {
      const idB = await getNodeIdentity(dirB);
      const looped = await signEnvelope(dirB, envelope());
      const r = await mergeEnvelopes(dirA, 'sales-dd6531eb', [{ ...looped, hops: MAX_HOPS }], idB.publicKey);
      expect(r.merged).toBe(0);
      expect(r.skippedHopLimit).toBe(1);
    });

    it('increments hops on merge so a cycle terminates', async () => {
      const idB = await getNodeIdentity(dirB);
      const e = await signEnvelope(dirB, envelope());
      await mergeEnvelopes(dirA, 'sales-dd6531eb', [e], idB.publicKey);
      expect(readEnvelopes(dirA, 'sales-dd6531eb')[0].hops).toBe(1);
    });

    it('drops oversize envelopes', async () => {
      const idB = await getNodeIdentity(dirB);
      const big = await signEnvelope(dirB, envelope({ payload: { blob: 'x'.repeat(MAX_ENVELOPE_BYTES) } }));
      const r = await mergeEnvelopes(dirA, 'sales-dd6531eb', [big], idB.publicKey);
      expect(r.merged).toBe(0);
      expect(r.skippedOversize).toBe(1);
    });

    it('tolerates malformed rows without throwing', async () => {
      const idB = await getNodeIdentity(dirB);
      const r = await mergeEnvelopes(dirA, 'sales-dd6531eb', [null as any, {} as any, 'x' as any], idB.publicKey);
      expect(r.merged).toBe(0);
      expect(r.skippedUnverified).toBe(3);
    });

    it('skips corrupt lines already in the local log', async () => {
      const idB = await getNodeIdentity(dirB);
      appendFileSync(join(dirA, 'room-sales-dd6531eb.jsonl'), 'not json\n');
      const e = await signEnvelope(dirB, envelope());
      const r = await mergeEnvelopes(dirA, 'sales-dd6531eb', [e], idB.publicKey);
      expect(r.merged).toBe(1);
    });
  });
});

describe('http transport (two real nodes)', () => {
  it('serves envelopes and a peer pulls, verifies and merges them', async () => {
    const idB = await getNodeIdentity(dirB);
    const e1 = await signEnvelope(dirB, envelope({ seq: 1 }));
    const e2 = await signEnvelope(dirB, envelope({ seq: 2 }));
    appendFileSync(join(dirB, 'room-sales-dd6531eb.jsonl'), JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n');

    const { server, port } = await serveFederation(dirB, { port: 0 });
    servers.push(server);

    addPeer(dirA, { nodeId: idB.nodeId, url: `http://127.0.0.1:${port}`, publicKey: idB.publicKey });
    const peer = readPeers(dirA)[0];
    const r = await syncRoomFromPeer(dirA, peer, 'sales-dd6531eb');

    expect(r.merged).toBe(2);
    expect(readEnvelopes(dirA, 'sales-dd6531eb')).toHaveLength(2);
    expect(readPeers(dirA)[0].lastSeq?.['sales-dd6531eb']).toBe(2);
  });

  it('a second sync is a no-op — since= advances', async () => {
    const idB = await getNodeIdentity(dirB);
    const e1 = await signEnvelope(dirB, envelope({ seq: 1 }));
    appendFileSync(join(dirB, 'room-sales-dd6531eb.jsonl'), JSON.stringify(e1) + '\n');
    const { server, port } = await serveFederation(dirB, { port: 0 });
    servers.push(server);
    addPeer(dirA, { nodeId: idB.nodeId, url: `http://127.0.0.1:${port}`, publicKey: idB.publicKey });

    await syncRoomFromPeer(dirA, readPeers(dirA)[0], 'sales-dd6531eb');
    const second = await syncRoomFromPeer(dirA, readPeers(dirA)[0], 'sales-dd6531eb');
    expect(second.merged).toBe(0);
    expect(readEnvelopes(dirA, 'sales-dd6531eb')).toHaveLength(1);
  });

  it('never serves the private key', async () => {
    await getNodeIdentity(dirB);
    const { server, port } = await serveFederation(dirB, { port: 0 });
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${port}/agentbbs/v1/identity`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(body.privateKey).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(JSON.parse(readFileSync(join(dirB, 'node-identity.json'), 'utf-8')).privateKey);
  });

  it('binds loopback by default rather than a routable interface', async () => {
    const { server, host } = await serveFederation(dirB, { port: 0 });
    servers.push(server);
    expect(host).toBe('127.0.0.1');
  });

  it('is read only — mutating verbs are refused', async () => {
    const { server, port } = await serveFederation(dirB, { port: 0 });
    servers.push(server);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(`http://127.0.0.1:${port}/agentbbs/v1/rooms/x/envelopes`, { method });
      expect(res.status).toBe(405);
    }
  });

  it('rejects a traversing roomId at the HTTP boundary', async () => {
    const { server, port } = await serveFederation(dirB, { port: 0 });
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${port}/agentbbs/v1/rooms/${encodeURIComponent('../../etc/passwd')}/envelopes`);
    expect(res.status).toBe(400);
  });

  it('surfaces an unreachable peer as an error instead of hanging', async () => {
    const idB = await getNodeIdentity(dirB);
    addPeer(dirA, { nodeId: idB.nodeId, url: 'http://127.0.0.1:1', publicKey: idB.publicKey });
    await expect(syncRoomFromPeer(dirA, readPeers(dirA)[0], 'sales-dd6531eb')).rejects.toThrow();
  });
});

describe('convergence', () => {
  it('two nodes that each publish converge on the same set after mutual sync', async () => {
    const idA = await getNodeIdentity(dirA);
    const idB = await getNodeIdentity(dirB);
    const room = 'sales-dd6531eb';

    const a1 = await signEnvelope(dirA, envelope({ seq: 1, payload: { from: 'A' } }));
    const b1 = await signEnvelope(dirB, envelope({ seq: 1, payload: { from: 'B' } }));
    appendFileSync(join(dirA, `room-${room}.jsonl`), JSON.stringify(a1) + '\n');
    appendFileSync(join(dirB, `room-${room}.jsonl`), JSON.stringify(b1) + '\n');

    const sa = await serveFederation(dirA, { port: 0 }); servers.push(sa.server);
    const sb = await serveFederation(dirB, { port: 0 }); servers.push(sb.server);

    addPeer(dirA, { nodeId: idB.nodeId, url: `http://127.0.0.1:${sb.port}`, publicKey: idB.publicKey });
    addPeer(dirB, { nodeId: idA.nodeId, url: `http://127.0.0.1:${sa.port}`, publicKey: idA.publicKey });

    await syncRoomFromPeer(dirA, readPeers(dirA)[0], room);
    await syncRoomFromPeer(dirB, readPeers(dirB)[0], room);

    const setA = readEnvelopes(dirA, room).map(e => e.envelopeId).sort();
    const setB = readEnvelopes(dirB, room).map(e => e.envelopeId).sort();
    expect(setA).toEqual(setB);
    expect(setA).toHaveLength(2);
  });
});
