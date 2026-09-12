import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { generateSecretKey,getPublicKey } from 'nostr-tools/pure';
import { Coordinator } from '../src/coordinator.mjs';
import { createExecutionServer } from '../src/service.mjs';
import { command,client } from '../src/client.mjs';

test('HTTP preserves signed Unicode across chunks and wakes waiting workers',async t=>{
  const keys=Array.from({length:3},()=>generateSecretKey()),pks=keys.map(getPublicKey),audience='http-proof';
  const c=new Coordinator({dbPath:':memory:',controllerPubkey:pks[0],verifierPubkeys:[pks[1]],workerPolicies:[{pubkey:pks[2],capabilities:['sum'],cost:1}],audience});
  const s=createExecutionServer(c);const port=await s.listen();t.after(async()=>{await s.close();c.close();});
  const task={id:'unicode',capability:'sum',input:{text:'你好 🌍'},vector:[1],budget:1,deadlineMs:Date.now()+10000};
  const raw=Buffer.from(JSON.stringify(command(keys[0],audience,'submit',task)));
  const split=raw.indexOf(Buffer.from('你'))+1;
  const response=await new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port,path:'/command',method:'POST',headers:{'content-type':'application/json'}},res=>{
      let body='';res.on('data',d=>{body+=d;});res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));
    });req.on('error',reject);req.write(raw.subarray(0,split));setImmediate(()=>req.end(raw.subarray(split)));
  });
  assert.equal(response.status,200);assert.equal(response.body.status,'queued');
  const worker=client(`http://127.0.0.1:${port}`,keys[2],audience),controller=client(`http://127.0.0.1:${port}`,keys[0],audience);
  await worker('register',{capabilities:['sum']});
  const wait=worker('wait');
  await new Promise(resolve=>setTimeout(resolve,20));
  await controller('assign',{taskId:'unicode',worker:pks[2]});await wait;
  assert.equal((await worker('pull')).task.id,'unicode');
  const bad=await fetch(`http://127.0.0.1:${port}/command`,{method:'POST',body:'{'});assert.equal(bad.status,400);
  const origin=await fetch(`http://127.0.0.1:${port}/command`,{method:'POST',headers:{origin:'https://example.com'},body:'{}'});assert.equal(origin.status,403);
  assert.throws(()=>client('https://example.com',keys[2],audience),/loopback/);
});
