# Executable offline p-limit historical witness

Published implementation source: `65f98d0489876f6c359616603626c6c67e712b36`,
tree `ff3bc2b021a161bab40be66f5f7ed77f17ef1792`. Frozen measured plan:
`e1a2ceb10e0c1013a4eb7c571632a55befaa012a60e180064967b3e9c0b0ecce`.
Raw plan, reservation, stdout/stderr and results are in
`evidence/p-limit-offline-plan.json`, `evidence/p-limit-offline-run-001/`, and
`evidence/p-limit-offline.json`.

All 164 focused tests passed in 46384.288 ms, including ten new tests. All seven
historical epochs replayed from the original anchor. One separately measured
fixed witness run took 68.812 ms summed subprocess wall time across two starts;
both processes exited zero and produced the expected base 3/4 and fix 4/4 checks.
Preparation and execution CLI parents add two more Node process starts. Research,
acquisition, test descendants, CI and full dollar costs are not completely metered.
External provider spend was zero. There were no new mission epochs, native calls
or repair candidate evaluations. This is a historical fixture result, not a
measured repair optimizer improvement or independent RSI evidence.

This increment makes the frozen p-limit queue-clearing defect executable from
committed runtime payloads. It closes the runtime dependency gap for one public
historical witness. It does not implement a repair proposer, the complete upstream
AVA/XO/tsd environment, hidden tests, arbitrary candidate isolation or RSI.

The base is `df476048d023ff868cd45b35ee47f5fb0ca2b25a`; the known fix is
`f3e7f9ba364a9357bd912d136367d06c46660917`. Both unchanged `index.js` payloads
retain their original Git identities. Their package manifest and MIT license
come from the existing verified source pack. No source transformation is used.

The sole runtime dependency is yocto-queue. The new explicit development pin is
1.2.1, commit `ce72d41de87b2a4ec7c50e10480300bee674d845`, resolving annotated tag
`38094e00614829af560bfc151a55ee2d30e0a481` dated 2025-03-22. This satisfies the
base's declared `^1.2.1`; it does not claim to recover a historical lockfile.
Exact runtime source, manifest and license are preserved with Git blob IDs and
GitHub acquisition URLs in `repair/p-limit-dependency.json`. That dependency has
no further production dependencies. Neither npm install nor lifecycle scripts run.

The witness checks ordered mapping, invalid concurrency, argument forwarding,
and queue clearing that rejects waiting calls while preserving a running call.
A manually controlled promise removes timing-based scheduling assumptions. The
expected exposed historical result is 3/4 checks on base and 4/4 on fix. This is
one known bug lineage. These checks are public calibration, never sealed data.

Node 24.19.0 is required. A preparation record binds the actual executable hash,
platform, architecture, source modules, witness, payload hashes and original ledger
fingerprint. The binary is identified on the runner, not archived or independently
attested. A different runtime requires a new preparation record. This is not a
portable hermetic operating-system image.

Execution accepts only these two original revisions. It creates a new output
directory and fsyncs an exclusive reservation before starting either process.
Each process has a five-second timeout, 64 KiB output cap and 128 MiB V8 heap cap.
The heap cap is not a total RSS limit. Raw stdout, stderr, status, signal, timing
and measured child CPU are retained. Interrupted reservations remain on disk;
an existing output directory is never overwritten or recovered automatically.
The reservation is for engineering calibration and grants no mission resources.

The child receives a minimal environment and Node file permissions. Its reviewed
source has no network calls. These are fixture restrictions, not an adversarial
sandbox or proof of OS-level network denial. A host probe of Bubblewrap failed:
`Failed to create NETLINK_ROUTE socket: Operation not permitted`, exit status 1.
No relaxed sandbox fallback is provided for arbitrary candidates.

## Reproduce

From a checkout with Node 24.19.0:

```bash
node --test v3/@claude-flow/cli/scripts/rsi/repair/p-limit-offline.test.mjs
```

Expected: 10 tests pass, historical defect reproduced, all ordinary regression
checks pass, candidate execution and RSI acceptance false.

For a durable measured run, prepare a new plan path with
`p-limit-offline.mjs prepare NEW_PLAN`, then use the printed hash with
`p-limit-offline.mjs run NEW_PLAN HASH NEW_OUTPUT_DIRECTORY`. Keep the plan and
reservation even if the process is interrupted. Source and evidence commits are
recorded in the published result receipt. Tests and CI are additional engineering
work, excluded from the separately measured witness run.

The original seven epochs and 209784 native calls are unchanged. No empirical
optimizer hypothesis is executed in this increment. MetaHarness and Autogenous
are not rerun because the fixed historical witness supplies no candidate or
descendant outcomes for them to check. All previous negative evidence remains.

Next: implement the isolated candidate executor against a runner that supports
its required isolation, complete fresh development tests and inherited proposal
state, and obtain the already proposed repair resource authorization before
trials. The envelope remains 36 evaluations, 216 starts and 1080000 summed process
milliseconds, unapproved. Full research dollars and independent confirmation
inputs are still absent. This new executable calibration does not establish
descendant improvement capacity.
