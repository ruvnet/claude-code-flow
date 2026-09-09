//! Fallback smoke tests. Like the sibling `aperture-providers-claude`
//! crate, this researcher must yield the wrapped MemoryDataSource
//! output when the network leg fails — for any reason.
//!
//! We force failure deterministically by pointing the curl binary at a
//! path that's guaranteed not to exist. `ensure_bootstrap` then fails
//! at `create_agent` and the researcher falls back without touching
//! the network.

use std::time::Duration;

use aperture_data::{DataSource, MemoryDataSource};
use aperture_providers_managed_agents::{Config, ManagedAgentsResearcher};

fn never_resolves() -> Config {
    Config {
        api_key: "sk-ant-test".into(),
        curl_binary: "/nonexistent/aperture-fake-curl-binary".into(),
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
fn news_falls_back_when_curl_missing() {
    let r = ManagedAgentsResearcher::new(MemoryDataSource, never_resolves());
    let payload = block_on(r.news(Some("AAPL"))).expect("fallback ok");
    assert_eq!(payload["scope"], "AAPL");
    assert!(payload["headlines"].is_array());
}

#[test]
fn macro_falls_back_when_curl_missing() {
    let r = ManagedAgentsResearcher::new(MemoryDataSource, never_resolves());
    let payload = block_on(r.macro_indicators()).expect("fallback ok");
    let rows = payload.as_array().expect("array");
    assert!(rows.iter().any(|v| v["name"] == "CPI YoY"));
}

#[test]
fn yields_falls_back_when_curl_missing() {
    let r = ManagedAgentsResearcher::new(MemoryDataSource, never_resolves());
    let payload = block_on(r.yield_curve()).expect("fallback ok");
    assert_eq!(payload.as_array().unwrap().len(), 8);
}

#[test]
fn quote_passes_through_unconditionally() {
    // Real-time methods never touch the network leg.
    let r = ManagedAgentsResearcher::new(MemoryDataSource, never_resolves());
    let q = block_on(r.quote("AAPL")).expect("memory always succeeds");
    assert_eq!(q.symbol, "AAPL");
}

#[test]
fn options_chain_passes_through() {
    let r = ManagedAgentsResearcher::new(MemoryDataSource, never_resolves());
    let p = block_on(r.options_chain("AAPL")).expect("memory");
    assert!(p["chain"]["rows"].is_array() || p["rows"].is_array());
}
