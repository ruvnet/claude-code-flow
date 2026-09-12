# Durable migration journal and immutable source dispatch

Date: 2026-09-12. Decision: accept this as a reviewable engineering increment.
The frozen migration is still not applied, repair candidate execution remains
disabled, and this is not evidence of RSI.

## Implemented boundary

`repair/journal-v2.mjs` creates an append-only v2 projection journal in a new
directory after revalidating frozen proposal
`0662eec69224f1c4e1ea9e06be03863f72dc409136d2210285a879d09ee87203`
against the original v1 ledger. Genesis embeds the exact frozen proposal and full
projected legacy state. Replay rejects a self-consistent forged mission, changed
charge, altered policy, rewritten history, reset proof state, modified gate or a
different proposal anchor.

The journal preserves the original 209784 reserved native field calls, seven
shared epochs, lifetime alpha state, failed attempts, source snapshots, consumed
tasks, trust registry and proof gates. Its only post-genesis data events record
verified historical source dispatch or writer recovery. Generic append is private.
There is no resource reservation, migration application, candidate execution,
proof acceptance, merge, release or deployment event.

The source registry maps epochs 1 through 7 exactly once to three immutable Git
trees. Dispatch validates the tree object, recomputes the exact five-file source
closure, verifies the matching reservation source hashes and checks the anchored
ledger prefix ends at the correct epoch boundary. The third tree newly freezes
epochs 5 through 7, so journal replay does not depend on future working-tree files
or edits to the original replay registry. Historical public commit pages were
fetched through GitHub. The old commit objects are absent in this local checkout,
so local receipts report that fact rather than claiming the commit aliases were
verified locally. Exact content trees remain available and all native epochs replay.

## Crash and adversarial coverage

Nineteen tests cover atomic publication before and after rename, exact frozen
genesis recovery, a valid single published child, retained pending bytes, dead and
live owners, ambiguous published-plus-pending refusal, recovery-lock exclusion,
writer-lock retention across quarantine and recovery audit, closed schemas,
proposal rehash attacks, source adapter substitution, swapped trees, wrong ledger
anchors, duplicate source events and permanent refusal of migration application.

A read-only reviewer found and reproduced proposal-binding and recovery races.
Each finding was fixed and regression tested. The final review found no remaining
critical or high-severity issue in this increment. This is implementation review,
not independent task evaluation.

The full focused suite now contains 79 tests: 18 prospective experiment and
generalization tests plus 61 native-loop, repair, migration and journal tests.
All passed locally with Node 24. Native source-specific replay passed for all seven
epochs, preserving the original anchor and the unchanged negative outcomes.

Five isolated executions of the 19 journal tests measured 2228.832, 2341.851,
2135.327, 2087.616 and 2040.372 milliseconds, 10833.997 milliseconds total.
External provider spend was $0. Full acquisition and evaluation dollar costs are
still unknown. These timings include immutable source lookup and crash fixtures;
they exclude research, code generation, review, the full suite, native epoch replay
and CI. No mission epoch, native field call or repair candidate was added.

MetaHarness and Autogenous were not run for this accounting increment because
they would project the same local invariants without adding a new measured task or
independent trust boundary. Z3 or Lean would be appropriate for a future explicit
formal property only if it catches failures beyond these finite reducer tests; a
solver result would not establish empirical generalization.

## Remaining authorization and evidence gap

The next implementation increment is a reviewed isolated repair executor and a
versioned resource-event extension. Candidate execution still requires explicit
operator approval of the proposed batch envelope: at most 36 candidate evaluations,
216 isolated process starts and 1080000 summed process wall milliseconds across at
most three remaining shared mission epochs. All failures and control work must fit
inside that same envelope. Native calls remain a separate literal unit, provider
spend remains zero, and a Federation claim is not resource authorization.

The largest scientific uncertainty remains whether an inherited improver can make
descendants better at producing further improvements on unseen repository tasks.
This journal reduces evidence-corruption risk but measures no descendant efficacy.
Confirmation still needs frozen real workloads, three task families, three
generations, four controls, two approved independent evaluator identities, full
dollar costs, raw cluster-paired results and external replication under unchanged
alpha and proof gates.

Reviewed source commit:
`e03f10700fcb873fb9628e55aa3cf7dc15aaa0a8`, tree
`e9fc7aed4aa8789cbc1d9f867a0da27ffedb002c`. Raw benchmark measurements are in
`evidence/migration-journal-check.json`.

## Acceptance

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/journal-v2.test.mjs
```

Expected: 19 passes, including frozen-proposal rehash rejection and crash recovery,
with migration and candidate execution still disabled.

```bash
node v3/@claude-flow/cli/scripts/rsi/loop/replay-history.mjs \
  v3/@claude-flow/cli/scripts/rsi/evidence/loop-development \
  5a0e219e871fcf616209807c828c5793c29752f8d190fc38a0bc95e4db88422e
```

Expected: `verified: true`, original anchor retained, seven epochs, 209784 reserved
native calls and `boundedRsiEvidenceAccepted: false`.
