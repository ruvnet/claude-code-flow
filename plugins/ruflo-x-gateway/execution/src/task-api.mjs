import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$/);
const submitSchema = z.object({id, capability:id, input:z.unknown(), vector:z.array(z.number().finite()).min(1).max(4096), budget:z.number().finite().min(0).max(1e6), maxAttempts:z.number().int().min(1).max(10).optional(), deadlineMs:z.number().int().positive()}).strict();
const querySchema = z.object({taskId:id}).strict();
const listSchema = z.object({cursor:z.string().max(256).optional(), limit:z.number().int().min(1).max(100).default(20)}).strict();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class TaskApiError extends Error { constructor(code, message) { super(message); this.code = code; } }
const verified = t => t.status === 'completed' && t.verification?.accepted === true && t.verification.epoch === t.epoch && t.verification.artifactHash === t.artifactHash && t.artifact !== undefined && hash(t.artifact) === t.artifactHash;
const summary = t => ({taskId:t.spec.id, capability:t.spec.capability, status:t.status, attempts:t.attempts, spent:t.spent, deadlineMs:t.spec.deadlineMs, verified:verified(t), ...(verified(t) ? {artifactHash:t.artifactHash} : {})});
export function createAgentCard(agentUrl) {
  const url = new URL(agentUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) throw new Error('agent URL requires HTTPS or loopback');
  if (url.username || url.password || url.search || url.hash) throw new Error('invalid agent URL');
  return {protocolVersion:'0.3.0', name:'Ruflo verified execution', description:'Bounded A2A 0.3.0 JSON-RPC subset: structured message/send, tasks/get and tasks/cancel. No streaming or push notifications.', url:url.href, preferredTransport:'JSONRPC', version:'0.1.0', capabilities:{streaming:false,pushNotifications:false}, defaultInputModes:['application/json'], defaultOutputModes:['application/json'], securitySchemes:{bearer:{type:'http',scheme:'bearer'}}, security:[{bearer:[]}], skills:[{id:'verified-task',name:'Verified task execution',description:'Submit a structured execution task and retrieve independently verified artifacts.',tags:['execution','verification']}]};
}
/** request MUST enforce principal scopes and workspace isolation for every operation. */
export function createTaskApi({request,workspace,agentUrl}) {
  if (typeof request !== 'function' || !workspace) throw new Error('authenticated workspace client required');
  const card = createAgentCard(agentUrl);
  const get = async taskId => { let response; try { response = await request('task_get',{taskId}); } catch { throw new TaskApiError(-32001,'Task not found or inaccessible'); } if (!response?.task) throw new TaskApiError(-32001,'Task not found'); return response.task; };
  const api = {
    card,
    async task_submit(data) { const spec = submitSchema.parse(data); if (Buffer.byteLength(JSON.stringify(spec)) > 16384) throw new TaskApiError(-32602,'Task exceeds size limit'); return request('submit',spec); },
    async task_list(data={}) { const query = listSchema.parse(data); const result = await request('task_list',query); return {tasks:result.tasks.map(t => ({taskId:t.taskId ?? t.id,status:t.status,capability:t.capability,spent:t.spent,verified:t.verified === true,...(t.verified === true ? {artifactHash:t.artifactHash} : {})})),nextCursor:result.nextCursor ?? null}; },
    async task_get(data) { return summary(await get(querySchema.parse(data).taskId)); },
    async task_cancel(data) { const {taskId} = querySchema.parse(data); const t = await get(taskId); if (['completed','failed'].includes(t.status)) throw new TaskApiError(-32002,'Task is not cancelable'); await request('cancel',{taskId}); return summary(await get(taskId)); },
    async artifact_get(data) { const t = await get(querySchema.parse(data).taskId); if (!verified(t)) throw new TaskApiError(-32004,'Verified artifact unavailable'); return {taskId:t.spec.id,artifact:t.artifact,artifactHash:t.artifactHash,verification:{verifier:t.verification.verifier,epoch:t.verification.epoch,at:t.verification.at}}; },
    createMcpServer() {
      const server = new McpServer({name:'ruflo-execution',version:'0.1.0'});
      for (const [name,schema] of Object.entries({task_submit:submitSchema,task_list:listSchema,task_get:querySchema,task_cancel:querySchema,artifact_get:querySchema})) server.registerTool(name,{description:`Workspace scoped ${name.replaceAll('_',' ')}`,inputSchema:schema.shape},async args => {
        try { const value = await api[name](args); return {content:[{type:'text',text:JSON.stringify(value)}]}; }
        catch (error) { return {isError:true,content:[{type:'text',text:error instanceof TaskApiError ? error.message : 'Request rejected'}]}; }
      });
      return server;
    },
    async a2a(body) {
      const rpcId = typeof body?.id === 'string' || Number.isFinite(body?.id) ? body.id : null;
      try {
        if (!body || body.jsonrpc !== '2.0' || rpcId === null || typeof body.method !== 'string' || Array.isArray(body)) throw new TaskApiError(-32600,'Invalid request');
        if (!['message/send','tasks/get','tasks/cancel'].includes(body.method)) throw new TaskApiError(-32601,'Method not supported');
        let taskId;
        if (body.method === 'message/send') {
          const p = body.params;
          if (!p || Object.keys(p).some(k => k !== 'message') || p.message?.kind !== 'message' || p.message.role !== 'user' || typeof p.message.messageId !== 'string' || !p.message.messageId || p.message.taskId || p.message.contextId || p.message.parts?.length !== 1 || p.message.parts[0].kind !== 'data') throw new TaskApiError(-32602,'Expected one structured task DataPart; continuations and configuration are unsupported');
          taskId = (await api.task_submit(p.message.parts[0].data)).taskId;
        } else {
          const p = z.object({id,historyLength:z.literal(0).optional()}).strict().parse(body.params);
          taskId = p.id;
          if (body.method === 'tasks/cancel') await api.task_cancel({taskId});
        }
        const t = await get(taskId);
        const result = {kind:'task',id:taskId,contextId:taskId,status:{state:({queued:'submitted',leased:'working',submitted:'working',cancelled:'canceled',completed:'completed',failed:'failed'})[t.status] ?? 'unknown'}};
        if (verified(t)) result.artifacts = [{artifactId:t.artifactHash,parts:[{kind:'data',data:await api.artifact_get({taskId})}]}];
        return {jsonrpc:'2.0',id:rpcId,result};
      } catch (error) { return {jsonrpc:'2.0',id:rpcId,error:{code:error instanceof TaskApiError ? error.code : error instanceof z.ZodError ? -32602 : -32603,message:error instanceof TaskApiError ? error.message : error instanceof z.ZodError ? 'Invalid params' : 'Request rejected'}}; }
    }
  };
  return api;
}
