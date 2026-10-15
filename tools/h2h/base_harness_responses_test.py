"""The door's Responses path, for Codex, with no model and no network: whole streams, repeated and
missing terminal events, incomplete replies, bad usage, a call that leans on server-side state, the
compaction call, a path the door does not meter, the stop past the budget, every tool kind and the
raw patch text passed through untouched, and the bundled Codex CLI itself through the door.

    python tools/h2h/base_harness_responses_test.py"""
import argparse
import http.server
import json
import os
import pathlib
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request

import base_harness_runner as B

CODEX = os.environ.get("ATLIAS_CODEX_CLI") or shutil.which("codex") or ""


class Upstream(http.server.BaseHTTPRequestHandler):
    """Answers /v1/responses as the request's metadata says (or with one finished message), and
    keeps every body it was given."""
    protocol_version = "HTTP/1.0"
    seen = []

    def log_message(self, *_):
        pass

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.seen.append((self.path, req))
        say = (req.get("metadata") or {}).get("say")
        say = json.loads(say) if say else {}
        usage = say.get("usage", {"input_tokens": 100, "input_tokens_details": {"cached_tokens": 40}, "output_tokens": 5,
                                  "output_tokens_details": {"reasoning_tokens": 2}, "total_tokens": 105})
        item = {"type": "message", "id": "msg_1", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "done", "annotations": []}]}
        resp = {"id": "resp_1", "object": "response", "status": "completed", "output": [item], "usage": usage}
        if not req.get("stream"):
            body = json.dumps(resp).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            return self.wfile.write(body)
        ev = [("response.created", {"type": "response.created", "response": {**resp, "status": "in_progress", "output": [], "usage": None}}),
              ("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": item})]
        end = say.get("terminal", "response.completed")
        for _ in range(say.get("repeat", 1) if end else 0):
            extra = {"incomplete_details": {"reason": "max_output_tokens"}, "status": "incomplete"} if end == "response.incomplete" else {}
            ev.append((end, {"type": end, "response": {**resp, **extra}}))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.wfile.write("".join(f"event: {k}\ndata: {json.dumps(d)}\n\n" for k, d in ev).encode())


def main():
    if not pathlib.Path(CODEX).is_file():
        print("UNQUALIFIED native Codex conformance: set ATLIAS_CODEX_CLI to an installed executable", file=sys.stderr)
        return 2
    results = []

    def check(name, ok, got=None):
        results.append((name, bool(ok), got))

    up = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=up.serve_forever, daemon=True).start()
    door = B.Door(f"http://127.0.0.1:{up.server_address[1]}", "qwen3.5:9b", 2048, 7)
    threading.Thread(target=door.serve_forever, daemon=True).start()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(say=None, path="/v1/responses", stream=True, **extra):
        body = {"model": "x", "stream": stream, "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}],
                "metadata": {"say": json.dumps(say or {})}, **extra}
        req = urllib.request.Request(door.base + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
        try:
            with opener.open(req, timeout=20) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    check("cached input and reasoning output are parts of the two totals, not added to them",
          B._responses_usage({"input_tokens": 100, "input_tokens_details": {"cached_tokens": 40}, "output_tokens": 5, "output_tokens_details": {"reasoning_tokens": 2}}) == (100, 5))
    check("a Responses count that is negative, true or false, text or null is unknown",
          all(B._responses_usage({"input_tokens": v, "output_tokens": 5}) is None for v in (-1, True, "7", None, 1.5)) and B._responses_usage(None) is None)

    tools = [{"type": "function", "name": "exec_command", "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}}},
             {"type": "custom", "name": "apply_patch", "format": {"type": "grammar", "syntax": "lark", "definition": "start: /.+/s"}},
             {"type": "namespace", "name": "multi_agent_v1", "tools": [{"type": "function", "name": "spawn", "parameters": {"type": "object"}}]}]
    patch = "*** Begin Patch\n*** Update File: a.py\n@@\n-x = 1\n+x = 2\n*** End Patch\n"
    items = [{"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "rules"}]},
             {"type": "custom_tool_call", "call_id": "call_patch_1", "name": "apply_patch", "input": patch},
             {"type": "custom_tool_call_output", "call_id": "call_patch_1", "output": "Success."},
             {"type": "function_call", "call_id": "call_fn_2", "name": "exec_command", "arguments": "{\"cmd\": \"python check.py\"}"},
             {"type": "function_call_output", "call_id": "call_fn_2", "output": "ok"}]
    s, b = call(tools=tools, instructions="keep me", input=items, max_output_tokens=99999, temperature=1.5)
    path, got = Upstream.seen[-1]
    check("a whole stream is passed through, counted from its terminal event, and its receipt says complete",
          s == 200 and door.usage[-1] == (100, 5) and door.receipts[-1]["outcome"] == "complete" and door.receipts[-1]["path"] == "/v1/responses" and b.rstrip().endswith("}"), (s, door.receipts[-1]))
    check("every tool kind, the instructions, the call ids and the raw patch text reach the model server untouched; only model, temperature and output cap are held",
          path == "/v1/responses" and got.get("tools") == tools and got.get("input") == items and got.get("instructions") == "keep me"
          and got.get("model") == "qwen3.5:9b" and got.get("temperature") == 0.2 and got.get("max_output_tokens") == 2048, {k: got.get(k) for k in ("model", "temperature", "max_output_tokens", "instructions")})
    call({"repeat": 3})
    check("a terminal event sent three times is counted once", door.usage[-1] == (100, 5) and len(door.usage) == 2 and len(door.receipts[-1]["usage"]) == 3, (door.usage, door.receipts[-1]))
    call({"terminal": "response.incomplete"})
    check("an incomplete reply is counted and named incomplete, with its reason kept",
          door.receipts[-1]["outcome"] == "incomplete" and door.receipts[-1]["detail"] == {"reason": "max_output_tokens"} and door.usage[-1] == (100, 5), door.receipts[-1])
    call({"terminal": None})
    check("a stream with no terminal event is partial and unknown, never a finished free call",
          door.receipts[-1]["outcome"].startswith("partial") and door.partial == 1 and door.usage[-1] is None, (door.receipts[-1], door.partial))
    call({"usage": {"input_tokens": -5, "output_tokens": 5}})
    check("a negative input count is unknown, with the raw block kept", door.usage[-1] is None and door.receipts[-1]["usage"][0]["input_tokens"] == -5, door.receipts[-1])
    calls = door.calls
    s, _ = call(previous_response_id="resp_0")
    check("a call that leans on an earlier response by id is refused, is not a model call, and is recorded",
          s == 400 and door.calls == calls and door.receipts[-1]["outcome"].startswith("refused") and "refused previous_response_id" in door.errors, (s, door.receipts[-1]))
    s, _ = call({}, path="/v1/responses/compact", stream=False)
    check("the compaction call is metered like any other", s == 200 and door.receipts[-1]["path"] == "/v1/responses/compact" and door.usage[-1] == (100, 5), door.receipts[-1])
    n = len(Upstream.seen)
    s, _ = call({}, path="/v1/responses/other")
    check("another generation path is refused, never let through unmetered", s == 501 and len(Upstream.seen) == n and door.receipts[-1]["outcome"].startswith("refused"), (s, door.receipts[-1]))
    call({})
    s, b = call({})
    events = [json.loads(x[6:]) for x in b.split("\n") if x.startswith("data: ")]
    check("past the budget the door answers a well-formed Responses stop by itself and the model is not called",
          s == 200 and len(Upstream.seen) == n + 1 and door.capped == 1 and events[-1]["type"] == "response.completed" and B.STOP_TEXT in b and door.receipts[-1]["outcome"].startswith("capped"), b[:300])
    door.shutdown()

    if os.path.exists(CODEX):
        door2 = B.Door(f"http://127.0.0.1:{up.server_address[1]}", "qwen3.5:9b", 2048, 5)
        threading.Thread(target=door2.serve_forever, daemon=True).start()
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as state:
            ws = pathlib.Path(state) / "ws"
            ws.mkdir()
            import codex_probe as P
            skill_snapshot = pathlib.Path(state) / 'personal-skills.json'
            skill_snapshot.write_text(json.dumps({'files': P.disabled_skills([pathlib.Path.home() / '.agents' / 'skills', pathlib.Path.home() / '.codex' / 'skills'])}), encoding='utf-8')
            a = argparse.Namespace(codex=CODEX, codex_home_from="", model="qwen3.5:9b", num_ctx=32768, codex_disabled_skills=str(skill_snapshot))
            env = B.offline_env(state, door2, str(pathlib.Path(state) / "shims"))
            argv, cwd, stdin_text = B.codex_command(a, {"prompt": "CODEX_DOOR_SENTINEL_1012"}, ws, state, door2, 5, env)
            with open(pathlib.Path(state) / "out.txt", "wb") as buf:
                rc, why = B.run_harness(argv, cwd=cwd, env=env, door=door2, start_limit=120, task_limit=120, stdout=buf, stdin_text=stdin_text)
            said = (pathlib.Path(state) / "out.txt").read_text(encoding="utf-8", errors="replace")
            path, got = Upstream.seen[-1]
            check("the bundled Codex CLI, in the harness environment, reaches the model only through the door, is counted, and ends by itself",
                  rc == 0 and why == "" and door2.calls == 1 and door2.usage == [(100, 5)] and door2.receipts[0]["outcome"] == "complete"
                  and "CODEX_DOOR_SENTINEL_1012" in json.dumps(got) and env["CODEX_HOME"].startswith(state) and '"turn.completed"' in said
                  and "skills_instructions" in json.dumps(got) and "openai-docs" in json.dumps(got) and ".agents/skills" not in json.dumps(got),
                  (rc, why, door2.calls, door2.usage, door2.errors, door2.refused[:4], said[-300:]))
        door2.shutdown()
    else:
        check("native Codex conformance requires an installed executable; set ATLIAS_CODEX_CLI", False, CODEX)
    up.shutdown()

    bad = [r for r in results if not r[1]]
    for name, ok, got in results:
        print(("ok   " if ok else "FAIL ") + name + ("" if ok else "  got " + repr(got)[:400]))
    print(f"{len(results) - len(bad)}/{len(results)}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
