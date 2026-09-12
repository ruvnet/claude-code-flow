import { constants, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPublicKey } from 'nostr-tools/pure';
import { z } from 'zod';
import { WorkspaceRegistry } from './workspaces.mjs';
import { createRelayAuthority } from './relay.mjs';

const pubkey=z.string().regex(/^[a-f0-9]{64}$/);
const identifier=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$/);
const policy=z.object({pubkey,capabilities:z.array(identifier).min(1).max(32),cost:z.number().finite().min(0).max(1e6)}).strict();
const schema=z.object({stateRoot:z.string().min(1),relayUrl:z.string().url(),canonicalRelay:z.string().url().optional(),leaseMs:z.number().int().min(50).max(300000).default(5000),workspaces:z.array(z.object({id:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),audience:identifier,controllerPubkey:pubkey,verifierPubkeys:z.array(pubkey).min(1).max(100),workerPolicies:z.array(policy).min(1).max(100),transportSecretKeyFile:z.string().min(1)}).strict()).min(1).max(100)}).strict();
function privateRead(path,limit){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=fstatSync(fd);if(!st.isFile()||st.size>limit||(st.mode&0o077)!==0||(typeof process.getuid==='function'&&st.uid!==process.getuid()))throw new Error('owner-only regular file required');return readFileSync(fd,'utf8');}finally{closeSync(fd);}}
function relayURL(value){const u=new URL(value);if(u.protocol!=='wss:'||u.username||u.password||u.hash)throw new Error('TLS relay URL required');return u.href;}
export function readFederationConfig(path){return schema.parse(JSON.parse(privateRead(resolve(path),65536)));}
export async function startFederationService(config,{baseDirectory=process.cwd(),registryFactory=options=>new WorkspaceRegistry(options),authorityFactory=createRelayAuthority}={}){
 const settings=schema.parse(config);relayURL(settings.relayUrl);if(settings.canonicalRelay)relayURL(settings.canonicalRelay);
 const ids=new Set(),audiences=new Set(),transportKeys=new Set();
 const workspaces=settings.workspaces.map(w=>{if(ids.has(w.id)||audiences.has(w.audience))throw new Error('duplicate workspace or audience');ids.add(w.id);audiences.add(w.audience);const hex=privateRead(resolve(baseDirectory,w.transportSecretKeyFile),256).trim();if(!/^[a-fA-F0-9]{64}$/.test(hex))throw new Error('transport key must be 32 byte hex');const secretKey=Uint8Array.from(Buffer.from(hex,'hex'));const publicKey=getPublicKey(secretKey);const roles=[w.controllerPubkey,...w.verifierPubkeys,...w.workerPolicies.map(p=>p.pubkey)];if(new Set(roles).size!==roles.length||roles.includes(publicKey)||transportKeys.has(publicKey))throw new Error('transport, controller, verifier and worker identities must be separate');transportKeys.add(publicKey);return {...w,secretKey,transportPubkey:publicKey};});
 let registry;const authorities=[];let closed=false;
 const close=async()=>{if(closed)return;closed=true;const results=await Promise.allSettled(authorities.map(a=>Promise.resolve().then(()=>a.close())));try{registry?.close();}finally{if(results.some(r=>r.status==='rejected'))throw new Error('authority shutdown failed');}};
 try{registry=registryFactory({root:resolve(baseDirectory,settings.stateRoot),leaseMs:settings.leaseMs,workspaces:workspaces.map(({secretKey,transportSecretKeyFile,transportPubkey,...w})=>w)});for(const w of workspaces)authorities.push(await authorityFactory({registry,workspace:w.id,secretKey:w.secretKey,relayUrl:settings.relayUrl,canonicalRelay:settings.canonicalRelay}));return {workspaces:workspaces.map(w=>({id:w.id,coordinatorPubkey:w.transportPubkey})),close};}catch(error){await close().catch(()=>{});throw error;}
}
async function main(){if(process.argv.length!==3)throw new Error('Usage: node src/federation-service.mjs /absolute/path/config.json');const path=resolve(process.argv[2]);const service=await startFederationService(readFederationConfig(path),{baseDirectory:dirname(path)});process.stdout.write(JSON.stringify({connected:true,workspaces:service.workspaces})+'\n');let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;try{await service.close();}catch{process.exitCode=1;}};process.once('SIGINT',stop);process.once('SIGTERM',stop);}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{process.stderr.write('Federation service startup failed. Check private configuration, identities and relay connectivity.\n');process.exitCode=1;});
