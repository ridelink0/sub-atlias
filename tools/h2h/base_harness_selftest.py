"""No-model self-test of the metering door in base_harness_runner.py: a fake Ollama stands in
upstream, so this runs anywhere and never touches a GPU.  python tools/h2h/base_harness_selftest.py"""
import argparse
import http.client
import http.server
import json
import pathlib
import sys
import tempfile
import threading
import time
import types
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import base_harness_runner as B  # noqa: E402

seen = []
hits = []  # every request the stand-in got: method, path and header names, whether or not it was a model call


def usage_for(mode):
    """The prompt and output counts the stand-in gives a chat call: 111 and 22, or what a 'u:<prompt>:<output>' message asks for."""
    if mode.startswith("u:"):
        _, p, c = mode.split(":")
        return int(p), int(c)
    return 111, 22


class Fake(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *_):
        pass

    def _out(self, code, body, ctype="application/json", length=True):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        if length:
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _claude(self, req):
        """The same stand-in, answering in Claude's wire format."""
        mode = req["messages"][-1]["content"]
        counted = mode != "nousage"
        if req.get("stream"):
            ev = [("message_start", {"type": "message_start", "message": {"id": "m", "type": "message", "role": "assistant", "model": req["model"], "content": [], "stop_reason": None,
                                                                             "usage": {"input_tokens": 100, "cache_read_input_tokens": 11, "output_tokens": 1} if counted else None}}),
                  ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                  ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "hi"}}),
                  ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                  ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, **({"usage": {"output_tokens": 22}} if counted else {})}),
                  ("message_stop", {"type": "message_stop"})]
            return self._out(200, "".join(f"event: {n}\ndata: {json.dumps(d)}\n\n" for n, d in ev).encode(), "text/event-stream", length=False)
        d = {"id": "m", "type": "message", "role": "assistant", "model": req["model"], "content": [{"type": "text", "text": "hi"}], "stop_reason": "end_turn", "stop_sequence": None}
        if counted:
            d["usage"] = {"input_tokens": 100, "cache_read_input_tokens": 11, "output_tokens": 22}
        self._out(200, json.dumps(d).encode())

    def do_GET(self):
        hits.append(("GET", self.path, [k.lower() for k in self.headers.keys()]))
        self._out(200, json.dumps({"object": "list", "data": [{"id": "m"}]}).encode())

    def do_POST(self):
        hits.append(("POST", self.path, [k.lower() for k in self.headers.keys()]))
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        route = self.path.split("?")[0].rstrip("/")
        if route.endswith("/count_tokens"):
            return self._out(200, b'{"input_tokens": 5}')
        seen.append(req)
        if route.endswith("/v1/messages"):
            return self._claude(req)
        mode = req["messages"][-1]["content"]
        if mode == "boom":
            return self._out(500, b'{"error":"no"}')
        p, c = usage_for(mode)
        usage = None if mode == "nousage" else {"prompt_tokens": p, "completion_tokens": c, "total_tokens": p + c}
        if req.get("stream"):
            parts = [{"choices": [{"index": 0, "delta": {"role": "assistant", "content": "hi"}, "finish_reason": None}]},
                     {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}]
            if usage:
                parts.append({"choices": [], "usage": usage})
            return self._out(200, ("".join("data: " + json.dumps(p) + "\n\n" for p in parts) + "data: [DONE]\n\n").encode(), "text/event-stream", length=False)
        d = {"choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}]}
        if usage:
            d["usage"] = usage
        self._out(200, json.dumps(d).encode())


def _serve_fake():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def _post(base, path, body, headers=None):
    """One request to a door or to the stand-in, with no proxy: (status, text)."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", **(headers or {})}, method="POST")
    try:
        with opener.open(req, timeout=20) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def _post_h(base, path, body, headers=None):
    """One POST with no proxy: (status, text, response headers as a dict)."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", **(headers or {})}, method="POST")
    try:
        with opener.open(req, timeout=20) as r:
            return r.status, r.read().decode(), dict(r.headers.items())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), dict(e.headers.items())


def _get(base, path, headers=None):
    """One GET to a door or to the stand-in, with no proxy: (status, text)."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(base + path, headers=headers or {}, method="GET")
    try:
        with opener.open(req, timeout=20) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


# A stand-in harness: it sends each [content, role] pair to the door as one chat call (role None sends no header).
CALLS_SRC = r'''
import json, sys, urllib.error, urllib.request
base = sys.argv[1]
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for content, role in json.loads(sys.argv[2]):
    headers = {"Content-Type": "application/json"}
    if role is not None:
        headers["X-Atlias-Role"] = role
    req = urllib.request.Request(base + "/v1/chat/completions", data=json.dumps({"model": "m", "messages": [{"role": "user", "content": content}]}).encode(), headers=headers, method="POST")
    try:
        op.open(req, timeout=20).read()
    except urllib.error.HTTPError:
        pass
'''


def _run_row(B, api_base, calls, rounds):
    """One task through run_one, its harness a stand-in that sends `calls` through the door. No model."""
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as work:
        script = pathlib.Path(work) / "calls.py"
        script.write_text(CALLS_SRC, encoding="utf-8")
        a = argparse.Namespace(harness="claude", model="qwen3.5:9b", num_ctx=16384, num_predict=2048, api_base=api_base, work=work, budget=0, keep=True,
                               start_timeout=60, task_timeout=60, ripgrep="", tiktoken_cache=work, provenance=None, tasks=["T"], ids_from="")

        def stand_in(a, task, ws, state, door, budget, env):
            return [sys.executable, str(script), door.base, json.dumps(calls)], str(ws), None

        saved = B.HARNESS["claude"]
        try:
            B.HARNESS["claude"] = stand_in
            row = B.run_one({"id": "t", "files": {}, "check": [sys.executable, "-c", "pass"], "rounds": rounds, "prompt": "fix"}, a, work)
        finally:
            B.HARNESS["claude"] = saved
        return row, B.report([row], a, time.time())


ROW_FIGURES = ("pass", "checkExit", "rounds", "budget", "stop", "harnessExit", "starts", "promptTokens", "outputTokens", "promptTotal", "outputTotal",
               "peakPrompt", "peakContext", "usageComplete", "inputParts", "partialCalls", "measurementComplete", "budgetCapped", "nativeCompleted",
               "cutCalls", "endedCut", "modelErrors", "refused", "numCtx")
REPORT_FIGURES = ("passed", "total", "usageComplete", "promptTotal", "outputTotal", "peakPrompt", "peakContext", "nativeCompleted", "engine",
                  "harness", "model", "numCtx", "numPredict", "pluginDirs", "corpus", "provenanceUniform")


def _door_view(door):
    """The door's own figures. Timing is left out, and so is the role, the one field a receipt gains."""
    return {"calls": door.calls, "usage": [list(u) if u else None for u in door.usage], "capped": door.capped, "errors": door.errors,
            "partial": door.partial, "cut": door.cut, "refused": door.refused,
            "receipts": [{k: v for k, v in r.items() if k not in ("at", "role")} for r in door.receipts]}


def primary_only(B):
    """A primary-only sequence, through the door (a chat call, a Claude-format call, a streamed call, and one past the budget
    of three) and through one task of run_one (two calls and one past its budget of two). Returns the figures the runner
    gives as canonical JSON, and the objects behind them for the role checks."""
    srv = _serve_fake()
    up = f"http://127.0.0.1:{srv.server_address[1]}"
    door = B.Door(up, "qwen3.5:9b", 2048, 3)
    threading.Thread(target=door.serve_forever, daemon=True).start()
    msgs = [{"role": "user", "content": "fix"}]
    _post(door.base, "/v1/chat/completions", {"model": "m", "messages": msgs})
    _post(door.base, "/v1/messages", {"model": "claude-x", "max_tokens": 5, "messages": msgs}, {"anthropic-version": "2023-06-01"})
    _post(door.base, "/v1/chat/completions", {"model": "m", "messages": msgs, "stream": True})
    _post(door.base, "/v1/chat/completions", {"model": "m", "messages": msgs})
    door.shutdown()
    door.server_close()
    row, rep = _run_row(B, up, [["fix", None]] * 3, rounds=2)
    srv.shutdown()
    srv.server_close()
    view = {"door": _door_view(door), "rowKeys": sorted(k for k in row if k != "byRole"),
            "row": {k: row[k] for k in ROW_FIGURES}, "report": {k: rep[k] for k in REPORT_FIGURES}}
    return json.dumps(view, sort_keys=True), door, row, rep


# The figures primary_only() gave under the runner before roles were added (captured from that runner, byte for byte).
PRIMARY_GOLDEN = '{"door": {"calls": 4, "capped": 1, "cut": 0, "errors": [], "partial": 0, "receipts": [{"api": "chat", "outcome": "complete", "sent": {"bytes": 113, "sha256": "bb5acc1f44a51f219d63118f818d4f8ec24c490277a09abe3a9f894d0b862716"}, "slot": 0, "status": 200, "stop": "stop", "stream": false, "usage": [{"completion_tokens": 22, "prompt_tokens": 111, "total_tokens": 133}]}, {"api": "messages", "counts": {"cacheRead": 11, "output": 22, "uncached": 100}, "outcome": "complete", "sent": {"bytes": 113, "sha256": "0f5c7fa84f64b71f740ff9ae89ea27776382badf117cbd830d16ccd9aea84bae"}, "slot": 1, "status": 200, "stop": "end_turn", "stream": false, "usage": [{"cache_read_input_tokens": 11, "input_tokens": 100, "output_tokens": 22}]}, {"api": "chat", "outcome": "complete", "sent": {"bytes": 172, "sha256": "1947e04706a1fad34b48670ff3870e1ac0e94aea20a9075879bca7e5c6a5833f"}, "slot": 2, "status": 200, "stop": "stop", "stream": true, "usage": [{"completion_tokens": 22, "prompt_tokens": 111, "total_tokens": 133}]}, {"api": "chat", "outcome": "capped: answered by the door, no model call", "slot": null, "stream": false}], "refused": [], "usage": [[111, 22], [111, 22], [111, 22]]}, "report": {"corpus": {"ids": null, "tasks": ["T"]}, "engine": "claude (stock, metered door, offline)", "harness": "claude", "model": "qwen3.5:9b", "nativeCompleted": 0, "numCtx": 16384, "numPredict": 2048, "outputTotal": 44, "passed": 1, "peakContext": 133, "peakPrompt": 111, "pluginDirs": [], "promptTotal": 222, "provenanceUniform": true, "total": 1, "usageComplete": true}, "row": {"budget": 2, "budgetCapped": 1, "checkExit": true, "cutCalls": 0, "endedCut": false, "harnessExit": 0, "inputParts": null, "measurementComplete": true, "modelErrors": [], "nativeCompleted": false, "numCtx": 16384, "outputTokens": [22, 22], "outputTotal": 44, "partialCalls": 0, "pass": true, "peakContext": 133, "peakPrompt": 111, "promptTokens": [111, 111], "promptTotal": 222, "refused": [], "rounds": 2, "starts": 1, "stop": "exit 0; step limit reached (1 further call(s) answered with a stop)", "usageComplete": true}, "rowKeys": ["addedFiles", "agentMs", "budget", "budgetCapped", "cases", "checkExit", "cutCalls", "endedCut", "harnessExit", "id", "inputParts", "loadedWindow", "loadedWindows", "measurementComplete", "modelErrors", "ms", "name", "nativeCompleted", "numCtx", "output", "outputTokens", "outputTotal", "partialCalls", "pass", "peakContext", "peakPrompt", "promptTokens", "promptTotal", "provenance", "receipts", "refused", "rounds", "startMs", "starts", "state", "stop", "tampered", "taskDigests", "usageComplete", "workspace"]}'


def main():
    fake = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=fake.serve_forever, daemon=True).start()
    door = B.Door(f"http://127.0.0.1:{fake.server_address[1]}", "qwen3.5:9b", 2048, 4)
    threading.Thread(target=door.serve_forever, daemon=True).start()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def post(body):
        req = urllib.request.Request(door.base + "/v1/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
        try:
            with opener.open(req, timeout=20) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    def raw(method, target):
        c = http.client.HTTPConnection("127.0.0.1", door.server_address[1], timeout=20)
        c.request(method, target)
        r = c.getresponse()
        r.read()
        return r.status

    results = []

    def check(name, ok, got=None):
        results.append((name, bool(ok), got))

    def msg(text):
        return [{"role": "user", "content": text}]

    # Gev 2026-10-16: /api/show listed the same stored parameters in another order on each server start.
    one = "num_ctx                        32768\ntemperature                    0.2\nstop                           \"<a>\"\nstop                           \"<b>\""
    two = "stop                           \"<b>\"\ntemperature                    0.2\n\nnum_ctx                        32768\nstop                           \"<a>\""
    check("model parameters hash the same whatever order the server lists them in", B._digest(B.canonical_parameters(one)) == B._digest(B.canonical_parameters(two)))
    check("a changed or missing parameter value still changes the parameters hash",
          B.canonical_parameters(one) != B.canonical_parameters(one.replace("0.2", "0.6"))
          and B.canonical_parameters(one) != B.canonical_parameters(one.replace("stop                           \"<b>\"", "")))

    # Gev 2026-10-16: a model-written solution under the grader took more than 7 GB in its 60 s (three screen stops).
    grab = lambda mib: [sys.executable, "-c", f"b = bytearray({mib} * 1024 * 1024); b[-1] = 1"]
    over = B.run_tree(grab(800), timeout=60, job_memory=256 * 1024 * 1024)
    under = B.run_tree(grab(32), timeout=60, job_memory=256 * 1024 * 1024)
    free = B.run_tree(grab(400), timeout=60)
    check("a capped check that allocates past its cap fails; under the cap, or with no cap, it runs",
          over[0] != 0 and not over[1] and under == (0, False) and free == (0, False), (over, under, free))
    # The per-process cap holds for every process of the tree: a grandchild that runs away fails too
    # (sprint-lean-s6: the base arm's own run of the same task's code took the memory).
    nested = lambda mib: [sys.executable, "-c", "import subprocess, sys; sys.exit(subprocess.call([sys.executable, '-c', 'b = bytearray(%d * 1024 * 1024); b[-1] = 1']))" % mib]
    def tree(argv, cap):
        # Through run_harness, the way the runner starts a harness; the door only needs its first-call time.
        rc, why = B.run_harness(argv, cwd=None, env=None, door=types.SimpleNamespace(first=None), start_limit=60, task_limit=60,
                                stdout=B.subprocess.DEVNULL, process_memory=cap)
        return rc
    deep_over, deep_under, deep_free = tree(nested(800), 256 * 1024 * 1024), tree(nested(32), 256 * 1024 * 1024), tree(nested(400), 0)
    check("a per-process cap stops a runaway grandchild, and leaves small or uncapped work alone",
          deep_over != 0 and deep_under == 0 and deep_free == 0, (deep_over, deep_under, deep_free))

    s, b = post({"model": "other", "messages": msg("x"), "temperature": 1.5, "max_tokens": 99999, "max_completion_tokens": 5})
    last = seen[-1]
    check("a plain call is forwarded with the model, temperature and output cap set",
          s == 200 and last["model"] == "qwen3.5:9b" and last["temperature"] == 0.2 and last["max_tokens"] == 2048 and "max_completion_tokens" not in last and "stream_options" not in last, last)
    check("its token counts are written down", door.usage == [(111, 22)], door.usage)
    s, b = post({"model": "m", "messages": msg("x"), "stream": True})
    check("a streamed call asks for the usage block and passes every line through",
          s == 200 and seen[-1]["stream_options"] == {"include_usage": True} and b.count("data: ") == 4 and b.rstrip().endswith("[DONE]"), b)
    check("a streamed call's counts are written down", door.usage[-1] == (111, 22) and len(door.usage) == 2, door.usage)
    post({"model": "m", "messages": msg("nousage")})
    check("a call with no usage block is recorded as unknown, not as zero", door.usage[-1] is None and len(door.usage) == 3, door.usage)
    s, b = post({"model": "m", "messages": msg("boom")})
    check("an upstream failure reaches the harness as the same status and is recorded",
          s == 500 and door.errors == ["HTTP 500"] and door.usage[-1] is None and len(door.usage) == 4, (s, door.errors, door.usage))
    n_before = len(seen)
    s, b = post({"model": "m", "messages": msg("x")})
    check("past the budget the door answers a stop by itself and the model is not called",
          s == 200 and len(seen) == n_before and json.loads(b)["choices"][0]["finish_reason"] == "stop" and B.STOP_TEXT in b and door.capped == 1 and len(door.usage) == 4, (s, b[:200]))
    s, b = post({"model": "m", "messages": msg("x"), "stream": True})
    check("past the budget a streamed call gets a well-formed stop stream",
          s == 200 and len(seen) == n_before and b.rstrip().endswith("[DONE]") and all(json.loads(x[6:]) for x in b.split("\n") if x.startswith("data: {")) and door.capped == 2, b[:300])
    s, b = post([1, 2])
    check("a body that is not an object is refused with 400 and counts as no call", s == 400 and door.calls == 6, (s, door.calls))
    with opener.open(door.base + "/v1/models", timeout=20) as r:
        check("the model list passes through", r.status == 200 and "data" in json.loads(r.read()))
    # A proxied request for another host arrives with an absolute URL, a tunnel as CONNECT.
    check("a request for another host is refused and listed", raw("GET", "http://example.com/x") == 403 and door.refused == ["GET http://example.com/x"], door.refused)
    check("a tunnel to another host is refused", raw("CONNECT", "example.com:443") == 403 and len(door.refused) == 2, door.refused)
    check("calls asked for are counted apart from calls sent to the model", door.calls == 6 and len(door.usage) == 4, (door.calls, len(door.usage)))
    # The two clocks of a harness run, with a child that only sleeps, and the environment a harness is given.
    import os
    import tempfile
    import time
    sleeper = [sys.executable, "-c", "import time; time.sleep(60)"]
    door.first = None
    t = time.time()
    rc, why = B.run_harness(sleeper, cwd=None, env=None, door=door, start_limit=2, task_limit=600, stdout=None)
    check("a harness that makes no model call is stopped at the start limit", rc == -1 and why.startswith("timeout: no model call in the first 2 s") and time.time() - t < 30, (rc, why))
    door.first = time.time()
    t = time.time()
    rc, why = B.run_harness(sleeper, cwd=None, env=None, door=door, start_limit=600, task_limit=2, stdout=None)
    check("a harness is stopped when the task limit has passed since its first model call", rc == -1 and why.startswith("timeout: 2 s passed since its first model call") and time.time() - t < 30, (rc, why))
    door.first = time.time() - 1000
    rc, why = B.run_harness([sys.executable, "-c", "import sys; sys.stdin.read(); sys.exit(7)"], cwd=None, env=None, door=door, start_limit=1, task_limit=2000, stdout=None, stdin_text="x" * 100000)
    check("a harness that ends by itself gives its own exit code and no stop reason, with its prompt on stdin", rc == 7 and why == "", (rc, why))
    os.environ["BASE_H2H_SECRET_KEY"] = "leak"
    with tempfile.TemporaryDirectory() as state:
        env = B.offline_env(state, door, "SHIMS", extra_path=["RG"], extra={"TIKTOKEN_CACHE_DIR": "T"})
        path = env[next(k for k in env if k.upper() == "PATH")]
        check("a harness gets a home of its own, the door as its only proxy, the shims first on its path and nothing secret from this process",
              "BASE_H2H_SECRET_KEY" not in env and env["HOME"].startswith(state) and env["USERPROFILE"] == env["HOME"] and env["HTTPS_PROXY"] == door.base
              and env["NO_PROXY"].startswith("127.0.0.1") and path.split(os.pathsep)[:2] == ["SHIMS", "RG"] and env["TIKTOKEN_CACHE_DIR"] == "T" and os.path.isdir(env["TMP"]), {k: env[k] for k in ("HOME", "HTTPS_PROXY")})
    # Council 1013b (b10 F3, b11): OpenCode reads %ProgramData%\opencode as a system config folder. Its run is given the
    # task's state folder as ProgramData, and no other harness's environment changes.
    import argparse
    import subprocess
    TITLE = "You are a title generator. You output ONLY a thread title."  # packages/core/src/plugin/agent.ts PROMPT_TITLE (d2905b8 and 026b106)
    with tempfile.TemporaryDirectory() as state:
        check("OpenCode's environment names the task's state folder as ProgramData, so its system config folder is never read",
              B.offline_env(state, door, "SHIMS", harness="opencode").get("ProgramData") == state)
        check("no other harness gets a ProgramData of ours",
              "ProgramData" not in B.offline_env(state, door, "SHIMS", harness="nanobot") and "ProgramData" not in B.offline_env(state, door, "SHIMS"))
    # Council 1013b (b10 F5, b11 F1): OpenCode's title call is its own request, not one of its steps. Its tokens count in
    # every total; the budget counts the other calls. Every other harness counts it as before.
    def post_to(d, body):
        req = urllib.request.Request(d.base + "/v1/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
        try:
            with opener.open(req, timeout=20) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    up = f"http://127.0.0.1:{fake.server_address[1]}"
    title_req = {"model": "m", "messages": [{"role": "system", "content": TITLE + " Nothing else."}, {"role": "user", "content": "fix"}]}
    work_req = {"model": "m", "messages": [{"role": "user", "content": "fix"}]}
    tdoor = B.Door(up, "qwen3.5:9b", 2048, 1, skip_titles=True)
    threading.Thread(target=tdoor.serve_forever, daemon=True).start()
    n0 = len(seen)
    post_to(tdoor, title_req)
    t1 = (len(seen), tdoor.calls, tdoor.titles, tdoor.capped)
    post_to(tdoor, work_req)
    t2 = (len(seen), tdoor.calls, tdoor.titles, tdoor.capped)
    _, b_over = post_to(tdoor, work_req)
    t3 = (len(seen), tdoor.calls, tdoor.titles, tdoor.capped)
    check("OpenCode's title call goes to the model and is not counted against a budget of one; the first working call is within it, the second is stopped",
          t1 == (n0 + 1, 1, 1, 0) and t2 == (n0 + 2, 2, 1, 0) and t3 == (n0 + 2, 3, 1, 1) and B.STOP_TEXT in b_over, (t1, t2, t3))
    check("the title call and the working call both count in the ledger, and the stopped call adds nothing",
          tdoor.usage == [(111, 22), (111, 22)] and len(tdoor.receipts) == 3, (tdoor.usage, len(tdoor.receipts)))
    check("the title call's receipt says it was a title; the working call's does not, and the stopped one says it was capped",
          tdoor.receipts[0].get("title") is True and "title" not in tdoor.receipts[1] and tdoor.receipts[2]["outcome"].startswith("capped"), tdoor.receipts)
    ndoor = B.Door(up, "qwen3.5:9b", 2048, 1)
    threading.Thread(target=ndoor.serve_forever, daemon=True).start()
    post_to(ndoor, title_req)
    post_to(ndoor, work_req)
    check("a door not built for OpenCode counts the same title request like any other call, as before",
          ndoor.calls == 2 and ndoor.capped == 1 and ndoor.titles == 0 and "title" not in ndoor.receipts[0], (ndoor.calls, ndoor.capped, ndoor.titles))
    kdoor = B.Door(up, "qwen3.5:9b", 2048, 0, skip_titles=True)
    threading.Thread(target=kdoor.serve_forever, daemon=True).start()
    post_to(kdoor, {"model": "m", "messages": [{"role": "user", "content": TITLE}]})
    post_to(kdoor, {"model": "m", "messages": [{"role": "system", "content": [{"type": "text", "text": TITLE + " Nothing else."}]}, {"role": "user", "content": "fix"}]})
    check("the title text in a user message is an ordinary call, and a title sent as text parts of the system message is recognised",
          kdoor.capped == 1 and kdoor.titles == 1 and kdoor.calls == 2, (kdoor.capped, kdoor.titles, kdoor.calls))
    for d in (tdoor, ndoor, kdoor):
        d.shutdown()
    # run_one, end to end, with a stand-in for the harness that makes OpenCode's calls: its title, then two working calls.
    # Run once as OpenCode (the title is apart from the budget) and once as Claude Code (it is not).
    calls_src = (
        "import json, sys, urllib.error, urllib.request\n"
        "base, marker = sys.argv[1], sys.argv[2]\n"
        "op = urllib.request.build_opener(urllib.request.ProxyHandler({}))\n"
        "def post(msgs):\n"
        "    req = urllib.request.Request(base + '/v1/chat/completions', data=json.dumps({'model': 'm', 'messages': msgs}).encode(), headers={'Content-Type': 'application/json'}, method='POST')\n"
        "    try:\n"
        "        op.open(req, timeout=20).read()\n"
        "    except urllib.error.HTTPError:\n"
        "        pass\n"
        "post([{'role': 'system', 'content': marker + ' Nothing else.'}, {'role': 'user', 'content': 'fix'}])\n"
        "post([{'role': 'user', 'content': 'fix'}])\n"
        "post([{'role': 'user', 'content': 'fix'}])\n")
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as work:
        script = pathlib.Path(work) / "calls.py"
        script.write_text(calls_src, encoding="utf-8")
        seen_env = {}

        def stand_in(name):
            def cmd(a, task, ws, state, door, budget, env):
                seen_env[name] = dict(env)
                return [sys.executable, str(script), door.base, TITLE], str(ws), None
            return cmd
        ra = argparse.Namespace(harness="opencode", model="qwen3.5:9b", num_ctx=16384, num_predict=2048, api_base=up, work=work, budget=0, keep=True,
                                start_timeout=60, task_timeout=60, ripgrep="", tiktoken_cache=work, provenance=None)
        saved = {k: B.HARNESS[k] for k in ("opencode", "claude")}
        try:
            B.HARNESS["opencode"], B.HARNESS["claude"] = stand_in("opencode"), stand_in("claude")
            row_oc = B.run_one({"id": "oc", "files": {}, "check": [sys.executable, "-c", "pass"], "rounds": 1, "prompt": "fix"}, ra, work)
            ra.harness = "claude"
            row_cl = B.run_one({"id": "cl", "files": {}, "check": [sys.executable, "-c", "pass"], "rounds": 1, "prompt": "fix"}, ra, work)
        finally:
            B.HARNESS.update(saved)
        oc_log = json.loads(pathlib.Path(row_oc["state"], "door-log.json").read_text(encoding="utf-8"))
    check("in OpenCode's run the title is apart from the budget: two calls to the model (title and one working call), titleCalls 1, the second working call stopped, and both sent calls in the totals",
          row_oc["rounds"] == 2 and row_oc.get("titleCalls") == 1 and "step limit reached (1 further" in row_oc["stop"] and row_oc["promptTotal"] == 222 and row_oc["outputTotal"] == 44,
          (row_oc["rounds"], row_oc.get("titleCalls"), row_oc["stop"], row_oc["promptTotal"], row_oc["outputTotal"]))
    check("OpenCode's run is given the task's state folder as ProgramData, and its title call is marked in the receipts and in the door's log",
          seen_env["opencode"].get("ProgramData") == row_oc["state"] and row_oc["receipts"][0].get("title") is True
          and oc_log.get("titles") == 1, (seen_env["opencode"].get("ProgramData"), row_oc["state"], oc_log.get("titles")))
    check("a Claude Code run counts that same first call against its budget as before: one call sent, two stopped, and no title field or ProgramData of ours",
          row_cl["rounds"] == 1 and "titleCalls" not in row_cl and "step limit reached (2 further" in row_cl["stop"] and "ProgramData" not in seen_env["claude"] and "title" not in row_cl["receipts"][0],
          (row_cl["rounds"], row_cl["stop"]))
    # Council 1013b (c): the help names the v2.0.28 source as an example for --opencode-source. Wide columns, so no word wraps.
    helped = subprocess.run([sys.executable, str(pathlib.Path(B.__file__)), "--help"], capture_output=True, timeout=120,
                            env={**os.environ, "COLUMNS": "400", "PYTHONIOENCODING": "utf-8"})
    check("the help names D:/harness-work/opencode-v2.0.28 as an example for --opencode-source",
          helped.returncode == 0 and "D:/harness-work/opencode-v2.0.28" in helped.stdout.decode("utf-8", "replace"), helped.returncode)
    # Claude's wire format (/v1/messages), which base Claude Code speaks and Ollama answers: the same door, the same rules.
    import shutil
    door2 = B.Door(f"http://127.0.0.1:{fake.server_address[1]}", "qwen3.5:9b", 2048, 3)
    threading.Thread(target=door2.serve_forever, daemon=True).start()

    def postc(d, path, body):
        req = urllib.request.Request(d.base + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "anthropic-version": "2023-06-01"}, method="POST")
        try:
            with opener.open(req, timeout=20) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    s, b = postc(door2, "/v1/messages?beta=true", {"model": "claude-x", "max_tokens": 64000, "temperature": 1, "messages": msg("x")})
    last = seen[-1]
    check("a call in Claude's format is forwarded with the model, temperature and output cap set",
          s == 200 and last["model"] == "qwen3.5:9b" and last["temperature"] == 0.2 and last["max_tokens"] == 2048 and json.loads(b)["content"][0]["text"] == "hi", last)
    check("its counts are written down, with tokens read from cache counted as read", door2.usage == [(111, 22)], door2.usage)
    s, b = postc(door2, "/v1/messages", {"model": "claude-x", "max_tokens": 5, "stream": True, "messages": msg("x")})
    check("a streamed call in Claude's format passes every event through and its counts are written down",
          s == 200 and b.count("event: ") == 6 and b.rstrip().endswith('{"type": "message_stop"}') and door2.usage[-1] == (111, 22) and len(door2.usage) == 2, (b[:200], door2.usage))
    postc(door2, "/v1/messages", {"model": "claude-x", "max_tokens": 5, "stream": True, "messages": msg("nousage")})
    check("a call in Claude's format with no count is recorded as unknown, not as zero", door2.usage[-1] is None and len(door2.usage) == 3, door2.usage)
    n_before = len(seen)
    s, b = postc(door2, "/v1/messages", {"model": "claude-x", "max_tokens": 5, "messages": msg("x")})
    check("past the budget the door answers a stop in Claude's format and the model is not called",
          s == 200 and len(seen) == n_before and json.loads(b)["stop_reason"] == "end_turn" and json.loads(b)["content"][0]["text"] == B.STOP_TEXT and door2.capped == 1 and len(door2.usage) == 3, b[:200])
    s, b = postc(door2, "/v1/messages", {"model": "claude-x", "max_tokens": 5, "stream": True, "messages": msg("x")})
    check("past the budget a streamed call gets six well-formed events ending the turn",
          s == 200 and len(seen) == n_before and b.count("event: ") == 6 and all(json.loads(x[6:]) for x in b.split("\n") if x.startswith("data: ")) and B.STOP_TEXT in b and door2.capped == 2, b[:300])
    s, b = postc(door2, "/v1/messages/count_tokens", {"model": "claude-x", "messages": msg("x")})
    check("a token-count request passes through and is not counted as a call", s == 200 and json.loads(b) == {"input_tokens": 5} and door2.calls == 5 and len(seen) == n_before, (s, b, door2.calls))
    with tempfile.TemporaryDirectory() as state:
        a = argparse.Namespace(model="qwen3.5:9b", num_predict=2048, claude="CLAUDE", claude_plugin_dir=["P1", "P2"], harness="claude", num_ctx=32768, tasks=["T"], ids_from="")
        env = B.offline_env(state, door2, "SHIMS")
        argv, cwd, stdin_text = B.claude_command(a, {"prompt": "fix it"}, pathlib.Path(state) / "ws", state, door2, 5, env)
        check("base Claude Code is started in print mode with a profile of its own, the door as its model, and any plugin folders asked for",
              argv == ["CLAUDE", "-p", "fix it", "--model", "qwen3.5:9b", "--dangerously-skip-permissions", "--plugin-dir", "P1", "--plugin-dir", "P2"] and stdin_text is None
              and env["ANTHROPIC_BASE_URL"] == door2.base and env["CLAUDE_CONFIG_DIR"].startswith(state) and os.path.isdir(env["CLAUDE_CONFIG_DIR"]) and env["ANTHROPIC_MODEL"] == "qwen3.5:9b"
              and B.claude_command(argparse.Namespace(**{**vars(a), "claude_plugin_dir": []}), {"prompt": "p"}, pathlib.Path(state) / "ws", state, door2, 5, dict(env))[0][-1] == "--dangerously-skip-permissions", argv)
        rep = B.report([], a, time.time())
        stock = B.report([], argparse.Namespace(**{**vars(a), "claude_plugin_dir": []}), time.time())
        check("the report says whether the run was stock or carried plugin folders", rep["pluginDirs"] == ["P1", "P2"] and "with 2 plugin folder(s)" in rep["engine"] and stock["pluginDirs"] == [] and "(stock," in stock["engine"], (rep["engine"], stock["engine"]))
    # The real program, when it is installed, against the stand-in: no model, no network, no plan usage.
    exe = "C:/Users/OWNER/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
    if os.path.exists(exe):
        door3 = B.Door(f"http://127.0.0.1:{fake.server_address[1]}", "qwen3.5:9b", 2048, 5)
        threading.Thread(target=door3.serve_forever, daemon=True).start()
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as state:
            ws = pathlib.Path(state) / "ws"
            ws.mkdir()
            shims = pathlib.Path(state) / "shims"
            shims.mkdir()
            a = argparse.Namespace(model="qwen3.5:9b", num_predict=2048, claude=exe, claude_plugin_dir=[])
            env = B.offline_env(state, door3, str(shims))
            argv, cwd, stdin_text = B.claude_command(a, {"prompt": "x"}, ws, state, door3, 5, env)
            out_file = pathlib.Path(state) / "out.txt"
            with open(out_file, "wb") as buf:
                rc, why = B.run_harness(argv, cwd=cwd, env=env, door=door3, start_limit=90, task_limit=90, stdout=buf)
            said = out_file.read_text(encoding="utf-8", errors="replace")
            check("the installed Claude Code, in the harness environment, reaches the door, is counted, and ends by itself",
                  rc == 0 and why == "" and door3.calls >= 1 and door3.usage[0] == (111, 22) and "hi" in said and not door3.errors, (rc, why, door3.calls, door3.usage, door3.refused[:3], door3.errors, said[-200:]))
            first = next((r for r in reversed(seen) if r.get("model") == "qwen3.5:9b" and r.get("tools")), None)
            check("what it sent is base Claude Code's own opening: its tools and its system prompt, held to the local model and the output cap",
                  first is not None and len(first["tools"]) >= 10 and first["max_tokens"] == 2048 and first["temperature"] == 0.2, None if first is None else (len(first["tools"]), first["max_tokens"]))
        door3.shutdown()
    # Roles (council 1015, lane P5). Absent means primary, which is all Claude Code and Codex send; planner and reporter are the
    # helpers' own; any other value is answered 400 before anything is sent upstream.
    golden, pdoor, prow, _ = primary_only(B)
    check("a primary-only run's figures are byte-for-byte what the runner gave before roles were added", golden == PRIMARY_GOLDEN, golden[:300])
    prole = B.role_summary(pdoor.receipts, pdoor.usage)
    check("a primary-only door attributes every call to primary, and that figure is the door's own aggregate",
          list(prole) == ["primary"] and prole.get("primary") == {"calls": pdoor.calls, "failures": 0, "capped": pdoor.capped,
                                                              "input": sum(u[0] for u in pdoor.usage), "output": sum(u[1] for u in pdoor.usage),
                                                              "total": sum(u[0] + u[1] for u in pdoor.usage), "peak": max(u[0] + u[1] for u in pdoor.usage)}, prole)
    pbr = prow["byRole"]
    check("a primary-only run's row attributes every call to primary, and that figure is the row's own aggregate",
          list(pbr) == ["primary"] and pbr.get("primary") == {"calls": prow["rounds"] + prow["budgetCapped"], "failures": 0, "capped": prow["budgetCapped"],
                                                          "input": prow["promptTotal"], "output": prow["outputTotal"],
                                                          "total": prow["promptTotal"] + prow["outputTotal"], "peak": prow["peakContext"]}, pbr)
    srv = _serve_fake()
    up = f"http://127.0.0.1:{srv.server_address[1]}"
    h0 = len(hits)
    mrow, mrep = _run_row(B, up, [["u:300:7", None], ["u:40:5", "planner"], ["u:20:3", "reporter"], ["u:999:999", "reporter"]], rounds=3)
    forwarded = [h for h in hits[h0:] if h[0] == "POST"]
    srv.shutdown()
    srv.server_close()
    mbr = mrow["byRole"]
    check("a primary, a planner and a reporter call are attributed to their own roles, and the reporter's call past the budget is its capped call",
          mbr == {"primary": {"calls": 1, "failures": 0, "capped": 0, "input": 300, "output": 7, "total": 307, "peak": 307},
                  "planner": {"calls": 1, "failures": 0, "capped": 0, "input": 40, "output": 5, "total": 45, "peak": 45},
                  "reporter": {"calls": 2, "failures": 0, "capped": 1, "input": 20, "output": 3, "total": 23, "peak": 23}}, mbr)
    roles = list(mbr.values())
    check("the roles' usage adds up to the run's aggregate, and their calls and capped calls add up to the aggregate's calls and cap",
          sum(r["input"] for r in roles) == mrow["promptTotal"] == 360 and sum(r["output"] for r in roles) == mrow["outputTotal"] == 15
          and sum(r["calls"] for r in roles) == mrow["rounds"] + mrow["budgetCapped"] == 4 and sum(r["capped"] for r in roles) == mrow["budgetCapped"] == 1
          and max(r["peak"] for r in roles) == mrow["peakContext"] == 307, (mrow["promptTotal"], mrow["outputTotal"], mrow["rounds"], mrow["budgetCapped"], mrow["peakContext"]))
    check("the report's role figures for that one task are the task's own", mrep["byRole"] == mbr, mrep["byRole"])
    check("the stand-in upstream got the three calls that were sent, and none of them carried X-Atlias-Role",
          len(forwarded) == 3 and not any("x-atlias-role" in h[2] for h in forwarded), forwarded)

    # Gev 2026-10-16, the real harness for 20x: Atlias's own agent (no Claude Code under it) on one task,
    # through the same door and grader as base Claude Code. The stand-in answers "hi", so the loop ends on
    # its first call as an answer; the grade is the task's check.
    srv = _serve_fake()
    up = f"http://127.0.0.1:{srv.server_address[1]}"
    s0 = len(seen)
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as work:
        aa = argparse.Namespace(harness="atlias", model="qwen3.5:9b", num_ctx=32768, num_predict=2048, api_base=up, work=work, budget=8, keep=True,
                                start_timeout=60, task_timeout=60, ripgrep="", tiktoken_cache=work, provenance=None, tasks=["T"], ids_from="")
        arow = B.run_one({"id": "at", "files": {"main.py": "x = 1\n"}, "check": [sys.executable, "-c", "pass"], "rounds": 3, "prompt": "fix main.py"}, aa, work)
        argv_a, cwd_a, stdin_a = B.HARNESS["atlias"](aa, {"prompt": "p", "rounds": 3}, pathlib.Path(work) / "ws", work, types.SimpleNamespace(base="http://127.0.0.1:1"), 8, {})
    srv.shutdown()
    srv.server_close()
    sent = seen[s0:]
    first = sent[0] if sent else {}
    check("the atlias harness runs Atlias's own agent on a task through the door, counted and graded like any harness",
          arow["harnessExit"] == 0 and arow["pass"] is True and arow["usageComplete"] is True and arow["rounds"] == 1
          and arow["promptTotal"] == 111 and arow["outputTotal"] == 22 and len(sent) == 1
          and first.get("model") == "qwen3.5:9b" and first.get("messages", [{}])[0].get("role") == "system"
          and any("fix main.py" in str(m.get("content")) for m in first.get("messages", [])), (arow.get("harnessExit"), arow.get("pass"), arow.get("rounds"), arow.get("stop"), len(sent)))
    check("the atlias command is the driver on the task's own rounds, the prompt on stdin, in the task directory",
          argv_a[1].endswith("atlias_task.mjs") and argv_a[2:] == ["--rounds", "3"] and stdin_a == "p" and cwd_a == str(pathlib.Path(work) / "ws"), argv_a)
    srv = _serve_fake()
    up = f"http://127.0.0.1:{srv.server_address[1]}"
    idoor = B.Door(up, "qwen3.5:9b", 2048, 2)
    threading.Thread(target=idoor.serve_forever, daemon=True).start()
    body = {"model": "m", "messages": [{"role": "user", "content": "u:50:5"}]}
    h0, s0 = len(hits), len(seen)
    bad_role = [_post(idoor.base, "/v1/chat/completions", body, {"X-Atlias-Role": v}) for v in ("admin", "Planner", "")]
    bad_role.append(_post(idoor.base, "/v1/messages", {"model": "claude-x", "max_tokens": 5, "messages": body["messages"]}, {"X-Atlias-Role": "admin", "anthropic-version": "2023-06-01"}))
    bad_role.append(_get(idoor.base, "/v1/models", {"X-Atlias-Role": "admin"}))
    check("a request whose role is neither planner, reporter nor absent is answered 400, and the stand-in upstream gets no hit for it",
          [s for s, _ in bad_role] == [400] * 5 and len(hits) == h0 and len(seen) == s0, (bad_role, len(hits) - h0))
    check("each refused attempt is recorded under role invalid with a failure, is not a call, and is an error that holds measurement",
          [r["role"] for r in idoor.receipts] == ["invalid"] * 5 and all(r["slot"] is None and r["outcome"].startswith("failed") for r in idoor.receipts)
          and idoor.calls == 0 and idoor.capped == 0 and idoor.usage == [] and len(idoor.errors) == 5
          and all(e.startswith("refused invalid X-Atlias-Role") for e in idoor.errors)
          and B.role_summary(idoor.receipts, idoor.usage) == {"invalid": {"calls": 0, "failures": 5, "capped": 0, "input": 0, "output": 0, "total": 0, "peak": 0}}, idoor.receipts)
    p_status, _ = _post(idoor.base, "/v1/chat/completions", body, {"X-Atlias-Role": "planner"})
    m_status, _ = _post(idoor.base, "/v1/messages", {"model": "claude-x", "max_tokens": 5, "messages": body["messages"]}, {"X-Atlias-Role": "reporter", "anthropic-version": "2023-06-01"})
    check("after the refusals the budget is untouched: a planner call and a reporter call in Claude's format are sent, counted, and forwarded without the header",
          (p_status, m_status) == (200, 200) and idoor.calls == 2 and idoor.usage == [(50, 5), (111, 22)] and [r["role"] for r in idoor.receipts[-2:]] == ["planner", "reporter"]
          and [h[1] for h in hits[-2:]] == ["/v1/chat/completions", "/v1/messages"] and all("x-atlias-role" not in h[2] for h in hits[-2:]),
          (p_status, m_status, idoor.calls, idoor.usage, hits[-2:]))
    _get(idoor.base, "/v1/models", {"X-Atlias-Role": "reporter"})
    check("a pass-through request is listed with its role as a fifth field", len(idoor.passed[-1]) == 5 and idoor.passed[-1][4] == "reporter", idoor.passed[-1:])
    bdoor = B.Door(up, "qwen3.5:9b", 2048, 5)
    threading.Thread(target=bdoor.serve_forever, daemon=True).start()
    _post(bdoor.base, "/v1/chat/completions", {"model": "m", "messages": [{"role": "user", "content": "boom"}]}, {"X-Atlias-Role": "reporter"})
    bsum = B.role_summary(bdoor.receipts, bdoor.usage)
    check("an upstream failure counts against its role, and leaves that role's figures unknown rather than smaller",
          bsum == {"reporter": {"calls": 1, "failures": 1, "capped": 0, "input": None, "output": None, "total": None, "peak": None}} and bdoor.errors == ["HTTP 500"], bsum)
    # Helper budget cap and output cap (Codex review 1015, finding 3). A helper call past the budget is a 429 the door
    # answers itself, with its outcome in a header and the body; a primary call past the budget keeps the 200 stop reply.
    cdoor = B.Door(up, "qwen3.5:9b", 2048, 1)
    threading.Thread(target=cdoor.serve_forever, daemon=True).start()
    h0, s0 = len(hits), len(seen)
    first = _post_h(cdoor.base, "/v1/chat/completions", {"model": "m", "max_tokens": 64, "messages": [{"role": "user", "content": "u:30:4"}]}, {"X-Atlias-Role": "planner"})
    sent_first = seen[-1] if len(seen) > s0 else {}
    capped_chat = _post_h(cdoor.base, "/v1/chat/completions", {"model": "m", "messages": [{"role": "user", "content": "u:30:4"}]}, {"X-Atlias-Role": "planner"})
    capped_msg = _post_h(cdoor.base, "/v1/messages", {"model": "claude-x", "max_tokens": 5, "messages": [{"role": "user", "content": "x"}]}, {"X-Atlias-Role": "reporter", "anthropic-version": "2023-06-01"})
    capped_resp = _post_h(cdoor.base, "/v1/responses", {"model": "m", "input": "x"}, {"X-Atlias-Role": "reporter"})
    capped_primary = _post_h(cdoor.base, "/v1/chat/completions", {"model": "m", "messages": [{"role": "user", "content": "x"}]})
    bodies = [json.loads(c[1]) for c in (capped_chat, capped_msg, capped_resp)]
    check("a helper call past the budget is a 429 the door answers itself, its outcome budget-capped in a header and in the body, in every format",
          [c[0] for c in (capped_chat, capped_msg, capped_resp)] == [429] * 3
          and all(c[2].get("X-Atlias-Door-Outcome") == "budget-capped" for c in (capped_chat, capped_msg, capped_resp))
          and all(b["atlias_door"] == {"outcome": "budget-capped", "modelCalled": False} for b in bodies) and bodies[1]["type"] == "error",
          [(c[0], c[2].get("X-Atlias-Door-Outcome"), c[1][:120]) for c in (capped_chat, capped_msg, capped_resp)])
    check("a primary call past the same budget keeps the 200 stop reply and carries no outcome header",
          capped_primary[0] == 200 and json.loads(capped_primary[1])["choices"][0]["message"]["content"] == B.STOP_TEXT and capped_primary[2].get("X-Atlias-Door-Outcome") is None,
          capped_primary[:2])
    check("the helper caps reach no model, and each is a capped call of its role in the door's own figures",
          len(hits) - h0 == 1 and cdoor.calls == 5 and cdoor.capped == 4 and cdoor.usage == [(30, 4)]
          and B.role_summary(cdoor.receipts, cdoor.usage) == {"planner": {"calls": 2, "failures": 0, "capped": 1, "input": 30, "output": 4, "total": 34, "peak": 34},
                                                             "primary": {"calls": 1, "failures": 0, "capped": 1, "input": 0, "output": 0, "total": 0, "peak": 0},
                                                             "reporter": {"calls": 2, "failures": 0, "capped": 2, "input": 0, "output": 0, "total": 0, "peak": 0}},
          (len(hits) - h0, cdoor.calls, cdoor.capped, B.role_summary(cdoor.receipts, cdoor.usage)))
    check("a helper's own smaller max_tokens is what the model server gets, echoed in a header and kept on the receipt",
          first[0] == 200 and sent_first.get("max_tokens") == 64 and first[2].get("X-Atlias-Door-Max-Tokens") == "64"
          and cdoor.receipts[0].get("maxTokens") == {"asked": 64, "sent": 64}, (first[0], sent_first.get("max_tokens"), first[2].get("X-Atlias-Door-Max-Tokens"), cdoor.receipts[0].get("maxTokens")))
    tdoor = B.Door(up, "qwen3.5:9b", 2048, 9)
    threading.Thread(target=tdoor.serve_forever, daemon=True).start()
    caps = []
    for asked, role in ((5000, "reporter"), (True, "planner"), (None, "planner"), (64, None)):
        body = {"model": "m", "messages": [{"role": "user", "content": "u:10:1"}]}
        if asked is not None:
            body["max_tokens"] = asked
        got = _post_h(tdoor.base, "/v1/chat/completions", body, {"X-Atlias-Role": role} if role else None)
        caps.append((seen[-1].get("max_tokens"), got[2].get("X-Atlias-Door-Max-Tokens"), tdoor.receipts[-1].get("maxTokens")))
    check("a helper cap above the run's is held to num_predict, an invalid one is ignored, and a primary call is held to num_predict as before, with no header or receipt field",
          caps == [(2048, "2048", {"asked": 5000, "sent": 2048}), (2048, "2048", {"asked": None, "sent": 2048}), (2048, "2048", {"asked": None, "sent": 2048}), (2048, None, None)], caps)
    for d in (cdoor, tdoor):
        d.shutdown()
    ns = argparse.Namespace(harness="claude", model="qwen3.5:9b", num_ctx=16384, num_predict=2048, tasks=["T"], ids_from="")
    summed = B.report([prow, mrow], ns, time.time())["byRole"]
    legacy = B.report([{k: v for k, v in prow.items() if k != "byRole"}, mrow], ns, time.time())["byRole"]
    check("the report adds up the tasks' role figures, and one task row without them makes the whole table unknown",
          summed.get("primary", {}).get("input") == 522 and summed.get("primary", {}).get("calls") == 4 and summed.get("planner", {}).get("calls") == 1
          and summed.get("reporter", {}).get("capped") == 1 and legacy is None,
          (summed, legacy))
    for d in (idoor, bdoor):
        d.shutdown()
    srv.shutdown()
    srv.server_close()
    door2.shutdown()
    door.shutdown()
    fake.shutdown()
    bad = [r for r in results if not r[1]]
    for name, ok, got in results:
        print(("ok   " if ok else "FAIL ") + name + ("" if ok else "  got " + repr(got)[:400]))
    print(f"{len(results) - len(bad)}/{len(results)}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
