# ADR RSI 002: durable research loop with separate confirmation authority

Status: implemented as opt-in research, not production integration.

## Problem

An instruction to iterate until RSI is achieved creates pressure to reuse tests,
select favorable runs, ignore rejected work or equate signed receipts with truth.
The prior unchanged learner failed all 36 registered generalization comparisons.
A repeatable engineering process must retain that evidence and remain capable of
reporting that no improvement was found.

## Decision

Implement a local append-only mission ledger, bounded native retrieval adapter,
development proposal-credit loop and separate evaluator-attestation gate under
`v3/@claude-flow/cli/scripts/rsi/loop`. Keep the original experiments unchanged.

The state machine is INIT, RESERVE, COMPLETE or INTERRUPTED, with explicit
HYPOTHESIS transitions on source changes. RESERVE precedes native evaluation;
every field call is metered. A new hypothesis retains the lifetime work and alpha
ledger. Three unsuccessful development epochs stop redundant execution. The
recurring Codex executor can implement the next hypothesis rather than silently
resetting the experiment or broadening limits.

Final evaluation is distinct: PROOF_RESERVED precedes PROOF_RESULT. Two approved
evaluator keys sign raw results over separate final task populations. The gate
recomputes all 72 practical-superiority comparisons. It never consumes candidate
success flags. Independence, real-task provenance and cost accounting remain
explicit trusted evaluator attestations, not properties created by signatures.

## Alternatives

An unlimited while-success-is-false loop loses cost control and invites optional
stopping. A MetaHarness promotion count is a different milestone and cannot
substitute for generalization or improvement-capacity evidence. Reusing the native
retrieval engine avoids a new numeric simulator and incurs no provider spend.
The public query pilot is a development fixture only; its saturated initial result
means harder workloads are needed, not that RSI has been evaluated successfully.

## Ownership and validation

One Codex writer owns the worktree. RuFlo Federation tracks the resource and Core
Memory tracks the mission. Git commits preserve the ledger head and source versions.
Local locks do not claim distributed authority. Only a separately authorized
release workflow may merge or deploy; this implementation has no such path.

Acceptance coverage is in `loop/loop.test.mjs`: native execution, deterministic
score replay, death before/after publication, retained reservations, ledger tamper,
parent/epoch/source binding, canonical evaluator identities, lifetime alpha,
complete raw evidence and rejection of forged results. The original 18 experiment
tests remain required. Full operating details and remaining limits are in
`scripts/rsi/LOOP.md`.
