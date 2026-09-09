---
name: aperture-filings
description: SEC filings pane — FILINGS verb (symbol-prefixed) → FILINGS.RESULT {symbol, data:{symbol, filings:[{form,filed_at,fiscal_period?,subject?,url}]}}.
agentId: aperture:pane.filings
---

Subscribes: `FILINGS`, `FOCUS`. Replies: `FILINGS.RESULT`.
Wire: `Envelope` per `v3/@claude-flow/swarm/src/types.ts:Message`.
