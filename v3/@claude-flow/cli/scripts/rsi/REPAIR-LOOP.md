# Continuing repair engineering work

Decision: build a bounded executable improver for real repository work. The
current deliverable is a working admission and historical regression calibration
tool, not a repair optimizer or evidence of recursive improvement.

## First measured calibration

Reviewed implementation and plan were published at
`642ecff20e3641545bea0d5fa3d3806d6c0e7736`, tree
`cf6b51f3de741df78b17584cfd6ac88da3172cb1`, before recording this benchmark.
The historical fixes and unit-test results were already known; this is not a
preregistered efficacy experiment or a final confirmation reservation.

Frozen plan: `278b2fcdd4be671857eb28354eafcd37b3342a5b7188a14c72594ea0e437908f`.
Raw outcomes, transformed source hashes, process stdout/stderr and costs are in
[`evidence/repair-calibration.json`](evidence/repair-calibration.json).

| Witness | Original passes | Fixed passes |
| --- | ---: | ---: |
| Receipt fractions | 2/5 | 5/5 |
| Decimal statistics round trip | 2/3 | 3/3 |
| Unknown receipt fields | 2/4 | 4/4 |

All three defects reproduce; all fixed checks pass. This measures the calibration
tool's ability to distinguish known source revisions, not an agent repair rate.
Six subprocesses took 314.337 ms total wall time on this Node 24 host. Parent CPU
was 168649 microseconds; measured child import/check CPU was 125151 microseconds,
excluding child startup. External provider spend was $0; full acquisition and
evaluation dollar costs remain unknown. No latency superiority is claimed from
this single benchmark. Profiling does not justify optimizing this subsecond
calibration ahead of implementing the missing improvement procedure.

There were zero mission candidate evaluations and zero new native field calls.
The mission retains seven epochs, 209784 reserved calls and head
`5a0e219e871fcf616209807c828c5793c29752f8d190fc38a0bc95e4db88422e`.
The 35 existing focused tests and 13 new tests pass. All seven historical epochs
replay using their original source. Calibration unit tests and CI reruns are
additional engineering validation, excluded from the single benchmark above.

```bash
node v3/@claude-flow/cli/scripts/rsi/repair/run.mjs replay \
  v3/@claude-flow/cli/scripts/rsi/evidence/repair-readiness-plan.json \
  278b2fcdd4be671857eb28354eafcd37b3342a5b7188a14c72594ea0e437908f
```

Expected: `regressionWitnessesVerified: true`, `ledgerUnchanged: true`,
`candidateExecutionEnabled: false`, `boundedRsiEvidenceAccepted: false`.

## Implemented and reproducible

`repair/corpus.json` contains three actual RuFlo TypeScript defects, original
parent revisions and published fixes. Exact source bytes and their dependency
closure are preserved under `repair/snapshots`, addressed by original Git blob ID.
`repair/acquisition.json` preserves the observed GitHub commit/path/blob bindings
and fix parent metadata. This is an acquisition record, not an independent signed
attestation. GitHub supplied the bytes at acquisition; offline admission verifies their Git
blob and SHA256 hashes. It does not independently query whether a remote commit
contains a blob. The immutable source URLs permit external verification.

1. Issue 3229: receipt policy fractions were serialized as binary numbers.
2. Issue 3072: statistics computed before decimal encoding could fail replay.
3. Issue 3068: unknown receipt fields were accepted despite a closed schema.

These are known repairs in one receipt module and count as **one independent
cluster**. They are calibration fixtures with exposed fixes, not representative
repair accuracy measurements, newly discovered repairs, or sealed final tasks.
The baseline means the original broken source, not an agent trying to repair it.

The fixed witness includes valid input and content tampering guards. It invokes
the complete historical module, after Node's TypeScript stripping and one explicit
relative import suffix translation. Both original and executable hashes are
recorded. The same dependency bytes came from each source revision. No extraction
of only the changed function or model simulation substitutes for native code.

No evaluator keys are created. Unsigned receipt tests inspect structural errors
while explicitly excluding the expected unsigned error. They do not demonstrate
signed receipt acceptance or independent evaluation.

The runner permits six fixed witness processes, five seconds per process, a
128 MiB V8 old space limit and 64 KiB output limit. The V8 limit is not a total
RSS bound. Each child receives a minimal environment and Node file permissions.
This is containment for reviewed historical fixtures, **not an adversarial
sandbox for arbitrary candidate code**. No arbitrary command or candidate runner
is exposed. All temporary witness files are removed after execution.

Admission binds the actual existing mission, original anchor, complete ledger
fingerprint, counters, consumed tasks, trust, protocol, source, corpus, verifier
and witness bytes. It refuses source drift, changed plans, corrupt snapshots,
unsafe paths, duplicate tasks, inflated clusters and ambiguous locks. It reads
the ledger without adding events. Fixed regression validation is engineering
work, not a new HYPOTHESIS or mission candidate evaluation.

## Required implementation sequence

[MIGRATION-001.md](MIGRATION-001.md) records the implemented versioned projection
and reservation algebra, adversarial tests and a concrete resource authorization
proposal. Live application, durable version dispatch and candidate execution
remain disabled. Read that increment before repeating accounting design work.

1. **Accounting and source migration.** The v1 ledger only accepts retrieval
   policies and native BM25 calls. Design a versioned migration retaining its
   exact history, 209784 consumed native calls, 7 epochs, alpha, tasks, trust and
   gates. Repair executions cannot spend a relabeled native call budget. State
   any required additional resource dimensions and obtain the applicable
   approval before enabling them. Merely reviewing this adapter does not enable
   optimization. Preserve original source snapshots and test mixed-version replay,
   interrupted reservations and retained charges. Do not invent zero acquisition
   costs. The current adapter always reports execution disabled.
2. **Broader public development tasks.** [WORKLOADS-001.md](WORKLOADS-001.md)
   freezes the first three exact public base/fix lineages and fail-closed
   admission checks. Complete source archives, offline dependency closures,
   toolchains and hidden development tests remain missing, so candidate
   execution stays disabled. [WORKLOADS-002.md](WORKLOADS-002.md) mirrors all 23
   manifest-bound changed source, upstream test, license and package-manifest
   blobs with offline Git-object verification, while explicitly refusing to
   treat that partial capsule as a whole source tree or runnable environment.
   Continue to acquire independently specified real
   defects across repository and bug lineages. Record exclusions, fix exposure,
   source dependencies and costs. Freeze the sample before comparing methods.
   The three known witnesses may calibrate tooling but cannot become final data.
3. **Executable improver.** Implement inherited failure diagnosis, patch proposal
   and test selection. Freeze the base model, evaluator, permissions and resource
   envelope. Compare against frozen, static, shuffled and previous optimizers.
   Every measured child must execute without new researcher coaching. Include
   the outer Codex procedure if it is part of the claimed system, with the same
   cost scope and treatment for controls.
4. **Bounded development.** Only after migration admission, publish a reviewed
   source, record HYPOTHESIS, reserve work durably and run at most three epochs
   with at most twelve candidates per epoch. Preserve all failures. Optimize only
   measured bottlenecks; do not remove gates to improve latency or acceptance.
5. **Independent confirmation.** Separately controlled sealed workloads, two
   approved evaluator identities, full dollar costs and three descendant
   generations are still required. The original three families and 72-cell gate
   remain in force; a repair-only success cannot satisfy them. Publish and verify
   the frozen reservation before outcomes, consume final datasets once, preserve
   lifetime alpha, and obtain external replication before declaring success.

Each continuing run completes one useful bounded engineering increment in the
existing draft PR, updates Core Memory issue 85 and releases its Federation claim.
Avoid repeating an unchanged calibration or failed hypothesis. If useful work
is fully blocked, preserve state and report the exact missing input; never create
new counters or expand budgets. No autonomous merge, release or deployment.

## Local acceptance

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/repair.test.mjs
```

Expected: thirteen passing tests, three witnessed historical defects, fixed sources
passing, unchanged original mission bytes and candidate execution disabled.
Frozen calibration plans and measured raw output live beside the original
evidence, not in a replacement mission ledger. Timings include parent work and
subprocess wall time; child CPU measures import and checks, excluding startup.
Total acquisition and evaluation dollars remain unknown, despite no external
provider spend. Neither passing tests nor two copies of these results establish
RSI or independent efficacy.
