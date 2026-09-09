use std::time::Duration;

use thiserror::Error;

/// Runtime knobs for the Managed Agents provider.
#[derive(Debug, Clone)]
pub struct Config {
    /// Anthropic API key (sk-ant-...). Required.
    pub api_key: String,
    /// API base URL. Default: `https://api.anthropic.com`. Override for
    /// proxies or self-hosted gateways.
    pub base_url: String,
    /// `anthropic-version` header value.
    pub anthropic_version: String,
    /// `anthropic-beta` header value. Default: `managed-agents-2026-04-01`.
    pub beta_header: String,
    /// Model name passed to the agent. Default: `claude-haiku-4-5-20251001`.
    pub model: String,
    /// Path to `curl`. Default: `"curl"` (resolved on PATH).
    pub curl_binary: String,
    /// Per-call timeout (covers create-session + send-event + stream).
    /// Default: 90s.
    pub timeout: Duration,
    /// TTL for cached results. Default: 1 hour.
    pub cache_ttl: Duration,
}

impl Config {
    /// Build a Config from the environment. Reads
    /// `ANTHROPIC_API_KEY` first, then `ANTHROPIC_KEY` as a friendly
    /// fallback. `ANTHROPIC_BASE_URL` overrides the API host when set
    /// (matches the Anthropic SDKs and Claude Code's proxied envs).
    /// Returns `Err` when no key is set so the caller can degrade
    /// explicitly.
    pub fn from_env() -> Result<Self, ConfigError> {
        let api_key = resolve_api_key()?;
        let base_url = std::env::var("ANTHROPIC_BASE_URL")
            .ok()
            .map(|v| v.trim_end_matches('/').to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| Self::default().base_url);
        Ok(Self {
            api_key,
            base_url,
            ..Self::default()
        })
    }

    /// Convenience for tests: build a Config with a fixed key, default
    /// the rest.
    pub fn with_key(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            ..Self::default()
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            base_url: "https://api.anthropic.com".into(),
            anthropic_version: "2023-06-01".into(),
            beta_header: "managed-agents-2026-04-01".into(),
            model: "claude-haiku-4-5-20251001".into(),
            curl_binary: "curl".into(),
            timeout: Duration::from_secs(90),
            cache_ttl: Duration::from_secs(3600),
        }
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("set ANTHROPIC_API_KEY (or ANTHROPIC_KEY) to enable the Managed Agents provider")]
    MissingApiKey,
}

fn resolve_api_key() -> Result<String, ConfigError> {
    for name in ["ANTHROPIC_API_KEY", "ANTHROPIC_KEY"] {
        if let Ok(v) = std::env::var(name) {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }
    Err(ConfigError::MissingApiKey)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_carry_beta_header() {
        let cfg = Config::default();
        assert_eq!(cfg.beta_header, "managed-agents-2026-04-01");
        assert_eq!(cfg.anthropic_version, "2023-06-01");
        assert_eq!(cfg.base_url, "https://api.anthropic.com");
    }

    #[test]
    fn with_key_sets_key_keeps_defaults() {
        let cfg = Config::with_key("sk-ant-test");
        assert_eq!(cfg.api_key, "sk-ant-test");
        assert_eq!(cfg.cache_ttl, Duration::from_secs(3600));
    }

    /// `from_env` reads `ANTHROPIC_API_KEY` first; we can't safely mutate
    /// real env vars in unit tests, so just check the error path when
    /// neither is set in a guarded scope.
    #[test]
    fn from_env_errors_when_no_key() {
        // Acquire both vars defensively. If the test host has either set
        // we skip without failing — this is an environmental constraint,
        // not a logic bug.
        if std::env::var("ANTHROPIC_API_KEY").is_ok()
            || std::env::var("ANTHROPIC_KEY").is_ok()
        {
            return;
        }
        let err = Config::from_env().unwrap_err();
        assert!(matches!(err, ConfigError::MissingApiKey));
    }
}
