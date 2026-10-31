"""Resident, resource-aware follower for the frozen common60 comparison.

No model source changes, PID termination, result overwrite or STOP removal.
Only whole qualified arms carry forward; resource-interrupted arms start fresh.
"""
import argparse
import ast
import copy
import ctypes
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import time

GIB = 1024 ** 3
ORDER = ['atlias', 'claude', 'mini-swe-agent', 'codex', 'pi']
FILES = ['adapter_support.py', 'provenance-runner.py', 'mini-owned-runner.py',
         'usage_capture.py', 'atlias-config.json', 'exact-smoke.json',
         'exact-screen.json', 'native-fixture.mjs', 'waiter.py', 'start.py',
         'launch.py', 'qualify.py']


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(file):
    return hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()


def save(file, value):
    temp = file.with_suffix(file.suffix + '.tmp')
    temp.write_text(json.dumps(value, indent=2), encoding='utf-8')
    os.replace(temp, file)


def load(file):
    return json.loads(pathlib.Path(file).read_text(encoding='utf-8-sig'))


def module(file, name):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def start_ready(memory):
    # Stronger admission reserve; the qualified child retains its original guards.
    return all(type(memory.get(k)) is int and memory[k] >= n * GIB for k, n in
               [('availablePhysical', 8), ('availableCommit', 18)])


def gpu_memory():
    """Read the single installed GPU through NVML; never load a model to probe it."""
    class Memory(ctypes.Structure):
        _fields_ = [('total', ctypes.c_ulonglong), ('free', ctypes.c_ulonglong), ('used', ctypes.c_ulonglong)]
    class Utilization(ctypes.Structure):
        _fields_ = [('gpu', ctypes.c_uint), ('memory', ctypes.c_uint)]
    try:
        nvml = ctypes.WinDLL(str(pathlib.Path(os.environ['SystemRoot'])/'System32/nvml.dll'))
        if nvml.nvmlInit_v2() != 0:
            return None
        try:
            count, handle, info, use = ctypes.c_uint(), ctypes.c_void_p(), Memory(), Utilization()
            nvml.nvmlDeviceGetHandleByIndex_v2.argtypes = [ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)]
            nvml.nvmlDeviceGetMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(Memory)]
            nvml.nvmlDeviceGetUtilizationRates.argtypes = [ctypes.c_void_p, ctypes.POINTER(Utilization)]
            if nvml.nvmlDeviceGetCount_v2(ctypes.byref(count)) != 0 or count.value != 1:
                return None
            if nvml.nvmlDeviceGetHandleByIndex_v2(0, ctypes.byref(handle)) != 0 or nvml.nvmlDeviceGetMemoryInfo(handle, ctypes.byref(info)) != 0 or nvml.nvmlDeviceGetUtilizationRates(handle, ctypes.byref(use)) != 0:
                return None
            return {'total': info.total, 'free': info.free, 'utilization': use.gpu}
        finally:
            nvml.nvmlShutdown()
    except (OSError, KeyError, AttributeError):
        return None


def gpu_ready(gpu):
    return bool(gpu and type(gpu.get('free')) is int and gpu['free'] >= 9 * GIB and
                type(gpu.get('utilization')) is int and 0 <= gpu['utilization'] <= 20)


def retryable(events, stop):
    return stop.strip() == 'resource reserve breached' and any(
        e.get('phase') == 'guard-stop' and e.get('reason') == 'resource reserve breached'
        for e in events)


def released(events):
    stops = [i for i, e in enumerate(events) if e.get('phase') in ['guard-stop', 'done', 'launcher-error']]
    tail = events[stops[-1] + 1:] if stops else []
    return all(any(e.get('phase') == 'owned-' + name + '-released' for e in tail)
               for name in ['worker', 'backend']) and not any(e.get('phase') == 'release-unconfirmed' for e in tail)


def port_free():
    with socket.socket() as sock:
        if os.name == 'nt':
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        sock.bind(('127.0.0.1', 11435))


def boot_identity():
    result = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command',
                             "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')"],
                            capture_output=True, text=True, creationflags=0x08000000)
    value = result.stdout.strip()
    if result.returncode or not value:
        raise RuntimeError('Windows boot identity unavailable; refuse automatic orphan recovery')
    datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    return value


def recover_reboot(state, boot, lease_path, root):
    """A newer OS boot proves old processes cannot survive, even if PIDs repeat."""
    old = state.get('activeBoot')
    instant = lambda value: datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if not old or instant(boot) <= instant(old):
        return False
    active = pathlib.Path(state['active']).resolve()
    if str(active) not in state['attempts']:
        raise RuntimeError('Interrupted attempt is not owned by this supervisor')
    port_free()
    archive = root/'recovery'
    archive.mkdir(exist_ok=True)
    if lease_path.exists():
        raw = lease_path.read_bytes()
        lease = json.loads(raw)
        events = load(active/'LAUNCH.json')
        held = [e for e in events if e.get('phase') == 'central-lease-held']
        if not held or lease.get('owner') != held[0].get('owner') or not lease.get('owner') or instant(lease['at']) >= instant(boot):
            raise RuntimeError('Lease belongs to a new or unknown owner; preserve it')
        destination = archive/('lease-' + lease['owner'] + '.json')
        if destination.exists() or lease_path.read_bytes() != raw:
            raise RuntimeError('Lease changed or was already archived; refuse overwrite')
        os.rename(lease_path, destination)
    number = state.get('reboots', 0) + 1
    record = archive/('interruption-%04d.json' % number)
    if record.exists():
        saved = load(record)
        if saved.get('attempt') != str(active) or saved.get('previousBoot') != old:
            raise RuntimeError('Recovery record belongs to another interruption; preserve history')
    completed = False
    report = active/(state['arm'] + '-screen.json')
    if (active/'QUALIFICATION.json').exists() and (active/'LAUNCH.json').exists() and report.exists():
        events = load(active/'LAUNCH.json')
        validations = [e for e in events if e.get('phase') == 'stage-validation' and e.get('harness') == state['arm'] and e.get('stage') == 'screen']
        if validations and validations[-1].get('qualified') is True:
            old_launch = module(active/'launch.py', 'reserve_completed_recovery')
            old_launch.verify_qualification()
            completed = old_launch.validate_stage(report, load(active/'PREPARED.json')['screen'])['qualified'] and old_launch.cache_cap_state(active/'owned-ollama.log') == 'ok'
            if not completed:
                raise RuntimeError('A recorded completed arm failed fresh validation; preserve it for review')
            state['completed'][state['arm']] = {'report': str(report), 'sha256': digest(report), 'qualification': str(active/'QUALIFICATION.json')}
    if not record.exists():
        save(record, {'at': utc(), 'attempt': str(active), 'previousBoot': old, 'currentBoot': boot,
                  'reason': 'OS reboot interrupted this attempt; active spend may be unknown',
                  'rawReports': {p.name: digest(p) for p in active.glob('*-screen.json')},
                      'completedBeforeRestart': completed, 'freshWholeArmOnly': not completed})
    state.update(active=None, reboots=number)
    return True


def trim_opera():
    """Release resident pages only. No content reads, closures or committed-RAM claim."""
    if os.name != 'nt':
        return []
    result = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command',
                             'Get-Process -Name opera -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }'],
                            capture_output=True, text=True, creationflags=0x08000000)
    kernel, psapi = ctypes.WinDLL('kernel32', use_last_error=True), ctypes.WinDLL('psapi', use_last_error=True)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.QueryFullProcessImageNameW.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]
    psapi.EmptyWorkingSet.argtypes = [ctypes.c_void_p]
    records = []
    for line in result.stdout.splitlines():
        if not line.strip().isdigit():
            continue
        handle = kernel.OpenProcess(0x0500, False, int(line))
        if handle:
            try:
                name = ctypes.create_unicode_buffer(32768)
                length = ctypes.c_ulong(len(name))
                if kernel.QueryFullProcessImageNameW(handle, 0, name, ctypes.byref(length)) and pathlib.PureWindowsPath(name.value).name.lower() == 'opera.exe':
                    records.append({'image': 'opera', 'trimmed': bool(psapi.EmptyWorkingSet(handle))})
            finally:
                kernel.CloseHandle(handle)
    return records


def prepare(template, target, arm):
    if arm not in ORDER:
        raise ValueError('Unknown comparison arm')
    prepared = load(template / 'PREPARED.json')
    if not all(digest(p) == h for p, h in prepared['pins'].items()):
        raise RuntimeError('Template pins changed; preserve ownership and measurements')
    target.mkdir()  # Exclusive: never reuse any attempt or remove its STOP.
    for name in FILES:
        shutil.copyfile(template / name, target / name)
    text = (target / 'launch.py').read_text(encoding='utf-8')
    old = 'ORDER = ' + json.dumps(ORDER)
    if old not in text:
        raise RuntimeError('Expected frozen queue declaration missing')
    text = text.replace(old, 'ORDER = ' + repr([arm]), 1)
    (target / 'launch.py').write_text(text, encoding='utf-8')
    main_ast = lambda source: ast.dump(next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'main'))
    if main_ast(text) != main_ast((template / 'launch.py').read_text(encoding='utf-8')):
        raise RuntimeError('Owned child lifecycle or guards changed')
    qualifier = (target / 'qualify.py').read_text(encoding='utf-8')
    old_check = "check('fresh paired60 Atlias/Claude before Mini/Codex/Pi', launch.ORDER==['atlias','claude','mini-swe-agent','codex','pi'])"
    new_check = "check('fresh exact60 single arm matches admission manifest', launch.ORDER==json.loads((HERE/'ARM.json').read_text())['order'] and len(launch.ORDER)==1 and launch.ORDER[0] in ['atlias','claude','mini-swe-agent','codex','pi'])"
    if old_check not in qualifier:
        raise RuntimeError('Expected queue contract missing')
    (target / 'qualify.py').write_text(qualifier.replace(old_check, new_check, 1), encoding='utf-8')
    save(target / 'ARM.json', {'order': [arm], 'why': 'Release backend between arms; retain complete arms and retry only resource interruptions'})
    pins = {}
    for name, expected in prepared['pins'].items():
        original = pathlib.Path(name)
        local = target / original.name
        pins[str(local) if original.parent.resolve() == template.resolve() else name] = digest(local) if original.parent.resolve() == template.resolve() else expected
    pins[str(target / 'qualify.py')] = digest(target / 'qualify.py')
    pins[str(target / 'ARM.json')] = digest(target / 'ARM.json')
    prepared.update(pins=pins, previousPartial=str(template), reuseResults=False)
    save(target / 'PREPARED.json', prepared)
    (target/'NEXT.md').write_text('This is one exact60 ' + arm + ' arm under the resource supervisor. Follow the supervisor path in ../CONTINUATION.json and read its STATE.json and NEXT.md, then this attempt QUALIFICATION.json, LAUNCH.json, HEALTH.json, STOP and actual task reports. Never clear STOP, weaken guards or infer activity from a process alone. Earlier attempts remain intact.\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['run', 'probe'])
    parser.add_argument('--root', required=True, type=pathlib.Path)
    parser.add_argument('--template', required=True, type=pathlib.Path)
    args = parser.parse_args()
    root, template = args.root.resolve(), args.template.resolve()
    launch = module(template / 'launch.py', 'reserve_template')
    root.mkdir(parents=True, exist_ok=True)
    if args.mode == 'probe':
        print(json.dumps({'memory': launch.memory(), 'gpu': gpu_memory(), 'admissionPhysicalGiB': 8, 'admissionCommitGiB': 18}))
        return 0
    import msvcrt
    with (root / 'SUPERVISOR.lock').open('a+b') as lock:
        lock.seek(0); lock.write(b'1'); lock.flush(); lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        state_file = root / 'STATE.json'
        state = load(state_file) if state_file.exists() else {'completed': {}, 'attempts': [], 'resourceRetries': 0, 'firstLaunch': None}
        boot = boot_identity()
        def record(status, **fields):
            state.update(at=utc(), status=status, **fields)
            save(state_file, state)
        if state.get('status') == 'held' and not state.get('active'):
            return 0  # Intentional holds survive watchdog and sign-in restarts.
        if state.get('active'):
            if recover_reboot(state, boot, launch.LOCK, root):
                record('waiting', reason='New OS boot confirmed; prior partial data retained and owned stale lease archived')
            else:
                record('held', reason='Interrupted resident in same boot: preserve any live child or lease; no duplicate launch')
                return 1
        previous = load(template / 'LAUNCH.json')
        if not released(previous) or not retryable(previous, (template / 'STOP').read_text()):
            record('held', reason='Template resource-stop cleanup is not confirmed')
            return 1
        pointer = template.parent / 'CONTINUATION.json'
        owned_pointers = {str(template), *state['attempts']}
        stable_since, last_sample, last_trim = None, None, -900
        for arm in ORDER:
            if arm in state['completed']:
                complete = state['completed'][arm]
                if digest(complete['report']) != complete['sha256']:
                    raise RuntimeError('Completed report changed; refuse result reuse')
                continue
            while True:
                if (root / 'STOP').exists():
                    record('held', reason='Supervisor STOP retained'); return 1
                if state['firstLaunch'] and time.time() - state['firstLaunch'] >= 46800:
                    record('held', reason='Global13-hour work deadline reached'); return 1
                current = str(pathlib.Path(load(pointer)['continuation']).resolve())
                if current not in owned_pointers:
                    record('held', reason='Another continuation owns the benchmark pointer'); return 1
                memory = launch.memory()
                sample = time.monotonic()
                if last_sample is not None and sample - last_sample > 15:
                    stable_since = None  # A suspended or stalled PC is not a stable sample interval.
                last_sample = sample
                available = not launch.LOCK.exists()
                try:
                    port_free()
                except OSError:
                    available = False
                gpu = gpu_memory()
                ready = available and start_ready(memory) and gpu_ready(gpu)
                stable_since = stable_since or time.monotonic() if ready else None
                record('waiting', arm=arm, memory=memory, gpu=gpu, stableSeconds=0 if stable_since is None else int(time.monotonic() - stable_since), reason='Need120 seconds of8GiB physical/18GiB commit,9GiB free VRAM, GPU at most20percent, vacant port and lease')
                if not ready or time.monotonic() - stable_since < 120:
                    if time.monotonic() - last_trim > 900 and memory['availablePhysical'] < 8 * GIB:
                        record('waiting', operaResidentTrim=trim_opera()); last_trim = time.monotonic()
                    time.sleep(5); continue
                target = template.parent / ('continuation-1025-v7-%04d' % (len(state['attempts']) + 1))
                prepare(template, target, arm)
                state['attempts'].append(str(target)); owned_pointers.add(str(target))
                record('qualifying', active=str(target), activeBoot=boot, arm=arm)
                with (target / 'qualification.log').open('x', encoding='utf-8') as output:
                    result = subprocess.run([sys.executable, '-B', str(target / 'qualify.py')], cwd=target, stdout=output, stderr=subprocess.STDOUT, creationflags=0x08004000)
                if result.returncode or not load(target / 'QUALIFICATION.json')['passed']:
                    record('held', reason='New attempt qualification failed', active=None); return 1
                if (root / 'STOP').exists() or str(pathlib.Path(load(pointer)['continuation']).resolve()) != current:
                    record('held', reason='Stop or foreign continuation appeared during qualification', active=None); return 1
                try:
                    port_free()
                except OSError:
                    record('held', reason='Private model port acquired during qualification', active=None); return 1
                if not start_ready(launch.memory()) or not gpu_ready(gpu_memory()) or launch.LOCK.exists():
                    record('waiting', active=None, reason='Resources changed during qualification')
                    stable_since = None; continue
                state['firstLaunch'] = state['firstLaunch'] or time.time()
                info = load(pointer)
                info.update(at=utc(), continuation=str(target), qualification=str(target / 'QUALIFICATION.json'), status='resource supervisor admitted one exact60 arm; verify fresh task activity', supervisor=str(root), supersedes=current,
                            remaining=[name for name in ORDER if name not in state['completed']], completedArms=state['completed'])
                save(pointer, info)
                record('running', active=str(target), arm=arm)
                child = subprocess.Popen([sys.executable, '-B', str(target / 'start.py'), 'run'], cwd=target, creationflags=0x08004000)
                while child.poll() is None:
                    memory = launch.memory()
                    record('running', memory=memory)
                    if (root / 'STOP').exists() and not (target / 'STOP').exists():
                        (target / 'STOP').write_text('requested supervisor stop', encoding='utf-8')
                    if time.time() - state['firstLaunch'] >= 46800 and not (target / 'STOP').exists():
                        (target / 'STOP').write_text('global supervisor deadline', encoding='utf-8')
                    if time.monotonic() - last_trim > 900 and (memory['availablePhysical'] < 3 * GIB or memory['availableCommit'] < 6 * GIB):
                        record('running', operaResidentTrim=trim_opera()); last_trim = time.monotonic()
                    time.sleep(3)
                events = load(target / 'LAUNCH.json')
                state['active'] = None
                if not released(events) or launch.LOCK.exists():
                    record('held', reason='Owned child/backend cleanup or lease release is unconfirmed'); return 1
                port_free()
                validations = [e for e in events if e.get('phase') == 'stage-validation' and e.get('harness') == arm and e.get('stage') == 'screen']
                if child.returncode == 0 and validations and validations[-1].get('qualified') is True:
                    report = target / (arm + '-screen.json')
                    state['completed'][arm] = {'report': str(report), 'sha256': digest(report), 'qualification': str(target / 'QUALIFICATION.json')}
                    info = load(pointer)
                    if str(pathlib.Path(info['continuation']).resolve()) != str(target):
                        record('held', reason='Another continuation took ownership after this arm completed'); return 1
                    info.update(at=utc(), completedArms=state['completed'], remaining=[name for name in ORDER if name not in state['completed']], status='Qualified arm complete; resident supervisor admits the next arm only after stable reserves')
                    save(pointer, info)
                    record('arm-complete', arm=arm); stable_since = None; break
                stop = (target / 'STOP').read_text() if (target / 'STOP').exists() else ''
                if retryable(events, stop) and state['resourceRetries'] < 3:
                    state['resourceRetries'] += 1
                    record('waiting', reason='Resource-only interruption retained; wait for stronger stable reserves before fresh whole-arm attempt')
                    stable_since = None; continue
                record('held', reason='Non-resource failure or resource retry bound; preserve raw attempts'); return 1
        record('complete', active=None)
        return 0


if __name__ == '__main__':
    raise SystemExit(main())
