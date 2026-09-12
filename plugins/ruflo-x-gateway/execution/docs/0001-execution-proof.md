# ADR 0001: A durable local execution authority before federated deployment

Status: implemented local proof; remote rollout pending.

## Specification

Input is an explicitly permitted deterministic task, budget and deadline.
Output is a result signed by a worker and independently accepted by a verifier,
with source-bound reproducible evidence. Actors are a controller, three workers
and a verifier. The business goal is evidence of completed work rather than
publication counts. No external side effects or production membership changes.

## Decision

Use Nostr signatures to match federation identity conventions. Run a SQLite
transactional authority independently of the existing gateway. Do not derive
execution ownership from a bounded channel replay. Embed native RuVector only
in the optional execution package, with pinned dependencies and a lockfile.

A single SQLite authority is cheaper and easier to test than distributed consensus
for this proof. It gives restart durability but limits deployment to one local
storage authority. An in-memory ledger would lose fencing and deduplication on
restart. A relay-only reducer cannot atomically arbitrate effects. A new distributed
service would add operational complexity before verifying the basic task contract.

## State machine and failure path

A permitted controller submits immutable input, assigns an eligible worker, and
the worker atomically pulls a lease. Pull increments the epoch and debits the
quoted attempt cost. The worker submits an artifact bound to input hash and epoch.
A disjoint verifier checks the artifact and accepts or rejects that exact hash.
An accepted task is terminal. Rejection or expiry requeues only within attempts,
budget and deadline. Cancellation fences pending work. A disconnected worker's
old epoch cannot submit after another lease is issued. Waiting workers wake on
assignment without a community scheduler tick.

## Trust boundaries

Signed envelopes are parsed and verified before reading command data. An event
body cannot override its signer. All roles and capabilities come from local policy,
not participant assertions. Ineligible work fails before budget debit or artifact
commit. The verifier is trusted for correctness, and its key is distinct from
worker and controller keys. Report signatures attest measurements, not billing.
No recorded private meeting data enters this public synthetic proof.

## Requirement to evidence

| Requirement | Executable evidence |
| --- | --- |
| Three signed workers, 20 correct results | benchmark.test.mjs |
| Real worker disconnect and retry | benchmark.test.mjs disconnect case |
| 100 expired owner rejection trials | coordinator.test.mjs |
| Persisted epochs, receipts and budgets | coordinator.test.mjs restart and two-connection cases |
| Capability, identity, audience and verifier restrictions | coordinator.test.mjs |
| Transport framing and event wake | service.test.mjs |
| Native RuVector eligibility and verified history | routing.test.mjs and evidence.test.mjs |
| Offline signatures, hashes and independent answers | evidence.test.mjs and src/evidence.mjs |
| Evaluation cannot promote | evaluation.test.mjs |

## Rollout and limitations

The service binds loopback and changes no existing gateway code. Public relay
transport, remote trust bootstrapping, MCP execution tools, A2A conformance,
production side-effect adapters, automatic promotion and hidden-task superiority
are follow-up work. A process-local proof does not establish independent remote
participation. CI stores source-bound signed reports. Rollback is to stop using
this optional package; no production database migration is involved.
