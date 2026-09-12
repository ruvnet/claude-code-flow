/** Prospective transfer test. Original learner unchanged; no production integration. */
import { createHash, verify } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { learn, validateGenome, compare, signResult, digest } from './experiment.mjs';

const deepFreeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(deepFreeze); Object.freeze(x); } return x; };
export const PROTOCOL = deepFreeze({
  version: 'ruflo.generalization/v1', dataSource: 'SYNTHETIC',
  seedStart: 830101, seeds: 16, generations: 6, trainTasks: 12, outerTasks: 24, steps: 16,
  checkpoints: [0, 2, 4, 6], arms: ['adaptive', 'frozen', 'shuffled'],
  trainFamily: 'squared', outerFamilies: ['permuted', 'absolute', 'coupled', 'multimodal'],
  comparisons: ['frozen', 'shuffled', 'previous'], comparisonCount: 36,
  familywiseAlpha: 0.05, minMeanGain: 0.01,
  decision: 'all 36 family/checkpoint comparisons must pass; no averaging away failures',
  externalBlindEvaluation: false, realTaskEvidence: false, productionPromotion: false,
});
const hashFile = url => createHash('sha256').update(readFileSync(url)).digest('hex');
export function registration() {
  const body = { protocol: PROTOCOL, evaluatorHash: hashFile(new URL(import.meta.url)), learnerHash: hashFile(new URL('./experiment.mjs', import.meta.url)) };
  return { ...body, commitment: digest(body) };
}
function random(address) {
  let s = parseInt(digest(address).slice(0, 8), 16) >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
const round = n => Math.round(n * 1e12) / 1e12;
const root = () => Array(8).fill(1);

export function makeTask(seed, phase, family, index) {
  if (!['squared', ...PROTOCOL.outerFamilies, 'null'].includes(family)) throw new Error('unknown family');
  if (!['train', 'outer', 'unit'].includes(phase) || (phase === 'train' && family !== 'squared')) throw new Error('invalid split');
  const rng = random([seed, phase, family, index]);
  const target = Array.from({ length: 8 }, rng), order = [0, 1, 2, 3, 4, 5, 6, 7];
  for (let i = 7; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  return deepFreeze({ id: `${seed}/${phase}/${family}/${index}`, family, target, order });
}
export function evaluateTask(task, point) {
  if (!Array.isArray(point) || point.length !== 8 || Array.from(point).some(x => !Number.isFinite(x) || x < 0 || x > 1)) throw new Error('invalid point');
  if (task.family === 'null') return 0.5;
  const d = point.map((x, i) => x - task.target[i]);
  let loss;
  if (task.family === 'squared' || task.family === 'permuted') {
    const major = task.family === 'squared' ? [0, 1] : task.order.slice(0, 2);
    loss = d.reduce((s, x, i) => s + x * x * (major.includes(i) ? 8 : 1), 0) / 22;
  } else if (task.family === 'absolute') loss = mean(d.map(Math.abs));
  else if (task.family === 'coupled') loss = mean(d.map((x, i) => ((x + d[(i + 1) % 8]) / 2) ** 2));
  else if (task.family === 'multimodal') loss = mean(d.map(x => (1 - Math.cos(6 * Math.PI * x)) / 2));
  else throw new Error('unknown family');
  const score = 1 - loss;
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error('invalid score');
  return score;
}

function episode(task, genome, address) {
  const rng = random(address);
  let point = Array(8).fill(0.5), best = evaluateTask(task, point);
  const start = best, history = [];
  for (let k = 0; k < PROTOCOL.steps; k++) {
    let ticket = rng() * genome.reduce((s, x) => s + x, 0), axis = 7, selected = false;
    for (let i = 0; i < 8; i++) { ticket -= genome[i]; if (!selected && ticket < 0) { selected = true; axis = i; } }
    const candidate = [...point]; candidate[axis] = rng();
    const score = evaluateTask(task, candidate), delta = score - best;
    history.push({ axis, delta: round(delta), accepted: delta > 0 });
    if (delta > 0) { point = candidate; best = score; }
  }
  return { gain: round(best - start), history };
}

/** Training surface contains no outer data or evaluator injection. */
export function trainSnapshots(seed) {
  const snapshots = {}, attempts = {}, trainTaskIds = [];
  for (const arm of PROTOCOL.arms) {
    let genome = validateGenome(root()), parent = digest(genome);
    snapshots[arm] = { 0: genome }; attempts[arm] = [];
    for (let g = 1; g <= PROTOCOL.generations; g++) {
      const episodes = Array.from({ length: PROTOCOL.trainTasks }, (_, i) => {
        const task = makeTask(seed, 'train', 'squared', (g - 1) * PROTOCOL.trainTasks + i);
        if (arm === 'adaptive') trainTaskIds.push(task.id);
        return episode(task, genome, [seed, 'inner-search', g, i]);
      });
      const history = episodes.flatMap(e => e.history), next = learn(genome, history, arm);
      const body = { generation: g, parent, before: genome, after: next, history };
      parent = digest(body); attempts[arm].push({ ...body, hash: parent }); genome = next;
      if (PROTOCOL.checkpoints.includes(g)) snapshots[arm][g] = genome;
    }
  }
  return deepFreeze({ snapshots, attempts, trainTaskIds });
}

/** Count logical work; objective costs differ by family, but each arm sees the same family. */
export function costsAt(g) {
  if (!PROTOCOL.checkpoints.includes(g)) throw new Error('invalid checkpoint');
  return {
    trainingEvaluations: g * PROTOCOL.trainTasks * (PROTOCOL.steps + 1),
    trainingHistoryRows: g * PROTOCOL.trainTasks * PROTOCOL.steps,
    trainingGenomeSlots: g * 8,
    outerEvaluationsPerFamily: PROTOCOL.outerTasks * (PROTOCOL.steps + 1),
    outerProposalAxisVisitsPerFamily: PROTOCOL.outerTasks * PROTOCOL.steps * 8,
  };
}
export function proofDecision(comparisons, guards) {
  const alpha = PROTOCOL.familywiseAlpha / PROTOCOL.comparisonCount;
  const expected = PROTOCOL.outerFamilies.flatMap(family => PROTOCOL.checkpoints.slice(1).flatMap(checkpoint => PROTOCOL.comparisons.map(control => `${family}/${checkpoint}/${control}`)));
  const keys = comparisons.map(c => `${c.family}/${c.checkpoint}/${c.control}`);
  const complete = comparisons.length === expected.length && new Set(keys).size === expected.length && expected.every(k => keys.includes(k));
  const passing = comparisons.filter(c => Number.isFinite(c.p) && c.p >= 0 && c.p <= alpha && Number.isFinite(c.meanGain) && c.meanGain >= PROTOCOL.minMeanGain && c.meanGain <= 1).length;
  const guarded = guards?.resetMatchesRoot === true && guards?.nullNoGain === true && guards?.splitsDisjoint === true;
  return { comparisonsRequired: expected.length, passing, complete, guarded,
    syntheticGeneralizationSupported: complete && guarded && passing === expected.length,
    realRsiProven: false, independentlyReplicated: false, productionPromotion: false };
}

/** Invoked only AFTER the exact registration is published; no adaptive stopping. */
export function runGeneralization(registered, registrationCommit) {
  if (JSON.stringify(registered) !== JSON.stringify(registration())) throw new Error('registration mismatch');
  if (!/^[0-9a-f]{40}$/.test(registrationCommit)) throw new Error('registration commit required');
  // Train every arm and snapshot for ALL seeds before constructing any outer task.
  const trained = Array.from({ length: PROTOCOL.seeds }, (_, i) => trainSnapshots(PROTOCOL.seedStart + i));
  const runs = [];
  let splitsDisjoint = true, resetMatchesRoot = true, nullNoGain = true;
  for (let i = 0; i < PROTOCOL.seeds; i++) {
    const seed = PROTOCOL.seedStart + i, training = trained[i], outerIds = [], results = {};
    for (const family of PROTOCOL.outerFamilies) {
      const tasks = Array.from({ length: PROTOCOL.outerTasks }, (_, j) => makeTask(seed, 'outer', family, j));
      outerIds.push(...tasks.map(t => t.id)); results[family] = {};
      for (const g of PROTOCOL.checkpoints) {
        results[family][g] = Object.fromEntries(PROTOCOL.arms.map(arm => [arm, tasks.map((t, j) => episode(t, training.snapshots[arm][g], [seed, 'outer-search', family, j]).gain)]));
      }
      const reset = tasks.map((t, j) => episode(t, validateGenome(root()), [seed, 'outer-search', family, j]).gain);
      resetMatchesRoot &&= digest(reset) === digest(results[family][0].adaptive) && PROTOCOL.checkpoints.every(g => digest(reset) === digest(results[family][g].frozen));
    }
    const nullTask = makeTask(seed, 'outer', 'null', 0);
    nullNoGain &&= PROTOCOL.arms.every(arm => episode(nullTask, training.snapshots[arm][6], [seed, 'null']).gain === 0);
    splitsDisjoint &&= new Set(outerIds).size === outerIds.length && !outerIds.some(id => training.trainTaskIds.includes(id));
    runs.push({ seed, training, outerCommitment: digest(PROTOCOL.outerFamilies.map(f => Array.from({ length: PROTOCOL.outerTasks }, (_, j) => makeTask(seed, 'outer', f, j)))), results });
  }
  const comparisons = PROTOCOL.outerFamilies.flatMap(family => PROTOCOL.checkpoints.slice(1).flatMap((checkpoint, index) => PROTOCOL.comparisons.map(control => {
    const prior = PROTOCOL.checkpoints[index];
    const deltas = runs.map(r => mean(r.results[family][checkpoint].adaptive.map((x, i) => x - r.results[family][control === 'previous' ? prior : checkpoint][control === 'previous' ? 'adaptive' : control][i])));
    return { family, checkpoint, control, ...compare(deltas), passed: undefined, pairedDeltas: deltas };
  })));
  const guards = { resetMatchesRoot, nullNoGain, splitsDisjoint };
  const trainPerArm = costsAt(6).trainingEvaluations;
  const totalEvaluations = PROTOCOL.seeds * (3 * trainPerArm + (3 * PROTOCOL.checkpoints.length + 1) * PROTOCOL.outerFamilies.length * PROTOCOL.outerTasks * (PROTOCOL.steps + 1) + 3 * (PROTOCOL.steps + 1));
  return { registration: registered, registrationCommit, runs, comparisons, guards,
    costs: { perCheckpointPerArm: Object.fromEntries(PROTOCOL.checkpoints.map(g => [g, costsAt(g)])), totalEvaluations,
      note: 'Same-checkpoint arms have equal logical budgets; later checkpoints incur extra training. Not equal CPU time. Outer comparisons reuse one task pool and Bonferroni covers all 36.' },
    decision: proofDecision(comparisons, guards), caveat: 'Public synthetic generators and seed split are not independent blind real-task evaluation. Commitment records provenance, not a causal or mathematical RSI proof.' };
}

export function verifyGeneralizationBundle(bundle, trustedPublicKey) {
  if (typeof trustedPublicKey !== 'string' || bundle?.publicKey !== trustedPublicKey) throw new Error('trusted key required');
  if (!verify(null, Buffer.from(JSON.stringify(bundle.result)), trustedPublicKey, Buffer.from(bundle.signature, 'base64'))) throw new Error('signature mismatch');
  const repeated = runGeneralization(bundle.result.registration, bundle.result.registrationCommit);
  if (JSON.stringify(repeated) !== JSON.stringify(bundle.result)) throw new Error('recomputation mismatch');
  return { verified: true, decision: repeated.decision };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, input, commit, out] = process.argv.slice(2);
    if (command === 'register' && input && !commit) writeFileSync(input, JSON.stringify(registration(), null, 2) + '\n', { flag: 'wx' });
    else if (command === 'run' && input && commit && out) {
      if (statSync(input).size > 16384) throw new Error('registration too large');
      const result = runGeneralization(JSON.parse(readFileSync(input, 'utf8')), commit);
      writeFileSync(out, JSON.stringify(signResult(result)) + '\n', { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ decision: result.decision, guards: result.guards, totalEvaluations: result.costs.totalEvaluations,
        comparisons: result.comparisons.map(({ pairedDeltas, ...rest }) => rest) }, null, 2));
    } else if (command === 'replay' && input && commit && !out) {
      if (statSync(input).size > 32 * 1024 * 1024 || statSync(commit).size > 4096) throw new Error('input too large');
      console.log(JSON.stringify(verifyGeneralizationBundle(JSON.parse(readFileSync(input, 'utf8')), readFileSync(commit, 'utf8')), null, 2));
    } else throw new Error('usage: generalization.mjs register NEW_FILE | run REGISTRATION COMMIT NEW_BUNDLE | replay BUNDLE TRUSTED_PUBLIC_KEY');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
