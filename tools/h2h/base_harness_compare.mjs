#!/usr/bin/env node
// What each base harness is good at, for Gev: reads the reports base_harness_runner.py wrote for
// stock nanobot and stock OpenCode over the same tasks (and, when given, atlias's own screen
// report and the plain arm's) and prints, arm by arm:
//   - tasks solved, in all and per corpus (CanItEdit: edit existing code to a request;
//     HumanEvalFix: fix one small function);
//   - what a solve costs: prompt and output tokens per solved task, the first prompt (what the
//     harness spends before any work), the largest prompt, model calls per task;
//   - how its tasks ended: by itself, at the step limit, at the time limit, without a model call;
//   - the tasks only it solved.
// Then two ways of putting the two together, worked out from the same rows and labelled as what
// they are (no run of a merged harness is claimed):
//   - "either": a task counts when either arm solved it. No real harness can do this without
//     knowing which arm was right; it is the ceiling a merge cannot pass.
//   - "cheap first": the cheaper arm runs every task; the other arm runs only the tasks where the
//     cheaper one visibly did not finish (step limit, time limit, or no model call). The grader's
//     verdict is not used to decide, because a harness never sees it.
//
//   node tools/h2h/base_harness_compare.mjs --nanobot base-nanobot.json --opencode base-opencode.json
//        [--atlias s2.json] [--plain plain.json] [--json]
import fs from 'node:fs';

const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : null; };
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const int = (x) => Number.isSafeInteger(x) && x >= 0;
const corpusOf = (id) => (/^canitedit/.test(id) ? 'canitedit' : /^humanevalfix/.test(id) ? 'humanevalfix' : 'other');
const per = (x) => (Number.isFinite(x) ? Math.round(x) : null);
const median = (xs) => { const a = xs.filter(Number.isFinite).sort((p, q) => p - q); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };

// One arm over exactly `ids`, or null when a task is missing, repeated, ungraded or uncounted.
export function armView(report, ids) {
  const rows = Array.isArray(report?.results) ? report.results.filter((r) => r && ids.has(r.id)) : [];
  if (!ids.size || rows.length !== ids.size || new Set(rows.map((r) => r.id)).size !== ids.size) return null;
  const matches = (r, list, total) => {
    if (!Object.hasOwn(r, list)) return true;
    const counts = r[list];
    if (!Array.isArray(counts) || !counts.length || !counts.every(int)) return false;
    const sum = counts.reduce((n, v) => n + v, 0);
    return int(sum) && sum === r[total];
  };
  if (rows.some((r) => typeof r.pass !== 'boolean' || !int(r.promptTotal) || !int(r.outputTotal) || !int(r.peakPrompt)
    || !matches(r, 'promptTokens', 'promptTotal') || !matches(r, 'outputTokens', 'outputTotal')
    || (Object.hasOwn(r, 'promptTokens') && r.promptTokens.reduce((n, v) => Math.max(n, v), 0) !== r.peakPrompt))) return null;
  const solved = rows.filter((r) => r.pass), tokens = rows.reduce((n, r) => n + r.promptTotal + r.outputTotal, 0);
  if (!int(tokens)) return null;
  const how = (r) => { const s = String(r.stop ?? ''); return /step limit reached|LimitsExceeded/.test(s) ? 'stepLimit' : /^timeout/.test(s) ? 'timeLimit' : (Array.isArray(r.promptTokens) ? r.promptTokens.length : r.rounds) ? 'byItself' : 'noModelCall'; };
  const ended = { byItself: 0, stepLimit: 0, timeLimit: 0, noModelCall: 0 };
  for (const r of rows) ended[how(r)]++;
  const byCorpus = {};
  for (const r of rows) { const c = byCorpus[corpusOf(r.id)] ||= { n: 0, passed: 0 }; c.n++; if (r.pass) c.passed++; }
  const first = rows.map((r) => (Array.isArray(r.promptTokens) && int(r.promptTokens[0]) ? r.promptTokens[0] : NaN));
  const calls = rows.map((r) => (Array.isArray(r.promptTokens) ? r.promptTokens.length : int(r.rounds) ? r.rounds : NaN));
  const completeMedian = (values) => values.every(Number.isFinite) ? median(values) : null;
  return {
    n: rows.length, passed: solved.length, byCorpus, tokens,
    promptPerSolve: solved.length ? per(rows.reduce((n, r) => n + r.promptTotal, 0) / solved.length) : null,
    outputPerSolve: solved.length ? per(rows.reduce((n, r) => n + r.outputTotal, 0) / solved.length) : null,
    tokensPerSolve: solved.length ? per(tokens / solved.length) : null,
    firstPromptMedian: completeMedian(first), peakPrompt: Math.max(0, ...rows.map((r) => r.peakPrompt)),
    callsMedian: completeMedian(calls), startSecondsMedian: per(completeMedian(rows.map((r) => (int(r.startMs) ? r.startMs / 1000 : NaN)))),
    ended, rows: new Map(rows.map((r) => [r.id, { pass: r.pass, tokens: r.promptTotal + r.outputTotal, visiblyUnfinished: how(r) !== 'byItself' }])),
  };
}

// The two ways of putting two arms together, from their rows alone.
export function merges(a, b, names) {
  const ids = [...a.rows.keys()];
  const either = ids.filter((id) => a.rows.get(id).pass || b.rows.get(id).pass).length;
  const cheapIsA = (a.tokens / a.n) <= (b.tokens / b.n), cheap = cheapIsA ? a : b, dear = cheapIsA ? b : a;
  let passed = 0, tokens = 0, escalated = 0;
  for (const id of ids) {
    const c = cheap.rows.get(id), d = dear.rows.get(id);
    tokens += c.tokens;
    if (c.visiblyUnfinished) { escalated++; tokens += d.tokens; if (d.pass) passed++; } else if (c.pass) passed++;
  }
  return { either, cheapFirst: { first: names[cheapIsA ? 0 : 1], then: names[cheapIsA ? 1 : 0], passed, tokens, tokensPerSolve: passed ? per(tokens / passed) : null, escalated } };
}

export function compare({ nanobot, opencode, atlias = null, plain = null }) {
  const ids = new Set((Array.isArray(nanobot?.results) ? nanobot.results : []).map((r) => r?.id));
  const arms = { nanobot: armView(nanobot, ids), opencode: armView(opencode, ids) };
  if (!arms.nanobot || !arms.opencode) return { ok: false, why: 'the two reports do not cover the same tasks with graded results and counted tokens' };
  const extra = {};
  if (atlias) extra.atlias = armView(atlias, ids);
  if (plain) extra['mini-swe-agent'] = armView(plain, ids);
  const only = (x, y) => [...x.rows.keys()].filter((id) => x.rows.get(id).pass && !y.rows.get(id).pass).sort();
  return { ok: true, tasks: ids.size, arms: { ...arms, ...extra }, only: { nanobot: only(arms.nanobot, arms.opencode), opencode: only(arms.opencode, arms.nanobot) },
    both: [...ids].filter((id) => arms.nanobot.rows.get(id).pass && arms.opencode.rows.get(id).pass).length,
    neither: [...ids].filter((id) => !arms.nanobot.rows.get(id).pass && !arms.opencode.rows.get(id).pass).length,
    windowMatched: nanobot.windowMatched === true && opencode.windowMatched === true, merge: merges(arms.nanobot, arms.opencode, ['nanobot', 'opencode']) };
}

function text(c) {
  if (!c.ok) return 'Gev: no comparison, ' + c.why;
  const out = [`Base-harness comparison over ${c.tasks} tasks${c.windowMatched ? '' : ' (NOT comparable: the model did not run at the same window in both arms)'}`, ''];
  for (const [name, a] of Object.entries(c.arms)) {
    if (!a) { out.push(`${name}: report does not cover these tasks; left out`, ''); continue; }
    out.push(`${name}: solved ${a.passed}/${a.n}` + Object.entries(a.byCorpus).map(([k, v]) => `, ${k} ${v.passed}/${v.n}`).join(''));
    out.push(`  tokens per solve ${a.tokensPerSolve ?? 'none solved'} (prompt ${a.promptPerSolve ?? '-'}, output ${a.outputPerSolve ?? '-'}); first prompt ${a.firstPromptMedian ?? 'unknown'}, largest prompt ${a.peakPrompt}, model calls per task ${a.callsMedian ?? 'unknown'}${a.startSecondsMedian != null ? `, ${a.startSecondsMedian} s before its first call` : ''}`);
    out.push(`  tasks ended: by itself ${a.ended.byItself}, at the step limit ${a.ended.stepLimit}, at the time limit ${a.ended.timeLimit}, with no model call ${a.ended.noModelCall}`, '');
  }
  out.push(`solved by both ${c.both}, by neither ${c.neither}`, `only nanobot (${c.only.nanobot.length}): ${c.only.nanobot.join(', ') || '-'}`, `only opencode (${c.only.opencode.length}): ${c.only.opencode.join(', ') || '-'}`, '');
  const m = c.merge;
  out.push(`either one (a ceiling no merge can pass, not a harness): ${m.either}/${c.tasks}`);
  out.push(`cheap first, worked out from these rows and not run: ${m.cheapFirst.first} on every task, ${m.cheapFirst.then} on the ${m.cheapFirst.escalated} it visibly did not finish: ${m.cheapFirst.passed}/${c.tasks}, ${m.cheapFirst.tokensPerSolve ?? 'none solved'} tokens per solve`);
  return out.join('\n');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const files = { nanobot: arg('nanobot'), opencode: arg('opencode'), atlias: arg('atlias'), plain: arg('plain') };
  if (!files.nanobot || !files.opencode) { console.error('usage: node tools/h2h/base_harness_compare.mjs --nanobot <report> --opencode <report> [--atlias <report>] [--plain <report>] [--json]'); process.exit(2); }
  const c = compare({ nanobot: read(files.nanobot), opencode: read(files.opencode), atlias: files.atlias ? read(files.atlias) : null, plain: files.plain ? read(files.plain) : null });
  if (process.argv.includes('--json')) console.log(JSON.stringify(c, (k, v) => (v instanceof Map ? undefined : v), 2)); else console.log(text(c));
  process.exitCode = c.ok ? 0 : 1;
}
