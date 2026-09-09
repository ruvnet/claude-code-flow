# ADR-382 — Init Scaffold Content Drift Remediation: Dead References, Unfulfilled Migrate Mitigation, Plugin Version Pinning, Marketplace Registry Gaps

**Status**: Proposed (2026-08-11)
**Date**: 2026-08-11
**Authors**: claude (drafted with rUv)
**Related**: ADR-128 (init bundle reduce and refactor — Phase 2 agent deletion), ADR-127 (GitHub stack modernization, CI-guard precedent), ADR-102 (supply-chain CI guards)
**Supersedes**: nothing — closes a mitigation gap ADR-128 documented but never implemented, and covers scaffold-content drift ADR-128 did not scope

## Context

An independent investigation of `ruflo`'s two install tracks — `npm install` (pinned, versioned tarball) vs. the Claude Code marketplace plugin (`npx -y @claude-flow/cli@latest`, always-latest) — surfaced four concrete, independently-verified defects in the shipped scaffold content and its remediation tooling. All four were re-verified directly against `main` at HEAD (commit range through `4ac1ab9ff`, v3.37.0) before this ADR was written; none rely on the third-party report's own numbers, which were measured against an earlier tag.

### Gap 1: ADR-128's own promised mitigation was never implemented

ADR-128 Phase 2 deleted 9 forked agent files from `v3/@claude-flow/cli/.claude/agents/` (`coder.md`, `researcher.md`, `reviewer.md`, `tester.md`, `memory-specialist.md`, `security-auditor.md`, `sparc-orchestrator.md`, `goal-planner.md`, `adr-architect.md`), making each plugin (`ruflo-core`, `ruflo-testgen`, `ruflo-rag-memory`, `ruflo-security-audit`, `ruflo-sparc`, `ruflo-goals`, `ruflo-adr`) the sole canonical source. That phase has landed — `ls v3/@claude-flow/cli/.claude/agents/ | grep -E 'coder|researcher|reviewer|tester'` returns nothing today.

ADR-128's own Consequences section (line 222) flagged the risk and named the fix: *"Mitigation: `ruflo migrate` should detect removed agents and print install suggestions."* `v3/@claude-flow/cli/src/commands/migrate.ts` (783 lines, read in full) implements `status`/`run`/`verify`/`rollback`/`breaking` subcommands — all scoped to the unrelated v2-config-format migration (`claude-flow.config.json` → `.claude-flow/config.json`, `swarm.mode` → `swarm.topology`, etc.). None of the five subcommands references agent files, `AGENTS_MAP`, or plugin install suggestions. A user who ran `ruflo init` before ADR-128 Phase 2 landed, then upgrades, silently loses `coder.md`/`researcher.md`/`reviewer.md`/`tester.md` with no CLI-surfaced signal and no suggested remediation — the exact failure mode ADR-128 itself called out as needing mitigation.

### Gap 2: Bundled scaffold content references dead CLI and MCP-tool forms

Content inside `v3/@claude-flow/cli/.claude/` (the directory shipped verbatim in the npm tarball per `package.json`'s `files` array) references two forms that no longer match the current surface:

- `grep -rl 'npx claude-flow' v3/@claude-flow/cli/.claude | wc -l` → **172 files**. The current canonical invocation form used elsewhere in this same tree is `npx @claude-flow/cli@latest` / `npx ruflo@latest`.
- `grep -rlE 'sparc_mode|task_orchestrate|memory_usage' v3/@claude-flow/cli/.claude | wc -l` → **96 files**. These MCP tool names do not appear in the current `mcp__claude-flow__*` tool registry (confirmed against the live tool list this session: no `sparc_mode`, `task_orchestrate`, or `memory_usage` — the closest live equivalents are `swarm_init`+`agent_spawn` for orchestration and `memory_store`/`memory_retrieve`/`memory_list`/`memory_delete` for the old catch-all `memory_usage`).

A fresh `ruflo init` therefore ships hundreds of files whose worked examples silently fail if a user copies them verbatim — the CLI invocation is stale and the referenced tools don't exist. This is a content-repair problem, not a defaults problem: the six command groups these files live under (`analysis`, `automation`, `github`, `monitoring`, `optimization`, `sparc`) are deliberately `true` by ADR-128 Phase 3's own policy (core commands, substrate). Flipping those defaults would contradict ADR-128; the fix is to repair the content, not gate it further.

### Gap 3: The marketplace-plugin install track pins nothing

`plugins/ruflo-core/.mcp.json` (the MCP server definition installed when a user takes the marketplace-plugin path) is:

```json
{
  "mcpServers": {
    "ruflo": {
      "command": "npx",
      "args": ["-y", "@claude-flow/cli@latest"],
      "env": { "CLAUDE_FLOW_MCP_TRANSPORT": "stdio" }
    }
  }
}
```

`@latest` means every marketplace-plugin user's MCP server silently re-resolves to whatever is newest on the registry at each `npx` invocation — independent of, and frequently ahead of or behind, whatever version they may separately have `npm install`-ed. The two install tracks (`npm install @claude-flow/cli` pinned in `package.json` vs. this always-latest `npx` call) can and do diverge, and nothing in the plugin surfaces that divergence to the user.

`.claude/helpers/hook-handler.cjs`'s `resolveCliBinForHook()` (lines 38–61) already solves an adjacent instance of this exact problem for the hook-refresh spawn path: it walks a local-bin-candidate list (`~/.claude/plugins/marketplaces/ruflo/bin/cli.js`, `node_modules/@claude-flow/cli/bin/cli.js`, `node_modules/ruflo/bin/cli.js`, `v3/@claude-flow/cli/bin/cli.js`), verifies `dist/src/index.js` exists alongside each candidate bin (guarding against the source-only marketplace checkout case, per the comment at lines 27–37), and only falls back to a bare `npx` call when no local candidate resolves. `plugins/ruflo-core/.mcp.json`'s launch path has no equivalent — it always takes the `npx @latest` branch.

### Gap 4: `.claude-plugin/marketplace.json` is missing 3 of 37 plugins

`plugins/` contains 37 entries (36 plugin directories + `README.md`). `.claude-plugin/marketplace.json` lists 35 plugins. Diffing the two: `ruflo-agntcy`, `ruflo-bbs-federation`, and `ruflo-business-pods` exist on disk and ship in the repo but are absent from the marketplace manifest, making them uninstallable via `ruflo plugins install <name>` / the marketplace UI despite being fully present in `plugins/`.

## Decision

Land a three-part remediation, following ADR-127/ADR-128's precedent of shipping each part as an independently runnable, independently mergeable artifact.

### Part A — Small, low-risk, immediately verifiable fixes

1. **Pin `plugins/ruflo-core/.mcp.json`**: replace the bare `npx -y @claude-flow/cli@latest` launch with a small resolver mirroring `resolveCliBinForHook()`'s candidate list and `dist/src/index.js` existence check, falling back to `npx @claude-flow/cli@latest` only when no local install resolves. This does not change behavior for a user with no local install; it stops silently overriding an explicit local `npm install` when one exists.
2. **Register the 3 missing plugins** in `.claude-plugin/marketplace.json` (`ruflo-agntcy`, `ruflo-bbs-federation`, `ruflo-business-pods`), matching the existing entry schema.
3. **Fix the stale example content directly attributable to this ADR's own investigation** (the specific dead-reference instances found while verifying Gaps 2–4, not a repo-wide sweep — that is Part C).

**Acceptance**: `plugins/ruflo-core/.mcp.json` resolves a local install when `node_modules/@claude-flow/cli` or the equivalent is present; falls back correctly otherwise (unit test, mirroring `hook-handler.cjs`'s existing coverage pattern). `python3 -c "import json; d=json.load(open('.claude-plugin/marketplace.json')); assert {'ruflo-agntcy','ruflo-bbs-federation','ruflo-business-pods'} <= {p['name'] for p in d['plugins']}"` passes.

### Part B — Implement ADR-128's promised `ruflo migrate` mitigation

Add agent-removal detection to `migrate.ts`, scoped narrowly to the 9 filenames ADR-128 Phase 2 named:

- New check (in `statusCommand` and as a new `breaking`-adjacent surface, not a new top-level subcommand — this extends existing output rather than adding surface area): for each of the 9 basenames, if a project's local `.claude/agents/**/*.md` (or the equivalent init-created path) references or expects one of them and the corresponding plugin is not installed (no `plugins/<owner-plugin>` marker in the project's plugin manifest), print a table mapping the missing agent to its owning plugin and the exact `ruflo plugins install <plugin>` command to restore it. Mirror the existing `formatMigrationStatus` / `printTable` patterns already in the file — no new output framework.
- Table data source: the same 9-row mapping ADR-128 §"Gap 2" documents (`coder.md`→`ruflo-core`, `tester.md`→`ruflo-testgen`, `memory-specialist.md`→`ruflo-rag-memory`, `security-auditor.md`→`ruflo-security-audit`, `sparc-orchestrator.md`→`ruflo-sparc`, `goal-planner.md`→`ruflo-goals`, `adr-architect.md`→`ruflo-adr`), inlined as a small constant — no new config file.

**Acceptance**: a project with a pre-Phase-2 init snapshot (no `ruflo-core` etc. installed, agent files absent) run through `ruflo migrate status` surfaces the 9-agent gap and the install command for each. Test added under `v3/@claude-flow/cli/__tests__/`, following the existing `migrate.ts` test conventions (if none exist yet, follow the `daemon-autostart.test.ts` pattern per prior-session precedent).

### Part C — CI guard first, then deterministic content remap

Before any bulk rewrite of the 172/96 flagged files, ship the guard that makes the problem mechanically detectable and prevents regression:

1. **`scripts/smoke-init-scaffold-references.mjs`** (new, follows the `smoke-deprecated-actions.mjs` / `smoke-init-bundle-dedup.mjs` static-scan pattern — zero runtime deps beyond Node built-ins):
   - Derives the live MCP tool name set from the built tool registry (not hand-maintained) and the live CLI subcommand set from the CLI's own command tree, at scan time.
   - Scans `v3/@claude-flow/cli/.claude/**/*.md` for `npx claude-flow` (flag: superseded by `npx @claude-flow/cli@latest` / `npx ruflo@latest`) and for any `<tool>_<verb>`-shaped MCP tool reference not present in the derived live tool set.
   - Exits non-zero with the offending file list on any match; run in warn-only mode until Part C's rewrite lands, then flipped to blocking.
2. **Deterministic remap only** for content fixes: apply the guard's failure list to make findings actionable. Only rewrite references that have an unambiguous 1:1 or documented 1:N successor (e.g. `memory_usage` → `memory_store`/`memory_retrieve`/`memory_list`/`memory_delete` per call-site context, `task_orchestrate` → `swarm_init`+`agent_spawn`, `npx claude-flow` → `npx @claude-flow/cli@latest`). Verify every remap target actually exists in the live tool/command registry before applying — do not guess.
3. **No-successor cases** (e.g. `sparc_mode`, if no live equivalent exists) get an inline `<!-- FLAG: no current equivalent, needs author review -->` comment or are deleted if the surrounding example is entirely obsolete — never silently guessed at.
4. If the FLAG surface after the deterministic pass is large, ship the guard **warn-only** plus the deterministic subset in this ADR's scope, and track the FLAGged remainder as follow-up work rather than blocking on a full hand-authored rewrite of all 268 flagged files in one PR.

**Acceptance**: `node scripts/smoke-init-scaffold-references.mjs` runs in CI (new job gated on `v3/@claude-flow/cli/.claude/**` path filter, following ADR-128 Phase 5's `v3-ci.yml` wiring). Deterministic-remap file count is reported in the PR description; any FLAGged remainder is enumerated, not silently dropped.

## Why this shape

- Part A is connect-the-existing-pieces work: `resolveCliBinForHook()` already exists and already solves this exact resolution problem elsewhere in the same file tree; reuse it rather than inventing a second resolver. The marketplace-registration fix is a 3-line JSON addition matching an existing schema.
- Part B applies ADR-128's own stated mitigation plan verbatim — this ADR does not redesign that mitigation, it implements the one already agreed and documented.
- Part C follows ADR-102/ADR-127/ADR-128 Phase 5's proven guard-before-rewrite discipline: land the detector so drift cannot silently reoccur, then let the detector's own output drive the mechanical fix rather than a manually-curated file list that will be stale before it's finished.

## Consequences

### Positive
- Closes a real, user-facing silent-data-loss gap: upgrading past ADR-128 Phase 2 currently removes 4 commonly-used core agents with zero CLI signal.
- Removes the primary source of npm-track vs. marketplace-track version divergence for the MCP server launch path.
- Makes scaffold-content staleness mechanically detectable going forward instead of relying on periodic manual audits.
- Restores 3 already-built, already-shipped plugins to installability with a 3-line change.

### Negative / trade-offs
- Part C's guard, if flipped to blocking before the deterministic remap lands, will fail CI on the existing 268 flagged files — sequencing (warn-only first) is load-bearing, not optional.
- Part B adds an agent-removal-detection code path to `migrate.ts` that must be kept in sync if a future ADR deletes more forked agents; it is not a general framework, it is the specific 9-row fix ADR-128 named.
- The content remap in Part C touches up to 172+96 files; even with a guard-driven deterministic pass, this is the largest-surface-area part of this ADR and should not be rushed into a single PR alongside Parts A/B.

### Neutral
- This ADR does not revisit ADR-128 Phase 4 (the `agents.all: false` default flip) or propose changing which command groups default on — both remain as ADR-128 specified.

## Implementation Plan

| Part | Files changed | Estimated size | Dependency |
|---|---|---:|---|
| A — .mcp.json pin + marketplace registration + spot fixes | `plugins/ruflo-core/.mcp.json`, `.claude-plugin/marketplace.json`, small set of doc files | small | none |
| B — migrate.ts agent-removal detection | `v3/@claude-flow/cli/src/commands/migrate.ts` + new test file | small–medium | none |
| C — scaffold-reference guard + deterministic remap | `scripts/smoke-init-scaffold-references.mjs` (new), `v3-ci.yml`, deterministic subset of the 268 flagged `.claude/**` files | medium–large | none (independent of A/B) |

Net-new work deferred to a separate issue: hand-review and rewrite of any FLAGged (no-successor) content Part C's guard surfaces but does not auto-remap.
