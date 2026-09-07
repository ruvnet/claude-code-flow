# Unexposed native authority snapshot prerequisite

Status: Implemented for local validation; no hosted tool or authority activation
Date: 2026-09-07
Base: `19c96378fda3eb1a873467c1a6cae9075e9855d8`

The existing cache-first plain-memory getter cannot establish current authority.
A disposable test of the pinned native image returned stale content after a
database update and conflated colon/underscore cache keys. Hierarchical exact
getters bypass that cache and retain their current behavior.

`cli/src/memory/authority-snapshot.ts` reads only the already-open database held
by ControllerRegistry. `bridgeAuthoritySnapshot` does not initialize a registry,
open another database, repair schema, consult caches or fall back to sql.js.
TypeScript uses the actual owned better-sqlite3 handle shared by `tiered_memory`
and `memory_entries`; a separate Rust connection would not prove same-handle
semantics. No MCP registration, hosted allowlist or authority is added.

Input is exactly `{companyId, selectors}`. The finite selector kinds are:

| Kind | Additional fields | Stored source |
| --- | --- | --- |
| company | none | semantic canonical Company |
| member | memberId | semantic canonical OrgMember |
| executive, settings | memberId | exact respective namespace/key |
| assignment, spend | groupId | exact respective WhatsApp namespace/key |
| request | groupId, reservationId | approval request |
| approval | groupId, reservationId, allowAbsent | approval |
| jti | jti, allowAbsent | original assertion-use record |
| identity-locator | identityRef | both defined locator mirrors |

Company/member/executive/settings IDs and JTI use the protected 128-character
safe-ID subset. Group/reservation IDs use the existing 160-character WhatsApp
grammar. Unsupported historical identifiers fail rather than changing keys.
The primitive is not a complete domain schema or authorization validator.

The installed ruClip `storeAtTier` writes Company/OrgMember through hierarchical
storage. Identity migration creates a real mirror: `ruclip-identity-v1/identity-SHA`
and semantic `ruclip:company:C:identity-legacy:SHA`, with SHA derived from the
exact JSON array `[companyId, identityRef]`. The locator selector requires both
records and identical compact JSON; missing either or disagreement fails.
It never searches arbitrary namespaces for apparent mirrors. This stricter
unexposed contract does not alter the existing identity resolver.

One synchronous `BEGIN` read transaction spans all selected exact tuples.
Native open file handle, WAL, effective FULL and a fixed WAL-reset SQLite
version are required. Caller transactions are neither committed nor rolled
back. Finite code-owned tables/columns and bound full namespace/key values
prevent cache aliases. Persisted ambiguity, including archived duplicate rows,
fails. Missing optional approval/JTI is explicitly null; malformed, expired or
tombstoned records never become creation absence. Hierarchical temporal fields
require RFC3339. Null legacy plain-memory status retains the existing active
row convention.

Values must be nonempty compact JSON objects with an exact JSON.stringify
roundtrip. Duplicate fields, alternate encodings and noncompact historical JSON
fail without normalization; unsupported history requires reconciliation.
Values remain opaque business records. Callers must independently validate
embedded identity/company/role, signatures, consent, approval expiry and all
domain bindings. Matching storage mirrors do not themselves grant identity.

There are at most 12 expanded record tuples, not 12 selectors when mirrors add
reads. Values are at most 256KiB each; metadata is bounded before transfer and
the entire encoded response at most 2 MiB. A length SELECT precedes each content
SELECT within the same transaction, rejecting oversized content before its
transfer. Only required columns are loaded, never embeddings. Counts explicitly
report selectors, logical records, rows observed, rows read by both SELECT
phases, record SELECTs and all SQLite statements. Two present records mean
2 logical records,4 record-row reads,4 record SELECTs and 18 total SQLite statements.
Row counts describe rows returned by the SELECT phases, not internal scanned
rows or page I/O; missing indexes can still cause scans. This is not a bound on
all engine work. Actual current schemas supply their existing key indexes.
No existing 16-native-request budget is changed or implicitly charged by this
library operation; a future exposed adapter must account for actual work.

The one-second elapsed guard runs between statements and after commit. It
cannot interrupt synchronous SQLite/filesystem stalls; a future adapter needs
its own bounded execution lane/deadline and outstanding-work accounting.
`observedAt` is the transaction observation time, not a renewable authority
lease. Metadata may expire afterward. The digest binds exact tuples, original
values, row IDs and validity/status metadata, not a guarantee of future current
state or an atomic compare with a subsequent write.

Tests cover actual file-backed WAL snapshots and a second connection committing
between record reads, exact aliases, mirror conflicts/absence, duplicate rows
and JSON, metadata/output bounds, expiry, native/FULL failures, nested
transactions, sanitized errors and rollback. The explicit fixture mounts the
compiled candidate module read-only into the unchanged cached image, with
network disabled and synthetic tmpfs data. It compares baseline cache behavior
and candidate reads on the same registry handle, SQLite 3.51.3/WAL/FULL. Its
microfixture timing is not an end-to-end improvement or shared latency proof.

Next prerequisites remain: native transactional compare-and-transition,
verifiable original-signature approval, fixed consume, publication dependencies,
full migration and deployed compatibility. Legacy signature-less approvals
remain withheld; all reservation/settlement liabilities and history stay intact.
