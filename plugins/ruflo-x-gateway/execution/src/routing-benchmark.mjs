import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools/pure';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {Coordinator} from './coordinator.mjs';
import {OutcomeMemory,createOutcomeReceipt} from './outcome-memory.mjs';
import {createRouter} from './routing.mjs';

/** Synthetic specialization benchmark, not a semantic model or a production speedup claim. */
export async function runRoutingBenchmark(){
 const dir=mkdtempSync(join(tmpdir(),'routing-bench-')),keys=Array.from({length:4},()=>generateSecretKey()),pub=keys.map(getPublicKey),audience='synthetic-routing',workspace='benchmark';
 const workers=pub.slice(2).map((pubkey,i)=>({pubkey,capabilities:['transform'],cost:1,available:true,family:i}));
 const memory=new OutcomeMemory({path:join(dir,'memory'),workspace,audience,controllerPubkey:pub[0],verifierPubkeys:[pub[1]],workerPubkeys:pub.slice(2)});
 let sequence=0;
 const sign=(index,op,data)=>finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['d',audience]],content:JSON.stringify({op,requestId:`r${sequence++}`,data})},keys[index]);
 const execute=(task,w)=>{
   const c=new Coordinator({dbPath:':memory:',audience,controllerPubkey:pub[0],verifierPubkeys:[pub[1]],workerPolicies:workers,leaseMs:30000});
   const start=performance.now();
   try{
     c.execute(sign(0,'submit',task));const wi=pub.indexOf(w.pubkey);c.execute(sign(wi,'register',{capabilities:['transform']}));c.execute(sign(0,'assign',{taskId:task.id,worker:w.pubkey}));const lease=c.execute(sign(wi,'pull',{})).task;
     // Deliberately narrow workers share one advertised capability. Actual correctness is checked independently.
     const artifact={value:w.family===task.input.family?task.input.value*task.input.value:null};
     const result=c.execute(sign(wi,'result',{taskId:task.id,epoch:lease.epoch,inputHash:lease.inputHash,artifact}));
     const accepted=artifact.value===task.input.value**2;
     c.execute(sign(1,'verify',{taskId:task.id,epoch:lease.epoch,artifactHash:result.artifactHash,accepted}));
     return {task:c.tasks()[0],accepted,latencyMs:performance.now()-start};
   }finally{c.close();}
 };
 const spec=(split,i)=>({id:`${split}-${i}`,capability:'transform',input:{family:i%2,value:(split==='train'?1:101)+i},vector:i%2?[0,1]:[1,0],budget:1,maxAttempts:1,deadlineMs:Date.now()+60000});
 const routers=[];
 try{
   const trainingIds=[];
   for(let i=0;i<12;i++){const task=spec('train',i);trainingIds.push(task.id);for(const w of workers){const out=execute(task,w);if(out.accepted)memory.admit(createOutcomeReceipt({task:out.task,workspace,audience,secretKey:keys[0],latencyMs:out.latencyMs,cost:out.task.spent}));}}
   const result={workload:'synthetic deliberately specialized workers; hand-authored family vectors; no learned semantic model',trainingTasks:12,trainingAttempts:24,verifiedTrainingOutcomes:memory.history().length,evaluationTasks:20,disjointInputs:true,metrics:{}};
   for(const mode of ['fixed','ruvector']){
     const router=await createRouter({mode,dimensions:2,history:memory.history(),storagePath:join(dir,`${mode}.rvf`)});routers.push(router);
     let success=0,cost=0;const latencies=[],routingTimes=[];
     for(let i=0;i<20;i++){const task=spec('eval',i);if(trainingIds.includes(task.id))throw new Error('train/eval leakage');const at=performance.now();const [w]=await router.rank(task,workers);routingTimes.push(performance.now()-at);const out=execute(task,w);success+=Number(out.accepted);cost+=out.task.spent;latencies.push(out.latencyMs);}
     latencies.sort((a,b)=>a-b);result.metrics[mode]={verifiedSuccess:success,attempts:20,successRate:success/20,policyCostUnits:cost,costPerVerifiedSuccess:success?cost/success:null,p95ExecutionMs:latencies[18],totalRoutingMs:routingTimes.reduce((a,b)=>a+b,0)};
   }
   result.limitations='Specialization is constructed, cost units are configured policy charges, timings include local signatures and SQLite, and no production superiority is established.';
   return result;
 }finally{for(const r of routers)await r.close();memory.close();rmSync(dir,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(await runRoutingBenchmark(),null,2));
