"""Adversarial checks of the base-harness runner's accounting, with no model and no network: usage
blocks in every bad shape, streams that end early, upstream failures, calls past the budget, runs
with a task whose window or count is missing, mixed provenance, and resume. Each check names what a
wrong ledger would claim. RESEARCH-FIRST 0f; the subharness efficiency report's accounting section.

    python tools/h2h/base_harness_accounting_test.py"""
import argparse
import http.server
import json
import pathlib
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

import base_harness_runner as B

BAD = [-1, True, False, "7", None, 1.5, [], {}]


class Upstream(http.server.BaseHTTPRequestHandler):
    """Answers in Claude's wire format as the request's last message says: a usage block to send,
    whether to end the stream, or a failure."""
    protocol_version = "HTTP/1.0"

    def log_message(self, *_):
        pass

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        say = json.loads(req["messages"][-1]["content"])
        if say.get("fail"):
            self.send_response(say["fail"])
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"type":"error","error":{"type":"api_error","message":"no"}}')
            return
        ev = [("message_start", {"type": "message_start", "message": {"id": "m", "type": "message", "role": "assistant", "content": [], "usage": say["start"]}}),
              ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
              ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "hi"}}),
              ("content_block_stop", {"type": "content_block_stop", "index": 0})]
        ev += [("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": u}) for u in say.get("deltas", [])]
        if say.get("end", True):
            ev.append(("message_stop", {"type": "message_stop"}))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.wfile.write("".join(f"event: {k}\ndata: {json.dumps(d)}\n\n" for k, d in ev).encode())


def main():
    results = []

    def check(name, ok, got=None):
        results.append((name, bool(ok), got))

    # The three input parts are disjoint and each is counted once.
    check("new input, cache writes and cache reads are summed once into what was read",
          B._message_usage({"input_tokens": 100, "cache_creation_input_tokens": 7, "cache_read_input_tokens": 11, "output_tokens": 5}) == (118, 5))
    check("a cache part no block mentions is 0, not unknown", B._message_usage({"input_tokens": 100, "output_tokens": 5}) == (100, 5))
    for key in ("cache_read_input_tokens", "cache_creation_input_tokens", "input_tokens"):
        got = [B._message_usage({"input_tokens": 100, "output_tokens": 5, key: v})[0] for v in BAD]
        check(f"a {key} that is negative, true or false, text, null, fractional or a container leaves what was read unknown, never smaller",
              all(g is None for g in got), got)
    check("an output count in a bad shape is unknown", all(B._message_usage({"input_tokens": 1, "output_tokens": v})[1] is None for v in BAD))
    got = {}
    B._message_counts({"input_tokens": 100, "cache_read_input_tokens": 11, "output_tokens": 1}, got)
    B._message_counts({"output_tokens": 22}, got)
    first = B._message_totals(got)
    B._message_counts({"output_tokens": -3}, got)
    check("a stream's later count replaces the earlier, and a later bad count makes it unknown again", first == (111, 22) and B._message_totals(got) == (111, None), (first, got))
    check("the chat format refuses negative and true/false counts", B._usage_of({"usage": {"prompt_tokens": -1, "completion_tokens": 2}}) is None
          and B._usage_of({"usage": {"prompt_tokens": True, "completion_tokens": 2}}) is None and B._usage_of({"usage": {"prompt_tokens": 3, "completion_tokens": 2}}) == (3, 2))

    # The door, against a stand-in that misbehaves on request.
    up = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=up.serve_forever, daemon=True).start()
    door = B.Door(f"http://127.0.0.1:{up.server_address[1]}", "qwen3.5:9b", 2048, 5)
    threading.Thread(target=door.serve_forever, daemon=True).start()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(say):
        body = {"model": "x", "max_tokens": 5, "stream": True, "messages": [{"role": "user", "content": json.dumps(say)}]}
        req = urllib.request.Request(door.base + "/v1/messages", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
        try:
            with opener.open(req, timeout=20) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    call({"start": {"input_tokens": 100, "cache_read_input_tokens": 11, "output_tokens": 1}, "deltas": [{"output_tokens": 22}]})
    r0 = door.receipts[-1]
    check("a whole stream is counted, keeps every raw usage block and its three parts, and ends complete",
          door.usage[-1] == (111, 22) and r0["outcome"] == "complete" and len(r0["usage"]) == 2 and r0["counts"] == {"uncached": 100, "cacheRead": 11, "output": 22}, r0)
    call({"start": {"input_tokens": 100, "cache_read_input_tokens": -11, "output_tokens": 1}, "deltas": [{"output_tokens": 22}]})
    r1 = door.receipts[-1]
    check("a negative cache count reaches the ledger as unknown, with the raw block kept as it came",
          door.usage[-1] is None and r1["counts"]["cacheRead"] == "unknown" and r1["usage"][0]["cache_read_input_tokens"] == -11, (door.usage[-1], r1))
    call({"start": {"input_tokens": 100, "output_tokens": 1}, "deltas": [{"output_tokens": 22}], "end": False})
    r2 = door.receipts[-1]
    check("a stream that stops before message_stop is a partial call, kept and named, whatever it counted",
          door.partial == 1 and r2["outcome"].startswith("partial") and door.usage[-1] == (100, 22), (door.partial, r2))
    call({"start": {"input_tokens": 100, "output_tokens": 1}})
    check("a stream whose only output count is message_start's is recorded with that count, in the open",
          door.receipts[-1]["counts"] == {"uncached": 100, "output": 1} and door.usage[-1] == (100, 1), door.receipts[-1])
    s, _ = call({"fail": 500})
    r4 = door.receipts[-1]
    check("an upstream failure is a receipt with its status and an unknown count, and is listed as an error",
          s == 500 and r4["outcome"] == "HTTP 500" and r4["status"] == 500 and door.usage[-1] is None and door.errors[-1] == "HTTP 500", (s, r4))
    call({"start": {"input_tokens": 1, "output_tokens": 1}})
    check("a call past the budget is answered by the door, has a receipt that says so, and adds no model count",
          door.capped == 1 and door.receipts[-1]["outcome"].startswith("capped") and door.receipts[-1]["slot"] is None and len(door.usage) == 5, (door.capped, door.receipts[-1]))
    check("every call the harness made has exactly one receipt", len(door.receipts) == door.calls == 6, (len(door.receipts), door.calls))
    sent = [r.get("sent") for r in door.receipts if r["slot"] is not None]
    check("every call sent to the model names the size and hash of the exact body sent, and two different bodies differ",
          all(x and x["bytes"] > 0 and len(x["sha256"]) == 64 for x in sent) and len({x["sha256"] for x in sent}) == len(sent), sent)
    door.shutdown()
    up.shutdown()

    # The run's report.
    a = argparse.Namespace(harness="claude", claude_plugin_dir=[], model="qwen3.5:9b", num_ctx=32768, num_predict=2048, tasks=["T"], ids_from="")
    row = lambda i, **kw: {"id": f"t{i}", "pass": True, "promptTotal": 10, "outputTotal": 2, "peakPrompt": 6, "peakContext": 7, "usageComplete": True,  # noqa: E731
                           "loadedWindow": 32768, "nativeCompleted": True, "provenance": {"model": "d1"}, **kw}
    full = B.report([row(0), row(1)], a, time.time())
    check("a run where every task was counted at the asked window has totals, peaks and a matched window",
          full["windowMatched"] is True and full["usageComplete"] is True and full["promptTotal"] == 20 and full["outputTotal"] == 4 and full["peakPrompt"] == 6 and full["peakContext"] == 7, full)
    missing = B.report([row(0), row(1, loadedWindow=None)], a, time.time())
    check("a task whose window could not be read does not let the run claim a matched window", missing["windowMatched"] is False, missing["windowMatched"])
    other = B.report([row(0), row(1, loadedWindow=16384)], a, time.time())
    check("a task at another window does not match", other["windowMatched"] is False, other["windowMatched"])
    unknown = B.report([row(0), row(1, usageComplete=False, promptTotal=None, outputTotal=None, peakPrompt=None, peakContext=None)], a, time.time())
    check("one uncounted task leaves the run's totals and peaks unknown, never the smaller known part",
          unknown["usageComplete"] is False and unknown["promptTotal"] is None and unknown["outputTotal"] is None and unknown["peakPrompt"] is None and unknown["peakContext"] is None, unknown)
    lying = B.report([row(0), row(1, usageComplete=False)], a, time.time())
    check("a row that says it was not fully counted is not trusted for its totals", lying["usageComplete"] is False and lying["promptTotal"] is None, lying["promptTotal"])
    mixed = B.report([row(0), row(1, provenance={"model": "d2"})], a, time.time())
    check("rows from two different models or clients are flagged as not one run", mixed["provenanceUniform"] is False and full["provenanceUniform"] is True)
    graded = B.report([row(0, nativeCompleted=False), row(1, **{"pass": False})], a, time.time())
    check("ending by itself and passing the grader are counted apart", graded["nativeCompleted"] == 1 and graded["passed"] == 1, (graded["nativeCompleted"], graded["passed"]))

    with tempfile.TemporaryDirectory() as d:
        out = pathlib.Path(d) / "r.json"
        rows = [row(0, usageComplete=False, promptTotal=None), row(1, **{"pass": False})]
        out.write_text(json.dumps({"results": rows}), encoding="utf-8")
        check("resume keeps every earlier row, the uncounted and the failed ones included, unchanged", B.resumed(out) == rows)
        plug = pathlib.Path(d) / "plug"
        (plug / "hooks").mkdir(parents=True)
        (plug / "hooks" / "register.mjs").write_text("export const A = 1;\n", encoding="utf-8")
        h1 = B.tree_digest(plug)
        (plug / ".git").mkdir()
        (plug / ".git" / "HEAD").write_text("x", encoding="utf-8")
        h2 = B.tree_digest(plug)
        (plug / "hooks" / "register.mjs").write_text("export const A = 2;\n", encoding="utf-8")
        check("a plugin folder's hash ignores its .git and changes when one byte of a file does", h1 == h2 and B.tree_digest(plug) != h1 and B.tree_digest(pathlib.Path(d) / "none") is None)
    t = {"prompt": "fix", "files": {"a.py": "x"}, "check": ["python", "check.py"], "hidden": {"check.py": "assert 1"}}
    d1, d2 = B.task_digests(t), B.task_digests({**t, "hidden": {"check.py": "assert 2"}})
    check("a changed hidden grader changes the grader hash and nothing else", d1["grader"] != d2["grader"] and d1["prompt"] == d2["prompt"] and d1["files"] == d2["files"])

    bad = [r for r in results if not r[1]]
    for name, ok, got in results:
        print(("ok   " if ok else "FAIL ") + name + ("" if ok else "  got " + repr(got)[:400]))
    print(f"{len(results) - len(bad)}/{len(results)}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
