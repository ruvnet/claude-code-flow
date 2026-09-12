# RFP ANS: identity and name binding

Version 0.1.0 draft. Profile `ans-local-v2` describes the supported local API. Profile `ans-nostr-binding-v1` is proposed and unimplemented in the inspected source.

## 1. Authority and scope

A name is unique only inside one registry controlled by one pinned issuer. Implementers MUST identify names externally as the pair (trusted issuer, name); a bare name MUST NOT be interpreted as globally unique. Bootstrap issuer trust through operator configuration, not through an untrusted binding. This document does not claim compatibility with OWASP ANS, DNS, NIP-05 or X.509. Historical TypeScript code is outside the supported v2 profile.

## 2. Local binding wire object

The object has exactly seven members. Unknown members are rejected.

| Member | Type and requirement |
| --- | --- |
| `id` | String matching `[a-f0-9-]{36}`; issuer emits a random UUID. The legacy validator does not enforce UUID layout. |
| `name` | String matching `^[a-z0-9][a-z0-9._-]{0,63}$`; no automatic case conversion |
| `subject` | Ed25519 public key in SPKI PEM, at most 1024 characters |
| `issuer` | Ed25519 SPKI PEM; exact string equality with pinned issuer |
| `issuedAt` | Safe integer, Unix milliseconds |
| `expiresAt` | Safe integer, Unix milliseconds; greater than issuedAt; lifetime at most 86400000 ms |
| `signature` | Standard base64 encoding of 64 Ed25519 signature bytes, 88 characters with `==` padding |

Signing input is UTF-8 encoding of compact ECMAScript JSON serialization of this ordered array:

```json
["ans-v2", "id", "name", "subject PEM", "issuer PEM", 0, 3600000]
```

The displayed whitespace is illustrative. Implementations MUST produce the same bytes as `JSON.stringify(['ans-v2', b.id, b.name, b.subject, b.issuer, b.issuedAt, b.expiresAt])`. Object member order is irrelevant. PEM strings, embedded newlines and spelling are signed verbatim; do not normalize them after issuance. Sign with Ed25519 directly, with no additional prehash. A verifier checks the field constraints, pinned issuer, signature, and `issuedAt <= now < expiresAt`. Default issuance lifetime is 3600000 ms. The local implementation permits no future clock skew.

## 3. Registry and possession

Registration MUST validate the binding and atomically enforce name and ID uniqueness, revocation tombstones and configured capacity. Default capacity is 10000; supported configured range is 1 through 1000000. Resolution MUST recheck expiration and revocation. Revocation durably tombstones the ID and removes the active name. Reissuing a name requires a fresh binding ID; it is not continuity of the former subject. Expired rows currently remain until revoked; automatic expiry cleanup is not part of the inspected implementation.

The server generates a random 32 byte nonce encoded as 64 lowercase hex characters and records it with the exact audience string and a 60000 ms expiry. Audience is 1 through 256 ECMAScript string code units. The subject signs UTF-8 compact JSON:

```json
["ans-proof-v2", "binding ID", "nonce", "audience"]
```

Authentication MUST verify the active binding, subject signature, expected audience, stored nonce and unexpired challenge, and atomically consume the nonce with success. Concurrent reuse MUST yield at most one success. Proof verification alone does not implement this transaction. Existing `verifyBinding` and MCP verification do not consult revocation; they MUST NOT be represented as registry authentication. Database operators own filesystem protection, backup and issuer recovery.

## 4. Proposed Nostr identity binding

Keep the ANS binding unchanged. Publish a separate Nostr event using the message v1 profile with message type `IdentityBinding`. Its payload has exactly `binding`, `nostrPubkey`, `audience`, `notBefore`, `expiresAt`, and `subjectProof`. `binding` is the complete ANS object above. `nostrPubkey` is the lowercase 64 hex event author. `audience` is the exact configured federation identifier. Times here are Unix seconds and must be safe integers.

`subjectProof` is an Ed25519 signature in standard padded base64 over UTF-8 compact JSON of:

```json
["ans-nostr-binding-v1", "binding ID", "nostrPubkey", "audience", 0, 3600]
```

The last two values are notBefore and expiresAt. The receiver MUST verify both the ANS issuer binding and this subject proof, and the outer Nostr event signature. Require `notBefore <= now < expiresAt`, `notBefore < expiresAt`, `notBefore * 1000 >= binding.issuedAt`, and `expiresAt * 1000 <= binding.expiresAt`. Multiplication must remain in the safe integer range. Payload audience and outer message audience MUST agree. Outer expiry MUST equal payload expiry. Revocation status MUST be obtained from the authoritative registry for execution; if unavailable, fail closed. Offline display may show the binding only as revocation unchecked.

This is a proposed dual possession binding, not a conversion between curves. It grants no execution rights. Rotation revokes the old ANS binding, issues a fresh ID and publishes a fresh dual proof. Receivers invalidate cached old bindings. There is no automatic recovery from issuer compromise: operators must distribute a new trust anchor out of band. No HTTP discovery endpoint or global name consensus is assigned by this draft.
