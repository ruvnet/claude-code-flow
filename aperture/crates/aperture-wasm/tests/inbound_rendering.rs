//! Integration tests for `render_inbound` covering every Wave-1 pane.
//!
//! Lives outside the crate root so `shell_renderers.rs` stays under the
//! 500-line cap.

use aperture_swarm::envelope::{Envelope, MessageType, Priority};
use aperture_wasm::{render_inbound, Pane};
use serde_json::{json, Value};

fn inbound(verb: &str, payload: Value, from: &str) -> Envelope {
    let mut p = payload;
    if let Some(map) = p.as_object_mut() {
        map.insert("verb".into(), json!(verb));
    } else {
        p = json!({"verb": verb});
    }
    Envelope {
        id: "test".into(),
        message_type: MessageType::Direct,
        from: from.into(),
        to: "aperture:cmdbar".into(),
        payload: p,
        timestamp: "2026-05-10T00:00:00.000Z".into(),
        priority: Priority::Normal,
        requires_ack: false,
        ttl_ms: 5000,
        correlation_id: None,
    }
}

#[test]
fn news_result_renders_headlines_in_news_pane() {
    let env = inbound(
        "NEWS.RESULT",
        json!({
            "scope": "AAPL",
            "data": {"headlines": [{"title": "Apple beats earnings"}]},
        }),
        "aperture:pane.news",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::News));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("Apple beats earnings")));
}

#[test]
fn yields_result_renders_curve_in_yields_pane() {
    let env = inbound(
        "YIELDS.RESULT",
        json!({"curve": [{"tenor": "10Y", "yield_pct": 4.25}]}),
        "aperture:pane.yields",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Yields));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("10Y") && l.text.contains("4.25")));
}

#[test]
fn fx_result_renders_pairs_in_fx_pane() {
    let env = inbound(
        "FX.RESULT",
        json!({"data": {"base": "USD", "rates": [{"pair": "EUR", "rate": 1.0823, "change_pct": 0.12}]}}),
        "aperture:pane.fx",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Fx));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("EUR") && l.text.contains("1.0823")));
}

#[test]
fn export_result_truncates_body_to_three_lines() {
    let env = inbound(
        "EXPORT.RESULT",
        json!({
            "format": "csv",
            "body": "a,b\n1,2\n3,4\n5,6\n7,8",
        }),
        "aperture:pane.export",
    );
    let lines = render_inbound(&env);
    // Header + 3 body lines == 4 total.
    assert_eq!(lines.iter().filter(|l| l.pane == Pane::Export).count(), 4);
}

#[test]
fn inbox_result_renders_messages_in_inbox_pane() {
    let env = inbound(
        "INBOX.RESULT",
        json!({"messages": [{"from": "aperture:cmdbar", "body": "ping", "ts": "now"}]}),
        "aperture:pane.inbox",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Inbox));
    assert!(lines.iter().any(|l| l.text.contains("ping")));
}

#[test]
fn risk_result_renders_rows_in_risk_pane() {
    // Uses the canonical `vol_annualised` field that `MemoryDataSource::risk_metrics`
    // emits; the renderer also accepts the legacy `volatility` alias.
    let env = inbound(
        "RISK.RESULT",
        json!({"data": {"rows": [{"symbol": "AAPL", "beta": 1.2, "vol_annualised": 0.3}]}}),
        "aperture:pane.risk",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Risk));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("AAPL") && l.text.contains("1.20") && l.text.contains("0.30")));
}

#[test]
fn options_result_renders_chain_in_options_pane() {
    // MemoryDataSource options chain rows have `call_iv` / `put_iv` / `call_oi` / `put_oi`,
    // not a flat `iv`/`oi`/`type`. Pin the renderer to that shape.
    let env = inbound(
        "OPTIONS.RESULT",
        json!({"symbol": "AAPL", "chain": {"rows": [{
            "strike": 200.0,
            "call_iv": 0.35, "put_iv": 0.40,
            "call_oi": 1234, "put_oi": 1100,
        }]}}),
        "aperture:pane.options",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Options));
    let row = lines
        .iter()
        .find(|l| l.text.contains("K=200.00"))
        .expect("strike row");
    assert!(row.text.contains("C iv=0.35/oi=1234"));
    assert!(row.text.contains("P iv=0.40/oi=1100"));
}

#[test]
fn financials_result_renders_three_statements() {
    let env = inbound(
        "FINANCIALS.RESULT",
        json!({"symbol": "AAPL", "data": {
            "income_ttm": {"revenue": 400_000.0, "net_income": 100_000.0},
            "balance_mrq": {"total_assets": 350_000.0},
            "cashflow_ttm": {"free_cashflow": 90_000.0},
        }}),
        "aperture:pane.financials",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.text.contains("revenue")));
    assert!(lines.iter().any(|l| l.text.contains("total assets")));
    assert!(lines.iter().any(|l| l.text.contains("free cashflow")));
}

#[test]
fn crypto_result_renders_in_crypto_pane() {
    let env = inbound(
        "CRYPTO.RESULT",
        json!({"symbol": "BTC", "data": {"last": 50000.0, "vol_24h": 1e9, "market_cap": 1e12}}),
        "aperture:pane.crypto",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Crypto));
    assert!(lines.iter().any(|l| l.text.contains("last=50000.00")));
}

#[test]
fn corpact_result_renders_events_in_corpact_pane() {
    // MemoryDataSource event shapes:
    //   dividend: {type, ex_date, amount, currency}
    //   split:    {type, ex_date, ratio}
    //   earnings: {type, date}
    // The renderer prefers `ex_date` then `date`, and surfaces the
    // type-specific scalar (amount / ratio / subject).
    let env = inbound(
        "CORPACT.RESULT",
        json!({"symbol": "AAPL", "data": {"events": [
            {"type": "split",    "ex_date": "2026-01-15", "ratio": "4-for-1"},
            {"type": "earnings", "date":    "2026-07-25"},
        ]}}),
        "aperture:pane.corpact",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Corpact));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("split") && l.text.contains("4-for-1")));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("earnings") && l.text.contains("2026-07-25")));
}

#[test]
fn macro_result_renders_in_macro_pane() {
    let env = inbound(
        "MACRO.RESULT",
        json!({"rows": [{"name": "CPI", "value": "3.1%"}, {"name": "GDP", "value": "2.5%"}]}),
        "aperture:pane.macro",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Macro));
    assert!(lines.iter().any(|l| l.text.contains("CPI = 3.1%")));
}

#[test]
fn insider_result_renders_in_insider_pane() {
    let env = inbound(
        "INSIDER.RESULT",
        json!({"symbol": "AAPL", "data": {"trades": [{"name": "Tim", "role": "CEO", "shares": 100}]}}),
        "aperture:pane.insider",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Insider));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("Tim") && l.text.contains("CEO")));
}

#[test]
fn error_payload_renders_in_target_pane() {
    let env = inbound(
        "MACRO.RESULT",
        json!({"error": "upstream down"}),
        "aperture:pane.macro",
    );
    let lines = render_inbound(&env);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].pane, Pane::Macro);
    assert!(lines[0].text.contains("upstream down"));
}

#[test]
fn unknown_verb_falls_back_to_address_pane() {
    let env = inbound("MYSTERY", json!({}), "aperture:pane.options");
    let lines = render_inbound(&env);
    assert_eq!(lines[0].pane, Pane::Options);
}

#[test]
fn agent_data_address_falls_back_to_chart_pane() {
    let env = inbound("OHLCV", json!({}), "aperture:agent.data");
    let lines = render_inbound(&env);
    assert_eq!(lines[0].pane, Pane::Chart);
}

// --- Wave-3 panes ---------------------------------------------------------

#[test]
fn earnings_result_renders_events_in_earnings_pane() {
    let env = inbound(
        "EARNINGS.RESULT",
        json!({"data": {"window_days": 7, "events": [
            {"symbol": "AAPL", "date": "2026-07-25", "estimate_eps": 1.62, "fiscal_period": "FY26 Q3"}
        ]}}),
        "aperture:pane.earnings",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Earnings));
    assert!(lines.iter().any(|l| l.text.contains("AAPL")
        && l.text.contains("2026-07-25")
        && l.text.contains("1.62")));
}

#[test]
fn movers_result_renders_gainers_in_movers_pane() {
    let env = inbound(
        "MOVERS.RESULT",
        json!({"data": {"scope": "gainers", "rows": [
            {"symbol": "ZZZ", "change_pct": 11.42, "last": 7.20}
        ]}}),
        "aperture:pane.movers",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Movers));
    assert!(lines.iter().any(|l| l.text.contains("gainers")));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("ZZZ") && l.text.contains("+11.42%")));
}

#[test]
fn movers_result_renders_active_with_volume() {
    let env = inbound(
        "MOVERS.RESULT",
        json!({"data": {"scope": "active", "rows": [
            {"symbol": "TSLA", "volume": 124_300_000_u64, "last": 250.12}
        ]}}),
        "aperture:pane.movers",
    );
    let lines = render_inbound(&env);
    assert!(lines
        .iter()
        .any(|l| l.text.contains("TSLA") && l.text.contains("vol")));
}

#[test]
fn screen_result_renders_matches_in_screen_pane() {
    let env = inbound(
        "SCREEN.RESULT",
        json!({"data": {"criteria": "market_cap>1e11", "matches": [
            {"symbol": "JNJ", "market_cap": 4.02e11, "div_yield": 0.0314, "pe": 24.1}
        ]}}),
        "aperture:pane.screen",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Screen));
    assert!(lines.iter().any(|l| l.text.contains("market_cap>1e11")));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("JNJ") && l.text.contains("pe 24.10")));
}

#[test]
fn members_result_renders_index_members() {
    let env = inbound(
        "MEMBERS.RESULT",
        json!({"symbol": "SPX", "data": {"index": "SPX", "members": [
            {"symbol": "AAPL", "weight_pct": 7.42, "last": 243.6}
        ]}}),
        "aperture:pane.members",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Members));
    assert!(lines.iter().any(|l| l.text.contains("SPX")));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("AAPL") && l.text.contains("7.42%")));
}

#[test]
fn ivol_result_renders_surface_in_ivol_pane() {
    let env = inbound(
        "IVOL.RESULT",
        json!({"symbol": "AAPL", "data": {
            "symbol": "AAPL",
            "underlying_last": 243.6,
            "rows": [
                {"expiry": "2026-06-19", "strike": 240.0, "iv": 0.2204},
                {"expiry": "2026-07-17", "strike": 245.0, "iv": 0.2326},
            ]
        }}),
        "aperture:pane.ivol",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Ivol));
    assert!(lines.iter().any(|l| l.text.contains("AAPL @ 243.60")));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("K=240.00") && l.text.contains("IV=0.2204")));
}

#[test]
fn tech_result_renders_indicator_value() {
    let env = inbound(
        "TECH.RESULT",
        json!({"symbol": "AAPL", "indicator": "SMA", "data": {
            "symbol": "AAPL", "indicator": "SMA", "value": 247.85
        }}),
        "aperture:pane.tech",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Tech));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("AAPL") && l.text.contains("SMA") && l.text.contains("247.8500")));
}

#[test]
fn corr_result_renders_matrix_in_corr_pane() {
    let env = inbound(
        "CORR.RESULT",
        json!({"data": {
            "symbols": ["AAPL", "MSFT"],
            "matrix": [
                {"symbol": "AAPL", "row": [1.0, 0.42]},
                {"symbol": "MSFT", "row": [0.42, 1.0]},
            ]
        }}),
        "aperture:pane.corr",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Corr));
    assert!(lines.iter().any(|l| l.text.contains("corr [AAPL MSFT]")));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("AAPL") && l.text.contains("0.420")));
}

#[test]
fn filings_result_renders_filings_in_filings_pane() {
    let env = inbound(
        "FILINGS.RESULT",
        json!({"symbol": "AAPL", "data": {"symbol": "AAPL", "filings": [
            {"form": "10-K", "filed_at": "2026-02-12", "fiscal_period": "FY25"},
            {"form": "8-K", "filed_at": "2026-05-08", "subject": "material event"},
        ]}}),
        "aperture:pane.filings",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Filings));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("10-K") && l.text.contains("FY25")));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("8-K") && l.text.contains("material event")));
}

#[test]
fn order_result_renders_single_order() {
    let env = inbound(
        "ORDER.RESULT",
        json!({"order": {
            "id": 1,
            "symbol": "AAPL",
            "side": "BUY",
            "qty": 10,
            "type": "MKT",
            "limit_price": null,
            "status": "PAPER_FILLED",
            "ts": "now"
        }}),
        "aperture:pane.order",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Order));
    assert!(lines.iter().any(|l| {
        l.text.contains("BUY")
            && l.text.contains("AAPL")
            && l.text.contains("qty 10")
            && l.text.contains("status=PAPER_FILLED")
    }));
}

#[test]
fn order_result_with_error_renders_error_line() {
    let env = inbound(
        "ORDER.RESULT",
        json!({"error": "side must be BUY or SELL"}),
        "aperture:pane.order",
    );
    let lines = render_inbound(&env);
    assert!(lines
        .iter()
        .any(|l| l.pane == Pane::Order && l.text.contains("side must be BUY")));
}

#[test]
fn blotter_result_renders_orders_with_count_header() {
    let env = inbound(
        "BLOTTER.RESULT",
        json!({"orders": [
            {"id": 1, "symbol": "AAPL", "side": "BUY", "qty": 10,
             "type": "MKT", "limit_price": null, "status": "PAPER_FILLED"},
            {"id": 2, "symbol": "TSLA", "side": "SELL", "qty": 5,
             "type": "LMT", "limit_price": 250.0, "status": "PAPER_FILLED"},
        ]}),
        "aperture:pane.order",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Order));
    assert!(lines.iter().any(|l| l.text.contains("Blotter (n=2)")));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("TSLA") && l.text.contains("LMT") && l.text.contains("250.00")));
}

#[test]
fn sentiment_result_renders_label_and_score() {
    let env = inbound(
        "SENTIMENT.RESULT",
        json!({"symbol": "AAPL", "data": {
            "symbol": "AAPL",
            "score": 0.421,
            "label": "bullish",
            "sources": [
                {"name": "social-stub", "mentions_24h": 1200},
                {"name": "news-stub", "mentions_24h": 300},
            ]
        }}),
        "aperture:pane.sentiment",
    );
    let lines = render_inbound(&env);
    assert!(lines.iter().any(|l| l.pane == Pane::Sentiment));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("bullish") && l.text.contains("score 0.421")));
    assert!(lines
        .iter()
        .any(|l| l.text.contains("mentions24h 1200+300")));
}

#[test]
fn pane_earnings_address_falls_back_to_earnings_pane() {
    // Unknown verb but the address points at pane.earnings — should still
    // route there.
    let env = inbound("MYSTERY", json!({}), "aperture:pane.earnings");
    let lines = render_inbound(&env);
    assert_eq!(lines[0].pane, Pane::Earnings);
}
