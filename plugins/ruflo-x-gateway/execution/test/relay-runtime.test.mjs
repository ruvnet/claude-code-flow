import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { generateSecretKey,getPublicKey,verifyEvent } from 'nostr-tools/pure';
import { WorkspaceRegistry } from '../src/workspaces.mjs';
import { createRelayAuthority,createRelayClient } from '../src/relay.mjs';
import { createRouter } from '../src/routing.mjs';
import { scheduleOnce,verifyOnce,listTasks } from '../src/task-runtime.mjs';
import { mockRelay } from './support/relay-fixture.mjs';

test('local relay integrates child worker, scheduler, verifier and exact budget receipts', {timeout:20000},async t=>{
 const relay=await mockRelay(t),root=mkdtempSync(join(tmpdir(),'relay-runtime-'));
 const keys=Array.from({length:4},generateSecretKey),pks=keys.map(getPublicKey);
 const workspace='runtime-test',audience='runtime-proof';
 const registry=new WorkspaceRegistry({root,leaseMs:5000,workspaces:[{id:workspace,audience,controllerPubkey:pks[0],verifierPubkeys:[pks[1]],workerPolicies:[{pubkey:pks[2],capabilities:['arithmetic'],cost:2}]}]});
 const authority=await createRelayAuthority({registry,workspace,secretKey:keys[3],relayUrl:relay.url,allowInsecureLocal:true});
 const config={relayUrl:relay.url,workspace,audience,coordinatorPubkey:pks[3],allowInsecureLocal:true};
 const controller=await createRelayClient({...config,secretKey:keys[0]}),verifier=await createRelayClient({...config,secretKey:keys[1]});
 const router=await createRouter({mode:'fixed',dimensions:2});
 const child=fork(new URL('./support/relay-worker-child.mjs',import.meta.url),[],{stdio:['ignore','ignore','pipe','ipc']});
 const messages=[];let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk.toString();});child.on('message',m=>messages.push(m));
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGKILL');await exited;}controller.close();verifier.close();authority.close();registry.close();await router.close();rmSync(root,{recursive:true,force:true});});
 const ready=new Promise((resolve,reject)=>{child.on('message',m=>{if(m.type==='ready')resolve(m);if(m.type==='failure')reject(new Error(m.error));});child.once('error',reject);});
 for(const [id,numbers] of [['task-one',[1,2,3]],['task-two',[4,5,6]]])await controller.request('submit',{id,capability:'arithmetic',input:{numbers,operation:'sum',privateMarker:'CONFIDENTIAL_RUNTIME_FIXTURE'},vector:[1,0],budget:4,maxAttempts:2,deadlineMs:Date.now()+15000});
 child.send({...config,secretKey:Array.from(keys[2])});assert.notEqual((await ready).pid,process.pid);
 let validations=0,finished=[];
 const validators={arithmetic:({input,artifact})=>{validations++;let expected=0;for(const n of input.numbers)expected+=n;return artifact.value===expected;}};
 const deadline=Date.now()+12000;
 while(Date.now()<deadline){await scheduleOnce({request:controller.request,router});await verifyOnce({request:verifier.request,validators});finished=await listTasks(controller.request);if(finished.every(task=>task.verified))break;assert.ok(!messages.some(m=>m.type==='failure'),JSON.stringify(messages));await delay(10);}
 assert.equal(finished.length,2);assert.ok(finished.every(task=>task.verified&&task.status==='completed'));assert.equal(validations,2);assert.equal(finished.reduce((sum,t)=>sum+t.spent,0),4);
 for(const summary of finished){const {task}=await controller.request('task_get',{taskId:summary.id});assert.equal(task.attempts,1);assert.equal(task.resultReceipt.envelope.pubkey,pks[2]);assert.equal(task.verification.envelope.pubkey,pks[1]);assert.ok(verifyEvent(task.resultReceipt.envelope));assert.ok(verifyEvent(task.verification.envelope));assert.equal(task.resultReceipt.inputHash,task.inputHash);}
 assert.deepEqual(await exited,{code:0,signal:null},stderr);assert.equal(messages.filter(m=>m.type==='submitted').length,2);assert.equal(messages.find(m=>m.type==='done').result.submitted,2);
 assert.ok(relay.records.length>0);assert.ok(relay.records.every(e=>!JSON.stringify(e).includes('CONFIDENTIAL_RUNTIME_FIXTURE')));
 // This is a local WebSocket fixture with one independently running child process,
 // not evidence of participation by an independently operated public host.
});
