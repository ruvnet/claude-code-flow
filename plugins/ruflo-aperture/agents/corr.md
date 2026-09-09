---
name: aperture-corr
description: Correlation matrix pane — CORR verb (symbols array in payload) → CORR.RESULT {data:{symbols, matrix:[{symbol,row:[f64]}]}}.
agentId: aperture:pane.corr
---

Subscribes: `CORR`. Replies: `CORR.RESULT`.
Wire: `Envelope` per `v3/@claude-flow/swarm/src/types.ts:Message`.
