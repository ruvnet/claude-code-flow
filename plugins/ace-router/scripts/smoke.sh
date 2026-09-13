#!/usr/bin/env bash
# ACE Router plugin structural verification

set -euo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0

check() {
  local desc="$1"
  local result="$2"
  if [ "$result" = "ok" ]; then
    echo "  PASS  $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $desc"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "ACE Router — Smoke Test"
echo "========================"

# 1. plugin.json exists
[ -f "$BASE/.claude-plugin/plugin.json" ] && R="ok" || R="fail"
check "plugin.json exists" "$R"

# 2. plugin.json is valid JSON
node -e "var d='';process.stdin.on('data',function(c){d+=c});process.stdin.on('end',function(){JSON.parse(d)})" < "$BASE/.claude-plugin/plugin.json" 2>/dev/null && R="ok" || R="fail"
check "plugin.json is valid JSON" "$R"

# 3. All 3 agent files present
agents=(command-agent task-agent notion-agent)
all=ok
for a in "${agents[@]}"; do
  [ -f "$BASE/agents/$a.md" ] || all=fail
done
check "All 3 agent files present" "$all"

# 4. All agents have model field
all=ok
for a in command-agent task-agent notion-agent; do
  grep -q "^model:" "$BASE/agents/$a.md" 2>/dev/null || all=fail
done
check "All agents have model field" "$all"

# 5. All 4 skill SKILL.md files present
skills=(ace ace-route ace-brief ace-task)
all=ok
for s in "${skills[@]}"; do
  [ -f "$BASE/skills/$s/SKILL.md" ] || all=fail
done
check "All 4 skill SKILL.md files present" "$all"

# 6. All skills have name in frontmatter
all=ok
for s in ace ace-route ace-brief ace-task; do
  grep -q "^name:" "$BASE/skills/$s/SKILL.md" 2>/dev/null || all=fail
done
check "All skills have name in frontmatter" "$all"

# 7. All skills have description in frontmatter
all=ok
for s in ace ace-route ace-brief ace-task; do
  grep -q "^description:" "$BASE/skills/$s/SKILL.md" 2>/dev/null || all=fail
done
check "All skills have description in frontmatter" "$all"

# 8. All skills have allowed-tools in frontmatter
all=ok
for s in ace ace-route ace-brief ace-task; do
  grep -q "^allowed-tools" "$BASE/skills/$s/SKILL.md" 2>/dev/null || all=fail
done
check "All skills have allowed-tools in frontmatter" "$all"

# 9. Both command files present
[ -f "$BASE/commands/ace.md" ] && [ -f "$BASE/commands/ace-route.md" ] && R="ok" || R="fail"
check "Both command files present" "$R"

# 10. README.md exists
[ -f "$BASE/README.md" ] && R="ok" || R="fail"
check "README.md exists" "$R"

echo ""
echo "Results: $PASS passed, $FAIL failed"
echo ""
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
