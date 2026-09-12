import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifyReport } from './evidence.mjs';
import { digest } from './coordinator.mjs';

const median=xs=>{const a=[...xs].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;};
export function cohortIssues(baseline,candidate) {
  const reasons=[];
  for(const [name,runs] of [['baseline',baseline],['candidate',candidate]]) {
    if(new Set(runs.map(r=>JSON.stringify([r.mode,r.sourceFingerprint,r.runtime,r.platform]))).size>1) reasons.push(`${name} mixes modes, builds or environments`);
  }
  if(new Set([...baseline,...candidate].map(r=>JSON.stringify([r.runtime,r.platform]))).size>1) reasons.push('environment mismatch');
  return reasons;
}
/** Evaluation-only receipt for MetaHarness review; never promotes or changes permissions. */
export function evaluateCandidate({baseline,candidate,minRuns=5,maxCostRatio=1,maxLatencyRatio=1,minimumImprovement=0.05}) {
  if(!Array.isArray(baseline)||!Array.isArray(candidate)||!Number.isInteger(minRuns)||minRuns<3||
      !Number.isFinite(maxCostRatio)||maxCostRatio<=0||!Number.isFinite(maxLatencyRatio)||maxLatencyRatio<=0||
      !Number.isFinite(minimumImprovement)||minimumImprovement<0||minimumImprovement>=1) throw new Error('invalid evaluation policy');
  const all=[...baseline,...candidate];
  for(const r of all) verifyReport(r);
  const reasons=cohortIssues(baseline,candidate);
  if(baseline.length<minRuns||candidate.length<minRuns) reasons.push('insufficient repeated runs');
  const shape=r=>digest(r.outcomes.map(o=>{const t=JSON.parse(o.submissionEnvelope.content).data;return [t.id,t.capability,t.input,t.vector,t.budget,t.maxAttempts];}).sort((a,b)=>a[0].localeCompare(b[0])));
  if(new Set(all.map(shape)).size!==1) reasons.push('task or budget mismatch');
  if(all.some(r=>r.sourceDirty!==false||!(/^[a-f0-9]{64}$/.test(r.sourceFingerprint ?? '')))) reasons.push('source not clean and fingerprinted');
  if(all.some(r=>r.fault?.requested != null)) reasons.push('fault trials are not performance comparisons');
  if(new Set(all.map(r=>r.audience)).size!==all.length) reasons.push('reused run evidence');
  if(all.some(r=>!Number.isFinite(r.elapsedMs)||r.elapsedMs<=0||!Number.isFinite(r.syntheticQuotedCost)||r.syntheticQuotedCost<0)) reasons.push('invalid measurements');
  let metrics=null;
  if(baseline.length&&candidate.length) {
    const bTime=median(baseline.map(r=>r.elapsedMs)),cTime=median(candidate.map(r=>r.elapsedMs));
    const bCost=median(baseline.map(r=>r.syntheticQuotedCost)),cCost=median(candidate.map(r=>r.syntheticQuotedCost));
    metrics={baselineMedianMs:bTime,candidateMedianMs:cTime,baselineQuote:bCost,candidateQuote:cCost};
    if(cCost>bCost*maxCostRatio||cTime>bTime*maxLatencyRatio) reasons.push('cost or latency regression');
    if(!(cTime<=bTime*(1-minimumImprovement)||cCost<bCost*(1-minimumImprovement))) reasons.push('no material measured improvement');
  }
  return {schema:1,kind:'federation-evaluation-receipt',decision:reasons.length?'hold':'review-candidate',
    reasons,metrics,baseline:baseline.map(r=>r.reportEnvelope.id),candidate:candidate.map(r=>r.reportEnvelope.id),
    authority:'evaluation only; promotion requires external authorization under ADR-322A',
    limits:'Synthetic local tasks and quotes; no general model capability or production cost claim. Self-contained keys establish integrity, not external trust.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const read=path=>readFileSync(path,'utf8').trim().split('\n').map(JSON.parse);
  if(!process.argv[2]||!process.argv[3])throw new Error('usage: node src/evaluation.mjs baseline.jsonl candidate.jsonl');
  console.log(JSON.stringify(evaluateCandidate({baseline:read(process.argv[2]),candidate:read(process.argv[3])}),null,2));
}
