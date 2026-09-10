/**
 * ADR-386 — public and private swarm channels.
 *
 * A channel is one extra tag on an ordinary swarm event: ['c', channelId].
 * NOT ['h', …]: buzz-relay reserves `h` for NIP-29-style groups and refuses a REQ
 * filtered on #h with "restricted: not a channel member", so an h-tagged event can
 * be published but never read back. `c` is indexed and unrestricted.
 *   public   channelId = `pub:<name>`      content = plaintext JSON, k = msgType
 *   private  channelId = `prv:<16 hex>`    content = NIP-44 v2 ciphertext,  k = 'enc'
 *
 * Private-channel keys are generated and held by CLIENTS. The gateway seals
 * nothing on anyone's behalf and stores no channel key: it filters by `h` and
 * relays ciphertext. See ADR-386 "the gateway is not a custodian".
 */
import { createHash, randomBytes } from 'node:crypto';
import { nip44 } from 'nostr-tools';

export const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const CHANNEL_ID_RE = /^(pub:[a-z0-9][a-z0-9._-]{0,63}|prv:[0-9a-f]{16})$/;
export const ENC_TYPE = 'enc';

/** Public channel id for a human-readable name. */
export function publicChannelId(name) {
  if (!CHANNEL_NAME_RE.test(String(name))) throw new Error('channel name must match [a-z0-9][a-z0-9._-]{0,63}');
  return `pub:${name}`;
}

/** Opaque private channel id derived from the key, so the name never reaches the wire. */
export function privateChannelId(channelKey) {
  const k = toKey(channelKey);
  return `prv:${createHash('sha256').update(k).digest('hex').slice(0, 16)}`;
}

/** A fresh 32-byte channel key (hex). Generated client-side, never by the gateway. */
export function newChannelKey() { return randomBytes(32).toString('hex'); }

function toKey(k) {
  const b = typeof k === 'string' ? Buffer.from(k, 'hex') : Buffer.from(k);
  if (b.length !== 32) throw new Error('channel key must be 32 bytes (64 hex)');
  return b;
}

/** Encrypt a message body under the channel key (NIP-44 v2). */
export function sealMessage(channelKey, body) {
  return nip44.v2.encrypt(JSON.stringify(body), toKey(channelKey));
}

/** Decrypt a channel message. Returns null when this key cannot open it. */
export function openMessage(channelKey, ciphertext) {
  try { return JSON.parse(nip44.v2.decrypt(ciphertext, toKey(channelKey))); } catch { return null; }
}

/**
 * Seal a channel key to one member: NIP-44 under the ECDH conversation key
 * between the granter's secret key and the member's pubkey. Only that member opens it.
 */
export function sealChannelKey(granterSk, memberPubkey, channelKey) {
  if (!/^[0-9a-f]{64}$/i.test(String(memberPubkey))) throw new Error('member pubkey must be 64 hex');
  const conv = nip44.v2.utils.getConversationKey(granterSk, memberPubkey);
  return nip44.v2.encrypt(toKey(channelKey).toString('hex'), conv);
}

/** Open a sealed channel key with the member's own secret key. Returns hex, or null. */
export function openChannelKey(memberSk, granterPubkey, sealed) {
  try {
    const conv = nip44.v2.utils.getConversationKey(memberSk, granterPubkey);
    const hex = nip44.v2.decrypt(sealed, conv);
    return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
  } catch { return null; }
}

/** Tags for a channel event. Private channels hide the message type behind k=enc. */
export function channelTags(channelId, msgType, isPrivate) {
  if (!CHANNEL_ID_RE.test(String(channelId))) throw new Error('bad channel id');
  return [['t', 'ruflo-swarm'], ['c', String(channelId)], ['k', isPrivate ? ENC_TYPE : String(msgType)]];
}

export function isPrivateChannel(channelId) { return String(channelId).startsWith('prv:'); }

/**
 * Well-known public channels, declared rather than discovered.
 *
 * `channel_list` reports what has been *published to* recently, which is the
 * right default for finding activity and the wrong one for onboarding: a channel
 * nobody has posted in today does not exist as far as a newcomer can tell, so
 * every new member starts in the flat firehose and the channels stay empty. That
 * is a discovery problem, not a usage problem.
 *
 * Declaring a small set fixes it. Keep it small on purpose — a directory of
 * plausible-sounding empty rooms is worse than no directory, because it spends a
 * newcomer's attention on guessing which ones are alive.
 */
export const DEFAULT_CHANNELS = [
  { channel: 'pub:announce', purpose: 'Releases, breaking changes and service status. Read-mostly; publish here when others need to act.' },
  { channel: 'pub:help', purpose: 'Questions from anyone joining or stuck. No question is too basic for this channel.' },
  { channel: 'pub:claims', purpose: 'Cross-host work claims, so ownership has one home instead of the shared stream.' },
  { channel: 'pub:showcase', purpose: 'What you built on the federation, and what it cost you to find out.' },
];

/** True for a channel id this service recognises; filters malformed tag values out of listings. */
export function isWellFormedChannel(id) {
  return CHANNEL_ID_RE.test(String(id ?? ''));
}
