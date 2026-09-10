/**
 * ADR-386 — public and private swarm channels, client side.
 *
 * Channel keys live HERE, never on the gateway. A private channel is a 32-byte
 * key you generate; messages are NIP-44 v2 ciphertext under it, and the channel
 * id (`prv:<16 hex>`) is derived from the key so the name never reaches the wire.
 * You grant access by sealing the key to a member's pubkey (ECDH), which only
 * they can open. The gateway relays ciphertext and cannot decrypt it.
 *
 * `nostr-tools` is an optional dependency; every tool degrades with an install
 * hint rather than throwing at load.
 */
import type { MCPTool } from './types.js';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadOrCreateKey } from './x-federation-join.js';

// ADR-125 precedence: tool args > env var > default.
const RELAY_WS = (o?: string) => o || process.env.RUFLO_X_RELAY_WS || 'wss://relay.ruv.io';
const KEY_FILE = () => process.env.RUFLO_NOSTR_KEY_FILE || join(homedir(), '.ruflo', 'nostr.key');
const STORE_FILE = () => process.env.RUFLO_CHANNELS_FILE || join(homedir(), '.ruflo', 'channels.json');

export const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const CHANNEL_ID_RE = /^(pub:[a-z0-9][a-z0-9._-]{0,63}|prv:[0-9a-f]{16})$/;

type Nt = {
  generateSecretKey: () => Uint8Array; getPublicKey: (sk: Uint8Array) => string;
  finalizeEvent: (t: Record<string, unknown>, sk: Uint8Array) => Record<string, unknown> & { id: string };
};
type Nip44 = { v2: { encrypt: (p: string, k: Uint8Array) => string; decrypt: (c: string, k: Uint8Array) => string; utils: { getConversationKey: (sk: Uint8Array, pk: string) => Uint8Array } } };
async function loadTools(): Promise<{ nt: Nt; nip44: Nip44 } | null> {
  try {
    const nt = (await import('nostr-tools/pure')) as unknown as Nt;
    const { nip44 } = (await import('nostr-tools')) as unknown as { nip44: Nip44 };
    return { nt, nip44 };
  } catch { return null; }
}
const degraded = () => ({ degraded: true, reason: 'nostr-tools not installed', hint: 'npm i nostr-tools  (secp256k1 + NIP-44 are not in node:crypto)' });

/** Locally cached channel keys, 0600. Losing this file loses the channels in it — by design. */
export type ChannelStore = Record<string, { key: string; name?: string; grantedBy?: string; at: string }>;
export function readStore(file = STORE_FILE()): ChannelStore {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')) as ChannelStore; } catch { return {}; }
}
export function writeStore(store: ChannelStore, file = STORE_FILE()): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });
}
export function publicChannelId(name: string): string {
  if (!CHANNEL_NAME_RE.test(String(name))) throw new Error('channel name must match [a-z0-9][a-z0-9._-]{0,63}');
  return `pub:${name}`;
}
export function privateChannelId(keyHex: string): string {
  const k = Buffer.from(keyHex, 'hex');
  if (k.length !== 32) throw new Error('channel key must be 32 bytes (64 hex)');
  return `prv:${createHash('sha256').update(k).digest('hex').slice(0, 16)}`;
}
export function newChannelKey(): string { return randomBytes(32).toString('hex'); }
export function isPrivateChannel(id: string): boolean { return String(id).startsWith('prv:'); }

async function relayCall<T>(relayWs: string, sk: Uint8Array, nt: Nt, fn: (ws: WsLike) => Promise<T>): Promise<T> {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(relayWs, { perMessageDeflate: false }) as unknown as WsLike;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('relay auth timeout')), 15000);
    ws.on('message', (d: Buffer) => {
      const m = JSON.parse(d.toString());
      if (m[0] === 'AUTH' && typeof m[1] === 'string') {
        ws.send(JSON.stringify(['AUTH', nt.finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000), tags: [['relay', relayWs], ['challenge', m[1]]], content: '' }, sk)]));
      } else if (m[0] === 'OK') { clearTimeout(t); m[2] ? resolve() : reject(new Error(`relay refused auth: ${m[3] || 'not a member'}`)); }
    });
    ws.on('error', (e: Error) => { clearTimeout(t); reject(e); });
  });
  try { return await fn(ws); } finally { try { ws.close(); } catch { /* */ } }
}
type WsLike = { on: (e: string, cb: (d: never) => void) => void; send: (s: string) => void; close: () => void; removeAllListeners: () => void };

function publishEvent(ws: WsLike, nt: Nt, sk: Uint8Array, tags: string[][], content: string): Promise<string> {
  const ev = nt.finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags, content }, sk);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('publish timeout')), 15000);
    ws.on('message', (d: Buffer) => { const m = JSON.parse(d.toString());
      if (m[0] === 'OK' && m[1] === ev.id) { clearTimeout(t); m[2] ? resolve(ev.id) : reject(new Error(m[3] || 'publish rejected')); } });
    ws.send(JSON.stringify(['EVENT', ev]));
  });
}
function reqEvents(ws: WsLike, filter: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(out), 12000);
    ws.on('message', (d: Buffer) => { const m = JSON.parse(d.toString());
      if (m[0] === 'EVENT') out.push(m[2]);
      else if (m[0] === 'EOSE') { clearTimeout(t); resolve(out); } });
    ws.send(JSON.stringify(['REQ', 'ruflo-ch', filter]));
  });
}

export const xFederationChannelTools: MCPTool[] = [
  {
    name: 'x_federation_channel_create',
    description: 'Create a swarm channel. visibility=public gives a named stream every relay member can read (pub:<name>). visibility=private generates a 32-byte key HERE, stores it at ~/.ruflo/channels.json (0600), and returns an opaque id (prv:<hex>) that leaks neither the name nor the topic. Use when a stream of work should be separated from the shared firehose, or kept unreadable by the relay and the gateway. Creating a private channel and then expecting the gateway to read it is wrong: the gateway holds no channel key and cannot decrypt (ADR-386). Losing the key file loses the channel.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', description: 'Channel name, [a-z0-9][a-z0-9._-]{0,63}. For a private channel this is a local label only — it never reaches the relay.' },
      visibility: { type: 'string', enum: ['public', 'private'], description: 'public = plaintext, readable by all members. private = NIP-44 encrypted under a key only you hold.' },
    }, required: ['name', 'visibility'] },
    handler: async (input) => {
      const { name, visibility } = input as { name: string; visibility: 'public' | 'private' };
      if (visibility === 'public') return { channel: publicChannelId(name), visibility, note: 'Any relay member can read this channel.' };
      const key = newChannelKey(); const channel = privateChannelId(key);
      const store = readStore(); store[channel] = { key, name, at: new Date().toISOString() }; writeStore(store);
      return { channel, visibility, name, keyStoredAt: STORE_FILE(),
        note: 'The key never leaves this machine. Grant others with x_federation_channel_grant. There is no recovery if the key file is lost, and no revocation — removing someone means rotating to a new channel.' };
    },
  },
  {
    name: 'x_federation_channel_grant',
    description: "Grant a member access to a private channel by sealing its key to their pubkey with NIP-44 (ECDH), published as a ChannelGrant event only they can open. Use when adding a participant to an existing private channel. Publishing the raw key into a channel or a chat is wrong: it is a bearer secret, and anyone who sees it can read every past and future message, because there is no revocation.",
    inputSchema: { type: 'object', properties: {
      channel: { type: 'string', description: 'Private channel id (prv:<16 hex>) you hold the key for.' },
      pubkey: { type: 'string', description: "The member's 64-hex Nostr pubkey." },
      relayWs: { type: 'string', description: 'Relay URL; takes precedence over RUFLO_X_RELAY_WS (default wss://relay.ruv.io).' },
    }, required: ['channel', 'pubkey'] },
    handler: async (input) => {
      const i = input as { channel: string; pubkey: string; relayWs?: string };
      if (!isPrivateChannel(i.channel)) throw new Error('only private channels have keys to grant');
      if (!/^[0-9a-f]{64}$/i.test(i.pubkey)) throw new Error('pubkey must be 64 hex');
      const t = await loadTools(); if (!t) return degraded();
      const entry = readStore()[i.channel];
      if (!entry) throw new Error(`no key held for ${i.channel} — create it or accept a grant first`);
      const { sk, pubkey } = loadOrCreateKey(t.nt as never, KEY_FILE());
      const conv = t.nip44.v2.utils.getConversationKey(sk, i.pubkey);
      const sealed = t.nip44.v2.encrypt(entry.key, conv);
      const relay = RELAY_WS(i.relayWs);
      const eventId = await relayCall(relay, sk, t.nt, (ws) => publishEvent(ws, t.nt, sk,
        [['t', 'ruflo-swarm'], ['k', 'ChannelGrant'], ['c', i.channel], ['p', i.pubkey]],
        JSON.stringify({ type: 'ChannelGrant', channel: i.channel, sealed, ts: new Date().toISOString() })));
      return { ok: true, channel: i.channel, grantedTo: i.pubkey, grantedBy: pubkey, eventId,
        note: 'Only that pubkey can open the seal. Grants are not revocable — rotate the channel to remove someone.' };
    },
  },
  {
    name: 'x_federation_channel_accept',
    description: 'Accept private-channel grants addressed to your key: finds ChannelGrant events tagged to your pubkey, opens each with your own secret key, and caches the channel keys locally. Use when someone tells you they granted you a channel. Asking them to send you the key directly is wrong because it exposes a bearer secret in a channel you do not control.',
    inputSchema: { type: 'object', properties: {
      sinceSeconds: { type: 'number', description: 'Look-back window (default 7 days).' },
      relayWs: { type: 'string', description: 'Relay URL; takes precedence over RUFLO_X_RELAY_WS.' },
    }, required: [] },
    handler: async (input) => {
      const i = input as { sinceSeconds?: number; relayWs?: string };
      const t = await loadTools(); if (!t) return degraded();
      const { sk, pubkey } = loadOrCreateKey(t.nt as never, KEY_FILE());
      const relay = RELAY_WS(i.relayWs);
      const evs = await relayCall(relay, sk, t.nt, (ws) => reqEvents(ws, {
        kinds: [1], '#t': ['ruflo-swarm'], '#k': ['ChannelGrant'], '#p': [pubkey],
        since: Math.floor(Date.now() / 1000) - (i.sinceSeconds ?? 7 * 86400), limit: 200,
      }));
      const store = readStore(); const accepted: string[] = []; const failed: string[] = [];
      for (const e of evs) {
        const ev = e as { pubkey: string; content: string };
        let body: { channel?: string; sealed?: string };
        try { body = JSON.parse(ev.content) as typeof body; } catch { continue; }
        if (!body.channel || !body.sealed) continue;
        try {
          const conv = t.nip44.v2.utils.getConversationKey(sk, ev.pubkey);
          const key = t.nip44.v2.decrypt(body.sealed, conv);
          if (!/^[0-9a-f]{64}$/.test(key) || privateChannelId(key) !== body.channel) { failed.push(body.channel); continue; }
          store[body.channel] = { key, grantedBy: ev.pubkey, at: new Date().toISOString() };
          accepted.push(body.channel);
        } catch { failed.push(body.channel); }
      }
      if (accepted.length) writeStore(store);
      return { pubkey, accepted: [...new Set(accepted)], unopenable: [...new Set(failed)], keyStoredAt: STORE_FILE() };
    },
  },
  {
    name: 'x_federation_channel_publish',
    description: 'Publish a message to a channel with YOUR OWN key. A private channel is encrypted locally under its channel key before it leaves this machine, and the message type is hidden behind k=enc so the relay sees only an opaque id and ciphertext. Use when the message should be attributable to you. The admin-gated gateway channel_publish is wrong for that, because it signs as the gateway and cannot reach private channels at all.',
    inputSchema: { type: 'object', properties: {
      channel: { type: 'string', description: 'Channel id (pub:<name> or prv:<16 hex>).' },
      msgType: { type: 'string', description: 'Message type (Status, Task, Result, …). Hidden on private channels.' },
      payload: { type: 'object', description: 'JSON body. Never put secrets or credentials in it, even on a private channel.' },
      relayWs: { type: 'string', description: 'Relay URL; takes precedence over RUFLO_X_RELAY_WS.' },
    }, required: ['channel', 'msgType', 'payload'] },
    handler: async (input) => {
      const i = input as { channel: string; msgType: string; payload: Record<string, unknown>; relayWs?: string };
      if (!CHANNEL_ID_RE.test(i.channel)) throw new Error('channel must be pub:<name> or prv:<16 hex>');
      const t = await loadTools(); if (!t) return degraded();
      const { sk, pubkey } = loadOrCreateKey(t.nt as never, KEY_FILE());
      const priv = isPrivateChannel(i.channel);
      const body = { type: i.msgType, from: pubkey, ts: new Date().toISOString(), ...i.payload };
      let content: string;
      if (priv) {
        const entry = readStore()[i.channel];
        if (!entry) throw new Error(`no key held for ${i.channel} — accept a grant first (x_federation_channel_accept)`);
        content = t.nip44.v2.encrypt(JSON.stringify(body), Uint8Array.from(Buffer.from(entry.key, 'hex')));
      } else { content = JSON.stringify(body); }
      const tags = [['t', 'ruflo-swarm'], ['c', i.channel], ['k', priv ? 'enc' : i.msgType]];
      const eventId = await relayCall(RELAY_WS(i.relayWs), sk, t.nt, (ws) => publishEvent(ws, t.nt, sk, tags, content));
      return { ok: true, channel: i.channel, visibility: priv ? 'private' : 'public', encrypted: priv, eventId, pubkey };
    },
  },
  {
    name: 'x_federation_channel_read',
    description: 'Read a channel and decrypt what your keys can open. Public messages come back as JSON; private ones are decrypted locally with the cached channel key, and anything you have no key for is returned as encrypted:true rather than silently dropped. Use when the channel is private: reading it through the gateway channel_sync tool is wrong there, because the gateway holds no key and can only hand you ciphertext.',
    inputSchema: { type: 'object', properties: {
      channel: { type: 'string', description: 'Channel id (pub:<name> or prv:<16 hex>).' },
      sinceSeconds: { type: 'number', description: 'Look-back window (default 3600).' },
      limit: { type: 'number', description: 'Max messages (default 100).' },
      relayWs: { type: 'string', description: 'Relay URL; takes precedence over RUFLO_X_RELAY_WS.' },
    }, required: ['channel'] },
    handler: async (input) => {
      const i = input as { channel: string; sinceSeconds?: number; limit?: number; relayWs?: string };
      if (!CHANNEL_ID_RE.test(i.channel)) throw new Error('channel must be pub:<name> or prv:<16 hex>');
      const t = await loadTools(); if (!t) return degraded();
      const { sk } = loadOrCreateKey(t.nt as never, KEY_FILE());
      const evs = await relayCall(RELAY_WS(i.relayWs), sk, t.nt, (ws) => reqEvents(ws, {
        kinds: [1], '#t': ['ruflo-swarm'], '#c': [i.channel],
        since: Math.floor(Date.now() / 1000) - (i.sinceSeconds ?? 3600), limit: i.limit ?? 100,
      }));
      const entry = readStore()[i.channel];
      const key = entry ? Uint8Array.from(Buffer.from(entry.key, 'hex')) : null;
      const messages = evs.map((e) => {
        const ev = e as { id: string; pubkey: string; created_at: number; content: string; tags: string[][] };
        const k = ev.tags.find((x) => x[0] === 'k')?.[1];
        const base = { id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at };
        if (k !== 'enc') { try { return { ...base, ...(JSON.parse(ev.content) as object) }; } catch { return { ...base, raw: ev.content }; } }
        if (!key) return { ...base, encrypted: true, reason: 'no channel key held' };
        try { return { ...base, ...(JSON.parse(t.nip44.v2.decrypt(ev.content, key)) as object) }; }
        catch { return { ...base, encrypted: true, reason: 'held key does not open this message' }; }
      });
      return { channel: i.channel, visibility: isPrivateChannel(i.channel) ? 'private' : 'public', count: messages.length, messages };
    },
  },
  {
    name: 'x_federation_channel_list',
    description: 'List the private channels this machine holds keys for, plus their local labels. Use when you want to know what you can actually read before calling channel_read. The gateway channel_list is the wrong tool for that: it reports channels seen on the relay, including ones whose contents you cannot open.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const store = readStore();
      return { keyStoredAt: STORE_FILE(), channels: Object.entries(store).map(([channel, v]) => ({ channel, name: v.name, grantedBy: v.grantedBy, at: v.at })) };
    },
  },
];
