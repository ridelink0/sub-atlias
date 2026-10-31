// Skills, in the format the hosts already read. Nine of the eleven agents in
// the September 2026 source study ship a skill system (docs/NEXTGEN.md); atlias
// had working rules and companion plugins but nothing it could see. Inventing a
// format would have been a second plugin system, so this reads the one Claude
// Code and Codex both already use on this machine: a folder holding a SKILL.md
// whose YAML frontmatter carries a name and a description.
//
// Discovery and listing only. Nothing here runs a skill or installs one: the
// hosts stay the ones that do that, and the terminal agent gains the index the
// hosts already had, plus the one tool it needs to read a skill it recognises.
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_DIR, CODEX_DIR, STATE_DIR, ROOT, clip, readText } from './core.mjs';

export const SKILL_FILE = 'SKILL.md';
// A skill's own instructions run long: graphify's SKILL.md is 41 KB. An index
// needs the frontmatter and nothing else, so only the head of each file is
// read and a folder of fifty skills costs fifty small reads.
export const HEAD_BYTES = 4096;
// Beyond this many skills the index stops naming them and says how many are
// left, because a prompt is not a directory listing.
export const LIST_BUDGET = 1600;

function head(p, bytes = HEAD_BYTES) {
  let fd = null;
  try {
    fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* already gone */ } } }
}

// Where a skill can live, in the order the hosts search: what atlias ships,
// then this machine's own, then the project's. A later root wins a name clash,
// because the nearer copy is the one the user is working on.
export function roots(cwd = process.cwd()) {
  const out = [
    { dir: path.join(ROOT, 'skills'), source: 'atlias' },
    { dir: path.join(CLAUDE_DIR, 'skills'), source: 'claude' },
    { dir: path.join(CODEX_DIR, 'skills'), source: 'codex' },
    // Skills brought in by `atlias import` live in the Atlias home, so they stay after the other tool is gone.
    { dir: path.join(STATE_DIR, 'skills'), source: 'home' },
  ];
  if (cwd) {
    out.push({ dir: path.join(cwd, '.claude', 'skills'), source: 'project' });
    out.push({ dir: path.join(cwd, '.codex', 'skills'), source: 'project' });
  }
  return out;
}

// The frontmatter the hosts read, and no more of YAML than that: the block
// between the first two --- lines, one top-level key per line, quotes stripped.
// Indented lines belong to a nested block (several skills carry a metadata:
// block) and are skipped rather than misread as keys of their own.
export function parseFrontmatter(text) {
  const t = String(text || '').replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(t);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s/.test(line) || line.trimStart().startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) value = value.slice(1, -1);
    if (key) out[key] = value;
  }
  return out;
}

// One folder. A folder with no SKILL.md is not a skill (~/.claude/skills holds
// learned/ and synced/ beside the real ones), and a SKILL.md with no
// frontmatter still is one: the folder name is the name the hosts fall back to.
export function readSkill(dir, source = '') {
  const file = path.join(dir, SKILL_FILE);
  let size = 0;
  try { const st = fs.statSync(file); if (!st.isFile()) return null; size = st.size; } catch { return null; }
  const front = parseFrontmatter(head(file));
  const folder = path.basename(dir);
  return {
    name: String(front.name || folder).trim() || folder,
    folder,
    description: String(front.description || '').replace(/\s+/g, ' ').trim(),
    path: file,
    source,
    bytes: size,
  };
}

// Every skill this machine and this project offer, by name, nearest root last
// so the project's copy of a name wins. Sorted, so an index built from it is
// the same on every session and can be cached as part of a prompt prefix.
export function discover(cwd = process.cwd(), only = null) {
  const byName = new Map();
  // `only` names the sources to look in (atlias, claude, codex, project); left
  // out, every root is read, as it always was.
  for (const { dir, source } of roots(cwd).filter((r) => !only || only.includes(r.source))) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    // No filter on the entry's own type. Claude Code installs most skills as
    // directory junctions into the plugin cache, and a junction reports itself
    // as a symbolic link, not a directory: filtering on isDirectory() found
    // five of the fifty-three folders in ~/.claude/skills on this machine.
    // Whether the entry holds a readable SKILL.md is the only question, and
    // readSkill answers it through a stat that follows the link.
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const skill = readSkill(path.join(dir, name), source);
      if (skill) byName.set(skill.name.toLowerCase(), skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function find(cwd, name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  const all = discover(cwd);
  return all.find((s) => s.name.toLowerCase() === want) || all.find((s) => s.folder.toLowerCase() === want) || all.find((s) => s.name.toLowerCase().includes(want)) || null;
}

// The skill itself, frontmatter stripped, clipped. This is what a reader gets
// when it asks for one by name; the whole point of an index is that it is paid
// once and this is paid only for the skill that matched.
export function body(cwd, name, max = 12000) {
  const s = find(cwd, name);
  if (!s) return null;
  const text = readText(s.path);
  if (text == null) return null;
  const stripped = text.replace(/^﻿/, '').replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '').trim();
  return { ...s, text: clip(stripped, max) };
}

// The human listing: `atlias skills`, and /skills in the agent.
export function format(list) {
  if (!list || !list.length) return 'no skills found. A skill is a folder with a SKILL.md; atlias reads them from ~/.claude/skills, ~/.codex/skills and .claude/skills or .codex/skills in the project.';
  const width = Math.max(...list.map((s) => s.name.length));
  return list.map((s) => `${s.name.padEnd(width)}  ${s.source.padEnd(7)}  ${s.description ? clip(s.description, 150) : '(no description)'}`).join('\n');
}

// The index the agent's own prompt carries: every skill named once, grouped by
// the folder that holds it so a path is written once instead of fifty times.
// Names only, because a name is what a model matches a task against and fifty
// descriptions would cost more than the reads they save.
export function promptSection(cwd = process.cwd(), budget = LIST_BUDGET) {
  const list = discover(cwd);
  if (!list.length) return '';
  const groups = new Map();
  for (const s of list) {
    const dir = path.dirname(path.dirname(s.path));
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(s.folder);
  }
  const lines = [`Skills installed here (${list.length}). A skill is one folder's SKILL.md holding instructions for a kind of task; read that file before doing work it covers, and follow it over your own defaults.`];
  let used = 0;
  let omitted = 0;
  for (const [dir, names] of groups) {
    const kept = [];
    for (const n of names.sort((a, b) => a.localeCompare(b))) {
      if (used + n.length + 2 > budget) { omitted++; continue; }
      kept.push(n);
      used += n.length + 2;
    }
    if (kept.length) lines.push(`  ${path.join(dir, '<name>', SKILL_FILE)}: ${kept.join(', ')}`);
  }
  if (omitted) lines.push(`  and ${omitted} more; \`atlias skills\` lists them all with what each is for.`);
  return lines.join('\n');
}

// ---------- the index in the agent's system message (agent.skillIndex) ----------
// off (the default since 2026-10-12, by Gev's decision): no index at all. On the
// benchmark the full index was about 1,440 characters on every call and no run
// was seen using a skill. relevant: the few installed skills that share words
// with the request the session started with, one short line each, capped, and
// how to list the rest; chosen with no model, and a skill's own instructions
// are never shortened (Codex's pipelines report, 2026-10-12: shrink what
// choosing a skill costs, keep what running it needs). all: promptSection
// above, every root, exactly what every run before that date carried.
export const INDEX_MODES = ['off', 'relevant', 'all'];
// Anything that is not one of the two index modes reads as off.
export function indexMode(value) { return value === 'relevant' || value === 'all' ? value : 'off'; }
// The relevant index may not run past this many characters, names at most this
// many skills, and cuts a description (never the skill's own instructions,
// which are read whole from its SKILL.md) to RELEVANT_DESC.
export const RELEVANT_CAP = 600;
export const RELEVANT_MAX = 5;
export const RELEVANT_DESC = 80;
// Below this a skill has too little in common with the request to be named: one
// word of a description can match by chance, a word of the name rarely does.
export const RELEVANT_MIN = 2;
// Words too common to say which skill a request is for.
const COMMON = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you', 'are', 'not', 'but', 'all', 'any', 'can', 'has', 'have', 'use', 'uses', 'using', 'used', 'when', 'what', 'which', 'will', 'its', 'our', 'out', 'make', 'add', 'new', 'file', 'files', 'code', 'skill', 'skills', 'work', 'task', 'tasks', 'please', 'should', 'need', 'needs', 'want', 'does', 'how', 'was', 'were', 'one', 'each', 'them', 'then', 'than', 'also', 'about', 'before', 'after', 'over', 'only']);
// The words of a text that can tell one skill from another: lower case, three
// characters or more, in any script that writes words apart.
export function words(text) {
  return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !COMMON.has(w));
}
// Whether a request names a skill outright: the name with nothing word-like on
// either side, so `commit` is not found inside `recommitted`.
function mentions(text, name) {
  const edge = /[\p{L}\p{N}_-]/u;
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    const before = at ? text[at - 1] : ' ';
    const after = at + name.length < text.length ? text[at + name.length] : ' ';
    if (!edge.test(before) && !edge.test(after)) return true;
  }
  return false;
}
// How much a skill has in common with a request, decided with no model: a skill
// the request names outranks everything, a request word found in the skill's
// name counts three and one found in its description counts one.
export function relevance(skill, request) {
  const text = String(request || '').toLowerCase();
  if (!text.trim()) return 0;
  const names = [...new Set([skill.name, skill.folder].map((n) => String(n || '').toLowerCase()).filter((n) => n.length >= 3))];
  const inName = new Set(names.flatMap(words));
  const inDescription = new Set(words(skill.description));
  let score = names.some((n) => mentions(text, n)) ? 100 : 0;
  for (const w of new Set(words(text))) score += inName.has(w) ? 3 : inDescription.has(w) ? 1 : 0;
  return score;
}
// A list of skills (readSkill's shape) as the index for one request: the few
// that fit it, best first, each with the path to read and a short description,
// and always how to list the rest, so the reader is never told the list is
// complete when it is not. With nothing in common, only that last part.
export function relevantSection(list, request, cwd = process.cwd(), cap = RELEVANT_CAP) {
  if (!list.length) return '';
  const none = `${list.length} ${list.length === 1 ? 'skill is' : 'skills are'} installed here; \`atlias skills\` lists them with what each is for.`;
  const ranked = list.map((s) => ({ s, score: relevance(s, request) })).filter((r) => r.score >= RELEVANT_MIN)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name)).slice(0, RELEVANT_MAX);
  let out = `Skills that may fit this request, of ${list.length} installed (\`atlias skills\` lists them all). Read a skill's SKILL.md before work it covers, and follow it over your own defaults.`;
  let kept = 0;
  for (const { s } of ranked) {
    // A skill inside the project is named by its path from there, which is the shorter one.
    const from = path.relative(cwd, s.path);
    const where = from && !from.startsWith('..') && !path.isAbsolute(from) ? from : s.path;
    const about = s.description.length > RELEVANT_DESC ? s.description.slice(0, RELEVANT_DESC - 3).trimEnd() + '...' : s.description;
    const line = `- ${where}${about ? `: ${about}` : ''}`;
    if (out.length + 1 + line.length > cap) break;
    out += `\n${line}`;
    kept++;
  }
  return kept ? out : none;
}
// What systemPrompt adds for a value of agent.skillIndex, or '' for none. The
// request is what the session was started with; only relevant reads it.
export function indexFor(cwd, value, request = '') {
  const mode = indexMode(value);
  if (mode === 'all') return promptSection(cwd);
  if (mode === 'relevant') return relevantSection(discover(cwd), request, cwd);
  return '';
}
