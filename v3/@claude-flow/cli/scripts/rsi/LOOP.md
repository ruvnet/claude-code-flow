# RuFlo continuing RSI research loop

The loop executes bounded development experiments and preserves their history.
It cannot promise to discover RSI. It must never weaken a gate or relabel a
development result to satisfy an instruction to continue until success.

## First execution

Mission `rsi-ruflo-loop-20260912` ran 3 epochs with 12 candidates each against
RuFlo's actual `src/memory/hybrid-retrieval.ts`, indexing 16 committed source
files with 24 public, developer-authored queries. There are 12 training queries
and 12 selection queries with disjoint target files. All corpus content is pinned
to source commit `b02c0cacec225deea01f586b66a9694393369432`.

The baseline already had MRR 1.0 on both sets. All 36 candidate evaluations
produced no selected improvement. There were **18,432 metered native BM25 field
calls**, **$0 external provider spend**, about 822 ms measured scorer wall time,
and 854 ms scorer CPU time on this host. Index construction and orchestration
are outside those scorer timings. These are measurements, not latency guarantees.

Status: `PLATEAU_REQUIRES_NEW_HYPOTHESIS`. This saturated pilot establishes real
code execution and loop mechanics, not efficacy or useful generalization.
Do not treat the absence of headroom as evidence that a different learner fails.
The next development hypothesis must introduce a more representative corpus and
harder real queries, or a different actual agent task, before more optimization.
Independent final evaluation must remain separate from that development work.

Ledger: [`evidence/loop-development`](evidence/loop-development).
Published head commitment:
`c5c6da0b728c52414f2dff86f9d23121776d600defff0f214f1502a091f69088`.
The optional [`loop-toolcheck.json`](evidence/loop-toolcheck.json) records actual
MetaHarness 0.1.11 replay and Autogenous native gate execution. Both reject this
candidate. They project the same recorded MRR, so they add no independent task
measurement. Autogenous authorization flags in that check are local test inputs,
not an authorization to change a deployed system.

## Execute and resume

Use Node 24 and a Git checkout containing the pinned corpus commit. No install,
provider credential, daemon, network or model call is required for the native pilot.

```bash
# Inspect the existing mission; never initialize over it.
node v3/@claude-flow/cli/scripts/rsi/loop/run.mjs status \
  v3/@claude-flow/cli/scripts/rsi/evidence/loop-development

# Up to eight bounded epochs. Stops on plateau or the lifetime resource ceiling.
node v3/@claude-flow/cli/scripts/rsi/loop/run.mjs run \
  v3/@claude-flow/cli/scripts/rsi/evidence/loop-development 8

# Validate the anchored chain and recompute native scores, candidates and credit.
node v3/@claude-flow/cli/scripts/rsi/loop/run.mjs replay \
  v3/@claude-flow/cli/scripts/rsi/evidence/loop-development \
  c5c6da0b728c52414f2dff86f9d23121776d600defff0f214f1502a091f69088

node --test v3/@claude-flow/cli/scripts/rsi/loop/loop.test.mjs
```

For a distinct development mission, `init NEW_DIRECTORY MISSION_NAME` creates a
new ledger. This is not a way to reset the existing research budget or alpha.
The recurring mission must always resume the committed directory above.

After reviewing and committing an actual source change, record its rationale:

```bash
node v3/@claude-flow/cli/scripts/rsi/loop/run.mjs hypothesis LEDGER_DIRECTORY \
  'Describe the observed failure and the new testable development hypothesis'
```

This preserves epoch count, reserved work, consumed confirmation datasets,
confirmation alpha index and ancestry. It does not expand the safety envelope,
trust registry, or resource ceiling. Historical epochs require their original
source revision for score replay; a new source cannot silently verify them.

## Durable work and recovery

Each epoch reserves every planned field-score call before executing candidates.
The evaluator meters calls and rejects excess work before the next native call.
Budgets include rejected proposals, training, candidate selection and root audits.
Limits are 12 candidates per epoch, 100,000 calls per epoch, 1,000,000 calls and
64 epochs per mission. A batch runs at most 8 epochs. No provider spend is enabled.
These are native work units, not equal CPU or dollar cost.

The ledger uses exclusive writer locks, fsync, atomic rename, sequential files and
hash chaining. `COMPLETE` must match its reserved source, corpus, epoch and parent.
Every checkpoint records policy, proposal credits and its parent hash. Git commits
provide externally inspectable head anchors; a locally rewritten hash chain alone
is not authentication. This is a local filesystem protocol, not distributed locking.

An abandoned reservation remains charged. `recover DIR EXPECTED_HEAD` records
interruption and permits a newly charged attempt; it never refunds uncertain work.
If a process dies during an atomic append, `recover-writer DIR EXPECTED_HEAD`
requires a dead local owner, serializes recovery, and quarantines any partial write.
It refuses a live or ambiguous owner. A crash during recovery itself may require
manual inspection of the recovery lock. There is no automatic lock deletion.

## Independent confirmation contract

Development receipts cannot claim bounded RSI. A confirmation mission must first
have two operator-approved Ed25519 evaluator keys with distinct canonical key
identities. The primary and replication roles attest their independence. Two keys
alone do not establish two independent people or infrastructures.

`init-trusted NEW_DIRECTORY CONFIG_JSON` accepts `{mission, trust}` where `trust`
contains `{role: 'primary' | 'replica', publicKey: PEM}` entries. The first pilot
intentionally has no such keys. Migrating it into a confirmation mission requires
reviewed preservation of the lifetime budget, alpha and ancestry; automatic trust
migration is not implemented. Never generate two local keys and call that an
independent evaluation. Positive gate fixtures in unit tests are mechanism tests.

Before reading final outcomes, `reserve-proof DIR MANIFEST_JSON` binds:

1. Mission and immutable protocol hash.
2. Current source identity and the public source commit.
3. The three latest recorded descendant checkpoints, their parents and root.
4. Two fresh committed final dataset identities, one per evaluator.
5. Lifetime test index k and alpha `0.05 / (k * (k + 1))`.

Publish and externally verify that reservation before final evaluation. The CLI
validates hash bindings and commit syntax; it cannot establish GitHub publication
time. Approved evaluator signatures attest source verification and sealed data.
The protocol's statistical error accounting is conditional on genuinely fresh,
properly sampled tasks. Alpha allocation cannot repair benchmark contamination.

`confirm DIR PACKETS_JSON` consumes two signed packets and recomputes the gate.
Each packet binds the reservation head, source, lineage and its final dataset.
It includes raw paired start scores, final child scores, common starting harness
identities, full training/acquisition costs including failures, evaluation costs,
shared dollar budget, task identities and independent repository/lineage clusters.
The candidate and start must match across comparators; repeated final tasks,
missing costs, signatures or cells block acceptance.

There are 3 workload families (`retrieval`, `repair`, `planning`), 3 generations,
4 controls (`frozen`, `static`, `shuffled`, `previous`) and 2 evaluators: **72**
predeclared comparisons. At least 16 independent clusters are required per cell.
Within each cluster, compute improvement over the common starting score divided
by all acquisition and evaluation dollars. Every cell requires:

1. Positive baseline mean productivity and candidate sample mean at least 10% higher.
2. An exact one-sided sign test on candidate productivity minus 1.1 times baseline
   productivity, with p no larger than the reserved alpha divided by 72.
3. No decrease in mean child quality, plus all predeclared safety and reset attestations.

This tests the prevalence of a practical productivity advantage, not a confidence
bound on its population mean. The 16-cluster floor is not a power calculation;
later alpha allocations or smaller effects may require much larger samples.
Cluster definitions and workload selection must be frozen by the evaluator.

Every attempted confirmation consumes its alpha and dataset identities, including
invalid signatures and rejected results. Restarts cannot reset that consumption.
The verdict is recomputed from raw signed packets on ledger replay; supplied
`accepted`, `promote`, or `RSI achieved` flags have no authority.

Success is `BOUNDED_RSI_EVIDENCE_ACCEPTED`, conditional on the approved evaluator
attestations being truthful and independent. `openEndedRsiProven` and production
promotion remain false. A signature does not prove labels, dollar accounting,
independence or real-world truth. No merge or deployment path exists here.

## Recurring executor contract

The scheduled Codex task performs actual engineering; RuFlo is its coordination
and memory plane. Each invocation inspects the latest Git branch and Core Memory
issue, obtains one resource claim, and resumes this exact ledger. On plateau it
must implement a new evidence-based hypothesis with tests and a source snapshot
before recording `HYPOTHESIS`. It must not rerun an unchanged saturated pilot.

Preserve all failed hypotheses, prior source revisions and signed evidence.
Publish changes to the draft PR and checkpoint this ledger. Do not merge, deploy,
read private provider credentials, increase budgets, or modify confirmation gates.
At resource exhaustion, missing independent evaluation, or another actionable
blocker, report what is needed and preserve state. Stop scheduling on accepted
bounded evidence or explicit cancellation. No success date is promised.

Acceptance: kill a process before and after ledger publication, recover against
the expected head, and verify retained reservations. Replay the native workload.
Then prove that untrusted signatures, incomplete evidence, reused final tasks,
false source identities and supplied success flags cannot open the evidence gate.
