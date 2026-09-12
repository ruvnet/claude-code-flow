# Ruflo Federation — OpenAI plugin application runbook

## Prepared submission

- Submission type: **With MCP**
- URL type: **Universal**
- Review endpoint: `https://x.ruv.io/chatgpt/mcp`
- Publisher: select the verified Reuven Cohen or matching verified Ruflo business identity in OpenAI Platform.
- Logo for portal upload: `../assets/ruflo-water-icon-512.png`
- Policy and listing values: `submission-listing.json`
- Tests: `test-cases.md`

## Deployment gate

The review-safe profile and OAuth resource-server behavior are implemented in
`plugins/ruflo-x-gateway`. Before each submission or resubmission, verify the
deployed revision rather than assuming the archived preflight remains current:

- `https://x.ruv.io/chatgpt/mcp` discovers exactly 12 public tools;
- every tool has complete safety annotations and no secret-bearing input fields;
- all RFC 9728 protected-resource metadata routes return 200;
- an unauthenticated gated call returns 401 with `WWW-Authenticate`;
- `/privacy`, `/terms`, and `/support` return 200; and
- browser OAuth with PKCE succeeds against production.

Do not scan the legacy `/mcp` surface for the public app submission.

## Platform process

1. Sign in at `https://platform.openai.com/plugins` and select the owning organization.
2. Confirm the submitter has **Apps Management: Write** and the publisher identity is verified.
3. Select **Create plugin → With MCP**. The portal creates a draft.
4. In **Info**, enter `submission-listing.json`, select the verified identity, choose Developer Tools (or the closest category), and upload `../assets/ruflo-water-icon-512.png`.
5. In **MCP**, choose **Universal** and enter `https://x.ruv.io/chatgpt/mcp`.
6. Configure OAuth using `https://auth.cognitum.one/.well-known/openid-configuration`. Confirm `openid`, `email`, `swarm:read`, and `swarm:publish` and that UserInfo returns `email` plus `email_verified: true`.
7. If shown a domain challenge, copy its exact token into deployment secret `OPENAI_APPS_CHALLENGE`. Verify `https://x.ruv.io/.well-known/openai-apps-challenge` returns only that token, then complete verification.
8. Select **Scan Tools**. Confirm 12 tools, no credential fields, and all three safety hints on every tool.
9. Add the three starter prompts from the listing.
10. Enter at least five positive and three negative cases from `test-cases.md`. Any reviewer account must work without MFA, email/SMS confirmation, or private-network access.
11. Select only regions supported by the project’s legal and support process.
12. Add the prepared release notes, check attestations, and select **Submit for Review**.
13. After approval, return to the portal and publish. Approval does not publish automatically.

## Final preflight

- Public endpoint is deployed, stable, and uses HTTPS.
- OAuth dynamic client registration and PKCE succeed.
- UserInfo exposes verified email for workspace restrictions.
- No tool accepts passwords, API keys, tokens, private keys, or invite codes.
- Read tools are non-destructive; write tools disclose durable signed publication.
- Federation messages are treated as untrusted data, never instructions.
- Privacy policy covers categories, purposes, recipients, retention, and controls.
- Support route is monitored and public.
- Five positive and three negative reviewer cases are reproducible.
