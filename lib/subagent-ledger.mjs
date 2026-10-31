// Sub-agent ledger (for Gev, 2026-10-30). One record per sub-agent a turn starts:
// an id, its task, where it is in its life, and what it has spent so far. The idea
// of a receipt whose final stage never goes back comes from reason-network's sent
// receipts (src/store.rs, stages queued/accepted/handed_to_agent/replied, MIT OR
// Apache-2.0); this file is written fresh for Atlias and copies none of its code.
//
// What is plumbing here and what is not:
// - The record, its events and cancelling one sub-agent change no model request,
//   so they are always on (RESEARCH-FIRST 0c: only changes to what a model is sent
//   wait for a measurement).
// - The concurrency cap, the token budget, the typed hand-back and the check gate
//   change how many calls a sub-agent makes or what its parent reads. They sit
//   behind agent.subagentConcurrency, agent.subagentTokenBudget,
//   agent.subagentHandback and agent.subagentVerify, all off by default.
//
// Events: every change of a record is handed to state.onSubagent (if it is a
// function) as { type: 'subagent', ...record }, and written to the session journal
// as { kind: 'subagent', ... } by the caller. A listener that throws is ignored:
// display never stops a run.

export const STATUSES = ['queued', 'running', 'done', 'unverified', 'failed', 'cancelled', 'refused'];
export const FINAL = new Set(['done', 'unverified', 'failed', 'cancelled', 'refused']);
export const TASK_CHARS = 200;
export const KEEP = 50;

function ledger(state) {
  return state.subLedger || (state.subLedger = { seq: 0, items: new Map(), running: 0, waiting: [] });
}

const short = (s, n) => { const t = String(s ?? '').replace(/[\r\n]+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// What a listener and the journal see: no answer text, only its length.
export function view(rec) {
  return {
    id: rec.id, name: rec.name, task: rec.task, status: rec.status, engine: rec.engine, model: rec.model,
    turns: rec.turns, steps: rec.steps, tokens: { prompt: rec.tokens.prompt, output: rec.tokens.output, cached: rec.tokens.cached },
    stop: rec.stop, reason: rec.reason, files: rec.files.slice(0, 20), check: rec.check,
    startedAt: rec.startedAt, endedAt: rec.endedAt, answerChars: rec.answerChars,
  };
}

function emit(state, rec) {
  const ev = { type: 'subagent', ...view(rec) };
  if (typeof state.onSubagent === 'function') { try { state.onSubagent(ev); } catch { /* display never stops a run */ } }
  return ev;
}

export function open(state, { name, task, engine = '', model = '', now = Date.now() } = {}) {
  const l = ledger(state);
  const id = `sa-${++l.seq}`;
  const rec = {
    id, name: short(name, 40), task: short(task, TASK_CHARS), status: 'queued', engine: String(engine || ''), model: String(model || ''),
    turns: 0, steps: 0, tokens: { prompt: 0, output: 0, cached: 0 }, stop: '', reason: '', files: [], check: null,
    startedAt: now, endedAt: 0, answerChars: 0, controller: new AbortController(), cancelReason: '',
  };
  l.items.set(id, rec);
  // Keep the newest records only; a finished one is dropped first.
  while (l.items.size > KEEP) {
    const old = [...l.items.values()].find((r) => FINAL.has(r.status));
    if (!old) break;
    l.items.delete(old.id);
  }
  emit(state, rec);
  return rec;
}

// A final status never changes again, the way a receipt that was replied to stays replied.
export function update(state, rec, patch = {}) {
  if (!rec || FINAL.has(rec.status)) return null;
  if (patch.status && !STATUSES.includes(patch.status)) throw Error(`unknown sub-agent status ${patch.status}`);
  Object.assign(rec, patch);
  if (FINAL.has(rec.status) && !rec.endedAt) rec.endedAt = Date.now();
  return emit(state, rec);
}

export function get(state, id) { return ledger(state).items.get(String(id)) || null; }
export function list(state) { return [...ledger(state).items.values()].map(view); }

// Stops one sub-agent and leaves its parent and siblings running. True when it was
// still queued or running.
export function cancel(state, id, why = 'cancelled by the person') {
  const rec = get(state, id);
  if (!rec || FINAL.has(rec.status)) return false;
  rec.cancelReason = rec.cancelReason || String(why);
  rec.controller.abort();
  return true;
}

// agent.subagentConcurrency: at most `limit` sub-agents of one parent run at once;
// the rest wait as 'queued'. 0 (the default) means no cap, as before.
export async function acquire(state, rec, limit) {
  const l = ledger(state);
  if (!(limit > 0)) { l.running++; return true; }
  while (l.running >= limit) {
    if (rec.controller.signal.aborted) return false;
    await new Promise((resolve) => {
      // A waiter that was cancelled takes itself off the list, so it never swallows a free slot.
      const done = () => { rec.controller.signal.removeEventListener('abort', done); const i = l.waiting.indexOf(done); if (i >= 0) l.waiting.splice(i, 1); resolve(); };
      l.waiting.push(done);
      rec.controller.signal.addEventListener('abort', done, { once: true });
    });
  }
  if (rec.controller.signal.aborted) return false;
  l.running++;
  return true;
}

export function release(state) {
  const l = ledger(state);
  l.running = Math.max(0, l.running - 1);
  const next = l.waiting.shift();
  if (next) next();
}

// Counts one model reply of a sub-agent: a turn, the tool calls it asked for, and
// the tokens the provider reported for it. Tokens are what countCache would add.
// `read` is the loop's own cacheReading, so the figures match the session's.
export function countReply(rec, res, parse, read) {
  if (!rec || !res || res.error) return;
  rec.turns++;
  const calls = Array.isArray(res.calls) && res.calls.length ? res.calls.length : (typeof parse === 'function' && res.content ? safeCount(parse, res.content) : 0);
  rec.steps += calls;
  for (const u of Array.isArray(res.requestUsages) ? res.requestUsages : res.usage ? [res.usage] : []) {
    if (!u) continue;
    const r = typeof read === 'function' ? read(u) : null;
    const input = r && Number.isSafeInteger(r.prompt) ? r.prompt : 0;
    const cached = r && Number.isSafeInteger(r.cached) ? r.cached : 0;
    // Output only where the provider reported it, as countCache does.
    const output = Number.isSafeInteger(u.output_tokens) && u.output_tokens >= 0 ? u.output_tokens : 0;
    rec.tokens.prompt += input; rec.tokens.cached += cached; rec.tokens.output += output;
  }
}

function safeCount(parse, text) { try { const c = parse(String(text)); return Array.isArray(c) ? c.length : 0; } catch { return 0; } }

// The check gate (agent.subagentVerify = check): a sub-agent that changed files is
// accepted only when a check it ran after its last edit passed. Whether a check
// ran, and what it said, is the loop's own record (state.lastCheck), never the
// sub-agent's word (RESEARCH-FIRST H5, section 7).
export function checkAfterEdits(child) {
  const edited = child.edited instanceof Set ? [...child.edited] : Array.isArray(child.edited) ? child.edited : [];
  const last = child.lastCheck || null;
  const after = Boolean(last) && Number(last.at) >= Number(child.editedAt || 0) && Number(child.editedAt || 0) > 0;
  return { files: edited, ran: after, outcome: after ? last.outcome : 'none', excerpt: after ? String(last.excerpt || '') : '' };
}

// The typed hand-back (agent.subagentHandback = typed): what the parent reads is
// built by the harness from the sub-agent's own record, and the model's answer is
// one field of it, clipped. The sub-agent is never asked to write a format
// (RESEARCH-FIRST section 7: strict output formats cost reasoning; let the
// controller extract the structure).
export function handback(rec, answer, { clipTo = 6000 } = {}) {
  const files = rec.files.length ? rec.files.slice(0, 20).join(', ') + (rec.files.length > 20 ? ` and ${rec.files.length - 20} more` : '') : 'none';
  const check = !rec.check || rec.check.outcome === 'none' ? (rec.files.length ? 'none ran after its edits' : 'none needed (no files changed)')
    : `${rec.check.outcome}${rec.check.excerpt ? ` (${short(rec.check.excerpt, 200)})` : ''}`;
  const text = String(answer || '(no answer)');
  const body = text.length > clipTo ? text.slice(0, clipTo) + `\n[answer cut at ${clipTo} of ${text.length} characters]` : text;
  return [
    `sub-agent ${rec.id} "${rec.name}": ${rec.status}${rec.stop ? ` (${rec.stop})` : ''}`,
    `turns ${rec.turns}, tool calls ${rec.steps}, tokens ${rec.tokens.prompt} in / ${rec.tokens.output} out`,
    `files changed: ${files}`,
    `check after its edits: ${check}`,
    ...(rec.status === 'unverified' ? ['not accepted: it changed files and no check it ran after its last edit passed. Check its work before relying on it.'] : []),
    'answer:',
    body,
  ].join('\n');
}
