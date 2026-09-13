/** Read-only repair calibration admission. This is not a mission executor. */
import { readFileSync, readdirSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { hash, loadLedger, currentSource, RULES } from '../loop/ledger.mjs';

export const ROOT = fileURLToPath(new URL('./', import.meta.url));
export const LEDGER = fileURLToPath(new URL('../evidence/loop-development', import.meta.url));
export const ORIGINAL_ANCHOR = 'c5c6da0b728c52414f2dff86f9d23121776d600defff0f214f1502a091f69088';
export const MISSION = 'rsi-ruflo-loop-20260912';
export const LIMITS = Object.freeze({ witnessProcesses: 6, timeoutMs: 5000, maxOutputBytes: 65536, heapMb: 128 });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (ok, why) => { if (!ok) throw Error(why); };
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
function keys(value, expected, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(','), `${label} fields`);
}
export function readBoundFile(root, path) {
  assert(typeof path === 'string' && /^[A-Za-z0-9_./-]+$/.test(path) && !isAbsolute(path) && path.split('/').every(p => p && p !== '.' && p !== '..'), 'unsafe relative path');
  const base = realpathSync(root), full = resolve(base, path);
  const rel = relative(base, realpathSync(full));
  assert(!rel.startsWith('..') && !isAbsolute(rel) && lstatSync(full).isFile() && !lstatSync(full).isSymbolicLink(), 'file escapes snapshot root');
  assert(lstatSync(full).size <= 1024 * 1024, 'snapshot too large');
  return readFileSync(full);
}
export function inspectCorpus(corpus, root = ROOT) {
  keys(corpus, ['schema', 'exposure', 'independentClusters', 'tasks'], 'corpus');
  assert(corpus.schema === 'ruflo.repair-calibration/v1' && corpus.exposure === 'PUBLIC_KNOWN_FIXES', 'calibration exposure required');
  assert(Array.isArray(corpus.tasks) && corpus.tasks.length === 3, 'three reviewed calibration tasks required');
  const ids = new Set(), clusters = new Set(), fingerprints = new Set();
  const files = {};
  for (const task of corpus.tasks) {
    keys(task, ['id', 'repository', 'cluster', 'role', 'fixExposure', 'issue', 'base', 'fixed'], 'task');
    assert(['receipt-fractions', 'receipt-roundtrip', 'receipt-unknown-fields'].includes(task.id) && !ids.has(task.id), 'duplicate or unknown task');
    ids.add(task.id); clusters.add(task.cluster);
    assert(task.repository === 'ruvnet/ruflo' && task.cluster === 'ruflo-flywheel-receipt', 'public repository cluster required');
    assert(task.role === 'calibration' && task.fixExposure === 'known' && Number.isSafeInteger(task.issue) && task.issue > 0, 'known fixes cannot be held out');
    assert(task.base.commit !== task.fixed.commit, 'distinct source revisions required');
    for (const source of [task.base, task.fixed]) {
      keys(source, ['commit', 'modules'], 'source');
      assert(hex(source.commit, 40), 'immutable source commit required');
      assert(Array.isArray(source.modules) && source.modules.length === 2 && source.modules.map(m => m.path).sort().join(',') === 'flywheel-receipt.ts,flywheel-sequential-evidence.ts', 'exact module closure required');
      for (const m of source.modules) {
        keys(m, ['path', 'gitBlob', 'stored', 'url'], 'module');
        assert(hex(m.gitBlob, 40) && m.stored === `snapshots/${m.gitBlob}.ts`, 'content addressed snapshot required');
        assert(m.url === `https://github.com/ruvnet/ruflo/blob/${source.commit}/v3/@claude-flow/cli/src/services/${m.path}`, 'source provenance URL mismatch');
        const bytes = readBoundFile(root, m.stored);
        const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        assert(blob === m.gitBlob, 'Git blob mismatch');
        files[m.stored] = sha256(bytes);
      }
    }
    const pair = task.base.modules[0].gitBlob + ':' + task.fixed.modules[0].gitBlob;
    assert(task.base.modules[0].gitBlob !== task.fixed.modules[0].gitBlob && !fingerprints.has(pair), 'duplicate or unchanged repair pair');
    fingerprints.add(pair);
  }
  assert(corpus.independentClusters === clusters.size, 'cluster count mismatch');
  return { files, tasks: ids.size, independentClusters: clusters.size, eligibleForConfirmation: false };
}
export function ledgerFingerprint(dir) {
  return hash(readdirSync(dir).filter(n => /^\d{8}\.json$/.test(n)).sort().map(n => [n, sha256(readFileSync(resolve(dir, n)))]));
}
export function inspectMission(dir, expectedHead) {
  assert(hex(expectedHead, 64), 'exact expected ledger head required');
  assert(!existsSync(resolve(dir, '.writer-lock')) && !existsSync(resolve(dir, '.recovery-lock')), 'live or ambiguous mission lock');
  const state = loadLedger(dir, expectedHead);
  assert(state.genesis.mission === MISSION, 'wrong mission');
  const events = readdirSync(dir).filter(n => /^\d{8}\.json$/.test(n)).map(n => JSON.parse(readFileSync(resolve(dir, n), 'utf8')));
  assert(events.some(e => e.hash === ORIGINAL_ANCHOR), 'original anchor absent');
  assert(!state.pending && !state.confirmation, 'mission has pending work');
  assert(!state.boundedRsiEvidenceAccepted && hash(currentSource()) === hash(state.source), 'source drift or mission already accepted');
  assert(state.epochs < RULES.maxEpochs && state.reservedUnits < RULES.maxUnits, 'mission resource ceiling');
  return { mission: MISSION, head: state.head, originalAnchor: ORIGINAL_ANCHOR,
    fingerprint: ledgerFingerprint(dir), epochs: state.epochs, nativeFieldCallsReserved: state.reservedUnits,
    proofIndex: state.proofIndex, consumedDatasets: state.consumedDatasets, consumedTasks: state.consumedTasks,
    trustHash: hash(state.genesis.trust), rulesHash: hash(RULES), sourceHash: hash(state.source) };
}
export function adapterSource(root = ROOT) {
  return Object.fromEntries(['admission.mjs', 'witness.mjs', 'run.mjs'].map(p => [p, sha256(readBoundFile(root, p))]));
}
export function prepare(dir, expectedHead, root = ROOT) {
  const corpusBytes = readBoundFile(root, 'corpus.json');
  const corpus = inspectCorpus(JSON.parse(corpusBytes), root);
  const acquisitionBytes = readBoundFile(root, 'acquisition.json');
  const acquisition = JSON.parse(acquisitionBytes);
  assert(acquisition.independentAttestation === false && acquisition.schema === 'ruflo.repair-source-acquisition/v1', 'acquisition record required');
  for (const task of JSON.parse(corpusBytes).tasks) {
    assert(acquisition.fixParents.some(p => p.commit === task.fixed.commit && p.parents.includes(task.base.commit)), 'fix parent acquisition mismatch');
    for (const source of [task.base, task.fixed]) for (const m of source.modules) {
      assert(acquisition.bindings.some(b => b.request.repository_full_name === task.repository && b.request.ref === source.commit &&
        b.request.path === `v3/@claude-flow/cli/src/services/${m.path}` && b.response.sha === m.gitBlob && b.response.display_url === m.url), 'source acquisition binding mismatch');
    }
  }
  return { schema: 'ruflo.repair-readiness-plan/v1', mission: inspectMission(dir, expectedHead),
    corpusSha256: sha256(corpusBytes), acquisitionSha256: sha256(acquisitionBytes), snapshotHashes: corpus.files, adapterSource: adapterSource(root),
    limits: LIMITS, mode: 'KNOWN_REGRESSION_CALIBRATION', candidateExecutionEnabled: false,
    accountingMigrationImplemented: false, sealedEvaluationEnabled: false };
}
export function admit(plan, expectedPlanHash, dir = LEDGER, root = ROOT) {
  assert(hex(expectedPlanHash, 64) && hash(plan) === expectedPlanHash, 'plan anchor mismatch');
  const recomputed = prepare(dir, plan.mission.head, root);
  assert(hash(recomputed) === expectedPlanHash, 'plan, source, corpus or mission drift');
  return { planHash: expectedPlanHash, calibrationReady: true, candidateExecutionEnabled: false,
    boundedRsiEvidenceAccepted: false, blockers: ['ACCOUNTING_AND_SOURCE_MIGRATION_REQUIRED', 'SEALED_WORKLOADS_AND_APPROVED_EVALUATORS_REQUIRED', 'FULL_ACQUISITION_COSTS_UNKNOWN'] };
}
export function executeCandidate() {
  throw Error('ACCOUNTING_AND_SOURCE_MIGRATION_REQUIRED: no repair candidate execution path exists');
}
