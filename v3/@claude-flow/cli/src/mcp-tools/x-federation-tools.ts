/**
 * x.ruv.io open swarm federation — ruflo-native MCP tools.
 *
 * Bridges ruflo to the open, membership-gated, signed Nostr federation behind
 * https://x.ruv.io. Reads are open; writes made with the GATEWAY identity need
 * the gateway admin token (RUFLO_X_ADMIN_TOKEN). Users who want to publish as
 * themselves should join with their own key via invite→claim (see the
 * `ruv://federation/registry` resource), not through these gateway-identity tools.
 */
import type { MCPTool } from './types.js';

// ADR-125 precedence: the tool arg `gatewayUrl` (fed by `ruflo federation --gateway`)
// takes precedence over the RUFLO_X_GATEWAY_URL env var, which precedes the default.
const GATEWAY = (override?: unknown): string =>
  ((typeof override === 'string' && override) || process.env.RUFLO_X_GATEWAY_URL || 'https://x.ruv.io').replace(/\/$/, '');
const gatewayArg = { gatewayUrl: { type: 'string', description: 'Gateway base URL; takes precedence over RUFLO_X_GATEWAY_URL (default https://x.ruv.io).' } } as const;
const TIMEOUT_MS = 25_000;

/** Minimal MCP-over-Streamable-HTTP client: POST JSON-RPC, parse the SSE `data:` frame. */
async function gatewayRpc(method: string, params: Record<string, unknown>, gatewayUrl?: unknown): Promise<unknown> {
  const res = await fetch(`${GATEWAY(gatewayUrl)}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  const payload = JSON.parse(line ? line.slice(5) : text) as { result?: unknown; error?: { message?: string } };
  if (payload.error) throw new Error(`x.ruv.io: ${payload.error.message ?? 'rpc error'}`);
  return payload.result;
}
async function gatewayTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { gatewayUrl, ...rest } = args;
  const r = (await gatewayRpc('tools/call', { name, arguments: rest }, gatewayUrl)) as { content?: Array<{ text?: string }>; isError?: boolean };
  const text = r.content?.[0]?.text ?? '{}';
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (r.isError || parsed.error) throw new Error(String(parsed.error ?? 'gateway tool error'));
  return parsed;
}
async function gatewayResource(uri: string, gatewayUrl?: unknown): Promise<unknown> {
  const r = (await gatewayRpc('resources/read', { uri }, gatewayUrl)) as { contents?: Array<{ text?: string }> };
  return JSON.parse(r.contents?.[0]?.text ?? '{}');
}
// Credential: intentionally env-only (a secret must never be a CLI flag — it would land in
// shell history / process lists). Registered in scripts/audit-env-var-precedence.mjs.
const adminToken = (): string | undefined => process.env.RUFLO_X_ADMIN_TOKEN;

export const xFederationTools: MCPTool[] = [
  {
    name: 'x_federation_sync',
    description:
      'Fetch recent signature-verified coordination messages from the open x.ruv.io swarm federation (Nostr, #t=ruflo-swarm). Use when you need to see what other ruflo nodes across the internet have posted (PeerHello/Status/Task/Result/Claim*). Reading the relay directly is wrong because you would have to do NIP-42 auth yourself; the gateway does it and only returns events whose signatures verify.',
    inputSchema: { type: 'object', properties: { ...gatewayArg, sinceSeconds: { type: 'number', description: 'Look-back window (default 3600).' }, limit: { type: 'number', description: 'Max messages (default 100).' }, type: { type: 'string', description: 'Optional message type filter, e.g. Task.' } } },
    handler: async (input) => gatewayTool('federation_sync', input as Record<string, unknown>),
  },
  {
    name: 'x_federation_roster',
    description:
      'List nodes currently announcing themselves on the open swarm (recent PeerHello events) via the ruv://swarm/roster resource. Use when you need to know who is online across the federation before assigning work. Grepping sync output by hand is wrong because the roster resource already de-duplicates by pubkey and carries lastSeen.',
    inputSchema: { type: 'object', properties: { ...gatewayArg } },
    handler: async (input) => gatewayResource('ruv://swarm/roster', (input as Record<string, unknown>).gatewayUrl),
  },
  {
    name: 'x_federation_claims',
    description:
      'Return the current owner-per-resource work-claims ledger for the open swarm (ruv://claims/board). Use when you are about to start shared work and need to know whether a resourceId is already owned. Inferring ownership from raw ClaimIssued events is wrong because releases, TTL expiry and handoffs change the answer; the board applies those rules.',
    inputSchema: { type: 'object', properties: { ...gatewayArg } },
    handler: async (input) => gatewayResource('ruv://claims/board', (input as Record<string, unknown>).gatewayUrl),
  },
  {
    name: 'x_federation_registry',
    description:
      'Read the federation registry resource (ruv://federation/registry): relay URL, canonical relay tag for NIP-42, gateway pubkey, and the exact self-join steps. Use when onboarding a new node or user to the open federation. Hard-coding the relay URL is wrong because the relay verifies the NIP-42 relay tag strictly against its canonical host, which this resource states.',
    inputSchema: { type: 'object', properties: { ...gatewayArg } },
    handler: async (input) => gatewayResource('ruv://federation/registry', (input as Record<string, unknown>).gatewayUrl),
  },
  {
    name: 'x_federation_publish',
    description:
      'Publish a signed coordination message to the open swarm AS THE GATEWAY identity (Status/Task/Result/…). Requires RUFLO_X_ADMIN_TOKEN. Use when a trusted operator needs a hub-level broadcast. Using this to post on behalf of an individual node is wrong because it attributes the message to the gateway, not the node — nodes should join with their own key via invite→claim and publish themselves.',
    inputSchema: { type: 'object', properties: { ...gatewayArg, msgType: { type: 'string' }, payload: { type: 'object' } }, required: ['msgType', 'payload'] },
    handler: async (input) => {
      const t = adminToken(); if (!t) throw new Error('RUFLO_X_ADMIN_TOKEN is not set (gateway-identity writes are admin-gated)');
      return gatewayTool('federation_publish', { ...(input as Record<string, unknown>), adminToken: t });
    },
  },
  {
    name: 'x_federation_invite_mint',
    description:
      'Mint a use-limited, expiring invite code so a new ruflo user can self-join the open federation with THEIR OWN key. Requires RUFLO_X_ADMIN_TOKEN. Use when onboarding someone. Sharing the relay owner key instead is wrong because invites are revocable, hashed at rest, and bind membership to the claimant\'s key; the code is a bearer secret — hand it over privately.',
    inputSchema: { type: 'object', properties: { ...gatewayArg, ttlSecs: { type: 'number', description: 'Validity (default 7 days).' }, maxUses: { type: 'number', description: 'Redemptions (default 25).' } } },
    handler: async (input) => {
      const t = adminToken(); if (!t) throw new Error('RUFLO_X_ADMIN_TOKEN is not set (invite minting is admin-gated)');
      return gatewayTool('federation_invite_mint', { ...(input as Record<string, unknown>), adminToken: t });
    },
  },
  {
    name: 'x_federation_admit',
    description:
      'Admit a Nostr pubkey as a relay member directly (NIP-43 kind 9030). Requires RUFLO_X_ADMIN_TOKEN. Use when a known node reports its 64-hex pubkey and you want to skip the invite step. Padding or hand-editing a reported pubkey is wrong because it is a cryptographic identity; a malformed key must be re-reported, never fixed up.',
    inputSchema: { type: 'object', properties: { ...gatewayArg, pubkey: { type: 'string', description: '64-hex secp256k1 x-only pubkey.' }, role: { type: 'string', enum: ['member', 'admin'] } }, required: ['pubkey'] },
    handler: async (input) => {
      const t = adminToken(); if (!t) throw new Error('RUFLO_X_ADMIN_TOKEN is not set (admission is admin-gated)');
      return gatewayTool('federation_admit', { ...(input as Record<string, unknown>), adminToken: t });
    },
  },
];
