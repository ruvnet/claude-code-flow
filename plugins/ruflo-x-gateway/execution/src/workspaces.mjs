import { mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Coordinator } from './coordinator.mjs';

export const workspaceTag=id=>createHash('sha256').update(id).digest('hex');
/** Configuration is operator-controlled, never a task payload. Each workspace gets a separate authority. */
export class WorkspaceRegistry {
  #entries=new Map();
  constructor({root,workspaces,leaseMs=5000,clock=Date.now}) {
    if(!root || !Array.isArray(workspaces)||!workspaces.length||workspaces.length>100)throw new Error('workspace configuration required');
    this.root=resolve(root);mkdirSync(this.root,{recursive:true,mode:0o700});chmodSync(this.root,0o700);
    const audiences=new Set();
    try {
      for(const config of workspaces) {
        if(typeof config.id!=='string'||! /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(config.id)||this.#entries.has(config.id)||audiences.has(config.audience))throw new Error('unique workspace and audience required');
        audiences.add(config.audience);
        const directory=join(this.root,workspaceTag(config.id));mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
        const {id,audience,controllerPubkey,verifierPubkeys,workerPolicies}=config;
        const coordinator=new Coordinator({dbPath:join(directory,'authority.sqlite'),audience,controllerPubkey,verifierPubkeys,workerPolicies,leaseMs,clock});
        this.#entries.set(id,{id,audience,directory,coordinator,allowed:new Set([controllerPubkey,...verifierPubkeys,...workerPolicies.map(w=>w.pubkey)])});
      }
    }catch(error){this.close();throw error;}
  }
  context(id) {const entry=this.#entries.get(id);if(!entry)throw new Error('unknown workspace');return entry;}
  execute(id,event){return this.context(id).coordinator.execute(event);}
  close(){for(const e of this.#entries.values())e.coordinator.close();this.#entries.clear();}
}
