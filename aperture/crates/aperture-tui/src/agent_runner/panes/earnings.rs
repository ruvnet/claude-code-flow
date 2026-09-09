//! Earnings calendar pane — EARNINGS verb (bare, optional `window_days`) → EARNINGS.RESULT.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::{json, Value};

use crate::agent_runner::verb;

pub struct EarningsPane {
    id: &'static str,
    source: MemoryDataSource,
}

impl EarningsPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.earnings",
            source: MemoryDataSource,
        }
    }
}

impl Agent for EarningsPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("EARNINGS") => {
                let window = env
                    .payload
                    .get("window_days")
                    .and_then(Value::as_u64)
                    .map(|n| n as u32);
                match self.source.earnings_calendar(window).await {
                    Ok(data) => vec![reply(
                        &env,
                        json!({"verb": "EARNINGS.RESULT", "data": data}),
                    )],
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "EARNINGS.RESULT", "error": e.to_string()}),
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
    async fn returns_calendar() {
        let mut p = EarningsPane::new();
        let outs = p.handle(req("EARNINGS", json!({}))).await;
        assert_eq!(outs[0].payload["verb"], "EARNINGS.RESULT");
        assert!(outs[0].payload["data"]["events"].is_array());
    }
}
