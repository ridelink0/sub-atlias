// Dream, NanoBot's two-stage memory, without an API key of its own.
// Stage 1 (this file, at SessionEnd, in a detached worker): distil the session
// into one append-only history.jsonl row with a cursor, and write DIGEST.md for
// the rows not yet consolidated.
// Stage 2 (the model, at a natural pause): read DIGEST.md, move durable facts
// into shared memory with harness_remember, then ack, which advances the cursor.
import fs from 'node:fs';
import { codexMessage } from './codex-transcript.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, projectDir, readJsonl, readLines, readText, writeText, appendLine, events, sessionDir, tryLock, unlock, detach, clip, log, exists, HOST_LABEL, safeId } from './core.mjs';
import * as graph from './graph.mjs';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hooks.mjs');
export function historyPath(cwd) { return path.join(projectDir(cwd), 'history.jsonl'); }
export function cursorPath(cwd) { return path.join(projectDir(cwd), '.dream_cursor'); }
export function digestPath(cwd) { return path.join(projectDir(cwd), 'DIGEST.md'); }
export function cursor(cwd) { const t = readText(cursorPath(cwd)); const n = parseInt(t || '0', 10); return Number.isFinite(n) && n >= 0 ? n : 0; }

export function pending(cwd) {
  const rows = readJsonl(historyPath(cwd)).filter((r) => Number.isInteger(r.cursor) && r.cursor > cursor(cwd));
  return { count: rows.length, rows, digest: digestPath(cwd) };
}

export function sessionEnd(payload) {
  if (!config().dream.enabled) return null;
  const sid = payload.session_id || 'no-session';
  const cwd = payload.cwd || process.cwd();
  detach([HOOKS, 'dream-worker', sid, payload.transcript_path || '', cwd]);
  return null;
}

// Claude Code and Codex transcripts are JSONL; each row carries a role and content blocks.
export function readTranscript(p) {
  const prompts = [];
  const tools = {};
  const nativeSeen = new Set();
  let lastAssistant = '';
  if (!p || !exists(p)) return { prompts, tools, lastAssistant };
  for (const line of readLines(p)) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const native = codexMessage(row);
    const item = row?.type === 'event_msg' && row.payload?.type === 'item_completed' ? row.payload.item : null;
    if (item && typeof item.id === 'string' && !nativeSeen.has(item.id)) {
      nativeSeen.add(item.id);
      if (native?.role === 'user' && native.text) prompts.push(native.text);
      if (native?.role === 'assistant' && native.text) lastAssistant = native.text;
      const name = item.type === 'CommandExecution' ? 'Bash' : item.type === 'FileChange' ? 'apply_patch' : item.type === 'McpToolCall' ? `mcp__${item.server}__${item.tool}` : null;
      if (name) tools[name] = (tools[name] || 0) + 1;
    }
    const msg = row.message || row;
    const role = msg.role || row.type;
    const content = msg.content;
    if (role === 'user' && row.type !== 'tool_result') {
      if (typeof content === 'string') prompts.push(content);
      else if (Array.isArray(content)) for (const b of content) if (b && b.type === 'text' && typeof b.text === 'string') prompts.push(b.text);
    } else if (role === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'tool_use') tools[b.name] = (tools[b.name] || 0) + 1;
        if (b.type === 'text' && b.text) lastAssistant = b.text;
      }
    }
  }
  return { prompts: prompts.filter((t) => t.trim() && !t.trim().startsWith('<')).map((t) => clip(t.trim(), 200)).slice(-12), tools, lastAssistant };
}

export function digest(cwd) {
  const p = pending(cwd);
  if (!p.count) { writeText(digestPath(cwd), `# atlias digest for ${cwd}\n\nNothing waiting. Every session up to cursor ${cursor(cwd)} is consolidated.\n`); return; }
  const out = [`# atlias digest for ${cwd}`, '', `${p.count} session(s) since the last consolidation. Read them, keep only what passes all four tests, then run harness_digest ack (or \`atlias dream ack\`).`, '',
    '## Keep a fact only if it is', '- Signal: remembering it saves the user from repeating it.', '- Novel: it is not already in memory.', '- Important: losing it would cause rework or drop a preference or rule.', '- Persistent: it stays useful for at least two weeks.', '',
    '## Where it goes (harness_remember type)', '- user: who the user is, role, preferences.', '- feedback: a correction or confirmed approach, with the why.', '- project: ongoing work, decisions, constraints not visible in the code; convert relative dates to absolute.', '- reference: URLs, dashboards, ids.', '',
    'Drop resolved incidents, one-off debugging, transient status, anything a doc or the code already records. A correction replaces the older fact in place.', ''];
  // A fortnight of unconsolidated sessions should not produce a file nobody
  // will read. Show the recent ones; the rest stay in history.jsonl.
  const SHOW = 10;
  const shown = p.rows.slice(-SHOW);
  if (p.rows.length > shown.length) out.push('(' + (p.rows.length - shown.length) + ' older session(s) are waiting too. They are not listed here, they are safe in history.jsonl, and ack covers them as well.)', '');
  for (const r of shown) {
    out.push(`## Session ${r.cursor} (${r.ts}, ${HOST_LABEL[r.host] || r.host || 'unknown host'})`);
    if (r.prompts && r.prompts.length) out.push(...r.prompts.map((t) => `- prompt: ${t}`));
    if (r.files && r.files.length) out.push(`- files: ${r.files.join(', ')}`);
    if (r.checks && r.checks.length) out.push(`- checks: ${r.checks.join(' | ')}`);
    if (r.blocks && (r.blocks.guard || r.blocks.gate)) out.push(`- harness: ${r.blocks.guard} guard denial(s), ${r.blocks.gate} gate block(s)`);
    const tools = Object.entries(r.tools || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ');
    if (tools) out.push(`- tools: ${tools}`);
    if (r.summary) out.push(`- last reply: ${r.summary}`);
    out.push('');
  }
  writeText(digestPath(cwd), out.join('\n'));
}

export function ack(cwd) {
  const rows = readJsonl(historyPath(cwd));
  const last = rows.reduce((m, r) => (Number.isInteger(r.cursor) && r.cursor > m ? r.cursor : m), 0);
  writeText(cursorPath(cwd), String(last) + '\n');
  digest(cwd);
  return last;
}

export function distil(sid, transcript, cwd, opts = {}) {
  const evs = events(sid);
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(sessionDir(), `${safeId(sid)}.json`), 'utf8')); } catch { /* no meta */ }
  const t = readTranscript(transcript);
  const prompts = t.prompts.length ? t.prompts : evs.filter((e) => e.kind === 'prompt').map((e) => e.text).slice(-12);
  const files = [...new Set(evs.filter((e) => e.kind === 'edit').flatMap((e) => e.files || []))].slice(-40);
  const checks = evs.filter((e) => e.kind === 'shell' && e.verify).map((e) => e.command).slice(-6);
  const blocks = { guard: evs.filter((e) => e.kind === 'deny' || e.kind === 'destructive').length, gate: Object.values(meta.gate || {}).reduce((n, g) => n + Object.keys(g).length, 0) };
  if (!prompts.length && !files.length) return null;
  const rows = readJsonl(historyPath(cwd));
  const last = rows.reduce((m, r) => (Number.isInteger(r.cursor) && r.cursor > m ? r.cursor : m), 0);
  const row = { cursor: last + 1, ts: new Date().toISOString(), session: sid, host: meta.host || 'unknown', prompts, files, tools: t.tools, checks, blocks, summary: clip(t.lastAssistant || '', 600) };
  appendLine(historyPath(cwd), JSON.stringify(row));
  if (opts.prune !== false) { prune(cwd); digest(cwd); }
  return row;
}

// Keep the archive bounded without ever dropping a row Dream has not consumed.
export function prune(cwd) {
  const cfg = config();
  const all = readJsonl(historyPath(cwd));
  if (all.length <= cfg.dream.keepHistory) return 0;
  const c = cursor(cwd);
  const keep = all.filter((r, i) => i >= all.length - cfg.dream.keepHistory || r.cursor > c);
  writeText(historyPath(cwd), keep.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return all.length - keep.length;
}

export function worker([sid, transcript, cwd]) {
  cwd = cwd || process.cwd();
  // The row is appended whatever else is happening: two sessions ending at the
  // same moment must both be remembered. Only the tidying is serialised, and
  // skipping it is harmless because the next session does it.
  let row = null;
  try { row = distil(sid, transcript, cwd, { prune: false }); } catch (e) { log(`dream distil failed: ${e.stack || e}`); }
  const lock = path.join(projectDir(cwd), '.dream.lock');
  if (!tryLock(lock, 5 * 60 * 1000)) return row;
  try {
    prune(cwd);
    digest(cwd);
    for (const f of fs.readdirSync(sessionDir())) {
      const fp = path.join(sessionDir(), f);
      try { if (Date.now() - fs.statSync(fp).mtimeMs > 7 * 24 * 3600 * 1000) fs.unlinkSync(fp); } catch { /* busy */ }
    }
    if (graph.isDirty(cwd)) graph.updateNow(cwd);
  } catch (e) { log(`dream worker failed: ${e.stack || e}`); } finally { unlock(lock); }
  return row;
}
