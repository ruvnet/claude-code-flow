# RuVector graph target source closure

Decision: preserve the complete local source closure needed by the frozen
RuVector graph package and quantify the remaining full-workspace acquisition.
This advances reproducibility; it is not candidate execution or RSI evidence.

Reviewed source: `93ccdd8d8bade4a60726ecafb9a07577b915533a`, tree
`15291192e392e4b12ed6687de90c8283333bf5c5`. Raw outcomes are preserved in
`evidence/public-target-payloads.json`.

The content-addressed pack covers the root Cargo manifests and configuration,
the complete `ruvector-graph` crate, its `ruvector-core` path dependency and the
transitive `ruvector-turboquant` path dependency. All 169 selected Git blobs and
2,448,546 payload bytes are verified against the frozen base-tree inventory.
The two path dependency literals are also checked from their original manifest
payloads. The published parser fix payload remains bound separately.

A second acquisition record binds all 11,997 unique Git blob IDs in the full
12,169-blob-entry base tree to their remotely observed object sizes. It measures
316,496,519 referenced bytes, including 48 blobs over 1 MiB and one over 10 MiB;
the largest is 15,996,134 bytes. These size observations are explicitly not
payload proofs. Persisting the unrelated full workspace would require a separate
storage and acquisition decision instead of silently expanding this mission.

The original Cargo workspace references many unselected members. The crates.io
dependency closure, exact Rust toolchain and hidden development tests are not
frozen, and this host has no Cargo binary. Therefore the workload is not offline
executable and candidate execution stays disabled. The public known fix cannot
become sealed confirmation evidence.

Mission accounting remains seven epochs, 209,784 native calls and ledger head
`5a0e219e871fcf616209807c828c5793c29752f8d190fc38a0bc95e4db88422e`.
No HYPOTHESIS, epoch, native call, repair evaluation, repair start or repair wall
time was added. External-provider spend is $0; total acquisition and evaluation
dollar costs remain unknown.

Five isolated target-payload test runs took 38,596.269 ms total and five
engineering validation process starts. All 154 focused tests and seven historical
epoch replays passed. The local Cargo probe failed with status 127 because the
binary is absent. MetaHarness and Autogenous were not rerun because no candidate
or descendant outcome was measured.

## Acceptance

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/public-target-payloads.test.mjs
```

Expected: fifteen passes with the selected local source closure verified and
workspace completeness, offline execution, candidate execution and RSI false.
