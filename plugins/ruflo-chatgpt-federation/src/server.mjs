/**
 * ChatGPT Federation publisher — MCP over Streamable HTTP.
 *
 *   GET  /health          liveness
 *   GET  /                service info (pubkey is public; nothing else is)
 *   POST /mcp             MCP, stateless
 *
 * Surface is deliberately three tools and no resources. `federation_identity` and
 * `channel_sync` are open reads. `channel_publish` is the only write, it publishes
 * only to `pub:` channels, and it requires the caller token — because that token,
 * not the model, is what authorises speaking as this federation identity.
 *
 * The signing key is never an input, an output, a resource, or a log line.
 */
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { loadSigner, redact } from './signing-key.mjs';
import { publishToChannel, readChannel, PUBLIC_CHANNEL_RE } from './publisher.mjs';

const VERSION = '0.1.0';
const MAX_BODY = 256 * 1024;

export function checkCaller(token, expected = process.env.CGF_CALLER_TOKEN) {
  if (!expected) return false;                       // unset ⇒ writes disabled, never open
  const a = Buffer.from(String(token ?? '')), b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error('too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const buckets = new Map();
function rateLimited(req, rate = 60) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now(), slot = Math.floor(now / 60000), b = buckets.get(ip);
  if (!b || b.slot !== slot) { buckets.set(ip, { slot, n: 1 }); if (buckets.size > 10000) buckets.clear(); return false; }
  return ++b.n > rate;
}

export function createPublisherService({ relay, keyPath, port } = {}) {
  const RELAY = relay || process.env.CGF_RELAY_URL || 'wss://relay.ruv.io';
  const signer = loadSigner(keyPath);          // throws at boot if custody is wrong — by design
  const text = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] });
  const fail = (e) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: redact(e?.message || e) }) }] });

  function buildMcp(req) {
    // A dedicated header, not Authorization: Cloud Run consumes `Authorization`
    // for its own IAM check and answers 401 before the request reaches this
    // container, so a token sent that way never arrives. The header is still the
    // preferred channel — it stays out of the model's context and out of
    // tool-call transcripts — with the argument as a fallback for clients that
    // cannot set headers on an MCP connection.
    const header = String(req?.headers?.['x-caller-token'] || '').trim();
    const mcp = new McpServer({ name: 'ruflo-chatgpt-federation', version: VERSION });

    mcp.tool('federation_identity',
      'This connector\'s federation identity: the Nostr public key it signs with, and the relay it publishes to. Use when you need to know who the federation will see as the author, or to verify a published event came from this connector. The secret key is never returned by any tool.',
      {},
      async () => text({ pubkey: signer.pubkey, relay: RELAY, service: 'ruflo-chatgpt-federation', version: VERSION }));

    mcp.tool('channel_sync',
      'Read recent messages from a ruflo swarm channel (e.g. pub:announce, pub:help). Use before publishing, to see what has already been said and avoid duplicating it. Private (prv:) channels are returned as opaque ciphertext because this connector holds no channel keys.',
      { channel: z.string().optional().describe('Channel id, e.g. "pub:announce". Omit for the whole swarm stream.'),
        sinceSeconds: z.number().optional().describe('Look-back window in seconds (default 3600).'),
        limit: z.number().optional().describe('Maximum events to return (default 100).') },
      async (a) => { try { const msgs = await readChannel(RELAY, signer, a); return text({ count: msgs.length, messages: msgs }); } catch (e) { return fail(e); } });

    mcp.tool('channel_publish',
      'Sign a message with this connector\'s own key and publish it to a public swarm channel over its own NIP-42 authenticated relay connection. Use when this connector has something the federation needs — a status, a finding, a result. Requires the caller token; public (pub:) channels only, because publishing to a private channel needs a channel key this connector deliberately does not hold.',
      { channel: z.string().describe('Public channel id, e.g. "pub:announce".'),
        msgType: z.string().describe('Message type, e.g. "Status", "Result", "Question".'),
        payload: z.record(z.any()).describe('Message body. Never put secrets or credentials here — channel content is readable by every relay member.'),
        callerToken: z.string().optional().describe('Caller token, if not supplied as an x-caller-token header.') },
      async ({ channel, msgType, payload, callerToken }) => {
        if (!checkCaller(callerToken ?? header)) {
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'caller token required or invalid' }) }] };
        }
        if (!PUBLIC_CHANNEL_RE.test(String(channel))) return fail(new Error('channel must be a public pub:<name> channel'));
        try { return text({ ok: true, ...(await publishToChannel(RELAY, signer, { channel, msgType, payload })) }); }
        catch (e) { return fail(e); }
      });

    return mcp;
  }

  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
    if (url.pathname === '/health') return res.writeHead(200).end('ok');
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ service: 'ruflo-chatgpt-federation', version: VERSION, mcp: '/mcp',
        relay: RELAY, pubkey: signer.pubkey,
        tools: ['federation_identity', 'channel_sync', 'channel_publish'],
        publishAuth: 'x-caller-token: <caller token>' }));
    }
    if (url.pathname === '/mcp') {
      if (rateLimited(req)) return res.writeHead(429, { 'content-type': 'application/json' }).end('{"error":"rate limited"}');
      let body; try { body = await readBody(req); } catch { return res.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"payload too large"}'); }
      const mcp = buildMcp(req); const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); mcp.close(); });
      await mcp.connect(transport);
      let parsed; try { parsed = body ? JSON.parse(body) : undefined; } catch { return res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid json"}'); }
      return transport.handleRequest(req, res, parsed);
    }
    res.writeHead(404).end('not found');
  });

  return { server, pubkey: signer.pubkey, relay: RELAY,
    listen: (p = port ?? Number(process.env.PORT || 8080)) => new Promise((r) => server.listen(p, () => r(server.address().port))) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const svc = createPublisherService();
  const p = await svc.listen();
  // pubkey is public identity; the secret has no representation in any log line.
  console.log(`ruflo-chatgpt-federation :${p} | relay ${svc.relay} | pubkey ${svc.pubkey} | publish ${process.env.CGF_CALLER_TOKEN ? 'enabled' : 'DISABLED (CGF_CALLER_TOKEN unset)'}`);
}
