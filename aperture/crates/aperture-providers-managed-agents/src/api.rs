//! Thin curl-based HTTP client for the Managed Agents endpoints.
//!
//! Each public function owns one of the wire calls we need:
//!
//! - [`create_agent`]
//! - [`create_environment`]
//! - [`create_session`]
//! - [`run_event`] — sends the user event and polls the events endpoint
//!   until the turn finishes, returning the agent's concatenated
//!   `agent.message` text.
//!
//! ## Why polling, not SSE
//!
//! The docs describe a `GET /v1/sessions/<id>/stream` SSE endpoint, but
//! it returns `not_found_error` in the environments we've tested (the
//! beta surface appears to gate it). `GET /v1/sessions/<id>/events`
//! reliably returns the full event history, so [`run_event`] polls that
//! instead. [`stream_argv`] is kept for when the SSE endpoint becomes
//! generally available.
//!
//! The argv-building helpers are split out so unit tests can assert
//! shape (URLs, header order, body) without spawning `curl`.

use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use thiserror::Error;
use tokio::process::Command;
use tokio::time::{sleep, timeout, Instant};

use crate::config::Config;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("spawn curl failed: {0}")]
    Spawn(String),
    #[error("curl exited with status {status}: {stderr}")]
    NonZero { status: i32, stderr: String },
    #[error("api timed out")]
    Timeout,
    #[error("response JSON parse failed: {0}")]
    Json(String),
    #[error("missing field `{0}` in response")]
    MissingField(&'static str),
    #[error("io: {0}")]
    Io(String),
}

/// `curl` args common to every Managed Agents call.
pub fn common_headers(cfg: &Config) -> Vec<String> {
    vec![
        "-sS".into(),
        "--fail-with-body".into(),
        "-H".into(),
        format!("x-api-key: {}", cfg.api_key),
        "-H".into(),
        format!("anthropic-version: {}", cfg.anthropic_version),
        "-H".into(),
        format!("anthropic-beta: {}", cfg.beta_header),
    ]
}

/// argv for `POST /v1/agents`.
pub fn create_agent_argv(cfg: &Config, body: &str) -> Vec<String> {
    let mut argv = common_headers(cfg);
    argv.extend([
        "-H".into(),
        "content-type: application/json".into(),
        "-X".into(),
        "POST".into(),
        format!("{}/v1/agents", cfg.base_url),
        "-d".into(),
        body.to_string(),
    ]);
    argv
}

/// argv for `POST /v1/environments`.
pub fn create_environment_argv(cfg: &Config, body: &str) -> Vec<String> {
    let mut argv = common_headers(cfg);
    argv.extend([
        "-H".into(),
        "content-type: application/json".into(),
        "-X".into(),
        "POST".into(),
        format!("{}/v1/environments", cfg.base_url),
        "-d".into(),
        body.to_string(),
    ]);
    argv
}

/// argv for `POST /v1/sessions`.
pub fn create_session_argv(cfg: &Config, body: &str) -> Vec<String> {
    let mut argv = common_headers(cfg);
    argv.extend([
        "-H".into(),
        "content-type: application/json".into(),
        "-X".into(),
        "POST".into(),
        format!("{}/v1/sessions", cfg.base_url),
        "-d".into(),
        body.to_string(),
    ]);
    argv
}

/// argv for `POST /v1/sessions/<id>/events`.
pub fn send_event_argv(cfg: &Config, session_id: &str, body: &str) -> Vec<String> {
    let mut argv = common_headers(cfg);
    argv.extend([
        "-H".into(),
        "content-type: application/json".into(),
        "-X".into(),
        "POST".into(),
        format!("{}/v1/sessions/{}/events", cfg.base_url, session_id),
        "-d".into(),
        body.to_string(),
    ]);
    argv
}

/// argv for `GET /v1/sessions/<id>/stream` with the long-lived SSE handle.
pub fn stream_argv(cfg: &Config, session_id: &str) -> Vec<String> {
    let mut argv = common_headers(cfg);
    argv.extend([
        "-N".into(),
        "-H".into(),
        "accept: text/event-stream".into(),
        format!("{}/v1/sessions/{}/stream", cfg.base_url, session_id),
    ]);
    argv
}

/// Spawn curl with the given argv, await stdout, parse as JSON.
async fn run_json(cfg: &Config, argv: Vec<String>) -> Result<Value, ApiError> {
    let mut cmd = Command::new(&cfg.curl_binary);
    cmd.args(&argv)
        .stdin(Stdio::null())
        // `wait_with_output` only captures piped streams; without these
        // the child inherits the parent's stdout and `out.stdout` is
        // empty, which previously surfaced as a spurious "EOF while
        // parsing" JSON error on every call.
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = cmd.spawn().map_err(|e| ApiError::Spawn(e.to_string()))?;
    let fut = child.wait_with_output();
    let out = match timeout(cfg.timeout, fut).await {
        Err(_) => return Err(ApiError::Timeout),
        Ok(Err(e)) => return Err(ApiError::Spawn(e.to_string())),
        Ok(Ok(o)) => o,
    };
    if !out.status.success() {
        return Err(ApiError::NonZero {
            status: out.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        });
    }
    serde_json::from_slice::<Value>(&out.stdout).map_err(|e| ApiError::Json(e.to_string()))
}

/// Create a research agent. Returns the new agent id.
pub async fn create_agent(cfg: &Config, name: &str, system: &str) -> Result<String, ApiError> {
    let body = json!({
        "name": name,
        "model": cfg.model,
        "system": system,
        "tools": [{"type": "agent_toolset_20260401"}],
    })
    .to_string();
    let v = run_json(cfg, create_agent_argv(cfg, &body)).await?;
    v.get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or(ApiError::MissingField("id"))
}

/// Create an environment. Returns the new environment id.
pub async fn create_environment(cfg: &Config, name: &str) -> Result<String, ApiError> {
    let body = json!({
        "name": name,
        "config": {"type": "cloud", "networking": {"type": "unrestricted"}},
    })
    .to_string();
    let v = run_json(cfg, create_environment_argv(cfg, &body)).await?;
    v.get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or(ApiError::MissingField("id"))
}

/// Create a session against a known agent + environment.
pub async fn create_session(
    cfg: &Config,
    agent_id: &str,
    environment_id: &str,
    title: &str,
) -> Result<String, ApiError> {
    let body = json!({
        "agent": agent_id,
        "environment_id": environment_id,
        "title": title,
    })
    .to_string();
    let v = run_json(cfg, create_session_argv(cfg, &body)).await?;
    v.get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or(ApiError::MissingField("id"))
}

/// Build the JSON body for a single-message user event.
pub fn user_event_body(text: &str) -> String {
    json!({
        "events": [{
            "type": "user.message",
            "content": [{"type": "text", "text": text}],
        }]
    })
    .to_string()
}

/// argv for `GET /v1/sessions/<id>/events` (the full event history).
pub fn list_events_argv(cfg: &Config, session_id: &str) -> Vec<String> {
    let mut argv = common_headers(cfg);
    argv.push(format!("{}/v1/sessions/{}/events", cfg.base_url, session_id));
    argv
}

/// Fetch the session's event history; returns the `data` array (empty
/// if absent).
async fn list_events(cfg: &Config, session_id: &str) -> Result<Vec<Value>, ApiError> {
    let v = run_json(cfg, list_events_argv(cfg, session_id)).await?;
    Ok(v.get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn event_type(e: &Value) -> Option<&str> {
    e.get("type").and_then(Value::as_str)
}

/// Concatenate the `text` blocks of every `agent.message` event in
/// `events`.
fn collect_agent_text(events: &[Value]) -> String {
    events
        .iter()
        .filter(|e| event_type(e) == Some("agent.message"))
        .filter_map(|e| e.get("content").and_then(Value::as_array))
        .flat_map(|blocks| blocks.iter())
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect()
}

/// Full round-trip via the events endpoint.
///
/// 1. Snapshot the current event count so we only pick up messages this
///    turn produces.
/// 2. `POST /v1/sessions/<id>/events` with `prompt` as a `user.message`.
/// 3. Poll `GET /v1/sessions/<id>/events` (~1.5s cadence) until the
///    events past our snapshot include a terminal `session.status_idle`.
/// 4. Return the concatenated text of every `agent.message` in that
///    window.
///
/// Bounded by `cfg.timeout`; returns `ApiError::Timeout` if the turn
/// hasn't finished by then.
pub async fn run_event(
    cfg: &Config,
    session_id: &str,
    prompt: &str,
) -> Result<String, ApiError> {
    let before = list_events(cfg, session_id).await?.len();

    let send = run_json(cfg, send_event_argv(cfg, session_id, &user_event_body(prompt)));
    match timeout(cfg.timeout, send).await {
        Err(_) => return Err(ApiError::Timeout),
        Ok(r) => {
            r?;
        }
    }

    let deadline = Instant::now() + cfg.timeout;
    loop {
        if Instant::now() >= deadline {
            return Err(ApiError::Timeout);
        }
        sleep(Duration::from_millis(1500)).await;
        let events = list_events(cfg, session_id).await?;
        if events.len() <= before {
            continue; // nothing new yet
        }
        let turn = &events[before..];
        let done = turn
            .iter()
            .any(|e| event_type(e) == Some("session.status_idle"));
        if !done {
            continue;
        }
        return Ok(collect_agent_text(turn));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Config {
        Config {
            api_key: "sk-ant-test".into(),
            ..Config::default()
        }
    }

    #[test]
    fn common_headers_include_api_key_and_beta() {
        let h = common_headers(&cfg());
        assert!(h.windows(2).any(|w| w[0] == "-H" && w[1] == "x-api-key: sk-ant-test"));
        assert!(h
            .windows(2)
            .any(|w| w[0] == "-H" && w[1] == "anthropic-beta: managed-agents-2026-04-01"));
        assert!(h
            .windows(2)
            .any(|w| w[0] == "-H" && w[1] == "anthropic-version: 2023-06-01"));
    }

    #[test]
    fn create_agent_argv_has_correct_url_and_body() {
        let argv = create_agent_argv(&cfg(), r#"{"hello":"world"}"#);
        assert!(argv.contains(&"https://api.anthropic.com/v1/agents".to_string()));
        assert!(argv.contains(&"-X".to_string()));
        assert!(argv.contains(&"POST".to_string()));
        assert!(argv.contains(&"-d".to_string()));
        assert!(argv.contains(&r#"{"hello":"world"}"#.to_string()));
    }

    #[test]
    fn send_event_argv_targets_session_subpath() {
        let argv = send_event_argv(&cfg(), "ses_abc", "{}");
        assert!(argv
            .iter()
            .any(|a| a == "https://api.anthropic.com/v1/sessions/ses_abc/events"));
    }

    #[test]
    fn stream_argv_uses_no_buffering_and_sse_accept() {
        let argv = stream_argv(&cfg(), "ses_xyz");
        assert!(argv.contains(&"-N".to_string()));
        assert!(argv
            .windows(2)
            .any(|w| w[0] == "-H" && w[1] == "accept: text/event-stream"));
        assert!(argv
            .iter()
            .any(|a| a == "https://api.anthropic.com/v1/sessions/ses_xyz/stream"));
    }

    #[test]
    fn user_event_body_matches_doc_shape() {
        let body = user_event_body("hello world");
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["events"][0]["type"], "user.message");
        assert_eq!(v["events"][0]["content"][0]["type"], "text");
        assert_eq!(v["events"][0]["content"][0]["text"], "hello world");
    }

    #[test]
    fn list_events_argv_is_a_get_on_the_events_subpath() {
        let argv = list_events_argv(&cfg(), "sesn_abc");
        assert!(argv
            .iter()
            .any(|a| a == "https://api.anthropic.com/v1/sessions/sesn_abc/events"));
        // No POST, no body — it's a GET.
        assert!(!argv.contains(&"-X".to_string()));
        assert!(!argv.contains(&"-d".to_string()));
    }

    #[test]
    fn collect_agent_text_concatenates_text_blocks_only() {
        let events = vec![
            json!({"type": "session.status_running"}),
            json!({"type": "user.message", "content": [{"type": "text", "text": "ignore me"}]}),
            json!({"type": "agent.thinking", "content": [{"type": "text", "text": "ignore thinking"}]}),
            json!({"type": "agent.message", "content": [
                {"type": "text", "text": "```json\n"},
                {"type": "thinking", "thinking": "drop this"},
                {"type": "text", "text": "{\"ok\":true}\n```"},
            ]}),
            json!({"type": "agent.message", "content": [{"type": "text", "text": " trailing"}]}),
            json!({"type": "session.status_idle"}),
        ];
        let text = collect_agent_text(&events);
        assert_eq!(text, "```json\n{\"ok\":true}\n``` trailing");
    }

    #[test]
    fn collect_agent_text_empty_when_no_agent_messages() {
        let events = vec![
            json!({"type": "session.status_running"}),
            json!({"type": "user.message", "content": [{"type": "text", "text": "x"}]}),
            json!({"type": "session.status_idle"}),
        ];
        assert_eq!(collect_agent_text(&events), "");
    }

    #[test]
    fn event_type_extracts_string_or_none() {
        assert_eq!(event_type(&json!({"type": "agent.message"})), Some("agent.message"));
        assert_eq!(event_type(&json!({"type": 42})), None);
        assert_eq!(event_type(&json!({})), None);
    }

    #[test]
    fn base_url_override_propagates() {
        let mut c = cfg();
        c.base_url = "http://localhost:1234".into();
        let argv = create_agent_argv(&c, "{}");
        assert!(argv.contains(&"http://localhost:1234/v1/agents".to_string()));
    }
}
