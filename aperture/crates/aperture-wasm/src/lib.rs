//! Browser entry for Aperture.
//!
//! Layout:
//! - `shell` — the [`App`] struct with `execute` / `handle_inbound` entry points.
//! - `local_data` — in-WASM `MemoryDataSource` backend so the bare browser
//!   shell shows real data even with no swarm bus connected.
//! - `keymap_web` — browser-friendly key bindings (Ctrl+1..9, `:`, `Esc`, `Enter`).
//! - `fetch_bridge` — thin `window.fetch` wrapper used by data panes; goes via
//!   the SvelteKit `/api/aperture/fetch?u=...` CORS proxy so API keys stay
//!   server-side.
//!
//! The native build (`cfg(not(target_arch = "wasm32"))`) is a no-op so
//! `cargo check --workspace` works without the wasm32 target installed.

// `keymap_web`, `local_data`, `shell_routing`, and `shell_renderers` are
// target-agnostic (pure logic) so their unit tests run under plain
// `cargo test`. `shell` and `fetch_bridge` depend on `wasm-bindgen` /
// `web-sys` and are wasm32-only.
#[cfg(target_arch = "wasm32")]
mod fetch_bridge;
mod keymap_web;
mod local_data;
#[cfg(target_arch = "wasm32")]
mod shell;
mod shell_renderers;
mod shell_routing;

#[cfg(target_arch = "wasm32")]
pub use shell::{start, App};

// Re-export the routing primitives so downstream Rust callers (and our own
// tests) can build/inspect envelopes without going through `wasm-bindgen`.
pub use local_data::resolve_local;
pub use shell_routing::{
    build_route, envelope_for, local_render, render_inbound, verb_str, Pane, ViewLine,
};

// `parse_line` is preserved for back-compat with the Phase A scaffold; the
// SvelteKit host can still call `parse_line(line)` if it does not yet hold an
// `App` handle.
#[cfg(target_arch = "wasm32")]
mod legacy {
    use aperture_core::parse;
    use wasm_bindgen::prelude::*;

    /// Parse a command line and return the AST as JSON. Lets the host show
    /// parse errors before any swarm traffic is generated.
    #[wasm_bindgen]
    pub fn parse_line(line: &str) -> Result<JsValue, JsValue> {
        match parse(line) {
            Ok(cmd) => {
                serde_wasm_bindgen::to_value(&cmd).map_err(|e| JsValue::from_str(&e.to_string()))
            }
            Err(e) => Err(JsValue::from_str(&e.to_string())),
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod native_noop {
    //! Native build of this crate is a no-op so that `cargo check --workspace`
    //! works without the wasm32 target installed. WASM users should build with
    //! `wasm-pack build crates/aperture-wasm`.
    #[allow(dead_code)]
    pub fn start(_mount_id: &str) {}
}
