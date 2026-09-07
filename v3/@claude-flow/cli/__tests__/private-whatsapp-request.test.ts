import {beforeEach,expect,it,vi} from 'vitest';
const {calls}=vi.hoisted(()=>({calls:{claimPrepare:vi.fn(),claimApply:vi.fn(),publishedPrepare:vi.fn(),publishedApply:vi.fn()}}));
vi.mock('../src/memory/whatsapp-request.js',()=>({createNativeWhatsAppRequester:()=>calls}));
import {createPrivateWhatsAppRequestTools} from '../src/mcp-tools/private-whatsapp-request.js';
beforeEach(()=>{for(const f of Object.values(calls)){f.mockReset();f.mockReturnValue({outcome:'unknown',error:'commit_unknown'});}});
it('preserves exact bytes and unknown results through four fixed uncached descriptors',async()=>{
 const tools=createPrivateWhatsAppRequestTools({},()=>({}));expect(tools.map(t=>t.name)).toEqual(['whatsapp_request_claim_prepare','whatsapp_request_claim_apply','whatsapp_request_published_prepare','whatsapp_request_published_apply']);
 for(const [i,t]of tools.entries()){expect(t.cacheable).toBe(false);expect(t.inputSchema).toMatchObject({additionalProperties:false});expect(await t.handler(i%2?{requestJson:'exact',serviceSeal:'seal'}:{requestJson:'exact'})).toEqual({outcome:'unknown',error:'commit_unknown'});}
 for(const f of Object.values(calls))expect(f).toHaveBeenCalledOnce();expect(calls.claimApply).toHaveBeenCalledWith('exact','seal');expect(calls.publishedApply).toHaveBeenCalledWith('exact','seal');
});
for(const value of [{requestJson:'x',namespace:'wide'},{requestJson:'x',serviceSeal:'s',target:'other'},{requestJson:'x'.repeat(262145)},Object.create({requestJson:'x'}),{requestJson:1},null])it('rejects extra/inherited/oversized/nonstring arguments before native dispatch',async()=>{
 const tools=createPrivateWhatsAppRequestTools({},()=>({}));for(const t of tools)expect(await t.handler(value as any)).toEqual({outcome:'denied',error:'invalid_request'});for(const f of Object.values(calls))expect(f).not.toHaveBeenCalled();
});
it('never executes caller property accessors',async()=>{const input={},get=vi.fn(()=>{throw Error();});Object.defineProperty(input,'requestJson',{get,enumerable:true});const [t]=createPrivateWhatsAppRequestTools({},()=>({}));expect(await t.handler(input)).toMatchObject({error:'invalid_request'});expect(get).not.toHaveBeenCalled();});
