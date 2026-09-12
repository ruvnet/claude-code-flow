#!/usr/bin/env node
/** Durable, append-only v2 migration journal and replay-only source dispatcher. */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, loadLedger } from '../loop/ledger.mjs';
import { LEDGER } from './admission.mjs';
import { projectState, verifyProjection, verifyProposal } from './migration.mjs';

export const JOURNAL_SCHEMA = 'ruflo.repair-migration-journal/v2';
export const EVENT_SCHEMA = 'ruflo.repair-migration-event/v2';
const digestPattern = /^[a-f0-9]{64}$/;
const recoveryCapability = Symbol('journal recovery capability');
const assert = (ok, why) => { if (!ok) throw Error(why); };
const digest = value => typeof value === 'string' && digestPattern.test(value);
const exactKeys = (value, keys, why) => assert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','), why);

function epochSourceHashes(state) {
  const values = new Map();
  for (const attempt of state.attempts) {
    assert(Number.isSafeInteger(attempt.epoch) && digest(attempt.sourceHash), 'legacy source identity');
    values.set(attempt.epoch, attempt.sourceHash);
  }
  return values;
}

/**
 * Build an immutable replay registry from the charged v1 history. This registry
 * authorizes historical verification only. It cannot dispatch candidates.
 */
export function buildSourceRegistry(state, archivePath = new URL('../evidence/migration-source-registry.json', import.meta.url)) {
  const byEpoch = epochSourceHashes(state);
  const archives = JSON.parse(readFileSync(archivePath, 'utf8'));
  assert(Array.isArray(archives), 'source archive registry');
  const covered = new Set(), entries = [];
  for (const item of archives) {
    exactKeys(item, ['commit', 'tree', 'head', 'epochs'], 'archived source fields');
    assert(/^[a-f0-9]{40}$/.test(item.commit) && /^[a-f0-9]{40}$/.test(item.tree) && digest(item.head), 'archived source identity');
    assert(Array.isArray(item.epochs) && item.epochs.length > 0, 'archived source dispatch');
    const sourceHashes = new Set(item.epochs.map(epoch => {
      assert(Number.isSafeInteger(epoch) && byEpoch.has(epoch) && !covered.has(epoch), 'archived epoch coverage');
      covered.add(epoch); return byEpoch.get(epoch);
    }));
    assert(sourceHashes.size === 1, 'archive spans multiple source snapshots');
    entries.push({ adapter: 'git-tree-replay/v1', epochs: [...item.epochs], sourceHash: [...sourceHashes][0], commit: item.commit, tree: item.tree, anchoredHead: item.head });
  }
  assert(covered.size === state.epochs && [...byEpoch.keys()].every(epoch => covered.has(epoch)), 'every charged epoch needs one immutable source');
  return { schema: 'ruflo.replay-source-registry/v1', executionClass: 'HISTORICAL_REPLAY_ONLY', candidateExecutionEnabled: false, entries };
}

function validateSourceRegistry(registry, state) {
  exactKeys(registry, ['schema', 'executionClass', 'candidateExecutionEnabled', 'entries'], 'source registry fields');
  assert(registry.schema === 'ruflo.replay-source-registry/v1' && registry.executionClass === 'HISTORICAL_REPLAY_ONLY' && registry.candidateExecutionEnabled === false, 'replay-only registry required');
  const byEpoch = epochSourceHashes(state), covered = new Set();
  assert(Array.isArray(registry.entries) && registry.entries.length > 0, 'source registry entries');
  for (const entry of registry.entries) {
    exactKeys(entry, ['adapter', 'epochs', 'sourceHash', 'commit', 'tree', 'anchoredHead'], 'source registry entry fields');
    assert(entry.adapter === 'git-tree-replay/v1' && /^[a-f0-9]{40}$/.test(entry.commit) && /^[a-f0-9]{40}$/.test(entry.tree) && digest(entry.anchoredHead), 'immutable source identity');
    assert(digest(entry.sourceHash) && Array.isArray(entry.epochs) && entry.epochs.length > 0, 'source entry dispatch');
    for (const epoch of entry.epochs) {
      assert(Number.isSafeInteger(epoch) && !covered.has(epoch) && byEpoch.get(epoch) === entry.sourceHash, 'source epoch binding');
      covered.add(epoch);
    }
  }
  assert(covered.size === state.epochs && [...byEpoch.keys()].every(epoch => covered.has(epoch)), 'source registry coverage');
  return true;
}

function verifyLedgerPrefix(dir, entry) {
  const files = readdirSync(dir).filter(name => /^\d{8}\.json$/.test(name)).sort();
  const reservations = new Map(), settled = new Set();
  let parent = null, found = false;
  for (let index = 0; index < files.length; index++) {
    assert(files[index] === `${String(index).padStart(8, '0')}.json`, 'legacy ledger gap');
    const event = JSON.parse(readFileSync(join(dir, files[index]), 'utf8')), { hash: recorded, ...body } = event;
    assert(event.index === index && event.parent === parent && hash(body) === recorded, 'legacy ledger prefix chain mismatch');
    if (event.type === 'RESERVE') reservations.set(event.payload.epoch, event.payload.sourceHash);
    if (['COMPLETE', 'INTERRUPTED'].includes(event.type)) settled.add(event.payload.epoch);
    parent = event.hash;
    if (parent === entry.anchoredHead) { found = true; break; }
  }
  assert(found, 'historical source anchor absent');
  const maxSettled = Math.max(...settled);
  assert(maxSettled === Math.max(...entry.epochs), 'historical source anchor covers wrong epoch boundary');
  for (const epoch of entry.epochs) assert(settled.has(epoch) && reservations.get(epoch) === entry.sourceHash, 'historical source prefix binding');
}

/** Resolve and verify an epoch's content-addressed historical source. */
export function dispatchReplay(registry, epoch, repository = resolve(new URL('../../../../../..', import.meta.url).pathname), legacyDir = LEDGER) {
  assert(registry?.schema === 'ruflo.replay-source-registry/v1' && registry.executionClass === 'HISTORICAL_REPLAY_ONLY' && registry.candidateExecutionEnabled === false, 'replay-only registry required');
  assert(Number.isSafeInteger(epoch) && epoch > 0, 'epoch required');
  const matches = registry.entries.filter(entry => entry.epochs.includes(epoch));
  assert(matches.length === 1, 'epoch source dispatch must be unique');
  const entry = structuredClone(matches[0]);
  if (entry.adapter !== 'git-tree-replay/v1') throw Error('untrusted source adapter');
  const kind = execFileSync('git', ['cat-file', '-t', entry.tree], { cwd: repository, encoding: 'utf8', timeout: 5000 }).trim();
  assert(kind === 'tree', 'archived Git tree unavailable');
  const prefix = 'v3/@claude-flow/cli/scripts/rsi/loop/';
  const names = ['ledger.mjs', 'proof.mjs', 'retrieval.mjs', 'run.mjs', '../../../src/memory/hybrid-retrieval.ts'];
  const source = Object.fromEntries(names.map(name => {
    const body = execFileSync('git', ['show', `${entry.tree}:${posix.normalize(prefix + name)}`], { cwd: repository, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    return [name, hash(body)];
  }));
  assert(hash(source) === entry.sourceHash, 'archived tree source closure mismatch');
  verifyLedgerPrefix(legacyDir, entry);
  let commitObjectVerified = false;
  try {
    const commitTree = execFileSync('git', ['rev-parse', `${entry.commit}^{tree}`], { cwd: repository, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    assert(commitTree === entry.tree, 'commit and tree mismatch'); commitObjectVerified = true;
  } catch (error) {
    if (error.message === 'commit and tree mismatch') throw error;
    // Historical public commit aliases are not guaranteed to exist in shallow
    // checkouts. The content-addressed tree and exact source closure still must.
  }
  return { schema: 'ruflo.replay-source-dispatch/v1', epoch, sourceHash: entry.sourceHash, adapter: entry.adapter, sourceIdentityHash: hash(entry), operation: 'HISTORICAL_REPLAY_ONLY', treeObjectVerified: true, sourceClosureVerified: true, ledgerPrefixVerified: true, commitObjectVerified, candidateExecutionEnabled: false };
}

function initial() {
  return { schema: JOURNAL_SCHEMA, head: null, events: 0, migrationApplied: false, candidateExecutionEnabled: false, boundedRsiEvidenceAccepted: false, projection: null, proposalHash: null, sourceRegistry: null, verifiedSources: [], recoveries: [] };
}

function reduce(state, event, expectedProposalHash) {
  assert(event.schema === EVENT_SCHEMA, 'event schema');
  const payload = event.payload;
  if (event.type === 'MIGRATION_PROJECTED') {
    assert(state.events === 0 && digest(expectedProposalHash), 'projected migration genesis');
    exactKeys(payload, ['proposal', 'proposalHash', 'legacyHead', 'legacyStateHash', 'projectedStateHash', 'projection', 'sourceRegistry', 'sourceRegistryHash', 'migrationApplied', 'candidateExecutionEnabled'], 'migration event fields');
    assert(payload.proposalHash === expectedProposalHash && hash(payload.proposal) === expectedProposalHash && digest(payload.legacyHead), 'migration proposal binding');
    assert(hash(payload.projection.legacy) === payload.legacyStateHash && hash(payload.projection) === payload.projectedStateHash, 'projected state hashes');
    verifyProjection(payload.projection.legacy, payload.projection);
    assert(payload.proposal.mission.head === payload.legacyHead && payload.proposal.legacyStateHash === payload.legacyStateHash && payload.proposal.projectedStateHash === payload.projectedStateHash, 'frozen proposal state binding');
    assert(hash(payload.proposal.accounting) === hash(payload.projection.accounting) && hash(payload.proposal.policy) === hash(payload.projection.policy), 'frozen proposal accounting or policy binding');
    assert(hash(payload.sourceRegistry) === payload.sourceRegistryHash && payload.sourceRegistry.candidateExecutionEnabled === false, 'source registry binding');
    validateSourceRegistry(payload.sourceRegistry, payload.projection.legacy);
    assert(payload.migrationApplied === false && payload.candidateExecutionEnabled === false, 'projection cannot enable execution');
    assert(payload.projection.legacy.head === payload.legacyHead, 'legacy head binding');
    state.projection = structuredClone(payload.projection); state.proposalHash = payload.proposalHash; state.sourceRegistry = structuredClone(payload.sourceRegistry);
  } else {
    assert(state.projection, 'missing migration projection');
    if (event.type === 'SOURCE_VERIFIED') {
      exactKeys(payload, ['dispatch'], 'source verification fields');
      const receipt = payload.dispatch;
      exactKeys(receipt, ['schema', 'epoch', 'sourceHash', 'adapter', 'sourceIdentityHash', 'operation', 'treeObjectVerified', 'sourceClosureVerified', 'ledgerPrefixVerified', 'commitObjectVerified', 'candidateExecutionEnabled'], 'source dispatch receipt fields');
      assert(receipt?.schema === 'ruflo.replay-source-dispatch/v1' && receipt.operation === 'HISTORICAL_REPLAY_ONLY' && receipt.treeObjectVerified === true && receipt.sourceClosureVerified === true && receipt.ledgerPrefixVerified === true && typeof receipt.commitObjectVerified === 'boolean' && receipt.candidateExecutionEnabled === false, 'replay-only source receipt');
      const matches = state.sourceRegistry.entries.filter(entry => entry.epochs.includes(receipt.epoch));
      assert(matches.length === 1 && receipt.sourceHash === matches[0].sourceHash && receipt.sourceIdentityHash === hash(matches[0]) && receipt.adapter === matches[0].adapter, 'source receipt binding');
      assert(!state.verifiedSources.some(item => item.epoch === receipt.epoch), 'source epoch already verified');
      state.verifiedSources.push(structuredClone(receipt));
    } else if (event.type === 'WRITER_RECOVERED') {
      exactKeys(payload, ['ownerPid', 'abandonedHash'], 'writer recovery fields');
      assert(Number.isSafeInteger(payload.ownerPid) && payload.ownerPid > 0 && (payload.abandonedHash === null || digest(payload.abandonedHash)), 'writer recovery audit');
      state.recoveries.push(structuredClone(payload));
    } else throw Error('unsupported v2 event: migration application and resource execution remain disabled');
  }
  state.events++; state.head = event.hash;
  return state;
}

export function loadJournal(dir, expectedHead, expectedProposalHash) {
  const files = readdirSync(dir).filter(name => /^\d{8}\.json$/.test(name)).sort();
  assert(files.length > 0 && files.length < 10000, 'journal length');
  const state = initial();
  files.forEach((name, index) => {
    assert(name === `${String(index).padStart(8, '0')}.json`, 'journal gap');
    const path = join(dir, name); assert(statSync(path).size <= 16 * 1024 * 1024, 'event too large');
    const event = JSON.parse(readFileSync(path, 'utf8'));
    exactKeys(event, ['schema', 'index', 'parent', 'type', 'payload', 'hash'], 'event fields');
    const { hash: recorded, ...body } = event;
    assert(event.index === index && event.parent === state.head && hash(body) === recorded, 'journal chain mismatch');
    reduce(state, event, expectedProposalHash);
  });
  if (expectedHead !== undefined) assert(state.head === expectedHead, 'anchored journal head mismatch');
  assert(state.proposalHash === expectedProposalHash, 'journal proposal anchor mismatch');
  return state;
}

function appendJournal(dir, type, payload, expectedHead, expectedProposalHash, hooks = {}, capability = null) {
  const recoveryOwned = capability === recoveryCapability;
  const lock = join(dir, '.writer-lock');
  let lockFd = null;
  if (recoveryOwned) {
    assert(existsSync(lock) && existsSync(join(dir, '.recovery-lock')), 'recovery locks required');
  } else {
    assert(!existsSync(join(dir, '.recovery-lock')), 'recovery in progress');
    lockFd = openSync(lock, 'wx', 0o600);
  }
  let pendingCreated = false, published = false;
  try {
    if (!recoveryOwned) {
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, host: hostname(), expectedHead, expectedProposalHash })); fsyncSync(lockFd);
    }
    const names = readdirSync(dir).filter(name => /^\d{8}\.json$/.test(name));
    const state = names.length ? loadJournal(dir, expectedHead, expectedProposalHash) : initial();
    assert(state.head === expectedHead, 'concurrent journal change');
    const body = { schema: EVENT_SCHEMA, index: state.events, parent: state.head, type, payload };
    const event = { ...body, hash: hash(body) }; reduce(state, event, expectedProposalHash);
    const name = `${String(body.index).padStart(8, '0')}.json`, pending = join(dir, `${name}.pending`);
    const fd = openSync(pending, 'wx', 0o600); pendingCreated = true;
    try { writeFileSync(fd, `${JSON.stringify(event)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    hooks.beforePublish?.(); renameSync(pending, join(dir, name));
    const dfd = openSync(dir, 'r'); try { fsyncSync(dfd); } finally { closeSync(dfd); }
    published = true;
    hooks.afterPublish?.(); return state;
  } finally {
    if (lockFd !== null) closeSync(lockFd);
    if (!recoveryOwned && existsSync(lock) && (!pendingCreated || published)) unlinkSync(lock);
  }
}

export function createProjectedJournal(dir, proposalFile, expectedProposalHash, legacyDir = LEDGER, hooks = {}) {
  assert(!existsSync(dir), 'journal target must be new');
  const payload = buildGenesisPayload(proposalFile, expectedProposalHash, legacyDir);
  mkdirSync(dir, { recursive: false, mode: 0o700 });
  return appendJournal(dir, 'MIGRATION_PROJECTED', payload, null, expectedProposalHash, hooks);
}

function buildGenesisPayload(proposalFile, expectedProposalHash, legacyDir) {
  const artifact = JSON.parse(readFileSync(proposalFile, 'utf8'));
  assert(artifact.proposalHash === expectedProposalHash, 'frozen proposal artifact hash');
  verifyProposal(artifact.proposal, expectedProposalHash, legacyDir);
  const legacy = loadLedger(legacyDir, artifact.proposal.mission.head), projection = projectState(legacy);
  const registry = buildSourceRegistry(legacy);
  return {
    proposal: artifact.proposal,
    proposalHash: expectedProposalHash, legacyHead: legacy.head,
    legacyStateHash: hash(legacy), projectedStateHash: hash(projection), projection,
    sourceRegistry: registry, sourceRegistryHash: hash(registry),
    migrationApplied: false, candidateExecutionEnabled: false,
  };
}

export function verifyAndRecordSource(dir, epoch, expectedHead, expectedProposalHash, repository, legacyDir = LEDGER, hooks = {}) {
  const state = loadJournal(dir, expectedHead, expectedProposalHash);
  const dispatch = dispatchReplay(state.sourceRegistry, epoch, repository, legacyDir);
  return appendJournal(dir, 'SOURCE_VERIFIED', { dispatch }, state.head, expectedProposalHash, hooks);
}

/** Explicit, anchored, same-host recovery. No stale-time auto recovery exists. */
export function recoverJournal(dir, expectedHead, expectedProposalHash, options = {}) {
  const recovery = join(dir, '.recovery-lock'), recoveryFd = openSync(recovery, 'wx', 0o600);
  try {
    const lock = join(dir, '.writer-lock'), owner = JSON.parse(readFileSync(lock, 'utf8'));
    assert(owner.host === hostname() && owner.expectedHead === expectedHead && owner.expectedProposalHash === expectedProposalHash, 'writer ownership or anchor cannot be established');
    let dead = false;
    try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') dead = true; else throw error; }
    assert(dead, 'writer may still be alive; recovery refused');
    const committed = readdirSync(dir).filter(name => /^\d{8}\.json$/.test(name));
    const state = committed.length ? loadJournal(dir, undefined, expectedProposalHash) : initial();
    assert(state.head === expectedHead || expectedHead !== null && state.head !== null, 'recovery journal anchor');
    if (state.head !== expectedHead) {
      const files = readdirSync(dir).filter(name => /^\d{8}\.json$/.test(name)).sort();
      const last = JSON.parse(readFileSync(join(dir, files.at(-1)), 'utf8'));
      assert(last.parent === expectedHead && last.hash === state.head, 'recovery observed more than one published child');
    }
    const pending = readdirSync(dir).filter(name => /^\d{8}\.json\.pending$/.test(name));
    assert(pending.length <= 1, 'ambiguous interrupted writes');
    assert(!(state.head !== expectedHead && pending.length), 'published child plus pending publication is ambiguous');
    let abandonedHash = null;
    if (pending.length) {
      const path = join(dir, pending[0]);
      if (expectedHead === null) {
        assert(options.proposalFile, 'genesis recovery requires frozen proposal artifact');
        const event = JSON.parse(readFileSync(path, 'utf8')), { hash: recorded, ...body } = event;
        exactKeys(event, ['schema', 'index', 'parent', 'type', 'payload', 'hash'], 'pending genesis event fields');
        assert(event.index === 0 && event.parent === null && event.type === 'MIGRATION_PROJECTED' && hash(body) === recorded, 'pending genesis event invalid');
        const expectedPayload = buildGenesisPayload(options.proposalFile, expectedProposalHash, options.legacyDir ?? LEDGER);
        assert(hash(event.payload) === hash(expectedPayload), 'pending genesis differs from frozen proposal');
      }
      abandonedHash = hash(readFileSync(path, 'utf8'));
      renameSync(path, join(dir, `abandoned-${abandonedHash}.json`));
    }
    options.afterQuarantine?.();
    let observed = state;
    if (expectedHead === null) {
      const payload = buildGenesisPayload(options.proposalFile, expectedProposalHash, options.legacyDir ?? LEDGER);
      observed = appendJournal(dir, 'MIGRATION_PROJECTED', payload, null, expectedProposalHash, {}, recoveryCapability);
    }
    const result = appendJournal(dir, 'WRITER_RECOVERED', { ownerPid: owner.pid, abandonedHash }, observed.head, expectedProposalHash, {}, recoveryCapability);
    unlinkSync(lock);
    return result;
  } finally { closeSync(recoveryFd); if (existsSync(recovery)) unlinkSync(recovery); }
}

export function applyMigration() { throw Error('MIGRATION_APPLICATION_DISABLED: this journal is a reviewable projection, not authorization'); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, path, anchor, extra] = process.argv.slice(2);
    if (command !== 'verify' || !path || !anchor || extra) throw Error('usage: journal-v2.mjs verify JOURNAL PROPOSAL_HASH');
    const state = loadJournal(resolve(path), undefined, anchor);
    console.log(JSON.stringify({ journalVerified: true, head: state.head, events: state.events, legacyHead: state.projection.legacy.head, nativeFieldCallsReserved: state.projection.accounting.reserved.nativeFieldCalls, sharedEpochsConsumed: state.projection.accounting.sharedEpochs.consumed, verifiedSourceEpochs: state.verifiedSources.map(item => item.epoch), migrationApplied: false, candidateExecutionEnabled: false, boundedRsiEvidenceAccepted: false }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
