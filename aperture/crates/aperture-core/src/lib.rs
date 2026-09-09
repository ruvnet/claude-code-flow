//! Aperture core: command grammar, AST, and shared state types.
//!
//! The grammar accepted by [`parse`] is intentionally tiny:
//!
//! ```text
//! command  := bare_verb GO?
//!           | symbol verb arg* GO?
//! bare_verb := HELP | CLS | EXIT | LIST | ASK <quoted-string>
//! verb      := DESC | CHART | WATCH | UNWATCH | ASK | CRYPTO
//! symbol    := [A-Z][A-Z0-9.\-]*
//! arg       := token
//! ```
//!
//! `GO` is an optional sentinel kept for muscle-memory compatibility with the
//! `<TICKER> <FN> GO` workflow.

pub mod ast;
pub mod grammar;
pub mod state;

pub use ast::{Arg, Command, Verb};
pub use grammar::{parse, ParseError};
pub use state::{FocusEvent, PaneId, Symbol};
