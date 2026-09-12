#!/usr/bin/env node
/** Versioned migration projection and reservation algebra. No live write or execution path. */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, loadLedger, RULES, alphaAt } from '../loop/ledger.mjs';
import { inspectMission, prepare, sha256, ledgerFingerprint, LEDGER } from './admission.mjs';

const assert = (ok, why) => { if (!ok) throw Error(why); };
const clone = value => structuredClone(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const DIMENSIONS = Object.freeze(['nativeFieldCalls', 'repairCandidateEvaluations', 'repairProcessStarts', 'repairWallMs']);
function exactKeys(value, keys, why) {
  assert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','), why);
}
export function vector(value) {
  exactKeys(value, DIMENSIONS, 'explicit resource dimensions required');
  for (const n of DIMENSIONS) assert(Number.isSafeInteger(value[n]) && value[n] >= 0 && !Object.is(value[n], -0), 'finite nonnegative integer resource required');
  return clone(value);
}
export function projectState(state) {
  assert(state?.genesis?.rulesHash === hash(RULES), 'original protocol required');
  const reservations = [...state.attempts, ...(state.pending ? [state.pending] : [])];
  assert(reservations.length === state.epochs && reservations.reduce((n, r) => n + r.units, 0) === state.reservedUnits, 'reservation accounting mismatch');
  // The complete legacy state is preserved, not just the current policy and totals.
  // This includes pending work, rejected proofs, alpha index and plateau history.
  return {
    schema: 'ruflo.research-loop-migration-projection/v2',
    legacy: clone(state),
    accounting: {
      unitDefinitions: { nativeFieldCalls: 'one original native BM25 field-score call', repairCandidateEvaluations: 'one future candidate evaluation', repairProcessStarts: 'one future isolated process start', repairWallMs: 'one future reserved process wall millisecond' },
      reserved: { nativeFieldCalls: state.reservedUnits, repairCandidateEvaluations: 0, repairProcessStarts: 0, repairWallMs: 0 },
      authorizedCeilings: { nativeFieldCalls: RULES.maxUnits, repairCandidateEvaluations: 0, repairProcessStarts: 0, repairWallMs: 0 },
      sharedEpochs: { consumed: state.epochs, ceiling: RULES.maxEpochs },
      perEpoch: { nativeFieldCalls: RULES.maxEpochUnits, candidates: RULES.maxCandidates },
      unitConversion: null, newResourceAuthorization: null,
      historicalAcquisitionUsd: null, historicalEvaluationUsd: null,
      externalProviderSpendCeilingUsd: RULES.providerSpendUsd,
    },
    policy: { schema: 'ruflo.retrieval-grid/v1', value: clone(state.champion), credits: clone(state.credits) },
    sourceRegistry: { legacySchema: 'ruflo.research-loop/v1', legacyCurrent: clone(state.source), checkpointSourceHashes: state.snapshots.map(s => s.sourceHash) },
    evidence: { rulesHash: hash(RULES), nextProofIndex: state.proofIndex + 1, nextAlpha: alphaAt(state.proofIndex + 1), inheritedStateHash: hash(state) },
    migrationApplied: false, candidateExecutionEnabled: false, boundedRsiEvidenceAccepted: false,
  };
}
export function verifyProjection(state, proposed) {
  assert(hash(proposed?.legacy) === hash(state), 'legacy state changed: charges, ancestry, evidence and trust must be retained');
  const expected = projectState(state);
  assert(hash(proposed) === hash(expected), 'migration projection differs from deterministic zero-entitlement schema');
  return { projectionVerified: true, migrationApplied: false, candidateExecutionEnabled: false };
}

/** Pure algebra for a future durable reducer. It performs no I/O or authorization. */
export function reserveResources(accounting, request) {
  exactKeys(accounting, ['reserved', 'ceilings', 'pending'], 'accounting fields');
  assert(accounting.pending === null, 'reservation already pending');
  const before = vector(accounting.reserved), ceilings = vector(accounting.ceilings), wanted = vector(request);
  assert(DIMENSIONS.some(k => wanted[k] > 0), 'empty reservation');
  const reserved = {};
  for (const k of DIMENSIONS) {
    assert(before[k] <= ceilings[k] && wanted[k] <= ceilings[k] - before[k], `resource ceiling: ${k}`);
    reserved[k] = before[k] + wanted[k];
  }
  return { reserved, ceilings, pending: { before, reserved: wanted } };
}
export function settleResources(accounting, actual, outcome) {
  exactKeys(accounting, ['reserved', 'ceilings', 'pending'], 'accounting fields');
  assert(accounting.pending && ['COMPLETE', 'INTERRUPTED'].includes(outcome), 'pending reservation and explicit outcome required');
  const reserved = vector(accounting.reserved), ceilings = vector(accounting.ceilings);
  exactKeys(accounting.pending, ['before', 'reserved'], 'pending fields');
  const before = vector(accounting.pending.before), charge = vector(accounting.pending.reserved);
  const measured = actual === null ? null : vector(actual);
  assert(outcome === 'INTERRUPTED' || measured !== null, 'completed work needs actual measurements');
  for (const k of DIMENSIONS) {
    assert(reserved[k] <= ceilings[k] && before[k] <= reserved[k] && charge[k] === reserved[k] - before[k], 'pending resource binding mismatch');
    assert(measured === null || measured[k] <= charge[k], 'unreserved actual work');
  }
  // Never refund unused or ambiguous work. A retry must reserve again.
  return { accounting: { reserved, ceilings, pending: null }, receipt: { outcome, charged: charge, actual: measured, refund: null } };
}

function sourceClosure() {
  const names = ['migration.mjs', 'admission.mjs', 'run.mjs', 'witness.mjs', '../loop/ledger.mjs', '../loop/proof.mjs', '../loop/run.mjs', '../loop/retrieval.mjs', '../loop/replay-history.mjs', '../evidence/loop-sources.json', '../../../src/memory/hybrid-retrieval.ts'];
  return Object.fromEntries(names.map(name => [name, sha256(readFileSync(new URL(name, import.meta.url)))]));
}
export function buildProposal(dir, expectedHead) {
  assert(!readdirSync(dir).some(n => /^\d{8}\.json\.pending$/.test(n)), 'stranded pending publication requires explicit recovery');
  const binding = inspectMission(dir, expectedHead), state = loadLedger(dir, expectedHead), projected = projectState(state);
  const readiness = prepare(dir, expectedHead);
  assert(ledgerFingerprint(dir) === binding.fingerprint, 'mission changed during projection');
  return {
    schema: 'ruflo.repair-migration-proposal/v1', mission: binding,
    legacyStateHash: hash(state), projectedStateHash: hash(projected),
    sourceClosure: sourceClosure(), calibrationReadinessHash: hash(readiness),
    accounting: projected.accounting, policy: projected.policy,
    retention: { fullLegacyState: true, attemptHistoryHash: hash(state.attempts), snapshotsHash: hash(state.snapshots), completedHistoryHash: hash(state.completed), confirmationStateHash: hash({ proofIndex: state.proofIndex, consumedDatasets: state.consumedDatasets, consumedTasks: state.consumedTasks, confirmation: state.confirmation, lastProof: state.lastProof ?? null }), nextAlpha: alphaAt(state.proofIndex + 1) },
    migrationApplied: false, candidateExecutionEnabled: false,
    requiredBeforeApplication: ['OPERATOR_APPROVED_REPAIR_RESOURCE_ENVELOPE', 'VERSIONED_DURABLE_EVENT_REDUCER_AND_SOURCE_DISPATCH', 'REVIEWED_ISOLATED_CANDIDATE_EXECUTOR'],
  };
}
export function verifyProposal(proposal, expectedHash, dir = LEDGER) {
  assert(digest(expectedHash) && hash(proposal) === expectedHash, 'proposal anchor mismatch');
  assert(hash(buildProposal(dir, proposal.mission.head)) === expectedHash, 'proposal or live source/state drift');
  return { projectionVerified: true, proposalHash: expectedHash, ledgerHead: proposal.mission.head,
    nativeFieldCallsReserved: proposal.accounting.reserved.nativeFieldCalls,
    sharedEpochsConsumed: proposal.accounting.sharedEpochs.consumed,
    migrationApplied: false, candidateExecutionEnabled: false, boundedRsiEvidenceAccepted: false,
    blockers: proposal.requiredBeforeApplication };
}
export function applyMigration() { throw Error('MIGRATION_APPLICATION_DISABLED: projection is not resource authorization or a durable migration'); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, path, anchor, extra] = process.argv.slice(2);
    if (!path || !anchor || extra) throw Error('usage: migration.mjs propose LEDGER HEAD | verify PROPOSAL PROPOSAL_HASH');
    if (command === 'propose') { const proposal = buildProposal(resolve(path), anchor); console.log(JSON.stringify({ proposal, proposalHash: hash(proposal) }, null, 2)); }
    else if (command === 'verify') { const { proposal } = JSON.parse(readFileSync(resolve(path), 'utf8')); console.log(JSON.stringify(verifyProposal(proposal, anchor), null, 2)); }
    else throw Error('migration application and candidate execution are disabled');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
