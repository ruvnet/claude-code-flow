// #2894 finding 1: `policy_evaluate` crashed with JSON-RPC -32603
// ("Cannot read properties of undefined (reading 'requestId')") when called
// with a missing/malformed `request` argument — including the exact
// `policy_evaluate {}` repro from the issue. Root cause: the handler cast
// `input.request` straight to `PolicyRequest` with no validation, so a
// missing `request` flowed all the way into
// `AgenticPolicyEngine.evaluate()`, which unconditionally reads
// `request.requestId` on an `undefined` request.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { policyTools } from '../src/mcp-tools/policy-tools.js';

const policyEvaluate = policyTools.find((tool) => tool.name === 'policy_evaluate')!;

describe('#2894 policy_evaluate — missing `request` no longer crashes', () => {
  it('rejects a call with no arguments with a clear validation error, not a TypeError', async () => {
    const root = mkdtempSync(join(tmpdir(), 'policy-evaluate-2894-'));
    try {
      await expect(policyEvaluate.handler({}, { projectRoot: root })).rejects.toThrow(
        /request/i,
      );
      // The historical crash surfaced as this exact TypeError message —
      // assert we no longer produce it.
      await expect(policyEvaluate.handler({}, { projectRoot: root })).rejects.not.toThrow(
        /Cannot read propert(y|ies) of undefined/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects the issue\'s exact "plausible arguments" repro (fields at the top level, not under `request`)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'policy-evaluate-2894-'));
    try {
      await expect(
        policyEvaluate.handler({ action: 'read', resource: 'file' }, { projectRoot: root }),
      ).rejects.not.toThrow(/Cannot read propert(y|ies) of undefined/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still evaluates a well-formed request normally', async () => {
    const root = mkdtempSync(join(tmpdir(), 'policy-evaluate-2894-'));
    try {
      const decision = await policyEvaluate.handler(
        {
          request: {
            identity: { id: 'test-user', type: 'user' },
            action: { type: 'read', resource: 'file' },
          },
        },
        { projectRoot: root },
      );
      expect(decision).toMatchObject({ outcome: expect.any(String) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
