# ADR-095 G2 — Failure-Injection Test Plan

**Status.** Scoping document. Source files cited are real; suggested test paths are TODO until landed.
**Scope.** The single remaining G2 work item from ADR-095 status update 2026-05-11: *"Failure-injection tests (f<n/3 for BFT, f<n/2 for Raft) — drive a multi-node `LocalTransport` cluster with simulated faulty/silent nodes; assert correct commits below threshold, no incorrect commits above."* See `docs/adr/ADR-095-architectural-gaps-from-april-audit.md:196-198`.
**Companion.** Sibling cross-host validation runbook (also in `docs/runbooks/`) tracks the FederationTransport path on real hosts; this plan is the in-process counterpart.

---

## 1. What's already tested (210/210 swarm suite)

The +28 ADR-095 G2 tests in `@claude-flow/swarm/__tests__/` already cover the **transport correctness** and **single-protocol-step-with-fault** dimensions. Inventory:

### `consensus-transport.test.ts` (12 tests)
- Ed25519 sign/verify round-trip, tampered payload, missing sig (fail-closed), wrong key, key-order-stable canonicalization (lines 17-54).
- `LocalTransport` happy path: send→peer→reply, broadcast to all-but-self, `peers()` exclude-self, unreachable peer rejects, closed peer rejects, handler-hangs timeout (lines 56-128).
- `LocalTransport` with signing: signed round-trip with `seq=1`, unsigned message rejected at signing-enabled peer, replay/`seq` monotonicity (lines 130-200).

### `byzantine-transport.test.ts` (8 tests)
- Legacy emit-only path unchanged when no transport injected (lines 18-29).
- Transport-injected pre-prepare emit + actually reaches peer over wire with sha256 digest (lines 31-58).
- Inbound transport pre-prepare invokes `handlePrePrepare`, which broadcasts a `prepare` (lines 60-102).
- `byzantineF()` derivation: 4-node→f=1, 7→f=2, 10→f=3; `maxFaultyNodes` cap honored; 3-node clamped to f=1 (lines 105-147).

### `raft-transport.test.ts` (6 tests)
- RequestVote receiver rules over transport: grant to up-to-date candidate, vote-once-per-term (denies second candidate at same term), deny stale-term candidate, deny behind-log candidate (lines 28-92).
- AppendEntries: follower accepts valid entry + commitIndex advances; follower rejects stale-term and reports its own term (lines 94-121).

### `gossip-transport.test.ts` (3 tests)
- Outbound gossip stamps `hops++` and appends to `path`; inbound dedup by id (`seenMessages.add` only fires once for repeated id); non-gossip types are ignored (lines 13-80).

### `federation-transport.test.ts` (7 tests)
- Correlation-id request-response, broadcast to all peers, no-address rejects, no-reply times out, peers-excludes-self, signing+verification round-trip, unsigned message dropped at signing-enabled node (lines 58-145).

### `consensus-failure-injection.test.ts` — **already partially present** (8 tests)
This is the existing scaffold for the work this plan scopes. It tests:
- BFT prepare/commit quorum at thresholds: 4-node (f=1) reached with 2f external commits, NOT reached with 1; 7-node (f=2) reached with 2f=4 commits, NOT reached with 3; `maxFaultyNodes` cap behavior (lines 73-103).
- Raft RequestVote tally: 5-node all-replying → 5 grants; 5-node with 2 silent → 3 grants (majority, wins); 5-node with 3 silent → 2 grants (loses) (lines 143-161).

**Coverage summary.** The transport layer, signing/replay defense, single-protocol-step receiver rules, and one-shot quorum-threshold accounting are covered. What is **not** covered is multi-round multi-node behavior, the gossip path under loss, and adversarial (not just silent) Byzantine faults.

---

## 2. What's missing

The ADR specifies *"drive a multi-node `LocalTransport` cluster with simulated faulty/silent nodes; assert correct commits below threshold, no incorrect commits above."* The existing `consensus-failure-injection.test.ts` short-circuits to a single node + injected messages; it never wires N actual consensus instances against a shared registry and lets them reach commit through the protocol. The gaps:

### 2.1 BFT — full-cluster multi-node commit (3-phase end-to-end)
The current scaffold (lines 29-66 of `consensus-failure-injection.test.ts`) drives ONE `ByzantineConsensus('node', ...)` and synthesizes external prepare/commit senders via short-lived `LocalTransport(p_<sid>)` instances. It asserts the quorum *counter*, not full multi-node convergence. Missing:
- **4-node cluster (f=1), zero faults**: all four nodes are real `ByzantineConsensus` instances on a shared `LocalTransportRegistry`; primary `propose()`s; assert all four reach `consensus.achieved` and `proposal.status === 'accepted'` with the same `digest`.
- **4-node cluster (f=1), 1 silent replica**: identical setup, but one non-primary replica's transport `onMessage` is replaced with a no-op (the existing `silent` pattern from lines 127-128). Assert: primary + remaining 2 replicas still hit 2f+1=3 commits → consensus achieved. Quorum survives the threshold.
- **4-node cluster (f=1), 2 silent replicas**: assert NO node reaches `consensus.achieved` within a bounded wait; `proposal.status` stays `pending` (safety: no incorrect commit above the f threshold).
- **7-node cluster (f=2) variants**: zero, 1, 2 faulty → all commit; 3 faulty → no commit.

### 2.2 BFT — Byzantine (lying) faults, not just silent
Silent nodes test liveness loss. Real Byzantine resilience also requires resisting **equivocating** nodes that send contradictory messages. The existing tests don't cover this. Missing:
- **Equivocating prepare**: a faulty peer sends a `prepare` with a *different* digest than the primary's pre-prepare. Assert honest replicas reject (current `handlePrepare` does not check digest match against pre-prepare — this may surface a real bug worth filing as a follow-up rather than masking with the test). TODO(verify): inspect `byzantine.ts:321-368` — `handlePrepare` only dedups by `senderId`, doesn't validate `digest` matches the prepared proposal's digest. If correct, the test should assert the current (possibly weak) behavior + open an issue.
- **Sig-forgery attempt**: with signed `LocalTransport` (Ed25519 enabled, `consensus-transport.test.ts:130-200` shows the wiring), a faulty node sends a message signed with the *wrong* key. Assert `LocalTransport.deliver` (transport.ts:236-254) rejects before the handler sees it.

### 2.3 Raft — full leader election + log replication under faults
The existing `tallyVotes` helper (`consensus-failure-injection.test.ts:115-141`) drives a single RequestVote round with the transport directly; it does NOT start `RaftConsensus.startElection`/`becomeLeader`. Missing:
- **5-node cluster (n=5, quorum=3), 0 faults**: all 5 are real `RaftConsensus` instances on a shared registry. Trigger election by waiting for `electionTimeout` or calling a test-exposed hook. Assert exactly one leader emerges (`leader.elected` event), `isLeader()` returns true on exactly one, term advances. (Reuses `buildCluster` from `raft-transport.test.ts:14-26`.)
- **5-node cluster, 2 followers silent**: assert candidate still wins (3 votes = majority), `state === 'leader'`. Replicate one entry via `propose()`; assert remaining 3-node majority commits it (`log.committed` emitted on 3 of 5).
- **5-node cluster, 3 followers silent (below quorum)**: assert candidate becomes `candidate`, fails to become `leader`, falls back to `follower`, election timeout retries. Assert no `leader.elected` event within a bounded window. (Hits the path at `raft.ts:330-332`.)
- **Split-vote**: two candidates start elections simultaneously at the same term. Assert at most one wins; both step down on higher-term observation. (Hits `raft.ts:346-352` step-down path.)
- **Stale-leader after partition heal**: leader at term 2 is silenced; a follower elects itself at term 3; the old leader's transport is re-enabled; assert the old leader steps down on receiving the new leader's heartbeat (term 3 > 2). Uses the existing AppendEntries stale-term path covered by `raft-transport.test.ts:111-120`.

### 2.4 Gossip — eventual delivery under packet loss
Gossip is NOT Byzantine-tolerant; its correctness property is *eventual delivery* given non-zero edge probability and bounded TTL. The existing gossip tests (`gossip-transport.test.ts`) cover single-hop send and dedup; nothing tests multi-hop convergence or loss tolerance. Missing:
- **N=10 ring topology, 0 loss**: 10 nodes, each `neighbors` set to two ring-neighbors. One node proposes. Assert all 10 receive the gossip within a bounded number of rounds (drive `gossipIntervalMs` low, or call internal drainer N times).
- **N=10 ring, 30% drop rate**: with a `FaultyTransport` wrapper (see §3) dropping 30% of messages. Assert convergence still happens within an extended round budget. Assert it does NOT happen with 100% drop (sanity).
- **TTL exhaustion**: a gossip message with `ttl=2` cannot reach a node 5 hops away. Assert delivery does not happen, and `hops` tracking is correct.

### 2.5 Cross-cutting: replay defense in adversarial flow
`consensus-transport.test.ts:167-199` documents that the existing replay test couldn't easily redeliver a captured signed message because there's no public API for it; it asserts the seq counter advances instead. Missing:
- **True replay**: capture a signed `ConsensusMessage` by spying on a peer's `onMessage`, then call `LocalTransport.deliver` (would need either a test-only escape hatch or a `FaultyTransport` wrapper that re-injects captured messages). Assert the second delivery throws `replayed/out-of-order seq from ...`. The escape hatch is preferable to making `deliver` public.

---

## 3. Test harness sketch

### 3.1 Does `LocalTransport` already support fault injection?

**Partially.** Surveying `transport.ts`:
- **Silent node** ✓ — replace `target.handler` with a no-op via `t.onMessage(() => {})`. Already used in `consensus-failure-injection.test.ts:127-128`.
- **Closed/unreachable** ✓ — `await t.close()` (transport.ts:279-283); subsequent sends to it throw `unreachable peer` (transport.ts:259) or `closed` (transport.ts:237).
- **Hang/timeout** ✓ — handler returns an unresolved Promise; `send` enforces `defaultTimeoutMs` (transport.ts:262-265). Demonstrated at `consensus-transport.test.ts:120-127`.
- **Selective message drop by predicate** ✗ — no built-in. Cannot drop "all `prepare` messages from node 3" without a wrapper.
- **Latency injection** ✗ — no built-in delay; only the all-or-nothing timeout.
- **Partition** ✗ — no way to make subsets of the registry mutually invisible while remaining individually live.
- **Replay capture/re-inject** ✗ — `deliver` is private (transport.ts:236).
- **Byzantine equivocation** ✗ — would need to send a hand-crafted `ConsensusMessage` that violates protocol invariants; `stamp()` always assigns `from = this.nodeId` (transport.ts:226), so a node cannot impersonate another. For Byzantine tests, the *faulty* node must be a transport instance under direct test control (already the pattern used in §2.1's external-sender injection).

### 3.2 Proposed `FaultyTransport` wrapper

A thin decorator implementing `ConsensusTransport`, wrapping a real `LocalTransport`, configured at construction:

```ts
// pseudocode — test helper, NOT production code
interface FaultProfile {
  dropPredicate?: (msg: ConsensusMessage) => boolean;   // returns true → drop silently
  delayMs?: (msg: ConsensusMessage) => number;          // returns ms to sleep before delivery
  replayAfterMs?: (msg: ConsensusMessage) => number;    // returns ms after which to re-deliver
  partitionedFrom?: Set<string>;                        // peer ids unreachable from this node
}
```

Build it in a test-only helper module (e.g. `__tests__/helpers/faulty-transport.ts`) so production `transport.ts` stays clean. It composes by delegating to an underlying `LocalTransport` for the actual registry lookup + signing + delivery, only intercepting the `send`/`broadcast`/`onMessage` paths to apply the fault profile.

Open question (TODO(verify) before implementation): broadcast in `LocalTransport.broadcast` (transport.ts:268-277) iterates `this.registry.peerIds(this.nodeId)` directly — a wrapper around a LocalTransport can intercept its own `broadcast()` call, but cannot prevent OTHER nodes' broadcasts from reaching the wrapped node unless the wrapper replaces `onMessage`. Cleanest design: the wrapper installs its own handler with the registry-side `onMessage`, then conditionally invokes the consensus class's handler.

### 3.3 What does NOT need to change in production code

The `ConsensusTransport` interface (transport.ts:63-80) is wrapper-friendly: 5 small methods, all async. A `FaultyTransport` that implements the interface and forwards to an inner `LocalTransport` is straightforward. **No changes to `transport.ts`, `raft.ts`, `byzantine.ts`, or `gossip.ts` should be required** to scope this work; if a test needs an internal hook (e.g. to capture+replay), prefer a test-only subclass over loosening encapsulation.

---

## 4. Proposed test file structure

All under `@claude-flow/swarm/__tests__/`. Suggested split (keeps each file ~150-250 LOC, parallel to the existing `*-transport.test.ts` per-protocol style):

### `__tests__/helpers/faulty-transport.ts` (new)
- Exports `FaultyTransport implements ConsensusTransport`, `FaultProfile`, helper builders `buildBftCluster(n, faulty)`, `buildRaftCluster(n, silent)`, `buildGossipRing(n, dropRate)`.
- TODO(verify): align with the existing `buildCluster` pattern in `raft-transport.test.ts:14-26` so they can be unified later.

### `__tests__/bft-cluster-faults.test.ts` (new)
- `4-node f=1 cluster, 0 faulty: primary propose → all 4 reach consensus.achieved`
- `4-node f=1 cluster, 1 silent replica: 2f+1=3 still commit`
- `4-node f=1 cluster, 2 silent replicas: NO consensus.achieved within 200ms`
- `7-node f=2 cluster, 0/1/2 faulty: all variants reach consensus`
- `7-node f=2 cluster, 3 faulty: safety holds, no commit`
- `4-node f=1, equivocating peer sends mismatched-digest prepare: documented current behavior` (TODO(verify) byzantine.ts:321-368 digest-validation question; may need a separate issue)
- `4-node f=1, peer sends wrong-key-signed message: rejected at transport boundary`

### `__tests__/raft-cluster-faults.test.ts` (new)
- `5-node cluster, 0 faulty: exactly one leader emerges, term advances`
- `5-node cluster, 2 followers silent: leader still elected, log replicated to majority`
- `5-node cluster, 3 followers silent: no leader.elected emitted within 500ms`
- `5-node split-vote: two candidates at same term, at most one wins, loser steps down`
- `5-node stale-leader rejoin: old leader steps down on receiving higher-term heartbeat`

### `__tests__/gossip-cluster-loss.test.ts` (new)
- `10-node ring, 0% loss: full convergence within N rounds`
- `10-node ring, 30% loss: convergence within extended round budget`
- `10-node ring, 100% loss: no convergence (sanity)`
- `TTL=2 cannot reach 5-hop neighbor; hops/path tracked correctly`

### `__tests__/consensus-failure-injection.test.ts` (existing — supplement, do not rewrite)
Keep the existing 8 unit-level quorum-counter tests. Cross-link in a comment that the full-cluster variants live in the three new files above. Optionally add the "true replay" test here once the test-only escape hatch is in place (§2.5).

---

## 5. Dependencies — what's reusable

Cite-by-export-path so an implementer can grep:

- `LocalTransport`, `LocalTransportRegistry`, `defaultLocalRegistry` — `@claude-flow/swarm/src/consensus/transport.ts:194,165,183`. The registry is the cluster scaffold; one per test for isolation.
- `generateNodeKeyPair`, `signMessage`, `verifyMessage`, `canonicalizeForSigning`, `messageDigest` — `transport.ts:94,134,145,124,129`. Reuse for the wrong-key-signed and equivocation tests.
- `buildCluster(ids)` helper — `__tests__/raft-transport.test.ts:14-26`. Generalize into `__tests__/helpers/`; the BFT and Gossip suites need the same shape.
- `tallyVotes`, `injectQuorum` — `__tests__/consensus-failure-injection.test.ts:29-66,115-141`. Keep as-is for the single-node accounting tests; full-cluster tests use the new helpers.
- `RaftConsensus` with `{ transport }` option — `src/consensus/raft.ts:50,335,394`. Already wires `requestVote` and `appendEntries` through transport (raft.ts:337-358, 394-427).
- `ByzantineConsensus` with `{ transport }` option — `src/consensus/byzantine.ts:54,101-118,418-449`. Already routes inbound messages through `handleInboundMessage` (byzantine.ts:101).
- `GossipConsensus` with `{ transport, gossipIntervalMs }` option — exercised at `__tests__/gossip-transport.test.ts:20-22`; set `gossipIntervalMs: 1_000_000` to disable the auto-loop and drive deterministically.
- CI guard: `plugins/ruflo-core/scripts/test-consensus-transport.mjs` (mentioned in ADR-095 line 193). TODO(verify): inspect whether the new test files need to be added to that smoke job or if vitest discovery picks them up via `@claude-flow/swarm/vitest.config.ts`.

---

## 6. Estimated effort

| Artifact | LOC | Notes |
|---|---:|---|
| `__tests__/helpers/faulty-transport.ts` | ~120 | Wrapper + 3 cluster-builder helpers |
| `__tests__/bft-cluster-faults.test.ts` | ~200 | 7 tests across 4-node and 7-node clusters |
| `__tests__/raft-cluster-faults.test.ts` | ~220 | 5 tests, slightly heavier setup (election timing) |
| `__tests__/gossip-cluster-loss.test.ts` | ~180 | 4 tests, ring topology builder + drop-rate driver |
| `__tests__/consensus-failure-injection.test.ts` | +30 | Add true-replay test + cross-link comment |
| **Total** | **~750 LOC** | 4 files net new + 1 supplemented |

Effort for a competent implementer familiar with vitest and the existing G2 work: **1.5-2 focused days**. Bottleneck is debugging the timing in `raft-cluster-faults.test.ts` (election timeouts make assertions racy if not driven explicitly) — budget 4 hours there. The Byzantine equivocation test (§2.2) may surface a real protocol gap; if so, scope an issue rather than expanding this PR.

---

## 7. Open questions (TODO(verify) before implementation)

1. **`handlePrepare` digest validation** — `byzantine.ts:321-368` appears to dedup only by `senderId`, not by `(senderId, digest)`. If a faulty node sends a prepare with the wrong digest, does it count toward the 2f+1 quorum? Worth a 30-min read of the PBFT paper §4.2 and a behavioral test before deciding whether to file as a follow-up bug.
2. **Election-timeout determinism in Raft cluster tests** — `raft.ts:297-301` randomizes between `electionTimeoutMinMs` and `electionTimeoutMaxMs`. Tests should either set both to the same value or expose a test-only hook to trigger election directly. Pick one; document the choice in the helper.
3. **CI wiring** — confirm `vitest` picks up the new files from `@claude-flow/swarm/vitest.config.ts` and that the existing `mcp-roundtrip-smoke` job's `test-consensus-transport.mjs` (ADR-095 line 193) doesn't need updates.
4. **Cross-host runbook coordination** — the sibling `docs/runbooks/` cross-host runbook (referenced by the current branch name `docs/adr-095-g2-cross-host-runbook`) is not yet in the directory. Once it lands, link it from §1 here so the two failure-domain stories are discoverable together.
