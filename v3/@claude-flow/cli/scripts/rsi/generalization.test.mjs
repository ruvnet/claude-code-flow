import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL, registration, makeTask, evaluateTask, trainSnapshots, costsAt, proofDecision, runGeneralization, verifyGeneralizationBundle } from './generalization.mjs';
import { digest } from './experiment.mjs';

test('registration is deterministic and pins exact learner/evaluator and protocol', () => {
  const a = registration(), { commitment, ...body } = a;
  assert.deepEqual(a, registration());
  assert.equal(commitment, digest(body));
  assert.match(a.learnerHash, /^[0-9a-f]{64}$/);
  assert.match(a.evaluatorHash, /^[0-9a-f]{64}$/);
  assert.throws(() => { PROTOCOL.minMeanGain = -1; });
  assert.throws(() => runGeneralization({ ...a, commitment: 'forged' }, 'a'.repeat(40)), /registration/);
  assert.throws(() => runGeneralization(a, 'not-a-commit'), /commit/);
});

test('untrained objective families are finite normalized and structurally different', () => {
  // Unit seeds deliberately exclude the registered evaluation seeds.
  const values = [];
  for (const family of ['squared', ...PROTOCOL.outerFamilies]) {
    const t = makeTask(3, 'unit', family, 0);
    assert.equal(evaluateTask(t, t.target), 1);
    values.push(evaluateTask(t, Array(8).fill(0.5)));
    for (const point of [Array(8).fill(0), Array(8).fill(1), Array(8).fill(0.5)]) {
      const s = evaluateTask(t, point); assert.ok(Number.isFinite(s) && s >= 0 && s <= 1);
    }
    assert.throws(() => evaluateTask(t, Array(8).fill(NaN)));
    assert.throws(() => evaluateTask(t, new Array(8)));
    assert.throws(() => evaluateTask(t, Array(8).fill(2)));
  }
  assert.equal(new Set(values).size, values.length);
  assert.equal(evaluateTask(makeTask(3, 'unit', 'null', 0), Array(8).fill(0)), 0.5);
});

test('split role and family separate addresses; training cannot request outer families', () => {
  const inner = makeTask(3, 'train', 'squared', 0), outer = makeTask(3, 'outer', 'squared', 0);
  assert.notEqual(inner.id, outer.id);
  assert.notDeepEqual(inner.target, outer.target);
  assert.throws(() => makeTask(3, 'train', 'absolute', 0));
  assert.throws(() => makeTask(3, 'bad', 'squared', 0));
  assert.throws(() => makeTask(3, 'unit', 'fake', 0));
  assert.throws(() => { outer.target[0] = 0; });
});

test('snapshots freeze all state and contain only inner task evidence', () => {
  const result = trainSnapshots(3);
  assert.deepEqual(result, trainSnapshots(3));
  assert.ok(result.trainTaskIds.every(id => id.includes('/train/squared/')));
  for (const arm of PROTOCOL.arms) {
    assert.deepEqual(Object.keys(result.snapshots[arm]).map(Number), [0, 2, 4, 6]);
    assert.equal(result.attempts[arm].length, 6);
    assert.equal(result.attempts[arm][0].history.length, 192);
    assert.throws(() => { result.snapshots[arm][6][0] = 8; });
  }
  assert.deepEqual(result.snapshots.frozen[0], result.snapshots.frozen[6]);
});

const fakeComparisons = () => PROTOCOL.outerFamilies.flatMap(family => [2, 4, 6].flatMap(checkpoint => ['frozen', 'shuffled', 'previous'].map(control => ({ family, checkpoint, control, p: 0.0001, meanGain: 0.02 }))));
const guards = { resetMatchesRoot: true, nullNoGain: true, splitsDisjoint: true };

test('proof requires every family, checkpoint and comparator; aggregate wins cannot hide a loss', () => {
  const all = fakeComparisons();
  assert.equal(all.length, 36);
  assert.equal(proofDecision(all, guards).syntheticGeneralizationSupported, true);
  assert.equal(proofDecision(all, guards).realRsiProven, false);
  assert.equal(proofDecision(all, guards).productionPromotion, false);
  for (const bad of [{ meanGain: -0.001 }, { p: 0.01 }, { p: -1 }, { meanGain: NaN }]) {
    const changed = structuredClone(all); Object.assign(changed[0], bad);
    assert.equal(proofDecision(changed, guards).syntheticGeneralizationSupported, false);
  }
  assert.equal(proofDecision(all.slice(1), guards).complete, false);
  assert.equal(proofDecision([...all.slice(1), all[1]], guards).complete, false);
  assert.equal(proofDecision(all, { ...guards, splitsDisjoint: false }).syntheticGeneralizationSupported, false);
  assert.equal(proofDecision(all, { ...guards, resetMatchesRoot: false }).syntheticGeneralizationSupported, false);
  assert.equal(proofDecision(all, { ...guards, nullNoGain: false }).syntheticGeneralizationSupported, false);
});

test('deployment budgets fixed across checkpoints, additional training disclosed', () => {
  assert.equal(costsAt(2).outerEvaluationsPerFamily, costsAt(6).outerEvaluationsPerFamily);
  assert.equal(costsAt(6).trainingEvaluations, 3 * costsAt(2).trainingEvaluations);
  assert.equal(costsAt(0).trainingEvaluations, 0);
  assert.throws(() => costsAt(5));
});

test('untrusted evidence is rejected before computation', () => {
  assert.throws(() => verifyGeneralizationBundle({}, undefined), /key/);
  assert.throws(() => verifyGeneralizationBundle({ publicKey: 'bad' }, 'different'), /key/);
});
