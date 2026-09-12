import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey,getPublicKey,finalizeEvent } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { RelayPeer,createRelayAuthority,createRelayClient } from '../src/relay.mjs';
import { WorkspaceRegistry,workspaceTag } from '../src/workspaces.mjs';
import { command } from '../src/client.mjs';
import { mockRelay } from './support/relay-fixture.mjs';

async function fixture(t){const relay=await mockRelay(t),keys=Array.from({length:5},generateSecretKey),pks=keys.map(getPublicKey),root=mkdtempSync(join(tmpdir(),'relay-authority-'));const registry=new WorkspaceRegistry({root,workspaces:[{id:'private',audience:'proof',controllerPubkey:pks[0],verifierPubkeys:[pks[1]],workerPolicies:[{pubkey:pks[2],capabilities:['sum'],cost:1}]}]});const authority=await createRelayAuthority({registry,workspace:'private',secretKey:keys[3],relayUrl:relay.url,allowInsecureLocal:true});const clients=[];async function connect(key=keys[0],audience='proof'){const c=await createRelayClient({relayUrl:relay.url,secretKey:key,workspace:'private',audience,coordinatorPubkey:pks[3],allowInsecureLocal:true,timeoutMs:1000});clients.push(c);return c;}t.after(()=>{clients.forEach(c=>c.close());authority.close();registry.close();rmSync(root,{recursive:true,force:true});});return {relay,keys,pks,registry,authority,connect};}
const task=(id,input='sensitive business task')=>({id,capability:'sum',input,vector:[1],budget:3,deadlineMs:Date.now()+60000});

test('encrypted signed roundtrip, fragmented status, wrong audience and reconnect',async t=>{
 const f=await fixture(t),controller=await f.connect();
 for(let i=0;i<4;i++)assert.equal((await controller.request('submit',task(`task${i}`,'sensitive-'+ 'z'.repeat(5000)))).status,'queued');
 const status=await controller.request('status');assert.equal(status.tasks.length,4);assert.equal(status.tasks[0].spec.input.length,5010);
 assert.ok(f.relay.records.length>10);assert.ok(f.relay.records.every(e=>!e.content.includes('sensitive-')&&!e.content.includes('submit')));
 const decrypted=f.relay.records.filter(e=>e.pubkey===f.pks[3]).map(e=>JSON.parse(nip44.v2.decrypt(e.content,nip44.v2.utils.getConversationKey(f.keys[0],f.pks[3]))));
 assert.ok(decrypted.some(e=>e.total>1),'large signed response must fragment');
 const wrongAudience=await f.connect(f.keys[0],'wrong');await assert.rejects(wrongAudience.request('status'),/audience/);
 const before=f.relay.authentications;f.relay.disconnect();await delay(400);
 assert.equal((await controller.request('status')).tasks.length,4);assert.ok(f.relay.authentications>before,'connections reauthenticate');
});

test('NIP42 does not accept unsolicited null acknowledgment',async t=>{
 const relay=await mockRelay(t,{nullAck:true});const peer=new RelayPeer({relayUrl:relay.url,secretKey:generateSecretKey(),workspace:'test',allowedSenders:[],allowInsecureLocal:true,timeoutMs:100});t.after(()=>peer.close());await assert.rejects(peer.start(),/authentication timeout/);assert.equal(relay.authentications,0);
});

test('receiver excludes foreign signer and workspace, validates ciphertext and deduplicates',async t=>{
 const relay=await mockRelay(t),a=generateSecretKey(),b=generateSecretKey(),outsider=generateSecretKey();
 const receiver=new RelayPeer({relayUrl:relay.url,secretKey:b,workspace:'team',allowedSenders:[getPublicKey(a)],allowInsecureLocal:true});const sender=new RelayPeer({relayUrl:relay.url,secretKey:a,workspace:'team',allowedSenders:[getPublicKey(b)],allowInsecureLocal:true});t.after(()=>{receiver.close();sender.close();});await receiver.start();await sender.start();let received=0;receiver.on('message',()=>received++);
 const next=once(receiver,'message');await sender.send(getPublicKey(b),{secret:'test'});assert.equal((await next)[0].body.secret,'test');
 const original=relay.records.at(-1);relay.deliver(original);
 function inject(key,workspace,content){relay.deliver(finalizeEvent({kind:1,created_at:Math.floor(Date.now()/1000),tags:[['t','ruflo-execution-v1'],['p',getPublicKey(b)],['d',workspaceTag(workspace)]],content},key));}
 inject(outsider,'team',nip44.v2.encrypt('{"secret":"outsider"}',nip44.v2.utils.getConversationKey(outsider,getPublicKey(b))));
 inject(a,'other',nip44.v2.encrypt('{"secret":"wrong workspace"}',nip44.v2.utils.getConversationKey(a,getPublicKey(b))));
 inject(a,'team','invalid ciphertext');await delay(50);assert.equal(received,1);
});

test('authority refuses inner signature identity substitution',async t=>{
 const f=await fixture(t);const worker=new RelayPeer({relayUrl:f.relay.url,secretKey:f.keys[2],workspace:'private',allowedSenders:[f.pks[3]],allowInsecureLocal:true});t.after(()=>worker.close());await worker.start();
 await worker.send(f.pks[3],{type:'command',event:command(f.keys[0],'proof','submit',task('forged'))});await delay(50);
 assert.equal(f.registry.context('private').coordinator.tasks().length,0);
});

test('remote worker completes only after separate verifier accepts signed artifact',async t=>{
 const f=await fixture(t),controller=await f.connect(),worker=await f.connect(f.keys[2]),verifier=await f.connect(f.keys[1]);
 await worker.request('register',{capabilities:['sum']});await controller.request('submit',task('work',[1,2]));await controller.request('assign',{taskId:'work',worker:f.pks[2]});const {task:lease}=await worker.request('pull');const result=await worker.request('result',{taskId:'work',epoch:lease.epoch,inputHash:lease.inputHash,artifact:{value:3}});
 await assert.rejects(worker.request('verify',{taskId:'work',epoch:lease.epoch,artifactHash:result.artifactHash,accepted:true}),/verifier/);
 await verifier.request('verify',{taskId:'work',epoch:lease.epoch,artifactHash:result.artifactHash,accepted:true});assert.equal((await controller.request('status')).tasks[0].status,'completed');
});
