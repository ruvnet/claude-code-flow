import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/routing.mjs';
const worker = (pubkey, extra = {}) => ({ pubkey, capabilities: ['sum'], cost: 1, available: true, ...extra });
const task = { id: 'task', capability: 'sum', vector: [1, 0], budget: 2 };
const keys = xs => xs.map(x => x.pubkey);
const history = (worker, vector, extra = {}) => ({ id: worker, worker, vector, capability: 'sum', verified: true, cost: 1, latencyMs: 10, ...extra });

test('fixed and single enforce capability, availability and budget before selection', async () => {
  const workers = [worker('offline', { available: false }), worker('wrong', { capabilities: ['exec'] }),
    worker('expensive', { cost: 3 }), worker('nan', { cost: NaN }), worker('negative', { cost: -1 }),
    worker('b'), worker('a'), worker('a')];
  const fixed = await createRouter();
  assert.deepEqual(keys(await fixed.rank(task, workers)), ['a', 'b']);
  const single = await createRouter({ mode: 'single' });
  assert.deepEqual(keys(await single.rank(task, workers)), ['b']);
  assert.deepEqual(await fixed.rank(task, []), []);
  await assert.rejects(fixed.rank({ ...task, budget: Infinity }, workers), /budget/);
  await fixed.close();
  await assert.rejects(fixed.rank(task, workers), /closed/);
});

test('invalid router mode is never silently changed', async () => {
  await assert.rejects(createRouter({ mode: 'magic' }), /Unknown/);
});

let coreAvailable = false;
try { await import('@ruvector/core'); coreAvailable = true; } catch {}

test('missing RuVector fails explicitly rather than misreporting fixed routing', { skip: coreAvailable }, async () => {
  await assert.rejects(createRouter({ mode: 'ruvector' }), /working @ruvector\/core/);
});

test('actual RuVector retrieves nearest verified examples and preserves eligibility boundaries', { skip: !coreAvailable }, async () => {
  const router = await createRouter({ mode: 'ruvector', dimensions: 2, history: [
    history('a', [0, 1]), history('b', [1, 0]), history('c', [1, 0], { verified: false }),
    history('c', [1, 0], { capability: 'exec' }), history('offline', [1, 0]), history('expensive', [1, 0]),
  ] });
  try {
    assert.equal(router.backend, '@ruvector/core');
    assert.deepEqual(keys(await router.rank(task, [worker('a'), worker('b'), worker('c'),
      worker('offline', { available: false }), worker('expensive', { cost: 3 })])), ['b', 'a', 'c']);
    assert.deepEqual(keys(await router.rank({ ...task, vector: [0, 1] }, [worker('a'), worker('b')])), ['a', 'b']);
    await assert.rejects(router.rank({ ...task, vector: [NaN, 0] }, [worker('a')]), /vector/);
    await assert.rejects(router.rank({ ...task, vector: [0, 0] }, [worker('a')]), /vector/);
  } finally { await router.close(); }
});

test('RuVector empty verified history uses deterministic ranking without relabeling backend', { skip: !coreAvailable }, async () => {
  const router = await createRouter({ mode: 'ruvector', dimensions: 2, history: [history('b', [1, 0], { verified: false })] });
  try {
    assert.equal(router.mode, 'ruvector');
    assert.deepEqual(keys(await router.rank(task, [worker('b'), worker('a')])), ['a', 'b']);
  } finally { await router.close(); }
});
