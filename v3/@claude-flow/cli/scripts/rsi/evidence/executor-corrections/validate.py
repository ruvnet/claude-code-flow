"""Source-bound engineering verification, never candidate or hypothesis execution.

Run from the repository root with Python 3 and Node 24.19.0 available.
The existing output directory may contain this script only. Results/reservations
are exclusive; use a separate reviewed copy for reproduction, never overwrite.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

HERE = Path(__file__).resolve().parent
ROOT = Path.cwd()
PREFIX = 'v3/@claude-flow/cli/scripts/rsi/'
SOURCE = '4700668961efbddbdf0d0b895923d79aeb2115ce'
TREE = 'd93b8003f188daf4dd9ea03bdbfecb60cdab6e85'
ANCHOR = 'c5c6da0b728c52414f2dff86f9d23121776d600defff0f214f1502a091f69088'
HEAD = '5a0e219e871fcf616209807c828c5793c29752f8d190fc38a0bc95e4db88422e'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def durable(name, value):
    data = json.dumps(value, indent=2).encode() + b'\n'
    with (HERE / name).open('xb') as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())
    fd = os.open(HERE, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def ledger_bytes():
    return {p.name: digest(p.read_bytes()) for p in sorted((ROOT / PREFIX / 'evidence/loop-development').glob('[0-9]*.json'))}

tests = sorted(str(p.relative_to(ROOT)) for p in (ROOT / PREFIX).rglob('*.test.mjs'))
commands = [
    ['node', '--test', '--test-reporter=tap', *tests],
    ['node', PREFIX + 'loop/replay-history.mjs', PREFIX + 'evidence/loop-development', HEAD],
]
before = ledger_bytes()
events = [json.loads(p.read_text()) for p in sorted((ROOT / PREFIX / 'evidence/loop-development').glob('[0-9]*.json'))]
assert any(event['hash'] == ANCHOR for event in events)
reservation = {
    'schema': 'ruflo.executor-correction-validation-reservation/v1',
    'sourceCommit': SOURCE, 'sourceTree': TREE,
    'validationScriptSha256': digest(Path(__file__).read_bytes()),
    'commands': commands, 'ledgerFiles': before, 'originalAnchor': ANCHOR,
    'reservedParentSpawnAttempts': len(commands), 'reservedParentWaitMs': 240000,
    'scope': 'FOCUSED_TESTS_AND_HISTORICAL_REPLAY_ONLY',
    'descendantProcessStarts': None, 'retainOnInterruption': True,
    'missionBudgetChanged': False, 'candidateExecutionEnabled': False,
}
durable('reservation.json', reservation)
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == SOURCE
assert subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], text=True).strip() == TREE
assert subprocess.check_output(['node', '-p', 'process.version'], text=True).strip() == 'v24.19.0'
assert subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--', PREFIX + 'repair', PREFIX + 'loop']).returncode == 0

rows = []
for index, args in enumerate(commands):
    started = time.perf_counter()
    with (HERE / f'{index}.stdout.txt').open('xb') as stdout, (HERE / f'{index}.stderr.txt').open('xb') as stderr:
        # All descendant work here is existing engineering tests or exact replay.
        # The executor tests simulate children and launch no isolation probes.
        try:
            result = subprocess.run(args, stdout=stdout, stderr=stderr, timeout=120)
            code, error = result.returncode, None
        except subprocess.TimeoutExpired:
            code, error = None, 'TIMEOUT'
        stdout.flush(); os.fsync(stdout.fileno())
        stderr.flush(); os.fsync(stderr.fileno())
    row = {'command': args, 'status': code, 'error': error,
           'wallMs': (time.perf_counter() - started) * 1000,
           'stdout': f'{index}.stdout.txt', 'stderr': f'{index}.stderr.txt',
           'stdoutSha256': digest((HERE / f'{index}.stdout.txt').read_bytes()),
           'stderrSha256': digest((HERE / f'{index}.stderr.txt').read_bytes())}
    durable(f'{index}.json', row)
    rows.append(row)
    if code != 0:
        raise SystemExit('Verification failed; reservation and raw outcomes retained')

tap = (HERE / '0.stdout.txt').read_text()
counts = {label: int(re.search(r'^# ' + label + r' (\d+)$', tap, re.MULTILINE)[1]) for label in ['tests', 'pass', 'fail']}
assert counts['tests'] == counts['pass'] == 178 and counts['fail'] == 0
replay = json.loads((HERE / '1.stdout.txt').read_text())
assert replay['verified'] is True
assert before == ledger_bytes()
summary = {
    'schema': 'ruflo.executor-correction-validation/v1',
    'decision': 'PROBE_ADMISSION_DEFECTS_CORRECTED_ISOLATED_WORKLOAD_INCOMPLETE',
    'sourceCommit': SOURCE, 'sourceTree': TREE, 'rows': rows, 'focusedTests': counts,
    'executorTests': 14, 'executorProcessResponsesSimulated': True,
    'historicalReplay': replay, 'originalAnchor': ANCHOR, 'ledgerHead': HEAD,
    'ledgerUnchanged': True, 'lifetimeEpochs': 7, 'lifetimeNativeFieldCallsReserved': 209784,
    'costs': {'measuredValidationParentStarts': 2, 'measuredValidationWallMs': sum(r['wallMs'] for r in rows),
              'identityPreflightProcessStarts': 4, 'validationDescendantProcessStarts': None,
              'actualIsolationProbeStarts': 0, 'newRepairCandidateEvaluations': 0,
              'newMissionEpochs': 0, 'newMissionNativeFieldCalls': 0,
              'externalProviderSpendUsd': 0, 'totalAcquisitionUsd': None, 'totalEvaluationUsd': None,
              'outerCodexModelUsage': None,
              'excluded': 'Python parent, editing, initial tests, review, Git acquisition/publication, memory, source research and CI; total work/dollars unknown'},
    'candidateExecutionEnabled': False, 'boundedRsiEvidenceAccepted': False,
    'largestUncertainty': 'Whether inherited failure-analysis state improves descendant successor productivity on fresh tasks at matched cost',
    'nextAcceptance': 'Resolve the allowed-runtime ELF loader layout and verify fixed p-limit startup under unchanged limits on a compatible authorized isolation runner',
}
durable('summary.json', summary)
print(json.dumps({'source': SOURCE, 'tests': counts, 'wallMs': summary['costs']['measuredValidationWallMs'], 'ledgerUnchanged': True}))
