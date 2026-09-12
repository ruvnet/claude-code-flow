import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPatchCapability } from '../src/patch-capability.mjs';
const input = { repository:'test/repo',baseSha:'a'.repeat(40),issue:{reference:'#1',text:'fix'}, policy:{commands:[{argv:['evil']}]}};
const policy = {commands:[{argv:['json-equals','value.json','answer','42']}]};
test('capability uses trusted repository policy and binds validation to assigned issue',async()=>{
 const digest=createHash('sha256').update(JSON.stringify(input.issue)).digest('hex');let observed;
 const adapter={async proposePatch(args){observed=args;return {issueDigest:digest};},async verifyPatch({artifact,expected}){if(artifact.issueDigest!==expected.issueDigest)throw new Error('wrong issue');return {verified:true};}};
 const capability=createPatchCapability({adapter,policies:{'test/repo':policy},propose:async()=>'',sandbox:{}});
 const artifact=await capability.handler({input});assert.deepEqual(observed.policy,policy);assert.equal(await capability.validator({input,artifact}),true);
 await assert.rejects(capability.validator({input:{...input,issue:{reference:'#2',text:'different'}},artifact}),/wrong issue/);
 await assert.rejects(capability.handler({input:{...input,repository:'unknown/repo'}}),/No trusted/);
});
test('abort prevents execution and suppresses a result after cancellation',async()=>{
 const controller=new AbortController();let runs=0;
 const capability=createPatchCapability({adapter:{async proposePatch(){runs++;controller.abort(new Error('cancelled'));return {};}},policies:{'test/repo':policy},sandbox:{},propose:async()=>''});
 await assert.rejects(capability.handler({input},{signal:controller.signal}),/cancelled/);assert.equal(runs,1);
 await assert.rejects(capability.handler({input},{signal:controller.signal}),/cancelled/);assert.equal(runs,1);
});
