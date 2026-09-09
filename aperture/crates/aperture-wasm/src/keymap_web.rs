//! Browser keymap. F1–F12 and `/` are reserved by the host, so we use
//! `Ctrl+1..9`, `Ctrl+0`, and `Alt+1..7` for pane focus and `:` to enter
//! command mode (vim-ish), with `Esc` to leave it and `Enter` to submit.
//!
//! Pane index layout (1-based, matches [`Action::FocusPane`]):
//!
//! | Index | Binding   | Pane (canonical)                  |
//! |-------|-----------|-----------------------------------|
//! |  1    | Ctrl+1    | quote                             |
//! |  2    | Ctrl+2    | chart                             |
//! |  3    | Ctrl+3    | watch                             |
//! |  4    | Ctrl+4    | oracle                            |
//! |  5    | Ctrl+5    | news                              |
//! |  6    | Ctrl+6    | macro                             |
//! |  7    | Ctrl+7    | yields                            |
//! |  8    | Ctrl+8    | fx                                |
//! |  9    | Ctrl+9    | options                           |
//! | 10    | Ctrl+0    | insider                           |
//! | 11    | Alt+1     | financials                        |
//! | 12    | Alt+2     | crypto                            |
//! | 13    | Alt+3     | risk                              |
//! | 14    | Alt+4     | corpact                           |
//! | 15    | Alt+5     | inbox                             |
//! | 16    | Alt+6     | export                            |
//! |  0    | (cmdbar)  | reserved for the command bar      |
//!
//! `Ctrl+0` is bound (index 10); the legacy "0 means cmdbar" semantics now
//! live on the bare `:` -> `EnterCmd` path.
//!
//! On native builds, only the unit tests reach this code; the warnings would
//! otherwise be a distraction.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// Total number of bindable panes. Must stay aligned with the table above
/// and with [`crate::shell_routing::Pane`] (which adds the `System` catch-all).
pub const PANE_COUNT: u8 = 16;

/// High-level UI action produced by the keymap. The shell is free to ignore
/// or remap these; they're just a stable enum the host can talk to without
/// re-implementing browser-key parsing in TypeScript.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    /// Focus pane index 1..=16. 0 means "command bar".
    FocusPane(u8),
    /// Enter command mode (`:`).
    EnterCmd,
    /// Leave command mode (`Esc`).
    LeaveCmd,
    /// Submit the current input (`Enter`).
    Submit,
    /// Unrecognised key — the host can decide whether to insert it as text.
    Unknown,
}

/// Parsed key descriptor coming from a JS `KeyboardEvent`. The host fills this
/// in; we deliberately don't depend on `web-sys::KeyboardEvent` here so the
/// keymap is unit-testable on native.
#[derive(Debug, Clone, Copy)]
pub struct KeyEvent<'a> {
    pub key: &'a str,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
}

/// Map a key event to a high-level [`Action`].
pub fn map(ev: KeyEvent<'_>) -> Action {
    match ev.key {
        ":" if !ev.ctrl && !ev.meta && !ev.alt => Action::EnterCmd,
        "Escape" => Action::LeaveCmd,
        "Enter" => Action::Submit,
        // Ctrl+1..9, Ctrl+0 — first 10 panes.
        k if ev.ctrl && !ev.alt && !ev.meta && k.len() == 1 => {
            let c = k.chars().next().unwrap();
            if let Some(d) = c.to_digit(10) {
                let idx = if d == 0 { 10 } else { d as u8 };
                if (1..=10).contains(&idx) {
                    return Action::FocusPane(idx);
                }
            }
            Action::Unknown
        }
        // Alt+1..6 — panes 11..16.
        k if ev.alt && !ev.ctrl && !ev.meta && k.len() == 1 => {
            let c = k.chars().next().unwrap();
            if let Some(d) = c.to_digit(10) {
                if (1..=6).contains(&d) {
                    return Action::FocusPane((d as u8) + 10);
                }
            }
            Action::Unknown
        }
        _ => Action::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(key: &str, ctrl: bool) -> KeyEvent<'_> {
        KeyEvent {
            key,
            ctrl,
            alt: false,
            meta: false,
        }
    }

    fn alt_ev(key: &str) -> KeyEvent<'_> {
        KeyEvent {
            key,
            ctrl: false,
            alt: true,
            meta: false,
        }
    }

    #[test]
    fn ctrl_digits_focus_panes_1_to_9() {
        for d in 1..=9u8 {
            let s = d.to_string();
            assert_eq!(map(ev(&s, true)), Action::FocusPane(d));
        }
    }

    #[test]
    fn ctrl_zero_focuses_pane_10() {
        assert_eq!(map(ev("0", true)), Action::FocusPane(10));
    }

    #[test]
    fn alt_digits_focus_panes_11_to_16() {
        for d in 1..=6u8 {
            let s = d.to_string();
            assert_eq!(map(alt_ev(&s)), Action::FocusPane(d + 10));
        }
    }

    #[test]
    fn alt_seven_is_unknown_until_we_add_more_panes() {
        assert_eq!(map(alt_ev("7")), Action::Unknown);
    }

    #[test]
    fn cmd_mode_keys() {
        assert_eq!(map(ev(":", false)), Action::EnterCmd);
        assert_eq!(map(ev("Escape", false)), Action::LeaveCmd);
        assert_eq!(map(ev("Enter", false)), Action::Submit);
    }

    #[test]
    fn ctrl_alt_combo_falls_through_to_unknown() {
        // Avoid swallowing system shortcuts — only pure Ctrl or pure Alt count.
        let e = KeyEvent {
            key: "1",
            ctrl: true,
            alt: true,
            meta: false,
        };
        assert_eq!(map(e), Action::Unknown);
    }

    #[test]
    fn pane_count_matches_max_index() {
        // Highest reachable index from the keymap is 16; the constant must
        // stay in sync.
        assert_eq!(PANE_COUNT, 16);
    }
}
