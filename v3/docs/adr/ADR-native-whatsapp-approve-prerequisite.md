# Fixed native WhatsApp approval prerequisite

Date: 2026-09-07
Status: Source implementation, unexposed. No MCP registration, bridge command,
allowlist, image, deployment, provider, send or consume activation.

## Trusted boundary

`createNativeWhatsAppApprover(registry, loadCurrentConfig)` is an internal module
factory. The embedding host owns the existing native registry and configuration
loader. HTTP fields must never select that loader, subject, epoch, revision or
keys. The factory validates, copies and freezes configuration, independently
reloads it before work and commit, and denies changed or expired configuration.

Config fields are exactly `subject`, `epoch`, `revision`, `expiresAt`,
`attesterPublicKey` (canonical base64url Ed25519 raw32), and `humanPublicKeys`
(1–16 reviewed key IDs to raw32 public keys). There are no private keys, defaults,
credential acquisition, refresh or configuration activation in this implementation.

Prepare accepts compact JSON with version1, kind `cognitum.whatsapp.approve.v1`,
companyId, groupId, approvedByMemberId, original assertion and
expectedSnapshotDigest:null. Apply requires the prepared digest and existing
`cognitum.protected-service-operation.v1` seal. Native verifies Ed25519 over exact
request bytes, including all assertion fields/digest, derived approval target,
company, action, configured subject/epoch, nonce and at most10s validity.

The helper does **not** authenticate HTTP/OIDC or consume a service operation
nonce. Future integration must first perform both existing ingress steps. An
operation nonce remains a separate transaction and liability boundary. No new
replay namespace or assertion of cross-store atomicity is introduced.

Original human Ed25519 verification independently uses current reviewed keys,
existing fixed-array domain, canonical ASCII and safe timestamps, five-minute
maximum TTL and30s issued-at skew. Digest is SHA256(canonical bytes || NUL ||
decoded64-byte signature), checked against the actual API/Rust synthetic vector.
Human v1 signs Slack user/email, not member ID or workspace. Exact current
canonical identity must equal `slack:` plus signed user ID; email is no identity
lookup. The unchanged assertion is stored in the API-compatible
`originalHumanApproval:{version:1,assertion,approver:{memberId,identityRef}}` with
unchanged legacy humanApproval summary. No old signature-less row is upgraded.

## Fixed state and effects

Prepare owns one read transaction; apply owns `BEGIN IMMEDIATE` on the same
already-open native SQLite handle. Assignment is read first inside the
transaction, then reused to derive the owner. There are9 owner records or11 for
an executive-other approver, including active company, assignment requiring
approval, canonical owner/agent, current settings, full ledger, published targeted
request, absent approval/JTI and, when needed, exact current approver/executive
grant. No caller-supplied authoritative rows or arbitrary replacement exists.

The full ledger must have valid historical rows, unique reservations/receipts,
consistent sums and valid route snapshots. Selected reservation must remain
reserved under current assignment version, route, command, source/inbound binding,
agent and cap. Request binds the exact five-field intent and canonical recipient.
`eventDelivered:false` is notification bookkeeping, never human consent.

Complete raw-row digest must match preparation. Two strict INSERTs create only
original JTI-use and approval; no other row changes. IDs hash exact namespace/key
with a distinct domain, avoiding the legacy colon/underscore cache alias. No
upsert, resurrection, schema initialization or history trimming is allowed.

Before COMMIT, current config, original human/service validity and retained row
validity are rechecked, including validFrom after backward-clock movement.
Failure after either insert rolls both back. Caller transactions are rejected
untouched. SQLite blocks competing writers; privileged same-handle hooks,
triggers, direct SQL and operator fencing remain trusted host constraints.

A known COMMIT followed by failed current release checks returns `committed-held`
with digest/counts and no approval content. COMMIT exceptions return conservative
`unknown`; no retry/refund or claim of no mutation follows. Transport loss still
requires ingress retained-marker handling. Provider dispatch is not atomic with
this transaction. This helper creates no send or consume permission by itself.

## Bounds and compatibility

Fixed9/11 records,256KiB per value,2MiB combined encoded records/writes,256KiB
request, full ledger at most10,000 rows within the byte cap. Owner apply reads7
found rows twice (14 returned rows,16 record SELECTs), adds2 INSERTs plus12
durability SQL and BEGIN/COMMIT:32 total statements. Executive apply:9 found,
18 returned,20 SELECTs,36 total. Prepare separately uses30/34 total statements.
Prepare+apply therefore reads18/22 logical records, not one disguised RPC read.
No existing hosted16-dispatch/8MiB cap changed; future ingress must account this
explicit native work. Counts mean returned rows, not engine scans or page I/O.

The one-second elapsed check is cooperative; synchronous filesystem/SQLite/COMMIT
may stall. Late committed results are held. Snapshot profile keeps simple
company/member IDs≤128, group/reservation IDs≤160 without slash, compact round-trip
JSON, unique key matches and strict RFC3339. Broader historical IDs, noncompact
JSON or ambiguous records need reviewed reconciliation. Slash-command and
namespaced-tool grammars match current API; intent/route field equality ignores
object key order while snapshot digest preserves exact bytes. Monetary sums keep
existing finite floating point and1e-9 tolerance.

## Validation and remaining work

Tests cover owner/executive paths, each authority category, signature/current keys,
time/config/state drift, strict replay/tombstones, injected fields, full-ledger
and byte bounds, rollback between inserts, unknown acknowledgment and late
committed-held release. Native fixture uses pinned SQLite3.51.3 WAL/FULL with the
actual registry handle, network disabled and no shared mounts. It proves rollback,
owner drift, writer exclusion, reopen replay and two simultaneous clients yielding
one approval. Its synthetic reset is test-only. Microfixture time is not evidence
of end-to-end speed or live provider behavior.

Remaining: reviewed native surface and both-hop ingress/accounting integration,
original operation nonce fence, fixed request claim/publication and approval
issuance path, fixed consume, complete-history migration and actual caller tests.
No shared identity, consent, key, grant, approval or provider send was created.
