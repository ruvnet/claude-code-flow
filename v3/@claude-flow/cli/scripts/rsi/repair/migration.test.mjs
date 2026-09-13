import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, loadLedger, append, ROOT_POLICY, alphaAt } from '../loop/ledger.mjs';
import { LEDGER, ledgerFingerprint } from './admission.mjs';
import { projectState, verifyProjection, buildProposal, verifyProposal, applyMigration, vector, reserveResources, settleResources } from './migration.mjs';

const HEAD = '5a0e219e871fcf616209807c828c5793c29752f8d190fc38a0bc95e4db88422e';
const zeros = () => ({ nativeFieldCalls: 0, repairCandidateEvaluations: 0, repairProcessStarts: 0, repairWallMs: 0 });
const state = () => loadLedger(LEDGER, HEAD);
function tempLedger(fn) { const dir = mkdtempSync(join(tmpdir(), 'rsi-migration-test-')); try { cpSync(LEDGER, dir, { recursive: true }); return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }

test('versioned projection retains all legacy state and literal native units', () => {
  const s = state(), p = projectState(s);
  assert.deepEqual(p.legacy, s);
  assert.equal(p.accounting.reserved.nativeFieldCalls, 209784);
  assert.equal(p.accounting.sharedEpochs.consumed, 7);
  assert.equal(p.accounting.authorizedCeilings.nativeFieldCalls, 1000000);
  assert.equal(p.accounting.authorizedCeilings.repairProcessStarts, 0);
  assert.equal(p.accounting.historicalAcquisitionUsd, null);
  assert.equal(p.accounting.unitConversion, null);
  assert.equal(verifyProjection(s, p).migrationApplied, false);
});
test('refunds and relabeled native units reject even with a recomputed proposal hash', () => {
  const s = state(), p = projectState(s); p.accounting.reserved.nativeFieldCalls = 0;
  assert.throws(() => verifyProjection(s, p), /zero-entitlement/);
  const proposal = buildProposal(LEDGER, HEAD); proposal.accounting.unitConversion = 'one native call = one repair';
  assert.throws(() => verifyProposal(proposal, hash(proposal)), /drift/);
});
test('champion, credits, ancestry and failed history cannot be rewritten', () => {
  const s = state();
  const edits = [p => { p.legacy.champion.b = 0; }, p => { p.legacy.credits[0] = 99; }, p => { p.legacy.snapshots[1].parent = '0'.repeat(64); }, p => { p.legacy.completed = []; }, p => { p.legacy.attempts.pop(); }, p => { p.legacy.hypotheses = 0; }, p => { p.legacy.status = 'NEW'; }];
  for (const edit of edits) { const p = projectState(s); edit(p); assert.throws(() => verifyProjection(s, p), /legacy state changed/); }
});
test('source, protocol, trust, alpha and consumed evidence cannot be reset', () => {
  const s = state();
  for (const edit of [p => { p.legacy.source = {}; }, p => { p.legacy.genesis.trust = ['invented']; }, p => { p.legacy.proofIndex = 1; }, p => { p.evidence.nextAlpha = 0.05; }, p => { p.accounting.sharedEpochs.ceiling = 128; }, p => { p.legacy.consumedTasks = ['fake']; }]) {
    const p = projectState(s); edit(p); assert.throws(() => verifyProjection(s, p));
  }
});
test('nonzero rejected confirmation history remains intact in projection fixtures', () => {
  const s = state(); // Mechanism fixture, not independently signed mission evidence.
  s.proofIndex = 4; s.consumedDatasets = ['a', 'b']; s.consumedTasks = ['task-a'];
  s.lastProof = { verdict: { accepted: false }, testIndex: 3 };
  s.confirmation = { reservedHead: 'c'.repeat(64), testIndex: 4 };
  const p = projectState(s);
  assert.deepEqual(p.legacy, s);
  assert.equal(p.evidence.nextAlpha, alphaAt(5));
  p.legacy.lastProof = null; assert.throws(() => verifyProjection(s, p), /legacy state changed/);
});
test('durable interrupted reservation is charged and retained, not refunded', () => tempLedger(dir => {
  const s = state();
  const reservation = { epoch: 8, units: 19, sourceHash: hash(s.source), corpusHash: 'a'.repeat(64), candidates: [{ policy: ROOT_POLICY, axis: 0 }] };
  append(dir, 'RESERVE', reservation, HEAD);
  const pending = loadLedger(dir), projected = projectState(pending);
  assert.deepEqual(projected.legacy.pending, reservation);
  assert.equal(projected.accounting.reserved.nativeFieldCalls, 209803);
  assert.throws(() => buildProposal(dir, pending.head), /pending work/);
  append(dir, 'INTERRUPTED', { epoch: 8 }, pending.head);
  const interrupted = loadLedger(dir), p = projectState(interrupted);
  assert.equal(p.accounting.reserved.nativeFieldCalls, 209803);
  assert.equal(p.legacy.attempts.at(-1).outcome, 'INTERRUPTED');
  assert.equal(p.accounting.sharedEpochs.consumed, 8);
}));
test('ambiguous locks and stranded publication files are refused and preserved', () => tempLedger(dir => {
  for (const name of ['.writer-lock', '.recovery-lock', '00000017.json.pending']) {
    writeFileSync(join(dir, name), 'ambiguous');
    assert.throws(() => buildProposal(dir, HEAD), /lock|pending publication/);
    assert.equal(readFileSync(join(dir, name), 'utf8'), 'ambiguous');
    rmSync(join(dir, name)); // Test fixture only; no live recovery is exercised.
  }
}));
test('resource vectors reject unknown, omitted, negative and fractional dimensions', () => {
  for (const x of [{ units: 1 }, { ...zeros(), extra: 1 }, { ...zeros(), nativeFieldCalls: -1 }, { ...zeros(), repairWallMs: 1.5 }, { ...zeros(), repairWallMs: Infinity }, { ...zeros(), nativeFieldCalls: -0 }]) assert.throws(() => vector(x));
});
test('zero authorized repair dimensions reject even when native budget remains', () => {
  const p = projectState(state());
  const accounting = { reserved: p.accounting.reserved, ceilings: p.accounting.authorizedCeilings, pending: null };
  for (const dimension of ['repairCandidateEvaluations', 'repairProcessStarts', 'repairWallMs']) assert.throws(() => reserveResources(accounting, { ...zeros(), [dimension]: 1 }), /resource ceiling/);
  assert.throws(() => applyMigration({ approved: true, signer: 'operator' }), /APPLICATION_DISABLED/);
});
test('complete and interrupted settlements retain the entire reservation', () => {
  const accounting = { reserved: zeros(), ceilings: { ...zeros(), nativeFieldCalls: 100 }, pending: null };
  const reserved = reserveResources(accounting, { ...zeros(), nativeFieldCalls: 80 });
  for (const [outcome, actual] of [['COMPLETE', { ...zeros(), nativeFieldCalls: 7 }], ['INTERRUPTED', null]]) {
    const settled = settleResources(reserved, actual, outcome);
    assert.equal(settled.accounting.reserved.nativeFieldCalls, 80);
    assert.equal(settled.receipt.refund, null);
    assert.throws(() => reserveResources(settled.accounting, { ...zeros(), nativeFieldCalls: 21 }), /ceiling/);
  }
});
test('double reservation, forged pending charges and unreserved actual work reject', () => {
  const reserved = reserveResources({ reserved: zeros(), ceilings: { ...zeros(), nativeFieldCalls: 100 }, pending: null }, { ...zeros(), nativeFieldCalls: 10 });
  assert.throws(() => reserveResources(reserved, { ...zeros(), nativeFieldCalls: 1 }), /already pending/);
  assert.throws(() => settleResources(reserved, { ...zeros(), nativeFieldCalls: 11 }, 'COMPLETE'), /unreserved/);
  assert.throws(() => settleResources(reserved, null, 'COMPLETE'), /measurements/);
  const forged = structuredClone(reserved); forged.pending.reserved.nativeFieldCalls = 1;
  assert.throws(() => settleResources(forged, zeros(), 'COMPLETE'), /binding mismatch/);
});
test('proposal verification is repeatable, source bound and has no ledger writes', () => {
  const before = ledgerFingerprint(LEDGER), proposal = buildProposal(LEDGER, HEAD), anchor = hash(proposal);
  assert.equal(verifyProposal(proposal, anchor).projectionVerified, true);
  assert.equal(hash(buildProposal(LEDGER, HEAD)), anchor);
  assert.equal(ledgerFingerprint(LEDGER), before);
  proposal.sourceClosure['migration.mjs'] = '0'.repeat(64);
  assert.throws(() => verifyProposal(proposal, hash(proposal)), /drift/);
});
