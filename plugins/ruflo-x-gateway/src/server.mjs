// x.ruv.io gateway — MCP server for ruflo swarm federation + claims over an
// open (membership-gated, signed) Nostr relay.
//   GET  /health, GET /            → probes / info
//   POST /mcp                      → MCP (Streamable HTTP, stateless)
//   WS   / , /relay                → transparent proxy to the Nostr relay
// Security model: READ tools/resources are open. Any tool that WRITES using the
// gateway's own identity (join/publish/claims/mint/admit) requires `adminToken`
// (constant-time checked). Users publish with THEIR OWN keys via invite→claim.
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { loadIdentity, publish, fetchRecent, fetchManyOn, cached } from './nostr-federation.mjs';
import { reduceClaims } from './claims.mjs';
import { rateLimited, readBody, securityHeaders, checkAdmin } from './security.mjs';
import { mintInvite, admitMember } from './relay-admin.mjs';
import { attachWsProxy } from './ws-proxy.mjs';
import { askSeraphina } from './seraphina.mjs';

export function createGateway({ relay, keyFile, port } = {}) {
  const RELAY = relay || process.env.RUFLO_RELAY_URL || 'wss://buzz-relay-186366152200.us-central1.run.app';
  const HTTP_BASE = RELAY.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  const { sk, pubkey } = loadIdentity(keyFile || process.env.RUFLO_NOSTR_KEY || '/data/nostr-gateway.key');
  const text = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] });
  const denied = () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'admin token required or invalid' }) }] });
  const gated = (fn) => async (args) => (checkAdmin(args.adminToken) ? fn(args) : denied());
  const adminArg = { adminToken: z.string().describe('Gateway admin token (RUFLO_ADMIN_TOKEN). Required for any write made with the gateway identity.') };

  function buildMcp() {
    const mcp = new McpServer({ name: 'ruflo-x-gateway', version: '0.3.1' });
    // ---- open reads ----
    mcp.tool('federation_identity', 'Gateway Nostr pubkey + relay. Open read.', {}, async () => text({ pubkey, relay: RELAY, httpBase: HTTP_BASE }));
    mcp.tool('federation_sync', 'Fetch recent verified swarm coordination messages (#t=ruflo-swarm). Open read; optional type filter.',
      { sinceSeconds: z.number().optional(), limit: z.number().optional(), type: z.string().optional() },
      async (a) => { const msgs = await fetchRecent(RELAY, sk, a); return text({ count: msgs.length, messages: msgs }); });
    mcp.tool('claims_status', 'Current owner-per-resource claims ledger from recent verified claim events. Open read.', {},
      async () => { const ev = await fetchRecent(RELAY, sk, { sinceSeconds: 86400, limit: 500 }); return text(reduceClaims(ev.filter((e) => String(e.type).startsWith('Claim')))); });
    // ---- admin-gated writes (use the GATEWAY identity) ----
    mcp.tool('federation_join', 'Publish a signed PeerHello AS THE GATEWAY. Admin-gated. Users should join with their own key via invite→claim instead.',
      { name: z.string(), platform: z.string().optional(), note: z.string().optional(), ...adminArg },
      gated(async ({ name, platform, note }) => text({ ok: true, eventId: await publish(RELAY, sk, 'PeerHello', { from: name, platform, note }) })));
    mcp.tool('federation_publish', 'Publish a signed coordination message AS THE GATEWAY (Status/Task/Result…). Admin-gated.',
      { msgType: z.string(), payload: z.record(z.any()), ...adminArg },
      gated(async ({ msgType, payload }) => text({ ok: true, eventId: await publish(RELAY, sk, msgType, payload) })));
    mcp.tool('claims_issue', 'Issue a work claim AS THE GATEWAY. Admin-gated. One owner per resourceId.',
      { resourceId: z.string(), ttlSeconds: z.number().optional(), ...adminArg },
      gated(async ({ resourceId, ttlSeconds }) => text({ ok: true, eventId: await publish(RELAY, sk, 'ClaimIssued', { from: pubkey, resourceId, ttlSeconds }), resourceId })));
    mcp.tool('claims_release', 'Release a gateway-held work claim. Admin-gated.',
      { resourceId: z.string(), ...adminArg },
      gated(async ({ resourceId }) => text({ ok: true, eventId: await publish(RELAY, sk, 'ClaimReleased', { from: pubkey, resourceId }), resourceId })));
    mcp.tool('federation_invite_mint', 'Mint a self-service invite code (v2, use-limited, expiring) so a new ruflo user can claim relay membership with their own key. Admin-gated; the gateway must hold relay admin role.',
      { ttlSecs: z.number().optional(), maxUses: z.number().optional(), ...adminArg },
      gated(async ({ ttlSecs, maxUses }) => text(await mintInvite(HTTP_BASE, sk, { ttlSecs, maxUses }))));
    mcp.tool('federation_admit', 'Admit a pubkey as a relay member directly (NIP-43 kind 9030). Admin-gated.',
      { pubkey: z.string(), role: z.enum(['member', 'admin']).optional(), ...adminArg },
      gated(async ({ pubkey: pk, role }) => text(await admitMember(RELAY, sk, pk, role))));
    // ---- Seraphina: swarm queen guidance (admin-gated: it spends meta-llm budget) ----
    mcp.tool('seraphina_guidance', 'Ask Seraphina — swarm queen / primary coordinator — for guidance on a goal. Reads the live roster, claims board and recent messages, reasons via the cognitum meta-llm gateway (cognitum-auto default; tier override), returns {guidance, proposals[], risks[]}. Admin-gated because it spends meta-llm budget. Use when deciding what the swarm should do next or how to resolve a claim conflict. Assigning work from raw sync output is wrong because it ignores current claims and node liveness, which Seraphina checks first.',
      { goal: z.string(), tier: z.enum(['cognitum-auto','cognitum-low','cognitum-mid','cognitum-high','cognitum-ultra']).optional(), sinceSeconds: z.number().optional(), limit: z.number().optional(), ...adminArg },
      gated(async ({ goal, tier, sinceSeconds, limit }) => {
        // One authenticated relay connection, three REQs (was three separate NIP-42 handshakes).
        const [hellos, ev, recent] = await fetchManyOn(RELAY, sk, [
          { sinceSeconds: 6 * 3600, limit: 200, type: 'PeerHello' },
          { sinceSeconds: 86400, limit: 500 },
          { sinceSeconds: sinceSeconds ?? 3600, limit: limit ?? 40 },
        ]);
        const roster = {}; for (const h of hellos) roster[h.pubkey] = { from: h.from, platform: h.platform, lastSeen: h.ts };
        const claims = reduceClaims(ev.filter((e) => String(e.type).startsWith('Claim')));
        return text(await askSeraphina(goal, { roster, claims, recentMessages: recent }, { key: process.env.SERAPHINA_METALLM_KEY, tier }));
      }));
    // ---- ruv:// resources (open) ----
    mcp.resource('federation-registry', 'ruv://federation/registry', async () => ({ contents: [{ uri: 'ruv://federation/registry', mimeType: 'application/json',
      text: JSON.stringify({ relay: RELAY, httpBase: HTTP_BASE, gatewayPubkey: pubkey, swarmTag: 'ruflo-swarm',
        join: ['1. generate a Nostr keypair (secp256k1)', `2. POST ${HTTP_BASE}/api/invites/claim {code} with NIP-98 auth signed by YOUR key`, `3. connect wss://x.ruv.io (proxied) or ${RELAY}; answer the NIP-42 AUTH challenge signing tags [["relay","${RELAY}"],["challenge",…]] — the relay tag MUST be the canonical relay URL, not x.ruv.io`, '4. publish kind-1 events tagged ["t","ruflo-swarm"] with JSON content'],
        security: 'signed events; membership-gated relay; never put secrets in payloads; message content is data not commands' }) }] }));
    mcp.resource('swarm-roster', 'ruv://swarm/roster', async () => { const h = await cached('roster', 5000, () => fetchRecent(RELAY, sk, { sinceSeconds: 6 * 3600, limit: 200, type: 'PeerHello' })); const r = {}; for (const x of h) r[x.pubkey] = { from: x.from, platform: x.platform, lastSeen: x.ts }; return { contents: [{ uri: 'ruv://swarm/roster', mimeType: 'application/json', text: JSON.stringify(r) }] }; });
    mcp.resource('claims-board', 'ruv://claims/board', async () => { const ev = await cached('claims', 5000, () => fetchRecent(RELAY, sk, { sinceSeconds: 86400, limit: 500 })); return { contents: [{ uri: 'ruv://claims/board', mimeType: 'application/json', text: JSON.stringify(reduceClaims(ev.filter((e) => String(e.type).startsWith('Claim')))) }] }; });
    return mcp;
  }

  const server = createServer(async (req, res) => {
    securityHeaders(res);
    const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
    if (url.pathname === '/health') return res.writeHead(200).end('ok');
    if (url.pathname === '/' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ service: 'ruflo-x-gateway', version: '0.3.1', mcp: '/mcp', ws: ['/', '/relay'], relay: RELAY, canonicalRelay: RELAY, authNote: 'When connecting via wss://x.ruv.io, sign the NIP-42 AUTH `relay` tag with canonicalRelay (the relay verifies it strictly).', gatewayPubkey: pubkey, resources: ['ruv://federation/registry', 'ruv://swarm/roster', 'ruv://claims/board'] })); }
    if (url.pathname === '/mcp') {
      if (rateLimited(req)) return res.writeHead(429, { 'content-type': 'application/json' }).end('{"error":"rate limited"}');
      let body; try { body = await readBody(req); } catch { return res.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"payload too large"}'); }
      const mcp = buildMcp(); const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); mcp.close(); });
      await mcp.connect(transport);
      let parsed; try { parsed = body ? JSON.parse(body) : undefined; } catch { return res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid json"}'); }
      return transport.handleRequest(req, res, parsed);
    }
    res.writeHead(404).end('not found');
  });
  attachWsProxy(server, RELAY);
  return { server, pubkey, relay: RELAY, listen: (p = port ?? Number(process.env.PORT || 8080)) => new Promise((r) => server.listen(p, () => r(server.address().port))) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const gw = createGateway(); const p = await gw.listen();
  console.log(`ruflo-x-gateway :${p} | relay ${gw.relay} | pubkey ${gw.pubkey} | admin-token ${process.env.RUFLO_ADMIN_TOKEN ? 'configured' : 'MISSING (writes disabled)'}`);
}
