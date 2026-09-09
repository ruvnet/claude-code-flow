//! `claude -p` invocation: build the command, capture stdout, parse the
//! `--output-format json` envelope, extract the model's text response,
//! and parse THAT as JSON. Splits assembly from execution so unit tests
//! can exercise the command-line shape without spawning a process.

use std::process::Stdio;

use serde_json::Value;
use thiserror::Error;
use tokio::process::Command;
use tokio::time::timeout;

use crate::config::Config;

#[derive(Debug, Error)]
pub enum ExecError {
    #[error("spawn failed: {0}")]
    Spawn(String),
    #[error("claude exited with status {status}: {stderr}")]
    NonZero { status: i32, stderr: String },
    #[error("claude invocation timed out")]
    Timeout,
    #[error("envelope JSON parse failed: {0}")]
    EnvelopeJson(String),
    #[error("model returned no `result` field")]
    NoResult,
    #[error("model response is not valid JSON: {0}")]
    BodyJson(String),
    #[error("validation failed: {0}")]
    Validation(String),
}

/// Build the argv vector for a `claude -p` invocation. Pure — used by
/// `run` and by unit tests that assert on the command shape.
pub fn build_argv(prompt: &str, cfg: &Config) -> Vec<String> {
    let mut argv: Vec<String> = vec![
        "-p".into(),
        "--output-format".into(),
        "json".into(),
        "--dangerously-skip-permissions".into(),
        "--max-budget-usd".into(),
        format!("{}", cfg.max_budget_usd),
        "--allowedTools".into(),
        cfg.allowed_tools.join(","),
    ];
    if let Some(model) = &cfg.model {
        argv.push("--model".into());
        argv.push(model.clone());
    }
    argv.push(prompt.to_string());
    argv
}

/// Spawn `claude -p`, capture its `--output-format json` envelope, and
/// return the parsed inner result body as a `serde_json::Value`.
pub async fn run(prompt: &str, cfg: &Config) -> Result<Value, ExecError> {
    let argv = build_argv(prompt, cfg);
    let mut cmd = Command::new(&cfg.binary);
    cmd.args(&argv);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let child = cmd.spawn().map_err(|e| ExecError::Spawn(e.to_string()))?;
    let output_fut = child.wait_with_output();
    let output = match timeout(cfg.timeout, output_fut).await {
        Err(_) => return Err(ExecError::Timeout),
        Ok(Err(e)) => return Err(ExecError::Spawn(e.to_string())),
        Ok(Ok(o)) => o,
    };

    if !output.status.success() {
        return Err(ExecError::NonZero {
            status: output.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        });
    }

    extract_result_body(&output.stdout)
}

/// Pure body-extraction: takes the raw `--output-format json` envelope
/// bytes, finds the `.result` field, and parses it as JSON. Split out
/// so it can be unit-tested with canned envelopes.
pub fn extract_result_body(envelope_bytes: &[u8]) -> Result<Value, ExecError> {
    let envelope: Value = serde_json::from_slice(envelope_bytes)
        .map_err(|e| ExecError::EnvelopeJson(e.to_string()))?;
    let body_text = envelope
        .get("result")
        .and_then(Value::as_str)
        .ok_or(ExecError::NoResult)?;
    parse_loose_json(body_text)
}

/// Parse a string that should be JSON, but tolerate code fences and
/// surrounding prose by extracting the first balanced `{...}` or
/// `[...]` slice.
pub fn parse_loose_json(s: &str) -> Result<Value, ExecError> {
    if let Ok(v) = serde_json::from_str::<Value>(s.trim()) {
        return Ok(v);
    }
    let bytes = s.as_bytes();
    // Find the earliest opening brace/bracket and the matching close.
    let opens: &[u8] = &[b'{', b'['];
    let Some(start) = bytes.iter().position(|b| opens.contains(b)) else {
        return Err(ExecError::BodyJson("no JSON object/array found".into()));
    };
    let open = bytes[start];
    let close = if open == b'{' { b'}' } else { b']' };
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escape = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if escape {
            escape = false;
            continue;
        }
        if in_str {
            if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        if b == b'"' {
            in_str = true;
        } else if b == open {
            depth += 1;
        } else if b == close {
            depth -= 1;
            if depth == 0 {
                let slice = &s[start..=i];
                return serde_json::from_str(slice)
                    .map_err(|e| ExecError::BodyJson(e.to_string()));
            }
        }
    }
    Err(ExecError::BodyJson("unbalanced brackets".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn argv_includes_required_flags() {
        let cfg = Config::default();
        let argv = build_argv("hello", &cfg);
        assert!(argv.iter().any(|a| a == "-p"));
        assert!(argv.iter().any(|a| a == "--output-format"));
        assert!(argv.iter().any(|a| a == "json"));
        assert!(argv.iter().any(|a| a == "--dangerously-skip-permissions"));
        assert!(argv.iter().any(|a| a == "--allowedTools"));
        assert!(argv.iter().any(|a| a == "WebFetch,WebSearch"));
        assert!(argv.iter().any(|a| a == "--model"));
        assert!(argv.iter().any(|a| a == "haiku"));
        assert_eq!(argv.last().unwrap(), "hello");
    }

    #[test]
    fn argv_omits_model_when_none() {
        let cfg = Config { model: None, ..Config::default() };
        let argv = build_argv("hello", &cfg);
        assert!(!argv.iter().any(|a| a == "--model"));
    }

    #[test]
    fn extract_result_body_parses_clean_json() {
        let env = json!({
            "type": "result", "subtype": "success",
            "result": "{\"a\": 1, \"b\": [2, 3]}"
        }).to_string();
        let body = extract_result_body(env.as_bytes()).unwrap();
        assert_eq!(body["a"], 1);
        assert_eq!(body["b"], json!([2, 3]));
    }

    #[test]
    fn extract_result_body_strips_code_fences() {
        let env = json!({
            "type": "result", "subtype": "success",
            "result": "```json\n{\"ok\": true}\n```"
        }).to_string();
        let body = extract_result_body(env.as_bytes()).unwrap();
        assert_eq!(body["ok"], true);
    }

    #[test]
    fn extract_result_body_strips_surrounding_prose() {
        let env = json!({
            "type": "result", "subtype": "success",
            "result": "Here is the JSON you asked for: {\"x\": 42}. Hope it helps!"
        }).to_string();
        let body = extract_result_body(env.as_bytes()).unwrap();
        assert_eq!(body["x"], 42);
    }

    #[test]
    fn extract_result_body_handles_array_root() {
        let env = json!({
            "type": "result", "subtype": "success",
            "result": "[{\"k\": 1}, {\"k\": 2}]"
        }).to_string();
        let body = extract_result_body(env.as_bytes()).unwrap();
        let arr = body.as_array().unwrap();
        assert_eq!(arr.len(), 2);
    }

    #[test]
    fn extract_result_body_rejects_envelope_with_no_result() {
        let env = json!({"type": "result", "subtype": "error"}).to_string();
        match extract_result_body(env.as_bytes()) {
            Err(ExecError::NoResult) => {}
            other => panic!("expected NoResult, got {other:?}"),
        }
    }

    #[test]
    fn extract_result_body_rejects_malformed_envelope() {
        match extract_result_body(b"not json") {
            Err(ExecError::EnvelopeJson(_)) => {}
            other => panic!("expected EnvelopeJson, got {other:?}"),
        }
    }

    #[test]
    fn parse_loose_json_handles_braces_inside_strings() {
        let v = parse_loose_json(r#"prelude {"label": "}"} trailing"#).unwrap();
        assert_eq!(v["label"], "}");
    }
}
