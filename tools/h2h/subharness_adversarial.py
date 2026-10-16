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
    ('opaque Read result accepted', 'mods/atlias-transaction/hooks/register.mjs', 'const nativeText = textReadResult(result) || (unchangedReads ? unchangedReadResult(result) : null);', 'const nativeText = result;', ['node', 'test/run.mjs', 'native batches']),
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
HOT = ['node', 'test/run.mjs', 'hot core keeps']
TX = 'mods/atlias-transaction/hooks/register.mjs'
cases += [
    ('hot core ignores its own switch', TX, 'const hotCore = defer && options.hotCoreTools === true;', 'const hotCore = defer;', HOT),
    ('hot core acts without deferral', TX, 'const hotCore = defer && options.hotCoreTools === true;', 'const hotCore = enabled && options.hotCoreTools === true;', HOT),
    ('hot core tools still deferred', TX, ' && !(hotCore && hot.includes(n))', '', HOT),
    ('hot core advertises names not deferred', TX, "'\\nNative tools deferred by this mod: ' + available.join(', ') + '. Load one with select:<name> before calling it directly. ' + ENVELOPE_NOTE", "'\\nNative tools deferred by this mod: ' + DEFERRED.join(', ') + '. Load one with select:<name> before calling it directly. ' + ENVELOPE_NOTE", HOT),
    ('hot core adds text when nothing is deferred', TX, 'return available.length ? {', 'return true ? {', HOT),
    ('batch envelope boundary omitted', TX, "  + ' ' + ENVELOPE_NOTE;", '  ;', HOT),
    ('ToolSearch envelope boundary omitted', TX, " + ENVELOPE_NOTE.replace('only this batch', 'only the batch') }", " }", HOT),
    ('visible Read still routed through ToolSearch', TX, ".replace('Use standalone Read through ToolSearch for those inputs.'", ".replace('Use standalone Read via ToolSearch for those inputs.'", HOT),
    ('hot core text lost without Read dedup', TX, "All file metadata is retained.' } : base;", "All file metadata is retained.' } : SPEC;", HOT),
]
SHAPES = ['node', 'test/run.mjs', 'unfamiliar native descriptor']
cases += [
    ('unfamiliar descriptor is edited', TX, "    if (!result || typeof result !== 'object' || Array.isArray(result) || ![Object.prototype, null].includes(Object.getPrototypeOf(result))) return result;\n", '', SHAPES),
    ('class descriptor is edited', TX, " || ![Object.prototype, null].includes(Object.getPrototypeOf(result))) return result;", ') return result;', SHAPES),
    ('non-string ToolSearch text is edited', TX, "    if (e.tool === 'ToolSearch' && typeof result.description !== 'string') return result;\n", '', SHAPES),
]
UNCHANGED = ['node', 'test/run.mjs', 'unchanged-file Read notice']
cases += [
    ('unchanged notice ignores its switch', TX, 'textReadResult(result) || (unchangedReads ? unchangedReadResult(result) : null)', 'textReadResult(result) || unchangedReadResult(result)', UNCHANGED),
    ('unchanged switch accepts non-true values', TX, 'const unchangedReads = enabled && options.unchangedReads === true;', 'const unchangedReads = enabled && !!options.unchangedReads;', UNCHANGED),
    ('unchanged notice accepts extra file fields', TX, "if (!exactFields(file, ['filePath'])", 'if (!plainRecord(file)', UNCHANGED),
    ('unchanged notice accepts other types', TX, " || body.type !== 'file_unchanged') return null;", ') return null;', UNCHANGED),
    ('unchanged notice accepts extra top-level fields', TX, "if (!exactFields(result, ['result', 'text'])", 'if (!plainRecord(result)', UNCHANGED),
    ('unchanged notice accepts inherited fields', TX, "Object.hasOwn(value, name) && 'value' in Object.getOwnPropertyDescriptor(value, name)\n      && Object.getOwnPropertyDescriptor(value, name).enumerable", 'name in value', UNCHANGED),
    ('unchanged notice accepts non-enumerable fields', TX, "\n      && Object.getOwnPropertyDescriptor(value, name).enumerable", '', UNCHANGED),
    ('unchanged notice accepts accessor fields', TX, " && 'value' in Object.getOwnPropertyDescriptor(value, name)", '', UNCHANGED),
    ('unchanged notice accepts class payloads', TX, " && [Object.prototype, null].includes(Object.getPrototypeOf(value));\n}\n\nfunction exactFields", ';\n}\n\nfunction exactFields', UNCHANGED),
    ('unchanged notice accepts an empty path', TX, " || !file.filePath.length) return null;", ') return null;', UNCHANGED),
]
METER_FILE = 'mods/atlias-meter/hooks/meter.mjs'
METER_HOOKS = 'mods/atlias-meter/hooks/register.mjs'
LEDGER = ['node', 'test/run.mjs', 'exact ledger keeps unknown counts']
cases += [
    ('ledger reads an unusable count as zero', METER_FILE, 'const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);', 'const count = (v) => (Number.isFinite(v) && v > 0 ? v : 0);', LEDGER),
    ('ledger accepts fractional counts', METER_FILE, 'const count = (v) => (Number.isSafeInteger(v) && v >= 0', 'const count = (v) => (Number.isFinite(v) && v >= 0', LEDGER),
    ('spend hides requests without a count', METER_FILE, '  for (const s of Object.values(out)) if (s.unknown) for', '  for (const s of Object.values(out)) if (false) for', LEDGER),
    ('ledger stores argument values', METER_FILE, 'keys: argKeys(t && t.input) }', 'keys: argKeys(t && t.input), input: t && t.input }', LEDGER),
    ('ledger stores the answer text', METER_FILE, "    stopReason: result && typeof result.stopReason === 'string' ? result.stopReason : null,\n", "    stopReason: result && typeof result.stopReason === 'string' ? result.stopReason : null, answer: result && result.answer,\n", LEDGER),
    ('peak and total leave out cache reads', METER_FILE, 'const one = u.input + u.cacheRead + u.cacheWrite + u.output;', 'const one = u.input + u.cacheWrite + u.output;', LEDGER),
    ('a missing cache count is treated as known', METER_FILE, 'const known = (u) => !!u && u.input !== null && u.output !== null && u.cacheRead !== null && u.cacheWrite !== null;', 'const known = (u) => !!u && u.input !== null && u.output !== null;', LEDGER),
    ('the batch tool counts as a wrapped call', METER_FILE, "      else if (t.keys && t.keys.length === 1 && t.keys[0] === 'args') bump('wrapped-args');", "      if (t.keys && t.keys.length === 1 && t.keys[0] === 'args') bump('wrapped-args');", LEDGER),
    ('a truthy is_error string counts as an error', METER_FILE, "block.type === 'tool_result' && block.is_error === true", "block.type === 'tool_result' && block.is_error", LEDGER),
    ('subagent requests are counted as main', METER_FILE, "role: agentId ? 'subagent' : 'main'", "role: 'main'", LEDGER),
    ('a meter failure breaks the step', METER_HOOKS, '    } catch { /* the result goes on as the engine streamed it */ }', '    } catch (err) { throw err; }', LEDGER),
    ('the summed line hides that it is a lower bound', METER_FILE, '  if (tally.incomplete) lines.push(', '  if (false) lines.push(', ['node', 'test/run.mjs', 'meter: counting is exact']),
    ('a missing usage is not marked incomplete', METER_FILE, '    tally.incomplete = (tally.incomplete || 0) + 1;\n    return tally;', '    return tally;', ['node', 'test/run.mjs', 'meter: counting is exact']),
    ('a count that is not whole is complete', METER_FILE, '.every(whole)) tally.incomplete', '.every(() => true)) tally.incomplete', ['node', 'test/run.mjs', 'meter: counting is exact']),
    ('the table prints zero for an unknown total', METER_FILE, "const show = (v) => (v === null ? 'unknown' : String(v));", 'const show = (v) => String(v || 0);', LEDGER),
]
# Codex whole-audit fixes (patch v2, 6a2a892), integrated on this branch: one plant per fixed line.
cases += [
    ('an empty authority ledger is called complete', 'lib/agent.mjs', 'complete: !state.authorityMissing && requests.length > 0 }', 'complete: !state.authorityMissing }', ['node', 'test/run.mjs', 'codex authority']),
    ('a failed pinned launch is marked started', 'lib/agent.mjs', "  if (r.status !== 0 || r.error) return `claude failed:", "  state.started = true;\n  if (r.status !== 0 || r.error) return `claude failed:", ['node', 'test/run.mjs', 'engine handshake']),
    ('provisional output usage counts as final', 'lib/subharness.mjs', 'tokens: terminal && !broken && outputFinal ?', 'tokens: terminal && !broken ?', ['node', 'test/run.mjs', 'public subharness']),
    ('a restarted message keeps its earlier usage', 'lib/subharness.mjs', '        if (started || terminal) broken = true;\n', '', ['node', 'test/run.mjs', 'public subharness']),
    ('a malformed MCP frame reaches dispatch', 'mcp/server.mjs', "  if (!msg || typeof msg !== 'object'", "  if (false && typeof msg !== 'object'", ['node', 'test/run.mjs', 'mcp server']),
]
# Whole-audit A5: a failed git call must leave the integrity check unfinished, not clean.
INTEGRITY_E2E = ['node', 'test/run.mjs', 'the gate on a real repository']
cases += [
    ('a failed git diff reads as a clean diff', 'lib/integrity.mjs', 'incomplete: d.status !== 0 || u.status !== 0 || unread }', 'incomplete: d.status === null || u.status === null || unread }', INTEGRITY_E2E),
    ('an unreadable new file is skipped as checked', 'lib/integrity.mjs', '} catch { unread = true; continue; }', '} catch { continue; }', INTEGRITY_E2E),
    ('a failed git grep reads as no references', 'lib/integrity.mjs', 'if (r.status !== 0 && r.status !== 1) { status.incomplete = true; continue; }', 'if (r.status !== 0 && r.status !== 1) continue;', INTEGRITY_E2E),
]
# Whole-audit A7: a sandbox worktree that could not be read is kept, and an unknown git status refuses.
SANDBOX_DECISION = ['node', 'test/run.mjs', 'take it or drop it']
cases += [
    ('an unreadable worktree is removed as unchanged', 'lib/sandbox.mjs', '  if (unread && exists(box.dir)) return', '  if (false && exists(box.dir)) return', SANDBOX_DECISION),
    ('a failed git diff in the sandbox reads as an empty patch', 'lib/sandbox.mjs', 'error: failed ? oops(failed) : null }', 'error: null }', SANDBOX_DECISION),
    ('a failed git status reads as a clean tree', 'lib/sandbox.mjs', '.filter(Boolean) : null;', '.filter(Boolean) : [];', SANDBOX_DECISION),
    ('an unknown tree status is not refused', 'lib/sandbox.mjs', '  if (dirty === null) return', '  if (false) return', SANDBOX_DECISION),
]
# Batch 2a: meter safe-integer bounds and Codex's turn-authority delta (dd38b382).
cases += [
    ('an unsafe count is accepted as exact', METER_FILE, 'const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);', 'const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);', LEDGER),
    ('an unsafe running total stays exact', METER_FILE, '    if (!Number.isSafeInteger(one) || !Number.isSafeInteger(s.total + one)) { s.unknown += 1; continue; }\n', '', LEDGER),
    ('the summed line hides unsafe sums', METER_FILE, '  if (!Object.values(tally.usage).every(Number.isSafeInteger)) tally.unsafe = true;\n', '', LEDGER),
    ('a lost ledger is not detected before the router records the follow-up', 'lib/agent.mjs', "    try { if (!ledger.read(state.sid).some(r => r.kind === 'request')) state.authorityMissing = true; }", '    try { }', ['node', 'test/run.mjs', 'codex authority']),
    ('helpers run on incomplete authority', 'lib/agent.mjs', 'const planned = exact && state.authorityMissing ? { ran: false } :', 'const planned = false ? { ran: false } :', ['node', 'test/run.mjs', 'codex authority']),
]
# Audit A1 (Codex-approved): a partial Anthropic reading is an unknown prompt.
CACHE = ['node', 'test/run.mjs', 'what the provider says it served from cache']
cases += [
    ('a missing input reads as a whole prompt', 'lib/loop.mjs', 'const parts = [input, field(', 'const parts = [input || 0, field(', CACHE),
    ('a malformed cache field reads as zero', 'lib/loop.mjs', "const field = (k) => (k in usage ? n(usage[k]) : 0);", "const field = (k) => (n(usage[k]) || 0);", CACHE),
    ('an unknown prompt counts toward the cache rate', 'lib/loop.mjs', 'if (!r || r.cached === null || r.prompt === null) { c.silent++; return c; }', 'if (!r || r.cached === null) { c.silent++; return c; }', CACHE),
]
# Audit A3 (Codex-approved): totals and peak are exact only when every round and every run has a count.
TOKENS = ['node', 'test/run.mjs', 'a run counts the engine tokens it spent']
cases += [
    ('a silent round is summed as zero in a task total', 'lib/eval.mjs', 'xs.length > 0 && xs.every((x) => Number.isSafeInteger(x) && x >= 0) && ', 'xs.length > 0 && ', TOKENS),
    ('exact totals ignore their default-off flag', 'lib/eval.mjs', 'const exactTotals = config().flags?.exactTokenTotals === true;', 'const exactTotals = true;', TOKENS),
    ('a partial per-round list is read as a run total', 'lib/eval.mjs', 'r[list].length && r[list].every(whole) ?', 'r[list].length && r[list].some(whole) ?', TOKENS),
]
# Sprint E2: deferShell (default off) defers the shells' schemas under hot core.
HOTCORE_SUITE = ['node', 'test/run.mjs', 'hot core keeps the common native tools']
cases += [
    ('deferShell accepts values other than true', 'mods/atlias-transaction/hooks/register.mjs', "hotCore && options.deferShell === true ?", "hotCore && options.deferShell ?", HOTCORE_SUITE),
    ('deferShell defers nothing', 'mods/atlias-transaction/hooks/register.mjs', "HOT_CORE.filter(n => n !== 'Bash' && n !== 'PowerShell')", 'HOT_CORE', HOTCORE_SUITE),
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
