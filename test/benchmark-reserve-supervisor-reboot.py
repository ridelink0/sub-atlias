"""Prove reboot ownership rules without rebooting Gev's PC or launching models."""
import copy
import importlib.util
import json
import pathlib
import tempfile
import types

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('reserve_reboot', ROOT/'tools/benchmark-reserve-supervisor.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
checks = []


def check(name, value):
    checks.append({'name': name, 'passed': bool(value)})
    if not value:
        raise AssertionError(name)


for scenario in ['owned-stale', 'same-boot', 'missing-boot', 'foreign-lease', 'new-lease',
                 'foreign-attempt', 'occupied-port', 'completed-arm', 'recovery-write-replay']:
    with tempfile.TemporaryDirectory(prefix='atlias-reserve-reboot-') as folder:
        root = pathlib.Path(folder)
        active = root/'attempt'; active.mkdir()
        events = [{'phase': 'central-lease-held', 'owner': 'owned-fixture'}]
        (active/'LAUNCH.json').write_text(json.dumps(events))
        (active/'STOP').write_text('keep original stop')
        (active/'atlias-screen.json').write_text('{"partialFixture":true}')
        lease_file = root/'central.lock'
        lease = {'owner': 'foreign' if scenario == 'foreign-lease' else 'owned-fixture',
                 'at': '2026-10-26T02:00:00+00:00' if scenario == 'new-lease' else '2026-10-26T00:01:00+00:00'}
        original = json.dumps(lease).encode()
        lease_file.write_bytes(original)
        boot = '2026-10-26T00:00:00+00:00' if scenario == 'same-boot' else '2026-10-26T01:00:00+00:00'
        state = {'active': str(active), 'activeBoot': None if scenario == 'missing-boot' else '2026-10-26T00:00:00+00:00',
                 'attempts': [] if scenario == 'foreign-attempt' else [str(active)], 'arm': 'atlias',
                 'completed': {}, 'firstLaunch': 123, 'resourceRetries': 0}
        def occupied():
            raise OSError('fixture occupied port')
        m.port_free = occupied if scenario == 'occupied-port' else lambda: None
        validated = []
        if scenario == 'completed-arm':
            events.append({'phase': 'stage-validation', 'harness': 'atlias', 'stage': 'screen', 'qualified': True})
            (active/'LAUNCH.json').write_text(json.dumps(events))
            (active/'QUALIFICATION.json').write_text('{}')
            (active/'PREPARED.json').write_text('{"screen":["fixture"]}')
            m.module = lambda *_: types.SimpleNamespace(verify_qualification=lambda: validated.append('source-pins'),
                validate_stage=lambda *_: validated.append('task-model-usage-window') or {'qualified': True}, cache_cap_state=lambda *_: 'ok')
        if scenario == 'recovery-write-replay':
            (root/'recovery').mkdir()
            (root/'recovery/interruption-0001.json').write_text(json.dumps({'attempt': str(active), 'previousBoot': state['activeBoot']}))
        refused = False
        try:
            recovered = m.recover_reboot(state, boot, lease_file, root)
        except (RuntimeError, OSError):
            refused = True
            recovered = False
        expected = scenario in ['owned-stale', 'completed-arm', 'recovery-write-replay']
        check(scenario + ' recovery decision', recovered is expected)
        if expected:
            check(scenario + ' old lease archived byte-for-byte', not lease_file.exists() and (root/'recovery/lease-owned-fixture.json').read_bytes() == original)
            check(scenario + ' interrupted state released without deadline reset', state['active'] is None and state['firstLaunch'] == 123)
            if scenario == 'completed-arm':
                check('completed arm is freshly validated and carried, not repeated', validated == ['source-pins', 'task-model-usage-window'] and 'atlias' in state['completed'])
        else:
            check(scenario + ' lease preserved byte-for-byte', lease_file.read_bytes() == original)
        check(scenario + ' old STOP preserved', (active/'STOP').read_text() == 'keep original stop')
original = (ROOT/'tools/benchmark-reserve-supervisor.py').read_text()
mutant = original.replace("lease.get('owner') != held[0].get('owner')", 'False')
check('reboot ownership guard actually mutated', mutant != original)
scope = {'__name__': 'mutant'}
exec(compile(mutant, 'reboot-owner-mutant', 'exec'), scope)


def ownership_contract(recover):
    with tempfile.TemporaryDirectory(prefix='atlias-reboot-owner-') as folder:
        root = pathlib.Path(folder); active = root/'attempt'; active.mkdir()
        (active/'LAUNCH.json').write_text('[{"phase":"central-lease-held","owner":"ours"}]')
        lease = root/'central.lock'; raw = b'{"owner":"foreign","at":"2026-10-26T00:01:00+00:00"}'; lease.write_bytes(raw)
        state = {'active': str(active), 'activeBoot': '2026-10-26T00:00:00+00:00', 'arm': 'atlias', 'attempts': [str(active)], 'completed': {}}
        try:
            recover(state, '2026-10-26T01:00:00+00:00', lease, root)
        except RuntimeError:
            pass
        return lease.exists() and lease.read_bytes() == raw


m.port_free = lambda: None
scope['port_free'] = lambda: None
check('same ownership contract catches foreign lease archival', ownership_contract(m.recover_reboot) and not ownership_contract(scope['recover_reboot']))
out = ROOT/'reports/private-release-1025/reserve-reboot.json'
out.write_text(json.dumps({'passed': True, 'checks': checks, 'actualPCRebootTested': False, 'externalModelCalls': 0, 'sourceSha256': m.digest(ROOT/'tools/benchmark-reserve-supervisor.py')}, indent=2))
print(json.dumps({'passed': True, 'checks': len(checks), 'actualPCRebootTested': False, 'externalModelCalls': 0}))
