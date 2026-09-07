import {beforeEach,expect,it,vi} from 'vitest';
const {register,ordinary,policy,privateCall}=vi.hoisted(()=>({register:vi.fn(),ordinary:vi.fn(),policy:vi.fn(),privateCall:vi.fn()}));
vi.mock('@claude-flow/mcp',()=>({createMCPServer:()=>({registerTools:register,start:vi.fn(),stop:vi.fn(),getHealthStatus:vi.fn()})}));
vi.mock('../src/mcp-client.js',()=>({listMCPTools:()=>[{name:'memory_store',inputSchema:{type:'object'},description:'public',handler:ordinary},{name:'agentdb_health',inputSchema:{type:'object'},description:'health',handler:ordinary}],callMCPTool:ordinary}));
vi.mock('../src/services/policy-runtime.js',()=>({authorizeMcpTool:policy}));
vi.mock('../src/memory/authority-snapshot.js',()=>({assertAuthorityNativeReady:vi.fn()}));
vi.mock('../src/mcp-tools/private-whatsapp-approval.js',()=>({createPrivateWhatsAppApprovalTools:()=>['whatsapp_approve_prepare','whatsapp_approve_apply'].map(name=>({name,description:'private',inputSchema:{type:'object'},cacheable:false,handler:privateCall}))}));
import {createProtectedWhatsAppHttpHost} from '../src/mcp-tools/private-whatsapp-host.js';
beforeEach(()=>{vi.clearAllMocks();register.mockImplementation(t=>({registered:t.length,failed:[]}));policy.mockResolvedValue({enforcedOutcome:'allowed'});privateCall.mockResolvedValue({outcome:'unknown',error:'commit_unknown'});});
it('uses exact selection and fixed private policy namespace/classification without caller authority',async()=>{
 const host=createProtectedWhatsAppHttpHost({},()=>({}),{port:8081,tools:['whatsapp_approve_prepare','whatsapp_approve_apply','memory_store']});
 const tools=register.mock.calls[0][0];const input={projectRoot:'/attacker',namespace:'wide',requestJson:'raw',serviceSeal:'seal'};
 await tools[0].handler(input,{projectRoot:'/attacker',approvalIds:['grant']});
 expect(policy).toHaveBeenCalledTimes(8);
 expect(policy.mock.calls.map(c=>c[1].namespace)).toEqual(['hierarchical:semantic','ruclip-api-whatsapp-group-assignments','ruclip-api-agent-settings','ruclip-api-whatsapp-group-spend','ruclip-api-whatsapp-group-send-approval-requests','ruclip-api-whatsapp-group-send-approvals','ruclip-api-whatsapp-human-approval-jti','ruclip-api-authority']);
 for(const c of policy.mock.calls){expect(c[2]).toEqual({projectRoot:process.cwd(),serverId:'protected-whatsapp-native'});expect(c[3]).toEqual({actionType:'memory.read',namespaceAccess:'read',network:false,destructive:false});}
 expect(JSON.parse(await tools[1].handler(input))).toEqual({outcome:'unknown',error:'commit_unknown'});
 expect(policy).toHaveBeenCalledTimes(18);
 expect(policy.mock.calls.slice(-2).map(c=>[c[1].namespace,c[3].actionType])).toEqual([['ruclip-api-whatsapp-group-send-approvals','memory.write'],['ruclip-api-whatsapp-human-approval-jti','memory.write']]);
 expect(tools[1].cacheable).toBe(false);expect(privateCall).toHaveBeenCalledTimes(2);
 await tools[2].handler({key:'x'});expect(ordinary).toHaveBeenCalledWith('memory_store',{key:'x'},{projectRoot:process.cwd(),serverId:'protected-whatsapp-native'});expect(host.tools).toEqual(['whatsapp_approve_prepare','whatsapp_approve_apply','memory_store']);
});
it('policy denial cancels private work',async()=>{policy.mockResolvedValue({enforcedOutcome:'denied'});createProtectedWhatsAppHttpHost({},()=>({}),{port:8081,tools:['whatsapp_approve_apply']});expect(JSON.parse(await register.mock.calls[0][0][0].handler({}))).toEqual({outcome:'denied',error:'policy_denied'});expect(privateCall).not.toHaveBeenCalled();});
for(const tools of [['all'],['memory'],['whatsapp'],['whatsapp_approve_apply','whatsapp_approve_apply'],['terminal_execute'],['MEMORY_STORE'],[]])it(`rejects broad/unrecognized selection ${JSON.stringify(tools)}`,()=>{expect(()=>createProtectedWhatsAppHttpHost({},()=>({}),{port:8081,tools})).toThrow('invalid_host_scope');expect(register).not.toHaveBeenCalled();});
it('does not return a partly installed instance',()=>{register.mockReturnValue({registered:0,failed:['whatsapp_approve_apply']});expect(()=>createProtectedWhatsAppHttpHost({},()=>({}),{port:8081,tools:['whatsapp_approve_apply']})).toThrow('tool_registration_failed');});

for(const namespace of ['hierarchical:semantic','ruclip-api-whatsapp-group-assignments','ruclip-api-agent-settings','ruclip-api-whatsapp-group-spend','ruclip-api-whatsapp-group-send-approval-requests','ruclip-api-whatsapp-group-send-approvals','ruclip-api-whatsapp-human-approval-jti','ruclip-api-authority'])it(`denied read scope ${namespace} prevents all native work`,async()=>{
 policy.mockImplementation((_n,input, _c, action)=>({enforcedOutcome:input.namespace===namespace && action.namespaceAccess==='read'?'denied':'allowed'}));
 createProtectedWhatsAppHttpHost({},()=>({}),{port:8081,tools:['whatsapp_approve_apply']});
 expect(JSON.parse(await register.mock.calls[0][0][0].handler({}))).toEqual({outcome:'denied',error:'policy_denied'});expect(privateCall).not.toHaveBeenCalled();
});
for(const namespace of ['ruclip-api-whatsapp-group-send-approvals','ruclip-api-whatsapp-human-approval-jti'])it(`denied write scope ${namespace} prevents all native work`,async()=>{
 policy.mockImplementation((_n,input, _c, action)=>({enforcedOutcome:input.namespace===namespace && action.namespaceAccess==='write'?'denied':'allowed'}));
 createProtectedWhatsAppHttpHost({},()=>({}),{port:8081,tools:['whatsapp_approve_apply']});
 expect(JSON.parse(await register.mock.calls[0][0][0].handler({}))).toEqual({outcome:'denied',error:'policy_denied'});expect(privateCall).not.toHaveBeenCalled();
});
