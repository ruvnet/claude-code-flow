//! Inbox pane — message mailbox.
//!
//! Verbs:
//! - `INBOX`         — list messages → `INBOX.RESULT`
//! - `INBOX.POST`    — append a message (`payload.body`)
//! - `INBOX.CLEAR`   — drop all messages

use aperture_swarm::{reply, Agent, Envelope};
use serde_json::{json, Value};

use crate::agent_runner::verb;

pub struct InboxPane {
    id: &'static str,
    messages: Vec<Value>,
}

impl InboxPane {
    pub fn new() -> Self {
        Self {
            id: "aperture:pane.inbox",
            messages: Vec::new(),
        }
    }
}

impl Agent for InboxPane {
    fn id(&self) -> &str {
        &self.id
    }

    async fn handle(&mut self, env: Envelope) -> Vec<Envelope> {
        match verb(&env) {
            Some("INBOX") => vec![reply(
                &env,
                json!({"verb": "INBOX.RESULT", "messages": self.messages}),
            )],
            Some("INBOX.POST") => {
                if let Some(body) = env.payload.get("body") {
                    self.messages.push(json!({
                        "from": env.from,
                        "body": body,
                        "ts": env.timestamp,
                    }));
                }
                vec![reply(
                    &env,
                    json!({"verb": "INBOX.RESULT", "messages": self.messages}),
                )]
            }
            Some("INBOX.CLEAR") => {
                self.messages.clear();
                vec![reply(
                    &env,
                    json!({"verb": "INBOX.RESULT", "messages": self.messages}),
                )]
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
    async fn post_then_list_then_clear() {
        let mut p = InboxPane::new();
        let _ = p.handle(req("INBOX.POST", json!({"body": "hello"}))).await;
        let _ = p.handle(req("INBOX.POST", json!({"body": "world"}))).await;
        let outs = p.handle(req("INBOX", json!({}))).await;
        assert_eq!(outs[0].payload["messages"].as_array().unwrap().len(), 2);
        let _ = p.handle(req("INBOX.CLEAR", json!({}))).await;
        let outs = p.handle(req("INBOX", json!({}))).await;
        assert_eq!(outs[0].payload["messages"].as_array().unwrap().len(), 0);
    }
}
