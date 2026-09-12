/** Bounded RSI research harness. No production imports, tools, network or promotion. */
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const VERSION = 'ruflo.rsi-experiment/v1';
export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const D = 8;
const ARMS = Object.freeze(['adaptive', 'frozen', 'shuffled']);
const FAMILIES = Object.freeze(['stationary', 'shifted', 'null']);
export const DEFAULT_CONFIG = Object.freeze({ seed: 1729, seeds: 16, generations: 6, trainTasks: 12, outerTasks: 24, steps: 16 });
export const RULE = Object.freeze({ alphaPerComparison: 0.025, minMeanGain: 0.01, productionPromotion: false });
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sourceHash = () => createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const round = n => Math.round(n * 1e12) / 1e12;

export function validateConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('invalid config');
  const limits = { seed: [0, 1_000_000], seeds: [8, 32], generations: [1, 12], trainTasks: [2, 32], outerTasks: [4, 64], steps: [2, 32] };
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`unknown config key: ${key}`);
  const cfg = { ...DEFAULT_CONFIG, ...input };
  for (const [key, [lo, hi]] of Object.entries(limits)) {
    if (!Number.isInteger(cfg[key]) || cfg[key] < lo || cfg[key] > hi) throw new Error(`invalid ${key}`);
  }
  const calls = cfg.seeds * (3 * (cfg.generations * cfg.trainTasks + 3 * cfg.outerTasks) + 3 * cfg.outerTasks) * (cfg.steps + 1);
  if (calls > 1_000_000) throw new Error('evaluation budget exceeds hard cap');
  if (cfg.seeds * 3 * cfg.generations * cfg.trainTasks * cfg.steps > 100_000) throw new Error('history budget exceeds hard cap');
  return Object.freeze(cfg);
}

function rng(address) {
  let state = parseInt(digest(address).slice(0, 8), 16) >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
function freezeDeep(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}
export function validateGenome(genome) {
  if (!Array.isArray(genome) || genome.length !== D || genome.some(x => !Number.isInteger(x) || x < 1 || x > 8)) throw new Error('invalid bounded optimizer genome');
  return Object.freeze([...genome]);
}
const rootGenome = () => validateGenome(Array(D).fill(1));

function task(seed, phase, index, family = 'stationary') {
  const random = rng([seed, phase, index, family]);
  const target = Array.from({ length: D }, random);
  const importance = Array.from({ length: D }, (_, i) => family === 'null' ? 0 : (family === 'shifted' ? i >= 6 : i < 2) ? 8 : 1);
  return freezeDeep({ id: `${seed}/${phase}/${family}/${index}`, target, importance });
}
function score(t, point) {
  const total = t.importance.reduce((a, b) => a + b, 0);
  if (!total) return 0.5;
  const result = 1 - t.importance.reduce((s, w, i) => s + w * (point[i] - t.target[i]) ** 2, 0) / total;
  if (!Number.isFinite(result) || result < 0 || result > 1) throw new Error('invalid score');
  return result;
}

/** Fixed work schedule, including all failed attempts. Genome has no evaluator reference. */
function episode(t, genome, steps, address) {
  const random = rng(address);
  let point = Array(D).fill(0.5), best = score(t, point);
  const root = best, history = [];
  for (let n = 0; n < steps; n++) {
    let ticket = random() * genome.reduce((a, b) => a + b, 0), axis = D - 1;
    // Always visit every axis: equal logical proposal work for every arm.
    let selected = false;
    for (let i = 0; i < D; i++) { ticket -= genome[i]; if (!selected && ticket < 0) { axis = i; selected = true; } }
    const candidate = [...point]; candidate[axis] = random();
    const value = score(t, candidate), delta = value - best;
    history.push({ axis, delta: round(delta), accepted: delta > 0 });
    if (delta > 0) { point = candidate; best = value; }
  }
  return { gain: round(best - root), history };
}

/** Shuffling breaks credit attribution, not merely history order. */
export function learn(genome, history, arm) {
  validateGenome(genome);
  if (!ARMS.includes(arm)) throw new Error('invalid arm');
  const credit = Array(D).fill(0), counts = Array(D).fill(0);
  for (const row of history) {
    if (!Number.isInteger(row.axis) || row.axis < 0 || row.axis >= D || !Number.isFinite(row.delta) || Math.abs(row.delta) > 1) throw new Error('invalid history');
    // All attempts, not only promoted candidates. Same operations in each arm.
    credit[row.axis] += row.delta; counts[row.axis]++;
  }
  const rates = credit.map((v, i) => counts[i] ? v / counts[i] : 0);
  const center = mean(rates);
  const proposal = genome.map((v, i) => Math.max(1, Math.min(8, v + (rates[i] > center ? 1 : -1))));
  // Fixed rotation destroys credit attribution, never rotates prior optimizer state.
  const shuffled = genome.map((v, i) => Math.max(1, Math.min(8, v + (rates[(i + D / 2) % D] > center ? 1 : -1))));
  return validateGenome(arm === 'frozen' ? genome : arm === 'shuffled' ? shuffled : proposal);
}

/** Exact one-sided sign test. Unit of inference is a seed, never individual steps. */
export function compare(deltas) {
  if (!Array.isArray(deltas) || !deltas.length || deltas.length > 32 || deltas.some(x => !Number.isFinite(x) || Math.abs(x) > 1)) throw new Error('invalid deltas');
  const wins = deltas.filter(x => x > 1e-12).length, losses = deltas.filter(x => x < -1e-12).length;
  const n = wins + losses;
  let probability = 2 ** -n, p = wins === 0 ? probability : 0;
  for (let k = 1; k <= n; k++) { probability *= (n - k + 1) / k; if (k >= wins) p += probability; }
  return { meanGain: round(mean(deltas)), wins, losses, ties: deltas.length - n, p: round(p), passed: mean(deltas) >= RULE.minMeanGain && p <= RULE.alphaPerComparison };
}

export function runExperiment(input = {}) {
  const config = validateConfig(input), runs = [];
  for (let replicate = 0; replicate < config.seeds; replicate++) {
    const seed = config.seed + replicate;
    const train = Array.from({ length: config.generations }, (_, g) => Array.from({ length: config.trainTasks }, (_, i) => task(seed, `train-${g}`, i)));
    const outer = Object.fromEntries(FAMILIES.map(f => [f, Array.from({ length: config.outerTasks }, (_, i) => task(seed, 'outer', i, f))]));
    const splitCommitment = digest({ train, outer });
    const trained = {};
    for (const arm of ARMS) {
      let genome = rootGenome(), parent = digest(genome);
      const lineage = [];
      for (let g = 0; g < config.generations; g++) {
        const episodes = train[g].map((t, i) => episode(t, genome, config.steps, [seed, 'train-search', g, i]));
        const history = episodes.flatMap(e => e.history);
        const next = learn(genome, history, arm);
        const body = { generation: g, parent, before: genome, after: next, history, trainMeanGain: round(mean(episodes.map(e => e.gain))) };
        const hash = digest(body); lineage.push({ ...body, hash }); parent = hash; genome = next;
      }
      trained[arm] = { genome, lineage };
    }
    // Every optimizer is frozen before ANY outer task runs; no outer feedback to learn().
    freezeDeep(trained);
    const results = {};
    for (const arm of ARMS) {
      const gains = Object.fromEntries(FAMILIES.map(f => [f, outer[f].map((t, i) => episode(t, trained[arm].genome, config.steps, [seed, 'outer-search', f, i]).gain)]));
      const trainEpisodes = config.generations * config.trainTasks, outerEpisodes = FAMILIES.length * config.outerTasks;
      results[arm] = { ...trained[arm], gains, costs: {
        evaluations: (trainEpisodes + outerEpisodes) * (config.steps + 1),
        proposalAxisVisits: (trainEpisodes + outerEpisodes) * config.steps * D,
        historyRowsProcessed: trainEpisodes * config.steps,
        genomeSlotsProcessed: config.generations * D,
      } };
    }
    // Reset optimizer to initial policy and replay identical outer addresses.
    const rollback = Object.fromEntries(FAMILIES.map(f => [f, outer[f].map((t, i) => episode(t, rootGenome(), config.steps, [seed, 'outer-search', f, i]).gain)]));
    runs.push({ seed, splitCommitment, results, rollbackMatchesFrozen: digest(rollback) === digest(results.frozen.gains), auditExtraEvaluations: FAMILIES.length * config.outerTasks * (config.steps + 1) });
  }
  const comparisons = Object.fromEntries(['frozen', 'shuffled'].map(control => {
    const pairedDeltas = runs.map(r => mean(['stationary', 'shifted'].map(f => mean(r.results.adaptive.gains[f]) - mean(r.results[control].gains[f]))));
    return [control, { ...compare(pairedDeltas), pairedDeltas }];
  }));
  const byFamily = Object.fromEntries(FAMILIES.map(f => [f, Object.fromEntries(ARMS.map(arm => [arm, round(mean(runs.map(r => mean(r.results[arm].gains[f]))))]))]));
  const budgetsEqual = runs.every(r => ARMS.every(a => digest(r.results[a].costs) === digest(r.results.frozen.costs)));
  const rollbackPassed = runs.every(r => r.rollbackMatchesFrozen);
  const nullPassed = ARMS.every(a => byFamily.null[a] === 0);
  const passed = comparisons.frozen.passed && comparisons.shuffled.passed && budgetsEqual && rollbackPassed && nullPassed;
  return { version: VERSION, dataSource: 'SYNTHETIC', sourceHash: sourceHash(), config, rule: RULE,
    constraints: { productionPromotion: false, externalActions: false, learningFromOuter: false, costModel: 'fixed logical work slots, NOT equal CPU time' },
    runs, summary: { comparisons, byFamily, budgetsEqual, rollbackPassed, nullPassed, verdict: passed ? 'SYNTHETIC_GAIN' : 'NULL', liveRsiProven: false } };
}

export function signResult(result) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const payload = JSON.stringify(result);
  return { result, publicKey: publicKey.export({ type: 'spki', format: 'pem' }), signature: sign(null, Buffer.from(payload), privateKey).toString('base64') };
}

/** Replay is computation, not trust in stored scores. A pinned key is mandatory. */
export function replay(bundle, trustedPublicKey) {
  if (!bundle || bundle.publicKey !== trustedPublicKey || typeof trustedPublicKey !== 'string') throw new Error('trusted public key required');
  if (!verify(null, Buffer.from(JSON.stringify(bundle.result)), trustedPublicKey, Buffer.from(bundle.signature, 'base64'))) throw new Error('invalid signature');
  if (bundle.result?.sourceHash !== sourceHash()) throw new Error('source fingerprint mismatch');
  const recomputed = runExperiment(bundle.result.config);
  if (JSON.stringify(bundle.result) !== JSON.stringify(recomputed)) throw new Error('replay mismatch');
  return { verified: true, verdict: recomputed.summary.verdict, liveRsiProven: false };
}
