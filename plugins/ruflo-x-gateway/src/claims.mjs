// Owner-per-resource ledger reduced from claim events (oldest first).
export function reduceClaims(events) {
  const byRes = {};
  for (const e of [...events].sort((a, b) => a.created_at - b.created_at)) {
    const r = e.resourceId; if (!r) continue;
    if (e.type === 'ClaimIssued') { if (!byRes[r]) byRes[r] = { owner: e.pubkey, from: e.from, at: e.ts, ttlSeconds: e.ttlSeconds }; }
    else if (e.type === 'ClaimReleased') { if (byRes[r]?.owner === e.pubkey) delete byRes[r]; }
    else if (e.type === 'ClaimHandoff') { if (byRes[r]?.owner === e.pubkey && e.toNode) byRes[r].owner = e.toNode; }
  }
  return byRes;
}
