# Aperture

Polymorphic, vendor-neutral market workspace. A multi-pane terminal UI driven by a
`SYMBOL VERB GO` command grammar, where each pane is a swarm agent that talks over
the ruflo `Message` bus. Compiles to a native ratatui binary and to WASM (ratzilla)
for the browser.

## Crates

| Crate | Role |
|---|---|
| `aperture-core` | Command AST + grammar + state types |
| `aperture-render` | Backend-agnostic `Pane` + `Widget` traits |
| `aperture-swarm` | Wire envelope mirroring `v3/@claude-flow/swarm` `Message` |
| `aperture-data` | `DataSource` + `KeyValueStore` traits + in-memory provider |
| `aperture-tui` | Native binary (ratatui + tokio) |
| `aperture-wasm` | Browser entry (wasm-bindgen) |

## Verbs (v0.1)

`HELP`, `CLS`, `EXIT`, `DESC`, `CHART`, `WATCH`, `UNWATCH`, `LIST`, `ASK`.

Form: `SYMBOL VERB [ARGS...] GO` — e.g. `AAPL CHART 6M GO`.

## Build

```
cargo check --workspace
cargo test  --workspace
cargo run -p aperture-tui -- --provider=memory
```
