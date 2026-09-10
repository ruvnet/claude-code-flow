/**
 * Self-service join for the open swarm federation — the user-facing invite path.
 *
 * Decentralized by design: the user generates/holds THEIR OWN Nostr key locally,
 * redeems an invite code with a NIP-98-signed claim (no admin in the loop), proves
 * membership with NIP-42, and announces themselves. The gateway never signs for them.
 *
 * `nostr-tools` is an optional dependency (secp256k1/Schnorr is not in node:crypto):
 * when absent the tool degrades with an install hint instead of throwing at load.
 */
import type { MCPTool } from './types.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// ADR-125 precedence: tool args (relayHttp / relayWs / keyFile) take precedence over the
// RUFLO_X_RELAY_HTTP / RUFLO_X_RELAY_WS / RUFLO_NOSTR_KEY_FILE env vars, which precede defaults.
const HTTP_BASE = (o?: string) => (o || process.env.RUFLO_X_RELAY_HTTP || 'https://relay.ruv.io').replace(/\/$/, '');
const RELAY_WS = (o?: string) => o || process.env.RUFLO_X_RELAY_WS || 'wss://relay.ruv.io';
const KEY_FILE = () => process.env.RUFLO_NOSTR_KEY_FILE || join(homedir(), '.ruflo', 'nostr.key');
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

type NostrTools = { generateSecretKey: () => Uint8Array; getPublicKey: (sk: Uint8Array) => string; finalizeEvent: (t: Record<string, unknown>, sk: Uint8Array) => Record<string, unknown> & { id: string } };
async function loadNostrTools(): Promise<NostrTools | null> {
  try { return (await import('nostr-tools/pure')) as unknown as NostrTools; } catch { return null; }
}
export function loadOrCreateKey(nt: NostrTools, file = KEY_FILE()): { sk: Uint8Array; pubkey: string; created: boolean } {
  if (existsSync(file)) { const sk = unhex(readFileSync(file, 'utf8').trim()); return { sk, pubkey: nt.getPublicKey(sk), created: false }; }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const sk = nt.generateSecretKey(); writeFileSync(file, hex(sk), { mode: 0o600 });
  return { sk, pubkey: nt.getPublicKey(sk), created: true };
}
export function nip98Header(nt: NostrTools, sk: Uint8Array, url: string, method: string, body?: string): string {
  const ev = nt.finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000),
    tags: [['u', url], ['method', method], ...(body ? [['payload', createHash('sha256').update(body).digest('hex')]] : [])], content: '' }, sk);
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
}
// NIP-42: connect, answer the challenge, resolve true/false (never throws on refusal).
export async function verifyMembership(nt: NostrTools, sk: Uint8Array, relayWs: string): Promise<{ ok: boolean; reason?: string }> {
  const { default: WebSocket } = await import('ws');
  return new Promise((resolve) => {
    const ws = new WebSocket(relayWs, { perMessageDeflate: false }); let done = false;
    const fin = (r: { ok: boolean; reason?: string }) => { if (done) return; done = true; try { ws.close(); } catch { /* */ } resolve(r); };
    ws.on('message', (d: Buffer) => { const m = JSON.parse(d.toString());
      if (m[0] === 'AUTH' && typeof m[1] === 'string') ws.send(JSON.stringify(['AUTH', nt.finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000), tags: [['relay', relayWs], ['challenge', m[1]]], content: '' }, sk)]));
      else if (m[0] === 'OK') fin({ ok: !!m[2], reason: m[3] }); });
    ws.on('error', (e: Error) => fin({ ok: false, reason: e.message }));
    setTimeout(() => fin({ ok: false, reason: 'timeout' }), 15000);
  });
}

export const xFederationJoinTools: MCPTool[] = [{
  name: 'x_federation_join',
  description:
    'Join the open swarm federation with YOUR OWN key using an invite code: generates (or reuses) a local Nostr key at ~/.ruflo/nostr.key (0600), redeems the code with a NIP-98-signed claim directly against the relay, proves membership via NIP-42, and returns your pubkey. Use when you have been handed an invite code and want to participate as yourself. Asking an admin to `federation_admit` you instead is wrong for an open swarm because it centralizes onboarding and requires trusting a pubkey out of band; the invite claim binds membership to the key you hold. Never share the invite code publicly — it is a bearer secret.',
  inputSchema: { type: 'object', properties: {
    code: { type: 'string', description: 'Invite code (v2.…) received privately from a member/admin.' },
    relayHttp: { type: 'string', description: 'Relay HTTPS base for the claim; takes precedence over RUFLO_X_RELAY_HTTP.' },
    relayWs: { type: 'string', description: 'Relay wss URL for NIP-42; takes precedence over RUFLO_X_RELAY_WS.' },
    keyFile: { type: 'string', description: 'Key file path; takes precedence over RUFLO_NOSTR_KEY_FILE (default ~/.ruflo/nostr.key).' } }, required: ['code'] },
  handler: async (input) => {
    const i = input as { code: string; relayHttp?: string; relayWs?: string; keyFile?: string };
    const nt = await loadNostrTools();
    // Validate input before the optional-dependency check so a bad code fails fast and identically
    // whether or not nostr-tools is present.
    if (!/^v2\.[A-Za-z0-9._-]{8,}$/.test(i.code)) throw new Error('invite code must look like v2.<token>');
    if (!nt) return { degraded: true, reason: 'nostr-tools not installed', hint: 'npm i -g nostr-tools  (secp256k1 signing is not in node:crypto)' };
    const { sk, pubkey, created } = loadOrCreateKey(nt, i.keyFile);
    const url = `${HTTP_BASE(i.relayHttp)}/api/invites/claim`; const body = JSON.stringify({ code: i.code });
    const r = await fetch(url, { method: 'POST', headers: { Authorization: nip98Header(nt, sk, url, 'POST', body), 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(20_000) });
    const claim = (await r.json().catch(() => ({}))) as { role?: string; error?: string; message?: string };
    if (!r.ok) throw new Error(`claim rejected (${r.status}): ${claim.error ?? claim.message ?? 'unknown'}`);
    const auth = await verifyMembership(nt, sk, RELAY_WS(i.relayWs));
    return { ok: auth.ok, pubkey, keyCreated: created, role: claim.role ?? 'member', membershipVerified: auth.ok, ...(auth.ok ? {} : { reason: auth.reason }),
      next: 'Publish kind-1 events tagged ["t","ruflo-swarm"] — or run `ruflo federation sync` to read the swarm.' };
  },
}];
