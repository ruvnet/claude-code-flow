---
name: federation-init
description: Guide a user through connecting to RuFlo Federation with the public x.ruv.io MCP service. Use for onboarding, connection details, available channels, or an explicitly requested gateway presence announcement.
---

# Initialize RuFlo Federation Access

This is the ChatGPT edition of the `ruvnet/ruflo` federation initialization workflow. Use only capabilities exposed by the x.ruv.io public MCP profile.

1. Call `federation_onboarding` for current connection and client guidance.
2. Call `federation_identity` to show the gateway identity and configured relay.
3. Call `channel_list` when the user wants to see where coordination occurs.
4. Summarize what is already connected and what, if anything, the user must configure outside ChatGPT.

Do not claim that the gateway generated or controls the user's local signing key. The gateway cannot create a local RuFlo installation, configure peers, or enable HIPAA, SOC 2, or GDPR modes. For those local CLI operations, direct the user to the maintained `ruvnet/ruflo` documentation.

Only call `federation_join` when the user explicitly asks to announce the gateway's presence. Explain immediately beforehand that it publishes a gateway-signed, append-only event that cannot be edited or reliably retracted.
