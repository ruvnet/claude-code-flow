//! FX pane — FX verb (bare, optional `base`) → FX.RESULT (cross rates).

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::{json, Value};

use crate::agent_runner::verb;

pub struct FxPane {
    id: &'static str,
    source: MemoryDataSource,
}

impl FxPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.fx",
            source: MemoryDataSource,
        }
    }
}

impl Agent for FxPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("FX") => {
                let base = env.payload.get("base").and_then(Value::as_str);
                match self.source.fx_rates(base).await {
                    Ok(rates) => vec![reply(
                        &env,
                        json!({"verb": "FX.RESULT", "data": rates}),
                    )],
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "FX.RESULT", "error": e.to_string()}),
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
    async fn returns_rates_default_base() {
        let mut p = FxPane::new();
        let outs = p.handle(req("FX", json!({}))).await;
        assert_eq!(outs.len(), 1);
        assert_eq!(outs[0].payload["verb"], "FX.RESULT");
        assert_eq!(outs[0].payload["data"]["base"], "USD");
    }

    #[tokio::test]
    async fn honours_explicit_base() {
        let mut p = FxPane::new();
        let outs = p.handle(req("FX", json!({"base": "eur"}))).await;
        assert_eq!(outs[0].payload["data"]["base"], "EUR");
    }
}
