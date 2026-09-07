/** Fixed owner settings patch on the already initialized native SQLite handle.
 * Service seals attest API caller admission; they are not original human proofs.
 * Neither stored preferences nor this helper activate a learning/runtime agent.
 */
import {assertAuthorityNativeReady as ready,readAuthorityRows,authorityTimestamp} from './authority-snapshot.js';
import {clock,reviewedConfig,strict,exact,identifier,hash,sha,object,verifyAgentSettingsService,
 requireThat as need,type Obj} from './whatsapp-approve-proof.js';
export const SETTINGS_NAMESPACE='ruclip-api-agent-settings';
export const settingsTarget=(d:Obj)=>`ruclip:agent-settings:${d.companyId}:${d.agentMemberId}`;
const DEFAULTS=Object.freeze({autonomy:'off',learningEnabled:false,memoryScope:'none'});
const FIELDS=Object.keys(DEFAULTS);
export type SettingsPatchResult={outcome:'prepared';digest:string;observedAt:number;counts:Obj}
 | {outcome:'committed';settings:Obj;digest:string;counts:Obj}
 | {outcome:'committed-held';digest:string;counts:Obj}
 | {outcome:'denied'|'unknown';error:string};
function fields(v:Obj,error:string):void {
 if(Object.hasOwn(v,'autonomy'))need(['off','suggest-only','auto-act-within-budget'].includes(v.autonomy),error);
 if(Object.hasOwn(v,'learningEnabled'))need(typeof v.learningEnabled==='boolean',error);
 if(Object.hasOwn(v,'memoryScope'))need(['none','own-dms-only','own-dms-and-mentions'].includes(v.memoryScope),error);
}
function request(raw:string,prepare:boolean):Obj {
 const d=strict(raw);
 need(exact(d,['version','kind','companyId','agentMemberId','ownerMemberId','ownerIdentityRef','patch','expectedSnapshotDigest'])
  &&d.version===1&&d.kind==='cognitum.agent-settings.patch.v1'&&identifier(d.companyId)&&identifier(d.agentMemberId)
  &&identifier(d.ownerMemberId)&&d.agentMemberId!==d.ownerMemberId&&typeof d.ownerIdentityRef==='string'
  &&/^slack:[A-Za-z0-9]{1,128}$/.test(d.ownerIdentityRef)&&object(d.patch)&&Object.keys(d.patch).every(k=>FIELDS.includes(k))
  &&(prepare?d.expectedSnapshotDigest===null:hash(d.expectedSnapshotDigest)),'invalid_request');
 fields(d.patch,'invalid_request');return d;
}
const ERRORS=new Set(['invalid_request','invalid_signature','service_denied','configuration_unavailable','configuration_changed','authority_denied',
 'settings_malformed','snapshot_drift','native_unavailable','transaction_active','durability_required','missing_record','ambiguous_record',
 'malformed_record','expired_record','mirror_conflict','byte_limit','deadline','clock_unavailable']);
export function createNativeAgentSettingsPatcher(registry:any,loadCurrentConfig:()=>unknown){
 const config=reviewedConfig(loadCurrentConfig()),bytes=JSON.stringify(config);
 const recheck=()=>{const c=reviewedConfig(loadCurrentConfig());need(JSON.stringify(c)===bytes,'configuration_changed');return c;};
 function execute(raw:string,seal:string|null):SettingsPatchResult {
  let db:any,began=false,committing=false;
  const start=performance.now(),check=()=>need(performance.now()-start<=1000,'deadline');
  try{
   const d=request(raw,seal===null),c=recheck(),now=clock();need(c.expiresAt>now,'configuration_unavailable');
   if(seal!==null)verifyAgentSettingsService(raw,seal,d,c,now);
   db=registry?.getAgentDB?.()?.database;ready(db);need(!db.inTransaction,'transaction_active');
   db.exec(seal===null?'BEGIN':'BEGIN IMMEDIATE');began=true;ready(db);
   const s=readAuthorityRows(db,{companyId:d.companyId,selectors:[{kind:'company'},{kind:'member',memberId:d.ownerMemberId},
    {kind:'member',memberId:d.agentMemberId},{kind:'settings-patch',memberId:d.agentMemberId}]},now,check);
   const [company,owner,agent]=s.records.slice(0,3).map(r=>JSON.parse(r.value!));
   need(company.id===d.companyId&&company.status==='active');
   need(owner.id===d.ownerMemberId&&owner.companyId===d.companyId&&owner.kind==='human'&&owner.status==='active'
    &&owner.identityRef===d.ownerIdentityRef);
   need(agent.id===d.agentMemberId&&agent.companyId===d.companyId&&agent.kind==='agent'&&agent.status==='active'
    &&agent.managerId===d.ownerMemberId);
   const row=s.records[3],current=row.value===null?{}:JSON.parse(row.value);fields(current,'settings_malformed');
   const encoded=JSON.stringify({companyId:d.companyId,records:s.records}),snapshot=sha(encoded);
   const counts={logicalRecords:4,bootstrapRecords:0,rowsObserved:s.rowsObserved,recordRowsRead:2*s.rowsObserved,
    recordStatements:4+s.rowsObserved,bytes:Buffer.byteLength(encoded)};
   need(counts.bytes<=2*1024*1024,'byte_limit');
   const finalGuard=()=>{const currentConfig=recheck(),at=clock();need(at>=now,'clock_unavailable');need(currentConfig.expiresAt>at,'configuration_unavailable');
    for(const r of s.records){const m=r.metadata;if(!m)continue;
     if(m.validFrom!==undefined&&m.validFrom!==null)need(authorityTimestamp(m.validFrom)<=at,'expired_record');
     if(m.validUntil!==undefined&&m.validUntil!==null)need(authorityTimestamp(m.validUntil)>at,'expired_record');
     if(m.expiresAt!==undefined&&m.expiresAt!==null)need(Number(m.expiresAt)>at,'expired_record');}
    if(seal!==null)verifyAgentSettingsService(raw,seal,d,currentConfig,at);check();};
   if(seal===null){ready(db);finalGuard();db.exec('COMMIT');began=false;finalGuard();
    return{outcome:'prepared',digest:snapshot,observedAt:now,counts:{...counts,recordInserts:0,recordUpdates:0,totalStatements:counts.recordStatements+14}};}
   need(d.expectedSnapshotDigest===snapshot,'snapshot_drift');
   // Preserve future fields verbatim in the stored object and all physical row
   // metadata. Missing known fields have safe defaults; malformed ones deny above.
   const settings={...DEFAULTS,...current,...d.patch},content=JSON.stringify(settings),writeBytes=Buffer.byteLength(content),digest=sha(content);
   need(writeBytes<=256*1024&&counts.bytes+writeBytes<=2*1024*1024,'byte_limit');
   if(row.value===null){
    const key=settingsTarget(d),id=`fixed-agent-settings-${sha(JSON.stringify([SETTINGS_NAMESPACE,key]))}`;
    const inserted=db.prepare("INSERT INTO memory_entries(id,key,namespace,content,type,created_at,updated_at,expires_at,status) VALUES(?,?,?,?,'semantic',?,?,NULL,'active')")
     .run(id,key,SETTINGS_NAMESPACE,content,now,now);need(inserted.changes===1,'storage_error');
   }else{
    const changed=db.prepare('UPDATE memory_entries SET content=? WHERE id=? AND namespace=? AND key=? AND content=?')
     .run(content,row.metadata!.id,row.namespace,row.key,row.value);need(changed.changes===1,'snapshot_drift');
   }
   ready(db);finalGuard();committing=true;db.exec('COMMIT');began=false;
   const result={digest,counts:{...counts,writeBytes,recordInserts:row.value===null?1:0,recordUpdates:row.value===null?0:1,totalStatements:counts.recordStatements+15}};
   try{finalGuard();}catch{return{outcome:'committed-held',...result};}
   return{outcome:'committed',settings,...result};
  }catch(e){let unknown=committing;if(began){try{if(db.inTransaction)db.exec('ROLLBACK');else unknown=true;}catch{unknown=true;}}
   const code=e instanceof Error?e.message:'';return{outcome:unknown?'unknown':'denied',error:unknown?'commit_unknown':ERRORS.has(code)?code:'storage_error'};}
 }
 return Object.freeze({prepare:(raw:string)=>execute(raw,null),apply:(raw:string,seal:string)=>execute(raw,seal)});
}
