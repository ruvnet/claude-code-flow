# Executor admission corrections and next executable comparison

Decision: close concrete probe execution and interruption defects before trusting
the p-limit executor. This increment implements the operator's p-limit-first
guidance. It does not complete the isolated workload or measure an inherited
improver. Candidate execution and RSI acceptance remain disabled.

The preceding source was `2e8924c6b39719cd5a61a84bb729a4ea8cd8df58`;
its focused CI [passed](https://github.com/ruvnet/ruflo/actions/runs/34734165833).
Its raw negative probe remains in `evidence/executor-probe-003.json` at evidence
commit `20daa44b3183c521494027f9684da698283c28a9`. The following findings correct
claims in EXECUTOR-001.md without replacing original evidence:

- The exported probe accepted a caller-controlled file named probe.mjs. It could
  reach the launcher without candidate authorization or a durable reservation.
  That export is removed. The only executing entry stages module-owned fixed bytes
  in a private temporary directory, then verifies their hash before spawning.
- The old receipt was written after execution. An interruption before publication
  could leave no record. An exclusive, fsynced reservation now precedes staging
  and both version/probe spawn attempts. It remains after success, failure or
  interruption; existing reservations reject automatic reuse. The reservation
  limits two parent spawn attempts and 6000 ms of parent waits; descendant counts
  are unknown. This is engineering accounting, not a new mission resource pool.
- Path-prefix checks admitted a nested directory named ..output. Segment-aware
  containment now rejects nesting in either direction, including those names.
- The old probe read /output although Node only permitted /workspace reads. Output
  verification now happens in the parent. No Node permission is expanded.
- Node permission denial did not prove a read-only OS mount; interface enumeration
  did not prove namespace separation or denied egress. The partial probe now names
  these unverified properties and always reports compatible false. A successful
  mocked probe is not measured OS isolation. The four control names in the policy
  do not implement matched control execution or accounting.
- Minimum engine version is checked before attempting namespace launch, with an
  empty environment and engine hashes checked around version discovery. This does
  not eliminate a same-user binary-replacement race or bind every runtime byte.
  Caller-provided replacement policy hashes cannot authorize a changed policy.

Unit tests mock process and engine responses to verify admission behavior. They
do not repeat the known failing Bubblewrap probe, run arbitrary candidate code,
or establish host compatibility. Exceptions model interruption while preserving
the reservation; that is not a measured kernel crash or distributed lock proof.
No new empirical HYPOTHESIS event is recorded. MetaHarness and Autogenous are not
rerun because this increment has no new candidate or descendant outcome.

## Remaining p-limit execution blockers

Read-only ELF inspection on this host found that both prlimit and pinned Node
request `/lib64/ld-linux-x86-64.so.2`. The current sandbox layout mounts /usr and
the selected /opt runtime, but creates no /lib64 path. Thus the launch can fail
before Node even on a namespace-capable host. A reviewed runtime layout must
resolve the loader from the same allowed runtime closure, reject missing runtime
dependencies before spawning, and bind exact runtime identities. Do not broaden
host mounts or silently change the frozen policy.

Next increment: complete that runtime layout and OS-specific verification for
fixed historical p-limit calibration on a compatible authorized runner, including
startup under the existing 512 MiB address-space ceiling. Startup at that ceiling
has not been validated; do not expand it to force success. Preserve the prior host
namespace denial. A compatible runner is necessary but does not authorize trials.

Then implement the smallest inherited failure-analysis procedure and fresh task
comparison described in REPAIR-LOOP.md. The proposed 36 evaluation / 216 start /
1080000 ms envelope still needs explicit operator authorization before trials.
Full dollar costs and separately controlled confirmation workloads remain absent.
The largest uncertainty is whether inherited changes improve descendants' ability
to create better successors on fresh tasks under matched cost.

## Acceptance

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/executor.test.mjs
```

Expected: 14 passes using simulated child responses, zero actual isolation probe
or candidate starts from this test file, and closed candidate/RSI gates. Measured
validation logs, exact source identity and unchanged ledger are published in
`evidence/executor-corrections/`. Do not treat passing tests as an improving agent.
