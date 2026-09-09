---
name: aperture-corpact
description: Corporate actions pane — CORPACT verb (symbol-prefixed) → CORPACT.RESULT {symbol, data:{events}} (splits, dividends, M&A).
agentId: aperture:pane.corpact
---

Subscribes: `CORPACT`, `FOCUS`. Replies: `CORPACT.RESULT`.
Calls `DataSource::corp_actions(symbol)`.
