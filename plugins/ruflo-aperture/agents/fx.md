---
name: aperture-fx
description: FX pane — FX verb (bare, optional `base`) → FX.RESULT {data:{base, rates}}.
agentId: aperture:pane.fx
---

Subscribes: `FX`. Replies: `FX.RESULT`.
Calls `DataSource::fx_rates(base)`; defaults base to USD.
