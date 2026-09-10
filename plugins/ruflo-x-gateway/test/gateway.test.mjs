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
  assert.equal(j.guidance, 'g'); assert.equal(j.proposals.length, 1); assert.deepEqual(j.risks, ['r']);
  assert.deepEqual(extractJson('plain prose').proposals, []);
  await assert.rejects(askSeraphina('x', { roster: {}, claims: {}, recentMessages: [] }, {}), /SERAPHINA_METALLM_KEY/);
});
