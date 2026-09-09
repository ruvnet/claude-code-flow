//! Wave-3 pane renderers (11 verbs): earnings, movers, screen, members, ivol,
//! tech, corr, filings, order, blotter, sentiment.
//!
//! Formatting conventions for future wave additions:
//! - Header line first (verb + scope/symbol/criteria), then one row per item.
//! - Floats: percentages `:+.2%`/`%`, prices `:.2`, weights `:.2`, IV `:.4`,
//!   tech indicators `:.4`, correlation cells `:>6.3`.
//! - Cap rows at 20 (sentiment/order are single-line; ivol cap at 8 for the
//!   surface preview; members cap at 30 for index rosters).
//! - Read from `/data/<key>` first, then fall back to top-level keys so the
//!   pane stays renderable even if the agent inlines fields.

use serde_json::Value;

use super::{line, value_to_compact_string};
use crate::shell_routing::{Pane, ViewLine};

pub(super) fn render_earnings(p: &Value) -> Vec<ViewLine> {
    let mut out = vec![line(Pane::Earnings, "EARNINGS".to_string())];
    let events = p
        .pointer("/data/events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for e in events.iter().take(20) {
        let sym = e.get("symbol").and_then(Value::as_str).unwrap_or("?");
        let date = e.get("date").and_then(Value::as_str).unwrap_or("?");
        let eps = e
            .get("estimate_eps")
            .and_then(Value::as_f64)
            .map(|v| format!("{v:.2}"))
            .unwrap_or_else(|| "?".into());
        out.push(line(
            Pane::Earnings,
            format!("{sym}  {date}  est-eps {eps}"),
        ));
    }
    out
}

pub(super) fn render_movers(p: &Value) -> Vec<ViewLine> {
    let scope = p
        .pointer("/data/scope")
        .and_then(Value::as_str)
        .unwrap_or("gainers");
    let mut out = vec![line(Pane::Movers, format!("MOVERS {scope}"))];
    let rows = p
        .pointer("/data/rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let is_active = scope.eq_ignore_ascii_case("active");
    for r in rows.iter().take(20) {
        let sym = r.get("symbol").and_then(Value::as_str).unwrap_or("?");
        let last = r.get("last").and_then(Value::as_f64).unwrap_or(0.0);
        if is_active {
            let vol = r.get("volume").and_then(Value::as_f64).unwrap_or(0.0);
            out.push(line(
                Pane::Movers,
                format!("{sym}  vol {vol:.0}  {last:.2}"),
            ));
        } else {
            let chg = r.get("change_pct").and_then(Value::as_f64).unwrap_or(0.0);
            out.push(line(Pane::Movers, format!("{sym}  {chg:+.2}%  {last:.2}")));
        }
    }
    out
}

pub(super) fn render_screen(p: &Value) -> Vec<ViewLine> {
    let criteria = p
        .pointer("/data/criteria")
        .and_then(Value::as_str)
        .unwrap_or("(no criteria)");
    let mut out = vec![line(Pane::Screen, format!("SCREEN {criteria}"))];
    let matches = p
        .pointer("/data/matches")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for m in matches.iter().take(20) {
        let sym = m.get("symbol").and_then(Value::as_str).unwrap_or("?");
        let cap = m.get("market_cap").and_then(Value::as_f64).unwrap_or(0.0);
        let yld = m.get("div_yield").and_then(Value::as_f64).unwrap_or(0.0);
        let pe = m.get("pe").and_then(Value::as_f64).unwrap_or(0.0);
        out.push(line(
            Pane::Screen,
            format!(
                "{sym}  cap {cap:.0}  yld {pct:.2}%  pe {pe:.2}",
                pct = yld * 100.0
            ),
        ));
    }
    out
}

pub(super) fn render_members(p: &Value) -> Vec<ViewLine> {
    let index = p
        .pointer("/data/index")
        .and_then(Value::as_str)
        .or_else(|| p.get("symbol").and_then(Value::as_str))
        .unwrap_or("?");
    let mut out = vec![line(Pane::Members, format!("MEMBERS {index}"))];
    let members = p
        .pointer("/data/members")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for m in members.iter().take(30) {
        let sym = m.get("symbol").and_then(Value::as_str).unwrap_or("?");
        let w = m.get("weight_pct").and_then(Value::as_f64).unwrap_or(0.0);
        let last = m.get("last").and_then(Value::as_f64).unwrap_or(0.0);
        out.push(line(
            Pane::Members,
            format!("{sym}  {w:.2}%  last {last:.2}"),
        ));
    }
    out
}

pub(super) fn render_ivol(p: &Value) -> Vec<ViewLine> {
    let sym = p
        .pointer("/data/symbol")
        .and_then(Value::as_str)
        .or_else(|| p.get("symbol").and_then(Value::as_str))
        .unwrap_or("?");
    let last = p
        .pointer("/data/underlying_last")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let mut out = vec![line(Pane::Ivol, format!("{sym} @ {last:.2}"))];
    let rows = p
        .pointer("/data/rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for r in rows.iter().take(8) {
        let exp = r.get("expiry").and_then(Value::as_str).unwrap_or("?");
        let strike = r.get("strike").and_then(Value::as_f64).unwrap_or(0.0);
        let iv = r.get("iv").and_then(Value::as_f64).unwrap_or(0.0);
        out.push(line(
            Pane::Ivol,
            format!("{exp}  K={strike:.2}  IV={iv:.4}"),
        ));
    }
    out
}

pub(super) fn render_tech(p: &Value) -> Vec<ViewLine> {
    let sym = p
        .pointer("/data/symbol")
        .and_then(Value::as_str)
        .or_else(|| p.get("symbol").and_then(Value::as_str))
        .unwrap_or("?");
    let indicator = p
        .pointer("/data/indicator")
        .and_then(Value::as_str)
        .or_else(|| p.get("indicator").and_then(Value::as_str))
        .unwrap_or("?");
    let value = p
        .pointer("/data/value")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    vec![line(Pane::Tech, format!("{sym}  {indicator} = {value:.4}"))]
}

pub(super) fn render_corr(p: &Value) -> Vec<ViewLine> {
    let symbols: Vec<String> = p
        .pointer("/data/symbols")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let mut out = vec![line(Pane::Corr, format!("corr [{}]", symbols.join(" ")))];
    let matrix = p
        .pointer("/data/matrix")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for entry in matrix.iter().take(20) {
        let sym = entry.get("symbol").and_then(Value::as_str).unwrap_or("?");
        let row = entry
            .get("row")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let cells: Vec<String> = row
            .iter()
            .map(|v| format!("{:>6.3}", v.as_f64().unwrap_or(0.0)))
            .collect();
        out.push(line(Pane::Corr, format!("{sym:<6} {}", cells.join(" "))));
    }
    out
}

pub(super) fn render_filings(p: &Value) -> Vec<ViewLine> {
    let sym = p
        .pointer("/data/symbol")
        .and_then(Value::as_str)
        .or_else(|| p.get("symbol").and_then(Value::as_str))
        .unwrap_or("?");
    let mut out = vec![line(Pane::Filings, format!("FILINGS {sym}"))];
    let filings = p
        .pointer("/data/filings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for f in filings.iter().take(20) {
        let form = f.get("form").and_then(Value::as_str).unwrap_or("?");
        let filed = f.get("filed_at").and_then(Value::as_str).unwrap_or("?");
        let detail = f
            .get("subject")
            .and_then(Value::as_str)
            .or_else(|| f.get("fiscal_period").and_then(Value::as_str))
            .unwrap_or("");
        out.push(line(Pane::Filings, format!("{form}  {filed}  {detail}")));
    }
    out
}

pub(super) fn render_order(p: &Value) -> Vec<ViewLine> {
    if let Some(err) = p.get("error").and_then(Value::as_str) {
        return vec![line(Pane::Order, format!("ORDER error: {err}"))];
    }
    let order = match p.get("order") {
        Some(o) => o,
        None => return vec![line(Pane::Order, "ORDER (empty)".into())],
    };
    vec![line(Pane::Order, format_order(order))]
}

pub(super) fn render_blotter(p: &Value) -> Vec<ViewLine> {
    let orders = p
        .get("orders")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out = vec![line(Pane::Order, format!("Blotter (n={})", orders.len()))];
    if orders.is_empty() {
        out.push(line(Pane::Order, "(empty)".into()));
        return out;
    }
    for o in orders.iter().take(50) {
        out.push(line(Pane::Order, format_order(o)));
    }
    out
}

fn format_order(o: &Value) -> String {
    let id = o
        .get("id")
        .map(value_to_compact_string)
        .unwrap_or_else(|| "?".into());
    let side = o.get("side").and_then(Value::as_str).unwrap_or("?");
    let sym = o.get("symbol").and_then(Value::as_str).unwrap_or("?");
    let qty = o.get("qty").and_then(Value::as_i64).unwrap_or(0);
    let kind = o.get("type").and_then(Value::as_str).unwrap_or("MKT");
    let limit = o
        .get("limit_price")
        .and_then(Value::as_f64)
        .map(|v| format!(" {v:.2}"))
        .unwrap_or_default();
    let status = o.get("status").and_then(Value::as_str).unwrap_or("?");
    format!("{id}  {side}  {sym}  qty {qty}  {kind}{limit}  status={status}")
}

pub(super) fn render_sentiment(p: &Value) -> Vec<ViewLine> {
    let sym = p
        .pointer("/data/symbol")
        .and_then(Value::as_str)
        .or_else(|| p.get("symbol").and_then(Value::as_str))
        .unwrap_or("?");
    let label = p
        .pointer("/data/label")
        .and_then(Value::as_str)
        .unwrap_or("?");
    let score = p
        .pointer("/data/score")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let sources = p
        .pointer("/data/sources")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let social = mention_count(&sources, "social-stub");
    let news = mention_count(&sources, "news-stub");
    vec![line(
        Pane::Sentiment,
        format!("{sym}  {label}  score {score:.3}  mentions24h {social}+{news}"),
    )]
}

fn mention_count(sources: &[Value], name: &str) -> i64 {
    sources
        .iter()
        .find(|s| s.get("name").and_then(Value::as_str) == Some(name))
        .and_then(|s| s.get("mentions_24h").and_then(Value::as_i64))
        .unwrap_or(0)
}
