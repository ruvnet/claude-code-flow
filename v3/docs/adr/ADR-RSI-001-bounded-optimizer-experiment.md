# ADR-RSI-001: Isolated bounded recursive optimizer experiment

Status: Implemented as a research experiment; efficacy gate NULL; no production integration.
Date: 2026-09-12
Mission: rsi-ruflo-20260912
Base inspected: b02c0cacec225deea01f586b66a9694393369432

## Specification

Outcome: measure whether learning an optimizer's search allocation yields more
fresh-task improvement for the same logical work than fixed search. Business value
is falsifying ineffective automation before spending tokens or deploying it.
Actors: operator starts an offline run; immutable evaluator scores candidates;
reviewer replays evidence. Inputs: bounded numeric configuration and seeded tasks.
Outputs: all attempt histories, optimizer ancestry, paired controls, signed bundle,
null-aware verdict and test evidence. Synthetic inputs are not live efficacy.

Constraints: no runtime dependencies, external actions, model spend, production
imports, evaluation mutation, automated merge or promotion. Failure and rollback
are first-class outcomes. Unknown settings and excessive budgets fail closed.

## Pseudocode

For every seed: generate disjoint inner and outer tasks; commit their digest.
For each arm: search inner episodes; record all attempts; update only bounded
optimizer weights; chain before/after state and history hashes.
Freeze all optimizers. Search fresh outer episodes with learning disabled.
Compare seed-level gains against frozen and corrupted-credit controls. Reset to
root and replay the frozen arm. Sign the whole result. Independent replay verifies
the pinned signer, source hash, then recomputes all fields rather than trusting logs.

Success trace: valid bounded config -> trained genome -> sealed outer scores ->
both gates pass -> SYNTHETIC_GAIN, still no production action.
Failure trace: invalid budget -> error before scoring; adverse outer result -> NULL;
forged but signed scores -> replay mismatch. A valid null remains replayable.

## Architecture decision

Use a standalone Node experiment beside existing CLI scripts. Mutating the current
production generation function would risk serving a champion and change existing
behavior. Adding paid model-driven code mutation would introduce infrastructure,
credential and evaluator-integrity requirements before establishing a useful signal.
The isolated experiment is reversible and costs zero model calls, but does not
establish production retrieval performance or general RSI.

The trusted boundary is this fixed local source and the operator-reviewed public
key. The numeric genome cannot supply code or tools. Hashes bind exact source and
lineage; signatures do not attest that synthetic tasks represent reality. No new
promotion authority is introduced. ADR-322 and ADR-381 remain unchanged.

## Refinement and evidence trace

| Requirement | Executable evidence |
|---|---|
| Bounded strict inputs | config/genome rejection tests, hard eval and history caps |
| Actual optimizer update | learning/control tests and persisted before/after genomes |
| Equal logical work | all-arm cost equality, failed-history retention tests |
| No outer feedback | varying outer sample size leaves trained histories identical |
| Paired controls | exact sign-test unit cases and per-seed raw deltas |
| Evidence integrity | signature, signer substitution, forged signed score and ancestry tests |
| Reproducibility | deterministic whole-experiment equality and full replay |
| Rollback | reset optimizer reproduces frozen outer results |
| No accidental file overwrite | CLI exclusive-output integration test |
| Honest limitations | SYNTHETIC marker, liveRsiProven=false and no production gate |

Command: `node --test v3/@claude-flow/cli/scripts/rsi/experiment.test.mjs`.
CI runs that command and replays the committed default evidence, with no package
installation or secrets. Current empirical result: NULL, 16/16 seed losses to
both controls. The machine-readable bundle is authoritative for exact figures.

## Completion and residual risk

Prototype completion is not RSI efficacy. No production regression is possible
through this code path because it is not imported into the daemon. Repository-wide
tests are separate from this focused experiment and are not implied by its passing
tests. Statistical assumptions, synthetic domain bias, logical versus physical
costs and public task secrecy limits are documented in the experiment README.

Owner of the next decision: operator/reviewer. Keep this learner disabled. Any
follow-up must use a prospectively frozen credit rule and fresh outer tasks rather
than tuning against this result. Real efficacy, multi-generation generalization and
production rollout are explicitly uncompleted research/deployment gates.
