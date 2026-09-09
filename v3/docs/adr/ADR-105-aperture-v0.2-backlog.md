# ADR-105: Aperture v0.2 Architecture Backlog

**Status**: Proposed
**Date**: 2026-05-10
**Version**: targets aperture@0.2.0 / ruflo-aperture@0.2.0
**Related**: ADR-104 (Aperture pane-as-agent swarm)

## Context

ADR-104 records the architecture that landed across commits
`16ccc76 → 9f6f3d4` on `claude/port-terminal-rust-wasm-ash37`: 6 Rust
crates, 26 panes, 220 passing tests, three execution shells, polymorphic
naming, MemoryDataSource as the offline provider, the hardening pass from
the deep-review swarm.

ADR-104's "Negative / accepted" and "Open issues tracked" sections list
six follow-ups that were explicitly deferred from v0.1. Each is large
enough to deserve its own design space and its own commit boundary. This
ADR records them as Proposed so future contributors have a concrete
target for the v0.2 milestone instead of free-floating commit-message
trailers.

The six items are independent — they can land in any order and the
v0.1 surface keeps working until each one lands. None of them block
shipping the current branch.

## Decisions (Proposed)

### 1. Split `DataSource` into five domain traits

**Why.** `aperture_data::DataSource` currently exposes 20 async methods.
Adding a new real provider (Yahoo / FRED / CoinGecko) means stubbing 18 of
them with `Err(Provider("not supported"))`. The default-method escape
hatch is real, but the type-level "this provider implements options
chains" signal is lost.

**Proposed shape.** Replace the single trait with five small traits, all
in `aperture-data`:

| Trait | Methods |
|---|---|
| `MarketData` | `quote`, `ohlcv`, `crypto_quote`, `fx_rates` |
| `Reference` | `financials`, `filings`, `corp_actions`, `index_members` |
| `Discovery` | `news`, `movers`, `screener`, `earnings_calendar`, `sentiment`, `macro_indicators`, `yield_curve` |
| `Derivatives` | `options_chain`, `vol_surface`, `technicals` |
| `Risk` | `risk_metrics`, `correlation_matrix`, `insider_trades` |

`MemoryDataSource` implements all five. Each pane depends on the trait
it actually needs (`pane.quote` takes `&dyn MarketData`, `pane.options`
takes `&dyn Derivatives`, etc.). A blanket `impl<T: MarketData +
Reference + …> DataSource for T` keeps the old composite name for
callers that want everything.

**Success criteria.**
- All 26 panes compile against narrower trait bounds.
- A toy real provider (e.g. `aperture-providers-yahoo` implementing only
  `MarketData`) demonstrates the opt-in.
- `cargo test --workspace` stays at 220 / 0 with no test changes (the
  composite blanket impl makes existing code work).

**Out of scope.** Renaming `MemoryDataSource`; introducing async iterators
for streaming responses; provider feature-detection at runtime.

### 2. Single-source pane registry via `build.rs` codegen

**Why.** The 26 pane ids are repeated in four places:

1. `aperture-tui/src/agent_runner/mod.rs` — `KNOWN_AGENTS` const + the
   `dispatch()` match table.
2. `aperture-wasm/src/shell_routing.rs` — the `Pane` enum.
3. `aperture-ui/src/lib/aperture/types.ts` — `PANE_ORDER` + the `Pane`
   string-union.
4. `ruflo/src/ruvocal/src/routes/aperture/+page.svelte` — `PANE_ORDER` +
   the `Pane` string-union.
5. `plugins/ruflo-aperture/.claude-plugin/plugin.json` — `agents` array.

Adding a new pane requires touching all five plus the `panes/mod.rs`
re-export.

**Proposed shape.** Author `aperture/spec/panes.toml`:

```toml
[[pane]]
id = "quote"
agent_id = "aperture:pane.quote"
title = "Quote"
hint = "AAPL DESC GO"
verbs = ["DESC"]
backed_by = "MarketData::quote"
```

Drive codegen at three points:
- Rust: `aperture/build.rs` reads `panes.toml`, emits
  `OUT_DIR/panes.rs` with `KNOWN_AGENTS`, the dispatch match, and the
  `Pane` enum. Included via `include!()`.
- TS/Svelte: a small Node script in `plugins/ruflo-aperture/scripts/`
  emits `aperture-ui/src/lib/aperture/panes.generated.ts` and
  `ruflo/src/ruvocal/src/routes/aperture/panes.generated.ts`.
- plugin.json: same Node script regenerates the `agents` array in
  `plugins/ruflo-aperture/.claude-plugin/plugin.json` (idempotent).

A CI step (extend `plugins/ruflo-aperture/scripts/smoke.sh`) runs the
codegen and `git diff --exit-code` to fail the build on stale generated
files.

**Success criteria.** Adding a new pane requires editing exactly two
files: `panes.toml` and the new `aperture-tui/src/agent_runner/panes/<id>.rs`.

**Out of scope.** Pane reordering through a runtime UI; per-host pane
visibility flags.

### 3. Real data providers behind cargo features

**Why.** v0.1 ships only `MemoryDataSource`. Live workflows need actual
quotes. The trait split (item 1) is a prerequisite so providers don't
ship dead methods.

**Proposed shape.** Sibling crates under `aperture/crates/`:

| Crate | Implements | Network dep |
|---|---|---|
| `aperture-providers-yahoo` | `MarketData` | `reqwest` |
| `aperture-providers-fred` | `Discovery` (macro + yields) | `reqwest` |
| `aperture-providers-coingecko` | `MarketData` (crypto only) | `reqwest` |
| `aperture-providers-sec-edgar` | `Reference` (filings) | `reqwest` |
| `aperture-providers-binance` | `MarketData` (crypto + fx) | `reqwest` + `tokio-tungstenite` |
| `aperture-providers-alphavantage` | `Discovery` (earnings + sentiment) | `reqwest` |

Each provider is **opt-in** via a workspace feature: `cargo build
-p aperture-tui --features providers-yahoo,providers-fred`. The default
build stays offline-only.

API keys are read from the environment at startup; the WASM target never
sees them — providers are native-only, and the WASM shell continues to
route requests through the SvelteKit proxy (which already has its
HTTPS-only / hostname-allowlist hardening from ADR-104).

**Success criteria.**
- `cargo build -p aperture-tui` with no features compiles offline.
- Each provider has at least one integration test gated behind
  `#[ignore]` and a `--features <provider>` flag.
- `aperture-tui --provider=yahoo` swaps in the real source when the
  feature is on; otherwise the flag errors with a build-feature hint.

**Out of scope.** Caching layer, retry / circuit-breaker policy, provider
load-balancing.

### 4. CSP + `frame-ancestors` on SvelteKit `/aperture`

**Why.** ADR-104 landed origin pinning on `postMessage` and the inbound
listener. The browser also needs a Content-Security-Policy header that
forbids framing and tightens script/connect sources — defence in depth,
and the natural place to drop `'unsafe-eval'` for the wasm-bindgen
artifact (it needs `'wasm-unsafe-eval'` only).

**Proposed shape.** Add `ruflo/src/ruvocal/src/routes/aperture/+layout.server.ts`
(or `hooks.server.ts` scoped to `/aperture`) emitting:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval';
  connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self';
  form-action 'self'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
```

The React aperture-ui equivalent goes in its Vite dev config + a
`public/_headers` file for Netlify-style hosts.

**Success criteria.** Loading `/aperture` in an iframe is refused by the
browser; CSP report logs (when configured) show zero violations on the
happy path.

**Out of scope.** Subresource integrity for the wasm artifact (separate
hash pipeline); CSP nonce rotation per response.

### 5. Per-pane state caps

**Why.** Three unbounded growth sites are reachable from a malicious
inbound envelope (the security review flagged these as medium):

- `OrderPane::orders` — paper-trade blotter, no cap.
- `InboxPane::messages` — message mailbox, no cap.
- The host-side `log` array in both browser shells.

**Proposed shape.** Cap each at a sensible bound, FIFO-evict on overflow:

| Site | Cap | Eviction |
|---|---|---|
| `OrderPane::orders` | 10_000 | drop oldest |
| `InboxPane::messages` | 1_000 | drop oldest |
| Browser `log` array | 500 (currently uncapped) | drop oldest |

Each gets a unit test that pushes `cap + 1` and asserts length stays at
`cap`.

**Success criteria.** A pathological producer can't allocate more than
~10 MB of pane state regardless of envelope volume.

**Out of scope.** Persistent backing stores (sled / OPFS) — that's its
own ADR.

### 6. Oracle ↔ `ruflo-neural-trader` over the swarm bus

**Why.** `OraclePane::synthesize_answer()` is in-process keyword
routing. The real plan is to forward the prompt envelope to
`plugins/ruflo-neural-trader`, await its reply, and return the answer
through the same `ASK.RESULT` channel.

The blocker is the swarm coordinator: `aperture_swarm::Agent::handle()`
returns `Vec<Envelope>` synchronously, but a real-LLM round trip is
async w.r.t. a different agent. The coordinator (`unified-coordinator.ts`)
needs to expose an agent-to-agent request/response primitive that
preserves `correlation_id` and reschedules the awaiting handler.

**Proposed shape.** Two parts:

a) Extend `aperture_swarm::Agent` with a non-blocking forwarding helper:

```rust
pub trait Agent {
    fn id(&self) -> &str;
    async fn handle(&mut self, env: Envelope) -> Vec<Envelope>;
    // NEW — opt-in default:
    async fn awaits(&mut self) -> Vec<Pending> { Vec::new() }
}

pub struct Pending {
    pub correlation_id: String,
    pub awaiting_from: String,         // e.g. "ruflo:neural-trader"
    pub timeout_ms: u64,
    pub resume: Box<dyn FnOnce(Envelope) -> Vec<Envelope> + Send>,
}
```

The native runtime in `aperture_swarm::runtime::run_agent` polls
`awaits()` and bridges to the coordinator over stdio.

b) Update the coordinator binding in
`v3/@claude-flow/swarm/src/unified-coordinator.ts` to forward correlated
envelopes between agents and resolve `Pending` slots when the reply
arrives.

**Success criteria.**
- Integration test spawns `pane.oracle` + a mock `neural-trader` agent;
  ASK arrives at oracle, oracle forwards, mock replies, oracle returns
  the mock's text in `ASK.RESULT`.
- Timeout path is covered: mock doesn't reply within `timeout_ms`,
  oracle returns a degraded answer ("oracle timed out, falling back to
  in-process synthesis").

**Out of scope.** Streaming replies (token-at-a-time); multi-hop fan-out
where the oracle queries multiple LLMs and synthesises.

## Status

All six items are **Proposed**. They can land independently. Suggested
order: 1 → 2 → 3 (provider work depends on the trait split) and 4 → 5 →
6 in parallel.

Re-status each item to Accepted in its own follow-up commit when it
lands. Open one ADR per item if the design space turns out to be larger
than the sketch above (in particular, item 6 likely deserves its own
ADR for the coordinator-side primitives).

## References

- ADR-104 — the architecture this backlog flows from.
- `aperture/docs/PROTOCOL.md` — wire format the new traits must preserve.
- Deep-review findings (commit `a334039`) — origin pinning, SSRF guard,
  ORDER bounds; this ADR's items 4 + 5 are the medium-severity follow-ups
  the same review flagged.
- `plugins/ruflo-aperture/scripts/smoke.sh` — the gate that the codegen
  step in item 2 should extend.
