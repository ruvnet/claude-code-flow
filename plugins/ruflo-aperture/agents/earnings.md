---
name: aperture-earnings
description: Earnings calendar pane — EARNINGS verb (optional window_days) → EARNINGS.RESULT {window_days, events:[{symbol,date,estimate_eps,fiscal_period}]}.
agentId: aperture:pane.earnings
---

Subscribes: `EARNINGS`. Replies: `EARNINGS.RESULT`.
Wire: `Envelope` per `v3/@claude-flow/swarm/src/types.ts:Message`.
