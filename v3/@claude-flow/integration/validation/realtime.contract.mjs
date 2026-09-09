import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { RealtimeSession, consumeRealtimeBody, validateReflexHandoff } from '../dist/realtime-session.js';
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
const h = (sequence, kind = 'Cancel', extra = {}) => ({ version: 1, authority: 'none', session_id: 's', latest_sequence: String(sequence), queued_events: [{ sequence: String(sequence), at_micros: String(sequence), kind }], interrupt_sequence: kind === 'Interrupt' ? String(sequence) : null, cancel_sequence: kind === 'Cancel' ? String(sequence) : null, cancelled_work_units: '0', dropped_events: '0', ...extra });

test('reasoning completes and emits without changing its result', async () => {
  const seen = []; const s = new RealtimeSession('s', { onToken: text => seen.push(text) });
  const t = s.start('hello', async (input, c) => { c.emit(input); return 42; });
  assert.equal((await t.result).value, 42); await t.settled; assert.deepEqual(seen, ['hello']); assert.equal(s.telemetry.busy, false);
});
test('interrupt acknowledges immediately, aborts, and suppresses stale output', async () => {
  const entered = defer(), exit = defer(); const seen = [];
  const s = new RealtimeSession('s', { onToken: text => seen.push(text) });
  const t = s.start('', async (_, c) => { entered.resolve(); await exit.promise; c.emit('stale'); return 'stale'; });
  await entered.promise;
  assert.equal(s.acceptHandoff(h(1, 'Interrupt')).acknowledged, true);
  assert.equal(t.signal.aborted, true); assert.equal((await t.result).status, 'cancelled');
  assert.equal(await s.waitForQuiescence(5), 'INCOMPLETE');
  assert.throws(() => s.start('', async () => 1), /QUIESCENT/);
  exit.resolve(); await t.settled; assert.deepEqual(seen, []); assert.equal(s.telemetry.staleOutputs, 1);
});
test('cancel latch survives missing queued cancel caused by overflow', async () => {
  const exit = defer(); const s = new RealtimeSession('s');
  const t = s.start('', async () => exit.promise);
  const ack = s.acceptHandoff(h(2, 'Observation', { queued_events: [], cancel_sequence: '2', dropped_events: '1' }));
  assert.equal(ack.acknowledged, true); assert.equal(t.signal.aborted, true); assert.equal(ack.needsReconcile, true);
  exit.resolve(); await t.settled;
  assert.throws(() => s.start('', async () => 1), /SNAPSHOT/);
  assert.throws(() => s.reconcileSnapshot('a'.repeat(64), '1'), /SNAPSHOT/);
  s.reconcileSnapshot('a'.repeat(64), '2'); const next = s.start('', async () => 1); assert.equal((await next.result).status, 'completed'); await next.settled;
});
test('backchannel does not cancel ongoing reasoning', async () => {
  const exit = defer(), s = new RealtimeSession('s'); const t = s.start('', async () => exit.promise);
  assert.equal(s.acceptHandoff(h(1, 'Backchannel')).acknowledged, true); assert.equal(t.signal.aborted, false);
  exit.resolve(); await t.settled; assert.equal((await t.result).status, 'completed');
});
test('stale controls cannot cancel a new generation', async () => {
  const s = new RealtimeSession('s'); s.acceptHandoff(h(10));
  const exit = defer(); const t = s.start('', async () => exit.promise);
  assert.equal(s.acceptHandoff(h(9)).status, 'stale'); assert.equal(t.signal.aborted, false);
  s.acceptHandoff(h(11, 'Observation', { cancel_sequence: '10' })); assert.equal(t.signal.aborted, false);
  exit.resolve(); await t.settled;
});
test('uint64 sequences retain precision above JavaScript safe integer', () => {
  const s = new RealtimeSession('s');
  assert.equal(s.acceptHandoff(h('18446744073709551614')).status, 'accepted');
  assert.equal(s.acceptHandoff(h('18446744073709551615')).status, 'accepted');
  assert.throws(() => s.acceptHandoff(h('18446744073709551616')), /U64/);
});
for (const [name, patch] of [
  ['wrong session', { session_id: 'other' }], ['authority widening', { authority: 'execute' }],
  ['missing latch', { cancel_sequence: null }], ['numeric sequence', { latest_sequence: 1 }],
  ['leading zero', { latest_sequence: '01' }], ['future latch', { cancel_sequence: '2' }],
  ['null events', { queued_events: null }], ['duplicate events', { queued_events: [h(1).queued_events[0], h(1).queued_events[0]] }],
  ['unknown kind', { queued_events: [{ sequence: '1', at_micros: '1', kind: 'Execute' }] }],
  ['resource exhaustion', { queued_events: Array(4097).fill(h(1).queued_events[0]) }],
  ['negative clock', { queued_events: [{ sequence: '1', at_micros: '-1', kind: 'Cancel' }] }],
]) test(`rejects ${name} without mutating state`, () => {
  const s = new RealtimeSession('s'); assert.throws(() => s.acceptHandoff(h(1, 'Cancel', patch)));
  assert.equal(s.acceptHandoff(h(1)).status, 'accepted'); assert.equal(s.telemetry.rejectedHandoffs, 1);
});
test('invalid limits rejected', () => {
  for (const value of [NaN, Infinity, -1, 0, 300001, 1.1]) assert.throws(() => new RealtimeSession('s', { timeoutMs: value }));
});
test('tool invocation denied without a boundary', async () => {
  const s = new RealtimeSession('s'); const t = s.start('', async (_, c) => c.tool({ name: 'write', argumentsJson: '{}' }));
  await t.settled; assert.notEqual((await t.result).status, 'completed'); assert.equal(s.telemetry.startedTools, 0);
});
test('cancellation during asynchronous authorization prevents effect', async () => {
  const authorization = defer(), entered = defer(); let effects = 0;
  const s = new RealtimeSession('s', { tools: { authorize: async () => { entered.resolve(); return authorization.promise; }, execute: async () => { effects++; } } });
  const t = s.start('', async (_, c) => c.tool({ name: 'write', argumentsJson: '{}' }));
  await entered.promise; s.acceptHandoff(h(1)); authorization.resolve(true);
  await t.settled; assert.equal(effects, 0); assert.equal((await t.result).status, 'cancelled');
});
test('truthy authorization is not a grant', async () => {
  let effects = 0; const s = new RealtimeSession('s', { tools: { authorize: async () => 'yes', execute: async () => { effects++; } } });
  const t = s.start('', async (_, c) => c.tool({ name: 'write', argumentsJson: '{}' })); await t.settled; assert.equal(effects, 0);
});
test('tool proposal is frozen across asynchronous policy lookup', async () => {
  const entered = defer(), approved = defer(); let executed;
  const proposal = { name: 'safe', argumentsJson: '{"safe":true}' };
  const s = new RealtimeSession('s', { tools: { authorize: async p => { assert.equal(Object.isFrozen(p), true); entered.resolve(); return approved.promise; }, execute: async p => { executed = p; return 1; } } });
  const t = s.start('', async (_, c) => c.tool(proposal)); await entered.promise;
  proposal.name = 'danger'; proposal.argumentsJson = '{}'; approved.resolve(true); await t.settled;
  assert.equal(executed.name, 'safe'); assert.equal((await t.result).status, 'completed');
});
test('cancel signal reaches delegated tasks and tool execution', async () => {
  const delegateEntered = defer(), toolEntered = defer(); let delegatesStopped = 0, toolsStopped = 0;
  const wait = (c, fn) => new Promise(resolve => { c.signal.addEventListener('abort', () => { fn(); resolve(); }, { once: true }); });
  const s = new RealtimeSession('s', { tools: { authorize: async () => true, execute: async (_, c) => { toolEntered.resolve(); return wait(c, () => toolsStopped++); } } });
  const t = s.start('', async (_, c) => {
    const child = c.spawn(async cc => { delegateEntered.resolve(); return wait(cc, () => delegatesStopped++); });
    await Promise.all([child, c.tool({ name: 'work', argumentsJson: '{}' })]);
  });
  await Promise.all([delegateEntered.promise, toolEntered.promise]); s.acceptHandoff(h(1));
  await t.settled; assert.equal(delegatesStopped, 1); assert.equal(toolsStopped, 1); assert.equal(await s.waitForQuiescence(), 'STOPPED');
});
test('deadline cancels cooperative work', async () => {
  const s = new RealtimeSession('s', { timeoutMs: 5 });
  const t = s.start('', async (_, c) => new Promise(resolve => c.signal.addEventListener('abort', resolve, { once: true })));
  assert.equal((await t.result).code, 'DEADLINE'); await t.settled;
});
test('output cap cancels rather than retaining unbounded text', async () => {
  const s = new RealtimeSession('s', { maxOutputChars: 3 });
  const t = s.start('', async (_, c) => { assert.equal(c.emit('abcd'), false); });
  await t.settled; assert.equal((await t.result).code, 'OUTPUT_LIMIT');
});
test('delegate cap blocks excess tasks', async () => {
  let ran = 0; const s = new RealtimeSession('s', { maxDelegates: 1 });
  const t = s.start('', async (_, c) => { await c.spawn(async () => { ran++; }); await c.spawn(async () => { ran++; }); });
  await t.settled; assert.equal(ran, 1); assert.equal((await t.result).status, 'failed');
});
test('close is terminal and leaves no resumable generation', async () => {
  const s = new RealtimeSession('s'); s.close(); assert.throws(() => s.start('', async () => 1), /CLOSED/); assert.throws(() => s.acceptHandoff(h(1)), /CLOSED/);
});
test('abort cancels a pending ReadableStream reader', async () => {
  const entered = defer(); let cancelled = false;
  const stream = new ReadableStream({ pull() { entered.resolve(); }, cancel() { cancelled = true; } });
  const s = new RealtimeSession('s'); const t = s.start('', async (_, c) => consumeRealtimeBody(stream, c));
  await entered.promise; s.acceptHandoff(h(1)); await t.settled; assert.equal(cancelled, true); assert.equal(stream.locked, false);
});
test('HTTP provider stream physically closes after cancellation', async () => {
  const first = defer(), socketClosed = defer(); let produced = 0, postAbort = 0, abortObserved = false;
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    const send = () => { produced++; if (abortObserved) postAbort++; res.write('token\n'); };
    send(); const interval = setInterval(send, 2);
    res.on('close', () => { clearInterval(interval); socketClosed.resolve(); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const s = new RealtimeSession('s', { onToken: () => first.resolve() });
    const t = s.start('', async (_, c) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}`, { signal: c.signal });
      await consumeRealtimeBody(response.body, c);
    });
    await first.promise; abortObserved = true; s.acceptHandoff(h(1));
    await t.settled;
    await Promise.race([socketClosed.promise, new Promise((_, reject) => { const tm = setTimeout(() => reject(new Error('SOCKET_NOT_CANCELLED')), 1000); tm.unref(); })]);
    const atClose = produced; await new Promise(r => setTimeout(r, 10)); assert.equal(produced, atClose); assert.ok(postAbort <= 5);
    assert.equal((await t.result).status, 'cancelled'); assert.equal(await s.waitForQuiescence(), 'STOPPED');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
test('1000 interrupted sessions preserve bounds and suppress every late result', async () => {
  for (let i = 0; i < 1000; i++) {
    const exit = defer(), s = new RealtimeSession('s');
    const t = s.start('', async (_, c) => { await exit.promise; assert.equal(c.emit('late'), false); return 'late'; });
    s.acceptHandoff(h(1)); s.acceptHandoff(h(2)); exit.resolve(); await t.settled;
    assert.equal((await t.result).status, 'cancelled'); assert.equal(s.telemetry.cancellations, 1); assert.equal(s.telemetry.busy, false);
  }
});
