"""Resumable, same-model native subharness trials for Gev.

Research basis: RESEARCH-FIRST 0f, H6/H7, sections 1 and 7. This controller
does not modify the regular evolve loop, choose code changes, or promote them.
Run ``selftest`` before preparing a measurement manifest. No model is called
by prepare, status, report, or selftest.
"""
import argparse
import contextlib
import copy
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import types
import urllib.parse
import uuid

SCHEMA = 1
SKIP = {".git", "node_modules", "__pycache__", ".pytest_cache"}
STOP_REQUESTED = False


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


def read(path):
    return json.loads(pathlib.Path(path).read_text(encoding="utf-8-sig"))


def write(path, value):
    """Replace a journal atomically; an interrupted write cannot erase evidence."""
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def tree(root):
    root = pathlib.Path(root)
    if not root.is_dir():
        raise ValueError(f"missing directory: {root}")
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob("*")) if p.is_file()
            and not SKIP.intersection(p.relative_to(root).parts)}


def positive(value, name):
    if type(value) is not int or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def count(value):
    return value if type(value) is int and value >= 0 else None


def relpath(value):
    p = pathlib.PurePosixPath(str(value).replace("\\", "/"))
    if p.is_absolute() or not p.parts or ".." in p.parts or ":" in str(p):
        raise ValueError(f"unsafe relative path: {value}")
    return p.as_posix()


def validate(spec):
    source = pathlib.Path(spec["source"]).resolve()
    if not (source / ".claude-plugin/plugin.json").is_file():
        raise ValueError("source must contain the full Atlias plugin")
    if not (source / "tools/h2h/base_harness_runner.py").is_file():
        raise ValueError("source must contain the existing native runner")
    endpoint = urllib.parse.urlparse(spec.get("apiBase", "http://127.0.0.1:11435"))
    if endpoint.scheme != "http" or endpoint.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("the local measurement controller only permits a loopback model server")
    if not isinstance(spec.get("model"), str) or not spec["model"].strip():
        raise ValueError("model is required")
    if not isinstance(spec.get("candidate"), str) or not re.fullmatch(r"[A-Za-z0-9_-]+", spec["candidate"]):
        raise ValueError("candidate must be a simple label")
    positive(spec.get("continuationMinimum", 20), "continuationMinimum")
    hosts = spec.get("hosts")
    if not isinstance(hosts, list) or not hosts or [h.get("host") for h in hosts] not in (["claude"], ["codex"], ["claude", "codex"]):
        # Codex alone is allowed: a candidate that changes only what Codex is sent (no MCP
        # server, a shorter instruction block) has nothing new to measure on Claude.
        raise ValueError("hosts must be Claude, Codex, or Claude followed by Codex")
    for h in hosts:
        positive(h["numCtx"], "numCtx")
        positive(h.get("numPredict", 2048), "numPredict")
        for key in ("budget", "taskTimeout", "startTimeout"):
            if key in h:
                positive(h[key], key)
        if not pathlib.Path(h["client"]).is_file():
            raise ValueError(f"missing {h['host']} client")
        if h["host"] == "codex" and not h.get("codexHomeFrom"):
            raise ValueError("enhanced Codex needs a prepared isolated Atlias CODEX_HOME")
    for mod in spec.get("claudeMods", []):
        if not (source / relpath(mod) / ".claude-plugin/plugin.json").is_file():
            raise ValueError("selected Claude mod is missing")
    search = spec.get("toolSearch", False)
    if type(search) is not bool and (not isinstance(search, dict) or set(search) != {"base", "atlias"} or any(type(v) is not bool for v in search.values())):
        raise ValueError("toolSearch must be a boolean or explicit base/atlias booleans")
    stages = spec.get("stages")
    if not isinstance(stages, list) or [s.get("name") for s in stages] not in (["smoke", "screen", "confirmation"], ["smoke", "screen", "confirmation", "ultimate"]):
        raise ValueError("declare smoke, screen, confirmation, and optional ultimate stages before testing")
    for stage in stages:
        ids = stage.get("ids")
        if not isinstance(ids, list) or not ids or any(not isinstance(i, str) or not i for i in ids) or len(ids) != len(set(ids)):
            raise ValueError("each stage needs unique explicit task IDs")
        positive(stage.get("repeats", 1), "repeats")
        if stage["name"] != "smoke" and stage.get("repeats", 1) < 2:
            raise ValueError("screen and confirmation must each be repeated")
    if set(stages[1]["ids"]) & set(stages[2]["ids"]):
        raise ValueError("confirmation IDs must be disjoint from the screen")
    checks = spec.get("checks")
    if not isinstance(checks, list) or not checks or any(not isinstance(c, list) or not c or not all(isinstance(x, str) for x in c) for c in checks):
        raise ValueError("checks must be explicit argument arrays, run without a shell")
    if not any("test/run.mjs" in c for c in checks):
        raise ValueError("candidate preflight must retain the repository's full functional suite")
    if not any("tools/h2h/subharness_adversarial.py" in c for c in checks):
        raise ValueError("candidate preflight must retain the planted regression suite")
    return spec


def prepare(spec_file, root):
    spec = validate(read(spec_file))
    root = pathlib.Path(root).resolve()
    if (root / "MANIFEST.json").exists():
        raise ValueError("manifest exists; use a new trial directory for a changed candidate")
    source = pathlib.Path(spec["source"]).resolve()
    if root == source or source in root.parents:
        raise ValueError("trial directory must be outside the source tree")
    root.mkdir(parents=True, exist_ok=True)
    snapshot = root / "source"
    if snapshot.exists():
        raise ValueError("source snapshot already exists; unfinished preparation needs a new directory")
    shutil.copytree(source, snapshot, ignore=shutil.ignore_patterns(*SKIP))
    tasks = {}
    for folder in spec["tasks"]:
        for path in sorted(pathlib.Path(folder).glob("*.json")):
            task = read(path)
            task_id = task.get("id")
            if not isinstance(task_id, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", task_id) or task_id in tasks:
                raise ValueError(f"duplicate or missing task ID: {path}")
            for mapping in (task.get("files", {}), task.get("hidden", {})):
                for name in mapping:
                    relpath(name)
            for name in task.get("protect", []):
                relpath(name)
            tasks[task_id] = task
    ids = {i for stage in spec["stages"] for i in stage["ids"]}
    missing = ids - tasks.keys()
    if missing:
        raise ValueError("declared IDs not found: " + ", ".join(sorted(missing)))
    task_file = root / "TASKS.json"
    write(task_file, {i: tasks[i] for i in sorted(ids)})
    homes = {}
    for h in spec["hosts"]:
        if h["host"] == "codex":
            origin = pathlib.Path(h["codexHomeFrom"]).resolve()
            if (origin / "auth.json").exists():
                raise ValueError("prepared benchmark home must contain no account credentials")
            target = root / "prepared-codex-home"
            shutil.copytree(origin, target, ignore=shutil.ignore_patterns(*SKIP))
            # installCodex writes absolute commands. Relocate only this known source
            # root, then freeze the resulting profile; it must never execute the
            # mutable worktree when the measured plugin is the snapshot.
            for path in target.rglob("*"):
                if path.is_file() and path.suffix in {".json", ".toml", ".md"}:
                    text = path.read_text(encoding="utf-8-sig")
                    forms = [(str(source), str(snapshot)),
                             (source.as_posix(), snapshot.as_posix()),
                             (str(source).replace("\\", "\\\\"), str(snapshot).replace("\\", "\\\\"))]
                    for old, new in sorted(forms, key=lambda item: len(item[0]), reverse=True):
                        text = text.replace(old, new)
                    path.write_text(text, encoding="utf-8")
            homes["codex"] = tree(target)
    exclusions = spec.get("codexDisabledSkills")
    exclusion_hash = None
    if exclusions:
        exclusion_data = read(exclusions)
        files = exclusion_data.get("files") if isinstance(exclusion_data, dict) else exclusion_data
        if not isinstance(files, list) or any(not isinstance(f, str) for f in files):
            raise ValueError("invalid personal skill exclusion list")
        write(root / "CODEX-DISABLED-SKILLS.json", {"files": files})
        exclusion_hash = digest(read(root / "CODEX-DISABLED-SKILLS.json"))
    # Snapshot hashes are recorded after copying, so measurements never depend on a mutable worktree.
    manifest = {"schema": SCHEMA, "created": now(), "spec": spec, "sourceFiles": tree(snapshot),
                "taskHash": digest(read(task_file)), "preparedHomes": homes, "codexDisabledSkillsHash": exclusion_hash,
                "clientHashes": {h["host"]: hashlib.sha256(pathlib.Path(h["client"]).read_bytes()).hexdigest() for h in spec["hosts"]}}
    manifest["id"] = digest(manifest)
    write(root / "MANIFEST.json", manifest)
    write(root / "STATE.json", {"schema": SCHEMA, "manifest": manifest["id"], "phase": "prepared", "at": now()})
    return manifest


def verify(root):
    root = pathlib.Path(root)
    m = read(root / "MANIFEST.json")
    if m.get("schema") != SCHEMA or m.get("id") != digest({k: v for k, v in m.items() if k != "id"}):
        raise ValueError("manifest was modified")
    if tree(root / "source") != m["sourceFiles"]:
        raise ValueError("frozen source changed; preserve this run and prepare a new candidate")
    if digest(read(root / "TASKS.json")) != m["taskHash"]:
        raise ValueError("frozen tasks or graders changed")
    if m.get("codexDisabledSkillsHash") and digest(read(root / "CODEX-DISABLED-SKILLS.json")) != m["codexDisabledSkillsHash"]:
        raise ValueError("personal skill exclusion list changed")
    for host, files in m["preparedHomes"].items():
        if tree(root / f"prepared-{host}-home") != files:
            raise ValueError("prepared native profile changed")
    for h in m["spec"]["hosts"]:
        if hashlib.sha256(pathlib.Path(h["client"]).read_bytes()).hexdigest() != m["clientHashes"][h["host"]]:
            raise ValueError("native client changed")
    return m


def plan(manifest):
    """Qualify Claude then Codex smoke before their larger trials; balance AB/BA."""
    rows = []
    for smoke_phase in (True, False):
        for host in manifest["spec"]["hosts"]:
            for stage in manifest["spec"]["stages"]:
                if (stage["name"] == "smoke") != smoke_phase:
                    continue
                for repeat in range(stage.get("repeats", 1)):
                    for index, task_id in enumerate(stage["ids"]):
                        order = ["base", "atlias"] if (repeat + index) % 2 == 0 else ["atlias", "base"]
                        for arm in order:
                            key = digest([manifest["id"], host["host"], stage["name"], repeat, task_id, arm])[:24]
                            rows.append({"key": key, "host": host["host"], "stage": stage["name"],
                                         "repeat": repeat, "taskId": task_id, "arm": arm})
    return rows


def load_attempts(root, manifest):
    journal = pathlib.Path(root) / "ATTEMPTS.jsonl"
    if not journal.exists():
        return []
    rows = []
    valid_trials = {t["key"]: t for t in plan(manifest)}
    for index, line in enumerate(journal.read_text(encoding="utf-8").splitlines()):
        try:
            item = json.loads(line)
        except ValueError as error:
            raise ValueError(f"attempt journal line {index + 1} is incomplete; retain and repair from its receipt") from error
        if item.get("manifest") != manifest["id"]:
            raise ValueError("attempt belongs to another frozen manifest")
        receipt = pathlib.Path(root) / "receipts" / (item["attempt"] + ".json")
        if not receipt.is_file() or digest(read(receipt)) != item["receiptHash"]:
            raise ValueError("attempt receipt is missing or changed")
        content = read(receipt)
        if valid_trials.get(content.get("trial", {}).get("key")) != content.get("trial"):
            raise ValueError("attempt is outside the predeclared plan")
        rows.append(content)
    if len({r["attempt"] for r in rows}) != len(rows):
        raise ValueError("duplicate attempt journal entry")
    return rows


def retain(root, manifest, trial, result, outcome="measured"):
    root = pathlib.Path(root)
    receipt = {"attempt": uuid.uuid4().hex, "manifest": manifest["id"], "at": now(),
               "trial": trial, "outcome": outcome, "result": result}
    path = root / "receipts" / (receipt["attempt"] + ".json")
    write(path, receipt)
    entry = {"attempt": receipt["attempt"], "manifest": manifest["id"], "receiptHash": digest(receipt)}
    with (root / "ATTEMPTS.jsonl").open("a", encoding="utf-8") as out:
        out.write(json.dumps(entry, separators=(",", ":")) + "\n")
        out.flush()
        os.fsync(out.fileno())
    return receipt


def summarize(manifest, attempts):
    wanted = plan(manifest)
    by_key = {}
    for attempt in attempts:
        by_key.setdefault(attempt["trial"]["key"], []).append(attempt)
    reports = []
    for h in manifest["spec"]["hosts"]:
        for stage in manifest["spec"]["stages"]:
            group = [t for t in wanted if t["host"] == h["host"] and t["stage"] == stage["name"]]
            arms = {}
            pairs = []
            for arm in ("base", "atlias"):
                trials = [t for t in group if t["arm"] == arm]
                rows = [a for t in trials for a in by_key.get(t["key"], [])]
                results = [a["result"] for a in rows]
                complete = len(rows) == len(trials) and all(a["outcome"] == "measured" for a in rows)
                counted = complete and all(r.get("usageComplete") is True and count(r.get("promptTotal")) is not None and count(r.get("outputTotal")) is not None for r in results)
                peaks = [count(r.get("peakContext")) for r in results]
                arms[arm] = {"expected": len(trials), "attempts": len(rows), "complete": complete,
                             "passed": sum(r.get("pass") is True for r in results),
                             "nativeCompleted": sum(r.get("nativeCompleted") is True for r in results),
                             "usageComplete": counted,
                             "totalTokens": sum(r["promptTotal"] + r["outputTotal"] for r in results) if counted else None,
                             "peakContext": max(peaks) if counted and peaks and all(p is not None for p in peaks) else None,
                             "windowMatched": complete and all(r.get("loadedWindow") == h["numCtx"] for r in results)}
                arms[arm]["tokensPerSolved"] = arms[arm]["totalTokens"] / arms[arm]["passed"] if arms[arm]["totalTokens"] is not None and arms[arm]["passed"] else None
            for t in (t for t in group if t["arm"] == "base"):
                opposite = next(x for x in group if x["arm"] == "atlias" and x["taskId"] == t["taskId"] and x["repeat"] == t["repeat"])
                a, b = by_key.get(t["key"], []), by_key.get(opposite["key"], [])
                if len(a) == len(b) == 1:
                    ar, br = a[0]["result"], b[0]["result"]
                    pa, pb = ar.get("provenance", {}), br.get("provenance", {})
                    matched = (ar.get("id") == br.get("id") == t["taskId"]
                               and ar.get("controllerIntegrity") is True and br.get("controllerIntegrity") is True
                               and ar.get("taskDigests") == br.get("taskDigests") and bool(ar.get("taskDigests"))
                               and pa.get("model") == pb.get("model") and all(pa.get("model", {}).get(k) for k in ("name", "digest", "server", "template", "parameters", "quantization"))
                               and pa.get("client") == pb.get("client") and all(pa.get("client", {}).get(k) for k in ("sha256", "version"))
                               and pa.get("door") == pb.get("door") and bool(pa.get("door")))
                    pairs.append({"taskId": t["taskId"], "repeat": t["repeat"], "conditionsMatched": matched,
                                  "basePass": ar.get("pass") is True, "atliasPass": br.get("pass") is True,
                                  "completionLost": ar.get("nativeCompleted") is True and br.get("nativeCompleted") is not True})
            a, b = arms["base"], arms["atlias"]
            qualified = (a["complete"] and b["complete"] and a["usageComplete"] and b["usageComplete"]
                         and a["windowMatched"] and b["windowMatched"] and len(pairs) == a["expected"]
                         and count(a["peakContext"]) is not None and count(b["peakContext"]) is not None
                         and all(p["conditionsMatched"] for p in pairs))
            total_ratio = a["totalTokens"] / b["totalTokens"] if qualified and b["totalTokens"] else None
            peak_ratio = a["peakContext"] / b["peakContext"] if qualified and b["peakContext"] else None
            lost = sum(p["basePass"] and not p["atliasPass"] for p in pairs)
            gained = sum(p["atliasPass"] and not p["basePass"] for p in pairs)
            reports.append({"host": h["host"], "stage": stage["name"], "arms": arms, "pairs": pairs,
                            "measurementMatched": qualified, "totalReduction": total_ratio, "peakReduction": peak_ratio,
                            "gained": gained, "lost": lost,
                            "solvedBase": sum(p["basePass"] for p in pairs), "solvedAtlias": sum(p["atliasPass"] for p in pairs),
                            # Gev, 2026-10-13: never worse than the bare client. The stage gate stays stricter (any lost task holds).
                            "neverWorse": qualified and sum(p["atliasPass"] for p in pairs) >= sum(p["basePass"] for p in pairs),
                            "measured20xNoTaskLoss": qualified and total_ratio is not None and peak_ratio is not None
                            and total_ratio >= 20 and peak_ratio >= 20 and lost == 0 and not any(p["completionLost"] for p in pairs)})
    return {"schema": SCHEMA, "manifest": manifest["id"], "generated": now(), "reports": reports,
            "qualification": "Local task-set evidence only; native capability, active skill and follow-up conformance require separate retained checks.",
            "goalComplete": False}


def stage_gate(manifest, attempts, host, stage):
    """Hold before another expensive stage unless the frozen threshold holds."""
    measured = next(r for r in summarize(manifest, attempts)["reports"] if r["host"] == host and r["stage"] == stage)
    minimum = manifest["spec"].get("continuationMinimum", 20)
    reasons = []
    if measured["measurementMatched"] is not True:
        reasons.append("counts, windows, tasks or provenance are incomplete or unmatched")
    if measured["lost"] != 0:
        reasons.append("a task solved by base was lost")
    if not measured["neverWorse"]:
        reasons.append("never worse: the Atlias arm did not solve at least as many matched tasks as base, or the pairs are unmatched (Gev, 2026-10-13)")
    if any(p["completionLost"] for p in measured["pairs"]):
        reasons.append("a base native completion was lost")
    for arm in ("base", "atlias"):
        if measured["arms"][arm]["nativeCompleted"] != measured["arms"][arm]["expected"]:
            reasons.append(arm + " native completion is incomplete")
    for metric in ("totalReduction", "peakReduction"):
        observed = measured[metric]
        if observed is None or observed < minimum:
            reasons.append(metric + " is unknown or below the predeclared minimum")
    inputs = [a for a in attempts if a["trial"]["host"] == host and a["trial"]["stage"] == stage]
    return {"manifest": manifest["id"], "host": host, "stage": stage, "continuationMinimum": minimum,
            "attemptsHash": digest(inputs), "measurement": measured, "reasons": reasons,
            "action": "hold" if reasons else "continue"}


def report(root, manifest=None):
    root = pathlib.Path(root)
    manifest = manifest or verify(root)
    data = summarize(manifest, load_attempts(root, manifest))
    write(root / "REPORT.json", data)
    lines = ["# Native subharness measurements", "", "Same pinned model within each base/enhanced pair. No regular harness promotion.", "",
             "| Host | Stage | Base solved | Atlias solved | Lost | Gained | Never worse | Base tokens per solve | Atlias tokens per solve | Total reduction | Peak reduction | Matched |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in data["reports"]:
        def ratio(x):
            return "unknown" if x is None else f"{x:.3f}x"
        a, b = r["arms"]["base"], r["arms"]["atlias"]
        def per(x):
            return "unknown" if x is None else f"{x:,.0f}"
        lines.append(f"| {r['host']} | {r['stage']} | {a['passed']}/{a['expected']} | {b['passed']}/{b['expected']} | {r.get('lost')} | {r.get('gained')} | {r.get('neverWorse')} | {per(a.get('tokensPerSolved'))} | {per(b.get('tokensPerSolved'))} | {ratio(r['totalReduction'])} | {ratio(r['peakReduction'])} | {r['measurementMatched']} |")
    lines += ["", "Solves come first (Gev, 2026-10-13: never worse than the bare client). Never worse means every pair matched and the Atlias arm solved at least as many matched tasks as base; the stage gate is stricter and holds on any lost task. One run per arm cannot tell a loss from noise: re-run a lost task before calling it a loss.",
              "", "Tokens are input plus output, cache reads counted as full input. The base arm is the bare client in an empty profile; a setting the spec gives one arm only (tool search, say) is not credited to Atlias.",
              "", data["qualification"], "", "All attempts, including failures and unknown spend, remain in ATTEMPTS.jsonl and receipts/. Changed code requires a new manifest."]
    (root / "REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return data


class Lease:
    """Exclusive GPU lock; never delete a foreign/stale lock or kill its owner."""
    def __init__(self, path):
        self.path = pathlib.Path(path)
        self.owner = uuid.uuid4().hex

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("x", encoding="utf-8") as out:
            json.dump({"pid": os.getpid(), "role": "subharness-controller", "owner": self.owner, "at": now()}, out)
        return self

    def __exit__(self, *_):
        try:
            if read(self.path).get("owner") == self.owner:
                self.path.unlink()
        except (OSError, ValueError):
            pass


def repository(folder, label):
    """A frozen snapshot carries no .git, and a check that stamps a result with its commit needs one
    to name. Only the disposable check copy becomes a repository; the measured source never does."""
    for args in (["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", label]):
        done = subprocess.run(["git", "-c", "core.autocrlf=false", "-c", "user.name=Gev", "-c", "user.email=gev@localhost", *args],
                              cwd=str(folder), capture_output=True, timeout=600)
        if done.returncode != 0:
            raise ValueError("disposable check copy could not be committed: " + done.stderr.decode("utf-8", "replace")[-300:])


def preflight(root, manifest):
    """Checks run on a disposable copy: planted changes cannot mutate measured source."""
    root = pathlib.Path(root)
    receipt_file = root / "PREFLIGHT.json"
    if receipt_file.exists():
        receipt = read(receipt_file)
        checks = receipt.get("checks", [])
        if (receipt.get("manifest") == manifest["id"] and receipt.get("passed") is True
            and [c.get("argv") for c in checks] == manifest["spec"]["checks"]
            and all(c.get("exit") == 0 and c.get("timeout") is False
                    and pathlib.Path(c["log"]).is_file()
                    and hashlib.sha256(pathlib.Path(c["log"]).read_bytes()).hexdigest() == c["sha256"] for c in checks)):
            return receipt
        raise ValueError("failed or mismatched preflight retained; use a new candidate directory")
    checks = []
    with tempfile.TemporaryDirectory(prefix="atlias-subharness-check-") as temp:
        check_source = pathlib.Path(temp) / "source"
        shutil.copytree(root / "source", check_source)
        repository(check_source, "frozen candidate " + manifest["id"])
        for i, argv in enumerate(manifest["spec"]["checks"]):
            log = root / "checks" / f"{i:02d}.log"
            log.parent.mkdir(exist_ok=True)
            sys.path.insert(0, str(check_source / "tools/h2h"))
            from owned_process import run_tree
            env = dict(os.environ)
            for name, folder in (("ATLIAS_HOME", "atlias"), ("CLAUDE_CONFIG_DIR", "claude"), ("CODEX_HOME", "codex")):
                target = pathlib.Path(temp) / folder
                target.mkdir(exist_ok=True)
                env[name] = str(target)
            with log.open("wb") as output:
                rc, timed = run_tree(argv, cwd=str(check_source), env=env, stdout=output, timeout=1800)
            checks.append({"argv": argv, "exit": rc, "timeout": timed,
                           "log": str(log), "sha256": hashlib.sha256(log.read_bytes()).hexdigest()})
            if rc != 0 or timed:
                break
    receipt = {"manifest": manifest["id"], "at": now(), "checks": checks,
               "passed": len(checks) == len(manifest["spec"]["checks"]) and all(c["exit"] == 0 and not c["timeout"] for c in checks)}
    write(receipt_file, receipt)
    if not receipt["passed"]:
        raise ValueError("candidate checks failed; no inference started")
    return receipt


def backend(root):
    path = pathlib.Path(root) / "source/tools/h2h/base_harness_runner.py"
    sys.path.insert(0, str(path.parent))
    module_spec = importlib.util.spec_from_file_location("subharness_frozen_runner", path)
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    originals = {host: module.HARNESS[host] for host in ("claude", "codex")}
    def command(host):
        def wrapped(a, task, ws, state, door, budget, env):
            argv, cwd, stdin = originals[host](a, task, ws, state, door, budget, env)
            atlias_home = pathlib.Path(state) / "atlias-home"
            atlias_home.mkdir(parents=True, exist_ok=True)
            env["ATLIAS_HOME"] = str(atlias_home)
            if a.controller_enhanced:
                write(atlias_home / "config.json", a.controller_config)
            if host == "claude":
                if a.controller_tool_search:
                    env["ENABLE_TOOL_SEARCH"] = "true"
                if a.controller_enhanced:
                    settings = pathlib.Path(state) / "enabled-settings.json"
                    write(settings, a.controller_claude_settings)
                    argv += ["--settings", str(settings)]
            return argv, cwd, stdin
        return wrapped
    for host in originals:
        module.HARNESS[host] = command(host)
    return module


def arguments(root, manifest, trial):
    spec = manifest["spec"]
    host = next(h for h in spec["hosts"] if h["host"] == trial["host"])
    enhanced = trial["arm"] == "atlias"
    source = pathlib.Path(root) / "source"
    work = pathlib.Path(root) / "work" / trial["key"]
    search = spec.get("toolSearch", False)
    search = search[trial["arm"]] if isinstance(search, dict) else search
    return types.SimpleNamespace(harness=trial["host"], model=spec["model"], api_base=spec.get("apiBase", "http://127.0.0.1:11435"),
        num_ctx=host["numCtx"], num_predict=host.get("numPredict", 2048), budget=host.get("budget", 0),
        task_timeout=host.get("taskTimeout", 1200), start_timeout=host.get("startTimeout", 600), keep=True, work=str(work),
        claude=host["client"], codex=host["client"], codex_home_from=str(pathlib.Path(root) / "prepared-codex-home") if enhanced and trial["host"] == "codex" else "",
        codex_disabled_skills=str(pathlib.Path(root) / "CODEX-DISABLED-SKILLS.json") if manifest.get("codexDisabledSkillsHash") else "",
        codex_bypass_hook_trust=enhanced and host.get("bypassHookTrust", False) is True,
        claude_plugin_dir=([str(source)] + [str(source / relpath(p)) for p in spec.get("claudeMods", [])] if enhanced and trial["host"] == "claude" else []),
        controller_enhanced=enhanced, controller_config=spec.get("atliasConfig", {}),
        controller_claude_settings=spec.get("claudeSettings", {}), controller_tool_search=search,
        tasks=spec["tasks"], ids_from="", ripgrep="", tiktoken_cache="", opencode_source="", nanobot="")


def run(root, gpu_lock, max_tasks=0):
    root = pathlib.Path(root).resolve()
    if max_tasks < 0:
        raise ValueError("max-tasks cannot be negative")
    with Lease(root / "CONTROLLER.lock"):
        return run_owned(root, gpu_lock, max_tasks)


def run_owned(root, gpu_lock, max_tasks=0):
    root = pathlib.Path(root).resolve()
    manifest = verify(root)
    preflight(root, manifest)
    runner = backend(root)
    tasks = read(root / "TASKS.json")
    with Lease(gpu_lock):
        attempts = load_attempts(root, manifest)
        done = {r["trial"]["key"] for r in attempts}
        active_path = root / "ACTIVE.json"
        if active_path.exists():
            active = read(active_path)
            if active["trial"]["key"] not in done:
                # A crash may have spent tokens without a terminal receipt. Retain unknown; never rerun in its place.
                attempts.append(retain(root, manifest, active["trial"], {"pass": False, "usageComplete": False,
                    "promptTotal": None, "outputTotal": None, "peakContext": None, "stop": "interrupted attempt: spend unknown"}, "interrupted"))
                done.add(active["trial"]["key"])
            active_path.unlink()
        n = 0
        held = {}
        try:
            for trial in plan(manifest):
                if trial["key"] in done or trial["host"] in held:
                    continue
                if STOP_REQUESTED or (root / "STOP").exists() or (max_tasks and n >= max_tasks):
                    write(root / "STATE.json", {"manifest": manifest["id"], "phase": "stopped-at-task-boundary", "next": trial, "at": now()})
                    break
                prerequisite = {"confirmation": "screen", "ultimate": "confirmation"}.get(trial["stage"])
                if prerequisite:
                    gate = stage_gate(manifest, attempts, trial["host"], prerequisite)
                    write(root / "gates" / f"{trial['host']}-{prerequisite}.json", gate)
                    if gate["action"] == "hold":
                        # A verdict holds this host's later stages only. The other host's stages are
                        # their own measurement and still run: before this, Claude's held screen
                        # ended the run and Codex's screen was never measured.
                        held[trial["host"]] = {"next": trial, "gate": gate}
                        continue
                verify(root)
                a = arguments(root, manifest, trial)
                pathlib.Path(a.work).mkdir(parents=True, exist_ok=True)
                shims = runner.make_shims(pathlib.Path(a.work) / "_shims")
                for name in ("powershell", "pwsh"):
                    for suffix in ("", ".cmd"):
                        (pathlib.Path(shims) / (name + suffix)).unlink(missing_ok=True)
                a.provenance = runner.provenance(a)
                a.provenance["controller"] = {"manifest": manifest["id"], "trial": trial, "sourceHash": digest(manifest["sourceFiles"]),
                                              "atliasConfig": digest(a.controller_config) if a.controller_enhanced else None,
                                              "claudeSettings": digest(a.controller_claude_settings) if a.controller_enhanced else None,
                                              "toolSearch": a.controller_tool_search}
                write(active_path, {"manifest": manifest["id"], "trial": trial, "at": now(), "provenance": a.provenance})
                write(root / "STATE.json", {"manifest": manifest["id"], "phase": "native-task-running", "trial": trial, "at": now()})
                try:
                    result = runner.run_one(tasks[trial["taskId"]], a, shims)
                    try:
                        verify(root)
                        result["controllerIntegrity"] = runner.model_facts(a.api_base, a.model) == a.provenance["model"]
                    except (OSError, ValueError):
                        result["controllerIntegrity"] = False
                    outcome = "measured"
                except Exception as error:
                    result = {"pass": False, "usageComplete": False, "promptTotal": None, "outputTotal": None,
                              "peakContext": None, "stop": f"controller exception: {type(error).__name__}: {error}", "provenance": a.provenance}
                    outcome = "error"
                attempts.append(retain(root, manifest, trial, result, outcome))
                active_path.unlink()
                done.add(trial["key"])
                report(root, manifest)
                print(f"{trial['host']} {trial['stage']} repeat {trial['repeat'] + 1} {trial['arm']} {trial['taskId']}: {result.get('pass')}; usage {result.get('usageComplete')}", flush=True)
                n += 1
                if (result.get("controllerIntegrity") is not True or result.get("usageComplete") is not True
                    or result.get("loadedWindow") != a.num_ctx or not result.get("rounds") or result.get("modelErrors")):
                    write(root / "STATE.json", {"manifest": manifest["id"], "phase": "held-native-qualification", "trial": trial, "at": now()})
                    break
            else:
                if held:
                    first = next(iter(held.values()))
                    write(root / "STATE.json", {"manifest": manifest["id"], "phase": "held-stage-verdict", "next": first["next"],
                                               "gate": first["gate"], "held": held, "at": now()})
                else:
                    write(root / "STATE.json", {"manifest": manifest["id"], "phase": "measurements-complete", "at": now()})
        finally:
            runner.end_all()
            report(root, manifest)
    return 0


def selftest_cases():
    """Pure controller checks: no native client, network, shared source or GPU."""
    m = {"id": "manifest", "spec": {"hosts": [{"host": "claude", "numCtx": 100}],
         "stages": [{"name": "screen", "ids": ["a", "b"], "repeats": 2}]}}
    p = plan(m)
    conditions = {"model": {"name": "qwen", "digest": "weights", "server": "version", "template": "template", "parameters": "parameters", "quantization": "Q4"},
                  "client": {"sha256": "client", "version": "version"}, "door": {"budget": 25}}
    attempts = [{"attempt": str(i), "trial": t, "outcome": "measured", "result": {"id": t["taskId"], "pass": True,
                 "nativeCompleted": True, "usageComplete": True, "promptTotal": 200 if t["arm"] == "base" else 5,
                 "outputTotal": 20 if t["arm"] == "base" else 5, "peakContext": 100 if t["arm"] == "base" else 4,
                 "loadedWindow": 100, "controllerIntegrity": True, "taskDigests": {"prompt": t["taskId"]}, "provenance": copy.deepcopy(conditions)}} for i, t in enumerate(p)]
    cases = []
    def check(name, condition):
        cases.append({"name": name, "passed": bool(condition)})
    r = summarize(m, attempts)["reports"][0]
    check("balanced AB/BA order", p[0]["arm"] != p[4]["arm"] and len(p) == 8)
    host_smoke = copy.deepcopy(m)
    host_smoke["spec"]["hosts"].append({"host": "codex", "numCtx": 100})
    host_smoke["spec"]["stages"].insert(0, {"name": "smoke", "ids": ["smoke"], "repeats": 1})
    observed_order = []
    for trial in plan(host_smoke):
        key = (trial["host"], trial["stage"])
        if not observed_order or observed_order[-1] != key:
            observed_order.append(key)
    check("Codex smoke follows Claude before larger stages", observed_order == [("claude", "smoke"), ("codex", "smoke"), ("claude", "screen"), ("codex", "screen")])
    check("full input plus output is measured", r["totalReduction"] == 22)
    check("native peak includes output", r["peakReduction"] == 25)
    check("task-set 20x conditions are explicit", r["measured20xNoTaskLoss"] is True)
    check("general capability is never invented", summarize(m, attempts)["goalComplete"] is False)
    check("matched 20x screen proceeds", stage_gate(m, attempts, "claude", "screen")["action"] == "continue")
    below = copy.deepcopy(attempts)
    for row in below:
        if row["trial"]["arm"] == "base":
            row["result"]["promptTotal"] = 150
    check("below threshold screen holds", stage_gate(m, below, "claude", "screen")["action"] == "hold")
    lower_peak = copy.deepcopy(attempts)
    for row in lower_peak:
        if row["trial"]["arm"] == "base":
            row["result"]["peakContext"] = 60
    check("peak alone below minimum holds", stage_gate(m, lower_peak, "claude", "screen")["action"] == "hold")
    lost_task = copy.deepcopy(attempts)
    lost_task[1]["result"]["pass"] = False
    check("task loss holds a cheap screen", stage_gate(m, lost_task, "claude", "screen")["action"] == "hold")
    check("never worse is true when Atlias solves as many matched tasks as base", summarize(m, attempts)["reports"][0]["neverWorse"] is True)
    check("never worse is false, and named in the hold, when Atlias solves fewer", summarize(m, lost_task)["reports"][0]["neverWorse"] is False
          and any(x.startswith("never worse") for x in stage_gate(m, lost_task, "claude", "screen")["reasons"]))
    traded = copy.deepcopy(lost_task)
    lost_pair = (lost_task[1]["trial"]["taskId"], lost_task[1]["trial"]["repeat"])
    next(x for x in traded if x["trial"]["arm"] == "base" and (x["trial"]["taskId"], x["trial"]["repeat"]) != lost_pair)["result"]["pass"] = False
    t = summarize(m, traded)["reports"][0]
    check("one gained and one lost is never worse, and the strict stage gate still holds on the loss",
          t["neverWorse"] is True and t["lost"] == 1 and t["gained"] == 1 and stage_gate(m, traded, "claude", "screen")["action"] == "hold")
    per_solve = summarize(m, attempts)["reports"][0]["arms"]
    check("tokens per solved task are reported per arm", per_solve["base"]["tokensPerSolved"] == 220 and per_solve["atlias"]["tokensPerSolved"] == 10)
    no_completion = copy.deepcopy(attempts)
    no_completion[0]["result"]["nativeCompleted"] = False
    check("incomplete native base holds", stage_gate(m, no_completion, "claude", "screen")["action"] == "hold")
    milestone = copy.deepcopy(m)
    milestone["spec"]["continuationMinimum"] = 5
    check("explicit lower milestone remains distinct from 20x", stage_gate(milestone, below, "claude", "screen")["action"] == "continue"
          and summarize(milestone, below)["reports"][0]["measured20xNoTaskLoss"] is False)
    for index in (0, 1):
        unknown_peak = copy.deepcopy(attempts)
        unknown_peak[index]["result"]["peakContext"] = None
        try:
            data = summarize(m, unknown_peak)["reports"][0]
            remains_unknown = data["peakReduction"] is None and data["measured20xNoTaskLoss"] is False
        except (TypeError, ValueError):
            remains_unknown = False
        check("unknown peak remains unknown without crash " + str(index), remains_unknown)
    for field, bad in (("promptTotal", None), ("promptTotal", True), ("outputTotal", -1), ("usageComplete", False), ("loadedWindow", None), ("loadedWindow", 99)):
        changed = copy.deepcopy(attempts)
        changed[0]["result"][field] = bad
        r = summarize(m, changed)["reports"][0]
        check(f"bad {field} {bad!r} blocks a ratio", r["totalReduction"] is None)
    changed = copy.deepcopy(attempts)
    changed[0]["result"]["provenance"]["model"]["digest"] = "different"
    check("different model blocks qualification", summarize(m, changed)["reports"][0]["totalReduction"] is None)
    for field in ("name", "digest", "server", "template", "parameters", "quantization"):
        changed = copy.deepcopy(attempts)
        for row in changed:
            row["result"]["provenance"]["model"][field] = None
        check("unknown model " + field + " blocks qualification", summarize(m, changed)["reports"][0]["totalReduction"] is None)
    changed = copy.deepcopy(attempts)
    changed[0]["result"]["controllerIntegrity"] = False
    check("mid-task source drift blocks qualification", summarize(m, changed)["reports"][0]["totalReduction"] is None)
    changed = copy.deepcopy(attempts)
    changed[1]["result"]["pass"] = False
    check("one task loss blocks 20x", summarize(m, changed)["reports"][0]["measured20xNoTaskLoss"] is False)
    changed = copy.deepcopy(attempts)
    changed[1]["result"]["nativeCompleted"] = False
    check("native completion loss blocks 20x", summarize(m, changed)["reports"][0]["measured20xNoTaskLoss"] is False)
    check("missing task remains incomplete", summarize(m, attempts[:-1])["reports"][0]["totalReduction"] is None)
    check("duplicate attempts are retained and block ratio", summarize(m, attempts + [attempts[0]])["reports"][0]["totalReduction"] is None)
    with tempfile.TemporaryDirectory() as temp:
        root = pathlib.Path(temp)
        a = retain(root, m, p[0], attempts[0]["result"])
        b = retain(root, m, p[1], {"pass": False, "usageComplete": False}, "interrupted")
        loaded = load_attempts(root, m)
        check("resume retains failures and unknown spend", [r["attempt"] for r in loaded] == [a["attempt"], b["attempt"]])
        write(root / "CONTROLLER.lock", {"owner": "foreign", "pid": 123})
        try:
            with Lease(root / "CONTROLLER.lock"):
                pass
            locked = False
        except FileExistsError:
            locked = read(root / "CONTROLLER.lock")["owner"] == "foreign"
        check("foreign lock is never stolen", locked)
        receipt = root / "receipts" / (a["attempt"] + ".json")
        changed = read(receipt)
        changed["result"]["pass"] = False
        write(receipt, changed)
        try:
            load_attempts(root, m)
            rejected = False
        except ValueError:
            rejected = True
        check("altered receipt is rejected", rejected)
    for unsafe in ("../check.py", "C:/outside.txt", "/absolute.txt", "a/../../b"):
        try:
            relpath(unsafe)
            rejected = False
        except ValueError:
            rejected = True
        check("task paths stay inside workspace: " + unsafe, rejected)
    with tempfile.TemporaryDirectory() as temp:
        trial_root = pathlib.Path(temp)
        gate_manifest = copy.deepcopy(m)
        gate_manifest["sourceFiles"] = {}
        gate_manifest["spec"].update({"model": "fixture", "tasks": []})
        gate_manifest["spec"]["hosts"][0]["client"] = sys.executable
        gate_manifest["spec"]["stages"].append({"name": "confirmation", "ids": ["held"], "repeats": 1})
        write(trial_root / "TASKS.json", {"held": {"id": "held"}})
        for attempt in below:
            retain(trial_root, gate_manifest, attempt["trial"], attempt["result"])
        calls = []
        def fake_shims(path):
            path.mkdir(parents=True, exist_ok=True)
            return str(path)
        fake = types.SimpleNamespace(end_all=lambda: None, make_shims=fake_shims,
            provenance=lambda _: copy.deepcopy(conditions), model_facts=lambda *_: conditions["model"],
            run_one=lambda *_: (calls.append("unexpected inference") or {"pass": False, "usageComplete": False}))
        original = {name: globals()[name] for name in ("verify", "preflight", "backend")}
        try:
            globals()["verify"] = lambda _: gate_manifest
            globals()["preflight"] = lambda *_: None
            globals()["backend"] = lambda _: fake
            run_owned(trial_root, trial_root / "fake-gpu.lock", max_tasks=1)
            held = read(trial_root / "STATE.json")["phase"] == "held-stage-verdict" and not calls
        finally:
            globals().update(original)
        check("run holds below-minimum screen before another model call", held)
        two = copy.deepcopy(gate_manifest)
        two["spec"]["hosts"].append({"host": "codex", "numCtx": 100, "client": sys.executable})
        write(trial_root / "TASKS.json", {"held": {"id": "held"}, "a": {"id": "a"}, "b": {"id": "b"}})
        seen = []
        fake_two = types.SimpleNamespace(end_all=lambda: None, make_shims=fake_shims,
            provenance=lambda _: copy.deepcopy(conditions), model_facts=lambda *_: conditions["model"],
            run_one=lambda task, a, shims: (seen.append(a.harness) or {"pass": False, "usageComplete": False, "promptTotal": None,
                "outputTotal": None, "peakContext": None, "stop": "fixture", "provenance": copy.deepcopy(conditions)}))
        try:
            globals()["verify"] = lambda _: two
            globals()["preflight"] = lambda *_: None
            globals()["backend"] = lambda _: fake_two
            with contextlib.redirect_stdout(io.StringIO()):
                run_owned(trial_root, trial_root / "fake-gpu.lock", max_tasks=1)
        finally:
            globals().update(original)
        check("a held host does not stop the other host's stages",
              seen == ["codex"] and read(trial_root / "gates" / "claude-screen.json")["action"] == "hold")
    with tempfile.TemporaryDirectory() as temp:
        temp = pathlib.Path(temp)
        source, tasks = temp / "candidate", temp / "tasks"
        (source / ".claude-plugin").mkdir(parents=True)
        (source / "tools/h2h").mkdir(parents=True)
        (source / ".claude-plugin/plugin.json").write_text('{"name":"atlias"}', encoding="utf-8")
        (source / "tools/h2h/base_harness_runner.py").write_text("# frozen fixture\n", encoding="utf-8")
        tasks.mkdir()
        for name in ("smoke", "screen", "held-out"):
            write(tasks / (name + ".json"), {"id": name, "prompt": "exact request", "files": {"main.py": "pass\n"}, "check": ["python", "main.py"]})
        spec = {"source": str(source), "candidate": "fixture", "model": "local", "tasks": [str(tasks)],
                "hosts": [{"host": "claude", "client": sys.executable, "numCtx": 100}],
                "checks": [["node", "test/run.mjs"], ["python", "tools/h2h/subharness_adversarial.py"]],
                "stages": [{"name": "smoke", "ids": ["smoke"], "repeats": 1}, {"name": "screen", "ids": ["screen"], "repeats": 2},
                           {"name": "confirmation", "ids": ["held-out"], "repeats": 2}]}
        spec_path, trial = temp / "spec.json", temp / "trial"
        write(spec_path, spec)
        prepared = prepare(spec_path, trial)
        check("prepare freezes source/tasks/client without inference", verify(trial)["id"] == prepared["id"])
        check("report before inference retains unknown ratios", all(r["totalReduction"] is None for r in report(trial)["reports"]))
        frozen = trial / "source/tools/h2h/base_harness_runner.py"
        original = frozen.read_bytes()
        frozen.write_bytes(original + b"# changed\n")
        try:
            verify(trial)
            rejected = False
        except ValueError:
            rejected = True
        check("changed frozen source rejected", rejected)
        frozen.write_bytes(original)
        changed = copy.deepcopy(spec)
        changed["stages"][2]["ids"] = ["screen"]
        try:
            validate(changed)
            rejected = False
        except ValueError:
            rejected = True
        check("confirmation cannot reuse screen", rejected)
        check_copy = temp / "check-copy"
        shutil.copytree(trial / "source", check_copy)
        repository(check_copy, "fixture")
        logged = subprocess.run(["git", "log", "-1", "--format=%h"], cwd=str(check_copy), capture_output=True, timeout=60)
        check("disposable check copy has a commit to stamp; frozen source stays without a repository",
              logged.returncode == 0 and re.fullmatch(rb"[0-9a-f]{7,40}\s*", logged.stdout) and not (trial / "source/.git").exists())
        changed = copy.deepcopy(spec)
        changed["hosts"] = [{"host": "codex", "client": sys.executable, "numCtx": 100, "codexHomeFrom": str(source)}]
        try:
            validate(changed)
            alone = True
        except ValueError:
            alone = False
        changed["hosts"] = [changed["hosts"][0], copy.deepcopy(spec["hosts"][0])]
        try:
            validate(changed)
            backwards = True
        except ValueError:
            backwards = False
        check("a Codex-only trial is accepted and Codex before Claude is not", alone and not backwards)
        changed = copy.deepcopy(spec)
        changed["apiBase"] = "https://api.example.com"
        try:
            validate(changed)
            rejected = False
        except ValueError:
            rejected = True
        check("local controller refuses paid remote endpoints", rejected)
    return cases


def selftest(receipt_path):
    cases = selftest_cases()
    mutants = [("unknown usage accepted", 'r.get("usageComplete") is True and count', 'True and count'),
               ("wrong window accepted", 'all(r.get("loadedWindow") == h["numCtx"] for r in results)', 'True'),
               ("model mismatch accepted", 'pa.get("model") == pb.get("model")', 'True'),
               ("task loss accepted", 'and lost == 0 and not any', 'and True and not any'),
               ("native completion loss accepted", 'not any(p["completionLost"] for p in pairs)', 'True'),
               ("output spend erased", 'sum(r["promptTotal"] + r["outputTotal"] for r in results)', 'sum(r["promptTotal"] for r in results)'),
               ("receipt tamper accepted", 'digest(read(receipt)) != item["receiptHash"]', 'False')]
    mutants += [("unknown peak gate bypassed", 'and count(a["peakContext"]) is not None and count(b["peakContext"]) is not None', 'and True'),
                ("stage reduction threshold bypassed", 'if observed is None or observed < minimum:', 'if observed is None:'),
                ("stage native completion gate bypassed", 'if measured["arms"][arm]["nativeCompleted"] != measured["arms"][arm]["expected"]:', 'if False:'),
                ("stage task loss gate bypassed", 'if measured["lost"] != 0:', 'if False:')]
    mutants += [("stage gate not dispatched", 'if prerequisite:', 'if False:')]
    mutants += [("never worse ignores solves", 'sum(p["atliasPass"] for p in pairs) >= sum(p["basePass"] for p in pairs)', 'True'),
                ("never worse gate bypassed", 'if not measured["neverWorse"]:', 'if False:')]
    mutants += [("held host ends the other host's stages", 'held[trial["host"]] = {"next": trial, "gate": gate}',
                 'write(root / "STATE.json", {"manifest": manifest["id"], "phase": "held-stage-verdict", "next": trial, "gate": gate, "at": now()}); break')]
    mutants += [("Codex-only trial refused", 'not in (["claude"], ["codex"], ["claude", "codex"]):', 'not in (["claude"], ["claude", "codex"]):')]
    mutants += [("check copy left without a commit", '["add", "-A"], ["commit", "-q", "-m", label]', '["add", "-A"]')]
    source = pathlib.Path(__file__).read_text(encoding="utf-8")
    planted = []
    with tempfile.TemporaryDirectory() as temp:
        for i, (name, old, new) in enumerate(mutants):
            # Replace the implementation anchor only; leave the same anchor in this mutation table intact.
            before_table = source.split("    mutants = [", 1)[0]
            if before_table.count(old) != 1:
                raise ValueError("mutation anchor is not unique: " + name)
            mutation = before_table.replace(old, new, 1) + "    mutants = [" + source.split("    mutants = [", 1)[1]
            path = pathlib.Path(temp) / f"mutant-{i}.py"
            path.write_text(mutation, encoding="utf-8")
            child = subprocess.run([sys.executable, str(path), "selftest-functional"], capture_output=True, timeout=30)
            planted.append({"name": name, "caught": child.returncode == 1 and b'"passed": false' in child.stdout,
                            "exit": child.returncode, "stdoutHash": hashlib.sha256(child.stdout).hexdigest()})
    receipt = {"at": now(), "controllerSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
               "functional": cases, "planted": planted, "restoredFunctional": selftest_cases()}
    write(receipt_path, receipt)
    passed = all(c["passed"] for c in cases + receipt["restoredFunctional"]) and all(c["caught"] for c in planted)
    print(json.dumps({"functional": sum(c["passed"] for c in cases), "functionalTotal": len(cases),
                      "planted": sum(c["caught"] for c in planted), "plantedTotal": len(planted), "passed": passed}))
    return 0 if passed else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    commands = ap.add_subparsers(dest="command", required=True)
    p = commands.add_parser("prepare")
    p.add_argument("--spec", required=True)
    p.add_argument("--root", required=True)
    p = commands.add_parser("run")
    p.add_argument("--root", required=True)
    p.add_argument("--gpu-lock", required=True)
    p.add_argument("--gpu-approved", action="store_true", help="use only after the existing GPU owner has yielded")
    p.add_argument("--max-tasks", type=int, default=0, help="stop at a task boundary for a bounded smoke")
    for cmd in ("status", "report"):
        p = commands.add_parser(cmd)
        p.add_argument("--root", required=True)
    p = commands.add_parser("selftest")
    p.add_argument("--receipt", required=True)
    commands.add_parser("selftest-functional")
    a = ap.parse_args()
    global STOP_REQUESTED
    def stop(*_):
        global STOP_REQUESTED
        STOP_REQUESTED = True
    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), stop)
    try:
        if a.command == "prepare":
            print(json.dumps({"manifest": prepare(a.spec, a.root)["id"]}))
        elif a.command == "run":
            if not a.gpu_approved:
                raise ValueError("GPU ownership must be explicitly released before starting inference")
            return run(a.root, a.gpu_lock, a.max_tasks)
        elif a.command == "status":
            m = verify(a.root)
            print(json.dumps({"state": read(pathlib.Path(a.root) / "STATE.json"), "attempts": len(load_attempts(a.root, m)), "expected": len(plan(m))}))
        elif a.command == "report":
            print(json.dumps(report(a.root)))
        elif a.command == "selftest":
            return selftest(a.receipt)
        else:
            cases = selftest_cases()
            print(json.dumps(cases))
            return 0 if all(c["passed"] for c in cases) else 1
        return 0
    except (OSError, ValueError, KeyError) as error:
        print(f"Gev: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
