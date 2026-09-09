//! Implied-volatility surface pane — IVOL verb (symbol-prefixed) → IVOL.RESULT.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::json;

use crate::agent_runner::{symbol_of, verb};

pub struct IvolPane {
    id: &'static str,
    focus: Option<String>,
    source: MemoryDataSource,
}

impl IvolPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.ivol",
            focus: None,
            source: MemoryDataSource,
        }
    }
}

impl Agent for IvolPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("IVOL") => {
                let Some(sym) = symbol_of(&env) else {
                    return vec![reply(
                        &env,
                        json!({"verb": "IVOL.RESULT", "error": "missing symbol"}),
                    )];
                };
                self.focus = Some(sym.clone());
                match self.source.vol_surface(&sym).await {
                    Ok(data) => vec![reply(
                        &env,
                        json!({"verb": "IVOL.RESULT", "symbol": sym, "data": data}),
                    )],
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "IVOL.RESULT", "symbol": sym, "error": e.to_string()}),
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
    async fn returns_surface() {
        let mut p = IvolPane::new();
        let outs = p.handle(req("IVOL", json!({"symbol": "AAPL"}))).await;
        assert_eq!(outs[0].payload["symbol"], "AAPL");
        assert!(outs[0].payload["data"]["rows"].is_array());
    }
}
