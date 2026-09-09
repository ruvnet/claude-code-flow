use thiserror::Error;

use crate::ast::{Arg, Command, Verb};

/// Hard caps to prevent pathological inputs (huge quoted strings, runaway
/// token streams) from allocating unbounded memory. The browser shell
/// passes any line a user types — and any envelope a different origin
/// might post — straight into `parse`.
pub const MAX_INPUT_BYTES: usize = 4096;
pub const MAX_TOKENS: usize = 64;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ParseError {
    #[error("empty input")]
    Empty,
    #[error("unterminated quoted string")]
    UnterminatedQuote,
    #[error("unknown verb: {0:?}")]
    UnknownVerb(String),
    #[error("verb {verb:?} requires a symbol prefix")]
    MissingSymbol { verb: Verb },
    #[error("ASK requires a quoted prompt")]
    AskMissingPrompt,
    #[error("input exceeds {MAX_INPUT_BYTES} bytes")]
    InputTooLong,
    #[error("input exceeds {MAX_TOKENS} tokens")]
    TooManyTokens,
}

/// Parse a single command line.
///
/// Whitespace-separated tokens; double-quoted strings preserve internal spaces.
/// The optional terminating `GO` sentinel is recognised and stripped.
pub fn parse(input: &str) -> Result<Command, ParseError> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(ParseError::InputTooLong);
    }
    let tokens = tokenize(input)?;
    if tokens.is_empty() {
        return Err(ParseError::Empty);
    }
    if tokens.len() > MAX_TOKENS {
        return Err(ParseError::TooManyTokens);
    }

    let (tokens, go) = strip_go(tokens);

    // Try bare verb first (verb in slot 0).
    if let Some(verb) = bare_verb(&tokens[0]) {
        return finish_bare(verb, &tokens[1..], go);
    }

    // Otherwise: symbol verb args...
    if tokens.len() < 2 {
        return Err(ParseError::UnknownVerb(tokens[0].as_str().to_string()));
    }
    let symbol = match &tokens[0] {
        Tok::Word(s) => s.to_ascii_uppercase(),
        Tok::Quoted(_) => return Err(ParseError::UnknownVerb(tokens[0].as_str().to_string())),
    };
    let verb = Verb::from_token(tokens[1].as_str())
        .ok_or_else(|| ParseError::UnknownVerb(tokens[1].as_str().to_string()))?;
    let args: Vec<Arg> = tokens[2..]
        .iter()
        .map(|t| match t {
            Tok::Word(s) => Arg::Word(s.clone()),
            Tok::Quoted(s) => Arg::Quoted(s.clone()),
        })
        .collect();
    Ok(Command {
        symbol: Some(symbol),
        verb,
        args,
        go,
    })
}

fn finish_bare(verb: Verb, rest: &[Tok], go: bool) -> Result<Command, ParseError> {
    if verb == Verb::Ask {
        // ASK is a bare verb but requires at least one quoted prompt or some
        // freeform args; we accept any non-empty `rest`.
        if rest.is_empty() {
            return Err(ParseError::AskMissingPrompt);
        }
    }
    let args = rest
        .iter()
        .map(|t| match t {
            Tok::Word(s) => Arg::Word(s.clone()),
            Tok::Quoted(s) => Arg::Quoted(s.clone()),
        })
        .collect();
    Ok(Command {
        symbol: None,
        verb,
        args,
        go,
    })
}

fn bare_verb(t: &Tok) -> Option<Verb> {
    let s = t.as_str();
    match Verb::from_token(s)? {
        v @ (Verb::Help
        | Verb::Cls
        | Verb::Exit
        | Verb::List
        | Verb::Ask
        | Verb::News
        | Verb::Macro
        | Verb::Yields
        | Verb::Fx
        | Verb::Risk
        | Verb::Inbox
        | Verb::Export
        | Verb::Earnings
        | Verb::Movers
        | Verb::Screen
        | Verb::Corr
        | Verb::Order
        | Verb::Blotter) => Some(v),
        _ => None,
    }
}

fn strip_go(mut tokens: Vec<Tok>) -> (Vec<Tok>, bool) {
    if let Some(last) = tokens.last() {
        if matches!(last, Tok::Word(s) if s.eq_ignore_ascii_case("GO")) {
            tokens.pop();
            return (tokens, true);
        }
    }
    (tokens, false)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Tok {
    Word(String),
    Quoted(String),
}

impl Tok {
    fn as_str(&self) -> &str {
        match self {
            Tok::Word(s) | Tok::Quoted(s) => s,
        }
    }
}

fn tokenize(input: &str) -> Result<Vec<Tok>, ParseError> {
    let mut out = Vec::new();
    let mut chars = input.chars().peekable();
    loop {
        // skip whitespace
        while matches!(chars.peek(), Some(c) if c.is_whitespace()) {
            chars.next();
        }
        match chars.peek() {
            None => break,
            Some(&'"') => {
                chars.next();
                let mut buf = String::new();
                let mut closed = false;
                while let Some(c) = chars.next() {
                    if c == '"' {
                        closed = true;
                        break;
                    }
                    buf.push(c);
                }
                if !closed {
                    return Err(ParseError::UnterminatedQuote);
                }
                out.push(Tok::Quoted(buf));
            }
            Some(_) => {
                let mut buf = String::new();
                while let Some(&c) = chars.peek() {
                    if c.is_whitespace() {
                        break;
                    }
                    buf.push(c);
                    chars.next();
                }
                out.push(Tok::Word(buf));
            }
        }
    }
    Ok(out)
}
