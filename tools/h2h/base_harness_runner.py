"""Base-harness head-to-head for Gev: stock nanobot against stock OpenCode on atlias's task
corpora, with the same local model, to choose the harness atlias is built on.

Each task is run once by the chosen harness as it ships: its own prompt, its own loop and its own
built-in file and shell tools, and nothing of atlias (no atlias tools, skills, hooks or prompt).
Both arms get the same things from this runner and nothing else:
  - the task files in an empty directory and the task's prompt as the one message;
  - the same model through one metering door (below), so sampling and limits cannot differ;
  - the task's `rounds` as the number of model calls allowed, as atlias and the plain arm have;
  - the same wall-clock limit per task, the same grading (the task's check, hidden files written
    only after the harness has stopped, protected files restored first), and no way off this PC.

The metering door is a loopback HTTP server that forwards /v1/chat/completions to Ollama's
OpenAI-compatible endpoint. On every call it sets the model, temperature 0.2 and max_tokens to
--num-predict (atlias's ollamaNumPredict), asks for the usage block, and writes down Ollama's own
prompt and output token counts. The window is the server's own (the private Ollama is started with
OLLAMA_CONTEXT_LENGTH equal to atlias's ollamaNumCtx; --num-ctx is recorded, and checked against
/api/ps after each task, so a run at another window is reported and not passed off as matched).
Past the allowed number of calls the door answers by itself with a plain "stop" message, so the
harness ends its own loop, and the row says so. Any request for somewhere else is refused with 403:
HTTP_PROXY and HTTPS_PROXY of the harness point here.

The report is shaped like `atlias eval --save` output and the plain arm's, so the same summary
reads all of them: id, pass, promptTotal, outputTotal, peakPrompt per task.

Usage:
  python tools/h2h/base_harness_runner.py --harness nanobot|opencode --tasks <dir> [<dir>...]
      --out report.json --model qwen3.5:9b [--ids-from atlias.json] [--only id,id] [--resume]
"""
import argparse
import http.server
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from mini_swe_runner import LIVE, _LIVE_LOCK, WIN, case_counts, end_all, kill_tree, make_shims, run_tree, sha, watch_parent  # noqa: E402

STOP_TEXT = "The step limit for this task has been reached. Stop now."
KEEP_ENV = {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PATH", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG", "TZ", "SYSTEMDRIVE"}


class Door(http.server.ThreadingHTTPServer):
    """The metering door for one task."""
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, upstream, model, num_predict, budget):
        super().__init__(("127.0.0.1", 0), DoorHandler)
        self.upstream = upstream.rstrip("/")
        self.model, self.num_predict, self.budget = model, num_predict, budget
        self.lock = threading.Lock()
        self.calls = 0          # chat calls asked for
        self.usage = []         # one (prompt, output) per call sent to the model; None where Ollama gave no count
        self.capped = 0         # calls answered by the door itself, past the budget
        self.refused = []       # requests for somewhere else
        self.errors = []        # upstream failures, as text
        self.passed = []        # every other request let through to the model server: seconds in, method, path, status
        self.t0 = time.time()
        self.first = None       # when the first chat call arrived: the task's clock starts there

    @property
    def base(self):
        return f"http://127.0.0.1:{self.server_address[1]}"


def _usage_of(obj):
    u = obj.get("usage") if isinstance(obj, dict) else None
    if not isinstance(u, dict):
        return None
    p, c = u.get("prompt_tokens"), u.get("completion_tokens")
    return (p, c) if isinstance(p, int) and isinstance(c, int) and not isinstance(p, bool) and not isinstance(c, bool) else None


class DoorHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # one request per connection; the body ends when the door closes it

    def log_message(self, *_):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
        except OSError:
            pass  # the harness closed the connection first (OpenCode does as it exits); nobody is left to answer

    def _local(self):
        return self.path.startswith("/")

    def _body(self):
        """The request body, whether it came with a length or in chunks (bun's fetch sends chunks)."""
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            out = b""
            while True:
                line = self.rfile.readline(65537).split(b";")[0].strip()
                size = int(line, 16) if line else 0
                if size <= 0:
                    while self.rfile.readline(65537).strip():  # trailers, up to the blank line
                        pass
                    return out
                out += self.rfile.read(size)
                self.rfile.readline(65537)  # the line end after each chunk
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        return self.rfile.read(n) if n > 0 else b""

    def _note(self, status):
        s = self.server
        with s.lock:
            if len(s.passed) < 200:
                s.passed.append([round(time.time() - s.t0, 1), self.command, self.path[:120], status])

    def _refuse(self):
        with self.server.lock:
            self.server.refused.append(f"{self.command} {self.path}"[:200])
        self._send(403, {"error": {"message": "this run cannot leave the PC", "type": "refused"}})

    def do_CONNECT(self):
        self._refuse()

    def do_GET(self):
        if not self._local():
            return self._refuse()
        self._pass(None)

    def do_POST(self):
        if not self._local():
            return self._refuse()
        try:
            raw = self._body()
        except Exception:
            return self._send(400, {"error": {"message": "the request body could not be read"}})
        if self.path.split("?")[0].rstrip("/").endswith("/chat/completions"):
            return self._chat(raw)
        self._pass(raw)

    def _pass(self, raw):
        """Anything that is not a chat call (the model list, say) goes to Ollama unchanged."""
        try:
            req = urllib.request.Request(self.server.upstream + self.path, data=raw, method=self.command,
                                         headers={"Content-Type": self.headers.get("Content-Type") or "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                self._note(r.status)
                self._send(r.status, r.read(), r.headers.get("Content-Type") or "application/json")
        except urllib.error.HTTPError as e:
            self._note(e.code)
            self._send(e.code, e.read(), e.headers.get("Content-Type") or "application/json")
        except Exception as e:
            self._note(f"{type(e).__name__}"[:40])
            self._send(502, {"error": {"message": f"the model server did not answer: {e}"[:300]}})

    def _stop_reply(self, stream):
        s = self.server
        now, mid = int(time.time()), "chatcmpl-step-limit"
        if not stream:
            return self._send(200, {"id": mid, "object": "chat.completion", "created": now, "model": s.model,
                                    "choices": [{"index": 0, "message": {"role": "assistant", "content": STOP_TEXT}, "finish_reason": "stop"}],
                                    "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}})
        chunk = lambda delta, fin: {"id": mid, "object": "chat.completion.chunk", "created": now, "model": s.model,  # noqa: E731
                                    "choices": [{"index": 0, "delta": delta, "finish_reason": fin}]}
        parts = [chunk({"role": "assistant", "content": STOP_TEXT}, None), chunk({}, "stop"),
                 {"id": mid, "object": "chat.completion.chunk", "created": now, "model": s.model, "choices": [],
                  "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}}]
        body = "".join(f"data: {json.dumps(p)}\n\n" for p in parts) + "data: [DONE]\n\n"
        self._send(200, body.encode("utf-8"), "text/event-stream")

    def _chat(self, raw):
        s = self.server
        try:
            body = json.loads(raw.decode("utf-8"))
            if not isinstance(body, dict):
                raise ValueError("not an object")
        except Exception:
            return self._send(400, {"error": {"message": "the request body is not a JSON object"}})
        stream = body.get("stream") is True
        with s.lock:
            s.calls += 1
            if s.first is None:
                s.first = time.time()
            over = s.calls > s.budget
            if over:
                s.capped += 1
            else:
                # The call's place is kept before it is sent, and filled the moment Ollama's count is
                # seen, so a harness that hangs up straight after its answer cannot lose the count.
                slot = len(s.usage)
                s.usage.append(None)
        if over:
            return self._stop_reply(stream)
        body["model"] = s.model
        body["temperature"] = 0.2
        body["max_tokens"] = s.num_predict
        body.pop("max_completion_tokens", None)
        if stream:
            body["stream_options"] = {"include_usage": True}
        try:
            req = urllib.request.Request(s.upstream + "/v1/chat/completions", data=json.dumps(body).encode("utf-8"), method="POST",
                                         headers={"Content-Type": "application/json", "Authorization": "Bearer local"})
            with urllib.request.urlopen(req, timeout=1800) as r:
                if not stream:
                    data = r.read()
                    try:
                        s.usage[slot] = _usage_of(json.loads(data.decode("utf-8")))
                    except Exception:
                        pass
                    self._send(r.status, data, r.headers.get("Content-Type") or "application/json")
                else:
                    self.send_response(r.status)
                    self.send_header("Content-Type", r.headers.get("Content-Type") or "text/event-stream")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    for line in r:
                        if line.startswith(b"data:") and b'"usage"' in line:
                            try:
                                s.usage[slot] = _usage_of(json.loads(line[5:].decode("utf-8").strip())) or s.usage[slot]
                            except Exception:
                                pass
                        try:
                            self.wfile.write(line)
                            self.wfile.flush()
                        except Exception:
                            break  # the harness went away; the count seen so far stands
        except urllib.error.HTTPError as e:
            with s.lock:
                s.errors.append(f"HTTP {e.code}"[:200])
            try:
                self._send(e.code, e.read(), e.headers.get("Content-Type") or "application/json")
            except Exception:
                pass
        except Exception as e:
            with s.lock:
                s.errors.append(f"{type(e).__name__}: {e}"[:200])
            try:
                self._send(502, {"error": {"message": f"the model server did not answer: {e}"[:300]}})
            except Exception:
                pass


def run_harness(argv, *, cwd, env, door, start_limit, task_limit, stdout, stdin_text=None):
    """argv as the root of its own process tree, with the prompt on stdin when given. Two limits,
    each ending the whole tree: `start_limit` seconds to make the first model call (OpenCode run
    from source needs about 150 s on this PC before it asks for anything, nanobot a few), then
    `task_limit` seconds from that first call, so both harnesses get the same time to work.
    Returns (returncode, why it was stopped or '')."""
    kw = {"cwd": cwd, "env": env, "stdin": subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
          "stdout": stdout, "stderr": subprocess.STDOUT}
    if not WIN:
        kw["start_new_session"] = True
    p = subprocess.Popen(argv, **kw)
    with _LIVE_LOCK:
        LIVE.add(p)
    try:
        if stdin_text is not None:
            try:
                p.stdin.write(stdin_text.encode("utf-8"))
                p.stdin.close()
            except Exception:
                pass  # a harness that never read its prompt fails the task by itself
        t0 = time.time()
        while True:
            try:
                return p.wait(timeout=1), ""
            except subprocess.TimeoutExpired:
                pass
            now, first = time.time(), door.first
            why = ""
            if first is None and now - t0 > start_limit:
                why = f"timeout: no model call in the first {start_limit} s"
            elif first is not None and now - first > task_limit:
                why = f"timeout: {task_limit} s passed since its first model call"
            if why:
                kill_tree(p)
                try:
                    p.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    pass
                return -1, why + " and the harness was stopped with everything it started"
    finally:
        if not WIN:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        with _LIVE_LOCK:
            LIVE.discard(p)


def offline_env(state, door, shims, extra_path=(), extra=None):
    """A child environment built from nothing: what a process needs to start, a home of its own
    under `state`, and proxies that lead to the door, which refuses anything but the model."""
    env = {}
    for k, v in os.environ.items():
        if k.upper() in KEEP_ENV and k.upper() not in {e.upper() for e in env}:
            env[k] = v
    key = next((k for k in env if k.upper() == "PATH"), "PATH")
    env[key] = os.pathsep.join([shims, *[str(x) for x in extra_path], env.get(key, "")])

    def d(*parts):
        x = pathlib.Path(state).joinpath(*parts)
        x.mkdir(parents=True, exist_ok=True)
        return str(x)
    home = d("home")
    env.update({"HOME": home, "USERPROFILE": home, "APPDATA": d("appdata", "Roaming"), "LOCALAPPDATA": d("appdata", "Local"),
                "XDG_DATA_HOME": d("xdg", "data"), "XDG_CACHE_HOME": d("xdg", "cache"), "XDG_CONFIG_HOME": d("xdg", "config"),
                "XDG_STATE_HOME": d("xdg", "state"), "TMP": d("tmp"), "TEMP": d("tmp"), "TMPDIR": d("tmp"),
                "HTTP_PROXY": door.base, "HTTPS_PROXY": door.base, "http_proxy": door.base, "https_proxy": door.base,
                "NO_PROXY": "127.0.0.1,localhost,::1", "no_proxy": "127.0.0.1,localhost,::1",
                "NO_COLOR": "1", "DO_NOT_TRACK": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"})
    env.update(extra or {})
    return env


def nanobot_command(a, task, ws, state, door, budget, env):
    """Stock nanobot, one message, its workspace the task directory. Nothing is added to it: no MCP
    server, no skill, no channel; its own file and shell tools are its harness."""
    cfg = {"agents": {"defaults": {"workspace": str(ws), "model": a.model, "provider": "custom", "maxTokens": a.num_predict,
                                   "contextWindowTokens": a.num_ctx, "temperature": 0.2, "maxToolIterations": budget}},
           "providers": {"custom": {"apiKey": "local", "apiBase": door.base + "/v1"}}}
    cfg_file = pathlib.Path(state) / "nanobot-config.json"
    cfg_file.write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    return [a.nanobot, "agent", "-m", task["prompt"], "-w", str(ws), "-c", str(cfg_file), "-s", "h2h", "--no-markdown"], str(ws), None


def opencode_command(a, task, ws, state, door, budget, env):
    """Stock OpenCode (the pinned source, run by the pinned bun), one `run`, its directory the task
    directory. Its own prompt and tools; every tool allowed but leaving the task directory."""
    keep = 1024 if a.num_ctx <= 8192 else 2048
    agent = {"mode": "primary", "description": "base harness head-to-head", "steps": budget,
             "permissions": [{"action": "*", "resource": "*", "effect": "allow"},
                             {"action": "external_directory", "resource": "*", "effect": "deny"}]}
    cfg = {"model": f"ollama/{a.model}", "default_agent": "base", "update": "disable", "share": "disabled", "warming": False,
           "snapshots": False, "lsp": False, "formatter": False, "websearch": False,
           "compaction": {"auto": True, "keep": {"tokens": keep}, "buffer": a.num_predict + 512},
           # The package is named here, as OpenCode's own Ollama plugin sets it once it has listed the
           # server's models: without it a run that starts before that listing ends has no route
           # to its model (seen 2026-10-11, one start in two).
           "providers": {"ollama": {"package": "@opencode/ai/providers/openai-compatible", "settings": {"baseURL": door.base + "/v1", "apiKey": "local"},
                                    "models": {a.model: {"limit": {"context": a.num_ctx, "output": a.num_predict}}}}},
           "agents": {"base": agent}}
    (pathlib.Path(state) / "opencode-config.json").write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    env.update({"OPENCODE_TEST_HOME": env["HOME"], "OPENCODE_CONFIG_PROJECT_DISABLE": "1", "OPENCODE_DISABLE_MODELS_FETCH": "1",
                "OPENCODE_DISABLE_FFF": "1", "OPENCODE_FILEWATCHER_DISABLE": "1", "OPENCODE_CONFIG_CONTENT": json.dumps(cfg), "PWD": str(ws)})
    cli = pathlib.Path(a.opencode_source) / "packages" / "cli"
    argv = [a.bun, "run", str(cli / "src" / "index.ts"), "run", "--format", "json", "--model", f"ollama/{a.model}", "--agent", "base", "--standalone"]
    return argv, str(cli), task["prompt"]


HARNESS = {"nanobot": nanobot_command, "opencode": opencode_command}


def loaded_window(api_base, model):
    """The window Ollama has this model loaded at right now, or None."""
    try:
        with urllib.request.urlopen(api_base.rstrip("/") + "/api/ps", timeout=10) as r:
            for m in json.loads(r.read().decode("utf-8")).get("models", []):
                if m.get("name") == model or m.get("model") == model:
                    return m.get("context_length")
    except Exception:
        return None
    return None


def run_one(task, a, shims):
    budget = a.budget or int(task.get("rounds") or 25)
    stamp = f"{task['id']}-{int(time.time() * 1000)}"
    ws = pathlib.Path(a.work) / stamp
    state = pathlib.Path(a.work) / "_state" / stamp
    ws.mkdir(parents=True, exist_ok=True)
    state.mkdir(parents=True, exist_ok=True)
    for name, body in task["files"].items():
        p = ws / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(body.encode("utf-8"))
    shipped = {str(p.relative_to(ws)).replace("\\", "/") for p in ws.rglob("*") if p.is_file()}
    protect = task.get("protect") or []
    before = {p: sha(ws / p) for p in protect}
    door = Door(a.api_base, a.model, a.num_predict, budget)
    threading.Thread(target=door.serve_forever, daemon=True).start()
    t0 = time.time()
    stop, rc, starts = "", None, 1
    log = state / "harness-output.txt"
    try:
        # Start-up caches kept between tasks, so no task pays for them again and neither harness needs
        # the network: nanobot's token-counter file, and bun's compiled copy of OpenCode's source.
        caches = {"TIKTOKEN_CACHE_DIR": str(a.tiktoken_cache)} if a.harness == "nanobot" else {"BUN_RUNTIME_TRANSPILER_CACHE_PATH": str(pathlib.Path(a.work) / "_bun-cache")}
        env = offline_env(state, door, shims, extra_path=[pathlib.Path(a.ripgrep).parent] if a.harness == "opencode" and a.ripgrep else (), extra=caches)
        argv, cwd, stdin_text = HARNESS[a.harness](a, task, ws, state, door, budget, env)
        with open(log, "wb") as buf:
            rc, stopped = run_harness(argv, cwd=cwd, env=env, door=door, start_limit=a.start_timeout, task_limit=a.task_timeout, stdout=buf, stdin_text=stdin_text)
            # A start that never reached the model is tried once more: no call was made, so the task
            # is not attempted twice (stock OpenCode sometimes asks for its model before it has found it).
            if door.calls == 0 and rc != 0 and not stopped:
                starts = 2
                buf.write(b"[no model call was made; started again]" + os.linesep.encode())
                buf.flush()
                rc, stopped = run_harness(argv, cwd=cwd, env=env, door=door, start_limit=a.start_timeout, task_limit=a.task_timeout, stdout=buf, stdin_text=stdin_text)
        stop = stopped or f"exit {rc}"
    except Exception as e:  # a harness that cannot start is a fail, not a skipped task
        stop = f"crash: {type(e).__name__}: {e}"[:200]
    finally:
        door.shutdown()
        door.server_close()
    agent_ms = int((time.time() - t0) * 1000)
    # What the harness itself left behind, listed before the hidden files are written: listed after,
    # the grader's own files looked as if the harness could have read them (council member h11, 2026-10-12).
    added = sorted(str(p.relative_to(ws)).replace("\\", "/") for p in ws.rglob("*") if p.is_file() and str(p.relative_to(ws)).replace("\\", "/") not in shipped)[:40]
    try:  # what went through the door, kept beside the harness's own output
        (state / "door-log.json").write_text(json.dumps({"calls": door.calls, "usage": door.usage, "capped": door.capped, "refused": door.refused,
                                                         "errors": door.errors, "passed": door.passed}, indent=1), encoding="utf-8")
    except Exception:
        pass
    window = loaded_window(a.api_base, a.model)
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
            crc, ctimed = run_tree(chk, cwd=str(ws), env=env_chk, timeout=limit, stdout=buf)
        except Exception as e:
            crc, ctimed = -1, False
            buf.write(str(e).encode("utf-8"))
        buf.seek(0)
        full = buf.read().decode("utf-8", errors="replace")
    check_ok = crc == 0 and not ctimed
    tail = (f"[the check ran past {limit:.0f} s and was stopped with everything it started]\n" if ctimed else "") + full[-300:]
    usage = list(door.usage)
    # No call at all is a true count of nothing; one call Ollama gave no count for leaves the totals unknown.
    counted = all(u is not None for u in usage)
    toks = [u[0] if u else None for u in usage]
    outs = [u[1] if u else None for u in usage]
    passed = check_ok and not tampered
    if door.capped:
        stop += f"; step limit reached ({door.capped} further call(s) answered with a stop)"
    if passed and not a.keep:
        shutil.rmtree(ws, ignore_errors=True)
        shutil.rmtree(state, ignore_errors=True)
    return {"id": task["id"], "name": task.get("name", task["id"]), "pass": passed, "checkExit": check_ok, "tampered": tampered,
            "rounds": len(usage), "budget": budget, "stop": stop, "harnessExit": rc, "starts": starts,
            "startMs": int((door.first - t0) * 1000) if door.first else None, "promptTokens": toks, "cases": case_counts(full),
            # A call Ollama gave no count for leaves the totals unknown, never a smaller number.
            "promptTotal": sum(toks) if counted else None, "outputTokens": outs, "outputTotal": sum(outs) if counted else None,
            "peakPrompt": max([t for t in toks if isinstance(t, int)] or [0]), "numCtx": a.num_ctx, "loadedWindow": window,
            "refused": door.refused[:20], "modelErrors": door.errors[:20], "addedFiles": None if (passed and not a.keep) else added,
            "ms": int((time.time() - t0) * 1000), "agentMs": agent_ms,
            "workspace": None if (passed and not a.keep) else str(ws), "state": None if (passed and not a.keep) else str(state), "output": tail}


def report(results, a, t_all):
    windows = sorted({r.get("loadedWindow") for r in results if r.get("loadedWindow")})
    return {"results": results, "passed": sum(1 for r in results if r["pass"]), "total": len(results),
            "ms": int((time.time() - t_all) * 1000), "engine": f"{a.harness} (stock, metered door, offline)", "harness": a.harness,
            "model": a.model, "numCtx": a.num_ctx, "numPredict": a.num_predict, "loadedWindows": windows,
            "windowMatched": windows == [a.num_ctx] if windows else None, "corpus": {"tasks": a.tasks, "ids": a.ids_from or None}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--harness", required=True, choices=sorted(HARNESS))
    ap.add_argument("--tasks", required=True, nargs="+", help="one or more task directories")
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--ids-from", default="", help="run exactly the task ids of this saved report")
    ap.add_argument("--budget", type=int, default=0)
    ap.add_argument("--resume", action="store_true", help="keep the tasks already in --out and run only the rest")
    ap.add_argument("--keep", action="store_true", help="keep the workspace of a passing task too")
    ap.add_argument("--model", required=True, help="the Ollama model name, for example qwen3.5:9b")
    ap.add_argument("--api-base", default="http://127.0.0.1:11435")
    ap.add_argument("--work", default=os.path.join(tempfile.gettempdir(), "base-h2h"))
    ap.add_argument("--num-ctx", type=int, default=16384)
    ap.add_argument("--num-predict", type=int, default=2048)
    ap.add_argument("--task-timeout", type=int, default=1200, help="seconds a harness may work on one task, from its first model call")
    ap.add_argument("--start-timeout", type=int, default=600, help="seconds a harness may take to make its first model call")
    ap.add_argument("--nanobot", default="D:/harness-work/venvs/nanobot/Scripts/nanobot.exe")
    ap.add_argument("--bun", default="D:/harness-work/atlias-opencode-1009/runtime/bun-windows-x64/bun.exe")
    ap.add_argument("--opencode-source", default="D:/harness-work/atlias-opencode-1009/upstream")
    ap.add_argument("--ripgrep", default="D:/harness-work/atlias-opencode-1009/runtime/rg/rg.exe")
    ap.add_argument("--tiktoken-cache", default="D:/harness-work/tiktoken-cache", help="where nanobot's token-counter file is kept (filled once, with the network)")
    a = ap.parse_args()
    need = [a.nanobot] if a.harness == "nanobot" else [a.bun, str(pathlib.Path(a.opencode_source) / "packages" / "cli" / "src" / "index.ts")]
    # Without its token-counter file nanobot falls back to counting bytes, takes its own first prompt
    # for twice the window and refuses to start (seen 2026-10-11); that is a broken setup, not a result.
    if a.harness == "nanobot" and not any(pathlib.Path(a.tiktoken_cache).glob("*")):
        need.append(str(pathlib.Path(a.tiktoken_cache) / "<the cl100k_base file>"))
    missing = [x for x in need if not pathlib.Path(x).exists()]
    if missing:
        print(f"Gev: {a.harness} cannot run, missing {', '.join(missing)}", flush=True)
        sys.exit(3)
    watch_parent()
    for sig in ("SIGTERM", "SIGHUP", "SIGBREAK"):
        if hasattr(signal, sig):
            signal.signal(getattr(signal, sig), lambda *_: (end_all(), os._exit(4)))
    pathlib.Path(a.work).mkdir(parents=True, exist_ok=True)
    shims = make_shims(pathlib.Path(a.work) / "_shims")
    # The plain arm's shims refuse PowerShell because its agent works in bash. These harnesses run
    # their own shell tool, and on Windows that is PowerShell: on 2026-10-11 nanobot could run no
    # command at all until these two were taken out. Editors, pagers and installers stay refused.
    for name in ("powershell", "pwsh"):
        for shim in (pathlib.Path(shims) / name, pathlib.Path(shims) / f"{name}.cmd"):
            shim.unlink(missing_ok=True)
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
        # A task whose tokens could not be counted (the model server failed under it) is run again.
        results = [r for r in json.loads(out.read_text(encoding="utf-8")).get("results", []) if isinstance(r.get("promptTotal"), int) and isinstance(r.get("outputTotal"), int)]
    done = {r["id"] for r in results}
    try:
        for f in files:
            task = json.loads(f.read_text(encoding="utf-8"))
            if task["id"] in done:
                continue
            res = run_one(task, a, shims)
            results.append(res)
            # Written after every task, so a run that dies at hour five keeps what it did.
            out.write_text(json.dumps(report(results, a, t_all), indent=2), encoding="utf-8")
            print(f"{'PASS' if res['pass'] else 'FAIL'}  {res['name']}  ({res['rounds']}/{res['budget']} calls, {res['ms'] / 1000:.1f}s, {res['stop']})", flush=True)
    finally:
        end_all()
    rep = report(results, a, t_all)
    out.write_text(json.dumps(rep, indent=2), encoding="utf-8")
    print(f"{a.harness}: {rep['passed']}/{rep['total']} in {rep['ms'] / 1000:.0f}s", flush=True)


if __name__ == "__main__":
    main()
