# Content-addressed public source capsules

Decision: accept a partial source-mirroring increment for the three frozen public
development workloads. Candidate admission and execution remain disabled. This is
artifact-integrity engineering, not a repair result or evidence of RSI.

Capsule manifest hash:
`f581dc26bee0d8ff03460c2734e29a236ce14596af65b652f48eb3b62bb77d2c`.
Reviewed source is `2c59b2e80bb22551d1e451f5ffc03c34126c841c`, tree
`9de764e43d9a850b056ede685c2e91971f6dc268`. Raw verification measurements
are preserved in `evidence/public-capsule-check.json`.
It remains bound to workload freeze
`4f6cb0b90be2b8de5c438a637164bdc483ec2cf83bdd982e9121dc7a2a20307e`
and its reviewed source commit
`03840179a052934a6de0a094106e6495f07ec6f3`.

## Mirrored scope

`repair/public-capsules` contains base64-encoded copies of 23 original public Git
blobs totaling 289533 decoded bytes. This covers every manifest-bound changed
source file, upstream test, license and package manifest. Each record preserves
the upstream repository, role and original path. Offline verification decodes the
bytes and recomputes both SHA256 and Git's `blob <length>\0<bytes>` SHA1 identity.

The validator rejects missing, duplicate, unexpected, corrupted or reassigned
blobs; unsafe manifest changes; workload-freeze drift; false completeness;
fabricated dollar costs; changed legacy counters; local evaluator keys; candidate
execution; sealed-evaluation labels and RSI acceptance. It never runs archived
code or accepts a command from the capsule.

## Deliberately incomplete

The RuVector `Cargo.lock` and Click `uv.lock` identities stay frozen in the
original workload manifest, but their payloads are deferred until their complete
offline dependency closures are acquired. Whole repository trees and exact
toolchains are also absent. The capsules therefore report:

* `completeDependencyLocks: false`
* `completeSourceTrees: false`
* `completeDependencyClosures: false`
* `offlineExecutable: false`
* `candidateExecutionEnabled: false`

This prevents a collection of selected files from being presented as a native
repository workload. Public upstream fixes and tests remain exposed; these tasks
can never become sealed confirmation data. Three repository labels do not by
themselves establish independent clusters or evaluators.

No mission epoch, native field call, repair evaluation, repair process start or
repair wall-time reservation was used. External provider spend was $0. Full
acquisition and evaluation dollar costs remain unknown.

## Next executable increment

Acquire complete content-addressed source trees, the two lockfile payloads,
offline dependency closures and exact toolchain identities. Verify native tests
from those immutable environments before implementing the inherited improver.
Evaluator-authored hidden development tests, the reviewed isolated executor and
explicit operator approval of repair resources remain separate gates.

## Acceptance

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/public-capsules.test.mjs
node v3/@claude-flow/cli/scripts/rsi/repair/public-capsules.mjs inspect \
  v3/@claude-flow/cli/scripts/rsi/repair/public-capsules.json \
  v3/@claude-flow/cli/scripts/rsi/repair/public-workloads.json \
  f581dc26bee0d8ff03460c2734e29a236ce14596af65b652f48eb3b62bb77d2c
```

Expected: fifteen tests pass; 23 blobs and 289533 decoded bytes verify; offline
execution, candidate admission and bounded RSI evidence remain false.
