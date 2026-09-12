# Generalization and proof protocol

This follow-up tests the **unchanged** learner from the initial NULL experiment.
It tightens the evidence standard instead of tuning the learner against observed
results. No deployment or real RSI claim is authorized by a passing simulation.

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
