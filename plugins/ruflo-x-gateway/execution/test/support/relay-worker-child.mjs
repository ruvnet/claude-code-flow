import { createRelayClient } from '../../src/relay.mjs';
import { runWorker } from '../../src/remote-worker.mjs';
import { compute } from '../../src/worker.mjs';

// Test worker receives its key only through IPC, never argv or environment.
process.on('disconnect',()=>process.exit(0));
process.once('message',async config=>{
 let client;
 try {
  client=await createRelayClient({...config,secretKey:Uint8Array.from(config.secretKey),allowInsecureLocal:true});
  process.send({type:'ready',pid:process.pid});
  const result=await runWorker({request:client.request,handlers:{arithmetic:compute},maxTasks:2,maxIdlePolls:30,pollMs:5,renewMs:500,onEvent:event=>process.send(event)});
  process.send({type:'done',result});client.close();process.exit(0);
 }catch(error){client?.close();process.send({type:'failure',error:error.message});process.exit(1);}
});
