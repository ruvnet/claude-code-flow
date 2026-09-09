---
name: aperture-chart
description: Chart pane — CHART verb → ASCII (TUI) / canvas (WASM) OHLCV + HNSW patterns from ruflo-market-data.
agentId: aperture:pane.chart
---

Subscribes: `CHART`, `FOCUS`. Replies: `CHART.RESULT`.
Requests OHLCV from `agent.data` and pattern hits from `ruflo-market-data` over the bus (no FFI).
