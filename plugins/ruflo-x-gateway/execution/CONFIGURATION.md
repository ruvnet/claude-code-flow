# Operational launchers

Run from `plugins/ruflo-x-gateway/execution` using Node 22.18 or newer after `npm ci`.
These launchers run real services. They do not publish releases, automatically approve
patches, or turn gateway acknowledgments into verification evidence.

## Credentials and authority boundaries

Keep configuration and credential files outside the repository, owned by the service
user and mode `0600`. Each key file contains one 32 byte hexadecimal Nostr private
key. Each token file contains a random bearer token of at least 32 characters.
Generate keys with `nostr-tools/pure.generateSecretKey()` and public keys with
`getPublicKey(key)`; generate bearer tokens with `node:crypto.randomBytes(32)`.
Do not reuse transport, controller, worker or verifier identities. Never post private
keys or tokens to a public swarm channel. File paths below resolve relative to the
configuration file. Unix symlinks and group/world readable credential files are
rejected. Relative state directories also resolve against the configuration directory.

## Relay authority

Save the following as a private JSON configuration, replacing every placeholder.
The transport public key printed on startup is the `coordinatorPubkey` used by remote
clients. The controller public key authorizes task submission and cancellation; it
is a different identity from the transport key.

```json
{
  "stateRoot": "./state",
  "relayUrl": "wss://YOUR_RELAY",
  "leaseMs": 5000,
  "workspaces": [{
    "id": "team-alpha",
    "audience": "team-alpha-execution",
    "controllerPubkey": "CONTROLLER_PUBLIC_KEY_HEX",
    "verifierPubkeys": ["VERIFIER_PUBLIC_KEY_HEX"],
    "workerPolicies": [{
      "pubkey": "WORKER_PUBLIC_KEY_HEX",
      "capabilities": ["sum"],
      "cost": 1
    }],
    "transportSecretKeyFile": "./authority.key"
  }]
}
```

```bash
node src/federation-service.mjs /private/federation.json
```

Production relay URLs require `wss:`. A distinct authority and SQLite database are
created for each workspace. The relay must accept NIP-42 authentication and the
protocol's signed, NIP-44 encrypted messages. Relay acceptance does not prove task
execution. SIGINT and SIGTERM close all peers and databases. Partial startup failure
closes resources that already started. Configuration changes to persisted authority
policy require an explicit migration; restarting with altered policy is rejected.

## Remote role clients

Workers, verifiers and controllers use the same transport client with their own
allowlisted key. A client cannot acquire additional privileges by setting its role
in a request. The coordinator authorizes the signed public key.

```js
import { createRelayClient } from './src/relay.mjs';

// Load secretKey from your private credential manager, never from a task body.
const connection = await createRelayClient({
  relayUrl: 'wss://YOUR_RELAY',
  secretKey,
  workspace: 'team-alpha',
  audience: 'team-alpha-execution',
  coordinatorPubkey: authorityTransportPublicKey
});
try {
  // Controller or verifier key required; worker status access is rejected.
  const page = await connection.request('task_list', { limit: 20 });
  console.log(page);
} finally {
  connection.close();
}
```

Each separately operated worker must register, heartbeat, accept an assigned task,
renew its lease, and submit an artifact. A separate verifier accepts or rejects it.
The authority launcher does not fabricate worker or verifier activity.

## MCP, A2A and console service

The task service CLI bridges a **loopback coordinator HTTP endpoint** at `/command`.
It does not automatically start a coordinator or use the relay transport. Start a
local `createExecutionServer(coordinator)` first, or use the explicit relay composition
below. A bearer token selects its configured workspace; task bodies cannot select
another workspace or authority.

```json
{
  "host": "127.0.0.1",
  "port": 8788,
  "workspaces": [{
    "id": "team-alpha",
    "audience": "team-alpha-execution",
    "controllerSecretKeyFile": "./controller.key",
    "coordinatorUrl": "http://127.0.0.1:8787",
    "tokenFile": "./operator.token",
    "scopes": ["task:read", "task:submit", "task:cancel"]
  }]
}
```

```bash
node src/task-service.mjs /private/task-api.json
```

Omitting `scopes` grants only `task:read`. Cancellation through the API requires both
read and cancel scopes. Each workspace must have a unique token and audience.
The service never returns controller keys. Bearer tokens are credentials and require
TLS when used beyond loopback. To bind remotely, configure `allowRemote: true`, a
concrete `host`, and an HTTPS `agentUrl` behind your trusted TLS reverse proxy.
Example: `"agentUrl": "https://tasks.example/a2a"`. Configure `allowedOrigins` only
for explicitly trusted browser origins. Authentication is checked on every request.

Endpoints:

| Path | Purpose |
| --- | --- |
| `/mcp` | MCP SDK Streamable HTTP, stateless JSON responses |
| `/a2a` | Explicit A2A 0.3.0 subset: `message/send`, `tasks/get`, `tasks/cancel` |
| `/.well-known/agent-card.json` | Public capability metadata, no workspace records |
| `/console` | Public static shell; task reads and actions require bearer authentication |
| `/api/task_list` | Bounded cursor pagination, maximum 100 records |
| `/api/task_get` | Sanitized task metadata |
| `/api/task_submit` | Structured task submission |
| `/api/task_cancel` | Fenced task cancellation |
| `/api/artifact_get` | Completed artifact with matching verification, hash and epoch |

The console polls every five seconds and keeps an entered token only in page memory.
It does not store credentials in local storage. A2A streaming, push notifications,
continuations and arbitrary chat text are unsupported; this is not a full A2A
conformance claim. See the pinned [A2A 0.3.0 specification](https://a2a-protocol.org/v0.3.0/specification/).

For an authenticated relay controller connection, compose it with the HTTP server:

```js
import { startTaskApiServer } from './src/task-api-server.mjs';
// controllerConnection = await createRelayClient(...) with controller credentials.
// authenticate(req) must verify a token/session and return only the fixed principal.
const api = await startTaskApiServer({
  port: 8788,
  resolveRequest: async req => {
    if (!await authenticate(req)) return null;
    return {
      workspace: 'team-alpha',
      request: async (op, data) => {
        if (!['task_list', 'task_get'].includes(op)) throw Error('Read only');
        return controllerConnection.request(op, data);
      }
    };
  }
});
// On shutdown: await api.close(); controllerConnection.close();
```

Never use body workspace fields to select a global coordinator or signing key.
Accept a claimed successful deployment only after independent hosts complete a task,
the verifier signs acceptance, and the artifact can be retrieved with matching hash.
