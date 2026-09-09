//! Live end-to-end test against the real Claude Managed Agents API.
//!
//! Ignored by default — it requires `ANTHROPIC_API_KEY` (or
//! `ANTHROPIC_KEY`), network egress to `api.anthropic.com` (or whatever
//! `ANTHROPIC_BASE_URL` points at), Managed Agents access on the org,
//! and it costs a few cents per run (it spins up a real cloud
//! container and runs the agent loop with web search).
//!
//! Run it explicitly:
//!
//! ```bash
//! cargo test -p aperture-providers-managed-agents --test live -- --ignored --nocapture
//! ```
//!
//! Even on failure the test still proves something useful: the
//! researcher must fall back to the wrapped `MemoryDataSource` on any
//! error, so a failed live leg should still yield a well-shaped payload
//! — just the deterministic offline one rather than fresh web data.

use aperture_data::{DataSource, MemoryDataSource};
use aperture_providers_managed_agents::{api, Config, ManagedAgentsResearcher};

/// Step-by-step diagnostic: runs each Managed Agents call in sequence
/// and prints the result or error so we can see exactly which leg fails
/// when the high-level researcher falls back.
#[tokio::test]
#[ignore = "live diagnostic; requires ANTHROPIC_API_KEY + network"]
async fn live_diagnostic_full_chain() {
    let cfg = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("skipping: {e}");
            return;
        }
    };
    eprintln!("base_url = {}", cfg.base_url);
    eprintln!("model    = {}", cfg.model);

    let agent_id = match api::create_agent(&cfg, "Aperture Diag", "You are a test agent.").await {
        Ok(id) => {
            eprintln!("create_agent OK -> {id}");
            id
        }
        Err(e) => panic!("create_agent FAILED: {e}"),
    };

    let env_id = match api::create_environment(&cfg, "aperture-diag-env").await {
        Ok(id) => {
            eprintln!("create_environment OK -> {id}");
            id
        }
        Err(e) => panic!("create_environment FAILED: {e}"),
    };

    let session_id = match api::create_session(&cfg, &agent_id, &env_id, "aperture-diag").await {
        Ok(id) => {
            eprintln!("create_session OK -> {id}");
            id
        }
        Err(e) => panic!("create_session FAILED: {e}"),
    };

    let prompt = "Reply with exactly this JSON and nothing else: {\"ok\": true, \"diag\": \"chain\"}";
    match api::run_event(&cfg, &session_id, prompt).await {
        Ok(text) => {
            eprintln!("run_event OK, raw agent text:\n{text}");
            assert!(!text.is_empty(), "run_event returned empty text");
        }
        Err(e) => panic!("run_event FAILED: {e}"),
    }
}

#[tokio::test]
#[ignore = "requires ANTHROPIC_API_KEY + network + Managed Agents access; costs ~$0.05"]
async fn live_news_round_trip() {
    let cfg = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("skipping live test: {e}");
            return;
        }
    };
    eprintln!(
        "live test: base_url={} model={} (key prefix {}...)",
        cfg.base_url,
        cfg.model,
        &cfg.api_key.chars().take(8).collect::<String>()
    );

    let r = ManagedAgentsResearcher::new(MemoryDataSource, cfg);
    let payload = r
        .news(Some("AAPL"))
        .await
        .expect("news() must return Ok (live or fallen-back)");
    eprintln!(
        "news payload:\n{}",
        serde_json::to_string_pretty(&payload).unwrap_or_default()
    );

    // Shape holds regardless of which path produced it.
    assert_eq!(payload["scope"], "AAPL");
    assert!(payload["headlines"].is_array());
    assert!(
        !payload["headlines"].as_array().unwrap().is_empty(),
        "expected at least one headline"
    );
}

#[tokio::test]
#[ignore = "requires ANTHROPIC_API_KEY + network + Managed Agents access; costs ~$0.05"]
async fn live_yield_curve_round_trip() {
    let cfg = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("skipping live test: {e}");
            return;
        }
    };
    let r = ManagedAgentsResearcher::new(MemoryDataSource, cfg);
    let payload = r.yield_curve().await.expect("yield_curve() must return Ok");
    eprintln!(
        "yield curve:\n{}",
        serde_json::to_string_pretty(&payload).unwrap_or_default()
    );
    let arr = payload.as_array().expect("array");
    assert!(!arr.is_empty());
}
