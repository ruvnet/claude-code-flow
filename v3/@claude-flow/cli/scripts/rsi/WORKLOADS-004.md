# Complete compact-workload source payloads

Decision: preserve and verify every base and fix Git blob payload for the
compact p-limit and Click development workloads. This is acquisition progress,
not an optimizer result or RSI evidence.

The deterministic payload-pack format stores each safe path and its exact bytes.
The verifier binds the pack to the frozen workload, partial capsule and complete
tree-inventory manifests. It recomputes every Git blob ID, checks complete path
coverage against the corresponding tree inventory, reconstructs each base tree,
substitutes only the already preserved public-fix blobs, and reconstructs each
fix tree.

The two packs cover 182 blobs and 1,648,424 payload bytes. Their encoded records
occupy 1,655,033 bytes before deterministic compression and 497,992 bytes after.
RuVector is explicitly deferred as a separate bounded acquisition because its
inventory contains 12,172 entries. This increment does not silently turn that
large acquisition into unmetered work.

Complete source payloads still do not provide offline dependency closures,
pinned runtimes, evaluator-authored hidden development tests, an adversarial
sandbox, or repair-resource authorization. The fixes are public and exposed;
these workloads cannot become sealed confirmation data. Offline execution,
candidate execution and bounded-RSI acceptance remain false.

No HYPOTHESIS or mission epoch was added. The original ledger remains at seven
epochs, 209,784 native field calls and head
`5a0e219e871fcf616209807c828c5793c29752f8d190fc38a0bc95e4db88422e`.
New native calls, repair candidate evaluations, repair starts, repair wall time
and external-provider spend remain zero. Total acquisition and evaluation dollar
costs are unknown.

## Acceptance

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/public-tree-payloads.test.mjs
```

Expected: fifteen passes, complete p-limit and Click base/fix payload coverage,
and all execution and RSI gates closed.
