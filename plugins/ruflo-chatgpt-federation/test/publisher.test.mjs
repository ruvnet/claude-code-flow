import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { generateSecretKey, getPublicKey, verifyEvent, getEventHash } from 'nostr-tools/pure';
import { loadSigner, redact, DEFAULT_KEY_PATH } from '../src/signing-key.mjs';
import { publishToChannel, readChannel, channelTags, connectAuthed, PUBLIC_CHANNEL_RE } from '../src/publisher.mjs';
import { createPublisherService, checkCaller } from '../src/server.mjs';

const dir = mkdtempSync(join(tmpdir(), 'cgf-'));
const skHex = Buffer.from(generateSecretKey()).toString('hex');
const keyPath = join(dir, 'signing-key');
writeFileSync(keyPath, skHex, { mode: 0o600 });

// ---- custody ----

test('loadSigner refuses a missing key instead of generating one', () => {
  // A generated fallback would be an unadmitted identity that reports healthy and
  // then fails every publish with "restricted:". Refusing to start is the honest failure.
  assert.throws(() => loadSigner(join(dir, 'nope')), /signing key unreadable/);
});

test('loadSigner refuses a key that is not 32 bytes of hex', () => {
  const bad = join(dir, 'bad'); writeFileSync(bad, 'not-a-key');
  assert.throws(() => loadSigner(bad), /not 32 bytes of hex/);
});

test('loadSigner tolerates the trailing newline a console paste adds', () => {
  const nl = join(dir, 'nl'); writeFileSync(nl, skHex + '\n');
  assert.equal(loadSigner(nl).pubkey, getPublicKey(Uint8Array.from(Buffer.from(skHex, 'hex'))));
});

test('the signer exposes a public key and a sign function, and nothing else', () => {
  const signer = loadSigner(keyPath);
  // Structural, not a string match: no property may carry the secret out.
  assert.deepEqual(Object.keys(signer).sort(), ['pubkey', 'sign']);
  const serialized = JSON.stringify(signer);
  assert.ok(!serialized.includes(skHex), 'secret must not survive serialization');
});

test('an unexpected identity fails startup rather than rolling over silently', () => {
  const prev = process.env.CGF_EXPECTED_PUBKEY;
  const other = getPublicKey(generateSecretKey());
  try {
    process.env.CGF_EXPECTED_PUBKEY = other;
    assert.throws(() => loadSigner(keyPath), /refusing to start under an unexpected federation identity/);
    // and the matching case still boots
    process.env.CGF_EXPECTED_PUBKEY = getPublicKey(Uint8Array.from(Buffer.from(skHex, 'hex')));
    assert.equal(loadSigner(keyPath).pubkey, process.env.CGF_EXPECTED_PUBKEY);
  } finally { if (prev === undefined) delete process.env.CGF_EXPECTED_PUBKEY; else process.env.CGF_EXPECTED_PUBKEY = prev; }
});

test('the pin is opt-in: unset means no assertion', () => {
  const prev = process.env.CGF_EXPECTED_PUBKEY;
  try { delete process.env.CGF_EXPECTED_PUBKEY; assert.ok(loadSigner(keyPath).pubkey); }
  finally { if (prev !== undefined) process.env.CGF_EXPECTED_PUBKEY = prev; }
});

test('redact scrubs anything shaped like key material', () => {
  assert.equal(redact(`leaked ${skHex} here`), 'leaked [redacted] here');
  assert.equal(redact(undefined), '');
});

test('the default key path is the read-only Cloud Run secret mount', () => {
  assert.equal(DEFAULT_KEY_PATH, '/secrets/nostr/signing-key');
});

test('no environment variable can supply the key value', async () => {
  // Only the *path* is configurable. An env var holding the secret itself is the
  // exposure a secret volume exists to remove, so the loader must not read one.
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/signing-key.mjs', import.meta.url), 'utf8'));
  const envReads = [...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual(envReads.sort(), ['CGF_EXPECTED_PUBKEY', 'CGF_SIGNING_KEY_PATH']);
  // neither carries key material: one is a path, the other a PUBLIC key
  assert.ok(!/process\.env\.[A-Z0-9_]*(SECRET|SK|PRIVATE|KEY_HEX)/.test(src));
});

// ---- tag compatibility with the gateway (ADR-386) ----

test('channelTags emits the ADR-386 shape', () => {
  assert.deepEqual(channelTags('pub:announce', 'Status'),
    [['t', 'ruflo-swarm'], ['c', 'pub:announce'], ['k', 'Status']]);
});

test('the gateway still builds channel tags the same way', async () => {
  // Read the gateway's source rather than importing it: this guard must run in a
  // bare checkout, and the gateway is a separate container with its own deps.
  // Drift here does not fail loudly — events publish fine and become invisible to
  // every reader, because the relay indexes `c` and reserves `h` for NIP-29 groups.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../ruflo-x-gateway/src/channels.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function channelTags'));
  assert.match(body, /\['t', 'ruflo-swarm'\]/, 'gateway must still tag t=ruflo-swarm');
  assert.match(body, /\['c', String\(channelId\)\]/, 'gateway must still tag the channel on `c`, not `h`');
});

test('channelTags refuses private channels and malformed types', () => {
  assert.throws(() => channelTags('prv:0123456789abcdef', 'Status'), /pub:/);
  assert.throws(() => channelTags('pub:announce', 'bad type!'), /msgType/);
  assert.ok(!PUBLIC_CHANNEL_RE.test('prv:0123456789abcdef'));
});

// ---- caller token ----

test('publishing is disabled, not open, when no caller token is configured', () => {
  assert.equal(checkCaller('anything', undefined), false);
  assert.equal(checkCaller(undefined, undefined), false);
});

test('caller token compare accepts the match and rejects near misses', () => {
  assert.equal(checkCaller('s3cret', 's3cret'), true);
  assert.equal(checkCaller('s3cres', 's3cret'), false);
  assert.equal(checkCaller('s3cret-longer', 's3cret'), false);
});

// ---- a relay that enforces what buzz-relay enforces ----

/**
 * Minimal NIP-42 relay: issues a challenge, binds the connection to the AUTH
 * identity, and refuses any EVENT signed by a different key — which is the exact
 * rule that makes a "gateway relays your signed event" design impossible.
 */
function fakeRelay() {
  const wss = new WebSocketServer({ port: 0 });
  const seen = [];
  wss.on('connection', (ws) => {
    let authed = null;
    ws.send(JSON.stringify(['AUTH', 'challenge-' + Math.random().toString(36).slice(2)]));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m[0] === 'AUTH') {
        const ev = m[1];
        const ok = ev.kind === 22242 && getEventHash(ev) === ev.id && verifyEvent(ev);
        if (ok) authed = ev.pubkey;
        return ws.send(JSON.stringify(['OK', ev.id, ok, ok ? '' : 'auth: bad event']));
      }
      if (m[0] === 'EVENT') {
        const ev = m[1];
        if (!authed) return ws.send(JSON.stringify(['OK', ev.id, false, 'auth-required: authenticate first']));
        if (ev.pubkey !== authed) return ws.send(JSON.stringify(['OK', ev.id, false, 'invalid: event pubkey does not match authenticated identity']));
        if (getEventHash(ev) !== ev.id || !verifyEvent(ev)) return ws.send(JSON.stringify(['OK', ev.id, false, 'invalid: bad signature']));
        seen.push(ev);
        return ws.send(JSON.stringify(['OK', ev.id, true, '']));
      }
      if (m[0] === 'REQ') {
        for (const ev of seen) ws.send(JSON.stringify(['EVENT', m[1], ev]));
        ws.send(JSON.stringify(['EOSE', m[1]]));
      }
    });
  });
  return { url: () => `ws://127.0.0.1:${wss.address().port}`, seen, close: () => wss.close() };
}

test('publish authenticates, signs locally, and the event pubkey is the authenticated identity', async () => {
  const relay = fakeRelay();
  try {
    const signer = loadSigner(keyPath);
    const r = await publishToChannel(relay.url(), signer, {
      channel: 'pub:announce', msgType: 'Status', payload: { note: 'probe' } });

    // The acceptance bar: pubkey == authenticated identity, and the event id
    // independently verifies against the content.
    assert.equal(r.pubkey, r.authenticatedAs);
    assert.equal(r.pubkey, signer.pubkey);
    const ev = relay.seen.find((e) => e.id === r.eventId);
    assert.ok(ev, 'relay accepted and stored the event');
    assert.equal(getEventHash(ev), ev.id);
    assert.ok(verifyEvent(ev));
    assert.equal(JSON.parse(ev.content).note, 'probe');
  } finally { relay.close(); }
});

test('the relay refuses an event signed by a key other than the authenticated one', async () => {
  // Proves the constraint this whole service exists to satisfy.
  const relay = fakeRelay();
  try {
    const signer = loadSigner(keyPath);
    const ws = await connectAuthed(relay.url(), signer);
    const otherSk = generateSecretKey();
    const { finalizeEvent } = await import('nostr-tools/pure');
    const foreign = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000),
      tags: channelTags('pub:announce', 'Status'), content: '{}' }, otherSk);
    const reason = await new Promise((resolve) => {
      ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m[0] === 'OK' && m[1] === foreign.id) resolve(m[3]); });
      ws.send(JSON.stringify(['EVENT', foreign]));
    });
    assert.match(reason, /does not match authenticated identity/);
    ws.close();
  } finally { relay.close(); }
});

test('readChannel returns what was published, verified', async () => {
  const relay = fakeRelay();
  try {
    const signer = loadSigner(keyPath);
    await publishToChannel(relay.url(), signer, { channel: 'pub:help', msgType: 'Question', payload: { q: 'how' } });
    const msgs = await readChannel(relay.url(), signer, { channel: 'pub:help' });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].q, 'how');
    assert.equal(msgs[0].pubkey, signer.pubkey);
  } finally { relay.close(); }
});

// ---- MCP surface ----

async function rpc(port, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body) });
  const raw = await res.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  const out = JSON.parse(line ? line.slice(6) : raw);
  out._status = res.status; out._wwwAuth = res.headers.get('www-authenticate');
  return out;
}

test('the MCP surface is exactly three tools, and none of them can return the key', async () => {
  const relay = fakeRelay();
  const svc = createPublisherService({ relay: relay.url(), keyPath });
  const port = await svc.listen(0);
  try {
    const out = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const names = out.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['channel_publish', 'channel_sync', 'federation_identity']);
    assert.ok(!JSON.stringify(out).includes(skHex));

    const id = await rpc(port, { jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'federation_identity', arguments: {} } });
    const body = JSON.parse(id.result.content[0].text);
    assert.equal(body.pubkey, svc.pubkey);
    assert.ok(!JSON.stringify(id).includes(skHex), 'identity must not leak the secret');
  } finally { svc.server.close(); relay.close(); }
});

test('channel_publish refuses without the caller token and publishes with it', async () => {
  const relay = fakeRelay();
  const prev = process.env.CGF_CALLER_TOKEN;
  process.env.CGF_CALLER_TOKEN = 'test-caller-token';
  const svc = createPublisherService({ relay: relay.url(), keyPath });
  const port = await svc.listen(0);
  try {
    const denied = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'channel_publish', arguments: { channel: 'pub:announce', msgType: 'Status', payload: {} } } });
    assert.match(denied.result.content[0].text, /caller token required/);

    // Authorization is the OAuth channel now, so the caller token sent there is
    // not a caller token at all — it is an unverifiable access token, and the
    // answer is a 401 that starts discovery, not a quiet grant.
    const wrongHeader = await rpc(port, { jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'channel_publish', arguments: { channel: 'pub:announce', msgType: 'Status', payload: {} } } },
      { authorization: 'Bearer test-caller-token' });
    assert.equal(wrongHeader._status, 401);
    assert.match(wrongHeader._wwwAuth || '', /^Bearer resource_metadata=/);
    assert.match(wrongHeader._wwwAuth || '', /error="invalid_token"/);

    const ok = await rpc(port, { jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'channel_publish', arguments: { channel: 'pub:announce', msgType: 'Status', payload: { note: 'hi' } } } },
      { 'x-caller-token': 'test-caller-token' });
    const body = JSON.parse(ok.result.content[0].text);
    assert.equal(body.ok, true);
    assert.equal(body.pubkey, body.authenticatedAs);
    assert.equal(relay.seen.length, 1);
  } finally { svc.server.close(); relay.close(); if (prev === undefined) delete process.env.CGF_CALLER_TOKEN; else process.env.CGF_CALLER_TOKEN = prev; }
});

test('channel_publish refuses a private channel even with a valid token', async () => {
  const relay = fakeRelay();
  const prev = process.env.CGF_CALLER_TOKEN;
  process.env.CGF_CALLER_TOKEN = 'test-caller-token';
  const svc = createPublisherService({ relay: relay.url(), keyPath });
  const port = await svc.listen(0);
  try {
    const out = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'channel_publish', arguments: { channel: 'prv:0123456789abcdef', msgType: 'Status', payload: {} } } },
      { 'x-caller-token': 'test-caller-token' });
    assert.match(out.result.content[0].text, /public pub:/);
    assert.equal(relay.seen.length, 0);
  } finally { svc.server.close(); relay.close(); if (prev === undefined) delete process.env.CGF_CALLER_TOKEN; else process.env.CGF_CALLER_TOKEN = prev; }
});
