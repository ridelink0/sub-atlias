// Codex's native execution journal supplies the exit status its Bash-shaped
// hook payload omits. Never interpret stdout or an outer functions.exec reply
// as an execution record: only typed, scoped native item_completed rows count.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTail, clip, sha, config } from './core.mjs';
import * as integrity from './integrity.mjs';

export const CODEX_TRANSCRIPT_TAIL = 2 * 1024 * 1024;
const milliseconds = value => Number.isFinite(value) && value >= 0 ? value : null;
const normalPath = value => { const file = path.resolve(String(value)).replace(/^\\\\\?\\/, '').replace(/\\/g, '/'); return process.platform === 'win32' ? file.toLowerCase() : file; };
const textContent = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(p => p && typeof p.text === 'string' ? p.text : '').join('\n') : '';

export function parseCodexItems(text, { turnId, sessionId, since = 0 } = {}) {
  if (typeof turnId !== 'string' || !turnId || typeof sessionId !== 'string' || !sessionId || typeof text !== 'string' || !text.trim()) return null;
  const items = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { return null; }
    const p = row?.payload;
    if (row?.type !== 'event_msg' || p?.type !== 'item_completed' || p.turn_id !== turnId) continue;
    if (sessionId && p.thread_id !== sessionId) continue;
    const item = p.item;
    if (!item || typeof item.id !== 'string' || !item.id) continue;
    const end = milliseconds(p.completed_at_ms);
    const start = milliseconds(p.started_at_ms);
    if (end === null || end < since || (start !== null && start > end)) continue;
    items.push({ item, start, end });
  }
  return items;
}

export function readCodexItems(file, options) {
  const recent = parseCodexItems(readTail(file, CODEX_TRANSCRIPT_TAIL), options);
  if (!recent) return null;
  const seen = new Set(recent.map(r => r.item.id));
  const missing = [...new Set(options?.neededIds || [])].filter(id => typeof id === 'string' && id && !seen.has(id));
  if (!missing.length) return recent;
  // Resolve only known pending execution IDs outside the fast tail. Read the
  // real journal with bounded buffers; printed tool output is still ignored.
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, chunk = Buffer.alloc(64 * 1024);
    let offset = 0, pending = Buffer.alloc(0), skipping = false;
    const older = [];
    while (offset < size) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (!count) break;
      offset += count;
      const bytes = Buffer.concat([pending, chunk.subarray(0, count)]);
      let start = 0, end;
      while ((end = bytes.indexOf(10, start)) >= 0) {
        if (!skipping) {
          const line = bytes.subarray(start, end).toString('utf8');
          if (missing.some(id => line.includes(id))) {
            const records = parseCodexItems(line, options);
            if (!records) return null;
            older.push(...records.filter(r => missing.includes(r.item.id)));
          }
        }
        skipping = false; start = end + 1;
      }
      pending = bytes.subarray(start);
      if (pending.length > CODEX_TRANSCRIPT_TAIL) { pending = Buffer.alloc(0); skipping = true; }
    }
    return older.concat(recent);
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function codexCommand(item) {
  if (!Array.isArray(item?.command) || !item.command.length || !item.command.every(v => typeof v === 'string')) return '';
  const argv = item.command;
  const shell = /^(?:ba|z|da|k)?sh(?:\.exe)?$|^(?:pwsh|powershell|cmd)(?:\.exe)?$/i.test(argv[0].split(/[\\/]/).pop());
  if (shell) {
    const at = argv.findIndex((arg, i) => i > 0 && /^(?:-c|-lc|-command|\/c)$/i.test(arg));
    if (at >= 0 && typeof argv[at + 1] === 'string') return argv[at + 1];
  }
  return argv.map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ');
}

function commandCwd(item) {
  if (typeof item.cwd !== 'string' || !item.cwd) return null;
  try { return item.cwd.startsWith('file:') ? fileURLToPath(item.cwd) : item.cwd; } catch { return null; }
}

function checkIdentity(command, cwd) {
  return config().flags.checkFailDominates === true ? { checkId: sha(`${cwd}\n${integrity.canonicalCommand(command)}`) } : {};
}

function nativeOutcome(record, lastEdit) {
  const { item, start } = record;
  if (item.status !== 'completed') return item.status === 'failed' ? { outcome: 'fail', excerpt: 'the native command failed' } : { outcome: 'unknown' };
  const result = integrity.verdict({ tool_response: { stdout: typeof item.aggregated_output === 'string' ? item.aggregated_output : '', exit_code: item.exit_code } });
  if (result.outcome === 'pass' && (start === null || start < lastEdit)) {
    return { outcome: 'unknown', excerpt: 'the check cannot be placed wholly after the last edit' };
  }
  return result;
}

// Rebuild verification order from native completion times. A yielded command
// with no terminal native record remains last and unknown, rather than being
// hidden by a recovered older pass. The append-only source log is kept intact.
export function projectCodexChecks(payload, turn, { isCheck, files = [], promptAt = 0 } = {}) {
  const sid = payload.session_id || '';
  const turnId = payload.turn_id || [...turn].reverse().find(e => e.codexTurnId)?.codexTurnId;
  const retainedIds = new Set(turn.filter(e => e.from === 'codex-transcript').map(e => e.codexId));
  const neededIds = turn.filter(e => e.kind === 'shell' && e.verify && e.outcome === 'unknown' &&
    e.codexId && e.codexTurnId === turnId && !retainedIds.has(e.codexId)).map(e => e.codexId);
  const native = readCodexItems(payload.transcript_path, { turnId, sessionId: sid, since: promptAt, neededIds });
  if (!native || typeof isCheck !== 'function') return null;
  const nativeIds = new Set(native.map(record => record.item.id));
  const earlier = new Map(turn.filter(e => e.from === 'codex-transcript' && !nativeIds.has(e.codexId)).map(e => [e.codexId, e]));
  const original = turn.filter(e => e.from !== 'codex-transcript' && !earlier.has(e.codexId)).concat([...earlier.values()]);
  const commands = new Map();
  const edits = new Map();
  for (const record of native) {
    const { item } = record;
    if (item.type === 'CommandExecution') {
      const old = commands.get(item.id);
      if (old && (codexCommand(old.item) !== codexCommand(item) || old.item.cwd !== item.cwd || old.item.exit_code !== item.exit_code || old.item.status !== item.status || old.start !== record.start || old.end !== record.end)) return null;
      commands.set(item.id, record);
    } else if (item.type === 'FileChange' && item.changes && typeof item.changes === 'object' && !Array.isArray(item.changes)) {
      const paths = Object.entries(item.changes).filter(([, change]) => change?.type !== 'delete').map(([file]) => file);
      edits.set(item.id, { kind: 'edit', files: paths, t: record.end, codexId: item.id, codexTurnId: turnId, from: 'codex-transcript' });
    }
  }
  const normalize = value => normalPath(path.isAbsolute(value) ? value : path.join(payload.cwd || process.cwd(), value));
  const editedPaths = new Set([...original.filter(e => e.kind === 'edit').flatMap(e => e.files || []), ...[...edits.values()].flatMap(e => e.files)].map(normalize));
  let lastEdit = Math.max(0, ...original.filter(e => e.kind === 'edit' && !edits.has(e.codexId)).map(e => e.t || 0), ...[...edits.values()].map(e => e.t));
  // A shell write may have no edit hook. Its on-disk modification time must
  // not be answered by a check that began before it; an unreadable file is no
  // permission to promote an unknown result.
  for (const file of files) {
    try {
      const t = Math.floor(fs.statSync(path.resolve(payload.cwd || process.cwd(), file)).mtimeMs);
      const knownEdit = Math.max(0, ...original.filter(e => e.kind === 'edit' && (e.files || []).some(f => normalize(f) === normalize(file))).map(e => e.t || 0), ...[...edits.values()].filter(e => e.files.some(f => normalize(f) === normalize(file))).map(e => e.t));
      if (t <= knownEdit) continue;
      lastEdit = Math.max(lastEdit, t);
      const id = 'filesystem:' + sha(normalize(file));
      edits.set(id, { kind: 'edit', files: [file], t, codexId: id, codexTurnId: turnId, from: 'codex-transcript', evidence: 'filesystem-mtime' });
    } catch { return null; }
  }
  const projected = [];
  const recovered = [];
  const seen = new Set();
  const edited = [...editedPaths];
  const makeCheck = record => {
    const command = codexCommand(record.item), cwd = commandCwd(record.item);
    if (!command || !cwd || !isCheck(command, edited)) return null;
    const outcome = nativeOutcome(record, lastEdit);
    if (outcome.outcome === 'pass' && record.start < promptAt) {
      outcome.outcome = 'unknown'; outcome.excerpt = 'the completed check began before this prompt';
    }
    return { kind: 'shell', command: clip(command, 300), verify: true, startedAt: record.start, ...checkIdentity(command, cwd), ...outcome,
      t: record.end, cwd, codexId: record.item.id, codexTurnId: turnId, from: 'codex-transcript',
      nativeTerminal: record.item.status === 'completed' && Number.isInteger(record.item.exit_code) };
  };
  for (const event of original) {
    if (event.kind === 'edit' && edits.has(event.codexId)) continue;
    if (event.kind === 'shell' && event.codexId && commands.has(event.codexId)) {
      const record = commands.get(event.codexId), check = makeCheck(record);
      seen.add(event.codexId);
      if (check) {
        if (event.outcome === 'fail' && check.outcome === 'pass') { check.outcome = 'fail'; check.excerpt = event.excerpt || 'the hook reported a failure for this execution'; }
        projected.push(check); recovered.push(check);
      }
      else projected.push(event);
    } else if (event.kind === 'shell' && event.verify && event.codexId && event.outcome === 'unknown') {
      // A completed check can be unknown only because it preceded an edit.
      // Once it falls out of the bounded transcript tail, retain its real end
      // time so a later check can verify the new code. Unfinished executions
      // still stay last. The fixed excerpts recognize pre-marker native logs.
      const ended = event.from === 'codex-transcript' && (event.nativeTerminal === true ||
        ['the check cannot be placed wholly after the last edit', 'the retained check began before the last edit'].includes(event.excerpt));
      projected.push(ended ? event : { ...event, t: Number.MAX_SAFE_INTEGER });
    } else if (event.from === 'codex-transcript' && event.kind === 'shell' && event.outcome === 'pass' && (!Number.isFinite(event.startedAt) || event.startedAt < lastEdit)) {
      projected.push({ ...event, outcome: 'unknown', excerpt: 'the retained check began before the last edit' });
    } else projected.push(event);
  }
  for (const [id, record] of commands) if (!seen.has(id)) {
    const check = makeCheck(record);
    if (check) { projected.push(check); recovered.push(check); }
  }
  for (const event of edits.values()) { projected.push(event); recovered.push(event); }
  for (const record of native) {
    const { item, start, end } = record;
    if (item.type !== 'McpToolCall' || item.server !== 'atlias' || item.tool !== 'harness_verify' || (start !== null && start < promptAt)) continue;
    const result = item.result;
    const text = textContent(result?.content);
    let outcome = 'unknown';
    if (item.status === 'failed' || result?.isError === true || /^verify:\s*(?:failed|[1-9]\d* of \d+ checked file\(s\) fail to parse)/i.test(text)) outcome = 'fail';
    else if (item.status === 'completed' && result?.isError === false && /^verify:\s*[1-9]\d* file\(s\) checked and they parse\./.test(text) && !/cannot parse here|do not exist|parser did not finish|neither passed nor failed/.test(text) && start !== null && start >= lastEdit) outcome = 'pass';
    const event = { kind: 'tool', tool: 'mcp__atlias__harness_verify', outcome, t: end, codexId: item.id, codexTurnId: turnId, from: 'codex-transcript' };
    projected.push(event); recovered.push(event);
  }
  projected.sort((a, b) => (a.t || 0) - (b.t || 0));
  return { events: projected, recovered };
}

// Native item records also carry the user/final messages that Claude-shaped
// history readers otherwise miss. Tool output is never promoted to a message.
export function codexMessage(row) {
  const p = row?.payload, item = p?.item;
  if (row?.type !== 'event_msg' || p?.type !== 'item_completed') return null;
  if (item?.type === 'UserMessage') return { role: 'user', text: textContent(item.content) };
  if (item?.type === 'AgentMessage' && (!item.phase || item.phase === 'final')) return { role: 'assistant', text: textContent(item.content ?? item.text) };
  return null;
}

export function codexCompactSummary(row) {
  if (row?.type !== 'compacted' || !row.payload) return '';
  if (typeof row.payload.message === 'string' && row.payload.message.trim()) return row.payload.message;
  if (!Array.isArray(row.payload.replacement_history)) return '';
  return row.payload.replacement_history.filter(item => item?.type === 'message' && ['user', 'assistant', 'developer', 'system'].includes(item.role))
    .map(item => textContent(item.content)).filter(Boolean).join('\n');
}
