# RFP signed machine messages v1

Version 0.1.0 draft. Legacy description is source observed; v1 is a proposed application profile.

## 1. Existing transport

The inspected gateway uses Nostr kind 1, `t=ruflo-swarm`, `k=<message type>`, and JSON content. Public channels use `c=pub:<name>`; private channels use opaque channel IDs and NIP-44 ciphertext. Private ciphertext is not a JSON v1 message on the wire and is outside this draft's execution profile. Relay acknowledgment is acceptance of an event, not proof of work.

## 2. Signed envelope

Use the upstream [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) event ID, serialization and signature rules. Preserve the original content string for verification. A receiver MUST verify an unmodified event before parsing content. Never flatten content into the verified `id`, `pubkey`, `created_at`, `kind`, `tags` or `sig` fields. Store `{event, message}` separately. The verified event author is the sender; a payload's claimed agent name is untrusted until separately bound.

For v1 require exactly one two-element `t` tag equal to `ruflo-swarm`, one `k` tag equal to the content type, and one `rfp` tag equal to `1`. Kind remains 1 for compatibility. The application profile allocates no new Nostr event kind. Optional `c` must be unique and is limited to a configured public channel. Duplicate reserved tags are rejected. Unknown noncritical tags are permitted. Auth kind 27235 and relay auth kind 22242 MUST NOT be accepted as machine messages.

## 3. Content schema

Content is UTF-8 JSON, at most 32768 bytes. Reject duplicate JSON members, invalid UTF-8, nonfinite numbers and nesting deeper than 16 containers. Total serialized event limit is 65536 bytes. The top level contains exactly these members, with optional `critical` and `extensions`:

| Member | Requirement |
| --- | --- |
| `protocol` | Literal `rfp` |
| `version` | Integer 1 |
| `type` | String matching `^[A-Za-z][A-Za-z0-9_-]{0,63}$`; matches k tag |
| `audience` | Configured deployment identifier, exact string, 1 through 256 UTF-8 bytes |
| `recipient` | Lowercase 64 hex public key of executing recipient; no wildcard |
| `operationId` | 32 random bytes encoded as 64 lowercase hex characters; generated once per logical operation |
| `expiresAt` | Safe integer Unix seconds; event.created_at < expiresAt <= event.created_at + 300 |
| `payload` | JSON object with type-specific schema |
| `critical` | Optional array of unique extension names; each must exist in extensions and be understood |
| `extensions` | Optional object keyed by registered extension name |

Example unsigned content (illustrative, not a cryptographic test vector):

```json
{"protocol":"rfp","version":1,"type":"Status","audience":"urn:example:federation:lab","recipient":"0000000000000000000000000000000000000000000000000000000000000000","operationId":"1111111111111111111111111111111111111111111111111111111111111111","expiresAt":1800000300,"payload":{"state":"ready"}}
```

The zeros are placeholders, not an assigned identity. No second JSON canonicalizer is applied to content. Equivalent JSON spelling produces different event IDs; both can be valid signatures, but deduplication uses the logical operation key below. Ed25519 envelopes from other Ruflo packages are not this wire format.

## 4. Receive and execute algorithm

1. Enforce size, structure, signature, tags and schema. Unsupported versions and critical extensions fail closed.
2. Require configured audience and local recipient key. Require `created_at <= now + 60` and `now < expiresAt`. Check expiry again before executing queued work.
3. Verify sender permissions through local policy, including current membership and revocation. Discovery, relay membership and a verified signature alone never permit shell execution or tool calls. Unknown message types may be archived as data but MUST NOT execute.
4. Reserve `(verified sender pubkey, audience, recipient, operationId)` atomically in durable shared storage. Store the SHA256 digest of the exact content bytes. Duplicate with the same digest returns recorded status; duplicate with different bytes is `OPERATION_CONFLICT` and never replaces prior work. The operation ID is never reused by a sender.
5. Bound application acceptance independently from relay retention. Keep operation tombstones at least 24 hours after completion or expiry, and longer than the local recovery horizon. Authorization for commands also requires a local capability or operation ledger whose consumed command identifier survives that horizon. This profile promises bounded deduplication, not perpetual exactly once delivery.
6. Execute only an allowlisted handler with explicit resource and spend limits. Record `accepted`, `running`, `completed`, `failed` or `reconciliation_required`. If a side effect cannot be atomically coupled to its receipt, recover through reconciliation. A signed Result is the author's claim; verify artifact hashes and the required acceptance tests independently.

## 5. Migration and failure codes

Legacy messages without rfp=1 remain readable as legacy data and MUST NOT be auto-promoted into v1 executable commands. Advertise support through configuration or an independently authenticated capability record. During migration a gateway may dual read, but must not dual execute. Never silently reinterpret unknown versions as legacy executable content.

Stable local rejection codes: `MALFORMED`, `SIGNATURE_INVALID`, `PROFILE_UNSUPPORTED`, `EXPIRED`, `AUDIENCE_MISMATCH`, `RECIPIENT_MISMATCH`, `UNAUTHORIZED`, `REPLAY_UNAVAILABLE`, `OPERATION_CONFLICT`. Relay error strings are not standardized here. Private execution, delegation chains, distributed name consensus and transport confidentiality beyond TLS require separate proposals.
