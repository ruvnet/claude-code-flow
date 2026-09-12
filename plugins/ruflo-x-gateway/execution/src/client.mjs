import { randomUUID } from 'node:crypto';
import { finalizeEvent } from 'nostr-tools/pure';

export function command(secretKey, audience, op, data = {}, {requestId = randomUUID(), now = Date.now()} = {}) {
  return finalizeEvent({kind:27235, created_at:Math.floor(now/1000), tags:[['d',audience]],
    content:JSON.stringify({op,requestId,data})}, secretKey);
}
export function client(base, secretKey, audience) {
  const url = new URL(base);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('proof client requires loopback HTTP');
  return async (op, data = {}) => {
    const response = await fetch(new URL('/command', url), {method:'POST', redirect:'error',headers:{'content-type':'application/json'},
      body:JSON.stringify(command(secretKey,audience,op,data)),signal:AbortSignal.timeout(10000)});
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
    return value;
  };
}
