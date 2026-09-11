/**
 * ChatGPT Federation publisher — MCP over Streamable HTTP.
 *
 *   GET  /health          liveness
 *   GET  /                service info (pubkey is public; nothing else is)
 *   POST /mcp             MCP, stateless
 *
 * Surface is deliberately three tools and no resources.
 *
 * Authorisation is OAuth 2.1 against Cognitum's authorization server: a bearer
 * token in `Authorization`, validated here against the issuer's JWKS, carrying
 * `federation:read` for the two reads and `federation:publish` for the write.
 * There is no client secret in this design — that server is public-client + PKCE.
 *
 * While OAuth is being wired up (CGF_OAUTH_REQUIRED unset), the service still
 * accepts the older `x-caller-token` for publish and leaves reads open, so the
 * connector keeps working through the transition. Setting CGF_OAUTH_REQUIRED
 * closes both of those and is the end state.
 *
 * OAuth decides who may ask. The signing key answers, and is never an input, an
 * output, a resource, or a log line.
 */
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { loadSigner, redact } from './signing-key.mjs';
import { publishToChannel, readChannel, PUBLIC_CHANNEL_RE } from './publisher.mjs';
import { protectedResourceMetadata, challengeHeader, verifyAccessToken, hasScope, SCOPE_READ, SCOPE_PUBLISH } from './oauth.mjs';

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
  if (String(process.env.CGF_OAUTH_REQUIRED || '') === 'true' && !(process.env.CGF_OAUTH_CLIENT_ID || '').trim()) {
    // Enforcing OAuth without an expected audience would accept any token this
    // issuer ever minted, for any Cognitum app — strictly worse than the
    // transitional caller token it replaces. Fail the deploy.
    throw new Error('CGF_OAUTH_REQUIRED=true needs CGF_OAUTH_CLIENT_ID — refusing to enforce OAuth without an audience to bind to');
  }
  const text = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] });
  // An OAuth caller must carry the scope; a legacy caller (no token, OAuth not yet
  // mandatory) keeps the reads it has always had.
  const needs = (auth, scope) => (auth.mode !== 'oauth' || hasScope(auth.scopes, scope))
    ? null
    : { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `access token lacks ${scope}` }) }] };
  const fail = (e) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: redact(e?.message || e) }) }] });

  const OAUTH_ISSUER = process.env.CGF_OAUTH_ISSUER || 'https://auth.cognitum.one';
  const OAUTH_JWKS = process.env.CGF_OAUTH_JWKS_URI || `${OAUTH_ISSUER}/.well-known/jwks.json`;
  const OAUTH_REQUIRED = String(process.env.CGF_OAUTH_REQUIRED || '') === 'true';
  // auth.cognitum.one sets `aud` to the requesting client_id, so THAT is what a
  // token must be addressed to — not this service's URL. Absent, no audience is
  // asserted, which is only acceptable while OAuth is not yet enforced.
  const OAUTH_CLIENT_ID = (process.env.CGF_OAUTH_CLIENT_ID || '').trim();
  const resourceUrl = () => (process.env.CGF_PUBLIC_URL || '').replace(/\/$/, '');
  // RFC 9728 §5.1: point at the metadata for the resource the client actually
  // requested. A client using <base>/mcp must be sent to the /mcp-suffixed
  // document, whose `resource` is <base>/mcp — sending it to the bare document
  // hands back an identifier it never asked about, which is the same mismatch
  // that silently stalls setup.
  const prmUrl = (pathname) => `${resourceUrl()}/.well-known/oauth-protected-resource`
    + (pathname === '/mcp' ? '/mcp' : '');

  /**
   * Resolve what this request is allowed to do.
   *   oauth   — a verified token; scopes decide.
   *   legacy  — no token at all, and OAuth is not yet mandatory.
   *   denied  — a token that did not verify, or none while OAuth is mandatory.
   */
  async function authContext(req) {
    const bearer = String(req?.headers?.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (bearer) {
      const v = await verifyAccessToken(bearer, { issuer: OAUTH_ISSUER, jwksUri: OAUTH_JWKS,
        audience: OAUTH_CLIENT_ID || undefined });
      if (!v.ok) return { mode: 'denied', ...v };
      return { mode: 'oauth', scopes: v.scopes, subject: v.subject };
    }
    if (OAUTH_REQUIRED) return { mode: 'denied', error: 'invalid_request', description: 'authorization required' };
    return { mode: 'legacy', scopes: [] };
  }

  function buildMcp(req, auth) {
    // Credentials arrive ONLY through the transport, never as a tool argument.
    // An argument is model-generated: it puts the credential in the model's
    // context and in tool-call transcripts, and makes authority something the
    // model can be talked into supplying. Authentication belongs to middleware;
    // the tool receives an already-authenticated identity.
    // (This header is the retired transitional path, dead while OAuth is
    // enforced, and kept only so a pre-OAuth deployment can still be rolled back.)
    const header = String(req?.headers?.['x-caller-token'] || '').trim();
    const mcp = new McpServer({ name: 'ruflo-chatgpt-federation', version: VERSION });

    mcp.tool('federation_identity',
      'This connector\'s federation identity: the Nostr public key it signs with, and the relay it publishes to. Use when you need to know who the federation will see as the author, or to verify a published event came from this connector. The secret key is never returned by any tool.',
      {},
      async () => needs(auth, SCOPE_READ) ?? text({ pubkey: signer.pubkey, relay: RELAY, service: 'ruflo-chatgpt-federation', version: VERSION }));

    mcp.tool('channel_sync',
      'Read recent messages from a ruflo swarm channel (e.g. pub:announce, pub:help). Use before publishing, to see what has already been said and avoid duplicating it. Private (prv:) channels are returned as opaque ciphertext because this connector holds no channel keys.',
      { channel: z.string().optional().describe('Channel id, e.g. "pub:announce". Omit for the whole swarm stream.'),
        sinceSeconds: z.number().optional().describe('Look-back window in seconds (default 3600).'),
        limit: z.number().optional().describe('Maximum events to return (default 100).') },
      async (a) => { const no = needs(auth, SCOPE_READ); if (no) return no;
        try { const msgs = await readChannel(RELAY, signer, a); return text({ count: msgs.length, messages: msgs }); } catch (e) { return fail(e); } });

    mcp.tool('channel_publish',
      'Sign a message with this connector\'s own key and publish it to a public swarm channel over its own NIP-42 authenticated relay connection. Use when this connector has something the federation needs — a status, a finding, a result. Requires the caller token; public (pub:) channels only, because publishing to a private channel needs a channel key this connector deliberately does not hold.',
      { channel: z.string().describe('Public channel id, e.g. "pub:announce".'),
        msgType: z.string().describe('Message type, e.g. "Status", "Result", "Question".'),
        payload: z.record(z.any()).describe('Message body. Never put secrets or credentials here — channel content is readable by every relay member.') },
      async ({ channel, msgType, payload }) => {
        // OAuth scope is the real gate. The caller token remains a transitional
        // fallback and only while OAuth is not yet mandatory.
        const viaOauth = auth.mode === 'oauth' && hasScope(auth.scopes, SCOPE_PUBLISH);
        const viaLegacy = auth.mode === 'legacy' && checkCaller(header);
        if (!viaOauth && !viaLegacy) {
          const why = auth.mode === 'oauth'
            ? `access token lacks ${SCOPE_PUBLISH}`
            : 'caller token required or invalid';
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: why }) }] };
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
    // A connector running in a browser preflights /mcp before it may POST to it,
    // and cannot read WWW-Authenticate unless it is explicitly exposed — without
    // that header it never learns where to authenticate, so the OAuth flow never
    // starts. Origin is open because authority here comes from the bearer token,
    // not from where the request was made.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-expose-headers', 'www-authenticate, mcp-session-id, mcp-protocol-version');
    const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-allow-headers',
        'content-type, authorization, x-caller-token, mcp-session-id, mcp-protocol-version, accept');
      res.setHeader('access-control-max-age', '86400');
      return res.writeHead(204).end();
    }
    if (url.pathname === '/health') return res.writeHead(200).end('ok');
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ service: 'ruflo-chatgpt-federation', version: VERSION, mcp: '/mcp',
        relay: RELAY, pubkey: signer.pubkey,
        tools: ['federation_identity', 'channel_sync', 'channel_publish'],
        authorization: { type: 'oauth2', issuer: OAUTH_ISSUER, clientId: OAUTH_CLIENT_ID || null,
          scopes: [SCOPE_READ, SCOPE_PUBLISH],
          protectedResourceMetadata: prmUrl('/mcp'),
          enforced: OAUTH_REQUIRED,
          transitionalHeader: OAUTH_REQUIRED ? null : 'x-caller-token' } }));
    }
    // RFC 9728 discovery. Served at both the bare path and the /mcp-suffixed one,
    // because clients differ on which they probe.
    if (url.pathname === '/.well-known/oauth-protected-resource'
      || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      // RFC 9728 §3: `resource` must be the resource identifier the client used.
      // A client given `<base>/mcp` looks up the path-suffixed document and
      // expects `<base>/mcp` back; answering with the bare origin is a mismatch
      // it is entitled to reject, and some do — silently, during setup.
      const base = resourceUrl() || `https://${req.headers.host}`;
      const resource = url.pathname.endsWith('/mcp') ? `${base}/mcp` : base;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(protectedResourceMetadata({ resource, issuer: OAUTH_ISSUER })));
    }
    if (url.pathname === '/mcp') {
      if (rateLimited(req)) return res.writeHead(429, { 'content-type': 'application/json' }).end('{"error":"rate limited"}');
      let body; try { body = await readBody(req); } catch { return res.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"payload too large"}'); }
      const auth = await authContext(req);
      // One line per call, so "is OAuth actually being used?" is answerable from
      // logs instead of inferred. Never the token: only the mode, the granted
      // scopes, and a truncated hash of the subject — enough to correlate calls
      // from one identity, not enough to identify or replay anyone.
      try {
        const sub = auth.subject ? createHash('sha256').update(auth.subject).digest('hex').slice(0, 12) : '-';
        console.log(`mcp auth=${auth.mode} scopes=${(auth.scopes || []).join('+') || '-'} sub=${sub}` +
          (auth.mode === 'denied' ? ` reason=${redact(auth.error)}` : ''));
      } catch { /* logging must never break a request */ }
      if (auth.mode === 'denied') {
        // 401 + WWW-Authenticate is what starts a client's OAuth discovery.
        res.writeHead(401, { 'content-type': 'application/json',
          'www-authenticate': challengeHeader(prmUrl(url.pathname), { error: auth.error, description: auth.description }) });
        return res.end(JSON.stringify({ error: auth.error, error_description: auth.description }));
      }
      const mcp = buildMcp(req, auth); const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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
