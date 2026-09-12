# 0002: Useful tasks over an encrypted federation transport

Status: implemented as an opt-in package; public production deployment unverified.

## Problem

The execution proof accepted independently verified fixture artifacts, but lacked
remote transport, isolated workspace services, useful patch output and standard
task interfaces. A public channel delivery receipt cannot establish task execution.

## Decision

Preserve the SQLite signed-command authority and add an outbound authenticated
Nostr transport. NIP42 authorization acknowledges the exact signed challenge
response. NIP44 messages bind sender, recipient and hashed workspace tags.
Responses bind the exact command event ID. TLS is required outside loopback tests.
Retries reuse the inner signed request for idempotency; outer messages have fresh
nonces. Reconnects resubscribe, while command receipt retention remains 61 seconds.

Each workspace owns a separate database, audience and configured role set. Its
transport key is distinct from controller, worker and verifier keys. The bearer
task service selects the workspace and allowed operations from private local
configuration. HTTP task bodies cannot select an authority, credential or policy.

Scheduling reserves one task per available worker. Unpulled reservations expire.
Workers run trusted installed handlers and renew leases; independent validators
check the assigned input before submitting acceptance. A revoked lease prevents
artifact acceptance but cannot undo arbitrary external side effects.

Patch artifacts bind repository, immutable base, issue digest, test policy, patch
and resulting tree. The verifier repeats checkout, application and tests. Draft
publication repeats verification, checks current base and resulting GitHub tree,
and creates a deterministic branch without overwriting conflicts. GitHub tokens
stay with the controller. Retries reconcile an existing branch and PR.

Repository code requires working bubblewrap namespaces and finite cgroup v2 CPU,
memory and process limits. The current process must already be in the bounded
cgroup. This is deployment configuration, not a claim that the package provisions
resource isolation. The data-only JSON evaluator is available without code
execution. Never fall back from a failed sandbox to ordinary child execution.

Only controller-attested, signature-checked outcomes from pinned workers and
verifiers enter workspace memory. Learned routing filters authorization,
capability, availability and budget first. Exploration is opt-in and capped at
5% of eligible decisions in a router session. The reference benchmark uses
constructed specialization, not production embeddings or performance evidence.

## Validation

`npm test` covers signature and audience substitution, workspace separation,
reconnect and response fragmentation, a real child worker over local WebSockets,
independent verification, replay, renewal, cancellation, 100 recovery trials,
patch traversal and workflow refusal, wrong-task artifacts, failed sandbox
receipts, conflicting publication branches, MCP SDK calls and API scopes.

`npm run benchmark:routing` uses 12 signed training executions and 20 disjoint
synthetic evaluation inputs. The original benchmark and offline evidence replay
remain part of CI. Dependency audit and a pinned Ruflo source scan complement
manual trust-boundary review; clean scanner output is not a security proof.

Public x.ruv.io claim and development messages coordinate voluntary review. Tests
use locally controlled keys and a local relay fixture, so they do not demonstrate
execution by independently operated public federation members.

## Limits and rollback

The coordinator remains a single local SQLite authority with bounded state and
no distributed consensus or automatic archival migration. Remote patch artifacts
are limited to 12 KiB. MCP uses the pinned SDK; A2A is the advertised 0.3.0 subset.
The operator supplies repositories, trusted proposer, policies and enrollment.
Remove the optional services to roll back; no deployed gateway migration occurs.
