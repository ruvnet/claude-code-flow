#!/usr/bin/env bash
set -euo pipefail

# Build the Aperture WASM artifact and stage it for the SvelteKit host.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$HERE/../../aperture"
OUT="$HERE/dist/wasm"

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "error: wasm-pack not found. install with: cargo install wasm-pack" >&2
  exit 1
fi

mkdir -p "$OUT"
( cd "$WORKSPACE" && wasm-pack build crates/aperture-wasm --target web --out-dir "$OUT" )
echo "ok: aperture wasm staged at $OUT"
