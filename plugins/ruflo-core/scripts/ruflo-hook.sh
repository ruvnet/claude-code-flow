#!/usr/bin/env bash
# ruflo-hook.sh — resilient invoker for ruflo CLI hook subcommands (#1921).
#
# Hooks fire on EVERY PreToolUse / PostToolUse / Stop. A bare
# `npx <pkg>@alpha hooks …` re-resolves the @alpha dist-tag and re-installs
# from cold cache on every fire, and when the install crashes (e.g. an
# arborist `Invalid Version` on npm 10.8.x) the user sees a hook error in
# Claude Code after every turn. This shim:
#   1. prefers the canonical global `~/.npm-global/bin/ruflo`, then an
#      already-installed `ruflo` / `claude-flow` binary on PATH;
#   2. never downloads or executes a private Ruflo through npx;
#   3. ALWAYS exits 0 — hook subcommands are best-effort telemetry/learning;
#      a failure must never surface an error or block a turn.
#
# stdin (the hook event JSON) is passed through to the CLI unchanged.
# Usage: ruflo-hook.sh <hook-subcommand> [args…]   (the literal `hooks`
# word is prepended here, so callers pass e.g. `post-edit -f "$FILE" -s true`).

# Swallow all diagnostics — nothing this script prints should reach the host.
# stdout is silenced too because Cursor (#2613) imports Claude Code hooks under
# its stricter `preToolUse` contract that requires valid-JSON stdout and
# fail-closes on any other text. Claude Code doesn't consume this stdout either,
# so redirecting it is a pure cleanup with no functional cost.
exec 1>/dev/null 2>/dev/null

# Bound every hook process. A partially initialized native embedding pool can
# otherwise keep a logically completed Stop hook alive indefinitely (#2691).
run() {
  "$@" &
  child=$!
  (
    sleep 15
    kill -TERM "$child" 2>/dev/null || true
    sleep 1
    kill -KILL "$child" 2>/dev/null || true
  ) &
  watchdog=$!
  wait "$child" 2>/dev/null || true
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
}

RUFLO_GLOBAL=""
if [[ -n "${HOME:-}" ]]; then
  RUFLO_GLOBAL="$HOME/.npm-global/bin/ruflo"
fi

if [[ -n "$RUFLO_GLOBAL" && -x "$RUFLO_GLOBAL" ]]; then
  run "$RUFLO_GLOBAL" hooks "$@"
elif command -v ruflo >/dev/null 2>&1; then
  run ruflo hooks "$@"
elif command -v claude-flow >/dev/null 2>&1; then
  run claude-flow hooks "$@"
fi

exit 0
