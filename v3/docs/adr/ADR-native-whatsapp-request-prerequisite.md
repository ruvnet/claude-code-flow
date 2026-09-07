# Fixed native WhatsApp send-request claim and publication

Status: source implementation; private adapter only, no hosted activation.
Date: 2026-09-07.

The legacy request handler reads absence and replaces a `claimed` record through a process-local queue before BBS publication. Two API processes can both publish. These fixed transactions replace only that request bookkeeping. They do not send WhatsApp, create human approval, consume a send, mutate assignment/settings/budget or publish BBS.

## Fixed wire and trusted boundary

The private host may explicitly select four additional descriptors (31 total finite names including the existing23 ordinary + approve/consume4):

- `whatsapp_request_claim_prepare({requestJson})`
- `whatsapp_request_claim_apply({requestJson,serviceSeal})`
- `whatsapp_request_published_prepare({requestJson})`
- `whatsapp_request_published_apply({requestJson,serviceSeal})`

The claim delta has exactly version1, kind`cognitum.whatsapp.approval-request.claim.v1`, decoded companyId/groupId, intent, targetMemberId(null or exact member ID), expectedSnapshotDigest(null for prepare, lowercase SHA256 for apply). The publication delta has version1, kind`cognitum.whatsapp.approval-request.published.v1`, companyId/groupId/intent, claimDigest, eventEnvelopeId, eventDelivered and expectedSnapshotDigest. Intent is exactly intentId/reservationId/agentMemberId/agentBbsEnvelopeId/payloadSha256. Event ID uses existing safe ASCII grammar (1..256); no room, arbitrary event payload, namespace, database, SQL, config or human assertion input.

Targets are the exact existing encoded request key in `ruclip-api-whatsapp-group-send-approval-requests`. Inner seals bind raw compact delta, action`whatsapp.approval-request.claim` or `.published`, company/target, current configured subject/epoch and nonce with at most10s validity. The two authenticated Rust hops and their single domain-separated operation nonce admission remain independent prerequisites. The native factory does not authenticate network callers or consume ingress nonces. Its six-field reviewed host config remains unchanged; humanPublicKeys are validated config structure but not used as human approval proof by these service-only actions.

Native canonical state is read uncached through the initialized registry's SAME better-sqlite3 handle. `request-claim` is a new fixed read selector allowing absence for this exact tuple; original `request` still requires presence. No arbitrary optional namespace or cache fallback is added. Both read preparation and BEGIN IMMEDIATE application derive assignment/target inside their transaction. Company, active owner/agent/current target, settings, complete reservation ledger, exact current route/assignment/cap and optional executive authority are validated. Any existing approval denies this publication lane, including consumed approvals whose reservation has not settled. Thus duplicate requests also require current authority and may be withheld after human approval; no existing duplicate reopens a publication opportunity. Exact service-attested intent fields bind the reservation/agent but do NOT independently prove BBS envelope contents or payload bytes: the native helper never reads BBS. Current room/audience and external effect checks belong to the dedicated API publisher.

## Exactly one caller opportunity, not atomic external delivery

Only a strict claim INSERT whose COMMIT and final release checks succeed returns `committed` with the original API-shaped claimed request, compact-record digest and `publicationPermit`:

`{version:1,subject,epoch,revision,nonce,issuedAt,expiresAt,claimDigest,recipientMemberId,recipient}`.

Times/nonce derive from the verified inner seal; expiry is the smaller of seal/config expiry. The API must retain this receipt in a nonpersistent, single-use closure, consume it before its one external publication attempt and never reconstruct it from state. The native object is not itself an unforgeable bearer token or a distributed BBS dispatcher. Service callers must obey the protected ingress/exclusive-writer and dedicated publisher contract. Native tests prove one successful INSERT acknowledgement across competing connections, not an atomic SQLite/BBS transaction.

Existing matching records return `duplicate` with full request, compact digest, observedAt/counts, NEVER a permit. Duplicate claim_prepare performs the complete fresh authority check, so the API can compare it against its still-live original permit immediately before external publication. Changed recipient/intent denies. Snapshot drift on a still-absent claim denies. A race that discovers an existing exact claim returns duplicate even if the previous prepared digest is stale; it applies no mutation. Unknown, held and restart paths cannot obtain a new permit. This deliberately retains abandoned claimed requests when the original response/publication is uncertain.

Publication application requires the exact claimed-record digest (for duplicate published state, reconstruct only the original four null/claimed fields to validate it). It conditionally UPDATEs only content's eventState/eventDelivered/eventEnvelopeId/publishedAt and preserves every other field plus row metadata. Already-published identical results are duplicate; conflicting envelope/delivery results deny. The timestamp derives natively. `eventDelivered` is service-attested BBS acceptance/degradation, never proof of Slack receipt. There is no native room registration, BBS call, fallback-log append, transaction held across network I/O or implicit durable outbox.

## Bounds, outcomes and validity

All existing compact JSON256KiB request/value and2MiB snapshot+write limits remain. Native deadline is1s cooperative synchronous deadline, not preemptive SQLite/filesystem cancellation. Same WAL/FULL checks and trusted current loader/row-validity/config/seal/time rechecks execute before COMMIT and after it; backwards observation or expired final config denies release. Config rotation after insert/update rolls back. Successful late COMMIT returns `committed-held` (digest/counts, no request/permit). Lost actual COMMIT response returns `unknown:commit_unknown`; neither implies rollback or retry permission.

Owner branch has8 logical records; executive branch10. Two bootstrap records (assignment/request) are reused, not hidden. Fresh claim has n-2 returned records (request and approval absent); existing request has n-1. `recordRowsRead=2*rowsObserved`; `recordStatements=n+rowsObserved`. Read-only prepare/duplicate totalStatements=recordStatements+14; one INSERT or conditional UPDATE adds1, giving fresh owner claim29 and owner published30. The14 accounts for readiness queries/BEGIN/COMMIT in addition to record SELECTs. Bytes, logical tuples, returned physical rows and statements are distinct; returned-row counts do not bound engine scans/page I/O. This does not disguise native work as one of the historical16 remote RPCs or increase that old budget.

## Validation scope

Focused tests cover strict input/service binding, exact namespaces, history retention, current owner/executive/agent/company/settings/reservation/config revocation, tombstones/expiry, malformed/oversized data, transaction adoption, SQL failure, unknown and late-commit behavior. Actual pinned native16b SQLite3.51.3/WAL/FULL fixture uses independent worker threads/connections plus a barrier for one claim permit, and separate child processes killed with SIGKILL before/after COMMIT to distinguish rollback from retained liability. It preserves all reservation history; added test reservations are synthetic only.

Actual pinned MCP3.0.0-alpha.10 HTTP fixture exercises compact committed request/digest/permit, duplicate-without-permit, publication and prior approve/consume/ordinary-policy paths, exact tools/list/builtin exclusion and RO-directory config rotation. Synthetic HTTP/native proof is not authenticated Rust-chain or real BBS/provider proof. All fixtures are disposable, network-none; no new public registry, runtime configuration, grants, image build or deployment. Final exact source/test receipts are handed off separately.
