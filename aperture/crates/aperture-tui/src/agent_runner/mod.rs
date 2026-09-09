//! `--agent=<id>` dispatch: each pane / data agent runs as a headless
//! stdio process implementing `aperture_swarm::Agent`.
//!
//! The host (the swarm coordinator, or the round-trip integration test)
//! spawns one of these processes per pane and pipes newline-delimited
//! `Envelope` JSON in/out.

use anyhow::{anyhow, Result};
use aperture_swarm::{run_agent, Envelope};
use serde_json::Value;

mod data;
mod panes;

/// Dispatch on the `--agent=<id>` value. Returns `Ok(true)` if the value
/// matched a known agent (and ran it to EOF); `Ok(false)` if the id is
/// unknown so the caller can surface a clear error.
pub async fn dispatch(agent_id: &str) -> Result<bool> {
    macro_rules! run {
        ($agent:expr) => {
            run_agent($agent)
                .await
                .map(|_| true)
                .map_err(into_anyhow)
        };
    }
    match agent_id {
        "pane.quote" => run!(panes::QuotePane::new()),
        "pane.chart" => run!(panes::ChartPane::new()),
        "pane.watchlist" => run!(panes::WatchlistPane::new()),
        "pane.oracle" => run!(panes::OraclePane::new()),

        "pane.news" => run!(panes::NewsPane::new()),
        "pane.macro" => run!(panes::MacroPane::new()),
        "pane.yields" => run!(panes::YieldsPane::new()),
        "pane.fx" => run!(panes::FxPane::new()),
        "pane.options" => run!(panes::OptionsPane::new()),
        "pane.insider" => run!(panes::InsiderPane::new()),
        "pane.financials" => run!(panes::FinancialsPane::new()),
        "pane.crypto" => run!(panes::CryptoPane::new()),
        "pane.risk" => run!(panes::RiskPane::new()),
        "pane.corpact" => run!(panes::CorpactPane::new()),
        "pane.inbox" => run!(panes::InboxPane::new()),
        "pane.export" => run!(panes::ExportPane::new()),

        "pane.earnings" => run!(panes::EarningsPane::new()),
        "pane.movers" => run!(panes::MoversPane::new()),
        "pane.screen" => run!(panes::ScreenPane::new()),
        "pane.members" => run!(panes::MembersPane::new()),
        "pane.ivol" => run!(panes::IvolPane::new()),
        "pane.tech" => run!(panes::TechPane::new()),
        "pane.corr" => run!(panes::CorrPane::new()),
        "pane.filings" => run!(panes::FilingsPane::new()),
        "pane.order" => run!(panes::OrderPane::new()),
        "pane.sentiment" => run!(panes::SentimentPane::new()),

        "agent.data" => run!(data::DataAgent::new()),
        _ => Ok(false),
    }
}

/// All known `--agent=<id>` strings, in dispatch order. Used by tests and
/// the WASM shell to enumerate available agents.
pub const KNOWN_AGENTS: &[&str] = &[
    "pane.quote",
    "pane.chart",
    "pane.watchlist",
    "pane.oracle",
    "pane.news",
    "pane.macro",
    "pane.yields",
    "pane.fx",
    "pane.options",
    "pane.insider",
    "pane.financials",
    "pane.crypto",
    "pane.risk",
    "pane.corpact",
    "pane.inbox",
    "pane.export",
    "pane.earnings",
    "pane.movers",
    "pane.screen",
    "pane.members",
    "pane.ivol",
    "pane.tech",
    "pane.corr",
    "pane.filings",
    "pane.order",
    "pane.sentiment",
    "agent.data",
];

fn into_anyhow(e: aperture_swarm::native_stdio::TransportError) -> anyhow::Error {
    anyhow!("transport error: {e}")
}

/// Extract `payload.verb` as a string slice.
pub(crate) fn verb<'a>(env: &'a Envelope) -> Option<&'a str> {
    env.payload.get("verb").and_then(Value::as_str)
}

/// Extract `payload.symbol` as an upper-cased `String`.
pub(crate) fn symbol_of(env: &Envelope) -> Option<String> {
    env.payload
        .get("symbol")
        .and_then(Value::as_str)
        .map(|s| s.to_ascii_uppercase())
}

/// Render an OHLCV candle series as an 8-row ASCII chart. Used by the chart
/// pane; lives here so the data agent can also expose a "rendered" view if
/// future verbs need it.
pub(crate) fn render_ascii_chart(candles: &[aperture_data::Candle]) -> Vec<String> {
    if candles.is_empty() {
        return vec!["(no data)".into()];
    }
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for c in candles {
        lo = lo.min(c.l);
        hi = hi.max(c.h);
    }
    let rows = 8usize;
    let cols = candles.len().min(60);
    let mut grid = vec![vec![' '; cols]; rows];
    for (x, c) in candles.iter().take(cols).enumerate() {
        let scale = |v: f64| -> usize {
            if hi == lo {
                rows / 2
            } else {
                let n = (v - lo) / (hi - lo);
                ((1.0 - n) * (rows as f64 - 1.0)).round() as usize
            }
        };
        let high_y = scale(c.h);
        let low_y = scale(c.l);
        let close_y = scale(c.c);
        for y in high_y..=low_y {
            grid[y][x] = '|';
        }
        if close_y < rows {
            grid[close_y][x] = '*';
        }
    }
    let mut out: Vec<String> = grid.into_iter().map(|r| r.into_iter().collect()).collect();
    out.push(format!("range hi {:.2}  lo {:.2}", hi, lo));
    out
}
