import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools/pure';
import {digest} from '../src/coordinator.mjs';
import {OutcomeMemory,createOutcomeReceipt} from '../src/outcome-memory.mjs';

export function fixture(){
 const keys=Array.from({length:3},()=>generateSecretKey()),pub=keys.map(getPublicKey),audience='test';
 const sign=(i,op,data)=>finalizeEvent({kind:27235,created_at:1,tags:[['d',audience]],content:JSON.stringify({op,data})},keys[i]);
 const spec={id:'one',capability:'sum',input:[1,2],vector:[1,0],budget:2,maxAttempts:3,deadlineMs:100};
 const artifact={value:3},artifactHash=digest(artifact),inputHash=digest(spec);
 const task={spec,inputHash,status:'completed',epoch:1,owner:pub[2],spent:1,artifact,artifactHash,submissionEnvelope:sign(0,'submit',spec),resultReceipt:{worker:pub[2],envelope:sign(2,'result',{taskId:spec.id,epoch:1,inputHash,artifact})},verification:{envelope:sign(1,'verify',{taskId:spec.id,epoch:1,artifactHash,accepted:true})}};
 const config={workspace:'team',audience,controllerPubkey:pub[0],verifierPubkeys:[pub[1]],workerPubkeys:[pub[2]]};
 const receipt=(t=task,extra={})=>createOutcomeReceipt({task:t,workspace:'team',audience,secretKey:keys[0],latencyMs:5,cost:1,...extra});
 return {config,task,receipt,keys,pub};
}
test('persists verified receipts, deduplicates, partitions and pins policy',()=>{
 const path=mkdtempSync(join(tmpdir(),'memory-test-')),f=fixture();
 try{let m=new OutcomeMemory({path,...f.config});const r=f.receipt();assert.equal(m.admit(r),true);assert.equal(m.admit(r),false);m.close();m=new OutcomeMemory({path,...f.config});assert.equal(m.history().length,1);assert.equal(m.history()[0].worker,f.pub[2]);assert.throws(()=>m.admit(f.receipt(f.task,{workspace:'other'})),/workspace/);m.close();const other=new OutcomeMemory({path,...f.config,workspace:'other'});assert.equal(other.history().length,0);other.close();assert.throws(()=>new OutcomeMemory({path,...f.config,audience:'changed'}),/policy/);}finally{rmSync(path,{recursive:true,force:true});}
});
test('rejects unsigned flags, forged measurements, tampering, stale epochs and unpinned workers',()=>{
 const path=mkdtempSync(join(tmpdir(),'memory-test-')),f=fixture(),m=new OutcomeMemory({path,...f.config});
 try{assert.throws(()=>m.admit({verified:true}));for(const mutate of [t=>t.status='submitted',t=>t.epoch++,t=>t.artifact.value=4,t=>t.spec.input=[9],t=>t.resultReceipt.envelope.content+=' ']){const t=structuredClone(f.task);mutate(t);assert.throws(()=>m.admit(f.receipt(t)));}assert.throws(()=>m.admit(f.receipt(f.task,{cost:0})),/measurements/);const outsider=generateSecretKey();assert.throws(()=>m.admit(f.receipt(f.task,{secretKey:outsider})),/identity/);}finally{m.close();rmSync(path,{recursive:true,force:true});}
});
test('bounded retention and raw signature cache bypass protection',()=>{
 const path=mkdtempSync(join(tmpdir(),'memory-test-')),f=fixture(),m=new OutcomeMemory({path,...f.config,maxRecords:1});
 try{const r=f.receipt();m.admit(r);r.content=r.content.replace('"latencyMs":5','"latencyMs":6');assert.throws(()=>m.admit(r),/signature/);const t=structuredClone(f.task);t.spec.id='two';t.inputHash=digest(t.spec);const sign=(i,op,data)=>finalizeEvent({kind:27235,created_at:1,tags:[['d','test']],content:JSON.stringify({op,data})},f.keys[i]);t.submissionEnvelope=sign(0,'submit',t.spec);t.resultReceipt.envelope=sign(2,'result',{taskId:'two',epoch:1,inputHash:t.inputHash,artifact:t.artifact});t.verification.envelope=sign(1,'verify',{taskId:'two',epoch:1,artifactHash:t.artifactHash,accepted:true});m.admit(f.receipt(t));assert.equal(m.history().length,1);assert.equal(m.history()[0].id,'team:two');}finally{m.close();rmSync(path,{recursive:true,force:true});}
});
