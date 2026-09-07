# Private native WhatsApp approval adapter

Status: source prerequisite; no public registration or deployment.

The fixed native approval transaction now has two immutable MCP descriptors,
constructed explicitly with an already initialized registry and an independently
reloadable, reviewed host configuration. The factory does not discover configuration
from the environment or request. Rotation invalidates an existing factory instance.

`whatsapp_approve_prepare({requestJson})` accepts the exact compact approval delta
with a null expected snapshot digest. `whatsapp_approve_apply({requestJson,serviceSeal})`
accepts the same fixed delta with the prepared digest, plus the inner service seal.
Arguments are exact data properties, bounded in UTF-8 bytes; no storage selectors,
configuration, or authority-bearing MCP context is accepted. Native transaction
outcomes and logical/physical/SQL accounting pass through without success coercion,
caching, retries or reconstruction of signed bytes.

The embedding protected host must authenticate the outer MCP envelope at both
Rust hops. Apply has an independently signed inner seal over requestJson; both
seals bind identical subject, epoch, action, company, derived target, nonce and
timestamps, differing only in body digest. The backend consumes the existing
service-operation nonce once before invoking native apply. Prepare requires its
own authenticated read admission. The factory itself neither authenticates a
transport nor consumes this nonce; it is deliberately absent from public MCP
registries, generic memory bridges, host allowlists and images.

The host must retain its 16-dispatch, 256 KiB envelope, 2 MiB response and 8 MiB
aggregate limits and a common operation deadline. Native logical records and SQL
work are separate from dispatch counts. The native one-second deadline is
cooperative. `committed-held` and unknown acknowledgement retain durable liability;
neither means safe retry, release, refund or permission to send.

Validation uses actual local SQLite through the descriptors for approval/replay,
configuration rotation, absent native readiness, rollback-independent commit
uncertainty and post-commit withholding. A separate network-none fixture invokes
the compiled descriptors with the pinned image's existing registry handle and
SQLite 3.51.3/WAL/FULL, checks rollback, exact proof, configuration rotation,
lost acknowledgement without redispatch and replay after reopening the database.
It records the exact five compiled module hashes. It does not establish authenticated
end-to-end ingress, published image identity, live human enrollment or delivery.
