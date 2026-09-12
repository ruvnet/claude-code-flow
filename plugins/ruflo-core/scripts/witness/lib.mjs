/**
 * Witness library — shared logic for regenerating, verifying, and
 * querying cryptographically-signed fix manifests with temporal
 * history (ADR-103).
 *
 * Pure functions + small I/O helpers; no project-specific assumptions.
 * CLI wrappers in this directory configure paths and surface output.
 *
 * @module plugins/ruflo-core/scripts/witness/lib
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { platform } from 'node:os';

/**
 * Map Node's `process.platform` value (linux/darwin/win32) to the
 * directory name used under `verification/`. Lets the caller's path
 * default to the right OS subfolder without hardcoding.
 */
export function osDir(p = platform()) {
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  return 'linux'; // linux + anything unknown
}

/**
 * Try to load the binary RVF backend (@ruvector/rvf-node) from the
 * caller's node_modules. Returns the RvfDatabase class or null if the
 * package isn't installed — callers fall back to JSONL.
 */
function loadRvfNode(probeRoots) {
  const expanded = [
    ...probeRoots,
    ...probeRoots.flatMap(r => [
      join(r, 'v3/@claude-flow/cli'),
      join(r, 'v3/@claude-flow/memory'),
    ]),
  ];
  for (const root of expanded) {
    try {
      const req = createRequire(join(root, 'noop.js'));
      const mod = req('@ruvector/rvf-node');
      if (mod && mod.RvfDatabase) return mod.RvfDatabase;
    } catch { /* try next */ }
  }
  return null;
}

// ─── ed25519 lazy load ─────────────────────────────────────────────
// Locate @noble/ed25519 from the caller's project (it lives in their
// node_modules, not bundled with this script). We probe a few likely
// install roots so the toolkit works in ruflo's monorepo layout *and*
// a user's flat node_modules.
function loadEd25519(probeRoots) {
  // Expand caller-supplied roots with workspace-package locations so
  // pnpm's isolated layout (where transitive deps don't hoist to the
  // workspace root) still resolves @noble/ed25519. Callers don't need
  // to know about this — the function just probes more places.
  // WITNESS_ED25519_ROOT is the escape hatch the thrown error below
  // advertises — it must actually be probed, first, or the message lies.
  const envRoot = process.env.WITNESS_ED25519_ROOT;
  const expanded = [
    ...(envRoot ? [envRoot] : []),
    ...probeRoots,
    ...probeRoots.flatMap(r => [
      join(r, 'v3/@claude-flow/cli'),
      join(r, 'v3/@claude-flow/plugin-agent-federation'),
    ]),
  ];
  let lastErr;
  for (const root of expanded) {
    try {
      const req = createRequire(join(root, 'noop.js'));
      const ed = req('@noble/ed25519');
      ed.etc.sha512Sync = (...m) => {
        const h = createHash('sha512');
        for (const x of m) h.update(x);
        return h.digest();
      };
      return ed;
    } catch (e) { lastErr = e; }
  }
  throw new Error(
    "Could not locate '@noble/ed25519'. Install it in your project " +
    "(npm i @noble/ed25519) or pass a node_modules root via the " +
    "WITNESS_ED25519_ROOT env var. Probed: " + expanded.join(', ') +
    ". Last error: " + (lastErr?.message ?? '?')
  );
}

// ─── manifest helpers ─────────────────────────────────────────────
export function fileSha256(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

export function fileContains(absPath, marker) {
  return readFileSync(absPath, 'utf8').includes(marker);
}

export function refreshFix(repoRoot, fix) {
  const abs = join(repoRoot, fix.file);
  if (!existsSync(abs)) {
    return { ...fix, sha256: fix.sha256 ?? '', markerVerified: false, _missing: true };
  }
  const sha256 = fileSha256(abs);
  const markerVerified = fileContains(abs, fix.marker);
  return { id: fix.id, desc: fix.desc, file: fix.file, sha256, marker: fix.marker, markerVerified };
}

// ─── regenerate ───────────────────────────────────────────────────
/**
 * Regenerate a signed witness manifest.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot       Absolute path to the project root.
 * @param {string} opts.manifestPath   Where to write verification.md.json.
 * @param {Array}  opts.newFixes       New fix entries to register.
 * @param {object} [opts.releases]     Map of pkg → version for the manifest.
 * @param {string[]} [opts.ed25519Roots] Probe roots for @noble/ed25519.
 * @returns {{witness: object, summary: string}}
 */
export function regenerate(opts) {
  const { repoRoot, manifestPath, newFixes = [], releases = {}, ed25519Roots = [] } = opts;
  const ed = loadEd25519(ed25519Roots.length ? ed25519Roots : [repoRoot, join(repoRoot, 'v3')]);

  const existing = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const oldFixes = existing?.manifest?.fixes ?? [];
  const oldIds = new Set(oldFixes.map(f => f.id));

  const merged = [
    ...oldFixes.map(f => refreshFix(repoRoot, f)),
    ...newFixes.filter(f => !oldIds.has(f.id)).map(f => refreshFix(repoRoot, f)),
  ];

  const gitCommit = execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim();
  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot }).toString().trim();
  const issuedAt = new Date().toISOString();

  const verifiedCount = merged.filter(f => f.markerVerified).length;
  const missingCount = merged.filter(f => f._missing).length;

  const manifest = {
    schema: existing?.manifest?.schema ?? 'ruflo-witness/v1',
    issuedAt,
    gitCommit,
    branch,
    os: osDir(),
    releases,
    summary: { totalFixes: merged.length, verified: verifiedCount, missing: missingCount },
    fixes: merged.map(f => { const { _missing, ...c } = f; return c; }),
  };

  const manifestCanonical = JSON.stringify(manifest);
  const manifestHash = createHash('sha256').update(manifestCanonical).digest('hex');
  const seed = createHash('sha256').update(gitCommit + ':ruflo-witness/v1').digest();
  const publicKey = ed.getPublicKey(seed);
  const signature = ed.sign(Buffer.from(manifestHash, 'hex'), seed);

  const witness = {
    manifest,
    integrity: {
      manifestHashAlgo: 'sha256',
      manifestHash,
      signatureAlgo: 'ed25519',
      publicKey: Buffer.from(publicKey).toString('hex'),
      signature: Buffer.from(signature).toString('hex'),
      seedDerivation: "sha256(gitCommit + ':ruflo-witness/v1')",
    },
  };

  const newIds = newFixes.filter(f => !oldIds.has(f.id)).map(f => f.id);
  const summary =
    `gitCommit:    ${gitCommit.slice(0,12)}…\n` +
    `branch:       ${branch}\n` +
    `issuedAt:     ${issuedAt}\n` +
    `total fixes:  ${merged.length}  (was ${oldFixes.length})\n` +
    `verified:     ${verifiedCount}\n` +
    `missing:      ${missingCount}\n` +
    `new entries:  ${newIds.join(', ') || '(none)'}\n` +
    `releases:     ${JSON.stringify(releases)}`;

  return { witness, summary, manifest, gitCommit, manifestHash };
}

// ─── temporal history ─────────────────────────────────────────────
/**
 * Append a compact snapshot of `manifest` to a JSONL history file
 * (one entry per line — git-diff-friendly, append-cheap).
 *
 * The history lives inside an RVF-style cognitive container layout
 * (`verification/<os>/history.jsonl`). RVF's binary format optimises
 * for vector similarity search; the witness use case is structured
 * key-value retrieval (snapshot N's commit + fixes), so JSONL is the
 * better format inside the container. The container concept — per-OS
 * folder bundling manifest + history + metadata — is what we adopt
 * from RVF, not the file format itself.
 *
 * @param {string} historyPath  Path to history.jsonl.
 * @param {object} manifest     The manifest object just signed.
 * @param {string} manifestHash The signed hash (for fast lookup).
 */
export function appendHistory(historyPath, manifest, manifestHash) {
  const fixesIndex = {};
  for (const f of manifest.fixes) {
    fixesIndex[f.id] = { sha256: f.sha256, markerVerified: f.markerVerified };
  }
  const entry = {
    v: 1,
    commit: manifest.gitCommit,
    issuedAt: manifest.issuedAt,
    branch: manifest.branch,
    os: manifest.os,
    manifestHash,
    summary: manifest.summary,
    fixes: fixesIndex,
  };
  appendFileSync(historyPath, JSON.stringify(entry) + '\n');
  return entry;
}

/**
 * Load the JSONL history into memory (chronological order).
 */
export function loadHistory(historyPath) {
  if (!existsSync(historyPath)) return [];
  const lines = readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
  return lines.map(l => JSON.parse(l));
}

/**
 * For each fix that is currently `regressed` (markerVerified=false in the
 * latest entry), walk backwards to find the most recent entry where it
 * was `pass` (markerVerified=true). The next entry after that is where
 * the regression was introduced.
 *
 * @returns {Array<{id, lastPassCommit, regressedAtCommit, atIssuedAt}>}
 */
export function findRegressionIntroductions(history) {
  if (history.length === 0) return [];
  const latest = history[history.length - 1];
  const out = [];
  for (const [id, state] of Object.entries(latest.fixes)) {
    if (state.markerVerified) continue;
    let lastPass = null;
    let regressedAt = latest;
    for (let i = history.length - 2; i >= 0; i--) {
      const e = history[i];
      const s = e.fixes[id];
      if (s && s.markerVerified) { lastPass = e; break; }
      regressedAt = e;
    }
    out.push({
      id,
      lastPassCommit: lastPass?.commit ?? null,
      lastPassIssuedAt: lastPass?.issuedAt ?? null,
      regressedAtCommit: regressedAt.commit,
      regressedAtIssuedAt: regressedAt.issuedAt,
    });
  }
  return out;
}

/**
 * Build a status timeline for a single fix across all history entries.
 *
 * @returns {Array<{commit, issuedAt, status}>}
 *   status ∈ { 'pass', 'regressed', 'absent' }
 */
export function fixTimeline(history, fixId) {
  return history.map(e => ({
    commit: e.commit,
    issuedAt: e.issuedAt,
    status: e.fixes[fixId]
      ? (e.fixes[fixId].markerVerified ? 'pass' : 'regressed')
      : 'absent',
  }));
}

/**
 * Compare the latest entry to the previous entry and report transitions.
 *
 * @returns {{newlyRegressed: string[], newlyPassing: string[], added: string[], removed: string[]}}
 */
export function diffLatest(history) {
  if (history.length < 2) return { newlyRegressed: [], newlyPassing: [], added: [], removed: [] };
  const [prev, curr] = [history[history.length - 2], history[history.length - 1]];
  const newlyRegressed = [];
  const newlyPassing = [];
  const added = [];
  const removed = [];
  for (const id of Object.keys(curr.fixes)) {
    if (!(id in prev.fixes)) added.push(id);
    else if (prev.fixes[id].markerVerified && !curr.fixes[id].markerVerified) newlyRegressed.push(id);
    else if (!prev.fixes[id].markerVerified && curr.fixes[id].markerVerified) newlyPassing.push(id);
  }
  for (const id of Object.keys(prev.fixes)) {
    if (!(id in curr.fixes)) removed.push(id);
  }
  return { newlyRegressed, newlyPassing, added, removed };
}
