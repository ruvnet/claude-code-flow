import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';

/** Local proof transport. The same signed command contract can be adapted to a relay. */
export function createExecutionServer(coordinator) {
  const wake = new EventEmitter(); wake.setMaxListeners(110);
  const server = createServer(async (req,res) => {
    res.setHeader('content-type','application/json'); res.setHeader('cache-control','no-store');
    if (req.url === '/health' && req.method === 'GET') return res.end('{"ok":true,"scope":"local-execution-proof"}');
    if (req.url !== '/command' || req.method !== 'POST') {res.statusCode=404; return res.end('{"error":"not found"}');}
    if (req.headers.origin) {res.statusCode=403; return res.end('{"error":"browser origins refused"}');}
    if (Number(req.headers['content-length']) > 32768) {res.statusCode=413; return res.end('{"error":"payload size"}');}
    try {
      const chunks=[]; let size=0;
      for await (const chunk of req) {size+=chunk.length; if(size>32768) throw new Error('payload size'); chunks.push(chunk);}
      const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = coordinator.execute(event);
      const op = JSON.parse(event.content).op;
      if (op === 'wait' && !result.ready) await new Promise(resolve => {
        const finish = () => {clearTimeout(timer);wake.off('work',finish);res.off('close',finish);resolve();};
        const timer=setTimeout(finish,1000); wake.once('work',finish);res.once('close',finish);
      });
      else if (['assign','cancel','verify'].includes(op)) wake.emit('work');
      res.end(JSON.stringify(result));
    } catch (e) {res.statusCode=e.message==='payload size'?413:400; res.end(JSON.stringify({error:e.message}));}
  });
  server.requestTimeout=5000; server.headersTimeout=5000;
  return {server,listen:(port=0)=>new Promise((resolve,reject)=>{
    server.once('error',reject); server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve(server.address().port);});
  }),close:()=>new Promise((resolve,reject)=>{wake.emit('work');server.closeAllConnections();server.close(e=>e?reject(e):resolve());})};
}
