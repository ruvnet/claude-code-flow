//! Inbound envelope renderers. Split into wave-grouped submodules to keep
//! every file under the 500-line cap.
//!
//! For each `<VERB>.RESULT` we know about, [`render_inbound`] produces one
//! or more [`ViewLine`]s targeted at the right [`Pane`]. Unknown verbs fall
//! back to address-based pane detection so the host still sees something.

use aperture_swarm::envelope::Envelope;
use serde_json::Value;

use crate::shell_routing::{Pane, ViewLine};

mod wave1;
mod wave3;

use wave1::*;
use wave3::*;

/// Decide which pane an inbound envelope belongs to and produce display
/// lines. Dispatch is on `payload.verb` first (so `*.RESULT` replies route
/// deterministically); we fall back to the address only if the verb is
/// missing or unknown. Errors short-circuit to a single line.
pub fn render_inbound(env: &Envelope) -> Vec<ViewLine> {
    let verb = env
        .payload
        .get("verb")
        .and_then(Value::as_str)
        .unwrap_or("?")
        .to_string();

    if let Some(err) = env.payload.get("error").and_then(Value::as_str) {
        let pane = pane_from_verb(&verb).unwrap_or_else(|| pane_from_address(&env.from));
        return vec![line(pane, format!("{verb}  error: {err}"))];
    }

    match verb.as_str() {
        // Wave-1
        "QUOTE.RESULT" => render_quote(&env.payload),
        "CHART.RESULT" => render_chart(&env.payload),
        "WATCH.RESULT" | "UNWATCH.RESULT" | "LIST.RESULT" => render_watch(&env.payload, &verb),
        "ASK.RESULT" => render_ask(&env.payload),
        "NEWS.RESULT" => render_news(&env.payload),
        "MACRO.RESULT" => render_macro(&env.payload),
        "YIELDS.RESULT" => render_yields(&env.payload),
        "FX.RESULT" => render_fx(&env.payload),
        "OPTIONS.RESULT" => render_options(&env.payload),
        "INSIDER.RESULT" => render_insider(&env.payload),
        "FINANCIALS.RESULT" => render_financials(&env.payload),
        "CRYPTO.RESULT" => render_crypto(&env.payload),
        "RISK.RESULT" => render_risk(&env.payload),
        "CORPACT.RESULT" => render_corpact(&env.payload),
        "INBOX.RESULT" => render_inbox(&env.payload),
        "EXPORT.RESULT" => render_export(&env.payload),
        // Wave-3
        "EARNINGS.RESULT" => render_earnings(&env.payload),
        "MOVERS.RESULT" => render_movers(&env.payload),
        "SCREEN.RESULT" => render_screen(&env.payload),
        "MEMBERS.RESULT" => render_members(&env.payload),
        "IVOL.RESULT" => render_ivol(&env.payload),
        "TECH.RESULT" => render_tech(&env.payload),
        "CORR.RESULT" => render_corr(&env.payload),
        "FILINGS.RESULT" => render_filings(&env.payload),
        "ORDER.RESULT" => render_order(&env.payload),
        "BLOTTER.RESULT" => render_blotter(&env.payload),
        "SENTIMENT.RESULT" => render_sentiment(&env.payload),
        _ => {
            let pane = pane_from_address(&env.from);
            let payload_str = serde_json::to_string(&env.payload).unwrap_or_default();
            vec![line(pane, format!("{verb}  {payload_str}"))]
        }
    }
}

fn pane_from_verb(verb: &str) -> Option<Pane> {
    match verb {
        "QUOTE.RESULT" => Some(Pane::Quote),
        "CHART.RESULT" => Some(Pane::Chart),
        "WATCH.RESULT" | "UNWATCH.RESULT" | "LIST.RESULT" => Some(Pane::Watch),
        "ASK.RESULT" => Some(Pane::Oracle),
        "NEWS.RESULT" => Some(Pane::News),
        "MACRO.RESULT" => Some(Pane::Macro),
        "YIELDS.RESULT" => Some(Pane::Yields),
        "FX.RESULT" => Some(Pane::Fx),
        "OPTIONS.RESULT" => Some(Pane::Options),
        "INSIDER.RESULT" => Some(Pane::Insider),
        "FINANCIALS.RESULT" => Some(Pane::Financials),
        "CRYPTO.RESULT" => Some(Pane::Crypto),
        "RISK.RESULT" => Some(Pane::Risk),
        "CORPACT.RESULT" => Some(Pane::Corpact),
        "INBOX.RESULT" => Some(Pane::Inbox),
        "EXPORT.RESULT" => Some(Pane::Export),
        "EARNINGS.RESULT" => Some(Pane::Earnings),
        "MOVERS.RESULT" => Some(Pane::Movers),
        "SCREEN.RESULT" => Some(Pane::Screen),
        "MEMBERS.RESULT" => Some(Pane::Members),
        "IVOL.RESULT" => Some(Pane::Ivol),
        "TECH.RESULT" => Some(Pane::Tech),
        "CORR.RESULT" => Some(Pane::Corr),
        "FILINGS.RESULT" => Some(Pane::Filings),
        "ORDER.RESULT" | "BLOTTER.RESULT" => Some(Pane::Order),
        "SENTIMENT.RESULT" => Some(Pane::Sentiment),
        _ => None,
    }
}

fn pane_from_address(addr: &str) -> Pane {
    let lower = addr.to_ascii_lowercase();
    // Check pane.<id> first so the longest match wins.
    let table = [
        ("pane.quote", Pane::Quote),
        ("pane.chart", Pane::Chart),
        ("pane.watch", Pane::Watch),
        ("pane.oracle", Pane::Oracle),
        ("pane.news", Pane::News),
        ("pane.macro", Pane::Macro),
        ("pane.yields", Pane::Yields),
        ("pane.fx", Pane::Fx),
        ("pane.options", Pane::Options),
        ("pane.insider", Pane::Insider),
        ("pane.financials", Pane::Financials),
        ("pane.crypto", Pane::Crypto),
        ("pane.risk", Pane::Risk),
        ("pane.corpact", Pane::Corpact),
        ("pane.inbox", Pane::Inbox),
        ("pane.export", Pane::Export),
        ("pane.earnings", Pane::Earnings),
        ("pane.movers", Pane::Movers),
        ("pane.screen", Pane::Screen),
        ("pane.members", Pane::Members),
        ("pane.ivol", Pane::Ivol),
        ("pane.tech", Pane::Tech),
        ("pane.corr", Pane::Corr),
        ("pane.filings", Pane::Filings),
        ("pane.order", Pane::Order),
        ("pane.sentiment", Pane::Sentiment),
        ("agent.quote", Pane::Quote),
        ("agent.watch", Pane::Watch),
        ("agent.oracle", Pane::Oracle),
        ("agent.data", Pane::Chart),
    ];
    for (needle, pane) in table {
        if lower.contains(needle) {
            return pane;
        }
    }
    Pane::System
}

// Shared helpers used by both submodules.

pub(super) fn line(pane: Pane, text: String) -> ViewLine {
    ViewLine { pane, text }
}

pub(super) fn value_to_compact_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

// Tests for `render_inbound` live in `tests/inbound_rendering.rs` so this
// file stays under the 500-line cap.
