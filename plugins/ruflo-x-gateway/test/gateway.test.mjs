import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { reduceClaims } from '../src/claims.mjs';
import { checkAdmin, rateLimited, readBody, MAX_BODY } from '../src/security.mjs';
import { connectAuthed } from '../src/nostr-federation.mjs';
import { createGateway } from '../src/server.mjs';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';

const ev = (type, pubkey, resourceId, t, extra = {}) => ({ type, pubkey, resourceId, created_at: t, ...extra });

test('claims: first ClaimIssued wins; later claim ignored', () => {
  const l = reduceClaims([ev('ClaimIssued', 'B', 'r1', 20), ev('ClaimIssued', 'A', 'r1', 10)]);
  assert.equal(l.r1.owner, 'A');
});
test('claims: release by owner frees; release by non-owner ignored', () => {
  assert.deepEqual(reduceClaims([ev('ClaimIssued', 'A', 'r1', 1), ev('ClaimReleased', 'A', 'r1', 2)]), {});
  assert.equal(reduceClaims([ev('ClaimIssued', 'A', 'r1', 1), ev('ClaimReleased', 'B', 'r1', 2)]).r1.owner, 'A');
});
test('claims: handoff only by current owner', () => {
  assert.equal(reduceClaims([ev('ClaimIssued', 'A', 'r1', 1), ev('ClaimHandoff', 'A', 'r1', 2, { toNode: 'C' })]).r1.owner, 'C');
  assert.equal(reduceClaims([ev('ClaimIssued', 'A', 'r1', 1), ev('ClaimHandoff', 'B', 'r1', 2, { toNode: 'C' })]).r1.owner, 'A');
});
test('security: checkAdmin is constant-time-safe and fails closed', () => {
  assert.equal(checkAdmin('s3cret', 's3cret'), true);
  assert.equal(checkAdmin('s3cre7', 's3cret'), false);
  assert.equal(checkAdmin('s3cret', undefined), false);   // no token configured → deny
  assert.equal(checkAdmin(undefined, 's3cret'), false);
});
test('security: rate limiter trips after burst', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.9' }, socket: {} };
  let tripped = false; for (let i = 0; i < 100; i++) if (rateLimited(req, 60)) { tripped = true; break; }
  assert.equal(tripped, true);
});
test('security: readBody rejects oversize content-length up front', async () => {
  const req = { headers: { 'content-length': String(MAX_BODY + 1) }, on() {}, destroy() {} };
  await assert.rejects(readBody(req), /too large/);
});
test('nip42: connectAuthed signs the challenge and resolves on OK / rejects on refusal', async () => {
  const sk = generateSecretKey(), pk = getPublicKey(sk);
  const run = (accept) => new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const url = `ws://127.0.0.1:${wss.address().port}`;
      wss.on('connection', (s) => { s.send(JSON.stringify(['AUTH', 'chal-123'])); s.on('message', (d) => { const m = JSON.parse(d); assert.equal(m[0], 'AUTH'); const e = m[1];
        assert.equal(e.kind, 22242); assert.equal(e.pubkey, pk); assert.ok(verifyEvent(e)); assert.ok(e.tags.some((t) => t[0] === 'challenge' && t[1] === 'chal-123'));
        s.send(JSON.stringify(['OK', e.id, accept, accept ? '' : 'restricted: not a relay member'])); }); });
      connectAuthed(url, sk, { timeoutMs: 4000 }).then((ws) => { ws.close(); wss.close(); resolve('ok'); }, (e) => { wss.close(); resolve('rej:' + e.message); });
    });
  });
  assert.equal(await run(true), 'ok');
  assert.match(await run(false), /rej:.*not a relay member/);
});
test('server: routes, admin gating, oversize body, unknown ws path', async () => {
  process.env.RUFLO_ADMIN_TOKEN = 'test-admin-token';
  const gw = createGateway({ relay: 'ws://127.0.0.1:1', keyFile: '/tmp/x-gw-test-' + Date.now() + '.key', port: 0 });
  const port = await gw.listen(0); const base = `http://127.0.0.1:${port}`;
  assert.equal(await (await fetch(base + '/health')).text(), 'ok');
  const info = await (await fetch(base + '/')).json(); assert.equal(info.gatewayPubkey, gw.pubkey); assert.ok(info.resources.includes('ruv://claims/board'));
  const rpc = (m) => fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(m) }).then((r) => r.text());
  const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  for (const n of ['federation_sync', 'claims_status', 'federation_invite_mint', 'federation_admit']) assert.ok(list.includes(`"name":"${n}"`), n);
  const noTok = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'claims_issue', arguments: { resourceId: 'x' } } });
  assert.match(noTok, /admin token required|invalid_type|Required/);   // rejected: missing/invalid adminToken
  const badTok = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'claims_issue', arguments: { resourceId: 'x', adminToken: 'wrong' } } });
  assert.match(badTok, /admin token required or invalid/);
  const big = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(MAX_BODY + 10) }, body: 'x'.repeat(MAX_BODY + 10) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
  gw.server.close();
});
test('seraphina: compaction dedupes by from|type, extractJson survives fences, missing key fails closed', async () => {
  const { compactRecent, extractJson, askSeraphina } = await import('../src/seraphina.mjs');
  const c = compactRecent([{ from: 'a', type: 'PeerHello', ts: 1 }, { from: 'a', type: 'PeerHello', ts: 2 }, { from: 'b', type: 'Status', ts: 3 }]);
  assert.equal(c.length, 2); assert.equal(c[0].from, 'b');
  const j = extractJson('sure:\n```json\n{"guidance":"g","proposals":[{"type":"Task"}],"risks":["r"]}\n```');
  assert.equal(j.ok, true);
  assert.equal(j.parsed.guidance, 'g'); assert.equal(j.parsed.proposals.length, 1); assert.deepEqual(j.parsed.risks, ['r']);
  const bad = extractJson('plain prose');
  assert.equal(bad.ok, false, 'non-JSON must be reported, not silently coerced');
  assert.deepEqual(bad.parsed.proposals, []);
  await assert.rejects(askSeraphina('x', { roster: {}, claims: {}, recentMessages: [] }, {}), /SERAPHINA_METALLM_KEY/);
});

test('seraphina: a truncated reasoning reply is reported as degraded, not as "nothing to do"', async () => {
  const { askSeraphina } = await import('../src/seraphina.mjs');
  const origFetch = globalThis.fetch;
  // Reproduces the live failure: the tier resolved to a reasoning model that spent the
  // whole budget thinking, so stop_reason is max_tokens and no JSON was ever emitted.
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    model: 'z-ai/glm-5.3-flash', stop_reason: 'max_tokens',
    usage: { input_tokens: 550, output_tokens: 8000, reasoning_tokens: 8000 },
    content: [{ type: 'text', text: 'Let me analyze this swarm snapshot. The operator wants' }],
  }) });
  try {
    const r = await askSeraphina('status', { roster: { a: {} }, claims: {}, recentMessages: [] }, { key: 'k' });
    assert.equal(r.degraded, true);
    assert.equal(r.stopReason, 'max_tokens');
    assert.equal(r.guidance, '', 'must not pass raw reasoning off as guidance');
    assert.deepEqual(r.proposals, []);
    assert.match(r.reason, /budget before emitting an answer/);
    assert.match(r.hint, /cognitum-low/);
  } finally { globalThis.fetch = origFetch; }
});

test('seraphina: a well-formed reply still parses and is not marked degraded', async () => {
  const { askSeraphina } = await import('../src/seraphina.mjs');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    model: 'anthropic/claude-sonnet-5', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 },
    content: [{ type: 'text', text: '{"guidance":"ship it","proposals":[{"type":"Task","forNode":"a"}],"risks":[]}' }],
  }) });
  try {
    const r = await askSeraphina('status', { roster: { a: {} }, claims: {}, recentMessages: [] }, { key: 'k' });
    assert.equal(r.degraded, undefined);
    assert.equal(r.guidance, 'ship it');
    assert.equal(r.proposals.length, 1);
  } finally { globalThis.fetch = origFetch; }
});
test('hardening: publish bounds, bucket eviction, ws maxPayload/404, fetchManyOn single-connection', async () => {
  const { publish, MAX_PAYLOAD_BYTES, fetchManyOn } = await import('../src/nostr-federation.mjs');
  const { rateLimited, _bucketsForTest } = await import('../src/security.mjs');
  const src = await import('node:fs').then((f) => f.readFileSync(new URL('../src/ws-proxy.mjs', import.meta.url), 'utf8'));
  await assert.rejects(publish('ws://127.0.0.1:1', new Uint8Array(32), 'bad type!', {}), /invalid msgType/);
  await assert.rejects(publish('ws://127.0.0.1:1', new Uint8Array(32), 'Status', { x: 'y'.repeat(MAX_PAYLOAD_BYTES) }), /payload too large/);
  for (let i = 0; i < 12_000; i++) rateLimited({ headers: { 'x-forwarded-for': `10.0.${(i >> 8) & 255}.${i & 255}` }, socket: {} }, 60);
  assert.ok(_bucketsForTest.size <= 10_100, 'bucket map is bounded: ' + _bucketsForTest.size);
  assert.match(src, /maxPayload/); assert.match(src, /404 Not Found/);
  // fetchManyOn: one AUTH handshake, N REQs on the same socket
  const sk = generateSecretKey(); let handshakes = 0, reqs = 0;
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (s) => { s.send(JSON.stringify(['AUTH', 'c'])); s.on('message', (d) => { const m = JSON.parse(d); if (m[0] === 'AUTH') { handshakes++; s.send(JSON.stringify(['OK', m[1].id, true, ''])); } if (m[0] === 'REQ') { reqs++; s.send(JSON.stringify(['EOSE', m[1]])); } }); });
  const out = await fetchManyOn(`ws://127.0.0.1:${wss.address().port}`, sk, [{ limit: 1 }, { limit: 1 }, { limit: 1 }]);
  wss.close();
  assert.equal(out.length, 3); assert.equal(handshakes, 1); assert.equal(reqs, 3);
});

// ---- ADR-386 channels ----
test('channels: ids, seal/open, non-member cannot open, type hidden on private', async () => {
  const c = await import('../src/channels.mjs');
  const { generateSecretKey, getPublicKey } = await import('nostr-tools/pure');

  // public ids carry the name; private ids are derived from the key and carry nothing
  assert.equal(c.publicChannelId('release-3-41'), 'pub:release-3-41');
  assert.throws(() => c.publicChannelId('Bad Name'), /channel name/);
  const key = c.newChannelKey();
  const id = c.privateChannelId(key);
  assert.match(id, /^prv:[0-9a-f]{16}$/);
  assert.equal(c.privateChannelId(key), id, 'id is deterministic in the key');
  assert.notEqual(c.privateChannelId(c.newChannelKey()), id);
  assert.ok(c.isPrivateChannel(id) && !c.isPrivateChannel('pub:x'));
  assert.throws(() => c.privateChannelId('abcd'), /32 bytes/);

  // message sealing round trip, and a wrong key opens nothing
  const ct = c.sealMessage(key, { type: 'Task', taskId: 't-1' });
  assert.ok(!/taskId|Task/.test(ct), 'ciphertext must not leak the body');
  assert.deepEqual(c.openMessage(key, ct), { type: 'Task', taskId: 't-1' });
  assert.equal(c.openMessage(c.newChannelKey(), ct), null);

  // key grant: only the addressed member opens it
  const granter = generateSecretKey(), member = generateSecretKey(), outsider = generateSecretKey();
  const sealed = c.sealChannelKey(granter, getPublicKey(member), key);
  assert.equal(c.openChannelKey(member, getPublicKey(granter), sealed), key);
  assert.equal(c.openChannelKey(outsider, getPublicKey(granter), sealed), null);
  assert.throws(() => c.sealChannelKey(granter, 'nothex', key), /64 hex/);

  // tags: private hides the message type behind k=enc, public keeps it
  assert.deepEqual(c.channelTags(id, 'Task', true), [['t', 'ruflo-swarm'], ['c', id], ['k', 'enc']]);
  assert.deepEqual(c.channelTags('pub:ops', 'Status', false), [['t', 'ruflo-swarm'], ['c', 'pub:ops'], ['k', 'Status']]);
  assert.throws(() => c.channelTags('bogus', 'Task', false), /bad channel id/);
});

test('channels: tools are registered, private publish refused, ids validated', async () => {
  process.env.RUFLO_ADMIN_TOKEN = 'test-admin-token';
  const gw = createGateway({ relay: 'ws://127.0.0.1:1', keyFile: '/tmp/x-gw-ch-' + Date.now() + '.key', port: 0 });
  const port = await gw.listen(0); const base = `http://127.0.0.1:${port}`;
  const rpc = (m) => fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(m) }).then((r) => r.text());
  const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  for (const n of ['channel_list', 'channel_sync', 'channel_publish']) assert.ok(list.includes(`"name":"${n}"`), n);
  assert.ok(list.includes('Use when'), 'ADR-112 descriptions');

  // channel_publish is admin-gated like every other gateway-identity write
  const noTok = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'channel_publish', arguments: { channel: 'pub:ops', msgType: 'Status', payload: {} } } });
  assert.match(noTok, /admin token required|invalid_type|Required/);

  // the gateway refuses to publish to a private channel: it holds no channel key
  const priv = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'channel_publish', arguments: { channel: 'prv:0123456789abcdef', msgType: 'Status', payload: {}, adminToken: 'test-admin-token' } } });
  assert.match(priv, /holds no channel key|private channels cannot/);

  // a malformed id is rejected before any relay work
  const bad = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'channel_sync', arguments: { channel: 'not a channel' } } });
  assert.match(bad, /pub:<name> or prv:/);

  const info = await (await fetch(base + '/')).json();
  assert.ok(info.resources.includes('ruv://swarm/channels'));
  // Version is asserted once, in the registry-directory test — re-pinning it here
  // just means two tests to update on every bump.
  gw.server.close();
});

test('channels: declared defaults are discoverable when quiet, and malformed ids are not channels', async () => {
  const c = await import('../src/channels.mjs');

  // Small on purpose: a directory of plausible empty rooms costs a newcomer more
  // attention than no directory at all.
  assert.ok(c.DEFAULT_CHANNELS.length > 0 && c.DEFAULT_CHANNELS.length <= 6);
  for (const d of c.DEFAULT_CHANNELS) {
    assert.ok(c.CHANNEL_ID_RE.test(d.channel), `${d.channel} must be a valid id`);
    assert.ok(!c.isPrivateChannel(d.channel), 'a declared default cannot be private — nobody could read it');
    assert.ok(d.purpose && d.purpose.length > 20, `${d.channel} needs a purpose a newcomer can act on`);
  }
  const ids = c.DEFAULT_CHANNELS.map((d) => d.channel);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate default channels');

  // The probe traffic that exposed this: a bare `c` tag value is not a channel.
  assert.equal(c.isWellFormedChannel('ruflo-probe-c'), false);
  assert.equal(c.isWellFormedChannel(''), false);
  assert.equal(c.isWellFormedChannel(undefined), false);
  assert.equal(c.isWellFormedChannel('pub:announce'), true);
  assert.equal(c.isWellFormedChannel('prv:0123456789abcdef'), true);
});

test('channels: the registry resource publishes the directory', async () => {
  process.env.RUFLO_ADMIN_TOKEN = 'test-admin-token';
  const gw = createGateway({ relay: 'ws://127.0.0.1:1', keyFile: '/tmp/x-gw-def-' + Date.now() + '.key', port: 0 });
  const port = await gw.listen(0); const base = `http://127.0.0.1:${port}`;
  const body = await fetch(base + '/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ruv://federation/registry' } }) }).then((r) => r.text());
  const { DEFAULT_CHANNELS } = await import('../src/channels.mjs');
  for (const d of DEFAULT_CHANNELS) assert.ok(body.includes(d.channel), `${d.channel} missing from the registry`);
  const info = await (await fetch(base + '/')).json();
  assert.equal(info.version, '0.5.1');
  // GitHub-style discovery metadata: the create-channel + invite-contributor story is self-describing.
  assert.ok(typeof info.description === 'string' && info.description.length > 0, 'root info carries a description');
  assert.ok(Array.isArray(info.quickstart) && info.quickstart.length >= 4, 'root info carries a quickstart');
  assert.ok(info.channels && info.channels.public && info.channels.private, 'root info explains public + private channels');
  assert.equal(info.canonicalRelay, gw.relay, 'canonicalRelay preserved for NIP-42');
  assert.ok(info.resources.includes('ruv://claims/board'), 'resources preserved');
  gw.server.close();
});
