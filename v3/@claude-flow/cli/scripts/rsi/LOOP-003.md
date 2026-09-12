# Joint coverage improves selection but does not establish learned advantage

Date: 2026-09-12. Decision: retain the better development policy, reject an RSI
claim, and complete this three-epoch hypothesis. The loop itself reports
`DEVELOPMENT`; it has only two consecutive null promotions after the first gain.
The executor stops because the reviewed three-epoch batch is complete. It must
not claim the plateau gate fired or repeat this batch unchanged.

The [SOTA review](SOTA-20260912.md) covers eight primary papers, including Meta^n,
AI4AI-Bench, RSIBench-Data and S3Gym from July/August 2026. The new proposer was
reviewed, tested and frozen publicly at
[`837386c864f97b2170a385fd4639c1ec165a7e5e`](https://github.com/ruvnet/ruflo/commit/837386c864f97b2170a385fd4639c1ec165a7e5e),
tree `b49166bc3cf5942720b4aec0c7fc36a9961c34d3`, before HYPOTHESIS event 10 and
the reservations for epochs 5, 6 and 7. Corpus, queries and the new rule were not
changed after these mission outcomes.

| Epoch | Adaptive child MRR | Frozen child MRR | Static child MRR | Legacy v2 child MRR | Retain new policy? |
| --- | ---: | ---: | ---: | ---: | --- |
| 5 | 0.458503190 | 0.458503190 | 0.458503190 | 0.383091987 | Yes |
| 6 | 0.383091987 | 0.383091987 | 0.458503190 | 0.403930408 | No, preserve epoch-5 policy |
| 7 | 0.458503190 | 0.458503190 | 0.458503190 | 0.403930408 | No, ties retained policy |

Shuffled and previous-checkpoint credit controls matched adaptive in all three
epochs. Each arm starts a fresh child from the same root, so the epoch-6 probe
can regress while the retained mission policy remains at MRR 0.458503190.
Adaptive minus frozen improvement capacity is exactly zero in all three epochs.
Static is at least as good in every epoch and strictly better in epoch 6.
There is no evidence of learned-credit superiority or three improving descendants.

The implementation recovered the high-corner policy already found by static in
epoch 4. That is a useful development fix, not a novel discovery or independently
generalizing result. Legacy's epoch-6 advantage also shows that forcing joint
exploration can waste a scarce proposal slot. More coverage is not uniformly better.
The final credits become nonuniform, but their effect after epoch 7 was not tested.

| Measurement | Actual value |
| --- | ---: |
| New epochs | 3 |
| Evaluated candidates | 36 |
| Native calls per arm per epoch | 8,040 |
| Native calls per epoch including parent audit | 49,848 |
| New native calls | 149,544 |
| Scorer wall time | 5,068.171 ms |
| Scorer CPU time | 5,097,444 microseconds |
| External provider spend | $0 |
| Lifetime mission reservations | 209,784 / 1,000,000 calls |
| Lifetime mission epochs | 7 / 64 |

Scorer timings and mission candidate-call counters exclude indexing, tests,
research, code generation, replay, CI and orchestration. Full acquisition dollar
costs remain unknown. Those exclusions prevent treating these results as a
complete cost comparison of the outer Codex improvement process.

The exact predecessor proposer is preserved and tested against its original Git
tree. Joint credit allocations are recorded, including all failed candidates.
All 35 focused tests pass locally. Source-history replay covers original epochs
1-3, epoch 4 and new epochs 5-7 once each at their respective evaluator versions.
Replaying the version-2 adapter exposed a root-relative Git path issue in the
archive runner. Its child now uses the original Git object database and the
snapshot as work-tree root; archived evaluator bytes remain unchanged. The full
seven-epoch replay passed after this reviewed fix.
The [optional library check](evidence/loop-joint-toolcheck.json) projects the last
adaptive/static tie through MetaHarness and Autogenous; it adds no independent
tasks, evaluator identities or proof of efficacy.

## Next hypothesis and proof gap

Do not spend the next batch on unchanged alternating corners. Build a bounded
executable improver that consumes inherited, training-only failure traces and
changes proposal selection or failure analysis on fresh public development tasks.
Measure the outer procedure against frozen, static, shuffled and predecessor
procedures with the same starting tasks and cost scope. A small replayable code
repair or experiment-selection workload is a more informative next target than
another tuning pass over these three parameters. Do not silently change the unit
of the existing lifetime budget to accommodate a different adapter.

Final confirmation still requires separately controlled sealed real workloads,
two operator-approved evaluators, complete acquisition/evaluation dollar costs,
raw cluster-paired data and three improving descendant generations. The current
mission has no approved keys. Its gates, alpha, trust registry and original
negative evidence remain unchanged. No merge, deployment or release occurred.

Current anchored ledger head:
`5a0e219e871fcf616209807c828c5793c29752f8d190fc38a0bc95e4db88422e`.
Raw completions: events 12, 14 and 16 in [loop-development](evidence/loop-development).

Acceptance from the PR checkout with Node 24:

```bash
node v3/@claude-flow/cli/scripts/rsi/loop/replay-history.mjs \
  v3/@claude-flow/cli/scripts/rsi/evidence/loop-development \
  5a0e219e871fcf616209807c828c5793c29752f8d190fc38a0bc95e4db88422e
```

Expected: `verified:true`, seven epochs, 209,784 lifetime reserved units and
`boundedRsiEvidenceAccepted:false`. Successful reproducibility is not independent
efficacy replication.
