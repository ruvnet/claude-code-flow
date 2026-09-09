//! Movers pane — MOVERS verb (bare, optional `scope: gainers|losers|active`) → MOVERS.RESULT.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::{json, Value};

use crate::agent_runner::verb;

pub struct MoversPane {
    id: &'static str,
    source: MemoryDataSource,
}

impl MoversPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.movers",
            source: MemoryDataSource,
        }
    }
}

impl Agent for MoversPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("MOVERS") => {
                let scope = env.payload.get("scope").and_then(Value::as_str);
                match self.source.movers(scope).await {
                    Ok(data) => vec![reply(
                        &env,
                        json!({"verb": "MOVERS.RESULT", "data": data}),
                    )],
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "MOVERS.RESULT", "error": e.to_string()}),
                    )],
                }
            }
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
    async fn returns_default_gainers() {
        let mut p = MoversPane::new();
        let outs = p.handle(req("MOVERS", json!({}))).await;
        assert_eq!(outs[0].payload["data"]["scope"], "gainers");
        assert!(outs[0].payload["data"]["rows"].is_array());
    }

    #[tokio::test]
    async fn returns_losers_when_requested() {
        let mut p = MoversPane::new();
        let outs = p.handle(req("MOVERS", json!({"scope": "losers"}))).await;
        assert_eq!(outs[0].payload["data"]["scope"], "losers");
    }
}
