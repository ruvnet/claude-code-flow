# Security SOTA Report — 2026-09-11

TL;DR: Tonight's security deep-dive found a live, code-verified authentication gap in `hive-mind_consensus`'s vote-casting path (`v3/@claude-flow/cli/src/mcp-tools/hive-mind-tools.ts`): the `voterId` a caller supplies is recorded into `proposal.votes` and counted toward the quorum threshold with **zero check against `state.workers`** (the roster populated by `hive-mind_join`). A single caller can cross any consensus strategy's threshold — raft, bft, *and* quorum alike — by voting repeatedly under fabricated identities: a Sybil attack on consensus, not merely a double-vote. This is a materially worse bug than the already-known "consensus strategy is silently discarded" finding (2026-09-10): it means even a hypothetically-working BFT check would be cosmetic, since the vote-casting layer itself trusts caller-supplied identity unconditionally. Fixed with a one-line roster-membership guard, fail-closed. Stash-isolated baseline-fails/candidate-passes evidence, a full 3036-test suite run, and an independent adversarial critique (CONFIRMED-WITH-CAVEATS — the fix closes forged-*vote* Sybil but not forged-*join* Sybil, since `hive-mind_join`/`hive-mind_leave` carry no authentication at all) are below. Five research roles ran in parallel; the deep-research role ran unusually long (background-agent stall, recovered) but returned exceptionally rich results, including that ADR-377's own foundational arXiv citation was quietly withdrawn by its authors.

## What's New in 2026

| Finding | Source | Confidence |
|---|---|---|
| OWASP MCP Top 10 (2025), published 2026-06-24 — MCP02 Scope-Creep Privilege Escalation, MCP07 Insufficient AuthN/AuthZ directly on-point for tonight's finding | [Cycode summary](https://cycode.com/blog/owasp-mcp-top-10/) | B |
| MCP spec 2026-07-28 RC hardens OAuth `iss`-validation/credential-binding but still has **no first-class tool-authority/capability-scoping primitive** — NSA/CISA flag this as the "confused deputy" gap | [MCP RC blog](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/), [NSA/CISA advisory](https://media.defense.gov/2026/Jun/02/2003943289/-1/-1/0/CSI_MCP_SECURITY.PDF) | A |
| Microsoft Agent Framework + Entra Agent ID: dedicated agent identity, least-privilege task-scoped roles, JIT elevation — most mature published *identity* model surveyed | [MS blog](https://www.microsoft.com/en-us/security/blog/2026/07/16/least-privilege-for-ai-agents-identity-access-and-tool-binding/) | B |
| **ADR-377's own cited threat-model paper, arXiv:2603.07473 ("MCP Caller Identity Confusion"), was withdrawn by its authors 2026-07-21** for "flaws in experimental methodology and unresolved ethical issues in data collection" | Directly verified on [arxiv.org/abs/2603.07473](https://arxiv.org/abs/2603.07473) | A |
| arXiv:2605.14460 "Semantic Compliance Hijacking" — payload-less skill supply-chain attack, 77.67% confidentiality-breach / 67.33% RCE success, 0.00% detection by current scanners | [arxiv.org/abs/2605.14460](https://arxiv.org/abs/2605.14460) | A |
| Unit 42 BIV audit of 49,943 OpenClaw agent-skill entries: 80% show declared-vs-actual behavior mismatches; 5% carry multi-stage attack chains | [Unit 42](https://unit42.paloaltonetworks.com/ai-agent-supply-chain-risks/) | B |
| Sybil/forged-identity vote manipulation in multi-agent LLM consensus is a named, active research class | arXiv "Insider Attacks in Multi-Agent LLM Consensus Systems" (2025) | B |

## Ruflo Current Capability

`hive-mind_consensus` (`hive-mind-tools.ts:525-720`) implements raft/bft/quorum vote counting keyed by caller-supplied `voterId` strings against a `Record<string, boolean>`. `calculateRequiredVotes()` derives the threshold from `state.workers.length` — the roster `hive-mind_join` (line 478) pushes into, itself **unauthenticated** (only format-validated via `validateIdentifier`, no identity check). Before tonight, `vote` never cross-checked `voterId` against that roster: the existing double-vote guard (line 629) and cross-proposal Byzantine-flip detector (`detectByzantineVoters`) only catch one identity contradicting *its own* prior vote — neither does anything against many distinct forged identities each voting once. Separately, the deep-research role's independent capability audit found: `ToolOutputGuardrail` and `AgenticPolicyEngine` are genuinely wired at the real `callMCPTool()` chokepoint (both transports) — correctly implemented, contrary to an uncertain premise in tonight's brief; but `ToolOutputGuardrail` only scans result objects one level deep, missing the common `{results:[{content:"..."}]}` shape used by `memory_search`/`hive-mind_*` query tools even when `CLAUDE_FLOW_STRICT_GUARDRAIL=true`. Three recent security ACCEPT-PRs (#3103 caller-identity, #3139 mcp-policy enforcement, #3152 rate-limit reset) remain open/unmerged as of tonight, so `main`'s security posture is still the pre-fix baseline for all three. `PluginIntegrityVerifier` remains unwired (re-confirmed independently by two roles): `checksum`/`signature` never referenced in `manager.ts`'s `installFromNpm`/`installFromLocal`, `trust-anchors.json` still ships a placeholder key.

## Competitor Comparison

| System | Mechanism | Posture | Grade | Source |
|---|---|---|---|---|
| MCP spec itself | 2026-07-28 RC auth hardening | No capability-scoping primitive; confused-deputy gap flagged by NSA/CISA | A | modelcontextprotocol.io, NSA/CISA |
| LangGraph/LangChain | App-level only | Multiple 2026 CVEs (checkpoint RCE, SQLi); no scoped inter-agent delegation | A | CSA research note |
| Microsoft Agent Framework | Entra Agent ID, JIT elevation, DID-based Inter-Agent Trust Protocol | Most mature identity/authZ model surveyed | B | MS Learn, OSS toolkit |
| CrewAI | None found | Trusts arbitrary Python callables; genuine, unpublished-fix gap | B | drel.ai, SecurityWeek |
| OpenAI Agents SDK | `allowed_callers`, sandboxed execution, human-approval gate | Granular tool-invocation hygiene, not agent-identity/authZ | A | OpenAI SDK docs |

Synthesis: no competitor surveyed authenticates *inter-agent consensus votes* specifically (this is a narrower primitive than general tool-authority scoping), so tonight's finding sits in a genuinely under-examined corner of the landscape. On the broader plugin-integrity gap, Ruflo sits behind even CrewAI's "no native verification" baseline in practice, since an unwired verifier provides zero runtime enforcement — the npm-provenance/Sigstore pattern is the concrete blueprint to wire it against.

## Hypothesis

> Given a `hive-mind_consensus` proposal awaiting votes under any strategy (raft/bft/quorum), when a submitted `vote`'s `voterId` is checked against `state.workers` (the registered-worker roster) before being recorded, then a caller voting under a fabricated identity never registered via `hive-mind_join` should be rejected (fail-closed) rather than counted toward the quorum threshold — relative to today's baseline where any string counts — subject to: (1) a genuinely-registered worker's own vote is still correctly recorded and counted; (2) existing hive-mind test suites remain green; (3) zero added latency beyond one array-membership check; (4) no change to the separately-tracked, still-unfixed consensus-strategy-discard bug (2026-09-10).

Frozen before evaluation began; not modified after seeing results.

## Benchmarks / Evaluation

**evaluated: accepted (ACCEPT-scoped — see caveat below).** Real evaluator: Vitest 4.1.8, deterministic, $0, zero LLM calls. New file `v3/@claude-flow/cli/__tests__/hive-mind-consensus-sybil-vote.test.ts` (3 tests): (1) 3 forged voterIds against 5 real workers under raft — proves votes are silently accepted with no error at baseline; (2) legitimate registered-worker vote still recorded; (3) exactly 3 forged identities crossing a 3-worker BFT quorum (`required = floor(3·2/3)+1 = 3`) — proves the proposal is silently `approved` at baseline via pure Sybil votes.

**Baseline vs. candidate, stash-isolated** (source file only, test kept): **2/3 fail against real baseline** — forged votes return no error, and the BFT proposal reaches `status: 'approved'`/`result: 'approved'` from 3 forged identities alone. **3/3 pass against candidate.** All 18 hive-mind tests (3 files) pass together — no regression. Full `@claude-flow/cli` package suite (241 files, 3036 tests): **2863 passed, 46 failed, 127 skipped** — every failure traced to pre-existing, unrelated causes (missing `@claude-flow/mcp`/`@claude-flow/neural` workspace-resolution, `security-scan-enum-validation` traversal-count assertions); **zero mentions of "hive" in any failure**. `tsc --noEmit`: pre-existing errors only (workspace type-declaration gaps), none in the touched file.

**Adversarial critique (STEP 10):** independent reviewer (no authoring context) reproduced the stash-isolation result itself, confirmed `hiveMindTools` is exported and reachable via `mcp-client.ts` as a live MCP tool (not internal-only), confirmed only one code path writes `proposal.votes`, and confirmed the fix holds across quorum presets and across reuse of one forged id across multiple proposals. **Verdict: CONFIRMED-WITH-CAVEATS.** The one material caveat: `hive-mind_join`/`hive-mind_leave` have **no caller authentication at all** — an attacker can still Sybil the roster itself by legitimately joining N times under fake names, since `validateIdentifier` only checks string format. Tonight's fix closes forged-*vote* Sybil (the more surprising, silent bug — a caller need not even call `join`) but not forged-*join* Sybil (a louder, more visible attack surface). Scoping ACCEPT accordingly: this is a real, necessary, but partial fix — the roster-authentication gap is a distinct, larger follow-up.

## Darwin Results

Skipped — confirmed via `npx ruvector@0.3.0 harness darwin --help`: real interface evolves continuous/categorical genome parameters against a fitness-scored corpus. Tonight's fix is a binary authentication gate (registered vs. not) with no tunable parameter space. Same skip class as most recent nights.

## Flywheel Evidence

No signed `@metaharness/flywheel` bundle exists (`npx ruvector harness flywheel --help` confirms `verify`/`gate` target LLM-scored-corpus evidence, not deterministic code fixes). Evidence retained as: 3 new deterministic tests + full-suite run + independent adversarial critique + this gist + the linked issue. Classified: **OBSERVATION** (voterId never checked against `state.workers`, confirmed via read + grep for all `proposal.votes` writers) / **MEASUREMENT** (2/3→3/3 stash-isolated, independently reproduced by the critic; 2863/3036 full-suite pass rate unaffected) / **INFERENCE** (this is reachable in production because `hiveMindTools` is exported and wired into `mcp-client.ts` — not measured via live production traffic) / **DECISION** (ship as a minimal, single-file, fail-closed guard) / **REJECTION** (none).

## Reward Hack Check

No standalone reward-hack CLI reachable this session (`@metaharness/weight-eft` listed as a loaded capability but no CLI binary found on PATH). Manual checklist, independently re-verified by the adversarial critic: no test weakened (purely additive new file); no gold-answer path exists; no cherry-picking (full 3036-test suite run, all 46 failures disclosed with cause, not hidden); no seed manipulation (deterministic); zero cost.

## Security Review

This **is** the security-sensitive candidate. The fix is fail-closed (rejects on non-membership) and adds no new attack surface — one `Array.includes()` check, no new I/O. Disclosed residual risk (per adversarial critique): `hive-mind_join`/`hive-mind_leave` remain fully unauthenticated, so an attacker with MCP tool access can still inflate `state.workers` with fabricated worker ids and then vote once per fabricated id — this raises the attacker's cost (must call `join` first, leaving more evidence) but does not close Sybil consensus manipulation end-to-end. Recommended as a first-class candidate for a future `security` or `swarm` night: authenticate `hive-mind_join`/`leave` (e.g., bind to the same caller-identity primitive ADR-377/#3103 was designed for, once merged).

## Scan Findings: intelligence

**New, code-verified finding.** `ReasoningBank.judge()` (`v3/@claude-flow/neural/src/reasoning-bank.ts:403-444`) computes trajectory `success` purely from caller-supplied `qualityScore`/`reward`, with **no clamping, validation, or provenance** — contrast `moe-router.ts:467`, which clamps reward to [-1,1] on an adjacent path. `Trajectory` (`types.ts:117-147`) has no `agentId`/`source`/`signature` field at all. A compromised or buggy worker that controls its own reported outcome can force a poor/adversarial trajectory to be `distill()`ed into a permanent `Pattern`, later surfaced to *other* agents via retrieval — a durable memory-poisoning primitive. `queen-coordinator.ts:1865-1888` feeds `TaskResult.metrics.qualityScore` into this path; I could not confirm this exact chain is exercised at runtime vs. only reachable via a caller I didn't find — flagged as **unverified-wiring**, not a confirmed live exploit. External grade B (arXiv:2605.18930, 2606.04329 — recent, on-topic, not yet peer-reviewed).

## Scan Findings: swarm

Tonight's DEEP finding (Sybil vote) *is* the swarm-surface finding — see above. Additionally re-confirmed: the 2026-09-10 hive-mind consensus-strategy-discard bug (`state.consensusStrategy` written at init, never read by `hive-mind_consensus`) remains unfixed; combined with tonight's finding, this means "Byzantine fault tolerance" in hive-mind is cosmetic on two independent axes tonight — the strategy selection is ignored, *and* the vote-identity layer beneath whichever strategy runs trusted unauthenticated callers.

## Additional candidates surfaced but not selected tonight (STEP 3.2)

Deep researcher's independently-scored candidates (0.25·fit+0.20·testability+0.20·measurability+0.15·production+0.10·novelty+0.10·reviewability): (1) `ToolOutputGuardrail` one-level-deep scan misses nested/array tool results even in strict mode — **score 4.75**, highest of the deep-researcher's own 5; (2) dream-cycle's own ACCEPT-graded security fixes (#3103/#3139/#3152) sit unmerged, freezing `main`'s posture at pre-fix baseline — score 4.50; (3) `mcp-composition-inspector` never runs over the live 314-tool registry it was built to protect — score 4.20; (4) `AgentAuthorizationPropagator` (agent-to-agent scope propagation) has zero callers anywhere, not even a draft PR — score 4.10; (5) `MemoryPoisonForensics` write-path forensics hook has zero callers, unlike its wired read-path sibling — score 3.70. **Tonight's selected candidate (hive-mind Sybil-vote) was not among these 5** — it came from the swarm scan role — but scores ~4.85 by the same rubric (fit 5, novelty 5, testability 5, measurability 5, production 4, reviewability 5), narrowly the highest overall, and sits at the DEEP+SCAN surface intersection. Explicit override note: Candidate 2 above (guardrail depth gap) is a strong, close second and a natural pick for a future night.

## SOTA Proof & Witness

| Field | Value |
|---|---|
| Session commit | `df87b0db338a8632f14e243169208be1d7faa164` |
| Gist SHA-256 (pre-witness content) | `21b04a6c8b9d90f2050b62e427dca3d046f0f648a4832d5bf76d2863796c232f` |
| Witness stamp | `55d67b4a8204225dd5db3dbd9a81d31d67a0045c6f1d3c36b3ab88bbc9a65f11` |

Verifier procedure: fetch this file from the branch, strip the witness table's filled values back to `PENDING`, SHA-256 it, concatenate with the session commit above, SHA-256 again — result must equal the witness stamp.

## Recommended Next Steps

1. **Merge the linked draft PR** (human review required) — a minimal (~20 net lines + test file), fail-closed fix with stash-isolated baseline-fails/candidate-passes evidence and an independent adversarial confirmation.
2. **Authenticate `hive-mind_join`/`hive-mind_leave`** (disclosed follow-up from tonight's own adversarial critique) — closes the remaining forged-*join* Sybil path tonight's fix does not.
3. **Fix `ToolOutputGuardrail`'s one-level-deep scan** (deep researcher's top-scored candidate, 4.75) — strong pick for tomorrow night regardless of DEEP surface.
4. **Prioritize merging #3103/#3139/#3152** — three ACCEPT-graded security fixes sitting unmerged mean `main`'s actual security posture lags its own evaluated evidence by 10-11 days.

## Addendum (2026-09-11, post-review)

ruvnet reviewed PR #3291 at `b275fdd0` and **REJECT**ed: the roster-membership check alone was "useful but insufficient" since `hive-mind_join`/`hive-mind_leave` remained unauthenticated (the exact caveat this gist and the adversarial critique above already disclosed, now correctly elevated to a blocking gate rather than a follow-up), and the "Test Suite" CI check failed twice on the exact head due to the cold-install issue diagnosed above.

Both addressed, not just documented:

1. **Capability-bound join/leave/vote.** `hive-mind_init` now mints a random 32-byte `hiveToken` (`node:crypto` `randomBytes`, returned once in the init response), stored in `state.hiveToken`. `hive-mind_join`, `hive-mind_leave`, and `hive-mind_consensus`'s `vote` action all now require a matching `hiveToken` (constant-time `timingSafeEqual` comparison), fail-closed: a missing/wrong token makes **zero** state change — no roster write, no vote write — verified by 3 new tests that reload `state.json` fresh off disk after each denial (standing in for a restart/reopen, per the reviewer's explicit ask) and assert `workers`/`votes` are unchanged. The CLI's own `hive-mind join/leave/consensus` subcommands are unaffected for legitimate local use: a new `getHiveTokenForCli()` export reads the token directly off the same-machine state file (never returned by `hive-mind_status`, so the token doesn't leak through any MCP-reachable read surface) and the CLI command handlers now pass it through automatically. `hive-mind_init` itself is intentionally left unauthenticated, matching the reviewer's literal scope ("join/leave and vote") — bootstrapping trust for who may call `init` is a materially different, larger problem than binding capabilities to already-initialized state, and out of scope for tonight.
2. **CI cold-install fixed at the root, not routed around.** `@claude-flow/security` (a root npm-workspace member per `package.json`'s `workspaces` array) had no `prepare`/`postinstall` script — only `prepublishOnly`, which `npm ci` never runs — so a fresh checkout's root `npm ci` never built its `dist/`, causing `ERR_MODULE_NOT_FOUND` in `doctor.js` → `policy-runtime.ts` → `@claude-flow/security`. Confirmed via a real root `npm ci` in this session (824 packages, `dist/index.js` freshly built, timestamped) and reproduced on an unrelated PR (#3266)'s own first-run history. Added `"prepare": "npm run build"` to `v3/@claude-flow/security/package.json` — standard npm lifecycle, runs automatically on `npm ci`/`npm install` for every future checkout, not just this PR's. Full `@claude-flow/cli` suite re-run after both fixes: **28 failed / 2884 passed** (was 46/2863) — the ~18-test improvement is exactly the `@claude-flow/security`-dependent tests the `prepare` script now fixes; the remaining 28 are pre-existing, unrelated `@claude-flow/neural`/`@claude-flow/mcp` workspace-resolution gaps (confirmed by name, not just count). Zero "hive" failures throughout.

Updated evaluation: 6/6 new/updated tests pass against the candidate, 6/6 fail appropriately against a stash-isolated baseline (join/leave/vote all silently succeed pre-fix); `tsc --noEmit` clean on every touched file.
