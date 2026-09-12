/** Local durable ledger. Git commits anchor its head; hashes alone are not authentication. */
import { mkdirSync, openSync, closeSync, fsyncSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, createPublicKey } from 'node:crypto';
import { hostname } from 'node:os';
import { evaluateProof } from './proof.mjs';

export const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const alphaAt = k => 0.05 / (k * (k + 1)); // telescopes to .05 over the lifetime
export const RULES = Object.freeze({ version: 'ruflo.research-loop/v1', maxEpochs: 64,
  maxUnits: 1000000, maxEpochUnits: 100000, maxCandidates: 12, plateauWindow: 3,
  providerSpendUsd: 0, families: ['retrieval', 'repair', 'planning'], generations: [1, 2, 3],
  controls: ['frozen', 'static', 'shuffled', 'previous'], minRelativeProductivityGain: 0.1,
  totalAlpha: 0.05, minClusters: 16, productionPromotion: false });
const integer = (x, lo, hi) => Number.isSafeInteger(x) && x >= lo && x <= hi;
const assert = (ok, why) => { if (!ok) throw Error(why); };
const digestPattern = /^[a-f0-9]{64}$/;
export function currentSource() {
  const names = ['ledger.mjs', 'proof.mjs', 'retrieval.mjs', 'run.mjs', '../../../src/memory/hybrid-retrieval.ts'];
  return Object.fromEntries(names.map(name => [name, hash(readFileSync(new URL(name, import.meta.url), 'utf8'))]));
}
const validSource = source => source && Object.keys(source).sort().join(',') === Object.keys(currentSource()).sort().join(',') && Object.values(source).every(x => digestPattern.test(x));
export function validatePolicy(p) {
  assert(p && Object.keys(p).sort().join(',') === 'b,k1,subjectWeight', 'policy keys');
  assert([0, 0.5, 0.75, 1].includes(p.b) && [0.5, 1.5, 2.5].includes(p.k1) && [0, 1, 3, 6].includes(p.subjectWeight), 'policy bounds');
  return structuredClone(p);
}
export const ROOT_POLICY = Object.freeze({ b: 0.75, k1: 1.5, subjectWeight: 3 });

function initial() { return { head: null, events: 0, epochs: 0, reservedUnits: 0, pending: null,
  champion: ROOT_POLICY, credits: [1, 1, 1], completed: [], attempts: [], proofIndex: 0,
  consumedDatasets: [], consumedTasks: [], hypotheses: 1, snapshots: [], confirmation: null, boundedRsiEvidenceAccepted: false, openEndedRsiProven: false,
  status: 'DEVELOPMENT', productionPromotion: false }; }
function reduce(s, e) {
  const p = e.payload;
  if (e.type === 'INIT') {
    assert(s.events === 0 && p.rulesHash === hash(RULES), 'genesis rules');
    assert(typeof p.mission === 'string' && /^[a-z0-9-]{1,80}$/.test(p.mission), 'mission');
    assert(validSource(p.source), 'source hashes');
    assert(Array.isArray(p.trust) && p.trust.length <= 2, 'trust registry');
    const keyIds = p.trust.map(t => {
      assert(t && Object.keys(t).sort().join(',') === 'publicKey,role' && typeof t.publicKey === 'string' && t.publicKey.length <= 4096, 'trust fields');
      const key = createPublicKey(t.publicKey); assert(key.asymmetricKeyType === 'ed25519', 'Ed25519 evaluators required');
      return hash(key.export({ type: 'spki', format: 'der' }).toString('base64'));
    });
    assert(p.trust.length === 0 || (p.trust.length === 2 && new Set(keyIds).size === 2 && p.trust.map(t => t.role).sort().join(',') === 'primary,replica'), 'distinct evaluator roles');
    s.genesis = p; s.source = p.source;
    const root = { parent: null, sourceHash: hash(p.source), epoch: 0, policy: ROOT_POLICY, credits: [1, 1, 1] };
    s.snapshots.push({ ...root, id: hash(root) });
  } else {
    assert(s.genesis, 'missing genesis');
    if (e.type === 'RESERVE') {
      assert(!s.pending && !s.boundedRsiEvidenceAccepted && s.status === 'DEVELOPMENT', 'loop not runnable');
      assert(p.epoch === s.epochs + 1 && p.epoch <= RULES.maxEpochs, 'epoch ceiling');
      assert(integer(p.units, 1, RULES.maxEpochUnits) && s.reservedUnits + p.units <= RULES.maxUnits, 'budget ceiling');
      assert(p.sourceHash === hash(s.source) && digestPattern.test(p.corpusHash), 'reservation binding');
      assert(Array.isArray(p.candidates) && p.candidates.length <= RULES.maxCandidates && p.candidates.length > 0, 'candidate ceiling');
      p.candidates.forEach(c => { validatePolicy(c.policy); assert(integer(c.axis, 0, 2), 'axis'); });
      s.epochs = p.epoch; s.reservedUnits += p.units; s.pending = p;
    } else if (e.type === 'COMPLETE' || e.type === 'INTERRUPTED') {
      assert(s.pending && p.epoch === s.pending.epoch, 'pending epoch mismatch');
      if (e.type === 'COMPLETE') {
        assert(p.receipt?.sourceHash === s.pending.sourceHash && p.receipt?.corpusHash === s.pending.corpusHash, 'receipt binding');
        assert(hash(p.receipt.beforePolicy) === hash(s.champion), 'receipt parent mismatch');
        assert(p.receipt.epoch === s.pending.epoch, 'receipt epoch mismatch');
        assert(integer(p.receipt.actualUnits, 1, s.pending.units), 'unreserved work');
        assert(p.receipt.providerSpendUsd === 0 && p.receipt.dataSource === 'REPOSITORY_DEVELOPMENT', 'development evidence required');
        assert(p.receipt.boundedRsiEvidenceAccepted === false, 'development cannot claim RSI');
        const next = validatePolicy(p.receipt.nextPolicy);
        assert([s.champion, ...s.pending.candidates.map(c => c.policy)].some(c => hash(c) === hash(next)), 'unproposed policy');
        assert(p.receipt.credits?.length === 3 && p.receipt.credits.every(c => Number.isFinite(c) && c >= 1 && c <= 100), 'credit bounds');
        s.champion = next; s.credits = p.receipt.credits; s.completed.push(p.receipt);
        const snapshot = { parent: s.snapshots.at(-1).id, sourceHash: s.pending.sourceHash, epoch: s.pending.epoch, policy: next, credits: s.credits };
        s.snapshots.push({ ...snapshot, id: hash(snapshot) });
        const tail = s.completed.slice(-RULES.plateauWindow);
        if (tail.length === RULES.plateauWindow && tail.every(r => r.selectionImproved === false)) s.status = 'PLATEAU_REQUIRES_NEW_HYPOTHESIS';
      }
      s.attempts.push({ ...s.pending, outcome: e.type }); s.pending = null;
      if (s.epochs >= RULES.maxEpochs || s.reservedUnits >= RULES.maxUnits) s.status = 'BUDGET_EXHAUSTED';
    } else if (e.type === 'HYPOTHESIS') {
      assert(!s.pending && !s.confirmation && !s.boundedRsiEvidenceAccepted && s.epochs < RULES.maxEpochs && s.reservedUnits < RULES.maxUnits, 'cannot change hypothesis');
      assert(validSource(p.source) && hash(p.source) !== hash(s.source), 'new source snapshot required');
      assert(typeof p.reason === 'string' && p.reason.length >= 20 && p.reason.length <= 2000, 'hypothesis rationale required');
      s.source = p.source; s.hypotheses++; s.status = 'DEVELOPMENT';
    } else if (e.type === 'PROOF_RESERVED') {
      assert(!s.pending && !s.confirmation && !s.boundedRsiEvidenceAccepted, 'confirmation already active');
      assert(s.genesis.trust.length === 2, 'independent evaluators not configured');
      assert(p.testIndex === s.proofIndex + 1 && p.alpha === alphaAt(p.testIndex), 'alpha allocation');
      assert(p.manifest?.mission === s.genesis.mission && p.manifest.protocolHash === hash(RULES), 'proof protocol');
      assert(p.manifest.sourceHash === hash(s.source), 'proof source snapshot mismatch');
      assert(/^[a-f0-9]{40}$/.test(p.manifest.sourceCommit), 'source commit');
      assert(Array.isArray(p.manifest.datasets) && p.manifest.datasets.length === 2 && new Set(p.manifest.datasets).size === 2 && p.manifest.datasets.every(x => digestPattern.test(x) && !s.consumedDatasets.includes(x)), 'fresh datasets required');
      assert(p.manifest.checkpoints?.length === 3 && new Set(p.manifest.checkpoints).size === 3 && p.manifest.checkpoints.every(x => digestPattern.test(x)), 'three frozen checkpoints');
      assert(s.snapshots.length >= 4 && hash(p.manifest.checkpoints) === hash(s.snapshots.slice(-3).map(n => n.id)), 'proof checkpoints must be recorded descendants');
      assert(p.manifest.rootCheckpoint === s.snapshots[0].id && hash(p.manifest.parents) === hash(s.snapshots.slice(-3).map(n => n.parent)), 'proof parent chain');
      s.proofIndex = p.testIndex; s.consumedDatasets.push(...p.manifest.datasets);
      s.confirmation = { ...p, reservedHead: e.hash };
    } else if (e.type === 'PROOF_RESULT') {
      assert(s.confirmation && p.testIndex === s.proofIndex, 'proof not reserved');
      assert(Array.isArray(p.packets) && p.packets.length === 2, 'two packets required');
      let verdict;
      try { verdict = evaluateProof(s, p.packets, RULES); }
      catch (error) { verdict = { accepted: false, reason: error.message, receiptHashes: p.packets.map(hash) }; }
      for (const packet of p.packets) for (const cell of packet?.result?.cells ?? []) for (const pair of cell.pairs ?? []) {
        if (typeof pair.taskId === 'string' && !s.consumedTasks.includes(pair.taskId)) s.consumedTasks.push(pair.taskId);
      }
      s.lastProof = { ...p, verdict }; s.boundedRsiEvidenceAccepted = verdict.accepted;
      s.confirmation = null;
      if (verdict.accepted) s.status = 'BOUNDED_RSI_EVIDENCE_ACCEPTED';
    } else if (e.type === 'WRITER_RECOVERED') {
      assert(typeof p.ownerPid === 'number' && (p.abandonedHash === null || digestPattern.test(p.abandonedHash)), 'writer recovery audit');
    } else throw Error('unknown ledger event');
  }
  s.events++; s.head = e.hash;
  return s;
}
export function loadLedger(dir, expectedHead) {
  const files = readdirSync(dir).filter(n => /^\d{8}\.json$/.test(n)).sort();
  assert(files.length > 0 && files.length < 10000, 'ledger length');
  const state = initial();
  files.forEach((name, i) => {
    assert(name === `${String(i).padStart(8, '0')}.json`, 'ledger gap');
    const path = join(dir, name); assert(statSync(path).size <= 8 * 1024 * 1024, 'event too large');
    const event = JSON.parse(readFileSync(path, 'utf8')), { hash: recorded, ...body } = event;
    assert(event.index === i && event.parent === state.head && hash(body) === recorded, 'ledger chain mismatch');
    reduce(state, event);
  });
  if (expectedHead !== undefined) assert(state.head === expectedHead, 'anchored head mismatch');
  return state;
}
export function append(dir, type, payload, expectedHead, hooks = {}) {
  const lock = join(dir, '.writer-lock');
  const lockFd = openSync(lock, 'wx', 0o600);
  try {
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, host: hostname(), expectedHead })); fsyncSync(lockFd);
    const names = readdirSync(dir).filter(n => /^\d{8}\.json$/.test(n));
    const state = names.length ? loadLedger(dir, expectedHead) : initial();
    assert(state.head === expectedHead, 'concurrent ledger change');
    const body = { index: state.events, parent: state.head, type, payload };
    const event = { ...body, hash: hash(body) }; reduce(state, event);
    const name = `${String(body.index).padStart(8, '0')}.json`, temp = join(dir, `${name}.pending`);
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(event) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    hooks.beforePublish?.();
    renameSync(temp, join(dir, name));
    const dfd = openSync(dir, 'r'); try { fsyncSync(dfd); } finally { closeSync(dfd); }
    hooks.afterPublish?.();
    return state;
  } finally { closeSync(lockFd); unlinkSync(lock); }
}
export function recoverWriter(dir, expectedHead) {
  const recoveryPath = join(dir, '.recovery-lock'), recoveryFd = openSync(recoveryPath, 'wx', 0o600);
  try {
  const s = loadLedger(dir, expectedHead), lock = join(dir, '.writer-lock');
  const owner = JSON.parse(readFileSync(lock, 'utf8'));
  assert(owner.host === hostname() && integer(owner.pid, 1, 2 ** 31 - 1), 'writer ownership cannot be established on this host');
  let dead = false;
  try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') dead = true; else throw error; }
  assert(dead, 'writer may still be alive; recovery refused');
  // These are local crash diagnostics, not distributed authorization or automatic lease expiry.
  const pending = readdirSync(dir).filter(n => /^\d{8}\.json\.pending$/.test(n));
  assert(pending.length <= 1, 'ambiguous interrupted writes');
  let abandonedHash = null;
  if (pending.length) {
    const path = join(dir, pending[0]); abandonedHash = hash(readFileSync(path, 'utf8'));
    renameSync(path, join(dir, `abandoned-${abandonedHash}.json`));
  }
  unlinkSync(lock);
  return append(dir, 'WRITER_RECOVERED', { ownerPid: owner.pid, abandonedHash }, s.head);
  } finally { closeSync(recoveryFd); unlinkSync(recoveryPath); }
}
export function initLedger(dir, mission, source, trust = []) {
  mkdirSync(resolve(dir), { recursive: false });
  return append(dir, 'INIT', { mission, source, trust, rulesHash: hash(RULES) }, null);
}
export function reserveProof(dir, manifest) {
  const s = loadLedger(dir), testIndex = s.proofIndex + 1;
  return append(dir, 'PROOF_RESERVED', { testIndex, alpha: alphaAt(testIndex), manifest }, s.head);
}
export function summary(s) {
  const sourceMatches = hash(currentSource()) === hash(s.source);
  return { mission: s.genesis.mission, head: s.head, status: sourceMatches ? s.status : 'SOURCE_DRIFT', epochs: s.epochs,
    completed: s.completed.length, hypotheses: s.hypotheses, reservedUnits: s.reservedUnits, pendingEpoch: s.pending?.epoch ?? null,
    champion: s.champion, proofAttempts: s.proofIndex, confirmationPending: !!s.confirmation,
    independentEvaluatorsConfigured: s.genesis.trust.length === 2,
    sourceMatches, boundedRsiEvidenceAccepted: sourceMatches && s.boundedRsiEvidenceAccepted, openEndedRsiProven: false, productionPromotion: false };
}
