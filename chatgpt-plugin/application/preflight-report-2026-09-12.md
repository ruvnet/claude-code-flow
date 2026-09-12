# x.ruv.io official plugin preflight

Audit date: 2026-09-12

## Live checks that passed

- `https://x.ruv.io/health` returns 200.
- `https://x.ruv.io/mcp` responds to MCP `tools/list`.
- The MCP plugin works in ChatGPT and read-only calls to federation identity, onboarding, and channel listing succeeded.
- RFC 9728 protected-resource metadata is available at `https://x.ruv.io/.well-known/oauth-protected-resource`.
- OAuth discovery is public at `https://auth.cognitum.one/.well-known/openid-configuration` and advertises authorization code, refresh token, PKCE S256, dynamic registration, UserInfo, `openid`, `email`, `swarm:read`, and `swarm:publish`.
- The current personal integration reports OAuth supported and connected.

## Live blockers found

- The connected personal listing is still in `development` review status and displays the placeholder name/description `x.ruv.io mcp v3`, Developer `App developer`, Category `Other`, and no visible icon.
- Production reports gateway version `0.7.0`; repository main reports `0.7.1`.
- Production `/privacy`, `/terms`, and `/support` return 404.
- Production tool metadata omits `readOnlyHint`, `openWorldHint`, and `destructiveHint`. ChatGPT consequently labels every tool `PUBLIC WRITE / OPEN WORLD / DESTRUCTIVE`, including reads.
- The production `/mcp` schema exposes `adminToken` inputs and admin-only membership tools. OpenAI’s public plugin rules prohibit collecting authentication secrets as tool inputs.
- The dedicated review-safe URL `https://x.ruv.io/chatgpt/mcp` is not deployed yet.
- OpenAI Platform requires a fresh **With MCP** submission. The existing personal integration id cannot be promoted directly.
- OpenAI Platform login is complete. The **With MCP** creation flow is blocked by the portal's **Complete identity verification** requirement; the live tab is preserved at that handoff.
- PR [#3297](https://github.com/ruvnet/ruflo/pull/3297) is open and mergeable, but its Marketplace Validate jobs fail because the current base branch contains `plugins/ruflo-chatgpt-federation/` without the required `.claude-plugin/plugin.json`. The PR itself only changes the x-gateway GET `/mcp` behavior and its OAuth test.

## Overnight coordination snapshot

First cycle recorded at 2026-09-12 05:33 UTC:

- takeover and collision-avoidance claim posted to Slack `#swarm` and `#development`;
- no teammate reply yet beyond the Codex status updates;
- production remains unchanged: legacy `/mcp` is 200, while `/chatgpt/mcp`, `/privacy`, `/terms`, and `/support` are 404;
- protected-resource metadata remains healthy at both the bare and `/mcp` RFC 9728 URLs;
- the OpenAI Platform account is signed in and the live tab is preserved at the required developer identity-verification handoff.

Material update at 2026-09-12 07:10 UTC:

- PR [#3300](https://github.com/ruvnet/ruflo/pull/3300) now carries the x-gateway review-safety work against `main`: explicit annotations, a 12-tool `/chatgpt/mcp` profile, public legal/support pages, the OpenAI challenge route, and an untrusted-content envelope for relay-backed results;
- its Marketplace validation, security, CodeQL, smoke, and test checks are green; three packaging jobs were still running when observed;
- it deliberately omits the icon, so the prepared `assets/icon.png` remains required for the portal listing;
- PR #3300 does not include PR #3297's GET `/mcp` discovery compatibility change, so landing order still needs coordination.

Follow-up at 2026-09-12 07:15 UTC:

- PR #3300 merged into `main` with every completed CI check green, including all three platform packaging jobs;
- its deploy/release job was skipped, so x.ruv.io remains unchanged and still requires an explicit deployment through the correct CD/traffic-promotion path;
- PR #3297 remains open with its older failed validation runs.

Deployment regression detected at 2026-09-12 07:22 UTC:

- PR #3300's review profile is now live as gateway version `0.7.1`: `/chatgpt/mcp` answers MCP POST requests with exactly 12 tools, every tool has all four safety hints, public schemas contain no secret-bearing fields, relay results are untrusted-content fenced, and `/privacy`, `/terms`, and `/support` return 200;
- however, the deployment removed the previously live RFC 9728 protected-resource metadata: the bare, `/mcp`, and `/chatgpt/mcp` metadata URLs now return 404;
- an unauthenticated gated tool call returns HTTP 200 with `admin token required or invalid` inside an MCP tool error and no `WWW-Authenticate` challenge, so ChatGPT cannot initiate the OAuth flow;
- the missing OAuth implementation is on open PR [#3285](https://github.com/ruvnet/ruflo/pull/3285), which is currently conflicting with `main`; PR #3297 targets that feature branch rather than `main`;
- official submission must remain blocked until #3285 is reconciled with #3300, the protected-resource metadata and OAuth challenge are restored, and an authenticated browser E2E passes against production.

## Fix prepared

`gateway-openai-submission.patch` is based on the production-aligned OAuth branch `origin/feat/chatgpt-federation-publisher` at commit `19e7b32e2` and adds:

- dedicated `/chatgpt/mcp` public surface;
- 12 public tools with complete safety annotations;
- no credential-bearing input fields;
- no admin-only invite/admission tools on the public endpoint;
- public privacy, terms, and support pages;
- OpenAI well-known domain-challenge support;
- automated regression checks.

Verification completed locally:

- gateway test suite: 38/38 passed;
- plugin manifest validation: passed;
- generated logo: 512 × 512 PNG with alpha.

## Remaining human or deployment actions

1. Review the policy wording and publisher identity.
2. Apply and deploy the gateway patch.
3. Set the exact portal challenge token after draft creation.
4. Verify UserInfo returns both `email` and `email_verified: true` for a reviewer account.
5. Sign in to OpenAI Platform, select the owning organization, and confirm Apps Management Write plus identity verification.
6. Submit only after the portal tool scan passes; publishing is a separate post-approval action.

## OAuth regression resolution — 2026-09-12 14:20 UTC

- PR [#3285](https://github.com/ruvnet/ruflo/pull/3285) was reconciled with `main`/PR #3300 and merged as commit `3949f9c50f53b5db00833862c1fbd5c628fe7ec0`.
- The exact merge revision was deployed to Cloud Run revision `ruflo-x-gateway-oauthfix-3949f9c` and promoted to 100% traffic.
- Production now returns 200 for all three RFC 9728 metadata locations: bare, `/mcp`, and `/chatgpt/mcp`.
- Anonymous and invalid-bearer writes on `/chatgpt/mcp` return HTTP 401 with a `WWW-Authenticate` challenge pointing to the exact protected-resource document.
- Production `/chatgpt/mcp` exposes exactly 12 review-safe tools with all four annotations, no secret-bearing schema fields, fenced relay content, and finite JSON/SSE GET discovery.
- ChatGPT's New Plugin form successfully discovered the production authorization, token, DCR, OIDC, UserInfo, resource, and scope settings for `https://x.ruv.io/chatgpt/mcp`.
- PR [#3297](https://github.com/ruvnet/ruflo/pull/3297) was closed as superseded after its finite GET behavior was integrated through #3285.
- A portal-compliant 256 x 256 PNG icon is available at `assets/icon-chatgpt.png` (8,616 bytes).

The remaining gates are user-controlled: attach the icon in the browser file picker, confirm creation of the new DCR-backed development app, complete any OAuth/identity-verification prompts, run the connected browser E2E, and submit for review only after that E2E passes.
