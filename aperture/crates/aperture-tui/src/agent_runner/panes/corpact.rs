//! Corporate actions pane — CORPACT verb (symbol-prefixed) → CORPACT.RESULT.
//! Splits, dividends, M&A.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::json;

use crate::agent_runner::{symbol_of, verb};

pub struct CorpactPane {
    id: &'static str,
    focus: Option<String>,
    source: MemoryDataSource,
}

impl CorpactPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.corpact",
            focus: None,
            source: MemoryDataSource,
        }
    }
}

impl Agent for CorpactPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("CORPACT") => {
                let Some(sym) = symbol_of(&env) else {
                    return vec![reply(
                        &env,
                        json!({"verb": "CORPACT.RESULT", "error": "missing symbol"}),
                    )];
                };
                self.focus = Some(sym.clone());
                match self.source.corp_actions(&sym).await {
                    Ok(data) => vec![reply(
                        &env,
                        json!({"verb": "CORPACT.RESULT", "symbol": sym, "data": data}),
                    )],
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "CORPACT.RESULT", "symbol": sym, "error": e.to_string()}),
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
    async fn returns_events() {
        let mut p = CorpactPane::new();
        let outs = p
            .handle(req("CORPACT", json!({"symbol": "AAPL"})))
            .await;
        assert_eq!(outs[0].payload["verb"], "CORPACT.RESULT");
        let events = outs[0].payload["data"]["events"].as_array().unwrap();
        assert!(!events.is_empty());
    }
}
