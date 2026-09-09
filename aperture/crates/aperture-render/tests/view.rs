//! Tests for `aperture-render::View` and `Msg`.
//!
//! `View` is a backend-neutral description of what to draw. We pin two
//! invariants here:
//!
//! 1. Lines retain insertion order and emphasis values stick.
//! 2. The `Msg` enum's two variants (`Focus`, `Payload`) JSON-round-trip
//!    cleanly so the wire form is stable across the native and WASM
//!    transports.

use aperture_render::{Emphasis, Msg, View};
use serde_json::json;

#[test]
fn view_preserves_line_order() {
    let mut v = View::default();
    v.push("first");
    v.push("second");
    v.push("third");
    assert_eq!(v.lines.len(), 3);
    assert_eq!(v.lines[0].text, "first");
    assert_eq!(v.lines[1].text, "second");
    assert_eq!(v.lines[2].text, "third");
}

#[test]
fn default_emphasis_is_normal() {
    let mut v = View::default();
    v.push("plain");
    assert_eq!(v.lines[0].emphasis, Emphasis::Normal);
    // Default trait directly on Emphasis as well.
    assert_eq!(Emphasis::default(), Emphasis::Normal);
}

#[test]
fn push_emph_persists_each_emphasis_value() {
    let mut v = View::default();
    v.push_emph("dim line", Emphasis::Dim);
    v.push_emph("strong line", Emphasis::Strong);
    v.push_emph("warn line", Emphasis::Warn);
    v.push_emph("error line", Emphasis::Error);
    v.push_emph("normal line", Emphasis::Normal);

    let want: Vec<(&str, Emphasis)> = vec![
        ("dim line", Emphasis::Dim),
        ("strong line", Emphasis::Strong),
        ("warn line", Emphasis::Warn),
        ("error line", Emphasis::Error),
        ("normal line", Emphasis::Normal),
    ];
    assert_eq!(v.lines.len(), want.len());
    for (i, (text, emph)) in want.iter().enumerate() {
        assert_eq!(v.lines[i].text, *text, "text mismatch at index {i}");
        assert_eq!(v.lines[i].emphasis, *emph, "emphasis mismatch at index {i}");
    }
}

#[test]
fn mixing_push_and_push_emph_does_not_cross_contaminate_emphasis() {
    let mut v = View::default();
    v.push("plain1");
    v.push_emph("WARN", Emphasis::Warn);
    v.push("plain2");
    v.push_emph("ERROR", Emphasis::Error);
    v.push("plain3");

    assert_eq!(v.lines[0].emphasis, Emphasis::Normal);
    assert_eq!(v.lines[1].emphasis, Emphasis::Warn);
    assert_eq!(v.lines[2].emphasis, Emphasis::Normal);
    assert_eq!(v.lines[3].emphasis, Emphasis::Error);
    assert_eq!(v.lines[4].emphasis, Emphasis::Normal);
}

#[test]
fn msg_focus_round_trips_through_serde_json() {
    let m = Msg::Focus {
        symbol: "AAPL".into(),
    };
    let s = serde_json::to_string(&m).unwrap();
    // Externally tagged enum: `{"Focus":{"symbol":"AAPL"}}`.
    assert!(s.contains("Focus"), "expected variant tag in {s}");
    assert!(s.contains(r#""symbol":"AAPL""#));

    let back: Msg = serde_json::from_str(&s).unwrap();
    match back {
        Msg::Focus { symbol } => assert_eq!(symbol, "AAPL"),
        Msg::Payload(_) => panic!("expected Focus, got Payload"),
    }
}

#[test]
fn msg_payload_round_trips_through_serde_json() {
    let p = json!({
        "verb": "OHLCV",
        "symbol": "AAPL",
        "period": "1D",
        "range": "6M"
    });
    let m = Msg::Payload(p.clone());
    let s = serde_json::to_string(&m).unwrap();
    assert!(s.contains("Payload"));
    assert!(s.contains(r#""verb":"OHLCV""#));
    assert!(s.contains(r#""symbol":"AAPL""#));

    let back: Msg = serde_json::from_str(&s).unwrap();
    match back {
        Msg::Payload(v) => assert_eq!(v, p, "payload JSON value mismatch after round-trip"),
        Msg::Focus { .. } => panic!("expected Payload, got Focus"),
    }
}

#[test]
fn msg_payload_handles_nested_and_unicode() {
    let p = json!({
        "verb": "ASK",
        "prompt": "naïve résumé — 日本",
        "context": {"symbol": "NVDA", "tags": ["earnings", "guidance"]},
        "n": 42
    });
    let m = Msg::Payload(p.clone());
    let s = serde_json::to_string(&m).unwrap();
    let back: Msg = serde_json::from_str(&s).unwrap();
    match back {
        Msg::Payload(v) => assert_eq!(v, p),
        _ => panic!("expected Payload"),
    }
}

#[test]
fn empty_view_serialises_renderably() {
    // A pane with nothing to show should still produce a valid View.
    let v = View::default();
    assert!(v.lines.is_empty());
}
