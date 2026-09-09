use std::time::Duration;

/// Runtime knobs for the `claude -p` provider. Defaults are tuned for
/// keeping per-call cost under USD 0.05 and per-call latency under
/// 60 seconds.
#[derive(Debug, Clone)]
pub struct Config {
    /// Path to the `claude` binary. Default: `"claude"` (resolved on PATH).
    pub binary: String,
    /// Tools `claude -p` is allowed to call. Default: `["WebFetch", "WebSearch"]`.
    pub allowed_tools: Vec<String>,
    /// Max USD spend per invocation. Default: 0.05.
    pub max_budget_usd: f64,
    /// Hard timeout per invocation. Default: 60s.
    pub timeout: Duration,
    /// Optional model override (`haiku`/`sonnet`/`opus`). Default: `"haiku"`
    /// — the smallest model that handles structured-JSON web summaries
    /// reliably.
    pub model: Option<String>,
    /// Cache TTL for memoised results. Default: 1 hour.
    pub cache_ttl: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            binary: "claude".into(),
            allowed_tools: vec!["WebFetch".into(), "WebSearch".into()],
            max_budget_usd: 0.05,
            timeout: Duration::from_secs(60),
            model: Some("haiku".into()),
            cache_ttl: Duration::from_secs(3600),
        }
    }
}
