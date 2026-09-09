---
name: aperture-export
description: Export pane — EXPORT verb {snapshot, format: json|csv|ndjson} → EXPORT.RESULT {format, body}.
agentId: aperture:pane.export
---

Subscribes: `EXPORT`. Replies: `EXPORT.RESULT`.
Formats host-supplied snapshot; host writes body to disk / clipboard / download.
