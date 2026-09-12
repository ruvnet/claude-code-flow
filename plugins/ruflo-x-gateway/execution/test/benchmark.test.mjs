import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyEvent } from 'nostr-tools/pure';
import { fixtures, expectedArtifact } from '../src/fixtures.mjs';
import { compute } from '../src/worker.mjs';
import { runBenchmark } from '../src/benchmark.mjs';

test('independent oracle agrees on 20 distinct evaluation fixtures', () => {
  const tasks = fixtures();
  assert.equal(new Set(tasks.map(t => t.id)).size, 20);
  for (const task of tasks) assert.deepEqual(compute(task), expectedArtifact(task));
  assert.throws(() => compute({ capability: 'arithmetic', input: { operation: 'eval', numbers: [1] } }));
  assert.throws(() => compute({ capability: 'graph', input: { nodes: 101, source: 0, edges: [] } }));
});

test('signed local three worker execution verifies all 20 artifacts', { timeout: 40000 }, async () => {
  const report = await runBenchmark({ mode: 'fixed' });
  assert.equal(report.verified, 20);
  assert.equal(new Set(report.workerIdentities).size, 3);
  assert.equal(report.participatingWorkers, 3);
  assert.equal(report.outcomes.filter(t => t.artifactHash && t.status === 'completed').length, 20);
  for (const outcome of report.outcomes) {
    assert.equal(verifyEvent(outcome.submissionEnvelope), true);
    assert.equal(verifyEvent(outcome.resultReceipt.envelope), true);
    assert.equal(verifyEvent(outcome.verification.envelope), true);
    assert.equal(outcome.resultReceipt.worker, outcome.worker);
    assert.equal(outcome.verification.artifactHash, outcome.artifactHash);
    assert.notEqual(outcome.verification.verifier, outcome.worker);
  }
});

test('real worker process disconnect recovers after fenced lease expiry', { timeout: 40000 }, async () => {
  const report = await runBenchmark({ mode: 'fixed', fault: 'disconnect' });
  assert.equal(report.verified, 20);
  assert.equal(report.fault.injected, true);
  assert.equal(report.fault.recovered, true);
  assert.ok(report.fault.attempts > 1);
  assert.match(report.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(report.syntheticQuotedCost > 0.20);
});
