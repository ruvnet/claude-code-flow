//! Yields pane — YIELDS verb (bare) → YIELDS.RESULT (treasury yield curve).

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::json;

use crate::agent_runner::verb;

pub struct YieldsPane {
    id: &'static str,
    source: MemoryDataSource,
}

impl YieldsPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.yields",
            source: MemoryDataSource,
        }
    }
}

impl Agent for YieldsPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("YIELDS") => match self.source.yield_curve().await {
                Ok(curve) => vec![reply(
                    &env,
                    json!({"verb": "YIELDS.RESULT", "curve": curve}),
                )],
                Err(e) => vec![reply(
                    &env,
                    json!({"verb": "YIELDS.RESULT", "error": e.to_string()}),
                )],
            },
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runner::panes::test_helpers::req;
    use serde_json::json;

    #[tokio::test]
    async fn returns_curve() {
        let mut p = YieldsPane::new();
        let outs = p.handle(req("YIELDS", json!({}))).await;
        assert_eq!(outs.len(), 1);
        assert_eq!(outs[0].payload["verb"], "YIELDS.RESULT");
        let curve = outs[0].payload["curve"].as_array().unwrap();
        assert!(!curve.is_empty());
    }
}
