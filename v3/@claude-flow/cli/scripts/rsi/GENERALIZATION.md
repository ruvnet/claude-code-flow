# Generalization and proof protocol

This follow-up tests the **unchanged** learner from the initial NULL experiment.
It tightens the evidence standard instead of tuning the learner against observed
results. No deployment or real RSI claim is authorized by a passing simulation.

## Registered result: generalization not supported

The exact evaluator, learner, tests and registration were published at
[`34a49bcda463dcac90124bb623b2da02413ea547`](https://github.com/ruvnet/ruflo/commit/34a49bcda463dcac90124bb623b2da02413ea547)
before the first registered outer run. GitHub readback verified tree
`4cb849f0818f288b09292c67254a01be9717c817` matched the local source tree. No
learner, source, seed, budget or gate was changed after observing its results.

**0 of 36 comparisons passed.** All 12 adaptive-versus-frozen mean deltas were
negative. Thirteen of the full 36 comparisons had positive means, but none met
both registered thresholds. There were 399,024 objective evaluations across 16
seeds. Reset, null and split guards all passed. This is a failed transfer test,
not evidence that every possible RSI system is impossible.

Final checkpoint (generation 6), mean paired score-gain differences on [0,1]:

| Held-out family | Adaptive minus frozen | Adaptive minus shuffled | Adaptive g6 minus g4 |
|---|---:|---:|---:|
| Permuted coordinates | -0.001563499772 | +0.001995738703 | +0.001092420659 |
| Absolute loss | -0.003804941146 | +0.004638185250 | -0.001024650553 |
| Coupled loss | -0.001346027341 | -0.000069988409 | -0.000566795870 |
| Multimodal loss | -0.010877938995 | +0.014939308181 | -0.003667240583 |

The strongest favorable sign-test result was multimodal g4 versus shuffled:
mean +0.016391608429, 14/16 wins, p=0.002090454102. It still failed the registered
0.05/36 threshold (approximately 0.001388889), and that checkpoint's frozen
comparison was negative. Reporting its uncorrected p-value as proof would be wrong.

[`evidence/generalization.json`](evidence/generalization.json) contains the raw
signed histories, snapshots, per-task gains, all comparisons and decision.
The separately committed [`generalization-public.pem`](evidence/generalization-public.pem)
pins the signer for replay, not independent identity. A read-only reviewer
recomputed the full bundle exactly and repeated all 18 focused tests. This is
reproducibility review, **not independent blind efficacy replication**.
Post-run adversarial checks rejected both an unsigned false verdict and a newly
signed false verdict: valid signatures alone cannot bypass full recomputation.

```bash
node --test v3/@claude-flow/cli/scripts/rsi/experiment.test.mjs \
  v3/@claude-flow/cli/scripts/rsi/generalization.test.mjs
node v3/@claude-flow/cli/scripts/rsi/generalization.mjs replay \
  v3/@claude-flow/cli/scripts/rsi/evidence/generalization.json \
  v3/@claude-flow/cli/scripts/rsi/evidence/generalization-public.pem
```

The earlier MetaHarness projection rejected the original learner. The earlier
Autogenous native fixture demonstrated bounded parameter evolution, not transfer.
Those cross checks are preserved unchanged; neither replaces this evaluation or
turns its negative result into RSI proof. No production promotion is permitted.

## Frozen design

Training uses only eight-dimensional separable squared loss. The four outer
families are excluded from training: permuted important coordinates, absolute
loss, coupled squared loss, and multimodal periodic loss. All scores lie in [0,1].
Task addresses include split, seed, family and index. These are author-designed
synthetic functions, not unseen repositories, model calls, or independent data.

All optimizer snapshots for all arms and seeds freeze before any outer task is
constructed. Checkpoints are 0, 2, 4 and 6. Every outer episode starts with the
same application state and indexed random stream. Evaluation learning is disabled.

For each of four families and three later checkpoints, compare adaptive against
frozen, credit-shuffled, and the previous adaptive checkpoint: exactly **36**
comparisons. Average task-level paired differences within each of 16 seeds. Each
comparison must have an exact one-sided sign-test p <= 0.05/36 and mean gain >=
0.01. **All 36 must pass.** No family averaging, best checkpoint selection, early
stopping, or threshold changes after observing results. The sign test concerns
prevalence of positive seed differences, not a confidence bound on the mean.

Same-checkpoint arms have identical logical training and deployment budgets.
Later checkpoints consume more training, so comparisons across checkpoints test
whether additional training improves fresh search at a fixed deployment budget;
they do not establish equal total lifecycle compute or cost-free compounding.
The run performs exactly **399,024 objective evaluations**, including reset and
constant-score null audits. Logical budgets do not imply CPU or dollar equality.

Resetting the optimizer must exactly recover root/frozen outer outcomes. The
constant-score fixture must produce zero gain. These causal controls establish
state/reset behavior, not that any observed change is beneficial.

## Public registration before evaluation

`generalization.mjs register` binds the protocol, exact evaluator SHA256 and the
unchanged learner SHA256 into `evidence/generalization-registration.json`.
Publish the evaluator, tests, protocol and registration **before** the first
registered outer run. Verify the remote commit tree matches those exact files.
Only then pass that commit SHA to `generalization.mjs run`.

The CLI checks commitment equality and SHA syntax, not GitHub publication or time.
A caller could invent a SHA; therefore public preregistration requires external
commit inspection. A source hash alone does not prove when a hypothesis was chosen.
Public seeds prevent post hoc seed selection here but are **not a blind holdout**.
Tests use distinct unit seed 3 and never execute the registered outer seed set.

```bash
node --test v3/@claude-flow/cli/scripts/rsi/generalization.test.mjs
node v3/@claude-flow/cli/scripts/rsi/generalization.mjs register /tmp/registration.json
# Publish and verify exact source + registration first.
node v3/@claude-flow/cli/scripts/rsi/generalization.mjs run \
  /tmp/registration.json REGISTRATION_COMMIT_SHA /tmp/generalization.json
node v3/@claude-flow/cli/scripts/rsi/generalization.mjs replay \
  /tmp/generalization.json /tmp/trusted-public-key.pem
```

Replay checks the pinned signature, source and protocol, then recomputes every
training history, checkpoint, score, comparison, budget and verdict. Verification
can succeed on a failed generalization claim. That is the intended behavior.

## What counts as proof?

| Evidence level | Necessary test | Claim permitted |
|---|---|---|
| Mechanism correctness | Unit/adversarial tests and exact replay | Implementation follows its contract |
| Synthetic transfer | All family/checkpoint/control gates pass | Transfer within these specified synthetic families |
| Real task generalization | Frozen learner tested on separately held out repositories/workloads, measured costs and independent evaluation | Bounded empirical transfer on that population |
| Recursive improvement efficiency | Successive optimizer changes outperform frozen and matched-history controls across fresh real workloads, with full acquisition cost and causal ablations | Bounded empirical RSI evidence within the tested envelope |

This deliverable implements the first two levels' machinery. It cannot satisfy
the last two by labeling synthetic results differently. `realRsiProven` and
`independentlyReplicated` remain false. Signing two receipts with two local keys
would not create independent evaluation. Formal code invariants and statistical
evidence are different from mathematical proof of open-ended RSI.

If transfer fails, keep the learner disabled. A follow-up learning rule requires
a new registration and new evaluator-controlled tasks. The largest remaining
risk is author/benchmark coupling; the fix is independent control of real task
selection and labels, not another favorable synthetic curve.
