"""Preserve reviewed benchmark arms and budget actual owned-stage time.

The immutable v2 engine still enforces admission, ownership, resource retries,
per-child deadlines and measurement qualification. Only its two global deadline
expressions use a persistent active-stage ledger instead of firstLaunch wall time.
"""
import argparse
import ast
from datetime import datetime
import hashlib
import importlib.util
import inspect
import json
from pathlib import Path
import sys
import time

REVIEWED = Path('D:/harness-work/harness-compare-1024/reserve-supervisor-1026-v3/supervisor.py')
REVIEWED_SHA = '31896d76cc9ecb74a52aa34d2a238f2f0cae2034fab534b8c97fcef154401d37'
LIMIT_SECONDS = 46800


def load(file):
    return json.loads(Path(file).read_text(encoding='utf-8-sig'))


def sha(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def timestamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def historical_work(state):
    intervals = []
    previous_end = 0
    for name in state['attempts']:
        folder = Path(name)
        events = load(folder / 'LAUNCH.json')
        assert {'owned-worker-released', 'owned-backend-released'} <= {e['phase'] for e in events}
        assert any(e['phase'] == 'central-lease-held' for e in events)
        start = min(timestamp(e['at']) for e in events)
        end = max(timestamp(e['at']) for e in events)
        assert end >= start >= previous_end, 'Attempt intervals overlap or run backwards'
        previous_end = end
        intervals.append({'attempt': name, 'start': start, 'end': end,
                          'seconds': end - start, 'launchSHA256': sha(folder / 'LAUNCH.json')})
    return {'seconds': sum(i['seconds'] for i in intervals), 'intervals': intervals}


class ActiveWorkClock:
    def __init__(self, state, boot, clock=time):
        self.state, self.boot, self.clock = state, boot, clock
        ledger = state['activeWork']
        assert ledger['schema'] == 1 and 0 <= ledger['seconds'] < 1e12
        self.running = ledger.get('phase') == 'running'
        self.last = clock.monotonic()
        if self.running:
            if ledger['boot'] == boot:
                delta = self.last - ledger['monotonic']
                assert delta >= 0, 'Same-boot monotonic time moved backwards'
            else:
                # A missing shutdown sample is charged conservatively up to the
                # proven next boot. Unknown downtime never grants extra budget.
                delta = timestamp(boot) - ledger['wall']
                assert delta >= 0, 'Boot proof predates the last active sample'
                ledger['recoveryCharge'] = {'seconds': delta, 'basis': 'conservative-new-boot-bound'}
            ledger['seconds'] += delta
        ledger.update(boot=boot, monotonic=self.last, wall=clock.time())

    def elapsed(self):
        delta = self.clock.monotonic() - self.last if self.running else 0
        assert delta >= 0
        return self.state['activeWork']['seconds'] + delta

    def transition(self, status):
        ledger = self.state['activeWork']
        ledger['seconds'] = self.elapsed()
        self.last = self.clock.monotonic()
        self.running = status == 'running'
        ledger.update(phase='running' if self.running else 'idle', boot=self.boot,
                      monotonic=self.last, wall=self.clock.time())


def rewrite_main(source):
    changes = [
        ('        boot = boot_identity()\n', '        boot = boot_identity()\n        clock = ActiveWorkClock(state, boot)\n'),
        ('        def record(status, **fields):\n', '        def record(status, **fields):\n            clock.transition(status)\n'),
        ("state['firstLaunch'] and time.time() - state['firstLaunch'] >= 46800", 'clock.elapsed() >= 46800'),
        ("time.time() - state['firstLaunch'] >= 46800", 'clock.elapsed() >= 46800'),
    ]
    for before, after in changes:
        assert source.count(before) == 1, 'Frozen main shape changed: ' + before
        source = source.replace(before, after)
    assert "time.time() - state['firstLaunch']" not in source
    return source


def verify_migration(root, reviewed):
    reviewed.verify_review(root)
    migration = load(root / 'ACTIVE-WORK-REVIEW.json')
    prior = Path(migration['priorState'])
    assert sha(prior) == migration['priorStateSHA256']
    old = load(prior)
    assert old['status'] == 'held' and old['active'] is None and old['arm'] == 'codex'
    assert set(old['completed']) == {'atlias', 'mini-swe-agent'}
    last = Path(old['attempts'][-1])
    assert (last / 'STOP').read_text().strip() == 'global supervisor deadline'
    assert sha(last / 'STOP') == migration['deadlineStopSHA256']
    assert historical_work(old) == migration['historicalWork']
    assert 0 < migration['historicalWork']['seconds'] < LIMIT_SECONDS
    state = load(root / 'STATE.json')
    assert state['firstLaunch'] == old['firstLaunch']
    assert state['attempts'][:len(old['attempts'])] == old['attempts']
    assert state['resourceRetries'] >= old['resourceRetries']
    assert state['activeWork']['seconds'] >= migration['historicalWork']['seconds']
    assert state['activeWork']['correction'] == 1
    for arm, complete in old['completed'].items():
        assert state['completed'][arm] == complete
        assert sha(complete['report']) == complete['sha256']
        folder = Path(complete['report']).parent
        assert load(folder / 'QUALIFICATION.json')['passed'] is True
        node = next(n for n in ast.parse((folder / 'launch.py').read_text(encoding='utf-8')).body
                    if isinstance(n, ast.FunctionDef) and n.name == 'validate_stage')
        ns = {'json': json, 'pathlib': __import__('pathlib'), 'HERE': folder}
        exec(compile(ast.Module(body=[node], type_ignores=[]), '<retained-validator>', 'exec'), ns)
        assert ns['validate_stage'](complete['report'], load(folder / 'PREPARED.json')['screen'])['qualified'] is True
    return migration


def configure(base, reviewed):
    reviewed.configure(base)
    source = rewrite_main(inspect.getsource(base.main))
    base.ActiveWorkClock = lambda state, boot: ActiveWorkClock(state, boot, base.time)
    exec(compile(source, '<active-stage-budget-main>', 'exec'), base.__dict__)
    return base


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['run', 'probe'])
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--template', required=True, type=Path)
    args = parser.parse_args()
    assert sha(REVIEWED) == REVIEWED_SHA
    spec = importlib.util.spec_from_file_location('reviewed_queue_v3', REVIEWED)
    reviewed = importlib.util.module_from_spec(spec); spec.loader.exec_module(reviewed)
    if args.mode == 'run':
        verify_migration(args.root, reviewed)
    assert sha(reviewed.BASE) == reviewed.BASE_SHA
    spec = importlib.util.spec_from_file_location('frozen_resource_engine', reviewed.BASE)
    base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)
    configure(base, reviewed)
    return base.main()


if __name__ == '__main__':
    raise SystemExit(main())
