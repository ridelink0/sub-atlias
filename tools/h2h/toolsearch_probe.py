"""Native ToolSearch selection and deferred-tool dispatch, against a scripted recording stand-in.

No inference: the stand-in answers in Claude's wire format with a fixed script (search, then call
the found tool, then answer), and records every request Claude Code sends. Four arms run the same
workspace, prompt and script: base (no plugin), off (atlias-efficiency loaded, switch off), ts
(ENABLE_TOOL_SEARCH=true, no mod) and on (mod on plus ENABLE_TOOL_SEARCH=true). What it settles:
whether the original request, the project instruction file and an explicitly invoked skill reach
every request; whether a deferred tool's schema comes back whole and identical to the base arm's;
whether the found tool really runs; whether the off arm sends what the base arm sends; and
whether the client needs tool_reference blocks from the endpoint. RESEARCH-FIRST 0f, 0d; the
subharness efficiency report's Claude Mods section."""
import argparse
import hashlib
import http.server
import json
import pathlib
import re
import threading

import base_harness_runner as B

CLAUDE = "C:/Users/OWNER/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
ASK = "ORIGINAL_REQUEST_SENTINEL_1012: find which file holds GREP_TARGET_SENTINEL_1012 and say its path. Do not edit anything."
PROMPT = "/probe-skill " + ASK
INSTRUCTION = "PROJECT_INSTRUCTION_SENTINEL_1012: answer in one line."
SKILL_BODY = "SKILL_BODY_SENTINEL_1012: search before answering, and name the file you found."
SEARCH = "select:Grep,Glob,Skill,Agent,WebFetch"
GREP = {"pattern": "GREP_TARGET_SENTINEL_1012", "output_mode": "files_with_matches"}


def texts(c):
    if isinstance(c, str):
        return [c]
    out = []
    for b in c or []:
        if isinstance(b, dict):
            if isinstance(b.get("text"), str):
                out.append(b["text"])
            if b.get("type") == "tool_result":
                out += texts(b.get("content"))
    return out


def results(req):
    """Every tool_result in the request, in order: (tool_use_id, block types, joined text)."""
    out = []
    for m in req.get("messages", []):
        if m.get("role") != "user" or not isinstance(m.get("content"), list):
            continue
        for b in m["content"]:
            if isinstance(b, dict) and b.get("type") == "tool_result":
                c = b.get("content")
                kinds = ["text"] if isinstance(c, str) else [x.get("type") for x in c or [] if isinstance(x, dict)]
                out.append((b.get("tool_use_id"), kinds, "\n".join(texts(c))))
    return out


class Script(http.server.BaseHTTPRequestHandler):
    """One scripted conversation; any request that is not it is answered with plain text."""
    protocol_version = "HTTP/1.0"
    steps, seen, lock = [], [], threading.Lock()

    def log_message(self, *_):
        pass

    def _out(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._out(200, json.dumps({"object": "list", "data": [{"id": "qwen3.5:9b"}]}).encode())

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        route = self.path.split("?")[0].rstrip("/")
        if route.endswith("/count_tokens"):
            return self._out(200, b'{"input_tokens": 5}')
        main = bool(req.get("tools")) and any(ASK in t for m in req.get("messages", []) for t in texts(m.get("content")))
        step = len(results(req)) if main else None
        act = self.steps[min(step, len(self.steps) - 1)] if main else ("text", "ok")
        with self.lock:
            n = len(self.seen)
            self.seen.append({"path": route, "main": main, "step": step, "reply": act, "request": req})
        if act[0] == "tool":
            block = {"type": "tool_use", "id": f"toolu_probe_{n}", "name": act[1], "input": {}}
            deltas = [{"type": "input_json_delta", "partial_json": json.dumps(act[2])}]
            stop = "tool_use"
        else:
            block, deltas, stop = {"type": "text", "text": ""}, [{"type": "text_delta", "text": act[1]}], "end_turn"
        ev = [("message_start", {"type": "message_start", "message": {"id": f"msg_probe_{n}", "type": "message", "role": "assistant", "model": req.get("model"),
                                                                       "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 100, "output_tokens": 1}}}),
              ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": block}),
              *[("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": d}) for d in deltas],
              ("content_block_stop", {"type": "content_block_stop", "index": 0}),
              ("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 9}}),
              ("message_stop", {"type": "message_stop"})]
        self._out(200, "".join(f"event: {k}\ndata: {json.dumps(d)}\n\n" for k, d in ev).encode(), "text/event-stream")


def workspace(ws):
    (ws / "notes").mkdir(parents=True, exist_ok=True)
    (ws / "notes" / "target.txt").write_text("GREP_TARGET_SENTINEL_1012\n", encoding="utf-8")
    (ws / "CLAUDE.md").write_text(INSTRUCTION + "\n", encoding="utf-8")
    sk = ws / ".claude" / "skills" / "probe-skill"
    sk.mkdir(parents=True, exist_ok=True)
    (sk / "SKILL.md").write_text("---\nname: probe-skill\ndescription: Probe skill for the ToolSearch qualification.\n---\n\n" + SKILL_BODY + "\n", encoding="utf-8")


def run_arm(root, name, plugin, settings, tool_search):
    arm = root / name
    ws = arm / "workspace"
    workspace(ws)
    Script.steps = ([("tool", "ToolSearch", {"query": SEARCH, "max_results": 5})] if tool_search else []) + [("tool", "Grep", GREP), ("text", "notes/target.txt")]
    Script.seen = []
    fake = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Script)
    threading.Thread(target=fake.serve_forever, daemon=True).start()
    door = B.Door(f"http://127.0.0.1:{fake.server_address[1]}", "qwen3.5:9b", 2048, 8)
    threading.Thread(target=door.serve_forever, daemon=True).start()
    try:
        env = B.offline_env(str(arm / "state"), door, str(arm / "shims"))
        if tool_search:
            env["ENABLE_TOOL_SEARCH"] = "true"
        opts = argparse.Namespace(model="qwen3.5:9b", num_predict=2048, claude=CLAUDE, claude_plugin_dir=[plugin] if plugin else [])
        argv, cwd, _ = B.claude_command(opts, {"prompt": PROMPT}, ws, str(arm / "state"), door, 8, env)
        if settings:
            argv += ["--settings", str(settings)]
        with open(arm / "native-output.txt", "wb") as out:
            rc, why = B.run_harness(argv, cwd=cwd, env=env, door=door, start_limit=120, task_limit=180, stdout=out)
    finally:
        door.shutdown()
        door.server_close()
        fake.shutdown()
        fake.server_close()
    seen = list(Script.seen)
    (arm / "requests.json").write_bytes(json.dumps(seen, indent=1, ensure_ascii=False).encode("utf-8"))
    return {"exit": rc, "stop": why, "doorCalls": door.calls, "doorErrors": door.errors, "seen": seen, "ws": str(ws), "arm": str(arm)}


def h(x):
    return hashlib.sha256(json.dumps(x, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


def functions(text):
    out = {}
    for m in re.finditer(r"<function>(\{.*?\})</function>", text, re.S):
        try:
            f = json.loads(m.group(1))
            out[f.get("name")] = f
        except ValueError:
            out.setdefault("_unparsed", []).append(m.group(1)[:200])
    return out


def analyse(r, base_tools):
    main = [s for s in r["seen"] if s["main"]]
    reqs = [s["request"] for s in main]
    def has(req, needle):
        return needle in json.dumps(req, ensure_ascii=False)
    out = {"exit": r["exit"], "stop": r["stop"], "doorCalls": r["doorCalls"], "doorErrors": r["doorErrors"],
           "requests": len(r["seen"]), "mainRequests": len(main), "auxRequests": len(r["seen"]) - len(main),
           "askExactEveryRequest": bool(reqs) and all(has(q, ASK) for q in reqs),
           "instructionEveryRequest": bool(reqs) and all(has(q, INSTRUCTION) for q in reqs),
           "skillBodyEveryRequest": bool(reqs) and all(has(q, SKILL_BODY) for q in reqs),
           "toolReferenceBlocks": any(has(q, '"tool_reference"') for q in reqs),
           "perRequest": []}
    for s in main:
        q = s["request"]
        out["perRequest"].append({"step": s["step"], "reply": s["reply"][:2], "tools": [t.get("name") for t in q.get("tools", [])],
                                  "deferLoading": [t.get("name") for t in q.get("tools", []) if t.get("defer_loading")],
                                  "toolResults": [(i, k, t[:300]) for i, k, t in results(q)]})
    found, ran = {}, None
    for s in main:
        for i, kinds, t in results(s["request"]):
            fs = functions(t)
            if fs:
                found.update(fs)
            if "notes" in t and "target.txt" in t:
                ran = t[:300]
    out["grepRanWithRealResult"] = ran
    ident = {}
    for name, f in found.items():
        if name == "_unparsed":
            ident[name] = f
            continue
        b = base_tools.get(name)
        ident[name] = None if b is None else {"descriptionIdentical": f.get("description") == b.get("description"),
                                               "schemaIdentical": f.get("parameters") == b.get("input_schema"),
                                               "foundHash": h({"d": f.get("description"), "s": f.get("parameters")}),
                                               "baseHash": h({"d": b.get("description"), "s": b.get("input_schema")})}
    out["discovered"] = ident
    # A deferred tool comes back as tool_reference blocks; the client then sends its whole definition
    # with defer_loading set. It must be the base arm's definition, byte for byte, apart from that flag.
    defs = {}
    for q in reqs[1:]:
        for t in q.get("tools", []):
            b = base_tools.get(t.get("name"))
            if t.get("defer_loading") and b is not None:
                defs[t["name"]] = {k: v for k, v in t.items() if k != "defer_loading"} == {k: v for k, v in b.items() if k != "defer_loading"}
    out["deferredDefinitionsIdentical"] = defs
    first = "\n".join(texts(reqs[0].get("system")) + [t for m in reqs[0].get("messages", []) for t in texts(m.get("content"))]) if reqs else ""
    listing = re.search(r"deferred tools are now available via ToolSearch.*?:\n((?:[A-Za-z]+\n)+)", first)
    announced = listing.group(1).split("\n")[:-1] if listing else []
    sent = {t.get("name") for t in reqs[0].get("tools", [])} if reqs else set()
    search = next((t.get("description", "") for t in (reqs[0].get("tools", []) if reqs else []) if t.get("name") == "ToolSearch"), "")
    note = re.search(r"Also deferred, by the atlias-efficiency mod;.*?calling it: (.*)$", search)
    out["announcedByMod"] = note.group(1).split(", ") if note else []
    announced = announced + out["announcedByMod"]
    out["toolSearchDescription"] = search
    out["announcedDeferred"] = announced
    # A base tool the model can neither call nor see named in the deferred listing is lost to it.
    out["hiddenTools"] = sorted(n for n in base_tools if n not in sent and n not in announced)
    return out


def normal(req, arm):
    """The request with what differs between two runs of the same arm taken out: the session id
    and the arm's own folder."""
    q = {k: v for k, v in req.items() if k != "metadata"}
    s = json.dumps(q, ensure_ascii=False)
    slug = re.sub(r"[^A-Za-z0-9]", "-", arm)  # the profile's per-project folder name
    for p in (arm, arm.replace("/", "\\"), json.dumps(arm)[1:-1], json.dumps(arm.replace("/", "\\"))[1:-1], slug):
        s = s.replace(p, "<ARM>")
    return re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "<UUID>", s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--plugin", required=True, help="the atlias-efficiency folder")
    ap.add_argument("--enabled-settings", required=True)
    ap.add_argument("--reuse", action="store_true")
    a = ap.parse_args()
    root = pathlib.Path(a.out).resolve()
    root.mkdir(parents=True, exist_ok=True)
    plugin = str(pathlib.Path(a.plugin).resolve())
    arms = {"base": (None, None, False), "off": (plugin, None, False), "ts": (None, None, True),
            "on": (plugin, str(pathlib.Path(a.enabled_settings).resolve()), True)}
    if a.reuse:  # analyse the requests a finished run recorded, without running Claude Code again
        raw = {n: {"exit": None, "stop": "reused", "doorCalls": None, "doorErrors": None, "arm": str(root / n),
                   "seen": json.loads((root / n / "requests.json").read_text(encoding="utf-8"))} for n in arms}
    else:
        raw = {n: run_arm(root, n, *spec) for n, spec in arms.items()}
    first = next((s["request"] for s in raw["base"]["seen"] if s["main"]), {})
    base_tools = {t["name"]: t for t in first.get("tools", [])}
    summary = {"inference": False, "claude": CLAUDE, "prompt": PROMPT, "arms": {n: analyse(r, base_tools) for n, r in raw.items()}}
    ts, on = summary["arms"]["ts"].pop("toolSearchDescription"), summary["arms"]["on"].pop("toolSearchDescription")
    for n in ("base", "off"):
        summary["arms"][n].pop("toolSearchDescription")
    # The mod may only add to ToolSearch's description; the engine's own text stays whole.
    summary["toolSearchOriginalKept"] = bool(ts) and on.startswith(ts)
    summary["toolSearchAdded"] = on[len(ts):] if ts and on.startswith(ts) else None
    bm = [normal(s["request"], raw["base"]["arm"]) for s in raw["base"]["seen"] if s["main"]]
    om = [normal(s["request"], raw["off"]["arm"]) for s in raw["off"]["seen"] if s["main"]]
    summary["offEqualsBase"] = {"sameCount": len(bm) == len(om), "identical": [x == y for x, y in zip(bm, om)],
                                "toolsIdentical": [h(x.get("tools")) == h(y.get("tools")) for x, y in
                                                   zip((s["request"] for s in raw["base"]["seen"] if s["main"]), (s["request"] for s in raw["off"]["seen"] if s["main"]))]}
    if bm and om and bm[0] != om[0]:
        i = next((k for k in range(min(len(bm[0]), len(om[0]))) if bm[0][k] != om[0][k]), min(len(bm[0]), len(om[0])))
        summary["offEqualsBase"]["firstDifference"] = {"at": i, "base": bm[0][max(0, i - 120):i + 200], "off": om[0][max(0, i - 120):i + 200]}
    (root / "summary.json").write_bytes(json.dumps(summary, indent=1, ensure_ascii=False).encode("utf-8"))
    print(json.dumps(summary, indent=1, ensure_ascii=True)[:12000])


if __name__ == "__main__":
    main()
