//! Wave-1 pane renderers (16 verbs): quote, chart, watch, ask, news, macro,
//! yields, fx, options, insider, financials, crypto, risk, corpact, inbox,
//! export.

use serde_json::Value;

use super::{line, value_to_compact_string};
use crate::shell_routing::{Pane, ViewLine};

pub(super) fn render_quote(p: &Value) -> Vec<ViewLine> {
    let sym = p.get("symbol").and_then(Value::as_str).unwrap_or("?");
    let last = p.get("last").and_then(Value::as_f64).unwrap_or(0.0);
    // Quote pane emits camelCase `changePct`; fall back to snake_case for
    // forward-compat with future providers that follow the trait convention.
    let chg = p
        .get("changePct")
        .or_else(|| p.get("change_pct"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    vec![line(Pane::Quote, format!("{sym}  {last:.2}  {chg:+.2}%"))]
}

pub(super) fn render_chart(p: &Value) -> Vec<ViewLine> {
    let sym = p.get("symbol").and_then(Value::as_str).unwrap_or("?");
    let mut out = vec![line(Pane::Chart, format!("CHART {sym}"))];
    // Chart pane emits `lines` (already-formatted ASCII rows). `ascii` was
    // the original field name from a discarded design.
    if let Some(rows) = p
        .get("lines")
        .or_else(|| p.get("ascii"))
        .and_then(Value::as_array)
    {
        for r in rows {
            if let Some(s) = r.as_str() {
                out.push(line(Pane::Chart, s.to_string()));
            }
        }
    }
    out
}

pub(super) fn render_watch(p: &Value, verb: &str) -> Vec<ViewLine> {
    // Watchlist pane emits `items`; `symbols` retained as a fallback for
    // any host that already encodes it that way.
    let items = p
        .get("items")
        .or_else(|| p.get("symbols"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if items.is_empty() {
        return vec![line(Pane::Watch, format!("{verb}  (empty)"))];
    }
    let names: Vec<String> = items
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    vec![line(Pane::Watch, names.join(" "))]
}

pub(super) fn render_ask(p: &Value) -> Vec<ViewLine> {
    let answer = p
        .get("answer")
        .and_then(Value::as_str)
        .unwrap_or("(no answer)");
    vec![line(Pane::Oracle, answer.to_string())]
}

pub(super) fn render_news(p: &Value) -> Vec<ViewLine> {
    let scope = p.get("scope").and_then(Value::as_str).unwrap_or("GLOBAL");
    let mut out = vec![line(Pane::News, format!("NEWS {scope}"))];
    let headlines = p
        .pointer("/data/headlines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for h in headlines.iter().take(10) {
        let title = h
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("(untitled)");
        out.push(line(Pane::News, format!("• {title}")));
    }
    out
}

pub(super) fn render_macro(p: &Value) -> Vec<ViewLine> {
    let mut out = vec![line(Pane::Macro, "MACRO".to_string())];
    let rows = p
        .get("rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for r in rows.iter().take(20) {
        let name = r.get("name").and_then(Value::as_str).unwrap_or("?");
        let value = r
            .get("value")
            .map(value_to_compact_string)
            .unwrap_or_default();
        out.push(line(Pane::Macro, format!("{name} = {value}")));
    }
    out
}

pub(super) fn render_yields(p: &Value) -> Vec<ViewLine> {
    let mut out = vec![line(Pane::Yields, "YIELDS".to_string())];
    let curve = p
        .get("curve")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for r in curve.iter().take(20) {
        let tenor = r.get("tenor").and_then(Value::as_str).unwrap_or("?");
        let yld = r.get("yield_pct").and_then(Value::as_f64).unwrap_or(0.0);
        out.push(line(Pane::Yields, format!("{tenor} = {yld:.2}%")));
    }
    out
}

pub(super) fn render_fx(p: &Value) -> Vec<ViewLine> {
    let base = p
        .pointer("/data/base")
        .and_then(Value::as_str)
        .unwrap_or("USD");
    let mut out = vec![line(Pane::Fx, format!("FX base={base}"))];
    let rates = p
        .pointer("/data/rates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for r in rates.iter().take(20) {
        let pair = r.get("pair").and_then(Value::as_str).unwrap_or("?");
        let rate = r.get("rate").and_then(Value::as_f64).unwrap_or(0.0);
        let chg = r.get("change_pct").and_then(Value::as_f64).unwrap_or(0.0);
        out.push(line(Pane::Fx, format!("{pair} = {rate:.4} ({chg:+.2}%)")));
    }
    out
}

pub(super) fn render_options(p: &Value) -> Vec<ViewLine> {
    let sym = p.get("symbol").and_then(Value::as_str).unwrap_or("?");
    let mut out = vec![line(Pane::Options, format!("OPTIONS {sym}"))];
    let rows = p
        .pointer("/chain/rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for r in rows.iter().take(10) {
        let strike = r.get("strike").and_then(Value::as_f64).unwrap_or(0.0);
        // MemoryDataSource returns `{call_iv, put_iv, call_oi, put_oi}`; old code read
        // `iv`/`oi`/`type` which never matched.
        let call_iv = r.get("call_iv").and_then(Value::as_f64).unwrap_or(0.0);
        let put_iv = r.get("put_iv").and_then(Value::as_f64).unwrap_or(0.0);
        let call_oi = r.get("call_oi").and_then(Value::as_i64).unwrap_or(0);
        let put_oi = r.get("put_oi").and_then(Value::as_i64).unwrap_or(0);
        out.push(line(
            Pane::Options,
            format!("K={strike:.2}  C iv={call_iv:.2}/oi={call_oi}  P iv={put_iv:.2}/oi={put_oi}"),
        ));
    }
    out
}

pub(super) fn render_insider(p: &Value) -> Vec<ViewLine> {
    let sym = p.get("symbol").and_then(Value::as_str).unwrap_or("?");
    let mut out = vec![line(Pane::Insider, format!("INSIDER {sym}"))];
    let trades = p
        .pointer("/data/trades")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for t in trades.iter().take(10) {
        let name = t.get("name").and_then(Value::as_str).unwrap_or("?");
        let role = t.get("role").and_then(Value::as_str).unwrap_or("?");
        let shares = t.get("shares").and_then(Value::as_i64).unwrap_or(0);
        out.push(line(
            Pane::Insider,
            format!("{name} ({role})  shares={shares}"),
        ));
    }
    out
}

pub(super) fn render_financials(p: &Value) -> Vec<ViewLine> {
    let sym = p.get("symbol").and_then(Value::as_str).unwrap_or("?");
    let mut out = vec![line(Pane::Financials, format!("FINANCIALS {sym}"))];
    if let Some(rev) = p
        .pointer("/data/income_ttm/revenue")
        .and_then(Value::as_f64)
    {
        out.push(line(Pane::Financials, format!("revenue (ttm)  {rev:.0}")));
    }
    if let Some(ni) = p
        .pointer("/data/income_ttm/net_income")
        .and_then(Value::as_f64)
    {
        out.push(line(Pane::Financials, format!("net income (ttm)  {ni:.0}")));
    }
    if let Some(a) = p
        .pointer("/data/balance_mrq/total_assets")
        .and_then(Value::as_f64)
    {
        out.push(line(
            Pane::Financials,
            format!("total assets (mrq)  {a:.0}"),
        ));
    }
    if let Some(fcf) = p
        .pointer("/data/cashflow_ttm/free_cashflow")
        .and_then(Value::as_f64)
    {
        out.push(line(
            Pane::Financials,
            format!("free cashflow (ttm)  {fcf:.0}"),
        ));
    }
    out
}

pub(super) fn render_crypto(p: &Value) -> Vec<ViewLine> {
    let sym = p.get("symbol").and_then(Value::as_str).unwrap_or("?");
    let last = p
        .pointer("/data/last")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let vol = p
        .pointer("/data/vol_24h")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let cap = p
        .pointer("/data/market_cap")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    vec![
        line(Pane::Crypto, format!("CRYPTO {sym}")),
        line(
            Pane::Crypto,
            format!("last={last:.2}  vol24h={vol:.0}  cap={cap:.0}"),
        ),
    ]
}

pub(super) fn render_risk(p: &Value) -> Vec<ViewLine> {
    let mut out = vec![line(Pane::Risk, "RISK".to_string())];
    let rows = p
        .pointer("/data/rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for r in rows.iter().take(20) {
        let sym = r.get("symbol").and_then(Value::as_str).unwrap_or("?");
        let beta = r.get("beta").and_then(Value::as_f64).unwrap_or(0.0);
        // MemoryDataSource emits `vol_annualised`; older `volatility` retained as fallback.
        let vol = r
            .get("vol_annualised")
            .or_else(|| r.get("volatility"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        out.push(line(
            Pane::Risk,
            format!("{sym}  beta={beta:.2}  vol={vol:.2}"),
        ));
    }
    out
}

pub(super) fn render_corpact(p: &Value) -> Vec<ViewLine> {
    let sym = p.get("symbol").and_then(Value::as_str).unwrap_or("?");
    let mut out = vec![line(Pane::Corpact, format!("CORPACT {sym}"))];
    let events = p
        .pointer("/data/events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for e in events.iter().take(10) {
        let kind = e.get("type").and_then(Value::as_str).unwrap_or("?");
        // MemoryDataSource events use `ex_date` (dividend/split) or `date` (earnings).
        let date = e
            .get("ex_date")
            .or_else(|| e.get("date"))
            .and_then(Value::as_str)
            .unwrap_or("?");
        // No single `detail` field; surface the type-specific scalar that
        // matters most: amount/currency for dividend, ratio for split,
        // subject for proxy/8-K, fall back to empty otherwise.
        let detail = e
            .get("amount")
            .map(value_to_compact_string)
            .or_else(|| e.get("ratio").map(value_to_compact_string))
            .or_else(|| e.get("subject").map(value_to_compact_string))
            .unwrap_or_default();
        out.push(line(Pane::Corpact, format!("{date}  {kind}  {detail}")));
    }
    out
}

pub(super) fn render_inbox(p: &Value) -> Vec<ViewLine> {
    let mut out = vec![line(Pane::Inbox, "INBOX".to_string())];
    let messages = p
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if messages.is_empty() {
        out.push(line(Pane::Inbox, "(empty)".into()));
        return out;
    }
    for m in messages.iter().take(20) {
        let from = m.get("from").and_then(Value::as_str).unwrap_or("?");
        let body = m
            .get("body")
            .map(value_to_compact_string)
            .unwrap_or_default();
        out.push(line(Pane::Inbox, format!("{from}: {body}")));
    }
    out
}

pub(super) fn render_export(p: &Value) -> Vec<ViewLine> {
    let format = p.get("format").and_then(Value::as_str).unwrap_or("?");
    let body = p.get("body").and_then(Value::as_str).unwrap_or("");
    let mut out = vec![line(Pane::Export, format!("EXPORT format={format}"))];
    for ln in body.lines().take(3) {
        out.push(line(Pane::Export, ln.to_string()));
    }
    out
}
