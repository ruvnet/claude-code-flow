//! Tests for the 10 wide market-info methods on `MemoryDataSource`.
//!
//! Each method has its own test that:
//!   * Constructs a `MemoryDataSource`.
//!   * Calls the method with deterministic input.
//!   * Asserts the returned `Payload` (JSON) has the expected shape.
//!   * Calls the method a second time and asserts the result is bit-equal
//!     (determinism: in-memory provider must be reproducible).
//!
//! Reuses the std-only `block_on` trick from `tests/memory_provider.rs` to
//! avoid pulling tokio in as a dev-dep.

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

/// Sanity helper: assert two `Payload` (serde_json::Value) values are
/// structurally equal. Used to gate determinism: two independent calls
/// must produce identical JSON.
fn assert_payload_eq(a: &Payload, b: &Payload, what: &str) {
    assert_eq!(a, b, "{what}: in-memory provider must be deterministic");
}

// ---------------------------------------------------------------------------
// 1. news()
// ---------------------------------------------------------------------------

#[test]
fn news_global_returns_headlines_and_is_deterministic() {
    let s = MemoryDataSource;
    let a = block_on(s.news(None)).expect("news(None) should succeed");
    let b = block_on(s.news(None)).expect("news(None) second call");
    assert_payload_eq(&a, &b, "news(None)");
    assert_eq!(a["scope"], "GLOBAL");
    let headlines = a["headlines"]
        .as_array()
        .expect("headlines should be an array");
    assert!(!headlines.is_empty(), "expected at least one global headline");
}

#[test]
fn news_per_symbol_uppercases_scope() {
    let s = MemoryDataSource;
    let a = block_on(s.news(Some("aapl"))).expect("news(Some) should succeed");
    let b = block_on(s.news(Some("aapl"))).expect("news(Some) second call");
    assert_payload_eq(&a, &b, "news(Some(\"aapl\"))");
    assert_eq!(a["scope"], "AAPL");
}

// ---------------------------------------------------------------------------
// 2. macro_indicators()
// ---------------------------------------------------------------------------

#[test]
fn macro_indicators_returns_array_with_named_rows() {
    let s = MemoryDataSource;
    let a = block_on(s.macro_indicators()).expect("macro_indicators should succeed");
    let b = block_on(s.macro_indicators()).expect("macro_indicators second call");
    assert_payload_eq(&a, &b, "macro_indicators()");
    let rows = a.as_array().expect("macro_indicators should be an array");
    assert!(!rows.is_empty(), "expected at least one indicator");
    // Every row should have a string `name` and a numeric `value`.
    for (i, row) in rows.iter().enumerate() {
        assert!(
            row.get("name").and_then(|v| v.as_str()).is_some(),
            "row {i} missing string `name`"
        );
        assert!(
            row.get("value").and_then(|v| v.as_f64()).is_some(),
            "row {i} missing numeric `value`"
        );
    }
}

// ---------------------------------------------------------------------------
// 3. yield_curve()
// ---------------------------------------------------------------------------

#[test]
fn yield_curve_returns_tenor_yield_array() {
    let s = MemoryDataSource;
    let a = block_on(s.yield_curve()).expect("yield_curve should succeed");
    let b = block_on(s.yield_curve()).expect("yield_curve second call");
    assert_payload_eq(&a, &b, "yield_curve()");
    let curve = a.as_array().expect("yield_curve should be an array");
    assert!(!curve.is_empty(), "expected at least one curve point");
    // First point must have tenor (string) + yield_pct (number).
    assert!(curve[0]
        .get("tenor")
        .and_then(|v| v.as_str())
        .is_some());
    assert!(curve[0]
        .get("yield_pct")
        .and_then(|v| v.as_f64())
        .is_some());
}

// ---------------------------------------------------------------------------
// 4. fx_rates()
// ---------------------------------------------------------------------------

#[test]
fn fx_rates_default_base_is_usd_and_uppercases_input() {
    let s = MemoryDataSource;
    let default_a = block_on(s.fx_rates(None)).expect("fx_rates(None) should succeed");
    let default_b = block_on(s.fx_rates(None)).expect("fx_rates(None) second call");
    assert_payload_eq(&default_a, &default_b, "fx_rates(None)");
    assert_eq!(default_a["base"], "USD");

    let lower_a = block_on(s.fx_rates(Some("eur"))).expect("fx_rates(\"eur\")");
    let lower_b = block_on(s.fx_rates(Some("eur"))).expect("fx_rates(\"eur\") second");
    assert_payload_eq(&lower_a, &lower_b, "fx_rates(Some(\"eur\"))");
    assert_eq!(lower_a["base"], "EUR");

    let rates = lower_a["rates"]
        .as_array()
        .expect("rates should be an array");
    assert!(!rates.is_empty());
}

// ---------------------------------------------------------------------------
// 5. options_chain()
// ---------------------------------------------------------------------------

#[test]
fn options_chain_returns_strikes_and_uppercases_symbol() {
    let s = MemoryDataSource;
    let a = block_on(s.options_chain("aapl")).expect("options_chain should succeed");
    let b = block_on(s.options_chain("aapl")).expect("options_chain second call");
    assert_payload_eq(&a, &b, "options_chain(\"aapl\")");
    assert_eq!(a["symbol"], "AAPL");
    assert!(
        a["underlying_last"].as_f64().is_some(),
        "underlying_last must be a number"
    );
    let rows = a["rows"].as_array().expect("rows must be an array");
    assert!(!rows.is_empty(), "expected at least one strike row");
    // Each row should have strike, call_iv, put_iv.
    for (i, row) in rows.iter().enumerate() {
        assert!(
            row.get("strike").and_then(|v| v.as_f64()).is_some(),
            "row {i} missing strike"
        );
        assert!(
            row.get("call_iv").and_then(|v| v.as_f64()).is_some(),
            "row {i} missing call_iv"
        );
        assert!(
            row.get("put_iv").and_then(|v| v.as_f64()).is_some(),
            "row {i} missing put_iv"
        );
    }
}

// ---------------------------------------------------------------------------
// 6. insider_trades()
// ---------------------------------------------------------------------------

#[test]
fn insider_trades_returns_trade_records() {
    let s = MemoryDataSource;
    let a = block_on(s.insider_trades("aapl")).expect("insider_trades should succeed");
    let b = block_on(s.insider_trades("aapl")).expect("insider_trades second call");
    assert_payload_eq(&a, &b, "insider_trades(\"aapl\")");
    assert_eq!(a["symbol"], "AAPL");
    let trades = a["trades"].as_array().expect("trades must be an array");
    assert!(!trades.is_empty(), "expected at least one insider trade");
    // First trade has name, role, shares.
    assert!(trades[0]
        .get("name")
        .and_then(|v| v.as_str())
        .is_some());
    assert!(trades[0]
        .get("role")
        .and_then(|v| v.as_str())
        .is_some());
    assert!(trades[0]
        .get("shares")
        .and_then(|v| v.as_i64())
        .is_some());
}

// ---------------------------------------------------------------------------
// 7. financials()
// ---------------------------------------------------------------------------

#[test]
fn financials_returns_three_statements() {
    let s = MemoryDataSource;
    let a = block_on(s.financials("aapl")).expect("financials should succeed");
    let b = block_on(s.financials("aapl")).expect("financials second call");
    assert_payload_eq(&a, &b, "financials(\"aapl\")");
    assert_eq!(a["symbol"], "AAPL");
    // income_ttm
    assert!(a["income_ttm"]["revenue"].as_f64().is_some());
    assert!(a["income_ttm"]["net_income"].as_f64().is_some());
    // balance_mrq
    assert!(a["balance_mrq"]["total_assets"].as_f64().is_some());
    assert!(a["balance_mrq"]["total_equity"].as_f64().is_some());
    // cashflow_ttm
    assert!(a["cashflow_ttm"]["operating"].as_f64().is_some());
    assert!(a["cashflow_ttm"]["free_cashflow"].as_f64().is_some());
}

// ---------------------------------------------------------------------------
// 8. crypto_quote()
// ---------------------------------------------------------------------------

#[test]
fn crypto_quote_returns_24h_volume_and_market_cap() {
    let s = MemoryDataSource;
    let a = block_on(s.crypto_quote("btc")).expect("crypto_quote should succeed");
    let b = block_on(s.crypto_quote("btc")).expect("crypto_quote second call");
    assert_payload_eq(&a, &b, "crypto_quote(\"btc\")");
    assert_eq!(a["symbol"], "BTC");
    assert!(a["last"].as_f64().expect("last must be a number") > 0.0);
    assert!(a["vol_24h"].as_f64().expect("vol_24h must be a number") > 0.0);
    assert!(
        a["market_cap"].as_f64().is_some(),
        "market_cap must be a number"
    );
    // BTC carries a non-zero dominance; other tickers do not.
    let dom = a["dominance_pct"]
        .as_f64()
        .expect("dominance_pct must be a number");
    assert!(dom > 0.0, "BTC should have positive dominance, got {dom}");

    let other = block_on(s.crypto_quote("eth")).expect("crypto_quote(\"eth\")");
    assert_eq!(other["symbol"], "ETH");
    assert_eq!(
        other["dominance_pct"].as_f64(),
        Some(0.0),
        "non-BTC tickers must report 0.0 dominance"
    );
}

// ---------------------------------------------------------------------------
// 9. risk_metrics()
// ---------------------------------------------------------------------------

#[test]
fn risk_metrics_returns_one_row_per_symbol() {
    let s = MemoryDataSource;
    let symbols = vec!["AAPL".to_string()];
    let a = block_on(s.risk_metrics(&symbols)).expect("risk_metrics should succeed");
    let b = block_on(s.risk_metrics(&symbols)).expect("risk_metrics second call");
    assert_payload_eq(&a, &b, "risk_metrics([\"AAPL\"])");
    let rows = a["rows"].as_array().expect("data.rows must be an array");
    assert_eq!(rows.len(), 1, "expected exactly one row per symbol");
    assert_eq!(rows[0]["symbol"], "AAPL");
    assert!(
        rows[0].get("beta").and_then(|v| v.as_f64()).is_some(),
        "beta must be a number"
    );
    assert!(
        rows[0]
            .get("vol_annualised")
            .and_then(|v| v.as_f64())
            .is_some(),
        "vol_annualised must be a number"
    );
    assert!(
        rows[0]
            .get("var_1d_95")
            .and_then(|v| v.as_f64())
            .is_some(),
        "var_1d_95 must be a number"
    );

    // Two-symbol call yields two rows.
    let two = vec!["AAPL".to_string(), "TSLA".to_string()];
    let multi = block_on(s.risk_metrics(&two)).expect("risk_metrics(2)");
    assert_eq!(multi["rows"].as_array().unwrap().len(), 2);
}

// ---------------------------------------------------------------------------
// 10. corp_actions()
// ---------------------------------------------------------------------------

#[test]
fn corp_actions_returns_event_array() {
    let s = MemoryDataSource;
    let a = block_on(s.corp_actions("aapl")).expect("corp_actions should succeed");
    let b = block_on(s.corp_actions("aapl")).expect("corp_actions second call");
    assert_payload_eq(&a, &b, "corp_actions(\"aapl\")");
    assert_eq!(a["symbol"], "AAPL");
    let events = a["events"].as_array().expect("events must be an array");
    assert!(!events.is_empty(), "expected at least one event");
    // Every event should have a `type` discriminator.
    for (i, ev) in events.iter().enumerate() {
        assert!(
            ev.get("type").and_then(|v| v.as_str()).is_some(),
            "event {i} missing string `type`"
        );
    }
}
