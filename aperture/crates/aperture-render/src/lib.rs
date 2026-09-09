//! Backend-agnostic rendering surface used by both the native ratatui binary
//! and the WASM/ratzilla shell.
//!
//! A [`Pane`] is a stateful, addressable unit. The host loop:
//! 1. delivers inbound `Msg` via [`Pane::handle`], which may mutate state
//!    and return outbound `Msg`s for the swarm bus,
//! 2. periodically calls [`Pane::view`] to obtain a [`View`], a
//!    backend-neutral description of what to draw.
//!
//! The TUI and WASM crates each translate `View` into their respective
//! frameworks; this crate has no `ratatui`/`web-sys` dependency.

use aperture_core::PaneId;
use serde::{Deserialize, Serialize};

/// Inbound or outbound pane traffic. The wire form (the swarm `Message`
/// envelope) is constructed in `aperture-swarm`; this is the in-process
/// representation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Msg {
    /// Command bar broadcast: re-anchor on a symbol.
    Focus { symbol: String },
    /// Generic payload for pane-specific messages.
    Payload(serde_json::Value),
}

/// Stateful, named pane. Implementors live in `aperture-tui`/`aperture-wasm`
/// or are dynamically registered by the host.
pub trait Pane {
    fn id(&self) -> &PaneId;
    fn title(&self) -> &str;
    /// Apply an inbound message; return any outbound messages.
    fn handle(&mut self, msg: Msg) -> Vec<Msg>;
    /// Snapshot the pane's renderable state.
    fn view(&self) -> View;
}

/// Backend-neutral description of a pane's content.
#[derive(Debug, Clone, Default)]
pub struct View {
    pub lines: Vec<Line>,
}

#[derive(Debug, Clone, Default)]
pub struct Line {
    pub text: String,
    pub emphasis: Emphasis,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Emphasis {
    #[default]
    Normal,
    Dim,
    Strong,
    Warn,
    Error,
}

impl View {
    pub fn push(&mut self, text: impl Into<String>) {
        self.lines.push(Line {
            text: text.into(),
            emphasis: Emphasis::Normal,
        });
    }
    pub fn push_emph(&mut self, text: impl Into<String>, emphasis: Emphasis) {
        self.lines.push(Line {
            text: text.into(),
            emphasis,
        });
    }
}
