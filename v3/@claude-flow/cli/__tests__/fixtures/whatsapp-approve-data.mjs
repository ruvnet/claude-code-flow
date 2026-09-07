// Generated public synthetic fixture; no actual identities or credentials.
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
export const NOW=1700000000000;
export function data() {
 const human=generateKeyPairSync('ed25519'),service=generateKeyPairSync('ed25519');
 const pub=k=>k.export({type:'spki',format:'der'}).subarray(12).toString('base64url');
 const config={subject:'fixture-api',epoch:'epoch1',revision:'fixture1',expiresAt:NOW+300000,attesterPublicKey:pub(service.publicKey),humanPublicKeys:{human1:pub(human.publicKey)}};
 const assertion={version:1,action:'whatsapp.send.approve',companyId:'fixture',groupId:'group:a',intentId:'intent1',reservationId:'reservation1',agentMemberId:'agent1',agentBbsEnvelopeId:'envelope1',payloadSha256:'a'.repeat(64),humanSubject:{provider:'slack',userId:'UALICE',email:'alice@cognitum.one'},issuedAt:NOW-1000,expiresAt:NOW+60000,jti:'jti1',keyId:'human1',signature:''};
 const canonical=a=>Buffer.from(JSON.stringify(['cognitum.whatsapp.human-approval.v1',a.version,a.action,a.companyId,a.groupId,a.intentId,a.reservationId,a.agentMemberId,a.agentBbsEnvelopeId,a.payloadSha256,a.humanSubject.provider,a.humanSubject.userId,a.humanSubject.email,a.issuedAt,a.expiresAt,a.jti,a.keyId]));
 const resign=()=>{assertion.signature=sign(null,canonical(assertion),human.privateKey).toString('base64url');};resign();
 const d={version:1,kind:'cognitum.whatsapp.approve.v1',companyId:'fixture',groupId:'group:a',approvedByMemberId:'alice',assertion,expectedSnapshotDigest:null};
 const stamp=new Date(NOW-2000).toISOString();
 const route={agentMemberId:'agent1',allowedCommands:['/research'],allowedTools:['ruclip:read@v1'],harnessRef:'fixture@v1',inferenceTier:'low',maxUsdPerInvocation:1};
 const assignment={companyId:'fixture',groupId:'group:a',ownerMemberId:'alice',status:'active',managementApprovalMode:'required',agents:[route],budgetCapUsd:10,memoryRetentionHours:24,updatedAt:stamp};
 const reservation={reservationId:'reservation1',agentMemberId:'agent1',command:'/research',sourceEventId:'source1',inboundEnvelopeId:'inbound1',routePolicy:route,assignmentUpdatedAt:stamp,budgetCapUsd:10,reservedUsd:1,status:'reserved',receiptId:null,recordedUsd:null,createdAt:stamp,updatedAt:stamp};
 const ledger={companyId:'fixture',groupId:'group:a',spentUsd:0,reservedUsd:1,reservations:[reservation],updatedAt:stamp};
 const intent={intentId:assertion.intentId,reservationId:assertion.reservationId,agentMemberId:assertion.agentMemberId,agentBbsEnvelopeId:assertion.agentBbsEnvelopeId,payloadSha256:assertion.payloadSha256};
 const published={version:1,companyId:'fixture',groupId:'group:a',intent,recipientMemberId:'alice',recipient:'slack:UALICE',eventState:'published',eventDelivered:false,eventEnvelopeId:'published1',createdAt:stamp,publishedAt:stamp};
 const records=[['tiered_memory','semantic','ruclip:company:fixture',{id:'fixture',status:'active'}],['tiered_memory','semantic','ruclip:company:fixture:org-member:alice',{id:'alice',companyId:'fixture',kind:'human',status:'active',identityRef:'slack:UALICE'}],['tiered_memory','semantic','ruclip:company:fixture:org-member:agent1',{id:'agent1',companyId:'fixture',kind:'agent',status:'active',identityRef:'agent:fixture'}],['memory_entries','ruclip-api-whatsapp-group-assignments','ruclip:whatsapp-group-assignment:fixture:group%3Aa',assignment],['memory_entries','ruclip-api-agent-settings','ruclip:agent-settings:fixture:agent1',{autonomy:'suggest-only'}],['memory_entries','ruclip-api-whatsapp-group-spend','ruclip:whatsapp-group-spend:fixture:group%3Aa',ledger],['memory_entries','ruclip-api-whatsapp-group-send-approval-requests','ruclip:whatsapp-group-send-approval-request:fixture:group%3Aa:reservation1',published]];
 const seal=raw=>{const req=JSON.parse(raw);const op={version:1,domain:'cognitum.protected-service-operation.v1',epoch:config.epoch,subject:config.subject,action:req.kind==='cognitum.whatsapp.consume.v1'?'whatsapp.send.consume':assertion.action,companyId:req.companyId,target:`ruclip:whatsapp-group-send-approval:${encodeURIComponent(req.companyId)}:${encodeURIComponent(req.groupId)}:${encodeURIComponent((req.assertion??req.intent).reservationId)}`,bodySha256:createHash('sha256').update(raw).digest('hex'),nonce:'operation1',issuedAt:NOW-10,expiresAt:NOW+9000};const bytes=Buffer.from(JSON.stringify(op));return bytes.toString('hex')+'.'+sign(null,bytes,service.privateKey).toString('hex');};
 return {config,assertion,d,route,assignment,reservation,ledger,published,records,resign,seal,canonical};
}
export function seed(db,records) {
 let n=0;for(const [table,ns,key,value]of records) {
  if(table==='tiered_memory')db.prepare('INSERT INTO tiered_memory(id,key,tier,value) VALUES(?,?,?,?)').run(`fixture-${n++}`,key,ns,JSON.stringify(value));
  else db.prepare('INSERT INTO memory_entries(id,key,namespace,content,created_at,updated_at,status) VALUES(?,?,?,?,?,?,?)').run(`fixture-${n++}`,key,ns,JSON.stringify(value),NOW,NOW,'active');
 }
}
