/** Fixed regression witnesses for reviewed historical modules, never generated candidates. */
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

export function probe(api, id) {
  const observations = [];
  const check = (name, fn) => {
    try { const result = fn(); observations.push({ name, passed: result.passed, actual: result.actual }); }
    catch (error) { observations.push({ name, passed: false, error: error.message }); }
  };
  const input = {
    now: 1700000000000, lineageId: '00000000-0000-7000-8000-000000000001',
    evaluationRunId: '00000000-0000-7000-8000-000000000002',
    baselineRef: api.policyCandidateId({ alpha: 0.5 }), candidatePolicy: { alpha: 0.3 },
    safetyEnvelopeRef: 'sha256:calibration-only', corpusVersion: 'public-regression/v1', corpusHash: 'sha256:calibration',
    baselineScore: 0.5, candidateScore: 0.65, heldOutDeltas: [0.1, 0.12, 0.2, 0.08, 0.15, 0.11],
    frozenAnchorRegression: 0, gates: { heldOut: true }, bootstrapIterations: 500,
  };
  const errors = receipt => api.verifyFlywheelReceipt(receipt).errors.filter(e => e !== 'receipt is unsigned');
  const rebuild = receipt => { const { receiptId, ...base } = receipt.payload; receipt.payload.receiptId = api.sha256Ref(api.canonicalizeJcs(base)); return receipt; };
  check('valid-receipt-integrity', () => { const actual = errors(api.createFlywheelReceipt(input)); return { passed: actual.length === 0, actual }; });
  check('content-tampering-rejected', () => { const r = api.createFlywheelReceipt(input); r.payload.corpusVersion = 'tampered'; const actual = errors(r); return { passed: actual.includes('receipt content ID mismatch'), actual }; });
  if (id === 'receipt-fractions') {
    check('fractional-policy-is-decimal-string', () => { const actual = api.createFlywheelReceipt(input).payload.candidatePolicy.alpha; return { passed: actual === '0.3', actual }; });
    check('raw-and-encoded-policy-have-same-id', () => { const actual = [api.policyCandidateId({ alpha: 0.3 }), api.policyCandidateId({ alpha: '0.3' })]; return { passed: actual[0] === actual[1], actual }; });
    check('nested-fractions-encoded', () => { const actual = api.createFlywheelReceipt({ ...input, candidatePolicy: { nested: [1, 0.25] } }).payload.candidatePolicy; return { passed: JSON.stringify(actual) === '{"nested":[1,"0.25"]}', actual }; });
  } else if (id === 'receipt-roundtrip') {
    check('nonterminating-decimal-roundtrip', () => { const r = api.createFlywheelReceipt({ ...input, candidateScore: 0.7687083333333332, heldOutDeltas: [0.2687083333333332, 0.26870833333333326, 0.2687083333333333, 0.2687083333333331] }); const actual = errors(r); return { passed: actual.length === 0 && r.payload.candidateScore === '0.768708333333', actual }; });
  } else if (id === 'receipt-unknown-fields') {
    check('unknown-payload-field-rejected', () => { const r = api.createFlywheelReceipt(input); r.payload.extra = 'not in contract'; const actual = errors(rebuild(r)); return { passed: actual.includes('unknown field: payload.extra') && !actual.includes('receipt content ID mismatch'), actual }; });
    check('unknown-nested-field-rejected', () => { const r = api.createFlywheelReceipt(input); r.payload.statistics.extra = 1; const actual = errors(rebuild(r)); return { passed: actual.includes('unknown field: payload.statistics.extra'), actual }; });
  } else throw Error('unknown witness');
  return observations;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const start = performance.now(), cpu = process.cpuUsage();
  const api = await import('./flywheel-receipt.mjs');
  const observations = probe(api, process.argv[2]);
  console.log(JSON.stringify({ observations, elapsedMs: performance.now() - start, cpuMicros: process.cpuUsage(cpu), maxRssKb: process.resourceUsage().maxRSS }));
}
