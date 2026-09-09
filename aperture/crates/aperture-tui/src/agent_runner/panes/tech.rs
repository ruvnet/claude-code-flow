//! Technicals pane — TECH verb (symbol-prefixed, indicator arg) → TECH.RESULT.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::{json, Value};

use crate::agent_runner::{symbol_of, verb};

pub struct TechPane {
    id: &'static str,
    focus: Option<String>,
    source: MemoryDataSource,
}

impl TechPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.tech",
            focus: None,
            source: MemoryDataSource,
        }
    }
}

impl Agent for TechPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("TECH") => {
                let Some(sym) = symbol_of(&env) else {
                    return vec![reply(
                        &env,
                        json!({"verb": "TECH.RESULT", "error": "missing symbol"}),
                    )];
                };
                let indicator = env
                    .payload
                    .get("indicator")
                    .and_then(Value::as_str)
                    .unwrap_or("SMA");
                self.focus = Some(sym.clone());
                match self.source.technicals(&sym, indicator).await {
                    Ok(data) => vec![reply(
                        &env,
                        json!({"verb": "TECH.RESULT", "symbol": sym, "indicator": indicator, "data": data}),
                    )],
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "TECH.RESULT", "symbol": sym, "error": e.to_string()}),
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
    async fn returns_default_sma() {
        let mut p = TechPane::new();
        let outs = p.handle(req("TECH", json!({"symbol": "AAPL"}))).await;
        assert_eq!(outs[0].payload["data"]["indicator"], "SMA");
        assert!(outs[0].payload["data"]["value"].is_number());
    }

    #[tokio::test]
    async fn rejects_unknown_indicator() {
        let mut p = TechPane::new();
        let outs = p
            .handle(req(
                "TECH",
                json!({"symbol": "AAPL", "indicator": "NOPE"}),
            ))
            .await;
        assert!(outs[0].payload["error"].is_string());
    }
}
