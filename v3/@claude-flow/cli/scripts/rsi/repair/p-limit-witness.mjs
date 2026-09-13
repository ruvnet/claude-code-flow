// Reviewed, public historical witness. No candidate patch input or provider calls.
import assert from 'node:assert/strict';
import pLimit, { limitFunction } from './index.js';

const rows = [];
async function check(name, fn) {
  try { await fn(); rows.push({ name, passed: true }); }
  catch (error) { rows.push({ name, passed: false, error: error.message }); }
}
const cpu = process.cpuUsage(), start = performance.now();
await check('ordinary map retains order', async () => {
  assert.deepEqual(await pLimit(2).map([3, 1, 2], async value => value * 2), [6, 2, 4]);
});
await check('invalid concurrency rejects', () => {
  for (const value of [0, -1, 1.5, NaN]) assert.throws(() => pLimit(value), TypeError);
});
await check('function wrapper preserves arguments and result', async () => {
  assert.equal(await limitFunction(async (a, b) => a + b, { concurrency: 1 })(2, 7), 9);
});
await check('wrapper clears pending calls without cancelling running call', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const called = [];
  const limited = limitFunction(async value => { called.push(value); await gate; return value; },
    { concurrency: 1, rejectOnClear: true });
  assert.equal(typeof limited.clearQueue, 'function');
  const running = limited('running');
  // Install rejection observers before clearing; no timing race or unhandled rejection.
  const pending = [limited('pending-1'), limited('pending-2')].map(p =>
    p.then(value => ({ value }), error => ({ error: error.name })));
  limited.clearQueue();
  release();
  assert.equal(await running, 'running');
  assert.deepEqual(await Promise.all(pending), [{ error: 'AbortError' }, { error: 'AbortError' }]);
  assert.deepEqual(called, ['running']);
  assert.equal(await limited('after-clear'), 'after-clear');
});
console.log(JSON.stringify({ rows, elapsedMs: performance.now() - start,
  cpuMicros: process.cpuUsage(cpu), maxRssKb: process.resourceUsage().maxRSS }));
