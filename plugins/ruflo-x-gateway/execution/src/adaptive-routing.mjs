import { createHash } from 'node:crypto';
import { createRouter } from './routing.mjs';
import { OutcomeMemory } from './outcome-memory.mjs';

/** Exploration is bounded over each router session, not a probabilistic promise. */
export async function createAdaptiveRouter({memory,dimensions=8,explorationRate=0,seed='federation',storagePath}={}) {
  if(!(memory instanceof OutcomeMemory))throw new TypeError('Pinned OutcomeMemory required');
  if(!Number.isFinite(explorationRate)||explorationRate<0||explorationRate>0.05)throw new TypeError('Exploration must be between zero and 5%');
  const history=memory.history();
  const fixed=await createRouter({mode:'fixed',dimensions});
  const learned=history.length ? await createRouter({mode:'ruvector',dimensions,history,storagePath}) : null;
  let eligibleDecisions=0,explorations=0,closed=false;
  return {
    backend:learned?.backend??'deterministic',
    async rank(task,workers){
      if(closed)throw new Error('Router is closed');
      const candidates=await fixed.rank(task,workers.filter(w=>memory.workers.includes(w?.pubkey)));
      if(!candidates.length)return {workers:[],reason:'no-eligible-workers'};
      const relevant=history.some(r=>r.capability===task.capability && candidates.some(w=>w.pubkey===r.worker));
      let ranked=relevant ? await learned.rank(task,candidates) : candidates;
      let reason=relevant?'verified-history':'fixed-no-history';
      // Callers mark low risk eligibility from trusted policy, never from task input.
      return {workers:ranked,reason};
    },
    async explore(task,workers,{lowRisk=false}={}){
      const result=await this.rank(task,workers);
      if(!lowRisk || result.workers.length<2)return result;
      eligibleDecisions++;
      if(explorations+1<=Math.floor(eligibleDecisions*explorationRate)){
        explorations++;
        const n=createHash('sha256').update(`${seed}:${eligibleDecisions}`).digest().readUInt32BE(0);
        const index=1+n%(result.workers.length-1),picked=result.workers[index];
        result.workers=[picked,...result.workers.filter(w=>w.pubkey!==picked.pubkey)];result.reason='bounded-exploration';
      }
      return result;
    },
    stats(){return {eligibleDecisions,explorations,explorationRate};},
    async close(){closed=true;await fixed.close();await learned?.close();},
  };
}
