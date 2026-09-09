//! Wave-3a grammar tests for the 11 new verbs added in commit dc93ac4:
//!   EARNINGS, MOVERS, SCREEN, MEMBERS, IVOL, TECH, CORR, FILINGS, ORDER,
//!   BLOTTER, SENTIMENT.
//!
//! Mirrors the assertion style of `tests/grammar.rs` — round-trip the
//! command line through `parse(line)` and verify:
//!   * the resulting `Verb` variant,
//!   * the symbol position for symbol-prefixed verbs,
//!   * the args list for argument-bearing verbs,
//!   * the optional terminating `GO` sentinel.

use aperture_core::{parse, Arg, Verb};

// ---------------------------------------------------------------------------
// Bare verbs — no symbol prefix.
// ---------------------------------------------------------------------------

#[test]
fn earnings_bare_with_go() {
    let c = parse("EARNINGS GO").unwrap();
    assert_eq!(c.verb, Verb::Earnings);
    assert_eq!(c.symbol, None);
    assert!(c.args.is_empty());
    assert!(c.go);
}

#[test]
fn movers_bare_with_scope_arg() {
    let c = parse("MOVERS losers GO").unwrap();
    assert_eq!(c.verb, Verb::Movers);
    assert_eq!(c.symbol, None);
    assert_eq!(c.args, vec![Arg::Word("losers".into())]);
    assert!(c.go);
}

#[test]
fn screen_bare_no_args() {
    let c = parse("SCREEN GO").unwrap();
    assert_eq!(c.verb, Verb::Screen);
    assert_eq!(c.symbol, None);
    assert!(c.args.is_empty());
    assert!(c.go);
}

#[test]
fn corr_bare_with_symbol_args() {
    let c = parse("CORR AAPL MSFT GO").unwrap();
    assert_eq!(c.verb, Verb::Corr);
    assert_eq!(c.symbol, None);
    assert_eq!(
        c.args,
        vec![Arg::Word("AAPL".into()), Arg::Word("MSFT".into())]
    );
    assert!(c.go);
}

#[test]
fn order_bare_with_args() {
    let c = parse("ORDER AAPL BUY 10 GO").unwrap();
    assert_eq!(c.verb, Verb::Order);
    assert_eq!(c.symbol, None);
    assert_eq!(
        c.args,
        vec![
            Arg::Word("AAPL".into()),
            Arg::Word("BUY".into()),
            Arg::Word("10".into()),
        ]
    );
    assert!(c.go);
}

#[test]
fn blotter_bare_no_args() {
    let c = parse("BLOTTER").unwrap();
    assert_eq!(c.verb, Verb::Blotter);
    assert_eq!(c.symbol, None);
    assert!(c.args.is_empty());
    assert!(!c.go);
}

// ---------------------------------------------------------------------------
// Symbol-prefixed verbs — symbol is uppercased, even from lowercase input.
// ---------------------------------------------------------------------------

#[test]
fn aapl_tech_rsi() {
    let c = parse("AAPL TECH RSI GO").unwrap();
    assert_eq!(c.symbol.as_deref(), Some("AAPL"));
    assert_eq!(c.verb, Verb::Tech);
    assert_eq!(c.args, vec![Arg::Word("RSI".into())]);
    assert!(c.go);
}

#[test]
fn aapl_ivol_lowercase_uppercases_symbol() {
    let c = parse("aapl ivol").unwrap();
    assert_eq!(c.symbol.as_deref(), Some("AAPL"));
    assert_eq!(c.verb, Verb::Ivol);
    assert!(c.args.is_empty());
    assert!(!c.go);
}

#[test]
fn spx_members() {
    let c = parse("SPX MEMBERS").unwrap();
    assert_eq!(c.symbol.as_deref(), Some("SPX"));
    assert_eq!(c.verb, Verb::Members);
    assert!(c.args.is_empty());
    assert!(!c.go);
}

#[test]
fn aapl_filings_with_go() {
    let c = parse("AAPL FILINGS GO").unwrap();
    assert_eq!(c.symbol.as_deref(), Some("AAPL"));
    assert_eq!(c.verb, Verb::Filings);
    assert!(c.args.is_empty());
    assert!(c.go);
}

#[test]
fn aapl_sentiment_no_args() {
    let c = parse("AAPL SENTIMENT").unwrap();
    assert_eq!(c.symbol.as_deref(), Some("AAPL"));
    assert_eq!(c.verb, Verb::Sentiment);
    assert!(c.args.is_empty());
    assert!(!c.go);
}

// ---------------------------------------------------------------------------
// requires_symbol() — Wave-3a verbs that demand a leading ticker.
// ---------------------------------------------------------------------------

#[test]
fn requires_symbol_set_includes_new_symbol_verbs() {
    assert!(Verb::Members.requires_symbol(), "MEMBERS must require a symbol");
    assert!(Verb::Ivol.requires_symbol(), "IVOL must require a symbol");
    assert!(Verb::Tech.requires_symbol(), "TECH must require a symbol");
    assert!(Verb::Filings.requires_symbol(), "FILINGS must require a symbol");
    assert!(
        Verb::Sentiment.requires_symbol(),
        "SENTIMENT must require a symbol"
    );

    // The bare-only Wave-3a verbs must NOT claim to require a symbol.
    assert!(!Verb::Earnings.requires_symbol());
    assert!(!Verb::Movers.requires_symbol());
    assert!(!Verb::Screen.requires_symbol());
    assert!(!Verb::Corr.requires_symbol());
    assert!(!Verb::Order.requires_symbol());
    assert!(!Verb::Blotter.requires_symbol());
}
