# Federation execution and useful task capabilities

Turn a bounded task into an independently checked artifact, with evidence of who
submitted, executed and verified it. This opt-in package runs beside the existing
x gateway. It does not replace the deployed OAuth gateway or mutate the public relay.

## Run

Requires Node 22.18 or newer and a platform supported by `@ruvector/core`.

```sh
cd plugins/ruflo-x-gateway/execution
npm ci --ignore-scripts
npm test
node src/benchmark.mjs > /tmp/federation-proof.jsonl
node src/evidence.mjs /tmp/federation-proof.jsonl
node src/benchmark.mjs fixed disconnect > /tmp/federation-recovery.jsonl
node src/evidence.mjs /tmp/federation-recovery.jsonl
```

The benchmark runs `single`, `fixed`, and actual native `ruvector` modes on the
same 20 arithmetic, sorting and graph fixtures. Workers execute in separate local
processes with distinct Nostr keys; a separate verifier uses different algorithms.
Keys travel over child-process IPC, never command lines or report files. These are
locally controlled identities, **not independently operated remote hosts**.

Single mode uses one general worker. Fixed and RuVector modes use three workers,
one per capability. History starts empty. This establishes native integration and
routing eligibility, **not an adaptive routing advantage**. Eight-dimensional
fixture vectors encode capability; they are not learned language embeddings.
Quoted costs are synthetic and equal per attempt; retry cost is included. Timings
include startup, signing, routing, persistence and verification. Per-task latency
is measured from run start, not worker service time. Use repeated, interleaved runs
before comparing modes; no performance claim follows from one run.

`disconnect` kills a real worker process after it acquired a task. The controller
withholds the old artifact, waits for lease expiry and starts a replacement with
the same identity. Completion requires a newer epoch and another attempt.

## Authority and evidence

* A SQLite transaction owns assignment, finite leases, epochs, budget debits and
  artifact acceptance. The Nostr channel claims view remains advisory.
* Every command carries a Nostr signature, audience, timestamp and request ID.
  Only configured public keys may act. Workers cannot expand their capabilities;
  controller, worker and verifier keys must be disjoint.
* Only the verifier can mark an artifact complete. It must bind the current task,
  epoch and artifact hash. Expired, cancelled and superseded attempts cannot commit.
* Exact request replay returns the original receipt without another budget debit.
  Commands expire after about 30 seconds; receipt retention is 61 seconds. Task
  identity and completed artifact state persist beyond that window.
* Signed submission, result, verification and full-report envelopes accompany
  each proof. `evidence.mjs` rechecks signatures, input hashes and independent
  fixture answers. Its default mode establishes self-contained integrity, not
  externally trusted identities. Supply pinned controller/verifier keys to the
  library `verifyReport` and `historyFromReport` functions to enforce external trust.
* `historyFromReport` only admits these validated bounded fixture outcomes, with
  attested measurements. Route only within one authorized history partition.
  Generic production artifact verification requires its own verifier adapter.

The coordinator implements `submit`, `register`, `heartbeat`, `assign`, `pull`,
`wait`, `renew`, `result`, `verify`, `cancel`, and restricted `status`, `worker_list`,
`task_get` and paginated `task_list` commands.
`wait` is an authenticated long poll that wakes immediately on assignment;
three-hour community coordination is not on the execution critical path.
`createExecutionServer` binds only loopback. The optional relay and task services
described below add authenticated interfaces. Task payloads cannot select shell
commands, credentials, verifier policy or workspace authority.

## Evaluation and governance

```sh
node src/evaluation.mjs baseline.jsonl candidate.jsonl
```

The evaluator emits a review receipt, never a promotion. It holds insufficient
runs, task/budget differences, dirty or unfingerprinted sources, repeated evidence,
fault trials, cost/latency regressions and immaterial improvement. Default is at
least five runs per candidate and at least 5% improvement without regressions.
This is a screening rule, not a significance test. Measurements are controller
attestations. External promotion must enforce ADR-322A, verify trusted experiment
identities, and use hidden tasks distinct from learning data. The checked-in 20
fixtures are public acceptance cases and cannot establish generalization.

## Storage and operational boundaries

Use a dedicated local database path with a private parent directory. Database
permissions are 0600 and transactions use full synchronous durability. Policy
changes fail closed against the stored policy fingerprint. Backwards clock
movement fails closed. SQLite supports a single shared local authority, including
restart and multiple connections on one filesystem; this is not a distributed
consensus service. Do not place its database on a network filesystem.

Accepted artifact storage is the only committed side effect in this proof. The
fencing guarantees do not automatically cover arbitrary external API calls. Such
systems need their own transactional idempotency/fence checks. Deadlines cap lease
renewal. State is bounded to 1,000 tasks and 10,000 recent requests/log entries;
use new experiment databases or a reviewed archival migration when full.

Native routing searches all supplied verified examples for correct filtering.
It is a small-corpus reference, not a demonstrated scalable ANN optimization.
Native handles lack an explicit close API on the pinned version; the bounded
benchmark process exits after its run. Use fresh storage paths per routing build.

## Implemented follow-up capabilities

| Capability | Interface | Enforced boundary |
| --- | --- | --- |
| Encrypted relay execution | `createRelayAuthority`, `createRelayClient` | NIP42 challenge ACK bound to event ID, NIP44 encryption, exact audience and sender pins, response binding and bounded fragmentation |
| Workspace isolation | `WorkspaceRegistry` | Separate private SQLite directory, authority policy and audience per workspace |
| Worker execution | `runWorker` | Trusted installed handlers, lease renewal, cancellation signal and fenced result submission |
| Scheduling and verification | `scheduleOnce`, `verifyOnce` | Worker reservations expire, independent capability validators decide acceptance |
| Issue to verified patch | `createPatchAdapter` | Allowlisted local mirror, immutable base SHA, bounded patch, fresh independent checkout and controller test policy |
| Draft PR publication | `createPatchPublisher` | Reverification, exact Git tree, deterministic branch and controller-held GitHub credentials |
| Task API and console | `startTaskService` | Per-token workspace and scopes; real MCP SDK; A2A 0.3.0 subset; only verified artifact retrieval |
| Persistent learned routing | `OutcomeMemory`, `createAdaptiveRouter` | Pinned signed receipt chain, workspace partition, deterministic fallback, optional exploration at most 5% |

Run `npm run task:serve -- /absolute/config.json` or
`npm run federation:serve -- /absolute/config.json`. See
[configuration and key ownership](CONFIGURATION.md) for the two service formats.
The relay service uses outbound TLS WebSockets; it does not deploy or reconfigure
the public x.ruv.io gateway. Task service defaults to loopback; remote binding
requires explicit configuration and an operator-managed TLS reverse proxy.

`runWorker` accepts an authenticated request client and a map of trusted handlers.
Use `createPatchCapability` to bind patch handlers and validators to local policy.
Workers submit artifacts; a separate verifier client runs `verifyOnce`. The
controller uses `scheduleOnce` and invokes draft publication only after acceptance.
Handlers must honor AbortSignal before side effects. Lease fencing covers the
artifact transaction, not an uncooperative handler's external side effects.

Patch tasks default to an 8 KiB patch and a 12 KiB artifact to fit the signed
command limit. Repository symlinks, submodules, binary edits, path traversal and
workflow edits are refused. The declarative JSON evaluator executes no repository
code. Bubblewrap additionally requires bounded cgroup v2 memory, process and CPU
limits, and fails closed if unavailable. This environment could not validate actual
bubblewrap execution; its capability test reports a skip, never an insecure fallback.
Refresh credential-free local mirrors through a trusted controller workflow.
The proposer is an injected local function or trusted model integration; this
package does not assume a model provider or distribute model credentials.

`npm run benchmark:routing` trains on 12 signed synthetic executions and evaluates
20 disjoint inputs with overlapping worker capabilities. Fixed routing verified
10/20 and native RuVector 20/20 at equal quoted cost in the reference workload.
Worker specialization is constructed; this is an integration regression, not a
production or state-of-the-art claim. Rebuild the router after admitting new
outcomes; only pinned controller-attested receipts may enter persistent memory.

MCP has actual SDK protocol tests. The A2A adapter explicitly supports structured
`message/send`, `tasks/get`, and `tasks/cancel` only. Streaming, continuation and
push notifications are unsupported. Do not advertise full A2A conformance.

Local WebSocket tests exercise authenticated relay messages and reconnects. Public
swarm development notices are coordination evidence, not evidence that independent
remote hosts executed this code. Production rollout still requires enrollment,
durable host provisioning, TLS and sandbox capability validation on that host.
Rollback removes the opt-in services. See [the original architecture decision](docs/0001-execution-proof.md)
and [the follow-up decision](docs/0002-useful-capabilities.md).
