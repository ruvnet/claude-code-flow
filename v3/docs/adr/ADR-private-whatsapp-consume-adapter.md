# Private native WhatsApp consume adapter

Date: 2026-09-07
Status: source and disposable-fixture prerequisite. No public registration,
host allowlist, image, provider, shared deployment or send activation.

The existing reviewed `createNativeWhatsAppConsumer` is exposed only through
`createPrivateWhatsAppConsumeTools(registry, loadCurrentConfig)`. Like approval,
construction requires the already initialized registry and independently owned
current configuration. There is no database reopen, generic mutation, request
configuration, namespace or SQL selector. Existing native transaction/proof/state
modules and the host configuration loader are unchanged.

The fixed descriptors are `whatsapp_consume_prepare({requestJson})` and
`whatsapp_consume_apply({requestJson,serviceSeal})`. Each argument is an exact data
property; inherited/accessor/extra/symbol fields deny. Combined arguments remain
at most 256 KiB UTF-8; the seal is at most 16 KiB. The compact native request is:

```json
{"version":1,"kind":"cognitum.whatsapp.consume.v1","companyId":"fixture","groupId":"group:a","intent":{"intentId":"intent1","reservationId":"reservation1","agentMemberId":"agent1","agentBbsEnvelopeId":"envelope1","payloadSha256":"<64 hexadecimal characters>"},"dispatchId":"dispatch1","expectedSnapshotDigest":null}
```

These are synthetic placeholders, not a valid signed request. Apply uses the exact
prepared digest instead of null. The native service action is
`whatsapp.send.consume`; the stored original human assertion remains
`whatsapp.send.approve` without renewal. Prepare returns `prepared`, digest,
observedAt and counts. Apply passes through committed approval/digest/counts,
committed-held digest/counts without approval, or denied/unknown error unchanged.
The HTTP wrapper emits compact JSON text so embedded approval bytes match the
native receipt digest. Both descriptors are non-cacheable and never retry.

The private HTTP instance's finite selection now admits the existing 23 ordinary
names plus two approval and two consume names (27 maximum). Startup built-ins
remain excluded; a mandatory exact-name authorizer remains independent of the
registration lock. Ordinary calls still use `callMCPTool`; they cannot borrow
consume admission. The outer protected bridge must continue denying unauthorized
raw namespace mutations—this private native instance is not a standalone network
authority or replacement for the two Rust hops.

Consume checks seven fixed read namespaces before entering native work:
`hierarchical:semantic`, `ruclip-api-whatsapp-group-assignments`,
`ruclip-api-agent-settings`, `ruclip-api-whatsapp-group-spend`,
`ruclip-api-whatsapp-group-send-approvals`,
`ruclip-api-whatsapp-human-approval-jti`, and `ruclip-api-authority`.
Apply additionally checks only the approvals namespace for write. The published
request is not read by native consume; original JTI is read and never rewritten.
Requiring the executive read namespace for an owner is a conservative policy
restriction. Policy decisions are sequential observations, not a common atomic
policy/native snapshot. Native current canonical/configuration/reservation and
original-signature validation still runs inside its own transaction.

Transport integration must authenticate the action-bound outer envelope at both
Rust hops, bind the original intent, dispatch ID and prepared digest, independently
verify the inner apply seal and consume the existing shared service-operation nonce
once. The request carries no new human assertion. Native resolves/reverifies the
retained original proof, JTI, canonical owner and full reserved ledger before its
single conditional UPDATE. This adapter does not itself authenticate HTTP, consume
the service nonce or claim independent human verification by an upstream hop.
Legacy approvals without original proof remain withheld.

Native counts are unchanged: owner/executive paths have 8/10 logical records,
bootstrapRecords=2, rowsObserved=8/10, recordRowsRead=16/20 and
recordStatements=16/20. Prepare uses 30/34 total SQL statements and zero updates;
apply uses 31/35 and one update plus separately reported writeBytes. Returned-row
counts do not measure page scans. Policy decisions (7 prepare, 8 apply) and HTTP
requests are separate metrics. Existing 1-second cooperative native limit,
256 KiB request/value and 2 MiB snapshot-plus-write limits remain. No old hosted
16-call or 8 MiB budget is raised or hidden as a batch.

Tests exercise real SQLite through the descriptors and the actual pinned MCP HTTP
server over loopback in a network-none disposable container. They cover approval
compatibility, exact discovery/built-in denial, consumed digest/intent/dispatch,
released reservation and legacy-proof denial, seal substitution, current configuration
rotation, unchanged original proof/JTI/full ledger, replay, and lost/late commit
outcomes. Fixture-only restoration of owned synthetic approval content is explicitly
used to test independent failure scenarios; it is not a production recovery path.
The inherited reviewed native worker/connection contention proof remains unchanged.
No provider executes and neither unknown nor held results are converted to a retry,
refund or released approval. This is not authenticated two-hop/cold-start proof or
complete end-to-end WhatsApp delivery compatibility.
