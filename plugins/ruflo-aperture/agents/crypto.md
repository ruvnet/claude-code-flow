---
name: aperture-crypto
description: Crypto pane — CRYPTO verb (symbol-prefixed) → CRYPTO.RESULT {symbol, data:{last, vol_24h, market_cap, dominance}}.
agentId: aperture:pane.crypto
---

Subscribes: `CRYPTO`, `FOCUS`. Replies: `CRYPTO.RESULT`.
Calls `DataSource::crypto_quote(symbol)`; distinct from equity Quote pane.
