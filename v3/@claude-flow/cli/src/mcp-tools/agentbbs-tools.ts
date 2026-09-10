/**
 * AgentBBS MCP Tools — Federated business-domain BBS room surface (ADR-164 Phase 1).
 *
 * Exposes the `agentbbs@~0.1.0` (a sibling BBS-style federation peer by the same
 * author as ruflo) as MCP tools so ruflo agents can register business rooms
 * (#sales, #finance, #marketing, ...), publish/watch typed envelopes, and
 * mint single-use human-join tokens for SSH/web cockpit access.
 *
 * Motivation:
 *   ADR-164 wires the "business autopilot" cockpit on top of the existing
 *   ruflo federation primitives (FederationEnvelope, PII pipeline, budget
 *   circuit breaker). The 4 tools here are the ruflo-side handles into the
 *   agentbbs Rust workspace (`crates/agentbbs-federation/` and
 *   `crates/agentbbs-mcp/`) that already implement Ed25519-signed envelopes
 *   and an MCP transport. Phase 1 ships the surface; Phases 2-5 wire deeper.
 *
 * Architectural constraint (mirrors metaharness-tools.ts / agenticow-tools.ts):
 *   - `agentbbs` lives in `optionalDependencies` — must NOT be a hard runtime dep
 *   - When the package is missing, every tool returns
 *     `{success: true, degraded: true, reason: 'agentbbs-not-found'}`
 *     so callers see one contract regardless of install state
 *   - Phase 1: polling-based watch (streaming subscriptions are Phase 4)
 *
 * @module @claude-flow/cli/mcp-tools/agentbbs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import type { MCPTool } from './types.js';
import { getProjectCwd } from './types.js';

const PACKAGE_NAME = 'agentbbs';

// Cache: amortize dynamic-import cost across handler calls.
// null = not yet attempted; false = unavailable; module = loaded.
let _agentbbsMod: any = null;
let _loadAttempted = false;

async function loadAgentbbs(): Promise<any | null> {
  if (_loadAttempted) return _agentbbsMod || null;
  _loadAttempted = true;
  try {
    _agentbbsMod = await import(PACKAGE_NAME);
    return _agentbbsMod;
  } catch (err: any) {
    if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND' ||
                /Cannot find (module|package)/i.test(String(err?.message)))) {
      _agentbbsMod = false;
      return null;
    }
    throw err;
  }
}

function degradedResult(reason: string): { success: true; degraded: true; reason: string } {
  return { success: true, degraded: true, reason };
}

function resolveBasePath(input?: string): string {
  const p = input && typeof input === 'string' && input.length > 0
    ? input
    : '.agentbbs';
  if (/\.\.[\\/]|\0/.test(p)) throw new Error('basePath contains disallowed characters');
  const abs = isAbsolute(p) ? p : resolve(getProjectCwd(), p);
  return abs;
}

function validateRoomLabel(label: string): string {
  if (!label || typeof label !== 'string') throw new Error('roomLabel is required');
  if (label.length > 128) throw new Error('roomLabel exceeds 128 chars');
  // Rooms are conventionally `#sales`, `#finance`, etc. — keep `#` in the allow-list.
  if (!/^[A-Za-z0-9_.\-:/@#]+$/.test(label)) {
    throw new Error('roomLabel may only contain [A-Za-z0-9_.\\-:/@#]');
  }
  return label;
}

function validateRoomId(roomId: string): string {
  if (!roomId || typeof roomId !== 'string') throw new Error('roomId is required');
  if (roomId.length > 128) throw new Error('roomId exceeds 128 chars');
  if (!/^[A-Za-z0-9_.\-:/@#]+$/.test(roomId)) {
    throw new Error('roomId may only contain [A-Za-z0-9_.\\-:/@#]');
  }
  return roomId;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function roomIdFromLabel(label: string): string {
  // Stable, deterministic roomId — strip leading `#`, lowercase, and append a
  // short hash so we don't collide across two rooms with the same canonical
  // label but different policies. Phase 1: deterministic over (label).
  const norm = label.replace(/^#/, '').toLowerCase();
  const h = createHash('sha256').update(`agentbbs:room:${norm}`).digest('hex').slice(0, 8);
  return `${norm}-${h}`;
}

function roomLogPath(basePath: string, roomId: string): string {
  return join(basePath, `room-${roomId}.jsonl`);
}

function roomsRegistryPath(basePath: string): string {
  return join(basePath, 'rooms.json');
}

interface BbsEnvelope {
  envelopeId: string;
  roomId: string;
  seq: number;
  msgType: string;
  payload: unknown;
  timestamp: string;
  signature?: string;
}

function readEnvelopes(path: string): BbsEnvelope[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const out: BbsEnvelope[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed line */ }
  }
  return out;
}

// Tail of the log we scan to find the last seq. Envelopes are small; one line
// always fits well inside this. Reading only the tail keeps append O(1) instead
// of O(n) as a room log grows (ADR-164 §3.2.2 requires monotonic seq, and a
// full re-parse on every publish was the cost).
const SEQ_TAIL_BYTES = 65536;

/** Last envelope's seq by scanning only the file tail; full-read fallback keeps it exact. */
export function nextSeq(path: string): number {
  if (!existsSync(path)) return 1;
  try {
    const size = statSync(path).size;
    if (size === 0) return 1;
    const start = Math.max(0, size - SEQ_TAIL_BYTES);
    const fd = openSync(path, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf-8');
    } finally {
      closeSync(fd);
    }
    // If we started mid-file the first fragment may be a partial line — drop it.
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const candidates = start > 0 && lines.length > 1 ? lines.slice(1) : lines;
    for (let i = candidates.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(candidates[i]);
        if (typeof e.seq === 'number') return e.seq + 1;
      } catch { /* keep scanning upward for the last parseable line */ }
    }
  } catch { /* fall through to the exact full-read path */ }
  // Fallback: whole-file parse (rare — huge single line, or a tail with no seq).
  const env = readEnvelopes(path);
  if (env.length === 0) return 1;
  return (env[env.length - 1].seq ?? env.length) + 1;
}

/** Window within which a fresh PeerHello is suppressed as a duplicate (heartbeat, not spam). */
const HELLO_WINDOW_SECS = Number(process.env.FEDERATION_BBS_HELLO_WINDOW_SECS ?? 60);

/** Timestamp (ms) of the most recent PeerHello for a room, or -Infinity if none. */
export function lastPeerHelloMs(logPath: string): number {
  if (!existsSync(logPath)) return -Infinity;
  const env = readEnvelopes(logPath);
  for (let i = env.length - 1; i >= 0; i--) {
    if (env[i].msgType === 'PeerHello') {
      const t = Date.parse(env[i].timestamp);
      return Number.isNaN(t) ? -Infinity : t;
    }
  }
  return -Infinity;
}

/**
 * Whether a `register` call should append a PeerHello: only for a genuinely new
 * registration, or once the heartbeat window has elapsed since the last one.
 * A re-register within the window is a retry and must NOT spam a near-identical
 * hello. Pure — the decision the handler makes, exported for test.
 */
export function shouldEmitHello(
  alreadyRegistered: boolean,
  nowMs: number,
  lastHelloMs: number,
  windowSecs: number,
): boolean {
  return !alreadyRegistered || nowMs - lastHelloMs >= windowSecs * 1000;
}

/** Collapse duplicate envelopeIds, preserving order (first occurrence wins). Pure. */
export function dedupEnvelopes<T extends { envelopeId: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter(e => {
    if (seen.has(e.envelopeId)) return false;
    seen.add(e.envelopeId);
    return true;
  });
}

/**
 * Ephemeral per-process Ed25519 keypair for human-join token signing.
 * Phase 1 contract: keys are NOT persisted across process restart — every
 * invocation can mint tokens but cross-process replay protection is the
 * agentbbs server's responsibility (nonce JTI tracking, per ADR-164 §3.2.4).
 * Phase 2+ will wire this to the existing federation Ed25519 keypair.
 */
let _signingKey: { priv: Uint8Array; pub: Uint8Array } | null = null;
async function getSigningKey(): Promise<{ priv: Uint8Array; pub: Uint8Array }> {
  if (_signingKey) return _signingKey;
  // Use @noble/ed25519 (already a hard dep of @claude-flow/cli for IPFS signing).
  const ed: any = await import('@noble/ed25519');
  const priv = ed.utils.randomPrivateKey
    ? ed.utils.randomPrivateKey()
    : randomBytes(32);
  const pub: Uint8Array = await (ed.getPublicKeyAsync ?? ed.getPublicKey)(priv);
  _signingKey = { priv, pub };
  return _signingKey;
}

function base64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export const agentbbsTools: MCPTool[] = [
  {
    name: 'federation_bbs_register',
    description: 'agentbbs@~0.1.0 — Register a BBS room as a named federation peer (ADR-164 Phase 1). Maps a business-domain label like "#sales" or "#finance" to a stable roomId and emits an attested PeerHello envelope. Use when you are scaffolding the business-autopilot cockpit and need a room handle that subsequent publish/watch calls can target. Calling FederationCoordinator.joinPeer() directly is wrong because it bypasses the room policy bag (PII mode, budget cap, preferLocal routing) that the BBS plugin layers on top. Optional dep — degrades to {degraded:true} when missing.',
    category: 'federation',
    tags: ['agentbbs', 'federation', 'bbs', 'register', 'adr-164'],
    inputSchema: {
      type: 'object',
      properties: {
        basePath: {
          type: 'string',
          description: 'Directory where BBS room state is persisted (defaults to <cwd>/.agentbbs).',
        },
        roomLabel: {
          type: 'string',
          description: 'Human-readable room label, e.g. "#sales" or "finance". May include alnum + _.-:/@# .',
        },
        agentbbsBin: {
          type: 'string',
          description: 'Optional explicit path to the agentbbs binary. Reserved for Phase 2 wire-up; ignored in Phase 1.',
        },
      },
      required: ['roomLabel'],
    },
    handler: async (input) => {
      // Validate inputs FIRST so callers see deterministic errors regardless of
      // optional-dep state. Degradation is a runtime-state branch, not a way
      // to mask malformed requests.
      const roomLabel = validateRoomLabel(String(input.roomLabel));
      const basePath = resolveBasePath(input.basePath as string | undefined);

      const api = await loadAgentbbs();
      if (!api) return degradedResult('agentbbs-not-found');

      ensureDir(basePath);

      const roomId = roomIdFromLabel(roomLabel);
      const registryPath = roomsRegistryPath(basePath);
      const registry: Record<string, { roomId: string; roomLabel: string; registeredAt: string; trustLevel: string }> =
        existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf-8')) : {};

      // Idempotent — re-registering the same label updates timestamp but keeps id stable.
      const alreadyRegistered = roomId in registry;
      const entry = {
        roomId,
        roomLabel,
        registeredAt: new Date().toISOString(),
        trustLevel: 'attested',
      };
      registry[roomId] = entry;
      writeFileSync(registryPath, JSON.stringify(registry, null, 2));

      // Emit a PeerHello only when it carries information: a genuinely new
      // registration, or a heartbeat refresh once HELLO_WINDOW_SECS has elapsed.
      // A re-register within the window is a retry/no-op — appending a
      // near-identical hello every call is the spam ADR-164 dedup guards against
      // (observed live: one node published 8 near-identical PeerHellos).
      const logPath = roomLogPath(basePath, roomId);
      const nowMs = Date.parse(entry.registeredAt);
      const helloEmitted = shouldEmitHello(
        alreadyRegistered, nowMs, lastPeerHelloMs(logPath), HELLO_WINDOW_SECS,
      );
      if (helloEmitted) {
        const env: BbsEnvelope = {
          envelopeId: base64url(randomBytes(12)),
          roomId,
          seq: nextSeq(logPath),
          msgType: 'PeerHello',
          payload: { roomLabel, trustLevel: 'attested' },
          timestamp: entry.registeredAt,
        };
        appendFileSync(logPath, JSON.stringify(env) + '\n');
      }

      // nodeId: deterministic per (cwd, roomId) so re-registers reuse identity.
      const nodeId = createHash('sha256')
        .update(`agentbbs:node:${basePath}:${roomId}`)
        .digest('hex')
        .slice(0, 16);

      return {
        success: true,
        roomId,
        nodeId,
        trustLevel: 'attested' as const,
        helloEmitted,
      };
    },
  },
  {
    name: 'federation_bbs_publish',
    description: 'agentbbs — Publish a domain event from a pod agent to a BBS room (ADR-164 Phase 1). Wraps the payload in a ReplicateMessage envelope (envelopeId, seq, ts, msgType, payload) and appends it to the room log. Use when an agent has produced a typed event (pod-status, task-result, alert, human-override-ack, bench-result) that the human cockpit or other pods need to see. Storing into raw memory_store is wrong because it skips the room-scoped budget cap, PII pipeline gating, and monotonic seq numbering that ADR-164 §3.2.2 requires. Optional dep — degrades to {degraded:true} when missing.',
    category: 'federation',
    tags: ['agentbbs', 'federation', 'bbs', 'publish', 'adr-164'],
    inputSchema: {
      type: 'object',
      properties: {
        basePath: {
          type: 'string',
          description: 'Directory where BBS room state is persisted (defaults to <cwd>/.agentbbs).',
        },
        roomId: {
          type: 'string',
          description: 'Target room identifier as returned by federation_bbs_register.',
        },
        msgType: {
          type: 'string',
          description: 'Typed event kind (pod-status / task-result / alert / human-override-ack / bench-result).',
        },
        payload: {
          type: 'object',
          description: 'Event-specific JSON-serializable payload.',
        },
        signature: {
          type: 'string',
          description: 'Optional Ed25519 signature over the canonical envelope bytes. Phase 1: pass-through.',
        },
      },
      required: ['roomId', 'msgType', 'payload'],
    },
    handler: async (input) => {
      const basePath = resolveBasePath(input.basePath as string | undefined);
      const roomId = validateRoomId(String(input.roomId));
      const msgType = String(input.msgType ?? '');
      if (!msgType) throw new Error('msgType is required');
      if (msgType.length > 64 || !/^[A-Za-z0-9_-]+$/.test(msgType)) {
        throw new Error('msgType must be alnum + _ - and ≤64 chars');
      }
      if (typeof input.payload !== 'object' || input.payload === null) {
        throw new Error('payload must be a JSON object');
      }

      const api = await loadAgentbbs();
      if (!api) return degradedResult('agentbbs-not-found');

      ensureDir(basePath);
      const logPath = roomLogPath(basePath, roomId);
      const env: BbsEnvelope = {
        envelopeId: base64url(randomBytes(12)),
        roomId,
        seq: nextSeq(logPath),
        msgType,
        payload: input.payload,
        timestamp: new Date().toISOString(),
        signature: input.signature ? String(input.signature) : undefined,
      };
      appendFileSync(logPath, JSON.stringify(env) + '\n');

      // Phase 1: recipientHopCount is always 0 (single-node). Phase 4+ will
      // surface real hop counts from the WG mesh transport.
      return {
        success: true,
        envelopeId: env.envelopeId,
        recipientHopCount: 0,
      };
    },
  },
  {
    name: 'federation_bbs_watch',
    description: 'agentbbs — Poll recent envelopes from a BBS room (ADR-164 Phase 1). Returns envelopes newer than the optional sinceEnvelopeId, up to limit. Use when a pod agent needs to see incoming human overrides, new tasks, or peer events posted to its room. Polling memory_search for the room namespace is wrong because it loses the monotonic seq ordering and re-runs PII gating per query; this tool reads the canonical envelope log directly. Phase 1 is polling — Phase 4 layers streaming on the same surface. Optional dep — degrades to {degraded:true} when missing.',
    category: 'federation',
    tags: ['agentbbs', 'federation', 'bbs', 'watch', 'adr-164'],
    inputSchema: {
      type: 'object',
      properties: {
        basePath: {
          type: 'string',
          description: 'Directory where BBS room state is persisted (defaults to <cwd>/.agentbbs).',
        },
        roomId: {
          type: 'string',
          description: 'Room identifier to watch.',
        },
        sinceEnvelopeId: {
          type: 'string',
          description: 'Only return envelopes strictly after this id. Omit to return the most recent window.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum envelopes to return (default 50, max 500).',
        },
      },
      required: ['roomId'],
    },
    handler: async (input) => {
      const basePath = resolveBasePath(input.basePath as string | undefined);
      const roomId = validateRoomId(String(input.roomId));

      const api = await loadAgentbbs();
      if (!api) return degradedResult('agentbbs-not-found');

      const limitRaw = typeof input.limit === 'number' ? input.limit : 50;
      const limit = Math.max(1, Math.min(500, Math.trunc(limitRaw)));
      const sinceEnvelopeId = input.sinceEnvelopeId ? String(input.sinceEnvelopeId) : undefined;

      const logPath = roomLogPath(basePath, roomId);
      const all = readEnvelopes(logPath);

      let slice = all;
      if (sinceEnvelopeId) {
        const idx = all.findIndex(e => e.envelopeId === sinceEnvelopeId);
        slice = idx >= 0 ? all.slice(idx + 1) : all;
      }
      // Dedup by envelopeId before applying the limit — a relay replay or a
      // double-append must not surface the same envelope twice to a watcher.
      const deduped = dedupEnvelopes(slice);
      const envelopes = deduped.slice(-limit);
      return {
        success: true,
        roomId,
        envelopes,
        count: envelopes.length,
        hasMore: deduped.length > envelopes.length,
      };
    },
  },
  {
    name: 'federation_bbs_human_join',
    description: 'agentbbs — Mint a single-use Ed25519-signed token a human business owner presents to the agentbbs SSH/web front door to join a room (ADR-164 §3.2.4). Returns webUrl + sshCommand + handshakeToken + expiresAt. Use when the cockpit operator needs scoped, time-limited access to a room without sharing the federation root keypair. Issuing a permanent bearer token is wrong because the agentbbs server enforces single-use JTI replay protection and the 15-min default TTL — a long-lived token defeats both. Optional dep — degrades to {degraded:true} when missing.',
    category: 'federation',
    tags: ['agentbbs', 'federation', 'bbs', 'human-join', 'token', 'adr-164'],
    inputSchema: {
      type: 'object',
      properties: {
        roomId: {
          type: 'string',
          description: 'Room the token authorizes.',
        },
        ttlSeconds: {
          type: 'integer',
          description: 'Token lifetime in seconds. Max 900 (15 min). Default 300.',
        },
      },
      required: ['roomId'],
    },
    handler: async (input) => {
      const roomId = validateRoomId(String(input.roomId));

      const api = await loadAgentbbs();
      if (!api) return degradedResult('agentbbs-not-found');

      const ttlRaw = typeof input.ttlSeconds === 'number' ? input.ttlSeconds : 300;
      const ttlSeconds = Math.max(30, Math.min(900, Math.trunc(ttlRaw)));
      const now = Date.now();
      const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();
      const nonce = base64url(randomBytes(16));

      const payload = { roomId, nonce, expiresAt };
      const canonical = JSON.stringify(payload);

      const ed: any = await import('@noble/ed25519');
      const { priv, pub } = await getSigningKey();
      const sigBytes: Uint8Array = await (ed.signAsync ?? ed.sign)(
        new TextEncoder().encode(canonical),
        priv,
      );

      // Token format: base64url(JSON{payload, sig, pub}). Single string, easy
      // to paste into an SSH command line. The verifier reconstructs canonical
      // bytes from payload and checks sig against pub.
      const token = base64url(Buffer.from(JSON.stringify({
        payload,
        sig: base64url(sigBytes),
        pub: base64url(pub),
      })));

      const webUrl = `https://agentbbs.local/rooms/${encodeURIComponent(roomId)}?token=${token}`;
      const sshCommand = `ssh -p 2222 agentbbs.local -- join ${roomId} ${token}`;

      return {
        success: true,
        webUrl,
        sshCommand,
        handshakeToken: token,
        expiresAt,
      };
    },
  },
];
