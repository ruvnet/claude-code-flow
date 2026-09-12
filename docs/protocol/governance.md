# Protocol governance proposal

Version 0.1.0 draft. This document proposes a public review process; it does not claim a standards body or independent governing council already exists.

## Ownership and participation

The repository's existing maintainers are initial editors. Editing authority is not authority to claim ecosystem adoption. Anyone may submit an issue, implementation report, erratum or pull request. Review comments, decisions and dissent remain public, except vulnerability details under coordinated disclosure. No vendor account is required to implement the specification.

Maintainers should recruit at least two independent organizations as reviewers. Affiliations and conflicts are disclosed in review records. Paid sponsorship, model output, swarm votes and automated scores do not count as independent technical review. No participant can self-certify interoperability by running the same implementation under two names.

## Lifecycle

| State | Required evidence |
| --- | --- |
| Draft | Source map, threat model, explicit normative requirements and known gaps |
| Candidate | Two named reviewers, including one security reviewer; schemas and positive/negative vectors; no unresolved critical ambiguity |
| Stable | At least two independently maintained implementations from two organizations pass the same conformance suite, including persistence and failure cases; minimum 30 calendar days public candidate review; all blocking comments resolved publicly |
| Deprecated | Successor, reason, compatibility mapping and at least 180 days migration notice unless an active security incident requires an expedited change |
| Retired | Notice elapsed; archived immutable versions and migration guidance retained |

Stable approval requires two approving maintainers including a reviewer independent of the submitting organization. Until that independence exists, the draft cannot become Stable. If a blocking disagreement remains, keep the lower status and document the disputed invariant. Appeal through a public issue with alternate evidence; a different uninvolved reviewer should chair the reconsideration. Proposal authors may not erase dissent.

## Change control

Every release freezes Markdown, schema, vectors, conformance harness version, source commit and SHA256 file manifest. Version major for incompatible semantics, minor for optional compatible extensions, patch for editorial corrections that do not change acceptance outcomes. Any changed valid/invalid result is semantic, not editorial. No in-place change to a released version. Record upstream NIP revisions used by a Stable release.

The repository registry begins with profile IDs `ans-local-v2`, `ans-nostr-binding-v1`, `rfp-http-strict-v1`, `rfp-message-v1`; message type `IdentityBinding` has the ANS schema. `Status`, `Task` and `Result` are observed legacy labels, not complete command schemas. Additional executable types require a schema, permission contract and negative tests before registration. Unknown critical extensions fail closed. Extension records include name, owner, version, schema, collision review, security considerations and status. No NIP number or global name allocation is claimed by this local registry.

## Security and intellectual property

Report vulnerabilities using the repository's security reporting route. Editors may issue an immediate advisory and disable an unsafe implementation profile; the advisory must identify affected versions, mitigation and subsequent public errata when disclosure is safe. Do not publish keys, bearer invitations or private payloads in vectors. Use dedicated nonproduction keys for tests.

Contributions remain subject to the repository license and contribution rules. Contributors disclose known relevant patent claims and licensing restrictions. A Stable release requires maintainers to record the chosen specification license and an explicit patent policy; this draft does not invent patent grants on behalf of contributors. Upstream Nostr compatibility and legal rights are separate gates.

## Adoption acceptance test

An independent team must implement from the documents without importing Ruflo or Cognitum code, then exchange valid messages and reject every negative vector against another implementation. Publish reproducible source revisions and receipts. Only then seek upstream Nostr review and ecosystem endorsement. Public documentation alone does not establish industry standard status.
