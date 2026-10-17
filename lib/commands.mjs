// The repl's slash commands, in one registry. Gev (2026-10-17): like Claude Code's, with /help
// listing every command from the same table that runs it, so a command cannot be added without
// being listed or listed without existing. Interactive only: nothing here is reached by
// `atlias exec`, `atlias eval`, tools/h2h/atlias_task.mjs or runLoop.
//
// A command is { name, usage, help, run(args, ctx), source }. ctx is { state, cwd, out, ask, api }:
// api carries the few repl functions a command calls (statusText, turn, saveChat, ...), passed in by
// lib/agent.mjs so this file does not import it back.
//
// Custom commands are markdown files, as in Claude Code: .atlias/commands/*.md in the project and
// commands/*.md in the Atlias home. A subfolder names a namespace (a/b.md is /a:b). The body is the
// prompt; $ARGUMENTS and $1..$9 are replaced by what follows the command; with no $ARGUMENTS in the
// body, the arguments are appended. A built-in always wins a name, and the project wins over the home.
import fs from 'node:fs';
import * as permissions from './permissions.mjs';
import path from 'node:path';
import { config, STATE_DIR, claudeMemoryDir, readText, clip } from './core.mjs';
import { colorMode, accent, dim } from './logo.mjs';
import * as settings from './settings.mjs';
import * as usage from './usage.mjs';
import * as skills from './skills.mjs';
import * as graph from './graph.mjs';
import * as progress from './progress.mjs';
import * as hosts from './hosts.mjs';
import * as extra from './hosts-extra.mjs';
import * as loop from './loop.mjs';
import * as research from './research.mjs';
import * as importer from './import.mjs';
import { recall } from '../mcp/tools.mjs';

const c = (s) => accent(s, colorMode());
const d = (s) => dim(s, colorMode());

export const CUSTOM_MAX_BYTES = 20000;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const LINE_RE = /^\/([A-Za-z][\w:.-]*)(?:\s+([\s\S]*))?$/;

// '/name rest' -> { name, args }. A line that is a path (/usr/bin/x) or not a slash line is null, so it
// goes to the model as the sentence it is. '//text' is handled by the caller as an escape.
export function parseLine(line) {
  const m = LINE_RE.exec(String(line || '').trim());
  return m ? { name: m[1], args: (m[2] || '').trim() } : null;
}

// ---------- custom commands ----------
export function customDirs(cwd, home = STATE_DIR) {
  return [{ dir: path.join(home, 'commands'), source: 'home' }, { dir: path.join(cwd, '.atlias', 'commands'), source: 'project' }];
}
function scan(dir, source, prefix, out, skipped, depth) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth === 0 && NAME_RE.test(e.name)) { scan(p, source, e.name + ':', out, skipped, 1); continue; }
    if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
    const base = e.name.replace(/\.md$/i, '');
    if (!NAME_RE.test(base)) { skipped.push({ file: p, why: 'the file name is not a command name (letters, digits, - and _)' }); continue; }
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.size > CUSTOM_MAX_BYTES) { skipped.push({ file: p, why: `over ${CUSTOM_MAX_BYTES} bytes` }); continue; }
    const text = readText(p);
    if (text == null) continue;
    const front = skills.parseFrontmatter(text);
    const body = text.replace(/^﻿/, '').replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '').trim();
    if (!body) { skipped.push({ file: p, why: 'the file has no prompt text' }); continue; }
    out.push({ name: prefix + base, source, file: p, body, help: String(front.description || '').replace(/\s+/g, ' ').trim() || clip(body.split(/\r?\n/)[0], 70), hint: String(front['argument-hint'] || '').trim() });
  }
}
// { list, skipped }: project entries replace home entries of the same name. Read at each call, so an edit
// to a file shows on the next line typed.
export function loadCustom(cwd, home = STATE_DIR) {
  const byName = new Map();
  const skipped = [];
  for (const { dir, source } of customDirs(cwd, home)) {
    const found = [];
    scan(dir, source, '', found, skipped, 0);
    for (const cmd of found) byName.set(cmd.name, cmd);
  }
  return { list: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), skipped };
}
export function expand(body, args) {
  const words = String(args || '').split(/\s+/).filter(Boolean);
  let used = false;
  let text = body.replace(/\$ARGUMENTS|\$([1-9])/g, (m, n) => { used = true; return n ? (words[Number(n) - 1] || '') : args; });
  if (!used && args) text += `\n\nARGUMENTS: ${args}`;
  return text;
}

// ---------- helpers ----------
// Replace what a state object holds without replacing the object, so the repl's variable follows.
export function replaceState(target, source) {
  for (const k of Reflect.ownKeys(target)) delete target[k];
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(source));
  return target;
}
function row(label, value) { return `${label.padEnd(14)} ${value}`; }
function exportText(state) {
  const names = { user: 'You', assistant: 'Atlias', gate: 'Atlias gate (generated)', review: 'Review request (generated)' };
  const L = [`# Atlias session ${state.sid}`, '', `Engine ${state.engine}. Project ${state.cwd}. Exported ${new Date().toISOString()}.`, ''];
  for (const h of state.history || []) L.push(`## ${names[h.role] || h.role}`, '', String(h.text || ''), '');
  return L.join('\n');
}

// ---------- the built-in commands ----------
const prompt = async (text, ctx) => { ctx.out('\n' + (await ctx.api.turn(ctx.state, text, ctx.ask, ctx.out)) + '\n'); ctx.api.saveChat(ctx.state); };

export const BUILTINS = [
  { name: 'help', usage: '/help', help: 'this list', run: (a, { out, cwd }) => out(helpText(cwd)) },
  { name: 'engine', usage: '/engine claude|codex|openai|ollama|echo', help: 'switch engine', run: (a, { state, out, api }) => {
    if (!a) return out(`engine ${state.engine}; /engine claude|codex|openai|ollama|echo switches`);
    if (api.detectEngines()[a]) { state.engine = a; state.started = false; state.messages = []; state.textTools = false; out(d(`engine ${a}; the new engine starts a conversation of its own`)); } else out(c(`engine ${a} is not available here`));
  } },
  { name: 'model', usage: '/model [name]', help: 'show the model, or set it for the ollama and openai engines', run: (a, { state, out }) => {
    const cfg = config().agent;
    const key = state.engine === 'ollama' ? 'ollamaModel' : state.engine === 'openai' ? 'openaiModel' : null;
    if (!key) return out(a ? `the ${state.engine} engine picks its own model; atlias does not pass one to it` : state.engine === 'echo' ? 'engine echo has no model' : `engine ${state.engine}: the ${state.engine} program picks the model; atlias does not pass one to it`);
    if (!a) return out(`engine ${state.engine}   model ${cfg[key] || '(not set: atlias config set agent.' + key + ' <model>)'}`);
    out(settings.set(`agent.${key}`, a).text + d('   saved in the atlias config, so it applies to every session'));
  } },
  { name: 'status', usage: '/status', help: 'engine, session, context size, plan, prompt cache, usage', run: (a, { state, out, api }) => out(api.statusText(state)) },
  { name: 'usage', usage: '/usage', help: 'plan limits read from the usage-limits plugin', run: (a, { out }) => { const u = usage.line(); out(u ? `usage ${u} Information only.` : 'usage: no reading from the usage-limits plugin (it writes usage-limits-live.json in the Claude folder)'); } },
  { name: 'cost', usage: '/cost', help: 'tokens this session has used, as far as the engine reported them', run: (a, { state, out }) => {
    if (['claude', 'codex', 'echo'].includes(state.engine)) return out(`cost: the ${state.engine} engine makes its own calls, so atlias never sees their token counts${state.engine === 'echo' ? ' (the echo engine uses none)' : ''}. Its own program reports them.`);
    const cache = state.cache;
    if (!cache || !cache.calls) return out('cost: no model call yet in this session');
    const prompts = (state.promptLog || []).filter((n) => n !== null);
    const outs = (state.outLog || []).filter((n) => n !== null);
    const lines = [row('model calls', String(cache.calls)), row('prompt tokens', cache.reported ? `${cache.prompt} over ${cache.reported} reporting call${cache.reported === 1 ? '' : 's'}${cache.silent ? `, ${cache.silent} reported nothing` : ''}` : 'none reported by the endpoint')];
    if (outs.length) lines.push(row('output tokens', `${outs.reduce((n, v) => n + v, 0)} over ${outs.length} call${outs.length === 1 ? '' : 's'} (this run of the repl only)`));
    if (prompts.length) lines.push(row('largest prompt', String(Math.max(...prompts))));
    lines.push(loop.cacheLine(cache), 'no price table: atlias does not turn tokens into money');
    out(lines.join('\n'));
  } },
  { name: 'permissions', usage: '/permissions [mode|next|log]', help: 'what the agent may do without asking (workspace, ask, read-only, auto-accept, plan, auto, max)', run: (a, { out, state }) => out(permissions.command(a ? ' ' + a : '', { current: config().agent.permissions, set: (m) => settings.set('agent.permissions', m), sid: state.sid })) },
  { name: 'config', usage: '/config [id [value] | reset <id> | all]', help: 'show or change a setting (no menu)', run: (a, { out }) => {
    const rows = settings.rows();
    if (!a) { const ch = rows.filter((r) => r.changed); return out((ch.length ? settings.format(ch) : 'every setting is at its default') + '\n' + d('/config all lists them all; /config <id> <value> sets one; /settings opens the menu')); }
    if (a === 'all') return out(settings.format(rows));
    const [first, second, ...rest] = a.split(/\s+/);
    if (first === 'reset') { out(second ? settings.reset(second).text : 'usage: /config reset <id>'); return; }
    const found = rows.find((r) => r.id === first);
    if (!found) return out(`no setting named ${first}; /config all lists them`);
    if (second === undefined) return out(settings.format([found]));
    out(settings.set(first, [second, ...rest].join(' ')).text);
  } },
  { name: 'diff', usage: '/diff', help: 'the uncommitted changes', run: (a, { out, cwd, api }) => out(api.diffText(cwd)) },
  { name: 'review', usage: '/review', help: 'have the engine review the uncommitted changes', run: async (a, { state, out, ask, cwd, api }) => {
    const p = api.reviewPrompt(cwd);
    if (!p) return out('nothing to review: no uncommitted changes');
    out('\n' + (await api.turn(state, p, ask, out, { generated: 'review' })) + '\n');
    api.saveChat(state);
  } },
  { name: 'undo', usage: '/undo', help: 'take back the last change this agent made', run: (a, { state, out, api }) => { out(['ollama', 'openai'].includes(state.engine) || (state.undo && state.undo.length) ? loop.undo(state) : 'undo covers changes made by the ollama and openai engines; claude and codex keep their own history'); api.saveChat(state); } },
  { name: 'compact', usage: '/compact', help: 'drop older messages, keep the plan', run: (a, { state, out, api }) => { out(loop.compact(state)); api.saveChat(state); } },
  { name: 'clear', usage: '/clear', help: 'save this conversation and start a new one', run: (a, { state, out, cwd, api }) => {
    if (!state.history.length && !state.messages.length) return out('this conversation is already empty');
    const old = state.sid;
    api.saveChat(state);
    api.distil(old, cwd);
    replaceState(state, api.newState(cwd, state.engine));
    out(d(`saved ${old}; new session ${state.sid}. /resume ${old} brings the old one back`));
  } },
  { name: 'sessions', usage: '/sessions', help: 'saved sessions in this folder', run: (a, { out, cwd, api }) => { const list = api.listChats(cwd).slice(0, 10); out(list.length ? list.map((s) => `${s.sid}   ${s.engine}   ${Math.floor((s.history || []).length / 2)} turns   ${new Date(s.saved).toLocaleString()}`).join('\n') : 'no saved sessions in this folder'); } },
  { name: 'resume', usage: '/resume [id]', help: 'carry on a saved session of this folder (the newest if no id)', run: (a, { state, out, cwd, api }) => {
    let loaded;
    const pick = a || (api.listChats(cwd).find((x) => x.sid !== state.sid) || {}).sid;
    try { loaded = pick ? api.loadChat(pick, cwd) : null; } catch (e) { return out(`cannot resume: ${e.message}`); }
    if (!loaded) return out(a ? `no saved session matches ${a}; /sessions lists them` : 'no other saved session in this folder');
    if (loaded.sid === state.sid) return out('that is the session already open');
    if (path.resolve(loaded.cwd) !== path.resolve(cwd)) return out(`that session belongs to ${loaded.cwd}; start atlias there to resume it`);
    const engine = api.detectEngines()[loaded.engine] ? loaded.engine : api.pickEngine();
    if (!engine) return out('cannot resume: none of the engines is available here');
    api.saveChat(state);
    if (loaded.engine !== engine) { loaded.engine = engine; loaded.started = false; loaded.messages = []; loaded.textTools = false; }
    replaceState(state, loaded);
    out(d(`resumed ${state.sid} (${Math.floor(state.history.length / 2)} turns, engine ${state.engine}); the session you left is saved`));
  } },
  { name: 'export', usage: '/export [file]', help: 'write this conversation to a markdown file in the project', run: (a, { state, out, cwd }) => {
    if (!state.history.length) return out('nothing to export yet');
    const target = path.resolve(cwd, a || path.join('.atlias', 'exports', `${state.sid}.md`));
    if (!loop.insideProject(cwd, target)) return out('export writes inside the project only');
    if (fs.existsSync(target)) return out(`${path.relative(cwd, target)} exists; give another name`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, exportText(state));
    out(`wrote ${path.relative(cwd, target)}`);
  } },
  { name: 'plan', usage: '/plan', help: 'the agent\'s current plan', run: (a, { state, out }) => out(state.todo && state.todo.length ? loop.renderTodo(state.todo) : 'no plan yet; the agent writes one with its todo tool') },
  { name: 'init', usage: '/init', help: 'have the engine write (or update) AGENTS.md for this project', run: (a, ctx) => {
    const have = fs.existsSync(path.join(ctx.cwd, 'AGENTS.md'));
    return prompt(`Look at this project and ${have ? 'update its AGENTS.md' : 'write AGENTS.md at its root'} for future coding sessions: how to build, test and run it, what the main folders hold, and the conventions you can confirm in the code. Read files first and state only what you saw in them. Keep it under 60 lines.${have ? ' AGENTS.md already exists: read it and keep what is still true.' : ''}`, ctx);
  } },
  { name: 'memory', usage: '/memory [words]', help: 'the instruction files and saved notes atlias reads here; with words, search them', run: (a, { out, cwd }) => {
    if (a) return out(recall(cwd, a));
    const files = loop.INSTRUCTION_FILES.filter((f) => fs.existsSync(path.join(cwd, f)));
    const dir = claudeMemoryDir(cwd);
    let notes = [];
    try { notes = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort(); } catch { /* no memory folder */ }
    out([`instruction files in ${cwd}: ${files.length ? files.map((f) => `${f} (${fs.statSync(path.join(cwd, f)).size} bytes)`).join(', ') : 'none (/init writes AGENTS.md)'}`,
      `saved notes in ${dir}: ${notes.length ? notes.length : 'none'}`, ...notes.slice(0, 30).map((f) => { const front = skills.parseFrontmatter(readText(path.join(dir, f)) || ''); return `  ${f}${front.description ? ' - ' + clip(front.description, 90) : ''}`; }),
      notes.length > 30 ? `  ... ${notes.length - 30} more` : '', d('edit these files directly; /memory <words> searches them')].filter(Boolean).join('\n'));
  } },
  { name: 'import', usage: '/import [--dry-run] [--from tool] [--sessions] [--undo]', help: 'bring in memory, skills, commands and sessions from Claude Code, Codex, Gemini CLI, Antigravity; --undo takes it back', run: async (a, { out, ask }) => { await importer.runImport(a.split(/\s+/).filter(Boolean), { ask, out }); } },
  { name: 'graph', usage: '/graph <question>', help: 'ask the knowledge graph', run: (a, { out, cwd }) => out(a ? graph.query(cwd, a, config().graph.queryBudget) || 'no graph here, or no answer' : 'usage: /graph <question>') },
  { name: 'skills', usage: '/skills [name]', help: 'the skills installed here, or one of them in full', run: (a, { out, cwd }) => { if (!a) return out(skills.format(skills.discover(cwd))); const one = skills.body(cwd, a); out(one ? `${one.path}\n\n${one.text}` : `no skill matches ${a}; /skills lists them`); } },
  { name: 'recall', usage: '/recall <query>', help: 'search memory and digests', run: (a, { out, cwd }) => out(a ? recall(cwd, a) : 'usage: /recall <query>') },
  { name: 'progress', usage: '/progress [set <next step>]', help: 'the handoff note', run: (a, { state, out, cwd }) => { if (a.startsWith('set ')) progress.setNext(cwd, a.slice(4)); out(progress.update(cwd, state.sid, null)); } },
  { name: 'deep-research', usage: '/deep-research <topic>', help: 'plan questions, gather, and write a cited report under .atlias/research', run: async (a, ctx) => {
    if (!a) return ctx.out('usage: /deep-research <topic>');
    const r = await research.deepResearch(a, ctx);
    ctx.api.saveChat(ctx.state);
    ctx.out(`\nreport: ${path.relative(ctx.cwd, r.file)}\n${r.questions} question${r.questions === 1 ? '' : 's'}, ${r.turns} model turns; citations: ${r.cites.ok.length} found, ${r.cites.bad.length} not found. The report lists what could not be verified.\n`);
  } },
  { name: 'settings', usage: '/settings', help: 'change any option (menu)', run: async (a, { ask, out, onSettings }) => { await settings.menu(ask, out); if (onSettings) onSettings(); } },
  { name: 'hosts', usage: '/hosts', help: 'harnesses atlias can see', run: (a, { out }) => out(extra.statusLine()) },
  { name: 'doctor', usage: '/doctor', help: 'harness health', run: (a, { out, cwd }) => out(hosts.formatDoctor(hosts.doctor(cwd).concat(extra.doctorRows()))) },
  { name: 'exit', usage: '/exit', help: 'leave (also /quit)', exit: true, run: () => {} },
  { name: 'quit', usage: '/quit', help: 'same as /exit', exit: true, hidden: true, run: () => {} },
];

export function builtinNames() { return new Set(BUILTINS.map((b) => b.name)); }

// Everything /help shows: the built-ins, then the custom commands that are not hidden by one.
export function helpText(cwd, home = STATE_DIR) {
  const shown = BUILTINS.filter((b) => !b.hidden);
  const { list, skipped } = loadCustom(cwd, home);
  const names = builtinNames();
  const custom = list.filter((x) => !names.has(x.name));
  const hidden = list.filter((x) => names.has(x.name));
  const width = Math.max(...shown.map((b) => b.usage.length), ...custom.map((x) => `/${x.name}${x.hint ? ' ' + x.hint : ''}`.length)) + 3;
  const L = shown.map((b) => b.usage.padEnd(width) + b.help);
  if (custom.length) L.push('', 'custom commands (markdown files in .atlias/commands here and in the atlias home):', ...custom.map((x) => `/${x.name}${x.hint ? ' ' + x.hint : ''}`.padEnd(width) + `${x.help} (${x.source})`));
  for (const x of hidden) L.push(d(`custom /${x.name} (${x.file}) is hidden by the built-in command of that name`));
  for (const s of skipped) L.push(d(`ignored ${s.file}: ${s.why}`));
  L.push('', d('a line that starts with // is sent to the model as a message that starts with one slash'));
  return L.join('\n');
}

// Runs one line if it is a slash command. { handled: false } means the repl treats it as a message.
// { handled: true, text } is a '//' line to send as a message. { handled: true, exit: true } ends the repl.
export async function dispatch(line, ctx) {
  const t = String(line || '').trim();
  if (t.startsWith('//')) return { handled: true, text: t.slice(1) };
  const parsed = parseLine(t);
  if (!parsed) return { handled: false };
  const built = BUILTINS.find((b) => b.name === parsed.name);
  if (built) {
    await built.run(parsed.args, ctx);
    return built.exit ? { handled: true, exit: true } : { handled: true };
  }
  const custom = loadCustom(ctx.cwd, ctx.home || STATE_DIR).list.find((x) => x.name === parsed.name);
  if (custom) {
    await prompt(expand(custom.body, parsed.args), ctx);
    return { handled: true };
  }
  ctx.out(`unknown command /${parsed.name}; /help lists the commands`);
  return { handled: true };
}
