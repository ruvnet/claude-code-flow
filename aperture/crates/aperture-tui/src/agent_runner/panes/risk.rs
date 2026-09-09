//! Risk pane — RISK verb (bare; optional symbols list in payload) → RISK.RESULT.
//!
//! When `payload.symbols` is missing the host is expected to attach the
//! current watchlist. v0.1: if no symbols are provided we return an empty
//! result rather than reaching into the watchlist pane out-of-band.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::{json, Value};

use crate::agent_runner::verb;

pub struct RiskPane {
    id: &'static str,
    source: MemoryDataSource,
}

impl RiskPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.risk",
            source: MemoryDataSource,
        }
    }
}

impl Agent for RiskPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("RISK") => {
                let symbols: Vec<String> = env
                    .payload
                    .get("symbols")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_ascii_uppercase()))
                            .collect()
                    })
                    .unwrap_or_default();
                match self.source.risk_metrics(&symbols).await {
                    Ok(data) => vec![reply(
                        &env,
                        json!({"verb": "RISK.RESULT", "data": data}),
                    )],
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "RISK.RESULT", "error": e.to_string()}),
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
    async fn returns_metrics() {
        let mut p = RiskPane::new();
        let outs = p
            .handle(req("RISK", json!({"symbols": ["AAPL", "TSLA"]})))
            .await;
        assert_eq!(outs[0].payload["verb"], "RISK.RESULT");
        let rows = outs[0].payload["data"]["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[tokio::test]
    async fn empty_symbols_yields_empty_rows() {
        let mut p = RiskPane::new();
        let outs = p.handle(req("RISK", json!({}))).await;
        let rows = outs[0].payload["data"]["rows"].as_array().unwrap();
        assert!(rows.is_empty());
    }
}
