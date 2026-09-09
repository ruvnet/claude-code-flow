---
name: aperture-ivol
description: Implied-volatility surface pane — IVOL verb (symbol-prefixed) → IVOL.RESULT {symbol, data:{symbol,underlying_last,rows:[{expiry,strike,iv}]}}.
agentId: aperture:pane.ivol
---

Subscribes: `IVOL`, `FOCUS`. Replies: `IVOL.RESULT`.
Wire: `Envelope` per `v3/@claude-flow/swarm/src/types.ts:Message`.
