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

## Required implementation sequence (operator update, 2026-09-13)

Advance the next executable comparison. At the start of each increment name the
execution blocker it removes or experimental uncertainty it resolves. At acceptance
demonstrate that change; test counts and additional manifests alone do not qualify.
Stop redundant infrastructure work. If no authorized useful work remains, preserve
state, report the exact missing input and pause the existing task. Do not create a
replacement task or ledger. The resource proposal below remains unapproved.

1. **Finish p-limit end to end.** Use the already frozen compact source, exact
   offline dependency and Node 24.19.0 witness. Finish the isolated executor and
   reproduce the historical failure and known fix in a clean environment without
   network access. A single runnable workload is a development milestone. Defer
   broader RuVector acquisition until it contributes to this comparison.
2. **Implement the smallest inherited improver.** Descendants inherit diagnosis
   rules, patch-selection logic and test-selection state. A child must produce
   and evaluate successors without additional researcher coaching. First proposed
   hypothesis: inherited training-only failure-analysis state selects more productive
   repair attempts on fresh development tasks at equal cost. This is a proposed
   hypothesis, not an admitted HYPOTHESIS event or permission to execute trials.
3. **Measure improvement capacity.** Freeze implementation, model, evaluator,
   permissions and task samples before comparing inherited state against frozen,
   static, shuffled and previous-optimizer controls. Include matched acquisition,
   execution and outer Codex treatment. Measure successor productivity on fresh
   tasks, distinguishing inheritance from a Codex-written proposer improvement.
   Exposed known fixes cannot be relabeled as fresh or sealed tasks.
4. **Derive publication and costs from validated evidence.** Generate report and
   Federation identities from the same checked artifact and verify public readback.
   Include failures, interruptions, acquisition, model use, process starts and time;
   distinguish spawn attempts from observed starts and unmeasured descendants.
   Unknown costs remain explicitly unknown and block confirmation.
5. **Run bounded development, then independent confirmation.** Complete reviewed
   migration and resource authorization, bind reviewed source in HYPOTHESIS and
   reserve durably before at most three development epochs, twelve candidates each.
   Preserve all failures and lifetime native units. Confirmation still requires
   three families, three generations, four controls, two approved evaluators, sealed
   fresh workloads, complete dollar costs and the unchanged 72-cell/alpha protocol.
   Independently accepted and externally replicated bounded evidence is required
   before declaring success. Z3/Lean may check explicit correctness invariants;
   they cannot establish empirical generalization.

Research grounding, verified 2026-09-13: [Hyperagents v1, submitted 2026-03-19](https://arxiv.org/abs/2603.19461v1)
distinguishes the task agent from an editable mechanism that modifies agents.
Its meta-level transfer findings are author-reported, not reproduced here.
The [official implementation at 59a68f67, dated 2026-04-14](https://github.com/facebookresearch/Hyperagents/tree/59a68f672dfb92c74aeb7e61535d776fb36e172d)
separates task_agent.py, meta_agent.py and generate_loop.py. No code or paid
execution from that repository is used in this increment.

## Existing artifacts and admission requirements

[WORKLOADS-006.md](WORKLOADS-006.md) provides an executable offline historical
p-limit runtime witness, using exact yocto-queue 1.2.1 payloads and Node 24.19.0.
It has durable engineering reservations and raw process outcomes. Full upstream
tests, hidden tests, arbitrary candidate isolation and resource approval remain
missing. The host denied Bubblewrap network namespace setup; do not treat the
fixed witness's Node permissions as an arbitrary candidate sandbox.

[EXECUTOR-001.md](EXECUTOR-001.md) preserves the first Bubblewrap contract and
negative receipts. [EXECUTOR-002.md](EXECUTOR-002.md) corrects its probe trust
boundary, interrupted reservation handling and overstated isolation verdict.
[EXECUTOR-003.md](EXECUTOR-003.md) binds the pinned Node, prlimit and ELF loader
identities and adds the two exact synthetic /lib links inside the empty root.
This removes the known loader-layout defect from the launch construction.
[EXECUTOR-004.md](EXECUTOR-004.md) adds direct bounded ELF dynamic-section
parsing and validates the complete declared static eight-library dependency closure,
including exact SONAME, symlink, canonical path, direct dependency and search-path
properties plus reviewed file hashes. Data-driven loads, immutable runtime
snapshotting, pinned Bubblewrap identity, actual relocation, sandbox startup and
OS isolation still require a compatible runner. A host compatibility receipt cannot grant resource authority.
Do not rerun the incompatible host unchanged.

[MIGRATION-001.md](MIGRATION-001.md) records the implemented versioned projection
and reservation algebra, adversarial tests and a concrete resource authorization
proposal. Live application, durable version dispatch and candidate execution
remain disabled. Read that increment before repeating accounting design work.

**Accounting and source migration.** The v1 ledger only accepts retrieval
   policies and native BM25 calls. Design a versioned migration retaining its
   exact history, 209784 consumed native calls, 7 epochs, alpha, tasks, trust and
   gates. Repair executions cannot spend a relabeled native call budget. State
   any required additional resource dimensions and obtain the applicable
   approval before enabling them. Merely reviewing this adapter does not enable
   optimization. Preserve original source snapshots and test mixed-version replay,
   interrupted reservations and retained charges. Do not invent zero acquisition
   costs. The current adapter always reports execution disabled.
**Preserved broader public development tasks.** [WORKLOADS-001.md](WORKLOADS-001.md)
   freezes the first three exact public base/fix lineages and fail-closed
   admission checks. Complete source archives, offline dependency closures,
   toolchains and hidden development tests remain missing, so candidate
   execution stays disabled. [WORKLOADS-002.md](WORKLOADS-002.md) mirrors all 23
   manifest-bound changed source, upstream test, license and package-manifest
   blobs with offline Git-object verification, while explicitly refusing to
   treat that partial capsule as a whole source tree or runnable environment.
   [WORKLOADS-003.md](WORKLOADS-003.md) freezes all 12354 base-tree path,
   mode, type and object-id entries and reconstructs both base and one-commit
   fix tree identities offline. Inventories prove whole-tree identity, but do
   not contain every blob payload or make the workloads executable.
   [WORKLOADS-004.md](WORKLOADS-004.md) adds complete content-addressed base
   and fix source payloads for the compact p-limit and Click workloads. The
   larger RuVector payload set and every offline dependency closure remain
   deliberately deferred, so candidate execution remains disabled.
   [WORKLOADS-005.md](WORKLOADS-005.md) preserves the complete 169-blob local
   source closure for the RuVector graph target and its two direct path-dependency
   crates. It also freezes an object-size inventory showing that the unrelated
   full workspace is 316496519 referenced bytes; that larger acquisition remains
   separately gated and no runnable dependency closure is claimed.
   These artifacts remain preserved; broader acquisition is deferred in favor of
   the p-limit comparison above. Record exclusions, fix exposure, dependencies
   and costs when further task acquisition becomes relevant. Freeze samples
   before comparing methods. The known witnesses cannot become final data.

The separate initial repair resource proposal is **not approved**: at most
36 candidate evaluations, 216 isolated process starts and 1080000 summed process
wall milliseconds across at most three existing shared epochs. No local helper,
review of this document or capability result authorizes that envelope. Retain
209784 native BM25 calls, seven epochs, original ancestry, consumed tasks,
trust, lifetime alpha and every existing proof gate.

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
