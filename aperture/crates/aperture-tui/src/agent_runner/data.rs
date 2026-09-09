//! `aperture:agent.data` — the central data agent. Other panes route
//! `QUOTE` / `OHLCV` traffic through this agent rather than calling a
//! `DataSource` directly so the wire is the single source of truth.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::{json, Value};

use super::{symbol_of, verb};

pub struct DataAgent {
    id: String,
    source: MemoryDataSource,
}

impl DataAgent {
    pub fn new() -> Self {
        Self {
            id: "aperture:agent.data".into(),
            source: MemoryDataSource,
        }
    }
}

impl Agent for DataAgent {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("QUOTE") => self.handle_quote(&env).await,
            Some("OHLCV") => self.handle_ohlcv(&env).await,
            _ => vec![],
        }
    }
}

impl DataAgent {
    async fn handle_quote(&self, env: &Envelope) -> Vec<Envelope> {
        let Some(sym) = symbol_of(env) else {
            return vec![reply(
                env,
                json!({"verb": "QUOTE.RESULT", "error": "missing symbol"}),
            )];
        };
        match self.source.quote(&sym).await {
            Ok(q) => vec![reply(
                env,
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
                env,
                json!({"verb": "QUOTE.RESULT", "symbol": sym, "error": e.to_string()}),
            )],
        }
    }

    async fn handle_ohlcv(&self, env: &Envelope) -> Vec<Envelope> {
        let Some(sym) = symbol_of(env) else {
            return vec![reply(
                env,
                json!({"verb": "OHLCV.RESULT", "error": "missing symbol"}),
            )];
        };
        let range = env
            .payload
            .get("range")
            .and_then(Value::as_str)
            .unwrap_or("1M");
        match self.source.ohlcv(&sym, range).await {
            Ok(candles) => {
                let candles_json: Vec<Value> = candles
                    .iter()
                    .map(|c| {
                        json!({
                            "t": c.t, "o": c.o, "h": c.h,
                            "l": c.l, "c": c.c, "v": c.v,
                        })
                    })
                    .collect();
                vec![reply(
                    env,
                    json!({
                        "verb": "OHLCV.RESULT",
                        "symbol": sym,
                        "range": range,
                        "candles": candles_json,
                    }),
                )]
            }
            Err(e) => vec![reply(
                env,
                json!({"verb": "OHLCV.RESULT", "symbol": sym, "error": e.to_string()}),
            )],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aperture_swarm::{MessageType, Priority};

    fn req(verb_s: &str, extra: Value) -> Envelope {
        let mut payload = json!({"verb": verb_s});
        if let (Some(p), Some(extra_obj)) = (payload.as_object_mut(), extra.as_object()) {
            for (k, v) in extra_obj {
                p.insert(k.clone(), v.clone());
            }
        }
        Envelope {
            id: "test-1".into(),
            message_type: MessageType::Direct,
            from: "aperture:cmdbar".into(),
            to: "aperture:agent.data".into(),
            payload,
            timestamp: "2026-05-10T15:04:05.000Z".into(),
            priority: Priority::Normal,
            requires_ack: false,
            ttl_ms: 5000,
            correlation_id: Some("corr-1".into()),
        }
    }

    #[tokio::test]
    async fn data_agent_ohlcv_returns_candles() {
        let mut a = DataAgent::new();
        let outs = a
            .handle(req("OHLCV", json!({"symbol": "AAPL", "range": "1M"})))
            .await;
        assert_eq!(outs.len(), 1);
        assert_eq!(outs[0].payload["verb"], "OHLCV.RESULT");
        let candles = outs[0].payload["candles"].as_array().unwrap();
        assert!(!candles.is_empty());
    }
}
