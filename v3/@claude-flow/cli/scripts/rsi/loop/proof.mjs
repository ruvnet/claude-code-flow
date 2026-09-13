/** Independent evaluator attestation gate. Signatures authenticate approved attestors, not truth. */
import { verify, createHash } from 'node:crypto';
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const need = (ok, message) => { if (!ok) throw Error(message); };
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
export function signTest(deltas) {
  need(Array.isArray(deltas) && deltas.length > 0 && deltas.length <= 4096 && deltas.every(Number.isFinite), 'invalid cluster deltas');
  const wins = deltas.filter(d => d > 1e-12).length, losses = deltas.filter(d => d < -1e-12).length, n = wins + losses;
  let logProbability = -n * Math.LN2;
  const logs = [];
  for (let k = 0; k <= n; k++) {
    if (k > 0) logProbability += Math.log(n - k + 1) - Math.log(k);
    if (k >= wins) logs.push(logProbability);
  }
  const max = Math.max(...logs);
  return { meanGain: mean(deltas), wins, losses, ties: deltas.length - n,
    p: Math.min(1, Math.exp(max) * logs.reduce((sum, x) => sum + Math.exp(x - max), 0)) };
}

export function evaluateProof(state, packets, rules) {
  need(state.confirmation && state.genesis.trust.length === 2, 'independent proof reservation required');
  need(Array.isArray(packets) && packets.length === 2, 'primary and replication receipts required');
  const reservation = state.confirmation, manifest = reservation.manifest;
  const expected = rules.families.flatMap(f => rules.generations.flatMap(g => rules.controls.map(c => `${f}/${g}/${c}`)));
  const seenRoles = new Set(), seenDatasets = new Set(), roleTaskSets = [], tests = [];
  for (const packet of packets) {
    const trusted = state.genesis.trust.find(t => t.role === packet?.role);
    need(trusted && !seenRoles.has(packet.role), 'untrusted or duplicate evaluator');
    need(verify(null, Buffer.from(JSON.stringify(packet.result)), trusted.publicKey, Buffer.from(packet.signature, 'base64')), 'evaluator signature mismatch');
    seenRoles.add(packet.role);
    const r = packet.result;
    need(r.mission === state.genesis.mission && r.registrationHead === reservation.reservedHead && r.sourceCommit === manifest.sourceCommit, 'proof lineage mismatch');
    need(r.sourceHash === manifest.sourceHash && r.rootCheckpoint === manifest.rootCheckpoint && digest(r.parents) === digest(manifest.parents), 'proof source or parent mismatch');
    need(digest(r.checkpoints) === digest(manifest.checkpoints), 'checkpoint mismatch');
    need(r.costUnit === 'usd', 'costs must include all acquisition and evaluation dollars');
    need(manifest.datasets.includes(r.datasetHash) && !seenDatasets.has(r.datasetHash), 'proof dataset mismatch');
    seenDatasets.add(r.datasetHash);
    for (const flag of ['realWorkloads', 'sealedFromDeveloper', 'sourceVerified', 'fullCostMeasured', 'noHumanEdits', 'causalResetPassed', 'safetyPassed']) need(r[flag] === true, `missing evaluator attestation: ${flag}`);
    need(r.cells?.length === expected.length, 'incomplete proof matrix');
    const cellIds = new Set(), tasks = new Set(), taskGeneration = new Map(), cellsByScope = new Map(), commonStarts = new Map();
    for (const cell of r.cells) {
      const id = `${cell.family}/${cell.generation}/${cell.control}`;
      need(expected.includes(id) && !cellIds.has(id), 'unexpected or duplicate proof cell'); cellIds.add(id);
      need(Array.isArray(cell.pairs) && cell.pairs.length >= rules.minClusters && cell.pairs.length <= 4096, 'insufficient raw evidence');
      const clusters = new Map(), localTasks = new Set();
      for (const p of cell.pairs) {
        need(typeof p.taskId === 'string' && p.taskId.length > 0 && p.taskId.length <= 256 && !localTasks.has(p.taskId), 'duplicate task');
        need(!state.consumedTasks.includes(p.taskId), 'task consumed by a previous proof attempt');
        need(typeof p.clusterId === 'string' && p.clusterId.length > 0 && p.clusterId.length <= 256, 'cluster identity required');
        need(typeof p.startHash === 'string' && /^[a-f0-9]{64}$/.test(p.startHash), 'common starting harness required');
        const scope = `${cell.family}/${cell.generation}`;
        need(!taskGeneration.has(p.taskId) || taskGeneration.get(p.taskId) === scope, 'tasks reused across checkpoints or families');
        taskGeneration.set(p.taskId, scope); tasks.add(p.taskId); localTasks.add(p.taskId);
        for (const key of ['startScore', 'baselineScore', 'candidateScore']) need(Number.isFinite(p[key]) && p[key] >= 0 && p[key] <= 1, 'invalid raw quality');
        for (const key of ['baselineCost', 'candidateCost', 'budget']) need(Number.isFinite(p[key]) && p[key] >= 1e-9 && p[key] <= 1e9, 'full measured costs required');
        for (const arm of ['baseline', 'candidate']) {
          for (const phase of ['TrainingCost', 'EvaluationCost']) need(Number.isFinite(p[arm + phase]) && p[arm + phase] >= 0, 'cost breakdown required');
          need(Math.abs(p[arm + 'Cost'] - p[arm + 'TrainingCost'] - p[arm + 'EvaluationCost']) <= 1e-9 * Math.max(1, p[arm + 'Cost']), 'incomplete total cost');
        }
        need(p.baselineCost <= p.budget && p.candidateCost <= p.budget, 'matched budget exceeded');
        const consistent = digest([p.startHash, p.startScore, p.clusterId, p.candidateScore, p.candidateCost, p.candidateTrainingCost, p.candidateEvaluationCost, p.budget]);
        if (commonStarts.has(p.taskId)) need(commonStarts.get(p.taskId) === consistent, 'candidate or starting state differs across controls');
        else commonStarts.set(p.taskId, consistent);
        const baseline = (p.baselineScore - p.startScore) / p.baselineCost;
        const candidate = (p.candidateScore - p.startScore) / p.candidateCost;
        const cluster = clusters.get(p.clusterId) ?? [];
        cluster.push({ baseline, candidate, qualityDelta: p.candidateScore - p.baselineScore }); clusters.set(p.clusterId, cluster);
      }
      const scope = `${cell.family}/${cell.generation}`;
      const ids = [...localTasks].sort();
      if (cellsByScope.has(scope)) need(digest(ids) === cellsByScope.get(scope), 'controls use different tasks');
      else cellsByScope.set(scope, digest(ids));
      need(clusters.size >= rules.minClusters, 'insufficient independent clusters');
      const clustered = [...clusters.values()].map(rows => ({ baseline: mean(rows.map(p => p.baseline)), candidate: mean(rows.map(p => p.candidate)), qualityDelta: mean(rows.map(p => p.qualityDelta)) }));
      // Exact sign superiority for the predeclared practical margin; not a mean confidence interval.
      const stats = signTest(clustered.map(p => p.candidate - (1 + rules.minRelativeProductivityGain) * p.baseline));
      const baselineMean = mean(clustered.map(p => p.baseline)), candidateMean = mean(clustered.map(p => p.candidate));
      const passed = baselineMean > 0 && candidateMean >= baselineMean * (1 + rules.minRelativeProductivityGain)
        && stats.p <= reservation.alpha / (2 * expected.length) && mean(clustered.map(p => p.qualityDelta)) >= 0;
      tests.push({ role: packet.role, id, ...stats, baselineMean, candidateMean, passed });
    }
    roleTaskSets.push(tasks);
  }
  need([...roleTaskSets[0]].every(t => !roleTaskSets[1].has(t)), 'replication reuses primary tasks');
  return { accepted: tests.every(t => t.passed), tests, receiptHashes: packets.map(digest),
    assurance: 'conditional on the accuracy and independence of the two operator-approved evaluator attestations',
    openEndedRsiProven: false, productionPromotion: false };
}
