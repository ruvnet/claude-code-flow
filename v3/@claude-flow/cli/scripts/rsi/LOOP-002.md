# Development iteration 2: proposal coverage fails despite baseline headroom

On 2026-09-12, one new epoch completed in mission `rsi-ruflo-loop-20260912`.
The fixed static control improved retrieval, while the adaptive proposer did not.
Bounded RSI remains unsupported. No policy was promoted.

Source was reviewed and publicly committed as
[`959d70cebcd413cee16b181999b0fb6a962fed1b`](https://github.com/ruvnet/ruflo/commit/959d70cebcd413cee16b181999b0fb6a962fed1b),
tree `a59659ebcf4a29e1c616ac9a6a0dad5b619a1de8`, before recording HYPOTHESIS
event 7 and reserving epoch 4. Its scenario queries and proposer were not changed
after observing mission outcomes. Fixture tests are implementation validation,
not additional research epochs or final evaluation.

The corpus includes every one of the 67 pinned memory/services TypeScript modules.
The 24 developer-authored scenario queries retain 12 training and 12 selection
queries with disjoint target files. Targets were previously observed. Baseline
training MRR is 0.388155951; baseline selection MRR is 0.383091987, leaving headroom.

| Improver | Training gain | Selection child MRR | Selection gain | Native calls |
| --- | ---: | ---: | ---: | ---: |
| Adaptive credits | 0 | 0.383091987 | 0 | 8,040 |
| Frozen uniform credits | 0 | 0.383091987 | 0 | 8,040 |
| Static two corners | 0.060807755 | 0.458503190 | 0.075411203 | 8,040 |
| Shuffled credits | 0 | 0.383091987 | 0 | 8,040 |
| Previous checkpoint credits | 0 | 0.383091987 | 0 | 8,040 |

Every improver started a child at the same root policy and evaluated two proposals
with identical native call budgets. Adaptive, frozen, shuffled and previous had
the same uniform credits and therefore the same proposals. They are not four
independent samples. Previous checkpoint credits run through the current proposer;
this does not replay the full historical optimizer implementation.

Adaptive tried lower `k1` (training delta -0.023458999) and zero subject weight
(training delta 0). Neither earned credit. Static tried two joint mutations;
`{b:1,k1:2.5,subjectWeight:6}` improved both development splits. The raw failed
static corner and all duplicated control evaluations remain in the receipt.
Adaptive's selection gain per 10,000 calls was 0, versus 0.093795029 for static.
This directly probes credit-conditioned child improvement capacity on one reused
development set. It does not establish three improving descendant generations,
causal credit benefit, transfer to new workloads, or independent generalization.

Actual mission cost was 41,808 native BM25 field calls: five 8,040-call arms plus a
1,608-call audit of the persisted parent. Scorer wall time was 1,355.259 ms and CPU
time 1,366,286 microseconds. External provider spend was $0. Index construction,
engineering, fixture tests, replay, orchestration and CI are outside those scorer
timings and the mission's candidate-call counter. Full acquisition dollar costs
are unavailable; these measurements cannot satisfy the confirmation cost gate.

The existing plateau tail includes prior null epochs, so the first new null
adaptive result stopped this batch after one epoch. No second or third attempt
was made. Lifetime development reservations now total 60,240 of 1,000,000 calls,
4 of 64 epochs, with no pending reservation and zero confirmation attempts.
The original ledger anchor and all negative evidence remain unchanged.

Current ledger head:
`98fbc3753edc28a14882e0f090177b69dd9c2b13c01506ea0ba5cd4a5e0719ec`.
Raw outcomes: [event 9](evidence/loop-development/00000009.json).
The original three epochs replay with their original Git tree, and epoch 4 replays
with the new source. The optional [library check](evidence/loop-capacity-toolcheck.json)
projects adaptive versus static outcomes through MetaHarness 0.1.11 and Autogenous
native gates; these add no independent task measurements or evaluator identities.

Next executable hypothesis: improve proposal coverage by including a predeclared
joint mutation alongside a training-informed single-axis mutation within the same
two-candidate arm budget. Freeze its rule before execution and compare it against
the unchanged current proposer, static, uniform and shuffled controls. Do not
simply install the observed static winner and call that recursive improvement.
Any new development source must be reviewed, archived and bound by a HYPOTHESIS
event while retaining this ledger and all counters.

Largest uncertainty: whether an improved proposer can earn a repeatable advantage
on independently selected real workloads. Separately controlled sealed tasks,
two operator-approved evaluator keys, full acquisition and evaluation dollars,
raw cluster-paired data and three descendant generations remain absent. No trust
keys, alpha allocations, statistical gates, resource ceilings or permissions changed.

Acceptance from the PR checkout, using Node 24:

```bash
node v3/@claude-flow/cli/scripts/rsi/loop/replay-history.mjs \
  v3/@claude-flow/cli/scripts/rsi/evidence/loop-development \
  98fbc3753edc28a14882e0f090177b69dd9c2b13c01506ea0ba5cd4a5e0719ec
```

Expected: `verified:true`, all four epochs covered once, 60,240 lifetime reserved
units, and `boundedRsiEvidenceAccepted:false`. Replay excludes timing equality.
