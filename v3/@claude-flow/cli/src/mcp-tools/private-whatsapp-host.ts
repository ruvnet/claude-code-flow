/** Protected-host-only HTTP instance. No global registration/CLI/env enablement.
 * Transport authentication and both service seals/nonce admission belong to the
 * existing protected Rust hops. A local socket or MCP context proves none of them.
 */
import {createMCPServer} from '@claude-flow/mcp';
import {listMCPTools,callMCPTool} from '../mcp-client.js';
import {authorizeMcpTool} from '../services/policy-runtime.js';
import {assertAuthorityNativeReady} from '../memory/authority-snapshot.js';
import {exact,requireThat as need} from '../memory/whatsapp-approve-proof.js';
import {createPrivateWhatsAppApprovalTools} from './private-whatsapp-approval.js';
import {createPrivateWhatsAppConsumeTools} from './private-whatsapp-consume.js';
import {createPrivateWhatsAppRequestTools} from './private-whatsapp-request.js';
import {createPrivateAgentSettingsTools} from './private-agent-settings.js';
import type {MCPTool} from './types.js';
const ORDINARY=Object.freeze(['memory_list','agentdb_graph-query','agentdb_hierarchical-recall','agentdb_pattern-search','claims_list','federation_bbs_watch',
 'agentdb_hierarchical-delete','claims_board','agentdb_hierarchical-store','agentdb_pattern-store','federation_bbs_publish','claims_accept-handoff',
 'memory_retrieve','federation_bbs_human_join','claims_handoff','agentdb_graph-pathfinder','federation_bbs_register','agentdb_causal-edge','agentdb_health',
 'claims_claim','agentdb_hierarchical-create','memory_store','agentdb_hierarchical-get']);
const PRIVATE=Object.freeze(['whatsapp_approve_prepare','whatsapp_approve_apply','whatsapp_consume_prepare','whatsapp_consume_apply',
 'whatsapp_request_claim_prepare','whatsapp_request_claim_apply','whatsapp_request_published_prepare','whatsapp_request_published_apply','agent_settings_patch_prepare','agent_settings_patch_apply']);
// Fixed conservative envelope covers every owner/executive branch before any
// native transaction. Requiring unused executive scope may deny an owner call;
// it never expands policy. Input cannot select or replace these namespaces.
const READ_NAMESPACES=Object.freeze(['hierarchical:semantic','ruclip-api-whatsapp-group-assignments',
 'ruclip-api-agent-settings','ruclip-api-whatsapp-group-spend','ruclip-api-whatsapp-group-send-approval-requests',
 'ruclip-api-whatsapp-group-send-approvals','ruclip-api-whatsapp-human-approval-jti','ruclip-api-authority']);
const WRITE_NAMESPACES=Object.freeze(['ruclip-api-whatsapp-group-send-approvals','ruclip-api-whatsapp-human-approval-jti']);
export type ProtectedWhatsAppHostOptions={port:number;tools:readonly string[]};
/** Internal application seam: existing host initializes the SAME registry before
 * passing it here. This factory opens no database and implements no warmup loop.
 * Caller retains existing30s health/3min same-child warmup requirements.
 */
export function createProtectedWhatsAppHttpHost(registry:unknown,loadCurrentConfig:()=>unknown,options:ProtectedWhatsAppHostOptions){
 need(exact(options,['port','tools']) && Number.isInteger(options.port) && options.port>=1024 && options.port<=65535
  && Array.isArray(options.tools) && options.tools.length>0 && options.tools.length<=33 && new Set(options.tools).size===options.tools.length
  && options.tools.every(n=>typeof n==='string' && [...ORDINARY,...PRIVATE].includes(n)),'invalid_host_scope');
 const ownedRegistry=registry as {getAgentDB?:()=>{database?:unknown}};
 assertAuthorityNativeReady(ownedRegistry?.getAgentDB?.()?.database);
 const ordinary=listMCPTools(),privateTools=[...createPrivateWhatsAppApprovalTools(registry,loadCurrentConfig),...createPrivateWhatsAppConsumeTools(registry,loadCurrentConfig),...createPrivateWhatsAppRequestTools(registry,loadCurrentConfig),...createPrivateAgentSettingsTools(registry,loadCurrentConfig)];
 need(!ordinary.some(t=>PRIVATE.includes(t.name)) && new Set(ordinary.map(t=>t.name)).size===ordinary.length,'tool_collision');
 const projectRoot=process.cwd();
 const tools:MCPTool[]=options.tools.map(name=>{
  const privateTool=privateTools.find(t=>t.name===name);
  if(privateTool){
   return {...privateTool,cacheable:false,handler:async(input:Record<string,unknown>)=>{
    // Never forward caller params/context into policy identity/root/namespace.
    for(const access of ['read','write'] as const){
     const settings=name==='agent_settings_patch_prepare'||name==='agent_settings_patch_apply';
     const requests=name.startsWith('whatsapp_request_');
     const consumes=name==='whatsapp_consume_prepare'||name==='whatsapp_consume_apply';
     const namespaces=access==='read'
      ? settings?['hierarchical:semantic','ruclip-api-agent-settings']:requests?READ_NAMESPACES.filter(ns=>ns!=='ruclip-api-whatsapp-human-approval-jti'):consumes?READ_NAMESPACES.filter(ns=>ns!=='ruclip-api-whatsapp-group-send-approval-requests'):READ_NAMESPACES
      : settings?(name.endsWith('_apply')?['ruclip-api-agent-settings']:[]):requests&&name.endsWith('_apply')?['ruclip-api-whatsapp-group-send-approval-requests']:name==='whatsapp_approve_apply'?WRITE_NAMESPACES:name==='whatsapp_consume_apply'?[WRITE_NAMESPACES[0]]:[];
     for(const namespace of namespaces){
      const decision=await authorizeMcpTool(name,{namespace},{projectRoot,serverId:'protected-whatsapp-native'},
       {actionType:access==='read'?'memory.read':'memory.write',namespaceAccess:access,network:false,destructive:false});
      if(decision.enforcedOutcome!=='allowed')return JSON.stringify({outcome:'denied',error:'policy_denied'});
     }
    }
    // MCP formats object results with indentation. Preserve the compact approval
    // bytes used by the native receipt digest and both-hop verifier.
    return JSON.stringify(await privateTool.handler(input));
   }};
  }
  const t=ordinary.find(t=>t.name===name);need(t,'tool_unavailable');
  // Preserve the actual existing policy/guardrail call path for every ordinary tool.
  return {...t,handler:async(input:Record<string,unknown>)=>callMCPTool(name,input,{projectRoot,serverId:'protected-whatsapp-native'})};
 });
 // No input, signature, record or response content reaches a logger.
 const quiet={debug:()=>{},info:()=>{},warn:()=>{},error:()=>{}};
 const server=createMCPServer({name:'Protected native WhatsApp host',version:'1',transport:'http',host:'127.0.0.1',port:options.port,
   enableMetrics:true,enableCaching:true,maxRequestSize:256*1024,requestTimeout:30000,requireToolAuthorization:true},quiet,undefined,undefined,
   name=>({allowed:tools.some(t=>t.name===name),reason:'fixed_host_selection'}));
 const registration=server.registerTools(tools as Parameters<typeof server.registerTools>[0]);
 need(registration.failed.length===0 && registration.registered===tools.length,'tool_registration_failed');
 // Pinned MCP start() installs built-ins through these public methods. Lock this
 // private instance before listening; no extra system/admin discovery surface.
 server.registerTool=()=>false;
 server.registerTools=extra=>({registered:0,failed:extra.map(t=>t.name)});
 return Object.freeze({start:()=>server.start(),stop:()=>server.stop(),health:()=>server.getHealthStatus(),tools:Object.freeze([...options.tools])});
}
