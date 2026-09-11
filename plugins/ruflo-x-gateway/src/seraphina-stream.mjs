// Decode only the first JSON field, never raw model output or thinking blocks.
export function guidancePrefix(raw) {
  const match = /^\s*(?:```(?:json)?\s*)?\{\s*"guidance"\s*:\s*"/.exec(raw);
  if (!match) return '';
  let encoded = '';
  for (let i = match[0].length; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') break;
    if (c === '\\') {
      if (i + 1 >= raw.length) break;
      const length = raw[i + 1] === 'u' ? 6 : 2;
      if (i + length > raw.length) break;
      encoded += raw.slice(i, i + length); i += length - 1;
    } else encoded += c;
  }
  try { return JSON.parse(`"${encoded}"`).replace(/[\uD800-\uDBFF]$/, ''); }
  catch { return ''; }
}

export async function readMessagesStream(response, { onGuidance, signal } = {}) {
  if (!response.body) throw new Error('meta-llm: missing response stream');
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  const blocks = new Map(); let buffer = '', raw = '', last = '', stopped = false, size = 0;
  const data = { content: [], usage: {} };
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  async function frame(value) {
    const payload = value.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!payload) return;
    const e = JSON.parse(payload);
    if (e.type === 'error') throw new Error('meta-llm: upstream streaming error');
    if (e.type === 'message_start') { data.model = e.message?.model; Object.assign(data.usage, e.message?.usage); }
    if (e.type === 'content_block_start') {
      blocks.set(e.index, e.content_block?.type);
      if (e.content_block?.type === 'text') raw += e.content_block.text || '';
    }
    if (e.type === 'content_block_delta' && blocks.get(e.index) === 'text' && e.delta?.type === 'text_delta') raw += e.delta.text || '';
    if (e.type === 'message_delta') { data.stop_reason = e.delta?.stop_reason; Object.assign(data.usage, e.usage); }
    if (e.type === 'message_stop') stopped = true;
    const guidance = guidancePrefix(raw);
    if (guidance && guidance !== last) { last = guidance; await onGuidance?.(guidance); }
  }
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) throw new Error('meta-llm: stream exceeds size limit');
      buffer += decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        await frame(buffer.slice(0, match.index).replace(/\r\n/g, '\n'));
        buffer = buffer.slice(match.index + match[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await frame(buffer.replace(/\r\n/g, '\n'));
    if (!stopped || !data.stop_reason) throw new Error('meta-llm: interrupted response stream');
    data.content = [{ type: 'text', text: raw }];
    return data;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
