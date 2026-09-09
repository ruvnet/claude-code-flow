//! News pane — NEWS verb (per-symbol or global) → NEWS.RESULT.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::json;

use crate::agent_runner::{symbol_of, verb};

pub struct NewsPane {
    id: &'static str,
    focus: Option<String>,
    source: MemoryDataSource,
}

impl NewsPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.news",
            focus: None,
            source: MemoryDataSource,
        }
    }
}

impl Agent for NewsPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("NEWS") => {
                let sym = symbol_of(&env);
                if sym.is_some() {
                    self.focus = sym.clone();
                }
                match self.source.news(sym.as_deref()).await {
                    Ok(payload) => vec![reply(
                        &env,
                        json!({
                            "verb": "NEWS.RESULT",
                            "scope": sym.unwrap_or_else(|| "GLOBAL".into()),
                            "data": payload,
                        }),
                    )],
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "NEWS.RESULT", "error": e.to_string()}),
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
    async fn returns_global_headlines() {
        let mut p = NewsPane::new();
        let outs = p.handle(req("NEWS", json!({}))).await;
        assert_eq!(outs.len(), 1);
        assert_eq!(outs[0].payload["verb"], "NEWS.RESULT");
        assert_eq!(outs[0].payload["scope"], "GLOBAL");
        assert!(outs[0].payload["data"]["headlines"].is_array());
    }

    #[tokio::test]
    async fn returns_per_symbol_headlines() {
        let mut p = NewsPane::new();
        let outs = p.handle(req("NEWS", json!({"symbol": "AAPL"}))).await;
        assert_eq!(outs[0].payload["scope"], "AAPL");
    }
}
