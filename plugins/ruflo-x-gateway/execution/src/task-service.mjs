import { constants, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { client } from './client.mjs';
import { startTaskApiServer } from './task-api-server.mjs';

const scopes = ['task:read','task:submit','task:cancel'];
const workspaceSchema=z.object({id:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),audience:z.string().min(1).max(128),controllerSecretKeyFile:z.string().min(1),coordinatorUrl:z.string().url(),tokenFile:z.string().min(1),scopes:z.array(z.enum(scopes)).min(1).default(['task:read'])}).strict();
const configSchema=z.object({host:z.string().default('127.0.0.1'),port:z.number().int().min(0).max(65535).default(0),agentUrl:z.string().url().optional(),allowRemote:z.boolean().default(false),allowedOrigins:z.array(z.string().url()).max(20).default([]),workspaces:z.array(workspaceSchema).min(1).max(100)}).strict();
const digest=text=>createHash('sha256').update(text).digest();
/** Refuse symlinks, oversized files and permissions exposing secrets to another Unix user. */
function privateFile(path,maxBytes=65536){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>maxBytes||(stat.mode&0o077)!==0||(typeof process.getuid==='function'&&stat.uid!==process.getuid()))throw new Error('private file requires owner-only permissions');return readFileSync(fd,'utf8');}finally{closeSync(fd);}}
export function readTaskServiceConfig(configFile){return configSchema.parse(JSON.parse(privateFile(resolve(configFile))));}
/** Configuration selects authority. HTTP bodies cannot choose workspace, keys, URLs or scopes. */
export async function startTaskService(config,{baseDirectory=process.cwd(),requestFactory=({coordinatorUrl,secretKey,audience})=>client(coordinatorUrl,secretKey,audience)}={}){
  const settings=configSchema.parse(config),entries=[],ids=new Set(),audiences=new Set(),tokenHashes=new Set();
  for(const workspace of settings.workspaces){
    if(ids.has(workspace.id)||audiences.has(workspace.audience))throw new Error('duplicate workspace or audience');
    ids.add(workspace.id);audiences.add(workspace.audience);
    const secret=privateFile(resolve(baseDirectory,workspace.controllerSecretKeyFile),256).trim();
    if(!/^[a-fA-F0-9]{64}$/.test(secret))throw new Error('controller key must be 32 byte hex');
    const token=privateFile(resolve(baseDirectory,workspace.tokenFile),1024).trim();
    if(!/^[A-Za-z0-9._~+/-]{32,512}={0,2}$/.test(token))throw new Error('token must have at least 32 secure characters');
    const tokenHash=digest(token),fingerprint=tokenHash.toString('hex');
    if(tokenHashes.has(fingerprint))throw new Error('workspace tokens must be unique');tokenHashes.add(fingerprint);
    const send=requestFactory({...workspace,secretKey:Uint8Array.from(Buffer.from(secret,'hex'))});
    if(typeof send!=='function')throw new Error('request factory must return a function');
    const allowed=new Set(workspace.scopes);
    const request=async(op,data)=>{const scope={task_list:'task:read',task_get:'task:read',submit:'task:submit',cancel:'task:cancel'}[op];if(!scope||!allowed.has(scope))throw new Error('operation denied');return send(op,data);};
    entries.push({tokenHash,workspace:workspace.id,request});
  }
  return startTaskApiServer({...settings,resolveRequest:async req=>{
    const header=req.headers.authorization;
    if(typeof header!=='string'||header.length>1024||!header.startsWith('Bearer '))return null;
    const candidate=digest(header.slice(7));let match;
    for(const entry of entries)if(timingSafeEqual(candidate,entry.tokenHash))match=entry;
    return match?{workspace:match.workspace,request:match.request}:null;
  }});
}

async function main(){if(process.argv.length!==3)throw new Error('Usage: node src/task-service.mjs /absolute/path/config.json');const configPath=resolve(process.argv[2]);const service=await startTaskService(readTaskServiceConfig(configPath),{baseDirectory:dirname(configPath)});process.stdout.write(JSON.stringify({listening:service.url,console:`${service.url}/console`})+'\n');let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await service.close();};process.once('SIGINT',stop);process.once('SIGTERM',stop);}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{process.stderr.write('Task service startup failed. Check private configuration, credentials and binding.\n');process.exitCode=1;});
