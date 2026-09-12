import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { verifyEvent } from 'nostr-tools/pure';
import { digest } from './coordinator.mjs';
import { fixtures, expectedArtifact } from './fixtures.mjs';

const requireThat=(condition,message)=>{if(!condition)throw new Error(message);};
function signed(event, op, pubkey, audience) {
  const clean=JSON.parse(JSON.stringify(event));
  requireThat(verifyEvent(clean),'signature invalid');
  requireThat(clean.kind===27235 && clean.pubkey===pubkey && JSON.stringify(clean.tags)===JSON.stringify([['d',audience]]),'identity or audience mismatch');
  const body=JSON.parse(clean.content);requireThat(body.op===op,'operation mismatch');return body.data;
}
/** Replays the bounded public fixture proof. Keys supplied out of band are required for trust, not just integrity. */
export function verifyReport(report, trusted={}) {
  requireThat(Array.isArray(report.outcomes) && report.outcomes.length===20,'expected 20 outcomes');
  const controller=trusted.controllerPubkey ?? report.controllerIdentity;
  const verifier=trusted.verifierPubkey ?? report.verifierIdentity;
  requireThat(typeof controller==='string' && typeof verifier==='string' && controller!==verifier,'separate controller and verifier required');
  requireThat(Array.isArray(report.workerIdentities) && new Set(report.workerIdentities).size===report.workerIdentities.length && !report.workerIdentities.includes(controller) && !report.workerIdentities.includes(verifier),'worker roles overlap');
  const {reportEnvelope,...payload}=report;
  const attestation=signed(reportEnvelope,'benchmark-report',controller,report.audience);
  requireThat(attestation.digest===digest(payload),'report digest mismatch');
  const expected=new Map(fixtures().map(t=>[t.id,t])),seen=new Set();
  for(const outcome of report.outcomes) {
    requireThat(!seen.has(outcome.id) && expected.has(outcome.id),'unknown or duplicate task');seen.add(outcome.id);
    requireThat(outcome.status==='completed' && report.workerIdentities.includes(outcome.worker),'uncompleted or unknown worker');
    const spec=signed(outcome.submissionEnvelope,'submit',controller,report.audience);
    const reference=expected.get(outcome.id);
    requireThat(spec.id===outcome.id && ['capability','input','vector','budget','maxAttempts'].every(k=>isDeepStrictEqual(spec[k],reference[k])),'fixture input mismatch');
    const result=signed(outcome.resultReceipt.envelope,'result',outcome.worker,report.audience);
    const proof=signed(outcome.verification.envelope,'verify',verifier,report.audience);
    const inputHash=digest({id:spec.id,capability:spec.capability,input:spec.input,vector:spec.vector,budget:spec.budget,maxAttempts:spec.maxAttempts,deadlineMs:spec.deadlineMs});
    requireThat(result.taskId===outcome.id && result.epoch===outcome.epoch && result.inputHash===inputHash,'result binding mismatch');
    requireThat(isDeepStrictEqual(result.artifact,outcome.artifact) && digest(result.artifact)===outcome.artifactHash,'artifact binding mismatch');
    requireThat(proof.taskId===outcome.id && proof.epoch===outcome.epoch && proof.artifactHash===outcome.artifactHash && proof.accepted===true,'verification binding mismatch');
    requireThat(isDeepStrictEqual(outcome.artifact,expectedArtifact(reference)),'incorrect artifact');
  }
  return {verified:seen.size,signatureIntegrity:true,trust:trusted.controllerPubkey && trusted.verifierPubkey ? 'externally pinned identities' : 'self-contained local identities; not external authorization'};
}
/** Only bounded fixture results validated above may enter this proof's routing memory. */
export function historyFromReport(report, trusted) {
  requireThat(trusted?.controllerPubkey && trusted?.verifierPubkey,'trusted identities required for memory admission');
  verifyReport(report,trusted);
  return report.outcomes.map(o=>{
    const spec=JSON.parse(o.submissionEnvelope.content).data;
    requireThat(Number.isFinite(o.spent) && o.spent>=0 && Number.isFinite(o.latencyMs) && o.latencyMs>=0,'missing measured outcome');
    return {id:`${report.audience}:${o.id}`,worker:o.worker,capability:spec.capability,vector:spec.vector,verified:true,cost:o.spent,latencyMs:o.latencyMs,
      artifactHash:o.artifactHash,verificationEvent:o.verification.envelope.id};
  });
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const path=process.argv[2];if(!path)throw new Error('usage: node src/evidence.mjs report.jsonl');
  for(const line of readFileSync(path,'utf8').trim().split('\n')) console.log(JSON.stringify(verifyReport(JSON.parse(line))));
}
