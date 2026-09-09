//! End-to-end round-trip: spawn the `aperture` binary in `--agent=<id>`
//! mode, pipe a single `Envelope` JSON line into stdin, read one line from
//! stdout, and assert the reply payload matches what each agent owes.
//!
//! Cross-package access to the binary works because this test lives in the
//! same package that declares `[[bin]] name = "aperture"`, so cargo sets
//! `CARGO_BIN_EXE_aperture` for us.

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

    // Send EOF to let the agent shut down cleanly.
    drop(stdin);
    let _ = timeout(TIMEOUT, child.wait()).await;

    serde_json::from_str(&line).expect("reply is not valid Envelope JSON")
}

#[tokio::test]
async fn pane_quote_desc_round_trip() {
    let req = make_request(
        "aperture:pane.quote",
        json!({"verb": "DESC", "symbol": "AAPL"}),
        "corr-quote-1",
    );

    let resp = round_trip("pane.quote", &req).await;

    assert_eq!(resp.payload["verb"], "QUOTE.RESULT");
    assert_eq!(resp.payload["symbol"], "AAPL");
    assert_eq!(resp.correlation_id.as_deref(), Some("corr-quote-1"));
    assert_eq!(resp.from, "aperture:pane.quote");
    assert_eq!(resp.to, "aperture:test-harness");
    // MemoryDataSource always quotes a non-zero last price.
    let last = resp.payload["last"]
        .as_f64()
        .expect("last should be a number");
    assert!(last > 0.0);
}

#[tokio::test]
async fn agent_data_ohlcv_round_trip() {
    let req = make_request(
        "aperture:agent.data",
        json!({"verb": "OHLCV", "symbol": "AAPL", "range": "1M"}),
        "corr-ohlcv-1",
    );

    let resp = round_trip("agent.data", &req).await;

    assert_eq!(resp.payload["verb"], "OHLCV.RESULT");
    assert_eq!(resp.payload["symbol"], "AAPL");
    assert_eq!(resp.correlation_id.as_deref(), Some("corr-ohlcv-1"));

    let candles = resp.payload["candles"]
        .as_array()
        .expect("candles should be an array");
    assert!(!candles.is_empty(), "expected non-empty candle array");

    // First candle should have all OHLCV fields.
    let first = &candles[0];
    for k in ["t", "o", "h", "l", "c", "v"] {
        assert!(first.get(k).is_some(), "candle missing field `{k}`");
    }
}
