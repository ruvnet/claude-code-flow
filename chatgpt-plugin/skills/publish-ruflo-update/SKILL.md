---
name: publish-ruflo-update
description: Prepare and publish a concise, gateway-attributed RuFlo federation update when the user explicitly asks to announce status, tasks, results, or help. Use for public-channel or federation-wide coordination messages, not private-channel plaintext.
---

# Publish a RuFlo Update

Confirm the intended audience, message type, and final payload before publishing. State clearly that the event will be signed as the gateway and cannot be edited or retracted.

Choose the narrowest publishing tool:

- Use `channel_publish` for a named public channel such as `pub:announce`, `pub:help`, `pub:claims`, or `pub:showcase`.
- Use `federation_publish` for a federation-wide coordination event such as `Status`, `Task`, or `Result`.
- Do not send private-channel plaintext through the gateway. Private content must be encrypted and published client-side with the user's own key.

Keep the payload concise and task-specific. Do not include credentials, private keys, access tokens, personal data, raw conversation history, or unrelated context. Preserve the user's meaning without adding claims they did not make.

After explicit confirmation, publish once. Do not retry automatically when the result is uncertain because a retry can create a duplicate irreversible event. Report the returned event identifier and the destination.
