#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$HERE/../../aperture"

echo "[smoke] cargo test"
( cd "$WORKSPACE" && cargo test --workspace --quiet )

echo "[smoke] naming gate"
# NOTICE.md, this script, and naming_gate.rs intentionally reference the banned
# tokens (NOTICE documents the inspiration; the gate itself + the in-source test
# must contain them to test for them). Everything else must be vendor-neutral.
GATE_RE='b''l''o''o''mberg|b''p''i''p''e|^b''l''p\b|f''i''n''msg'
if rg -i "$GATE_RE" "$WORKSPACE" "$HERE" \
     --glob '!target/**' --glob '!dist/**' --glob '!*.lock' \
     --glob '!NOTICE.md' --glob '!scripts/smoke.sh' \
     --glob '!**/naming_gate.rs' >/dev/null; then
  echo "naming gate failed: vendor token present" >&2
  rg -i "$GATE_RE" "$WORKSPACE" "$HERE" \
     --glob '!target/**' --glob '!dist/**' --glob '!*.lock' \
     --glob '!NOTICE.md' --glob '!scripts/smoke.sh' \
     --glob '!**/naming_gate.rs' >&2
  exit 1
fi

echo "[smoke] no-stub-text gate"
# After the StubDataSource → MemoryDataSource rename and Oracle pane behavioral
# fix, no source file should ship the literal "(stub)" placeholder text in
# user-visible strings. The gate itself contains the literal so excludes it.
STUB_RE='\(stub\)'
if rg -F "$STUB_RE" "$WORKSPACE" "$HERE" \
     --glob '!target/**' --glob '!dist/**' --glob '!*.lock' \
     --glob '!**/smoke.sh' >/dev/null; then
  echo "no-stub-text gate failed: '(stub)' marker present" >&2
  rg -F "$STUB_RE" "$WORKSPACE" "$HERE" \
     --glob '!target/**' --glob '!dist/**' --glob '!*.lock' \
     --glob '!**/smoke.sh' >&2
  exit 1
fi

echo "[smoke] wasm-pack build (optional)"
if command -v wasm-pack >/dev/null 2>&1; then
  WASM_OUT="/tmp/aperture-wasm-smoke"
  rm -rf "$WASM_OUT"
  ( cd "$WORKSPACE" && wasm-pack build crates/aperture-wasm --target web --out-dir "$WASM_OUT" --dev )
  echo "[smoke] wasm artifact at $WASM_OUT"
else
  echo "[smoke] wasm-pack not found — skipping wasm build (install with: cargo install wasm-pack)"
fi

echo "[smoke] ok"
