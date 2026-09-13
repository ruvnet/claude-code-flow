# Public repair workload freeze 001

Decision: three public one-commit bug lineages are frozen for development
acquisition. They are not yet admitted for candidate execution and provide no
RSI evidence.

The manifest hash is
`4f6cb0b90be2b8de5c438a637164bdc483ec2cf83bdd982e9121dc7a2a20307e`.
Reviewed source is `03840179a052934a6de0a094106e6495f07ec6f3`, tree
`b4960f3fe7861b8779eb523b5063d2861043a728`. Raw acquisition and verification
costs are preserved in `evidence/public-workload-freeze-check.json`.
`repair/public-workloads.json` binds each exact base commit, fix commit, Git tree,
changed-file blob, diff hash, test declaration, dependency metadata and license.
The fixes and upstream tests are public and known. The sample was frozen before
any optimizer comparison.

The selected development lineages are:

1. `ruvnet/RuVector`: Rust Cypher `NOT` precedence.
2. `sindresorhus/p-limit`: JavaScript async queue API exposure.
3. `pallets/click`: Python sentinel identity across copy and pickle.

These are three distinct repositories and plausible bug clusters. That is an
engineering diversity property, not an independent evaluator judgment. A later
cluster review may reject or merge clusters. None may be moved into confirmation
because their fixes were exposed during acquisition.

RuView's RSSI validity repair was excluded from this increment because its server
target is compile-heavy and an evaluator-authored history-path test has not been
frozen. The attrs ForwardRef repair was excluded because its strongest scenario
needs a pinned Python 3.14 environment. More RuFlo issues were excluded because
they would not add an independent repository lineage to the existing single
cluster calibration.

## Admission boundary

Source lineage metadata is frozen, but complete source archives are not mirrored.
Offline dependency closures and exact Node, Python and Rust toolchains are not
all frozen. Evaluator-authored hidden development tests do not exist. Therefore
the validator returns `candidateAdmissible: false` and the executor deliberately
throws `PUBLIC_WORKLOAD_EXECUTION_DISABLED`.

No candidate or workload test process was launched by this increment. Engineering
verification ran separately and is fully excluded from the proposed repair
resource envelope. It added zero native field calls, repair evaluations, repair
process starts, repair wall time and external provider spend. Total acquisition
and evaluation dollar costs remain unknown. The original mission remains at seven
epochs and 209784 reserved native field calls.

## Next admissible increment

Mirror content-addressed base and fix source archives, freeze complete offline
dependency closures and exact toolchains, then publish evaluator-authored hidden
development tests without disclosing them to the improver. Update the manifest
through a new reviewed version; never mutate this frozen sample in place. Resource
authorization for execution remains a separate gate.

## Local acceptance

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/public-workloads.test.mjs
node v3/@claude-flow/cli/scripts/rsi/repair/public-workloads.mjs inspect \
  v3/@claude-flow/cli/scripts/rsi/repair/public-workloads.json \
  4f6cb0b90be2b8de5c438a637164bdc483ec2cf83bdd982e9121dc7a2a20307e
```

Expected: fifteen tests pass; inspection reports three repositories, three
clusters, frozen exposed lineages, candidate execution disabled and bounded RSI
evidence false.
