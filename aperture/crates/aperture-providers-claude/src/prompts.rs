//! Per-method prompt builders.
//!
//! Each builder returns a single-line prompt that:
//!  - states the JSON schema the response must match,
//!  - tells `claude -p` to output ONLY that JSON (no fences, no prose),
//!  - constrains the data scope so WebSearch/WebFetch costs stay bounded.

/// News headlines. `symbol` is optional — `None` means a global market
/// summary. Schema: `{ scope, headlines: [{ title, source, url, ts }] }`.
pub fn news(symbol: Option<&str>) -> String {
    let scope = symbol.map(str::to_ascii_uppercase).unwrap_or_else(|| "GLOBAL".into());
    let target = if scope == "GLOBAL" {
        "broad US equity market".to_string()
    } else {
        format!("the publicly-traded company with ticker {scope}")
    };
    format!(
        "Search the web for the 5 most recent news headlines about {target}. \
         Output ONLY a single JSON object — no code fences, no prose — with this exact shape: \
         {{ \"scope\": \"{scope}\", \"headlines\": [ {{ \"title\": string, \"source\": string, \"url\": string, \"ts\": ISO-8601 string }} ] }}. \
         Limit to 5 entries. Each title must be a verbatim headline from a real publication."
    )
}

/// US macroeconomic indicators (CPI, unemployment, GDP, Fed funds, ISM).
pub fn macro_indicators() -> String {
    "Look up the most recent US macroeconomic indicator readings: CPI YoY, unemployment rate, \
     GDP QoQ annualised, Fed funds target, ISM manufacturing. \
     Output ONLY a single JSON array — no code fences, no prose — with this exact shape: \
     [ { \"name\": string, \"value\": number, \"as_of\": YYYY-MM-DD string } ]. \
     Five entries in the order listed above."
        .to_string()
}

/// US Treasury yield curve at standard tenors.
pub fn yield_curve() -> String {
    "Look up today's US Treasury constant-maturity yields for tenors 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y, 30Y. \
     Output ONLY a single JSON array — no code fences, no prose — with this exact shape: \
     [ { \"tenor\": string, \"yield_pct\": number } ]. \
     Eight entries in the listed order; values in percent (e.g. 4.25 means 4.25%)."
        .to_string()
}

/// Major FX cross rates against `base` (default USD).
pub fn fx_rates(base: Option<&str>) -> String {
    let base = base.map(str::to_ascii_uppercase).unwrap_or_else(|| "USD".into());
    format!(
        "Look up today's spot FX cross rates against {base}: EURUSD, USDJPY, GBPUSD, USDCHF, AUDUSD, USDCAD. \
         Output ONLY a single JSON object — no code fences, no prose — with this exact shape: \
         {{ \"base\": \"{base}\", \"rates\": [ {{ \"pair\": string, \"rate\": number, \"change_pct\": number }} ] }}. \
         Six entries; change_pct is the day-over-day percent change."
    )
}

/// Earnings calendar window (default 7 days).
pub fn earnings_calendar(window_days: Option<u32>) -> String {
    let days = window_days.unwrap_or(7);
    format!(
        "Look up upcoming US equity earnings releases in the next {days} days. \
         Output ONLY a single JSON object — no code fences, no prose — with this exact shape: \
         {{ \"window_days\": {days}, \"events\": [ {{ \"symbol\": string, \"date\": YYYY-MM-DD string, \"estimate_eps\": number, \"fiscal_period\": string }} ] }}. \
         Limit to 10 entries, sorted by date ascending."
    )
}

/// Index members (e.g. SPX, NDX, DJI).
pub fn index_members(symbol: &str) -> String {
    let s = symbol.to_ascii_uppercase();
    format!(
        "Look up the top 10 components by weight of the equity index with ticker {s}. \
         Output ONLY a single JSON object — no code fences, no prose — with this exact shape: \
         {{ \"index\": \"{s}\", \"members\": [ {{ \"symbol\": string, \"weight_pct\": number, \"last\": number }} ] }}. \
         Limit to 10 entries; weight_pct in percent (e.g. 7.2 means 7.2%); last is the most-recent close."
    )
}

/// Corporate actions (dividends, splits, M&A) for a symbol.
pub fn corp_actions(symbol: &str) -> String {
    let s = symbol.to_ascii_uppercase();
    format!(
        "Look up recent corporate actions (dividends, stock splits, scheduled earnings) for {s} in the last 12 months and the next 6 months. \
         Output ONLY a single JSON object — no code fences, no prose — with this exact shape: \
         {{ \"symbol\": \"{s}\", \"events\": [ {{ \"type\": \"dividend\"|\"split\"|\"earnings\"|\"merger\", \"ex_date\": YYYY-MM-DD string OPTIONAL, \"date\": YYYY-MM-DD string OPTIONAL, \"amount\": number OPTIONAL, \"currency\": string OPTIONAL, \"ratio\": string OPTIONAL, \"subject\": string OPTIONAL }} ] }}. \
         Use ex_date for dividends/splits, date for earnings/mergers."
    )
}

/// Recent SEC filings for a symbol.
pub fn filings(symbol: &str) -> String {
    let s = symbol.to_ascii_uppercase();
    format!(
        "Look up the 5 most recent SEC EDGAR filings for {s}. \
         Output ONLY a single JSON object — no code fences, no prose — with this exact shape: \
         {{ \"symbol\": \"{s}\", \"filings\": [ {{ \"form\": string, \"filed_at\": YYYY-MM-DD string, \"fiscal_period\": string OPTIONAL, \"subject\": string OPTIONAL, \"url\": string }} ] }}. \
         form is e.g. \"10-K\", \"10-Q\", \"8-K\", \"DEF 14A\". url must be the EDGAR document URL."
    )
}

/// News + social sentiment summary for a symbol.
pub fn sentiment(symbol: &str) -> String {
    let s = symbol.to_ascii_uppercase();
    format!(
        "Search the web for current news and social sentiment about the publicly-traded company with ticker {s}. \
         Score the overall tone from -1.0 (very bearish) to +1.0 (very bullish). \
         Output ONLY a single JSON object — no code fences, no prose — with this exact shape: \
         {{ \"symbol\": \"{s}\", \"score\": number, \"label\": \"bullish\"|\"neutral\"|\"bearish\", \"sources\": [ {{ \"name\": string, \"mentions_24h\": integer }} ] }}. \
         label = bullish if score >= 0.4, bearish if score <= -0.4, else neutral."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn news_with_symbol_uppercases_and_includes_schema() {
        let p = news(Some("aapl"));
        assert!(p.contains("AAPL"));
        assert!(p.contains("\"headlines\""));
        assert!(p.contains("Output ONLY"));
        assert!(p.contains("Limit to 5"));
    }

    #[test]
    fn news_without_symbol_targets_global() {
        let p = news(None);
        assert!(p.contains("GLOBAL"));
        assert!(p.contains("broad US equity market"));
    }

    #[test]
    fn macro_indicators_lists_all_five_indicators() {
        let p = macro_indicators();
        for key in ["CPI", "unemployment", "GDP", "Fed funds", "ISM"] {
            assert!(p.contains(key), "missing `{key}`: {p}");
        }
    }

    #[test]
    fn yield_curve_lists_eight_tenors() {
        let p = yield_curve();
        for t in ["1M", "3M", "6M", "1Y", "2Y", "5Y", "10Y", "30Y"] {
            assert!(p.contains(t), "missing tenor `{t}`: {p}");
        }
    }

    #[test]
    fn fx_rates_default_base_is_usd() {
        let p = fx_rates(None);
        assert!(p.contains("\"USD\""));
    }

    #[test]
    fn fx_rates_explicit_base_uppercased() {
        let p = fx_rates(Some("eur"));
        assert!(p.contains("\"EUR\""));
    }

    #[test]
    fn earnings_calendar_default_window_is_7() {
        let p = earnings_calendar(None);
        assert!(p.contains("next 7 days"));
        assert!(p.contains("\"window_days\": 7"));
    }

    #[test]
    fn earnings_calendar_custom_window() {
        let p = earnings_calendar(Some(14));
        assert!(p.contains("next 14 days"));
    }

    #[test]
    fn members_uppercases_index() {
        let p = index_members("spx");
        assert!(p.contains("\"SPX\""));
    }

    #[test]
    fn corp_actions_mentions_all_event_types() {
        let p = corp_actions("AAPL");
        for t in ["dividend", "split", "earnings", "merger"] {
            assert!(p.contains(t));
        }
    }

    #[test]
    fn filings_mentions_edgar_and_sample_form() {
        let p = filings("AAPL");
        assert!(p.contains("EDGAR"));
        assert!(p.contains("10-K"));
    }

    #[test]
    fn sentiment_includes_score_range_and_thresholds() {
        let p = sentiment("AAPL");
        assert!(p.contains("-1.0"));
        assert!(p.contains("+1.0"));
        assert!(p.contains("bullish"));
        assert!(p.contains("0.4"));
    }
}
