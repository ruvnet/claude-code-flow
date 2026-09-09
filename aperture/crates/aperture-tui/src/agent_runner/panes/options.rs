//! Options pane — OPTIONS verb (symbol-prefixed) → OPTIONS.RESULT (chain).

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::json;

use crate::agent_runner::{symbol_of, verb};

pub struct OptionsPane {
    id: &'static str,
    focus: Option<String>,
    source: MemoryDataSource,
}

impl OptionsPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.options",
            focus: None,
            source: MemoryDataSource,
        }
    }
}

impl Agent for OptionsPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("OPTIONS") => {
                let Some(sym) = symbol_of(&env) else {
                    return vec![reply(
                        &env,
                        json!({"verb": "OPTIONS.RESULT", "error": "missing symbol"}),
                    )];
                };
                self.focus = Some(sym.clone());
                match self.source.options_chain(&sym).await {
                    Ok(chain) => vec![reply(
                        &env,
                        json!({"verb": "OPTIONS.RESULT", "symbol": sym, "chain": chain}),
                    )],
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "OPTIONS.RESULT", "symbol": sym, "error": e.to_string()}),
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
    async fn returns_chain() {
        let mut p = OptionsPane::new();
        let outs = p
            .handle(req("OPTIONS", json!({"symbol": "AAPL"})))
            .await;
        assert_eq!(outs[0].payload["verb"], "OPTIONS.RESULT");
        assert_eq!(outs[0].payload["symbol"], "AAPL");
        assert!(outs[0].payload["chain"]["rows"].is_array());
    }
}
