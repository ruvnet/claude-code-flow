#!/usr/bin/env node
/**
 * Post-deployment end-to-end check for the ChatGPT Federation connector.
 *
 * Verifies what can be verified without a human at a browser. The OAuth
 * authorization-code flow needs an interactive sign-in at auth.cognitum.one, so
 * this asserts everything up to and around it — that the client is registered,
 * that the scopes are advertised, that discovery is correct, that an unbound or
 * wrong-audience token is refused — and reports the interactive steps as
 * PENDING rather than silently skipping them.
 *
 *   node scripts/e2e.mjs                       # read-only checks
 *   CGF_CALLER_TOKEN=… node scripts/e2e.mjs    # also publish + read back + dedupe
 */
import WebSocket from 'ws';
import { finalizeEvent, verifyEvent, getEventHash } from 'nostr-tools/pure';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const SERVICE = process.env.CGF_URL || 'https://chatgpt-federation-875130704813.us-central1.run.app';
const RELAY = process.env.CGF_RELAY_URL || 'wss://relay.ruv.io';
const AS = process.env.CGF_OAUTH_ISSUER || 'https://auth.cognitum.one';
const CLIENT_ID = process.env.CGF_OAUTH_CLIENT_ID || 'chatgpt-federation';
const PUBKEY = process.env.CGF_EXPECTED_PUBKEY || 'a29fbf2f7299d13e1f1049f829e0d7036949133de4226d728b2f181458d56890';
const CHANNEL = process.env.CGF_CHANNEL || 'pub:ruflo-release';

let pass = 0, fail = 0, pending = 0;
const ok = (n, d = '') => { pass++; console.log(`  ok      ${n}${d ? ` — ${d}` : ''}`); };
const no = (n, d = '') => { fail++; console.error(`  FAIL    ${n}${d ? ` — ${d}` : ''}`); };
const todo = (n, d) => { pending++; console.log(`  PENDING ${n} — ${d}`); };

async function mcp(method, params, headers = {}) {
  const r = await fetch(`${SERVICE}/mcp`, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const raw = await r.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  let body = null; try { body = JSON.parse(line ? line.slice(6) : raw); } catch {}
  return { status: r.status, wwwAuth: r.headers.get('www-authenticate'), body };
}
const toolBody = (r) => { try { return JSON.parse(r.body.result.content[0].text); } catch { return null; } };

// Enforcement state decides what an unauthenticated call is SUPPOSED to do, so
// read it before asserting anything: under enforcement a 401 here is the correct
// answer, not a defect.
const info = await (await fetch(`${SERVICE}/`)).json();
const enforced = info.authorization.enforced === true;
const accessToken = process.env.CGF_ACCESS_TOKEN;
const authed = accessToken ? { authorization: `Bearer ${accessToken}` } : {};

// ---- 1. connector identity and surface ----
console.log(`\nconnector  (oauth ${enforced ? 'ENFORCED' : 'not enforced'}${accessToken ? ', token supplied' : ''})`);
if (enforced && !accessToken) {
  // The service's own advertisement is public and unauthenticated, so the
  // surface is still checkable — just not through the MCP endpoint.
  info.pubkey === PUBKEY ? ok('service info reports the pinned pubkey', PUBKEY.slice(0, 16) + '…')
                         : no('service info reports the pinned pubkey', `got ${info.pubkey}`);
  JSON.stringify(info.tools.slice().sort()) === JSON.stringify(['channel_publish', 'channel_sync', 'federation_identity'])
    ? ok('service info advertises exactly three tools', info.tools.join(', '))
    : no('service info advertises exactly three tools', JSON.stringify(info.tools));
  todo('tools/list and federation_identity over MCP',
    'OAuth is enforced — set CGF_ACCESS_TOKEN to exercise the MCP surface directly');
} else {
  const r = await mcp('tools/list', {}, authed);
  const names = (r.body?.result?.tools ?? []).map((t) => t.name).sort();
  names.length === 3 && names.join() === 'channel_publish,channel_sync,federation_identity'
    ? ok('exposes exactly three tools', names.join(', '))
    : no('exposes exactly three tools', `got ${JSON.stringify(names)}`);
  const b = toolBody(await mcp('tools/call', { name: 'federation_identity', arguments: {} }, authed));
  b?.pubkey === PUBKEY ? ok('federation_identity returns the pinned pubkey', PUBKEY.slice(0, 16) + '…')
                       : no('federation_identity returns the pinned pubkey', `got ${b?.pubkey}`);
}

// ---- 2. OAuth discovery ----
console.log('\noauth discovery');
{
  const m = await (await fetch(`${SERVICE}/.well-known/oauth-protected-resource`)).json().catch(() => null);
  m?.authorization_servers?.[0] === AS ? ok('protected-resource metadata names the AS', AS)
                                       : no('protected-resource metadata names the AS', JSON.stringify(m));
  const want = ['federation:read', 'federation:publish'];
  want.every((s) => m?.scopes_supported?.includes(s)) ? ok('resource advertises both scopes')
                                                      : no('resource advertises both scopes', JSON.stringify(m?.scopes_supported));
}
{
  const m = await (await fetch(`${AS}/.well-known/oauth-authorization-server`)).json().catch(() => null);
  const want = ['federation:read', 'federation:publish'];
  const have = m?.scopes_supported ?? [];
  want.every((s) => have.includes(s))
    ? ok('authorization server advertises both scopes')
    : no('authorization server advertises both scopes', `identity not yet deployed? have=${JSON.stringify(have)}`);
  m?.token_endpoint_auth_methods_supported?.includes('none')
    ? ok('AS is a public client (no client secret)') : no('AS is a public client');
}
{
  // Does the client row exist? Distinguish it by the REASON the AS gives, not by
  // the status code or the page title — every rejection is a 400 titled
  // "Invalid OAuth Request", so a title check cannot tell a registered client
  // from an unknown one. An unknown client says "Unknown client_id"; a
  // registered one renders its consent page naming the app.
  //
  // `state` is required in practice: omit it and even a known-good client is
  // rejected, which reads exactly like "the client is not registered".
  const q = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code',
    redirect_uri: process.env.CGF_REDIRECT_URI || 'https://chatgpt.com/connector/oauth/rsmLSzfP7w_t',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256',
    scope: 'federation:read federation:publish', state: 'e2e' });
  const html = await (await fetch(`${AS}/oauth/authorize?${q}`)).text().catch(() => '');
  const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  if (/Unknown client_id/.test(text)) {
    no(`AS knows client_id=${CLIENT_ID}`, 'Unknown client_id — the migration has not reached this database');
  } else if (/is requesting access/i.test(text)) {
    ok(`AS knows client_id=${CLIENT_ID}`, 'renders its consent page, so redirect_uri and both scopes were accepted');
  } else {
    no(`AS knows client_id=${CLIENT_ID}`, `unexpected response: ${text.slice(0, 90)}`);
  }

  // Control: the same probe against a client that cannot exist must say so.
  // Without this, a change to the error page would silently turn the check above
  // into one that always passes.
  const cq = new URLSearchParams({ client_id: 'e2e-nonexistent-client', response_type: 'code',
    redirect_uri: 'https://example.com/cb', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256', scope: 'federation:read', state: 'e2e' });
  const ctext = (await (await fetch(`${AS}/oauth/authorize?${cq}`)).text().catch(() => ''))
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  /Unknown client_id/.test(ctext)
    ? ok('control: an unknown client_id is reported as unknown')
    : no('control: an unknown client_id is reported as unknown', 'the probe above cannot be trusted');
}

// ---- 3. token rejection (the security bar) ----
console.log('\ntoken rejection');
{
  // An unverifiable bearer: refused either way, but under enforcement this is
  // the same code path that refuses a browser-session token (no iss/aud) and
  // another client's token (wrong aud).
  const r = await mcp('tools/call', { name: 'federation_identity', arguments: {} },
    { authorization: 'Bearer not.a.real.token' });
  r.status === 401 && /resource_metadata=/.test(r.wwwAuth || '')
    ? ok('an unverifiable bearer is refused, with a discovery pointer')
    : no('an unverifiable bearer is refused', `status ${r.status}`);
}
if (enforced) {
  ok('OAuth is ENFORCED — reads are closed and the transitional header is shut');
  // Prove the transitional door is actually shut rather than merely unadvertised.
  const r = await mcp('tools/call', { name: 'federation_identity', arguments: {} });
  r.status === 401
    ? ok('an unauthenticated call is challenged')
    : no('an unauthenticated call is challenged', `status ${r.status}`);
  if (process.env.CGF_CALLER_TOKEN) {
    const c = await mcp('tools/call', { name: 'channel_publish',
      arguments: { channel: CHANNEL, msgType: 'Status', payload: {} } },
      { 'x-caller-token': process.env.CGF_CALLER_TOKEN });
    c.status === 401
      ? ok('the retired caller token no longer authorises publishing')
      : no('the retired caller token no longer authorises publishing', `status ${c.status}`);
  }
} else {
  no('OAuth is enforced', 'CGF_OAUTH_REQUIRED is not true — reads are open and x-caller-token still publishes');
}

// ---- 4. publish, read back, dedupe ----
// Under enforcement only a scoped OAuth access token can publish. Obtaining one
// needs an interactive sign-in, so this section runs from a token supplied in the
// environment; otherwise it reports PENDING rather than failing, because "we did
// not exercise this" and "this is broken" must not look alike.
const caller = enforced ? null : process.env.CGF_CALLER_TOKEN;
const publishHeaders = accessToken ? { authorization: `Bearer ${accessToken}` }
                     : caller ? { 'x-caller-token': caller } : null;
if (!publishHeaders) {
  todo('publish / read-back / duplicate check',
    enforced ? 'OAuth is enforced — set CGF_ACCESS_TOKEN to a token with federation:publish'
             : 'set CGF_CALLER_TOKEN to run these');
} else {
  console.log('\npublish and verify');
  const marker = `e2e-${Date.now()}`;
  const r = await mcp('tools/call', { name: 'channel_publish', arguments: {
    channel: CHANNEL, msgType: 'Status', payload: { from: 'e2e', marker } } }, publishHeaders);
  const b = toolBody(r);
  b?.ok ? ok('published', b.eventId.slice(0, 16) + '…') : no('published', JSON.stringify(b));

  if (b?.ok) {
    b.pubkey === b.authenticatedAs && b.pubkey === PUBKEY
      ? ok('event pubkey equals the NIP-42 authenticated identity')
      : no('event pubkey equals the NIP-42 authenticated identity');

    // Independent read-back: a DIFFERENT key, our own connection, verified from
    // scratch. It must be a key the relay has admitted — relay.ruv.io is
    // membership-gated, so a freshly generated key fails NIP-42 and the read
    // returns nothing, which looks identical to "the event is not there".
    const keyPath = process.env.CGF_VERIFY_KEY || `${homedir()}/.ruflo/nostr-session-b.key`;
    let sk;
    try {
      sk = Uint8Array.from(Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex'));
    } catch {
      no('read back from the relay independently',
        `no admitted verifier key at ${keyPath} — set CGF_VERIFY_KEY to a key the relay has admitted`);
      sk = null;
    }
    const found = sk === null ? 'skip' : await new Promise((resolve) => {
      const ws = new WebSocket(RELAY, { perMessageDeflate: false });
      const done = (v) => { try { ws.close(); } catch {} resolve(v); };
      const timer = setTimeout(() => done(null), 20000);
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m[0] === 'AUTH') ws.send(JSON.stringify(['AUTH', finalizeEvent({ kind: 22242,
          created_at: Math.floor(Date.now() / 1000), tags: [['relay', RELAY], ['challenge', m[1]]], content: '' }, sk)]));
        else if (m[0] === 'OK' && m[2]) ws.send(JSON.stringify(['REQ', 'e2e', { ids: [b.eventId] }]));
        else if (m[0] === 'EVENT' && m[2]?.id === b.eventId) { clearTimeout(timer); done(m[2]); }
        else if (m[0] === 'EOSE') { clearTimeout(timer); done(null); }
      });
      ws.on('error', (e) => done({ error: String(e.message || e) }));
    });
    if (found === 'skip') { /* already reported */ }
    else if (!found || found.error) {
      no('read back from the relay independently',
        found?.error ? `relay: ${found.error}` : 'event not returned — is the verifier key admitted?');
    }
    else {
      ok('read back from the relay with an independent admitted key');
      getEventHash(found) === found.id ? ok('event id binds to its content') : no('event id binds to its content');
      verifyEvent(found) ? ok('signature verifies') : no('signature verifies');
      found.pubkey === PUBKEY ? ok('read-back pubkey is the connector') : no('read-back pubkey is the connector');
    }

    // Dedupe: the same marker must appear exactly once.
    const sync = toolBody(await mcp('tools/call', { name: 'channel_sync',
      arguments: { channel: CHANNEL, sinceSeconds: 600, limit: 200 } }, publishHeaders));
    const hits = (sync?.messages ?? []).filter((m) => m.marker === marker).length;
    hits === 1 ? ok('exactly one event carries this marker (no duplicates)')
               : no('exactly one event carries this marker', `found ${hits}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${pending} pending`);
process.exit(fail === 0 ? 0 : 1);
