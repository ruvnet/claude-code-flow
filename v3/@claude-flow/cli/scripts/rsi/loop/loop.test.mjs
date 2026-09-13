import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { RULES, ROOT_POLICY, hash, alphaAt, initLedger, loadLedger, append, reserveProof, validatePolicy, recoverWriter } from './ledger.mjs';
import { evaluateProof, signTest } from './proof.mjs';
import { sourceIdentity, loadCorpus, TASKS, ARMS, scorePolicy, makeReservation, runReserved, propose, proposeLegacy, creditUpdate } from './retrieval.mjs';
import { step, recover, replayDevelopment } from './run.mjs';

function fixture(t, trust = []) {
  const root = mkdtempSync(join(tmpdir(), 'ruflo-loop-')), dir = join(root, 'ledger');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initLedger(dir, 'test-mission', sourceIdentity(), trust); return dir;
}
const keys = () => ['primary', 'replica'].map(role => {
  const k = generateKeyPairSync('ed25519'); return { role, publicKey: k.publicKey.export({ type: 'spki', format: 'pem' }), privateKey: k.privateKey };
});
function proofFixture(t) {
  const identities = keys(), dir = fixture(t, identities.map(({ role, publicKey }) => ({ role, publicKey })));
  step(dir); step(dir); step(dir); const developed = loadLedger(dir);
  const manifest = { mission: 'test-mission', protocolHash: hash(RULES), sourceCommit: 'a'.repeat(40),
    sourceHash: hash(developed.source), rootCheckpoint: developed.snapshots[0].id,
    parents: developed.snapshots.slice(-3).map(n => n.parent), checkpoints: developed.snapshots.slice(-3).map(n => n.id), datasets: [hash('primary'), hash('replica')] };
  const state = reserveProof(dir, manifest);
  const packets = identities.map((k, i) => {
    const result = { mission: manifest.mission, sourceCommit: manifest.sourceCommit, registrationHead: state.confirmation.reservedHead,
      sourceHash: manifest.sourceHash, rootCheckpoint: manifest.rootCheckpoint, parents: manifest.parents,
      checkpoints: manifest.checkpoints, datasetHash: manifest.datasets[i], costUnit: 'usd', realWorkloads: true, sealedFromDeveloper: true,
      sourceVerified: true, fullCostMeasured: true, noHumanEdits: true, causalResetPassed: true, safetyPassed: true,
      cells: RULES.families.flatMap(family => RULES.generations.flatMap(generation => RULES.controls.map(control => ({
        family, generation, control,
        pairs: Array.from({ length: 16 }, (_, j) => ({ taskId: `${k.role}/${family}/${generation}/${j}`, clusterId: `repo-${j}`,
          startHash: hash('same-start'), startScore: 0.2, baselineScore: 0.5, candidateScore: 0.7,
          baselineCost: 1, candidateCost: 1, baselineTrainingCost: 0.5, baselineEvaluationCost: 0.5,
          candidateTrainingCost: 0.5, candidateEvaluationCost: 0.5, budget: 1 }))
      })))) };
    return { role: k.role, result, signature: sign(null, Buffer.from(JSON.stringify(result)), k.privateKey).toString('base64') };
  });
  const resign = (ps, i = 0) => { ps[i].signature = sign(null, Buffer.from(JSON.stringify(ps[i].result)), identities[i].privateKey).toString('base64'); return ps; };
  return { dir, state, manifest, packets, resign };
}

test('native repository retrieval is deterministic and target modules are split', () => {
  const corpus = loadCorpus(); assert.equal(corpus.docs.length, 67);
  const train = TASKS.filter(t => t.split === 'train'), selection = TASKS.filter(t => t.split === 'selection');
  assert.ok(selection.every(t => !train.some(i => i.target === t.target)));
  const rows = scorePolicy(corpus, ROOT_POLICY, TASKS);
  assert.deepEqual(rows, scorePolicy(corpus, ROOT_POLICY, TASKS));
  assert.ok(rows.every(r => r.rank >= 1 && r.rank <= 67 && r.score === 1 / r.rank));
  assert.ok(rows.filter(r => train.some(t => t.id === r.taskId)).some(r => r.rank > 1), 'training baseline needs headroom');
  assert.ok(rows.filter(r => selection.some(t => t.id === r.taskId)).some(r => r.rank > 1), 'selection baseline needs headroom');
  assert.throws(() => validatePolicy({ ...ROOT_POLICY, arbitraryCode: 'execute' }), /keys/);
  assert.throws(() => validatePolicy({ ...ROOT_POLICY, b: NaN }), /bounds/);
});

test('crash after reservation retains work and forbids a free retry', t => {
  const dir = fixture(t);
  const source = `import {step} from ${JSON.stringify(new URL('./run.mjs', import.meta.url).href)};step(${JSON.stringify(dir)},{reserveOnly:true});process.exit(23);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(child.status, 23, child.stderr);
  const before = loadLedger(dir); assert.ok(before.pending && before.reservedUnits > 0);
  assert.throws(() => step(dir), /interrupted/);
  assert.throws(() => recover(dir, '0'.repeat(64)), /anchored/);
  recover(dir, before.head);
  const after = loadLedger(dir); assert.equal(after.reservedUnits, before.reservedUnits); assert.equal(after.epochs, before.epochs);
  assert.equal(after.attempts[0].outcome, 'INTERRUPTED');
  step(dir); assert.ok(loadLedger(dir).reservedUnits > after.reservedUnits);
});

test('SIGKILL during atomic append has explicit anchored recovery without resetting charged work', t => {
  for (const phase of ['beforePublish', 'afterPublish']) {
    const dir = fixture(t), before = loadLedger(dir);
    const source = `import {append,loadLedger} from ${JSON.stringify(new URL('./ledger.mjs', import.meta.url).href)};import {loadCorpus,makeReservation} from ${JSON.stringify(new URL('./retrieval.mjs', import.meta.url).href)};const s=loadLedger(${JSON.stringify(dir)});append(${JSON.stringify(dir)},'RESERVE',makeReservation(s,loadCorpus()),s.head,{${phase}:()=>process.kill(process.pid,'SIGKILL')});`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const crashed = loadLedger(dir);
    if (phase === 'afterPublish') assert.ok(crashed.reservedUnits > 0);
    else assert.equal(crashed.reservedUnits, before.reservedUnits);
    const recovered = recoverWriter(dir, crashed.head);
    assert.equal(recovered.reservedUnits, crashed.reservedUnits);
    if (recovered.pending) recover(dir, recovered.head);
    step(dir); assert.ok(loadLedger(dir).completed.length > 0);
  }
});

test('resumable epochs execute all attempts without promoting development to proof', t => {
  const dir = fixture(t); step(dir);
  const s = loadLedger(dir), r = s.completed[0];
  assert.equal(s.epochs, 1); assert.equal(s.pending, null); assert.ok(r.attempts.length > 0);
  assert.equal(r.actualUnits, s.reservedUnits); assert.equal(r.providerSpendUsd, 0);
  assert.equal(r.actualUnits, 49848); assert.equal(r.attempts.length, 12);
  assert.deepEqual(r.improvementCapacity.map(c => c.arm), ARMS);
  assert.ok(r.improvementCapacity.every(c => c.actualUnits === 8040 && hash(c.optimizationStartPolicy) === hash(ROOT_POLICY)));
  assert.equal(r.improvementCapacity.reduce((n, c) => n + c.actualUnits, r.parentAuditUnits), r.actualUnits);
  assert.equal(r.controlComparisons.length, 5);
  const adaptive = r.attempts.filter(a => a.arm === 'adaptive'), expectedCredits = r.beforeCredits.map(c => Math.max(1, c * 0.9));
  adaptive.forEach(a => { for (const axis of a.editedAxes) expectedCredits[axis] = Math.min(100, expectedCredits[axis] + Math.max(0, a.delta) * 10 / a.editedAxes.length); });
  assert.deepEqual(r.credits, expectedCredits, 'control and selection outcomes cannot update credits');
  assert.equal(s.boundedRsiEvidenceAccepted, false); assert.equal(s.productionPromotion, false);
  assert.equal(replayDevelopment(dir, s.head).replayedEpochs, 1);
  assert.deepEqual(loadLedger(dir, s.head).head, s.head);
  const first = JSON.parse(readFileSync(join(dir, '00000000.json'))); first.payload.mission = 'tampered';
  writeFileSync(join(dir, '00000000.json'), JSON.stringify(first));
  assert.throws(() => loadLedger(dir), /chain/);
});

test('joint coverage is explicit and old implementation control preserves its exact source', () => {
  const pinned = spawnSync('git', ['show', 'a59659ebcf4a29e1c616ac9a6a0dad5b619a1de8:v3/@claude-flow/cli/scripts/rsi/loop/retrieval.mjs'], { encoding: 'utf8' });
  assert.equal(pinned.status, 0, pinned.stderr);
  const old = pinned.stdout.slice(pinned.stdout.indexOf('export function propose('), pinned.stdout.indexOf('export function makeReservation('))
    .trim().replace('export function propose(', 'function proposeLegacy(');
  assert.equal(proposeLegacy.toString(), old);
  for (let epoch = 0; epoch < 8; epoch++) {
    const state = { epochs: epoch, champion: ROOT_POLICY, credits: [7, 1, 3] };
    const candidates = propose(state);
    assert.equal(candidates.length, 2); assert.equal(candidates[0].editedAxes.length, 3);
    assert.equal(candidates[1].editedAxes.length, 1);
    assert.notEqual(hash(candidates[0].policy), hash(candidates[1].policy));
    assert.deepEqual(candidates[0], propose({ ...state, credits: [1, 1, 1] })[0]);
  }
});

test('joint credit records heuristic allocation and ignores control or selection outcomes', () => {
  const joint = { arm: 'adaptive', policy: { b: 1, k1: 2.5, subjectWeight: 6 }, axis: 0, editedAxes: [0, 1, 2], delta: 0.3 };
  const result = creditUpdate([1, 1, 1], [joint]);
  assert.deepEqual(result.credits, [2, 2, 2]);
  assert.equal(result.allocations[0].assigned.reduce((n, a) => n + a.added, 0), 3);
  assert.deepEqual(creditUpdate([1, 1, 1], [{ ...joint, candidateSelection: [{ score: -999 }] }, { ...joint, arm: 'static', delta: 999 }]), result);
  assert.deepEqual(creditUpdate([1, 1, 1], [{ ...joint, delta: -1 }]).credits, [1, 1, 1]);
});

test('proposer controls share random addresses and bind previous optimizer ancestry', t => {
  const dir = fixture(t); const s = loadLedger(dir), corpus = loadCorpus();
  const parent = { id: hash('previous optimizer'), epoch: 1, credits: [4, 1, 2] }, child = { id: hash('current optimizer'), epoch: 2, credits: [9, 2, 1] };
  const state = { ...s, epochs: 2, credits: [9, 2, 1], snapshots: [...s.snapshots, parent, child],
    completed: [{ beforeCredits: [4, 1, 2], credits: [9, 2, 1] }] };
  const r = makeReservation(state, corpus);
  assert.deepEqual(r.optimizerInputs.previous, { credits: [4, 1, 2], checkpoint: parent.id });
  assert.deepEqual(r.optimizerInputs.shuffled.credits, [2, 1, 9]);
  assert.deepEqual(r.candidates.filter(c => c.arm === 'adaptive').map(({ arm, ...c }) => c),
    propose({ epochs: 2, champion: ROOT_POLICY, credits: [9, 2, 1] }));
  assert.equal(new Set(ARMS.map(a => r.candidates.filter(c => c.arm === a).length)).size, 1);
});

test('budget and concurrency checks occur before any evaluation', t => {
  const dir = fixture(t), s = loadLedger(dir), reservation = makeReservation(s, loadCorpus());
  assert.throws(() => append(dir, 'RESERVE', { ...reservation, units: RULES.maxEpochUnits + 1 }, s.head), /budget/);
  assert.equal(loadLedger(dir).epochs, 0);
  const reserved = append(dir, 'RESERVE', reservation, s.head);
  assert.throws(() => append(dir, 'RESERVE', reservation, s.head), /anchored|concurrent/);
  assert.throws(() => append(dir, 'COMPLETE', { epoch: 1, receipt: { boundedRsiEvidenceAccepted: true } }, reserved.head));
  assert.equal(loadLedger(dir).reservedUnits, reservation.units);
  const receipt = runReserved(reserved, loadCorpus());
  assert.throws(() => append(dir, 'COMPLETE', { epoch: 1, receipt: { ...receipt, beforePolicy: { ...ROOT_POLICY, b: 0 } } }, reserved.head), /parent/);
  assert.throws(() => append(dir, 'COMPLETE', { epoch: 1, receipt: { ...receipt, epoch: 2 } }, reserved.head), /epoch/);
  assert.throws(() => runReserved({ ...reserved, pending: { ...reserved.pending, units: 1 } }, loadCorpus()), /reservation exhausted/);
});

test('source changes require explicit new hypothesis without resetting lifetime counters', t => {
  const dir = fixture(t); step(dir); const s = loadLedger(dir);
  const source = { ...s.source, 'retrieval.mjs': hash('new revision') };
  const next = append(dir, 'HYPOTHESIS', { source, reason: 'New reviewed retrieval hypothesis with fresh developer queries' }, s.head);
  assert.equal(next.epochs, s.epochs); assert.equal(next.reservedUnits, s.reservedUnits); assert.equal(next.proofIndex, s.proofIndex);
  assert.equal(next.hypotheses, 2); assert.throws(() => step(dir), /source drift/);
});

test('plateau stops redundant local execution', t => {
  const dir = fixture(t); let s = loadLedger(dir);
  for (let i = 0; i < 3; i++) {
    const corpus = loadCorpus(); s = append(dir, 'RESERVE', makeReservation(s, corpus), s.head);
    const r = runReserved(s, corpus);
    s = append(dir, 'COMPLETE', { epoch: s.epochs, receipt: { ...r, selectionImproved: false, nextPolicy: s.champion } }, s.head);
  }
  assert.equal(s.status, 'PLATEAU_REQUIRES_NEW_HYPOTHESIS');
  assert.equal(step(dir).epochs, s.epochs);
});

test('alpha lifetime allocation sums below .05 and cannot reset on restart', t => {
  assert.ok(Array.from({ length: 10000 }, (_, i) => alphaAt(i + 1)).reduce((a, b) => a + b, 0) < 0.05);
  const { dir, state, packets, manifest } = proofFixture(t);
  const bad = structuredClone(packets); bad[0].signature = 'forged';
  const failed = append(dir, 'PROOF_RESULT', { testIndex: 1, packets: bad }, state.head);
  assert.equal(failed.boundedRsiEvidenceAccepted, false); assert.match(failed.lastProof.verdict.reason, /signature/);
  assert.throws(() => reserveProof(dir, manifest), /fresh datasets/);
  const next = reserveProof(dir, { ...manifest, datasets: [hash('new primary'), hash('new replica')] });
  assert.equal(next.proofIndex, 2); assert.equal(next.confirmation.alpha, alphaAt(2));
});

test('proof path recomputes all 72 comparisons and recognizes only approved evaluator attestations', t => {
  const { dir, state, packets } = proofFixture(t), verdict = evaluateProof(state, packets, RULES);
  assert.equal(verdict.tests.length, 72); assert.equal(verdict.accepted, true);
  const s = append(dir, 'PROOF_RESULT', { testIndex: 1, packets, verdict: { accepted: false } }, state.head);
  assert.equal(s.boundedRsiEvidenceAccepted, true); assert.equal(s.openEndedRsiProven, false); assert.equal(s.productionPromotion, false);
  assert.equal(loadLedger(dir).lastProof.verdict.accepted, true);
  assert.match(s.lastProof.verdict.assurance, /conditional/);
});

test('even trusted signatures cannot bypass missing evidence, altered controls, or regressions', t => {
  const { state, packets, resign } = proofFixture(t);
  for (const mutate of [
    p => { p.result.cells.pop(); },
    p => { p.result.fullCostMeasured = false; },
    p => { p.result.cells[0].pairs[0].candidateCost = 0; },
    p => { p.result.cells[0].pairs[0].candidateTrainingCost = 0; },
    p => { p.result.cells[0].pairs[0].startHash = hash('different'); },
    p => { p.result.cells[0].pairs[0].taskId = p.result.cells[0].pairs[1].taskId; },
    p => { p.result.cells[0].pairs.forEach(x => { x.clusterId = 'one-repo'; }); },
    p => { p.result.registrationHead = hash('fake'); },
  ]) {
    const changed = structuredClone(packets); mutate(changed[0]); resign(changed);
    assert.throws(() => evaluateProof(state, changed, RULES));
  }
  const negative = structuredClone(packets);
  negative[0].result.cells.forEach(c => c.pairs.forEach(p => { p.candidateScore = 0.4; })); resign(negative);
  assert.equal(evaluateProof(state, negative, RULES).accepted, false);
  const unauthenticated = structuredClone(packets); unauthenticated[0].result.cells[0].pairs[0].candidateScore = 1;
  assert.throws(() => evaluateProof(state, unauthenticated, RULES), /signature/);
});

test('ordinary development missions cannot reserve or forge independent confirmation', t => {
  const dir = fixture(t); assert.throws(() => reserveProof(dir, {}), /evaluators/);
  const s = loadLedger(dir);
  assert.throws(() => append(dir, 'PROOF_RESULT', { testIndex: 0, packets: [], verdict: { accepted: true } }, s.head), /reserved/);
  assert.equal(readdirSync(dir).filter(n => n.endsWith('.json')).length, 1);
});

test('one signing key in two PEM encodings is not independent replication', t => {
  const identities = keys(), key = identities[0].publicKey;
  assert.throws(() => fixture(t, [{ role: 'primary', publicKey: key }, { role: 'replica', publicKey: key + '\n' }]), /distinct/);
});

test('proof source and checkpoint identities must match this mission', t => {
  const { dir, state, packets, manifest } = proofFixture(t);
  const bad = structuredClone(packets); bad[0].signature = 'bad';
  append(dir, 'PROOF_RESULT', { testIndex: 1, packets: bad }, state.head);
  const fresh = { ...manifest, datasets: [hash('fresh1'), hash('fresh2')] };
  assert.throws(() => reserveProof(dir, { ...fresh, sourceHash: hash('other-source') }), /source/);
  assert.throws(() => reserveProof(dir, { ...fresh, checkpoints: [hash('a'), hash('b'), hash('c')] }), /descendants/);
});

test('sign test matches exact small cases and supports larger replication samples', () => {
  assert.equal(signTest([1, 1, 1, 1]).p, 1 / 16);
  assert.equal(signTest([0, 0]).p, 1);
  assert.ok(Math.abs(signTest([-1, -1]).p - 1) < 1e-12);
  assert.ok(signTest(Array(100).fill(1)).p < 1e-20);
  assert.throws(() => signTest([NaN]));
});
