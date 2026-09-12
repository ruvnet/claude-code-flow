import { createHash } from 'node:crypto';

/** Runtime bridge: task content cannot select repository policy or the sandbox. */
export function createPatchCapability({ adapter, policies, propose, sandbox }) {
  const trustedPolicies = new Map(Object.entries(policies).map(([repo, policy]) => [repo, structuredClone(policy)]));
  function taskContext(input) {
    if (!input || typeof input.repository !== 'string' || typeof input.baseSha !== 'string' || typeof input.issue?.reference !== 'string' || typeof input.issue?.text !== 'string') throw new Error('Invalid patch task input');
    const policy = trustedPolicies.get(input.repository);
    if (!policy) throw new Error('No trusted patch policy for repository');
    const issue = { reference: input.issue.reference, text: input.issue.text };
    return { repository: input.repository, baseSha: input.baseSha, issue, policy: structuredClone(policy) };
  }
  function checkAbort(signal) { if (signal?.aborted) throw signal.reason ?? new Error('Patch task aborted'); }
  return {
    async handler(task, { signal } = {}) {
      checkAbort(signal);
      const context = taskContext(task.input);
      const artifact = await adapter.proposePatch({ ...context, propose, sandbox });
      checkAbort(signal);
      return artifact;
    },
    async validator({ input, artifact }, { signal } = {}) {
      checkAbort(signal);
      const context = taskContext(input);
      const expected = { repository: context.repository, baseSha: context.baseSha, issueReference: context.issue.reference, issueDigest: createHash('sha256').update(JSON.stringify(context.issue)).digest('hex') };
      const result = await adapter.verifyPatch({ artifact, expected, policy: context.policy, sandbox });
      checkAbort(signal);
      if (result.verified !== true) throw new Error('Patch verification failed');
      return true;
    },
  };
}
