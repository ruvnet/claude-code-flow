#!/usr/bin/env node
/** Explicit bounded local execution. No daemon, provider credential, network, merge or deployment. */
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { hash, initLedger, loadLedger, append, summary, reserveProof, recoverWriter } from './ledger.mjs';
import { sourceIdentity, loadCorpus, makeReservation, runReserved } from './retrieval.mjs';
const json = path => { if (statSync(path).size > 4 * 1024 * 1024) throw Error('input too large'); return JSON.parse(readFileSync(path, 'utf8')); };

export function step(dir, { reserveOnly = false } = {}) {
  let s = loadLedger(dir);
  if (s.pending) throw Error('interrupted epoch requires explicit recover; reservation is never refunded');
  if (s.status !== 'DEVELOPMENT') return summary(s);
  if (hash(sourceIdentity()) !== hash(s.source)) throw Error('source drift requires hypothesis event; lifetime counters remain');
  const corpus = loadCorpus();
  s = append(dir, 'RESERVE', makeReservation(s, corpus), s.head);
  if (reserveOnly) return summary(s);
  // Failure leaves the reserved epoch pending. A later process cannot silently retry it for free.
  const receipt = runReserved(s, corpus);
  return summary(append(dir, 'COMPLETE', { epoch: s.pending.epoch, receipt }, s.head));
}
export function recover(dir, expectedHead) {
  const s = loadLedger(dir, expectedHead);
  if (!s.pending) throw Error('no pending epoch');
  return summary(append(dir, 'INTERRUPTED', { epoch: s.pending.epoch, reason: 'operator acknowledged abandoned attempt; full reservation retained' }, s.head));
}
export function replayDevelopment(dir, expectedHead, { sourceOnly = false } = {}) {
  const s = loadLedger(dir, expectedHead), sourceHash = hash(sourceIdentity()), corpus = loadCorpus();
  let credits = [1, 1, 1]; const completed = [], replayed = [], skipped = [];
  for (const receipt of s.completed) {
    if (receipt.sourceHash !== sourceHash) {
      if (!sourceOnly) throw Error('replay requires the source snapshot of each historical epoch');
      skipped.push(receipt.epoch);
    } else {
      const pending = s.attempts.find(a => a.epoch === receipt.epoch);
      const actual = runReserved({ pending, champion: receipt.beforePolicy, credits, completed,
        epochs: receipt.epoch - 1, source: sourceIdentity(), snapshots: s.snapshots.filter(n => n.epoch < receipt.epoch) }, corpus);
      const stable = r => { const { elapsedMs, cpuMicros, ...rest } = r; return rest; };
      if (hash(stable(actual)) !== hash(stable(receipt))) throw Error('development recomputation mismatch');
      replayed.push(receipt.epoch);
    }
    credits = receipt.credits; completed.push(receipt);
  }
  if (sourceOnly && replayed.length === 0) throw Error('no epochs match this source');
  return { verified: skipped.length === 0, sourceSubsetVerified: true, replayedEpochs: replayed.length,
    replayedEpochNumbers: replayed, skippedHistoricalEpochs: skipped, ...summary(s), timingReplayed: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, dir, arg, extra] = process.argv.slice(2);
    if (!dir || extra) throw Error('usage: run.mjs init DIR MISSION | run DIR [1..8] | status DIR | verify DIR HEAD | recover DIR HEAD | hypothesis DIR REASON | reserve-proof DIR MANIFEST | confirm DIR PACKETS');
    let result;
    if (command === 'init' && arg) result = summary(initLedger(dir, arg, sourceIdentity()));
    else if (command === 'init-trusted' && arg) {
      const config = json(arg); result = summary(initLedger(dir, config.mission, sourceIdentity(), config.trust));
    }
    else if (command === 'run') {
      const count = Number(arg ?? 1);
      if (!Number.isInteger(count) || count < 1 || count > 8) throw Error('batch bound is 1..8');
      for (let i = 0; i < count; i++) { result = step(dir); if (result.status !== 'DEVELOPMENT') break; }
    } else if (command === 'status' && !arg) result = summary(loadLedger(dir));
    else if (command === 'verify' && arg) {
      const view = summary(loadLedger(dir, arg));
      if (!view.sourceMatches) throw Error('verification source drift');
      result = { verified: true, ...view };
    }
    else if (command === 'replay' && arg) result = replayDevelopment(dir, arg);
    else if (command === 'replay-source' && arg) result = replayDevelopment(dir, arg, { sourceOnly: true });
    else if (command === 'recover' && arg) result = recover(dir, arg);
    else if (command === 'recover-writer' && arg) result = summary(recoverWriter(dir, arg));
    else if (command === 'hypothesis' && arg) {
      const s = loadLedger(dir); result = summary(append(dir, 'HYPOTHESIS', { reason: arg, source: sourceIdentity() }, s.head));
    } else if (command === 'reserve-proof' && arg) result = summary(reserveProof(dir, json(arg)));
    else if (command === 'confirm' && arg) {
      const s = loadLedger(dir);
      if (!s.confirmation) throw Error('reserve and publish proof manifest before reading outcomes');
      if (hash(sourceIdentity()) !== hash(s.source)) throw Error('confirmation source drift');
      const next = append(dir, 'PROOF_RESULT', { testIndex: s.proofIndex, packets: json(arg) }, s.head);
      result = { ...summary(next), verdict: next.lastProof.verdict };
    } else throw Error('invalid command');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
