"""Native Codex startup, exact authority, selected skills and resume/compaction recording.

No model inference or paid API. Uses the bundled native CLI and an HTTP stand-in;
the usage values are protocol fixtures, never benchmark token measurements.
RESEARCH-FIRST 0f/H6: identical native controls, full project skills and system catalog.
"""
import argparse
import hashlib
import http.server
import json
import pathlib
import subprocess
import sys
import tempfile
import threading

import base_harness_runner as B
import codex_probe as P

ORIGINAL = "Use $continuity-probe. Original authority: ORIGINAL_EXACT_1012. Keep alpha, beta and gamma in that order. Do no edits."
FOLLOWUP = "Follow-up authority: FOLLOWUP_EXACT_1012. Add delta after gamma; preserve the original request and selected skill. Do no edits."
AFTER_COMPACT = "Second follow-up: AFTER_COMPACT_EXACT_1012. Retain both previous requests exactly. Do no edits."
PROJECT = "Project authority: PROJECT_EXACT_1012. Preserve this full line verbatim, including its punctuation.\n"
SKILL = "---\nname: continuity-probe\ndescription: Exact project skill for the native recording continuity probe.\n---\n# Continuity probe\n\nACTIVE_SKILL_EXACT_1012. Keep every active instruction verbatim. Never replace this skill with a path alone.\n"


def texts(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return "\n".join(texts(v) for v in value.values())
    if isinstance(value, list):
        return "\n".join(texts(v) for v in value)
    return ""


class Continuity(P.Responses):
    seen = []
    phase = ""

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        body = json.loads(raw)
        self.seen.append({"method": "POST", "path": self.path, "phase": self.phase, "body": body})
        route = self.path.split("?")[0].rstrip("/")
        if not route.endswith("/responses"):
            return self._out(404, b'{"error":{"message":"only Responses is served by this recording stand-in"}}')
        n = len(self.seen)
        compact = "CONTEXT CHECKPOINT COMPACTION" in texts(body).upper() or "summarize the conversation" in texts(body).lower()
        answer = "Compacted summary. Earlier work was recorded." if compact else "Recorded."
        item = {"type": "message", "id": f"msg_continuity_{n}", "role": "assistant", "status": "completed",
                "content": [{"type": "output_text", "text": answer, "annotations": []}]}
        usage = {"input_tokens": 100, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 5,
                 "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 105}
        resp = {"id": f"resp_continuity_{n}", "object": "response", "status": "completed", "model": body.get("model"), "output": [item], "usage": usage}
        ev = [("response.created", {"type": "response.created", "response": {**resp, "status": "in_progress", "output": [], "usage": None}}),
              ("response.output_item.added", {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "content": []}}),
              ("response.output_text.delta", {"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": answer}),
              ("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": item}),
              ("response.completed", {"type": "response.completed", "response": resp})]
        self._out(200, "".join(f"event: {k}\ndata: {json.dumps(d)}\n\n" for k, d in ev).encode(), "text/event-stream")


def thread_id(output):
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "thread.started":
            return event.get("thread_id")
    return None


def request_kind(body):
    for value in (body.get("client_metadata") or {}).values():
        try:
            meta = json.loads(value) if isinstance(value, str) else value
        except ValueError:
            continue
        if isinstance(meta, dict) and meta.get("request_kind"):
            return meta["request_kind"]
    return "compaction" if "CONTEXT CHECKPOINT COMPACTION" in texts(body).upper() else "model"


def self_test():
    with tempfile.TemporaryDirectory() as temp:
        root = pathlib.Path(temp)
        for relative in ("personal/SKILL.md", ".system/keep/SKILL.md", "space's skill/SKILL.md"):
            file = root / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b"fixture")
        files = P.disabled_skills([root, root])
        assert len(files) == 2 and all(".system" not in p for p in files)
        args = P.disable_skill_args(files)
        assert args[0] == "-c" and "enabled=false" in args[1] and "include_instructions" not in args[1]
        import tomllib
        assert len(tomllib.loads(args[1])["skills"]["config"]) == 2
        overlap = subprocess.run([sys.executable, P.__file__, "--out", str(root), "--codex-home-from", str(root)], capture_output=True, text=True)
        assert overlap.returncode == 2 and "outside the prepared source home" in overlap.stderr
    assert thread_id('{"type":"thread.started","thread_id":"exact-id"}\n') == "exact-id"
    assert thread_id("not JSON\n") is None
    assert request_kind({"client_metadata": {"trace": '{"request_kind":"compaction"}'}}) == "compaction"
    assert request_kind({"input": [{"text": "You are performing a CONTEXT CHECKPOINT COMPACTION."}]}) == "compaction"
    assert request_kind({"input": [{"text": ORIGINAL}]}) == "model"
    assert texts({"input": [{"text": ORIGINAL}]}) == ORIGINAL
    print("Codex continuity probe self-test: 10 checks passed")


def record_hooks(root, home):
    """A second, no-output observer in this private diagnostic home; original hooks stay intact."""
    observer, output = root / "record-hook.mjs", root / "hook-payloads.jsonl"
    observer.write_bytes(b"import fs from 'node:fs';\nlet s='';for await(const c of process.stdin)s+=c;\nfs.appendFileSync(process.argv[2],JSON.stringify({event:process.argv[3],payload:JSON.parse(s)})+'\\n');\n")
    file = home / "hooks.json"
    doc = json.loads(file.read_text(encoding="utf-8"))
    for event in ("SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"):
        command = f'node "{observer.as_posix()}" "{output.as_posix()}" "{event}"'
        doc["hooks"].setdefault(event, []).append({"hooks": [{"type": "command", "command": command, "timeout": 3}]})
    file.write_text(json.dumps(doc, indent=2), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    ap.add_argument("--codex", default=P.CODEX)
    ap.add_argument("--atlias-source", help="install Codex hooks/MCP/AGENTS into this probe's private home")
    ap.add_argument("--disable-skill-root", action="append", default=[])
    ap.add_argument("--bypass-hook-trust", action="store_true")
    ap.add_argument("--compact", action="store_true", help="force a low native auto-compaction threshold on the third turn")
    ap.add_argument("--record-hooks", action="store_true", help="record native payloads in the isolated Atlias home without changing original hooks")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    if not a.out:
        ap.error("--out is required unless --self-test")
    root = pathlib.Path(a.out).resolve()
    ws, home = root / "workspace", root / "codex-home"
    ws.mkdir(parents=True, exist_ok=True)
    home.mkdir(parents=True, exist_ok=True)
    (ws / "AGENTS.md").write_bytes(PROJECT.encode("utf-8"))
    skill = ws / ".agents" / "skills" / "continuity-probe" / "SKILL.md"
    skill.parent.mkdir(parents=True, exist_ok=True)
    skill.write_bytes(SKILL.encode("utf-8"))
    Continuity.seen = []
    fake = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Continuity)
    threading.Thread(target=fake.serve_forever, daemon=True).start()
    door = B.Door(f"http://127.0.0.1:{fake.server_address[1]}", "qwen3.5:9b", 2048, 20)
    threading.Thread(target=door.serve_forever, daemon=True).start()
    env = B.offline_env(str(root / "state"), door, str(root / "shims"))
    env.update({"CODEX_HOME": str(home), "ATLIAS_HOME": str(root / "atlias-home"),
                "CLAUDE_CONFIG_DIR": str(root / "claude-profile"), "PWD": str(ws)})
    base = f"http://127.0.0.1:{fake.server_address[1]}/v1"
    files = P.disabled_skills(a.disable_skill_root)
    common = ["--ignore-rules", "--strict-config", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox",
              *(["--dangerously-bypass-hook-trust"] if a.bypass_hook_trust else []), *P.provider_args(base), *P.disable_skill_args(files)]
    stages, install = [], None
    try:
        if a.atlias_source:
            uri = (pathlib.Path(a.atlias_source).resolve() / "lib" / "hosts.mjs").as_uri()
            code = "const h=await import(" + json.dumps(uri) + "); console.log(JSON.stringify(h.installCodex()));"
            with (root / "install-output.txt").open("wb") as out:
                rc, stop = B.run_harness(["node", "--input-type=module", "-e", code], cwd=str(ws), env=env, door=door,
                                        start_limit=30, task_limit=30, stdout=out)
            install = {"exit": rc, "stop": stop}
            if rc != 0:
                raise RuntimeError("isolated Atlias install failed; inspect install-output.txt")
            state = root / "atlias-home"
            state.mkdir(parents=True, exist_ok=True)
            (state / "config.json").write_text(json.dumps({"flags": {"authorityLedger": True}}), encoding="utf-8")
            if a.record_hooks:
                record_hooks(root, home)
        sid = None
        for phase, prompt in (("original", ORIGINAL), ("followup", FOLLOWUP), ("after-compact", AFTER_COMPACT)):
            if phase != "original" and not sid:
                break
            Continuity.phase = phase
            before = len(Continuity.seen)
            door.first = None
            if phase == "original":
                argv = [a.codex, "exec", *common, "-C", str(ws), "-"]
            else:
                extra = ["-c", "model_auto_compact_token_limit=50"] if phase == "after-compact" and a.compact else []
                argv = [a.codex, "exec", "resume", *common, *extra, sid, "-"]
            output = root / (phase + "-output.txt")
            with output.open("wb") as out:
                rc, stop = B.run_harness(argv, cwd=str(ws), env=env, door=door, start_limit=120, task_limit=120, stdout=out, stdin_text=prompt)
            sid = sid or thread_id(output.read_text(encoding="utf-8", errors="replace"))
            calls = [c for c in Continuity.seen[before:] if c["method"] == "POST" and c["path"].split("?")[0].rstrip("/").endswith("/responses")]
            entries = [{"path": c["path"], "kind": request_kind(c["body"]), "originalExact": ORIGINAL in texts(c["body"]), "followupExact": FOLLOWUP in texts(c["body"]),
                        "currentExact": prompt in texts(c["body"]), "projectExact": PROJECT.rstrip("\n") in texts(c["body"]),
                        "skillExact": SKILL in texts(c["body"]), "skillBodyExact": SKILL.split("---\n", 2)[2] in texts(c["body"]),
                        "atliasBrief": "sub-harness linked to Codex" in texts(c["body"]), "atliasInstructions": "atlias sub-harness" in texts(c["body"]),
                        "chars": len(json.dumps(c["body"], ensure_ascii=False))} for c in calls]
            stages.append({"phase": phase, "exit": rc, "stop": stop, "argv": argv[1:], "requests": entries})
        (root / "requests.json").write_text(json.dumps(Continuity.seen, indent=1, ensure_ascii=False), encoding="utf-8")
        summary = {"inference": False, "fixtureUsageOnly": True, "codexSha256": hashlib.sha256(pathlib.Path(a.codex).read_bytes()).hexdigest(),
                   "source": a.atlias_source, "install": install, "threadId": sid, "disabledSkillFiles": files,
                   "bypassHookTrust": a.bypass_hook_trust, "forcedCompaction": a.compact, "refused": door.refused, "stages": stages}
        working = [r for s in stages for r in s["requests"] if r["kind"] != "compaction"]
        last = stages[-1]["requests"][-1] if stages and stages[-1]["requests"] else {}
        summary["checks"] = {"allThreeNativeExitsZero": len(stages) == 3 and all(s["exit"] == 0 for s in stages),
                             "originalPreservedInEveryWorkingRequest": bool(working) and all(r["originalExact"] for r in working),
                             "currentPreservedInEveryWorkingRequest": bool(working) and all(r["currentExact"] for r in working),
                             "projectPreservedInEveryWorkingRequest": bool(working) and all(r["projectExact"] for r in working),
                             "compactionActuallyRecorded": any(r["kind"] == "compaction" for s in stages for r in s["requests"]),
                             "selectedSkillPresentAfterLastTurn": last.get("skillExact", False)}
        (root / "summary.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding="utf-8")
        brief = {k: v for k, v in summary.items() if k not in {"disabledSkillFiles", "stages"}}
        brief["disabledSkillCount"] = len(files)
        brief["stages"] = [{k: v for k, v in s.items() if k != "argv"} for s in stages]
        print(json.dumps(brief, indent=1, ensure_ascii=True))
    finally:
        door.shutdown()
        door.server_close()
        fake.shutdown()
        fake.server_close()


if __name__ == "__main__":
    main()
