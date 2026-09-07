/** Fixed claim/publication bookkeeping on the existing native handle.
 * The host authenticates ingress and consumes each service nonce independently.
 * This module never publishes. Only the immediate claim ack can seed a caller's
 * nonpersistent, single-use publication closure; no restart/read recreates it.
 */
import {assertAuthorityNativeReady as ready,authorityTimestamp} from './authority-snapshot.js';
import {clock,reviewedConfig,strict,exact,identifier,groupId,safe,hash,sha,verifyRequestClaimService,verifyRequestPublishedService,
 requireThat as need,type Obj} from './whatsapp-approve-proof.js';
import {requestState,requestTarget,REQUEST_NAMESPACE,INTENT_FIELDS} from './whatsapp-request-state.js';
export type RequestResult={outcome:'prepared';digest:string;observedAt:number;counts:Obj}
 | {outcome:'duplicate';request:Obj;digest:string;observedAt:number;counts:Obj}
 | {outcome:'committed';request:Obj;digest:string;counts:Obj;publicationPermit?:Obj}
 | {outcome:'committed-held';digest:string;counts:Obj}
 | {outcome:'denied'|'unknown';error:string};
type Phase='claim'|'published';
function request(raw:string,phase:Phase,prepare:boolean):Obj {
 const d=strict(raw),fields=['version','kind','companyId','groupId','intent','expectedSnapshotDigest',
  ...(phase==='claim'?['targetMemberId']:['claimDigest','eventEnvelopeId','eventDelivered'])];
 need(exact(d,fields)&&d.version===1&&d.kind===`cognitum.whatsapp.approval-request.${phase}.v1`
  &&identifier(d.companyId)&&groupId(d.groupId)&&(prepare?d.expectedSnapshotDigest===null:hash(d.expectedSnapshotDigest)),'invalid_request');
 need(exact(d.intent,INTENT_FIELDS)&&groupId(d.intent.intentId)&&groupId(d.intent.reservationId)&&identifier(d.intent.agentMemberId)
  &&safe(d.intent.agentBbsEnvelopeId)&&hash(d.intent.payloadSha256),'invalid_request');
 need(phase==='claim'?(d.targetMemberId===null||identifier(d.targetMemberId)):
  hash(d.claimDigest)&&safe(d.eventEnvelopeId)&&typeof d.eventDelivered==='boolean','invalid_request');return d;
}
const ERRORS=new Set(['invalid_request','invalid_signature','service_denied','configuration_unavailable','configuration_changed','authority_denied',
 'approval_replayed','request_missing','request_mismatch','publication_conflict','snapshot_drift','native_unavailable','transaction_active',
 'durability_required','missing_record','ambiguous_record','malformed_record','expired_record','mirror_conflict','byte_limit','deadline','clock_unavailable']);
export function createNativeWhatsAppRequester(registry:any,loadCurrentConfig:()=>unknown){
 const config=reviewedConfig(loadCurrentConfig()),configBytes=JSON.stringify(config);
 const recheck=()=>{const c=reviewedConfig(loadCurrentConfig());need(JSON.stringify(c)===configBytes,'configuration_changed');return c;};
 function execute(raw:string,seal:string|null,phase:Phase):RequestResult {
  let db:any,began=false,committing=false;
  const start=performance.now(),check=()=>need(performance.now()-start<=1000,'deadline');
  try{
   const d=request(raw,phase,seal===null),c=recheck(),now=clock();need(c.expiresAt>now,'configuration_unavailable');
   const verify=phase==='claim'?verifyRequestClaimService:verifyRequestPublishedService;
   const op=seal===null?null:verify(raw,seal,d,c,now);
   db=registry?.getAgentDB?.()?.database;ready(db);need(!db.inTransaction,'transaction_active');
   db.exec(seal===null?'BEGIN':'BEGIN IMMEDIATE');began=true;ready(db);
   const s=requestState(db,d,now,check);check();
   const finalGuard=()=>{const current=recheck(),at=clock();need(current.expiresAt>at,'configuration_unavailable');need(at>=now,'clock_unavailable');
    for(const r of s.records){const m=r.metadata;if(!m)continue;
     if(m.validFrom!==undefined&&m.validFrom!==null)need(authorityTimestamp(m.validFrom)<=at,'expired_record');
     if(m.validUntil!==undefined&&m.validUntil!==null)need(authorityTimestamp(m.validUntil)>at,'expired_record');
     if(m.expiresAt!==undefined&&m.expiresAt!==null)need(Number(m.expiresAt)>at,'expired_record');}
    if(s.request){need(authorityTimestamp(s.request.createdAt)<=at,'expired_record');
     if(s.request.publishedAt!==null)need(authorityTimestamp(s.request.publishedAt)<=at,'expired_record');}
    if(seal!==null)verify(raw,seal,d,current,at);check();};
   let duplicate=phase==='claim'&&s.request!==null;
   if(phase==='published'){
    need(s.request,'request_missing');
    const claimed={...s.request,eventState:'claimed',eventDelivered:null,eventEnvelopeId:null,publishedAt:null};
    need(sha(JSON.stringify(claimed))===d.claimDigest,'request_mismatch');
    if(s.request.eventState==='published'){
     need(s.request.eventEnvelopeId===d.eventEnvelopeId&&s.request.eventDelivered===d.eventDelivered,'publication_conflict');duplicate=true;
    }
   }
   if(duplicate||seal===null){
    ready(db);finalGuard();db.exec('COMMIT');began=false;finalGuard();
    const counts={...s.counts,recordInserts:0,recordUpdates:0,totalStatements:s.counts.recordStatements+14};
    // A duplicate applies no write and returns no publication permit, even if
    // its caller still holds an older prepared snapshot or a fresh service seal.
    return duplicate?{outcome:'duplicate',request:s.request!,digest:sha(JSON.stringify(s.request)),observedAt:now,counts}:
     {outcome:'prepared',digest:s.digest,observedAt:now,counts};
   }
   need(s.digest===d.expectedSnapshotDigest,'snapshot_drift');
   const stamp=new Date(now).toISOString();
   const next=phase==='claim'?{version:1,companyId:d.companyId,groupId:d.groupId,intent:d.intent,
    recipientMemberId:s.recipientMemberId,recipient:s.recipient,eventState:'claimed',eventDelivered:null,eventEnvelopeId:null,createdAt:stamp,publishedAt:null}:
    {...s.request,eventState:'published',eventDelivered:d.eventDelivered,eventEnvelopeId:d.eventEnvelopeId,publishedAt:stamp};
   const content=JSON.stringify(next),writeBytes=Buffer.byteLength(content),digest=sha(content);
   need(writeBytes<=256*1024&&s.counts.bytes+writeBytes<=2*1024*1024,'byte_limit');
   if(phase==='claim'){
    const key=requestTarget(d),id=`fixed-whatsapp-request-${sha(JSON.stringify([REQUEST_NAMESPACE,key]))}`;
    const r=db.prepare("INSERT INTO memory_entries(id,key,namespace,content,type,created_at,updated_at,expires_at,status) VALUES(?,?,?,?,'semantic',?,?,NULL,'active')")
     .run(id,key,REQUEST_NAMESPACE,content,now,now);need(r.changes===1,'storage_error');
   }else{
    const r=s.requestRecord;
    const updated=db.prepare('UPDATE memory_entries SET content=? WHERE id=? AND namespace=? AND key=? AND content=?')
     .run(content,r.metadata!.id,r.namespace,r.key,r.value);need(updated.changes===1,'snapshot_drift');
   }
   ready(db);finalGuard();committing=true;db.exec('COMMIT');began=false;
   const receipt={digest,counts:{...s.counts,writeBytes,recordInserts:phase==='claim'?1:0,recordUpdates:phase==='published'?1:0,totalStatements:s.counts.recordStatements+15}};
   try{finalGuard();}catch{return{outcome:'committed-held',...receipt};}
   return {outcome:'committed',request:next,...receipt,...(phase==='claim'?{publicationPermit:{version:1,subject:c.subject,epoch:c.epoch,
    revision:c.revision,nonce:op!.nonce,issuedAt:op!.issuedAt,expiresAt:Math.min(op!.expiresAt,c.expiresAt),claimDigest:digest,
    recipientMemberId:s.recipientMemberId,recipient:s.recipient}}:{})};
  }catch(error){let unknown=committing;if(began){try{if(db.inTransaction)db.exec('ROLLBACK');else unknown=true;}catch{unknown=true;}}
   const code=error instanceof Error?error.message:'';return {outcome:unknown?'unknown':'denied',error:unknown?'commit_unknown':ERRORS.has(code)?code:'storage_error'};}
 }
 return Object.freeze({claimPrepare:(raw:string)=>execute(raw,null,'claim'),claimApply:(raw:string,seal:string)=>execute(raw,seal,'claim'),
  publishedPrepare:(raw:string)=>execute(raw,null,'published'),publishedApply:(raw:string,seal:string)=>execute(raw,seal,'published')});
}
