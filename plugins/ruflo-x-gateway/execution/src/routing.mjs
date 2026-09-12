/** Outcome routing over caller-authorized history. Numeric fixtures are not semantic embeddings.
 * The caller must authenticate workers and supply only history visible to this task's tenant.
 * `verified` is a trusted verifier outcome, never a worker's self-attestation.
 */
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const compareKeys = (a, b) => a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0;
function vectorOf(value, dimensions) {
  if (!Array.isArray(value) || value.length !== dimensions ||
      !value.every(n => Number.isFinite(n) && Number.isFinite(Math.fround(n))) ||
      !value.some(n => Math.fround(n) !== 0)) throw new TypeError('Expected a finite, nonzero vector of configured dimensions');
  return Float32Array.from(value);
}
function eligible(task, workers) {
  if (!task || typeof task.capability !== 'string' || !task.capability ||
      !Number.isFinite(task.budget) || task.budget < 0) throw new TypeError('Task requires capability and finite nonnegative budget');
  if (!Array.isArray(workers)) throw new TypeError('Workers must be an array');
  const seen = new Set();
  return workers.filter(w => {
    if (!w || typeof w.pubkey !== 'string' || !w.pubkey || seen.has(w.pubkey) ||
        w.available !== true || !Array.isArray(w.capabilities) ||
        !w.capabilities.includes(task.capability) || !Number.isFinite(w.cost) ||
        w.cost < 0 || w.cost > task.budget) return false;
    seen.add(w.pubkey);
    return true;
  });
}

export async function createRouter({ mode = 'fixed', dimensions = 8, storagePath, history = [] } = {}) {
  if (!['single', 'fixed', 'ruvector'].includes(mode)) throw new TypeError('Unknown routing mode');
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 65536) throw new TypeError('Invalid dimensions');
  if (!Array.isArray(history)) throw new TypeError('History must be an array');
  let db;
  const records = new Map();
  if (mode === 'ruvector') {
    let core;
    try { core = await import('@ruvector/core'); }
    catch (cause) { throw new Error('RuVector routing requires a working @ruvector/core native installation', { cause }); }
    const VectorDB = core.VectorDB ?? core.default?.VectorDB;
    if (typeof VectorDB !== 'function') throw new Error('@ruvector/core does not export VectorDB');
    db = new VectorDB({ dimensions, distanceMetric: 'Cosine', storagePath: storagePath ?? join(tmpdir(), `federation-routing-${randomUUID()}.rvf`) });
    // Unique ids ensure pre-existing storage never injects unprovided history into ranking.
    const run = randomUUID();
    for (const [i, row] of history.entries()) {
      if (!row || row.verified !== true) continue;
      if (typeof row.worker !== 'string' || !row.worker || typeof row.capability !== 'string' || !row.capability ||
          !Number.isFinite(row.cost) || row.cost < 0 || !Number.isFinite(row.latencyMs) || row.latencyMs < 0) {
        throw new TypeError('Verified history requires worker, capability, cost, and latencyMs');
      }
      const vector = vectorOf(row.vector, dimensions);
      const id = `${run}:${i}`;
      await db.insert({ id, vector });
      records.set(id, { ...row });
    }
  }
  let closed = false;
  return {
    mode,
    backend: db ? '@ruvector/core' : 'deterministic',
    async rank(task, workers) {
      if (closed) throw new Error('Router is closed');
      const candidates = eligible(task, workers);
      if (mode === 'single') return candidates.slice(0, 1);
      candidates.sort(compareKeys);
      if (mode === 'fixed') return candidates;
      const vector = vectorOf(task.vector, dimensions);
      if (!records.size || !candidates.length) return candidates;
      const allowed = new Set(candidates.map(w => w.pubkey));
      const scores = new Map();
      // Search all supplied examples to avoid cross-capability examples starving eligible matches.
      // This deliberately bounded proof favors correctness; benchmark before scaling history.
      const hits = await db.search({ vector, k: records.size });
      for (const hit of hits) {
        const row = records.get(hit.id);
        if (!row || row.capability !== task.capability || !allowed.has(row.worker) || !Number.isFinite(hit.score)) continue;
        const old = scores.get(row.worker);
        // Native cosine score is distance: smaller is nearer. One nearest verified example
        // avoids rewarding workers merely for producing more history records.
        if (!old || hit.score < old.distance || (hit.score === old.distance && row.cost < old.cost)) {
          scores.set(row.worker, { distance: hit.score, cost: row.cost, latencyMs: row.latencyMs });
        }
      }
      return candidates.sort((a, b) => {
        const x = scores.get(a.pubkey), y = scores.get(b.pubkey);
        if (!x || !y) return x ? -1 : y ? 1 : compareKeys(a, b);
        return x.distance - y.distance || x.cost - y.cost || x.latencyMs - y.latencyMs || compareKeys(a, b);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (typeof db?.close === 'function') await db.close();
    },
  };
}
