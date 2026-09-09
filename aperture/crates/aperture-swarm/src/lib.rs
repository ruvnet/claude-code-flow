//! Wire bridge between Aperture panes and ruflo's swarm bus.
//!
//! The on-the-wire envelope is field-identical to
//! `v3/@claude-flow/swarm/src/types.ts:Message`, so JSON round-trips with
//! zero remap on either side.

pub mod envelope;

#[cfg(not(target_arch = "wasm32"))]
pub mod native_stdio;

#[cfg(not(target_arch = "wasm32"))]
pub mod runtime;

#[cfg(target_arch = "wasm32")]
pub mod wasm_postmsg;

pub use envelope::{Envelope, MessageType, Priority};

#[cfg(not(target_arch = "wasm32"))]
pub use runtime::{envelope as new_envelope, make_id, now_iso, reply, run_agent, Agent};
