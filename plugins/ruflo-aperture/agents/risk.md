---
name: aperture-risk
description: Risk pane — RISK verb (bare; optional `symbols` list) → RISK.RESULT {data:{rows}} per-symbol metrics.
agentId: aperture:pane.risk
---

Subscribes: `RISK`. Replies: `RISK.RESULT`.
Calls `DataSource::risk_metrics(symbols)`; host attaches watchlist when omitted.
