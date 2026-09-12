import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateCandidate,cohortIssues} from '../src/evaluation.mjs';

test('evaluation holds absent or invalid evidence and cannot grant promotion',()=>{
  const result=evaluateCandidate({baseline:[],candidate:[]});
  assert.equal(result.decision,'hold');assert.ok(result.reasons.includes('insufficient repeated runs'));
  assert.match(result.authority,/external authorization/);
  assert.throws(()=>evaluateCandidate({baseline:[],candidate:[],minRuns:1}),/policy/);
  assert.throws(()=>evaluateCandidate({baseline:[{}],candidate:[]}),/20 outcomes/);
});


test('one candidate cannot mix builds, modes or runtime environments',()=>{
  const baseline={mode:'fixed',sourceFingerprint:'a',runtime:'v24',platform:'linux/x64'};
  const candidate={...baseline,mode:'ruvector',sourceFingerprint:'b'};
  assert.deepEqual(cohortIssues([baseline],[candidate]),[]);
  assert.ok(cohortIssues([baseline],[candidate,{...candidate,sourceFingerprint:'c'}]).some(s=>s.includes('candidate mixes')));
  assert.ok(cohortIssues([baseline],[{...candidate,platform:'darwin/arm64'}]).includes('environment mismatch'));
});
