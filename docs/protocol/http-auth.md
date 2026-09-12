# RFP HTTP strict v1

Version 0.1.0 draft. This is a stricter application profile of [upstream NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md), not a replacement NIP. Upstream remains the normative source for the base wire format.

## 1. Base format

Use a signed Nostr kind 27235 event in the `Authorization: Nostr <base64>` header. Bind the absolute URL with the `u` tag, method with `method`, and body digest with `payload`. URL comparison includes the query. Validate the Nostr event ID and signature, not merely its fields. Authentication establishes the signing key; permission is a separate check.

## 2. Additional proposed requirements

1. Accept HTTPS only outside explicitly configured loopback tests. The server MUST derive its external URL from a configured origin and raw request target. Trust forwarded headers only from configured proxies. Do not sort queries, decode and reencode paths, strip a trailing slash, or follow redirects using the old proof. Clients sign the exact final URL without fragment or userinfo.
2. Require exactly one two-element `u` and `method` tag. Require uppercase method matching the request exactly. Require empty content. Reject duplicate security tags, duplicate JSON object members, malformed base64, invalid UTF-8, invalid event fields and unknown critical extensions. Ordinary unknown Nostr tags remain permitted.
3. Require safe integer `created_at` in Unix seconds and `abs(now - created_at) <= 60`. Keep clocks synchronized. Store authenticated event IDs atomically through `created_at + 61` seconds, including future dated events. A consumed proof MUST NOT cause a second side effect, including across processes or restart. Fail closed if the shared replay store is unavailable or full.
4. Require exactly one `payload` tag for every request with a nonempty body, and for every POST, PUT, PATCH or DELETE, including an empty body. Its value is lowercase SHA256 hex of the raw entity bytes passed to the application before JSON parsing, without content encoding. This profile rejects Content-Encoding other than absent or identity. Transfer framing is excluded from the hash. For an empty entity, hash the zero length byte string. If supplied on another method, validate it. Do not hash a parsed or reserialized object.
5. Limit the decoded authorization event to 8192 bytes and the request entity to 32768 bytes. Check limits before expensive cryptography and impose per-source admission limits. A larger upload requires a separately versioned profile.
6. Validate authorization and reserve the proof atomically before execution. A signature MUST NOT grant membership, admin role or the ability to publish on behalf of another identity. Gate sensitive operations by current capabilities, scope, audience, expiry and revocation. A restart durable operation ledger MUST suppress repeat effects even if the requester signs a fresh auth event for a retry. Use the signed application operation identifier defined in the message profile where applicable.

## 3. Failure and retry

Return 401 for invalid authentication or replayed auth proof, 403 for valid identity without permission, 413 for size violations, and 503 when safe replay or authorization checks cannot run. Do not return internal keys or invite codes in errors or logs. A transport retry generates a fresh auth proof but retains its application operation ID. A previous successful operation may return its recorded result; it MUST NOT execute again. A crash between a side effect and recording completion requires transactional integration or reconciliation, not a blind retry.

## 4. Compatibility and boundary

The inspected Ruflo client signs nonempty bodies. Receiver strictness, distributed replay persistence and proxy URL reconstruction are not proven by that client. Negotiate this profile through explicit endpoint configuration; do not silently reject legacy traffic on an existing endpoint without a migration window.

NIP-42 WebSocket challenges remain a separate handshake. An OAuth token passed to the gateway can authorize a gateway action but is not a Nostr signature by the OAuth subject. Never substitute Ed25519 ANS keys for Nostr signing keys. No new NIP number is assigned.
