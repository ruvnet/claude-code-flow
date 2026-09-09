---
name: aperture-insider
description: Insider pane — INSIDER verb (symbol-prefixed) → INSIDER.RESULT {symbol, data:{trades}}.
agentId: aperture:pane.insider
---

Subscribes: `INSIDER`, `FOCUS`. Replies: `INSIDER.RESULT`.
Calls `DataSource::insider_trades(symbol)`.
