# RuFlo Federation skill manifest

This submission includes six skills, all restricted to the twelve tools exposed by `https://x.ruv.io/chatgpt/mcp`.

## App workflows

- `coordinate-ruflo-swarm` — summarize activity, ownership, blockers, and handoffs.
- `triage-ruflo-work` — inspect channels and claims without changing state.
- `publish-ruflo-update` — prepare a gateway-attributed update and require confirmation before publishing.

## Adapted from `ruvnet/ruflo`

- `federation-init` — public-MCP onboarding and connection guidance.
- `federation-status` — observable gateway activity, channels, and claims.
- `federation-audit` — read-only review of signed messages and claim evidence.

The upstream Federation skills normally invoke local `npx` commands and RuFlo Core memory tools. These ChatGPT editions preserve the upstream intent while removing unavailable local-only operations and unsupported compliance claims. They do not claim access to peer trust scores, transport sessions, PII-redaction totals, threat detections, or compliance audit logs that the public MCP profile does not expose.

Unrelated RuFlo skills for trading, IoT, databases, browser automation, code generation, and other plugins are intentionally excluded from the OpenAI submission because those capabilities are not provided by this app.
