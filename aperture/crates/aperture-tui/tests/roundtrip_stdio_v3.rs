//! Wave-3a wide round-trip tests: spawn the `aperture` binary in
//! `--agent=pane.<id>` mode for each of the 10 new pane-agents and verify
//! each replies with a properly shaped `Envelope` carrying the right
//! `*.RESULT` verb and a non-trivial payload key set.
//!
//! Mirrors the style of `tests/roundtrip_stdio_wide.rs`. Each test:
//!   1. Spawns the binary with `--agent=pane.<id>`.
//!   2. Writes a single request `Envelope` JSON line on stdin.
//!   3. Reads one reply line from stdout (5 s timeout).
//!   4. Asserts:
//!        a) `payload.verb` ends with `.RESULT`.
//!        b) `correlationId` mirrors the request.
//!        c) For symbol-prefixed verbs, `payload.symbol` is uppercased.
//!        d) The expected per-pane data key is present.
//!        e) No `error` key on the happy path.
//!
//! No new dev-deps: reuses tokio process/io/time features that the existing
//! Wave-1 round-trip test already pulls in.

use std::process::Stdio;
use std::time::Duration;

use aperture_swarm::{Envelope, MessageType, Priority};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
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
// 1. EARNINGS — bare verb, returns data.events
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_earnings_round_trip() {
    let req = make_request(
        "aperture:pane.earnings",
        json!({"verb": "EARNINGS"}),
        "corr-earnings-1",
    );
    let resp = round_trip("pane.earnings", &req).await;
    assert_result_envelope(&resp, "EARNINGS.RESULT", "corr-earnings-1");
    let events = resp.payload["data"]["events"]
        .as_array()
        .expect("data.events must be an array");
    assert!(!events.is_empty(), "expected at least one earnings event");
}

// ---------------------------------------------------------------------------
// 2. MOVERS — bare verb, scope=losers, asserts data.scope echo
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_movers_round_trip() {
    let req = make_request(
        "aperture:pane.movers",
        json!({"verb": "MOVERS", "scope": "losers"}),
        "corr-movers-1",
    );
    let resp = round_trip("pane.movers", &req).await;
    assert_result_envelope(&resp, "MOVERS.RESULT", "corr-movers-1");
    assert_eq!(
        resp.payload["data"]["scope"], "losers",
        "scope must echo back as 'losers'"
    );
    let rows = resp.payload["data"]["rows"]
        .as_array()
        .expect("data.rows must be an array");
    assert!(!rows.is_empty(), "expected at least one mover row");
}

// ---------------------------------------------------------------------------
// 3. SCREEN — bare verb, returns data.matches
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_screen_round_trip() {
    let req = make_request(
        "aperture:pane.screen",
        json!({"verb": "SCREEN"}),
        "corr-screen-1",
    );
    let resp = round_trip("pane.screen", &req).await;
    assert_result_envelope(&resp, "SCREEN.RESULT", "corr-screen-1");
    let matches = resp.payload["data"]["matches"]
        .as_array()
        .expect("data.matches must be an array");
    assert!(!matches.is_empty(), "expected at least one screener match");
}

// ---------------------------------------------------------------------------
// 4. MEMBERS — symbol-prefixed (the index ticker), returns data.members
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_members_round_trip() {
    let req = make_request(
        "aperture:pane.members",
        json!({"verb": "MEMBERS", "symbol": "SPX"}),
        "corr-members-1",
    );
    let resp = round_trip("pane.members", &req).await;
    assert_result_envelope(&resp, "MEMBERS.RESULT", "corr-members-1");
    assert_eq!(resp.payload["symbol"], "SPX");
    let members = resp.payload["data"]["members"]
        .as_array()
        .expect("data.members must be an array");
    assert!(!members.is_empty(), "expected at least one index member");
}

// ---------------------------------------------------------------------------
// 5. IVOL — symbol-prefixed, returns data.rows
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_ivol_round_trip() {
    let req = make_request(
        "aperture:pane.ivol",
        json!({"verb": "IVOL", "symbol": "aapl"}),
        "corr-ivol-1",
    );
    let resp = round_trip("pane.ivol", &req).await;
    assert_result_envelope(&resp, "IVOL.RESULT", "corr-ivol-1");
    assert_eq!(resp.payload["symbol"], "AAPL", "symbol must be uppercased");
    let rows = resp.payload["data"]["rows"]
        .as_array()
        .expect("data.rows must be an array");
    assert!(!rows.is_empty(), "expected at least one vol-surface row");
}

// ---------------------------------------------------------------------------
// 6. TECH — symbol-prefixed with indicator=SMA, returns data.value (number)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_tech_round_trip() {
    let req = make_request(
        "aperture:pane.tech",
        json!({"verb": "TECH", "symbol": "AAPL", "indicator": "SMA"}),
        "corr-tech-1",
    );
    let resp = round_trip("pane.tech", &req).await;
    assert_result_envelope(&resp, "TECH.RESULT", "corr-tech-1");
    assert_eq!(resp.payload["symbol"], "AAPL");
    assert_eq!(resp.payload["indicator"], "SMA");
    let value = resp.payload["data"]["value"]
        .as_f64()
        .expect("data.value must be a number");
    assert!(value.is_finite(), "expected a finite SMA value, got {value}");
}

// ---------------------------------------------------------------------------
// 7. CORR — bare verb with symbols list, returns data.matrix (length 2)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_corr_round_trip() {
    let req = make_request(
        "aperture:pane.corr",
        json!({"verb": "CORR", "symbols": ["AAPL", "MSFT"]}),
        "corr-corr-1",
    );
    let resp = round_trip("pane.corr", &req).await;
    assert_result_envelope(&resp, "CORR.RESULT", "corr-corr-1");
    let matrix = resp.payload["data"]["matrix"]
        .as_array()
        .expect("data.matrix must be an array");
    assert_eq!(matrix.len(), 2, "expected 2x2 correlation matrix");
    // Diagonal sanity check: each row's [i] == 1.0.
    for (i, entry) in matrix.iter().enumerate() {
        let row = entry["row"]
            .as_array()
            .expect("matrix entry must have a row array");
        assert_eq!(
            row[i].as_f64(),
            Some(1.0),
            "diagonal element [{i}][{i}] must be 1.0"
        );
    }
}

// ---------------------------------------------------------------------------
// 8. FILINGS — symbol-prefixed, returns data.filings
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_filings_round_trip() {
    let req = make_request(
        "aperture:pane.filings",
        json!({"verb": "FILINGS", "symbol": "AAPL"}),
        "corr-filings-1",
    );
    let resp = round_trip("pane.filings", &req).await;
    assert_result_envelope(&resp, "FILINGS.RESULT", "corr-filings-1");
    assert_eq!(resp.payload["symbol"], "AAPL");
    let filings = resp.payload["data"]["filings"]
        .as_array()
        .expect("data.filings must be an array");
    assert!(!filings.is_empty(), "expected at least one filing");
}

// ---------------------------------------------------------------------------
// 9. ORDER — three round-trips against ONE binary spawn (state matters):
//    a) BLOTTER → empty
//    b) ORDER {AAPL BUY 10}   → ORDER.RESULT
//    c) BLOTTER → length 1
// ---------------------------------------------------------------------------

async fn send_one(stdin: &mut ChildStdin, env: &Envelope) {
    let line = serde_json::to_string(env).unwrap();
    stdin.write_all(line.as_bytes()).await.unwrap();
    stdin.write_all(b"\n").await.unwrap();
    stdin.flush().await.unwrap();
}

async fn read_one<R: AsyncBufReadExt + Unpin>(reader: &mut tokio::io::Lines<R>) -> Envelope {
    let line = timeout(TIMEOUT, reader.next_line())
        .await
        .expect("agent reply timeout")
        .expect("io error reading agent reply")
        .expect("expected one reply line, got EOF");
    serde_json::from_str(&line).expect("reply is not valid Envelope JSON")
}

#[tokio::test]
async fn pane_order_blotter_then_order_then_blotter() {
    let mut child = Command::new(APERTURE_BIN)
        .arg("--agent=pane.order")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn aperture binary");

    let mut stdin = child.stdin.take().expect("child stdin");
    let stdout = child.stdout.take().expect("child stdout");
    let mut reader = BufReader::new(stdout).lines();

    // 1) BLOTTER on a fresh process should report an empty list.
    let req1 = make_request(
        "aperture:pane.order",
        json!({"verb": "BLOTTER"}),
        "corr-order-blot-pre",
    );
    send_one(&mut stdin, &req1).await;
    let resp1 = read_one(&mut reader).await;
    assert_result_envelope(&resp1, "BLOTTER.RESULT", "corr-order-blot-pre");
    let pre_orders = resp1.payload["orders"]
        .as_array()
        .expect("orders must be an array");
    assert!(
        pre_orders.is_empty(),
        "fresh blotter should be empty, got {pre_orders:?}"
    );

    // 2) ORDER AAPL BUY 10 → ORDER.RESULT with order body.
    let req2 = make_request(
        "aperture:pane.order",
        json!({"verb": "ORDER", "symbol": "AAPL", "side": "BUY", "qty": 10}),
        "corr-order-submit",
    );
    send_one(&mut stdin, &req2).await;
    let resp2 = read_one(&mut reader).await;
    assert_result_envelope(&resp2, "ORDER.RESULT", "corr-order-submit");
    assert_eq!(resp2.payload["order"]["symbol"], "AAPL");
    assert_eq!(resp2.payload["order"]["side"], "BUY");
    assert_eq!(resp2.payload["order"]["qty"], 10);
    assert_eq!(resp2.payload["order"]["status"], "PAPER_FILLED");

    // 3) BLOTTER should now have exactly one entry.
    let req3 = make_request(
        "aperture:pane.order",
        json!({"verb": "BLOTTER"}),
        "corr-order-blot-post",
    );
    send_one(&mut stdin, &req3).await;
    let resp3 = read_one(&mut reader).await;
    assert_result_envelope(&resp3, "BLOTTER.RESULT", "corr-order-blot-post");
    let post_orders = resp3.payload["orders"]
        .as_array()
        .expect("orders must be an array");
    assert_eq!(
        post_orders.len(),
        1,
        "blotter should have exactly one entry after one ORDER"
    );
    assert_eq!(post_orders[0]["symbol"], "AAPL");

    drop(stdin);
    let _ = timeout(TIMEOUT, child.wait()).await;
}

// ---------------------------------------------------------------------------
// 10. SENTIMENT — symbol-prefixed, label is in the allowed set
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pane_sentiment_round_trip() {
    let req = make_request(
        "aperture:pane.sentiment",
        json!({"verb": "SENTIMENT", "symbol": "AAPL"}),
        "corr-sentiment-1",
    );
    let resp = round_trip("pane.sentiment", &req).await;
    assert_result_envelope(&resp, "SENTIMENT.RESULT", "corr-sentiment-1");
    assert_eq!(resp.payload["symbol"], "AAPL");
    let label = resp.payload["data"]["label"]
        .as_str()
        .expect("data.label must be a string");
    assert!(
        matches!(label, "bullish" | "neutral" | "bearish"),
        "label must be one of bullish|neutral|bearish, got {label:?}"
    );
}
