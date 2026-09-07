# Fixed native WhatsApp consume prerequisite

Date: 2026-09-07
Status: Unexposed source implementation. No MCP/tool registration, allowlist,
image, deployment, provider or send activation. Follows fixed approval4dd903dd.

## Exact interface and trusted boundary

`createNativeWhatsAppConsumer(registry, loadCurrentConfig)` follows the existing
native approver factory. It receives the already-open native registry and an
independently owned reviewed host configuration loader. No request selects keys,
subject, epoch or loader. Configuration has the same six exact fields, public
Ed25519 keys and finite expiry as approval. Construction does not authenticate
HTTP or consume an operation nonce: existing host/ingress admission remains
mandatory before any future exposed apply operation.

Prepare JSON contains exactly version1, kind `cognitum.whatsapp.consume.v1`,
companyId, groupId, intent (intentId, reservationId, agentMemberId,
agentBbsEnvelopeId, payloadSha256), dispatchId and expectedSnapshotDigest:null.
Apply replaces null with the prepared exact-state digest and requires the
existing signed service-operation envelope over all exact request bytes. The
fixed native verifier demands action `whatsapp.send.consume`, the derived
existing approval target, current configured subject/epoch and at most10s validity.
The action cannot be supplied as a generic mutation selector. Human signature
verification remains the ORIGINAL `whatsapp.send.approve` action, never a newly
invented human consume signature or renewed decision.

## Current state and one effect

Assignment and approval are read first INSIDE the native transaction, then reused
to derive owner, original canonical approver and original human JTI. Owner path
has8 records: assignment, approval, company, canonical owner, canonical agent,
settings, full reserved ledger and original JTI. Executive-other path adds exact
current approver and its active identity-bound trusted-seed executive grant (10).
The published request is not reread: its original binding is preserved in the
independently verified approval. Current approval revocation/state, canonical
identity, keys, settings, assignment and reservation all remain admission gates.

Native verifies the retained strict originalHumanApproval wrapper, complete
original Ed25519 assertion, current key/time, canonical approver association,
legacy summary, signature-inclusive digest, original JTI and usedAt, original
approvedAt and expiry, and exact intent. Missing legacy proof denies; no upgrade,
expiry extension or consent recreation exists. The complete ledger/current route,
source/inbound binding, assignment version, cap and reserved row reuse approval's
validators. A released/recorded/missing reservation cannot be consumed.

Apply owns BEGIN IMMEDIATE, repeats the complete state read and compares the raw
snapshot digest. Exactly one conditional UPDATE binds physical ID, exact
namespace/key and original raw content. Only content fields status='consumed',
consumedAt and dispatchId change. All unknown approval history, original signature,
expiry and row metadata remain; no ledger/JTI/other row changes. There is no
arbitrary setter, upsert or partial approval reconstruction. Replay denies even
when dispatch ID is identical; a recorded consume is never another send permit.

Final current configuration/time, original signature/service expiry and row
validity are checked before COMMIT. Any failure after UPDATE rolls it back.
COMMIT acknowledgment exceptions return unknown with retained liability. Known
commit followed by failed release checks returns committed-held metadata without
approval content; neither result grants retry/refund. Provider execution cannot
be atomic with this transaction, and future callers need durable dispatch and
uncertain-delivery handling. Privileged same-handle SQL/hooks and operator writer
fencing remain trusted host prerequisites, not claims made by this library.

## Bounds and evidence

The prior limits remain:256KiB request/individual value,2MiB encoded read+write
content, full ledger≤10,000 rows within byte bounds, cooperative1s elapsed guard.
Owner read:8 logical/found records,16 returned rows,16 record SELECTs. Apply adds
one UPDATE,12 readiness SQL and BEGIN/COMMIT:31 statements. Executive read:
10 records,20 returned rows/SELECTs;35 total statements. Prepare separately uses
30/34 statements. Bootstrap2 records are included/reused. Counts mean returned
rows, not engine scan/page I/O. No existing16 hosted-dispatch/8MiB cap increases;
future transport must account the explicit logical work, not disguise a batch.

Snapshot profile identifier/compact-JSON/RFC3339 reconciliation limits remain.
Original-proof approvedAt/expiresAt require canonical UTC ISO milliseconds, matching
the existing API wrapper. Unknown humanApproval summary metadata is retained.
Intent and human subject comparisons ignore object key order; snapshot digest
still binds exact row bytes. Full original unknown history is preserved. Existing
floating point/1e-9 ledger semantics remain unchanged.

Tests create real approvals through the new native approver before consuming.
They cover owner/executive paths, each current authority category, released
reservation, missing/tampered original proof/JTI, expiry/key/config drift, exact
intent/dispatch/service binding, full history/byte caps, UPDATE rollback,
committed-held/unknown and reopen replay. A pinned SQLite3.51.3 WAL/FULL fixture
uses the actual registry handle, then two real worker threads with independent
connections and a shared start barrier: exactly one consume commits. It also
proves release-before-consume denial, after-UPDATE rollback and unchanged ledger.
No paid/provider calls or shared data are involved.

Remaining: reviewed private native transport and both-hop action/nonce/accounting
integration, complete original caller compatibility, durable external dispatch,
request publication/approval issuance, and full-history shared migration. This
source alone does not finish or activate the WhatsApp send lifecycle.
