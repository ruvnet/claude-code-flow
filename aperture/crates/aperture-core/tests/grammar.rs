use aperture_core::{parse, Arg, ParseError, Verb};

#[test]
fn help_bare() {
    let c = parse("HELP").unwrap();
    assert_eq!(c.verb, Verb::Help);
    assert_eq!(c.symbol, None);
    assert!(!c.go);
}

#[test]
fn help_with_go() {
    let c = parse("HELP GO").unwrap();
    assert_eq!(c.verb, Verb::Help);
    assert!(c.go);
}

#[test]
fn cls_alias() {
    assert_eq!(parse("CLEAR").unwrap().verb, Verb::Cls);
    assert_eq!(parse("CLS").unwrap().verb, Verb::Cls);
}

#[test]
fn exit_quit() {
    assert_eq!(parse("EXIT").unwrap().verb, Verb::Exit);
    assert_eq!(parse("QUIT GO").unwrap().verb, Verb::Exit);
}

#[test]
fn aapl_desc() {
    let c = parse("AAPL DESC").unwrap();
    assert_eq!(c.symbol.as_deref(), Some("AAPL"));
    assert_eq!(c.verb, Verb::Desc);
    assert!(c.args.is_empty());
}

#[test]
fn aapl_chart_range_with_go() {
    let c = parse("aapl chart 6M go").unwrap();
    assert_eq!(c.symbol.as_deref(), Some("AAPL"));
    assert_eq!(c.verb, Verb::Chart);
    assert_eq!(c.args, vec![Arg::Word("6M".into())]);
    assert!(c.go);
}

#[test]
fn btc_crypto() {
    let c = parse("BTC CRYPTO").unwrap();
    assert_eq!(c.symbol.as_deref(), Some("BTC"));
    assert_eq!(c.verb, Verb::Crypto);
}

#[test]
fn ask_bare_with_quoted_prompt() {
    let c = parse(r#"ASK "why did NVDA pop today""#).unwrap();
    assert_eq!(c.verb, Verb::Ask);
    assert_eq!(c.symbol, None);
    assert_eq!(
        c.args,
        vec![Arg::Quoted("why did NVDA pop today".into())]
    );
}

#[test]
fn nvda_ask_attached() {
    // Symbol-prefixed ASK: route the question with that symbol's context.
    let c = parse(r#"NVDA ASK "implications of guidance miss""#).unwrap();
    assert_eq!(c.symbol.as_deref(), Some("NVDA"));
    assert_eq!(c.verb, Verb::Ask);
    assert_eq!(
        c.args,
        vec![Arg::Quoted("implications of guidance miss".into())]
    );
}

#[test]
fn list_bare() {
    assert_eq!(parse("LIST").unwrap().verb, Verb::List);
    assert_eq!(parse("LS GO").unwrap().verb, Verb::List);
}

#[test]
fn watch_unwatch() {
    assert_eq!(parse("AAPL WATCH").unwrap().verb, Verb::Watch);
    assert_eq!(parse("AAPL UNWATCH").unwrap().verb, Verb::Unwatch);
}

#[test]
fn empty_input_errors() {
    assert_eq!(parse("").unwrap_err(), ParseError::Empty);
    assert_eq!(parse("   ").unwrap_err(), ParseError::Empty);
}

#[test]
fn unknown_verb_errors() {
    assert!(matches!(
        parse("AAPL FROBNICATE"),
        Err(ParseError::UnknownVerb(_))
    ));
}

#[test]
fn unterminated_quote_errors() {
    assert_eq!(
        parse(r#"ASK "hello"#).unwrap_err(),
        ParseError::UnterminatedQuote
    );
}

#[test]
fn ask_without_prompt_errors() {
    assert_eq!(parse("ASK").unwrap_err(), ParseError::AskMissingPrompt);
}
