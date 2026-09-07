/** Current fixed send-request authority. No BBS, cached rows or caller authority. */
import {readAuthorityRows,authorityTimestamp as date} from './authority-snapshot.js';
import {member,validateAssignment,validateReserved} from './whatsapp-approve-state.js';
import {type Obj,exact,identifier,safe,requireThat as need,sha} from './whatsapp-approve-proof.js';
export const REQUEST_NAMESPACE='ruclip-api-whatsapp-group-send-approval-requests';
export const INTENT_FIELDS=['intentId','reservationId','agentMemberId','agentBbsEnvelopeId','payloadSha256'];
export const sameIntent=(a:Obj,b:Obj)=>exact(a,INTENT_FIELDS)&&INTENT_FIELDS.every(k=>a[k]===b[k]);
export const requestTarget=(d:Obj)=>`ruclip:whatsapp-group-send-approval-request:${encodeURIComponent(d.companyId)}:${encodeURIComponent(d.groupId)}:${encodeURIComponent(d.intent.reservationId)}`;
export function requestState(db:any,d:Obj,now:number,check:()=>void){
 const c=d.companyId,g=d.groupId;
 const first=readAuthorityRows(db,{companyId:c,selectors:[{kind:'assignment',groupId:g}]},now,check);
 const assignment=JSON.parse(first.records[0].value!);validateAssignment(assignment,c,g);
 const owner=assignment.ownerMemberId;
 // Publication recipient is derived from the retained claim, never an asserted identity.
 const initial=readAuthorityRows(db,{companyId:c,selectors:[{kind:'request-claim',groupId:g,reservationId:d.intent.reservationId}]},now,check);
 const requestRecord=initial.records[0],request=requestRecord.value===null?null:JSON.parse(requestRecord.value);
 const recipientId=d.kind==='cognitum.whatsapp.approval-request.claim.v1'?(d.targetMemberId??owner):request?.recipientMemberId;
 need(identifier(recipientId),'request_missing');
 const selectors:Obj[]=[{kind:'company'},{kind:'member',memberId:owner},{kind:'member',memberId:d.intent.agentMemberId},
  {kind:'settings',memberId:d.intent.agentMemberId},{kind:'spend',groupId:g},
  {kind:'approval',groupId:g,reservationId:d.intent.reservationId,allowAbsent:true}];
 if(recipientId!==owner)selectors.push({kind:'member',memberId:recipientId},{kind:'executive',memberId:recipientId});
 const rest=readAuthorityRows(db,{companyId:c,selectors},now,check);
 const vals=rest.records.map(r=>r.value===null?null:JSON.parse(r.value));
 const [company,human,agent,settings,spend,approval]=vals;
 need(company.id===c&&company.status==='active');member(human,c,owner,'human');member(agent,c,d.intent.agentMemberId,'agent');
 need(settings&&['suggest-only','auto-act-within-budget'].includes(settings.autonomy));
 const recipient=recipientId===owner?human:vals[6];member(recipient,c,recipientId,'human');
 need(/^slack:[UW][A-Z0-9]{1,79}$/.test(recipient.identityRef));
 if(recipientId!==owner){const e=vals[7];need(e&&e.version===1&&e.companyId===c&&e.memberId===recipientId
  &&e.identityRef===recipient.identityRef&&e.capability==='executive'&&e.status==='active'&&e.source==='trusted-seed');}
 validateReserved(spend,assignment,d.intent.agentMemberId,d.intent.reservationId,c,g);
 // A consumed approval can leave its reservation reserved until settlement.
 need(approval===null,'approval_replayed');
 if(request!==null){
  need(request.version===1&&request.companyId===c&&request.groupId===g&&sameIntent(request.intent,d.intent)
   &&request.recipientMemberId===recipientId&&request.recipient===recipient.identityRef,'request_mismatch');
  need(date(request.createdAt)<=now,'malformed_record');
  if(request.eventState==='claimed')need(request.eventDelivered===null&&request.eventEnvelopeId===null&&request.publishedAt===null,'malformed_record');
  else need(request.eventState==='published'&&typeof request.eventDelivered==='boolean'&&safe(request.eventEnvelopeId)
   &&date(request.publishedAt)>=date(request.createdAt)&&date(request.publishedAt)<=now,'malformed_record');
 }
 const records=[...first.records,...initial.records,...rest.records],encoded=JSON.stringify({companyId:c,records});
 need(Buffer.byteLength(encoded)<=2*1024*1024,'byte_limit');
 const returned=first.rowsObserved+initial.rowsObserved+rest.rowsObserved;
 return {request,requestRecord,recipientMemberId:recipientId,recipient:recipient.identityRef,records,digest:sha(encoded),
  counts:{logicalRecords:records.length,bootstrapRecords:2,rowsObserved:returned,recordRowsRead:2*returned,
   recordStatements:records.length+returned,bytes:Buffer.byteLength(encoded)}};
}
