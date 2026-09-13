# Pinned static dynamic-library closure

Decision: remove the unresolved transitive-library ambiguity from the fixed
p-limit isolation launch while keeping candidate execution and resource gates
closed. This is a structural runtime-admission improvement, not a sandbox
capability result or RSI evidence.

`repair/executor-runtime-layout.json` is upgraded to schema v2 with manifest
hash `ccf90161f686638f6409a6f187631e5848713ed2f5174df47466018c5c5ae8f8`.
It declares the exact ordered `DT_NEEDED` roots and reviewed SHA-256 identities
for pinned Node 24.19.0 and
`prlimit`, plus the complete reachable eight-SONAME closure:

- `ld-linux-x86-64.so.2`
- `libc.so.6`
- `libdl.so.2`
- `libgcc_s.so.1`
- `libm.so.6`
- `libpthread.so.0`
- `libsmartcols.so.1`
- `libstdc++.so.6`

Each entry binds its sandbox-visible path, canonical path, exact symlink target
when applicable, SHA-256, SONAME and direct dependency list. The manifest validator
rejects missing dependency nodes, duplicate SONAMEs, unsorted declarations and
unused additions. It remains a closed hash-pinned contract with both execution
gates false.

`repair/runtime-layout.mjs` now parses `PT_DYNAMIC`, `DT_STRTAB`, `DT_STRSZ`,
`DT_NEEDED`, `DT_SONAME`, `DT_RPATH` and `DT_RUNPATH` directly from bounded
little-endian x86_64 ELF bytes. It maps the dynamic string table through exactly
one in-bounds `PT_LOAD`, uses checked integer arithmetic, caps each ELF read at
128 MiB, requires `DT_NULL`, rejects duplicate dependencies and forbids runtime search-path overrides. No `ldd`, shell parsing, loader execution
or network access is used by admission.

Production inspection accepts no injected I/O or manifest path. A separately
named test-only API is guarded by Node's test context. Production reads every canonical library, validates its file or exact
symlink identity, re-parses SONAME and direct dependencies, verifies closure and
requires the reviewed SHA-256. The executor already repeats the complete runtime
observation immediately before any real probe spawn.

This is the declared static `DT_NEEDED` closure only. It does not cover `dlopen`,
NSS, locale, ICU or other data-driven runtime loads, nor claim ABI compatibility,
successful relocation, loader behavior, or OS isolation. Binding all of `/usr`
also exposes undeclared files. Those properties require the fixed p-limit witness to actually
start inside the unchanged Bubblewrap contract on a compatible runner. The
previous namespace denial on this host remains preserved and is not retried.

No HYPOTHESIS event, repair candidate, mission epoch, native field call,
MetaHarness evaluation or Autogenous evaluation is created. The separate repair
proposal remains unapproved: 36 candidate evaluations, 216 isolated starts and
1080000 summed process milliseconds. The original seven epochs and 209784 native
calls are unchanged.

## Acceptance

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/runtime-layout.test.mjs
```

Expected: all dynamic-parser, checked-arithmetic, size, hash, closure, drift and search-path tests pass without
an isolation or candidate process. Execution and RSI gates remain false.
