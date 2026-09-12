import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runBenchmark} from '../src/benchmark.mjs';
import {verifyReport,historyFromReport} from '../src/evidence.mjs';
import {createRouter} from '../src/routing.mjs';
import {fixtures} from '../src/fixtures.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('offline signatures, independent replay and trusted memory admission', {timeout:40000}, async()=>{
  const report=await runBenchmark({mode:'fixed'});
  const trusted={controllerPubkey:report.controllerIdentity,verifierPubkey:report.verifierIdentity};
  assert.equal(verifyReport(report,trusted).verified,20);
  const changed=structuredClone(report);changed.outcomes[0].artifact={value:999};
  assert.throws(()=>verifyReport(changed,trusted),/digest mismatch/);
  const costs=structuredClone(report);costs.outcomes[0].spent=0;
  assert.throws(()=>historyFromReport(costs,trusted),/digest mismatch/);
  assert.throws(()=>historyFromReport(report),/trusted identities/);
  assert.throws(()=>verifyReport(report,{...trusted,verifierPubkey:report.controllerIdentity}),/separate/);
  const history=historyFromReport(report,trusted);assert.equal(history.length,20);
  const dir=await mkdtemp(join(tmpdir(),'outcome-history-'));let router;
  try {
    router=await createRouter({mode:'ruvector',dimensions:8,history,storagePath:join(dir,'history.rvf')});
    const task=fixtures()[0], winner=report.outcomes.find(o=>o.id===task.id).worker;
    const workers=report.workerIdentities.map(pubkey=>({pubkey,capabilities:['arithmetic','sort','graph'],cost:0.01,available:true}));
    assert.equal((await router.rank(task,workers))[0].pubkey,winner);
    // This is a memory admission/retrieval test using known results, not a held out performance claim.
  }finally{await router?.close();await rm(dir,{recursive:true,force:true});}
});
