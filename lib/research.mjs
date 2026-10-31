// /deep-research <topic>: a multi-step research pass the repl runs with the current engine.
// Gev (2026-10-17): plan the questions, gather from the tools atlias has, write a cited report to a
// file under the project, and say plainly what could not be verified.
//
// Four things here are done by this code and not by the model, because a model's word is not
// evidence: which tools the run could reach (and that atlias's own loop has no web tool), whether
// every path:line citation names a file and a line that exist, the list of what the model said it
// could not check, and the report file itself. The model plans, gathers and summarises.
import fs from 'node:fs';
import path from 'node:path';
import { config, clip, claudeMemoryDir } from './core.mjs';
import * as loop from './loop.mjs';

export const MAX_QUESTIONS = 5;
export const CITE_FILE_MAX = 2 * 1024 * 1024;
export const REPORT_DIR = ['.atlias', 'research'];

export function slug(text) {
  const s = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
  return s || 'research';
}

// One question per line, numbered or bulleted. A reply with no such line yields none, and the
// caller then researches the topic as a single question and says so in the report.
export function parseQuestions(text, max = MAX_QUESTIONS) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(?:\d+[.):]|[-*])\s+(.{6,300})$/.exec(line);
    if (m) out.push(m[1].trim());
    if (out.length >= max) break;
  }
  return out;
}

// What this run could reach, from the engine and the tool table, never from the model.
export function reach(state, cfg = (config().agent || {}), hasGraph = true) {
  if (state.engine === 'openai' || state.engine === 'ollama') {
    const tools = loop.offeredTools(cfg.toolSet, hasGraph).map((t) => t.name);
    return { engine: state.engine, tools, web: false, text: `atlias's own tool loop on the ${state.engine} engine. Tools: ${tools.join(', ')}. It has no web tool: nothing here was looked up on the internet, and every finding comes from this project's files, saved memory or what the model already knew.` };
  }
  if (state.engine === 'claude' || state.engine === 'codex') {
    return { engine: state.engine, tools: [], web: null, text: `the ${state.engine} engine, which runs its own tools. Atlias cannot see which of them it used, so whether it browsed the web is not known to this report; treat any web claim as unverified unless it carries a link you can open.` };
  }
  return { engine: state.engine, tools: [], web: false, text: 'the echo engine, which has no model and no tools. This report only shows the steps ran; it holds no research.' };
}

// Every path:line (or path:from-to) in the text, checked against the project. This confirms the file and
// the line exist. It does not confirm that the line says what the model claims.
const CITE_RE = /(?<![\w/.\\-])((?:[A-Za-z]:[\\/])?[\w@.\-/\\]+\.[A-Za-z0-9]{1,8}):(\d+)(?:-(\d+))?/g;
const MEMORY_RE = /\bmemory:([A-Za-z0-9_.\-]+)/g;
export function checkCitations(cwd, text, memoryDir = claudeMemoryDir(cwd)) {
  const ok = [];
  const bad = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(CITE_RE)) {
    const ref = m[0];
    if (seen.has(ref)) continue;
    seen.add(ref);
    const file = path.resolve(cwd, m[1]);
    if (!loop.insideProject(cwd, file)) { bad.push({ ref, why: 'outside the project' }); continue; }
    let st;
    try { st = fs.statSync(file); } catch { bad.push({ ref, why: 'no such file' }); continue; }
    if (!st.isFile()) { bad.push({ ref, why: 'not a file' }); continue; }
    if (st.size > CITE_FILE_MAX) { bad.push({ ref, why: 'file too large to check' }); continue; }
    const body = fs.readFileSync(file, 'utf8');
    const lines = body.split('\n').length - (body.endsWith('\n') ? 1 : 0);
    const from = Number(m[2]);
    const to = m[3] ? Number(m[3]) : from;
    if (from < 1 || to < from || to > lines) bad.push({ ref, why: `the file has ${lines} line${lines === 1 ? '' : 's'}` });
    else ok.push(ref);
  }
  for (const m of String(text || '').matchAll(MEMORY_RE)) {
    const ref = m[0];
    if (seen.has(ref)) continue;
    seen.add(ref);
    let have = false;
    try { have = fs.readdirSync(memoryDir).some((f) => f === m[1] || f === `${m[1]}.md`); } catch { /* no memory folder */ }
    (have ? ok : bad).push(have ? ref : { ref, why: 'no such memory note' });
  }
  return { ok, bad };
}

// The lines a model wrote after "Not verified:", one entry per step that said anything.
export function notVerified(text) {
  const all = [...String(text || '').matchAll(/\bnot verified:(?:\*\*)?[ \t]*([^\n]*)/gi)];
  if (!all.length) return null;
  const said = all[all.length - 1][1].replace(/\*+/g, '').trim();
  return /^(nothing|none|n\/a)\.?$/i.test(said) || !said ? '' : said;
}

export function buildReport({ topic, when, engine, reachText, planNote, summary, steps, cites, withheld }) {
  const L = [];
  L.push(`# Research: ${topic}`, '', `Written by atlias /deep-research on ${when} with the ${engine} engine.`, '');
  L.push('## How this was researched', '', `Reach: ${reachText}`, '');
  if (planNote) L.push(planNote, '');
  L.push('## Summary', '', summary || 'No summary was produced.', '');
  L.push('## Findings', '');
  steps.forEach((s, i) => { L.push(`### ${i + 1}. ${s.question}`, '', s.answer || 'No answer.', ''); });
  L.push('## What could not be verified', '');
  const gaps = [];
  steps.forEach((s, i) => {
    const nv = notVerified(s.answer);
    if (nv === null) gaps.push(`Question ${i + 1} gave no "Not verified" line, so none of it is vouched for.`);
    else if (nv) gaps.push(`Question ${i + 1}: ${nv}`);
  });
  if (withheld) gaps.push(withheld);
  if (!gaps.length) gaps.push('The model reported nothing it could not check. That is its statement, not a check of this report.');
  for (const g of gaps) L.push(`- ${g}`);
  L.push('', '## Citation check', '');
  L.push('Atlias checked each path:line against the project files. A citation that exists proves the file and line are there, not that the line says what the finding claims.', '');
  L.push(`Checked and found: ${cites.ok.length}${cites.ok.length ? ` (${cites.ok.join(', ')})` : ''}`);
  L.push(`Not found: ${cites.bad.length}${cites.bad.length ? ` (${cites.bad.map((b) => `${b.ref}: ${b.why}`).join('; ')})` : ''}`);
  if (!cites.ok.length && !cites.bad.length) L.push('', 'No finding carried a path:line citation, so nothing here is traceable to a file.');
  return L.join('\n') + '\n';
}

const PLAN_PROMPT = (topic, r) => `Deep research on: ${topic}\n\nStep 1, plan. Write ${MAX_QUESTIONS} or fewer specific questions that, once answered, would cover this topic. Each must be answerable with what you can reach: ${r.web === false ? 'this project\'s files, saved memory and what you already know (there is no web tool)' : 'your own tools'}. Reply with one numbered question per line and nothing else.`;
const ASK_PROMPT = (topic, q, i, n) => `Deep research on: ${topic}\n\nStep ${i + 1} of ${n}, gather. Question: ${q}\n\nUse your tools to find evidence (read files, search, recall saved memory). Answer in under 200 words. Cite every claim from a project file as path:line (for example lib/loop.mjs:120) and every claim from a saved note as memory:<note name>. Say plainly where you are guessing. Finish with one line starting "Not verified:" naming anything you could not check, or "Not verified: nothing".`;
const SUM_PROMPT = (topic, steps) => `Deep research on: ${topic}\n\nFinal step, summarise. These are the findings so far:\n\n${steps.map((s, i) => `${i + 1}. ${s.question}\n${clip(s.answer, 1500)}`).join('\n\n')}\n\nWrite a summary of at most 150 words. Keep the citations that support it, say where findings conflict, and say what is still unknown. Do not add facts that are not in the findings.`;

// ctx: { state, cwd, out, ask, api } as the repl builds it. api.turn runs one engine turn.
export async function deepResearch(topic, ctx, deps = {}) {
  const { state, cwd, out, ask, api } = ctx;
  const now = deps.now || (() => new Date());
  const r = reach(state);
  out(`research: ${topic}`);
  out(`research: reach is ${r.web === false ? 'project files and memory only, no web' : r.web === null ? 'whatever the engine\'s own tools allow' : 'none'}; planning`);
  const planReply = await api.turn(state, PLAN_PROMPT(topic, r), ask, out);
  let questions = parseQuestions(planReply);
  let planNote = '';
  if (!questions.length) { questions = [topic]; planNote = 'The plan step gave no numbered questions, so the topic itself was researched as one question.'; }
  const steps = [];
  for (let i = 0; i < questions.length; i++) {
    out(`research: question ${i + 1} of ${questions.length}`);
    const answer = String(await api.turn(state, ASK_PROMPT(topic, questions[i], i, questions.length), ask, out) || '').trim();
    steps.push({ question: questions[i], answer });
  }
  out('research: summary');
  const summary = String(await api.turn(state, SUM_PROMPT(topic, steps), ask, out) || '').trim();
  const cites = checkCitations(cwd, [...steps.map((s) => s.answer), summary].join('\n'));
  const when = now();
  const stamp = when.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const file = path.join(cwd, ...REPORT_DIR, `${slug(topic)}-${stamp}.md`);
  const report = buildReport({ topic, when: when.toISOString(), engine: state.engine, reachText: r.text, planNote, summary, steps, cites, withheld: r.web === false ? 'Nothing was checked against the internet: this run had no web tool.' : r.web === null ? 'Whether the engine used the web is not visible to atlias.' : '' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, report);
  return { file, questions: questions.length, cites, turns: questions.length + 2 };
}
