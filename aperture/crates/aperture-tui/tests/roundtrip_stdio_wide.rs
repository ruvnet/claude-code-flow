//! Wave-1 wide round-trip tests: spawn the `aperture` binary in
//! `--agent=pane.<id>` mode for each of the 11 new pane-agents (plus the
//! `pane.export` host-formatter) and verify each replies with a properly
//! shaped `Envelope` carrying the right `*.RESULT` verb and a non-trivial
//! payload key set.
//!
//! Mirrors the style of `tests/roundtrip_stdio.rs`. Each test:
//!   1. Spawns the binary with `--agent=pane.<id>`.
//!   2. Writes a single request `Envelope` JSON line on stdin.
//!   3. Reads one reply line from stdout (5 s timeout).
//!   4. Asserts:
//!        a) `payload.verb` ends with `.RESULT`.
//!        b) `correlationId` mirrors the request.
//!        c) For symbol-prefixed verbs, `payload.symbol` is uppercased.
//!        d) The expected per-pane data key is present.
//!
//! No new dev-deps: reuses tokio process/io/time features the existing
//! round-trip test already pulls in.

use std::process::Stdio;
use std::time::Duration;

use aperture_swarm::{Envelope, MessageType, Priority};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

const APERTURE_BIN: &str = env!("CARGO_BIN_EXE_aperture");
const TIMEOUT: Duration = Duration::from_secs(5);

fn make_request(to: &str, payload: Value, correlation_id: &str) -> Envelope {
    Envelope {
        id: format!("test-{correlation_id}"),
        message_type: MessageType::Direct,
        from: "aperture:test-harness".into(),
        to: to.into(),
        payload,
        timestamp: "2026-05-10T15:04:05.000Z".into(),
        priority: Priority::High,
        requires_ack: false,
        ttl_ms: 5000,
        correlation_id: Some(correlation_id.into()),
    }
}

/// Spawn the binary with `--agent=<arg>`, send `req` on stdin, read one
/// reply line, send EOF, wait (with timeout) for the child to exit, then
/// return the parsed reply.
async fn round_trip(agent_arg: &str, req: &Envelope) -> Envelope {
    let mut child = Command::new(APERTURE_BIN)
        .arg(format!("--agent={agent_arg}"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn aperture binary");

    let mut stdin = child.stdin.take().expect("child stdin");
    let stdout = child.stdout.take().expect("child stdout");
    let mut reader = BufReader::new(stdout).lines();

    let line = serde_json::to_string(req).unwrap();
    stdin.write_all(line.as_bytes()).await.unwrap();
    stdin.write_all(b"\n").await.unwrap();
    stdin.flush().await.unwrap();

    let line = timeout(TIMEOUT, reader.next_line())
        .await
        .expect("agent reply timeout")
        .expect("io error reading agent reply")
        .expect("expected one reply line, got EOF");

    drop(stdin);
    let _ = timeout(TIMEOUT, child.wait()).await;

    serde_json::from_str(&line).expect("reply is not valid Envelope JSON")
}

/// Common reply assertions:
///   * `verb` matches `expected_verb` (always ends with `.RESULT`).
///   * `correlationId` matches the request.
///   * No `error` key was set (panes return `error` strings on bad input).
fn assert_result_envelope(resp: &Envelope, expected_verb: &str, correlation_id: &str) {
    assert!(
        expected_verb.ends_with(".RESULT"),
        "test bug: expected verb {expected_verb} should end with .RESULT"
    );
    assert_eq!(
        resp.payload["verb"], expected_verb,
        "verb mismatch in payload: {}",
        resp.payload
    );
    assert_eq!(
        resp.correlation_id.as_deref(),
        Some(correlation_id),
        "correlationId did not echo back: {:?}",
        resp.correlation_id
    );
    assert!(
        resp.payload.get("error").is_none(),
        "agent returned an error payload: {}",
        resp.payload
    );
}

// ---------------------------------------------------------------------------
// 1. NEWS — symbol-scoped, returns data.headlines
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_news_round_trip() {
    let req = make_request(
        "aperture:pane.news",
        json!({"verb": "NEWS", "symbol": "aapl"}),
        "corr-news-1",
    );
    let resp = round_trip("pane.news", &req).await;
    assert_result_envelope(&resp, "NEWS.RESULT", "corr-news-1");
    // News pane echoes the uppercased symbol as the scope label.
    assert_eq!(resp.payload["scope"], "AAPL");
    let headlines = resp.payload["data"]["headlines"]
        .as_array()
        .expect("data.headlines must be an array");
    assert!(!headlines.is_empty(), "expected at least one headline");
}

// ---------------------------------------------------------------------------
// 2. MACRO — bare verb, returns rows
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_macro_round_trip() {
    let req = make_request(
        "aperture:pane.macro",
        json!({"verb": "MACRO"}),
        "corr-macro-1",
    );
    let resp = round_trip("pane.macro", &req).await;
    assert_result_envelope(&resp, "MACRO.RESULT", "corr-macro-1");
    let rows = resp.payload["rows"]
        .as_array()
        .expect("rows must be an array");
    assert!(!rows.is_empty(), "expected at least one indicator row");
    // Each row should have a name + value (sanity check on the in-memory shape).
    assert!(rows[0].get("name").and_then(Value::as_str).is_some());
    assert!(rows[0].get("value").and_then(Value::as_f64).is_some());
}

// ---------------------------------------------------------------------------
// 3. YIELDS — bare verb, returns curve
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_yields_round_trip() {
    let req = make_request(
        "aperture:pane.yields",
        json!({"verb": "YIELDS"}),
        "corr-yields-1",
    );
    let resp = round_trip("pane.yields", &req).await;
    assert_result_envelope(&resp, "YIELDS.RESULT", "corr-yields-1");
    let curve = resp.payload["curve"]
        .as_array()
        .expect("curve must be an array");
    assert!(!curve.is_empty(), "expected non-empty yield curve");
    assert!(curve[0]
        .get("tenor")
        .and_then(Value::as_str)
        .is_some());
}

// ---------------------------------------------------------------------------
// 4. FX — bare verb, returns data.base
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_fx_round_trip() {
    let req = make_request(
        "aperture:pane.fx",
        json!({"verb": "FX", "base": "eur"}),
        "corr-fx-1",
    );
    let resp = round_trip("pane.fx", &req).await;
    assert_result_envelope(&resp, "FX.RESULT", "corr-fx-1");
    // FX pane uppercases the base before delegating to the source.
    assert_eq!(resp.payload["data"]["base"], "EUR");
    let rates = resp.payload["data"]["rates"]
        .as_array()
        .expect("data.rates must be an array");
    assert!(!rates.is_empty());
}

// ---------------------------------------------------------------------------
// 5. OPTIONS — symbol-prefixed, returns chain.rows
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_options_round_trip() {
    let req = make_request(
        "aperture:pane.options",
        json!({"verb": "OPTIONS", "symbol": "AAPL"}),
        "corr-options-1",
    );
    let resp = round_trip("pane.options", &req).await;
    assert_result_envelope(&resp, "OPTIONS.RESULT", "corr-options-1");
    assert_eq!(resp.payload["symbol"], "AAPL");
    let rows = resp.payload["chain"]["rows"]
        .as_array()
        .expect("chain.rows must be an array");
    assert!(!rows.is_empty(), "expected at least one strike row");
}

// ---------------------------------------------------------------------------
// 6. INSIDER — symbol-prefixed, returns data.trades
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_insider_round_trip() {
    let req = make_request(
        "aperture:pane.insider",
        json!({"verb": "INSIDER", "symbol": "aapl"}),
        "corr-insider-1",
    );
    let resp = round_trip("pane.insider", &req).await;
    assert_result_envelope(&resp, "INSIDER.RESULT", "corr-insider-1");
    assert_eq!(resp.payload["symbol"], "AAPL");
    let trades = resp.payload["data"]["trades"]
        .as_array()
        .expect("data.trades must be an array");
    assert!(!trades.is_empty(), "expected insider trades");
}

// ---------------------------------------------------------------------------
// 7. FINANCIALS — symbol-prefixed, returns data.income_ttm
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_financials_round_trip() {
    let req = make_request(
        "aperture:pane.financials",
        json!({"verb": "FINANCIALS", "symbol": "AAPL"}),
        "corr-fin-1",
    );
    let resp = round_trip("pane.financials", &req).await;
    assert_result_envelope(&resp, "FINANCIALS.RESULT", "corr-fin-1");
    assert_eq!(resp.payload["symbol"], "AAPL");
    let revenue = resp.payload["data"]["income_ttm"]["revenue"]
        .as_f64()
        .expect("data.income_ttm.revenue should be a number");
    assert!(revenue > 0.0, "expected positive revenue");
}

// ---------------------------------------------------------------------------
// 8. CRYPTO — symbol-prefixed, returns data.vol_24h
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_crypto_round_trip() {
    let req = make_request(
        "aperture:pane.crypto",
        json!({"verb": "CRYPTO", "symbol": "btc"}),
        "corr-crypto-1",
    );
    let resp = round_trip("pane.crypto", &req).await;
    assert_result_envelope(&resp, "CRYPTO.RESULT", "corr-crypto-1");
    assert_eq!(resp.payload["symbol"], "BTC");
    let vol = resp.payload["data"]["vol_24h"]
        .as_f64()
        .expect("data.vol_24h must be a number");
    assert!(vol > 0.0, "expected positive 24h volume");
}

// ---------------------------------------------------------------------------
// 9. RISK — bare verb with symbols list, returns data.rows
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_risk_round_trip() {
    let req = make_request(
        "aperture:pane.risk",
        json!({"verb": "RISK", "symbols": ["AAPL", "TSLA"]}),
        "corr-risk-1",
    );
    let resp = round_trip("pane.risk", &req).await;
    assert_result_envelope(&resp, "RISK.RESULT", "corr-risk-1");
    let rows = resp.payload["data"]["rows"]
        .as_array()
        .expect("data.rows must be an array");
    assert_eq!(rows.len(), 2, "expected one row per requested symbol");
    // Symbols echoed uppercased.
    let row_syms: Vec<&str> = rows
        .iter()
        .filter_map(|r| r.get("symbol").and_then(Value::as_str))
        .collect();
    assert!(row_syms.contains(&"AAPL"));
    assert!(row_syms.contains(&"TSLA"));
}

// ---------------------------------------------------------------------------
// 10. CORPACT — symbol-prefixed, returns data.events
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_corpact_round_trip() {
    let req = make_request(
        "aperture:pane.corpact",
        json!({"verb": "CORPACT", "symbol": "AAPL"}),
        "corr-corpact-1",
    );
    let resp = round_trip("pane.corpact", &req).await;
    assert_result_envelope(&resp, "CORPACT.RESULT", "corr-corpact-1");
    assert_eq!(resp.payload["symbol"], "AAPL");
    let events = resp.payload["data"]["events"]
        .as_array()
        .expect("data.events must be an array");
    assert!(!events.is_empty(), "expected at least one corp action event");
}

// ---------------------------------------------------------------------------
// 11. INBOX — bare verb, returns messages
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_inbox_round_trip() {
    // Fresh InboxPane starts empty; we just ask for the list and assert
    // that `messages` is an array (possibly empty).
    let req = make_request(
        "aperture:pane.inbox",
        json!({"verb": "INBOX"}),
        "corr-inbox-1",
    );
    let resp = round_trip("pane.inbox", &req).await;
    assert_result_envelope(&resp, "INBOX.RESULT", "corr-inbox-1");
    let messages = resp.payload["messages"]
        .as_array()
        .expect("messages must be an array");
    assert!(messages.is_empty(), "fresh inbox should be empty");
}

// ---------------------------------------------------------------------------
// 12. EXPORT — bare verb, returns format
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_export_round_trip() {
    let snapshot = json!({"focus": "AAPL", "panes": ["quote", "chart"]});
    let req = make_request(
        "aperture:pane.export",
        json!({"verb": "EXPORT", "format": "json", "snapshot": snapshot}),
        "corr-export-1",
    );
    let resp = round_trip("pane.export", &req).await;
    assert_result_envelope(&resp, "EXPORT.RESULT", "corr-export-1");
    assert_eq!(resp.payload["format"], "json");
    let body = resp.payload["body"]
        .as_str()
        .expect("body must be a string");
    assert!(body.contains("AAPL"), "rendered body must include the focus symbol");
}
