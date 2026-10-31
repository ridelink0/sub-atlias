"""Exercise the actual supervisor with isolated local child fixtures, never models."""
import importlib.util
import json
import pathlib
import sys
import tempfile
import time
import types

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('reserve_lifecycle', ROOT/'tools/benchmark-reserve-supervisor.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
results = []
real_sleep = time.sleep


def scenario(name):
    with tempfile.TemporaryDirectory(prefix='atlias-reserve-life-') as folder:
        base = pathlib.Path(folder)
        template, root = base/'template', base/'resident'
        template.mkdir(); root.mkdir()
        events = [{'phase': 'guard-stop', 'reason': 'resource reserve breached'},
                  {'phase': 'owned-worker-released'}, {'phase': 'owned-backend-released'}]
        if name == 'missing-release':
            events.pop()
        (template/'LAUNCH.json').write_text(json.dumps(events))
        (template/'STOP').write_text('resource reserve breached')
        pointer = base/'CONTINUATION.json'
        pointer.write_text(json.dumps({'continuation': str(base/'foreign' if name == 'foreign-owner' else template)}))
        if name == 'requested-stop':
            (root/'STOP').write_text('requested stop')
        if name == 'interrupted-resident':
            (root/'STATE.json').write_text(json.dumps({'active': 'preserve-child-for-review'}))
        if name == 'persisted-policy-hold':
            (root/'STATE.json').write_text(json.dumps({'status': 'held', 'active': None, 'reason': 'Retry bound retained'}))
        fake = types.SimpleNamespace(LOCK=base/'central-lease', memory=lambda: {'availablePhysical': 8*m.GIB, 'availableCommit': 18*m.GIB})
        if name == 'low-resource':
            fake.memory = lambda: {'availablePhysical': 2*m.GIB, 'availableCommit': 18*m.GIB}
        tick = [1]
        def monotonic():
            return tick[0]
        def sleep(seconds):
            tick[0] += seconds
            if name == 'low-resource':
                (root/'STOP').write_text('fixture stop after admission refusal')
            real_sleep(.02)
        m.time = types.SimpleNamespace(monotonic=monotonic, time=lambda: 10000, sleep=sleep)
        m.module = lambda *_: fake
        m.boot_identity = lambda: '2026-10-26T01:05:29+00:00'
        m.gpu_memory = lambda: {'free': 9*m.GIB, 'utilization': 0}
        m.port_free = lambda: None
        m.trim_opera = lambda: []  # No real app changes in lifecycle fixtures.
        prepared = []
        def prepare(unused, target, arm):
            target.mkdir(); prepared.append((str(target), arm))
            qualify = "import pathlib,json; p=pathlib.Path(__file__).parent; (p/'QUALIFICATION.json').write_text(json.dumps({'passed':True}))"
            if name == 'qualification-failure':
                qualify = qualify.replace("'passed':True", "'passed':False")
            if name == 'foreign-during-qualification':
                qualify += '; pathlib.Path(' + repr(str(pointer)) + ').write_text(json.dumps({"continuation":' + repr(str(base/'new-owner')) + '}))'
            (target/'qualify.py').write_text(qualify)
            interrupted = name == 'resource-retry' and len(prepared) == 1
            non_resource = name == 'non-resource-failure'
            child_events = ([{'phase': 'guard-stop', 'reason': 'resource reserve breached'}] if interrupted else
                            [{'phase': 'guard-stop', 'reason': 'requested stop'}] if non_resource else
                            [{'phase': 'stage-validation', 'harness': arm, 'stage': 'screen', 'qualified': True}, {'phase': 'done'}])
            child_events += [{'phase': 'owned-worker-released'}, {'phase': 'owned-backend-released'}]
            start = "import pathlib,json; p=pathlib.Path(__file__).parent; (p/'CHILD-STARTED').write_text('local fixture only'); (p/'LAUNCH.json').write_text(" + repr(json.dumps(child_events)) + "); (p/" + repr(arm+'-screen.json') + ").write_text('{\"fixture\":true}')"
            if interrupted or non_resource:
                start += "; (p/'STOP').write_text(" + repr('resource reserve breached' if interrupted else 'requested stop') + '); raise SystemExit(1)'
            (target/'start.py').write_text(start)
        m.prepare = prepare
        sys.argv = ['fixture', 'run', '--root', str(root), '--template', str(template)]
        rc = m.main()
        state = json.loads((root/'STATE.json').read_text())
        if name in ['complete', 'resource-retry']:
            assert rc == 0 and state['status'] == 'complete'
            assert list(state['completed']) == m.ORDER
            assert len(prepared) == (6 if name == 'resource-retry' else 5)
            assert state['resourceRetries'] == (1 if name == 'resource-retry' else 0)
            if name == 'resource-retry':
                assert (pathlib.Path(prepared[0][0])/'STOP').read_text() == 'resource reserve breached'
                assert prepared[0][1] == prepared[1][1] == 'atlias'
        elif name == 'persisted-policy-hold':
            assert rc == 0 and state['status'] == 'held' and not prepared
        else:
            assert rc == 1 and state['status'] == 'held'
            if name in ['qualification-failure', 'foreign-during-qualification']:
                assert len(prepared) == 1 and not (pathlib.Path(prepared[0][0])/'CHILD-STARTED').exists()
            elif name == 'non-resource-failure':
                assert len(prepared) == 1 and state['resourceRetries'] == 0
            else:
                assert not prepared
        assert (template/'STOP').read_text() == 'resource reserve breached'
        results.append({'scenario': name, 'passed': True, 'localChildFixtures': len(prepared)})


for name in ['complete', 'resource-retry', 'missing-release', 'foreign-owner', 'requested-stop',
             'interrupted-resident', 'low-resource', 'qualification-failure',
             'foreign-during-qualification', 'non-resource-failure']:
    scenario(name)
scenario('persisted-policy-hold')
receipt = {'passed': True, 'scenarios': results, 'externalModelCalls': 0, 'actualSupervisorMain': True, 'sourceSha256': m.digest(ROOT/'tools/benchmark-reserve-supervisor.py')}
(ROOT/'reports/private-release-1025/reserve-lifecycle.json').write_text(json.dumps(receipt, indent=2))
print(json.dumps({'passed': True, 'scenarios': len(results), 'externalModelCalls': 0}))
