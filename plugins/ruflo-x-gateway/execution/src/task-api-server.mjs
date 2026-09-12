import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createTaskApi, createAgentCard, TaskApiError } from './task-api.mjs';
import { taskConsole, taskConsoleScript } from './task-console.mjs';

const send = (res,status,body,type='application/json') => { res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"}); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
async function readBody(req) { let size=0; const chunks=[]; for await (const chunk of req) { size+=chunk.length; if(size>32768) throw new TaskApiError(413,'Payload too large'); chunks.push(chunk); } try{return JSON.parse(Buffer.concat(chunks));}catch{throw new TaskApiError(400,'Invalid JSON');} }
/** Resolver authenticates each request and returns a least privilege workspace-bound client. */
export async function startTaskApiServer({resolveRequest,host='127.0.0.1',port=0,agentUrl,allowRemote=false,allowedOrigins=[]}) {
  if(typeof resolveRequest !== 'function') throw new Error('authentication resolver required');
  if(!['127.0.0.1','::1','localhost'].includes(host) && !allowRemote) throw new Error('remote binding requires explicit TLS reverse proxy configuration');
  if(allowRemote && (!agentUrl || new URL(agentUrl).protocol !== 'https:')) throw new Error('remote binding requires HTTPS public agent URL');
  let publicUrl=agentUrl;
  const server=createServer(async(req,res)=>{
    try {
      const path=new URL(req.url,'http://localhost').pathname;
      const expected=new URL(publicUrl).host;
      if(!allowRemote && req.headers.host !== expected) return send(res,403,{error:'Host rejected'});
      if(req.headers.origin && req.headers.origin !== new URL(publicUrl).origin && !allowedOrigins.includes(req.headers.origin)) return send(res,403,{error:'Origin rejected'});
      if(req.method==='GET' && ['/agent-card','/.well-known/agent-card.json'].includes(path)) return send(res,200,createAgentCard(publicUrl));
      if(req.method==='GET' && path==='/console') return send(res,200,taskConsole,'text/html; charset=utf-8');
      if(req.method==='GET' && path==='/console.js') return send(res,200,taskConsoleScript,'text/javascript; charset=utf-8');
      let principal; try{principal=await resolveRequest(req);}catch{return send(res,401,{error:'Authentication required'});}
      if(!principal?.workspace || typeof principal.request !== 'function') return send(res,401,{error:'Authentication required'});
      const api=createTaskApi({...principal,agentUrl:publicUrl});
      if(req.method!=='POST') return send(res,405,{error:'POST required'});
      if(!req.headers['content-type']?.startsWith('application/json')) return send(res,415,{error:'JSON required'});
      const body=await readBody(req);
      if(path==='/a2a') return send(res,200,await api.a2a(body));
      if(path==='/mcp') {
        const mcp=api.createMcpServer();
        const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
        res.on('close',()=>{transport.close().catch(()=>{});mcp.close().catch(()=>{});});
        await mcp.connect(transport); await transport.handleRequest(req,res,body); return;
      }
      const operation=path.startsWith('/api/') ? path.slice(5) : '';
      if(!['task_submit','task_list','task_get','task_cancel','artifact_get'].includes(operation)) return send(res,404,{error:'Not found'});
      return send(res,200,await api[operation](body));
    }catch(error){if(!res.headersSent)send(res,error.code===413?413:error.code===400?400:400,{error:error instanceof TaskApiError?error.message:'Request rejected'});else res.end();}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  const address=server.address(); publicUrl ??= `http://${host.includes(':')?'['+host+']':host}:${address.port}/a2a`;
  return {server,url:new URL(publicUrl).origin,close:()=>new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeIdleConnections();})};
}
