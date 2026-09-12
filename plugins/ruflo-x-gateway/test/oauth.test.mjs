import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createGateway } from '../src/server.mjs';
import { protectedResourceMetadata, SCOPE_READ, SCOPE_PUBLISH } from '../src/oauth.mjs';

const CLIENT_ID = 'ruflo-x-gateway';

async function fakeAuthServer() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'g1', alg: 'RS256', use: 'sig' };
  const srv = createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, r));
  const issuer = `http://127.0.0.1:${srv.address().port}`;
  const mint = ({ scope, audience, issuer: iss = issuer }) =>
    new SignJWT({ scope }).setProtectedHeader({ alg: 'RS256', kid: 'g1' })
      .setIssuer(iss).setAudience(audience).setSubject('u1')
      .setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + 300).sign(privateKey);
  // The shape auth_web.rs mints: no iss, no aud.
  const mintSession = ({ scope }) =>
    new SignJWT({ scope }).setProtectedHeader({ alg: 'RS256', kid: 'g1' })
      .setSubject('u1').setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + 300).sign(privateKey);
  return { issuer, jwksUri: `${issuer}/.well-known/jwks.json`, mint, mintSession, close: () => srv.close() };
}

async function withGateway(as, fn) {
  const prev = { ...process.env };
  Object.assign(process.env, {
    RUFLO_OAUTH_ISSUER: as.issuer, RUFLO_OAUTH_JWKS_URI: as.jwksUri,
    RUFLO_OAUTH_CLIENT_ID: CLIENT_ID, RUFLO_PUBLIC_URL: 'https://x.example',
  });
  const gw = createGateway({ relay: 'ws://127.0.0.1:1', keyFile: '/tmp/gw-test.key' });
  const port = await gw.listen(0);
  try { return await fn(port, gw); }
  finally {
    gw.server.close();
    for (const k of ['RUFLO_OAUTH_ISSUER','RUFLO_OAUTH_JWKS_URI','RUFLO_OAUTH_CLIENT_ID','RUFLO_PUBLIC_URL']) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
}

const call = (port, name, args = {}, headers = {}, path = '/mcp') =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  .then(async (r) => {
    const raw = await r.text();
    const line = raw.split('\n').find((l) => l.startsWith('data: '));
    let body = null; try { body = JSON.parse(line ? line.slice(6) : raw); } catch {}
    return { status: r.status, wwwAuth: r.headers.get('www-authenticate'), body };
  });
const toolText = (r) => r.body?.result?.content?.[0]?.text ?? JSON.stringify(r.body);

test('the gateway advertises its own scopes, not the connector\'s', () => {
  const m = protectedResourceMetadata({ resource: 'https://x.example', issuer: 'https://auth.example' });
  assert.deepEqual(m.scopes_supported, ['swarm:read', 'swarm:publish']);
  // Sharing federation:* would be safe (audience pinning is what isolates), but
  // distinct scopes keep a consent screen honest about what this resource grants.
  assert.ok(!m.scopes_supported.some((s) => s.startsWith('federation:')));
});

test('discovery echoes the identifier the client asked about', async () => {
  const as = await fakeAuthServer();
  try {
    await withGateway(as, async (port) => {
      const bare = await (await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`)).json();
      assert.equal(bare.resource, 'https://x.example');
      assert.deepEqual(bare.authorization_servers, [as.issuer]);
      const sfx = await (await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`)).json();
      assert.equal(sfx.resource, 'https://x.example/mcp');
      const chatgpt = await (await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/chatgpt/mcp`)).json();
      assert.equal(chatgpt.resource, 'https://x.example/chatgpt/mcp');
      assert.deepEqual(chatgpt.authorization_servers, [as.issuer]);
    });
  } finally { as.close(); }
});

test('an anonymous ChatGPT-profile write returns an HTTP OAuth challenge', async () => {
  const as = await fakeAuthServer();
  try {
    await withGateway(as, async (port) => {
      const r = await call(port, 'federation_publish', { msgType: 'Status', payload: {} }, {}, '/chatgpt/mcp');
      assert.equal(r.status, 401);
      assert.match(r.wwwAuth || '', /oauth-protected-resource\/chatgpt\/mcp/);
      assert.match(r.body?.error || '', /invalid_request/);
    });
  } finally { as.close(); }
});

test('a swarm:publish token authorises a ChatGPT-profile write without a tool secret', async () => {
  const as = await fakeAuthServer();
  try {
    await withGateway(as, async (port) => {
      const tok = await as.mint({ scope: `${SCOPE_READ} ${SCOPE_PUBLISH}`, audience: CLIENT_ID });
      const r = await call(port, 'federation_publish', { msgType: 'Status', payload: {} },
        { authorization: `Bearer ${tok}` }, '/chatgpt/mcp');
      assert.notEqual(r.status, 401);
      assert.doesNotMatch(toolText(r), /no write credential|admin token required|lacks swarm:publish/);
    });
  } finally { as.close(); }
});

test('a browser-origin client can preflight /mcp and read the challenge', async () => {
  const as = await fakeAuthServer();
  try {
    await withGateway(as, async (port) => {
      const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'OPTIONS',
        headers: { origin: 'https://chatgpt.com', 'access-control-request-method': 'POST' } });
      assert.equal(r.status, 204);
      assert.match(r.headers.get('access-control-allow-headers') || '', /authorization/);
      assert.match(r.headers.get('access-control-expose-headers') || '', /www-authenticate/);
    });
  } finally { as.close(); }
});

test('anonymous reads still work — the federation front door stays open', async () => {
  const as = await fakeAuthServer();
  try {
    await withGateway(as, async (port, gw) => {
      const r = await call(port, 'federation_identity');
      assert.equal(r.status, 200);
      assert.equal(JSON.parse(toolText(r)).pubkey, gw.pubkey);
    });
  } finally { as.close(); }
});

test('a presented bearer that does not verify is refused, never downgraded to anonymous', async () => {
  const as = await fakeAuthServer();
  try {
    await withGateway(as, async (port) => {
      const r = await call(port, 'federation_identity', {}, { authorization: 'Bearer nope' });
      assert.equal(r.status, 401);
      assert.match(r.wwwAuth || '', /resource_metadata=".*\/oauth-protected-resource\/mcp"/);
    });
  } finally { as.close(); }
});

test('a token for ANOTHER Cognitum client cannot act here', async () => {
  // The ChatGPT Federation connector's audience. This is the replay this
  // resource must refuse, and it is what audience pinning buys.
  const as = await fakeAuthServer();
  try {
    await withGateway(as, async (port) => {
      const tok = await as.mint({ scope: `${SCOPE_READ} ${SCOPE_PUBLISH}`, audience: 'chatgpt-federation' });
      const r = await call(port, 'federation_identity', {}, { authorization: `Bearer ${tok}` });
      assert.equal(r.status, 401);
    });
  } finally { as.close(); }
});

test('a browser-session token (no iss/aud) cannot act here', async () => {
  const as = await fakeAuthServer();
  try {
    await withGateway(as, async (port) => {
      const tok = await as.mintSession({ scope: `${SCOPE_READ} ${SCOPE_PUBLISH}` });
      const r = await call(port, 'federation_identity', {}, { authorization: `Bearer ${tok}` });
      assert.equal(r.status, 401);
      // Assert the PROPERTY, not the wording: a session token is refused because
      // it is bound to no resource. Which claim is named first depends on
      // verification order and is not what matters.
      assert.match(r.wwwAuth || '', /not bound to this resource/);
      assert.match(r.wwwAuth || '', /carries no (iss|aud)/);
    });
  } finally { as.close(); }
});

test('swarm:publish authorises a write with NO admin token', async () => {
  const as = await fakeAuthServer();
  try {
    await withGateway(as, async (port) => {
      const tok = await as.mint({ scope: `${SCOPE_READ} ${SCOPE_PUBLISH}`, audience: CLIENT_ID });
      const r = await call(port, 'federation_publish',
        { msgType: 'Status', payload: { note: 'x' } }, { authorization: `Bearer ${tok}` });
      // Authorisation passed; the relay is unreachable in this test, which is how
      // we know it got past the gate rather than being refused by it.
      assert.doesNotMatch(toolText(r), /admin token required/);
    });
  } finally { as.close(); }
});

test('a read-only token cannot write', async () => {
  const as = await fakeAuthServer();
  try {
    await withGateway(as, async (port) => {
      const tok = await as.mint({ scope: SCOPE_READ, audience: CLIENT_ID });
      const r = await call(port, 'federation_publish',
        { msgType: 'Status', payload: {} }, { authorization: `Bearer ${tok}` });
      assert.match(toolText(r), /lacks swarm:publish/);
    });
  } finally { as.close(); }
});

test('an anonymous write is still refused', async () => {
  const as = await fakeAuthServer();
  try {
    await withGateway(as, async (port) => {
      const r = await call(port, 'federation_publish', { msgType: 'Status', payload: {} });
      assert.match(toolText(r), /no write credential/);
    });
  } finally { as.close(); }
});

test('adminToken is optional in the schema, or OAuth writes cannot even be attempted', async () => {
  // Regression guard for a defect that looked like working code: while the
  // schema required adminToken, every OAuth-authorised write was rejected at
  // validation before the handler saw the token.
  const as = await fakeAuthServer();
  try {
    await withGateway(as, async (port) => {
      const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      const raw = await r.text();
      const line = raw.split('\n').find((l) => l.startsWith('data: '));
      const tools = JSON.parse(line ? line.slice(6) : raw).result.tools;
      const pub = tools.find((t) => t.name === 'federation_publish');
      assert.ok(pub, 'federation_publish is exposed');
      assert.ok(!(pub.inputSchema.required || []).includes('adminToken'),
        'adminToken must not be a required argument once OAuth can authorise writes');
    });
  } finally { as.close(); }
});

test('with no audience configured, a bearer token is refused rather than honoured', async () => {
  // Unconfigured must mean "no OAuth", never "OAuth without an audience" — the
  // latter would accept any token this issuer ever minted, for any app.
  const as = await fakeAuthServer();
  const prev = { ...process.env };
  try {
    Object.assign(process.env, { RUFLO_OAUTH_ISSUER: as.issuer, RUFLO_OAUTH_JWKS_URI: as.jwksUri,
      RUFLO_PUBLIC_URL: 'https://x.example' });
    delete process.env.RUFLO_OAUTH_CLIENT_ID;
    const gw = createGateway({ relay: 'ws://127.0.0.1:1', keyFile: '/tmp/gw-noaud.key' });
    const port = await gw.listen(0);
    try {
      const tok = await as.mint({ scope: SCOPE_PUBLISH, audience: 'anything-at-all' });
      const r = await call(port, 'federation_identity', {}, { authorization: `Bearer ${tok}` });
      assert.equal(r.status, 401, 'a token must not be honoured when no audience is pinned');
    } finally { gw.server.close(); }
  } finally {
    as.close();
    for (const k of ['RUFLO_OAUTH_ISSUER','RUFLO_OAUTH_JWKS_URI','RUFLO_PUBLIC_URL','RUFLO_OAUTH_CLIENT_ID']) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
});

test('a dynamically registered client\'s token is accepted; a stranger\'s is not', async () => {
  // DCR mints clients whose tokens carry aud=<their own client_id>, never
  // `ruflo-x-gateway` — so pinning a single audience made dynamic registration
  // useless. This resource accepts `dcr-` audiences BECAUSE registration
  // constrains those clients to this resource's own scopes. If that constraint
  // is ever loosened, this acceptance stops being safe.
  const as = await fakeAuthServer();
  try {
    await withGateway(as, async (port) => {
      const dcr = await as.mint({ scope: SCOPE_PUBLISH, audience: 'dcr-0123456789abcdef' });
      const ok = await call(port, 'federation_identity', {}, { authorization: `Bearer ${dcr}` });
      assert.equal(ok.status, 200, 'a dcr- client must be able to use this resource');

      // Still refused: another Cognitum resource's client.
      const other = await as.mint({ scope: SCOPE_PUBLISH, audience: 'chatgpt-federation' });
      assert.equal((await call(port, 'federation_identity', {}, { authorization: `Bearer ${other}` })).status, 401);

      // And a name that merely CONTAINS dcr- must not pass — prefix, not substring.
      const sneaky = await as.mint({ scope: SCOPE_PUBLISH, audience: 'not-a-dcr-client' });
      assert.equal((await call(port, 'federation_identity', {}, { authorization: `Bearer ${sneaky}` })).status, 401,
        'audience matching must be a prefix check, not a substring check');
    });
  } finally { as.close(); }
});

test('GET /mcp serves finite JSON by default and finite SSE when requested', async () => {
  const as = await fakeAuthServer();
  try {
    await withGateway(as, async (port) => {
      const t0 = Date.now();
      const json = await fetch(`http://127.0.0.1:${port}/mcp`);
      assert.equal(json.status, 200);
      assert.match(json.headers.get('content-type') || '', /application\/json/);
      const doc = await json.json();
      assert.equal(doc.transport, 'streamable-http');
      assert.deepEqual(doc.methods, ['POST']);
      assert.ok(Array.isArray(doc.servers));

      const sse = await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { accept: 'text/event-stream' } });
      assert.equal(sse.status, 200);
      assert.match(sse.headers.get('content-type') || '', /text\/event-stream/);
      assert.match(await sse.text(), /^: /);
      assert.ok(Date.now() - t0 < 2000, 'both GET responses must complete immediately');
    });
  } finally { as.close(); }
});

test('swarm:publish may post, but may NOT change relay membership', async () => {
  // Publishing and deciding who may join are different powers. A self-registered
  // client can obtain swarm:publish with nothing but a sign-in, so if that scope
  // also admitted members, the registration gate would be the only thing between
  // a stranger and the relay roster.
  const as = await fakeAuthServer();
  try {
    await withGateway(as, async (port) => {
      const tok = await as.mint({ scope: `${SCOPE_READ} ${SCOPE_PUBLISH}`, audience: CLIENT_ID });
      const auth = { authorization: `Bearer ${tok}` };

      // Allowed: posting.
      const pub = await call(port, 'federation_publish', { msgType: 'Status', payload: {} }, auth);
      assert.doesNotMatch(toolText(pub), /admin token required/, 'swarm:publish must be able to post');

      // Refused: membership control.
      for (const [name, args] of [
        ['federation_admit', { pubkey: 'a'.repeat(64), role: 'member' }],
        ['federation_invite_mint', { ttlSecs: 60, maxUses: 1 }],
      ]) {
        const r = await call(port, name, args, auth);
        assert.match(toolText(r), /no write credential|admin token/,
          `${name} must not be reachable with swarm:publish alone`);
      }
    });
  } finally { as.close(); }
});

test('every write tool documents the OAuth path, not just the admin token', async () => {
  // A description saying only "Admin-gated" leads a model to ask a person for
  // the admin token — which also authorises every other gateway write and must
  // never be pasted into a browser.
  const as = await fakeAuthServer();
  try {
    await withGateway(as, async (port) => {
      const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      const raw = await r.text();
      const line = raw.split('\n').find((l) => l.startsWith('data: '));
      for (const t of JSON.parse(line ? line.slice(6) : raw).result.tools) {
        if (!('adminToken' in (t.inputSchema?.properties || {}))) continue;
        // "Admin-gated" is now always an incomplete answer: either an OAuth
        // token also authorises the tool, or the admin token is required and
        // the description must say the scope is not sufficient — or, as with
        // seraphina_guidance, the tool is not gated at all and the phrase was
        // simply wrong. Every tool must state its real authorisation.
        assert.ok(!/Admin-gated/.test(t.description),
          `${t.name} says "Admin-gated", which no longer describes how it is authorised`);
        assert.match(t.description, /swarm:publish|admin token is OPTIONAL/,
          `${t.name} must state whether an OAuth token can authorise it`);
      }
    });
  } finally { as.close(); }
});

test('a write refused for a missing scope says so, and does not blame the admin token', async () => {
  // The old message was "admin token required or invalid" for every refusal,
  // including a perfectly valid token that simply lacked swarm:publish. That
  // sends the caller hunting for a broken credential, and invites them to paste
  // an admin token into a browser to make it go away.
  const as = await fakeAuthServer();
  try {
    await withGateway(as, async (port) => {
      const readOnly = await as.mint({ scope: SCOPE_READ, audience: CLIENT_ID });
      const r = await call(port, 'federation_publish', { msgType: 'Status', payload: {} },
        { authorization: `Bearer ${readOnly}` });
      const body = toolText(r);
      assert.match(body, /lacks swarm:publish/, 'must name the missing scope');
      assert.match(body, /swarm:read/, 'must report what the token actually holds');
      assert.match(body, /Re-authorise/, 'must say how to fix it');
      assert.doesNotMatch(body, /admin token required/, 'must not blame the admin token');
      assert.match(body, /Do NOT paste an admin token/, 'must warn against the wrong remedy');
    });
  } finally { as.close(); }
});

test('a write with no credential at all still refuses, with its own message', async () => {
  const as = await fakeAuthServer();
  try {
    await withGateway(as, async (port) => {
      const body = toolText(await call(port, 'federation_publish', { msgType: 'Status', payload: {} }));
      assert.match(body, /no write credential/);
      assert.match(body, /swarm:publish/);
    });
  } finally { as.close(); }
});
