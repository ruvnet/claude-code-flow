import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { generateSecretKey } from 'nostr-tools/pure';
import { createPublisherService } from '../src/server.mjs';
import { protectedResourceMetadata, challengeHeader, SCOPE_READ, SCOPE_PUBLISH } from '../src/oauth.mjs';

const dir = mkdtempSync(join(tmpdir(), 'cgf-oauth-'));
const keyPath = join(dir, 'signing-key');
writeFileSync(keyPath, Buffer.from(generateSecretKey()).toString('hex'), { mode: 0o600 });

// A stand-in authorization server: publishes a JWKS and mints tokens we control.
async function fakeAuthServer() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-1', alg: 'RS256', use: 'sig' };
  const srv = createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, r));
  const issuer = `http://127.0.0.1:${srv.address().port}`;
  const mint = ({ scope, audience, issuer: iss = issuer, expSeconds = 300 }) =>
    new SignJWT({ scope })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-1' })
      .setIssuer(iss).setAudience(audience).setSubject('user-1')
      .setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds)
      .sign(privateKey);
  // Same signing key, but no iss and no aud — the shape auth.cognitum.one actually issues.
  const mintRaw = ({ scope, expSeconds = 300 }) =>
    new SignJWT({ scope })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-1' })
      .setSubject('user-1').setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds)
      .sign(privateKey);
  return { issuer, jwksUri: `${issuer}/.well-known/jwks.json`, mint, mintRaw, close: () => srv.close() };
}

const CLIENT_ID = 'chatgpt-federation';

async function withService(as, { required, publicUrl, clientId = CLIENT_ID }, fn) {
  const prev = { ...process.env };
  Object.assign(process.env, {
    CGF_OAUTH_ISSUER: as.issuer, CGF_OAUTH_JWKS_URI: as.jwksUri,
    CGF_PUBLIC_URL: publicUrl, CGF_OAUTH_REQUIRED: required ? 'true' : '',
    CGF_OAUTH_CLIENT_ID: clientId,
  });
  const svc = createPublisherService({ relay: 'ws://127.0.0.1:1', keyPath });
  const port = await svc.listen(0);
  try { return await fn(port, svc); }
  finally { svc.server.close(); for (const k of ['CGF_OAUTH_ISSUER','CGF_OAUTH_JWKS_URI','CGF_PUBLIC_URL','CGF_OAUTH_REQUIRED','CGF_OAUTH_CLIENT_ID']) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

const call = (port, name, args = {}, headers = {}) =>
  fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  .then(async (r) => {
    const raw = await r.text();
    const line = raw.split('\n').find((l) => l.startsWith('data: '));
    return { status: r.status, wwwAuth: r.headers.get('www-authenticate'),
      body: line || raw.startsWith('{') ? JSON.parse(line ? line.slice(6) : raw) : raw };
  });

const toolText = (b) => b.result?.content?.[0]?.text ?? JSON.stringify(b);

test('protected-resource metadata names the authorization server and both scopes', () => {
  const m = protectedResourceMetadata({ resource: 'https://x.example', issuer: 'https://auth.example' });
  assert.equal(m.resource, 'https://x.example');
  assert.deepEqual(m.authorization_servers, ['https://auth.example']);
  assert.deepEqual(m.scopes_supported, ['federation:read', 'federation:publish']);
  assert.deepEqual(m.bearer_methods_supported, ['header']);
});

test('the challenge header points a client at discovery', () => {
  const h = challengeHeader('https://x.example/.well-known/oauth-protected-resource', { error: 'invalid_token' });
  assert.match(h, /^Bearer resource_metadata="https:\/\/x\.example\/\.well-known\/oauth-protected-resource"/);
  assert.match(h, /error="invalid_token"/);
});

test('discovery is served at both paths clients probe', async () => {
  const as = await fakeAuthServer();
  try {
    await withService(as, { required: true, publicUrl: 'https://cgf.example' }, async (port) => {
      for (const [path, expected] of [
        ['/.well-known/oauth-protected-resource', 'https://cgf.example'],
        ['/.well-known/oauth-protected-resource/mcp', 'https://cgf.example/mcp'],
      ]) {
        const r = await fetch(`http://127.0.0.1:${port}${path}`);
        assert.equal(r.status, 200, path);
        const m = await r.json();
        assert.deepEqual(m.authorization_servers, [as.issuer]);
        assert.equal(m.resource, expected, path);
      }
    });
  } finally { as.close(); }
});

test('with OAuth required, an unauthenticated call gets 401 and a discovery pointer', async () => {
  const as = await fakeAuthServer();
  try {
    await withService(as, { required: true, publicUrl: 'https://cgf.example' }, async (port) => {
      const r = await call(port, 'federation_identity');
      assert.equal(r.status, 401);
      // …/mcp was requested, so the pointer carries the /mcp suffix.
      assert.match(r.wwwAuth, /resource_metadata="https:\/\/cgf\.example\/\.well-known\/oauth-protected-resource\/mcp"/);
    });
  } finally { as.close(); }
});

test('a token from another issuer is refused', async () => {
  const as = await fakeAuthServer();
  try {
    await withService(as, { required: true, publicUrl: 'https://cgf.example' }, async (port) => {
      const tok = await as.mint({ scope: SCOPE_READ, audience: CLIENT_ID, issuer: 'https://evil.example' });
      const r = await call(port, 'federation_identity', {}, { authorization: `Bearer ${tok}` });
      assert.equal(r.status, 401);
      assert.match(r.wwwAuth, /error="invalid_token"/);
    });
  } finally { as.close(); }
});

test('a token minted for a different client is refused', async () => {
  // Same issuer, different client. auth.cognitum.one binds `aud` to the
  // requesting client_id, so this is the check that stops another Cognitum app's
  // token from acting as the federation identity.
  const as = await fakeAuthServer();
  try {
    await withService(as, { required: true, publicUrl: 'https://cgf.example' }, async (port) => {
      const tok = await as.mint({ scope: SCOPE_PUBLISH, audience: 'some-other-client' });
      const r = await call(port, 'federation_identity', {}, { authorization: `Bearer ${tok}` });
      assert.equal(r.status, 401);
    });
  } finally { as.close(); }
});

test('an expired token is refused', async () => {
  const as = await fakeAuthServer();
  try {
    await withService(as, { required: true, publicUrl: 'https://cgf.example' }, async (port) => {
      const tok = await as.mint({ scope: SCOPE_READ, audience: CLIENT_ID, expSeconds: -3600 });
      const r = await call(port, 'federation_identity', {}, { authorization: `Bearer ${tok}` });
      assert.equal(r.status, 401);
    });
  } finally { as.close(); }
});

test('federation:read reads, but does not publish', async () => {
  const as = await fakeAuthServer();
  try {
    await withService(as, { required: true, publicUrl: 'https://cgf.example' }, async (port, svc) => {
      const tok = await as.mint({ scope: SCOPE_READ, audience: CLIENT_ID });
      const auth = { authorization: `Bearer ${tok}` };

      const id = await call(port, 'federation_identity', {}, auth);
      assert.equal(id.status, 200);
      assert.equal(JSON.parse(toolText(id.body)).pubkey, svc.pubkey);

      const pub = await call(port, 'channel_publish',
        { channel: 'pub:announce', msgType: 'Status', payload: {} }, auth);
      assert.match(toolText(pub.body), /lacks federation:publish/);
    });
  } finally { as.close(); }
});

test('a scopeless token cannot even read', async () => {
  const as = await fakeAuthServer();
  try {
    await withService(as, { required: true, publicUrl: 'https://cgf.example' }, async (port) => {
      const tok = await as.mint({ scope: '', audience: CLIENT_ID });
      const r = await call(port, 'federation_identity', {}, { authorization: `Bearer ${tok}` });
      assert.match(toolText(r.body), /lacks federation:read/);
    });
  } finally { as.close(); }
});

test('federation:publish reaches the publish path (and fails only at the relay)', async () => {
  const as = await fakeAuthServer();
  try {
    await withService(as, { required: true, publicUrl: 'https://cgf.example' }, async (port) => {
      const tok = await as.mint({ scope: `${SCOPE_READ} ${SCOPE_PUBLISH}`, audience: CLIENT_ID });
      const r = await call(port, 'channel_publish',
        { channel: 'pub:announce', msgType: 'Status', payload: {} }, { authorization: `Bearer ${tok}` });
      // Authorisation passed; the relay is unreachable in this test, which is how
      // we know the request got past the gate rather than being refused by it.
      assert.equal(r.status, 200);
      assert.doesNotMatch(toolText(r.body), /lacks federation:publish|caller token/);
    });
  } finally { as.close(); }
});

test('the transitional caller token still works only while OAuth is not enforced', async () => {
  const as = await fakeAuthServer();
  const prev = process.env.CGF_CALLER_TOKEN;
  process.env.CGF_CALLER_TOKEN = 'transitional';
  try {
    await withService(as, { required: false, publicUrl: 'https://cgf.example' }, async (port) => {
      const open = await call(port, 'federation_identity');
      assert.equal(open.status, 200, 'reads stay open during the transition');
      const pub = await call(port, 'channel_publish',
        { channel: 'pub:announce', msgType: 'Status', payload: {} }, { 'x-caller-token': 'transitional' });
      assert.doesNotMatch(toolText(pub.body), /caller token required/);
    });
    await withService(as, { required: true, publicUrl: 'https://cgf.example' }, async (port) => {
      const pub = await call(port, 'channel_publish',
        { channel: 'pub:announce', msgType: 'Status', payload: {} }, { 'x-caller-token': 'transitional' });
      assert.equal(pub.status, 401, 'enforcing OAuth must close the transitional door');
    });
  } finally { as.close(); if (prev === undefined) delete process.env.CGF_CALLER_TOKEN; else process.env.CGF_CALLER_TOKEN = prev; }
});

test('the service info advertises the authorization server and enforcement state', async () => {
  // This block is how an operator (and a human debugging a connector) learns which
  // AS to use and whether the transitional door is still open. It silently missed
  // its patch anchor once; this test is why that cannot recur unnoticed.
  const as = await fakeAuthServer();
  try {
    for (const required of [false, true]) {
      await withService(as, { required, publicUrl: 'https://cgf.example' }, async (port) => {
        const info = await (await fetch(`http://127.0.0.1:${port}/`)).json();
        assert.equal(info.authorization.type, 'oauth2');
        assert.equal(info.authorization.issuer, as.issuer);
        assert.deepEqual(info.authorization.scopes, [SCOPE_READ, SCOPE_PUBLISH]);
        assert.equal(info.authorization.protectedResourceMetadata,
          'https://cgf.example/.well-known/oauth-protected-resource/mcp');
        assert.equal(info.authorization.enforced, required);
        assert.equal(info.authorization.transitionalHeader, required ? null : 'x-caller-token');
      });
    }
  } finally { as.close(); }
});

test('a correctly-signed but unbound token is rejected AND says why', async () => {
  // auth.cognitum.one is measured to issue tokens with neither iss nor aud. Such a
  // token is not resource-bound: any Cognitum-integrated app holding a user's token
  // could present it here and publish as the federation identity. It must be
  // refused — and the refusal must name the cause, not just say "invalid_token".
  const as = await fakeAuthServer();
  try {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    void publicKey;
    void privateKey;
    await withService(as, { required: true, publicUrl: 'https://cgf.example' }, async (port) => {
      // Minted by the real issuer's key, but with no iss and no aud.
      const tok = await as.mintRaw({ scope: `${SCOPE_READ} ${SCOPE_PUBLISH}` });
      const r = await call(port, 'channel_publish',
        { channel: 'pub:announce', msgType: 'Status', payload: {} }, { authorization: `Bearer ${tok}` });
      assert.equal(r.status, 401, 'an unbound token must not authorise anything');
      assert.match(r.wwwAuth || '', /carries no iss or aud claim/);
    });
  } finally { as.close(); }
});

test('enforcing OAuth without an expected audience fails the deploy', async () => {
  // Enforcing OAuth with no audience to bind to would accept ANY token this
  // issuer ever minted, for any Cognitum app — strictly worse than the
  // transitional caller token it replaces. It must not be a silent config gap.
  const prev = { ...process.env };
  try {
    process.env.CGF_OAUTH_REQUIRED = 'true';
    delete process.env.CGF_OAUTH_CLIENT_ID;
    assert.throws(() => createPublisherService({ relay: 'ws://127.0.0.1:1', keyPath }),
      /refusing to enforce OAuth without an audience to bind to/);
  } finally {
    for (const k of ['CGF_OAUTH_REQUIRED', 'CGF_OAUTH_CLIENT_ID']) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
});

test('ACCEPTANCE: session and other-client tokens get 401; ours succeeds with exactly two scopes', async () => {
  // The stated bar. Three tokens, same issuer key, same signature validity —
  // separated only by what they are addressed to.
  const as = await fakeAuthServer();
  try {
    await withService(as, { required: true, publicUrl: 'https://cgf.example' }, async (port, svc) => {
      // 1. A browser-session-shaped token: auth_web.rs mints these through the
      //    unbound path, so they carry neither iss nor aud.
      const session = await as.mintRaw({ scope: `${SCOPE_READ} ${SCOPE_PUBLISH}` });
      const r1 = await call(port, 'federation_identity', {}, { authorization: `Bearer ${session}` });
      assert.equal(r1.status, 401, 'a browser-session token must not authenticate here');
      assert.match(r1.wwwAuth || '', /carries no iss or aud claim/);

      // 2. A well-formed OAuth token for a DIFFERENT Cognitum client.
      const other = await as.mint({ scope: `${SCOPE_READ} ${SCOPE_PUBLISH}`, audience: 'music-cognitum-one' });
      const r2 = await call(port, 'channel_publish',
        { channel: 'pub:announce', msgType: 'Status', payload: {} }, { authorization: `Bearer ${other}` });
      assert.equal(r2.status, 401, 'another client\'s token must not act as the federation identity');

      // 3. Ours: correct issuer, addressed to our client_id, exactly the two scopes.
      const ours = await as.mint({ scope: `${SCOPE_READ} ${SCOPE_PUBLISH}`, audience: CLIENT_ID });
      const r3 = await call(port, 'federation_identity', {}, { authorization: `Bearer ${ours}` });
      assert.equal(r3.status, 200);
      assert.equal(JSON.parse(toolText(r3.body)).pubkey, svc.pubkey);

      // and it carries ONLY those two — a third scope must not ride along.
      const decoded = JSON.parse(Buffer.from(ours.split('.')[1], 'base64url').toString());
      assert.deepEqual(decoded.scope.split(' ').sort(), [SCOPE_PUBLISH, SCOPE_READ].sort());
      assert.equal(decoded.aud, CLIENT_ID);
      assert.equal(decoded.iss, as.issuer);
    });
  } finally { as.close(); }
});

test('a browser-origin connector can preflight /mcp', async () => {
  // Without this the connector cannot POST at all, and the failure surfaces to
  // the user as a generic "error creating connector".
  const as = await fakeAuthServer();
  try {
    await withService(as, { required: false, publicUrl: 'https://cgf.example' }, async (port) => {
      const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'OPTIONS',
        headers: { origin: 'https://chatgpt.com', 'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,authorization' } });
      assert.equal(r.status, 204);
      assert.equal(r.headers.get('access-control-allow-origin'), '*');
      assert.match(r.headers.get('access-control-allow-methods') || '', /POST/);
      assert.match(r.headers.get('access-control-allow-headers') || '', /authorization/);
      // The client cannot start OAuth if it cannot read the challenge.
      assert.match(r.headers.get('access-control-expose-headers') || '', /www-authenticate/);
    });
  } finally { as.close(); }
});

test('protected-resource metadata echoes the identifier the client asked about', async () => {
  const as = await fakeAuthServer();
  try {
    await withService(as, { required: false, publicUrl: 'https://cgf.example' }, async (port) => {
      const bare = await (await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`)).json();
      assert.equal(bare.resource, 'https://cgf.example');
      const suffixed = await (await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`)).json();
      assert.equal(suffixed.resource, 'https://cgf.example/mcp',
        'a client given <base>/mcp must get <base>/mcp back, not the bare origin');
    });
  } finally { as.close(); }
});

test('the auth-mode log line never contains token material', async () => {
  const as = await fakeAuthServer();
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    await withService(as, { required: true, publicUrl: 'https://cgf.example' }, async (port) => {
      const tok = await as.mint({ scope: `${SCOPE_READ} ${SCOPE_PUBLISH}`, audience: CLIENT_ID });
      await call(port, 'federation_identity', {}, { authorization: `Bearer ${tok}` });
      const line = lines.find((l) => l.startsWith('mcp auth='));
      assert.ok(line, 'an auth line is emitted');
      assert.match(line, /auth=oauth/);
      assert.match(line, /scopes=federation:read\+federation:publish/);
      assert.ok(!line.includes(tok), 'the token must never appear in a log line');
      assert.ok(!/user-1/.test(line), 'the raw subject must not appear either');
    });
  } finally { console.log = orig; as.close(); }
});

test('the 401 challenge points at the metadata for the path that was requested', async () => {
  const as = await fakeAuthServer();
  try {
    await withService(as, { required: true, publicUrl: 'https://cgf.example' }, async (port) => {
      const r = await call(port, 'federation_identity');
      assert.equal(r.status, 401);
      // …/mcp was requested, so the pointer must be the /mcp-suffixed document,
      // whose `resource` matches the identifier the client is using.
      assert.match(r.wwwAuth || '',
        /resource_metadata="https:\/\/cgf\.example\/\.well-known\/oauth-protected-resource\/mcp"/);
    });
  } finally { as.close(); }
});

test('no tool accepts a credential as an argument', async () => {
  // Submission requirement, and the right rule regardless: a credential passed
  // as a tool argument is model-generated — it lands in the model's context and
  // in tool-call transcripts, and makes authority something the model can be
  // persuaded to supply. Authentication is the transport's job.
  const as = await fakeAuthServer();
  try {
    await withService(as, { required: false, publicUrl: 'https://cgf.example' }, async (port) => {
      const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      const raw = await r.text();
      const line = raw.split('\n').find((l) => l.startsWith('data: '));
      for (const t of JSON.parse(line ? line.slice(6) : raw).result.tools) {
        const props = Object.keys(t.inputSchema?.properties || {});
        const creds = props.filter((k) => /token|secret|password|apikey|api_key|credential/i.test(k));
        assert.deepEqual(creds, [], `${t.name} exposes credential argument(s): ${creds.join(', ')}`);
      }
    });
  } finally { as.close(); }
});
