# Minimal runtime snapshot result

Decision: accept the corrected content-addressed runtime snapshot as a bounded
executor improvement. Candidate execution remains disabled and RSI is not
supported.

Reviewed source commit `ddb441b2c6e642c0ced99e6cfda30ebfac7e156c`
and tree `156bb32459f69d01feb8decc1f7dddf1eedb6a48` remove the mutable
whole-host `/usr` bind. The fixed probe now owns a minimal staged tree containing
13 reviewed entries and 132248416 regular-file bytes. Snapshot hash
`f4e1a04ccab31069b6eccf241207e2f6c45efae9e83bcb5ebd3b293f9ff16529`
binds the exact inventory to runtime-layout hash
`ccf90161f686638f6409a6f187631e5848713ed2f5174df47466018c5c5ae8f8`.

A read-only security review rejected predecessor source
`2c8cb50b8b0cb9f4b00cd579dedcbab9d88950c8` because cleanup accepted a
caller-forged directory and validation ignored writable or extra nested
directories. Both findings and the original reservation are retained. The
corrected source requires a module-owned object identity for cleanup and verifies
the complete file, symlink, and directory inventory with read-only directory
modes immediately before launch construction.

The first corrected-source workflow, run `34744138142`, then failed because the
local snapshot-mount assertion correction was omitted from its published tree.
That negative integration result is retained; final reviewed source includes the
missing executor test and does not rewrite the failed run.

Four source-bound unit runs passed 28/28 tests in 187, 158, 171, and 207 ms. Two
read-only host snapshot stages, full revalidations, and exact cleanups took 1017
and 1002 ms. The six Node validation processes therefore used 2742 ms summed
measured wall time. No Bubblewrap process, candidate, epoch, native call, MetaHarness check, or
Autogenous check ran. External provider spend was $0. Shell-wrapper, CI,
prepublication testing, acquisition, evaluation, and outer engineering dollar
costs remain unknown.

Dedicated workflow `34744268968` passed both jobs, all 203 focused tests, both
preserved signed negative replays, and all seven historical native epochs. The
earlier failed workflow is not discarded or relabeled.

The original mission remains at seven epochs and 209784 native calls. The next
blockers are a pinned Bubblewrap identity, compatible OS-isolation runner,
successful runtime startup/data-driven-load validation, and explicit approval of
the still-disabled 36-evaluation, 216-start, 1080000-ms repair proposal. The
largest uncertainty remains whether inherited failure-analysis state improves
descendant successor productivity on fresh tasks.

## Acceptance

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/runtime-snapshot.test.mjs
```

Expected: seven tests pass; corruption, undeclared paths, writable directories,
link escapes, overwrites, and forged cleanup ownership are rejected. Candidate
execution and bounded RSI acceptance remain false.
