//! Macro pane — MACRO verb (bare) → MACRO.RESULT (econ indicators).
//!
//! Module name is `macro_pane` because `macro` is a Rust keyword; the
//! pane id remains `aperture:pane.macro` and the verb remains `MACRO`.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_swarm::{reply, Agent, Envelope};
use serde_json::json;

use crate::agent_runner::verb;

pub struct MacroPane {
    id: &'static str,
    source: MemoryDataSource,
}

impl MacroPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.macro",
            source: MemoryDataSource,
        }
    }
}

impl Agent for MacroPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("MACRO") => match self.source.macro_indicators().await {
                Ok(rows) => vec![reply(
                    &env,
                    json!({"verb": "MACRO.RESULT", "rows": rows}),
                )],
                Err(e) => vec![reply(
                    &env,
                    json!({"verb": "MACRO.RESULT", "error": e.to_string()}),
                )],
            },
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
    async fn returns_indicators() {
        let mut p = MacroPane::new();
        let outs = p.handle(req("MACRO", json!({}))).await;
        assert_eq!(outs.len(), 1);
        assert_eq!(outs[0].payload["verb"], "MACRO.RESULT");
        assert!(outs[0].payload["rows"].is_array());
    }
}
