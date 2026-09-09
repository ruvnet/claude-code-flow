/**
 * agentbbs Phase 2 — cross-host federation.
 *
 * Phase 1 (`agentbbs-tools.ts`) gives every host an append-only room log at
 * `<basePath>/room-<roomId>.jsonl`, and derives `roomId` deterministically from
 * the room label. Two independent hosts that register `#sales` therefore
 * compute the *same* roomId without ever talking to each other. That is the
 * property this module builds on.
 *
 * ## Why a signed union-merge, and not a consensus protocol
 *
 * A room log is an append-only set of immutable envelopes. Two hosts that each
 * append locally hold two subsets of the same logical set, so reconciling them
 * is a set union — there is no conflicting write to arbitrate, and therefore
 * nothing for a consensus round to decide. Union is commutative, associative
 * and idempotent, which makes sync order-independent and safe to retry: pulling
 * the same peer twice, or pulling A-then-B versus B-then-A, converges on the
 * same log. That is a CRDT (a grow-only set keyed by `envelopeId`), and it is
 * strictly cheaper and less failure-prone than the Byzantine agreement the
 * plugin README gestures at.
 *
 * What union does *not* give you is authenticity. If any peer can inject an
 * envelope, the merge faithfully replicates forgeries. So every envelope is
 * Ed25519-signed by its originating node, and a receiver verifies the signature
 * against the *pinned* public key it recorded when the peer was added — not
 * against a key carried in the envelope, which would let an attacker sign with
 * their own key and claim any origin. Trust is pinned at peer-add time; the
 * wire is treated as hostile.
 *
 * ## Transport
 *
 * Pull-based HTTP. A node serves `GET /agentbbs/v1/rooms/:roomId/envelopes?since=N`
 * and peers poll it. Pull is deliberate: it needs no inbound connectivity from
 * the peer's side, survives a node being offline (it just catches up later),
 * and gives the *receiver* control over how much it ingests. Push would invert
 * that and make every node an unauthenticated write target.
 *
 * Designed for a private overlay (Tailscale/WireGuard) where the network
 * already authenticates the host. Signatures mean a compromised or hostile peer
 * still cannot forge another node's envelopes. See `bindHost` on serve() — it
 * binds loopback by default, and binding a routable interface is an explicit
 * operator choice.
 *
 * ## Bounds
 *
 * Every ingest path is bounded: envelope count per sync, byte size per envelope,
 * total bytes per response, peer count, and hop count. An unbounded merge from
 * an untrusted peer is a memory-exhaustion primitive, so limits are enforced on
 * the *receiving* side where they cannot be negotiated away by the sender.
 *
 * @module @claude-flow/cli/mcp-tools/agentbbs-federation
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

/** Max envelopes accepted from one peer in one sync. */
export const MAX_ENVELOPES_PER_SYNC = 5_000;
/** Max serialized bytes for a single envelope. */
export const MAX_ENVELOPE_BYTES = 64 * 1024;
/** Max total bytes read from one peer response. */
export const MAX_SYNC_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Max peers in the registry. */
export const MAX_PEERS = 256;
/** Max federation hops before an envelope stops propagating. */
export const MAX_HOPS = 8;
/** Per-request timeout when pulling from a peer. */
export const SYNC_TIMEOUT_MS = 15_000;

const ROOM_ID_RE = /^[A-Za-z0-9_.\-:/@#]+$/;
const NODE_ID_RE = /^[0-9a-f]{16}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

export interface NodeIdentity {
  nodeId: string;
  publicKey: string;   // hex
  privateKey: string;  // hex — never leaves this host
  createdAt: string;
}

export interface FederationPeer {
  nodeId: string;
  url: string;
  publicKey: string;   // hex, pinned at add time
  label?: string;
  addedAt: string;
  lastSyncedAt?: string;
  lastSeq?: Record<string, number>;
}

export interface SignedEnvelope {
  envelopeId: string;
  roomId: string;
  seq: number;
  msgType: string;
  payload: unknown;
  timestamp: string;
  origin?: string;      // nodeId that created it
  hops?: number;
  signature?: string;   // hex Ed25519 over canonical()
}

let _edMod: any = null;
async function loadEd25519(): Promise<any> {
  if (!_edMod) _edMod = await import('@noble/ed25519');
  return _edMod;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function hex(buf: Uint8Array): string {
  return Buffer.from(buf).toString('hex');
}

function unhex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'hex'));
}

/**
 * Deterministic byte string an envelope's signature covers.
 *
 * Field order is fixed here rather than relying on `JSON.stringify` key order,
 * because a receiver must reconstruct byte-identical input from a payload that
 * survived a JSON round trip. `payload` is canonicalized recursively with
 * sorted keys for the same reason: `{a:1,b:2}` and `{b:2,a:1}` are the same
 * value and must not produce different signatures.
 *
 * `hops` is deliberately excluded — it is mutated in transit by design, so
 * including it would invalidate the signature at the first relay.
 */
export function canonicalEnvelopeBytes(env: SignedEnvelope): Uint8Array {
  const canon = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(canon);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = canon((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  const material = JSON.stringify({
    envelopeId: env.envelopeId,
    roomId: env.roomId,
    seq: env.seq,
    msgType: env.msgType,
    timestamp: env.timestamp,
    origin: env.origin ?? '',
    payload: canon(env.payload),
  });
  return new TextEncoder().encode(material);
}

function identityPath(basePath: string): string {
  return join(basePath, 'node-identity.json');
}

function peersPath(basePath: string): string {
  return join(basePath, 'peers.json');
}

function roomLogPath(basePath: string, roomId: string): string {
  return join(basePath, `room-${roomId}.jsonl`);
}

/**
 * Load or create this host's long-lived Ed25519 identity.
 *
 * Phase 1 minted an ephemeral key per process, which is fine for local token
 * signing but useless across hosts: a peer cannot pin a key that changes on
 * every restart. This persists one, 0600, and derives a stable nodeId from the
 * public key so identity is verifiable rather than self-asserted.
 */
export async function getNodeIdentity(basePath: string): Promise<NodeIdentity> {
  ensureDir(basePath);
  const p = identityPath(basePath);
  if (existsSync(p)) {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as NodeIdentity;
    if (!NODE_ID_RE.test(parsed.nodeId ?? '') || !HEX64_RE.test(parsed.publicKey ?? '')) {
      throw new Error('node-identity.json is malformed');
    }
    return parsed;
  }
  const ed = await loadEd25519();
  const priv: Uint8Array = ed.utils?.randomPrivateKey ? ed.utils.randomPrivateKey() : new Uint8Array(randomBytes(32));
  const pub: Uint8Array = await (ed.getPublicKeyAsync ?? ed.getPublicKey)(priv);
  const publicKey = hex(pub);
  const identity: NodeIdentity = {
    nodeId: createHash('sha256').update(`agentbbs:node:${publicKey}`).digest('hex').slice(0, 16),
    publicKey,
    privateKey: hex(priv),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(p, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* best effort on filesystems without modes */ }
  return identity;
}

export async function signEnvelope(basePath: string, env: SignedEnvelope): Promise<SignedEnvelope> {
  const id = await getNodeIdentity(basePath);
  const ed = await loadEd25519();
  const withOrigin: SignedEnvelope = { ...env, origin: id.nodeId, hops: env.hops ?? 0 };
  const sig: Uint8Array = await (ed.signAsync ?? ed.sign)(canonicalEnvelopeBytes(withOrigin), unhex(id.privateKey));
  return { ...withOrigin, signature: hex(sig) };
}

/**
 * Verify an envelope against a public key the caller already trusts.
 *
 * The key is passed in rather than read from the envelope on purpose: an
 * envelope-carried key proves only that the sender holds *a* key, not that they
 * are who the `origin` field claims. Callers pass the key pinned at peer-add.
 */
export async function verifyEnvelope(env: SignedEnvelope, publicKeyHex: string): Promise<boolean> {
  if (!env.signature || !HEX64_RE.test(publicKeyHex)) return false;
  if (!/^[0-9a-f]{128}$/.test(env.signature)) return false;
  try {
    const ed = await loadEd25519();
    return await (ed.verifyAsync ?? ed.verify)(unhex(env.signature), canonicalEnvelopeBytes(env), unhex(publicKeyHex));
  } catch {
    return false;
  }
}

export function readPeers(basePath: string): FederationPeer[] {
  const p = peersPath(basePath);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePeers(basePath: string, peers: FederationPeer[]): void {
  ensureDir(basePath);
  writeFileSync(peersPath(basePath), JSON.stringify(peers, null, 2) + '\n');
}

/**
 * Reject anything that is not a plain http(s) URL to a host.
 *
 * Blocks credentials-in-URL (they would be logged), and non-http schemes such
 * as `file:` which would turn a peer entry into a local file read.
 */
export function validatePeerUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('peer url is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('peer url must be http or https');
  }
  if (u.username || u.password) throw new Error('peer url must not embed credentials');
  return u.origin;
}

export function addPeer(
  basePath: string,
  input: { nodeId: string; url: string; publicKey: string; label?: string },
): FederationPeer {
  if (!NODE_ID_RE.test(input.nodeId ?? '')) throw new Error('nodeId must be 16 lowercase hex chars');
  if (!HEX64_RE.test(input.publicKey ?? '')) throw new Error('publicKey must be 64 lowercase hex chars');
  const url = validatePeerUrl(String(input.url));

  const peers = readPeers(basePath);
  if (peers.length >= MAX_PEERS) throw new Error(`peer registry is full (${MAX_PEERS})`);

  const existing = peers.find(p => p.nodeId === input.nodeId);
  if (existing) {
    // Re-pinning a different key for a known nodeId is how a key-substitution
    // attack would present. Require an explicit remove first.
    if (existing.publicKey !== input.publicKey) {
      throw new Error(`nodeId ${input.nodeId} is already pinned to a different publicKey; remove it first`);
    }
    existing.url = url;
    if (input.label) existing.label = input.label;
    writePeers(basePath, peers);
    return existing;
  }

  const peer: FederationPeer = {
    nodeId: input.nodeId,
    url,
    publicKey: input.publicKey,
    label: input.label,
    addedAt: new Date().toISOString(),
    lastSeq: {},
  };
  peers.push(peer);
  writePeers(basePath, peers);
  return peer;
}

export function removePeer(basePath: string, nodeId: string): boolean {
  const peers = readPeers(basePath);
  const next = peers.filter(p => p.nodeId !== nodeId);
  if (next.length === peers.length) return false;
  writePeers(basePath, next);
  return true;
}

export function readEnvelopes(basePath: string, roomId: string): SignedEnvelope[] {
  const p = roomLogPath(basePath, roomId);
  if (!existsSync(p)) return [];
  const out: SignedEnvelope[] = [];
  for (const line of readFileSync(p, 'utf-8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

export function validateRoomId(roomId: string): string {
  if (!roomId || typeof roomId !== 'string') throw new Error('roomId is required');
  if (roomId.length > 128) throw new Error('roomId exceeds 128 chars');
  // Also blocks path traversal: `.` is allowed but `/` segments cannot form
  // `..` without tripping the explicit check below.
  if (!ROOM_ID_RE.test(roomId)) throw new Error('roomId has invalid characters');
  if (roomId.includes('..')) throw new Error('roomId must not contain ..');
  return roomId;
}

export interface MergeResult {
  merged: number;
  skippedDuplicate: number;
  skippedUnverified: number;
  skippedOversize: number;
  skippedHopLimit: number;
}

/**
 * Union-merge verified envelopes from a peer into the local room log.
 *
 * Idempotent: `envelopeId` is the merge key, so replaying the same batch is a
 * no-op. Anything that fails verification is dropped and counted rather than
 * quarantined — a receiver has no use for an envelope it cannot attribute.
 */
export async function mergeEnvelopes(
  basePath: string,
  roomId: string,
  incoming: SignedEnvelope[],
  peerPublicKey: string,
): Promise<MergeResult> {
  validateRoomId(roomId);
  ensureDir(basePath);

  const result: MergeResult = {
    merged: 0, skippedDuplicate: 0, skippedUnverified: 0, skippedOversize: 0, skippedHopLimit: 0,
  };

  const existing = readEnvelopes(basePath, roomId);
  const seen = new Set(existing.map(e => e.envelopeId));
  const logPath = roomLogPath(basePath, roomId);

  const batch = incoming.slice(0, MAX_ENVELOPES_PER_SYNC);
  for (const env of batch) {
    if (!env || typeof env !== 'object' || typeof env.envelopeId !== 'string') {
      result.skippedUnverified++; continue;
    }
    if (env.roomId !== roomId) { result.skippedUnverified++; continue; }
    if (seen.has(env.envelopeId)) { result.skippedDuplicate++; continue; }
    if (JSON.stringify(env).length > MAX_ENVELOPE_BYTES) { result.skippedOversize++; continue; }
    if ((env.hops ?? 0) >= MAX_HOPS) { result.skippedHopLimit++; continue; }
    if (!(await verifyEnvelope(env, peerPublicKey))) { result.skippedUnverified++; continue; }

    appendFileSync(logPath, JSON.stringify({ ...env, hops: (env.hops ?? 0) + 1 }) + '\n');
    seen.add(env.envelopeId);
    result.merged++;
  }
  return result;
}

/** Pull one room from one peer and merge what verifies. */
export async function syncRoomFromPeer(
  basePath: string,
  peer: FederationPeer,
  roomId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MergeResult & { peerNodeId: string; roomId: string }> {
  validateRoomId(roomId);
  const since = peer.lastSeq?.[roomId] ?? 0;
  const url = `${peer.url}/agentbbs/v1/rooms/${encodeURIComponent(roomId)}/envelopes?since=${since}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  let body: any;
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`peer ${peer.nodeId} returned ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_SYNC_RESPONSE_BYTES) throw new Error(`peer ${peer.nodeId} response exceeds size cap`);
    body = JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }

  const envelopes: SignedEnvelope[] = Array.isArray(body?.envelopes) ? body.envelopes : [];
  const merged = await mergeEnvelopes(basePath, roomId, envelopes, peer.publicKey);

  const peers = readPeers(basePath);
  const rec = peers.find(p => p.nodeId === peer.nodeId);
  if (rec) {
    rec.lastSyncedAt = new Date().toISOString();
    rec.lastSeq = rec.lastSeq ?? {};
    const maxSeq = envelopes.reduce((m, e) => Math.max(m, Number(e.seq) || 0), since);
    rec.lastSeq[roomId] = maxSeq;
    writePeers(basePath, peers);
  }
  return { ...merged, peerNodeId: peer.nodeId, roomId };
}

/**
 * Serve this node's room logs for peers to pull.
 *
 * Binds loopback unless the caller explicitly asks otherwise, so starting a
 * server never silently exposes room contents on a routable interface. Read
 * only by construction: there is no route that mutates state, which removes the
 * whole class of unauthenticated-write attacks that a push design would open.
 */
export function serveFederation(
  basePath: string,
  opts: { port?: number; bindHost?: string } = {},
): Promise<{ server: Server; port: number; host: string }> {
  const host = opts.bindHost ?? '127.0.0.1';
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, obj: unknown) => {
      const buf = Buffer.from(JSON.stringify(obj));
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length });
      res.end(buf);
    };
    try {
      if (req.method !== 'GET') return send(405, { error: 'method-not-allowed' });
      const u = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (u.pathname === '/agentbbs/v1/identity') {
        const p = identityPath(basePath);
        if (!existsSync(p)) return send(404, { error: 'no-identity' });
        const id = JSON.parse(readFileSync(p, 'utf-8')) as NodeIdentity;
        // Never serve privateKey.
        return send(200, { nodeId: id.nodeId, publicKey: id.publicKey, createdAt: id.createdAt });
      }

      const m = u.pathname.match(/^\/agentbbs\/v1\/rooms\/([^/]+)\/envelopes$/);
      if (m) {
        let roomId: string;
        try { roomId = validateRoomId(decodeURIComponent(m[1])); }
        catch (e) { return send(400, { error: (e as Error).message }); }
        const since = Math.max(0, Math.trunc(Number(u.searchParams.get('since') ?? 0)) || 0);
        const all = readEnvelopes(basePath, roomId);
        const out = all.filter(e => (Number(e.seq) || 0) > since).slice(0, MAX_ENVELOPES_PER_SYNC);
        return send(200, { roomId, since, count: out.length, envelopes: out });
      }
      return send(404, { error: 'not-found' });
    } catch (e) {
      return send(500, { error: 'internal' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port, host });
    });
  });
}

/** Constant-time compare for any future shared-secret paths. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
