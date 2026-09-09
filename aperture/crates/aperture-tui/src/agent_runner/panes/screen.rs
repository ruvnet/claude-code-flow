//! Screener pane — SCREEN verb (bare, optional `criteria`) → SCREEN.RESULT.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::{json, Value};

use crate::agent_runner::verb;

pub struct ScreenPane {
    id: &'static str,
    source: MemoryDataSource,
}

impl ScreenPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.screen",
            source: MemoryDataSource,
        }
    }
}

impl Agent for ScreenPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("SCREEN") => {
                let criteria = env.payload.get("criteria").and_then(Value::as_str);
                match self.source.screener(criteria).await {
                    Ok(data) => vec![reply(
                        &env,
                        json!({"verb": "SCREEN.RESULT", "data": data}),
                    )],
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "SCREEN.RESULT", "error": e.to_string()}),
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
    async fn returns_matches() {
        let mut p = ScreenPane::new();
        let outs = p.handle(req("SCREEN", json!({}))).await;
        assert_eq!(outs[0].payload["verb"], "SCREEN.RESULT");
        let matches = outs[0].payload["data"]["matches"].as_array().unwrap();
        assert!(!matches.is_empty());
    }
}
