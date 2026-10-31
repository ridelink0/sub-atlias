// PostToolUse and SubagentStop: record what changed, and speak for one reason
// only - a whole file was read that the knowledge graph could have answered
// (lib/pointer.mjs, which is silent unless every one of its conditions holds).
import path from 'node:path';
import { config, recordEvent, filesFromTool, commandFromTool, isEditTool, isShellTool, looksLikeVerification, isCodeFile, clip, exists, graphPath, readTail, readText, sha, subagentTag, actorSession } from './core.mjs';
import * as authority from './authority.mjs';
import * as graph from './graph.mjs';
import * as integrity from './integrity.mjs';
import * as pointer from './pointer.mjs';
import { turnEvents } from './gate.mjs';
import { projectCodexChecks } from './codex-transcript.mjs';

// flags.checkFailDominates: which check an event is, from its whole command and
// directory, so two long commands sharing their first 300 characters, or one
// command run in two directories, are not taken for one (Codex's audit F2).
const checkId = (payload, command) => (integrity.failDominates() ? { checkId: sha(`${payload.cwd || process.cwd()}\n${integrity.canonicalCommand(command)}`) } : {});
// The hash of a file's content as an edit left it, keyed by its path: guard.mjs (revertsEarlier)
// treats a landed edit whose hash matches an earlier one as a revert. Null when the file is unreadable.
const contentHash = (file) => { const text = readText(file); return text === null ? null : sha(`${file}\n${text}`); };

// Running a program this turn edited is checking it, the rule atlias's own loop
// has used since 3.x (lib/loop.mjs); printing it is not. The hooks did not
// have it, so in Claude Code `python -c "from main import f; print(f(3))"`
// after an edit to main.py counted as no check, and the gate held a reply that
// had checked its work. The file must be named as a file (main.py, app.js) or
// imported as a module (from main import, import main, require('./main')).
export const RUNNER = /(?:^|[\s;&|(\\/"'])(?:node|python[\d.]*|py|deno|bun|tsx|ts-node|ruby|perl|php|bash|sh|pwsh|powershell)(?:\.exe)?["']?\s/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function runsEditedFile(command, edited) {
  const cmd = String(command || '');
  if (!RUNNER.test(cmd)) return false;
  for (const f of edited || []) {
    // Split on both separators: a hook on Linux can carry a Windows path, and
    // path.basename there would keep the whole of it.
    const base = String(f).split(/[\\/]/).pop() || '';
    const stem = base.replace(/\.[^.]+$/, '');
    if (!stem) continue;
    if (new RegExp(`(^|[\\s"'\\\\/=(])${escapeRe(base)}($|[\\s"');&|])`).test(cmd)) return true;
    if (new RegExp(`\\b(from\\s+${escapeRe(stem)}\\s+import|import\\s+${escapeRe(stem)}\\b|require\\(\\s*["'][./\\\\]*${escapeRe(stem)}(\\.[a-z]+)?["']\\s*\\))`).test(cmd)) return true;
  }
  return false;
}
function editedThisTurn(sid, actor) {
  const out = [];
  for (const e of turnEvents(sid, actor).turn) if (e.kind === 'edit') out.push(...(e.files || []));
  return out;
}
// `edited`, when given, is the turn's edited files as the caller knows them
// (the transcript recovery below); otherwise the event log is asked.
export function isCheck(command, sid, edited = null, actor) {
  if (looksLikeVerification(command)) return true;
  // The event log is read only for a command that runs an interpreter at all.
  return RUNNER.test(String(command || '')) && runsEditedFile(command, edited || editedThisTurn(sid, actor));
}

export function postTool(payload, host) {
  const cfg = config();
  const sid = payload.session_id || 'no-session';
  const cwd = payload.cwd || process.cwd();
  const tool = String(payload.tool_name || '');
  const input = payload.tool_input || {};
  const native = host === 'codex' && typeof payload.tool_use_id === 'string' && typeof payload.turn_id === 'string'
    ? { codexId: payload.tool_use_id, codexTurnId: payload.turn_id } : {};
  if (cfg.flags.authorityLedger && /^(Read|read_file)$/i.test(tool) && !payload.tool_response?.is_error) {
    const file = input.file_path || input.path;
    if (typeof file === 'string' && /(?:^|[\\/])SKILL\.md$/i.test(file)) {
      const resolved = path.resolve(cwd, file);
      const text = readText(resolved);
      if (text !== null) authority.skill(actorSession(payload, cfg), resolved, text);
    }
  }
  if (cfg.flags.authorityLedger && tool === 'Skill' && !payload.tool_response?.is_error) {
    const response = payload.tool_response;
    const text = typeof response === 'string' ? response : typeof response?.content === 'string' ? response.content : Array.isArray(response?.content) ? response.content.map((p) => p.text || '').join('\n') : '';
    const base = /^Base directory for this skill:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (base) {
      const file = path.resolve(cwd, base, 'SKILL.md');
      const original = readText(file);
      if (original !== null) authority.skill(actorSession(payload, cfg), file, original);
    }
  }
  if (isEditTool(tool)) {
    const files = filesFromTool(tool, input);
    if (files.length) {
      // flags.guardResetOnEdit (council 1013b, b03, b05): the failed mark and the content hash are written
      // only under the flag, so a flag-off event is the same line as before 19b92cb.
      const flagged = cfg.flags.guardResetOnEdit === true;
      const failed = flagged && Boolean(payload.tool_response?.is_error);
      const after = flagged && !failed && files.length === 1 ? contentHash(path.resolve(cwd, String(files[0]))) : null;
      recordEvent(sid, { kind: 'edit', tool, files, ...(failed ? { failed: true } : {}), ...(after ? { after } : {}), ...native, ...subagentTag(payload, cfg) });
      if (cfg.graph.autoUpdate && files.some(isCodeFile) && exists(graphPath(cwd))) graph.scheduleUpdate(cwd);
    }
    return null;
  }
  if (isShellTool(tool)) {
    const command = commandFromTool(tool, input);
    if (cfg.flags.authorityLedger && !payload.tool_response?.is_error) {
      const output = typeof payload.tool_response === 'string' ? payload.tool_response : payload.tool_response?.output || payload.tool_response?.stdout || '';
      // Retain only a skill file named by the command whose complete bytes were
      // returned by the tool. Merely mentioning a skill path is not selection.
      const named = [...String(command).matchAll(/(?:"([^"\r\n]*[\\/]SKILL\.md)"|'([^'\r\n]*[\\/]SKILL\.md)'|([^\s"']+[\\/]SKILL\.md))/gi)];
      for (const match of named) {
        const file = path.resolve(cwd, match[1] || match[2] || match[3]);
        const original = readText(file);
        if (original && String(output).replace(/\r\n/g, '\n').includes(original.replace(/\r\n/g, '\n'))) authority.skill(actorSession(payload, cfg), file, original);
      }
    }
    if (command) {
      const verify = isCheck(command, sid, null, subagentTag(payload, cfg).subagent);
      const ev = { kind: 'shell', command: clip(command, 300), verify, ...(verify ? checkId(payload, command) : {}), ...native, ...subagentTag(payload, cfg) };
      // A check is only evidence if we know how it came out, so the gate can
      // hold "the tests pass" against the run that said otherwise.
      if (verify) {
        const v = integrity.verdict(payload);
        ev.outcome = v.outcome;
        if (v.excerpt) ev.excerpt = clip(v.excerpt, 200);
      }
      recordEvent(sid, ev);
      // Preserve terminal native evidence as it appears, before a long Codex
      // turn can move it out of the bounded transcript tail. A journal that
      // has not flushed the completion yet simply leaves this hook unknown.
      if (host === 'codex' && payload.transcript_path && native.codexId) {
        try {
          const current = turnEvents(sid, subagentTag(payload, cfg).subagent);
          recoverCodexChecks(payload, current.turn, { promptAt: current.promptAt });
        } catch { /* missing or pending native evidence remains unknown */ }
      }
    }
  }
  // The one thing PostToolUse ever says: a whole file was read that the graph
  // could have answered. Silent unless every condition in pointer.consider
  // holds, so the common path still costs one regex and a stat.
  return pointer.postTool(payload, cfg);
}

// PostToolUseFailure: the tool call itself failed. For a check, that is a
// failed check, and it is recorded as one.
export function postToolFailure(payload, host) {
  const sid = payload.session_id || 'no-session';
  const tool = String(payload.tool_name || '');
  if (!isShellTool(tool)) return null;
  const command = commandFromTool(tool, payload.tool_input || {});
  if (!command) return null;
  const tag = subagentTag(payload, config());
  const native = host === 'codex' && typeof payload.tool_use_id === 'string' && typeof payload.turn_id === 'string'
    ? { codexId: payload.tool_use_id, codexTurnId: payload.turn_id } : {};
  recordEvent(sid, { kind: 'shell', command: clip(command, 300), verify: isCheck(command, sid, null, tag.subagent), ...checkId(payload, command), outcome: 'fail', excerpt: clip(String(payload.error || payload.tool_error || 'the tool reported a failure'), 200), ...native, ...tag });
  return null;
}

// ---------- checks the transcript saw and the log did not ----------
// Under the load of the 2026-09-28 study Claude Code cancelled 80 atlias hook
// calls in 22 of 34 runs. A cancelled PostToolUse leaves a check that ran with
// no record, so the gate said "no check ran" and held a reply that had checked
// its work, one more full-context round. Claude Code hands Stop the session
// transcript, JSONL like the one progress.compactSummary reads: an assistant
// row holds tool_use blocks, a later user row the tool_result for each, with
// is_error set and "Exit code N" leading the content when a command failed
// (seen in this machine's transcripts). Only the tail is read, and a tail that
// does not read cleanly is no answer at all: a half-written last line could be
// the edit that came after the check.
export const TRANSCRIPT_TAIL = 2 * 1024 * 1024;
export function transcriptTurn(transcriptPath, bytes = TRANSCRIPT_TAIL) {
  if (!transcriptPath) return null;
  const text = readTail(transcriptPath, bytes);
  if (!text) return null;
  let calls = [];
  let seen = false;
  const results = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { return null; }
    if (!row || typeof row !== 'object' || row.isSidechain) continue;
    const content = row.message && row.message.content;
    if (row.type === 'assistant' && Array.isArray(content)) {
      seen = true;
      for (const b of content) if (b && b.type === 'tool_use') calls.push(b);
    } else if (row.type === 'user' && content != null) {
      seen = true;
      const blocks = Array.isArray(content) ? content : [];
      const answered = blocks.filter((b) => b && b.type === 'tool_result');
      for (const b of answered) results.set(b.tool_use_id, { block: b, row });
      // A prompt starts the turn over; tool results and meta rows do not.
      if (!answered.length && !row.isMeta && !row.isCompactSummary) { calls = []; results.clear(); }
    }
  }
  if (!seen) return null;
  return calls.map((c) => ({ name: String(c.name || ''), input: c.input || {}, result: results.get(c.id) || null }));
}

// How a transcript tool result came out, by the rules the hooks use: a failed
// call is a failed check (postToolFailure), anything else goes to verdict.
export function transcriptVerdict(result) {
  const b = result.block;
  const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('\n') : '';
  if (b.is_error) {
    const m = text.match(/^Exit code (\d+)/);
    if (m) return integrity.verdict({ tool_response: { stdout: text.slice(m[0].length), exit_code: Number(m[1]) } });
    return { outcome: 'fail', excerpt: clip(text.trim() || 'the tool reported a failure', 200) };
  }
  const r = result.row.toolUseResult;
  return integrity.verdict({ tool_response: r && typeof r === 'object' ? r : text });
}

const samePath = (cwd) => (f) => path.resolve(cwd, String(f)).replace(/\\/g, '/').toLowerCase();

// The checks after the turn's last edit that the transcript shows, as shell
// events shaped like the ones postTool records. Empty unless the transcript
// holds every edit the log has for this turn, so it cannot miss the edit that
// came after its check. And the log's order has the last word: a check counts
// only if its result is stamped after the last edit the log recorded. A
// subagent's edit reaches the log through its own hook but not this transcript
// (Claude Code writes a subagent's transcript to a file of its own), and a row
// with no time cannot be placed.
export function checksFromTranscript(transcriptPath, { cwd, sid, turn }) {
  const calls = transcriptTurn(transcriptPath);
  if (!calls) return [];
  const norm = samePath(cwd);
  const recorded = [];
  let since = 0;
  for (const e of turn) if (e.kind === 'edit') { recorded.push(...(e.files || [])); if (e.t > since) since = e.t; }
  const edited = [];
  let lastEdit = -1;
  calls.forEach((c, i) => { if (isEditTool(c.name)) { lastEdit = i; edited.push(...filesFromTool(c.name, c.input)); } });
  const known = new Set(edited.map(norm));
  if (!recorded.every((f) => known.has(norm(f)))) return [];
  const out = [];
  for (const c of calls.slice(lastEdit + 1)) {
    if (!isShellTool(c.name) || !c.result) continue;
    if (since && !(Date.parse(c.result.row.timestamp) > since)) continue;
    const command = commandFromTool(c.name, c.input);
    if (!command || !isCheck(command, sid, recorded.concat(edited))) continue;
    const v = transcriptVerdict(c.result);
    const ev = { kind: 'shell', command: clip(command, 300), verify: true, ...checkId({ cwd }, command), outcome: v.outcome, from: 'transcript' };
    if (v.excerpt) ev.excerpt = clip(v.excerpt, 200);
    out.push(ev);
  }
  return out;
}

// Records what checksFromTranscript found and adds it to the turn in hand, so
// the gate and everything after it read it as a recorded check.
export function recoverChecks(payload, turn) {
  const sid = payload.session_id || 'no-session';
  const found = checksFromTranscript(payload.transcript_path, { cwd: payload.cwd || process.cwd(), sid, turn }).map((ev) => ({ ...ev, ...subagentTag(payload, config()) }));
  for (const ev of found) {
    recordEvent(sid, ev);
    turn.push({ t: Date.now(), ...ev });
  }
  return found;
}

export function recoverCodexChecks(payload, turn, options = {}) {
  const sid = payload.session_id || 'no-session';
  const projected = projectCodexChecks(payload, turn, {
    ...options, isCheck: (command, edited) => isCheck(command, sid, edited),
  });
  if (!projected) return [];
  const cfg = config();
  const found = projected.recovered.filter(e => !turn.some(old => old.from === 'codex-transcript' && old.codexId === e.codexId && old.t === e.t && old.outcome === e.outcome));
  for (const event of found) recordEvent(sid, { ...event, ...subagentTag(payload, cfg) });
  turn.splice(0, turn.length, ...projected.events);
  return found;
}

export function subagentStop(payload) {
  const sid = payload.session_id || 'no-session';
  recordEvent(sid, { kind: 'subagent', agent: payload.agent_type || payload.agent_id || 'unknown', summary: clip(payload.last_assistant_message || '', 200) });
  return null;
}
