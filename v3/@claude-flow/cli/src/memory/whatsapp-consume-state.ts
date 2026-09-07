/** Fixed current consume state; approval/JTI are observations, never caller replacements. */
import { readAuthorityRows, authorityTimestamp as date } from './authority-snapshot.js';
import { member, validateAssignment, validateReserved } from './whatsapp-approve-state.js';
import { type Obj, type ReviewedConfig, exact, object, identifier, requireThat as need, sha, verifyHuman } from './whatsapp-approve-proof.js';
const INTENT=['intentId','reservationId','agentMemberId','agentBbsEnvelopeId','payloadSha256'];
const equalFields=(left:Obj,right:Obj,keys:string[])=>keys.every(k=>k==='humanSubject'
  ? exact(left[k],['provider','userId','email']) && exact(right[k],['provider','userId','email'])
    && ['provider','userId','email'].every(field=>left[k][field]===right[k][field])
  : left[k]===right[k]);
export function consumeState(db:any,d:Obj,c:ReviewedConfig,now:number,check:()=>void) {
  const company=d.companyId,group=d.groupId;
  // Two actual bootstrap records, reused in the final digest/record accounting.
  const first=readAuthorityRows(db,{companyId:company,selectors:[{kind:'assignment',groupId:group},
    {kind:'approval',groupId:group,reservationId:d.intent.reservationId,allowAbsent:false}]},now,check);
  const assignment=JSON.parse(first.records[0].value!),approval=JSON.parse(first.records[1].value!);
  validateAssignment(assignment,company,group);
  need(approval.companyId===company && approval.groupId===group && exact(approval.intent,INTENT)
    && equalFields(approval.intent,d.intent,INTENT) && identifier(approval.approvedByMemberId));
  need(approval.status==='approved' && approval.consumedAt===null && approval.dispatchId===null,'approval_replayed');
  const original=approval.originalHumanApproval;
  need(exact(original,['version','assertion','approver']) && original.version===1
    && exact(original.approver,['memberId','identityRef']),'original_proof_required');
  const a=original.assertion;
  const proofDigest=verifyHuman(a,c,now);
  need(a.companyId===company && a.groupId===group && equalFields(a,d.intent,INTENT)
    && original.approver.memberId===approval.approvedByMemberId && original.approver.identityRef===`slack:${a.humanSubject.userId}`);
  const summary=approval.humanApproval;
  need(object(summary) && ['assertionDigestSha256','jti','keyId','humanSubject','issuedAt','expiresAt'].every(k=>Object.hasOwn(summary,k))
    && summary.assertionDigestSha256===proofDigest && equalFields(summary,a,['jti','keyId','humanSubject','issuedAt','expiresAt']));
  const approvedAt=date(approval.approvedAt),expiry=date(approval.expiresAt);
  need(new Date(approvedAt).toISOString()===approval.approvedAt && new Date(expiry).toISOString()===approval.expiresAt
    && approvedAt>=a.issuedAt-30000 && approvedAt<a.expiresAt && approvedAt<=now && expiry===a.expiresAt && expiry>now);
  const owner=assignment.ownerMemberId,approver=approval.approvedByMemberId;
  const selectors:Obj[]=[{kind:'company'},{kind:'member',memberId:owner},{kind:'member',memberId:d.intent.agentMemberId},
    {kind:'settings',memberId:d.intent.agentMemberId},{kind:'spend',groupId:group},{kind:'jti',jti:a.jti,allowAbsent:false}];
  if(approver!==owner)selectors.push({kind:'member',memberId:approver},{kind:'executive',memberId:approver});
  const rest=readAuthorityRows(db,{companyId:company,selectors},now,check);
  const vals=rest.records.map(r=>JSON.parse(r.value!));
  const [org,human,agent,settings,spend,jti]=vals;
  need(org.id===company && org.status==='active');member(human,company,owner,'human');member(agent,company,d.intent.agentMemberId,'agent');
  need(settings && ['suggest-only','auto-act-within-budget'].includes(settings.autonomy));
  const currentApprover=approver===owner?human:vals[6];member(currentApprover,company,approver,'human');
  need(currentApprover.identityRef===original.approver.identityRef);
  if(approver!==owner){const e=vals[7];need(e && e.version===1 && e.companyId===company && e.memberId===approver
    && e.identityRef===currentApprover.identityRef && e.capability==='executive' && e.status==='active' && e.source==='trusted-seed');}
  need(jti.version===1 && jti.action==='whatsapp.send.approve' && jti.companyId===company && jti.groupId===group
    && jti.assertionDigestSha256===proofDigest && equalFields(jti,a,['jti','keyId','humanSubject']) && date(jti.usedAt)===approvedAt);
  validateReserved(spend,assignment,d.intent.agentMemberId,d.intent.reservationId,company,group);
  const records=[...first.records,...rest.records],encoded=JSON.stringify({companyId:company,records});
  need(Buffer.byteLength(encoded)<=2*1024*1024,'byte_limit');
  const returned=first.rowsObserved+rest.rowsObserved;
  return {approval,assertion:a,approvalRecord:first.records[1],digest:sha(encoded),records,
    counts:{logicalRecords:records.length,bootstrapRecords:2,rowsObserved:returned,recordRowsRead:2*returned,
      recordStatements:records.length+returned,bytes:Buffer.byteLength(encoded)}};
}
