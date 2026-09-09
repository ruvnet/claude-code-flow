//! Deterministic in-memory provider for tests and offline demos.

use crate::{Candle, DataError, DataSource, Payload, Quote};
use async_trait::async_trait;
use serde_json::json;

pub struct MemoryDataSource;

#[async_trait]
impl DataSource for MemoryDataSource {
    fn name(&self) -> &'static str {
        "memory"
    }

    async fn quote(&self, symbol: &str) -> Result<Quote, DataError> {
        let s = symbol.to_ascii_uppercase();
        let last = price_for(&s);
        Ok(Quote {
            symbol: s,
            last,
            change_pct: 0.42,
            bid: Some(last - 0.05),
            ask: Some(last + 0.05),
            timestamp: "2026-05-10T15:04:05.000Z".into(),
        })
    }

    async fn ohlcv(&self, symbol: &str, _range: &str) -> Result<Vec<Candle>, DataError> {
        let base = price_for(&symbol.to_ascii_uppercase());
        let mut out = Vec::with_capacity(30);
        for i in 0..30 {
            let drift = (i as f64) * 0.1;
            out.push(Candle {
                t: 1_700_000_000 + (i as i64) * 86_400,
                o: base + drift,
                h: base + drift + 1.0,
                l: base + drift - 1.0,
                c: base + drift + 0.5,
                v: 1_000_000.0,
            });
        }
        Ok(out)
    }

    async fn news(&self, symbol: Option<&str>) -> Result<Payload, DataError> {
        let scope = symbol.map(|s| s.to_ascii_uppercase());
        let scope_label = scope.as_deref().unwrap_or("GLOBAL");
        Ok(json!({
            "scope": scope_label,
            "headlines": [
                {"title": format!("{scope_label}: guidance update"), "source": "wire-1", "ts": "2026-05-10T13:00:00Z"},
                {"title": format!("{scope_label}: sector rotation note"), "source": "wire-2", "ts": "2026-05-10T11:30:00Z"},
                {"title": format!("{scope_label}: research highlights"), "source": "wire-3", "ts": "2026-05-10T09:15:00Z"},
            ]
        }))
    }

    async fn macro_indicators(&self) -> Result<Payload, DataError> {
        Ok(json!([
            {"name": "CPI YoY", "value": 2.6, "as_of": "2026-04-30"},
            {"name": "Unemployment", "value": 3.9, "as_of": "2026-04-30"},
            {"name": "GDP QoQ Annualised", "value": 2.1, "as_of": "2026-03-31"},
            {"name": "Fed Funds Target", "value": 4.25, "as_of": "2026-05-01"},
            {"name": "ISM Manufacturing", "value": 49.5, "as_of": "2026-04-30"},
        ]))
    }

    async fn yield_curve(&self) -> Result<Payload, DataError> {
        Ok(json!([
            {"tenor": "1M",  "yield_pct": 4.42},
            {"tenor": "3M",  "yield_pct": 4.41},
            {"tenor": "6M",  "yield_pct": 4.36},
            {"tenor": "1Y",  "yield_pct": 4.18},
            {"tenor": "2Y",  "yield_pct": 3.92},
            {"tenor": "5Y",  "yield_pct": 3.85},
            {"tenor": "10Y", "yield_pct": 4.05},
            {"tenor": "30Y", "yield_pct": 4.41},
        ]))
    }

    async fn fx_rates(&self, base: Option<&str>) -> Result<Payload, DataError> {
        let base = base.unwrap_or("USD").to_ascii_uppercase();
        Ok(json!({
            "base": base,
            "rates": [
                {"pair": "EURUSD", "rate": 1.0853, "change_pct": -0.12},
                {"pair": "USDJPY", "rate": 152.31, "change_pct": 0.34},
                {"pair": "GBPUSD", "rate": 1.2614, "change_pct": -0.08},
                {"pair": "USDCHF", "rate": 0.8924, "change_pct": 0.05},
                {"pair": "AUDUSD", "rate": 0.6582, "change_pct": -0.21},
                {"pair": "USDCAD", "rate": 1.3712, "change_pct": 0.11},
            ]
        }))
    }

    async fn options_chain(&self, symbol: &str) -> Result<Payload, DataError> {
        let s = symbol.to_ascii_uppercase();
        let last = price_for(&s);
        let strikes: Vec<_> = (0..7)
            .map(|i| {
                let strike = ((last - 15.0) + (i as f64) * 5.0).round();
                json!({
                    "strike": strike,
                    "call_iv": 0.28 + (i as f64) * 0.005,
                    "put_iv": 0.30 + (i as f64) * 0.004,
                    "call_oi": 1200 + i * 80,
                    "put_oi": 1100 + i * 70,
                })
            })
            .collect();
        Ok(json!({
            "symbol": s,
            "underlying_last": last,
            "expiry": "2026-06-19",
            "rows": strikes,
        }))
    }

    async fn insider_trades(&self, symbol: &str) -> Result<Payload, DataError> {
        let s = symbol.to_ascii_uppercase();
        Ok(json!({
            "symbol": s,
            "trades": [
                {"name": "C. Ackerman", "role": "CFO",      "shares": -12_000, "filed_at": "2026-05-08"},
                {"name": "B. Niven",    "role": "Director", "shares":   5_000, "filed_at": "2026-05-05"},
                {"name": "A. Pham",     "role": "CEO",      "shares":  -8_500, "filed_at": "2026-04-30"},
            ]
        }))
    }

    async fn financials(&self, symbol: &str) -> Result<Payload, DataError> {
        let s = symbol.to_ascii_uppercase();
        let scale = price_for(&s);
        Ok(json!({
            "symbol": s,
            "income_ttm": {
                "revenue": 8.0e10 + scale * 1.0e8,
                "gross_profit": 3.4e10 + scale * 4.0e7,
                "operating_income": 2.5e10 + scale * 2.0e7,
                "net_income": 2.0e10 + scale * 1.5e7,
            },
            "balance_mrq": {
                "total_assets": 3.5e11,
                "total_liabilities": 2.6e11,
                "total_equity": 9.0e10,
                "cash": 4.0e10,
            },
            "cashflow_ttm": {
                "operating": 3.0e10,
                "investing": -1.2e10,
                "financing": -1.5e10,
                "free_cashflow": 2.4e10,
            }
        }))
    }

    async fn crypto_quote(&self, symbol: &str) -> Result<Payload, DataError> {
        let s = symbol.to_ascii_uppercase();
        let last = price_for(&s) * 100.0;
        Ok(json!({
            "symbol": s,
            "last": last,
            "change_24h_pct": 1.84,
            "vol_24h": 2.4e10,
            "market_cap": last * 1.95e7,
            "dominance_pct": if s == "BTC" { 51.2 } else { 0.0 },
            "timestamp": "2026-05-10T15:04:05.000Z",
        }))
    }

    async fn risk_metrics(&self, symbols: &[String]) -> Result<Payload, DataError> {
        let rows: Vec<_> = symbols
            .iter()
            .map(|s| {
                let s = s.to_ascii_uppercase();
                let p = price_for(&s);
                json!({
                    "symbol": s,
                    "beta": 0.85 + ((p as i64 % 60) as f64) / 200.0,
                    "vol_annualised": 0.22 + ((p as i64 % 30) as f64) / 500.0,
                    "var_1d_95": -p * 0.018,
                })
            })
            .collect();
        Ok(json!({
            "as_of": "2026-05-10",
            "rows": rows,
        }))
    }

    async fn corp_actions(&self, symbol: &str) -> Result<Payload, DataError> {
        let s = symbol.to_ascii_uppercase();
        Ok(json!({
            "symbol": s,
            "events": [
                {"type": "dividend", "ex_date": "2026-05-12", "amount": 0.24, "currency": "USD"},
                {"type": "split",    "ex_date": "2025-08-31", "ratio": "4-for-1"},
                {"type": "earnings", "date":     "2026-07-25"},
            ]
        }))
    }

    async fn earnings_calendar(&self, window_days: Option<u32>) -> Result<Payload, DataError> {
        let days = window_days.unwrap_or(7);
        Ok(json!({
            "window_days": days,
            "events": [
                {"symbol": "AAPL", "date": "2026-07-25", "estimate_eps": 1.62, "fiscal_period": "FY26 Q3"},
                {"symbol": "MSFT", "date": "2026-07-30", "estimate_eps": 3.05, "fiscal_period": "FY26 Q4"},
                {"symbol": "NVDA", "date": "2026-08-21", "estimate_eps": 0.68, "fiscal_period": "FY27 Q2"},
                {"symbol": "TSLA", "date": "2026-07-19", "estimate_eps": 0.55, "fiscal_period": "FY26 Q2"},
                {"symbol": "AMZN", "date": "2026-08-01", "estimate_eps": 1.08, "fiscal_period": "FY26 Q2"},
            ]
        }))
    }

    async fn movers(&self, scope: Option<&str>) -> Result<Payload, DataError> {
        let scope = scope.unwrap_or("gainers").to_ascii_lowercase();
        let mk = |sym: &str, chg: f64, last: f64| {
            json!({"symbol": sym, "change_pct": chg, "last": last})
        };
        let rows = match scope.as_str() {
            "losers" => vec![
                mk("XYZ", -8.41, 12.34),
                mk("ABC", -6.92, 45.10),
                mk("DEF", -5.18, 88.55),
                mk("GHI", -4.77, 23.06),
                mk("JKL", -3.61, 15.78),
            ],
            "active" => vec![
                json!({"symbol": "TSLA", "volume": 124_300_000_u64, "last": 250.12}),
                json!({"symbol": "AAPL", "volume":  98_700_000_u64, "last": 243.60}),
                json!({"symbol": "AMZN", "volume":  74_200_000_u64, "last": 188.45}),
                json!({"symbol": "NVDA", "volume":  68_500_000_u64, "last": 920.18}),
                json!({"symbol": "MSFT", "volume":  43_900_000_u64, "last": 492.40}),
            ],
            _ => vec![
                mk("ZZZ", 11.42, 7.20),
                mk("YYY",  9.31, 33.82),
                mk("XXX",  7.55, 102.40),
                mk("WWW",  6.10, 18.04),
                mk("VVV",  5.38, 60.12),
            ],
        };
        Ok(json!({"scope": scope, "rows": rows}))
    }

    async fn screener(&self, criteria: Option<&str>) -> Result<Payload, DataError> {
        let q = criteria.unwrap_or("market_cap>1e11 AND div_yield>0.02").to_string();
        Ok(json!({
            "criteria": q,
            "matches": [
                {"symbol": "JNJ",  "market_cap": 4.02e11, "div_yield": 0.0314, "pe": 24.1},
                {"symbol": "KO",   "market_cap": 2.91e11, "div_yield": 0.0282, "pe": 26.4},
                {"symbol": "PG",   "market_cap": 3.85e11, "div_yield": 0.0247, "pe": 27.0},
                {"symbol": "XOM",  "market_cap": 4.55e11, "div_yield": 0.0335, "pe": 14.8},
                {"symbol": "CVX",  "market_cap": 2.81e11, "div_yield": 0.0405, "pe": 13.9},
            ]
        }))
    }

    async fn index_members(&self, symbol: &str) -> Result<Payload, DataError> {
        let s = symbol.to_ascii_uppercase();
        // Tiny in-memory roster — the real list per index is provider-specific.
        let members = match s.as_str() {
            "DJI" | "DJIA" => vec!["AAPL", "MSFT", "JPM", "GS", "JNJ", "PG", "KO", "BA"],
            "NDX" | "QQQ" => vec!["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "AVGO"],
            _ /* SPX */ => vec!["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "BRK.B", "XOM"],
        };
        let rows: Vec<_> = members
            .into_iter()
            .map(|m| {
                let p = price_for(m);
                json!({"symbol": m, "weight_pct": (p % 100.0) / 10.0, "last": p})
            })
            .collect();
        Ok(json!({"index": s, "members": rows}))
    }

    async fn vol_surface(&self, symbol: &str) -> Result<Payload, DataError> {
        let s = symbol.to_ascii_uppercase();
        let last = price_for(&s);
        let expiries = ["2026-06-19", "2026-07-17", "2026-09-18", "2026-12-19"];
        let strikes_offset: [f64; 5] = [-15.0, -7.5, 0.0, 7.5, 15.0];
        let mut rows = Vec::new();
        for (i, exp) in expiries.iter().enumerate() {
            for (j, off) in strikes_offset.iter().enumerate() {
                let strike = (last + off).round();
                let iv = 0.22 + (i as f64) * 0.012 + (j as f64) * 0.004;
                rows.push(json!({"expiry": exp, "strike": strike, "iv": iv}));
            }
        }
        Ok(json!({"symbol": s, "underlying_last": last, "rows": rows}))
    }

    async fn technicals(&self, symbol: &str, indicator: &str) -> Result<Payload, DataError> {
        let s = symbol.to_ascii_uppercase();
        let ind = indicator.to_ascii_uppercase();
        let base = price_for(&s);
        let series: Vec<f64> = (0..30).map(|i| base + (i as f64) * 0.3).collect();
        let value = match ind.as_str() {
            "SMA" => series.iter().sum::<f64>() / series.len() as f64,
            "EMA" => {
                // Simple 14-period EMA approximation.
                let alpha = 2.0 / (14.0 + 1.0);
                let mut e = series[0];
                for v in &series[1..] {
                    e = alpha * v + (1.0 - alpha) * e;
                }
                e
            }
            "RSI" => {
                // Toy RSI on the deterministic in-memory series: monotonically increasing → 100.
                100.0
            }
            "MACD" => {
                // Toy: difference between mean of last 12 and last 26 (truncated).
                let last12 = series.iter().rev().take(12).sum::<f64>() / 12.0;
                let last26 = series.iter().rev().take(26).sum::<f64>() / 26.0;
                last12 - last26
            }
            _ => return Err(DataError::Provider(format!("unknown indicator: {ind}"))),
        };
        Ok(json!({
            "symbol": s,
            "indicator": ind,
            "value": value,
            "series": series,
        }))
    }

    async fn correlation_matrix(&self, symbols: &[String]) -> Result<Payload, DataError> {
        let n = symbols.len();
        let mut rows = Vec::with_capacity(n);
        for (i, a) in symbols.iter().enumerate() {
            let mut row = Vec::with_capacity(n);
            for (j, b) in symbols.iter().enumerate() {
                let v = if i == j {
                    1.0
                } else {
                    let pa = price_for(&a.to_ascii_uppercase()) as i64;
                    let pb = price_for(&b.to_ascii_uppercase()) as i64;
                    let mix = ((pa.wrapping_add(pb)).abs() % 200) as f64 / 100.0 - 1.0;
                    (mix * 1000.0).round() / 1000.0
                };
                row.push(v);
            }
            rows.push(json!({"symbol": a.to_ascii_uppercase(), "row": row}));
        }
        Ok(json!({
            "symbols": symbols.iter().map(|s| s.to_ascii_uppercase()).collect::<Vec<_>>(),
            "matrix": rows,
        }))
    }

    async fn filings(&self, symbol: &str) -> Result<Payload, DataError> {
        let s = symbol.to_ascii_uppercase();
        Ok(json!({
            "symbol": s,
            "filings": [
                {"form": "10-K",  "filed_at": "2026-02-12", "fiscal_period": "FY25",   "url": "stub://10-K-2026-02-12"},
                {"form": "10-Q",  "filed_at": "2026-04-30", "fiscal_period": "FY26 Q1","url": "stub://10-Q-2026-04-30"},
                {"form": "8-K",   "filed_at": "2026-05-08", "subject": "material event", "url": "stub://8-K-2026-05-08"},
                {"form": "DEF 14A","filed_at": "2026-03-15", "subject": "proxy",          "url": "stub://DEF14A-2026-03-15"},
            ]
        }))
    }

    async fn sentiment(&self, symbol: &str) -> Result<Payload, DataError> {
        let s = symbol.to_ascii_uppercase();
        let p = price_for(&s);
        // Fake but deterministic per-symbol score in [-1.0, +1.0].
        let score = ((p as i64 % 200) as f64 / 100.0) - 1.0;
        let label = match score {
            x if x >= 0.4 => "bullish",
            x if x <= -0.4 => "bearish",
            _ => "neutral",
        };
        Ok(json!({
            "symbol": s,
            "score": (score * 1000.0).round() / 1000.0,
            "label": label,
            "sources": [
                {"name": "social-stub", "mentions_24h": (p as i64 % 5000)},
                {"name": "news-stub",   "mentions_24h": (p as i64 % 1500)},
            ]
        }))
    }
}

fn price_for(symbol: &str) -> f64 {
    let mut acc: u64 = 0;
    for b in symbol.bytes() {
        acc = acc.wrapping_mul(31).wrapping_add(b as u64);
    }
    100.0 + ((acc % 4_000) as f64) / 10.0
}
