# Ruflo Federation Protocol

Publication: 0.1.0 draft, 2026-09-12. Status: open implementation proposal, not a ratified industry standard or an accepted Nostr NIP.

These specifications let independent implementers distinguish a name, a signing key, an authenticated request and permission to execute. No Cognitum account, proprietary gateway or model is required by the proposed protocol. A deployment can impose its own admission policy.

| Document | Scope | Status |
| --- | --- | --- |
| [ANS](ans.md) | Existing local identity binding and proposed Nostr binding | Documented v2 alpha plus explicit extension |
| [HTTP authentication](http-auth.md) | Strict application profile of upstream NIP-98 | Proposed receiver requirements |
| [Signed messages](signed-messages.md) | Existing wire format and versioned machine payload | Legacy description plus proposed profile |
| [Governance](governance.md) | Changes, registries, adoption and release gates | Proposed process |
| [Evidence](evidence.md) | Source snapshots, checks, gaps and conformance matrix | Review evidence |

Capitalized MUST, MUST NOT, SHOULD and MAY express requirements for the named profile. Requirements labelled proposed do not imply existing implementations enforce them. The draft does not amend upstream NIPs. Existing project licenses apply; this proposal grants no third party patent rights and makes no patent clearance claim.

## Implementer entry point

1. Pin the draft version and source commit. Select ANS local v2, HTTP strict v1, message v1, or a stated combination.
2. Implement the normative documents and negative cases in the evidence matrix. Preserve exact signed bytes.
3. Publish implementation version, source hash, test inputs, outputs and deviations. A green syntax check is not conformance.
4. Propose changes through a public pull request. Do not silently change deployed protocol semantics.

## Interoperability boundary

ANS currently uses Ed25519. Nostr uses Schnorr signatures over secp256k1. Keys are not interchangeable. Names and discovery records do not grant authority. A valid message proves authorship of its signed bytes, not task execution, capability ownership or truth of its claims. OAuth gateway publication is attributable to the gateway key unless an independently verified user proof accompanies it.

The current ANS source is [ruvnet/Agent-Name-Service](https://github.com/ruvnet/Agent-Name-Service). The current federation source is this repository's `plugins/ruflo-x-gateway`. The proposed profiles are transport independent where specified; they do not require x.ruv.io as a trust root.
