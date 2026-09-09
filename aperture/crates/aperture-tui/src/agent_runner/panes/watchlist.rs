//! Watchlist pane — WATCH / UNWATCH / LIST verbs.

use aperture_swarm::{reply, Agent, Envelope};
use serde_json::json;

use crate::agent_runner::{symbol_of, verb};

pub struct WatchlistPane {
    id: &'static str,
    items: Vec<String>,
}

impl WatchlistPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.watchlist",
            items: Vec::new(),
        }
    }
}

impl Agent for WatchlistPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("WATCH") => {
                let Some(sym) = symbol_of(&env) else {
                    return vec![reply(
                        &env,
                        json!({"verb": "WATCH.RESULT", "error": "missing symbol"}),
                    )];
                };
                if !self.items.contains(&sym) {
                    self.items.push(sym.clone());
                }
                vec![reply(
                    &env,
                    json!({"verb": "WATCH.RESULT", "symbol": sym, "items": self.items}),
                )]
            }
            Some("UNWATCH") => {
                let Some(sym) = symbol_of(&env) else {
                    return vec![reply(
                        &env,
                        json!({"verb": "UNWATCH.RESULT", "error": "missing symbol"}),
                    )];
                };
                self.items.retain(|x| x != &sym);
                vec![reply(
                    &env,
                    json!({"verb": "UNWATCH.RESULT", "symbol": sym, "items": self.items}),
                )]
            }
            Some("LIST") => vec![reply(
                &env,
                json!({"verb": "LIST.RESULT", "items": self.items}),
            )],
            Some("FOCUS") => vec![],
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
    async fn add_remove_list() {
        let mut p = WatchlistPane::new();
        let _ = p.handle(req("WATCH", json!({"symbol": "AAPL"}))).await;
        let _ = p.handle(req("WATCH", json!({"symbol": "TSLA"}))).await;
        let outs = p.handle(req("LIST", json!({}))).await;
        let items = outs[0].payload["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        let _ = p.handle(req("UNWATCH", json!({"symbol": "AAPL"}))).await;
        let outs = p.handle(req("LIST", json!({}))).await;
        let items = outs[0].payload["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0], "TSLA");
    }
}
