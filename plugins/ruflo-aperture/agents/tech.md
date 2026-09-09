---
name: aperture-tech
description: Technicals pane — TECH verb (symbol + indicator: SMA|EMA|RSI|MACD) → TECH.RESULT {symbol, indicator, data:{symbol,indicator,value,...}}.
agentId: aperture:pane.tech
---

Subscribes: `TECH`, `FOCUS`. Replies: `TECH.RESULT`.
Wire: `Envelope` per `v3/@claude-flow/swarm/src/types.ts:Message`.
