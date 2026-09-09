//! `ClaudeResearcher<F>` — `DataSource` implementation that intercepts
//! the nine web-friendly methods and shells out to `claude -p`. All
//! other methods delegate to the wrapped fallback.

use async_trait::async_trait;
use serde_json::Value;

use aperture_data::{Candle, DataError, DataSource, Payload, Quote};

use crate::cache::TtlCache;
use crate::config::Config;
use crate::{exec, prompts};

pub struct ClaudeResearcher<F: DataSource> {
    fallback: F,
    config: Config,
    cache: TtlCache,
}

impl<F: DataSource> ClaudeResearcher<F> {
    pub fn new(fallback: F) -> Self {
        Self::with_config(fallback, Config::default())
    }

    pub fn with_config(fallback: F, config: Config) -> Self {
        Self {
            fallback,
            config,
            cache: TtlCache::new(),
        }
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    /// Run a prompt through `claude -p`, with caching keyed by `cache_key`.
    /// Returns `Err(DataError::Provider)` on any failure so the caller can
    /// fall back to the wrapped source.
    async fn ask(&self, cache_key: &str, prompt: String) -> Result<Value, DataError> {
        if let Some(cached) = self.cache.get(cache_key, self.config.cache_ttl) {
            return Ok(cached);
        }
        let body = exec::run(&prompt, &self.config)
            .await
            .map_err(|e| DataError::Provider(format!("claude: {e}")))?;
        self.cache.put(cache_key.to_string(), body.clone());
        Ok(body)
    }
}

#[async_trait]
impl<F: DataSource> DataSource for ClaudeResearcher<F> {
    fn name(&self) -> &'static str {
        "claude"
    }

    // ---- Pass-through (real-time market data — claude -p can't deliver) ----

    async fn quote(&self, symbol: &str) -> Result<Quote, DataError> {
        self.fallback.quote(symbol).await
    }

    async fn ohlcv(&self, symbol: &str, range: &str) -> Result<Vec<Candle>, DataError> {
        self.fallback.ohlcv(symbol, range).await
    }

    async fn options_chain(&self, symbol: &str) -> Result<Payload, DataError> {
        self.fallback.options_chain(symbol).await
    }

    async fn vol_surface(&self, symbol: &str) -> Result<Payload, DataError> {
        self.fallback.vol_surface(symbol).await
    }

    async fn technicals(&self, symbol: &str, indicator: &str) -> Result<Payload, DataError> {
        self.fallback.technicals(symbol, indicator).await
    }

    async fn correlation_matrix(&self, symbols: &[String]) -> Result<Payload, DataError> {
        self.fallback.correlation_matrix(symbols).await
    }

    async fn risk_metrics(&self, symbols: &[String]) -> Result<Payload, DataError> {
        self.fallback.risk_metrics(symbols).await
    }

    async fn crypto_quote(&self, symbol: &str) -> Result<Payload, DataError> {
        self.fallback.crypto_quote(symbol).await
    }

    async fn insider_trades(&self, symbol: &str) -> Result<Payload, DataError> {
        self.fallback.insider_trades(symbol).await
    }

    async fn financials(&self, symbol: &str) -> Result<Payload, DataError> {
        self.fallback.financials(symbol).await
    }

    async fn movers(&self, scope: Option<&str>) -> Result<Payload, DataError> {
        self.fallback.movers(scope).await
    }

    async fn screener(&self, criteria: Option<&str>) -> Result<Payload, DataError> {
        self.fallback.screener(criteria).await
    }

    // ---- Web-research methods: try claude, fall back on error ----

    async fn news(&self, symbol: Option<&str>) -> Result<Payload, DataError> {
        let key = format!("news:{}", symbol.unwrap_or("GLOBAL").to_ascii_uppercase());
        match self.ask(&key, prompts::news(symbol)).await {
            Ok(v) => Ok(v),
            Err(_) => self.fallback.news(symbol).await,
        }
    }

    async fn macro_indicators(&self) -> Result<Payload, DataError> {
        match self.ask("macro", prompts::macro_indicators()).await {
            Ok(v) => Ok(v),
            Err(_) => self.fallback.macro_indicators().await,
        }
    }

    async fn yield_curve(&self) -> Result<Payload, DataError> {
        match self.ask("yields", prompts::yield_curve()).await {
            Ok(v) => Ok(v),
            Err(_) => self.fallback.yield_curve().await,
        }
    }

    async fn fx_rates(&self, base: Option<&str>) -> Result<Payload, DataError> {
        let key = format!("fx:{}", base.unwrap_or("USD").to_ascii_uppercase());
        match self.ask(&key, prompts::fx_rates(base)).await {
            Ok(v) => Ok(v),
            Err(_) => self.fallback.fx_rates(base).await,
        }
    }

    async fn earnings_calendar(&self, window_days: Option<u32>) -> Result<Payload, DataError> {
        let key = format!("earnings:{}", window_days.unwrap_or(7));
        match self.ask(&key, prompts::earnings_calendar(window_days)).await {
            Ok(v) => Ok(v),
            Err(_) => self.fallback.earnings_calendar(window_days).await,
        }
    }

    async fn index_members(&self, symbol: &str) -> Result<Payload, DataError> {
        let key = format!("members:{}", symbol.to_ascii_uppercase());
        match self.ask(&key, prompts::index_members(symbol)).await {
            Ok(v) => Ok(v),
            Err(_) => self.fallback.index_members(symbol).await,
        }
    }

    async fn corp_actions(&self, symbol: &str) -> Result<Payload, DataError> {
        let key = format!("corpact:{}", symbol.to_ascii_uppercase());
        match self.ask(&key, prompts::corp_actions(symbol)).await {
            Ok(v) => Ok(v),
            Err(_) => self.fallback.corp_actions(symbol).await,
        }
    }

    async fn filings(&self, symbol: &str) -> Result<Payload, DataError> {
        let key = format!("filings:{}", symbol.to_ascii_uppercase());
        match self.ask(&key, prompts::filings(symbol)).await {
            Ok(v) => Ok(v),
            Err(_) => self.fallback.filings(symbol).await,
        }
    }

    async fn sentiment(&self, symbol: &str) -> Result<Payload, DataError> {
        let key = format!("sentiment:{}", symbol.to_ascii_uppercase());
        match self.ask(&key, prompts::sentiment(symbol)).await {
            Ok(v) => Ok(v),
            Err(_) => self.fallback.sentiment(symbol).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aperture_data::MemoryDataSource;

    #[test]
    fn name_is_claude() {
        let r = ClaudeResearcher::new(MemoryDataSource);
        assert_eq!(r.name(), "claude");
    }

    #[test]
    fn config_carries_default_when_unspecified() {
        let r = ClaudeResearcher::new(MemoryDataSource);
        assert_eq!(r.config().binary, "claude");
        assert_eq!(r.config().allowed_tools, vec!["WebFetch", "WebSearch"]);
    }

    #[test]
    fn config_override_propagates() {
        let cfg = Config {
            binary: "/usr/local/bin/claude".into(),
            model: Some("sonnet".into()),
            ..Config::default()
        };
        let r = ClaudeResearcher::with_config(MemoryDataSource, cfg);
        assert_eq!(r.config().binary, "/usr/local/bin/claude");
        assert_eq!(r.config().model.as_deref(), Some("sonnet"));
    }
}
