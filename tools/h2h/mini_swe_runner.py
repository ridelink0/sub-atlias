"""Head-to-head: mini-swe-agent on atlias's task corpora, with the same local model, no Docker.

It runs mini-swe-agent's DefaultAgent with its text-based config on the task files `atlias eval`
reads, grades each task the way atlias does, and writes a report shaped like `atlias eval --save`
output, so `atlias compare atlias.json mini.json` pairs the two task by task.

Usage (mini-swe-agent importable, for example PYTHONPATH=<a pip --target dir>):
  python tools/h2h/mini_swe_runner.py --tasks evals/canitedit/lazy evals/humanevalfix/python \
      --out D:/runs/mini.json [--only id,id] [--ids-from atlias.json] [--budget N] [--repeat k] [--resume]
  --ids-from runs exactly the tasks another report ran (an `atlias eval --sample` run, say), so both
  arms of the comparison cover the same tasks.

Matched to atlias's Ollama call: /api/chat, temperature 0.2, num_ctx 16384, num_predict 2048
(atlias's agent.ollamaNumCtx and ollamaNumPredict). LiteLLM sends no num_ctx of its own, so without
it this driver would run at Ollama's default window while atlias does not, and the comparison would
measure the window instead of the harness. Step limit = the task's `rounds` unless --budget is given.
A task's `hidden` files (CanItEdit's tests and grader) are written only after the agent stops, as
atlias does. chars is the JSON length of the role/content message list, the measure atlias uses.

Code that never stops (2026-09-26: a model-written make_palindrome looped for ever, the old driver's
timeout ended only bash, and three pythons held a core each for hours while an orphaned runner kept
starting more): every action and every grading run is started as the root of its own process tree
and ended as a tree at its limit (taskkill /T on Windows, the process group elsewhere), and this
runner ends every tree it started, and then itself, when the process that started it goes away.
The tree helpers import nothing from mini-swe-agent, so test/proc-suites.mjs checks them without it.
"""
import argparse
import atexit
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import hashlib

WIN = os.name == "nt"
LIVE = set()  # Popen objects of every tree this runner has running
_LIVE_LOCK = threading.Lock()


def kill_tree(p):
    """Ends p and everything under it. Only ever called on a Popen this runner started."""
    if p is None or p.poll() is not None and WIN:
        # On Windows a dead root's orphans cannot be walked from it; the root is gone.
        return
    if WIN:
        subprocess.run(["taskkill", "/pid", str(p.pid), "/T", "/F"], capture_output=True, timeout=15)
    else:
        try:
            os.killpg(p.pid, signal.SIGKILL)  # the tree was started as a session of its own
        except (ProcessLookupError, PermissionError):
            pass


def run_tree(argv, *, cwd=None, env=None, timeout=60, stdout=None, shell=False):
    """Runs argv as the root of its own process tree. Returns (returncode, timed_out).
    stdout: a file object to write output to (stderr is joined to it), or None to discard.
    At the limit the whole tree is ended, not only the root."""
    kw = {"cwd": cwd, "env": env, "stdin": subprocess.DEVNULL, "shell": shell,
          "stdout": stdout if stdout is not None else subprocess.DEVNULL, "stderr": subprocess.STDOUT}
    if not WIN:
        kw["start_new_session"] = True
    p = subprocess.Popen(argv, **kw)
    with _LIVE_LOCK:
        LIVE.add(p)
    try:
        try:
            return p.wait(timeout=timeout), False
        except subprocess.TimeoutExpired:
            kill_tree(p)
            try:
                p.wait(timeout=15)
            except subprocess.TimeoutExpired:
                pass
            return -1, True
    finally:
        # A tree whose root has exited can still hold a process it put in the background: on POSIX
        # its session is ended here too; on Windows the root is gone and taskkill cannot walk it.
        if not WIN:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        with _LIVE_LOCK:
            LIVE.discard(p)


def end_all():
    with _LIVE_LOCK:
        live = list(LIVE)
    for p in live:
        try:
            kill_tree(p)
        except Exception:
            pass


def _parent_gone_check():
    """A function that says whether the process that started this one has gone. On Windows a handle
    to the parent is opened once, so a pid handed to a new process cannot fool it."""
    first = os.getppid()
    if not WIN:
        return lambda: os.getppid() != first
    import ctypes
    k32 = ctypes.windll.kernel32
    SYNCHRONIZE = 0x00100000
    h = k32.OpenProcess(SYNCHRONIZE, False, first)
    if not h:
        return lambda: False  # cannot watch it; the per-action limits still apply
    return lambda: k32.WaitForSingleObject(h, 0) == 0  # WAIT_OBJECT_0: the parent has exited


def watch_parent(interval=1.0, on_gone=None):
    """Ends every tree this runner started, and then the runner, when its parent goes away."""
    gone = _parent_gone_check()

    def loop():
        while True:
            time.sleep(interval)
            if gone():
                end_all()
                if on_gone:
                    on_gone()
                os._exit(3)

    t = threading.Thread(target=loop, name="parent-watch", daemon=True)
    t.start()
    return t


atexit.register(end_all)


def case_counts(output):
    """atlias's caseCounts (lib/eval.mjs): pytest's or unittest's own counts, or None."""
    text = str(output or "")

    def num(rx):
        m = re.search(rx, text)
        return int(m.group(1)) if m else 0
    passed = num(r"(\d+) passed")
    failed = num(r"(\d+) failed") + num(r"(\d+) errors?(?![=\w])")
    if passed or failed:
        return {"passed": passed, "failed": failed, "total": passed + failed, "from": "pytest"}
    ran = num(r"Ran (\d+) tests?")
    if ran:
        bad = min(ran, num(r"failures=(\d+)") + num(r"errors=(\d+)"))
        return {"passed": ran - bad, "failed": bad, "total": ran, "from": "unittest"}
    return None


def git_bash():
    """Git's bash on Windows (LocalEnvironment's shell=True would be cmd.exe, and a bare `bash`
    on PATH can be WSL's), /bin/bash elsewhere."""
    if not WIN:
        return shutil.which("bash") or "/bin/bash"
    try:
        ex = subprocess.run(["git", "--exec-path"], capture_output=True, text=True, timeout=20).stdout.strip()
        cand = pathlib.Path(ex).parents[2] / "usr" / "bin" / "bash.exe"  # <git>/mingw64/libexec/git-core
        if cand.exists():
            return str(cand)
    except Exception:
        pass
    return shutil.which("bash") or "bash"


REFUSE = ["vim", "vi", "nano", "emacs", "less", "more", "man", "winget", "choco", "scoop", "msiexec", "start",
          "powershell", "pwsh", "explorer", "runas", "setx", "reg", "sudo", "apt", "apt-get"]


def make_shims(where):
    """Editors, pagers and installers answer "command not found", as in the slim images mini-swe-agent
    runs in: on 2026-09-26 `vim` waited for keys for ever, and a `python3` that hit the Windows Store
    alias led the model to `winget install` a second Python. python3 runs this interpreter."""
    d = pathlib.Path(where)
    d.mkdir(parents=True, exist_ok=True)
    for name in REFUSE:
        (d / name).write_text(f'#!/bin/sh\necho "bash: {name}: command not found" >&2\nexit 127\n', encoding="utf-8", newline="\n")
        (d / f"{name}.cmd").write_text(f"@echo '{name}' is not recognized as an internal or external command, operable program or batch file. 1>&2\r\n@exit /b 9009\r\n", encoding="utf-8", newline="")
    py = sys.executable.replace("\\", "/")
    (d / "python3").write_text(f'#!/bin/sh\nexec "{py}" "$@"\n', encoding="utf-8", newline="\n")
    (d / "python3.cmd").write_text(f'@"{sys.executable}" %*\r\n', encoding="utf-8", newline="")
    if not WIN:
        for f in d.iterdir():
            if not f.suffix:
                f.chmod(0o755)
    return str(d)


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None


def context_chars(messages):
    """What the model was handed, measured as atlias measures it (JSON.stringify(st.messages).length):
    the JSON text of the role/content list, no whitespace, non-ASCII left as is."""
    rows = []
    for m in messages:
        c = m.get("content")
        rows.append({"role": m.get("role"), "content": c if isinstance(c, str) else str(c or "")})
    return len(json.dumps(rows, ensure_ascii=False, separators=(",", ":")))


def usage_tokens(messages, key):
    """Per model call, the engine's own count as LiteLLM reports it (usage.prompt_tokens is Ollama's
    prompt_eval_count, usage.completion_tokens its eval_count), or None."""
    out = []
    for m in messages:
        if m.get("role") != "assistant":
            continue
        u = ((m.get("extra") or {}).get("response") or {}).get("usage") or {}
        out.append(u.get(key) if isinstance(u, dict) else None)
    return out


def prompt_tokens(messages):
    return usage_tokens(messages, "prompt_tokens")


def make_env_class(bash, shims):
    from minisweagent.environments.local import LocalEnvironment

    class TreeBashEnvironment(LocalEnvironment):
        """LocalEnvironment, but each action runs in bash as a process tree of its own, ended as a
        tree at the limit; output goes to a file, so nothing that outlives the action can hold a pipe."""
        def execute(self, action, cwd="", *, timeout=None):
            cmd = action.get("command", "")
            env = os.environ | self.config.env
            env["PATH"] = shims + os.pathsep + env.get("PATH", "")
            with tempfile.TemporaryFile() as buf:
                rc, timed_out = run_tree([bash, "-c", cmd], cwd=cwd or self.config.cwd, env=env,
                                         timeout=timeout or self.config.timeout, stdout=buf)
                buf.seek(0)
                text = buf.read().decode("utf-8", errors="replace")
            info = f"timeout: the command ran past {timeout or self.config.timeout} s and it and everything it started were stopped" if timed_out else ""
            out = {"output": text, "returncode": rc, "exception_info": info}
            self._check_finished(out)
            return out
    return TreeBashEnvironment


def run_one(task, a, cfg, agent_cfg, tag, Env):
    from minisweagent.agents.default import DefaultAgent
    from minisweagent.models.litellm_textbased_model import LitellmTextbasedModel
    budget = a.budget or int(task.get("rounds") or 25)
    ws = pathlib.Path(a.work) / f"{task['id']}-{int(time.time() * 1000)}-{tag}"
    ws.mkdir(parents=True, exist_ok=True)
    for name, body in task["files"].items():
        p = ws / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(body.encode("utf-8"))
    protect = task.get("protect") or []
    before = {p: sha(ws / p) for p in protect}
    model = LitellmTextbasedModel(model_name=a.model, cost_tracking="ignore_errors",
                                  model_kwargs={"api_base": a.api_base, "temperature": 0.2, "drop_params": True,
                                                "num_ctx": a.num_ctx, "num_predict": a.num_predict},
                                  observation_template=cfg["model"]["observation_template"],
                                  format_error_template=cfg["model"]["format_error_template"])
    env = Env(cwd=str(ws), timeout=a.action_timeout, env=cfg["environment"]["env"])
    agent = DefaultAgent(model, env, **{**agent_cfg, "step_limit": budget, "cost_limit": 0})
    t0 = time.time()
    exit_status = ""
    try:
        info = agent.run(task["prompt"])
        exit_status = (info or {}).get("exit_status", "")
    except Exception as e:  # a crash is a fail, not a skipped task
        exit_status = f"crash: {type(e).__name__}: {e}"[:200]
    agent_ms = int((time.time() - t0) * 1000)
    tampered = [p for p, h in before.items() if sha(ws / p) != h]
    for p in tampered:  # grade against the shipped file, as atlias does
        (ws / p).write_bytes(task["files"][p].encode("utf-8"))
    for rel, body in (task.get("hidden") or {}).items():
        p = ws / rel
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(str(body).encode("utf-8"))
        except Exception:
            pass  # the check then fails, which is the honest result
    chk = task["check"] if isinstance(task["check"], list) else task["check"].split()
    limit = max(5, task.get("timeoutMs", 60000) / 1000)
    env_chk = os.environ | {"PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    with tempfile.TemporaryFile() as buf:
        try:
            rc, timed_out = run_tree(chk, cwd=str(ws), env=env_chk, timeout=limit, stdout=buf)
        except Exception as e:
            rc, timed_out = -1, False
            buf.write(str(e).encode("utf-8"))
        buf.seek(0)
        full = buf.read().decode("utf-8", errors="replace")
    check_ok = rc == 0 and not timed_out
    tail = (f"[the check ran past {limit:.0f} s and was stopped with everything it started]\n" if timed_out else "") + full[-300:]
    chars = context_chars(agent.messages)
    toks = prompt_tokens(agent.messages)
    outs = usage_tokens(agent.messages, "completion_tokens")
    passed = check_ok and not tampered
    if passed and not a.keep:
        shutil.rmtree(ws, ignore_errors=True)
    else:
        (ws / "trajectory.json").write_text(json.dumps(agent.messages, default=str, indent=1), encoding="utf-8")
    return {"id": task["id"], "name": task.get("name", task["id"]), "pass": passed,
            "checkExit": check_ok, "tampered": tampered, "rounds": agent.n_calls, "budget": budget,
            "stop": exit_status, "chars": chars, "promptTokens": toks, "cases": case_counts(full),
            "promptTotal": sum(t for t in toks if isinstance(t, int)) if any(isinstance(t, int) for t in toks) else None,
            "outputTokens": outs,
            "outputTotal": sum(t for t in outs if isinstance(t, int)) if any(isinstance(t, int) for t in outs) else None,
            "peakPrompt": max([t for t in toks if isinstance(t, int)] or [0]), "numCtx": a.num_ctx,
            "ms": int((time.time() - t0) * 1000), "agentMs": agent_ms,
            "workspace": None if (passed and not a.keep) else str(ws), "output": tail}


def report(results, a, t_all, tries):
    runs = [x for r in results for x in (r.get("attempts") or [r])]
    rows = [r.get("cases") for r in results if r.get("cases") and r["cases"].get("total")]
    return {"results": results, "passed": sum(1 for r in results if r["pass"]), "total": len(results),
            "anyPassed": sum(1 for r in results if r.get("passes", 1 if r["pass"] else 0) > 0),
            "attemptsPassed": sum(r.get("passes", 1 if r["pass"] else 0) for r in results),
            "attemptsTotal": sum(r.get("tries", 1) for r in results), "tries": tries,
            "chars": sum(x["chars"] for x in runs), "ms": int((time.time() - t_all) * 1000),
            "cases": {"tasks": len(rows), "of": len(results), "passed": sum(c["passed"] for c in rows),
                      "total": sum(c["total"] for c in rows)} if rows else None,
            "engine": "mini-swe-agent (textbased, bash local env, tree-killed actions)", "model": a.model,
            "numCtx": a.num_ctx, "numPredict": a.num_predict, "corpus": {"tasks": a.tasks, "ids": a.ids_from or None}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", required=True, nargs="+", help="one or more task directories")
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--ids-from", default="", help="run exactly the task ids of this saved report")
    ap.add_argument("--budget", type=int, default=0)
    ap.add_argument("--repeat", type=int, default=1, help="attempts per task; a task passes only when every attempt does")
    ap.add_argument("--resume", action="store_true", help="keep the tasks already in --out and run only the rest")
    ap.add_argument("--keep", action="store_true", help="keep the workspace of a passing attempt too")
    ap.add_argument("--model", default="ollama_chat/qwen2.5-coder:7b")
    ap.add_argument("--api-base", default="http://127.0.0.1:11434")
    ap.add_argument("--work", default=os.path.join(tempfile.gettempdir(), "mswe-h2h"))
    ap.add_argument("--num-ctx", type=int, default=16384)
    ap.add_argument("--num-predict", type=int, default=2048)
    ap.add_argument("--action-timeout", type=int, default=120, help="seconds per action, as atlias's eval shell limit")
    ap.add_argument("--bash", default="", help="the bash to run actions in (default: Git's bash on Windows)")
    a = ap.parse_args()
    watch_parent()
    for sig in ("SIGTERM", "SIGHUP", "SIGBREAK"):
        if hasattr(signal, sig):
            signal.signal(getattr(signal, sig), lambda *_: (end_all(), os._exit(4)))
    import yaml
    from minisweagent import package_dir
    tries = max(1, a.repeat)
    cfg = yaml.safe_load((package_dir / "config" / "mini_textbased.yaml").read_text())
    agent_cfg = {k: v for k, v in cfg["agent"].items() if k != "mode"}
    pathlib.Path(a.work).mkdir(parents=True, exist_ok=True)
    Env = make_env_class(a.bash or git_bash(), make_shims(pathlib.Path(a.work) / "_shims"))
    files = sorted(f for d in a.tasks for f in pathlib.Path(d).glob("*.json"))
    if a.only:
        want = [s for s in a.only.split(",") if s]
        files = [f for f in files if any(w in f.stem for w in want)]
    if a.ids_from:
        ids = {r["id"] for r in json.loads(pathlib.Path(a.ids_from).read_text(encoding="utf-8")).get("results", [])}
        files = [f for f in files if json.loads(f.read_text(encoding="utf-8")).get("id") in ids]
    results, t_all = [], time.time()
    out = pathlib.Path(a.out)
    if a.resume and out.exists():
        results = json.loads(out.read_text(encoding="utf-8")).get("results", [])
    done = {r["id"] for r in results}
    try:
        for f in files:
            task = json.loads(f.read_text(encoding="utf-8"))
            if task["id"] in done:
                continue
            attempts = [run_one(task, a, cfg, agent_cfg, i, Env) for i in range(tries)]
            passes = sum(1 for x in attempts if x["pass"])
            face = next((x for x in attempts if not x["pass"]), attempts[0])
            res = {**face, "pass": passes == tries, "passes": passes, "tries": tries}
            if tries > 1:
                res["attempts"] = attempts
            results.append(res)
            # Written after every task, so a run that dies at hour five keeps what it did.
            out.write_text(json.dumps(report(results, a, t_all, tries), indent=2), encoding="utf-8")
            spent = sum(x["ms"] for x in attempts) / 1000
            print(f"{'PASS' if res['pass'] else 'FAIL'}  {res['name']}  {passes}/{tries}  ({res['rounds']}/{res['budget']} steps, {spent:.1f}s, {res['stop']})", flush=True)
    finally:
        end_all()
    rep = report(results, a, t_all, tries)
    out.write_text(json.dumps(rep, indent=2), encoding="utf-8")
    print(f"{rep['passed']}/{rep['total']} ({rep['attemptsPassed']}/{rep['attemptsTotal']} attempts) in {rep['ms']/1000:.0f}s, {rep['chars']} chars", flush=True)


if __name__ == "__main__":
    main()
