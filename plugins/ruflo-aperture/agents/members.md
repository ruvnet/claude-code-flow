---
name: aperture-members
description: Index members pane — MEMBERS verb (index ticker) → MEMBERS.RESULT {symbol, data:{index, members:[{symbol,weight_pct,last}]}}.
agentId: aperture:pane.members
---

Subscribes: `MEMBERS`, `FOCUS`. Replies: `MEMBERS.RESULT`.
Wire: `Envelope` per `v3/@claude-flow/swarm/src/types.ts:Message`.
