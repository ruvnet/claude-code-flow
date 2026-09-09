//! Crypto pane — CRYPTO verb (symbol-prefixed) → CRYPTO.RESULT.
//!
//! Distinct from the equity Quote pane because crypto carries 24h volume,
//! market cap, and dominance fields that do not apply to equities.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::json;

use crate::agent_runner::{symbol_of, verb};

pub struct CryptoPane {
    id: &'static str,
    focus: Option<String>,
    source: MemoryDataSource,
}

impl CryptoPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.crypto",
            focus: None,
            source: MemoryDataSource,
        }
    }
}

impl Agent for CryptoPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("CRYPTO") => {
                let Some(sym) = symbol_of(&env) else {
                    return vec![reply(
                        &env,
                        json!({"verb": "CRYPTO.RESULT", "error": "missing symbol"}),
                    )];
                };
                self.focus = Some(sym.clone());
                match self.source.crypto_quote(&sym).await {
                    Ok(data) => vec![reply(
                        &env,
                        json!({"verb": "CRYPTO.RESULT", "symbol": sym, "data": data}),
                    )],
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "CRYPTO.RESULT", "symbol": sym, "error": e.to_string()}),
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
    async fn returns_crypto_payload() {
        let mut p = CryptoPane::new();
        let outs = p.handle(req("CRYPTO", json!({"symbol": "BTC"}))).await;
        assert_eq!(outs[0].payload["verb"], "CRYPTO.RESULT");
        assert!(outs[0].payload["data"]["vol_24h"].is_number());
    }
}
