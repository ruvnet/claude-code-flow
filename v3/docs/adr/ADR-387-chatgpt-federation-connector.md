# ADR-387 — ChatGPT Federation Connector: a Participant That Holds Its Own Key

**Status**: Implemented
**Date**: 2026-09-11
**Related**: ADR-386 (swarm channels), ADR-388 (OAuth on x.ruv.io), console ADR-038 (MCP OAuth surface)
**Surfaces**: `plugins/ruflo-chatgpt-federation` (Cloud Run MCP service, project `ruv-dev`)

## Context

ChatGPT could read the federation through `x.ruv.io` and could not write to it.
The obvious fix — "let the gateway relay an event ChatGPT signed" — is not a
policy we declined. It is impossible:

```
invalid: event pubkey does not match authenticated identity
```

`buzz-relay` refuses any `EVENT` whose pubkey differs from the NIP-42 identity
that authenticated the connection. A participant that publishes must hold a key
and open its own authenticated socket. There is no relaying design.

So the connector needs a Nostr secret key, which raises the real question: where
does it live, and what stops everything else in the estate from reading it?

## Decision

A separate Cloud Run service that holds one key, signs with it, and publishes
over its own NIP-42 connection. Three tools, no resources:

| tool | auth | purpose |
|---|---|---|
| `federation_identity` | open | the public key it signs with |
| `channel_sync` | open | read a channel |
| `channel_publish` | scoped token | sign locally, publish to a `pub:` channel |

`channel_publish` returns `pubkey` and `authenticatedAs` separately so a caller
can **check** the identity binding rather than trust it.

### Key custody, and why it lives in `ruv-dev`

The secret is a Secret Manager secret mounted read-only at
`/secrets/nostr/signing-key`, with a dedicated runtime service account as the
only principal granted access.

It is in **`ruv-dev`, not `cognitum-20260110`**, and that is the load-bearing
part. Cognitum grants `roles/secretmanager.secretAccessor` to the default compute
service account at the *project* level, and `ruflo-x-gateway` runs as that
account — so any secret placed there is readable by the gateway and by every
other service in the project, regardless of per-secret IAM. Project-level grants
win. `ruv-dev` grants that account only `roles/editor`, which does **not**
include `secretmanager.versions.access`.

We tried the surgical alternative first: an IAM deny policy scoped to just these
secrets. `ruv@ruv.net` lacks `iam.denypolicies.create`, so it was unavailable.

Three deliberate omissions in `signing-key.mjs`, each with a test:

- **No env-var key value.** Only the *path* is configurable. An env var holding
  the secret is precisely the exposure a secret volume exists to remove.
- **No generate-on-missing fallback.** A fresh key is an identity the relay has
  never admitted, so the service would report healthy and then fail every publish
  under a second, unaudited identity. It refuses to start instead.
- **No accessor.** `loadSigner()` returns `{ pubkey, sign }`; the bytes stay in
  the closure. Asserted structurally, not by string matching.

### Authorisation: OAuth 2.1, audience-pinned

`auth.cognitum.one`, client `chatgpt-federation`, scopes `federation:read` /
`federation:publish`, public client + PKCE — **no client secret exists** in this
design (`token_endpoint_auth_methods_supported: ["none"]`).

The expected audience is the **client id**, not the resource URL. That server
binds `aud` to the requesting client (`issue_oauth_access_token`), which is
client-audience binding rather than RFC 8707 resource binding. It closes the same
confused-deputy hole *because this connector is the only resource its client id
is registered for*.

A widely-cited in-house note says Cognitum tokens carry neither `iss` nor `aud`.
That is true of **browser-session** tokens, which `auth_web.rs` mints through the
unbound path — not of the OAuth flow. Check which minting path produced a token
before concluding anything about its claims.

Credentials arrive **only through the transport**, never as a tool argument. A
credential passed as an argument is model-generated: it lands in the model's
context and in tool-call transcripts, and makes authority something the model can
be talked into supplying. A test asserts no tool exposes an argument matching
token/secret/password/credential.

## Consequences

- The connector is a first-class federation participant: its events verify
  against its own pubkey like any other member's.
- The gateway cannot sign for it, hold its key, or read it. That is by design and
  is enforced by project boundary, not by convention.
- Rotation mints a **new federation identity**. The new pubkey must be admitted
  and proven before the old secret version is disabled, or the connector strands.
  `CGF_EXPECTED_PUBKEY` is a startup assertion that turns an accidental identity
  rollover into a failed deploy rather than a silent one.
- Pinning the mounted secret *version* is required. Under `:latest`, a
  `versions add` becomes an identity change on the next cold start.

## Verification

Live against `wss://relay.ruv.io`, read back by an independent client using a
different admitted key, everything recomputed:

```
event id binds to content : true
signature verifies        : true
pubkey == connector id    : true
VERDICT                   : PASS
```

The relay's acceptance is itself the external proof that the event pubkey equals
the authenticated connection identity — it rejects the alternative. A local
NIP-42 relay enforcing the same rule covers the publish path in tests.

`scripts/e2e.mjs` is the repeatable check. It distinguishes **PENDING** from
**FAIL**: "we did not exercise this" and "this is broken" must not look alike.

## What this cost, so it is not repeated

- The read-back verifier first used a **freshly generated key**. On a
  membership-gated relay that key fails NIP-42, so the read returns nothing —
  indistinguishable from "the event is not there". Independence on a gated relay
  means *a different admitted member*, not an unknown one.
- A client-existence probe read the page **title**. Every rejection from
  `/oauth/authorize` is a 400 titled "Invalid OAuth Request", so the probe
  reported the same thing for a client that exists and one that does not. It was
  only caught by controlling it against a client known to exist.
