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
 * Presence check: the published `agentbbs` package (as of 0.2.1) is a CLI-only
 * launcher — a `bin` script with no importable JS entry point (no `main` /
 * `exports` field) — that downloads/builds a Rust binary and shells out to it.
 * `await import('agentbbs')` can therefore never resolve, even when the CLI is
 * correctly installed and on PATH: there is no module for Node to find. This
 * previously made every tool report `degraded: true` unconditionally,
 * regardless of install state. Detect real availability instead by probing the
 * CLI itself, matching how the rest of this codebase treats optional
 * command-line tools (`shutil.which()`-style guards) rather than assuming a
 * package shape the dependency doesn't have.
 *
 * @module @claude-flow/cli/mcp-tools/agentbbs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { MCPTool } from './types.js';
import {
  getNodeIdentity,
  signEnvelope,
  addPeer,
  removePeer,
  readPeers,
  syncRoomFromPeer,
  serveFederation,
  validateRoomId as fedValidateRoomId,
  MAX_PEERS,
  MAX_HOPS,
} from './agentbbs-federation.js';
import { getProjectCwd } from './types.js';

const CLI_NAME = 'agentbbs';

// Cache: amortize the subprocess probe cost across handler calls within a
// process. null = not yet probed; boolean = probe result.
let _cliAvailable: boolean | null = null;

function agentbbsCliAvailable(): boolean {
  if (_cliAvailable !== null) return _cliAvailable;
  const bin = process.env.AGENTBBS_BIN || CLI_NAME;
  try {
    // On Windows npm's global-install shim is `agentbbs.cmd`, and
    // child_process cannot spawn a .cmd without going through cmd.exe, which
    // is what resolves the PATHEXT extension. POSIX keeps shell:false so the
    // AGENTBBS_BIN override is never shell-interpreted — same convention as
    // browser-tools.ts and commands/init.ts.
    execFileSync(bin, ['--version'], {
      stdio: 'ignore',
      timeout: 5000,
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    _cliAvailable = true;
  } catch {
    _cliAvailable = false;
  }
  return _cliAvailable;
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

function nextSeq(path: string): number {
  const env = readEnvelopes(path);
  if (env.length === 0) return 1;
  return (env[env.length - 1].seq ?? env.length) + 1;
}

/**
 * Ephemeral per-process Ed25519 keypair for human-join token signing.
 * Phase 1 contract: keys are NOT persisted across process restart — every
 * invocation can mint tokens but cross-process replay protection is the
 * agentbbs server's responsibility (nonce JTI tracking, per ADR-164 §3.2.4).
 * Phase 2+ will wire this to the existing federation Ed25519 keypair.
 */
// Use @noble/ed25519 (already a hard dep of @claude-flow/cli for IPFS
// signing). Memoized behind one loader — two separate dynamic `import()`
// call sites for the same bare specifier in this module tripped up the
// test runner's dependency pre-bundling (surfaced once federation_bbs_
// human_join actually ran instead of always short-circuiting to degraded).
let _edMod: any = null;
async function loadEd25519(): Promise<any> {
  if (!_edMod) _edMod = await import('@noble/ed25519');
  return _edMod;
}

let _signingKey: { priv: Uint8Array; pub: Uint8Array } | null = null;
async function getSigningKey(): Promise<{ priv: Uint8Array; pub: Uint8Array }> {
  if (_signingKey) return _signingKey;
  const ed = await loadEd25519();
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

      if (!agentbbsCliAvailable()) return degradedResult('agentbbs-not-found');

      ensureDir(basePath);

      const roomId = roomIdFromLabel(roomLabel);
      const registryPath = roomsRegistryPath(basePath);
      const registry: Record<string, { roomId: string; roomLabel: string; registeredAt: string; trustLevel: string }> =
        existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf-8')) : {};

      // Idempotent — re-registering the same label updates timestamp but keeps id stable.
      const entry = {
        roomId,
        roomLabel,
        registeredAt: new Date().toISOString(),
        trustLevel: 'attested',
      };
      registry[roomId] = entry;
      writeFileSync(registryPath, JSON.stringify(registry, null, 2));

      // Emit a synthetic PeerHello envelope into the room log so watchers see the join.
      const logPath = roomLogPath(basePath, roomId);
      const env: BbsEnvelope = {
        envelopeId: base64url(randomBytes(12)),
        roomId,
        seq: nextSeq(logPath),
        msgType: 'PeerHello',
        payload: { roomLabel, trustLevel: 'attested' },
        timestamp: entry.registeredAt,
      };
      appendFileSync(logPath, JSON.stringify(env) + '\n');

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

      if (!agentbbsCliAvailable()) return degradedResult('agentbbs-not-found');

      ensureDir(basePath);
      const logPath = roomLogPath(basePath, roomId);
      const base: BbsEnvelope = {
        envelopeId: base64url(randomBytes(12)),
        roomId,
        seq: nextSeq(logPath),
        msgType,
        payload: input.payload,
        timestamp: new Date().toISOString(),
      };
      // Phase 2: sign with this host's persistent node identity so peers can
      // attribute and verify the envelope after a cross-host merge. An
      // explicitly supplied signature is preserved rather than overwritten.
      const env: BbsEnvelope = input.signature
        ? { ...base, signature: String(input.signature) }
        : (await signEnvelope(basePath, base as any)) as any;
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

      if (!agentbbsCliAvailable()) return degradedResult('agentbbs-not-found');

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
      const envelopes = slice.slice(-limit);
      return {
        success: true,
        roomId,
        envelopes,
        count: envelopes.length,
        hasMore: slice.length > envelopes.length,
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

      if (!agentbbsCliAvailable()) return degradedResult('agentbbs-not-found');

      const ttlRaw = typeof input.ttlSeconds === 'number' ? input.ttlSeconds : 300;
      const ttlSeconds = Math.max(30, Math.min(900, Math.trunc(ttlRaw)));
      const now = Date.now();
      const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();
      const nonce = base64url(randomBytes(16));

      const payload = { roomId, nonce, expiresAt };
      const canonical = JSON.stringify(payload);

      const ed = await loadEd25519();
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

  // ---------------------------------------------------------------- Phase 2
  {
    name: 'federation_bbs_identity',
    description: "agentbbs Phase 2 — return this host's persistent federation node identity (nodeId + Ed25519 public key), creating it on first call. Give the nodeId and publicKey to a peer so they can pin you with federation_bbs_peer_add. The private key never leaves this host and is never returned. Use when you are bootstrapping a new host into the federation and a peer needs something to pin. Reading node-identity.json directly is wrong because it also holds the private key, and the file is created lazily so it may not exist yet.",
    inputSchema: {
      type: 'object',
      properties: {
        basePath: { type: 'string', description: 'Override the .agentbbs directory.' },
      },
    },
    handler: async (input) => {
      const basePath = resolveBasePath(input.basePath as string | undefined);
      if (!agentbbsCliAvailable()) return degradedResult('agentbbs-not-found');
      const id = await getNodeIdentity(basePath);
      return { success: true, nodeId: id.nodeId, publicKey: id.publicKey, createdAt: id.createdAt };
    },
  },
  {
    name: 'federation_bbs_peer_add',
    description: `agentbbs Phase 2 — pin a remote federation peer by nodeId, URL and Ed25519 public key. The key is pinned at add time and every envelope merged from this peer is verified against it, so a hostile peer cannot forge another node's envelopes. Re-adding a known nodeId with a different key is refused; remove it first. Max ${MAX_PEERS} peers. Use when you have a peer's identity out of band and want to start syncing with it. Trusting a key carried inside an incoming envelope is wrong because that only proves the sender holds some key, not that they are the node they claim to be.`,
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: "Peer's 16-hex nodeId from its federation_bbs_identity." },
        url: { type: 'string', description: 'Peer base URL, e.g. http://100.104.125.72:7777' },
        publicKey: { type: 'string', description: "Peer's 64-hex Ed25519 public key." },
        label: { type: 'string', description: 'Optional human label.' },
        basePath: { type: 'string' },
      },
      required: ['nodeId', 'url', 'publicKey'],
    },
    handler: async (input) => {
      const basePath = resolveBasePath(input.basePath as string | undefined);
      if (!agentbbsCliAvailable()) return degradedResult('agentbbs-not-found');
      const peer = addPeer(basePath, {
        nodeId: String(input.nodeId),
        url: String(input.url),
        publicKey: String(input.publicKey),
        label: input.label ? String(input.label) : undefined,
      });
      return { success: true, peer: { nodeId: peer.nodeId, url: peer.url, label: peer.label, addedAt: peer.addedAt } };
    },
  },
  {
    name: 'federation_bbs_peers',
    description: 'agentbbs Phase 2 — list pinned federation peers with last-sync state. Public keys are returned so an operator can compare a pin against what the peer reports; private material is never included. Use when you want to audit who this host will accept envelopes from, or unpin a peer. Editing peers.json by hand is wrong because a malformed entry silently disables verification for that peer on the next sync.',
    inputSchema: {
      type: 'object',
      properties: {
        remove: { type: 'string', description: 'Optional nodeId to unpin instead of listing.' },
        basePath: { type: 'string' },
      },
    },
    handler: async (input) => {
      const basePath = resolveBasePath(input.basePath as string | undefined);
      if (!agentbbsCliAvailable()) return degradedResult('agentbbs-not-found');
      if (input.remove) {
        const removed = removePeer(basePath, String(input.remove));
        return { success: true, removed, nodeId: String(input.remove) };
      }
      return { success: true, peers: readPeers(basePath) };
    },
  },
  {
    name: 'federation_bbs_serve',
    description: 'agentbbs Phase 2 — start the read-only pull endpoint peers fetch from (GET /agentbbs/v1/rooms/:roomId/envelopes). Binds 127.0.0.1 unless bindHost is given explicitly, so room contents are never exposed on a routable interface by accident. There is no route that mutates state. Use when this host needs to be reachable by peers that pull from it. Exposing the .agentbbs directory over a static file server is wrong because that would serve node-identity.json, which contains the private key.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'number', description: 'Port to listen on. 0 picks a free one.' },
        bindHost: { type: 'string', description: 'Interface to bind. Defaults to 127.0.0.1; set a tailnet IP to federate.' },
        basePath: { type: 'string' },
      },
    },
    handler: async (input) => {
      const basePath = resolveBasePath(input.basePath as string | undefined);
      if (!agentbbsCliAvailable()) return degradedResult('agentbbs-not-found');
      const { port, host } = await serveFederation(basePath, {
        port: typeof input.port === 'number' ? input.port : undefined,
        bindHost: input.bindHost ? String(input.bindHost) : undefined,
      });
      const id = await getNodeIdentity(basePath);
      return { success: true, listening: `http://${host}:${port}`, nodeId: id.nodeId, publicKey: id.publicKey };
    },
  },
  {
    name: 'federation_bbs_sync',
    description: `agentbbs Phase 2 — pull a room from pinned peers and union-merge what verifies. Merge is keyed on envelopeId so it is idempotent and order-independent; unsigned, misattributed, oversize and over-hop (>${MAX_HOPS}) envelopes are dropped and counted rather than merged. Use after publish to propagate, or on a timer to converge. Use when you want to converge this host's rooms with its peers, on demand or on a timer. Copying room-*.jsonl between machines is wrong because it bypasses signature verification, dedupe and the hop limit, so a single hostile or looping file can corrupt the log.`,
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Room to sync. Same label yields the same roomId on every host.' },
        nodeId: { type: 'string', description: 'Optional single peer to sync from; default is all pinned peers.' },
        basePath: { type: 'string' },
      },
      required: ['roomId'],
    },
    handler: async (input) => {
      const basePath = resolveBasePath(input.basePath as string | undefined);
      const roomId = fedValidateRoomId(String(input.roomId));
      if (!agentbbsCliAvailable()) return degradedResult('agentbbs-not-found');

      const all = readPeers(basePath);
      const targets = input.nodeId ? all.filter(p => p.nodeId === String(input.nodeId)) : all;
      if (targets.length === 0) return { success: true, roomId, peersSynced: 0, results: [], note: 'no pinned peers' };

      type SyncRow = { peerNodeId: string; roomId: string; merged: number; skippedDuplicate: number;
        skippedUnverified: number; skippedOversize: number; skippedHopLimit: number; error?: string };
      const results: SyncRow[] = [];
      for (const peer of targets) {
        try {
          results.push(await syncRoomFromPeer(basePath, peer, roomId));
        } catch (e) {
          // One unreachable peer must not fail the whole sync — the merge is
          // idempotent, so this peer simply catches up on the next run.
          results.push({ peerNodeId: peer.nodeId, roomId, error: (e as Error).message,
            merged: 0, skippedDuplicate: 0, skippedUnverified: 0, skippedOversize: 0, skippedHopLimit: 0 });
        }
      }
      return {
        success: true,
        roomId,
        peersSynced: results.length,
        totalMerged: results.reduce((n, r) => n + (r.merged || 0), 0),
        results,
      };
    },
  },
];
