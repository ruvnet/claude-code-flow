//! In-WASM data backend for the standalone browser shell.
//!
//! When a real swarm bus is connected (the SvelteKit host wired to ruflo's
//! `message-bus.ts`), data-verb requests round-trip out as [`Envelope`]s and
//! the answering pane agent's `<VERB>.RESULT` comes back through
//! [`crate::shell::App::handle_inbound`]. But the bare `aperture-ui` SPA has
//! no bus and no agent processes, so it would show nothing. This module makes
//! the shell *its own data agent*: it resolves the request against the
//! deterministic [`MemoryDataSource`] (the same provider the TUI pane agents
//! use), builds the same `<VERB>.RESULT` payload those agents would, and
//! renders it through [`render_inbound`] — identical output to a real agent
//! round-trip, just synchronous and offline.
//!
//! Only the data-backed verbs are self-serviced here. Stateful panes
//! (WATCH / INBOX / ORDER) and provider-backed verbs (ASK → claude) stay
//! no-ops in the standalone shell — use the TUI or the SvelteKit host for
//! those.

use aperture_core::{Arg, Command, Verb};
use aperture_data::{Candle, DataSource, MemoryDataSource};
use aperture_swarm::envelope::{Envelope, MessageType, Priority};
use serde_json::{json, Value};

use crate::shell_renderers::render_inbound;
use crate::shell_routing::ViewLine;

/// Resolve a parsed command against the in-memory provider and render the
/// per-pane view lines. Empty for verbs without a local data path.
pub fn resolve_local(cmd: &Command, last_symbol: Option<&str>) -> Vec<ViewLine> {
    match result_payload(cmd, last_symbol) {
        Some(payload) => render_inbound(&result_envelope(payload)),
        None => Vec::new(),
    }
}

/// Build the `<VERB>.RESULT` payload for a data verb, or `None` if the verb
/// isn't self-serviced in the browser shell. Errors are surfaced as a payload
/// with an `"error"` key (which `render_inbound` turns into a one-line note).
fn result_payload(cmd: &Command, last_symbol: Option<&str>) -> Option<Value> {
    let src = MemoryDataSource;
    let sym_or = |fallback: bool| -> Result<String, Value> {
        match cmd.symbol.clone() {
            Some(s) => Ok(s),
            None if fallback => last_symbol
                .map(|s| s.to_string())
                .ok_or_else(|| json!("missing symbol")),
            None => Err(json!("missing symbol")),
        }
    };

    let payload = match cmd.verb {
        Verb::Desc => {
            let sym = match sym_or(true) {
                Ok(s) => s,
                Err(_) => return Some(rerr("QUOTE", None, "missing symbol")),
            };
            match block_ready(src.quote(&sym)) {
                Ok(q) => json!({
                    "verb": "QUOTE.RESULT",
                    "symbol": q.symbol, "last": q.last, "changePct": q.change_pct,
                    "bid": q.bid, "ask": q.ask, "timestamp": q.timestamp,
                }),
                Err(e) => rerr("QUOTE", Some(&sym), &e.to_string()),
            }
        }
        Verb::Chart => {
            let sym = match sym_or(true) {
                Ok(s) => s,
                Err(_) => return Some(rerr("CHART", None, "missing symbol")),
            };
            let range = first_arg(cmd).unwrap_or_else(|| "1M".into());
            match block_ready(src.ohlcv(&sym, &range)) {
                Ok(candles) => json!({
                    "verb": "CHART.RESULT", "symbol": sym, "range": range,
                    "lines": ascii_chart(&candles), "candleCount": candles.len(),
                }),
                Err(e) => rerr("CHART", Some(&sym), &e.to_string()),
            }
        }
        Verb::News => match block_ready(src.news(cmd.symbol.as_deref())) {
            Ok(data) => {
                let scope = data
                    .get("scope")
                    .and_then(Value::as_str)
                    .unwrap_or("GLOBAL")
                    .to_string();
                json!({ "verb": "NEWS.RESULT", "scope": scope, "data": data })
            }
            Err(e) => rerr("NEWS", None, &e.to_string()),
        },
        Verb::Macro => match block_ready(src.macro_indicators()) {
            Ok(rows) => json!({ "verb": "MACRO.RESULT", "rows": rows }),
            Err(e) => rerr("MACRO", None, &e.to_string()),
        },
        Verb::Yields => match block_ready(src.yield_curve()) {
            Ok(curve) => json!({ "verb": "YIELDS.RESULT", "curve": curve }),
            Err(e) => rerr("YIELDS", None, &e.to_string()),
        },
        Verb::Fx => match block_ready(src.fx_rates(first_arg(cmd).as_deref())) {
            Ok(data) => json!({ "verb": "FX.RESULT", "data": data }),
            Err(e) => rerr("FX", None, &e.to_string()),
        },
        Verb::Options => {
            let sym = match sym_or(true) {
                Ok(s) => s,
                Err(_) => return Some(rerr("OPTIONS", None, "missing symbol")),
            };
            match block_ready(src.options_chain(&sym)) {
                Ok(chain) => json!({ "verb": "OPTIONS.RESULT", "symbol": sym, "chain": chain }),
                Err(e) => rerr("OPTIONS", Some(&sym), &e.to_string()),
            }
        }
        Verb::Insider => {
            let sym = match sym_or(true) {
                Ok(s) => s,
                Err(_) => return Some(rerr("INSIDER", None, "missing symbol")),
            };
            match block_ready(src.insider_trades(&sym)) {
                Ok(data) => json!({ "verb": "INSIDER.RESULT", "symbol": sym, "data": data }),
                Err(e) => rerr("INSIDER", Some(&sym), &e.to_string()),
            }
        }
        Verb::Financials => {
            let sym = match sym_or(true) {
                Ok(s) => s,
                Err(_) => return Some(rerr("FINANCIALS", None, "missing symbol")),
            };
            match block_ready(src.financials(&sym)) {
                Ok(data) => json!({ "verb": "FINANCIALS.RESULT", "symbol": sym, "data": data }),
                Err(e) => rerr("FINANCIALS", Some(&sym), &e.to_string()),
            }
        }
        Verb::Crypto => {
            let sym = match sym_or(true) {
                Ok(s) => s,
                Err(_) => return Some(rerr("CRYPTO", None, "missing symbol")),
            };
            match block_ready(src.crypto_quote(&sym)) {
                Ok(data) => json!({ "verb": "CRYPTO.RESULT", "symbol": sym, "data": data }),
                Err(e) => rerr("CRYPTO", Some(&sym), &e.to_string()),
            }
        }
        Verb::Risk => match block_ready(src.risk_metrics(&symbols_of(cmd))) {
            Ok(data) => json!({ "verb": "RISK.RESULT", "data": data }),
            Err(e) => rerr("RISK", None, &e.to_string()),
        },
        Verb::Corpact => {
            let sym = match sym_or(true) {
                Ok(s) => s,
                Err(_) => return Some(rerr("CORPACT", None, "missing symbol")),
            };
            match block_ready(src.corp_actions(&sym)) {
                Ok(data) => json!({ "verb": "CORPACT.RESULT", "symbol": sym, "data": data }),
                Err(e) => rerr("CORPACT", Some(&sym), &e.to_string()),
            }
        }
        Verb::Earnings => {
            let window = first_arg(cmd).and_then(|s| s.parse::<u32>().ok());
            match block_ready(src.earnings_calendar(window)) {
                Ok(data) => json!({ "verb": "EARNINGS.RESULT", "data": data }),
                Err(e) => rerr("EARNINGS", None, &e.to_string()),
            }
        }
        Verb::Movers => match block_ready(src.movers(first_arg(cmd).as_deref())) {
            Ok(data) => json!({ "verb": "MOVERS.RESULT", "data": data }),
            Err(e) => rerr("MOVERS", None, &e.to_string()),
        },
        Verb::Screen => match block_ready(src.screener(screen_criteria(cmd).as_deref())) {
            Ok(data) => json!({ "verb": "SCREEN.RESULT", "data": data }),
            Err(e) => rerr("SCREEN", None, &e.to_string()),
        },
        Verb::Members => {
            let sym = match sym_or(false) {
                Ok(s) => s,
                Err(_) => return Some(rerr("MEMBERS", None, "missing index symbol")),
            };
            match block_ready(src.index_members(&sym)) {
                Ok(data) => json!({ "verb": "MEMBERS.RESULT", "symbol": sym, "data": data }),
                Err(e) => rerr("MEMBERS", Some(&sym), &e.to_string()),
            }
        }
        Verb::Ivol => {
            let sym = match sym_or(true) {
                Ok(s) => s,
                Err(_) => return Some(rerr("IVOL", None, "missing symbol")),
            };
            match block_ready(src.vol_surface(&sym)) {
                Ok(data) => json!({ "verb": "IVOL.RESULT", "data": data }),
                Err(e) => rerr("IVOL", Some(&sym), &e.to_string()),
            }
        }
        Verb::Tech => {
            let sym = match sym_or(true) {
                Ok(s) => s,
                Err(_) => return Some(rerr("TECH", None, "missing symbol")),
            };
            let indicator = first_arg(cmd).unwrap_or_else(|| "SMA".into());
            match block_ready(src.technicals(&sym, &indicator)) {
                Ok(data) => json!({ "verb": "TECH.RESULT", "data": data }),
                Err(e) => rerr("TECH", Some(&sym), &e.to_string()),
            }
        }
        Verb::Corr => match block_ready(src.correlation_matrix(&symbols_of(cmd))) {
            Ok(data) => json!({ "verb": "CORR.RESULT", "data": data }),
            Err(e) => rerr("CORR", None, &e.to_string()),
        },
        Verb::Filings => {
            let sym = match sym_or(true) {
                Ok(s) => s,
                Err(_) => return Some(rerr("FILINGS", None, "missing symbol")),
            };
            match block_ready(src.filings(&sym)) {
                Ok(data) => json!({ "verb": "FILINGS.RESULT", "symbol": sym, "data": data }),
                Err(e) => rerr("FILINGS", Some(&sym), &e.to_string()),
            }
        }
        Verb::Sentiment => {
            let sym = match sym_or(true) {
                Ok(s) => s,
                Err(_) => return Some(rerr("SENTIMENT", None, "missing symbol")),
            };
            match block_ready(src.sentiment(&sym)) {
                Ok(data) => json!({ "verb": "SENTIMENT.RESULT", "data": data }),
                Err(e) => rerr("SENTIMENT", Some(&sym), &e.to_string()),
            }
        }

        // Stateful / provider-backed verbs aren't self-serviced in the bare
        // browser shell — the TUI / SvelteKit host owns those.
        Verb::Watch
        | Verb::Unwatch
        | Verb::List
        | Verb::Inbox
        | Verb::Export
        | Verb::Order
        | Verb::Blotter
        | Verb::Ask
        | Verb::Help
        | Verb::Cls
        | Verb::Exit => return None,
    };
    Some(payload)
}

/// `<VERB>.RESULT` error payload (`render_inbound` renders it as one line).
fn rerr(verb: &str, symbol: Option<&str>, msg: &str) -> Value {
    let mut v = json!({ "verb": format!("{verb}.RESULT"), "error": msg });
    if let Some(s) = symbol {
        v["symbol"] = json!(s);
    }
    v
}

/// Wrap a `<VERB>.RESULT` payload in an [`Envelope`] for [`render_inbound`].
/// Addresses are cosmetic here — `render_inbound` dispatches on `payload.verb`.
fn result_envelope(payload: Value) -> Envelope {
    Envelope {
        id: "aperture:local-data".into(),
        message_type: MessageType::Direct,
        from: "aperture:agent.memory".into(),
        to: "aperture:cmdbar".into(),
        payload,
        timestamp: "1970-01-01T00:00:00.000Z".into(),
        priority: Priority::Normal,
        requires_ack: false,
        ttl_ms: 0,
        correlation_id: None,
    }
}

/// Drive a future that completes synchronously to its value, without an
/// executor. `MemoryDataSource`'s `async fn`s contain no `.await` points, so
/// they're `Ready` on the first poll — the loop is for type-completeness only
/// (a wasm32 build can't park a thread, so it would spin if a future ever
/// pended, which `MemoryDataSource` never does).
fn block_ready<F: core::future::Future>(fut: F) -> F::Output {
    use core::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
    fn noop(_: *const ()) {}
    fn clone_waker(_: *const ()) -> RawWaker {
        RawWaker::new(core::ptr::null(), &VTABLE)
    }
    static VTABLE: RawWakerVTable = RawWakerVTable::new(clone_waker, noop, noop, noop);
    let waker = unsafe { Waker::from_raw(RawWaker::new(core::ptr::null(), &VTABLE)) };
    let mut cx = Context::from_waker(&waker);
    let mut fut = Box::pin(fut);
    loop {
        if let Poll::Ready(v) = fut.as_mut().poll(&mut cx) {
            return v;
        }
    }
}

/// One-line sparkline + summary for a candle series (the bare-shell stand-in
/// for the TUI's richer ASCII chart). Returned as the `lines` array the
/// `CHART.RESULT` renderer expects.
fn ascii_chart(candles: &[Candle]) -> Vec<String> {
    if candles.is_empty() {
        return vec!["(no candles)".into()];
    }
    const TICKS: [char; 8] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    let closes: Vec<f64> = candles.iter().map(|c| c.c).collect();
    let lo = closes.iter().cloned().fold(f64::INFINITY, f64::min);
    let hi = closes.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let span = (hi - lo).max(f64::EPSILON);
    let spark: String = closes
        .iter()
        .map(|&c| {
            let idx = (((c - lo) / span) * (TICKS.len() as f64 - 1.0)).round() as usize;
            TICKS[idx.min(TICKS.len() - 1)]
        })
        .collect();
    let last = *closes.last().unwrap();
    vec![
        spark,
        format!(
            "n={}  last={last:.2}  range=[{lo:.2}, {hi:.2}]",
            candles.len()
        ),
    ]
}

fn first_arg(cmd: &Command) -> Option<String> {
    cmd.args.first().map(|a| a.as_str().to_string())
}

/// Symbols for multi-symbol verbs (RISK / CORR): the leading symbol, if any,
/// followed by the args — all upper-cased.
fn symbols_of(cmd: &Command) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(s) = &cmd.symbol {
        out.push(s.to_ascii_uppercase());
    }
    for a in &cmd.args {
        out.push(a.as_str().to_ascii_uppercase());
    }
    out
}

/// SCREEN criteria: a quoted arg if present, else the args joined into a
/// free-form expression, else `None` (the provider supplies its default).
fn screen_criteria(cmd: &Command) -> Option<String> {
    cmd.args
        .iter()
        .find_map(|a| match a {
            Arg::Quoted(s) => Some(s.clone()),
            _ => None,
        })
        .or_else(|| {
            if cmd.args.is_empty() {
                None
            } else {
                Some(
                    cmd.args
                        .iter()
                        .map(|a| a.as_str())
                        .collect::<Vec<_>>()
                        .join(" "),
                )
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell_routing::Pane;
    use aperture_core::parse;

    fn run(line: &str) -> Vec<ViewLine> {
        resolve_local(&parse(line).expect("parse"), None)
    }

    #[test]
    fn desc_renders_a_quote_line_in_the_quote_pane() {
        let v = run("AAPL DESC GO");
        assert!(!v.is_empty());
        assert_eq!(v[0].pane, Pane::Quote);
        assert!(v[0].text.starts_with("AAPL"));
    }

    #[test]
    fn macro_yields_fx_render_their_panes() {
        assert_eq!(run("MACRO GO")[0].pane, Pane::Macro);
        assert!(run("MACRO GO").len() > 1, "macro should list indicators");
        assert_eq!(run("YIELDS GO")[0].pane, Pane::Yields);
        assert_eq!(run("FX EUR GO")[0].pane, Pane::Fx);
    }

    #[test]
    fn options_renders_a_chain_in_the_options_pane() {
        let v = run("AAPL OPTIONS GO");
        assert_eq!(v[0].pane, Pane::Options);
        assert!(v.iter().any(|l| l.text.starts_with("K=")), "{v:?}");
    }

    #[test]
    fn movers_screen_members_render_wave3_panes() {
        assert_eq!(run("MOVERS losers GO")[0].pane, Pane::Movers);
        assert_eq!(run("SCREEN GO")[0].pane, Pane::Screen);
        assert_eq!(run("SPX MEMBERS GO")[0].pane, Pane::Members);
    }

    #[test]
    fn export_and_inbox_are_not_self_serviced() {
        assert!(run("EXPORT csv GO").is_empty());
        assert!(run("INBOX GO").is_empty());
        assert!(run("HELP GO").is_empty());
    }

    #[test]
    fn chart_renders_a_sparkline() {
        let v = run("AAPL CHART 6M GO");
        assert_eq!(v[0].pane, Pane::Chart);
        assert!(v.iter().any(|l| l.text.contains("last=")), "{v:?}");
    }
}
