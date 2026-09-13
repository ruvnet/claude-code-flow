# Descriptor-bound snapshot verification

Decision: close the file-substitution and unbounded-read gaps identified by the
EXECUTOR-005 security review. This is a bounded executor hardening increment,
not a Bubblewrap capability result, repair trial, or RSI evidence.

Every staged source, staged destination, and pre-launch snapshot file is now
opened with `O_NOFOLLOW`. The verifier obtains its size and identity from the
opened descriptor, allocates no more than the 128 MiB file ceiling, performs
positional bounded reads, rejects truncation or growth, and confirms device,
inode, size, modification time, and change time are stable across the read.
Destination modes are applied through the opened descriptor before `fsync`.

The executor performs a second complete snapshot verification after host runtime
reinspection and immediately before its fixed Bubblewrap probe spawn. Bubblewrap
0.9.0 itself is now pinned to reviewed SHA-256
`52231e1caf55bcbc667b269f49c63599a6f7db4767ae6a039580d0ff853db712`
and 72160 bytes, copied into the private probe directory through the same bounded
descriptor path, and reverified immediately before execution. The host pathname
is never used as the isolation authority. The staging parent must be a canonical
mode-0700 directory. Policy, runtime-manifest, executor-source, staged-source and
staged-destination reads are bounded. New adversarial tests cover regular-file to
symlink substitution, the owned engine copy, and rejection of shared engine staging.

Node does not expose `openat2`/fd-relative recursive traversal here, so validation
is not atomically bound to the later pathname-based exec and mounts. This does
not claim to eliminate same-UID replacement races affecting the engine, probe,
snapshot paths, directory enumeration, output inspection, or cleanup.
Snapshot roots remain private `mkdtemp` descendants, cleanup requires the
module-owned object identity, and no caller-supplied candidate is executable.
A compatible clean OS-isolation runner remains required before the p-limit
witness can run end to end.

Spawn attempts are charged before production version discovery. If the host API
throws without a process identity, observed starts remain explicitly unknown.
Receipt wall time is labeled as ending before receipt persistence and cleanup;
complete engineering and dollar costs remain unknown.

No candidate evaluation, Bubblewrap start, mission epoch, native field call,
MetaHarness evaluation, Autogenous evaluation, provider spend, resource approval,
or proof-gate change is authorized by this increment.

## Acceptance

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/runtime-snapshot.test.mjs
```

Expected: nine tests pass, including descriptor-bound symlink substitution and
pinned private engine checks; candidate execution and bounded RSI acceptance
remain false.
