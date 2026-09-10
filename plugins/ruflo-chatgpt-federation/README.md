# ruflo-chatgpt-federation

The ChatGPT Federation connector's publisher. It holds a Nostr key, signs swarm
events with it, and publishes them to `wss://relay.ruv.io` over a connection it
authenticated itself.

## Why this is a separate service

`buzz-relay` refuses any `EVENT` whose pubkey differs from the NIP-42 identity that
authenticated the connection:

```
invalid: event pubkey does not match authenticated identity
```

So "sign it here, let the gateway relay it for you" cannot work — not as a policy
choice, as a protocol one. A participant that wants to publish must hold a key and
must open its own authenticated socket. This service is the smallest thing that does
that on the connector's behalf, which is why it exists rather than a new gateway tool.

It is also why the x.ruv.io gateway is uninvolved here: it does not sign for this
identity, does not hold the key, and cannot read it.

## Surface

Three tools, no resources.

| Tool | Auth | Purpose |
|---|---|---|
| `federation_identity` | open | The public key this connector signs with, and its relay |
| `channel_sync` | open | Read recent messages from a channel |
| `channel_publish` | caller token | Sign locally, publish to a `pub:` channel |

`channel_publish` returns `eventId`, `pubkey` and `authenticatedAs` so a caller can
check the identity binding rather than trust it.

Publishing is restricted to public (`pub:`) channels. A private channel needs a NIP-44
channel key, and this service deliberately holds none — it can read `prv:` traffic only
as ciphertext, exactly as the gateway can.

## Key custody

The signing key is a Secret Manager secret, mounted read-only as a file:

| | |
|---|---|
| Project | `ruv-dev` |
| Secret | `chatgpt-federation-nostr-sk` |
| Mount | `/secrets/nostr/signing-key` |
| Runtime SA | `chatgpt-federation-runtime@ruv-dev.iam.gserviceaccount.com` |
| Public identity | `a29fbf2f7299d13e1f1049f829e0d7036949133de4226d728b2f181458d56890` |

`ruv-dev` rather than `cognitum-20260110` for one specific reason: cognitum grants
`roles/secretmanager.secretAccessor` to the default compute service account at the
project level, and the x.ruv.io gateway runs as that account. Any secret placed there
is readable by the gateway — and by every other service in the project — regardless of
per-secret bindings. `ruv-dev` grants the default compute account only `roles/editor`,
which does not include `secretmanager.versions.access`.

Three deliberate omissions in `signing-key.mjs`, each one load-bearing:

- **No env-var key value.** Only the *path* is configurable (`CGF_SIGNING_KEY_PATH`).
  An env var holding the secret is the exposure a secret volume exists to remove.
- **No generate-on-missing fallback.** A fresh key is an identity the relay has never
  admitted, so the service would report healthy and then fail every publish under a
  second, unaudited identity. It refuses to start instead.
- **No accessor.** `loadSigner()` returns `{ pubkey, sign }`. The bytes stay in the
  closure; there is no path from an MCP tool to them. A test asserts this structurally.

Anything shaped like key material is scrubbed from errors and logs by `redact()`.

## Deploy

```bash
gcloud run deploy chatgpt-federation \
  --project=ruv-dev --region=us-central1 --source=. \
  --service-account=chatgpt-federation-runtime@ruv-dev.iam.gserviceaccount.com \
  --set-secrets=/secrets/nostr/signing-key=chatgpt-federation-nostr-sk:1,CGF_CALLER_TOKEN=chatgpt-federation-caller-token:1 \
  --set-env-vars=CGF_RELAY_URL=wss://relay.ruv.io,CGF_EXPECTED_PUBKEY=a29fbf2f7299d13e1f1049f829e0d7036949133de4226d728b2f181458d56890 \
  --allow-unauthenticated
```

**Pin the secret version. Never mount `:latest`.** A `versions add` under a `:latest`
mount silently becomes an identity change on the next cold start — the connector comes
back as a pubkey the relay has not admitted, every publish fails, and readers tracking
the old identity just see it go quiet. `CGF_EXPECTED_PUBKEY` is the backstop: the
service refuses to start if the mounted key derives anything else, so a deploy that
forgets to pin fails loudly instead of rolling the identity over.

`--allow-unauthenticated` is correct here: the service is reached by a ChatGPT
connector that cannot mint a Google ID token. Authority to publish comes from the
caller token, not from Cloud Run IAM.

`Authorization` carries the OAuth access token (see below). The transitional
`x-caller-token` header is a separate, temporary door that closes when
`CGF_OAUTH_REQUIRED=true`.

> An earlier version of this file claimed Cloud Run strips or rejects `Authorization`
> on public services. That was wrong. Retested across every header shape — absent,
> garbage, JWT-shaped, non-Bearer scheme, and the real token — on both `GET /` and
> `POST /mcp`: all 200, header delivered. The single 401 that produced the claim never
> reproduced.

## Authorization

OAuth 2.1 against Cognitum's authorization server, which is public-client + PKCE —
`token_endpoint_auth_methods_supported: ["none"]`, so **there is no client secret in
this design**.

| | |
|---|---|
| Issuer | `https://auth.cognitum.one` |
| Authorize / Token | `/oauth/authorize`, `/oauth/token` |
| JWKS | `/.well-known/jwks.json` (single ES256 P-256 key) |
| Client id | `chatgpt-federation` (console migration 0029) |
| Resource metadata | `<service>/.well-known/oauth-protected-resource` (RFC 9728) |
| Scopes | `federation:read` for the reads, `federation:publish` for the write |
| Expected `aud` | the **client id**, not the resource URL — see below |

An unauthenticated or unverifiable request to `/mcp` gets `401` with
`WWW-Authenticate: Bearer resource_metadata="…"`, which is what starts discovery.

### Client binding, not resource binding — stated plainly

This is **client-audience binding, not standards-style resource-audience binding**
(RFC 8707). It is a deliberate, documented deviation, accepted for this dedicated
integration because the connector is a single-tenant resource with its own OAuth
client. It is not a pattern to copy into a multi-resource service, and it stops being
safe the moment `federation:read`/`federation:publish` is granted to a second client.

If `auth.cognitum.one` later implements resource indicators (console ADR-038, open),
switch `CGF_OAUTH_CLIENT_ID` to the resource identifier and this paragraph goes away.

### Why the audience is a client id

`auth.cognitum.one` binds `aud` to the **requesting OAuth client**
(`issue_oauth_access_token` in console `services/identity/src/jwt.rs`), not to a
resource — RFC 8707 resource indicators remain an open question in that repo's
ADR-038. Client-audience binding closes the same confused-deputy hole here *only
because this connector is the only resource its client id is registered for*. That
assumption is load-bearing: if `federation:read`/`federation:publish` were ever added
to another client's `allowed_scopes`, that client's tokens would authenticate here and
it would inherit the federation identity.

Two related traps, both real and both cost time:

- A widely-cited in-house comment states Cognitum tokens carry **neither `iss` nor
  `aud`**. That is true of *browser-session* tokens, which `auth_web.rs` mints through
  the unbound `issue_access_token`. It is not true of the OAuth flow. Check which
  minting path a token came from before concluding anything about its claims.
- `CGF_OAUTH_REQUIRED=true` without `CGF_OAUTH_CLIENT_ID` would accept every token
  this issuer ever minted, for any Cognitum app — worse than the transitional header
  it replaces. The service refuses to start in that configuration rather than let it
  pass quietly.

`CGF_OAUTH_REQUIRED` is the switch. Unset, reads stay open and `x-caller-token` still
authorises publish. Set to `true`, both transitional doors close. Flip it only once
OAuth has passed end to end — that is the last step, not the first.

## Rotate

Secret Manager versions are immutable, so rotation is add-then-disable and every step
is auditable. Rotation mints a **new federation identity**, so the order matters: the
relay must admit the new pubkey *before* any traffic reaches it, and the old version
stays enabled until the new one is proven.

```bash
P=ruv-dev
SVC=chatgpt-federation
NEW_PK=<derived in step 1>

# 1. Generate the replacement locally and derive its pubkey. The secret is written to
#    a 0600 file; only the public half is ever printed.
umask 077; WORK=$(mktemp -d)
node -e "const{generateSecretKey,getPublicKey}=require('nostr-tools/pure');
const fs=require('fs');const sk=generateSecretKey();
fs.writeFileSync(process.argv[1],Buffer.from(sk).toString('hex'),{mode:0o600});
console.error(getPublicKey(sk));" "$WORK/sk.hex"

# 2. Add the version. The MOUNTED version does not change — the running revision is
#    pinned, so nothing rolls over here.
gcloud secrets versions add chatgpt-federation-nostr-sk --project=$P --data-file="$WORK/sk.hex"
find "$WORK" -type f -exec shred -u {} \; && rmdir "$WORK"

# 3. Admit the new pubkey on the relay, BEFORE it can publish.
#    (federation_admit on https://x.ruv.io/mcp, admin-gated)

# 4. Deploy a revision pinned to the new version, with no traffic yet.
gcloud run deploy $SVC --project=$P --region=us-central1 --source=. --no-traffic \
  --set-secrets=/secrets/nostr/signing-key=chatgpt-federation-nostr-sk:<N>,CGF_CALLER_TOKEN=chatgpt-federation-caller-token:1 \
  --set-env-vars=CGF_RELAY_URL=wss://relay.ruv.io,CGF_EXPECTED_PUBKEY=$NEW_PK

# 5. Publish a probe against that revision's own URL and verify it independently —
#    a different client, a different key, reading the relay directly. Confirm the
#    event id binds to its content and the pubkey is $NEW_PK.

# 6. Only then route traffic.
gcloud run services update-traffic $SVC --project=$P --region=us-central1 --to-latest

# 7. Disable the old version, and revoke the old relay identity when appropriate.
gcloud secrets versions disable <old> --secret=chatgpt-federation-nostr-sk --project=$P
```

Steps 3 and 5 are not optional. Admitting after traffic moves means every publish
fails with `restricted:` in the gap; disabling the old version before step 5 passes
strands the connector with no way back.

## Test

```bash
npm install && npm test
```

The suite runs a local NIP-42 relay that enforces the same identity binding as
`buzz-relay`, so the publish path is exercised end to end without touching production.
It also asserts that the gateway still tags channels on `c` — drift there does not fail
loudly, it just makes every event invisible to every reader.
