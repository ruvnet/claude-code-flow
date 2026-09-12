import {setTimeout as delay} from 'node:timers/promises';

const check=(ok,message)=>{if(!ok)throw new TypeError(message);};
/** Transport must authenticate the worker and enforce request timeouts. Handlers are trusted,
 * locally installed functions and must honor AbortSignal before side effects. No task code executes.
 * Results are submitted, never declared verified by this runtime.
 */
export async function runWorker({request,handlers,signal,maxTasks=1,maxIdlePolls=100,pollMs=100,renewMs=500,onEvent=()=>{}}={}) {
 check(typeof request==='function' && handlers && typeof handlers==='object','signed request and trusted handlers required');
 const capabilities=Object.keys(handlers);
 check(capabilities.length>0 && capabilities.every(k=>typeof handlers[k]==='function'),'invalid handlers');
 for(const [name,value,min,max] of [['maxTasks',maxTasks,1,10000],['maxIdlePolls',maxIdlePolls,1,10000],['pollMs',pollMs,1,60000],['renewMs',renewMs,1,60000]])check(Number.isSafeInteger(value)&&value>=min&&value<=max,`invalid ${name}`);
 signal?.throwIfAborted();
 await request('register',{capabilities});
 let submitted=0,idlePolls=0;
 while(submitted<maxTasks && idlePolls<maxIdlePolls){
  signal?.throwIfAborted();await request('heartbeat',{});
  const {ready}=await request('wait',{});
  if(!ready){idlePolls++;await delay(pollMs,undefined,{signal});continue;}
  const {task}=await request('pull',{});
  if(!task){idlePolls++;continue;}
  idlePolls=0;
  if(!Object.hasOwn(handlers,task.capability))throw new Error('untrusted capability assignment');
  const stop=new AbortController(),cancel=new AbortController();
  const workSignal=signal?AbortSignal.any([signal,cancel.signal]):cancel.signal;
  let renewalError;
  const maintenance=(async()=>{
   try{while(!stop.signal.aborted){await delay(renewMs,undefined,{signal:stop.signal});workSignal.throwIfAborted();await request('heartbeat',{});await request('renew',{taskId:task.id,epoch:task.epoch});}}
   catch(error){if(!stop.signal.aborted){renewalError=error;cancel.abort(error);}}
  })();
  let abortListener;
  const aborted=new Promise((_,reject)=>{abortListener=()=>reject(workSignal.reason??new Error('worker aborted'));if(workSignal.aborted)abortListener();else workSignal.addEventListener('abort',abortListener,{once:true});});
  try{
   onEvent({type:'started',taskId:task.id,epoch:task.epoch});
   const artifact=await Promise.race([Promise.resolve().then(()=>handlers[task.capability](structuredClone(task),{signal:workSignal})),aborted]);
   workSignal.throwIfAborted();
   // Stop and join maintenance before submission to avoid renewing a submitted task.
   stop.abort();await maintenance;if(renewalError)throw renewalError;workSignal.throwIfAborted();
   await request('result',{taskId:task.id,epoch:task.epoch,inputHash:task.inputHash,artifact});
   submitted++;onEvent({type:'submitted',taskId:task.id,epoch:task.epoch});
  }finally{stop.abort();cancel.abort();await maintenance;workSignal.removeEventListener('abort',abortListener);}
 }
 return {submitted,idlePolls,reason:submitted===maxTasks?'task-limit':'idle-limit'};
}
