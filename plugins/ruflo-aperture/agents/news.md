---
name: aperture-news
description: News pane — NEWS verb (per-symbol or global) → NEWS.RESULT {scope, data:{headlines}}.
agentId: aperture:pane.news
---

Subscribes: `NEWS`, `FOCUS`. Replies: `NEWS.RESULT`.
Calls `DataSource::news(symbol)`; bare verb returns global headlines.
