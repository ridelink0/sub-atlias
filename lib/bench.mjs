// What atlias costs and what it replaces, measured on the project in front of
// you. No model is called: every number here is either a byte count taken from
// disk or a token estimate derived from one, and the estimates are labelled.
import fs from 'node:fs';
import path from 'node:path';
import { config, readJsonl, projectDir, sessionDir, readJson, eventsTail, clip } from './core.mjs';
import * as graph from './graph.mjs';
import * as brief from './brief.mjs';

// Four characters to a token is the rough rule for English and for code. It is
// an estimate, it is never presented as anything else, and it is the same
// estimate on both sides of every comparison here, so the ratio holds even
// where the absolute numbers drift.
export function estimateTokens(text) {
  const n = String(text == null ? '' : text).length;
  return n === 0 ? 0 : Math.ceil(n / 4);
}

export function briefCost(cwd, host = 'claude') {
  const text = brief.build({ cwd, session_id: 'bench', source: 'startup' }, host);
  return { chars: text.length, tokens: estimateTokens(text) };
}

// A graph answer names the files it came from. The comparison is that answer
// against the cost of opening those same files, which is what the model would
// otherwise have had to do.
export function graphVsFiles(cwd, question) {
  const answer = graph.query(cwd, question, config().graph.queryBudget);
  if (!answer) return null;
  const named = new Set();
  for (const m of answer.matchAll(/src=([^\s\]]+)/g)) named.add(m[1]);
  let bytes = 0;
  let read = 0;
  for (const rel of named) {
    const full = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    try { bytes += fs.statSync(full).size; read++; } catch { /* the graph can name a file that has since moved */ }
  }
  const answerTokens = estimateTokens(answer);
  const fileTokens = Math.ceil(bytes / 4);
  return { question, answerTokens, fileTokens, filesNamed: named.size, filesMeasured: read, saved: fileTokens - answerTokens };
}

// How often the harness actually spoke, taken from the session digests it has
// already written for this project.
export function interventions(cwd) {
  const rows = readJsonl(path.join(projectDir(cwd), 'history.jsonl'));
  let toolCalls = 0;
  let guard = 0;
  let gate = 0;
  for (const r of rows) {
    for (const n of Object.values(r.tools || {})) toolCalls += Number(n) || 0;
    guard += (r.blocks && r.blocks.guard) || 0;
    gate += (r.blocks && r.blocks.gate) || 0;
  }
  // Sessions that have not ended yet have no digest, so read their logs
  // directly. Without this the bench says zero during the very session whose
  // numbers you are asking about.
  const live = liveSessions(cwd);
  return { sessions: rows.length, live: live.sessions, toolCalls: toolCalls + live.toolCalls, guard: guard + live.guard, gate: gate + live.gate, spoke: guard + gate + live.guard + live.gate };
}

export function liveSessions(cwd, maxFiles = 10) {
  const dir = sessionDir();
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { sessions: 0, toolCalls: 0, guard: 0, gate: 0 }; }
  const norm = (v) => String(v || '').replace(/[\\/]+$/, '').toLowerCase();
  const mine = files.filter((f) => norm((readJson(path.join(dir, f), {}) || {}).cwd) === norm(cwd)).slice(-maxFiles);
  let toolCalls = 0;
  let guard = 0;
  let gate = 0;
  for (const f of mine) {
    const id = f.replace(/\.json$/, '');
    for (const e of eventsTail(id, 512 * 1024)) {
      if (e.kind === 'tool') toolCalls++;
      else if (e.kind === 'deny' || e.kind === 'destructive') guard++;
    }
    const meta = readJson(path.join(dir, f), {}) || {};
    for (const g of Object.values(meta.gate || {})) gate += Object.keys(g).length;
  }
  return { sessions: mine.length, toolCalls, guard, gate };
}

export function report(cwd, questions = []) {
  const out = [];
  const b = briefCost(cwd);
  out.push('atlias bench for ' + cwd);
  out.push('');
  out.push('Fixed cost, once per session');
  out.push('  session brief: ' + b.chars + ' characters, about ' + b.tokens + ' tokens (estimate, four characters per token)');
  out.push('');
  const qs = questions.length ? questions : ['how does this project handle errors', 'what is the entry point of this project'];
  if (!graph.status(cwd).exists) {
    out.push('Graph answer versus opening the files');
    out.push('  no graph in this project, so nothing to measure. Build one with /graphify, or with the graph update command.');
  } else {
    out.push('Graph answer versus opening the files it names');
    let savedTotal = 0;
    let measured = 0;
    for (const q of qs) {
      const r = graphVsFiles(cwd, q);
      if (!r) { out.push('  "' + clip(q, 60) + '": the graph had no answer'); continue; }
      measured++;
      savedTotal += r.saved;
      out.push('  "' + clip(q, 60) + '"');
      out.push('    answer about ' + r.answerTokens + ' tokens, the ' + r.filesMeasured + ' file(s) it named about ' + r.fileTokens + ' tokens, difference about ' + r.saved + ' tokens');
    }
    if (measured) {
      out.push('  across ' + measured + ' question(s): about ' + savedTotal + ' tokens not spent opening files (estimate)');
      out.push('  this is an upper bound: it assumes every file the graph named would otherwise');
      out.push('  have been opened in full, and a model often reads fewer of them, or only parts.');
    }
  }
  out.push('');
  const i = interventions(cwd);
  out.push('How often the harness spoke, from its own session digests');
  if (!i.sessions && !i.live) out.push('  no sessions recorded for this project yet.');
  else {
    out.push('  sessions ' + i.sessions + ' finished' + (i.live ? ' and ' + i.live + ' still open' : '') + ', tool calls ' + i.toolCalls + ', guard denials ' + i.guard + ', gate blocks ' + i.gate);
    out.push('  it interrupted ' + i.spoke + ' time(s) in ' + i.toolCalls + ' tool call(s)' + (i.toolCalls ? ', about ' + ((i.spoke / i.toolCalls) * 100).toFixed(1) + ' per cent' : ''));
  }
  out.push('');
  out.push('Not measured here: whether the guard and the gate change how often a task actually succeeds.');
  out.push('That needs the same tasks run with the harness on and off, and it has not been done.');
  return out.join('\n');
}
