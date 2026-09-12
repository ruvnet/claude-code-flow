#!/usr/bin/env bash
# Structural smoke test for ruflo-core v0.2.7 (ADR-0001).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
step() { printf "→ %s ... " "$1"; }
ok()   { printf "PASS\n"; PASS=$((PASS+1)); }
bad()  { printf "FAIL: %s\n" "$1"; FAIL=$((FAIL+1)); }

step "1. plugin.json declares 0.2.7 with new keywords"
v=$(grep -E '"version"' "$ROOT/.claude-plugin/plugin.json" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if [[ "$v" != "0.2.7" ]]; then
  bad "expected 0.2.7, got '$v'"
else
  miss=""
  for k in foundation mcp-server plugin-catalog discovery; do
    grep -q "\"$k\"" "$ROOT/.claude-plugin/plugin.json" || miss="$miss $k"
  done
  [[ -z "$miss" ]] && ok || bad "missing keywords:$miss"
fi

step "2. .mcp.json registers ruflo and hook shims never spawn private Ruflo"
F="$ROOT/.mcp.json"
if [[ -f "$F" ]] && grep -q '"ruflo"' "$F" && grep -q '"command"' "$F" \
  && ! grep -q 'ruflo@latest' "$ROOT/scripts/ruflo-hook.sh" "$ROOT/scripts/ruflo-hook.cjs"; then
  ok
else
  bad ".mcp.json missing, no ruflo server registration, or a hook shim can spawn private Ruflo"
fi

step "3. all 4 agents present with valid frontmatter"
miss=""
for a in coder researcher reviewer witness-curator; do
  f="$ROOT/agents/$a.md"
  [[ -f "$f" ]] || { miss="$miss missing-$a"; continue; }
  for k in 'name:' 'description:'; do
    grep -q "^$k" "$f" || miss="$miss $a-no-$k"
  done
done
[[ -z "$miss" ]] && ok || bad "$miss"

step "4. all 5 skills present with valid frontmatter"
miss=""
for s in init-project ruflo-doctor ruflo-status discover-plugins witness; do
  f="$ROOT/skills/$s/SKILL.md"
  [[ -f "$f" ]] || { miss="$miss missing-$s"; continue; }
  for k in 'name:' 'description:' 'allowed-tools:'; do
    grep -q "^$k" "$f" || miss="$miss $s-no-$k"
  done
done
[[ -z "$miss" ]] && ok || bad "$miss"

step "5. discover-plugins catalog references at least 25 sibling plugins"
F="$ROOT/skills/discover-plugins/SKILL.md"
n=$(grep -oE 'ruflo-[a-z-]+' "$F" | sort -u | wc -l | tr -d ' ')
if [[ $n -ge 25 ]]; then
  ok
else
  bad "expected ≥25 distinct ruflo-* references, got $n"
fi

step "6. README pins @claude-flow/cli to v3.6"
grep -qE "@claude-flow/cli.*v3\.6|v3\.6.*claude-flow/cli" "$ROOT/README.md" \
  && ok || bad "Compatibility pin to v3.6 missing"

step "7. README cross-references sibling contracts"
F="$ROOT/README.md"
miss=""
grep -q "Namespace convention" "$F" || miss="$miss namespace"
grep -qE "3-gate|3 gates|three gates" "$F" || miss="$miss 3-gate"
grep -qE "4-step|4 step" "$F" || miss="$miss 4-step"
[[ -z "$miss" ]] && ok || bad "missing cross-references:$miss"

step "8. ADR-0001 exists with status Accepted"
ADR="$ROOT/docs/adrs/0001-core-contract.md"
[[ -f "$ADR" ]] && grep -qE "^status:[[:space:]]*Accepted" "$ADR" \
  && ok || bad "ADR missing or status != Accepted"

step "9. /ruflo-status command invokes doctor + status"
F="$ROOT/commands/ruflo-status.md"
if grep -q "doctor" "$F" && grep -q "status" "$F"; then
  ok
else
  bad "ruflo-status command missing doctor/status invocation"
fi

step "10. no wildcard tool grants in skills"
bad_skills=""
for f in "$ROOT"/skills/*/SKILL.md; do
  grep -q '^allowed-tools:[[:space:]]*\*' "$f" && bad_skills="$bad_skills $(basename $(dirname "$f"))"
done
[[ -z "$bad_skills" ]] && ok || bad "wildcard:$bad_skills"

step "11. every Claude command has a same-name Codex skill"
miss=""
# Explicit exemptions must be recorded here as "command: reason". None exist.
command_skill_exemptions=()
for command_file in "$ROOT"/commands/*.md; do
  command_name="$(basename "$command_file" .md)"
  [[ -f "$ROOT/skills/$command_name/SKILL.md" ]] && continue
  exempt=""
  for entry in "${command_skill_exemptions[@]}"; do
    [[ "$entry" == "$command_name: "* ]] && exempt="$entry"
  done
  [[ -n "$exempt" ]] || miss="$miss $command_name"
done
[[ -z "$miss" ]] && ok || bad "commands missing same-name skills:$miss"

printf "\n%s passed, %s failed\n" "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
