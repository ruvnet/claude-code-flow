//! Insider pane — INSIDER verb (symbol-prefixed) → INSIDER.RESULT.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::json;

use crate::agent_runner::{symbol_of, verb};

pub struct InsiderPane {
    id: &'static str,
    focus: Option<String>,
    source: MemoryDataSource,
}

impl InsiderPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.insider",
            focus: None,
            source: MemoryDataSource,
        }
    }
}

impl Agent for InsiderPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("INSIDER") => {
                let Some(sym) = symbol_of(&env) else {
                    return vec![reply(
                        &env,
                        json!({"verb": "INSIDER.RESULT", "error": "missing symbol"}),
                    )];
                };
                self.focus = Some(sym.clone());
                match self.source.insider_trades(&sym).await {
                    Ok(trades) => vec![reply(
                        &env,
                        json!({"verb": "INSIDER.RESULT", "symbol": sym, "data": trades}),
                    )],
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "INSIDER.RESULT", "symbol": sym, "error": e.to_string()}),
                    )],
                }
            }
            Some("FOCUS") => {
                self.focus = symbol_of(&env);
                vec![]
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
    async fn returns_trades() {
        let mut p = InsiderPane::new();
        let outs = p
            .handle(req("INSIDER", json!({"symbol": "AAPL"})))
            .await;
        assert_eq!(outs[0].payload["verb"], "INSIDER.RESULT");
        assert!(outs[0].payload["data"]["trades"].is_array());
    }
}
