//! Property-style fuzz coverage for the command grammar.
//!
//! No `proptest` dependency: deterministic loops over a curated alphabet of
//! `(symbol, verb, args)` tuples plus a battery of whitespace, casing, and
//! quoting permutations. The goal is to pin behaviour that the existing
//! golden tests in `grammar.rs` only sample.
//!
//! Every test in this file pairs a generator with assertions about the
//! resulting `Command`, then round-trips through `serde_json` to catch
//! divergence between the in-memory AST and its wire form.

use aperture_core::{parse, Arg, Command, ParseError, Verb};

/// Curated `(symbol, verb_token, args, expected_verb)` table that exercises
/// every symbol-prefixed verb and several arg shapes. Verbs that cannot take
/// a symbol prefix (HELP/CLS/EXIT/LIST/ASK) are covered separately.
fn symbol_verb_table() -> Vec<(&'static str, &'static str, Vec<&'static str>, Verb)> {
    vec![
        ("AAPL", "DESC", vec![], Verb::Desc),
        ("AAPL", "DES", vec![], Verb::Desc),
        ("AAPL", "CHART", vec!["6M"], Verb::Chart),
        ("AAPL", "CHART", vec!["1Y", "WEEKLY"], Verb::Chart),
        ("AAPL", "GP", vec!["6M"], Verb::Chart),
        ("AAPL", "GIP", vec!["1D"], Verb::Chart),
        ("AAPL", "WATCH", vec![], Verb::Watch),
        ("AAPL", "UNWATCH", vec![], Verb::Unwatch),
        ("MSFT", "DESC", vec![], Verb::Desc),
        ("BRK.B", "DESC", vec![], Verb::Desc),
        ("BTC", "CRYPTO", vec![], Verb::Crypto),
        ("ETH", "CRYPTO", vec!["USD"], Verb::Crypto),
        ("NVDA", "CHART", vec!["3M", "DAILY", "LOG"], Verb::Chart),
    ]
}

#[test]
fn symbol_verb_table_round_trips_through_json() {
    let mut asserts = 0usize;
    for (symbol, verb_tok, args, expected_verb) in symbol_verb_table() {
        let line = if args.is_empty() {
            format!("{symbol} {verb_tok}")
        } else {
            format!("{symbol} {verb_tok} {}", args.join(" "))
        };
        let cmd = parse(&line).unwrap_or_else(|e| panic!("failed to parse {line:?}: {e}"));
        assert_eq!(cmd.verb, expected_verb, "verb mismatch for {line:?}");
        assert_eq!(
            cmd.symbol.as_deref(),
            Some(symbol),
            "symbol normalisation broken for {line:?}"
        );
        assert!(!cmd.go, "GO sentinel should be absent for {line:?}");
        // Args are always Word at this layer (no quotes used here).
        for (i, expected) in args.iter().enumerate() {
            assert_eq!(
                cmd.args.get(i),
                Some(&Arg::Word((*expected).into())),
                "arg #{i} mismatch for {line:?}"
            );
        }
        asserts += 1;

        // Round-trip through JSON.
        let json = serde_json::to_string(&cmd).expect("serialize");
        let back: Command = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(cmd, back, "json round-trip diverged for {line:?}");
        asserts += 1;
    }
    assert!(asserts >= 25, "expected >=25 assertions, got {asserts}");
}

#[test]
fn case_insensitivity_for_verbs_and_symbols_only() {
    // Verbs and symbols are case-insensitive on input; symbols are normalised
    // to upper-case in the AST. Args, however, are passed through verbatim
    // (this is intentional — args may be free-form like quoted prompts).
    // So we compare {symbol, verb, go} across casings, not {args}.
    for (symbol, verb_tok, args, expected_verb) in symbol_verb_table() {
        let parts: Vec<String> = std::iter::once(symbol.to_string())
            .chain(std::iter::once(verb_tok.to_string()))
            .chain(args.iter().map(|s| s.to_string()))
            .collect();
        let upper = parts
            .iter()
            .map(|s| s.to_ascii_uppercase())
            .collect::<Vec<_>>()
            .join(" ");
        let lower = parts
            .iter()
            .map(|s| s.to_ascii_lowercase())
            .collect::<Vec<_>>()
            .join(" ");
        let mixed = parts
            .iter()
            .enumerate()
            .map(|(i, s)| {
                if i % 2 == 0 {
                    s.to_ascii_uppercase()
                } else {
                    s.to_ascii_lowercase()
                }
            })
            .collect::<Vec<_>>()
            .join(" ");

        let cu = parse(&upper).expect("upper parses");
        let cl = parse(&lower).expect("lower parses");
        let cm = parse(&mixed).expect("mixed parses");

        assert_eq!(cu.verb, expected_verb, "verb mismatch (upper) for {parts:?}");
        assert_eq!(cl.verb, expected_verb, "verb mismatch (lower) for {parts:?}");
        assert_eq!(cm.verb, expected_verb, "verb mismatch (mixed) for {parts:?}");
        assert_eq!(cu.go, cl.go, "go mismatch upper vs lower for {parts:?}");
        assert_eq!(cu.go, cm.go, "go mismatch upper vs mixed for {parts:?}");
        // Symbol must always be upper-cased in the AST regardless of input casing.
        assert_eq!(cu.symbol.as_deref(), Some(symbol));
        assert_eq!(cl.symbol.as_deref(), Some(symbol));
        assert_eq!(cm.symbol.as_deref(), Some(symbol));
        // Arg count agrees across casings.
        assert_eq!(cu.args.len(), cl.args.len());
        assert_eq!(cu.args.len(), cm.args.len());
    }
}

#[test]
fn whitespace_variants_yield_identical_ast() {
    // Leading, trailing, and internal multi-space all collapse the same way.
    let baseline = parse("AAPL CHART 6M").unwrap();
    let variants = [
        "  AAPL CHART 6M",
        "AAPL CHART 6M  ",
        "  AAPL   CHART   6M  ",
        "AAPL\tCHART\t6M",
        "AAPL  CHART\t  6M",
        "\n AAPL CHART 6M \n",
    ];
    for v in variants {
        let c = parse(v).unwrap_or_else(|e| panic!("variant {v:?} should parse: {e}"));
        assert_eq!(c, baseline, "whitespace variant diverged: {v:?}");
    }
}

#[test]
fn go_sentinel_only_strips_when_last_token() {
    // `GO` last → stripped, `go: true`.
    let c1 = parse("AAPL CHART 6M GO").unwrap();
    assert!(c1.go);
    assert_eq!(c1.args, vec![Arg::Word("6M".into())]);

    // `GO` last with mixed case still strips. Note args are NOT case-folded:
    // the literal "6m" stays as-is.
    let c1m = parse("aapl chart 6m Go").unwrap();
    assert!(c1m.go);
    assert_eq!(c1m.args, vec![Arg::Word("6m".into())]);

    // `GO` mid-line is a regular arg, not a sentinel. Casing of the literal
    // arg is preserved verbatim.
    let c2 = parse("AAPL CHART GO 6M").unwrap();
    assert!(!c2.go, "mid-line GO must not be treated as sentinel");
    assert_eq!(
        c2.args,
        vec![Arg::Word("GO".into()), Arg::Word("6M".into())],
        "mid-line GO must survive as a literal arg"
    );

    // Two trailing `GO`s only strips one (the very last).
    let c3 = parse("AAPL CHART 6M GO GO").unwrap();
    assert!(c3.go);
    assert_eq!(
        c3.args,
        vec![Arg::Word("6M".into()), Arg::Word("GO".into())],
        "only the trailing GO is stripped; the inner one remains an arg"
    );
}

#[test]
fn empty_quoted_string_is_accepted_for_ask() {
    // Pin: an empty quoted string after ASK is accepted (rest is non-empty)
    // and produces an `Arg::Quoted("")`.
    let c = parse(r#"ASK """#).expect("empty quoted string after ASK should parse");
    assert_eq!(c.verb, Verb::Ask);
    assert_eq!(c.symbol, None);
    assert_eq!(c.args, vec![Arg::Quoted(String::new())]);

    // Round-trip through JSON.
    let json = serde_json::to_string(&c).unwrap();
    let back: Command = serde_json::from_str(&json).unwrap();
    assert_eq!(back, c);
}

#[test]
fn unicode_in_quoted_strings_round_trips() {
    let inputs = [
        r#"ASK "naïve résumé""#,
        r#"ASK "日本株は上昇""#,
        r#"ASK "πr² > 0""#,
        r#"NVDA ASK "guidance — beat or miss?""#,
    ];
    for src in inputs {
        let c = parse(src).unwrap_or_else(|e| panic!("unicode {src:?} should parse: {e}"));
        // The quoted body should be the exact unicode string.
        assert!(
            matches!(c.args.first(), Some(Arg::Quoted(_))),
            "expected first arg to be Quoted for {src:?}"
        );
        // JSON round-trip preserves the bytes exactly.
        let json = serde_json::to_string(&c).unwrap();
        let back: Command = serde_json::from_str(&json).unwrap();
        assert_eq!(back, c, "unicode round-trip diverged for {src:?}");
    }
}

#[test]
fn unknown_verb_error_carries_offending_token() {
    let cases = [
        ("AAPL FROBNICATE", "FROBNICATE"),
        ("MSFT NOPE", "NOPE"),
        ("NVDA ZZZ", "ZZZ"),
    ];
    for (input, expected_token) in cases {
        match parse(input) {
            Err(ParseError::UnknownVerb(tok)) => {
                // The token may be stored as-is (case preserved); compare
                // case-insensitively to keep the test robust to either choice.
                assert_eq!(
                    tok.to_ascii_uppercase(),
                    expected_token.to_ascii_uppercase(),
                    "UnknownVerb should carry {expected_token:?} for input {input:?}"
                );
            }
            other => panic!("expected UnknownVerb for {input:?}, got {other:?}"),
        }
    }
}

#[test]
fn bare_verbs_round_trip_through_json() {
    // Each bare verb with optional GO. ASK is exercised separately because it
    // requires a prompt.
    let cases: Vec<(&str, Verb, bool)> = vec![
        ("HELP", Verb::Help, false),
        ("HELP GO", Verb::Help, true),
        ("?", Verb::Help, false),
        ("CLS", Verb::Cls, false),
        ("CLEAR", Verb::Cls, false),
        ("CLS GO", Verb::Cls, true),
        ("EXIT", Verb::Exit, false),
        ("QUIT", Verb::Exit, false),
        ("EXIT GO", Verb::Exit, true),
        ("LIST", Verb::List, false),
        ("LS", Verb::List, false),
        ("LIST GO", Verb::List, true),
    ];
    for (line, verb, go) in cases {
        let c = parse(line).unwrap_or_else(|e| panic!("{line:?} must parse: {e}"));
        assert_eq!(c.verb, verb, "verb mismatch for {line:?}");
        assert_eq!(c.symbol, None, "bare verbs must have None symbol");
        assert!(c.args.is_empty(), "bare verbs must have no args here");
        assert_eq!(c.go, go, "go sentinel mismatch for {line:?}");
        // Round-trip JSON.
        let json = serde_json::to_string(&c).unwrap();
        let back: Command = serde_json::from_str(&json).unwrap();
        assert_eq!(back, c);
    }
}

#[test]
fn ask_quoted_prompt_round_trips() {
    // Bare ASK plus symbol-prefixed ASK, both preserve the quoted body verbatim.
    let bare = parse(r#"ASK "why did NVDA pop today""#).unwrap();
    assert_eq!(bare.verb, Verb::Ask);
    assert_eq!(bare.symbol, None);
    assert_eq!(bare.args, vec![Arg::Quoted("why did NVDA pop today".into())]);

    let attached = parse(r#"NVDA ASK "implications of guidance miss""#).unwrap();
    assert_eq!(attached.verb, Verb::Ask);
    assert_eq!(attached.symbol.as_deref(), Some("NVDA"));
    assert_eq!(
        attached.args,
        vec![Arg::Quoted("implications of guidance miss".into())]
    );

    for c in [bare, attached] {
        let json = serde_json::to_string(&c).unwrap();
        let back: Command = serde_json::from_str(&json).unwrap();
        assert_eq!(back, c);
    }
}

#[test]
fn unterminated_quote_is_a_parse_error_not_panic() {
    let bad = [r#"ASK "hello"#, r#"NVDA ASK "no end"#, r#"AAPL CHART "open"#];
    for input in bad {
        let res = parse(input);
        assert!(res.is_err(), "expected parse error for {input:?}");
        // Crucially: must be a typed error, not a panic.
        assert_eq!(
            res.unwrap_err(),
            ParseError::UnterminatedQuote,
            "expected UnterminatedQuote for {input:?}"
        );
    }
}

#[test]
fn all_args_round_trip_byte_for_byte() {
    // Build a command with both Word and Quoted args, then JSON round-trip.
    let cmd = parse(r#"NVDA ASK "what now?""#).unwrap();
    let json = serde_json::to_string(&cmd).unwrap();
    // Ensure JSON contains the snake_case `quoted` discriminant.
    assert!(json.contains("\"quoted\""), "expected snake_case Arg tag in {json}");
    let back: Command = serde_json::from_str(&json).unwrap();
    assert_eq!(back, cmd);

    let cmd2 = parse("AAPL CHART 6M DAILY LOG GO").unwrap();
    let json2 = serde_json::to_string(&cmd2).unwrap();
    assert!(json2.contains("\"go\":true"));
    let back2: Command = serde_json::from_str(&json2).unwrap();
    assert_eq!(back2, cmd2);
}

#[test]
fn empty_and_whitespace_only_input_errors() {
    assert_eq!(parse("").unwrap_err(), ParseError::Empty);
    for blank in ["   ", "\t", "\n", " \t \n "] {
        assert_eq!(
            parse(blank).unwrap_err(),
            ParseError::Empty,
            "blank input {blank:?} should error Empty"
        );
    }
}
