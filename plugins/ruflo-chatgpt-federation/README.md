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
  --set-secrets=/secrets/nostr/signing-key=chatgpt-federation-nostr-sk:latest,CGF_CALLER_TOKEN=chatgpt-federation-caller-token:latest \
  --set-env-vars=CGF_RELAY_URL=wss://relay.ruv.io \
  --allow-unauthenticated
```

`--allow-unauthenticated` is correct here: the service is reached by a ChatGPT
connector that cannot mint a Google ID token. Authority to publish comes from the
caller token, not from Cloud Run IAM.

Send that token as **`x-caller-token`**, not `Authorization`. Cloud Run consumes the
`Authorization` header for its own IAM check and answers `401` before the request
reaches the container, so a token sent that way never arrives.

## Rotate

Secret Manager versions are immutable, so rotation is add-then-disable and every step
is auditable.

```bash
# 1. new key → new version. The value moves through a pipe; it is never written
#    to a file and never printed.
node -e "const{generateSecretKey}=require('nostr-tools/pure');process.stdout.write(Buffer.from(generateSecretKey()).toString('hex'))" \
  | gcloud secrets versions add chatgpt-federation-nostr-sk --project=ruv-dev --data-file=-

# 2. restart onto it
gcloud run services update chatgpt-federation --project=ruv-dev --region=us-central1 \
  --set-secrets=/secrets/nostr/signing-key=chatgpt-federation-nostr-sk:latest,CGF_CALLER_TOKEN=chatgpt-federation-caller-token:latest

# 3. read the new public identity, admit it on the relay, confirm it can publish
curl -s https://chatgpt-federation-875130704813.us-central1.run.app/ | jq -r .pubkey

# 4. only after federation continuity is confirmed
gcloud secrets versions disable <old> --secret=chatgpt-federation-nostr-sk --project=ruv-dev
```

Step 3 is not optional. A rotated key is a **new federation identity**: the relay must
admit the new pubkey (`federation_admit`) or every publish fails with `restricted:`,
and readers tracking the old pubkey will see the connector go silent rather than change
names. Disabling the old version before that is confirmed strands the connector.

## Test

```bash
npm install && npm test
```

The suite runs a local NIP-42 relay that enforces the same identity binding as
`buzz-relay`, so the publish path is exercised end to end without touching production.
It also asserts that the gateway still tags channels on `c` — drift there does not fail
loudly, it just makes every event invisible to every reader.
