import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { Coordinator } from '../src/coordinator.mjs';
import { command } from '../src/client.mjs';

function setup(t, {persist=false}={}) {
  const directory=mkdtempSync(join(tmpdir(),'fence-test-'));
  const keys=Array.from({length:5},()=>generateSecretKey());
  const pks=keys.map(getPublicKey); let now=Date.now();
  const options={dbPath:persist?join(directory,'state.db'):':memory:',controllerPubkey:pks[0],verifierPubkeys:[pks[1]],
    workerPolicies:pks.slice(2,4).map(pubkey=>({pubkey,capabilities:['sum'],cost:1})),audience:'test-proof',leaseMs:100,clock:()=>now};
  let c=new Coordinator(options);
  t.after(()=>{c.close();rmSync(directory,{recursive:true,force:true});});
  const signed=(who,op,data={},extra={})=>command(keys[who],options.audience,op,data,{now,...extra});
  const run=(who,op,data={})=>c.execute(signed(who,op,data));
  const submit=(id='task',extra={})=>run(0,'submit',{id,capability:'sum',input:[1,2,3],vector:[1,0],budget:3,deadlineMs:now+10000,maxAttempts:3,...extra});
  const register=()=>{run(2,'register',{capabilities:['sum']});run(3,'register',{capabilities:['sum']});};
  const lease=(who=2,id='task')=>{run(0,'assign',{taskId:id,worker:pks[who]});return run(who,'pull').task;};
  const result=(who,task,artifact={value:6})=>run(who,'result',{taskId:task.id,epoch:task.epoch,inputHash:task.inputHash,artifact});
  const verify=(task,hash,accepted=true)=>run(1,'verify',{taskId:task.id,epoch:task.epoch,artifactHash:hash,accepted});
  return {get c(){return c;},keys,pks,options,signed,run,submit,register,lease,result,verify,advance:ms=>{now+=ms;},restart:()=>{c.close();c=new Coordinator(options);}};
}

test('verified artifact is durable, signed and committed only by verifier',t=>{
  const s=setup(t,{persist:true});s.register();s.submit();const task=s.lease();
  const r=s.result(2,task);
  assert.equal(s.run(0,'status').tasks[0].status,'submitted');
  assert.throws(()=>s.run(2,'verify',{taskId:task.id,epoch:task.epoch,artifactHash:r.artifactHash,accepted:true}),/verifier/);
  s.verify(task,r.artifactHash);s.restart();const final=s.run(0,'status').tasks[0];
  assert.equal(final.status,'completed');assert.equal(final.spent,1);
  assert.ok(verifyEvent(final.submissionEnvelope));assert.ok(verifyEvent(final.resultReceipt.envelope));assert.ok(verifyEvent(final.verification.envelope));
  assert.notEqual(final.resultReceipt.envelope.pubkey,final.verification.envelope.pubkey);
  assert.deepEqual(final.artifact,{value:6});
});

test('disconnect expires ownership; recovered owner fences delayed result in 100 trials',t=>{
  const s=setup(t);s.register();
  for(let i=0;i<100;i++) {
    s.submit(`task-${i}`);const old=s.lease(2,`task-${i}`);s.advance(101);
    const next=s.lease(3,`task-${i}`);assert.ok(next.epoch>old.epoch);
    assert.throws(()=>s.result(2,old),/stale fence/);
    const r=s.result(3,next);s.verify(next,r.artifactHash);
    assert.throws(()=>s.result(3,next),/stale fence/);
    // Refresh the two worker registrations without changing their authority.
    s.register();
  }
  const tasks=s.run(0,'status').tasks;
  assert.equal(tasks.filter(t=>t.status==='completed').length,100);
  assert.ok(tasks.every(t=>t.spent===2 && t.attempts===2));
});

test('duplicate signed pull is idempotent across restart; request id conflict rejected',t=>{
  const s=setup(t,{persist:true});s.register();s.submit();s.run(0,'assign',{taskId:'task',worker:s.pks[2]});
  const event=s.signed(2,'pull',{}, {requestId:'same-request'});
  const one=s.c.execute(event);s.restart();assert.deepEqual(s.c.execute(event),one);
  assert.equal(s.run(0,'status').tasks[0].spent,1);
  assert.throws(()=>s.c.execute(s.signed(2,'heartbeat',{}, {requestId:'same-request'})),/reused/);
});

test('two authority connections preserve one lease and one artifact commit',t=>{
  const s=setup(t,{persist:true});s.register();s.submit();s.run(0,'assign',{taskId:'task',worker:s.pks[2]});
  const second=new Coordinator(s.options);t.after(()=>second.close());
  const task=s.c.execute(s.signed(2,'pull')).task;
  assert.equal(second.execute(s.signed(3,'pull')).task,null);
  assert.throws(()=>second.execute(s.signed(0,'assign',{taskId:'task',worker:s.pks[3]})),/ineligible/);
  assert.equal(second.tasks()[0].spent,1);
  const r=s.result(2,task);const proof=s.signed(1,'verify',{taskId:'task',epoch:task.epoch,artifactHash:r.artifactHash,accepted:true});
  assert.equal(second.execute(proof).status,'completed');assert.equal(s.c.execute(proof).status,'completed');
  assert.equal(second.tasks()[0].attempts,1);
});

test('bad signatures, foreign audience, body identity spoof, role and capability escalation fail',t=>{
  const s=setup(t);s.register();s.submit();
  const ev=s.signed(2,'heartbeat');ev.pubkey=s.pks[0];assert.throws(()=>s.c.execute(ev),/signature/);
  assert.throws(()=>s.c.execute(command(s.keys[2],'other-proof','heartbeat',{})),/audience/);
  assert.throws(()=>s.run(4,'status'),/not allowed/);
  assert.throws(()=>s.run(2,'register',{capabilities:['shell']}),/escalation/);
  assert.throws(()=>s.run(2,'cancel',{taskId:'task',pubkey:s.pks[0]}),/controller/);
  assert.throws(()=>s.run(2,'status'),/requires controller/);
});

test('expired, cancelled, changed input and changed artifact cannot commit',t=>{
  const s=setup(t);s.register();s.submit();const task=s.lease();
  assert.throws(()=>s.run(2,'result',{taskId:task.id,epoch:task.epoch,inputHash:'fake',artifact:6}),/input hash/);
  const r=s.result(2,task);assert.throws(()=>s.result(2,task,{value:7}),/artifact conflict/);
  s.advance(101);assert.throws(()=>s.verify(task,r.artifactHash),/verification fence/);
  const next=s.lease(3);s.run(0,'cancel',{taskId:'task'});
  assert.throws(()=>s.result(3,next),/stale fence/);
});

test('rejection cannot exceed budget and replay cannot resurrect expired lease',t=>{
  const s=setup(t);s.register();s.submit('task',{budget:1});const task=s.lease();
  const r=s.result(2,task,{value:9});s.verify(task,r.artifactHash,false);
  assert.throws(()=>s.lease(3),/ineligible/);
  s.submit('second');const old=s.lease(2,'second');s.advance(101);
  assert.throws(()=>s.run(2,'renew',{taskId:old.id,epoch:old.epoch}),/stale fence/);
});

test('task identifiers and backwards clock handled safely',t=>{
  const s=setup(t,{persist:true});s.register();
  assert.throws(()=>s.submit('__proto__'),/invalid task/);
  for(const id of ['constructor','toString']) {s.submit(id);const task=s.lease(2,id);const r=s.result(2,task);s.verify(task,r.artifactHash);}
  s.restart();assert.equal(s.run(0,'status').tasks.length,2);
  assert.throws(()=>new Coordinator({...s.options,leaseMs:200}),/policy mismatch/);
  s.advance(-1);assert.throws(()=>s.run(0,'status'),/clock moved backwards/);
});

test('lease deadline and heartbeat eligibility are enforced using coordinator clock',t=>{
  const s=setup(t);s.register();s.submit();s.advance(10001);
  assert.throws(()=>s.lease(),/ineligible/);
  assert.equal(s.run(0,'status').tasks[0].status,'failed');
  s.submit('fresh');assert.throws(()=>s.lease(2,'fresh'),/ineligible/);
  s.register();assert.equal(s.lease(2,'fresh').id,'fresh');
});
