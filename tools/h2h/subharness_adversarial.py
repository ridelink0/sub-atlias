"""Planted regressions in an isolated worktree; restores every source in finally."""
import json
import pathlib
import sys
import tempfile
from owned_process import run_tree

root = pathlib.Path(__file__).resolve().parents[2]
cases = [
    ("long requests cut", "lib/loop.mjs", "if (exact) return `", "if (false) return `"),
    ("instruction tail cut", "lib/loop.mjs", "!exact && text.length > room", "text.length > room"),
    ("repeated authority erased", "lib/loop.mjs", "if (exact) {\n    // Only the retained", "if (false) {\n    // Only the retained"),
    ("off mode changes placement", "mods/atlias-efficiency/hooks/register.mjs", "if (!enabled || !compatible", "if (!compatible"),
    ("moved tools not named", "mods/atlias-efficiency/hooks/register.mjs", "return { ...result, description: result.description + NOTE };", "return result;"),
    ("note replaces ToolSearch text", "mods/atlias-efficiency/hooks/register.mjs", "description: result.description + NOTE", "description: NOTE"),
]
rows = []
for name, rel, old, new in cases:
    p = root / rel
    before = p.read_bytes()
    try:
        text = before.decode("utf-8").replace("\r\n", "\n")
        if text.count(old) != 1:
            raise RuntimeError(f"mutation anchor not unique: {name}")
        p.write_bytes(text.replace(old, new, 1).encode("utf-8"))
        with tempfile.TemporaryFile() as out:
            rc, timed = run_tree(["node", "test/run.mjs", "authority:", "efficiency:"], cwd=str(root), timeout=180, stdout=out)
            out.seek(0)
            result = out.read().decode("utf-8", errors="replace")
        caught = rc != 0 and not timed and "FAIL " in result
        rows.append({"name": name, "caught": caught, "exit": rc, "timeout": timed})
        print(f"{'PASS' if caught else 'FAIL'} planted break: {name}", flush=True)
    finally:
        p.write_bytes(before)

with tempfile.TemporaryFile() as out:
    rc, timed = run_tree(["node", "test/run.mjs", "authority:", "efficiency:"], cwd=str(root), timeout=180, stdout=out)
    out.seek(0)
    text = out.read().decode("utf-8", errors="replace")
print(text, flush=True)
receipt = {"mutations": rows, "restoredFunctionalExit": rc, "restoredFunctionalTimeout": timed}
target = root / "test" / "subharness-adversarial-receipt.json"
target.write_bytes(json.dumps(receipt, indent=2).encode("utf-8"))
if not all(r["caught"] for r in rows) or rc != 0 or timed:
    sys.exit(1)
