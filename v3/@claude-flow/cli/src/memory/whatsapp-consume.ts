/** Unexposed fixed approved→consumed transaction; does not send or grant a retry.
 * Host-authenticated ingress and its admitted operation nonce remain prerequisites.
 */
import { assertAuthorityNativeReady as ready, authorityTimestamp } from './authority-snapshot.js';
import { clock, reviewedConfig, strict, exact, identifier, groupId, safe, hash, sha, verifyHuman, verifyConsumeService,
  requireThat as need, type Obj } from './whatsapp-approve-proof.js';
import { consumeState } from './whatsapp-consume-state.js';
export type ConsumeResult={outcome:'prepared';digest:string;observedAt:number;counts:Obj}
 | {outcome:'committed';approval:Obj;digest:string;counts:Obj}
 | {outcome:'committed-held';digest:string;counts:Obj}
 | {outcome:'denied'|'unknown';error:string};
function request(raw:string,prepare:boolean):Obj {
 const d=strict(raw);
 need(exact(d,['version','kind','companyId','groupId','intent','dispatchId','expectedSnapshotDigest'])
   && d.version===1 && d.kind==='cognitum.whatsapp.consume.v1' && identifier(d.companyId) && groupId(d.groupId)
   && groupId(d.dispatchId) && (prepare?d.expectedSnapshotDigest===null:hash(d.expectedSnapshotDigest)),'invalid_request');
 need(exact(d.intent,['intentId','reservationId','agentMemberId','agentBbsEnvelopeId','payloadSha256'])
   && groupId(d.intent.intentId) && groupId(d.intent.reservationId) && identifier(d.intent.agentMemberId)
   && safe(d.intent.agentBbsEnvelopeId) && hash(d.intent.payloadSha256),'invalid_request');return d;
}
const ERRORS=new Set(['invalid_request','invalid_assertion','invalid_signature','assertion_expired','service_denied','configuration_unavailable','configuration_changed',
 'authority_denied','approval_replayed','original_proof_required','snapshot_drift','native_unavailable','transaction_active','durability_required','missing_record','ambiguous_record',
 'malformed_record','expired_record','mirror_conflict','byte_limit','deadline','clock_unavailable']);
/** Reviewed loader is independent host input, never selected by a request.
 * Named fixed consumer requires a separately admitted consume action/seal upstream.
 */
export function createNativeWhatsAppConsumer(registry:any,loadCurrentConfig:()=>unknown) {
 const config=reviewedConfig(loadCurrentConfig()),configBytes=JSON.stringify(config);
 const recheck=()=>{const c=reviewedConfig(loadCurrentConfig());need(JSON.stringify(c)===configBytes,'configuration_changed');return c;};
 function execute(raw:string,seal:string|null):ConsumeResult {
  let db:any,began=false,committing=false;
  const start=performance.now(),check=()=>need(performance.now()-start<=1000,'deadline');
  try {
   const d=request(raw,seal===null),c=recheck(),now=clock();need(c.expiresAt>now,'configuration_unavailable');
   if(seal!==null)verifyConsumeService(raw,seal,d,c,now);
   db=registry?.getAgentDB?.()?.database;ready(db);need(!db.inTransaction,'transaction_active');
   db.exec(seal===null?'BEGIN':'BEGIN IMMEDIATE');began=true;ready(db);
   const s=consumeState(db,d,c,now,check);check();
   const finalGuard=()=>{const current=recheck(),at=clock();need(current.expiresAt>at,'configuration_unavailable');
    for(const r of s.records){const m=r.metadata;if(!m)continue;
     if(m.validFrom!==undefined&&m.validFrom!==null)need(authorityTimestamp(m.validFrom)<=at,'expired_record');
     if(m.validUntil!==undefined&&m.validUntil!==null)need(authorityTimestamp(m.validUntil)>at,'expired_record');
     if(m.expiresAt!==undefined&&m.expiresAt!==null)need(Number(m.expiresAt)>at,'expired_record');}
    verifyHuman(s.assertion,current,at);need(authorityTimestamp(s.approval.approvedAt)<=at,'authority_denied');
    if(seal!==null)verifyConsumeService(raw,seal,d,current,at);check();};
   if(seal===null){ready(db);finalGuard();db.exec('COMMIT');began=false;
    return{outcome:'prepared',digest:s.digest,observedAt:now,counts:{...s.counts,recordUpdates:0,totalStatements:s.counts.recordStatements+14}};}
   need(s.digest===d.expectedSnapshotDigest,'snapshot_drift');
   const next={...s.approval,status:'consumed',consumedAt:new Date(now).toISOString(),dispatchId:d.dispatchId};
   const content=JSON.stringify(next),writeBytes=Buffer.byteLength(content);
   need(writeBytes<=256*1024 && s.counts.bytes+writeBytes<=2*1024*1024,'byte_limit');
   const r=s.approvalRecord;
   // No generic setter/upsert. Preserve all row metadata and unknown approval fields.
   const updated=db.prepare('UPDATE memory_entries SET content=? WHERE id=? AND namespace=? AND key=? AND content=?')
     .run(content,r.metadata!.id,r.namespace,r.key,r.value);
   need(updated.changes===1,'snapshot_drift');
   ready(db);finalGuard();committing=true;db.exec('COMMIT');began=false;
   const receipt={digest:sha(content),counts:{...s.counts,writeBytes,recordUpdates:1,totalStatements:s.counts.recordStatements+15}};
   try{finalGuard();}catch{return{outcome:'committed-held',...receipt};}
   return{outcome:'committed',approval:next,...receipt};
  }catch(error){let unknown=committing;if(began){try{if(db.inTransaction)db.exec('ROLLBACK');else unknown=true;}catch{unknown=true;}}
   const code=error instanceof Error?error.message:'';return{outcome:unknown?'unknown':'denied',error:unknown?'commit_unknown':ERRORS.has(code)?code:'storage_error'};}
 }
 return Object.freeze({prepare:(raw:string)=>execute(raw,null),apply:(raw:string,seal:string)=>execute(raw,seal)});
}
