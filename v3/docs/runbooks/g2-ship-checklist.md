# ADR-095 G2 Ship Checklist

**Owner**: whoever closes out ADR-095 G2 from upstream `ruvnet/ruflo` (formerly `ruvnet/claude-flow`).
**Scope**: closes the line in `docs/adr/ADR-095-architectural-gaps-from-april-audit.md` lines 196–199 ("Remaining for G2").
**Authored from**: local branch `docs/adr-095-g2-cross-host-runbook` against repo `C:/Users/costa/Projects/claude-flow/v3/` (no upstream write access from here).
**Date**: 2026-05-18.

---

## 1. PR #1905 — current status

| Field | Value |
|---|---|
| Title | `feat(swarm): ADR-095 G2 — pluggable ConsensusTransport + Ed25519 message signing (step 1)` |
| Number | 1905 |
| Head | `feat/adr-095-g2-hive-mind-ws-transport` |
| Base | `main` |
| State | **MERGED** (2026-05-11T13:52:47Z) |
| Review decision | empty (merged by maintainer; no formal review block recorded) |
| CI summary | All required checks **SUCCESS** (Test V3 Packages, Build V3 ubuntu/macos/windows, MCP smoke, Plugin hooks smoke, Witness verify, Integration tests, Security & Code Quality, Verification Pipeline). Only `Deploy & Release` and `Publish to npm (alpha)` are `SKIPPED` — those are conditional jobs that fire on tagged release commits, not on merge. |
| URL | https://github.com/ruvnet/ruflo/pull/1905 |

**Source of truth for the query**: `gh pr view 1905 --repo ruvnet/claude-flow --json state,mergeable,statusCheckRollup,reviewDecision` (the `ruvnet/claude-flow` slug redirects to `ruvnet/ruflo` — the repo was renamed; gh follows the redirect transparently).

**Blockers from #1905 itself**: none. The PR is in; the code is on `main`; CI was green.

**Verification on our local clone**: `git log --oneline -10` on the v3 working tree shows `cffa55744 chore(release): 3.7.0-alpha.27 — ships managed_agent_* (ADR-115) + ruflo-wasm→ruflo-agent (#1934)` — i.e. main has already shipped two alpha cuts past the G2 merge (alpha.26 in #1924, alpha.27 in #1934). The transport code from #1905 is already inside published artifacts.

---

## 2. Outstanding G2 items after #1905

Pulled from `docs/adr/ADR-095-architectural-gaps-from-april-audit.md:196-199`:

> Remaining for G2:
> - Failure-injection tests (f<n/3 for BFT, f<n/2 for Raft) — drive a multi-node `LocalTransport` cluster with simulated faulty/silent nodes; assert correct commits below threshold, no incorrect commits above.
> - Cross-host validation (mac ↔ ruvultra over tailscale, root) once `FederationTransport` is wired into a real hive-mind + federation setup.
> - Build + publish; merge PR #1905.

Item 3 (PR #1905) is **done**. Items 1 and 2 are the real gate. They are tracked by the two sibling deliverables a parallel agent run is dropping into this same `docs/runbooks/` directory:

| Sibling artifact (expected path) | What it must contain to count as done |
|---|---|
| `docs/runbooks/g2-cross-host-runbook.md` | Reproducible mac ↔ ruvultra-over-tailscale procedure: keypair generation, `FederationTransport` peer config, hive-mind init across hosts, expected `RequestVote`/`AppendEntries` traffic, Ed25519 signature failure paths. **Currently empty / not yet authored** — the `docs/runbooks/` directory exists but contains no files at the time of this checklist's writing. |
| `docs/runbooks/g2-failure-injection-plan.md` | Test plan + executable harness pointer: a multi-node `LocalTransport` cluster spec that injects (a) silent nodes, (b) byzantine equivocation, (c) delayed/replayed messages; thresholds (f<n/3 BFT, f<n/2 Raft); assertions on commit correctness above/below threshold. **Currently empty / not yet authored.** |

**Cross-reference rule**: until both of those documents land AND their procedures have been executed and recorded, the ADR-095 status block's bullet "Cross-host validation … once `FederationTransport` is wired into a real hive-mind + federation setup" remains open. The check-in for completion of G2 is **all three** runbook docs present + a Markdown reference back from ADR-095's "Remaining for G2" section to this checklist.

Other G2-adjacent CI evidence already in tree (so the failure-injection plan doesn't start from zero):

- `plugins/ruflo-core/scripts/test-consensus-transport.mjs` — the `mcp-roundtrip-smoke` job's transport guard. Asserts exports present, `LocalTransport` round-trip, real Ed25519 verify (no `return true` regression). Cited at `docs/adr/ADR-095…md:193`.
- BFT correctness landed: `f = floor((n-1)/3)` (clamped ≥1) derived from cluster size, no longer hardcoded to 1. Cited at `docs/adr/ADR-095…md:192`.
- All three protocols (Raft, Byzantine, Gossip) accept an injected `transport` and preserve the legacy no-transport code path. Cited at `docs/adr/ADR-095…md:191`.
- 210/210 swarm suite green (+28 new tests across transport/byzantine/raft/federation/gossip). Cited at `docs/adr/ADR-095…md:194`.

---

## 3. Local branch decision — `docs/adr-095-g2-cross-host-runbook`

**Recommendation: (b) keep local-only and (c) delete after the runbook docs land in a follow-up PR.** Do **not** open a PR upstream from this branch as-is. Reasoning:

- `git log origin/main..HEAD --oneline` is empty — the branch contains **zero commits** beyond `main`. It is a working-tree scratch branch where this checklist and the two sibling runbooks are being authored.
- We do not have write access to `ruvnet/ruflo`. Any upstreaming has to happen as a regular contributor fork-and-PR, not from this clone.
- The three runbook docs (this file + the two sibling files) belong upstream — they fill in a line ADR-095 itself owns. But the right shape for that contribution is one PR from a fork (`<user>/ruflo:docs/adr-095-g2-runbooks`) that adds all three files at once and edits the ADR's `Remaining for G2` section to link them. **Not** this 0-commit local branch.

**Action sequence** (for the human closing this out):
1. Wait until both sibling runbook docs land in `docs/runbooks/`.
2. Cherry-pick / `git mv` the three files onto a fork-tracking branch (e.g. `git checkout -b docs/adr-095-g2-runbooks origin/main`, then `git restore --source=docs/adr-095-g2-cross-host-runbook -- docs/runbooks/`).
3. Edit `docs/adr/ADR-095-architectural-gaps-from-april-audit.md` "Remaining for G2" to link the three runbooks and mark items 1 and 2 done once they've actually been executed (not just documented).
4. Open the PR against `ruvnet/ruflo:main` from your fork.
5. **Delete** `docs/adr-095-g2-cross-host-runbook` locally after the PR lands: `git branch -D docs/adr-095-g2-cross-host-runbook`. It has no upstream tracking ref and serves no further purpose.

---

## 4. Build + publish checklist

**Read this first.** The v3 monorepo has two release flows. They look similar but ship different artifacts.

### 4.1 Current published version

- Workspace root `package.json:3` is pinned at `3.0.0-alpha.1` — this is the monorepo aggregator, not what users install.
- The **actually-published artifact** is `@claude-flow/cli`. Its `package.json:3` reads `"version": "3.7.0-alpha.27"`. That's what users get from `npm install claude-flow@alpha` (it re-publishes under the unscoped name `claude-flow`).
- Most recent release commit: `cffa55744 chore(release): 3.7.0-alpha.27` (PR #1934).

### 4.2 Version bump rule for closing G2

The G2 transport code already shipped in `3.7.0-alpha.21` per the ADR status update, and the surrounding work (BFT correctness, federation wire) was rolled forward through alpha.22 → alpha.27. **Closing G2 does not by itself require a new publish** — the code is on registry.

However, if the runbook docs + a corrective ADR amendment land and you want a clean "G2 closed" version line:

- Bump rule: prerelease patch — `alpha.27 → alpha.28`. Do this from `@claude-flow/cli/package.json` only; the workspace root stays at `3.0.0-alpha.1` (per its `prepare-publish.js` convention).
- Use `npm version prerelease --preid=alpha` from inside `@claude-flow/cli/` (this is what the `release` script in that package's `package.json:90` does).
- For a docs-only close, the alternative is **no version bump** — just merge the docs PR and let the next regular release pick it up. This is the lighter-weight path and what I recommend for closing G2 specifically.

### 4.3 Publish commands

The canonical script is `@claude-flow/cli/scripts/publish.sh`. From a clean checkout on `main` with all builds green:

```bash
# 1. Confirm npm auth
npm whoami

# 2. Build from repo root
cd v3 && pnpm install && pnpm -r build

# 3. From @claude-flow/cli, publish both @claude-flow/cli@alpha AND claude-flow@v3alpha
cd @claude-flow/cli && ./scripts/publish.sh
```

What `publish.sh` does (lines 16–48):
1. Reads the version from `@claude-flow/cli/package.json`.
2. `npm publish --tag alpha` for `@claude-flow/cli`.
3. Copies `dist/ bin/ src/ package.json README.md` to a temp dir, rewrites the name to unscoped `claude-flow`, runs `npm publish --tag v3alpha`.
4. Tags both packages with `alpha`, `latest`, `v3alpha` dist-tags.

There is **no separate** root-level `npm run release`. The root has `publish:dry` / `publish:v3alpha` (`package.json:31-32`) but those use `pnpm --filter claude-flow publish` — which expects a `claude-flow` workspace pkg that the v3 layout does **not** ship (`v3/claude-flow/` does not exist). Treat the root scripts as legacy; the live path is `@claude-flow/cli/scripts/publish.sh`.

### 4.4 Changelog entry template

Append below the latest release header in `CHANGELOG.md`:

```markdown
## [3.7.0-alpha.28] - YYYY-MM-DD

### Documentation
- ADR-095 G2 closeout: cross-host runbook (`docs/runbooks/g2-cross-host-runbook.md`),
  failure-injection plan (`docs/runbooks/g2-failure-injection-plan.md`), and ship
  checklist (`docs/runbooks/g2-ship-checklist.md`). Marks G2's "Remaining" bullets
  as documented + validated. No runtime changes.
```

For a docs-only close with no version bump, instead add a dated entry under the most recent release's existing "Documentation" subsection (if present) and skip the version header.

### 4.5 Smoke tests (post-publish)

Run these from a clean directory after publish completes:

```bash
# 1. Install resolves
npm view claude-flow@v3alpha version          # should print 3.7.0-alpha.28
npm view @claude-flow/cli@alpha version       # should print the same

# 2. Binary runs
npx claude-flow@v3alpha --version

# 3. MCP smoke (locally)
cd v3 && pnpm test:integration:mcp

# 4. Consensus transport guard (mirrors the CI check from PR #1905)
node plugins/ruflo-core/scripts/test-consensus-transport.mjs
```

If any of those fail, **do not** add `latest` dist-tag to the new version; `npm dist-tag rm claude-flow latest` if it was already set, leaving alpha.27 as the resolved `latest` until the issue is fixed.

---

## 5. Sign-off criteria — G2 is DONE when…

Greppable checklist. Future audits should `grep -n 'G2-DONE-' docs/runbooks/g2-ship-checklist.md` to find these.

- [ ] **G2-DONE-1**: PR #1905 is MERGED (already true — 2026-05-11).
- [ ] **G2-DONE-2**: `docs/runbooks/g2-failure-injection-plan.md` exists, names f<n/3 (BFT) + f<n/2 (Raft) thresholds explicitly, and points to an executable harness (script path or vitest file) that drives a multi-node `LocalTransport` cluster.
- [ ] **G2-DONE-3**: The failure-injection harness has been **executed** at least once (not just authored). Evidence: a CI run URL or local-run log captured inside the runbook.
- [ ] **G2-DONE-4**: `docs/runbooks/g2-cross-host-runbook.md` exists and documents a reproducible mac ↔ ruvultra-over-tailscale procedure for `FederationTransport`, including the Ed25519 keypair generation step and the expected message-signing failure mode if a peer's pubkey is wrong.
- [ ] **G2-DONE-5**: The cross-host procedure has been **executed** at least once between two distinct hosts (not localhost-as-two-peers). Evidence: a capture of `RequestVote` traffic crossing the wire, or a screenshot of two nodes converging on the same Raft term from different IPs.
- [ ] **G2-DONE-6**: `docs/adr/ADR-095-architectural-gaps-from-april-audit.md` has been amended: the "Remaining for G2" block at lines 196–199 either links to the runbook docs and marks each bullet done, or — if this is the closing PR — moves the whole G2 subsection from "in progress" to a new "G2 — RESOLVED" subsection styled to match G1/G3/G4/G6's REMEDIATED entries.
- [ ] **G2-DONE-7**: An npm publish has shipped the consolidated docs to the registry (either as alpha.28 or rolled into a later release commit's notes), OR a deliberate decision has been recorded in this checklist that the close is docs-only and no version bump is required.

When all seven boxes are checked, G2 is closed. Any audit re-opening one of these bullets without checking another evidence box re-opens G2.

---

## Appendix — files cited

- `docs/adr/ADR-095-architectural-gaps-from-april-audit.md` (lines 149–213 — Status update + Remaining for G2)
- `package.json` (workspace root, lines 31–41 — publish scripts; line 3 — aggregator version)
- `@claude-flow/cli/package.json` (line 3 — `3.7.0-alpha.27`; lines 83–92 — release scripts; lines 126–129 — publishConfig)
- `@claude-flow/cli/scripts/publish.sh` (lines 1–58 — canonical publish flow)
- `scripts/prepare-publish.js` (lines 16–17 — legacy version constants; treat as legacy)
- `CHANGELOG.md` (top of file — Keep-a-Changelog format)
- `plugins/ruflo-core/scripts/test-consensus-transport.mjs` (CI guard installed by PR #1905; cited by ADR-095:193)

**Sibling docs expected in this directory** (parallel-agent authored, not yet present at the time of writing):

- `docs/runbooks/g2-cross-host-runbook.md`
- `docs/runbooks/g2-failure-injection-plan.md`
