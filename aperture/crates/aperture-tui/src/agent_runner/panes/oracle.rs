//! Oracle pane — ASK verb. In-process synthesis: wraps the prompt with focus
//! + recent context. The full ruflo-neural-trader integration will route ASK
//! envelopes through the swarm bus when the dispatcher exposes that channel.

use aperture_swarm::{reply, Agent, Envelope};
use serde_json::{json, Value};

use crate::agent_runner::{symbol_of, verb};

pub struct OraclePane {
    id: &'static str,
    focus: Option<String>,
}

impl OraclePane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.oracle",
            focus: None,
        }
    }
}

impl Agent for OraclePane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("ASK") => {
                let prompt = env
                    .payload
                    .get("prompt")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let answer = synthesize_answer(&prompt, self.focus.as_deref());
                vec![reply(
                    &env,
                    json!({
                        "verb": "ASK.RESULT",
                        "prompt": prompt,
                        "answer": answer,
                        "focus": self.focus,
                    }),
                )]
            }
            Some("FOCUS") => {
                self.focus = symbol_of(&env);
                vec![]
            }
            _ => vec![],
        }
    }
}

/// In-process synthesis for ASK prompts. Builds a 2–3 line answer that:
///  1. acknowledges the focus symbol when set,
///  2. summarises the prompt by length tier (short / medium / long),
///  3. suggests next panes to consult based on simple keyword matching.
fn synthesize_answer(prompt: &str, focus: Option<&str>) -> String {
    let trimmed = prompt.trim();
    let len = trimmed.chars().count();
    let tier = if len == 0 {
        "empty"
    } else if len < 40 {
        "short"
    } else if len < 200 {
        "medium"
    } else {
        "long"
    };

    let lower = trimmed.to_ascii_lowercase();
    let mut suggestions: Vec<&str> = Vec::new();
    if lower.contains("earnings") {
        suggestions.push("pane.earnings");
    }
    if lower.contains("yield") || lower.contains("rate") {
        suggestions.push("pane.yields");
    }
    if lower.contains("vol") || lower.contains("volatility") {
        suggestions.push("pane.ivol");
    }
    if lower.contains("headline") || lower.contains("news") {
        suggestions.push("pane.news");
    }
    if suggestions.is_empty() {
        suggestions.extend(["pane.quote", "pane.chart", "pane.financials"]);
    }

    let focus_line = match focus {
        Some(sym) if !sym.is_empty() => format!("Focus: {sym}."),
        _ => "Focus: none set (use SYMBOL FOCUS GO).".to_string(),
    };
    let summary_line = format!("Prompt is {tier} ({len} chars).");
    let suggest_line = format!("Next: {}.", suggestions.join(", "));
    format!("{focus_line}\n{summary_line}\n{suggest_line}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runner::panes::test_helpers::req;
    use serde_json::json;

    #[tokio::test]
    async fn echoes_ask() {
        let mut p = OraclePane::new();
        let outs = p
            .handle(req("ASK", json!({"prompt": "what is going on?"})))
            .await;
        assert_eq!(outs.len(), 1);
        assert_eq!(outs[0].payload["verb"], "ASK.RESULT");
    }

    #[tokio::test]
    async fn earnings_keyword_routes_to_earnings_pane() {
        let mut p = OraclePane::new();
        let outs = p
            .handle(req("ASK", json!({"prompt": "earnings season outlook"})))
            .await;
        assert_eq!(outs.len(), 1);
        let answer = outs[0].payload["answer"].as_str().expect("answer string");
        assert!(
            answer.contains("pane.earnings"),
            "expected earnings suggestion, got: {answer}"
        );
    }
}
