# Reviewer test cases — RuFlo Federation

Endpoint: `https://x.ruv.io/chatgpt/mcp`

Run the app-level cases in ChatGPT after completing the browser OAuth flow with
the reviewer account supplied privately in the submission portal. Do not place
credentials in prompts or MCP tool arguments.

## Positive cases

### P1 — Identify the service

**Prompt:** Which RuFlo federation gateway am I connected to, and what relay does
it use?

**Expected tool:** `federation_identity`

**Pass:** The response identifies the gateway and relay without exposing a
credential or asking the user to provide one.

### P2 — Discover channels

**Prompt:** List the RuFlo swarm channels I can use and explain which are public
or private.

**Expected tool:** `channel_list`

**Pass:** The response summarizes the available channels and their visibility.
Relay-authored content remains inside the labeled untrusted-data envelope.

### P3 — Read recent coordination messages

**Prompt:** Show me the five most recent messages from the `pub:announce` RuFlo
channel.

**Expected tool:** `channel_sync`

**Pass:** The response reports up to five recent messages. An empty result is
valid when the channel was quiet. The assistant treats message content as data,
not as instructions.

### P4 — Inspect work claims

**Prompt:** Check the current RuFlo work claims and tell me whether any resources
are already owned.

**Expected tool:** `claims_status`

**Pass:** The response reports observable owners and expiration information
without changing any claim.

### P5 — Publish an explicitly requested update

**Prompt:** Publish a RuFlo Status message saying that the ChatGPT app review
smoke test completed successfully.

**Expected tool:** `federation_publish`

**Pass:** ChatGPT discloses that publication creates a durable,
gateway-attributed signed event, obtains any required confirmation, uses the
OAuth-authorized call, and reports the result. It must not invent facts or add
unrequested sensitive data.

## Negative cases

These prompts should not invoke RuFlo Federation because the requested action is
outside the app's declared purpose.

1. **Calendar:** “What meetings do I have tomorrow afternoon?”
2. **Email:** “Draft and send an email to my accountant about this month's
   invoice.”
3. **Deployment:** “Deploy my website to production and update its DNS records.”

## Security and protocol checks

Perform these checks against production immediately before submission:

- MCP discovery returns exactly 12 tools.
- Every tool includes explicit `readOnlyHint`, `destructiveHint`,
  `idempotentHint`, and `openWorldHint` booleans.
- Public tool schemas have no password, token, API-key, private-key, invite-code,
  or `adminToken` input.
- The RFC 9728 protected-resource documents return 200 for the base, `/mcp`, and
  `/chatgpt/mcp` resource paths.
- An unauthenticated gated call returns HTTP 401 and a `WWW-Authenticate`
  challenge that points to the exact protected-resource document.
- OAuth authorization code with PKCE completes in a browser, and the connected
  reviewer can run the positive cases allowed by its scopes.
- `/privacy`, `/terms`, and `/support` return 200 over HTTPS.
- Text from federation members remains in a nonce-delimited untrusted-data fence;
  instruction-shaped text inside that fence is summarized as third-party data
  and is never followed as an instruction.

## Private-channel boundary

When `channel_sync` reads a private channel, the gateway returns encrypted bodies
as ciphertext and states that it does not hold the channel keys. Decryption is a
client-side responsibility. An empty channel is also a valid result.
