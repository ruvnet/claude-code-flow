# Pinned runtime-layout result

Decision: accept the structural runtime-layout correction as a bounded
engineering increment. It removes the known missing `/lib64` loader path from
the fixed isolation launch. It does not establish a compatible isolation host,
candidate execution, an improving descendant or RSI.

The reviewed source is commit
`5a3c6d7f12b2aa2efa9125a76ce5efd67f95bc49`, tree
`8e06d9673450a716fd80cf43354b2cac1f2f32cc`, with runtime-layout manifest hash
`6bcfdb29967558abbcff13c5cb4b3cbad9adeab85f6c15d3cd69de05e4c9b439`.
The production builder inspects fixed paths internally, validates both ELF
interpreters and canonical containment, emits constant `/lib` and `/lib64`
links, and rechecks runtime identities before a real probe spawn. Test-only
observation injection is guarded by Node's test context.

The source-bound runtime suite passed 11/11 checks in 94.968349 ms. A separate
read-only host inspection took 340.099475 ms and bound Node 24.19.0, `prlimit`
and the loader by SHA-256. These two Node validations total 435.067824 ms.
The dedicated bounded-RSI workflow run 34739540003 passed both jobs, including
all historical epoch replays and the new runtime-layout step.

No repair candidate, isolation probe, native field call, mission epoch,
MetaHarness evaluation or Autogenous evaluation ran. External provider spend
was $0. Acquisition, evaluation and outer engineering dollar costs remain
unknown. The legacy ledger remains unchanged at seven epochs and 209784 native
field calls.

PT_INTERP validation is not a proof of the transitive shared-library closure.
The previous namespace denial on this host remains preserved and was not retried.
The next acceptance is the fixed p-limit witness starting in the unchanged
Bubblewrap contract on a compatible runner, followed by explicit OS mount,
namespace and denied-egress checks. Candidate trials additionally require
operator approval for the unchanged proposed envelope of 36 evaluations, 216
isolated starts and 1080000 summed process milliseconds.

The largest uncertainty remains whether inherited failure-analysis state helps
descendants produce better successors on fresh tasks under matched cost.

## Acceptance

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/runtime-layout.test.mjs
```

Expected: 11 passes and no probe or candidate processes. Execution and RSI gates
remain false.
