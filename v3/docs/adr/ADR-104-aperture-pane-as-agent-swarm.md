# ADR-104: Aperture — Polymorphic Market Workspace as Pane-as-Agent Swarm

**Status**: Accepted
**Date**: 2026-05-10
**Version**: aperture@0.1.0-alpha · @aperture/ui@0.1.0-alpha.1 · ruflo-aperture@0.1.0-alpha.3
**Related**: ADR-004 (Plugin Architecture), ADR-015 (Unified Plugin System),
ADR-019 (Headless Runtime Package), ADR-046 (ruflo Umbrella)

## Context

The ruflo ecosystem needed a reference workstation that exercises the swarm
runtime end-to-end and shows what a multi-pane financial workspace looks like
when built on top of pane-as-agent coordination. Prior work in this space has
been single-process Python TUIs; the design space asked specifically for:

1. **Polymorphic naming** — no vendor tokens (`bloomberg`, `bpipe`, `blp`,
   `finmsg`) anywhere in code, comments, docs, or UX. The project name and
   verb mnemonics are vendor-neutral (`DESC` / `CHART` / `OPTIONS` / …) and
   a CI gate enforces it.
2. **Two execution targets from one engine** — native ratatui binary for
   terminal-first users and a wasm-bindgen artifact that the existing
   SvelteKit ruvocal host and a new React/shadcn-ui app can both mount.
3. **Pane = Agent** — every pane is a separate `aperture_swarm::Agent`,
   reachable as `aperture:pane.<id>` and addressable from the existing
   `v3/@claude-flow/swarm` `message-bus.ts` without a remap layer.
4. **Provider-agnostic data layer** — the engine compiles and tests with no
   network deps; real providers (Yahoo / FRED / SEC EDGAR / CoinGecko /
   Binance / AlphaVantage) plug in later behind cargo features.

This ADR records the architectural decisions that fell out of that design and
the security / perf hardening pass that followed.

## Decision

### 1. Rust workspace with target-split crates

`aperture/` is a fresh cargo workspace under the repo root with six crates:

| Crate | Role | Targets |
|---|---|---|
| `aperture-core` | Command AST + grammar + state types | host-agnostic |
| `aperture-render` | Backend-agnostic `Pane` / `Widget` traits | host-agnostic |
| `aperture-swarm` | Wire envelope mirroring `v3/@claude-flow/swarm` `Message` + native stdio transport + wasm postMessage transport | dual-target |
| `aperture-data` | `DataSource` + `KeyValueStore` traits + `MemoryDataSource` offline provider | host-agnostic |
| `aperture-tui` | Native binary (`ratatui` + `tokio`) | native only |
| `aperture-wasm` | Browser entry (`wasm-bindgen`) + verb routing + reply renderers | wasm32 + cfg-gated native no-op |

`aperture-swarm` and `aperture-wasm` use `[target.'cfg(target_arch = "wasm32")']`
to gate transport choices so `cargo check --workspace` succeeds without the
wasm32 toolchain installed.

### 2. Pane-as-Agent contract

Every pane is one struct implementing `aperture_swarm::Agent`. Inter-pane
traffic is `Envelope` JSON whose field shape is **byte-identical to**
`v3/@claude-flow/swarm/src/types.ts:Message`:

```rust
pub struct Envelope {
    pub id: String,
    #[serde(rename = "type")] pub message_type: MessageType,
    pub from: String, pub to: String,
    pub payload: serde_json::Value,
    pub timestamp: String,   // ISO-8601, never null
    pub priority: Priority,
    #[serde(rename = "requiresAck")] pub requires_ack: bool,
    #[serde(rename = "ttlMs")] pub ttl_ms: u64,
    #[serde(rename = "correlationId")] pub correlation_id: Option<String>,
}
```

A native pane reads/writes newline-delimited JSON on stdin/stdout; the WASM
shell relays via `window.postMessage`. Both transports preserve correlation
ids so request/response can be matched by the host without server-side state.

The pane registry currently holds 26 panes (Quote, Chart, Watchlist, Oracle,
News, Macro, Yields, FX, Options, Insider, Financials, Crypto, Risk,
Corpact, Inbox, Export, Earnings, Movers, Screen, Members, IVol, Tech, Corr,
Filings, Order, Sentiment) + a data agent (`aperture:agent.data`). The 27
known agent ids are enumerated in
`aperture-tui::agent_runner::KNOWN_AGENTS`.

### 3. Verb grammar

Commands follow `SYMBOL VERB ARGS* GO`. 32 verbs total: 9 local
(HELP/CLS/EXIT/LIST/ASK plus four legacy), 11 first-wave market verbs,
11 second-wave (EARNINGS/MOVERS/SCREEN/MEMBERS/IVOL/TECH/CORR/FILINGS/
ORDER/BLOTTER/SENTIMENT), 1 broadcast (FOCUS). The full mapping is in
`aperture/docs/PROTOCOL.md`. Parsing is hand-rolled (no external parser
crate), hardened against pathological inputs with
`MAX_INPUT_BYTES = 4096` and `MAX_TOKENS = 64`.

### 4. Three shells, one engine

The same wasm-bindgen artifact mounts in:

- `ruflo/src/ruvocal/src/routes/aperture/+page.svelte` — the existing
  SvelteKit ruvocal host; minimal CSS, native Svelte 5 reactivity.
- `aperture-ui/src/pages/Aperture.tsx` — a new React + Vite + Tailwind +
  shadcn-ui SPA forked from `v3/goal_ui` (Supabase + research-specific
  routes stripped); see `aperture-ui/README.md` for the diff vs upstream.

Both hosts use the same `App::execute(line)` and `App::handle_inbound(env)`
API surface. Pane rendering uses the same `Pane` enum (lowercase serde
variant names) so a third shell could be added without touching the
renderer module.

### 5. `MemoryDataSource` — explicit, not a stub

The default `DataSource` impl is `aperture_data::MemoryDataSource` (file
`memory.rs`, cargo feature `memory`). It returns deterministic JSON keyed
by a polynomial-rolling hash of the symbol; tests pin the outputs. Real
providers (Yahoo / FRED / SEC EDGAR / CoinGecko / Binance / AlphaVantage)
land later as sibling provider crates, each behind a cargo feature, with a
shared abstraction via `DataSource` default methods that return
`Provider("not supported")` so single-purpose providers don't need to
implement the full 20-method surface.

The naming reflects the actual behaviour (an in-memory provider for tests
and offline demos). A CI gate (`smoke.sh`'s no-stub-text pass) rejects any
new occurrence of the literal `(stub)` in source.

### 6. Hardening defaults

The deep-review pass landed these defaults:

- **Origin pinning** — both browser hosts check
  `ev.origin === window.location.origin && ev.source === window` before
  routing inbound envelopes; outbound `postMessage` targets the same origin
  (no `"*"`).
- **SSRF guard on the SvelteKit proxy** — HTTPS-only, no userinfo, port
  pinned to "" / "443", hostname allowlist, `AbortSignal.timeout(15s)`,
  `redirect: "manual"`, 5 MiB body cap.
- **WASM fetch defence-in-depth** — `AbortController` + `setTimeout` for a
  30 s ceiling; content-type validation accepts only
  `application/json` / `text/*`.
- **Native stdio** — line reader is byte-bounded by 1 MiB; oversize lines
  yield `TransportError::LineTooLong` and the agent skips and continues.
- **ORDER pane** — `^[A-Z][A-Z0-9.\-]{0,15}$` symbols, `1..=10_000_000`
  qty, finite + positive limit prices.

### 7. Plugin distribution

Aperture ships as `plugins/ruflo-aperture/` via the existing IPFS plugin
registry. The plugin manifest declares all 26 pane-agents, the `/aperture`
command, and the `aperture-launch` skill. A new `BUILT_IN_PLUGINS` entry in
`v3/@claude-flow/cli/src/plugins/manager.ts` registers it for runtime
discovery (CID pin TODO until first IPFS publish).

### 8. Smoke gate

`plugins/ruflo-aperture/scripts/smoke.sh` runs three gates in order:

1. `cargo test --workspace --quiet`
2. Naming gate — no `bloomberg|bpipe|^blp\b|finmsg` literals anywhere
   except `NOTICE.md`, the gate script, and the in-source naming-gate
   test that has to contain them to test for them.
3. No-stub-text gate — no `(stub)` literal anywhere except this script.

The optional fourth step builds the WASM artifact via `wasm-pack` when
available; missing toolchain skips cleanly.

## Consequences

### Positive

- **One canonical wire format** — the `Envelope` field shape is the swarm
  bus contract; future panes, hosts, and providers attach without remap
  glue.
- **Test coverage scales with breadth** — 220 tests across 7 crates,
  including 22 round-trip stdio tests that spawn the binary as
  `--agent=pane.<id>` and assert reply shape, and 29 inbound-rendering
  tests that pin the field names every renderer reads.
- **Naming is enforced** — vendor neutrality and no-stub-text are CI gates,
  not conventions. The branch carries 11 commits with zero violations.
- **Hosts are interchangeable** — replacing the React SPA, the SvelteKit
  route, or the native ratatui binary touches only its shell crate; the
  pane code is unaware.

### Negative / accepted

- **`DataSource` is wide** (20 methods on one trait). The deep-review pass
  flagged this; the trait split into MarketData / Reference / Discovery /
  Derivatives / Risk is queued for a follow-up ADR but not blocking.
- **Pane registry is duplicated four times** (Rust `KNOWN_AGENTS`, React
  `PANE_ORDER`, Svelte `PANE_ORDER`, plugin.json `agents`). Drift hazard
  noted; a build-time codegen step from one spec file is the planned fix.
- **Tokenizer allocates per token** — `Tok<'a> { Word(&'a str) }` zero-copy
  refactor is deferred; not a measurable hot path at human keystroke
  cadence.
- **No real providers yet** — the workspace compiles offline, but a
  developer who wants live quotes must implement and feature-gate their
  own provider.
- **`wasm-pack` not exercised in CI** — the WASM artifact builds locally
  but no automated step verifies it (no GitHub Actions workflow yet).

### Open issues tracked

- **Marketplace.json entry** alongside `ruflo-market-data` /
  `ruflo-neural-trader` so end users see Aperture in `/plugins list`.
- **IPFS CID** in `BUILT_IN_PLUGINS` empty; pin at first Pinata publish.
- **Oracle pane routing** — current `synthesize_answer()` is an
  in-process keyword router; the full `ruflo-neural-trader` call needs the
  coordinator to expose an agent-to-agent forwarding channel.
- **CSP / `frame-ancestors`** header on the SvelteKit `/aperture` route to
  pair with the origin-pinned postMessage handlers.
- **Per-pane state caps** on InboxPane, OrderPane, and the host-side
  `log` array.

## References

- `aperture/README.md` — workspace overview
- `aperture/NOTICE.md` — inspiration / clean-room note
- `aperture/docs/PROTOCOL.md` — verb table + reply payload shapes
- `plugins/ruflo-aperture/README.md` — plugin wrapper details
- `aperture-ui/README.md` — React fork diff vs `v3/goal_ui`
- Commits on `claude/port-terminal-rust-wasm-ash37`:
  `16ccc76` (Phase A scaffold), `ccec35c` (Phase B + WASM shell),
  `47020de` (comprehensive tests), `9702566` (hot-path perf wins),
  `62f8732` / `8556b16` (Wave 1+2 — 16 panes), `dc93ac4` / `41c5b2a`
  (Wave 3 — 26 panes), `b859108` (React fork), `a334039` (deep-review
  hardening), `d3ef4b0` (stub removal).
