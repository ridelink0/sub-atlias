"""Offline cost-completeness contracts; no client, network or inference."""
import copy
import sys
from types import SimpleNamespace
import base_harness_runner as runner

results = []
def check(name, condition):
    results.append((name, bool(condition)))

def fixture():
    return SimpleNamespace(errors=[], partial=0, usage=[(100, 12), (150, 8)],
        receipts=[{"slot": 0, "outcome": "complete"}, {"slot": 1, "outcome": "complete"}], calls=2, capped=0)

door = fixture()
check("normal terminal spend is complete", runner.measured_complete(0, "", door))
door.capped = 1; door.calls = 3
door.receipts.append({"slot": None, "outcome": "capped: answered by the door, no model call"})
check("an explicitly unsent budget stop has complete measurement", runner.measured_complete(0, "", door))
door.receipts[1]["cut"] = True
check("a terminal output cap can be counted while native completion remains separate", runner.measured_complete(0, "", door) and runner.ended_cut(door.receipts))
for name, edit in [
    ("unknown tokens", lambda d: d.usage.__setitem__(1, None)),
    ("negative tokens", lambda d: d.usage.__setitem__(1, (150, -1))),
    ("boolean tokens", lambda d: d.usage.__setitem__(1, (True, 8))),
    ("missing terminal", lambda d: d.receipts[1].update(outcome="sent")),
    ("missing receipt", lambda d: d.receipts.pop(1)),
    ("duplicate slot", lambda d: d.receipts[1].update(slot=0)),
    ("invalid slot", lambda d: d.receipts[1].update(slot=True)),
    ("provider error", lambda d: d.errors.append("synthetic failure")),
    ("partial stream", lambda d: setattr(d, "partial", 1)),
    ("unreceipted synthetic cap", lambda d: setattr(d, "capped", 2)),
    ("unreceipted request", lambda d: setattr(d, "calls", 4)),
]:
    bad = copy.deepcopy(door); edit(bad)
    check(name + " cannot qualify complete measurement", not runner.measured_complete(0, "", bad))
check("a failed native process is not complete measurement", not runner.measured_complete(1, "", door))
check("a timed-out native process is not complete measurement", not runner.measured_complete(0, "task timed out", door))
empty = fixture(); empty.usage=[]; empty.receipts=[]; empty.calls=0
check("zero model calls do not qualify a native measurement", not runner.measured_complete(0, "", empty))
for name, passed in results:
    print(("ok   " if passed else "FAIL ") + name)
print(f"{sum(passed for _, passed in results)}/{len(results)}")
sys.exit(0 if all(passed for _, passed in results) else 1)
