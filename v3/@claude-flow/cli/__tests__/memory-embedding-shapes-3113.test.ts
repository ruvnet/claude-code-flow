import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeEmbeddingOutput } from '../src/memory/embedding-output.js';

describe('ReasoningBank embedding result shapes (#3113, #3114)', () => {
  it('registers computeEmbedding as a callable model', () => {
    const initializerPath = fileURLToPath(
      new URL('../src/memory/memory-initializer.ts', import.meta.url),
    );
    const source = readFileSync(initializerPath, 'utf8');

    expect(source).toContain('model: (text: string) => reasoningBank.computeEmbedding(text)');
    expect(source).not.toContain('model: { embed: reasoningBank.computeEmbedding }');
  });

  it.each([
    ['plain arrays', [0.25, -0.5]],
    ['typed arrays', new Float32Array([0.25, -0.5])],
    ['transformers data', { data: new Float32Array([0.25, -0.5]) }],
  ])('accepts non-empty %s', (_description, output) => {
    expect(normalizeEmbeddingOutput(output)).toEqual([0.25, -0.5]);
  });

  it.each([
    ['empty arrays', []],
    ['empty typed arrays', new Float32Array()],
    ['DataView values', new DataView(new ArrayBuffer(8))],
  ])('rejects %s so callers retain hash fallback', (_description, output) => {
    expect(normalizeEmbeddingOutput(output)).toBeNull();
  });
});
