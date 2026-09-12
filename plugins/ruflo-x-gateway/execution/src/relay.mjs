import WebSocket from 'ws';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { command } from './client.mjs';
import { workspaceTag } from './workspaces.mjs';

const TOPIC='ruflo-execution-v1', MAX_CONTENT=24576, RESPONSE_MAX=512*1024;
const sha=value=>createHash('sha256').update(value).digest('hex');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const pk=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
function endpoint(url,local) {
  const u=new URL(url);
  if(u.username||u.password||u.hash|| !(['wss:'].includes(u.protocol)||(local&&u.protocol==='ws:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname))))throw new Error('TLS relay required; insecure loopback is test-only');
  return u.toString();
}

/** NIP-42 authenticated transport, NIP-44 encrypted messages, raw envelope verification. */
export class RelayPeer extends EventEmitter {
  constructor({relayUrl,canonicalRelay=relayUrl,secretKey,workspace,allowedSenders,allowInsecureLocal=false,timeoutMs=5000}) {
    super();this.url=endpoint(relayUrl,allowInsecureLocal);this.canonical=endpoint(canonicalRelay,allowInsecureLocal);
    if(!workspace||!Array.isArray(allowedSenders)||!allowedSenders.every(pk)||!Number.isFinite(timeoutMs)||timeoutMs<100||timeoutMs>15000)throw new Error('invalid relay config');
    this.key=secretKey;this.pubkey=getPublicKey(secretKey);this.tag=workspaceTag(workspace);this.allowed=new Set(allowedSenders);
    this.timeoutMs=timeoutMs;this.stopped=false;this.ws=null;this.connecting=null;this.pending=new Map();this.seen=new Map();this.reconnectTimer=null;
  }
  async start() {
    if(this.stopped)throw new Error('peer closed');
    if(this.ws?.readyState===WebSocket.OPEN && this.authenticated)return;
    if(this.connecting)return this.connecting;
    this.connecting=new Promise((resolve,reject)=>{
      const ws=new WebSocket(this.url,{perMessageDeflate:false,maxPayload:128*1024});this.ws=ws;this.authenticated=false;
      let authId=null,settled=false;const subId=`exec-${randomUUID()}`;
      const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
      const timer=setTimeout(()=>{finish(new Error('relay authentication timeout'));ws.terminate();},this.timeoutMs);
      ws.on('message',buffer=>{
        try {
          const m=JSON.parse(buffer.toString('utf8'));
          if(!Array.isArray(m))return;
          if(m[0]==='AUTH'&&typeof m[1]==='string'&&m[1].length<=4096&&!this.authenticated) {
            const ev=finalizeEvent({kind:22242,created_at:Math.floor(Date.now()/1000),tags:[['relay',this.canonical],['challenge',m[1]]],content:''},this.key);
            authId=ev.id;ws.send(JSON.stringify(['AUTH',ev]));
          }else if(m[0]==='OK'&&typeof authId==='string'&&m[1]===authId&&!this.authenticated) {
            if(m[2]!==true){finish(new Error('relay authentication rejected'));ws.close();return;}
            this.authenticated=true;ws.send(JSON.stringify(['REQ',subId,{kinds:[1],'#t':[TOPIC],'#p':[this.pubkey],'#d':[this.tag],since:Math.floor(Date.now()/1000)-30,limit:500}]));finish();
          }else if(m[0]==='OK'&&this.pending.has(m[1])) {
            const p=this.pending.get(m[1]);this.pending.delete(m[1]);clearTimeout(p.timer);m[2]===true?p.resolve(m[1]):p.reject(new Error('relay rejected event'));
          }else if(m[0]==='EVENT'&&m[1]===subId&&this.authenticated) {
            const ev=m[2];if(!ev||ev.kind!==1||!pk(ev.pubkey)||!this.allowed.has(ev.pubkey)||!verifyEvent(ev)||Math.abs(ev.created_at*1000-Date.now())>60000||typeof ev.content!=='string'||ev.content.length>65536)return;
            if(JSON.stringify(ev.tags)!==JSON.stringify([['t',TOPIC],['p',this.pubkey],['d',this.tag]]))return;
            const now=Date.now();for(const [id,at]of this.seen)if(at<now-61000)this.seen.delete(id);
            if(this.seen.has(ev.id)||this.seen.size>=10000)return;
            const clear=nip44.v2.decrypt(ev.content,nip44.v2.utils.getConversationKey(this.key,ev.pubkey));
            if(Buffer.byteLength(clear)>MAX_CONTENT)return;
            const body=JSON.parse(clear);this.seen.set(ev.id,now);this.emit('message',{sender:ev.pubkey,event:ev,body});
          }
        }catch{this.emit('discarded');}
      });
      ws.on('error',()=>{finish(new Error('relay connection failed'));});
      ws.on('close',()=>{
        if(this.ws===ws){this.authenticated=false;this.ws=null;}
        finish(new Error('relay disconnected'));
        for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('relay disconnected'));}this.pending.clear();
        if(!this.stopped&&!this.reconnectTimer)this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;this.start().catch(()=>{});},250);
      });
    }).finally(()=>{this.connecting=null;});
    return this.connecting;
  }
  async send(recipient,body) {
    if(!pk(recipient))throw new Error('invalid recipient');
    const clear=JSON.stringify({...body,transportNonce:randomUUID()});if(Buffer.byteLength(clear)>MAX_CONTENT)throw new Error('relay message too large');
    await this.start();
    const content=nip44.v2.encrypt(clear,nip44.v2.utils.getConversationKey(this.key,recipient));
    const ev=finalizeEvent({kind:1,created_at:Math.floor(Date.now()/1000),tags:[['t',TOPIC],['p',recipient],['d',this.tag]],content},this.key);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(ev.id);reject(new Error('relay publish timeout'));},this.timeoutMs);
      this.pending.set(ev.id,{resolve,reject,timer});
      try{this.ws.send(JSON.stringify(['EVENT',ev]));}catch(error){clearTimeout(timer);this.pending.delete(ev.id);reject(error);}
    });
  }
  close() {
    this.stopped=true;clearTimeout(this.reconnectTimer);this.reconnectTimer=null;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('peer closed'));}this.pending.clear();
    this.ws?.terminate();this.removeAllListeners();
  }
}

export async function createRelayAuthority({registry,workspace,secretKey,relayUrl,canonicalRelay,allowInsecureLocal=false}) {
  const context=registry.context(workspace);
  const peer=new RelayPeer({relayUrl,canonicalRelay,secretKey,workspace,allowedSenders:[...context.allowed],allowInsecureLocal});
  const wakes=new EventEmitter();wakes.setMaxListeners(110);let inFlight=0;
  peer.on('message',({sender,body})=>{
    if(body?.type!=='command'||inFlight>=100)return;
    const inner=body.event;
    if(!inner||inner.pubkey!==sender||!pk(inner.id))return;
    inFlight++;
    (async()=>{
      let response;
      try{
        const value=registry.execute(workspace,inner),op=JSON.parse(inner.content).op;
        if(op==='wait'&&!value.ready)await new Promise(resolve=>{
          const finish=()=>{clearTimeout(timer);wakes.off('work',finish);resolve();};const timer=setTimeout(finish,1000);wakes.once('work',finish);
        });
        else if(['assign','cancel','verify'].includes(op))wakes.emit('work');
        response={ok:true,value};
      }catch(error){response={ok:false,error:error.message};}
      let bytes=Buffer.from(JSON.stringify(response));
      if(bytes.length>RESPONSE_MAX)bytes=Buffer.from(JSON.stringify({ok:false,error:'response exceeds transport limit; use paginated task_list'}));
      const total=Math.ceil(bytes.length/8192),digest=sha(bytes);
      for(let part=0;part<total;part++)await peer.send(sender,{type:'response',requestId:inner.id,part,total,digest,chunk:bytes.subarray(part*8192,(part+1)*8192).toString('base64')});
    })().catch(()=>{}).finally(()=>{inFlight--;});
  });
  try{await peer.start();}catch(error){peer.close();throw error;}
  return {peer,coordinatorPubkey:peer.pubkey,close:()=>{wakes.emit('work');peer.close();}};
}

export async function createRelayClient({relayUrl,canonicalRelay,secretKey,workspace,audience,coordinatorPubkey,allowInsecureLocal=false,timeoutMs=10000}) {
  if(!pk(coordinatorPubkey)||!Number.isFinite(timeoutMs)||timeoutMs<100||timeoutMs>15000)throw new Error('invalid client config');
  const peer=new RelayPeer({relayUrl,canonicalRelay,secretKey,workspace,allowedSenders:[coordinatorPubkey],allowInsecureLocal});
  const pending=new Map();
  peer.on('message',({body})=>{
    const p=pending.get(body?.requestId);if(!p||body.type!=='response')return;
    if(!Number.isInteger(body.total)||body.total<1||body.total>64||!Number.isInteger(body.part)||body.part<0||body.part>=body.total||!pk(body.digest)||typeof body.chunk!=='string'||body.chunk.length>11000)return;
    if(p.digest && (p.digest!==body.digest||p.total!==body.total))return;
    p.digest=body.digest;p.total=body.total;p.parts.set(body.part,Buffer.from(body.chunk,'base64'));
    if(p.parts.size!==p.total)return;
    const bytes=Buffer.concat(Array.from({length:p.total},(_,i)=>p.parts.get(i)));
    if(bytes.length>RESPONSE_MAX||sha(bytes)!==p.digest)return;
    try{const response=JSON.parse(bytes.toString('utf8'));pending.delete(body.requestId);clearTimeout(p.timer);response.ok?p.resolve(response.value):p.reject(new Error(response.error));}catch{p.reject(new Error('invalid relay response'));}
  });
  try{await peer.start();}catch(error){peer.close();throw error;}
  const request=async(op,data={})=>{
    if(pending.size>=100)throw new Error('client concurrency limit');
    const event=command(secretKey,audience,op,data);
    for(let attempt=0;attempt<2;attempt++){
      try{return await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(event.id);reject(new Error('relay response timeout'));},timeoutMs);
        pending.set(event.id,{resolve,reject,timer,parts:new Map()});
        peer.send(coordinatorPubkey,{type:'command',event}).catch(error=>{const p=pending.get(event.id);if(p){clearTimeout(p.timer);pending.delete(event.id);p.reject(error);}});
      });}catch(error){if(attempt||!/timeout|disconnect|connection/.test(error.message))throw error;await delay(300);}
    }
  };
  return {request,peer,close:()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('client closed'));}pending.clear();peer.close();}};
}
