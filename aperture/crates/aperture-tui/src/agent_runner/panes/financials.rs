//! Financials pane — FINANCIALS verb (symbol-prefixed) → FINANCIALS.RESULT.
//! Returns income / balance / cashflow snapshots.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::json;

use crate::agent_runner::{symbol_of, verb};

pub struct FinancialsPane {
    id: &'static str,
    focus: Option<String>,
    source: MemoryDataSource,
}

impl FinancialsPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.financials",
            focus: None,
            source: MemoryDataSource,
        }
    }
}

impl Agent for FinancialsPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("FINANCIALS") => {
                let Some(sym) = symbol_of(&env) else {
                    return vec![reply(
                        &env,
                        json!({"verb": "FINANCIALS.RESULT", "error": "missing symbol"}),
                    )];
                };
                self.focus = Some(sym.clone());
                match self.source.financials(&sym).await {
                    Ok(data) => vec![reply(
                        &env,
                        json!({"verb": "FINANCIALS.RESULT", "symbol": sym, "data": data}),
                    )],
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "FINANCIALS.RESULT", "symbol": sym, "error": e.to_string()}),
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
    async fn returns_three_statements() {
        let mut p = FinancialsPane::new();
        let outs = p
            .handle(req("FINANCIALS", json!({"symbol": "AAPL"})))
            .await;
        let data = &outs[0].payload["data"];
        assert!(data["income_ttm"]["revenue"].is_number());
        assert!(data["balance_mrq"]["total_assets"].is_number());
        assert!(data["cashflow_ttm"]["free_cashflow"].is_number());
    }
}
