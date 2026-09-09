---
name: aperture-sentiment
description: Sentiment pane — SENTIMENT verb (symbol-prefixed) → SENTIMENT.RESULT {symbol, data:{symbol,score,label,sources:[{name,mentions_24h}]}}.
agentId: aperture:pane.sentiment
---

Subscribes: `SENTIMENT`, `FOCUS`. Replies: `SENTIMENT.RESULT`.
Wire: `Envelope` per `v3/@claude-flow/swarm/src/types.ts:Message`.
