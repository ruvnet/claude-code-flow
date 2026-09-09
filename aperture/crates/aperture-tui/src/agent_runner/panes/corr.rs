//! Correlation matrix pane — CORR verb (bare, `symbols` array in payload) → CORR.RESULT.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::{json, Value};

use crate::agent_runner::verb;

pub struct CorrPane {
    id: &'static str,
    source: MemoryDataSource,
}

impl CorrPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.corr",
            source: MemoryDataSource,
        }
    }
}

impl Agent for CorrPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("CORR") => {
                let symbols: Vec<String> = env
                    .payload
                    .get("symbols")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                match self.source.correlation_matrix(&symbols).await {
                    Ok(data) => vec![reply(
                        &env,
                        json!({"verb": "CORR.RESULT", "data": data}),
                    )],
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "CORR.RESULT", "error": e.to_string()}),
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
    async fn returns_matrix() {
        let mut p = CorrPane::new();
        let outs = p
            .handle(req("CORR", json!({"symbols": ["AAPL", "MSFT", "TSLA"]})))
            .await;
        let matrix = outs[0].payload["data"]["matrix"].as_array().unwrap();
        assert_eq!(matrix.len(), 3);
        // Diagonal should be 1.0.
        for (i, row_obj) in matrix.iter().enumerate() {
            let row = row_obj["row"].as_array().unwrap();
            assert_eq!(row[i].as_f64().unwrap(), 1.0);
        }
    }
}
