//! SEC filings pane — FILINGS verb (symbol-prefixed) → FILINGS.RESULT.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::json;

use crate::agent_runner::{symbol_of, verb};

pub struct FilingsPane {
    id: &'static str,
    focus: Option<String>,
    source: MemoryDataSource,
}

impl FilingsPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.filings",
            focus: None,
            source: MemoryDataSource,
        }
    }
}

impl Agent for FilingsPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("FILINGS") => {
                let Some(sym) = symbol_of(&env) else {
                    return vec![reply(
                        &env,
                        json!({"verb": "FILINGS.RESULT", "error": "missing symbol"}),
                    )];
                };
                self.focus = Some(sym.clone());
                match self.source.filings(&sym).await {
                    Ok(data) => vec![reply(
                        &env,
                        json!({"verb": "FILINGS.RESULT", "symbol": sym, "data": data}),
                    )],
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "FILINGS.RESULT", "symbol": sym, "error": e.to_string()}),
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
    async fn returns_filings() {
        let mut p = FilingsPane::new();
        let outs = p.handle(req("FILINGS", json!({"symbol": "AAPL"}))).await;
        let arr = outs[0].payload["data"]["filings"].as_array().unwrap();
        assert!(!arr.is_empty());
    }
}
