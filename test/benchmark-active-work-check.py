"""Functional and adversarial checks: actual stage budget, no model loads."""
import copy
import importlib.util
import inspect
import json
from pathlib import Path
import types
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'reports/benchmark-active-work-1026'
OUT.mkdir(parents=True, exist_ok=True)
spec = importlib.util.spec_from_file_location('active_work', ROOT / 'tools/benchmark-active-work.py')
m = importlib.util.module_from_spec(spec); sys.modules[spec.name] = m; spec.loader.exec_module(m)
checks = []
def check(name, value):
    assert value, name
    checks.append(name)

def state(seconds=0, **extra):
    return {'activeWork': {'schema': 1, 'seconds': seconds, 'phase': 'idle', **extra}}

class Time:
    def __init__(self): self.now = 1000
    def monotonic(self): return self.now
    def time(self): return 1793020000 + self.now

boot = '2026-10-26T01:05:29+00:00'
t = Time(); s = state(200)
c = m.ActiveWorkClock(s, boot, t)
t.now += 90000
check('idle and admission hours do not consume active work', c.elapsed() == 200)
c.transition('running'); t.now += 7
check('running stage advances budget', c.elapsed() == 207)
c.transition('running'); t.now += 3; c.transition('waiting'); t.now += 80000
check('resource wait stops stage clock without reset', c.elapsed() == 210)
saved = copy.deepcopy(s); c = m.ActiveWorkClock(s, boot, t)
check('idle native restart preserves spend', c.elapsed() == saved['activeWork']['seconds'])
c.transition('running'); t.now += 8; c.transition('running'); t.now += 4
c = m.ActiveWorkClock(s, boot, t)
check('same boot active native restart charges unsampled gap', c.elapsed() == 222)
t.now += m.LIMIT_SECONDS
check('actual active deadline still exhausts', c.elapsed() >= m.LIMIT_SECONDS)
old = state(20, phase='running', boot='2026-10-25T01:00:00+00:00', monotonic=500, wall=m.timestamp(boot)-40)
c = m.ActiveWorkClock(old, boot, t)
check('new boot unknown gap charged conservatively', c.elapsed() == 60 and old['activeWork']['recoveryCharge']['seconds'] == 40)

spec = importlib.util.spec_from_file_location('reviewed_v3', m.REVIEWED)
reviewed = importlib.util.module_from_spec(spec); spec.loader.exec_module(reviewed)
check('reviewed operational wrapper remains pinned', m.sha(m.REVIEWED) == m.REVIEWED_SHA)
spec = importlib.util.spec_from_file_location('frozen_main', reviewed.BASE)
base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)
original = inspect.getsource(base.main)
changed = m.rewrite_main(original)
check('only two global checks use active clock', changed.count('clock.elapsed() >= 46800') == 2)
check('original first launch assignment is retained', "state['firstLaunch'] = state['firstLaunch'] or time.time()" in changed)
for guard in ["if (root / 'STOP').exists()", "state['resourceRetries'] < 3", 'start_ready(memory)', 'gpu_ready(gpu)', 'stableSeconds', 'recover_reboot(state, boot, launch.LOCK, root)', 'child.returncode == 0 and validations']:
    check('preserved guard: '+guard, guard in changed)
for bad in [original.replace('>= 46800', '>= 999999'), original.replace('boot = boot_identity()', 'boot = None')]:
    refused = False
    try: m.rewrite_main(bad)
    except AssertionError: refused = True
    check('changed frozen controller shape refuses', refused)
# Plant the real transition line that excludes idle time. The same clock
# contract must expose the regression; source remains unmodified.
source = inspect.getsource(m.ActiveWorkClock)
for before, after, expected in [
    ("self.running = status == 'running'", 'self.running = True', 12),
    ("return self.state['activeWork']['seconds'] + delta", "return self.state['activeWork']['seconds']", 5),
]:
    assert before in source
    ns = {'time': __import__('time'), 'timestamp': m.timestamp}
    exec(source.replace(before, after), ns)
    q = Time(); st = state(5); mutant = ns['ActiveWorkClock'](st, boot, q)
    mutant.transition('waiting' if expected == 12 else 'running'); q.now += 7
    check('actual-line clock regression is detected', mutant.elapsed() == expected)

# Run the real transformed supervisor main against existing local child fixtures.
life = (ROOT / 'test/benchmark-reserve-supervisor-lifecycle.py').read_text()
life = life.replace('spec.loader.exec_module(m)', 'spec.loader.exec_module(m)\nactive.configure(m, reviewed)')
seed = """        initial = json.loads((root/'STATE.json').read_text()) if (root/'STATE.json').exists() else {'completed':{},'attempts':[],'resourceRetries':0,'firstLaunch':1}
        initial['activeWork'] = {'schema':1,'seconds':46800 if name == 'active-deadline' else 0,'phase':'idle'}
        (root/'STATE.json').write_text(json.dumps(initial))
"""
life = life.replace('        fake = types.SimpleNamespace(', seed + '        fake = types.SimpleNamespace(')
life = life.replace('time=lambda: 10000', 'time=lambda: 2000000')
life = life.replace("(6 if name == 'resource-retry' else 5)", "(4 if name == 'resource-retry' else 3)")
life = life.replace("== 'atlias'", "== 'mini-swe-agent'")
life = life.replace("scenario('persisted-policy-hold')", "scenario('persisted-policy-hold')\nscenario('active-deadline')")
life = life.replace("reports/private-release-1025/reserve-lifecycle.json", "reports/benchmark-active-work-1026/lifecycle.json")
exec(compile(life, str(ROOT/'test/benchmark-reserve-supervisor-lifecycle.py'), 'exec'), {'__file__':str(ROOT/'test/benchmark-reserve-supervisor-lifecycle.py'), 'active':m, 'reviewed':reviewed})
# Validate the real completed arms and reviewed clock correction, then refuse
# budget/history/score tampering in isolated state copies.
import tempfile
actual = Path('D:/harness-work/harness-compare-1024/reserve-supervisor-1026-v4')
check('actual retained Atlias and Mini freshly qualify', bool(m.verify_migration(actual, reviewed)))
with tempfile.TemporaryDirectory(prefix='atlias-active-review-') as folder:
    root = Path(folder)
    for name in ['REVIEW.json', 'ACTIVE-WORK-REVIEW.json', 'STATE.json']:
        (root/name).write_bytes((actual/name).read_bytes())
    initial = m.load(root/'STATE.json')
    for label, change in [
        ('active budget reset', lambda d: d['activeWork'].update(seconds=0)),
        ('first launch reset', lambda d: d.update(firstLaunch=1)),
        ('completed Mini discarded', lambda d: d['completed'].pop('mini-swe-agent')),
        ('retry counter reset', lambda d: d.update(resourceRetries=0)),
    ]:
        changed = copy.deepcopy(initial); change(changed)
        (root/'STATE.json').write_text(json.dumps(changed))
        refused = False
        try: m.verify_migration(root, reviewed)
        except (AssertionError, KeyError): refused = True
        check(label + ' refuses', refused)
result = {'passed':True,'checks':checks,'sourceSHA256':m.sha(ROOT/'tools/benchmark-active-work.py'),'externalModelCalls':0,'actualMainScenarios':12,'actualLineMutants':2}
(OUT/'check.json').write_text(json.dumps(result,indent=2))
print(json.dumps({'passed':True,'checks':len(checks),'actualMainScenarios':12,'actualLineMutants':2,'externalModelCalls':0}))
