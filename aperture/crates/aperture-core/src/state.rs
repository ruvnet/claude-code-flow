use serde::{Deserialize, Serialize};

/// Stable identifier for a pane instance, e.g. `pane.chart#1`.
pub type PaneId = String;

/// Uppercase market symbol token.
pub type Symbol = String;

/// Broadcast-on-execute event emitted by the command bar so every pane can
/// re-anchor on the same symbol.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FocusEvent {
    pub symbol: Symbol,
    pub panes: Vec<PaneId>,
}
