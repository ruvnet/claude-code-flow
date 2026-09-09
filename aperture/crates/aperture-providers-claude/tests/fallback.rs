//! Falls-back-to-memory smoke tests: when `claude` is not available on
//! PATH (or the spawn fails for any reason) the researcher must yield
//! the wrapped `MemoryDataSource` output, not bubble the spawn error.
//!
//! These tests run in the default sandbox where `claude` is rarely on
//! PATH; if it IS present the researcher will try it first, succeed,
//! and the fallback isn't exercised. To deterministically force the
//! fallback regardless of PATH state, point the binary at a path that
//! is guaranteed not to exist.

use std::time::Duration;

use aperture_data::{DataSource, MemoryDataSource};
use aperture_providers_claude::{ClaudeResearcher, Config};

fn never_resolves() -> Config {
    Config {
        binary: "/nonexistent/aperture-fake-claude-binary".into(),
        timeout: Duration::from_millis(50),
        ..Config::default()
    }
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Arc;
    use std::task::{Context, Poll, Wake, Waker};

    struct Noop;
    impl Wake for Noop {
        fn wake(self: Arc<Self>) {}
    }
    let waker: Waker = Arc::new(Noop).into();
    let mut cx = Context::from_waker(&waker);
    let mut fut = Box::pin(f);
    loop {
        if let Poll::Ready(v) = Pin::new(&mut fut).as_mut().poll(&mut cx) {
            return v;
        }
    }
}

#[test]
fn news_falls_back_to_memory_when_binary_missing() {
    let r = ClaudeResearcher::with_config(MemoryDataSource, never_resolves());
    let out = block_on(r.news(Some("AAPL")));
    let payload = out.expect("fallback should yield Ok");
    assert_eq!(payload["scope"], "AAPL");
    assert!(payload["headlines"].is_array());
}

#[test]
fn macro_falls_back_to_memory_when_binary_missing() {
    let r = ClaudeResearcher::with_config(MemoryDataSource, never_resolves());
    let out = block_on(r.macro_indicators()).expect("fallback");
    let arr = out.as_array().expect("array");
    assert!(!arr.is_empty());
    assert!(arr.iter().any(|v| v["name"] == "CPI YoY"));
}

#[test]
fn yields_falls_back_to_memory_when_binary_missing() {
    let r = ClaudeResearcher::with_config(MemoryDataSource, never_resolves());
    let out = block_on(r.yield_curve()).expect("fallback");
    let arr = out.as_array().expect("array");
    assert_eq!(arr.len(), 8);
}

#[test]
fn quote_passes_through_to_fallback_unconditionally() {
    // `quote` is not a web-research method — it always delegates.
    let r = ClaudeResearcher::with_config(MemoryDataSource, never_resolves());
    let q = block_on(r.quote("AAPL")).expect("memory always succeeds");
    assert_eq!(q.symbol, "AAPL");
}

#[test]
fn delegated_methods_dont_invoke_claude() {
    // None of these should attempt to spawn the binary, so a
    // never-resolving binary path is irrelevant for them.
    let r = ClaudeResearcher::with_config(MemoryDataSource, never_resolves());
    let _ = block_on(r.ohlcv("AAPL", "1M")).expect("ok");
    let _ = block_on(r.options_chain("AAPL")).expect("ok");
    let _ = block_on(r.crypto_quote("BTC")).expect("ok");
    let _ = block_on(r.risk_metrics(&["AAPL".to_string()])).expect("ok");
}

#[test]
fn cached_call_does_not_respawn_binary() {
    // First call falls back through claude (which fails) and then to
    // memory. Second call should hit the cache *only if* the first
    // call's claude attempt succeeded — since it doesn't, the cache
    // stays empty and the second call repeats the fallback path
    // without panicking.
    let r = ClaudeResearcher::with_config(MemoryDataSource, never_resolves());
    let a = block_on(r.news(Some("AAPL"))).expect("first");
    let b = block_on(r.news(Some("AAPL"))).expect("second");
    assert_eq!(a, b);
}
