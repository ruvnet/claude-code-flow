/**
 * Direct-to-relay publisher.
 *
 * buzz-relay refuses any EVENT whose pubkey differs from the NIP-42 authenticated
 * identity on that connection. So a "gateway relays your signed event" design is
 * impossible by construction, and this service exists to do the only thing that
 * works: authenticate as itself, then publish as itself, on one socket it owns.
 */
import WebSocket from 'ws';
import { verifyEvent, getEventHash } from 'nostr-tools/pure';
import { redact } from './signing-key.mjs';

export const SWARM_TAG = 'ruflo-swarm';
export const SWARM_KIND = 1;
export const AUTH_KIND = 22242;
export const MAX_PAYLOAD_BYTES = 32 * 1024;
// Public channels only. Publishing into `prv:` needs a NIP-44 channel key, and this
// service is deliberately not a channel-key holder — it can carry ciphertext no more
// than the gateway can. Reading a private channel stays possible; it just stays opaque.
export const PUBLIC_CHANNEL_RE = /^pub:[a-z0-9][a-z0-9._-]{0,63}$/;
const MSGTYPE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Tags for a swarm channel event. Must stay byte-identical to the gateway's
 * channelTags() (ADR-386) or these events publish fine and are then invisible to
 * every reader — `c`, not `h`: the relay reserves `h` for NIP-29 groups and answers
 * a #h-filtered REQ with "restricted: not a channel member".
 */
export function channelTags(channelId, msgType) {
  if (!PUBLIC_CHANNEL_RE.test(String(channelId))) throw new Error('channel must match pub:<name>');
  if (!MSGTYPE_RE.test(String(msgType))) throw new Error('msgType must match [A-Za-z][A-Za-z0-9_-]{0,63}');
  return [['t', SWARM_TAG], ['c', String(channelId)], ['k', String(msgType)]];
}

/** Connect and complete NIP-42. Resolves the authenticated socket. */
export function connectAuthed(relayUrl, signer, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl, { perMessageDeflate: false });
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; fn(arg); };
    const timer = setTimeout(() => { try { ws.close(); } catch {} done(reject, new Error('auth timeout')); }, timeoutMs);
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m[0] === 'AUTH' && typeof m[1] === 'string') {
        // The relay verifies the `relay` tag strictly, so it must carry the URL we dialled.
        const ev = signer.sign({ kind: AUTH_KIND, created_at: Math.floor(Date.now() / 1000),
          tags: [['relay', relayUrl], ['challenge', m[1]]], content: '' });
        ws.send(JSON.stringify(['AUTH', ev]));
      } else if (m[0] === 'OK') {
        clearTimeout(timer);
        if (m[2]) done(resolve, ws);
        else { try { ws.close(); } catch {} done(reject, new Error(redact(m[3] || 'auth rejected'))); }
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); done(reject, new Error(redact(e.message))); });
    ws.on('close', () => { clearTimeout(timer); done(reject, new Error('closed before auth')); });
  });
}

/**
 * Sign locally, then publish over the same authenticated socket.
 *
 * Returns the evidence the acceptance test asks for: the event id, the pubkey that
 * signed it, and the identity that authenticated the connection — which are the same
 * value here by construction, and are reported separately so a caller can check rather
 * than trust that.
 */
export async function publishToChannel(relayUrl, signer, { channel, msgType, payload }) {
  const tags = channelTags(channel, msgType);
  const content = JSON.stringify({ type: msgType, ts: new Date().toISOString(), ...(payload ?? {}) });
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_PAYLOAD_BYTES) throw new Error(`payload too large (${bytes} > ${MAX_PAYLOAD_BYTES} bytes)`);

  const ws = await connectAuthed(relayUrl, signer);
  const ev = signer.sign({ kind: SWARM_KIND, created_at: Math.floor(Date.now() / 1000), tags, content });

  // Self-check before it leaves: verifyEvent() alone does NOT bind the id to the
  // content, so a tampered body verifies true unless the hash is recomputed first.
  if (getEventHash(ev) !== ev.id) { try { ws.close(); } catch {} throw new Error('event id does not match its content'); }
  if (!verifyEvent(ev)) { try { ws.close(); } catch {} throw new Error('event failed signature verification'); }
  if (ev.pubkey !== signer.pubkey) { try { ws.close(); } catch {} throw new Error('event pubkey is not the connection identity'); }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('publish timeout')); }, 15000);
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m[0] === 'OK' && m[1] === ev.id) {
        clearTimeout(timer); try { ws.close(); } catch {}
        if (!m[2]) return reject(new Error(redact(m[3] || 'publish rejected')));
        resolve({ eventId: ev.id, pubkey: ev.pubkey, authenticatedAs: signer.pubkey,
          channel, msgType, relay: relayUrl, verified: true });
      }
    });
    ws.send(JSON.stringify(['EVENT', ev]));
  });
}

/** Read a channel's recent events over our own authenticated connection. */
export async function readChannel(relayUrl, signer, { channel, sinceSeconds = 3600, limit = 100 } = {}) {
  const ws = await connectAuthed(relayUrl, signer);
  const filter = { kinds: [SWARM_KIND], '#t': [SWARM_TAG],
    since: Math.floor(Date.now() / 1000) - sinceSeconds, limit };
  if (channel) filter['#c'] = [String(channel)];
  const out = [];
  return new Promise((resolve) => {
    const finish = () => { try { ws.close(); } catch {} resolve(out); };
    const timer = setTimeout(finish, 12000);
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m[0] === 'EVENT' && m[2] && getEventHash(m[2]) === m[2].id && verifyEvent(m[2])) {
        const e = m[2];
        const rec = { id: e.id, pubkey: e.pubkey, created_at: e.created_at,
          channel: e.tags.find((t) => t[0] === 'c')?.[1], k: e.tags.find((t) => t[0] === 'k')?.[1] };
        // A private channel's body stays ciphertext: we hold no channel key.
        if (rec.k === 'enc') out.push({ ...rec, encrypted: true });
        else { let body; try { body = JSON.parse(e.content); } catch { body = { raw: e.content }; } out.push({ ...rec, ...body }); }
      } else if (m[0] === 'EOSE') { clearTimeout(timer); finish(); }
    });
    ws.send(JSON.stringify(['REQ', 'cgf-read', filter]));
  });
}
