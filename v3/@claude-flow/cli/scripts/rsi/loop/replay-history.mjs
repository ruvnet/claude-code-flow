#!/usr/bin/env node
/** Recompute every epoch with its Git-preserved evaluator; never relabel a subset as full replay. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { hash, loadLedger } from './ledger.mjs';
import { replayDevelopment } from './run.mjs';

const repo = fileURLToPath(new URL('../../../../../../', import.meta.url));
const prefix = 'v3/@claude-flow/cli/scripts/rsi/loop/';
const anchor = 'c5c6da0b728c52414f2dff86f9d23121776d600defff0f214f1502a091f69088';
const sourceFiles = ['ledger.mjs', 'proof.mjs', 'retrieval.mjs', 'run.mjs', '../../../src/memory/hybrid-retrieval.ts'];
export function replayHistory(dir, expectedHead) {
  const state = loadLedger(dir, expectedHead);
  const events = readdirSync(dir).filter(n => /^\d{8}\.json$/.test(n)).sort()
    .map(name => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
  if (!events.some(e => JSON.parse(e.text).hash === anchor)) throw Error('original mission anchor absent');
  const archives = JSON.parse(readFileSync(new URL('../evidence/loop-sources.json', import.meta.url), 'utf8'));
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repo, encoding: 'utf8' }).trim();
  const covered = [], results = [];
  for (const archive of archives) {
    if (!/^[a-f0-9]{40}$/.test(archive.tree)) throw Error('invalid source tree');
    const end = events.findIndex(e => JSON.parse(e.text).hash === archive.head);
    if (end < 0) throw Error('historical anchor absent');
    // Use the original object database with the snapshot directory as work-tree
    // root. This preserves root-relative ls-tree pathspecs in historical adapters.
    const temp = mkdtempSync(join(repo, '.rsi-replay-'));
    try {
      for (const name of sourceFiles) {
        const path = join(prefix, name), destination = join(temp, path);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, execFileSync('git', ['show', `${archive.tree}:${path}`], { cwd: repo, maxBuffer: 4 * 1024 * 1024 }));
      }
      const ledger = join(temp, 'ledger'); mkdirSync(ledger);
      for (const e of events.slice(0, end + 1)) writeFileSync(join(ledger, e.name), e.text);
      const output = JSON.parse(execFileSync(process.execPath, [join(temp, prefix, 'run.mjs'), archive.command, ledger, archive.head],
        { cwd: temp, env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: temp }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
      const epochs = output.replayedEpochNumbers ?? Array.from({ length: output.replayedEpochs }, (_, i) => i + 1);
      if (!(output.verified || output.sourceSubsetVerified) || hash(epochs) !== hash(archive.epochs) || !output.sourceMatches) throw Error('historical source replay mismatch');
      covered.push(...epochs); results.push({ sourceCommit: archive.commit, sourceTree: archive.tree, anchor: archive.head, replayedEpochNumbers: epochs });
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  const current = replayDevelopment(dir, expectedHead, { sourceOnly: true });
  covered.push(...current.replayedEpochNumbers);
  const expected = state.completed.map(r => r.epoch).sort((a, b) => a - b);
  if (!current.sourceMatches || new Set(covered).size !== covered.length || hash(covered.sort((a, b) => a - b)) !== hash(expected)) throw Error('incomplete or duplicate epoch coverage');
  return { verified: true, originalAnchor: anchor, head: state.head, historical: results,
    currentEpochs: current.replayedEpochNumbers, replayedEpochs: covered.length, lifetimeReservedUnits: state.reservedUnits,
    timingReplayed: false, boundedRsiEvidenceAccepted: state.boundedRsiEvidenceAccepted };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [dir, head, extra] = process.argv.slice(2);
    if (!dir || !/^[a-f0-9]{64}$/.test(head ?? '') || extra) throw Error('usage: replay-history.mjs LEDGER EXPECTED_HEAD');
    console.log(JSON.stringify(replayHistory(resolve(dir), head), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
