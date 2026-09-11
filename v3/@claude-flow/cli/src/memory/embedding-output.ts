/** Normalize the output shapes returned by the supported local embedders. */
export function normalizeEmbeddingOutput(output: unknown): number[] | null {
  const data = output && typeof output === 'object' && 'data' in output
    ? (output as { data?: unknown }).data
    : output;

  if (Array.isArray(data)) {
    return data.length > 0 ? data : null;
  }

  if (ArrayBuffer.isView(data) && !(data instanceof DataView)) {
    const embedding = Array.from(data as unknown as ArrayLike<number>);
    return embedding.length > 0 ? embedding : null;
  }

  return null;
}
