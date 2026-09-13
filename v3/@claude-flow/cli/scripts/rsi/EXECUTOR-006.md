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
reinspection and immediately before its fixed Bubblewrap probe spawn. A new
adversarial test replaces a declared regular file with a symlink and requires
fail-closed rejection.

Node does not expose `openat2`/fd-relative recursive traversal here, so this does
not claim to eliminate same-UID races in directory enumeration or cleanup.
Snapshot roots remain private `mkdtemp` descendants, cleanup requires the
module-owned object identity, and no caller-supplied candidate is executable.
Pinned Bubblewrap identity and a compatible clean OS-isolation runner remain
required before the p-limit witness can run end to end.

No candidate evaluation, Bubblewrap start, mission epoch, native field call,
MetaHarness evaluation, Autogenous evaluation, provider spend, resource approval,
or proof-gate change is authorized by this increment.

## Acceptance

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/runtime-snapshot.test.mjs
```

Expected: eight tests pass, including descriptor-bound symlink substitution
rejection; candidate execution and bounded RSI acceptance remain false.
