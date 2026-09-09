//! Tests for `aperture-core::state` types.
//!
//! Covers JSON round-trip for `FocusEvent` and confirms (at the type level)
//! that `PaneId` and `Symbol` are bare `String` aliases — i.e. a `String`
//! can be assigned directly to either without wrapping.

use aperture_core::{FocusEvent, PaneId, Symbol};

#[test]
fn focus_event_round_trips_through_json() {
    let ev = FocusEvent {
        symbol: "AAPL".into(),
        panes: vec![
            "pane.quote#1".into(),
            "pane.chart#1".into(),
            "pane.watchlist#1".into(),
            "pane.oracle#1".into(),
        ],
    };
    let json = serde_json::to_string(&ev).unwrap();
    // Field names in JSON should be exactly what `Message`-style payloads expect.
    assert!(json.contains(r#""symbol":"AAPL""#));
    assert!(json.contains(r#""panes":["#));
    let back: FocusEvent = serde_json::from_str(&json).unwrap();
    assert_eq!(back, ev);
}

#[test]
fn focus_event_with_empty_panes_round_trips() {
    let ev = FocusEvent {
        symbol: "MSFT".into(),
        panes: vec![],
    };
    let json = serde_json::to_string(&ev).unwrap();
    let back: FocusEvent = serde_json::from_str(&json).unwrap();
    assert_eq!(back, ev);
    assert_eq!(back.panes.len(), 0);
}

#[test]
fn pane_id_is_a_bare_string_alias() {
    // If PaneId weren't `type PaneId = String`, this assignment wouldn't compile.
    let s: String = "pane.chart#1".into();
    let id: PaneId = s.clone();
    assert_eq!(id, s);
    // Same the other direction: a PaneId is usable wherever &str/&String is.
    let back: &str = &id;
    assert_eq!(back, "pane.chart#1");
}

#[test]
fn symbol_is_a_bare_string_alias() {
    let s: String = "AAPL".into();
    let sym: Symbol = s.clone();
    assert_eq!(sym, s);
    // Symbol can be used in collections of String without conversion.
    let mut list: Vec<String> = Vec::new();
    list.push(sym);
    assert_eq!(list, vec![String::from("AAPL")]);
}
