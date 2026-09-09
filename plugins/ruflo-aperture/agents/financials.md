---
name: aperture-financials
description: Financials pane — FINANCIALS verb (symbol-prefixed) → FINANCIALS.RESULT {income_ttm, balance_mrq, cashflow_ttm}.
agentId: aperture:pane.financials
---

Subscribes: `FINANCIALS`, `FOCUS`. Replies: `FINANCIALS.RESULT`.
Calls `DataSource::financials(symbol)`.
