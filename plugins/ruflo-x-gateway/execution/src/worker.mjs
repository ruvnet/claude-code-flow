import { client } from './client.mjs';
import { pathToFileURL } from 'node:url';

/** Allowlisted, bounded computation only; no eval, shell, or external fetch. */
export function compute(task) {
  const { input, capability } = task;
  if (capability === 'arithmetic' || capability === 'sort') {
    if (!Array.isArray(input.numbers) || input.numbers.length > 1000 || !input.numbers.every(Number.isSafeInteger)) throw new Error('invalid numbers');
    if (capability === 'sort') return { values: [...input.numbers].sort((a, b) => a - b) };
    if (!['sum', 'sumSquares'].includes(input.operation)) throw new Error('invalid operation');
    const value = input.numbers.map(n => input.operation === 'sumSquares' ? n ** 2 : n).reduce((a, b) => a + b, 0);
    if (!Number.isSafeInteger(value)) throw new Error('unsafe result');
    return { value };
  }
  if (capability === 'graph') {
    if (!Number.isInteger(input.nodes) || input.nodes < 1 || input.nodes > 100 || !Number.isInteger(input.source) || input.source < 0 || input.source >= input.nodes || !Array.isArray(input.edges) || input.edges.length > 1000) throw new Error('invalid graph');
    const neighbors = Array.from({ length: input.nodes }, () => []);
    for (const edge of input.edges) {
      if (!Array.isArray(edge) || edge.length !== 2 || !edge.every(n => Number.isInteger(n) && n >= 0 && n < input.nodes)) throw new Error('invalid edge');
      const [a, b] = edge; neighbors[a].push(b); neighbors[b].push(a);
    }
    const distances = Array(input.nodes).fill(null), queue = [input.source]; distances[input.source] = 0;
    for (let p = 0; p < queue.length; p++) for (const next of neighbors[queue[p]]) if (distances[next] === null) { distances[next] = distances[queue[p]] + 1; queue.push(next); }
    return { distances };
  }
  throw new Error('unsupported capability');
}

async function start(config) {
  const url = new URL(config.base);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('local benchmark endpoint required');
  const request = client(config.base, Uint8Array.from(config.secretKey), config.audience);
  await request('register', { capabilities: config.capabilities });
  process.send?.({ type: 'ready' });
  let stopped = false;
  process.on('message', m => { if (m.type === 'stop') stopped = true; });
  process.on('disconnect', () => process.exit(0));
  while (!stopped) {
    await request('heartbeat');
    const { task } = await request('pull');
    if (task) {
      const artifact = compute(task);
      await request('result', { taskId: task.id, epoch: task.epoch, inputHash: task.inputHash, artifact });
      process.send?.({ type: 'submitted', taskId: task.id });
    } else await request('wait');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.once('message', config => start(config).then(() => process.exit(0)).catch(error => {
    process.send?.({ type: 'error', message: error.message }); process.exit(1);
  }));
}
