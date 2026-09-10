// x.ruv.io gateway — MCP server for ruflo swarm federation + claims, over an
// open (membership-gated, signed) Nostr relay. Exposes:
//   GET  /            → service info
//   GET  /health      → health probe
//   POST /mcp         → MCP (Streamable HTTP, stateless JSON-RPC)
//   resources ruv://… → federation registry, swarm roster, claims board
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { loadIdentity, publish, fetchRecent } from './nostr-federation.mjs';

const RELAY = process.env.RUFLO_RELAY_URL || 'wss://buzz-relay-186366152200.us-central1.run.app';
const KEYFILE = process.env.RUFLO_NOSTR_KEY || '/data/nostr-gateway.key';
const PORT = Number(process.env.PORT || 8080);
const { sk, pubkey } = loadIdentity(KEYFILE);

// Reduce claim events into an owner-per-resource ledger.
function reduceClaims(events) {
  const byRes = {};
  for (const e of events.sort((a, b) => a.created_at - b.created_at)) {
    if (e.type === 'ClaimIssued') { if (!byRes[e.resourceId]) byRes[e.resourceId] = { owner: e.pubkey, from: e.from, at: e.ts, ttlSeconds: e.ttlSeconds }; }
    else if (e.type === 'ClaimReleased') { if (byRes[e.resourceId]?.owner === e.pubkey) delete byRes[e.resourceId]; }
    else if (e.type === 'ClaimHandoff' && byRes[e.resourceId]?.owner === e.pubkey) byRes[e.resourceId].owner = e.toNode;
  }
  return byRes;
}

function buildServer() {
  const mcp = new McpServer({ name: 'ruflo-x-gateway', version: '0.1.0' });

  mcp.tool('federation_identity', 'Return this gateway\'s Nostr public key (npub hex) and the relay it federates through. Use to learn who you are talking to before publishing.', {}, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ pubkey, relay: RELAY }) }],
  }));

  mcp.tool('federation_join', 'Announce presence to the ruflo swarm by publishing a signed PeerHello. Use when a node comes online and wants peers to see it. Requires relay membership.',
    { name: z.string(), platform: z.string().optional(), note: z.string().optional() },
    async ({ name, platform, note }) => {
      const id = await publish(RELAY, sk, 'PeerHello', { from: name, platform, note });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, eventId: id }) }] };
    });

  mcp.tool('federation_publish', 'Publish a signed coordination message to the swarm (Status/Task/Result/etc). Payload must be JSON. Use to broadcast state or hand out work.',
    { msgType: z.string(), payload: z.record(z.any()) },
    async ({ msgType, payload }) => {
      const id = await publish(RELAY, sk, msgType, payload);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, eventId: id }) }] };
    });

  mcp.tool('federation_sync', 'Fetch recent verified swarm coordination messages. Use to catch up on what peers have posted. Optionally filter by type.',
    { sinceSeconds: z.number().optional(), limit: z.number().optional(), type: z.string().optional() },
    async ({ sinceSeconds, limit, type }) => {
      const msgs = await fetchRecent(RELAY, sk, { sinceSeconds, limit, type });
      return { content: [{ type: 'text', text: JSON.stringify({ count: msgs.length, messages: msgs }) }] };
    });

  mcp.tool('claims_issue', 'Issue a work claim over the swarm so peers know you own a resource. One owner per resourceId; sync first and defer if already owned.',
    { resourceId: z.string(), ttlSeconds: z.number().optional() },
    async ({ resourceId, ttlSeconds }) => {
      const id = await publish(RELAY, sk, 'ClaimIssued', { from: pubkey, resourceId, ttlSeconds });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, eventId: id, resourceId }) }] };
    });

  mcp.tool('claims_release', 'Release a work claim you hold so another node can take the resource.',
    { resourceId: z.string() },
    async ({ resourceId }) => {
      const id = await publish(RELAY, sk, 'ClaimReleased', { from: pubkey, resourceId });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, eventId: id, resourceId }) }] };
    });

  mcp.tool('claims_status', 'Return the current claims ledger (owner per resource) derived from recent verified claim events.', {}, async () => {
    const events = await fetchRecent(RELAY, sk, { sinceSeconds: 24 * 3600, limit: 500 });
    const claims = events.filter((e) => String(e.type).startsWith('Claim'));
    return { content: [{ type: 'text', text: JSON.stringify(reduceClaims(claims)) }] };
  });

  // ruv:// resources
  mcp.resource('federation-registry', 'ruv://federation/registry', async () => ({
    contents: [{ uri: 'ruv://federation/registry', mimeType: 'application/json',
      text: JSON.stringify({ relay: RELAY, gatewayPubkey: pubkey, swarmTag: 'ruflo-swarm',
        note: 'Signed Nostr coordination. Join via federation_join (requires relay membership).' }) }],
  }));
  mcp.resource('swarm-roster', 'ruv://swarm/roster', async () => {
    const hellos = await fetchRecent(RELAY, sk, { sinceSeconds: 6 * 3600, limit: 200, type: 'PeerHello' });
    const roster = {}; for (const h of hellos) roster[h.pubkey] = { from: h.from, platform: h.platform, lastSeen: h.ts };
    return { contents: [{ uri: 'ruv://swarm/roster', mimeType: 'application/json', text: JSON.stringify(roster) }] };
  });
  mcp.resource('claims-board', 'ruv://claims/board', async () => {
    const events = await fetchRecent(RELAY, sk, { sinceSeconds: 24 * 3600, limit: 500 });
    const claims = events.filter((e) => String(e.type).startsWith('Claim'));
    return { contents: [{ uri: 'ruv://claims/board', mimeType: 'application/json', text: JSON.stringify(reduceClaims(claims)) }] };
  });

  return mcp;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/health') { res.writeHead(200).end('ok'); return; }
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'ruflo-x-gateway', mcp: '/mcp', relay: RELAY, gatewayPubkey: pubkey,
      resources: ['ruv://federation/registry', 'ruv://swarm/roster', 'ruv://claims/board'] }));
    return;
  }
  if (url.pathname === '/mcp') {
    // stateless Streamable HTTP: fresh server+transport per request
    const mcp = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); mcp.close(); });
    await mcp.connect(transport);
    let body = ''; req.on('data', (c) => (body += c));
    await new Promise((r) => req.on('end', r));
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    return;
  }
  res.writeHead(404).end('not found');
});
server.listen(PORT, () => console.log(`ruflo-x-gateway on :${PORT} | relay ${RELAY} | pubkey ${pubkey}`));
