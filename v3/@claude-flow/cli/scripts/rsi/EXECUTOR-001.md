# Fail closed isolated candidate executor contract

Decision: implement the operating system isolation and resource admission boundary
for future repair candidates. This increment does not authorize or execute a
candidate and does not create a new optimizer hypothesis or mission epoch.

`repair/executor-policy.json` freezes Bubblewrap 0.9.0 or newer, a fresh user,
mount, PID, IPC, UTS, cgroup and network namespace, all Linux capabilities
dropped, a new session, an empty environment, an allowlisted read only runtime,
read only candidate source, dedicated writable output, and no shell. The network
namespace must expose only internal loopback interfaces. The exact policy hash is
`84c079ec4d58d17bb63966bfe17924ed715c919cb46a7b6209d9836945608b9b`.

The launch inserts `prlimit` inside the sandbox before Node, limiting address
space to 512 MiB, CPU to five seconds, open files to 64 and processes to 16.
The parent limits wall time to five seconds and captured output to 64 KiB. These
are per process ceilings. They do not substitute for the unchanged mission wide
proposal of 36 candidate evaluations, 216 isolated starts and 1080000 summed
process milliseconds.

Only a fixed capability probe is executable. It checks that candidate source is
read only, the dedicated output directory is writable and all visible network
interfaces are internal. Probe success still cannot authorize candidate work.
The candidate reservation entry point always rejects because both a reviewed
resource authorization and a compatible isolation receipt are absent. Caller
supplied approval flags have no effect.

The `probe NEW_ABSOLUTE_RECEIPT` command creates an exclusive, fsynced receipt
and refuses overwrite. It binds the policy and executor bytes, kernel platform,
release and architecture, Bubblewrap version and binary hash, raw capability
result and bounded cost. An interrupted or negative receipt is never deleted or
converted into authorization.

The launch builder accepts canonical, non symlink directories and one basename
entry. It passes an argument vector directly with shell mode false. Candidate and
output directories must be separate. The runtime root is allowlisted rather than
mounting the host root, avoiding ambient access to credentials and unrelated
files. Candidate source is mounted read only and only `/output` is writable.

The policy retains the original mission head, anchor, seven epochs and 209784
native calls. Frozen, static, shuffled and previous controls are enumerated in
the same order. A policy mutation, additional control, changed budget, relaxed
namespace or local capability result invalidates the pinned policy hash.

On the current managed Linux host, Bubblewrap 0.9.0 has SHA256
`52231e1caf55bcbc667b269f49c63599a6f7db4767ae6a039580d0ff853db712`.
The fixed probe cannot create its namespaces and fails. The raw receipt records
the status, signal, timeout, stdout, stderr and elapsed time. This is useful
negative compatibility evidence. No fallback launcher is enabled.

This contract is reviewable source for a compatible runner. Before candidate
execution, rerun the fixed probe against the exact reviewed source, bind the
runner binary and kernel identity in a durable receipt, publish the resource
authorization, migrate without resetting legacy accounting, reserve work, and
then execute one frozen hypothesis. Candidate failures and all resource charges
must be retained.

MetaHarness and Autogenous add no measured value to a capability probe, so they
are not run in this increment. The largest unresolved question remains whether
inherited repair state improves descendant improvement capacity on fresh tasks.
This executor contract cannot answer that question or establish RSI.

## Acceptance

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/executor.test.mjs
```

Expected: eight passes, the current capability receipt reports incompatible,
and candidate execution plus RSI acceptance remain false.
