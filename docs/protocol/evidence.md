# Evidence and conformance plan

Review date: 2026-09-12. Publication status: Draft. No production deployment, live attack, membership change or full protocol conformance claim is made.

## Source provenance

| Input | Inspected revision and paths |
| --- | --- |
| Ruflo | `005a0ed25e644778f767cd78754fe91d660466af`: `plugins/ruflo-x-gateway/src/nostr-federation.mjs`, `relay-admin.mjs`, and `v3/@claude-flow/cli/src/mcp-tools/x-federation-join.ts` |
| ANS | `0565783df31da2d98729c27f02551f49478b8393`: `v2/identity.mjs`, `v2/identity.test.mjs`, README |
| Nostr | Upstream NIP-01 and NIP-98 master documents consulted on review date; a Stable release must pin their commit revisions |
| Cognitum | `docs_search` consulted for ANS, authentication and federation. It returned device Ed25519 documentation but no authoritative ANS/Nostr protocol specification |
| Cognitum assisted review | Federation `seraphina_guidance` through the Cognitum model gateway provided read-only governance advice; its roster and expiry conclusions were not independently validated and are not adopted as findings |

## Validation performed

Node v24.19.0. Existing ANS `npm test`: 10 passed, 0 failed. The new fixture verifier: 12 passed, 0 failed. The latter verifies signed bytes, tamper cases and dual possession signatures only; it does not implement the normative receive algorithm.

Ruflo harness used `npx -y @claude-flow/cli@3.25.6 memory search --query 'ANS Nostr protocol governance'`; the fresh checkout had no memory database. Read-only security scan used `npx -y @claude-flow/cli@3.25.6 security scan --target plugins/ruflo-x-gateway/src --depth deep --type all` and reported zero issues. The scan did not identify the metadata overwrite found during manual source inspection. No advisory feed timestamp was exposed, and dependency CVE coverage was not established. Zero scanner findings is not a security release gate.

The fixture runtime pins `nostr-tools@2.7.2`; this is a reproducibility pin, not a latest-version or vulnerability-free recommendation. Fixture generation used fresh nonproduction keys; only public keys and signatures are retained. All time-based tests must use the fixture time, not wall clock time. See `vectors.json`. The accompanying `fixture-package-lock.json` freezes transitive dependencies; original SHA256 is `4698f1d426a17363b8969b873eed488fabeb23c0797e9bcc2eddd2a39327dd05`.

To repeat the cryptographic checks from the repository root, copy `fixture-package.json` and `fixture-package-lock.json` into a temporary directory as `package.json` and `package-lock.json`, run `npm ci --ignore-scripts` there, and supply the absolute installed module path:

```sh
NOSTR_PURE_MODULE=/absolute/runtime/node_modules/nostr-tools/lib/esm/pure.js node docs/protocol/verify-vectors.mjs
```

Expected result: `checks: 12`, `fullConformance: false`. ANS functional tests run separately from its pinned repository with `npm test`.

## Confirmed source gaps

1. `fetchRecent`, `fetchManyOn`, and public `fetchChannel` spread parsed body fields after verified metadata. Thus signed content may override displayed `pubkey`, `id`, timestamp or channel. The signature remains valid for the actual author while the flattened result can misattribute it. Severity depends on downstream authorization use, which this documentation review does not establish. Remediation: preserve `{event, message}` and add reserved-field collision regression tests before v1 promotion.
2. `publish` spreads the payload after generated `type` and `ts`; callers can introduce conflicting body type and k tag. Remediation: separate envelope fields and reject collisions; do not normalize already signed content.
3. ANS is explicitly local and Ed25519 based. Nostr identity binding, distributed issuer discovery and global name uniqueness are not implemented. The proposed extension is not deployed by publishing these documents.
4. NIP-98 receiver replay storage, URL reconstruction and transactional side effects are outside the inspected client. Their enforcement is unknown, not proven absent.

## Threat model

| Asset and boundary | Failure | Required control | Residual risk |
| --- | --- | --- | --- |
| Key to identity | Curve confusion or forged binding | Distinct suites, pinned issuer, dual proofs | Compromised issuer requires trust reset |
| HTTP request to handler | Replay or body substitution | Exact body digest, URL binding, durable atomic consumption | Crash recovery requires application integration |
| Relay event to execution | Metadata shadowing or unauthorized commands | Separate verified event, schema and capability gate | Valid sender can still submit harmful data |
| Registry to receiver | Stale or revoked name | Authoritative revocation check and expiry | Registry outage denies execution |
| Parser to verifier | Oversize input or ambiguous JSON | Precheck limits and duplicate rejection | Rate limiting remains deployment specific |
| Draft to ecosystem | False standard or conformance claims | Independent review, fixtures, public receipts | Adoption cannot be compelled |

## Required conformance matrix

These are normative acceptance cases for a future Candidate harness. Only rows explicitly marked tested have been executed. This matrix is not a full test suite.

| ID | Case and expected outcome | Evidence state |
| --- | --- | --- |
| A01 | Valid binding accepted; changed name, unknown field, wrong issuer, invalid key, future or expired binding rejected | Existing ANS tests passed |
| A02 | Challenge accepted once; wrong audience, unknown or expired challenge rejected | Existing ANS tests passed |
| A03 | Replay and revocation survive reopen; duplicate names and capacity denied | Existing ANS tests passed |
| A04 | Dual Ed25519 and Nostr fixture signatures verify | Fixture tests passed |
| A05 | Wrong bound key, wrong federation, expired dual proof, revoked binding or unavailable registry denied | Required, not run |
| H01 | HTTP event verifies; changing URL or method invalidates signature; changed entity digest differs | Fixture tests passed |
| H02 | Exact query ordering, escaped path and trusted proxy origin accepted only when equal | Required, not run |
| H03 | Time boundary plus/minus 60 accepted; 61 rejected; duplicate security tags and duplicate JSON rejected | Required, not run |
| H04 | Empty mutation entity requires correct digest; altered bytes and content encoding rejected | Required, not run |
| H05 | Concurrent and post-restart auth reuse cannot execute twice; replay outage denies | Required, not run |
| M01 | Machine event signature verifies; any content tampering rejected | Fixture tests passed |
| M02 | Wrong recipient/audience, expiry, unsupported version/critical extension denied | Required, not run |
| M03 | Valid signed payload with forged metadata cannot change verified author or channel | Required, source gap confirmed |
| M04 | Same operation/content returns recorded result; changed content produces conflict | Required, not run |
| M05 | Crash during side effect leads to reconciliation; replay across two workers has at most one effect | Required, not run |
| M06 | Unknown executable type and unauthorized command denied; legacy readable but not auto-executed | Required, not run |
| G01 | Two independent implementations exchange fixtures and pass every required case | Not established |

## Release decision

Publish as Draft with gaps intact. Next work is receiver implementation, metadata isolation remediation and the full adversarial conformance harness. No benchmark or scanner score can waive identity, replay or permission invariants. The acceptance test for Stable is G01 plus the public review gates in governance.md.
