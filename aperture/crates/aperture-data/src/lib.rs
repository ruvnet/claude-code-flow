//! Data layer abstractions: `DataSource` for market feeds, `KeyValueStore`
//! for persistence (watchlists, last-seen). Real providers (yahoo, fred,
//! coingecko, ...) live in sibling crates and are wired in behind cargo
//! features in later phases. v0.1 ships only the `memory` provider.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DataError {
    #[error("symbol not found: {0}")]
    NotFound(String),
    #[error("provider error: {0}")]
    Provider(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Quote {
    pub symbol: String,
    pub last: f64,
    pub change_pct: f64,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Candle {
    pub t: i64,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
    pub v: f64,
}

/// JSON-shaped payload returned by the wide market-info methods.
/// Kept opaque so each provider can shape its own structure without forcing a
/// shared type on callers; consumers parse the relevant subset themselves.
pub type Payload = serde_json::Value;

#[async_trait]
pub trait DataSource: Send + Sync {
    fn name(&self) -> &'static str;
    async fn quote(&self, symbol: &str) -> Result<Quote, DataError>;
    async fn ohlcv(&self, symbol: &str, range: &str) -> Result<Vec<Candle>, DataError>;

    // --- Wide market-info methods ----------------------------------------
    // Default implementations return `Provider("not supported")` so future
    // single-purpose providers (e.g. yahoo, fred) can opt into only the
    // methods they cover. `MemoryDataSource` overrides every method with
    // deterministic data.

    async fn news(&self, _symbol: Option<&str>) -> Result<Payload, DataError> {
        Err(not_supported("news"))
    }
    async fn macro_indicators(&self) -> Result<Payload, DataError> {
        Err(not_supported("macro"))
    }
    async fn yield_curve(&self) -> Result<Payload, DataError> {
        Err(not_supported("yields"))
    }
    async fn fx_rates(&self, _base: Option<&str>) -> Result<Payload, DataError> {
        Err(not_supported("fx"))
    }
    async fn options_chain(&self, _symbol: &str) -> Result<Payload, DataError> {
        Err(not_supported("options"))
    }
    async fn insider_trades(&self, _symbol: &str) -> Result<Payload, DataError> {
        Err(not_supported("insider"))
    }
    async fn financials(&self, _symbol: &str) -> Result<Payload, DataError> {
        Err(not_supported("financials"))
    }
    async fn crypto_quote(&self, _symbol: &str) -> Result<Payload, DataError> {
        Err(not_supported("crypto_quote"))
    }
    async fn risk_metrics(&self, _symbols: &[String]) -> Result<Payload, DataError> {
        Err(not_supported("risk"))
    }
    async fn corp_actions(&self, _symbol: &str) -> Result<Payload, DataError> {
        Err(not_supported("corp_actions"))
    }
    async fn earnings_calendar(&self, _window_days: Option<u32>) -> Result<Payload, DataError> {
        Err(not_supported("earnings_calendar"))
    }
    async fn movers(&self, _scope: Option<&str>) -> Result<Payload, DataError> {
        Err(not_supported("movers"))
    }
    async fn screener(&self, _criteria: Option<&str>) -> Result<Payload, DataError> {
        Err(not_supported("screener"))
    }
    async fn index_members(&self, _symbol: &str) -> Result<Payload, DataError> {
        Err(not_supported("index_members"))
    }
    async fn vol_surface(&self, _symbol: &str) -> Result<Payload, DataError> {
        Err(not_supported("vol_surface"))
    }
    async fn technicals(&self, _symbol: &str, _indicator: &str) -> Result<Payload, DataError> {
        Err(not_supported("technicals"))
    }
    async fn correlation_matrix(&self, _symbols: &[String]) -> Result<Payload, DataError> {
        Err(not_supported("correlation_matrix"))
    }
    async fn filings(&self, _symbol: &str) -> Result<Payload, DataError> {
        Err(not_supported("filings"))
    }
    async fn sentiment(&self, _symbol: &str) -> Result<Payload, DataError> {
        Err(not_supported("sentiment"))
    }
}

fn not_supported(what: &str) -> DataError {
    DataError::Provider(format!("{what} not supported by this provider"))
}

#[derive(Debug, Error)]
pub enum KvError {
    #[error("io: {0}")]
    Io(String),
    #[error("missing key: {0}")]
    Missing(String),
}

pub trait KeyValueStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, KvError>;
    fn put(&self, key: &str, value: &[u8]) -> Result<(), KvError>;
    fn delete(&self, key: &str) -> Result<(), KvError>;
}

#[cfg(feature = "memory")]
pub mod memory;
#[cfg(feature = "memory")]
pub use memory::MemoryDataSource;
