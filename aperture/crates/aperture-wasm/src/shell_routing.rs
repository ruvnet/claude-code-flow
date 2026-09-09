//! Pure routing logic for the browser shell. Target-agnostic so the unit
//! tests run under plain `cargo test -p aperture-wasm` without needing the
//! wasm32 target. The wasm-only `shell` module wires these into `App`.
//!
//! The routing here mirrors the pane-as-agent contract from
//! `crates/aperture-tui/src/agent_runner/panes/`: each verb becomes an
//! `Envelope` aimed at `aperture:agent.<id>` (data-backed verbs) or
//! `aperture:pane.<id>` (pane-owned state like INBOX / EXPORT). Inbound
//! `<VERB>.RESULT` rendering lives in `shell_renderers` to keep both files
//! under the 500-line cap.

use aperture_core::{Arg, Command, Verb};
use aperture_swarm::envelope::{Envelope, MessageType, Priority};
use serde::Serialize;
use serde_json::{json, Value};

pub use crate::shell_renderers::render_inbound;

/// Logical pane the host can render to. The string form (lowercase via
/// `serde(rename_all = "lowercase")`) is the contract with the SvelteKit
/// host — keep these names aligned with the page's pane registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Pane {
    Quote,
    Chart,
    Watch,
    Oracle,
    News,
    Macro,
    Yields,
    Fx,
    Options,
    Insider,
    Financials,
    Crypto,
    Risk,
    Corpact,
    Inbox,
    Export,
    Earnings,
    Movers,
    Screen,
    Members,
    Ivol,
    Tech,
    Corr,
    Filings,
    Order,
    Sentiment,
    /// Catch-all for log lines / parse errors that don't belong to a pane.
    System,
}

/// One line of rendered output for a pane. The host decides how to display it.
#[derive(Debug, Clone, Serialize)]
pub struct ViewLine {
    pub pane: Pane,
    pub text: String,
}

/// Build the outbound envelope for a parsed command. Returns `None` for
/// purely-local verbs (HELP / CLS / EXIT / LIST). `seq` is the monotonic
/// counter the caller maintains; `last_symbol` is the last FOCUSed symbol
/// (used by ASK so the oracle has context when the prompt is bare).
pub fn envelope_for(cmd: &Command, seq: u64, last_symbol: Option<&str>) -> Option<Envelope> {
    let (msg_type, to, payload) = build_route(cmd, last_symbol)?;
    Some(Envelope {
        id: format!("aperture-{:08x}", seq),
        message_type: msg_type,
        from: "aperture:cmdbar".into(),
        to,
        payload,
        timestamp: now_iso(),
        priority: Priority::Normal,
        requires_ack: false,
        ttl_ms: 5000,
        correlation_id: None,
    })
}

/// Decide the destination + payload for a parsed command. Split out from
/// [`envelope_for`] so tests can assert payload shape without touching the
/// envelope wrapper.
pub fn build_route(
    cmd: &Command,
    last_symbol: Option<&str>,
) -> Option<(MessageType, String, Value)> {
    match cmd.verb {
        // Local-only verbs.
        Verb::Help | Verb::Cls | Verb::Exit | Verb::List => None,

        Verb::Desc | Verb::Watch | Verb::Unwatch => {
            let symbol = cmd.symbol.clone()?;
            let to = match cmd.verb {
                Verb::Desc => "aperture:pane.quote",
                Verb::Watch | Verb::Unwatch => "aperture:pane.watchlist",
                _ => unreachable!(),
            };
            Some((
                MessageType::Direct,
                to.into(),
                json!({
                    "verb": verb_str(&cmd.verb),
                    "symbol": symbol,
                    "args": args_to_json(&cmd.args),
                }),
            ))
        }
        Verb::Chart => {
            let symbol = cmd.symbol.clone()?;
            Some((
                MessageType::Direct,
                "aperture:pane.chart".into(),
                json!({
                    "verb": "CHART",
                    "symbol": symbol,
                    "range": first_arg(&cmd.args).unwrap_or_else(|| "1M".into()),
                }),
            ))
        }
        Verb::Crypto => {
            let symbol = cmd.symbol.clone()?;
            Some((
                MessageType::Direct,
                "aperture:pane.crypto".into(),
                json!({"verb": "CRYPTO", "symbol": symbol}),
            ))
        }
        Verb::Ask => {
            let prompt = cmd
                .args
                .iter()
                .find_map(|a| match a {
                    Arg::Quoted(s) => Some(s.clone()),
                    _ => None,
                })
                .unwrap_or_default();
            let symbol = cmd
                .symbol
                .clone()
                .or_else(|| last_symbol.map(|s| s.to_string()));
            Some((
                MessageType::Direct,
                "aperture:pane.oracle".into(),
                json!({"verb": "ASK", "prompt": prompt, "symbol": symbol}),
            ))
        }

        // Wave-1 panes: news/macro/yields/fx/options/insider/financials/risk/
        // corpact/inbox/export. Every one speaks to its `pane.<id>` address.
        // RISK accepts an optional symbols list — the host attaches the
        // watchlist before forwarding.
        Verb::News => {
            let mut p = json!({"verb": "NEWS"});
            if let Some(s) = cmd.symbol.clone() {
                p["symbol"] = json!(s);
            }
            Some((MessageType::Direct, "aperture:pane.news".into(), p))
        }
        Verb::Macro => Some((
            MessageType::Direct,
            "aperture:pane.macro".into(),
            json!({"verb": "MACRO"}),
        )),
        Verb::Yields => Some((
            MessageType::Direct,
            "aperture:pane.yields".into(),
            json!({"verb": "YIELDS"}),
        )),
        Verb::Fx => {
            let mut p = json!({"verb": "FX"});
            if let Some(base) = first_arg(&cmd.args) {
                p["base"] = json!(base);
            }
            Some((MessageType::Direct, "aperture:pane.fx".into(), p))
        }
        Verb::Options => {
            let symbol = cmd.symbol.clone()?;
            Some((
                MessageType::Direct,
                "aperture:pane.options".into(),
                json!({"verb": "OPTIONS", "symbol": symbol}),
            ))
        }
        Verb::Insider => {
            let symbol = cmd.symbol.clone()?;
            Some((
                MessageType::Direct,
                "aperture:pane.insider".into(),
                json!({"verb": "INSIDER", "symbol": symbol}),
            ))
        }
        Verb::Financials => {
            let symbol = cmd.symbol.clone()?;
            Some((
                MessageType::Direct,
                "aperture:pane.financials".into(),
                json!({"verb": "FINANCIALS", "symbol": symbol}),
            ))
        }
        Verb::Risk => {
            let symbols: Vec<String> = cmd
                .args
                .iter()
                .map(|a| a.as_str().to_ascii_uppercase())
                .collect();
            Some((
                MessageType::Direct,
                "aperture:pane.risk".into(),
                json!({"verb": "RISK", "symbols": symbols}),
            ))
        }
        Verb::Corpact => {
            let symbol = cmd.symbol.clone()?;
            Some((
                MessageType::Direct,
                "aperture:pane.corpact".into(),
                json!({"verb": "CORPACT", "symbol": symbol}),
            ))
        }
        Verb::Inbox => {
            // Bare INBOX lists; INBOX "<msg>" posts. The first quoted arg is
            // the body when present.
            let body = cmd.args.iter().find_map(|a| match a {
                Arg::Quoted(s) => Some(s.clone()),
                _ => None,
            });
            let payload = match body {
                Some(b) => json!({"verb": "INBOX.POST", "body": b}),
                None => json!({"verb": "INBOX"}),
            };
            Some((MessageType::Direct, "aperture:pane.inbox".into(), payload))
        }
        Verb::Export => {
            let format = first_arg(&cmd.args).unwrap_or_else(|| "json".into());
            // v0.1: the host attaches the snapshot before forwarding. We ship
            // an empty snapshot here so the pane reply still succeeds even
            // when the host forgets to enrich.
            Some((
                MessageType::Direct,
                "aperture:pane.export".into(),
                json!({
                    "verb": "EXPORT",
                    "format": format,
                    "snapshot": Value::Object(serde_json::Map::new()),
                }),
            ))
        }

        // Wave-3 panes: earnings/movers/screen/members/ivol/tech/corr/filings/
        // order/sentiment. All speak to their `pane.<id>` address.
        Verb::Earnings => {
            let mut p = json!({"verb": "EARNINGS"});
            if let Some(w) = first_arg(&cmd.args).and_then(|s| s.parse::<u32>().ok()) {
                p["window_days"] = json!(w);
            }
            Some((MessageType::Direct, "aperture:pane.earnings".into(), p))
        }
        Verb::Movers => {
            let mut p = json!({"verb": "MOVERS"});
            if let Some(scope) = first_arg(&cmd.args) {
                p["scope"] = json!(scope);
            }
            Some((MessageType::Direct, "aperture:pane.movers".into(), p))
        }
        Verb::Screen => {
            let mut p = json!({"verb": "SCREEN"});
            // The criteria is a quoted string when present; otherwise the args
            // are joined into a free-form expression.
            let criteria = cmd
                .args
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
                });
            if let Some(c) = criteria {
                p["criteria"] = json!(c);
            }
            Some((MessageType::Direct, "aperture:pane.screen".into(), p))
        }
        Verb::Members => {
            let symbol = cmd.symbol.clone()?;
            Some((
                MessageType::Direct,
                "aperture:pane.members".into(),
                json!({"verb": "MEMBERS", "symbol": symbol}),
            ))
        }
        Verb::Ivol => {
            let symbol = cmd.symbol.clone()?;
            Some((
                MessageType::Direct,
                "aperture:pane.ivol".into(),
                json!({"verb": "IVOL", "symbol": symbol}),
            ))
        }
        Verb::Tech => {
            let symbol = cmd.symbol.clone()?;
            let indicator = first_arg(&cmd.args).unwrap_or_else(|| "SMA".into());
            Some((
                MessageType::Direct,
                "aperture:pane.tech".into(),
                json!({"verb": "TECH", "symbol": symbol, "indicator": indicator}),
            ))
        }
        Verb::Corr => {
            let symbols: Vec<String> = cmd
                .args
                .iter()
                .map(|a| a.as_str().to_ascii_uppercase())
                .collect();
            Some((
                MessageType::Direct,
                "aperture:pane.corr".into(),
                json!({"verb": "CORR", "symbols": symbols}),
            ))
        }
        Verb::Filings => {
            let symbol = cmd.symbol.clone()?;
            Some((
                MessageType::Direct,
                "aperture:pane.filings".into(),
                json!({"verb": "FILINGS", "symbol": symbol}),
            ))
        }
        Verb::Order => {
            // Free-form ORDER from the cmdbar: forward args verbatim. The
            // SvelteKit host is expected to enrich with side / qty / type via
            // a richer UI.
            let mut p = json!({"verb": "ORDER", "args": args_to_json(&cmd.args)});
            if let Some(s) = cmd.symbol.clone() {
                p["symbol"] = json!(s);
            }
            Some((MessageType::Direct, "aperture:pane.order".into(), p))
        }
        Verb::Blotter => Some((
            MessageType::Direct,
            "aperture:pane.order".into(),
            json!({"verb": "BLOTTER"}),
        )),
        Verb::Sentiment => {
            let symbol = cmd.symbol.clone()?;
            Some((
                MessageType::Direct,
                "aperture:pane.sentiment".into(),
                json!({"verb": "SENTIMENT", "symbol": symbol}),
            ))
        }
    }
}

/// Local renderer for verbs that don't need to leave the WASM module.
pub fn local_render(cmd: &Command) -> Option<Vec<ViewLine>> {
    match cmd.verb {
        Verb::Help => Some(vec![
            line(
                Pane::System,
                "verbs: HELP CLS EXIT LIST DESC CHART WATCH UNWATCH ASK CRYPTO NEWS MACRO YIELDS FX OPTIONS INSIDER FINANCIALS RISK CORPACT INBOX EXPORT",
            ),
            line(
                Pane::System,
                "form: SYMBOL VERB [ARGS] GO   (e.g. AAPL CHART 6M GO)",
            ),
        ]),
        Verb::Cls => Some(vec![line(Pane::System, "[clear]")]),
        Verb::List => Some(vec![line(
            Pane::Watch,
            "(use AAPL WATCH GO to add a symbol)",
        )]),
        Verb::Exit => Some(vec![line(Pane::System, "(exit ignored in browser)")]),
        _ => None,
    }
}

fn line(pane: Pane, text: &str) -> ViewLine {
    ViewLine {
        pane,
        text: text.into(),
    }
}

/// Current time as an ISO-8601 string with millisecond precision. On wasm32
/// this calls `js_sys::Date::new_0().to_iso_string()`; on native we delegate
/// to `aperture_swarm::now_iso` so the routing tests stay deterministic and
/// dep-free (no `chrono`/`time`).
#[cfg(target_arch = "wasm32")]
fn now_iso() -> String {
    js_sys::Date::new_0()
        .to_iso_string()
        .as_string()
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string())
}

#[cfg(not(target_arch = "wasm32"))]
fn now_iso() -> String {
    aperture_swarm::now_iso()
}

fn first_arg(args: &[Arg]) -> Option<String> {
    args.first().map(|a| a.as_str().to_string())
}

fn args_to_json(args: &[Arg]) -> Value {
    Value::Array(args.iter().map(|a| json!(a.as_str())).collect())
}

pub fn verb_str(v: &Verb) -> &'static str {
    match v {
        Verb::Help => "HELP",
        Verb::Cls => "CLS",
        Verb::Exit => "EXIT",
        Verb::List => "LIST",
        Verb::Desc => "DESC",
        Verb::Chart => "CHART",
        Verb::Watch => "WATCH",
        Verb::Unwatch => "UNWATCH",
        Verb::Ask => "ASK",
        Verb::Crypto => "CRYPTO",
        Verb::News => "NEWS",
        Verb::Macro => "MACRO",
        Verb::Yields => "YIELDS",
        Verb::Fx => "FX",
        Verb::Options => "OPTIONS",
        Verb::Insider => "INSIDER",
        Verb::Financials => "FINANCIALS",
        Verb::Risk => "RISK",
        Verb::Corpact => "CORPACT",
        Verb::Inbox => "INBOX",
        Verb::Export => "EXPORT",
        Verb::Earnings => "EARNINGS",
        Verb::Movers => "MOVERS",
        Verb::Screen => "SCREEN",
        Verb::Members => "MEMBERS",
        Verb::Ivol => "IVOL",
        Verb::Tech => "TECH",
        Verb::Corr => "CORR",
        Verb::Filings => "FILINGS",
        Verb::Order => "ORDER",
        Verb::Blotter => "BLOTTER",
        Verb::Sentiment => "SENTIMENT",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aperture_core::parse;

    fn route(line: &str) -> (MessageType, String, Value) {
        let cmd = parse(line).expect("parse");
        build_route(&cmd, None).expect("route")
    }

    #[test]
    fn news_routes_to_news_pane_with_optional_symbol() {
        let (_t, to, p) = route("AAPL NEWS");
        assert_eq!(to, "aperture:pane.news");
        assert_eq!(p["verb"], "NEWS");
        assert_eq!(p["symbol"], "AAPL");

        let (_t, to, p) = route("NEWS");
        assert_eq!(to, "aperture:pane.news");
        assert_eq!(p["verb"], "NEWS");
        assert!(p.get("symbol").is_none());
    }

    #[test]
    fn macro_yields_fx_route_to_panes() {
        let (_t, to, p) = route("MACRO");
        assert_eq!(to, "aperture:pane.macro");
        assert_eq!(p["verb"], "MACRO");

        let (_t, to, p) = route("YIELDS");
        assert_eq!(to, "aperture:pane.yields");
        assert_eq!(p["verb"], "YIELDS");

        let (_t, to, p) = route("FX EUR");
        assert_eq!(to, "aperture:pane.fx");
        assert_eq!(p["verb"], "FX");
        assert_eq!(p["base"], "EUR");
    }

    #[test]
    fn options_requires_symbol_and_routes_to_options_pane() {
        let (_t, to, p) = route("AAPL OPTIONS");
        assert_eq!(to, "aperture:pane.options");
        assert_eq!(p["symbol"], "AAPL");
    }

    #[test]
    fn risk_routes_with_symbols_array() {
        let (_t, to, p) = route("RISK AAPL TSLA");
        assert_eq!(to, "aperture:pane.risk");
        let symbols = p["symbols"].as_array().unwrap();
        assert_eq!(symbols.len(), 2);
        assert_eq!(symbols[0], "AAPL");
        assert_eq!(symbols[1], "TSLA");
    }

    #[test]
    fn export_carries_format_and_default_snapshot() {
        let (_t, to, p) = route("EXPORT csv");
        assert_eq!(to, "aperture:pane.export");
        assert_eq!(p["format"], "csv");
        assert!(p["snapshot"].is_object());
    }

    #[test]
    fn inbox_post_when_quoted_arg_present() {
        let (_t, to, p) = route("INBOX \"hello world\"");
        assert_eq!(to, "aperture:pane.inbox");
        assert_eq!(p["verb"], "INBOX.POST");
        assert_eq!(p["body"], "hello world");

        let (_t, _to, p) = route("INBOX");
        assert_eq!(p["verb"], "INBOX");
    }

    #[test]
    fn crypto_routes_to_crypto_pane() {
        let (_t, to, p) = route("BTC CRYPTO");
        assert_eq!(to, "aperture:pane.crypto");
        assert_eq!(p["symbol"], "BTC");
    }

    #[test]
    fn financials_routes_to_financials_pane() {
        let (_t, to, p) = route("AAPL FINANCIALS");
        assert_eq!(to, "aperture:pane.financials");
        assert_eq!(p["symbol"], "AAPL");
    }

    #[test]
    fn insider_routes_to_insider_pane() {
        let (_t, to, p) = route("AAPL INSIDER");
        assert_eq!(to, "aperture:pane.insider");
        assert_eq!(p["symbol"], "AAPL");
    }

    #[test]
    fn corpact_routes_to_corpact_pane() {
        let (_t, to, p) = route("AAPL CORPACT");
        assert_eq!(to, "aperture:pane.corpact");
        assert_eq!(p["symbol"], "AAPL");
    }

    #[test]
    fn local_verbs_have_no_route() {
        for line in ["HELP", "CLS", "EXIT", "LIST"] {
            let cmd = parse(line).unwrap();
            assert!(build_route(&cmd, None).is_none(), "{line} should be local");
        }
    }

    #[test]
    fn envelope_for_wraps_route_with_seq_id() {
        let cmd = parse("MACRO").unwrap();
        let env = envelope_for(&cmd, 42, None).unwrap();
        assert_eq!(env.id, "aperture-0000002a");
        assert_eq!(env.from, "aperture:cmdbar");
        assert_eq!(env.to, "aperture:pane.macro");
        assert_eq!(env.payload["verb"], "MACRO");
    }

    #[test]
    fn pane_serializes_lowercase() {
        // SvelteKit host reads `pane: "macro"` etc. — pin the contract.
        let s = serde_json::to_string(&Pane::Macro).unwrap();
        assert_eq!(s, "\"macro\"");
        let s = serde_json::to_string(&Pane::Corpact).unwrap();
        assert_eq!(s, "\"corpact\"");
    }
}
