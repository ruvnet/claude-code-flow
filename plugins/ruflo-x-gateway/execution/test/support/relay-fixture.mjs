import { WebSocketServer, WebSocket } from 'ws';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { verifyEvent } from 'nostr-tools/pure';

/** Local protocol fixture, no external relay or membership changes. */
export async function mockRelay(t,{nullAck=false}={}) {
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  const url=`ws://127.0.0.1:${server.address().port}/`;
  const records=[],sessions=new Map();let authentications=0;
  server.on('connection',ws=>{
    const challenge=randomUUID();sessions.set(ws,{challenge,filters:[]});
    ws.send(JSON.stringify(nullAck?['OK',null,true]:['AUTH',challenge]));
    ws.on('message',raw=>{
      const m=JSON.parse(raw.toString()),session=sessions.get(ws);
      if(m[0]==='AUTH') {
        const e=m[1];const valid=verifyEvent(e)&&e.kind===22242&&JSON.stringify(e.tags)===JSON.stringify([['relay',url],['challenge',challenge]]);
        if(valid){session.pubkey=e.pubkey;authentications++;}ws.send(JSON.stringify(['OK',e.id,valid]));
      }else if(m[0]==='REQ'&&session.pubkey){session.filters.push({id:m[1],filter:m[2]});ws.send(JSON.stringify(['EOSE',m[1]]));}
      else if(m[0]==='EVENT'&&session.pubkey){const e=m[1];if(!verifyEvent(e)||e.pubkey!==session.pubkey)return;records.push(e);deliver(e);ws.send(JSON.stringify(['OK',e.id,true]));}
    });
    ws.on('close',()=>sessions.delete(ws));
  });
  function deliver(event){for(const [ws,s]of sessions)for(const {id,filter}of s.filters){if(ws.readyState!==WebSocket.OPEN)continue;if(filter.kinds&&!filter.kinds.includes(event.kind))continue;if(Object.entries(filter).some(([k,values])=>k.startsWith('#')&&!event.tags.some(tag=>tag[0]===k.slice(1)&&values.includes(tag[1]))))continue;ws.send(JSON.stringify(['EVENT',id,event]));}}
  t.after(async()=>{for(const ws of server.clients)ws.terminate();await new Promise(r=>server.close(r));});
  return {url,records,deliver,get authentications(){return authentications;},disconnect(){for(const ws of server.clients)ws.terminate();}};
}
