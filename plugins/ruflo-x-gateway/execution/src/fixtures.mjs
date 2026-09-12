/** Synthetic deterministic evaluation data. Never used to train routing. */
export const capabilities = ['arithmetic', 'sort', 'graph'];
export function fixtures() {
  return Array.from({ length: 20 }, (_, i) => {
    const capability = capabilities[i % 3];
    const input = capability === 'arithmetic' ? { numbers: [i, -3, 7, i * 2], operation: i % 2 ? 'sum' : 'sumSquares' }
      : capability === 'sort' ? { numbers: [i, 4, -i, 4, 0, 19 - i] }
      : { nodes: 6, source: i % 6, edges: [[0, 1], [1, 2], [2, 3], [0, 4], [4, 3], [3, 5]] };
    return { id: `eval-${String(i).padStart(2, '0')}`, capability, input,
      vector: Array.from({ length: 8 }, (_, j) => j === i % 3 ? 1 : 0), budget: 1, maxAttempts: 3 };
  });
}
/** Independent oracle: arithmetic uses dot products, sorting insertion sort,
 * graph uses repeated edge relaxation instead of the worker's BFS. */
export function expectedArtifact(task) {
  const { input, capability } = task;
  if (capability === 'arithmetic') {
    let value = 0;
    for (const n of input.numbers) value += n * (input.operation === 'sumSquares' ? n : 1);
    return { value };
  }
  if (capability === 'sort') {
    const values = [];
    for (const n of input.numbers) {
      let i = 0;
      while (i < values.length && values[i] <= n) i++;
      values.splice(i, 0, n);
    }
    return { values };
  }
  if (capability === 'graph') {
    const distances = Array(input.nodes).fill(Infinity);
    distances[input.source] = 0;
    for (let round = 0; round < input.nodes; round++) {
      for (const [a, b] of input.edges) {
        distances[b] = Math.min(distances[b], distances[a] + 1);
        distances[a] = Math.min(distances[a], distances[b] + 1);
      }
    }
    return { distances: distances.map(n => Number.isFinite(n) ? n : null) };
  }
  throw new Error('unsupported capability');
}
