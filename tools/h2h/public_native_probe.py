"""Actual public Atlias launcher + installed native clients, against recording APIs.

No inference or paid API. Fixture usage proves receipt plumbing only. RESEARCH-FIRST
0f/H6: preserve native resume, complete requests and native skill capabilities.
"""
import argparse
import hashlib
import http.server
import http.client
import json
import pathlib
import threading
import time
import types
import uuid

import base_harness_runner as B
import codex_probe as C
from codex_continuity_probe import texts, thread_id

CLAUDE = "C:/Users/OWNER/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
ORIGINAL = "PUBLIC_ORIGINAL_EXACT_1012. Record this request exactly; keep alpha then beta. Do no edits."
FOLLOWUP = "PUBLIC_FOLLOWUP_EXACT_1012. Keep the original request; add gamma after beta. Do no edits."


def passed(checks):
    return bool(checks) and all(value is True for value in checks.values())


class Endpoint(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    seen, phase, secret, door = [], "", "", None

    def log_message(self, *_):
        pass

    def out(self, code, body, kind="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.out(200, json.dumps({"object": "list", "data": [{"id": "localstandin", "object": "model"}]}).encode())

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
        route = self.path.split("?")[0]
        anthropic = route.startswith("/v1/messages")
        accepted = (self.headers.get("x-api-key") == self.secret) if anthropic else (self.headers.get("Authorization") == "Bearer " + self.secret)
        self.seen.append({"phase": self.phase, "path": self.path, "credentialAccepted": accepted, "body": body})
        if not accepted:
            return self.out(401, b'{"error":{"message":"recording upstream credential rejected"}}')
        if route.endswith("/count_tokens"):
            return self.out(200, b'{"input_tokens":100}')
        self.door.first = self.door.first or time.time()
        n = len(self.seen)
        if anthropic:
            usage = {"input_tokens": 70, "cache_read_input_tokens": 20, "cache_creation_input_tokens": 10, "output_tokens": 5}
            message = {"id": f"m_public_{n}", "type": "message", "role": "assistant", "model": body.get("model"),
                       "content": [{"type": "text", "text": "Recorded."}], "stop_reason": "end_turn", "stop_sequence": None, "usage": usage}
            if not body.get("stream"):
                return self.out(200, json.dumps(message).encode())
            events = [("message_start", {"type": "message_start", "message": {**message, "content": [], "stop_reason": None, "usage": {**usage, "output_tokens": 0}}}),
                      ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                      ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Recorded."}}),
                      ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                      ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 5}}),
                      ("message_stop", {"type": "message_stop"})]
        else:
            usage = {"input_tokens": 100, "input_tokens_details": {"cached_tokens": 20, "cache_write_tokens": 10},
                     "output_tokens": 5, "output_tokens_details": {"reasoning_tokens": 1}, "total_tokens": 105}
            item = {"type": "message", "id": f"m_public_{n}", "role": "assistant", "status": "completed",
                    "content": [{"type": "output_text", "text": "Recorded.", "annotations": []}]}
            response = {"id": f"r_public_{n}", "object": "response", "status": "completed", "model": body.get("model"), "output": [item], "usage": usage}
            events = [("response.created", {"type": "response.created", "response": {**response, "status": "in_progress", "output": [], "usage": None}}),
                      ("response.output_item.added", {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "content": []}}),
                      ("response.output_text.delta", {"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": "Recorded."}),
                      ("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": item}),
                      ("response.completed", {"type": "response.completed", "response": response})]
        self.out(200, "".join(f"event: {kind}\ndata: {json.dumps(event)}\n\n" for kind, event in events).encode(), "text/event-stream")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    ap.add_argument("--host", choices=["claude", "codex"])
    ap.add_argument("--source", default=str(pathlib.Path(__file__).resolve().parents[2]))
    ap.add_argument("--claude", default=CLAUDE)
    ap.add_argument("--codex", default=C.CODEX)
    ap.add_argument("--disable-skill-root", action="append", default=[])
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    if not a.out or not a.host:
        ap.error("--out and --host are required unless --self-test")
    root = pathlib.Path(a.out).resolve()
    ws = root / "workspace"
    ws.mkdir(parents=True, exist_ok=True)
    Endpoint.seen = []
    endpoint = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Endpoint)
    threading.Thread(target=endpoint.serve_forever, daemon=True).start()
    door = B.Door(f"http://127.0.0.1:{endpoint.server_address[1]}", "localstandin", 2048, 20)
    Endpoint.door = door
    threading.Thread(target=door.serve_forever, daemon=True).start()
    secret = uuid.uuid4().hex
    Endpoint.secret = secret
    env = B.offline_env(str(root / "state"), door, str(root / "shims"))
    env.update({"ATLIAS_HOME": str(root / "atlias-home"), "CODEX_HOME": str(root / "codex-home"),
                "CLAUDE_CONFIG_DIR": str(root / "claude-profile"), "PUBLIC_PROBE_API_KEY": secret,
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1"})
    pricing = {"currency": "USD", "input": 2, "output": 8, "cacheRead": 0.2, "cacheWrite": 2.5, "source": "protocol fixture", "asOf": "2026-10-12"}
    profile = {"protocol": "anthropic" if a.host == "claude" else "responses", "baseUrl": f"http://127.0.0.1:{endpoint.server_address[1]}/v1",
               "model": "localstandin", "keyEnv": "PUBLIC_PROBE_API_KEY", "pricing": pricing}
    profile_file, log = root / "provider.json", root / "receipts.jsonl"
    profile_file.write_bytes(json.dumps(profile).encode())
    sid = str(uuid.uuid4()) if a.host == "claude" else None
    stages = []
    executable = a.claude if a.host == "claude" else a.codex
    try:
        for phase, prompt in (("original", ORIGINAL), ("followup", FOLLOWUP)):
            if phase == "followup" and not sid:
                break
            Endpoint.phase = phase
            door.first = None
            before = len(Endpoint.seen)
            receipts_before = len(log.read_text(encoding="utf-8").splitlines()) if log.exists() else 0
            if a.host == "claude":
                native = ["-p", prompt, "--output-format", "json", "--dangerously-skip-permissions",
                          *( ["--session-id", sid] if phase == "original" else ["--resume", sid])]
                stdin = None
            else:
                controls = ["--ignore-rules", "--strict-config", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox",
                            "--dangerously-bypass-hook-trust", "-c", "model_context_window=32768", "-c", 'web_search="disabled"',
                            *C.disable_skill_args(C.disabled_skills(a.disable_skill_root))]
                native = ["exec", *controls, "-C", str(ws), "-"] if phase == "original" else ["exec", "resume", *controls, sid, "-"]
                stdin = prompt
            argv = ["node", str(pathlib.Path(a.source) / "bin" / "atlias.mjs"), "sub", "--profile", str(profile_file), "--host", a.host,
                    "--executable", executable, "--log", str(log), "--", *native]
            output = root / (phase + "-output.txt")
            with output.open("wb") as out:
                rc, stop = B.run_harness(argv, cwd=str(ws), env=env, door=door, start_limit=120, task_limit=120, stdout=out, stdin_text=stdin)
            text = output.read_text(encoding="utf-8", errors="replace")
            if a.host == "codex":
                sid = sid or thread_id(text)
            calls = [r for r in Endpoint.seen[before:] if not r["path"].split("?")[0].endswith("count_tokens")]
            rows = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()[receipts_before:]] if log.exists() else []
            stages.append({"phase": phase, "exit": rc, "stop": stop, "nativeArgs": native,
                           "requests": [{"path": r["path"], "credentialAccepted": r["credentialAccepted"], "originalExact": ORIGINAL in texts(r["body"]),
                                         "currentExact": prompt in texts(r["body"]), "model": r["body"].get("model")} for r in calls],
                           "receipts": rows, "outputContainsCredential": secret in text})
            if rc != 0 or stop:
                break
        (root / "requests.json").write_bytes(json.dumps(Endpoint.seen, indent=1, ensure_ascii=False).encode("utf-8"))
        all_rows = [r for s in stages for r in s["receipts"]]
        summary = {"inference": False, "fixtureUsageOnly": True, "host": a.host, "executableSha256": hashlib.sha256(pathlib.Path(executable).read_bytes()).hexdigest(),
                   "threadId": sid, "stages": stages, "refused": door.refused,
                   "checks": {"bothLauncherExitsZero": len(stages) == 2 and all(s["exit"] == 0 for s in stages),
                              "twoPhysicalCallsRecorded": len(all_rows) == 2,
                              "nativeCredentialReachedLocalMeter": bool(all_rows) and all(r.get("status") == 200 for r in all_rows),
                              "upstreamCredentialFromEnvironment": bool(Endpoint.seen) and all(r["credentialAccepted"] for r in Endpoint.seen),
                              "requestsPreservedAcrossResume": len(stages) == 2 and all(s["requests"] and all(r["originalExact"] and r["currentExact"] for r in s["requests"]) for s in stages),
                              "completeUsageAndCost": bool(all_rows) and all(r.get("terminal") and (r.get("tokens") or {}).get("total") == 105 and abs((r.get("cost") or {}).get("value", 0) - 0.000209) < 1e-12 for r in all_rows),
                              "credentialAbsentFromRecords": secret not in json.dumps(Endpoint.seen) and secret not in json.dumps(all_rows) and not any(s["outputContainsCredential"] for s in stages)}}
        (root / "summary.json").write_bytes(json.dumps(summary, indent=1).encode())
        print(json.dumps({k: v for k, v in summary.items() if k != "stages"}, indent=1))
        print(json.dumps([{k: v for k, v in s.items() if k != "nativeArgs"} for s in stages], indent=1))
        if not passed(summary["checks"]):
            raise SystemExit(1)
    finally:
        door.shutdown()
        door.server_close()
        endpoint.shutdown()
        endpoint.server_close()


def self_test():
    assert passed({"one": True, "two": True})
    assert not passed({"one": True, "two": False})
    assert not passed({}) and not passed({"one": "true"})
    Endpoint.secret, Endpoint.seen, Endpoint.door = "fixture-upstream-credential", [], types.SimpleNamespace(first=None)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Endpoint)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        c = http.client.HTTPConnection(*server.server_address)
        c.request("POST", "/v1/responses", body=b'{"model":"fixture"}', headers={"Authorization": "Bearer wrong", "Content-Type": "application/json"})
        response = c.getresponse()
        assert response.status == 401
        response.read(); c.close()
        c = http.client.HTTPConnection(*server.server_address)
        c.request("POST", "/v1/messages/count_tokens?beta=true", body=b'{"model":"fixture"}', headers={"x-api-key": Endpoint.secret, "Content-Type": "application/json"})
        response = c.getresponse()
        assert response.status == 200 and json.loads(response.read()) == {"input_tokens": 100}
        c.close()
        assert Endpoint.seen[0]["credentialAccepted"] is False and Endpoint.seen[1]["credentialAccepted"] is True
    finally:
        server.shutdown()
        server.server_close()
    print("Public native probe self-test: 6 checks passed")


if __name__ == "__main__":
    main()
