//! Quote pane — DESC verb → QUOTE.RESULT.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::json;

use crate::agent_runner::{symbol_of, verb};

pub struct QuotePane {
    id: &'static str,
    focus: Option<String>,
    source: MemoryDataSource,
}

impl QuotePane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.quote",
            focus: None,
            source: MemoryDataSource,
        }
    }
}

impl Agent for QuotePane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("DESC") => {
                let Some(sym) = symbol_of(&env) else {
                    return vec![reply(
                        &env,
                        json!({"verb": "QUOTE.RESULT", "error": "missing symbol"}),
                    )];
                };
                self.focus = Some(sym.clone());
                match self.source.quote(&sym).await {
                    Ok(q) => vec![reply(
                        &env,
                        json!({
                            "verb": "QUOTE.RESULT",
                            "symbol": q.symbol,
                            "last": q.last,
                            "changePct": q.change_pct,
                            "bid": q.bid,
                            "ask": q.ask,
                            "timestamp": q.timestamp,
                        }),
                    )],
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "QUOTE.RESULT", "symbol": sym, "error": e.to_string()}),
                    )],
                }
            }
            Some("FOCUS") => {
                self.focus = symbol_of(&env);
                if env.requires_ack {
                    vec![reply(
                        &env,
                        json!({"verb": "FOCUS.ACK", "symbol": self.focus.clone()}),
                    )]
                } else {
                    vec![]
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
    async fn handles_desc() {
        let mut p = QuotePane::new();
        let outs = p.handle(req("DESC", json!({"symbol": "AAPL"}))).await;
        assert_eq!(outs.len(), 1);
        assert_eq!(outs[0].payload["verb"], "QUOTE.RESULT");
        assert_eq!(outs[0].payload["symbol"], "AAPL");
        assert_eq!(outs[0].correlation_id.as_deref(), Some("corr-1"));
    }
}
