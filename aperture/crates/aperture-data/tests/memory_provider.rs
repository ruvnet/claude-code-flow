//! Tests for `MemoryDataSource`.
//!
//! Avoids pulling tokio in as a dev-dep: we run the async methods on a
//! tiny std-only executor (`block_on` below). `MemoryDataSource` is purely
//! synchronous internally so a `Waker::noop`-style executor is sufficient.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};

use aperture_data::{DataSource, MemoryDataSource};

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

#[test]
fn name_is_stable() {
    let s = MemoryDataSource;
    assert_eq!(s.name(), "memory");
}

#[test]
fn quote_is_deterministic_across_calls() {
    let s = MemoryDataSource;
    let q1 = block_on(s.quote("AAPL")).unwrap();
    let q2 = block_on(s.quote("AAPL")).unwrap();
    assert_eq!(q1, q2, "memory quote must be deterministic for the same symbol");
    // Symbol is normalised to upper-case in the response.
    assert_eq!(q1.symbol, "AAPL");
}

#[test]
fn quote_normalises_symbol_to_uppercase() {
    let s = MemoryDataSource;
    let lower = block_on(s.quote("aapl")).unwrap();
    let upper = block_on(s.quote("AAPL")).unwrap();
    assert_eq!(lower.symbol, "AAPL");
    assert_eq!(lower, upper, "casing of input symbol must not change quote");
}

#[test]
fn quote_pins_specific_values_for_known_symbols() {
    // The `price_for` function in memory.rs uses a stable hash of the symbol
    // bytes. Pin specific outputs so any accidental algorithm change is
    // caught immediately and the bridge contract stays observable.
    let s = MemoryDataSource;
    let aapl = block_on(s.quote("AAPL")).unwrap();
    let msft = block_on(s.quote("MSFT")).unwrap();
    assert!(
        (aapl.last - 243.6).abs() < 1e-9,
        "AAPL last expected 243.6, got {}",
        aapl.last
    );
    assert!(
        (msft.last - 492.4).abs() < 1e-9,
        "MSFT last expected 492.4, got {}",
        msft.last
    );
    // Bid/ask spread is fixed at +/- 0.05 around `last`.
    assert!((aapl.bid.unwrap() - (aapl.last - 0.05)).abs() < 1e-9);
    assert!((aapl.ask.unwrap() - (aapl.last + 0.05)).abs() < 1e-9);
    // Change percent is a fixed sample for the in-memory provider.
    assert!((aapl.change_pct - 0.42).abs() < 1e-9);
}

#[test]
fn different_symbols_produce_different_prices() {
    let s = MemoryDataSource;
    let aapl = block_on(s.quote("AAPL")).unwrap();
    let msft = block_on(s.quote("MSFT")).unwrap();
    let nvda = block_on(s.quote("NVDA")).unwrap();
    assert_ne!(aapl.last, msft.last, "AAPL and MSFT should price differently");
    assert_ne!(aapl.last, nvda.last, "AAPL and NVDA should price differently");
    assert_ne!(msft.last, nvda.last, "MSFT and NVDA should price differently");
}

#[test]
fn empty_symbol_is_handled_and_returns_some_quote() {
    // Document existing behaviour: empty symbol does NOT error; it returns
    // a quote with the empty symbol and the base price (100.0).
    let s = MemoryDataSource;
    let q = block_on(s.quote("")).expect("memory provider does not error on empty symbol");
    assert_eq!(q.symbol, "");
    assert!(
        (q.last - 100.0).abs() < 1e-9,
        "empty symbol should return base price 100.0, got {}",
        q.last
    );
}

#[test]
fn ohlcv_returns_thirty_candles() {
    let s = MemoryDataSource;
    let candles = block_on(s.ohlcv("AAPL", "1M")).unwrap();
    assert_eq!(candles.len(), 30);
}

#[test]
fn ohlcv_timestamps_are_strictly_monotonic() {
    let s = MemoryDataSource;
    let candles = block_on(s.ohlcv("AAPL", "1M")).unwrap();
    for w in candles.windows(2) {
        assert!(
            w[1].t > w[0].t,
            "candle timestamps must be strictly increasing: {} <= {}",
            w[1].t,
            w[0].t
        );
    }
    // Cadence is 1 day (86_400 s) per the in-memory implementation.
    for w in candles.windows(2) {
        assert_eq!(w[1].t - w[0].t, 86_400);
    }
}

#[test]
fn ohlcv_high_is_greater_than_or_equal_to_low_for_every_candle() {
    let s = MemoryDataSource;
    let candles = block_on(s.ohlcv("MSFT", "6M")).unwrap();
    for (i, c) in candles.iter().enumerate() {
        assert!(
            c.h >= c.l,
            "candle {i}: high {} must be >= low {}",
            c.h,
            c.l
        );
        // MemoryDataSource also guarantees open and close fall inside [low, high].
        assert!(c.o >= c.l && c.o <= c.h, "open out of range at {i}");
        assert!(c.c >= c.l && c.c <= c.h, "close out of range at {i}");
    }
}

#[test]
fn ohlcv_is_anchored_on_the_symbol_price() {
    // First candle's open should equal `quote().last` for the same symbol
    // (per the in-memory provider's deterministic price_for + drift=0 at i=0).
    let s = MemoryDataSource;
    let q = block_on(s.quote("NVDA")).unwrap();
    let candles = block_on(s.ohlcv("NVDA", "1M")).unwrap();
    assert!(
        (candles[0].o - q.last).abs() < 1e-9,
        "first candle open ({}) should equal quote.last ({})",
        candles[0].o,
        q.last
    );
}

#[test]
fn ohlcv_round_trips_through_serde_json() {
    let s = MemoryDataSource;
    let candles = block_on(s.ohlcv("AAPL", "1M")).unwrap();
    let json = serde_json::to_string(&candles).unwrap();
    let back: Vec<aperture_data::Candle> = serde_json::from_str(&json).unwrap();
    assert_eq!(back.len(), candles.len());
    for (a, b) in candles.iter().zip(back.iter()) {
        assert_eq!(a.t, b.t);
        assert!((a.o - b.o).abs() < 1e-9);
        assert!((a.h - b.h).abs() < 1e-9);
        assert!((a.l - b.l).abs() < 1e-9);
        assert!((a.c - b.c).abs() < 1e-9);
        assert!((a.v - b.v).abs() < 1e-9);
    }
}

#[test]
fn quote_round_trips_through_serde_json() {
    // Quote derives PartialEq on f64, so a strict eq after JSON round-trip
    // can fail on floats that don't have an exact decimal representation.
    // We compare field-by-field with a small epsilon for the floats and
    // exactly for the strings/options-shape.
    let s = MemoryDataSource;
    let q = block_on(s.quote("AAPL")).unwrap();
    let json = serde_json::to_string(&q).unwrap();
    let back: aperture_data::Quote = serde_json::from_str(&json).unwrap();
    assert_eq!(back.symbol, q.symbol);
    assert_eq!(back.timestamp, q.timestamp);
    assert!((back.last - q.last).abs() < 1e-9);
    assert!((back.change_pct - q.change_pct).abs() < 1e-9);
    match (back.bid, q.bid) {
        (Some(a), Some(b)) => assert!((a - b).abs() < 1e-9),
        (None, None) => {}
        other => panic!("bid presence diverged: {other:?}"),
    }
    match (back.ask, q.ask) {
        (Some(a), Some(b)) => assert!((a - b).abs() < 1e-9),
        (None, None) => {}
        other => panic!("ask presence diverged: {other:?}"),
    }
}
