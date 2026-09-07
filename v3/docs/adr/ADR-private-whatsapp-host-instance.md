# Private WhatsApp native HTTP instance

Status: source and disposable-fixture prerequisite, 2026-09-07. No public registration,
image change, hosted tool allowance, shared deployment, or permission to send.

`createProtectedWhatsAppHttpHost(registry, loadCurrentConfig, {port, tools})` is an
explicit application seam. It requires the already initialized native registry and
SQLite readiness before constructing the private approval descriptors. Ordinary
selected tools retain `callMCPTool`, including the existing policy and content guards.
The exact finite selection accepts the existing 23 bridge tools, two private approval names and two private
consume names plus four fixed request claim/publication names (31 total); it rejects
broad prefixes, duplicates, unknown names and collisions.
After registration the instance refuses additional registration, including the
pinned MCP server's startup system tools. A mandatory name authorizer independently
limits dispatch. No CLI loader, arbitrary module or environment activation was added.

Private prepare checks read policy for the following fixed conservative envelope
before entering the native helper: `hierarchical:semantic`,
`ruclip-api-whatsapp-group-assignments`, `ruclip-api-agent-settings`,
`ruclip-api-whatsapp-group-spend`, `ruclip-api-whatsapp-group-send-approval-requests`,
`ruclip-api-whatsapp-group-send-approvals`, `ruclip-api-whatsapp-human-approval-jti`,
and `ruclip-api-authority`. Apply checks these eight reads plus writes to approvals
and human JTI. These are eight/ten policy decisions, separately from native record,
SQL and HTTP counts. Requiring the executive namespace even for an owner may deny
an otherwise authorized owner operation; it grants no additional scope. Caller
arguments and context cannot choose project root, namespace, classification or
policy evidence. Policy denial returns the fixed `policy_denied` result before
native work. Existing policy modes retain their semantics; this factory does not
auto-enable enforcement or mint policy grants. These sequential policy decisions
are bounded observations, not an atomic policy-and-native-state snapshot.

Private results are compact JSON strings at the MCP boundary. The pinned server
pretty-prints object results; allowing that would change the embedded approval bytes
and break the independently computed approval digest. Signed input is untouched,
cache is disabled for both private tools, and held/unknown results are not retried.

`createReviewedWhatsAppConfigLoader(path)` requires an independently mounted
read-only directory, owned by the current OS user with exact mode 0700. The file
must be a regular, singly linked, same-owner file with exact mode 0600 and at most
32 KiB. The loader reopens the same canonical path on every call and validates the
six reviewed fields and current expiry. It checks bigint device/inode/size/mode,
owner/group/link count and nanosecond change/modification timestamps before/after
reading, rechecks directory metadata and mount evidence, and rejects invalid UTF-8,
ambiguous mounts, path escapes, nested mounts, symlinks and duplicate JSON keys.
Read-only single-file binds are rejected because host atomic replacement would
leave the old inode visible. Directory replacement is observed and invalidates an
existing approval instance. These are observation checks, not distributed fencing
or protection from a privileged unfenced host writer; synchronous filesystem stalls
are not bounded by an asynchronous timeout.

The two Rust hops still must authenticate the outer envelope, independently verify
the inner apply seal and consume the shared service nonce exactly once. This
factory neither authenticates network callers nor performs that nonce admission.
It binds only loopback and has no public installation path. Existing remote raw-write
protection and exclusive host/epoch fencing remain prerequisites. Native outcomes,
full history and original proof behavior are unchanged.

Validation includes real temporary-file permissions/rotation, policy denial for
every possible read/write scope, and actual pinned MCP 3.0.0-alpha.10 HTTP calls in
a network-none disposable container. The fixture uses the same default registry for
ordinary memory writes and approval prepare/apply, proves exact tool discovery and
built-in denial, compact approval digest, replay denial, SQLite 3.51.3/WAL/FULL, and
host atomic replacement through a real read-only directory bind. It records module
hashes and local timing; it is not authenticated two-hop or cold-host performance
proof. The first cold fixture exposed a missing default `.swarm` parent; the fresh
synthetic fixture creates that fixed parent before the first default registry
initialization. No alternate database path or latched-init retry is used.

The actual pinned child launcher remains `/usr/local/bin/entrypoint.sh` →
`/app/scripts/serve.mjs` → existing `RUFLO_BIN` child at 8081. A future reviewed
protected bootstrap can construct this instance in that child with the same native
registry. Existing 30-second health wait and three-minute same-child memory warmup
must be tested in the composed fixture; receiving an initialized registry here does
not establish those cold-start timings. The public/default CLI remains unchanged.

The consume continuation is specified in
[private consume adapter](ADR-private-whatsapp-consume-adapter.md). It preserves
this host's loader, ordinary policy path, compact result contract and registration
lock; consume checks its own exact seven-read/approval-write envelope.

## 2026-09-07 fixed request compatibility

The explicit private instance can now select four fixed request claim/publication tools in addition to its previous27 names (31 finite total). It checks seven fixed read namespaces (the prior envelope without human-JTI) and only the request namespace for either write. Ordinary tool policy and startup builtin exclusion are unchanged; request tools never enter the global registry. See [fixed request ADR](ADR-native-whatsapp-request-prerequisite.md) for current-authority, transient publication opportunity, strict INSERT/conditional UPDATE, counts and uncertainty limitations. No hosted configuration is enabled by this source extension.
