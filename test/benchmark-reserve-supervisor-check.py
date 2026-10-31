"""No-model functional and actual-line adversarial contracts for the supervisor."""
import importlib.util
import json
import pathlib
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
source = ROOT / 'tools/benchmark-reserve-supervisor.py'
spec = importlib.util.spec_from_file_location('reserve', source)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
checks = []


def check(name, value):
    checks.append({'name': name, 'passed': bool(value)})
    if not value:
        raise AssertionError(name)


g = m.GIB
check('idle GPU with enough VRAM admits', m.gpu_ready({'free': 9*g, 'utilization': 20}))
for gpu in [None, {'free': 9*g-1, 'utilization': 0}, {'free': 9*g, 'utilization': 21}, {'free': None, 'utilization': 0}]:
    check('unknown, occupied or busy GPU refuses', not m.gpu_ready(gpu))
check('strong admission accepts exact reserve', m.start_ready({'availablePhysical': 8*g, 'availableCommit': 18*g}))
for data in [{'availablePhysical': 8*g-1, 'availableCommit': 18*g},
             {'availablePhysical': 8*g, 'availableCommit': 18*g-1},
             {'availablePhysical': None, 'availableCommit': 18*g}]:
    check('insufficient or unknown admission refuses', not m.start_ready(data))
events = [{'phase': 'guard-stop', 'reason': 'resource reserve breached'},
          {'phase': 'owned-worker-released'}, {'phase': 'owned-backend-released'}]
check('resource stop eligible only after release', m.retryable(events, 'resource reserve breached') and m.released(events))
for reason in ['requested stop', 'deadline', 'owned backend exited', 'backend prompt cache not capped']:
    check('non-resource interruption never retries: ' + reason, not m.retryable(events, reason))
check('stale release before latest stop refuses', not m.released(events + [{'phase': 'guard-stop'}]))
check('missing release refuses', not m.released(events[:-1]))
original = source.read_text()
mutant = original.replace('memory[k] >= n * GIB', 'memory[k] >= 0')
check('admission actual line mutated', mutant != original)
scope = {'__name__': 'mutant'}
exec(compile(mutant, 'reserve-mutant', 'exec'), scope)
check('same admission contract catches missing guard', not m.start_ready({'availablePhysical': 0, 'availableCommit': 0}) and scope['start_ready']({'availablePhysical': 0, 'availableCommit': 0}))
mutant = original.replace("stop.strip() == 'resource reserve breached'", 'True')
scope = {'__name__': 'mutant'}
exec(compile(mutant, 'retry-mutant', 'exec'), scope)
check('same retry contract catches requested-stop retry', not m.retryable(events, 'requested stop') and scope['retryable'](events, 'requested stop'))
template = pathlib.Path('D:/harness-work/harness-compare-1024/continuation-1025-v6')
with tempfile.TemporaryDirectory(prefix='atlias-reserve-') as tmp:
    target = pathlib.Path(tmp) / 'attempt'
    m.prepare(template, target, 'atlias')
    check('exact60 unchanged selectors', (target/'exact-screen.json').read_bytes() == (template/'exact-screen.json').read_bytes())
    check('old STOP retained and no attempt launched', (template/'STOP').read_text().strip() == 'resource reserve breached' and not (target/'LAUNCH.json').exists())
    check('single-arm queue explicit', "ORDER = ['atlias']" in (target/'launch.py').read_text())
    check('all prepared pins actual', all(m.digest(p) == h for p, h in m.load(target/'PREPARED.json')['pins'].items()))
    try:
        m.prepare(template, target, 'atlias')
    except FileExistsError:
        refused = True
    else:
        refused = False
    check('existing attempt cannot be overwritten', refused)
receipt = {'passed': True, 'checks': checks, 'externalModelCalls': 0, 'sourceSha256': m.digest(source)}
out = ROOT / 'reports/private-release-1025/reserve-check.json'
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(receipt, indent=2))
print(json.dumps({'passed': True, 'checks': len(checks), 'externalModelCalls': 0}))
