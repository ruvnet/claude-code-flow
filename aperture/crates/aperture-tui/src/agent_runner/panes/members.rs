//! Index members pane — MEMBERS verb (symbol-prefixed, the index ticker) → MEMBERS.RESULT.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::json;

use crate::agent_runner::{symbol_of, verb};

pub struct MembersPane {
    id: &'static str,
    focus: Option<String>,
    source: MemoryDataSource,
}

impl MembersPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.members",
            focus: None,
            source: MemoryDataSource,
        }
    }
}

impl Agent for MembersPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("MEMBERS") => {
                let Some(sym) = symbol_of(&env) else {
                    return vec![reply(
                        &env,
                        json!({"verb": "MEMBERS.RESULT", "error": "missing index symbol"}),
                    )];
                };
                self.focus = Some(sym.clone());
                match self.source.index_members(&sym).await {
                    Ok(data) => vec![reply(
                        &env,
                        json!({"verb": "MEMBERS.RESULT", "symbol": sym, "data": data}),
                    )],
                    Err(e) => vec![reply(
                        &env,
                        json!({"verb": "MEMBERS.RESULT", "symbol": sym, "error": e.to_string()}),
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
    async fn returns_members() {
        let mut p = MembersPane::new();
        let outs = p.handle(req("MEMBERS", json!({"symbol": "SPX"}))).await;
        assert_eq!(outs[0].payload["verb"], "MEMBERS.RESULT");
        assert!(outs[0].payload["data"]["members"].is_array());
    }
}
