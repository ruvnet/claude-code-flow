# G2 Cross-Host Consensus Validation Runbook

- **Tracks:** [ADR-095 G2 — Hive-mind multi-process consensus](../adr/ADR-095-architectural-gaps-from-april-audit.md) ("Status update — 2026-05-11", lines 149–201)
- **Wire transports:** [ADR-104 (WS via `agentic-flow/transport/loader`)](../adr/ADR-104-federation-wire-transport.md), [ADR-107 (TLS posture)](../adr/ADR-107-federation-tls.md), [ADR-111 (optional WG mesh)](../adr/ADR-111-federation-wg-mesh.md)
- **Repo state at authoring:** `v3.7.0-alpha.23-17-g545426f60` on branch `docs/adr-095-g2-cross-host-runbook`
- **Implements (read these to ground):** `@claude-flow/swarm/src/consensus/transport.ts` (`LocalTransport`, signing helpers), `@claude-flow/swarm/src/consensus/federation-transport.ts` (`FederationTransport`), `@claude-flow/swarm/src/consensus/index.ts` (factory + re-exports)

---

## 1. Purpose & Scope

This runbook walks an operator through the **first real two-host run** of the hive-mind consensus protocols (Raft, Byzantine, Gossip) over the federation plugin's ADR-104 WebSocket wire, with **real Ed25519 message signing** and **per-sender monotonic-`seq` replay defense**. It is the third and final item gating ADR-095 G2:

> "Cross-host validation (mac ↔ ruvultra over tailscale, root) once `FederationTransport` is wired into a real hive-mind + federation setup." — ADR-095 line 198

### In scope

- Two hosts, one consensus cluster per protocol (3+ logical nodes spread across the two hosts).
- `FederationTransport` carrying every `ConsensusMessage` (`@claude-flow/swarm/src/consensus/federation-transport.ts:73`) over the federation plugin's WS wire (selected backend per ADR-104 is `websocket` until native QUIC lands).
- Ed25519 signing/verification end-to-end (`signMessage`/`verifyMessage` at `transport.ts:134` and `transport.ts:145`; canonical-JSON over deep-sorted keys at `transport.ts:107`).
- Per-sender replay defense via `seq` (`transport.ts:202`, `federation-transport.ts:86`).
- BFT quorum sanity at `n=4` (so `f = floor((4-1)/3) = 1`, quorum `2f+1 = 3`) — per ADR-095 line 192.

### Out of scope (separate runbooks)

- **Failure-injection tests** (silenced nodes, equivocating nodes, partitioned links) — ADR-095 line 197 calls these out as their own track. This runbook proves the happy path on real wire; the failure runbook proves correctness below threshold.
- WG mesh (ADR-111) — opt-in, Phase 4–7 still Proposed. Tailscale-as-TLS (ADR-107 v1) is the assumed path here.
- `wss://` + cert pinning (ADR-107 v2) — only needed if peers cross trust domains; this runbook stays inside one tailnet.

---

## 2. Topology

```
                tailnet (WireGuard, managed by Tailscale)
                              |
   +--------------------------+--------------------------+
   |                                                     |
   v                                                     v
+-------------------------+                +-------------------------+
|  mac (darwin/arm64)     |                |  ruvultra (linux/x64)   |
|  role: leader candidate |   WS :9101     |  role: peer             |
|  hosts logical nodes:   | <------------> |  hosts logical nodes:   |
|    - mac-A              |   (ADR-104)    |    - ruv-A              |
|    - mac-B              |                |    - ruv-A2             |
+-------------------------+                +-------------------------+
```

- **Cluster size for Raft / Byzantine runs:** `n=4` (2 nodes per host). Forces every quorum decision to cross the wire.
- **Cluster size for Gossip run:** `n=5` (mac runs 3, ruvultra runs 2) so we can observe propagation hops.
- **Wire address scheme:** matches the FederationTransport test fixture (`@claude-flow/swarm/__tests__/federation-transport.test.ts:48`) — `ws://<host>:9101` per host, logical node ids multiplexed on a single stream via ADR-104 `streamId` (`federation-transport.ts:93`, defaults to `'ruflo-consensus'`).
- **TLS posture:** tailnet provides confidentiality + identity (ADR-107 line 11). No `wss://`.

---

## 3. Prerequisites

### Software (both hosts)

| Item | Version / Source | Verify |
|---|---|---|
| Node.js | `>=22` (repo-pinned, per memory `project_pulsecheck_node22_convention`) | `node -v` -> `v22.x.x` |
| ruflo CLI | `v3.7.0-alpha.23` or newer (current `git describe`: `v3.7.0-alpha.23-17-g545426f60`) | `npx @claude-flow/cli@v3alpha --version` |
| `@claude-flow/swarm` | `3.0.0-alpha.7` (per `@claude-flow/swarm/package.json`) | `npm ls @claude-flow/swarm` |
| `agentic-flow` | `2.0.12-fix.1` or newer on `fix` dist-tag (ADR-104 line 75) | `npm view agentic-flow@fix version` |
| Federation plugin | `@claude-flow/plugin-agent-federation@1.0.0-alpha.13+` (ADR-107 line 3 "alpha.12") | `npm ls @claude-flow/plugin-agent-federation` |
| Tailscale | any version both hosts can join the same tailnet | `tailscale status` shows both hosts |
| `ANTHROPIC_API_KEY` | set in env on whichever host launches the hive-mind | `echo $ANTHROPIC_API_KEY \| wc -c` non-zero |

### Hardware

Minimal. Each host needs:
- 1 CPU core idle, 1 GiB free RAM (the consensus protocols are tiny).
- Tailnet IP reachable from the peer (`tailscale ping <peer>`).
- TCP `:9101` free on each host (the WS listener port from `__tests__/federation-transport.test.ts:48`).

### Repo

Both hosts must have the v3 monorepo checked out at the **same commit** so the `ConsensusMessage` schema and canonical-JSON signing format match exactly. Different commits = different `canonicalizeForSigning` outputs = silent verification failures.

```bash
git -C ~/Projects/claude-flow/v3 rev-parse HEAD   # must match on both hosts
```

---

## 4. Step-by-step Setup

### 4.1 — Generate Ed25519 keypairs (one per logical node)

`generateNodeKeyPair` is exported from `@claude-flow/swarm/src/consensus/transport.ts:94`. The helper wraps Node's built-in `crypto.generateKeyPairSync('ed25519')` and returns PKCS8/SPKI PEMs — no new deps (ADR-095 line 189).

On **mac**:

```bash
cd ~/Projects/claude-flow/v3
node -e "
  const { generateNodeKeyPair } = await import('./@claude-flow/swarm/dist/consensus/transport.js');
  for (const id of ['mac-A', 'mac-B']) {
    const kp = generateNodeKeyPair();
    require('fs').mkdirSync('.claude-flow/g2-keys', { recursive: true });
    require('fs').writeFileSync(\`.claude-flow/g2-keys/\${id}.private.pem\`, kp.privateKeyPem, { mode: 0o600 });
    require('fs').writeFileSync(\`.claude-flow/g2-keys/\${id}.public.pem\`, kp.publicKeyPem);
    console.log(id, 'OK');
  }
"
```

On **ruvultra** repeat with ids `ruv-A` and `ruv-A2` (and `ruv-B` if running the gossip cluster).

> TODO(verify): the `dist/` path assumes `npm run build` has been run in `@claude-flow/swarm`. If running from source, swap `./dist/consensus/transport.js` for `./src/consensus/transport.ts` and invoke via `tsx`.

### 4.2 — Distribute public keys

Each host needs every peer's public PEM to populate the `resolvePeerPublicKey` callback (`transport.ts:191`, `federation-transport.ts:70`). Copy the `.public.pem` files across in either direction:

```bash
# from mac:
scp .claude-flow/g2-keys/mac-{A,B}.public.pem ruvultra:~/Projects/claude-flow/v3/.claude-flow/g2-keys/
# from ruvultra:
scp .claude-flow/g2-keys/ruv-{A,A2}.public.pem mac:~/Projects/claude-flow/v3/.claude-flow/g2-keys/
```

After this, both hosts have all four `*.public.pem` files plus their own private keys.

### 4.3 — Start the federation WS listener on each host

The federation plugin's listener is the agentic-flow `WebSocketFallbackTransport` (ADR-104 line 53). Bring it up on both hosts on port `9101`.

> TODO(verify): the exact CLI surface for "start a bare federation listener bound to the consensus stream" is not directly callable as a single subcommand in the current `@claude-flow/cli/src/commands/hive-mind.ts` — the listener is brought up as a side effect of `hive-mind init` (when the plugin is configured). Confirm with maintainers whether a standalone `federation_init` command is preferred, and update this section with the exact invocation before sign-off.

Expected handshake log (from ADR-104 line 50):

```
[srv] LISTENING on 0.0.0.0:9101
[srv] caps: {"quicAvailable":false,"webSocketFallbackAvailable":true,"selectedBackend":"websocket"}
```

### 4.4 — Init the hive-mind on mac (the "queen" host)

From `@claude-flow/cli/src/commands/hive-mind.ts:413` — the `init` subcommand takes `--topology` and `--consensus`:

```bash
# Raft run
npx @claude-flow/cli@v3alpha hive-mind init \
  --topology hierarchical-mesh \
  --consensus raft \
  --max-agents 4 \
  --persist
```

Capture the `hiveId` it prints — you need it for `join` from the other host.

### 4.5 — Join the other host's logical nodes

From `@claude-flow/cli/src/commands/hive-mind.ts:1140`:

```bash
# on ruvultra, for each logical node:
npx @claude-flow/cli@v3alpha hive-mind join --agent-id ruv-A  --role worker
npx @claude-flow/cli@v3alpha hive-mind join --agent-id ruv-A2 --role worker
```

> TODO(verify): the `hive-mind join` command targets the local MCP server (`callMCPTool('hive-mind_join', ...)` at line 1154). For a **cross-host** join the MCP server on ruvultra must be configured to forward join requests to the mac queen via the FederationTransport. Verify this end-to-end before claiming sign-off — it is the most likely undiscovered gap.

### 4.6 — Confirm transport is wired

Run on **both** hosts:

```bash
npx ruflo doctor --component federation
```

Expect (per ADR-104 line 96, ADR-107 line 131):

```
[OK] Federation Breaker: ADR-097 breaker loadable
[OK] Federation Transport: selectedBackend=websocket (native QUIC unavailable)
```

If `selectedBackend=quic` appears unexpectedly, an `AGENTIC_FLOW_QUIC_NATIVE=1` env var is set somewhere — unset it for this runbook.

---

## 5. Validation Procedure

Run each sub-run in sequence; tear down the cluster (Section 7) between protocols so logs are clean.

### 5.1 — Raft (n=4, leader-based)

| Step | Command | Expected outcome |
|---|---|---|
| Trigger leader election | (automatic on `init`; or `hive-mind consensus --action propose --type leader-election --value '{}'` per `hive-mind.ts:1179`) | Exactly one node logs `leader.elected` (event forwarded at `index.ts:128`) |
| Propose a value | `hive-mind consensus --action propose --type test --value '{"x":1}'` | Proposal id returned |
| Inspect cluster state | `hive-mind consensus --action list` and `hive-mind status` (per `hive-mind.ts:760`) | All 4 nodes show same `commitIndex`, same `term`, same proposal in `accepted` state |
| Inspect signatures | Tail federation transport debug logs (`DEBUG=ruflo:federation:* ...`) | Each outbound message carries non-empty `signature`; inbound verify never logs `signature verification failed` |

**Success assertions:**

1. `hive-mind consensus --action list` on **both hosts** returns the same proposal with `status: 'accepted'`.
2. All 4 nodes agree on the same `commitIndex` after the proposal commits. Inspect via `hive-mind status --format json` and `jq '.nodes[].commitIndex'` — set must be a singleton.
3. Term comparison rule is honored: a stale-term `AppendEntries` is rejected (look for `term mismatch` in logs).

### 5.2 — Byzantine PBFT (n=4, f=1, quorum=3)

Re-init with `--consensus byzantine`. ADR-095 line 192: `f` is derived from cluster size as `floor((n-1)/3)`, clamped >= 1; quorum `2f+1`. For `n=4`: `f=1`, quorum `3`.

| Step | Command | Expected outcome |
|---|---|---|
| Propose | `hive-mind consensus --action propose --type test --value '{"y":2}'` | Pre-prepare broadcast from primary |
| Watch PBFT phases | Tail logs for `pre-prepare` -> `prepare` -> `commit` (message types per `transport.ts:36`) | All 4 nodes broadcast `prepare` then `commit`; each node counts >= `2f+1 = 3` matching commits before deciding |
| Verify digests | Grep for `messageDigest` (sha256 from `transport.ts:130`, replaced the toy 32-bit hash per ADR-095 line 191) | Same hex digest for the same proposal across all 4 nodes |

**Success assertions:**

1. All 4 nodes converge to the same accepted proposal.
2. Quorum size in logs matches `2f+1 = 3` (where `f = floor((4-1)/3) = 1`).
3. Every commit message bears a valid Ed25519 signature (no `verifyMessage` returning false).

### 5.3 — Gossip (n=5, eventually consistent)

Re-init with `--consensus gossip --max-agents 5`. Add a 5th logical node so `n=5`.

| Step | Command | Expected outcome |
|---|---|---|
| Broadcast a message | `hive-mind broadcast --message '{"hello":"world"}'` (per `hive-mind.ts:1208`) | Originating node fans out `gossip` messages to its neighbors |
| Inspect propagation | `hive-mind memory --action get ...` on each node, with a 2s delay between samples | Message id appears on all 5 nodes within ~3 rounds (each round = one `defaultTimeoutMs` of 5s, `federation-transport.ts:94`) |
| Verify dedup | Same node sees the same message multiple times | Per-id dedup (ADR-095 line 191) drops repeats — the gossip handler is idempotent |

**Success assertions:**

1. All 5 nodes eventually observe the gossip message.
2. No node emits the same message id twice (dedup-by-id works).
3. All inbound messages pass Ed25519 verify; replay attempts (a node receiving a `seq` <= its `lastSeenSeq` for that sender, `federation-transport.ts:109`) are dropped silently.

---

## 6. Common Failure Modes & Diagnosis

| Symptom (log string to grep) | Likely cause | First thing to check |
|---|---|---|
| `LocalTransport: signature verification failed for message from <id>` (`transport.ts:242`) — analogous to FederationTransport silently dropping at `federation-transport.ts:107` | Public PEM for sender not distributed, OR `canonicalizeForSigning` output differs across hosts | (a) Are both hosts on the same git commit? `git rev-parse HEAD`. (b) Is the sender's `.public.pem` present in `.claude-flow/g2-keys/` on the receiver? (c) Clock skew >5s? `chronyc tracking` / `sntp -t 3 pool.ntp.org`. |
| `LocalTransport: replayed/out-of-order seq from <id> (<seq> <= <last>)` (`transport.ts:247`) or silent drop in FederationTransport (`federation-transport.ts:110`) | Sender restarted and reset `seqCounter` to 0 while receiver still has the old `lastSeenSeq` | Receiver must be restarted too, OR purge `.claude-flow/g2-keys/seq-state-*.json` if persisted. seq counters are in-memory only (`transport.ts:202`, `federation-transport.ts:84`) so a both-side restart fixes it. |
| `FederationTransport: send to <id> timed out (5000ms)` (`federation-transport.ts:161`) | Tailnet partition, WS port blocked, or remote `wire.onMessage` handler never fired | `tailscale ping <peer>`; `curl -i --no-buffer http://<peer>:9101/` (expect WS upgrade error, NOT connection refused); confirm `[srv] LISTENING` log on the remote. |
| `FederationTransport: no address for peer <id>` (`federation-transport.ts:156`) | The `addressOf` callback returned `undefined` — node is in the cluster registry but not in the address book | Verify the peer's `nodeId` matches what `peerIds()` returns; cross-check spelling between init and join commands. |
| Raft never elects a leader; all nodes stuck in `candidate` | Vote messages crossing the wire but signatures failing -> vote silently dropped at `federation-transport.ts:107` (fail-closed) | This is the canonical sign of misdistributed pubkeys. Grep for `signature verification failed` on every host — at least one will have it. |
| Byzantine never reaches `commit` despite all 4 nodes online | Quorum miscalculated. ADR-095 line 192 says `f` is derived from cluster size; if some old code path is hardcoding `f=1` for `n=3`, quorum becomes 3 of 3, which fails the moment one node lags | Look for `quorum=` in logs; should be `3` for n=4. If `4`, you've hit the regression the ADR-095 G2 fix was meant to close — flag it. |
| `selectedBackend=quic` in doctor when it should be `websocket` | `AGENTIC_FLOW_QUIC_NATIVE=1` is set, and a stub QUIC binding is being picked up (ADR-104 line 30) | `env \| grep AGENTIC_FLOW`; unset and restart. |
| Gossip messages propagate to direct neighbors but stop there | The receiving gossip handler is not re-broadcasting (dedup too aggressive, or the inbound message has no peers to fan out to from that node) | Confirm each node's `peers()` returns the other `n-1`; if a node shows `peers().length === 0` the join didn't register that node in the discovery list. |

---

## 7. Teardown

Per protocol, before moving to the next sub-run:

```bash
# On both hosts:
npx @claude-flow/cli@v3alpha hive-mind shutdown   # see hive-mind.ts:1262
```

After all three sub-runs:

```bash
# Stop the federation WS listener (whichever way 4.3 brought it up).
# Clear key material if this was a one-shot run:
rm -rf .claude-flow/g2-keys/
# Clear hive-mind persistent state:
rm -rf .claude-flow/hive-mind/
```

> TODO(verify): exact paths for hive-mind persistence — `--persist` flag at `hive-mind.ts:444` is described as "Enable persistent state" but the on-disk location isn't visible from the command file. Confirm with the MCP tool implementation before publishing.

---

## 8. Sign-off Checklist

Mark each box only with evidence — a log line, a JSON snapshot, or a screenshot of the doctor output. Attach evidence to the PR that closes ADR-095 G2.

- [ ] Both hosts on the same git commit (`git rev-parse HEAD` matches).
- [ ] `selectedBackend=websocket` reported by `ruflo doctor --component federation` on both hosts.
- [ ] **Raft:** all 4 nodes converge on the same `commitIndex` after a proposal; exactly one `leader.elected` event observed.
- [ ] **Byzantine:** all 4 nodes accept the same proposal; quorum size in logs is `2f+1 = 3` for `n=4`.
- [ ] **Gossip:** all 5 nodes observe the broadcast message within 3 propagation rounds; no duplicate handling.
- [ ] Every inbound `ConsensusMessage` on both hosts carries a valid Ed25519 signature (zero `verifyMessage` failures in the happy-path logs).
- [ ] At least one deliberate signature tamper (e.g. flip a byte in a public PEM on one host) results in fail-closed drop on the receiver — proves the verify path is exercised, not bypassed.
- [ ] At least one deliberate replay attempt (re-send a captured envelope) is rejected with the `seq` check (`transport.ts:247` / `federation-transport.ts:110`).
- [ ] Teardown leaves no listening port on `:9101` and no stale hive-mind state files.

When every box is checked and evidence is attached, append to ADR-095 line 198:

> **2026-MM-DD — G2 cross-host validated.** Evidence: `<link to PR / log bundle>`. Remaining G2 item: failure-injection tests (separate runbook).

---

## References

- ADR-095 status update: `docs/adr/ADR-095-architectural-gaps-from-april-audit.md:149-201`
- `ConsensusTransport` interface: `@claude-flow/swarm/src/consensus/transport.ts:63-80`
- `LocalTransport` (default, in-process): `@claude-flow/swarm/src/consensus/transport.ts:194-284`
- Ed25519 helpers: `@claude-flow/swarm/src/consensus/transport.ts:94-154`
- `FederationTransport`: `@claude-flow/swarm/src/consensus/federation-transport.ts:73-185`
- Consensus factory re-exports: `@claude-flow/swarm/src/consensus/index.ts:27-50`
- `hive-mind init` / `join` CLI: `@claude-flow/cli/src/commands/hive-mind.ts:413`, `:1139`
- ADR-104 transport selection: `docs/adr/ADR-104-federation-wire-transport.md`
- ADR-107 TLS posture (tailnet trust v1): `docs/adr/ADR-107-federation-tls.md`
- ADR-111 (optional WG mesh, opt-in; not required by this runbook): `docs/adr/ADR-111-federation-wg-mesh.md`
- Test fixture for `FederationTransport` (the same wiring pattern this runbook drives): `@claude-flow/swarm/__tests__/federation-transport.test.ts`
