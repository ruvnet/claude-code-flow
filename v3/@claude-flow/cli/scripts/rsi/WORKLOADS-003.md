# Complete public Git tree inventories

Decision: the three exposed public repair lineages now have complete,
content-addressed Git tree inventories. This closes ambiguity about which paths
and object identities belong to each source revision; it does not make the
workloads executable and is not RSI evidence.

Reviewed source: `cdac5dfb86ca67a43bd4d9444a54263d27d0af0e`, tree
`b8bd2b399e6eaa85e5832364382fca846c2a2620`. Raw benchmark outcomes are in
`evidence/public-tree-inventories.json`.

`repair/public-tree-inventories.json` binds the existing workload freeze and
partial blob-capsule manifest. Three deterministic `git ls-tree -rz` streams are
gzip-compressed with timestamps disabled and stored as base64. The offline
verifier:

1. verifies compressed and raw SHA-256 identities;
2. parses every NUL-delimited mode, type, object id and path;
3. reconstructs Git tree objects recursively and verifies each frozen base tree;
4. applies only the already frozen one-commit blob substitutions; and
5. reconstructs and verifies each published fix tree.

The inventories cover 12,354 entries and 1,286,134 raw bytes (421,836 compressed
bytes). They cover all paths and object ids in the three base revisions. Most
object payloads, both dependency closures, pinned toolchains and evaluator-authored
hidden development tests remain absent. Therefore complete source-tree payloads,
offline executability, candidate admission and candidate execution all remain
false.

No HYPOTHESIS or experiment epoch was added. The original mission remains at
seven epochs, 209,784 reserved native field calls and ledger head
`5a0e219e871fcf616209807c828c5793c29752f8d190fc38a0bc95e4db88422e`.
Repair evaluations, repair process starts, repair wall time, new native calls and
external-provider spend are zero. Total acquisition and evaluation dollar costs
remain unknown.

Five isolated inventory-test runs took 5890.395 ms total and five engineering
validation process starts. All 124 focused tests and seven historical epoch
replays passed. MetaHarness and Autogenous were not rerun because no candidate
outcome or descendant improvement was measured.

## Acceptance

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/public-tree-inventories.test.mjs
```

Expected: fifteen passes, verified base and fix tree identities, and offline
execution, candidate execution and bounded-RSI acceptance all false.
