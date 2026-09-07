/** Unexposed, fixed native approval transaction. No MCP, HTTP, provider or consume wiring.
 * The embedding host MUST authenticate transport and admit/consume its existing
 * operation nonce before apply. This helper independently verifies the service
 * seal and original human signature, but does not replace either ingress step.
 */
import { authorityTimestamp, assertAuthorityNativeReady as ready } from './authority-snapshot.js';
import { clock, reviewedConfig, request, verifyHuman, verifyService, sha, target, requireThat as need, type Obj } from './whatsapp-approve-proof.js';
import { state, intent } from './whatsapp-approve-state.js';
const APPROVAL_NS='ruclip-api-whatsapp-group-send-approvals';
const JTI_NS='ruclip-api-whatsapp-human-approval-jti';
const ERRORS=new Set(['invalid_request','invalid_assertion','invalid_signature','assertion_expired','service_denied','configuration_unavailable','configuration_changed',
  'authority_denied','approval_replayed','snapshot_drift','native_unavailable','transaction_active','durability_required','missing_record','ambiguous_record',
  'malformed_record','expired_record','mirror_conflict','byte_limit','deadline','clock_unavailable']);
export type ApprovalResult = { outcome:'prepared'; digest:string; observedAt:number; counts:Obj }
  | {outcome:'committed'; approval:Obj; digest:string; counts:Obj}
  | {outcome:'committed-held'; digest:string; counts:Obj}
  | {outcome:'denied'|'unknown'; error:string};
/** Create only from a host-owned current configuration loader. No request may
 * select/replace this loader or its subject, epoch, revision, public keys.
 * The frozen copy is compared to independently reloaded config before commit.
 * No global factory/export registers this object with a hosted tool surface.
 */
export function createNativeWhatsAppApprover(registry:any, loadCurrentConfig:() => unknown) {
  const config=reviewedConfig(loadCurrentConfig()); const configBytes=JSON.stringify(config);
  const recheck=() => { const fresh=reviewedConfig(loadCurrentConfig()); need(JSON.stringify(fresh) === configBytes,'configuration_changed'); return fresh; };
  function execute(raw:string, seal:string|null):ApprovalResult {
    let db:any,began=false,committing=false;
    const start=performance.now(); const check=() => need(performance.now()-start <= 1000,'deadline');
    try {
      const d=request(raw,seal === null), c=recheck(), now=clock();
      const proofDigest=verifyHuman(d.assertion,c,now);
      if (seal !== null) verifyService(raw,seal,d,c,now);
      db=registry?.getAgentDB?.()?.database; ready(db); need(!db.inTransaction,'transaction_active');
      db.exec(seal === null ? 'BEGIN' : 'BEGIN IMMEDIATE'); began=true; ready(db);
      const snapshot=state(db,d,now,check); check();
      const currentRecords=(at:number) => { for (const r of snapshot.records) { const m=r.metadata; if (!m) continue;
        if (m.validFrom !== undefined && m.validFrom !== null) need(authorityTimestamp(m.validFrom) <= at,'expired_record');
        if (m.validUntil !== undefined && m.validUntil !== null) need(authorityTimestamp(m.validUntil) > at,'expired_record');
        if (m.expiresAt !== undefined && m.expiresAt !== null) need(Number(m.expiresAt) > at,'expired_record');
      } };
      if (seal === null) {
        ready(db); const current=recheck(), finalNow=clock(); need(current.expiresAt > finalNow,'configuration_unavailable'); currentRecords(finalNow); verifyHuman(d.assertion,current,finalNow); check();
        db.exec('COMMIT'); began=false;
        return {outcome:'prepared',digest:snapshot.digest,observedAt:now,counts:{...snapshot.counts,
          recordInserts:0,totalStatements:snapshot.counts.recordStatements+14}};
      }
      need(snapshot.digest === d.expectedSnapshotDigest,'snapshot_drift');
      const stamp=new Date(now).toISOString(), a=d.assertion;
      const summary={assertionDigestSha256:proofDigest,jti:a.jti,keyId:a.keyId,humanSubject:a.humanSubject,issuedAt:a.issuedAt,expiresAt:a.expiresAt};
      const approval={companyId:d.companyId,groupId:d.groupId,intent:intent(d),approvedByMemberId:d.approvedByMemberId,
        approvedAt:stamp,expiresAt:new Date(a.expiresAt).toISOString(),status:'approved',consumedAt:null,dispatchId:null,humanApproval:summary,
        originalHumanApproval:{version:1,assertion:a,approver:{memberId:d.approvedByMemberId,identityRef:`slack:${a.humanSubject.userId}`}}};
      const jti={version:1,action:a.action,companyId:d.companyId,groupId:d.groupId,jti:a.jti,keyId:a.keyId,humanSubject:a.humanSubject,
        assertionDigestSha256:proofDigest,usedAt:stamp};
      const writes=[{namespace:JTI_NS,key:`ruclip:whatsapp-human-approval:${encodeURIComponent(a.jti)}`,value:jti},
        {namespace:APPROVAL_NS,key:target(d),value:approval}];
      let writeBytes=0;
      for (const w of writes) {
        const content=JSON.stringify(w.value); writeBytes+=Buffer.byteLength(content);
        need(Buffer.byteLength(content) <= 256*1024 && snapshot.counts.bytes+writeBytes <= 2*1024*1024,'byte_limit');
        // No upsert or tombstone resurrection. Namespace and key remain exact;
        // domain-separated physical ID avoids the legacy ':'/'_' cache alias.
        const id=`fixed-whatsapp-approve-${sha(JSON.stringify([w.namespace,w.key]))}`;
        const result=db.prepare("INSERT INTO memory_entries(id,key,namespace,content,type,created_at,updated_at,expires_at,status) VALUES(?,?,?,?,'semantic',?,?,NULL,'active')")
          .run(id,w.key,w.namespace,content,now,now);
        need(result.changes === 1,'storage_error');
      }
      // Trusted config/time may change during synchronous SQL/hooks. Deny and
      // rollback BOTH inserts; authority data stays locked by BEGIN IMMEDIATE.
      ready(db); const current=recheck(), finalNow=clock(); need(current.expiresAt > finalNow,'configuration_unavailable'); currentRecords(finalNow); verifyHuman(a,current,finalNow); verifyService(raw,seal,d,current,finalNow); check();
      committing=true; db.exec('COMMIT'); began=false;
      const receipt={digest:sha(JSON.stringify(approval)),counts:{...snapshot.counts,writeBytes,recordInserts:2,totalStatements:snapshot.counts.recordStatements+16}};
      // COMMIT is durable fact even when final private release cannot pass.
      // Never report no mutation or attempt a retry/rollback of committed rows.
      try { check(); const finalConfig=recheck(), releaseAt=clock(); need(finalConfig.expiresAt > releaseAt,'configuration_unavailable'); currentRecords(releaseAt); verifyHuman(a,finalConfig,releaseAt); verifyService(raw,seal,d,finalConfig,releaseAt); check(); }
      catch { return {outcome:'committed-held',...receipt}; }
      return {outcome:'committed',approval,...receipt};
    } catch (error) {
      let unknown=committing;
      if (began) { try { if (db.inTransaction) db.exec('ROLLBACK'); else unknown=true; } catch { unknown=true; } }
      const label=error instanceof Error ? error.message : '';
      return {outcome:unknown?'unknown':'denied',error:unknown?'commit_unknown':ERRORS.has(label)?label:'storage_error'};
    }
  }
  return Object.freeze({prepare:(raw:string) => execute(raw,null),apply:(raw:string,serviceSeal:string) => execute(raw,serviceSeal)});
}
