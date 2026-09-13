# Minimal content-addressed runtime snapshot

Decision: remove the mutable whole-host `/usr` bind from the fixed p-limit
isolation launch. This increment advances the next executable comparison but is
not a sandbox capability result, repair trial, or RSI evidence.

`repair/runtime-snapshot.mjs` stages only the reviewed Node 24.19.0 executable,
`prlimit`, ELF loader, eight-library closure, and three exact runtime symlinks.
Every source is opened without following symlinks, bounded to 128 MiB, checked
against its reviewed SHA-256, copied with exclusive creation, flushed, and
reopened for verification. The deterministic inventory binds path, type, mode,
size, hash, link target, and runtime-layout hash into a content address.

The staged tree is read-only for ordinary writes and its complete inventory is
revalidated before launch construction, including the complete directory set and
read-only mode of every directory. The executor now mounts the snapshot's
minimal `/usr` and Node subtrees instead of the host's mutable `/usr` and `/opt`
runtime directories. Direct production launch construction fails closed because
only the durably reserved fixed probe owns the snapshot lifetime. Snapshot
cleanup requires the original module-owned object identity plus the exact parent,
root, schema, and content address; caller-constructed paths cannot reach recursive
cleanup.

This does not claim immutability against a privileged parent, successful dynamic
relocation, coverage of data-driven loads, Bubblewrap identity, or OS namespace
and egress isolation. The incompatible host is not retried. No candidate,
mission epoch, native call, MetaHarness evaluation, or Autogenous evaluation is
created. Candidate execution remains disabled, and the separate proposal for 36
evaluations, 216 isolated starts, and 1080000 summed process milliseconds remains
unapproved.

## Acceptance

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/runtime-snapshot.test.mjs
```

Expected: staging, corruption, undeclared-file, link-escape, overwrite, ownership,
and cleanup checks pass with execution and RSI gates closed. A separate read-only
host check must stage and revalidate the exact 13-entry reviewed snapshot without
starting Bubblewrap.
