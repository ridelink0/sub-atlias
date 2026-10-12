"""Capture native Claude Code requests against a recording stand-in; no inference."""
import argparse
import http.server
import json
import pathlib
import threading

import base_harness_runner as B
import base_harness_selftest as fixture

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--plugin", action="append", default=[])
    ap.add_argument("--settings", default="")
    ap.add_argument("--tool-search", action="store_true")
    a = ap.parse_args()
    root = pathlib.Path(a.out).resolve()
    root.mkdir(parents=True, exist_ok=True)
    fake = http.server.ThreadingHTTPServer(("127.0.0.1", 0), fixture.Fake)
    threading.Thread(target=fake.serve_forever, daemon=True).start()
    door = B.Door(f"http://127.0.0.1:{fake.server_address[1]}", "qwen3.5:9b", 2048, 5)
    threading.Thread(target=door.serve_forever, daemon=True).start()
    ws = root / "workspace"
    ws.mkdir(exist_ok=True)
    env = B.offline_env(str(root / "state"), door, str(root / "shims"))
    if a.tool_search:
        env["ENABLE_TOOL_SEARCH"] = "true"
    opts = argparse.Namespace(model="qwen3.5:9b", num_predict=2048,
        claude="C:/Users/OWNER/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
        claude_plugin_dir=a.plugin)
    prompt = "Record this exact probe request. No edits. AUTHORITY_SENTINEL_1012."
    argv, cwd, stdin = B.claude_command(opts, {"prompt": prompt}, ws, str(root / "state"), door, 5, env)
    if a.settings:
        argv += ["--settings", str(pathlib.Path(a.settings).resolve())]
    try:
        with open(root / "native-output.txt", "wb") as out:
            rc, why = B.run_harness(argv, cwd=cwd, env=env, door=door, start_limit=120, task_limit=120, stdout=out)
        requests = list(fixture.seen)
        (root / "requests.json").write_bytes(json.dumps(requests, indent=2).encode("utf-8"))
        summary = {"inference": False, "harnessExit": rc, "stop": why, "calls": door.calls,
                   "requests": len(requests), "errors": door.errors,
                   "authorityPresent": bool(requests) and all(prompt in json.dumps(r, ensure_ascii=False) for r in requests),
                   "firstCharacters": len(json.dumps(requests[0])) if requests else None,
                   "tools": [{"name": t.get("name"), "descriptionCharacters": len(t.get("description", "")),
                              "defer": t.get("defer_loading")} for t in requests[0].get("tools", [])] if requests else []}
        (root / "summary.json").write_bytes(json.dumps(summary, indent=2).encode("utf-8"))
        print(json.dumps(summary, indent=2))
        if rc != 0 or why or not summary["authorityPresent"]:
            raise SystemExit(1)
    finally:
        door.shutdown()
        door.server_close()
        fake.shutdown()
        fake.server_close()

if __name__ == "__main__":
    main()
