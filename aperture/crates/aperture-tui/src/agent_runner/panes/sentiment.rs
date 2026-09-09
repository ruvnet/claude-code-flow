//! Sentiment pane — SENTIMENT verb (symbol-prefixed) → SENTIMENT.RESULT.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::json;

use crate::agent_runner::{symbol_of, verb};

pub struct SentimentPane {
    id: &'static str,
    focus: Option<String>,
    source: MemoryDataSource,
}

impl SentimentPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.sentiment",
            focus: None,
            source: MemoryDataSource,
        }
    }
}

impl Agent for SentimentPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("SENTIMENT") => {
                let Some(sym) = symbol_of(&env) else {
                    return vec![reply(
                        &env,
                        json!({"verb": "SENTIMENT.RESULT", "error": "missing symbol"}),
                    )];
                };
                self.focus = Some(sym.clone());
                match self.source.sentiment(&sym).await {
                    Ok(data) => vec![reply(
                        &env,
                        json!({"verb": "SENTIMENT.RESULT", "symbol": sym, "data": data}),
                    )],
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "SENTIMENT.RESULT", "symbol": sym, "error": e.to_string()}),
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
    async fn returns_score_and_label() {
        let mut p = SentimentPane::new();
        let outs = p.handle(req("SENTIMENT", json!({"symbol": "AAPL"}))).await;
        let label = outs[0].payload["data"]["label"].as_str().unwrap();
        assert!(matches!(label, "bullish" | "neutral" | "bearish"));
    }
}
