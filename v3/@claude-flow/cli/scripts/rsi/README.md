# Bounded RSI experiment

An opt-in, dependency-free research harness for testing whether a learned optimizer
becomes better at finding improvements under a fixed logical work budget. It does
not modify model weights, execute generated code, call tools, or change production
policies. It is an experiment, not a demonstrated real-world RSI system.

## Result: NULL

The default 16-seed experiment found **no improvement**. On the predeclared equal
mixture of stationary and shifted outer tasks, adaptive search lost to the frozen
optimizer on **16/16 seeds**, with mean score-gain delta **-0.007259307422**.
It also lost to the credit-shuffled control on 16/16 seeds, delta
**-0.011139723822**. Do not promote this learner.

| Mean fresh-episode gain | Adaptive | Frozen | Credit shuffled |
|---|---:|---:|---:|
| Stationary | 0.023633114518 | 0.043162656148 | 0.046573438710 |
| Shifted | 0.043986262760 | 0.038975335972 | 0.043325386211 |
| Constant-score null | 0 | 0 | 0 |

All figures are **SYNTHETIC**, not benchmark scores, accuracy, or model capability.
The null and rollback controls pass. Each arm receives 2,448 objective evaluations
per seed, including training. Total is 137,088 evaluations including separate
rollback audits. No model tokens or API spend. Wall time is machine dependent;
local execution was below one second, not a latency guarantee.

## Run and verify

The [continuing research loop](LOOP.md) adds durable reservations, native RuFlo
retrieval experiments, plateau detection and an independent confirmation contract.
Its first 36 candidate evaluations found no improvement because the development
baseline already scored MRR 1.0. That pilot validates mechanics, not RSI efficacy.

The prospective [generalization experiment](GENERALIZATION.md) retains this
learner unchanged and tests four training-excluded families at three checkpoints.
Public source registration preceded its first official run. **0/36 gates passed**
across 399,024 objective evaluations. All twelve adaptive-versus-frozen mean
deltas are negative. The signed result replays exactly; real RSI remains unproven.

From the repository root, with Node 22 or later; no install or build is required:

```bash
node --test v3/@claude-flow/cli/scripts/rsi/experiment.test.mjs
node v3/@claude-flow/cli/scripts/rsi/run.mjs run --out /tmp/my-rsi-bundle.json
node v3/@claude-flow/cli/scripts/rsi/run.mjs replay \
  --bundle v3/@claude-flow/cli/scripts/rsi/evidence/default.json \
  --public-key v3/@claude-flow/cli/scripts/rsi/evidence/public.pem
```

The output path must not exist. A run prints a newly generated public key. Pin it
through a separately trusted channel before using it to verify a new bundle.
The committed public key is reviewable alongside the evidence. An embedded or
self-signed key establishes consistency, not independent author identity or truth.
Replay verifies the signature, pins the experiment source hash, and recomputes
**the complete experiment**, including histories, costs, controls, and verdict.
Changing the source invalidates old bundles; replay them at their original commit.

`run --config FILE` accepts only the six keys in `DEFAULT_CONFIG`. Limits include
one million total objective evaluations (including rollback) and 100,000 stored
history rows. Inputs and output sizes are capped. No resume, append, hidden seed
selection, free-text genome, plugins, credentials, or production actions exist.

## What is recursive here?

The inner search improves an application point. A separate bounded eight-weight
optimizer genome learns from all inner attempts, including failed mutations.
That changed optimizer controls which coordinates subsequent searches explore.
After all training generations, the optimizer is frozen and tested on entirely
fresh optimization episodes starting from the same application point. This tests
optimizer utility, not merely the fitness of its final application configuration.

It is a minimal experimental counterpart to
[`axisEffectiveness` and `biasedGrid`](../../src/services/harness-flywheel-generations.ts).
It deliberately does **not** import that module: its production generation entry
point can serve prior champions, and its search size differs across generations.
No claim is made that this standalone experiment measures the existing production
retrieval implementation. An actual retrieval adapter remains future work.

## Protocol and interpretation

1. Predeclare configuration, immutable scoring, thresholds and a 50/50 stationary
   versus shifted primary endpoint before observing outer results.
2. Start all arms from equal application state and equal optimizer weights, using
   the same tasks and indexed random numbers. Frozen means optimizer-frozen,
   **not** application-frozen.
3. Train each optimizer for six generations of twelve episodes with sixteen
   mutations each. Credit uses mean raw attempt delta; failures are retained.
   The shuffled control rotates credit across axes before applying an update;
   it does not rotate prior optimizer state or merely reorder history.
4. Freeze every trained optimizer before any outer search. Outer targets and
   importance weights are available only to the internal evaluator. Split IDs
   include seed, phase and family. A digest commits to all task contents.
5. Run 24 fresh episodes per family and arm. Candidate and history-processing
   schedules are fixed. The constant-score family diagnoses fabricated gains.
6. Compare paired seed-level deltas using an exact one-sided sign test, p <= .025
   per control, plus a practical mean delta >= .01. These two tests bound their
   familywise false-positive rate by .05 under the sign-test null assumptions.
   The sign test concerns win prevalence, **not** a confidence bound on the mean.
   Seeded synthetic tasks are an engineering fixture, not a random population sample.
7. A passing run is only `SYNTHETIC_GAIN`; a failed gate is `NULL`, including
   harmful learners. Neither verdict authorizes deployment. Report family results
   separately: the aggregate can conceal transfer regressions.
8. Reset the optimizer to root and reproduce frozen-arm outer results exactly.
   This is an in-memory optimizer rollback test, not a production rollback test.

## Boundaries and remaining work

Logical work slots cover objective calls, proposal axis visits, history rows and
genome slots. This is **not equal CPU time or dollars**. Frozen and shuffled arms
also perform bookkeeping whose result may be discarded. Rollback audit work is
separately reported and included in the total hard cap. Hostile evaluator code is
not accepted; JavaScript process isolation is not claimed. Replays rerun this
trusted, fixed source, not arbitrary bundle-provided code.

The task generator is purpose-built, low dimensional and known to the author.
These tasks are split from optimizer feedback, not secret from the experiment
author. Genomes contain numeric weights only; they cannot change evaluators,
budgets, gates, capabilities or outer targets. Entire experiment reruns are not
covered by an across-experiment alpha ledger, so selecting the best seed/run
after observing results invalidates the nominal inference.

The initial development run already showed a null against frozen search. Review
then corrected the shuffled control (credit rotation instead of genome rotation)
and budget/output validation. The adaptive learner, seed set, endpoint and gate
were not tuned after observing that null. The corrected run remains null. A
plausible failure mechanism is negative raw deltas discouraging exploration of
high-impact coordinates; this is a hypothesis, not a validated fix.

After the failed transfer test, a new experiment would need to predeclare a different credit estimator and new untouched task
seeds; retain this negative baseline. Before any real RSI claim, add actual RuFlo
retrieval tasks with externally frozen relevance labels, cost measurement, sealed
evaluation controlled by another party, and optimizer-efficiency evidence over
multiple generations. Production integration requires a separately reviewed
ADR-322 promotion gate; do not wire this learner into the daemon.

See [ADR-RSI-001](../../../../docs/adr/ADR-RSI-001-bounded-optimizer-experiment.md).

## MetaHarness and Autogenous cross checks

`crosscheck.mjs` first replays the original RSI evidence, then executes the actual
`@metaharness/flywheel@0.1.11` library and the Autogenous TypeScript mesh at commit
`7bf327a9754ce798364dbee8b2825af42a421fd4`. The pinned versions are intentional;
the script rejects a different package version or dirty/different Autogenous HEAD.
Package version checking is not a cryptographic npm package integrity check.

Recorded in [`evidence/crosscheck.json`](evidence/crosscheck.json):

| Component | Executed result | What it establishes |
|---|---|---|
| MetaHarness | 0 improvements; all 8 replay checks pass | Its default gate rejects the recorded adverse optimizer result |
| Autogenous mesh | 4 promotions; separation 0.6875 -> 1.25 | Bounded parameter evolution on its native fixed fixture |
| Autogenous witness | Signed chain verifies; tamper rejected | Integrity of this generated trajectory |
| Autogenous four-part gate | Unauthorized and irreversible attempts rejected | Gate conjunction behavior, not production authorization |
| Autogenous Rust envelope | Not executed: Cargo unavailable | No native Rust verifier claim |

The MetaHarness adapter projects recorded fresh-episode gains to `primary`, the
fraction of zero-gain episodes to `noopRate`, and total arm evaluations per
successful episode to `costPerWin`. It performs one candidate evaluation, not a
new search over the observed holdout. These are synthetic proxy metrics, not
agent completion or monetary cost. Its rejection reasons are `primary_regressed`,
`noop_rate_not_improved`, and `cost_per_win_worsened`.

Autogenous runs its existing seed-42, 30-generation, population-4 fixture twice
and confirms equal final champions. The 81.8% separation improvement is on the
same fixed fitness fixture used for selection, not unseen tasks. No independent
optimizer baseline or improvement-efficiency test exists in that fixture. Its
RVF-style JSON witness must not be called native RVF execution when
`ledger.rvfAvailable` is false. Neither cross check changes the RSI verdict.

To reproduce, install the pinned MetaHarness library in a separate scratch
prefix, check out the pinned Autogenous revision, and install its locked
`packages/radio-moe` dependencies with `npm ci --ignore-scripts`. Run:

```bash
node --import /ABS/autogenous/packages/radio-moe/node_modules/tsx/dist/loader.mjs \
  v3/@claude-flow/cli/scripts/rsi/crosscheck.mjs \
  /ABS/toolchain/node_modules/@metaharness/flywheel \
  /ABS/autogenous /tmp/new-rsi-crosscheck.json
```

The optional cross check is not included in dependency-free CI. It accepts only
operator-selected local package paths; those packages execute as trusted code,
not as sandboxed candidates. No keys or tokens are read, and no experts or network
transports are launched. Per-run signatures vary; numeric outcomes are deterministic.
