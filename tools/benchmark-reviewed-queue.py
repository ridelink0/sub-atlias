"""Continue untouched arms after a documented rejected measurement.

The old hold and reports remain immutable. This does not qualify or retry Claude.
The frozen v2 supervisor still owns admission, resource retry, boot and deadlines.
"""
import argparse
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

BASE = Path('D:/harness-work/harness-compare-1024/reserve-supervisor-1025-v2/supervisor.py')
BASE_SHA = '8bedda0223e315638c4b94a8e980d6d62deafb40e5e36d266ae8fb6749d214fd'
QUEUE = ['mini-swe-agent', 'codex', 'pi']
POLICY = {'harnessJobMiB': 4096, 'graderJobMiB': 2048}


def load(file):
    return json.loads(Path(file).read_text(encoding='utf-8-sig'))


def sha(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def verify_review(root):
    review = load(root / 'REVIEW.json')
    assert review['disposition'] == 'retain-unqualified-and-continue-other-arms'
    assert review['remaining'] == QUEUE
    assert sha(BASE) == BASE_SHA
    old_file = Path(review['priorState'])
    assert sha(old_file) == review['priorStateSHA256']
    old = load(old_file)
    assert old['status'] == 'held' and old['active'] is None and old['arm'] == 'claude'
    rejected = Path(review['rejectedReport'])
    assert sha(rejected) == review['rejectedReportSHA256']
    report = load(rejected)
    prepared = load(rejected.parent / 'PREPARED.json')
    rows = report['results']
    assert len(rows) == report['total'] == 60
    assert len({r['id'] for r in rows}) == 60 and {r['id'] for r in rows} == set(prepared['screen'])
    assert report['usageComplete'] is True and report['windowMatched'] is True
    bad = [r for r in rows if r.get('measurementComplete') is not True]
    assert len(bad) == 1 and bad[0]['harnessExit'] == 1
    error = (Path(bad[0]['state']) / 'harness-output.txt').read_text(encoding='utf-8')
    assert 'response exceeded the 2048 output token maximum' in error
    events = load(rejected.parent / 'LAUNCH.json')
    assert {'owned-worker-released', 'owned-backend-released'} <= {e['phase'] for e in events}
    screen = [e for e in events if e.get('phase') == 'stage-validation' and e.get('stage') == 'screen'][-1]
    assert screen['qualified'] is False and screen['measurementComplete'] is False
    # Revalidate the successful arm against the original validator before carry.
    complete = old['completed']['atlias']
    assert sha(complete['report']) == complete['sha256']
    attempt = Path(complete['report']).parent
    node = next(n for n in ast.parse((attempt / 'launch.py').read_text(encoding='utf-8')).body
                if isinstance(n, ast.FunctionDef) and n.name == 'validate_stage')
    ns = {'json': json, 'pathlib': __import__('pathlib'), 'HERE': attempt}
    exec(compile(ast.Module(body=[node], type_ignores=[]), '<retained-validator>', 'exec'), ns)
    assert ns['validate_stage'](complete['report'], prepared['screen'])['qualified'] is True
    state = load(root / 'STATE.json')
    assert state['firstLaunch'] == old['firstLaunch'], 'The existing deadline cannot reset'
    assert state['resourceRetries'] >= old['resourceRetries'], 'Retry history cannot reset'
    assert state['attempts'][:len(old['attempts'])] == old['attempts']
    assert state['completed']['atlias'] == complete and 'claude' not in state['completed']
    return review


def mini_limits(target):
    """Bound the future Mini environment; never alter its frozen agent or prompts."""
    file = target / 'mini-owned-runner.py'
    text = file.read_text(encoding='utf-8')
    anchor = '    module.main()'
    assert text.count(anchor) == 1
    addition = '''    original_one = module.run_one
    grader = {'argv': None}
    def limited_tree(argv, **kwargs):
        cap = 2048 if list(argv) == grader['argv'] else 4096
        return owned.run_tree(argv, job_memory=cap * 1024 ** 2, **kwargs)
    def limited_one(task, *args):
        grader['argv'] = task['check'] if isinstance(task['check'], list) else task['check'].split()
        try:
            row = original_one(task, *args)
            row['resourcePolicy'] = {'harnessJobMiB': 4096, 'graderJobMiB': 2048}
            row['measurementComplete'] = row.get('usageComplete') is True and row.get('loadedWindow') == 32768
            return row
        finally:
            grader['argv'] = None
    module.run_tree, module.run_one = limited_tree, limited_one
    module.main()'''
    file.write_text(text.replace(anchor, addition), encoding='utf-8')
    file = target / 'launch.py'
    text = file.read_text(encoding='utf-8')
    old = 'owned.start_owned(argv, cwd=str(SOURCE), env=dict(os.environ, **extra), stdout=log, stderr=subprocess.STDOUT)'
    new = 'owned.start_owned(argv, job_memory=4096 * 1024 ** 2 if harness == "mini-swe-agent" else 0, cwd=str(SOURCE), env=dict(os.environ, **extra), stdout=log, stderr=subprocess.STDOUT)'
    assert text.count(old) == 1
    text = text.replace(old, new)
    old_measure = "(r.get('provenance') or {}).get('harness') == 'mini-swe-agent' or r.get('measurementComplete') is True"
    new_measure = "r.get('measurementComplete') is True and ((r.get('provenance') or {}).get('harness') != 'mini-swe-agent' or r.get('resourcePolicy') == {'harnessJobMiB': 4096, 'graderJobMiB': 2048})"
    assert text.count(old_measure) == 1
    file.write_text(text.replace(old_measure, new_measure), encoding='utf-8')
    file = target / 'qualify.py'
    text = file.read_text(encoding='utf-8')
    old_parse = "    after = ast.parse((HERE / 'launch.py').read_text(encoding='utf-8'))"
    new_parse = ("    after_text = (HERE / 'launch.py').read_text(encoding='utf-8')\n"
                 "    bounded = " + repr(new) + "\n"
                 "    check('only Mini stage has the explicit4GiB owned job', after_text.count(bounded) == 1)\n"
                 "    after = ast.parse(after_text.replace(bounded, " + repr(old) + "))")
    assert text.count(old_parse) == 1
    file.write_text(text.replace(old_parse, new_parse), encoding='utf-8')
    prepared_file = target / 'PREPARED.json'
    prepared = load(prepared_file)
    for name in ['mini-owned-runner.py', 'launch.py', 'qualify.py']:
        prepared['pins'][str(target / name)] = sha(target / name)
    prepared['miniResourcePolicy'] = POLICY
    prepared_file.write_text(json.dumps(prepared, indent=2), encoding='utf-8')


def configure(base):
    original_order = list(base.ORDER)
    original_prepare = base.prepare
    def prepare(template, target, arm):
        if arm not in QUEUE:
            raise ValueError('Only the three untouched arms may continue')
        # The unchanged template still declares all five arms. Its own qualifier
        # binds the generated one-arm manifest before anything can run.
        base.ORDER = original_order
        try:
            original_prepare(template, target, arm)
        finally:
            base.ORDER = list(QUEUE)
        if arm == 'mini-swe-agent':
            mini_limits(target)
    base.ORDER, base.prepare = list(QUEUE), prepare
    return base


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['run', 'probe'])
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--template', required=True, type=Path)
    args = parser.parse_args()
    assert sha(BASE) == BASE_SHA
    if args.mode == 'run':
        verify_review(args.root)
    spec = importlib.util.spec_from_file_location('frozen_resource_supervisor', BASE)
    base = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(base)
    configure(base)
    return base.main()


if __name__ == '__main__':
    raise SystemExit(main())
