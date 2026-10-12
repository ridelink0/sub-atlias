"""Planted regressions in an isolated worktree; restores every source in finally."""
import json
import pathlib
import sys
import tempfile
from owned_process import run_tree

root = pathlib.Path(__file__).resolve().parents[2]
NODE = ["node", "test/run.mjs", "authority:", "efficiency:"]
LEDGER = [sys.executable, "tools/h2h/base_harness_accounting_test.py"]
RUNNER = "tools/h2h/base_harness_runner.py"
RESP = [sys.executable, "tools/h2h/base_harness_responses_test.py"]
cases = [
    ("long requests cut", "lib/loop.mjs", "if (exact) return `", "if (false) return `"),
    ("instruction tail cut", "lib/loop.mjs", "!exact && text.length > room", "text.length > room"),
    ("repeated authority erased", "lib/loop.mjs", "if (exact) {\n    // Only the retained", "if (false) {\n    // Only the retained"),
    ("off mode changes placement", "mods/atlias-efficiency/hooks/register.mjs", "if (!enabled || !compatible", "if (!compatible"),
    ("moved tools not named", "mods/atlias-efficiency/hooks/register.mjs", "return { ...result, description: result.description + NOTE };", "return result;"),
    ("note replaces ToolSearch text", "mods/atlias-efficiency/hooks/register.mjs", "description: result.description + NOTE", "description: NOTE"),
    ("malformed cache count read as 0", RUNNER, 'got[name] = _count(u[key]) if _count(u[key]) is not None else "unknown"', "got[name] = _count(u[key]) or 0", LEDGER),
    ("missing window counted as matched", RUNNER, '"windowMatched": all(r.get("loadedWindow") == a.num_ctx for r in results) if results else None,', '"windowMatched": windows == [a.num_ctx] if windows else None,', LEDGER),
    ("row marked uncounted trusted", RUNNER, 'return r.get("usageComplete") is not False and _count', "return _count", LEDGER),
    ("partial stream taken as complete", RUNNER, 'ended = ended or ev.get("type") == "message_stop"', "ended = True", LEDGER),
    ("resume drops uncounted rows", RUNNER, 'return list(json.loads(pathlib.Path(out).read_text(encoding="utf-8")).get("results", []))', 'return [r for r in json.loads(pathlib.Path(out).read_text(encoding="utf-8")).get("results", []) if isinstance(r.get("promptTotal"), int)]', LEDGER),
    ("responses count taken unchecked", RUNNER, 'p, c = _count(u.get("input_tokens")), _count(u.get("output_tokens"))', 'p, c = u.get("input_tokens"), u.get("output_tokens")', RESP),
    ("responses stream without end not partial", RUNNER, "if ended is None:", "if False:", RESP),
    ("previous_response_id let through", RUNNER, 'if body.get("previous_response_id"):', "if False:", RESP),
    ("unmetered responses path let through", RUNNER, 'if "/responses" in route:', "if False:", RESP),
    ("instructions dropped on the way", RUNNER, 'body["max_output_tokens"] = s.num_predict', 'body["max_output_tokens"] = s.num_predict; body.pop("instructions", None)', RESP),
    ("native skill capability removed", RUNNER, 'argv += ["-"]', 'argv += ["-c", "skills.include_instructions=false", "-"]', RESP),
    ("real skills root leaks into Codex", RUNNER, 'if skill_file:', 'if False:', RESP),
    ("capped call leaves no receipt", RUNNER, 's.receipts.append({"api": "messages", "stream": stream, "slot": None, "outcome": "capped: answered by the door, no model call"})', "pass", LEDGER),
]
rows = []
for name, rel, old, new, *cmd in cases:
    p = root / rel
    before = p.read_bytes()
    try:
        text = before.decode("utf-8").replace("\r\n", "\n")
        if text.count(old) != 1:
            raise RuntimeError(f"mutation anchor not unique: {name}")
        p.write_bytes(text.replace(old, new, 1).encode("utf-8"))
        with tempfile.TemporaryFile() as out:
            rc, timed = run_tree(cmd[0] if cmd else NODE, cwd=str(root), timeout=180, stdout=out)
            out.seek(0)
            result = out.read().decode("utf-8", errors="replace")
        caught = rc != 0 and not timed and "FAIL " in result
        rows.append({"name": name, "caught": caught, "exit": rc, "timeout": timed})
        print(f"{'PASS' if caught else 'FAIL'} planted break: {name}", flush=True)
    finally:
        p.write_bytes(before)

restored = []
for cmd in (NODE, LEDGER, RESP):
    with tempfile.TemporaryFile() as out:
        rc, timed = run_tree(cmd, cwd=str(root), timeout=180, stdout=out)
        out.seek(0)
        print(out.read().decode("utf-8", errors="replace")[-400:], flush=True)
    restored.append((rc, timed))
rc = max(abs(r) for r, _ in restored)
timed = any(t for _, t in restored)
receipt = {"mutations": rows, "restoredFunctionalExit": rc, "restoredFunctionalTimeout": timed}
target = root / "test" / "subharness-adversarial-receipt.json"
target.write_bytes(json.dumps(receipt, indent=2).encode("utf-8"))
if not all(r["caught"] for r in rows) or rc != 0 or timed:
    sys.exit(1)
