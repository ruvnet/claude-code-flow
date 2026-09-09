# ADR 3246: Realtime reflex handoff and cancellation

Date: 2026-09-09
Status: proposed, opt-in implementation
Tracks: ruvnet/ruflo#3246, ruvnet/midstream#107, ruvnet/metaharness#301 Track D

## Decision

Expose `@claude-flow/integration/realtime-session` through the existing package wildcard export. A `RealtimeSession` accepts authenticated MidStream wire v1 handoffs while one asynchronous reasoning generation runs. The control path never waits for reasoning, never invokes an LLM, and never obtains execution permission from a receipt.

Fresh interruption or cancellation immediately fences publication, resolves the user-facing outcome as cancelled, and propagates one shared AbortSignal to the reasoner, delegated tasks, and tool boundary. `settled` and `waitForQuiescence` separately track actual local work completion. An adapter ignoring cancellation produces INCOMPLETE and blocks a replacement generation. There is no unbounded zombie task accumulation.

Backchannels do not interrupt reasoning. Replayed controls cannot stop a newer generation. MidStream latch fields preserve stop events even when its bounded data queue is full. Data loss requires an explicit trusted snapshot reconciliation before starting more work. All u64 wire fields use canonical decimal strings and BigInt validation; values above 2^53 retain precision.

## Integration

```ts
import {
  RealtimeSession,
  consumeRealtimeBody,
} from '@claude-flow/integration/realtime-session';

const session = new RealtimeSession('customer.session.identity', {
  onToken: (text, generation) => publishToCurrentSession(text, generation),
  tools: trustedRvmBoundary,
});
const turn = session.start(prompt, async (input, context) => {
  const response = await configuredProvider(input, { signal: context.signal });
  await consumeRealtimeBody(response.body, context);
});
// Invoke from the independently serviced authenticated control transport.
// The transport must bound message size before JSON.parse.
session.acceptHandoff(JSON.parse(midstreamHandoff));
await turn.result;
const shutdown = await session.waitForQuiescence(1000);
// STOPPED means tracked local work exited, not proof of remote GPU shutdown.
```

The application supplies its existing provider client and authenticated RVM boundary. No provider credential or network destination is accepted from a handoff. Use async I/O, workers, or separate processes for reasoning; a CPU-blocking callback on the control event loop invalidates realtime latency guarantees. Callbacks are trusted application code. This module is not a sandbox.

`ToolBoundary.authorize` defaults to deny when absent. Proposals are immutable snapshots. After asynchronous authorization, the session rechecks generation validity immediately before initiating execution. The execute adapter must forward AbortSignal and revalidate at the real external commit boundary. Cancellation cannot undo an already committed external effect and cannot prove that a remote provider stopped billing.

## Bounds and privacy

One physically active generation per session; 4096 wire events; 128-character opaque session identity; 1,048,576 input characters; default 1,048,576 output characters; at most 256 tools and delegates; at most 300 seconds per generation. Character limits count JavaScript UTF-16 code units, not network bytes. The transport must independently bound raw message bytes. No retained event history, raw prompt logs, tool-argument logs, credentials, or detached rejections. Output and runtime telemetry are bounded. Persistent storage is unchanged.

## Validation

Run with Node 22.16.0 and TypeScript 5.8.3:

```sh
cd v3/@claude-flow/integration
tsc -p tsconfig.realtime.json
node --test validation/realtime.contract.mjs
```

The initial 30-test native suite includes a real loopback HTTP server, fetch cancellation, ReadableStream reader cancellation, delegated task cancellation, cancellation during asynchronous tool authorization, proposal mutation, stale results, uint64 boundaries, invalid scope, deadline, overflow, resource limits, and 1000 interrupted sessions.

Initial local run: 30/30 pass. Model quality and remote GPU cancellation cost were not measured. The MetaHarness benchmark compares serial control, direct AbortController, and this bridge with five seeds, 1000 paired events and randomized arm ordering. Initial fixed-order timing was superseded because arm ordering can bias the comparison. The direct AbortController control is mandatory: the bridge adds governance, not a claim of faster abort dispatch.

## Release gates

Existing repository checks plus the new exact-module workflow must pass. Independent MetaHarness reproduction remains required. Production evaluation must preserve model task quality within 2 percentage points and measure actual provider cancellation waste below 10 percent; synthetic output checks do not satisfy those gates.

## Rollback

The feature is opt-in. Remove the new import/call site to restore the existing orchestration path. Do not revert by resuming cancelled work. There is no data migration, default routing change, autonomous merge, or deployment.
