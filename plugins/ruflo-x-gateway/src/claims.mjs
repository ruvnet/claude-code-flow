// Owner-per-resource ledger reduced from claim events (oldest first).
//
// A claim with ttlSeconds expires at created_at + ttlSeconds. An expired claim is not an
// owner: it is dropped from the ledger, and a later ClaimIssued for the same resource wins.
// Expiry is evaluated against the later event's own timestamp while reducing (so history
// replays deterministically) and against `now` for the final ledger (so a resource whose
// owner disconnected without releasing frees itself once the lease runs out).
const expiresAt = (c) => (c.ttlSeconds > 0 ? c.issuedAt + c.ttlSeconds : Infinity);
export function reduceClaims(events, now = Math.floor(Date.now() / 1000)) {
  // A null prototype, deliberately. `resourceId` is a string a third party
  // chose, and on a plain object an id like `__proto__`, `constructor` or
  // `toString` is answered by Object.prototype rather than by this ledger: the
  // `!byRes[r]` guard below sees a truthy inherited value and the claim is
  // never recorded. The claim is signed and accepted by the relay, and simply
  // absent from the board — so two workers both read the resource as unowned,
  // which is the one outcome this ledger exists to prevent. Assigning
  // `__proto__` on a plain object would also mutate the prototype rather than
  // add an entry. Both problems disappear when nothing is inherited.
  const byRes = Object.create(null);
  for (const e of [...events].sort((a, b) => a.created_at - b.created_at)) {
    const r = e.resourceId; if (!r) continue;
    const cur = byRes[r];
    if (cur && expiresAt(cur) <= e.created_at) delete byRes[r];
    if (e.type === 'ClaimIssued') {
      if (!byRes[r]) byRes[r] = { owner: e.pubkey, from: e.from, at: e.ts, ttlSeconds: e.ttlSeconds, issuedAt: e.created_at };
    } else if (e.type === 'ClaimReleased') { if (byRes[r]?.owner === e.pubkey) delete byRes[r]; }
    else if (e.type === 'ClaimHandoff') { if (byRes[r]?.owner === e.pubkey && e.toNode) byRes[r].owner = e.toNode; }
  }
  for (const [r, c] of Object.entries(byRes)) {
    if (expiresAt(c) <= now) delete byRes[r];
    else { c.expiresAt = Number.isFinite(expiresAt(c)) ? new Date(expiresAt(c) * 1000).toISOString() : null; delete c.issuedAt; }
  }
  // Spread back to an ordinary object so the returned shape is unchanged for
  // callers and tests. Object spread defines OWN properties, so a `__proto__`
  // entry survives as data here rather than being re-interpreted as a prototype
  // assignment — the fix holds through serialisation.
  return { ...byRes };
}
