// Public synthetic owner/settings fixture; no real identity or credential.
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {data,seed,NOW} from './whatsapp-approve-data.mjs';
export {seed,NOW};
export function settingsData(){
 const f=data(),service=generateKeyPairSync('ed25519');
 f.config.attesterPublicKey=service.publicKey.export({type:'spki',format:'der'}).subarray(12).toString('base64url');
 f.records=[...f.records.slice(0,3),f.records[4]];
 f.records[2][3].managerId='alice';
 const d={version:1,kind:'cognitum.agent-settings.patch.v1',companyId:'fixture',agentMemberId:'agent1',
  ownerMemberId:'alice',ownerIdentityRef:'slack:UALICE',patch:{learningEnabled:true},expectedSnapshotDigest:null};
 const seal=(raw,patch={})=>{const req=JSON.parse(raw);
  const op={version:1,domain:'cognitum.protected-service-operation.v1',epoch:f.config.epoch,subject:f.config.subject,
   action:'agent-settings.patch',companyId:req.companyId,target:`ruclip:agent-settings:${req.companyId}:${req.agentMemberId}`,
   bodySha256:createHash('sha256').update(raw).digest('hex'),nonce:'operation1',issuedAt:NOW-10,expiresAt:NOW+9000,...patch};
  const b=Buffer.from(JSON.stringify(op));return b.toString('hex')+'.'+sign(null,b,service.privateKey).toString('hex');};
 return {...f,d,seal};
}
