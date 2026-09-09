//! Web-research DataSource backed by Anthropic Claude Managed Agents.
//!
//! Parallels `aperture-providers-claude` (which shells out to the `claude`
//! CLI) but talks directly to the Managed Agents REST + SSE endpoints at
//! `api.anthropic.com`. Same prompt set, same fallback contract.
//!
//! ```text
//! POST /v1/agents              # create or reuse a research agent
//! POST /v1/environments        # create or reuse a sandbox container
//! POST /v1/sessions            # one session per research call
//! POST /v1/sessions/<id>/events  # the user.message that kicks the work
//! GET  /v1/sessions/<id>/events  # polled until the turn finishes
//! ```
//!
//! Wire details follow `https://platform.claude.com/docs/en/managed-agents/`.
//! All calls include `x-api-key`, `anthropic-version: 2023-06-01`, and
//! `anthropic-beta: managed-agents-2026-04-01`.
//!
//! ## Transport: polling, not SSE
//!
//! The docs describe a `GET /v1/sessions/<id>/stream` SSE endpoint, but
//! it returns `not_found_error` in the environments we've tested (the
//! streaming surface appears gated during the beta). `GET
//! /v1/sessions/<id>/events` reliably returns the full event history, so
//! [`api::run_event`] sends the user message and then polls the events
//! endpoint (~1.5s cadence, bounded by `Config::timeout`) until a
//! terminal `session.status_idle` appears, then returns the concatenated
//! text of every `agent.message` event from that turn. An SSE-stream
//! parser (`sse::SseParser`) and `api::stream_argv` are retained for
//! when the streaming endpoint becomes generally available.
//!
//! ## Auth
//!
//! `Config::from_env` resolves credentials from these env vars:
//!
//! 1. `ANTHROPIC_API_KEY` — Anthropic's canonical name (matches the SDKs).
//! 2. `ANTHROPIC_KEY` — accepted as a user-friendly alias because that's
//!    what we were asked to integrate with.
//! 3. `ANTHROPIC_BASE_URL` — overrides the API host (matches the SDKs and
//!    Claude Code's proxied environments). Defaults to
//!    `https://api.anthropic.com`.
//!
//! No key → `Config::from_env` returns Err; the host should either bail
//! or wire a `ManagedAgentsResearcher` only on opt-in.
//!
//! ## HTTP transport
//!
//! Uses `curl` via `tokio::process::Command`. This matches the pattern of
//! the sibling `aperture-providers-claude` crate (which shells to
//! `claude`) and keeps the workspace free of a heavy `reqwest` /
//! `hyper` / TLS dep tree. `curl` is universally available on the
//! native targets we care about.
//!
//! ## No live invocations in tests
//!
//! Unit tests cover argv assembly, SSE parsing, and the cache. Live
//! integration tests are gated behind `#[ignore]` and read
//! `ANTHROPIC_API_KEY` from the environment.

pub mod api;
pub mod config;
pub mod sse;

mod researcher;

pub use config::Config;
pub use researcher::ManagedAgentsResearcher;
