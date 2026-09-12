import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey,getPublicKey } from 'nostr-tools/pure';
import { WorkspaceRegistry,workspaceTag } from '../src/workspaces.mjs';
import { command } from '../src/client.mjs';

export function fixture(t){const root=mkdtempSync(join(tmpdir(),'workspace-test-'));const keys=Array.from({length:6},generateSecretKey),pks=keys.map(getPublicKey);const configs=[0,1].map(i=>({id:`team${i}`,audience:`audience${i}`,controllerPubkey:pks[i*3],verifierPubkeys:[pks[i*3+1]],workerPolicies:[{pubkey:pks[i*3+2],capabilities:['sum'],cost:1}]}));const registry=new WorkspaceRegistry({root,workspaces:configs});t.after(()=>{registry.close();rmSync(root,{recursive:true,force:true});});return {registry,keys,pks,configs,root};}
test('separate workspace authorities reject foreign identities and audiences',t=>{const {registry,keys}=fixture(t);const spec={id:'private',capability:'sum',input:'private team zero payload',vector:[1],budget:1,deadlineMs:Date.now()+10000};registry.execute('team0',command(keys[0],'audience0','submit',spec));assert.equal(registry.execute('team0',command(keys[0],'audience0','status')).tasks.length,1);assert.equal(registry.execute('team1',command(keys[3],'audience1','status')).tasks.length,0);assert.throws(()=>registry.execute('team1',command(keys[0],'audience1','status')),/identity not allowed/);assert.throws(()=>registry.execute('team1',command(keys[3],'audience0','status')),/audience/);assert.throws(()=>registry.context('../team0'),/unknown/);assert.notEqual(registry.context('team0').directory,registry.context('team1').directory);assert.equal(statSync(registry.context('team0').directory).mode&0o777,0o700);assert.match(workspaceTag('team0'),/^[a-f0-9]{64}$/);});
test('duplicate audiences fail closed and persisted policy resists role replacement',t=>{const {registry,configs,root}=fixture(t);assert.throws(()=>new WorkspaceRegistry({root:join(root,'duplicate'),workspaces:[configs[0],{...configs[1],audience:configs[0].audience}]}),/unique/);registry.close();assert.throws(()=>new WorkspaceRegistry({root,workspaces:[{...configs[0],controllerPubkey:getPublicKey(generateSecretKey())}]}),/policy mismatch/);});
