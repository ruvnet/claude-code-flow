# RuFlo Federation — ChatGPT app submission reference

This directory keeps the reviewable source materials used to prepare the
RuFlo Federation ChatGPT app submission. It is documentation and submission
evidence; the production MCP implementation remains in
[`plugins/ruflo-x-gateway`](../plugins/ruflo-x-gateway/).

## Production surface

- App name: **RuFlo Federation**
- MCP endpoint: `https://x.ruv.io/chatgpt/mcp`
- Authentication: OAuth 2.0 authorization code with PKCE
- Public profile: 12 tools with explicit safety annotations
- Legal pages: `https://x.ruv.io/privacy`, `https://x.ruv.io/terms`, and
  `https://x.ruv.io/support`

The public profile excludes administrative membership tools and secret-bearing
tool inputs. Relay-authored content is returned inside a nonce-delimited,
untrusted-data envelope. Irreversible signed publications and claim changes are
identified as writes and require authorization and user intent.

## Directory map

- `application/` — structured submission JSON, listing copy, reviewer tests,
  release notes, runbook, and a dated preflight record.
- `assets/` — the current water-mark icon family and demonstration video.
- `skills/` — six app-specific skills that use only the public 12-tool surface.
- `upload/` — a portal-ready ZIP containing one directory of skill roots.
- `scripts/` — reproducible source for the demonstration slides.

The dated preflight report records the investigation chronologically, including
issues that were later fixed. Its final OAuth regression-resolution section is
the current conclusion for that audit; it should not be used as a live status
monitor.

## Skills policy

The submission includes all six skills that accurately map to the public
RuFlo Federation MCP surface. Unrelated Ruflo repository skills are not bundled:
including capabilities that the app cannot invoke would misrepresent the app to
users and reviewers. See [`skills/SKILL-MANIFEST.md`](skills/SKILL-MANIFEST.md).

The upload archive has this required shape:

```text
ruflo-federation-skills/
  coordinate-ruflo-swarm/SKILL.md
  federation-audit/SKILL.md
  federation-init/SKILL.md
  federation-status/SKILL.md
  publish-ruflo-update/SKILL.md
  triage-ruflo-work/SKILL.md
```

Each root also contains `agents/openai.yaml`. This wrapper layout avoids the
portal error “Skill zip must contain one skill root or one directory of skill
roots.”

## Submission workflow

1. Review `application/chatgpt-app-submission.json` and
   `application/submission-listing.json` against the live MCP tool scan.
2. Upload `assets/ruflo-water-icon-512.png` as the app icon.
3. Upload `assets/ruflo-federation-demo.mp4` as the demonstration video.
4. Upload `upload/ruflo-federation-all-skills-upload.zip` in the Skills section.
5. Supply reviewer credentials only through the private OpenAI submission form.
6. Run the positive and negative reviewer cases after OAuth authorization.
7. Submit for review. Approval and public publication are separate platform
   actions and are not guaranteed by these artifacts.

## Credential handling

No password, OAuth client secret, access token, private signing key, invite code,
or reviewer credential belongs in this directory. Use
`application/reviewer-credentials.example.md` as the process template and keep
real values in the OpenAI portal or the approved secret manager.
