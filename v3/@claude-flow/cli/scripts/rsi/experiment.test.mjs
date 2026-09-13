import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_CONFIG, validateConfig, validateGenome, learn, compare, runExperiment, signResult, replay, digest } from './experiment.mjs';

const small = { seed: 99, seeds: 8, generations: 2, trainTasks: 2, outerTasks: 4, steps: 4 };
const result = runExperiment(small);

test('config has strict finite integer bounds and global resource ceiling', () => {
  for (const [key, value] of [['steps', Infinity], ['steps', NaN], ['steps', 0], ['steps', 2.5], ['seeds', 33], ['seed', -1], ['generations', 13], ['trainTasks', '2']]) {
    assert.throws(() => validateConfig({ [key]: value }));
  }
  for (const key of ['evaluator', 'productionPromotion', 'tools', 'alpha', 'toString', '__proto__']) assert.throws(() => validateConfig(JSON.parse(`{"${key}":1}`)));
  assert.throws(() => validateConfig({ seeds: 32, generations: 12, trainTasks: 32, outerTasks: 64, steps: 32 }), /hard cap/);
  assert.throws(() => validateConfig(null));
  assert.throws(() => validateConfig([]));
  assert.throws(() => validateConfig(new Date()));
  assert.throws(() => validateConfig({ seeds: 32, generations: 8, trainTasks: 32, outerTasks: 64, steps: 22 }), /evaluation budget/);
  assert.throws(() => validateConfig({ seeds: 32, generations: 12, trainTasks: 20, outerTasks: 4, steps: 32 }), /history budget/);
  assert.deepEqual(validateConfig(), DEFAULT_CONFIG);
});

test('genome permits only eight bounded integer axis weights', () => {
  for (const value of [null, {}, [], Array(9).fill(1), [NaN, ...Array(7).fill(1)], [9, ...Array(7).fill(1)], [0, ...Array(7).fill(1)]]) assert.throws(() => validateGenome(value));
  const original = Array(8).fill(1), genome = validateGenome(original);
  original[0] = 7;
  assert.equal(genome[0], 1);
  assert.throws(() => { genome[0] = 2; }, TypeError);
});

test('learning preserves failed attempts and corrupt-credit control differs', () => {
  const root = Array(8).fill(1);
  const history = [{ axis: 0, delta: 0.4 }, { axis: 0, delta: -0.1 }, { axis: 1, delta: -0.2 }];
  assert.notDeepEqual(learn(root, history, 'adaptive'), learn(root, history, 'shuffled'));
  assert.deepEqual(learn(root, history, 'frozen'), root);
  assert.notDeepEqual(learn(root, [{ axis: 0, delta: 0.1 }], 'adaptive'), learn(root, [{ axis: 0, delta: 0.1 }, { axis: 0, delta: -0.9 }], 'adaptive'));
  for (const row of [{ axis: -1, delta: 0 }, { axis: 8, delta: 0 }, { axis: 0, delta: NaN }, { axis: 0, delta: Infinity }, { axis: 0, delta: 2 }]) assert.throws(() => learn(root, [row], 'adaptive'));
  assert.throws(() => learn(root, history, 'execute'));
  const prior = [8, 7, 6, 5, 4, 3, 2, 1];
  assert.deepEqual(learn(prior, [{ axis: 0, delta: 0.4 }], 'shuffled'), [7, 6, 5, 4, 5, 2, 1, 1]);
});

test('exact sign test reports wins, ties, losses and refuses invalid inputs', () => {
  assert.equal(compare(Array(8).fill(0.1)).p, 1 / 256);
  assert.equal(compare(Array(8).fill(0.1)).passed, true);
  assert.equal(compare(Array(8).fill(-0.1)).p, 1);
  assert.equal(compare(Array(8).fill(0)).p, 1);
  assert.equal(compare(Array(8).fill(0)).passed, false);
  assert.equal(compare(Array(8).fill(0.0001)).passed, false);
  assert.equal(compare([0.1, -0.1]).p, 0.75);
  assert.throws(() => compare([NaN]));
  assert.throws(() => compare([]));
  assert.throws(() => compare(Array(33).fill(0.1)));
});

test('all arms receive identical logical work, including rejects and training', () => {
  for (const run of result.runs) {
    const { adaptive, frozen, shuffled } = run.results;
    assert.deepEqual(adaptive.costs, frozen.costs);
    assert.deepEqual(adaptive.costs, shuffled.costs);
    assert.equal(adaptive.costs.evaluations, (small.generations * small.trainTasks + 3 * small.outerTasks) * (small.steps + 1));
    for (const arm of [adaptive, frozen, shuffled]) {
      assert.equal(arm.lineage.length, small.generations);
      assert.equal(arm.lineage[0].history.length, small.trainTasks * small.steps);
      assert.ok(arm.lineage.flatMap(x => x.history).some(x => !x.accepted));
    }
  }
});

test('lineage reconstructs from root with exact before/after and hashes', () => {
  for (const run of result.runs) for (const arm of Object.values(run.results)) {
    let before = Array(8).fill(1), parent = digest(before);
    for (const { hash, ...body } of arm.lineage) {
      assert.deepEqual(body.before, before);
      assert.equal(body.parent, parent);
      assert.equal(hash, digest(body));
      before = body.after; parent = hash;
    }
    assert.deepEqual(arm.genome, before);
  }
});

test('changing outer sample size never changes trained optimizer or history', () => {
  const changed = runExperiment({ ...small, outerTasks: 8 });
  for (let i = 0; i < result.runs.length; i++) {
    assert.notEqual(result.runs[i].splitCommitment, changed.runs[i].splitCommitment);
    for (const arm of ['adaptive', 'frozen', 'shuffled']) {
      assert.deepEqual(result.runs[i].results[arm].lineage, changed.runs[i].results[arm].lineage);
      assert.deepEqual(result.runs[i].results[arm].genome, changed.runs[i].results[arm].genome);
    }
  }
});

test('null and rollback controls pass without claiming live efficacy', () => {
  assert.equal(result.summary.nullPassed, true);
  assert.equal(result.summary.rollbackPassed, true);
  assert.equal(result.summary.liveRsiProven, false);
  assert.equal(result.dataSource, 'SYNTHETIC');
  assert.equal(result.constraints.productionPromotion, false);
  assert.equal(result.constraints.externalActions, false);
  assert.ok(result.runs.every(r => r.rollbackMatchesFrozen));
});

test('deterministic whole experiment replay and pinned signer verification', () => {
  assert.deepEqual(runExperiment(small), result);
  const bundle = signResult(result);
  assert.equal(replay(bundle, bundle.publicKey).verified, true);
  assert.throws(() => replay(bundle), /trusted/);
  assert.throws(() => replay(bundle, signResult(result).publicKey), /trusted/);
  const tampered = structuredClone(bundle); tampered.result.summary.liveRsiProven = true;
  assert.throws(() => replay(tampered, bundle.publicKey), /signature/);
});

test('even correctly signed falsified evidence fails recomputation', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ type: 'spki', format: 'pem' });
  for (const mutate of [r => { r.summary.verdict = 'FORGED'; }, r => { r.runs[0].results.adaptive.lineage[0].parent = 'forged'; }, r => { r.sourceHash = 'wrong'; }, r => { r.config.steps = 1e9; }]) {
    const forged = structuredClone(result); mutate(forged);
    const bundle = { result: forged, publicKey: key, signature: sign(null, Buffer.from(JSON.stringify(forged)), privateKey).toString('base64') };
    assert.throws(() => replay(bundle, key));
  }
});

test('CLI requires explicit output, refuses overwrite, replays with pinned key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruflo-rsi-test-'));
  const config = join(dir, 'config.json'), out = join(dir, 'bundle.json'), key = join(dir, 'public.pem');
  writeFileSync(config, JSON.stringify(small));
  const cli = new URL('./run.mjs', import.meta.url);
  const invoke = args => spawnSync(process.execPath, [cli.pathname, ...args], { encoding: 'utf8' });
  assert.equal(invoke(['run']).status, 1);
  assert.equal(invoke(['run', '--out', out, '--config', config]).status, 0);
  const before = readFileSync(out, 'utf8');
  assert.equal(invoke(['run', '--out', out, '--config', config]).status, 1);
  assert.equal(readFileSync(out, 'utf8'), before);
  writeFileSync(key, JSON.parse(before).publicKey);
  assert.equal(invoke(['replay', '--bundle', out, '--public-key', key]).status, 0);
  assert.equal(invoke(['run', '--out', out, '--out', 'other']).status, 1);
});
