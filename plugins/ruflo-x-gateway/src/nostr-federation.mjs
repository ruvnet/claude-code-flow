// Nostr federation bridge for the ruflo swarm.
// Transport: a membership-gated Nostr relay (buzz-relay). Every coordination
// message is a signed Nostr event, so authorship is cryptographically verifiable
// and participation is open to anyone the relay admits as a member.
import WebSocket from 'ws';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SWARM_TAG = 'ruflo-swarm';           // discoverable hashtag
export const SWARM_KIND = 1;                        // text-note kind, tagged for the swarm
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

export function loadIdentity(keyFile) {
  mkdirSync(dirname(keyFile), { recursive: true });
  let sk;
  if (existsSync(keyFile)) sk = unhex(readFileSync(keyFile, 'utf8').trim());
  else { sk = generateSecretKey(); writeFileSync(keyFile, hex(sk), { mode: 0o600 }); }
  return { sk, pubkey: getPublicKey(sk) };
}

// Connect + NIP-42 authenticate. Resolves the open socket, or rejects with the
// relay's reason (e.g. "restricted: not a relay member").
export function connectAuthed(relayUrl, sk, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl, { perMessageDeflate: false });
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; fn(arg); };
    const timer = setTimeout(() => { try { ws.close(); } catch {} done(reject, new Error('auth timeout')); }, timeoutMs);
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m[0] === 'AUTH' && typeof m[1] === 'string') {
        const ev = finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000),
          tags: [['relay', relayUrl], ['challenge', m[1]]], content: '' }, sk);
        ws.send(JSON.stringify(['AUTH', ev]));
      } else if (m[0] === 'OK') {
        clearTimeout(timer);
        if (m[2]) done(resolve, ws);
        else { try { ws.close(); } catch {} done(reject, new Error(m[3] || 'auth rejected')); }
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); done(reject, e); });
    ws.on('close', () => { clearTimeout(timer); done(reject, new Error('closed before auth')); });
  });
}

// Publish a signed coordination message. Resolves the event id on relay OK.
export async function publish(relayUrl, sk, msgType, payload) {
  const ws = await connectAuthed(relayUrl, sk);
  const ev = finalizeEvent({ kind: SWARM_KIND, created_at: Math.floor(Date.now() / 1000),
    tags: [['t', SWARM_TAG], ['k', String(msgType)]],
    content: JSON.stringify({ type: msgType, ts: new Date().toISOString(), ...payload }) }, sk);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('publish timeout')); }, 15000);
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m[0] === 'OK' && m[1] === ev.id) { clearTimeout(timer); try { ws.close(); } catch {}
        m[2] ? resolve(ev.id) : reject(new Error(m[3] || 'publish rejected')); }
    });
    ws.send(JSON.stringify(['EVENT', ev]));
  });
}

// Fetch recent swarm coordination messages (verified). Optional type filter.
export async function fetchRecent(relayUrl, sk, { sinceSeconds = 3600, limit = 100, type } = {}) {
  const ws = await connectAuthed(relayUrl, sk);
  const filter = { kinds: [SWARM_KIND], '#t': [SWARM_TAG], since: Math.floor(Date.now() / 1000) - sinceSeconds, limit };
  if (type) filter['#k'] = [String(type)];
  const out = [];
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(out); }, 12000);
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m[0] === 'EVENT' && verifyEvent(m[2])) {
        let body; try { body = JSON.parse(m[2].content); } catch { body = { raw: m[2].content }; }
        out.push({ id: m[2].id, pubkey: m[2].pubkey, created_at: m[2].created_at, ...body });
      } else if (m[0] === 'EOSE') { clearTimeout(timer); try { ws.close(); } catch {} resolve(out); }
    });
    ws.send(JSON.stringify(['REQ', 'ruflo-sync', filter]));
  });
}
