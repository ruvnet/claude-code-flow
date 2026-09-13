# Versioned accounting migration projection

Date: 2026-09-12. Decision: publish a tested, read-only migration projection and
resource reservation algebra. **No migration has been applied and no repair
optimization is enabled.** This is an implementation increment, not an RSI result.

## Implemented

`repair/migration.mjs` constructs a v2 projection from the actual anchored v1
ledger. It retains the entire reduced legacy state, including reservations,
interrupted attempts, snapshots, source identities, champion, credits, plateau
history, hypotheses, proof attempts, consumed data/tasks, confirmation and trust.
It checks that reservation charges sum to the original native-call total.

Resources have distinct typed dimensions. Native field calls retain their literal
meaning, 209784 consumed units and 1000000 lifetime ceiling. Shared epochs retain
7 consumed and 64 lifetime. The original 100000 calls and 12 candidates per epoch
remain unchanged. Repair candidate evaluations, isolated process starts and
process wall milliseconds each have **zero authorized ceiling**. Unknown historic
acquisition/evaluation dollars are null, not zero. There is no conversion rate.

The proposal binds the complete legacy state hash, ledger byte fingerprint,
original anchor, original rules, source history and the new checker's dependency
closure. The calibration readiness hash transitively binds its corpus and exact
Git blobs. Verification recomputes the proposal from the live anchored ledger,
so changing a policy, charge, source, threshold or trust entry and merely rehashing
the proposal does not bypass the checks.

The pure reservation functions validate every resource dimension, reject excess
or unreserved work, prevent overlapping reservations and retain the full reserved
charge after either completion or interruption. They are testable algebra for a
future durable reducer, **not a durable journal or an authorization service**.
`applyMigration` refuses every request, including supplied approval flags.

The tests append a 19-call RESERVE to a disposable copy of the existing ledger,
verify the full charge while pending, append INTERRUPTED and retain the charge.
Another fixture reserves 80 units and completes after using 7; the 80 remain
charged and a 21-unit retry against a 100-unit ceiling is rejected. None of these
test units is an actual native call or a new live mission reservation.

## Scope and evidence

Twelve new tests cover state retention, rehashed tampering, nonzero proof history,
interruption, ambiguous locks, stranded publication files, typed resources,
zero authorization, actual usage limits and repeatable read-only verification.
The current total is 60 focused tests, including the 48 prior tests.
Original v1 reducer and source files are unchanged; no HYPOTHESIS or migration
event was appended. All seven historical epochs replay under their original
source trees. GitHub commit metadata was checked again for the two archived
commit/tree pairs; local remote commit aliases are absent but their preserved
trees remain available and executable. This is reproducibility, not independent
efficacy. No MetaHarness or Autogenous projection was added because the same
accounting checks would not supply an additional task outcome or trust boundary.

## Concrete authorization proposal, not an enabled budget

For an initial future repair development pilot, request at most three of the
remaining shared mission epochs, twelve candidate evaluations per epoch, six
isolated process starts per candidate and five seconds per process. This bounds
the whole proposed batch at 36 candidate evaluations, 216 process starts and
1080000 summed process wall milliseconds (18 minutes), including rejected
candidates and control work. Root audits or extra processes must fit inside the
same envelope; they are not free. These requested new resource dimensions are
not granted by this document, a Federation claim or a rehashed proposal.

Native call accounting stays separate and unchanged. External provider spend
remains disabled. No paid model calls or credential discovery is requested.
Host acquisition and evaluation dollar attribution must be implemented before
confirmation. A larger corpus may not fit this small proposed pilot, which is
an admission failure rather than grounds for automatic budget expansion.

Before any repair candidate executes, the operator must approve a concrete repair
resource envelope and the implementation must pass review of durable versioned
event application, shared epoch accounting, source dispatch, exact checkpoint
and policy identity, safe isolated execution and interrupted reservation retention.
The fixed Node permission wrapper used for historical calibration is not an
adversarial candidate sandbox. None of these gates is implied by projection
verification. The next engineering increment can implement and test the durable
versioned reducer without enabling live repair resources.

Independent confirmation additionally retains all original requirements: three
families, three descendant generations, four controls, two approved independent
evaluators, sealed workloads, complete costs and lifetime alpha. No gate has been
relaxed, no key generated, and no evidence accepted.

## Acceptance

Reviewed source was published as `bdfd4fe5479eb6efa5c25b67d55ac153967d2506`
with tree `688b098a1707a849ffa6f22b70bbc72d32c55577`. The frozen proposal hash
is `0662eec69224f1c4e1ea9e06be03863f72dc409136d2210285a879d09ee87203`.
Five verifications measured 40.799, 25.160, 31.483, 25.800 and 22.884 ms,
146.699 ms total including the final ledger fingerprint. Measured CPU was
168444 microseconds. External provider spend was $0; full dollar costs remain
unknown. This is overhead measurement, not an optimization speedup or a mission
candidate benchmark. All five runs returned projection verified, migration not
applied, execution disabled and an unchanged ledger. No new epoch or native call
was charged. Source acquisition, code generation, other tests and CI are excluded.

```bash
node v3/@claude-flow/cli/scripts/rsi/repair/migration.mjs verify \
  v3/@claude-flow/cli/scripts/rsi/evidence/migration-proposal.json \
  0662eec69224f1c4e1ea9e06be03863f72dc409136d2210285a879d09ee87203
```

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/migration.test.mjs
```

Expected: twelve tests pass, original ledger bytes unchanged, new repair ceilings
zero, `projectionVerified: true`, `migrationApplied: false` and
`candidateExecutionEnabled: false`. The frozen proposal and measured verifier
costs are published under `evidence/migration-proposal.json` and
`evidence/migration-check.json`. Neither artifact is a new mission ledger.
