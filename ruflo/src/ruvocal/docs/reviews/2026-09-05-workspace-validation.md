# Ruflo workspace implementation and validation

Date: 2026-09-05

Status: Implemented for review. Build and scoped acceptance pass. Production publication and operational promotion have not been performed.

## Source identity

| Item | Immutable identity |
| --- | --- |
| Source baseline | `db4991967c45c6f72133dff0bb80b0a492960fc1` |
| Candidate code commit on GitHub | `a03d85c2c11da6ed9bfd5a7cb5bde0ebae62d94f` |
| Candidate repository tree | `aa608c5457ab58310a201669ed9598a05f0eecbb` |
| Candidate application tree | `a3a835c0e017d2d802df3f2c4dab028891771aaf` |
| Local validation commit | `339efed870306d5da0e5c98364088504e2d47b0e` |

The local and GitHub code commits have identical repository trees. Their commit identities differ because the GitHub connector created the review commit. This report and its [machine-readable receipt](2026-09-05-workspace-receipt.json) are a subsequent documentation change. The actual revision serving flo.ruv.io remains unknown, so the comparison is against source, not an attestation of changes since the deployed release.

The [gap analysis](2026-09-05-ui-gap-analysis.md) records the pinned Ruflo, Autogenous, MetaHarness and ruOS source review. [ADR-039](../adr/ADR-039-WORKSPACE-CAPABILITY-EVIDENCE.md), [ADR-040](../adr/ADR-040-GOVERNED-RUNTIME-INTEGRATIONS.md), [ADR-041](../adr/ADR-041-IMPLEMENTATION-OPTIMIZATION-LOOP.md) and [ADR-042](../adr/ADR-042-BOUNDED-OPERATIONS-TOOLS.md) define the implementation, authority boundaries and rollback. These decisions do not approve deployment.

## Delivered behavior

The existing chat application now has a workspace with an objective composer, bounded draft iteration instructions, recent conversations, searchable tool schemas, runtime observations and keyboard command search. Chat onboarding offers editable task examples. Responsive styles support the existing light and dark themes, reduced motion preferences and narrow screens. Mission and tool drafts transfer through the existing local input store and require deliberate submission. Even a 4,000 character Unicode objective stays out of the URL.

Tool selection and successful discovery are separate states. Unchecked or failed inventories display as unavailable. Base MCP discovery resolves the deployment's private endpoint and headers from an exact server identity; browser requests cannot override them. Existing personal connection validation remains in place.

The administrator runtime API observes only privately configured endpoints. Ruflo and MetaHarness use exact discovered status calls; the bridge adds seven operations tools behind an opt-in group and supplies immutable flywheel status arguments. The UI identifies observations obtained through the Ruflo fallback. ruOS observations are limited to rendezvous service health. Autogenous has a documented operator adapter seam because its inspected upstream SDK does not provide the required HTTP or MCP status service. This change does not install such an adapter or verify signed evolution receipts.

Observation requests have fixed time, response size, request count, pagination and tool count limits. The API rejects guests, regular users, cross-origin requests and query overrides before upstream work. Nested MCP envelopes preserve failure signals; late responses cannot alter a timed-out observation. Availability never grants execution or promotion authority.

## Executed validation

Environment: Linux, Node `24.19.0`, npm `11.9.0`, dependencies installed from the unchanged application lockfile. The new scoped GitHub Actions workflow uses Node 22, following existing repository workflows; that remote execution is not part of these local results.

| Check | Result | Scope and limit |
| --- | --- | --- |
| Workspace Vitest suite | 108 passed | Draft constraints and Unicode handoff; server rendering and unknown inventories; runtime authorization, exact calls, SDK JSON/SSE transport, nested errors, deadlines and private health targets |
| Existing regression fixtures | 55 passed | RVF database and MCP client pool |
| Bridge Node tests | 6 passed | Real local HTTP bridge with fake stdio backend; default denial, exact discovery, fixed arguments and cross-group denial |
| Production build | Passed | Adapter Node output, without production provider credentials |
| Built application HTTP smoke | 6 passed | Workspace overview, tools, runtimes, chat, models and denied guest runtime API; local model-list fixture only |
| ESLint on 24 new source and test files | Passed | Does not certify the entire legacy application's lint state |
| Full application type check | Failed with existing baseline | 199 errors and 14 warnings in 51 files on both baseline and candidate; normalized diagnostic paths and messages are identical, excluding shifted line positions |
| Ruflo security scan | No signals in selected scope | Pinned CLI scan of the new server workspace directory; not a full application security assessment |
| Browser interaction and visual review | Not completed | Advertised cloud browser could not reach the local preview; no screenshot, focus, hydration or viewport assurance is claimed |
| Live production runtime or model calls | Not performed | Fixtures do not establish deployed connectivity, signer trust or production performance |

The total is **169 passing tests plus six built HTTP checks**. The failed full type check remains release debt. No test, type rule or authorization requirement was weakened to obtain the scoped passes.

The new `.github/workflows/ruvocal-workspace.yml` reruns scoped contracts, existing storage regressions, bridge tests, the offline build and built HTTP smoke when this application changes. It does not deploy, merge or certify the full type check.

## Measured optimization loop

The first integrated candidate eagerly imported the command palette into the shared layout. The final candidate loads it on demand. Both builds used the same installed dependencies and host. The unchanged baseline needed a local model-list fixture during build analysis; the candidate moves provider discovery to actual server startup so build analysis works offline.

| Build | Shared layout dependency JS, gzip bytes | All client JS, gzip bytes |
| --- | ---: | ---: |
| Source baseline | 102,208 | 634,786 |
| Initial candidate, eager command palette | 126,586 | Not used for comparison |
| Final candidate, lazy command palette | 103,495 | 651,666 |

The final layout is 23,091 compressed bytes smaller than the initial candidate, an 18.2% reduction. It is 1,287 bytes above baseline, about 1.3%. All client JavaScript grows by 16,880 bytes, about 2.7%, including the new workspace functionality.

Method: read `.svelte-kit/output/client/.vite/manifest.json`, start at the entry ending in `/nodes/0.js`, recursively follow static `imports`, deduplicate emitted JavaScript files and sum their individual Python `gzip.compress` lengths. Dynamic imports are excluded from the shared layout graph. The all-client measure sums every emitted `.js` file. These are reproducible bundle size proxies, not measured page latency, network transfer, usability, model quality or MetaHarness evaluation scores.

Ruflo CLI `3.25.6` recorded a bounded hierarchical swarm and initialized verified hybrid memory. Source research and implementation ran in separate Codex worktrees. That installed CLI did not support `metaharness flywheel status`; the attempted command returned an unknown subcommand error. The observer implementation instead follows the pinned current source API and is tested with actual MCP SDK transports and deterministic fixtures. No live Autogenous evolution, MetaHarness candidate evaluation or ruOS optimization run is claimed.

Review iterations also corrected nested error propagation, detached work after deadlines, deployment connection resolution, draft URL exposure and unknown inventory display. These are implementation improvements verified by their targeted failure fixtures, not claims of autonomous production optimization.

## Reproduction and release gate

From `ruflo/src/ruvocal`:

```sh
npm ci
npm run test:workspace -- src/lib/server/database/__tests__/rvf.spec.ts src/lib/server/mcp/clientPool.spec.ts
npm test --prefix mcp-bridge
npm run build
npm run test:workspace:smoke
npm run check
```

The last command currently fails with the documented baseline diagnostics. Configure actual deployment connections using [workspace configuration](../source/configuration/workspace.md). Do not substitute fixture observations for deployment acceptance.

Before release, obtain the running production build identity, complete narrow-screen and keyboard/browser acceptance, confirm chat and conversation streaming with the intended model, verify the scoped CI execution, resolve or explicitly accept existing type debt through normal review, and observe the intended live connections with correctly scoped administrator credentials. Autogenous receipt verification and richer evaluation/fleet control require separate adapter work and authority review. This workspace does not promote candidates or change runtime budgets.

Rollback uses a source revert to the reviewed baseline. The operations group can also be disabled independently with `MCP_GROUP_OPERATIONS=false`. No conversation storage migration is introduced.

Acceptance test: a fresh session can draft an objective, inspect an actual discovered schema and distinguish unconfigured, failed and observed connections; an unauthorized request reaches no runtime endpoint; a mission remains an editable chat draft until submitted.
