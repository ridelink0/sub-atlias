// Tool implementations shared by the MCP server and the CLI.
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, slug, claudeMemoryDir, readText, writeText, readLines, exists, clip, config, ensureDir } from '../lib/core.mjs';
import * as graph from '../lib/graph.mjs';
import * as dream from '../lib/dream.mjs';
import * as progress from '../lib/progress.mjs';
import { syntaxReport } from '../lib/gate.mjs';
import { doctor, formatDoctor } from '../lib/hosts.mjs';
import * as bench from '../lib/bench.mjs';
import * as relay from '../lib/relay.mjs';
import { doctorRows } from '../lib/hosts-extra.mjs';

const TYPES = new Set(['user', 'feedback', 'project', 'reference']);
// Names that would collide with the index itself. The filesystem is
// case-insensitive on Windows and macOS, so memory.md and MEMORY.md are one
// file, and writing a memory body over the index destroys every line in it.
export const RESERVED_NAMES = new Set(['memory', 'index', 'readme']);

export function recall(cwd, query, limit = 8) {
  const terms = String(query || '').toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2);
  if (!terms.length) return 'recall: give at least one word of three letters or more.';
  const score = (text) => { const t = text.toLowerCase(); return terms.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0); };
  // recall exists to be the cheap way to a fact. A budget keeps it that way,
  // and anything dropped is counted rather than silently lost.
  const cfg = config().recall;
  const out = [];
  let used = 0;
  let omitted = 0;
  const add = (text) => {
    if (used + text.length > cfg.budgetChars) { omitted++; return false; }
    out.push(text);
    used += text.length;
    return true;
  };
  const memDir = claudeMemoryDir(cwd);
  // Notes brought in by `atlias import` live in the Atlias home: this project's, and the ones from Codex.
  const importedDirs = [path.join(STATE_DIR, 'projects', slug(cwd), 'memory'), path.join(STATE_DIR, 'memory', 'codex')].filter((d) => d !== memDir && exists(d));
  if (exists(memDir) || importedDirs.length) {
    const hits = [];
    for (const dir of [memDir, ...importedDirs]) {
      if (!exists(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
        const text = readText(path.join(dir, f)) || '';
        const s = score(text);
        if (s) hits.push({ f, s, text });
      }
    }
    hits.sort((a, b) => b.s - a.s);
    for (const h of hits.slice(0, limit)) add(`### memory ${h.f}\n${clip(h.text.replace(/^---[\s\S]*?---\s*/, '').trim(), cfg.bodyChars)}`);
  }
  for (const r of dream.pending(cwd).rows.slice(-20).reverse()) {
    const text = [...(r.prompts || []), r.summary || ''].join(' ');
    if (score(text)) add(`### session ${r.cursor} (${r.ts})\n${clip(text, 400)}`);
    if (out.length >= limit + 3) break;
  }
  const note = progress.read(cwd);
  if (note && score(note)) add('### handoff note\n' + clip(note, Math.min(900, cfg.bodyChars * 2)));
  const g = graph.query(cwd, String(query), Math.min(config().graph.queryBudget, 400));
  if (g) add(`### graph\n${g}`);
  if (!out.length) return `recall: nothing matched "${clip(query, 80)}" in memory, session history or the graph.`;
  const tail = omitted ? `\n\n(${omitted} further match(es) left out to stay inside the recall budget of ${cfg.budgetChars} characters. Narrow the query, or read the files named above.)` : '';
  return out.join('\n\n') + tail;
}

export function remember(cwd, { name, type, description, body }) {
  if (!name || !/^[a-z0-9][a-z0-9_-]{1,60}$/i.test(name)) return 'remember: name must be a short kebab-case slug (letters, digits, dashes).';
  if (RESERVED_NAMES.has(String(name).toLowerCase())) return `remember: "${name}" is reserved. On Windows and macOS that file is the memory index itself, and writing to it would destroy every memory line for this project. Choose a name for the fact, such as ${String(name).toLowerCase()}-notes.`;
  if (!TYPES.has(type)) return `remember: type must be one of ${[...TYPES].join(', ')}.`;
  if (!description) return 'remember: description is required; it is what recall matches on.';
  const memDir = ensureDir(claudeMemoryDir(cwd));
  const file = path.join(memDir, `${name}.md`);
  const existed = exists(file);
  const desc = String(description).replace(/\r?\n/g, ' ');
  writeText(file, `---\nname: ${name}\ndescription: ${desc}\nmetadata:\n  type: ${type}\n---\n\n${String(body || description).trim()}\n`);
  const index = path.join(memDir, 'MEMORY.md');
  // Keep every line the file already had, including the blank ones. Rebuilding
  // it from non-empty lines deleted the shape of a structured index, one save
  // at a time, and never mentioned it.
  const existingIndex = readText(index) || '';
  const kept = existingIndex.split(/\r?\n/).filter((l) => !l.includes(`](${name}.md)`));
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  kept.push(`- [${name.replace(/[-_]/g, ' ')}](${name}.md) - ${clip(desc, 160)}`);
  writeText(index, kept.join('\n') + '\n');
  return `${existed ? 'updated' : 'saved'} ${file} and indexed it in MEMORY.md (shared by every host).`;
}

export function verifyText(cwd, paths) {
  const files = (paths || []).map((p) => (path.isAbsolute(p) ? p : path.join(cwd, p)));
  if (!files.length) return 'verify: pass the changed file paths.';
  const r = syntaxReport(files);
  const notes = [];
  if (r.skipped.length) notes.push(`${r.skipped.length} file(s) atlias cannot parse here (${r.skipped.map((f) => path.basename(f)).join(', ')}): it knows JavaScript, JSON and Python only. Run the project's own type check, build or test for those; do not treat them as verified.`);
  if (r.missing.length) notes.push(`${r.missing.length} path(s) do not exist: ${r.missing.map((f) => path.basename(f)).join(', ')}.`);
  if (r.unchecked && r.unchecked.length) notes.push(`${r.unchecked.length} file(s) whose parser did not finish (${r.unchecked.map((u) => path.basename(u.file)).join(', ')}): neither passed nor failed. Run verify again, or the project's own check.`);
  if (r.failures.length) {
    return [`verify: ${r.failures.length} of ${r.checked.length} checked file(s) fail to parse.`,
      ...r.failures.map((f) => `- ${f.file}\n  ${f.error}`),
      ...notes,
      'What went wrong: a change was about to be called done without the cheapest check. Fix each file, then run verify again.'].join('\n');
  }
  if (!r.checked.length) {
    return [`verify: nothing was checked.`, ...notes, 'Syntax is the floor and atlias could not even reach it here. Run the project\'s own check, then read each changed file once more as an adversary.'].join('\n');
  }
  return [`verify: ${r.checked.length} file(s) checked and they parse.`, ...notes,
    'Syntax is the floor, not the ceiling: now run the smallest real check of behaviour and read each file once more as an adversary.'].join('\n');
}

export const TOOLS = [
  { name: 'harness_relay', description: 'Opt-in automatic relay for an exact saved Atlias agent session (not a host chat id). status lists this project; schedule saves next_step and at, or a fresh measured reset_at plus five minutes; cancel uses id. Enable agent.relay on first. Same engine/model/permissions, bounded chain, Windows Task Scheduler.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['status','schedule','cancel'] }, session: { type: 'string' }, at: { type: 'string' }, reset_at: { type: 'string' }, next_step: { type: 'string' }, id: { type: 'string' }, cwd: { type: 'string' } }, required: ['action'] } },
  { name: 'harness_recall', description: 'Search the shared memory (all hosts), recent session digests and the knowledge graph for a question. Cheap; use before reading files or asking the user to repeat themselves.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, cwd: { type: 'string', description: 'project directory (defaults to the server cwd)' } }, required: ['query'] } },
  { name: 'harness_remember', description: 'Save one durable fact to the shared memory as a Claude Code memory file (name, type user|feedback|project|reference, description, body) and index it. Use for preferences, corrections, decisions and references, never for what the code already says.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] }, description: { type: 'string' }, body: { type: 'string' }, cwd: { type: 'string' } }, required: ['name', 'type', 'description'] } },
  { name: 'harness_progress', description: 'Shared project handoff across all callers, including workers. get: read the parent project note. set: record the shared next step for compaction, crash or resume. Actor-specific hook notes are separate.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['get', 'set'] }, text: { type: 'string' }, cwd: { type: 'string' } }, required: ['action'] } },
  { name: 'harness_verify', description: 'Syntax-check changed files (JavaScript, JSON, Python). Returns what failed and how to fix it.', inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' } }, required: ['paths'] } },
  { name: 'harness_digest', description: 'show: the session digests waiting to be consolidated into memory. ack: mark them consolidated after you saved the durable facts with harness_remember.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['show', 'ack'] }, cwd: { type: 'string' } }, required: ['action'] } },
  { name: 'graph_query', description: 'Ask the graphify knowledge graph of this project a question (BFS over code, docs and their relationships). A few hundred tokens instead of a file walk. Requires graphify-out/graph.json.', inputSchema: { type: 'object', properties: { question: { type: 'string' }, budget: { type: 'integer', description: 'token cap, default 600' }, cwd: { type: 'string' } }, required: ['question'] } },
  { name: 'graph_affected', description: 'Reverse traversal: what depends on this node and would be affected by changing it. Use before a risky edit.', inputSchema: { type: 'object', properties: { node: { type: 'string' }, cwd: { type: 'string' } }, required: ['node'] } },
  { name: 'graph_explain', description: 'Plain-language explanation of one node and its neighbours.', inputSchema: { type: 'object', properties: { node: { type: 'string' }, cwd: { type: 'string' } }, required: ['node'] } },
  { name: 'harness_bench', description: 'Measure what atlias costs on this project and what a graph answer replaces: the session brief in tokens, a graph answer against the files it names, and how often the guard and the gate have interrupted. Reads only; calls no model. Use when asked whether the harness is worth its cost.', inputSchema: { type: 'object', properties: { questions: { type: 'array', items: { type: 'string' }, description: 'codebase questions to measure the graph against' }, cwd: { type: 'string' } } } },
  { name: 'harness_status', description: 'Health of the harness and its host integrations, with a fix for every failing check.', inputSchema: { type: 'object', properties: { cwd: { type: 'string' } } } },
];

export function callTool(name, args = {}) {
  const cwd = args.cwd || process.cwd();
  const cfg = config();
  switch (name) {
    case 'harness_relay': return JSON.stringify(relay.relayAction(cwd, args));
    case 'harness_recall': return recall(cwd, args.query, args.limit);
    case 'harness_remember': return remember(cwd, args);
    case 'harness_progress':
      if (args.action === 'set') {
        const merged = progress.applyNext(cwd, args.text || '');
        return merged ? `next step recorded, the rest of the note kept:\n${merged}` : `next step recorded. There is no handoff note yet; the next reply that changes a file will write one.`;
      }
      return progress.read(cwd) || 'no handoff note yet for this project.';
    case 'harness_verify': return verifyText(cwd, args.paths);
    case 'harness_digest':
      if (args.action === 'ack') return `consolidated through cursor ${dream.ack(cwd)}.`;
      dream.digest(cwd); return readText(dream.digestPath(cwd)) || 'no digest yet.';
    case 'graph_query': return graph.query(cwd, args.question, args.budget || cfg.graph.queryBudget) || 'no graph here (run /graphify or `graphify update .`), or the graph had no answer.';
    case 'graph_affected': return graph.sub(cwd, 'affected', args.node) || 'no graph here, or no such node.';
    case 'graph_explain': return graph.sub(cwd, 'explain', args.node) || 'no graph here, or no such node.';
    case 'harness_bench': return bench.report(cwd, Array.isArray(args.questions) ? args.questions : []);
    case 'harness_status': return formatDoctor(doctor(cwd).concat(doctorRows()));
    default: throw new Error(`unknown tool ${name}`);
  }
}
