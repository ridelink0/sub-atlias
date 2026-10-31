"""Source-bound no-model checks for a reviewed, still-qualified remaining queue."""
import ast
import copy
import importlib.util
import json
from pathlib import Path
import ctypes
import os
import subprocess
import sys
import tempfile
import types

ROOT = Path(__file__).resolve().parents[1]
file = ROOT / 'tools/benchmark-reviewed-queue.py'
spec = importlib.util.spec_from_file_location('reviewed_queue', file)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
checks = []

def check(name, value):
    assert value, name
    checks.append(name)

with tempfile.TemporaryDirectory(prefix='atlias-reviewed-') as folder:
    root = Path(folder)
    old_state = Path('D:/harness-work/harness-compare-1024/reserve-supervisor-1025-v2/STATE.json')
    rejected = old_state.parent.parent / 'continuation-1025-v7-0003/claude-screen.json'
    old = m.load(old_state)
    review = {'disposition': 'retain-unqualified-and-continue-other-arms', 'remaining': m.QUEUE,
              'priorState': str(old_state), 'priorStateSHA256': m.sha(old_state),
              'rejectedReport': str(rejected), 'rejectedReportSHA256': m.sha(rejected)}
    (root / 'REVIEW.json').write_text(json.dumps(review))
    (root / 'STATE.json').write_text(json.dumps(old))
    check('actual rejected report excluded, completed Atlias freshly validates', m.verify_review(root) == review)
    for label, mutate in [('deadline reset', lambda s: s.update(firstLaunch=1)),
                          ('retry reset', lambda s: s.update(resourceRetries=0)),
                          ('attempt history removed', lambda s: s.update(attempts=[])),
                          ('rejected arm relabeled complete', lambda s: s['completed'].update(claude={'report': str(rejected)}))]:
        changed = copy.deepcopy(old); mutate(changed)
        (root / 'STATE.json').write_text(json.dumps(changed))
        refused = False
        try: m.verify_review(root)
        except AssertionError: refused = True
        check(label + ' refuses', refused)
    (root / 'STATE.json').write_text(json.dumps(old))
    bad = copy.deepcopy(review); bad['remaining'] = ['claude', 'mini-swe-agent', 'codex', 'pi']
    (root / 'REVIEW.json').write_text(json.dumps(bad))
    refused = False
    try: m.verify_review(root)
    except AssertionError: refused = True
    check('review cannot retry Claude to obtain a favorable result', refused)
    # Exercise the real generator against the frozen template. It never launches.
    spec = importlib.util.spec_from_file_location('unchanged_v2', m.BASE)
    base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)
    m.configure(base)
    target = root / 'mini'
    base.prepare(Path('D:/harness-work/harness-compare-1024/continuation-1025-v6'), target, 'mini-swe-agent')
    prepared = m.load(target / 'PREPARED.json')
    check('future arm pins all changed operational files', all(m.sha(p) == h for p, h in prepared['pins'].items()))
    check('single Mini arm and original selectors preserved', "ORDER = ['mini-swe-agent']" in (target / 'launch.py').read_text() and len(prepared['screen']) == 60)
    tree = ast.parse((target / 'mini-owned-runner.py').read_text())
    nodes = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name in ['limited_tree', 'limited_one']]
    caps = []
    owned = types.SimpleNamespace(run_tree=lambda argv, **kw: caps.append(kw['job_memory']) or (0, False))
    grader = {'argv': None}
    def original_one(task, *args):
        ns['limited_tree'](['bash', '-c', 'echo fixture'])
        ns['limited_tree'](task['check'])
        return {'usageComplete': True, 'loadedWindow': 32768}
    ns = {'owned': owned, 'grader': grader, 'original_one': original_one}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), '<actual-generated-mini-limits>', 'exec'), ns)
    row = ns['limited_one']({'check': ['python', 'check.py']})
    check('actual generated Mini action and grader use 4GiB and 2GiB', caps == [4096 * 1024**2, 2048 * 1024**2])
    check('Mini completion requires usage and loaded window', row['measurementComplete'] and row['resourcePolicy'] == m.POLICY and grader['argv'] is None)
    original_one_good = ns['original_one']
    ns['original_one'] = lambda *_: {'usageComplete': False, 'loadedWindow': 32768}
    check('Mini unknown usage is never certified', ns['limited_one']({'check': ['check']})['measurementComplete'] is False)
    # Actual-line plant: removing the bound changes observed job arguments.
    changed = copy.deepcopy(nodes)
    cap_assignment = next(n for n in ast.walk(changed[0]) if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'cap' for t in n.targets))
    cap_assignment.value = ast.copy_location(ast.Constant(value=0), cap_assignment.value)
    broken = {'owned': owned, 'grader': grader, 'original_one': original_one_good}
    exec(compile(ast.fix_missing_locations(ast.Module(body=changed, type_ignores=[])), '<missing-memory-limit>', 'exec'), broken)
    caps.clear(); broken['limited_tree'](['bash'])
    check('actual-line missing memory limit is detected', caps == [0])
    # The generated validator must reject Mini's old missing measurement flag.
    node = next(n for n in ast.parse((target / 'launch.py').read_text()).body if isinstance(n, ast.FunctionDef) and n.name == 'validate_stage')
    ns = {'json': json, 'pathlib': __import__('pathlib'), 'HERE': target}
    exec(compile(ast.Module(body=[node], type_ignores=[]), '<generated-validator>', 'exec'), ns)
    task_id = prepared['screen'][0]
    payload = {'numCtx': 32768, 'numPredict': 2048, 'windowMatched': True, 'usageComplete': True, 'results': [{
        'id': task_id, 'promptTotal': 100, 'outputTotal': 20, 'budget': 32, 'measurementComplete': True,
        'resourcePolicy': m.POLICY, 'taskDigests': prepared['tasks'][task_id],
        'provenance': {'harness': 'mini-swe-agent', 'model': prepared['model'], 'pluginDirs': []}}]}
    report = root / 'fixture.json'; report.write_text(json.dumps(payload))
    check('complete bounded Mini graded outcome accepts', ns['validate_stage'](report, [task_id])['qualified'])
    for key in ['measurementComplete', 'resourcePolicy']:
        bad = copy.deepcopy(payload); bad['results'][0].pop(key); report.write_text(json.dumps(bad))
        check('Mini missing ' + key + ' rejects', not ns['validate_stage'](report, [task_id])['qualified'])

if os.name == 'nt':
    # Use the same handle-owning primitive as the future worker. A tiny child
    # exits naturally; query installed limits rather than allocating large RAM.
    sys.path.insert(0, 'D:/harness-work/atlias-claude-continuous-1015/tools/h2h')
    import owned_process as owned
    owned.K.QueryInformationJobObject.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p]
    for mib in [4096, 2048]:
        child = owned.start_owned([sys.executable, '-c', 'import time; time.sleep(.25)'],
                                  job_memory=mib * 1024**2, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            limits = owned.Extended()
            assert owned.K.QueryInformationJobObject(child._benchmark_job, 9, ctypes.byref(limits), ctypes.sizeof(limits), None)
            check('native Windows job installs ' + str(mib) + 'MiB limit', bool(limits.basic.flags & 0x200) and limits.job_memory == mib * 1024**2)
            assert child.wait(timeout=10) == 0
        finally:
            owned.release(child)

# Reuse all actual-main lifecycle scenarios, now with the reduced reviewed queue.
# Child fixtures are local scripts only; no model/backend is available to them.
source = (ROOT / 'test/benchmark-reserve-supervisor-lifecycle.py').read_text()
source = source.replace('spec.loader.exec_module(m)', 'spec.loader.exec_module(m)\nreview.configure(m)')
source = source.replace('(6 if name == \'resource-retry\' else 5)', '(4 if name == \'resource-retry\' else 3)')
source = source.replace("== 'atlias'", "== 'mini-swe-agent'")
source = source.replace("reports/private-release-1025/reserve-lifecycle.json", "reports/benchmark-reviewed-1026/lifecycle.json")
(ROOT / 'reports/benchmark-reviewed-1026').mkdir(parents=True, exist_ok=True)
exec(compile(source, str(ROOT / 'test/benchmark-reserve-supervisor-lifecycle.py'), 'exec'), {'__file__': str(ROOT / 'test/benchmark-reserve-supervisor-lifecycle.py'), 'review': m})
result = {'passed': True, 'checks': checks, 'sourceSHA256': m.sha(file), 'externalModelCalls': 0}
(ROOT / 'reports/benchmark-reviewed-1026/check.json').write_text(json.dumps(result, indent=2))
print(json.dumps({'passed': True, 'checks': len(checks), 'actualMainScenarios': 11, 'externalModelCalls': 0}))
