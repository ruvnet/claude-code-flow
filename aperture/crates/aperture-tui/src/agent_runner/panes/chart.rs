//! Chart pane — CHART verb → CHART.RESULT (ASCII lines).

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::{json, Value};

use crate::agent_runner::{render_ascii_chart, symbol_of, verb};

pub struct ChartPane {
    id: &'static str,
    focus: Option<String>,
    source: MemoryDataSource,
}

impl ChartPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.chart",
            focus: None,
            source: MemoryDataSource,
        }
    }
}

impl Agent for ChartPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("CHART") => {
                let Some(sym) = symbol_of(&env) else {
                    return vec![reply(
                        &env,
                        json!({"verb": "CHART.RESULT", "error": "missing symbol"}),
                    )];
                };
                let range = env
                    .payload
                    .get("range")
                    .and_then(Value::as_str)
                    .unwrap_or("1M");
                self.focus = Some(sym.clone());
                match self.source.ohlcv(&sym, range).await {
                    Ok(candles) => {
                        let lines = render_ascii_chart(&candles);
                        vec![reply(
                            &env,
                            json!({
                                "verb": "CHART.RESULT",
                                "symbol": sym,
                                "range": range,
                                "lines": lines,
                                "candleCount": candles.len(),
                            }),
                        )]
                    }
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "CHART.RESULT", "symbol": sym, "error": e.to_string()}),
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
    async fn returns_lines() {
        let mut p = ChartPane::new();
        let outs = p
            .handle(req("CHART", json!({"symbol": "AAPL", "range": "1M"})))
            .await;
        assert_eq!(outs.len(), 1);
        assert_eq!(outs[0].payload["verb"], "CHART.RESULT");
        let lines = outs[0].payload["lines"].as_array().unwrap();
        assert!(!lines.is_empty());
    }
}
