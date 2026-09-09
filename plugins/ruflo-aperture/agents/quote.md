---
name: aperture-quote
description: Quote pane — DESC verb → QUOTE.RESULT {symbol, last, change_pct, bid, ask, ts}.
agentId: aperture:pane.quote
---

Subscribes: `DESC`, `FOCUS`. Replies: `QUOTE.RESULT`.
Wire: `Envelope` per `v3/@claude-flow/swarm/src/types.ts:Message`.
