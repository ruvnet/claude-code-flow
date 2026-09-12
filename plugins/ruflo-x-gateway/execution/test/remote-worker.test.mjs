import test from 'node:test';
import assert from 'node:assert/strict';
import {generateSecretKey,getPublicKey} from 'nostr-tools/pure';
import {setTimeout as delay} from 'node:timers/promises';
import {Coordinator} from '../src/coordinator.mjs';
import {command} from '../src/client.mjs';
import {runWorker} from '../src/remote-worker.mjs';
function setup(){
 const keys=Array.from({length:3},()=>generateSecretKey()),pub=keys.map(getPublicKey),audience='remote-test';
 const c=new Coordinator({dbPath:':memory:',audience,controllerPubkey:pub[0],verifierPubkeys:[pub[1]],workerPolicies:[{pubkey:pub[2],capabilities:['sum'],cost:1}],leaseMs:100,heartbeatMs:1000});
 const req=(i,op,data={})=>c.execute(command(keys[i],audience,op,data));
 req(0,'submit',{id:'task',capability:'sum',input:[1,2],vector:[1],budget:2,maxAttempts:2,deadlineMs:Date.now()+10000});
 let renewals=0;
 const request=async(op,data)=>{const out=req(2,op,data);if(op==='register')req(0,'assign',{taskId:'task',worker:pub[2]});if(op==='renew')renewals++;return out;};
 return {c,req,request,renewals:()=>renewals};
}
test('signed runtime renews long work and submits independently verifiable artifact',async()=>{
 const f=setup();try{const result=await runWorker({request:f.request,renewMs:20,handlers:{sum:async(task,{signal})=>{await delay(180,undefined,{signal});return {value:task.input.reduce((a,b)=>a+b,0)};}}});assert.equal(result.submitted,1);assert(f.renewals()>=2);const t=f.c.tasks()[0];assert.equal(t.status,'submitted');assert.equal(t.artifact.value,3);f.req(1,'verify',{taskId:'task',epoch:t.epoch,artifactHash:t.artifactHash,accepted:true});assert.equal(f.c.tasks()[0].status,'completed');}finally{f.c.close();}
});
test('controller cancellation fences worker and aborts handler without result',async()=>{
 const f=setup();let observed=false;try{await assert.rejects(runWorker({request:f.request,renewMs:10,handlers:{sum:async(task,{signal})=>{signal.addEventListener('abort',()=>{observed=true;},{once:true});f.req(0,'cancel',{taskId:task.id});try{await delay(200,undefined,{signal});}catch(e){observed=signal.aborted;throw e;}return {};}}}),/stale fence/);assert.equal(observed,true);assert.equal(f.c.tasks()[0].status,'cancelled');assert.equal(f.c.tasks()[0].resultReceipt,undefined);}finally{f.c.close();}
});
test('external abort stops uncooperative handler from submitting',async()=>{
 const f=setup(),stop=new AbortController();try{await assert.rejects(runWorker({request:f.request,signal:stop.signal,renewMs:10,handlers:{sum:async()=>{stop.abort(new Error('operator stop'));return new Promise(()=>{});}}}),/operator stop/);assert.equal(f.c.tasks()[0].resultReceipt,undefined);}finally{f.c.close();}
});
