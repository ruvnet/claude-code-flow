/** Controller scheduling and independent verification use authenticated, workspace-bound clients. */
export async function listTasks(request) {
  const tasks=[];let cursor;
  do {const page=await request('task_list',{limit:100,...(cursor?{cursor}:{})});tasks.push(...page.tasks);cursor=page.nextCursor;}while(cursor);
  return tasks;
}

export async function scheduleOnce({request,router}) {
  const assignments=[];
  for(const summary of await listTasks(request)) {
    if(summary.status!=='queued')continue;
    const {task}=await request('task_get',{taskId:summary.id});
    if(task.status!=='queued'||task.assigned)continue;
    const {workers}=await request('worker_list');
    const ranked=await router.rank({...task.spec,spent:task.spent},workers);
    const candidates=Array.isArray(ranked)?ranked:ranked.workers;
    if(!candidates.length)continue;
    try {assignments.push(await request('assign',{taskId:summary.id,worker:candidates[0].pubkey}));}
    catch(error){if(!/ineligible/.test(error.message))throw error;}
  }
  return assignments;
}

/** Validators are operator-provided and get the signed task input, never worker-selected policy. */
export async function verifyOnce({request,validators}) {
  const results=[];
  for(const summary of await listTasks(request)) {
    if(summary.status!=='submitted')continue;
    const {task}=await request('task_get',{taskId:summary.id});
    if(task.status!=='submitted')continue;
    const validator=Object.hasOwn(validators,task.spec.capability)?validators[task.spec.capability]:null;
    let accepted=false;
    if(typeof validator==='function')try{accepted=(await validator({input:task.spec.input,artifact:task.artifact,task}))===true;}catch{accepted=false;}
    try {results.push({taskId:summary.id,...await request('verify',{taskId:summary.id,epoch:task.epoch,artifactHash:task.artifactHash,accepted})});}
    catch(error){if(!/verification fence/.test(error.message))throw error;results.push({taskId:summary.id,status:'stale'});}
  }
  return results;
}
