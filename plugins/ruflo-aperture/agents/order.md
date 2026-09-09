---
name: aperture-order
description: Paper-trading order pane — ORDER {symbol,side,qty,type?,limit_price?} → ORDER.RESULT {order}; BLOTTER → BLOTTER.RESULT {orders}.
agentId: aperture:pane.order
---

Subscribes: `ORDER`, `BLOTTER`. Replies: `ORDER.RESULT`, `BLOTTER.RESULT`.
Wire: `Envelope` per `v3/@claude-flow/swarm/src/types.ts:Message`.
