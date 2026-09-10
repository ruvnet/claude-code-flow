import { finalizeEvent } from 'nostr-tools/pure';
import { createHash } from 'node:crypto';
import { connectAuthed } from './nostr-federation.mjs';
function nip98(sk, url, method, body) {
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000),
    tags: [['u', url], ['method', method], ...(body ? [['payload', createHash('sha256').update(body).digest('hex')]] : [])], content: '' }, sk);
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
}
// Mint a v2 invite (caller must be relay admin/owner). Returns {code, expires_at, max_uses}.
export async function mintInvite(httpBase, sk, { ttlSecs = 7 * 86400, maxUses = 25 } = {}) {
  const url = `${httpBase}/api/invites`, body = JSON.stringify({ ttl_secs: ttlSecs, max_uses: maxUses });
  const r = await fetch(url, { method: 'POST', headers: { Authorization: nip98(sk, url, 'POST', body), 'Content-Type': 'application/json' }, body });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || j.message || `mint failed ${r.status}`); return j;
}
// Admit a pubkey as member via NIP-43 kind 9030 (caller must be admin/owner).
export async function admitMember(relayUrl, sk, pubkey, role = 'member') {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) throw new Error('pubkey must be 64 hex');
  if (!['member', 'admin'].includes(role)) throw new Error('role must be member|admin');
  const ws = await connectAuthed(relayUrl, sk);
  const ev = finalizeEvent({ kind: 9030, created_at: Math.floor(Date.now() / 1000), tags: [['p', pubkey], ['role', role]], content: '' }, sk);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('admit timeout')); }, 15000);
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m[0] === 'OK' && m[1] === ev.id) { clearTimeout(t); try { ws.close(); } catch {} m[2] ? resolve({ pubkey, role }) : reject(new Error(m[3] || 'admit rejected')); } });
    ws.send(JSON.stringify(['EVENT', ev]));
  });
}
