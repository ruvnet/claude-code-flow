// Synthetic canonical records and service key; no live identity or event.
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {data,seed,NOW} from './whatsapp-approve-data.mjs';
export {seed,NOW};
export function requestData(executive=false){
 const f=data(),service=generateKeyPairSync('ed25519');
 f.config.attesterPublicKey=service.publicKey.export({type:'spki',format:'der'}).subarray(12).toString('base64url');
 f.records=f.records.slice(0,6);
 if(executive)f.records.push(['tiered_memory','semantic','ruclip:company:fixture:org-member:bob',{id:'bob',companyId:'fixture',kind:'human',status:'active',identityRef:'slack:UBOB'}],
 ['memory_entries','ruclip-api-authority','ruclip:executive:fixture:bob',{version:1,companyId:'fixture',memberId:'bob',identityRef:'slack:UBOB',capability:'executive',status:'active',source:'trusted-seed'}]);
 const d={version:1,kind:'cognitum.whatsapp.approval-request.claim.v1',companyId:'fixture',groupId:'group:a',intent:f.published.intent,targetMemberId:executive?'bob':null,expectedSnapshotDigest:null};
 const seal=(raw,patch={})=>{const req=JSON.parse(raw),phase=req.kind.includes('.published.')?'published':'claim';
 const op={version:1,domain:'cognitum.protected-service-operation.v1',epoch:f.config.epoch,subject:f.config.subject,action:`whatsapp.approval-request.${phase}`,companyId:req.companyId,target:`ruclip:whatsapp-group-send-approval-request:${encodeURIComponent(req.companyId)}:${encodeURIComponent(req.groupId)}:${encodeURIComponent(req.intent.reservationId)}`,bodySha256:createHash('sha256').update(raw).digest('hex'),nonce:'operation1',issuedAt:NOW-10,expiresAt:NOW+9000,...patch};
 const bytes=Buffer.from(JSON.stringify(op));return bytes.toString('hex')+'.'+sign(null,bytes,service.privateKey).toString('hex');};
 return {...f,d,seal};
}
