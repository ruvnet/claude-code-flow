# ADR-388 — OAuth 2.1 on `x.ruv.io/mcp`, Additively

**Status**: Implemented
**Date**: 2026-09-11
**Related**: ADR-386 (swarm channels), ADR-387 (ChatGPT Federation connector), console ADR-038 §3 (gated DCR)
**Surfaces**: `plugins/ruflo-x-gateway`

## Context

`x.ruv.io/mcp` is the federation's front door: 14 tools, reads open to anyone,
writes behind a single shared `adminToken`. A shared secret is the wrong
credential for a hosted MCP client — it cannot be scoped, attributed to a person,
or revoked for one holder — and ChatGPT's connector UI offers OAuth, No Auth, or
Mixed. There is no custom-header option, so "paste the admin token" was never
available anyway.

The constraint that shaped everything: **this gateway has existing participants.**
Closing anonymous reads or retiring `adminToken` would strand every agent already
connected. So OAuth had to be additive or not worth doing.

## Decision

OAuth 2.1 against `auth.cognitum.one` as a **second** way to earn write
authority. Reads stay open; `adminToken` keeps working; an access token carrying
`swarm:publish` is an alternative, per-user credential.

- RFC 9728 protected-resource metadata at both probed paths, with `resource`
  echoing **the identifier the client asked about** — a client given `<base>/mcp`
  gets `<base>/mcp` back, not the bare origin. Answering with the origin is a
  mismatch a client may reject silently during setup.
- Bearer validated against the issuer's JWKS. An unverifiable bearer is refused,
  **never downgraded to anonymous** — a caller that believes it is authenticated
  must not be quietly handed the smaller permission set.
- `401` + `WWW-Authenticate: Bearer resource_metadata="…"`, pointing at the
  metadata for the path that was requested.
- CORS preflight answered, and `WWW-Authenticate` exposed — without that a
  browser-origin client cannot read the challenge and never learns where to
  authenticate.

### Why `swarm:*` and not `federation:*`

Isolation between this resource and the ChatGPT Federation connector comes from
**audience pinning**, not scope names: each resource accepts only tokens whose
`aud` is its own client. Sharing scope names would in fact have been safe.

Distinct names are a **UX contract**: someone authorising the gateway should not
be told they are granting "federation" rights to something else. A scope name is
what a human reads on a consent screen; the audience is the security control.
(This corrects an overstatement in console migration 0029, which claims sharing
the scope would hand over the signing identity. It would not — audience pinning
prevents that.)

### Accepting dynamically registered clients

A client that self-registers through RFC 7591 gets `aud=dcr-…`, its own client
id — never `ruflo-x-gateway`. Pinning one audience therefore made dynamic
registration **useless**: every self-registered client was refused
`invalid_token` immediately after a successful sign-in.

This resource accepts its own client id **or any `dcr-` client**, because
registration constrains those to `swarm:*` / `openid` / `email` — this resource's
own scopes — so such a token is by construction minted for it. That acceptance is
exactly as strong as the registration gate: **if reserved scopes ever become
self-registrable, this stops being safe.** The two facts belong together.

Matching is a prefix check, not a substring check: `not-a-dcr-client` must not
pass. Verified by mutation.

### Refusing to offer OAuth unsafely

Without `RUFLO_OAUTH_CLIENT_ID` there is no audience to pin, so any token the
issuer ever minted for any Cognitum app would be honoured — a confused deputy
with write access to the federation identity. The gateway refuses bearer tokens
entirely in that configuration rather than accepting them unpinned.

### `adminToken` is optional in the schema

It had to become optional, or every OAuth-authorised write failed at *schema
validation* before the handler could consider the token. The protection moved to
the handler, and the test moved with it: a write with neither credential is still
refused. Credentials are never tool arguments in new surfaces — an argument is
model-generated, and lands in the model's context and transcripts.

## Consequences

- Existing participants are unaffected: anonymous reads and `adminToken` writes
  both keep working, verified live after deploy.
- A per-user token can be scoped and revoked without rotating a shared secret.
- The gateway is now a resource server with a real dependency on
  `auth.cognitum.one` being up for *authenticated* callers. Anonymous reads have
  no such dependency, which is part of why they stayed open.

## Verification

Live on `x.ruv.io` after deploy:

```
resource      https://x.ruv.io/mcp        (matches the identifier clients use)
invalid bearer → 401 + www-authenticate discovery pointer
anonymous read → 14 tools
adminToken write → ok, eventId 393547871c8dfbf8…
no credential  → refused
GET /mcp       → 405 in 0.21s
```

34 tests, including cross-resource replay refusal (a `chatgpt-federation` token
is refused here) and browser-session token refusal.

## Three bugs worth recording, because each looked like working code

1. **`GET /mcp` hung for 301 seconds.** Streamable HTTP permits a GET to open a
   server→client SSE stream, but this transport is stateless
   (`sessionIdGenerator: undefined`) so there is no session to attach one to. The
   SDK held the socket until Cloud Run severed it, logging "Truncated response
   body". Now `405` with `Allow: POST`. The same latent bug exists in the
   connector, masked only because enforcement `401`s first.
2. **A denied request left no trace.** The `401` was returned *before* the
   `mcp auth=` log line, so a rejected token logged nothing and the logs showed
   only `auth=anonymous`. Reading them produced the confident, wrong conclusion
   that no token had arrived. A log that cannot distinguish "no credential" from
   "credential refused" is worse than no log, because it is believed. Logging now
   happens first and records the reason and observed audience.
3. **`adminToken` required in the schema** made OAuth writes impossible while the
   code read as correct.
