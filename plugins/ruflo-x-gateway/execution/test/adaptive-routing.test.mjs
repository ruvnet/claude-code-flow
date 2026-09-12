import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateSecretKey,getPublicKey} from 'nostr-tools/pure';
import {OutcomeMemory} from '../src/outcome-memory.mjs';
import {createAdaptiveRouter} from '../src/adaptive-routing.mjs';
test('fixed fallback, permission filtering and strict exploration budget',async()=>{
 const path=mkdtempSync(join(tmpdir(),'adaptive-')),pub=Array.from({length:4},()=>getPublicKey(generateSecretKey()));
 const memory=new OutcomeMemory({path,workspace:'team',audience:'test',controllerPubkey:pub[0],verifierPubkeys:[pub[1]],workerPubkeys:pub.slice(2)});
 const router=await createAdaptiveRouter({memory,dimensions:2,explorationRate:.05});
 const task={capability:'sum',vector:[1,0],budget:2},workers=pub.slice(2).map(pubkey=>({pubkey,capabilities:['sum'],cost:1,available:true}));
 try{assert.equal((await router.rank(task,workers)).reason,'fixed-no-history');for(let i=1;i<=100;i++){const r=await router.explore(task,[...workers,{pubkey:'unauthorized',capabilities:['other'],cost:0,available:true}],{lowRisk:true});assert(r.workers.every(w=>w.pubkey!=='unauthorized'));assert(router.stats().explorations<=Math.floor(i*.05));}assert.equal(router.stats().explorations,5);await assert.rejects(createAdaptiveRouter({memory,explorationRate:.06}));await assert.rejects(createAdaptiveRouter({memory:{history:()=>[]}}));}finally{await router.close();memory.close();rmSync(path,{recursive:true,force:true});}
});
test('native routing uses signed successful training outcomes on disjoint inputs',async()=>{
 const {runRoutingBenchmark}=await import('../src/routing-benchmark.mjs');
 const result=await runRoutingBenchmark();
 assert.equal(result.disjointInputs,true);assert.equal(result.verifiedTrainingOutcomes,12);
 assert.equal(result.metrics.fixed.verifiedSuccess,10);assert.equal(result.metrics.ruvector.verifiedSuccess,20);
 assert.equal(result.metrics.fixed.policyCostUnits,result.metrics.ruvector.policyCostUnits);
 assert.match(result.limitations,/no production superiority/);
});
