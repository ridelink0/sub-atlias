"""What base Codex sends before any work, against a recording stand-in for the Responses API.

No inference: the stand-in answers every /v1/responses call with one finished assistant message
and a usage block, and records the request. The exact bundled Codex CLI runs in a private
CODEX_HOME and home folder, with a loopback custom provider (a built-in provider id cannot be
overridden), the Responses wire API and websockets off. What it settles: that this build runs
against such a provider at all, and how large its opening is (instructions, tools by type, input
items), the figure that bounds any peak-context saving. RESEARCH-FIRST 0f; the subharness
efficiency report's Codex section."""
import argparse
import hashlib
import http.server
import json
import pathlib
import shutil
import threading

import base_harness_runner as B

CODEX = "C:/Users/OWNER/AppData/Local/OpenAI/Codex/bin/2e5e00daee91c61d/codex.exe"
PROMPT = "Record this exact probe request. No edits. CODEX_AUTHORITY_SENTINEL_1012."


def disabled_skills(roots):
    """Exact personal skill files only; never disable native/project skill discovery."""
    files = set()
    for root in roots:
        for file in pathlib.Path(root).resolve().rglob("SKILL.md"):
            if ".system" not in file.parts:
                files.add(file.resolve().as_posix())
    return sorted(files)


def disable_skill_args(files):
    rows = ",".join("{path=" + json.dumps(p) + ",enabled=false}" for p in files)
    return ["-c", "skills.config=[" + rows + "]"] if files else []


def provider_args(base, configs=()):
    p = "atlias_local_meter"
    return ["-c", 'model="qwen3.5:9b"', "-c", f'model_provider="{p}"',
            "-c", f'model_providers.{p}.name="Atlias local meter"', "-c", f'model_providers.{p}.base_url="{base}"',
            "-c", f'model_providers.{p}.wire_api="responses"', "-c", f"model_providers.{p}.requires_openai_auth=false",
            "-c", f"model_providers.{p}.supports_websockets=false", "-c", "model_context_window=32768", "-c", 'web_search="disabled"',
            *[x for c in configs for x in ("-c", c)]]


class Responses(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    seen = []

    def log_message(self, *_):
        pass

    def _out(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.seen.append({"method": "GET", "path": self.path, "body": None})
        self._out(200, json.dumps({"object": "list", "data": [{"id": "qwen3.5:9b", "object": "model"}]}).encode())

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        try:
            body = json.loads(raw)
        except ValueError:
            body = {"unreadable": raw[:400].decode("utf-8", errors="replace")}
        self.seen.append({"method": "POST", "path": self.path, "body": body})
        if not self.path.split("?")[0].rstrip("/").endswith("/responses"):
            return self._out(404, b'{"error":{"message":"not served by the probe"}}')
        n = len(self.seen)
        item = {"type": "message", "id": f"msg_probe_{n}", "role": "assistant", "status": "completed",
                "content": [{"type": "output_text", "text": "done", "annotations": []}]}
        usage = {"input_tokens": 100, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 5,
                 "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 105}
        resp = {"id": f"resp_probe_{n}", "object": "response", "status": "completed", "model": body.get("model"), "output": [item], "usage": usage}
        ev = [("response.created", {"type": "response.created", "response": {**resp, "status": "in_progress", "output": [], "usage": None}}),
              ("response.output_item.added", {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "content": []}}),
              ("response.output_text.delta", {"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": "done"}),
              ("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": item}),
              ("response.completed", {"type": "response.completed", "response": resp})]
        self._out(200, "".join(f"event: {k}\ndata: {json.dumps(d)}\n\n" for k, d in ev).encode(), "text/event-stream")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--codex", default=CODEX)
    ap.add_argument("--config", action="append", default=[], help="an extra -c key=value for Codex (repeatable), the same way each arm would get it")
    ap.add_argument("--codex-home-from", help="copy an isolated prepared home and load its config; never changes the original")
    ap.add_argument("--disable-skill-root", action="append", default=[], help="disable exact personal SKILL.md files under this root; native/project skills stay enabled")
    ap.add_argument("--bypass-hook-trust", action="store_true", help="run pre-vetted hooks in this isolated automation")
    a = ap.parse_args()
    root = pathlib.Path(a.out).resolve()
    ws, home = root / "workspace", root / "codex-home"
    ws.mkdir(parents=True, exist_ok=True)
    if a.codex_home_from:
        prepared = pathlib.Path(a.codex_home_from).resolve()
        if home == prepared or prepared in home.parents:
            ap.error("the probe output home must be outside the prepared source home")
        shutil.copytree(prepared, home, dirs_exist_ok=True)
    home.mkdir(parents=True, exist_ok=True)
    Responses.seen = []
    fake = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Responses)
    threading.Thread(target=fake.serve_forever, daemon=True).start()
    door = B.Door(f"http://127.0.0.1:{fake.server_address[1]}", "qwen3.5:9b", 2048, 5)  # only its refusal of other hosts is used
    threading.Thread(target=door.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{fake.server_address[1]}/v1"
    env = B.offline_env(str(root / "state"), door, str(root / "shims"))
    env.update({"CODEX_HOME": str(home), "ATLIAS_HOME": str(root / "atlias-home")})
    files = disabled_skills(a.disable_skill_root)
    argv = [a.codex, "exec", *([] if a.codex_home_from else ["--ignore-user-config"]), "--ignore-rules", "--strict-config", "--json", "--skip-git-repo-check",
            *(["--dangerously-bypass-hook-trust"] if a.bypass_hook_trust else []), "-C", str(ws),
            *provider_args(base, a.config), *disable_skill_args(files), "-"]
    try:
        with open(root / "native-output.txt", "wb") as out:
            rc, why = B.run_harness(argv, cwd=str(ws), env=env, door=door, start_limit=120, task_limit=120, stdout=out, stdin_text=PROMPT)
    finally:
        door.shutdown()
        door.server_close()
        fake.shutdown()
        fake.server_close()
    seen = list(Responses.seen)
    (root / "requests.json").write_bytes(json.dumps(seen, indent=1, ensure_ascii=False).encode("utf-8"))
    calls = [s["body"] for s in seen if s["method"] == "POST" and s["path"].split("?")[0].rstrip("/").endswith("/responses")]
    first = calls[0] if calls else {}
    tools = first.get("tools") or []
    summary = {"inference": False, "codex": a.codex, "sha256": hashlib.sha256(pathlib.Path(a.codex).read_bytes()).hexdigest(),
               "argv": argv[1:], "exit": rc, "stop": why, "refused": door.refused, "paths": [f"{s['method']} {s['path']}" for s in seen],
               "preparedHome": a.codex_home_from, "disabledSkillFiles": files,
               "responsesCalls": len(calls), "authorityPresent": bool(calls) and all(PROMPT in json.dumps(c, ensure_ascii=False) for c in calls),
               "firstRequestChars": len(json.dumps(first, ensure_ascii=False)) if calls else None,
               "instructionsChars": len(first.get("instructions") or "") if calls else None,
               "toolsChars": len(json.dumps(tools, ensure_ascii=False)),
               "tools": [{"type": t.get("type"), "name": t.get("name") or (t.get("namespace") or {}).get("name"), "descriptionChars": len(t.get("description") or ""),
                          "chars": len(json.dumps(t, ensure_ascii=False))} for t in tools],
               "inputItems": [{"type": i.get("type"), "role": i.get("role"), "chars": len(json.dumps(i, ensure_ascii=False))} for i in first.get("input") or []],
               "topKeys": sorted(first)}
    (root / "summary.json").write_bytes(json.dumps(summary, indent=1, ensure_ascii=False).encode("utf-8"))
    print(json.dumps(summary, indent=1, ensure_ascii=True)[:8000])


if __name__ == "__main__":
    main()
