# Pinned static dependency-closure result

Decision: accept the declared static `DT_NEEDED` closure as a bounded
engineering improvement. RSI remains unsupported and candidate execution stays
disabled.

Reviewed source is commit
`4d40f1f6ff23974042a1a406d10025482ba74b0b`, tree
`55c217707d7da879a9b9cf4fe367ddb088631cb5`. Runtime manifest v2 has hash
`ccf90161f686638f6409a6f187631e5848713ed2f5174df47466018c5c5ae8f8`.
It binds the SHA-256 and exact direct dependency graph for Node 24.19.0,
`prlimit`, the loader and eight shared-library SONAMEs.

Admission now parses the ELF dynamic section directly with checked arithmetic,
128 MiB file bounds, exact SONAME/dependency matching and forbidden RPATH/RUNPATH.
The production API accepts no injected filesystem observation. The read-only
current-host check verifies every declared artifact and hash.

The source-bound suite passed 17/17 tests in 115.981869 ms. The read-only host
inspection took 338.770759 ms, totaling 454.752628 ms across two Node validation
processes. Dedicated workflow 34741093717 passed both jobs, including all
historical epoch replays and the new closure step.

No isolation probe, candidate, epoch, native call, MetaHarness evaluation or
Autogenous evaluation ran. Provider spend was $0. Acquisition, evaluation and
outer engineering dollar costs remain unknown. The original mission remains at
seven epochs and 209784 native calls.

This result is deliberately limited to the declared static dependency graph.
It does not prove data-driven loads such as `dlopen`, NSS, locale or ICU, ABI
relocation, successful startup, or OS mount/namespace/egress isolation. The
runtime is not yet an immutable snapshot and Bubblewrap's identity is not yet
pinned. Binding all of `/usr` also exposes files outside the declared graph.

Next acceptance is an immutable, content-addressed runtime and pinned Bubblewrap
running the fixed p-limit base and known fix in a compatible clean offline
sandbox, followed by explicit OS isolation checks. Repair trials still require
operator approval for 36 evaluations, 216 isolated starts and 1080000 summed
process milliseconds.

The largest uncertainty is whether inherited failure-analysis state improves
descendants' capacity to create better successors on fresh tasks under matched
cost.

## Acceptance

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/runtime-layout.test.mjs
```

Expected: 17 passes, zero candidate or isolation processes, and closed execution
and RSI gates.
