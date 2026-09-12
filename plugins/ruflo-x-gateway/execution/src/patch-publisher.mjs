import { createHash } from 'node:crypto';
import { validatePatch } from './patch-adapter.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');

/** Controller-only publication. Files are full resulting UTF-8 contents, never commands. */
export function createPatchPublisher({ repositories, verifyPatch, github }) {
  const allowed = new Map(Object.entries(repositories).map(([key, value]) => [key, structuredClone(value)]));
  if (typeof verifyPatch !== 'function') throw new Error('Independent verifier required');
  return { async publishVerifiedPatch({ artifact, expected, policy, sandbox, files, title, body = '' }) {
    artifact = structuredClone(artifact); files = structuredClone(files);
    const config = allowed.get(artifact.repository);
    if (!config || artifact.baseSha !== config.baseSha || !/^[0-9a-f]{40}$/.test(config.baseSha) || !/^[A-Za-z0-9_./-]+$/.test(config.baseBranch) || config.baseBranch.includes('..')) throw new Error('Publication repository/base denied');
    if (typeof title !== 'string' || title.length < 1 || title.length > 200 || typeof body !== 'string' || body.length > 60_000) throw new Error('Invalid PR text');
    const paths = validatePatch(artifact.patch);
    if (!files || JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(paths)) throw new Error('Publication file manifest mismatch');
    let bytes = 0;
    for (const path of paths) {
      const file = files[path];
      if (file === null) { if (artifact.hashes[path] !== null) throw new Error('Invalid file deletion'); continue; }
      if (typeof file?.content !== 'string' || !['100644', '100755'].includes(file.mode) || hash(file.content) !== artifact.hashes[path]) throw new Error('Publication content mismatch');
      bytes += Buffer.byteLength(file.content);
    }
    if (bytes > 2_097_152) throw new Error('Publication contents too large');
    const evidence = await verifyPatch({ artifact, expected, policy, sandbox });
    if (evidence.verified !== true || evidence.artifactDigest !== hash(JSON.stringify(artifact)) || evidence.tree !== artifact.tree || evidence.baseSha !== artifact.baseSha || evidence.repository !== artifact.repository) throw new Error('Independent verification rejected publication');
    const repository = artifact.repository, branch = `federation/patch-${evidence.artifactDigest}`;
    const base = await github.getRef(repository, config.baseBranch);
    if (base !== config.baseSha) throw new Error('Base branch advanced; regenerate and verify');
    const entries = [];
    for (const path of paths) {
      const file = files[path];
      entries.push(file === null ? { path, mode: '100644', type: 'blob', sha: null } : { path, mode: file.mode, type: 'blob', sha: await github.createBlob(repository, file.content) });
    }
    const baseCommit = await github.getCommit(repository, config.baseSha);
    const tree = await github.createTree(repository, baseCommit.tree, entries);
    if (tree !== evidence.tree) throw new Error('Published tree does not match verified tree');
    let commit = await github.getRef(repository, branch);
    const message = `Federation verified patch ${evidence.artifactDigest}`;
    if (commit) {
      const existing = await github.getCommit(repository, commit);
      if (existing.tree !== tree || JSON.stringify(existing.parents) !== JSON.stringify([config.baseSha]) || existing.message !== message) throw new Error('Existing publication branch conflicts');
    } else {
      commit = await github.createCommit(repository, { tree, parents: [config.baseSha], message });
      try { await github.createRef(repository, branch, commit); }
      catch (error) {
        // A concurrent publisher may have won. Never overwrite an existing ref.
        const winner = await github.getRef(repository, branch);
        if (!winner) throw error;
        const existing = await github.getCommit(repository, winner);
        if (existing.tree !== tree || JSON.stringify(existing.parents) !== JSON.stringify([config.baseSha]) || existing.message !== message) throw new Error('Concurrent publication branch conflicts');
        commit = winner;
      }
    }
    const existingPR = await github.findPullRequest(repository, branch, config.baseBranch);
    if (existingPR) return { ...existingPR, branch, commit, evidence, reused: true };
    const receipt = `\n\nVerified artifact: ${evidence.artifactDigest}\nBase: ${config.baseSha}\nTree: ${tree}\nPolicy: ${artifact.policyDigest}`;
    let pr;
    try { pr = await github.createPullRequest(repository, { title, body: body + receipt, head: branch, base: config.baseBranch, draft: true }); }
    catch (error) { pr = await github.findPullRequest(repository, branch, config.baseBranch); if (!pr) throw error; }
    return { ...pr, branch, commit, evidence, reused: false };
  } };
}

/** Construct only in the privileged controller; never pass this object to workers. */
export function createGitHubRestClient({ token = process.env.GITHUB_TOKEN, fetchImpl = globalThis.fetch } = {}) {
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error('Controller GitHub token required');
  const repoPath = repository => { if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid repository'); return `/repos/${repository}`; };
  async function request(path, { method = 'GET', data, missing = false } = {}) {
    const response = await fetchImpl(`https://api.github.com${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' }, ...(data ? { body: JSON.stringify(data) } : {}) });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API ${method} failed (${response.status})`);
    return response.json();
  }
  return {
    async getRef(repo, branch) { return (await request(`${repoPath(repo)}/git/ref/heads/${encodeURIComponent(branch)}`, { missing: true }))?.object.sha ?? null; },
    async getCommit(repo, sha) { const r = await request(`${repoPath(repo)}/git/commits/${encodeURIComponent(sha)}`); return { tree: r.tree.sha, parents: r.parents.map(p => p.sha), message: r.message }; },
    async createBlob(repo, content) { return (await request(`${repoPath(repo)}/git/blobs`, { method: 'POST', data: { content: Buffer.from(content).toString('base64'), encoding: 'base64' } })).sha; },
    async createTree(repo, baseTree, tree) { return (await request(`${repoPath(repo)}/git/trees`, { method: 'POST', data: { base_tree: baseTree, tree } })).sha; },
    async createCommit(repo, commit) { return (await request(`${repoPath(repo)}/git/commits`, { method: 'POST', data: commit })).sha; },
    async createRef(repo, branch, sha) { return request(`${repoPath(repo)}/git/refs`, { method: 'POST', data: { ref: `refs/heads/${branch}`, sha } }); },
    async findPullRequest(repo, branch, base) {
      const query = new URLSearchParams({ state: 'all', head: `${repo.split('/')[0]}:${branch}`, base, per_page: '100' });
      const prs = await request(`${repoPath(repo)}/pulls?${query}`);
      const pr = prs.find(p => p.head.ref === branch && p.head.repo?.full_name === repo && p.base.ref === base);
      return pr ? { number: pr.number, url: pr.html_url, state: pr.state, draft: pr.draft } : null;
    },
    async createPullRequest(repo, data) { const pr = await request(`${repoPath(repo)}/pulls`, { method: 'POST', data }); return { number: pr.number, url: pr.html_url, state: pr.state, draft: pr.draft }; },
  };
}
