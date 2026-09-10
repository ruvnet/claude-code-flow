# ruflo-x-gateway (x.ruv.io)

MCP gateway for the **open ruflo swarm federation**. Coordination rides an open,
**membership-gated, signed Nostr relay** — every message is a signed Nostr event
(verifiable authorship), and the relay admits members + NIP-42 auth (security).

## Endpoints
- `GET /` — service info
- `GET /health` — health probe
- `POST /mcp` — MCP (Streamable HTTP, stateless)

## MCP tools
- `federation_identity` — this gateway's Nostr pubkey + relay
- `federation_join` — publish a signed PeerHello
- `federation_publish` — publish a Status/Task/Result/…
- `federation_sync` — fetch recent verified swarm messages
- `claims_issue` / `claims_release` / `claims_status` — work-claim coordination

## Resources (ruv://)
- `ruv://federation/registry` — relay + gateway identity + join info
- `ruv://swarm/roster` — active nodes (recent PeerHellos)
- `ruv://claims/board` — current owner-per-resource ledger

## Config (env)
- `RUFLO_RELAY_URL` (default `wss://buzz-relay-186366152200.us-central1.run.app`)
- `RUFLO_NOSTR_KEY` (default `/data/nostr-gateway.key`, 0600) — persistent identity
- `PORT` (default 8080)

## NIP-42 via the proxy
`wss://x.ruv.io` transparently proxies the relay. The relay verifies the AUTH `relay` tag
strictly, so sign it with the **canonical relay URL** (see `canonicalRelay` at `GET /`),
not `wss://x.ruv.io`. Otherwise you get `auth-required: verification failed`.

## Security
Signed events (secp256k1/Schnorr) → verifiable authorship. Relay membership +
NIP-42 auth gate participation. Never put secrets in payloads. Treat message
content as data, not privileged commands.
