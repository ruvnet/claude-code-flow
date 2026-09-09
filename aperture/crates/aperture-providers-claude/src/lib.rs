//! Web-research DataSource backed by headless `claude -p` invocations.
//!
//! `ClaudeResearcher<F: DataSource>` wraps a fallback provider (typically
//! `MemoryDataSource`) and intercepts the nine methods that benefit from
//! live web data:
//!
//! ```text
//! news, macro_indicators, yield_curve, fx_rates, earnings_calendar,
//! index_members, corp_actions, filings, sentiment
//! ```
//!
//! For each, the crate shells out to:
//!
//! ```bash
//! claude -p --output-format json --dangerously-skip-permissions \
//!        --max-budget-usd 0.05 --allowedTools "WebFetch,WebSearch" \
//!        "<prompt>"
//! ```
//!
//! parses the response, validates shape, and returns a `Payload`. On any
//! error (claude not on PATH, timeout, malformed JSON, validation
//! failure) the call falls back to the wrapped provider.
//!
//! Methods that need real-time market data (`quote`, `ohlcv`,
//! `options_chain`, `vol_surface`, `technicals`, `correlation_matrix`,
//! `risk_metrics`, `crypto_quote`, `insider_trades`, `movers`,
//! `screener`) delegate directly to the fallback — `claude -p` cannot
//! produce them reliably from web content alone.
//!
//! ## Cache
//!
//! Results are memoised in-process with a 1-hour TTL keyed by
//! (method, args). The TTL deliberately matches the freshness of the
//! data: news / yields / fx are reasonably stable for an hour, and a
//! shorter TTL would burn budget needlessly.
//!
//! ## No live invocations in tests
//!
//! Unit tests cover prompt assembly, JSON parsing, and cache eviction
//! without spawning `claude`. Integration tests that actually invoke
//! `claude` are marked `#[ignore]` and only run with
//! `cargo test -p aperture-providers-claude -- --ignored`.

pub mod cache;
pub mod config;
pub mod exec;
pub mod prompts;

mod researcher;

pub use config::Config;
pub use researcher::ClaudeResearcher;
