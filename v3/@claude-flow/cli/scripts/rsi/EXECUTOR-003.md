# Pinned executor runtime layout

Decision: remove the known ELF-loader defect from the fixed p-limit isolation
launch while keeping execution and resource gates closed. The previous launch
mounted /usr and pinned Node into an empty root, but both Node and prlimit request
`/lib64/ld-linux-x86-64.so.2`. Because `/lib64` did not exist inside that root,
a namespace-capable host could fail before Node started.

`repair/executor-runtime-layout.json` is a separate versioned contract. It does
not change the frozen executor policy or its resource proposal. The manifest pins
Linux x64, Node 24.19.0, the existing Node and prlimit paths, their exact PT_INTERP,
the allowed interpreter link and canonical path, and two synthetic links:
`/lib -> usr/lib` and `/lib64 -> usr/lib64`. Its hash is
`6bcfdb29967558abbcff13c5cb4b3cbad9adeab85f6c15d3cd69de05e4c9b439`.

`repair/runtime-layout.mjs` parses ELF64 program headers directly from the bound
binary bytes. It requires little-endian x86_64, exactly one absolute PT_INTERP,
bounded offsets and a terminating NUL. Admission checks both executables, the
pinned Node version and process path, canonical path containment, the exact
interpreter symlink, its regular canonical file, and hashes Node, prlimit and the
loader. Missing runtime mounts now reject instead of being silently skipped.

The production launch builder performs this fixed-path inspection itself. Its
only runtime-layout arguments are the two constant Bubblewrap symlinks above.
Test helpers can supply a simulated verified layout only inside Node's test
context; the production probe cannot accept such an observation. Immediately
before a real probe spawn, production repeats the runtime inspection and compares
all identities. Candidate source remains read only, output dedicated, capabilities
dropped and namespaces unchanged.

Eleven runtime-layout tests cover manifest drift, ELF class, byte order, machine,
absent/duplicate/relative interpreters, mismatched Node/prlimit loaders, path
escapes, link drift, missing executables and targets, and exact symlink arguments.
Executor tests also bind the launch ordering. These tests use synthetic ELF and
process responses. They run no isolation probe or repair candidate.

Read-only observation on the current development host confirms the specified
layout exists and binds all three files. This is source/runtime evidence on the
host, not sandbox-startup or OS-isolation evidence. PT_INTERP validation alone
does not prove the transitive DT_NEEDED library closure. The current host's prior
namespace denial remains preserved and is not rerun.

Next acceptance is fixed p-limit startup under the unchanged 512 MiB address
space and other limits on a compatible authorized isolation runner, followed by
explicit OS read-only mount, namespace-separation and denied-egress checks.
That runner evidence still cannot authorize repair trials. The proposed 36
evaluations, 216 isolated starts and 1080000 summed process milliseconds remains
unapproved.

The original ledger remains at seven epochs and 209784 native field calls.
No HYPOTHESIS, repair candidate, native call, MetaHarness result or Autogenous
result is created by this increment. RSI remains unsupported. The largest
uncertainty is whether inherited failure-analysis state improves descendants'
ability to produce better successors on fresh tasks under matched cost.

## Acceptance

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/runtime-layout.test.mjs
```

Expected: eleven passes using synthetic ELF fixtures, no probe or candidate
processes, and closed execution/RSI gates.
