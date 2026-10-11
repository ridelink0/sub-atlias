"""No-model self-test of the metering door in base_harness_runner.py: a fake Ollama stands in
upstream, so this runs anywhere and never touches a GPU.  python tools/h2h/base_harness_selftest.py"""
import http.client
import http.server
import json
import pathlib
import sys
import threading
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import base_harness_runner as B  # noqa: E402

seen = []


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

    def do_GET(self):
        self._out(200, json.dumps({"object": "list", "data": [{"id": "m"}]}).encode())

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        seen.append(req)
        mode = req["messages"][-1]["content"]
        if mode == "boom":
            return self._out(500, b'{"error":"no"}')
        usage = None if mode == "nousage" else {"prompt_tokens": 111, "completion_tokens": 22, "total_tokens": 133}
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
    door.shutdown()
    fake.shutdown()
    bad = [r for r in results if not r[1]]
    for name, ok, got in results:
        print(("ok   " if ok else "FAIL ") + name + ("" if ok else "  got " + repr(got)[:400]))
    print(f"{len(results) - len(bad)}/{len(results)}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
