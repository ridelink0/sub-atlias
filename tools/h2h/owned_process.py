"""Bounded benchmark children, owned by handles rather than Windows PIDs."""
import atexit
import ctypes
import os
import signal
import subprocess
import threading
import time

WIN = os.name == "nt"
LIVE = set()
_LIVE_LOCK = threading.Lock()

if WIN:
    from ctypes import wintypes as W
    K = ctypes.WinDLL("kernel32", use_last_error=True)
    N = ctypes.WinDLL("ntdll")
    class Basic(ctypes.Structure):
        _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64), ("flags", W.DWORD),
                    ("minimum", ctypes.c_size_t), ("maximum", ctypes.c_size_t), ("active", W.DWORD),
                    ("affinity", ctypes.c_size_t), ("priority", W.DWORD), ("scheduling", W.DWORD)]
    class IO(ctypes.Structure):
        _fields_ = [(n, ctypes.c_uint64) for n in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]
    class Extended(ctypes.Structure):
        _fields_ = [("basic", Basic), ("io", IO), ("process_memory", ctypes.c_size_t),
                    ("job_memory", ctypes.c_size_t), ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]
    K.CreateJobObjectW.argtypes, K.CreateJobObjectW.restype = [ctypes.c_void_p, W.LPCWSTR], W.HANDLE
    K.SetInformationJobObject.argtypes, K.SetInformationJobObject.restype = [W.HANDLE, ctypes.c_int, ctypes.c_void_p, W.DWORD], W.BOOL
    K.AssignProcessToJobObject.argtypes, K.AssignProcessToJobObject.restype = [W.HANDLE, W.HANDLE], W.BOOL
    K.TerminateJobObject.argtypes, K.TerminateJobObject.restype = [W.HANDLE, W.UINT], W.BOOL
    K.TerminateProcess.argtypes, K.TerminateProcess.restype = [W.HANDLE, W.UINT], W.BOOL
    K.CloseHandle.argtypes, K.CloseHandle.restype = [W.HANDLE], W.BOOL
    N.NtResumeProcess.argtypes, N.NtResumeProcess.restype = [W.HANDLE], ctypes.c_long

def start_owned(argv, job_memory=0, process_memory=0, **kwargs):
    """job_memory (bytes, 0 = no limit): the most committed memory the whole owned tree may hold;
    process_memory (bytes, 0 = no limit): the most any one process in the tree may hold. Gev
    2026-10-16: a model-written solution under the grader took more than 7 GB within its 60 s and
    tripped the launcher's memory guard on three screens, and on a fourth the base arm's own run of the
    same task did; with a limit its allocations fail instead."""
    if not WIN:
        kwargs["start_new_session"] = True
        cap = min(x for x in (job_memory, process_memory) if x) if (job_memory or process_memory) else 0
        if cap:
            import resource
            kwargs["preexec_fn"] = lambda: resource.setrlimit(resource.RLIMIT_AS, (cap, cap))
        p = subprocess.Popen(argv, **kwargs)
    else:
        job = K.CreateJobObjectW(None, None)
        if not job:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = Extended()
        limits.basic.flags = 0x2000  # KILL_ON_JOB_CLOSE; children cannot outlive this owned job.
        if job_memory:
            limits.basic.flags |= 0x200  # JOB_OBJECT_LIMIT_JOB_MEMORY
            limits.job_memory = int(job_memory)
        if process_memory:
            limits.basic.flags |= 0x100  # JOB_OBJECT_LIMIT_PROCESS_MEMORY, every process in the tree
            limits.process_memory = int(process_memory)
        p = None
        try:
            if not K.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
                raise ctypes.WinError(ctypes.get_last_error())
            kwargs["creationflags"] = kwargs.get("creationflags", 0) | 0x4 | 0x08000000
            p = subprocess.Popen(argv, **kwargs)  # suspended before it can create descendants
            if not K.AssignProcessToJobObject(job, int(p._handle)):
                raise ctypes.WinError(ctypes.get_last_error())
            p._benchmark_job = job
            if N.NtResumeProcess(int(p._handle)) != 0:
                raise RuntimeError("the owned benchmark process could not be resumed")
        except BaseException:
            if p is not None:
                K.TerminateProcess(int(p._handle), 1)
                p.wait(timeout=10)
            K.CloseHandle(job)
            raise
    with _LIVE_LOCK:
        LIVE.add(p)
    return p

def kill_tree(p):
    """Stop only the job/session created by start_owned, never a discovered PID."""
    if p is None:
        return
    if WIN:
        job = getattr(p, "_benchmark_job", None)
        if job and not K.TerminateJobObject(job, 1):
            raise ctypes.WinError(ctypes.get_last_error())
    else:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

def release(p):
    if WIN:
        job = getattr(p, "_benchmark_job", None)
        if job:
            p._benchmark_job = None
            K.CloseHandle(job)
    else:
        kill_tree(p)
    with _LIVE_LOCK:
        LIVE.discard(p)

def run_tree(argv, *, cwd=None, env=None, timeout=60, stdout=None, shell=False, job_memory=0):
    p = start_owned(argv, job_memory=job_memory, cwd=cwd, env=env, stdin=subprocess.DEVNULL, shell=shell,
                    stdout=stdout if stdout is not None else subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        try:
            return p.wait(timeout=timeout), False
        except subprocess.TimeoutExpired:
            kill_tree(p)
            p.wait(timeout=15)
            return -1, True
    finally:
        release(p)

def end_all():
    with _LIVE_LOCK:
        children = list(LIVE)
    for p in children:
        try:
            kill_tree(p)
            release(p)
        except OSError:
            pass

def watch_parent(interval=1.0, on_gone=None):
    if WIN:
        from ctypes import wintypes as W
        K.OpenProcess.argtypes, K.OpenProcess.restype = [W.DWORD, W.BOOL, W.DWORD], W.HANDLE
        K.WaitForSingleObject.argtypes, K.WaitForSingleObject.restype = [W.HANDLE, W.DWORD], W.DWORD
        parent = K.OpenProcess(0x00100000, False, os.getppid())
        gone = lambda: bool(parent) and K.WaitForSingleObject(parent, 0) == 0
    else:
        parent = os.getppid()
        gone = lambda: os.getppid() != parent
    def loop():
        while True:
            time.sleep(interval)
            if gone():
                end_all()
                if on_gone:
                    on_gone()
                os._exit(3)
    t = threading.Thread(target=loop, name="benchmark-parent-watch", daemon=True)
    t.start()
    return t

atexit.register(end_all)
