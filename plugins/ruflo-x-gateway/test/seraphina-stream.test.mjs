import test from 'node:test';
import assert from 'node:assert/strict';
import { guidancePrefix, readMessagesStream } from '../src/seraphina-stream.mjs';
const encode = e => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`;
const start = { type:'message_start', message:{ model:'test', usage:{input_tokens:10} } };
const block = { type:'content_block_start', index:0, content_block:{type:'text',text:''} };
const delta = text => ({type:'content_block_delta',index:0,delta:{type:'text_delta',text}});
const end = [{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:20}},{type:'message_stop'}];
const response = events => new Response(new ReadableStream({start(c){for(const byte of new TextEncoder().encode(events.map(encode).join(''))) c.enqueue(Uint8Array.of(byte)); c.close();}}));
test('guidance decodes partial escapes without exposing JSON',()=>{
  assert.equal(guidancePrefix('{"guidance":"hello\\n\\u263a\\'), 'hello\n☺');
  assert.equal(guidancePrefix('{"guidance":"quote \\"x\\"","proposals":[]}'), 'quote "x"');
  assert.equal(guidancePrefix('{"thinking":"private","guidance":"x"}'), '');
});
test('split UTF8 and SSE frames emit cumulative guidance only; thinking never emitted',async()=>{
  const outputs=[]; const result=await readMessagesStream(response([start,
    {type:'content_block_start',index:1,content_block:{type:'thinking',thinking:'secret'}},
    {type:'content_block_delta',index:1,delta:{type:'thinking_delta',thinking:'secret'}},block,
    delta('{"guidance":"Hé'),delta('llo\\nthere","proposals":[],"risks":[]}'),...end]),{onGuidance:t=>outputs.push(t)});
  assert.deepEqual(outputs,['Hé','Héllo\nthere']); assert.equal(result.usage.input_tokens,10); assert.equal(result.usage.output_tokens,20);
});
test('interrupted responses fail rather than report success',async()=>{
  await assert.rejects(readMessagesStream(response([start,block,delta('{"guidance":"partial')])) , /interrupted/);
});
test('upstream error fails and cancels',async()=>{
  await assert.rejects(readMessagesStream(response([{type:'error',error:{message:'private'}}])),/streaming error/);
});
test('cancellation terminates pending reader',async()=>{
  const controller=new AbortController(); let cancelled=false;
  const res=new Response(new ReadableStream({cancel(){cancelled=true;}}));
  const pending=readMessagesStream(res,{signal:controller.signal}); controller.abort();
  await assert.rejects(pending,{name:'AbortError'}); assert.equal(cancelled,true);
});
import { askSeraphina } from '../src/seraphina.mjs';
test('opt in requests streaming, but accepts ordinary JSON fallback',async()=>{
 const original=globalThis.fetch; let body;
 globalThis.fetch=async(_url,opts)=>{body=JSON.parse(opts.body);return new Response(JSON.stringify({content:[{text:'{"guidance":"ok","proposals":[],"risks":[]}'}],stop_reason:'end_turn'}),{headers:{'content-type':'application/json'}});};
 try {const result=await askSeraphina('test',{}, {key:'test',onGuidance:()=>{}}); assert.equal(body.stream,true);assert.equal(result.guidance,'ok');}
 finally {globalThis.fetch=original;}
});
test('streamed truncation fails honestly even if JSON happens to be complete',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>{const r=response([start,block,delta('{"guidance":"partial","proposals":[],"risks":[]}'),{type:'message_delta',delta:{stop_reason:'max_tokens'}},{type:'message_stop'}]);r.headers.set('content-type','text/event-stream');return r;};
 try{const result=await askSeraphina('test',{}, {key:'test',onGuidance:()=>{}});assert.equal(result.degraded,true);assert.equal(result.guidance,'');}
 finally{globalThis.fetch=original;}
});
