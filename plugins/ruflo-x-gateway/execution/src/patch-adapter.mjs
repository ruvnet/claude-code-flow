import { mkdtemp, rm, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { boundedProcess } from './patch-sandbox.mjs';

const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
function policySnapshot(policy) {
  const copy = JSON.parse(JSON.stringify(policy));
  if (!Array.isArray(copy.commands) || !copy.commands.length || copy.commands.length > 20) throw new Error('Trusted test policy required');
  for (const c of copy.commands) if (!Array.isArray(c.argv) || !c.argv.length || c.argv.length > 64 || c.argv.some(x => typeof x !== 'string' || x.length > 4096 || x.includes('\0'))) throw new Error('Invalid policy argv');
  copy.timeoutMs ??= 30_000; copy.maxOutputBytes ??= 65_536;
  if (!Number.isInteger(copy.timeoutMs) || copy.timeoutMs < 1 || copy.timeoutMs > 300_000 || !Number.isInteger(copy.maxOutputBytes) || copy.maxOutputBytes < 1 || copy.maxOutputBytes > 1_048_576) throw new Error('Invalid policy limits');
  return copy;
}
function safePath(path) {
  if (!/^[A-Za-z0-9_./-]+$/.test(path) || isAbsolute(path) || path.split('/').some(x => !x || x === '.' || x === '..' || x.toLowerCase() === '.git' || x.toLowerCase() === '.github')) throw new Error(`Unsafe patch path: ${path}`);
  return path;
}
export function validatePatch(patch, { maxPatchBytes = 8192, maxFiles = 32 } = {}) {
  if (typeof patch !== 'string' || !patch.length || Buffer.byteLength(patch) > maxPatchBytes || patch.includes('\0')) throw new Error('Invalid patch size/content');
  if (/^(?:GIT binary patch|Binary files |(?:old|new|deleted file|new file) mode (?!100644$|100755$)|rename |copy )/m.test(patch)) throw new Error('Unsupported patch type or mode');
  const files = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(line);
      if (!match || safePath(match[1]) !== safePath(match[2])) throw new Error('Unsupported patch paths');
      files.push(match[1]);
    } else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const path = line.slice(4);
      if (path !== '/dev/null') {
        if (!/^[ab]\//.test(path)) throw new Error('Invalid patch header');
        safePath(path.slice(2));
        if (path.slice(2) !== files.at(-1)) throw new Error('Patch header mismatch');
      }
    }
  }
  if (!files.length || files.length > maxFiles || new Set(files).size !== files.length) throw new Error('Invalid patch file count');
  return files.sort();
}

export function createPatchAdapter({ repositories, maxPatchBytes = 8192, maxFiles = 32 }) {
  // Mapping is supplied by the controller, never by task or issue content.
  const sources = new Map(Object.entries(repositories));
  const git = async (cwd, args, input) => {
    const r = await boundedProcess('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', ...args], { cwd, input, maxOutputBytes: 2_097_152 });
    if (r.exitCode !== 0) throw new Error(`git failed: ${r.output.slice(0, 1000)}`);
    return r.output;
  };
  async function checkout(repository, baseSha, fn) {
    if (!sources.has(repository) || !/^[0-9a-f]{40}$/.test(baseSha)) throw new Error('Repository allowlist or pinned SHA required');
    const source = sources.get(repository);
    // Local credential-free mirrors only. Fetch and credentials belong to controller.
    if (typeof source !== 'string' || !isAbsolute(source)) throw new Error('Trusted local repository mirror required');
    const dir = await mkdtemp(join(tmpdir(), 'ruflo-patch-'));
    try {
      await git(dir, ['init', '--quiet']);
      await git(dir, ['fetch', '--no-tags', '--depth=1', '--', source, baseSha]);
      await git(dir, ['checkout', '--detach', baseSha]);
      const tree = await git(dir, ['ls-tree', '-r', baseSha]);
      // Reject symlinks and submodules throughout checkout before any runner sees it.
      if (tree.split('\n').some(line => line && !/^100(?:644|755) blob /.test(line))) throw new Error('Unsupported repository object mode');
      return await fn(dir);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async function apply(dir, patch) {
    const files = validatePatch(patch, { maxPatchBytes, maxFiles });
    await git(dir, ['apply', '--check', '--index', '-'], patch);
    await git(dir, ['apply', '--index', '-'], patch);
    const changed = (await git(dir, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean).sort();
    if (JSON.stringify(changed) !== JSON.stringify(files)) throw new Error('Patch file manifest mismatch');
    const hashes = {};
    for (const file of files) {
      try { if (!(await lstat(join(dir, file))).isFile()) throw new Error('Not a regular file'); hashes[file] = digest(await readFile(join(dir, file))); }
      catch (error) { if (error.code === 'ENOENT') hashes[file] = null; else throw error; }
    }
    return { files, hashes, tree: (await git(dir, ['write-tree'])).trim() };
  }
  async function run(sandbox, dir, policy) {
    if (!sandbox || typeof sandbox.run !== 'function') throw new Error('Trusted sandbox required');
    const evidence = await sandbox.run({ cwd: dir, policy: structuredClone(policy) });
    if (!Array.isArray(evidence?.results) || evidence.results.length !== policy.commands.length || evidence.results.some(result => result.exitCode !== 0)) throw new Error('Sandbox evidence incomplete or failed');
    return evidence;
  }
  return {
    async proposePatch({ repository, baseSha, issue, policy, propose, sandbox }) {
      const trustedPolicy = policySnapshot(policy);
      if (!sources.has(repository) || !/^[0-9a-f]{40}$/.test(baseSha)) throw new Error('Repository allowlist or pinned SHA required');
      if (typeof issue !== 'object' || issue === null || typeof issue.reference !== 'string' || typeof issue.text !== 'string' || Buffer.byteLength(JSON.stringify(issue)) > 65_536 || typeof propose !== 'function') throw new Error('Bounded issue and trusted proposer required');
      const issueData = Object.freeze({ reference: issue.reference, text: issue.text }), issueDigest = digest(issueData);
      // Proposer gets data, never a shell or credentials. It is controller injected.
      const patch = await propose(Object.freeze({ repository, baseSha, issue: issueData }));
      return checkout(repository, baseSha, async dir => {
        const manifest = await apply(dir, patch);
        const tests = await run(sandbox, dir, trustedPolicy);
        const artifact = { version: 1, repository, baseSha, issueReference: issueData.reference, issueDigest, policyDigest: digest(trustedPolicy), patch, patchDigest: digest(patch), ...manifest, tests };
        if (Buffer.byteLength(JSON.stringify(artifact)) > 12_000) throw new Error('Artifact exceeds remote transport budget');
        return artifact;
      });
    },
    async verifyPatch({ artifact, expected, policy, sandbox }) {
      const snapshot = structuredClone(artifact), trustedPolicy = policySnapshot(policy);
      if (!expected || ['repository', 'baseSha', 'issueReference', 'issueDigest'].some(field => typeof expected[field] !== 'string' || snapshot[field] !== expected[field])) throw new Error('Artifact does not match trusted expected task');
      if (Buffer.byteLength(JSON.stringify(snapshot)) > 12_000) throw new Error('Artifact exceeds remote transport budget');
      if (snapshot.version !== 1 || snapshot.patchDigest !== digest(snapshot.patch) || snapshot.policyDigest !== digest(trustedPolicy)) throw new Error('Artifact or policy digest mismatch');
      return checkout(snapshot.repository, snapshot.baseSha, async dir => {
        const manifest = await apply(dir, snapshot.patch);
        for (const field of ['files', 'hashes', 'tree']) if (JSON.stringify(manifest[field]) !== JSON.stringify(snapshot[field])) throw new Error(`Artifact ${field} mismatch`);
        const tests = await run(sandbox, dir, trustedPolicy);
        return { verified: true, artifactDigest: digest(snapshot), repository: snapshot.repository, baseSha: snapshot.baseSha, tree: manifest.tree, policyDigest: snapshot.policyDigest, tests };
      });
    },
  };
}
