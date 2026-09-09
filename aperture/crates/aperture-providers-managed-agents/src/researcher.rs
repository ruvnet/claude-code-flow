//! `ManagedAgentsResearcher<F>` — `DataSource` impl that performs each
//! supported research method by spinning up a Managed Agents session,
//! sending the schema-pinned prompt, and parsing the agent's reply as
//! JSON.

use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Value;

use aperture_data::{Candle, DataError, DataSource, Payload, Quote};
use aperture_providers_claude::cache::TtlCache;
use aperture_providers_claude::exec::parse_loose_json;
use aperture_providers_claude::prompts;

use crate::api::{self, ApiError};
use crate::config::Config;

const AGENT_NAME: &str = "Aperture Market Research";
const ENV_NAME: &str = "aperture-research-env";
const SYSTEM_PROMPT: &str = "You are a financial market data research assistant. \
For each user request, search the web for the requested information and return \
ONLY a single JSON document matching the schema in the user message. \
Do not write files. Do not run bash beyond what's strictly required by the web tools. \
Do not add prose, code fences, or commentary.";

/// In-memory cache of (agent_id, environment_id) — these are created
/// once and reused across calls for the lifetime of the process.
#[derive(Default)]
struct Bootstrap {
    agent_id: Option<String>,
    environment_id: Option<String>,
}

pub struct ManagedAgentsResearcher<F: DataSource> {
    fallback: F,
    config: Config,
    cache: TtlCache,
    bootstrap: Mutex<Bootstrap>,
}

impl<F: DataSource> ManagedAgentsResearcher<F> {
    pub fn new(fallback: F, config: Config) -> Self {
        Self {
            fallback,
            config,
            cache: TtlCache::new(),
            bootstrap: Mutex::new(Bootstrap::default()),
        }
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    async fn ensure_bootstrap(&self) -> Result<(String, String), ApiError> {
        // Snapshot current state under the lock; release before the
        // (possibly long) network calls. Two concurrent first-callers
        // will both create their own agent + env — that's acceptable
        // for a v1; the second caller's IDs just go unused.
        let (have_agent, have_env) = {
            let g = self.bootstrap.lock().unwrap();
            (g.agent_id.clone(), g.environment_id.clone())
        };
        let agent_id = match have_agent {
            Some(id) => id,
            None => api::create_agent(&self.config, AGENT_NAME, SYSTEM_PROMPT).await?,
        };
        let environment_id = match have_env {
            Some(id) => id,
            None => api::create_environment(&self.config, ENV_NAME).await?,
        };
        {
            let mut g = self.bootstrap.lock().unwrap();
            if g.agent_id.is_none() {
                g.agent_id = Some(agent_id.clone());
            }
            if g.environment_id.is_none() {
                g.environment_id = Some(environment_id.clone());
            }
        }
        Ok((agent_id, environment_id))
    }

    async fn ask(&self, cache_key: &str, prompt: String) -> Result<Value, DataError> {
        if let Some(cached) = self.cache.get(cache_key, self.config.cache_ttl) {
            return Ok(cached);
        }
        let body = self
            .run_session(&prompt)
            .await
            .map_err(|e| DataError::Provider(format!("managed-agents: {e}")))?;
        self.cache.put(cache_key.to_string(), body.clone());
        Ok(body)
    }

    async fn run_session(&self, prompt: &str) -> Result<Value, ApiError> {
        let (agent_id, env_id) = self.ensure_bootstrap().await?;
        let session_id = api::create_session(
            &self.config,
            &agent_id,
            &env_id,
            "aperture-research",
        )
        .await?;
        let text = api::run_event(&self.config, &session_id, prompt).await?;
        parse_loose_json(&text).map_err(|e| ApiError::Json(e.to_string()))
    }
}

#[async_trait]
impl<F: DataSource> DataSource for ManagedAgentsResearcher<F> {
    fn name(&self) -> &'static str {
        "managed-agents"
    }

    // ---- Real-time methods: delegate ----

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
    async fn movers(&self, scope: Option<&str>) -> Result<Payload, DataError> {
        self.fallback.movers(scope).await
    }
    async fn screener(&self, criteria: Option<&str>) -> Result<Payload, DataError> {
        self.fallback.screener(criteria).await
    }

    // ---- Web-research methods: try Managed Agents, fall back on error ----

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
    fn name_is_managed_agents() {
        let r = ManagedAgentsResearcher::new(
            MemoryDataSource,
            Config::with_key("sk-ant-test"),
        );
        assert_eq!(r.name(), "managed-agents");
    }

    #[test]
    fn config_propagates() {
        let cfg = Config {
            api_key: "sk-ant-test".into(),
            model: "claude-opus-4-7".into(),
            ..Config::default()
        };
        let r = ManagedAgentsResearcher::new(MemoryDataSource, cfg);
        assert_eq!(r.config().model, "claude-opus-4-7");
    }
}
