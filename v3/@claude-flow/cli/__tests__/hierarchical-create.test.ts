import {afterEach,describe,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TieredMemoryStore} from '../../memory/src/tiered-memory.js';
import * as bridge from '../src/memory/memory-bridge.js';
import {agentdbHierarchicalCreate,agentdbTools} from '../src/mcp-tools/agentdb-tools.js';
import {classifyMcpTool} from '../src/services/policy-runtime.js';
afterEach(()=>vi.restoreAllMocks());
describe('durable protected hierarchical create MCP',()=>{
  it('registers narrow create input and classifies it as a policy-governed memory write',()=>{
    expect(agentdbTools).toContain(agentdbHierarchicalCreate);
    expect(agentdbHierarchicalCreate.inputSchema.required).toEqual(['key','tier','value']);
    expect(classifyMcpTool('agentdb_hierarchical-create')).toMatchObject({actionType:'memory.write',namespaceAccess:'write'});
  });
  it('returns existing bytes without invoking a compatibility store/recall path',()=>{
    const directory=mkdtempSync(join(tmpdir(),'protected-create-'));
    const db=new Database(join(directory,'memory.sqlite'));try{
      const hm=new TieredMemoryStore({db,protectedRetention:{prefixes:[{tier:'semantic',keyPrefix:'ruclip:'}],maxEntries:1}});
      const params={key:'ruclip:member',tier:'semantic',value:'inactive'};
      expect(bridge.createHierarchicalExact(hm,params)).toMatchObject({success:true,status:'created',retention:'protected'});
      vi.spyOn(hm,'store').mockImplementation(()=>{throw new Error('upsert forbidden');});
      expect(bridge.createHierarchicalExact(hm,{...params,value:'active'})).toMatchObject({success:true,status:'existing',entry:{value:'inactive'}});
      expect(bridge.createHierarchicalExact(hm,{...params,key:'ruclip:bob'})).toMatchObject({success:false,error:'protected_capacity_exceeded'});
      for(const unsupported of [null,new TieredMemoryStore(),{getStats:()=>({}),promote:()=>{},store:()=>{throw new Error('native fallback forbidden');}}])expect(bridge.createHierarchicalExact(unsupported,params)).toMatchObject({success:false,status:'unsupported'});
    }finally{db.close();rmSync(directory,{recursive:true,force:true});}
  });
  it('rejects protection, temporal, namespace and overwrite options before dispatch',async()=>{
    const mock=vi.spyOn(bridge,'bridgeHierarchicalCreate').mockResolvedValue({success:true});
    for(const extra of [{protected:true},{namespace:'ruclip'},{supersedes:'old'},{validUntil:'2999-01-01'},{overwrite:true},{value:'x'.repeat(100001)}]){
      expect(await agentdbHierarchicalCreate.handler({key:'ruclip:member',tier:'semantic',value:'inactive',...extra})).toMatchObject({success:false});
    }
    expect(mock).not.toHaveBeenCalled();
    await agentdbHierarchicalCreate.handler({key:'ruclip:member',tier:'semantic',value:'inactive'});
    expect(mock).toHaveBeenCalledWith({key:'ruclip:member',tier:'semantic',value:'inactive'});
  });
});
