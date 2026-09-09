//! Minimal SSE parser for the `/v1/sessions/<id>/stream` endpoint.
//!
//! The Managed Agents stream emits standard `text/event-stream` frames:
//! each `data: <json>` line carries one event; blank lines terminate
//! the frame. We only care about three event types:
//!
//! - `agent.message`     — concatenate `content[*].text` (when `type=text`)
//! - `agent.tool_use`    — note for diagnostics; not surfaced to callers
//! - `session.status_idle` — terminal: agent has nothing more to do
//!
//! The parser is byte-oriented and operates on a streaming input by
//! holding a small carry-buffer between feeds.

use serde_json::Value;

/// One decoded SSE event from the Managed Agents stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseEvent {
    AgentMessage { text: String },
    AgentToolUse { name: String },
    SessionIdle,
    Other,
}

/// Stateful line-oriented SSE parser. Feed bytes as they arrive and
/// drain the accumulated events with `drain`.
#[derive(Debug, Default)]
pub struct SseParser {
    buf: String,
    pending: Vec<SseEvent>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append bytes from the upstream stream and parse any complete
    /// lines they yield.
    pub fn feed(&mut self, chunk: &str) {
        self.buf.push_str(chunk);
        while let Some(nl) = self.buf.find('\n') {
            let line: String = self.buf.drain(..=nl).collect();
            self.handle_line(line.trim_end_matches(['\n', '\r']));
        }
    }

    /// Drain accumulated events. Returns them in order.
    pub fn drain(&mut self) -> Vec<SseEvent> {
        std::mem::take(&mut self.pending)
    }

    fn handle_line(&mut self, line: &str) {
        // We only consume `data:` lines. Empty lines (event boundaries),
        // `event:`, `id:`, `retry:`, comments (`:`) are all ignored.
        let Some(payload) = line.strip_prefix("data:") else {
            return;
        };
        let payload = payload.trim_start();
        if payload.is_empty() {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(payload) else {
            return;
        };
        if let Some(ev) = decode_event(&value) {
            self.pending.push(ev);
        }
    }
}

fn decode_event(v: &Value) -> Option<SseEvent> {
    let ty = v.get("type")?.as_str()?;
    match ty {
        "agent.message" => {
            let text = v
                .get("content")?
                .as_array()?
                .iter()
                .filter_map(|b| {
                    if b.get("type").and_then(Value::as_str) == Some("text") {
                        b.get("text").and_then(Value::as_str).map(str::to_string)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("");
            Some(SseEvent::AgentMessage { text })
        }
        "agent.tool_use" => {
            let name = v.get("name")?.as_str()?.to_string();
            Some(SseEvent::AgentToolUse { name })
        }
        "session.status_idle" => Some(SseEvent::SessionIdle),
        _ => Some(SseEvent::Other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_agent_message() {
        let mut p = SseParser::new();
        p.feed("data: {\"type\":\"agent.message\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}\n\n");
        assert_eq!(
            p.drain(),
            vec![SseEvent::AgentMessage { text: "hi".into() }]
        );
    }

    #[test]
    fn concatenates_multiple_text_blocks() {
        let mut p = SseParser::new();
        p.feed("data: {\"type\":\"agent.message\",\"content\":[{\"type\":\"text\",\"text\":\"foo\"},{\"type\":\"text\",\"text\":\"bar\"}]}\n");
        assert_eq!(
            p.drain(),
            vec![SseEvent::AgentMessage { text: "foobar".into() }]
        );
    }

    #[test]
    fn skips_non_data_lines() {
        let mut p = SseParser::new();
        p.feed(":heartbeat\nevent: status\nid: 1\nretry: 5000\n");
        assert!(p.drain().is_empty());
    }

    #[test]
    fn handles_split_chunks() {
        let mut p = SseParser::new();
        p.feed("data: {\"type\":\"agent.tool_");
        assert!(p.drain().is_empty());
        p.feed("use\",\"name\":\"WebSearch\"}\n");
        assert_eq!(
            p.drain(),
            vec![SseEvent::AgentToolUse { name: "WebSearch".into() }]
        );
    }

    #[test]
    fn surfaces_session_idle_as_terminal() {
        let mut p = SseParser::new();
        p.feed("data: {\"type\":\"session.status_idle\"}\n");
        assert_eq!(p.drain(), vec![SseEvent::SessionIdle]);
    }

    #[test]
    fn unknown_event_types_pass_through_as_other() {
        let mut p = SseParser::new();
        p.feed("data: {\"type\":\"agent.thinking\"}\n");
        assert_eq!(p.drain(), vec![SseEvent::Other]);
    }

    #[test]
    fn malformed_json_is_dropped() {
        let mut p = SseParser::new();
        p.feed("data: not-json\n\n");
        assert!(p.drain().is_empty());
    }

    #[test]
    fn handles_crlf_line_endings() {
        let mut p = SseParser::new();
        p.feed("data: {\"type\":\"session.status_idle\"}\r\n");
        assert_eq!(p.drain(), vec![SseEvent::SessionIdle]);
    }
}
