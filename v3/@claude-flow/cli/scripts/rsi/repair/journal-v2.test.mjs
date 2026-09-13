import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hash, loadLedger } from '../loop/ledger.mjs';
import { LEDGER } from './admission.mjs';
import {
  applyMigration, buildSourceRegistry, createProjectedJournal,
  dispatchReplay, loadJournal, recoverJournal, verifyAndRecordSource,
} from './journal-v2.mjs';

const PROPOSAL_HASH = '0662eec69224f1c4e1ea9e06be03863f72dc409136d2210285a879d09ee87203';
const PROPOSAL = new URL('../evidence/migration-proposal.json', import.meta.url);
const HEAD = '5a0e219e871fcf616209807c828c5793c29752f8d190fc38a0bc95e4db88422e';
const repository = resolve(new URL('../../../../../..', import.meta.url).pathname);

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rsi-journal-v2-')), journal = join(root, 'journal');
  try { return fn({ root, journal }); } finally { rmSync(root, { recursive: true, force: true }); }
}
function initialized(fn) {
  return fixture(({ root, journal }) => { const created = createProjectedJournal(journal, PROPOSAL, PROPOSAL_HASH); return fn({ root, journal, created }); });
}
function rewriteEvent(path, edit) {
  const event = JSON.parse(readFileSync(path, 'utf8')); edit(event);
  const { hash: ignored, ...body } = event; event.hash = hash(body);
  writeFileSync(path, `${JSON.stringify(event)}\n`);
}

test('durable projection preserves the complete charged mission and zero entitlements', () => initialized(({ journal, created }) => {
  const state = loadJournal(journal, created.head, PROPOSAL_HASH);
  assert.equal(state.projection.legacy.head, HEAD);
  assert.equal(state.projection.legacy.reservedUnits, 209784);
  assert.equal(state.projection.legacy.epochs, 7);
  assert.equal(state.projection.accounting.authorizedCeilings.repairCandidateEvaluations, 0);
  assert.equal(state.projection.accounting.authorizedCeilings.repairProcessStarts, 0);
  assert.equal(state.projection.accounting.authorizedCeilings.repairWallMs, 0);
  assert.equal(state.migrationApplied, false);
  assert.equal(state.candidateExecutionEnabled, false);
}));

test('source registry covers every charged epoch exactly once', () => {
  const registry = buildSourceRegistry(loadLedger(LEDGER, HEAD));
  assert.deepEqual(registry.entries.flatMap(item => item.epochs).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(registry.entries.map(item => item.adapter), ['git-tree-replay/v1', 'git-tree-replay/v1', 'git-tree-replay/v1']);
  assert.equal(new Set(registry.entries.map(item => item.sourceHash)).size, 3);
  assert.equal(registry.candidateExecutionEnabled, false);
});

test('dispatcher verifies all immutable historical Git trees', () => {
  const registry = buildSourceRegistry(loadLedger(LEDGER, HEAD));
  for (const epoch of [1, 4, 7]) {
    const receipt = dispatchReplay(registry, epoch, repository);
    assert.equal(receipt.epoch, epoch);
    assert.equal(receipt.operation, 'HISTORICAL_REPLAY_ONLY');
    assert.equal(receipt.candidateExecutionEnabled, false);
  }
});

test('verified replay sources append durably and duplicate epochs reject', () => initialized(({ journal, created }) => {
  let state = verifyAndRecordSource(journal, 1, created.head, PROPOSAL_HASH, repository);
  assert.deepEqual(state.verifiedSources.map(item => item.epoch), [1]);
  assert.throws(() => verifyAndRecordSource(journal, 1, state.head, PROPOSAL_HASH, repository), /already verified/);
  state = verifyAndRecordSource(journal, 4, state.head, PROPOSAL_HASH, repository);
  state = verifyAndRecordSource(journal, 7, state.head, PROPOSAL_HASH, repository);
  assert.deepEqual(loadJournal(journal, state.head, PROPOSAL_HASH).verifiedSources.map(item => item.epoch), [1, 4, 7]);
}));

test('rehashed legacy charge or gate tampering rejects', () => initialized(({ journal }) => {
  const eventPath = join(journal, '00000000.json');
  rewriteEvent(eventPath, event => {
    event.payload.projection.legacy.reservedUnits = 0;
    event.payload.legacyStateHash = hash(event.payload.projection.legacy);
    event.payload.projectedStateHash = hash(event.payload.projection);
  });
  assert.throws(() => loadJournal(journal, undefined, PROPOSAL_HASH), /legacy state changed|migration projection|reservation accounting/);
}));

test('self-consistent forged mission cannot borrow the frozen proposal hash', () => initialized(({ journal }) => {
  const eventPath = join(journal, '00000000.json');
  rewriteEvent(eventPath, event => {
    event.payload.projection.legacy.genesis.mission = 'forged-mission';
    event.payload.legacyStateHash = hash(event.payload.projection.legacy);
    event.payload.projection.evidence.inheritedStateHash = event.payload.legacyStateHash;
    event.payload.projectedStateHash = hash(event.payload.projection);
  });
  assert.throws(() => loadJournal(journal, undefined, PROPOSAL_HASH), /frozen proposal state binding/);
}));

test('rehashed source adapter or epoch coverage tampering rejects', () => initialized(({ journal }) => {
  const eventPath = join(journal, '00000000.json');
  rewriteEvent(eventPath, event => {
    event.payload.sourceRegistry.entries[0].adapter = 'shell/v1';
    event.payload.sourceRegistryHash = hash(event.payload.sourceRegistry);
  });
  assert.throws(() => loadJournal(journal, undefined, PROPOSAL_HASH), /immutable source identity/);
}));

test('wrong proposal and journal head anchors reject', () => initialized(({ journal, created }) => {
  assert.throws(() => loadJournal(journal, created.head, '0'.repeat(64)), /proposal/);
  assert.throws(() => loadJournal(journal, '0'.repeat(64), PROPOSAL_HASH), /head mismatch/);
}));

test('publication failure retains owner lock and pending file until explicit recovery', () => initialized(({ journal, created }) => {
  assert.throws(() => verifyAndRecordSource(journal, 1, created.head, PROPOSAL_HASH, repository, LEDGER, { beforePublish() { throw Error('injected stop'); } }), /injected stop/);
  assert.equal(loadJournal(journal, created.head, PROPOSAL_HASH).head, created.head);
  assert.deepEqual(readdirSync(journal).filter(name => name.endsWith('.pending')), ['00000001.json.pending']);
  assert.equal(existsSync(join(journal, '.writer-lock')), true);
  const lock = JSON.parse(readFileSync(join(journal, '.writer-lock'), 'utf8'));
  lock.pid = 2147483647; writeFileSync(join(journal, '.writer-lock'), JSON.stringify(lock));
  const recovered = recoverJournal(journal, created.head, PROPOSAL_HASH);
  assert.equal(recovered.recoveries.length, 1);
  assert.equal(readdirSync(journal).some(name => name.endsWith('.pending')), false);
}));

test('post-publication interruption leaves a complete replayable event', () => initialized(({ journal, created }) => {
  assert.throws(() => verifyAndRecordSource(journal, 4, created.head, PROPOSAL_HASH, repository, LEDGER, { afterPublish() { throw Error('injected stop'); } }), /injected stop/);
  const recovered = loadJournal(journal, undefined, PROPOSAL_HASH);
  assert.deepEqual(recovered.verifiedSources.map(item => item.epoch), [4]);
}));

test('explicit recovery accepts exactly one valid post-publication child', () => initialized(({ journal, created }) => {
  const published = verifyAndRecordSource(journal, 4, created.head, PROPOSAL_HASH, repository);
  const deadPid = 2147483647;
  writeFileSync(join(journal, '.writer-lock'), JSON.stringify({ pid: deadPid, host: hostname(), expectedHead: created.head, expectedProposalHash: PROPOSAL_HASH }));
  const recovered = recoverJournal(journal, created.head, PROPOSAL_HASH);
  assert.equal(recovered.verifiedSources[0].epoch, 4);
  assert.equal(recovered.recoveries.at(-1).ownerPid, deadPid);
  assert.notEqual(recovered.head, published.head);
}));

test('explicit genesis recovery quarantines and reconstructs only the frozen projection', () => fixture(({ journal }) => {
  assert.throws(() => createProjectedJournal(journal, PROPOSAL, PROPOSAL_HASH, LEDGER, { beforePublish() { throw Error('genesis stop'); } }), /genesis stop/);
  const lockPath = join(journal, '.writer-lock'), lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.pid = 2147483647; writeFileSync(lockPath, JSON.stringify(lock));
  const recovered = recoverJournal(journal, null, PROPOSAL_HASH, { proposalFile: PROPOSAL, legacyDir: LEDGER });
  assert.equal(recovered.events, 2);
  assert.equal(recovered.projection.legacy.head, HEAD);
  assert.equal(recovered.recoveries.length, 1);
  assert.ok(existsSync(join(journal, `abandoned-${recovered.recoveries[0].abandonedHash}.json`)));
}));

test('published child plus pending publication is refused and preserved as ambiguous', () => initialized(({ journal, created }) => {
  verifyAndRecordSource(journal, 4, created.head, PROPOSAL_HASH, repository);
  const lock = join(journal, '.writer-lock'), pending = join(journal, '00000002.json.pending');
  writeFileSync(lock, JSON.stringify({ pid: 2147483647, host: hostname(), expectedHead: created.head, expectedProposalHash: PROPOSAL_HASH }));
  writeFileSync(pending, 'impossible second write');
  assert.throws(() => recoverJournal(journal, created.head, PROPOSAL_HASH), /ambiguous/);
  assert.equal(existsSync(lock), true);
  assert.equal(existsSync(pending), true);
}));

test('ordinary source recording cannot race an active recovery', () => initialized(({ journal, created }) => {
  const recovery = join(journal, '.recovery-lock'); writeFileSync(recovery, 'held');
  assert.throws(() => verifyAndRecordSource(journal, 1, created.head, PROPOSAL_HASH, repository), /recovery in progress/);
  assert.throws(() => verifyAndRecordSource(journal, 1, created.head, PROPOSAL_HASH, repository, LEDGER, { allowRecoveryLock: true }), /recovery in progress/);
  assert.equal(existsSync(recovery), true);
}));

test('recovery retains writer exclusion through quarantine and audit append', () => initialized(({ journal, created }) => {
  const lock = join(journal, '.writer-lock');
  writeFileSync(lock, JSON.stringify({ pid: 2147483647, host: hostname(), expectedHead: created.head, expectedProposalHash: PROPOSAL_HASH }));
  writeFileSync(join(journal, '00000001.json.pending'), 'partial event');
  const recovered = recoverJournal(journal, created.head, PROPOSAL_HASH, { afterQuarantine() {
    assert.equal(existsSync(lock), true);
    assert.throws(() => verifyAndRecordSource(journal, 1, created.head, PROPOSAL_HASH, repository), /recovery in progress|EEXIST/);
  } });
  assert.equal(recovered.recoveries.length, 1);
  assert.equal(existsSync(lock), false);
}));

test('explicit anchored recovery quarantines one dead writer publication', () => initialized(({ journal, created }) => {
  const deadPid = 2147483647;
  writeFileSync(join(journal, '.writer-lock'), JSON.stringify({ pid: deadPid, host: hostname(), expectedHead: created.head, expectedProposalHash: PROPOSAL_HASH }));
  writeFileSync(join(journal, '00000001.json.pending'), 'partial event');
  const state = recoverJournal(journal, created.head, PROPOSAL_HASH);
  assert.equal(state.recoveries.length, 1);
  assert.equal(state.recoveries[0].ownerPid, deadPid);
  assert.ok(existsSync(join(journal, `abandoned-${state.recoveries[0].abandonedHash}.json`)));
  assert.equal(existsSync(join(journal, '.writer-lock')), false);
}));

test('live or ambiguously locked writer is preserved and refused', () => initialized(({ journal, created }) => {
  const lock = join(journal, '.writer-lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), expectedHead: created.head, expectedProposalHash: PROPOSAL_HASH }));
  assert.throws(() => recoverJournal(journal, created.head, PROPOSAL_HASH), /may still be alive/);
  assert.equal(existsSync(lock), true);
}));

test('generic journal writes are not exported and migration application remains impossible', async () => initialized(async () => {
  const module = await import('./journal-v2.mjs');
  assert.equal(module.appendJournal, undefined);
  assert.throws(() => applyMigration({ operatorApproved: true }), /APPLICATION_DISABLED/);
}));

test('swapped source trees and ledger prefix anchors reject dispatch', () => {
  const registry = buildSourceRegistry(loadLedger(LEDGER, HEAD));
  const swapped = structuredClone(registry); swapped.entries[0].tree = swapped.entries[1].tree;
  assert.throws(() => dispatchReplay(swapped, 1, repository), /source closure mismatch/);
  const wrongHead = structuredClone(registry); wrongHead.entries[0].anchoredHead = '0'.repeat(64);
  assert.throws(() => dispatchReplay(wrongHead, 1, repository), /anchor absent/);
});
