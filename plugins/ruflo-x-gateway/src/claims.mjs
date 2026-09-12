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
    // `resourceId` arrives from spread JSON, so it is not necessarily a string:
    // an array ["repo/x"] keys as 'repo/x' and squats that resource, and any
    // object collapses to '[object Object]'. Coercion is the vulnerability, so
    // refuse rather than coerce.
    const r = e.resourceId;
    if (typeof r !== 'string' || !r) continue;
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
  // Returned with the null prototype intact. Spreading back to an ordinary
  // object restores exactly the hazard this fixes on the READ side: `board.toString`
  // becomes a truthy function, so a consumer asking "is this free?" with the same
  // `!board[r]` idiom used above is told an unowned resource is owned; and
  // `Object.assign({}, board)` or an `Object.entries` copy silently drops a
  // `__proto__` claim. Callers serialise this (JSON.stringify and structuredClone
  // both preserve the entries), so nothing needs the prototype.
  return byRes;
}
