"""Planted regressions in a disposable copy; the calling checkout is never mutated."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import sys
import tempfile
from owned_process import run_tree

source = pathlib.Path(__file__).resolve().parents[2]
ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument('--receipt', default=str(source / 'test/subharness-adversarial-receipt.json'))
ap.add_argument('--anchors-only', action='store_true', help='validate every planted source anchor without copying or running checks')
args = ap.parse_args()
if args.anchors_only:
    root = source
else:
    disposable = tempfile.TemporaryDirectory(prefix='atlias-planted-')
    root = pathlib.Path(disposable.name) / 'source'
    shutil.copytree(source, root, symlinks=True, ignore=shutil.ignore_patterns('.git', 'node_modules', '__pycache__'))
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
    ("listing cut without its own switch", "mods/atlias-efficiency/hooks/register.mjs", "const listing = enabled && options.skillListing === true;", "const listing = enabled;"),
    ("long skill name cut", "mods/atlias-efficiency/hooks/register.mjs", "Math.max(colon + 1, line.lastIndexOf(' ', LISTING_CAP))", "line.lastIndexOf(' ', LISTING_CAP)"),
    ("another plugin's listing cut", "mods/atlias-efficiency/hooks/register.mjs", "e?.origin?.kind !== 'engine' || ", ""),
    ("memory switch omits every section", "mods/atlias-efficiency/hooks/register.mjs", "!OMIT_SECTIONS.includes(event?.name)", "false"),
    ("compact text without its switch", "mods/atlias-efficiency/hooks/register.mjs", "const compact = enabled && options.compactToolText === true;", "const compact = enabled;"),
    ("another provider's tool text rewritten", "mods/atlias-efficiency/hooks/register.mjs", "event?.provider?.plugin !== 'engine' || !Object.hasOwn", "!Object.hasOwn"),
    ("brief ignores verify.doublePass", "lib/brief.mjs", "const doublePass = !(cfg.verify && cfg.verify.doublePass === false);", "const doublePass = true;", ["node", "test/run.mjs", "the brief says when the gate will run the check"]),
    ("hooks-only brief still names tools", "lib/brief.mjs", "if (flags.hooksOnly) {", "if (false) {", ["node", "test/run.mjs", "the brief says when the gate will run the check"]),
    ("hooks-only block for every host", "lib/hosts.mjs", "if (hooksOnly && host === 'codex') return", "if (hooksOnly) return", ["node", "test/run.mjs", "each harness is called by its own name"]),
    ("lean Codex block for every host", "lib/hosts.mjs", "if (lean && host === 'codex') return", "if (lean) return", ["node", "test/run.mjs", "each harness is called by its own name"]),
    ("malformed cache count read as 0", RUNNER, 'got[name] = _count(u[key]) if _count(u[key]) is not None else "unknown"', "got[name] = _count(u[key]) or 0", LEDGER),
    ("missing window counted as matched", RUNNER, '"windowMatched": all(r.get("loadedWindow") == a.num_ctx for r in results) if results else None,', '"windowMatched": windows == [a.num_ctx] if windows else None,', LEDGER),
    ("window read only after the task", RUNNER, "seen = [w for w in [*readings, end] if w is not None]", "seen = [w for w in [end] if w is not None]", LEDGER),
    ("reload at another window matched", RUNNER, "return (asked if other is None else other), sorted(set(seen))", "return asked, sorted(set(seen))", LEDGER),
    ("upstream error text dropped", RUNNER, 'error=body[:300].decode("utf-8", errors="replace")', 'error=""', LEDGER),
    ("row marked uncounted trusted", RUNNER, 'return r.get("usageComplete") is not False and _count', "return _count", LEDGER),
    ("partial stream taken as complete", RUNNER, 'ended = ended or ev.get("type") == "message_stop"', "ended = True", LEDGER),
    ("resume drops uncounted rows", RUNNER, 'return list(json.loads(pathlib.Path(out).read_text(encoding="utf-8")).get("results", []))', 'return [r for r in json.loads(pathlib.Path(out).read_text(encoding="utf-8")).get("results", []) if isinstance(r.get("promptTotal"), int)]', LEDGER),
    ("responses count taken unchecked", RUNNER, 'p, c = _count(u.get("input_tokens")), _count(u.get("output_tokens"))', 'p, c = u.get("input_tokens"), u.get("output_tokens")', RESP),
    ("responses stream without end not partial", RUNNER, "if ended is None:", "if False:", RESP),
    ("previous_response_id let through", RUNNER, 'if body.get("previous_response_id"):', "if False:", RESP),
    ("unmetered POST path let through", RUNNER, 'if route in ("/api/show", "/v1/messages/count_tokens"):', "if True:", RESP),
    ("instructions dropped on the way", RUNNER, 'body["max_output_tokens"] = s.num_predict', 'body["max_output_tokens"] = s.num_predict; body.pop("instructions", None)', RESP),
    ("native skill capability removed", RUNNER, 'argv += ["-"]', 'argv += ["-c", "skills.include_instructions=false", "-"]', RESP),
    ("real skills root leaks into Codex", RUNNER, 'if skill_file:', 'if False:', RESP),
    ("capped call leaves no receipt", RUNNER, 's.receipts.append({"api": "messages", "stream": stream, "slot": None, "role": self._role, "outcome": "capped: answered by the door, no model call"})', "pass", LEDGER),
    ("partial spend marked measured", RUNNER, 'or door.partial or not door.usage:', 'or not door.usage:', [sys.executable, "tools/h2h/base_harness_measurement_test.py"]),
    ("invalid token count marked measured", RUNNER, 'or any(_count(v) is None for v in u) for u in door.usage)', 'for u in door.usage)', [sys.executable, "tools/h2h/base_harness_measurement_test.py"]),
    ("duplicate provider slot marked measured", RUNNER, 'or sorted(slots) != list(range(len(door.usage)))', '', [sys.executable, "tools/h2h/base_harness_measurement_test.py"]),
    ("unreceipted request marked measured", RUNNER, 'and door.calls == len(door.usage) + door.capped)', 'and True)', [sys.executable, "tools/h2h/base_harness_measurement_test.py"]),
]
# Codex's audit of 2026-10-13, F1 to F5: one planted break on the line each fix rests on.
CODEX_F = ["node", "test/run.mjs", "Codex F", "claims against evidence"]
cases += [
    ("unknown outcome clears a failure", "lib/integrity.mjs", "sameCheck(l, e) && l.outcome === 'pass'", "sameCheck(l, e) && l.outcome !== 'fail'", CODEX_F),
    ("quoted spacing collapsed", "lib/integrity.mjs", ": canonicalCommand(a.command) === canonicalCommand(b.command));", ": String(a.command).replace(/\\s+/g, ' ').trim() === String(b.command).replace(/\\s+/g, ' ').trim());", CODEX_F),
    ("checkId ignored", "lib/integrity.mjs", "a.checkId || b.checkId ? Boolean(a.checkId && b.checkId && a.checkId === b.checkId) : ", "", CODEX_F),
    ("hook records no checkId", "lib/track.mjs", "verify, ...(verify ? checkId(payload, command) : {}), ...subagentTag(payload, cfg) };", "verify, ...subagentTag(payload, cfg) };", CODEX_F),
    ("alternating window ignores edits", "lib/guard.mjs", "i > lastAlt; i--) if (evs[i].kind === 'edit' && !evs[i].failed && !revertsEarlier(evs, i)) { lastAlt = i; break; }", "i > lastAlt; i--) if (false) { lastAlt = i; break; }", CODEX_F),
    ("failed edit resets the alternating guard", "lib/guard.mjs", "&& !evs[i].failed && !revertsEarlier(evs, i)) { lastAlt = i; break; }", " && !revertsEarlier(evs, i)) { lastAlt = i; break; }", CODEX_F),
    ("positions applied without the switch", "lib/guard.mjs", "const parts = positions && !UNREADABLE.test(line) ? simpleCommands(line) : null;", "const parts = simpleCommands(line);", CODEX_F),
    # Council 1013b (b06, b07, b09): each new guard rule and the door's cut reading has a test that fails without it.
    ("positions reads a pipe into a shell", "lib/guard.mjs", "positions && !UNREADABLE.test(line)", "positions", CODEX_F),
    ("positions refuses 2>/dev/null", "lib/guard.mjs", "String(cmd).replace(HARMLESS_REDIRECT, ' ')", "cmd", CODEX_F),
    ("space before > /dev/sd slips by", "lib/guard.mjs", "|>\\s*\\/dev\\/(sd|hd|vd|xvd|nvme|mmcblk|disk)/i", "/i", ["node", "test/run.mjs", "guards"]),
    ("quoted or globbed home target slips by", "lib/guard.mjs", "[\\\\/]?\\*?[\"']?(?=$|[\\s;&|)`'\"\\\\])/, why: 'recursive delete aimed at a root", "(\"|\\s|$)/, why: 'recursive delete aimed at a root", ["node", "test/run.mjs", "guards"]),
    ("door ignores a cut reply", "tools/h2h/base_harness_runner.py", "if why in CUT_STOPS and not rec.get(\"cut\"):", "if False:", LEDGER),
    ("both open-quote protections removed", "lib/guard.mjs", ["const texts = parts && !parts.open ? parts", "if (quote) return null;"], ["const texts = parts ? parts", "/* open quote accepted */"], CODEX_F),
    ("substitution taken as read-only", "lib/guard.mjs", "if (/\\$\\(|`|<\\(/.test(part.text) || part.bare.includes('>')) return false;", "", CODEX_F),
    ("hook ignores the positions switch", "lib/guard.mjs", "destructiveReason(command, Boolean(cfg.flags && cfg.flags.guardCommandPositions === true))", "destructiveReason(command)", CODEX_F),
    ("no-check rule without its flag", "lib/brief.mjs", "if (!flags.briefNoCheckRule) return false;", "", ["node", "test/run.mjs", "no check is named"]),
    ("no-check rule where a check exists", "lib/brief.mjs", "try { return !visibleCheck(cwd, { uncertainty }) && uncertainty.length === 0; } catch { return false; }", "return true;", ["node", "test/run.mjs", "no check is named"]),
    ("tool list ignores its flag", "lib/brief.mjs", "flags.briefAllTools ? TOOLS_ALL : TOOLS_LISTED", "TOOLS_ALL", ["node", "test/run.mjs", "no check is named"]),
    ("Stop timeout back to 30", "lib/hosts.mjs", "['Stop', 'stop', 45]", "['Stop', 'stop', 30]", ["node", "test/run.mjs", "45 seconds on every host"]),
    ("ledger drops middle requests", "lib/loop.mjs", "if (state.asks.length > 20 && !exact)", "if (state.asks.length > 20)", CODEX_F),
]
TRANSITION = ['node', 'test/run.mjs', 'exact requests survive']
BATCH = ['node', 'test/run.mjs', 'native batches']
ACTORS = ['node', 'test/run.mjs', 'subagents apart']
SKILLS = ['node', 'test/run.mjs', 'skill versions']
PROTOCOL = ['node', 'test/run.mjs', 'native protocol']
cases += [
    ('off legacy load looks complete', 'lib/agent.mjs', 'missing: Boolean(c.authorityMissing || !valid)', 'missing: false', TRANSITION),
    ('off pruning looks complete', 'lib/loop.mjs', 'state.authorityMissing = true;', 'state.authorityMissing = false;', TRANSITION),
    ('immediate exact save drops private history', 'lib/agent.mjs', 'pending && Array.isArray(pending.asks) ? [...pending.asks, ...(state.asks || [])] : state.asks', 'state.asks', TRANSITION),
    ('batch permits fabricated agent identity', 'mods/atlias-transaction/hooks/register.mjs', "'consent', 'agentId',", "'consent',", BATCH),
    ('batch ignores permission refusal', 'mods/atlias-transaction/hooks/register.mjs', "if (permission?.decision === 'deny')", 'if (false)', BATCH),
    ('batch continues after tool error', 'mods/atlias-transaction/hooks/register.mjs', "results.push({ index: results.length, tool: op.tool, status, native });\n          if (status !== 'executed') { halted = status; break; }", 'results.push({ index: results.length, tool: op.tool, status, native });\n          if (false) { halted = status; break; }', BATCH),
    ('non-Read batch continues after tool error', 'mods/atlias-transaction/hooks/register.mjs', "results.push({ index: results.length, tool: op.tool, status, native: result });\n          if (status !== 'executed') { halted = status; break; }", 'results.push({ index: results.length, tool: op.tool, status, native: result });\n          if (false) { halted = status; break; }', BATCH),
    ('batch pretends uncertain effects are absent', 'mods/atlias-transaction/hooks/register.mjs', "effects: 'unknown'", "effects: 'none'", BATCH),
    ('repeat guards pool parallel actors', 'lib/guard.mjs', "eventsTail(sid).filter((e) => !cfg.flags.subagentsApart || (e.subagent || '') === (tag.subagent || ''));", 'eventsTail(sid);', ACTORS),
    ('actor edit tag is dropped', 'lib/track.mjs', "...(after ? { after } : {}), ...subagentTag(payload, cfg)", "...(after ? { after } : {})", ACTORS),
    ('main gate pools actors', 'lib/gate.mjs', 'turn: apartOn ? rest.filter(mine) : rest,', 'turn: rest,', ACTORS),
    ('worker prompt moves parent boundary', 'lib/gate.mjs', "&& (actor === null || !evs[i].subagent || evs[i].subagent === actor)", '', ACTORS),
    ('actor authority namespace is dropped', 'lib/core.mjs', "return tag.subagent && sid !== 'no-session' ? `actor-${sha(JSON.stringify([sid, tag.subagent]))}` : sid;", 'return sid;', ACTORS),
    ('oversized event loses actor', 'lib/core.mjs', "...(out.subagent ? { subagent: out.subagent } : {}), oversized: true", 'oversized: true', ACTORS),
    ('worker consumes parent gate flags', 'lib/gate.mjs', 'const metaSid = actorSession(payload, cfg);', 'const metaSid = sid;', ACTORS),
    ('Windows filesystem tick loses shell edits', 'lib/gate.mjs', 'stat(full) >= since - MTIME_SLOP_MS', 'stat(full) >= since', ACTORS),
    ('recovered check loses actor', 'lib/track.mjs', '.map((ev) => ({ ...ev, ...subagentTag(payload, config()) }))', '', ACTORS),
    ('handoff pools actor events', 'lib/progress.mjs', "!apart || (e.subagent || '') === actor", 'true', ACTORS),
    ('worker overwrites parent handoff', 'lib/progress.mjs', "config().flags.subagentsApart && actor ? `progress-actor-${sha(actor)}.md` : 'progress.md'", "'progress.md'", ACTORS),
    ('frontend hint metadata pools actors', 'lib/router.mjs', 'const metaSid = actorSession(payload, cfg);', 'const metaSid = sid;', ACTORS),
    ('worker startup overwrites parent metadata', 'lib/brief.mjs', 'const sid = actorSession(payload);', "const sid = payload.session_id || 'no-session';", ACTORS),
    ('skill versions ignore opt-in', 'lib/authority.mjs', "cfg.flags.authorityBodiesOnce && r.kind === 'skill'", "r.kind === 'skill'", SKILLS),
    ('skill versions discard amended bodies', 'lib/authority.mjs', 'JSON.stringify([r.file, r.text])', 'JSON.stringify([r.file])', SKILLS),
    ('repeated skill occurrence is dropped', 'lib/authority.mjs', 'if (first !== undefined) return title +', "if (first !== undefined) return '' +", SKILLS),
    ('native missing id executes', 'lib/loop.mjs', "typeof tc.id !== 'string' || !tc.id.trim() || ids.has(tc.id)", 'ids.has(tc.id)', PROTOCOL),
    ('native duplicate id executes', 'lib/loop.mjs', '|| ids.has(tc.id)', '', PROTOCOL),
    ('native call set has no bound', 'lib/loop.mjs', 'raw.length > MAX_NATIVE_CALLS', 'false', PROTOCOL),
    ('native protocol refusal executes text fallback', 'lib/loop.mjs', "if (res.protocolError) return stopWith", 'if (false) return stopWith', PROTOCOL),
    ('function parameter changes tool identity', 'lib/loop.mjs', "['tool', '__proto__', 'constructor', 'prototype'].includes(k)", "['__proto__', 'constructor', 'prototype'].includes(k)", PROTOCOL),
    ('provider response has no byte bound', 'lib/loop.mjs', 'if (bytes > maxBytes)', 'if (false)', PROTOCOL),
    ('provider response counts characters', 'lib/loop.mjs', "Buffer.byteLength(x, 'utf8')", 'x.length', PROTOCOL),
    ('permanent resource refusal retries', 'lib/loop.mjs', 'r.retryable !== false && (r.status === 429', '(r.status === 429', PROTOCOL),
    ('request timeout becomes retryable', 'lib/loop.mjs', "finish({ status: 0, error: 'timed out', retryable: false })", "finish({ status: 0, error: 'timed out' })", PROTOCOL),
    ('uncertain transport status retries', 'lib/loop.mjs', 'r.status === 429 || r.status >= 500', 'r.status === 429 || r.status >= 500 || r.status === 0', PROTOCOL),
    ('retry usage drops earlier attempts', 'lib/loop.mjs', 'requestUsages.push(r.json?.usage || null);', 'requestUsages.splice(0, requestUsages.length, r.json?.usage || null);', PROTOCOL),
    ('model error discards request accounting', 'lib/loop.mjs', 'Array.isArray(res?.requestUsages) ? res.requestUsages', 'Array.isArray(res?.requestUsages) ? (res.error ? [] : res.requestUsages)', PROTOCOL),
]
cases += [
    ('binary plan guard removed', 'mods/atlias-transaction/hooks/register.mjs', 'const unsupported = e.operations.find(unsupportedReadPlan);', 'const unsupported = null;', ['node', 'test/run.mjs', 'native batches']),
    ('opaque Read result accepted', 'mods/atlias-transaction/hooks/register.mjs', 'const nativeText = textReadResult(result);', 'const nativeText = result;', ['node', 'test/run.mjs', 'native batches']),
    ('later effects after opaque Read', 'mods/atlias-transaction/hooks/register.mjs', "halted = 'require-native-read';\n            break;", "halted = 'require-native-read';\n            continue;", ['node', 'test/run.mjs', 'native batches']),
    ('Read errors lose diagnostics', 'mods/atlias-transaction/hooks/register.mjs', 'native.text = result.text;', 'void result.text;', ['node', 'test/run.mjs', 'native batches']),
    ('text-only tool contract hidden', 'mods/atlias-transaction/hooks/register.mjs', 'Batch Read supports text only;', '', ['node', 'test/run.mjs', 'native batches']),
    ('malformed text body accepted', 'mods/atlias-transaction/hooks/register.mjs', "|| typeof file.content !== 'string'", '|| false', ['node', 'test/run.mjs', 'native batches']),
    ('opaque extra file fields accepted', 'mods/atlias-transaction/hooks/register.mjs', 'if (Object.keys(file).some(k => !READ_FILE_KEYS.has(k))) return null;', 'if (false) return null;', ['node', 'test/run.mjs', 'native batches']),
    ('optional native truncation flag dropped', 'mods/atlias-transaction/hooks/register.mjs', "'totalLines', 'truncatedByTokenCap']);", "'totalLines']);", ['node', 'test/run.mjs', 'native batches']),
    ('recovered checks lack identity', 'lib/track.mjs', 'verify: true, ...checkId({ cwd }, command), outcome:', 'verify: true, outcome:', ['node', 'test/run.mjs', 'transcript recovery:']),
    ('recovered identity hashes clipped command', 'lib/track.mjs', '...checkId({ cwd }, command), outcome:', '...checkId({ cwd }, clip(command, 300)), outcome:', ['node', 'test/run.mjs', 'transcript recovery:']),
]
cases += [
    ('worker batch drops the native actor boundary', 'mods/atlias-transaction/hooks/register.mjs', "if (e.agentId !== undefined && e.agentId !== null)", 'if (false)', BATCH),
    ('worker native-tool route hidden from the model', 'mods/atlias-transaction/hooks/register.mjs', 'Workers use standalone native tools through ToolSearch.', '', BATCH),
]
# Removing Windows-only clock slack has no behavioral effect on other hosts.
READ_VIEW = ['node', 'test/run.mjs', 'native read views']
cases += [
    ('Read dedup option inverted', 'mods/atlias-transaction/hooks/register.mjs', 'options.deduplicateTextReads === true', 'options.deduplicateTextReads !== true', READ_VIEW),
    ('Read dedup dispatch ignored', 'mods/atlias-transaction/hooks/register.mjs', 'compactReads ? compactTextRead(nativeText) : nativeText', 'nativeText', READ_VIEW),
    ('Read dedup contract omitted', 'mods/atlias-transaction/hooks/register.mjs', 'Exact numbered Read text is retained;', '', READ_VIEW),
    ('Read dedup accepts diagnostic text', 'mods/atlias-transaction/hooks/text-read.mjs', 'numbered(file.content, file.startLine) === native.text', 'true', READ_VIEW),
    ('Read dedup encodes without benefit', 'mods/atlias-transaction/hooks/text-read.mjs', 'Math.min(textGain, transportGain) > 0', 'true', READ_VIEW),
    ('Read dedup ignores count mismatch', 'mods/atlias-transaction/hooks/text-read.mjs', "if (file.numLines !== file.content.split('\\n').length) return native;", 'if (false) return native;', READ_VIEW),
    ('Read decoder ignores count mismatch', 'mods/atlias-transaction/hooks/text-read.mjs', "if (file.numLines !== content.split('\\n').length) return null;", 'if (false) return null;', READ_VIEW),
    ('Read dedup discards truncation metadata', 'mods/atlias-transaction/hooks/text-read.mjs', '...file, content: { from:', 'filePath: file.filePath, numLines: file.numLines, startLine: file.startLine, totalLines: file.totalLines, content: { from:', READ_VIEW),
    ('Read decoder ignores line prefix', 'mods/atlias-transaction/hooks/text-read.mjs', 'if (!lines[index].startsWith(prefix)) return null;', 'if (false) return null;', READ_VIEW),
    ('Read decoder drops CR characters', 'mods/atlias-transaction/hooks/text-read.mjs', 'content = restored.join', "content = restored.map(line => line.replace(/\\r/g, '')).join", READ_VIEW),
    ('Read decoder accepts unknown source', 'mods/atlias-transaction/hooks/text-read.mjs', "recipe.from !== 'native.text'", 'false', READ_VIEW),
]
cases += [
    ('unknown check accepted as pass evidence', 'lib/integrity.mjs', "} else if (!passingVerification(turn)) {", '} else if (false) {', ['node', 'test/run.mjs', 'claims against evidence']),
    ('unknown check suppresses gate verification', 'lib/gate.mjs', '!integrity.passingVerification(turn)', '!turn.some(integrity.isVerifyEvent)', ['node', 'test/run.mjs', 'when the gate wants']),
    ('unknown check satisfies edit verification', 'lib/integrity.mjs', "isVerifyEvent(e) && (e.kind === 'tool' || e.outcome === 'pass' || e.outcome === 'fail')", 'isVerifyEvent(e)', ['node', 'test/run.mjs', 'claims against evidence']),
    ('malformed native error means executed', 'mods/atlias-transaction/hooks/register.mjs', "if (result.isError !== false) return 'unknown';", 'if (false) return \'unknown\';', ['node', 'test/run.mjs', 'native batches']),
    ('missing native result means executed', 'mods/atlias-transaction/hooks/register.mjs', " && result.result !== undefined && result.result !== null", '', ['node', 'test/run.mjs', 'native batches']),
    ('native tools hidden without ToolSearch', 'mods/atlias-transaction/hooks/register.mjs', "if (!names.includes('ToolSearch')) return next(e);", 'if (false) return next(e);', ['node', 'test/run.mjs', 'native batches']),
]
if os.name != 'nt':
    cases = [c for c in cases if c[0] != 'Windows filesystem tick loses shell edits']
# Validate all anchors before spending time on the first planted execution.
for name, rel, old, new, *_ in cases:
    text = (root / rel).read_bytes().decode("utf-8").replace("\r\n", "\n")
    if isinstance(old, list) and (not isinstance(new, list) or len(old) != len(new)):
        raise RuntimeError(f"mutation replacements do not match anchors: {name}")
    changes = zip(old, new) if isinstance(old, list) else [(old, new)]
    for needle, replacement in changes:
        if text.count(needle) != 1:
            raise RuntimeError(f"mutation anchor not unique: {name}")
        text = text.replace(needle, replacement, 1)
if args.anchors_only:
    print(json.dumps({"anchors": len(cases), "passed": True, "execution": False}))
    sys.exit(0)

rows = []
original_hashes = {rel: hashlib.sha256((source / rel).read_bytes()).hexdigest() for _, rel, *_ in cases}
for name, rel, old, new, *cmd in cases:
    p = root / rel
    if not p.resolve().is_relative_to(root.resolve()):
        raise RuntimeError('mutation target escapes the disposable copy')
    before = p.read_bytes()
    try:
        text = before.decode("utf-8").replace("\r\n", "\n")
        changes = zip(old, new) if isinstance(old, list) else [(old, new)]
        for needle, replacement in changes:
            if text.count(needle) != 1:
                raise RuntimeError(f"mutation anchor not unique: {name}")
            text = text.replace(needle, replacement, 1)
        p.write_bytes(text.encode("utf-8"))
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
for cmd in (NODE, LEDGER, RESP, [sys.executable, "tools/h2h/base_harness_measurement_test.py"]):
    with tempfile.TemporaryFile() as out:
        rc, timed = run_tree(cmd, cwd=str(root), timeout=180, stdout=out)
        out.seek(0)
        print(out.read().decode("utf-8", errors="replace")[-400:], flush=True)
    restored.append((rc, timed))
rc = max(abs(r) for r, _ in restored)
timed = any(t for _, t in restored)
source_intact = all(hashlib.sha256((source / rel).read_bytes()).hexdigest() == digest for rel, digest in original_hashes.items())
receipt = {"mutations": rows, "restoredFunctionalExit": rc, "restoredFunctionalTimeout": timed, "sourceIntact": source_intact}
target = pathlib.Path(args.receipt).resolve()
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(json.dumps(receipt, indent=2).encode("utf-8"))
if not all(r["caught"] for r in rows) or rc != 0 or timed or not source_intact:
    sys.exit(1)
