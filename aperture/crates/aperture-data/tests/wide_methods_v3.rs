//! Wave-3a tests for the 9 new market-info methods on
//! `MemoryDataSource`. Each test:
//!   * Constructs a `MemoryDataSource`.
//!   * Calls the method twice with the same input and asserts bit-equal
//!     output (determinism).
//!   * Validates the returned `Payload` (JSON) shape.
//!
//! Reuses the std-only `block_on` waker pattern from `tests/wide_methods.rs`
//! to avoid pulling tokio in as a dev-dep.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};

use aperture_data::{DataSource, Payload, MemoryDataSource};

/// Minimal executor: poll the future repeatedly with a no-op waker. Safe
/// because `MemoryDataSource`'s methods never `.await` on real I/O.
fn block_on<F: Future>(mut fut: F) -> F::Output {
    struct NoopWake;
    impl Wake for NoopWake {
        fn wake(self: Arc<Self>) {}
    }
    let waker: Waker = Arc::new(NoopWake).into();
    let mut cx = Context::from_waker(&waker);
    // SAFETY: the future is owned on the stack and never moved while polling.
    let mut pinned = unsafe { Pin::new_unchecked(&mut fut) };
    loop {
        match pinned.as_mut().poll(&mut cx) {
            Poll::Ready(out) => return out,
            Poll::Pending => continue,
        }
    }
}

fn assert_payload_eq(a: &Payload, b: &Payload, what: &str) {
    assert_eq!(a, b, "{what}: in-memory provider must be deterministic");
}

// ---------------------------------------------------------------------------
// 1. earnings_calendar() — None and Some(window_days)
// ---------------------------------------------------------------------------

#[test]
fn earnings_calendar_default_window_returns_events() {
    let s = MemoryDataSource;
    let a = block_on(s.earnings_calendar(None)).expect("earnings_calendar(None)");
    let b = block_on(s.earnings_calendar(None)).expect("earnings_calendar(None) #2");
    assert_payload_eq(&a, &b, "earnings_calendar(None)");
    assert!(
        a["window_days"].as_u64().is_some(),
        "window_days must be a number"
    );
    let events = a["events"].as_array().expect("events must be an array");
    assert!(!events.is_empty(), "expected at least one earnings event");
    // Each event has symbol + date + estimate_eps.
    for (i, ev) in events.iter().enumerate() {
        assert!(
            ev.get("symbol").and_then(|v| v.as_str()).is_some(),
            "event {i} missing string `symbol`"
        );
        assert!(
            ev.get("date").and_then(|v| v.as_str()).is_some(),
            "event {i} missing string `date`"
        );
        assert!(
            ev.get("estimate_eps").and_then(|v| v.as_f64()).is_some(),
            "event {i} missing numeric `estimate_eps`"
        );
    }
}

#[test]
fn earnings_calendar_explicit_window_echoes_back() {
    let s = MemoryDataSource;
    let a = block_on(s.earnings_calendar(Some(30))).expect("earnings_calendar(Some(30))");
    let b = block_on(s.earnings_calendar(Some(30))).expect("earnings_calendar(Some(30)) #2");
    assert_payload_eq(&a, &b, "earnings_calendar(Some(30))");
    assert_eq!(a["window_days"].as_u64(), Some(30));
}

// ---------------------------------------------------------------------------
// 2. movers() — None / Some("losers") / Some("active")
// ---------------------------------------------------------------------------

#[test]
fn movers_default_scope_is_gainers() {
    let s = MemoryDataSource;
    let a = block_on(s.movers(None)).expect("movers(None)");
    let b = block_on(s.movers(None)).expect("movers(None) #2");
    assert_payload_eq(&a, &b, "movers(None)");
    assert_eq!(a["scope"], "gainers");
    let rows = a["rows"].as_array().expect("rows must be an array");
    assert!(!rows.is_empty(), "expected non-empty gainers list");
}

#[test]
fn movers_losers_scope_returns_negative_changes() {
    let s = MemoryDataSource;
    let a = block_on(s.movers(Some("losers"))).expect("movers(\"losers\")");
    let b = block_on(s.movers(Some("losers"))).expect("movers(\"losers\") #2");
    assert_payload_eq(&a, &b, "movers(Some(\"losers\"))");
    assert_eq!(a["scope"], "losers");
    let rows = a["rows"].as_array().expect("rows must be an array");
    assert!(!rows.is_empty());
    // Every loser row should have a non-positive change_pct.
    for (i, r) in rows.iter().enumerate() {
        let chg = r["change_pct"]
            .as_f64()
            .unwrap_or_else(|| panic!("row {i} missing numeric change_pct"));
        assert!(chg <= 0.0, "loser row {i} has positive change_pct {chg}");
    }
}

#[test]
fn movers_active_scope_returns_volume_rows() {
    let s = MemoryDataSource;
    let a = block_on(s.movers(Some("active"))).expect("movers(\"active\")");
    let b = block_on(s.movers(Some("active"))).expect("movers(\"active\") #2");
    assert_payload_eq(&a, &b, "movers(Some(\"active\"))");
    assert_eq!(a["scope"], "active");
    let rows = a["rows"].as_array().expect("rows must be an array");
    assert!(!rows.is_empty(), "expected non-empty active list");
    for (i, r) in rows.iter().enumerate() {
        assert!(
            r.get("volume").and_then(|v| v.as_u64()).is_some(),
            "active row {i} missing numeric `volume`"
        );
    }
}

// ---------------------------------------------------------------------------
// 3. screener() — None and Some(criteria)
// ---------------------------------------------------------------------------

#[test]
fn screener_default_returns_matches() {
    let s = MemoryDataSource;
    let a = block_on(s.screener(None)).expect("screener(None)");
    let b = block_on(s.screener(None)).expect("screener(None) #2");
    assert_payload_eq(&a, &b, "screener(None)");
    let matches = a["matches"].as_array().expect("matches must be an array");
    assert!(!matches.is_empty(), "expected at least one match");
    assert!(
        a["criteria"].as_str().is_some(),
        "criteria must be a string"
    );
}

#[test]
fn screener_with_criteria_echoes_string() {
    let s = MemoryDataSource;
    let q = "market_cap>1e12";
    let a = block_on(s.screener(Some(q))).expect("screener(Some)");
    let b = block_on(s.screener(Some(q))).expect("screener(Some) #2");
    assert_payload_eq(&a, &b, "screener(Some)");
    assert_eq!(a["criteria"], q);
}

// ---------------------------------------------------------------------------
// 4. index_members() — DJI / NDX / SPX
// ---------------------------------------------------------------------------

#[test]
fn index_members_dji_returns_roster() {
    let s = MemoryDataSource;
    let a = block_on(s.index_members("DJI")).expect("index_members(DJI)");
    let b = block_on(s.index_members("DJI")).expect("index_members(DJI) #2");
    assert_payload_eq(&a, &b, "index_members(DJI)");
    assert_eq!(a["index"], "DJI");
    let members = a["members"].as_array().expect("members must be an array");
    assert!(!members.is_empty(), "DJI roster should be non-empty");
}

#[test]
fn index_members_ndx_returns_roster() {
    let s = MemoryDataSource;
    let a = block_on(s.index_members("NDX")).expect("index_members(NDX)");
    let b = block_on(s.index_members("NDX")).expect("index_members(NDX) #2");
    assert_payload_eq(&a, &b, "index_members(NDX)");
    assert_eq!(a["index"], "NDX");
    let members = a["members"].as_array().expect("members must be an array");
    assert!(!members.is_empty(), "NDX roster should be non-empty");
}

#[test]
fn index_members_spx_returns_roster() {
    let s = MemoryDataSource;
    let a = block_on(s.index_members("SPX")).expect("index_members(SPX)");
    let b = block_on(s.index_members("SPX")).expect("index_members(SPX) #2");
    assert_payload_eq(&a, &b, "index_members(SPX)");
    assert_eq!(a["index"], "SPX");
    let members = a["members"].as_array().expect("members must be an array");
    assert!(!members.is_empty(), "SPX roster should be non-empty");
    // Each member has a string symbol + numeric weight + numeric last.
    for (i, m) in members.iter().enumerate() {
        assert!(
            m.get("symbol").and_then(|v| v.as_str()).is_some(),
            "member {i} missing string `symbol`"
        );
        assert!(
            m.get("weight_pct").and_then(|v| v.as_f64()).is_some(),
            "member {i} missing numeric `weight_pct`"
        );
        assert!(
            m.get("last").and_then(|v| v.as_f64()).is_some(),
            "member {i} missing numeric `last`"
        );
    }
}

// ---------------------------------------------------------------------------
// 5. vol_surface() — single symbol
// ---------------------------------------------------------------------------

#[test]
fn vol_surface_returns_grid_of_strikes_and_expiries() {
    let s = MemoryDataSource;
    let a = block_on(s.vol_surface("AAPL")).expect("vol_surface(AAPL)");
    let b = block_on(s.vol_surface("AAPL")).expect("vol_surface(AAPL) #2");
    assert_payload_eq(&a, &b, "vol_surface(AAPL)");
    assert_eq!(a["symbol"], "AAPL");
    assert!(
        a["underlying_last"].as_f64().is_some(),
        "underlying_last must be a number"
    );
    let rows = a["rows"].as_array().expect("rows must be an array");
    assert!(!rows.is_empty(), "expected at least one surface row");
    for (i, r) in rows.iter().enumerate() {
        assert!(
            r.get("expiry").and_then(|v| v.as_str()).is_some(),
            "row {i} missing string `expiry`"
        );
        assert!(
            r.get("strike").and_then(|v| v.as_f64()).is_some(),
            "row {i} missing numeric `strike`"
        );
        assert!(
            r.get("iv").and_then(|v| v.as_f64()).is_some(),
            "row {i} missing numeric `iv`"
        );
    }
}

// ---------------------------------------------------------------------------
// 6. technicals() — SMA / RSI / MACD happy paths plus an unknown indicator
// ---------------------------------------------------------------------------

#[test]
fn technicals_sma_returns_finite_value() {
    let s = MemoryDataSource;
    let a = block_on(s.technicals("AAPL", "SMA")).expect("technicals(AAPL, SMA)");
    let b = block_on(s.technicals("AAPL", "SMA")).expect("technicals(AAPL, SMA) #2");
    assert_payload_eq(&a, &b, "technicals(AAPL, SMA)");
    assert_eq!(a["symbol"], "AAPL");
    assert_eq!(a["indicator"], "SMA");
    let value = a["value"].as_f64().expect("value must be a number");
    assert!(value.is_finite(), "expected finite SMA value, got {value}");
    let series = a["series"].as_array().expect("series must be an array");
    assert!(!series.is_empty(), "series should be non-empty");
}

#[test]
fn technicals_rsi_returns_value() {
    let s = MemoryDataSource;
    let a = block_on(s.technicals("AAPL", "RSI")).expect("technicals(AAPL, RSI)");
    let b = block_on(s.technicals("AAPL", "RSI")).expect("technicals(AAPL, RSI) #2");
    assert_payload_eq(&a, &b, "technicals(AAPL, RSI)");
    assert_eq!(a["indicator"], "RSI");
    let value = a["value"].as_f64().expect("value must be a number");
    assert!(value.is_finite(), "expected finite RSI value, got {value}");
}

#[test]
fn technicals_macd_returns_value() {
    let s = MemoryDataSource;
    let a = block_on(s.technicals("AAPL", "MACD")).expect("technicals(AAPL, MACD)");
    let b = block_on(s.technicals("AAPL", "MACD")).expect("technicals(AAPL, MACD) #2");
    assert_payload_eq(&a, &b, "technicals(AAPL, MACD)");
    assert_eq!(a["indicator"], "MACD");
    let value = a["value"].as_f64().expect("value must be a number");
    assert!(
        value.is_finite(),
        "expected finite MACD value, got {value}"
    );
}

#[test]
fn technicals_unknown_indicator_returns_error() {
    let s = MemoryDataSource;
    let res = block_on(s.technicals("AAPL", "NOPE"));
    assert!(
        res.is_err(),
        "expected unknown indicator NOPE to be an error"
    );
}

// ---------------------------------------------------------------------------
// 7. correlation_matrix() — diagonal=1.0
// ---------------------------------------------------------------------------

#[test]
fn correlation_matrix_diagonal_is_unity_and_deterministic() {
    let s = MemoryDataSource;
    let symbols = vec!["AAPL".to_string(), "MSFT".to_string()];
    let a = block_on(s.correlation_matrix(&symbols)).expect("correlation_matrix");
    let b = block_on(s.correlation_matrix(&symbols)).expect("correlation_matrix #2");
    assert_payload_eq(&a, &b, "correlation_matrix(AAPL,MSFT)");
    let echoed = a["symbols"].as_array().expect("symbols echo array");
    assert_eq!(echoed.len(), 2);
    let matrix = a["matrix"].as_array().expect("matrix must be an array");
    assert_eq!(matrix.len(), 2);
    for (i, entry) in matrix.iter().enumerate() {
        let row = entry["row"].as_array().expect("row must be an array");
        assert_eq!(row.len(), 2, "row {i} should have length 2");
        assert_eq!(
            row[i].as_f64(),
            Some(1.0),
            "diagonal element [{i}][{i}] must be 1.0"
        );
        // Off-diagonals should still be finite numbers in [-1, 1].
        for (j, v) in row.iter().enumerate() {
            let f = v.as_f64().expect("matrix entry must be a number");
            assert!(f.is_finite());
            assert!(f >= -1.0 && f <= 1.0, "[{i}][{j}] outside [-1,1]: {f}");
        }
    }
}

// ---------------------------------------------------------------------------
// 8. filings() — non-empty
// ---------------------------------------------------------------------------

#[test]
fn filings_returns_non_empty_list_of_forms() {
    let s = MemoryDataSource;
    let a = block_on(s.filings("AAPL")).expect("filings(AAPL)");
    let b = block_on(s.filings("AAPL")).expect("filings(AAPL) #2");
    assert_payload_eq(&a, &b, "filings(AAPL)");
    assert_eq!(a["symbol"], "AAPL");
    let filings = a["filings"].as_array().expect("filings must be an array");
    assert!(!filings.is_empty(), "expected at least one filing");
    for (i, f) in filings.iter().enumerate() {
        assert!(
            f.get("form").and_then(|v| v.as_str()).is_some(),
            "filing {i} missing string `form`"
        );
        assert!(
            f.get("filed_at").and_then(|v| v.as_str()).is_some(),
            "filing {i} missing string `filed_at`"
        );
    }
}

// ---------------------------------------------------------------------------
// 9. sentiment() — label is in the allowed set
// ---------------------------------------------------------------------------

#[test]
fn sentiment_returns_score_label_and_sources() {
    let s = MemoryDataSource;
    let a = block_on(s.sentiment("AAPL")).expect("sentiment(AAPL)");
    let b = block_on(s.sentiment("AAPL")).expect("sentiment(AAPL) #2");
    assert_payload_eq(&a, &b, "sentiment(AAPL)");
    assert_eq!(a["symbol"], "AAPL");
    let score = a["score"].as_f64().expect("score must be a number");
    assert!(
        (-1.0..=1.0).contains(&score),
        "score outside [-1,1]: {score}"
    );
    let label = a["label"].as_str().expect("label must be a string");
    assert!(
        matches!(label, "bullish" | "neutral" | "bearish"),
        "label not in allowed set: {label:?}"
    );
    let sources = a["sources"].as_array().expect("sources must be an array");
    assert!(!sources.is_empty(), "expected at least one source");
}
