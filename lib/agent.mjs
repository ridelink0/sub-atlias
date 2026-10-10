// atlias as a regular agent: the same harness, flown from a terminal of its own.
// One ship, four engines: Claude Code (claude -p), Codex (codex exec), any
// OpenAI-compatible endpoint, or a local Ollama model. The last two run on
// atlias's own tool loop (lib/loop.mjs). The guard, the gate, the graph
// router, the handoff note and Dream all run here exactly as they do in a host.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { config, saveSessionMeta, clip, STATE_DIR, readJson, writeJson, safeId, run, events } from './core.mjs';
import * as usage from './usage.mjs';
import { logo, colorMode, accent, dim, bold } from './logo.mjs';
import * as router from './router.mjs';
import * as gate from './gate.mjs';
import * as progress from './progress.mjs';
import * as dream from './dream.mjs';
import * as graph from './graph.mjs';
import * as hosts from './hosts.mjs';
import * as extra from './hosts-extra.mjs';
import * as loop from './loop.mjs';
import * as settings from './settings.mjs';
import * as sandbox from './sandbox.mjs';
import * as skills from './skills.mjs';
import { recall } from '../mcp/tools.mjs';

export { TOOL_RE, parseToolCall, systemPrompt, insideProject, runTool, transportFor } from './loop.mjs';

const MODE = () => colorMode();
const c = (s) => accent(s, MODE());
const d = (s) => dim(s, MODE());
const b = (s) => bold(s, MODE());

// ---------- engines ----------
export const VERSION_PROBE_MS = 5000;
// npm installs the Claude and Codex CLIs on Windows as .cmd shims, and Node
// refuses to spawn a .cmd or .bat without a shell (EINVAL since the fix for
// CVE-2024-27980), so asking for claude.cmd failed on every such machine and
// detectEngines reported the engine missing. Read the shim for the program it
// launches and run that directly, so no shell ever parses the arguments.
export function resolveCommand(cmd, args, { platform = process.platform, env = process.env, read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  if (platform !== 'win32') return { file: cmd, args };
  for (const dir of String(env.PATH || env.Path || '').split(';').filter(Boolean)) {
    let text;
    try { text = read(path.win32.join(dir, cmd + '.cmd')); } catch { continue; }
    const m = /"%dp0%\\([^"]+)"\s+%\*/.exec(text);
    if (!m) continue;
    const target = path.win32.join(dir, m[1]);
    return /\.[cm]?js$/i.test(target) ? { file: process.execPath, args: [target, ...args] } : { file: target, args };
  }
  return { file: cmd, args };
}
function cli(cmd, args, input, cwd, timeout = 20 * 60 * 1000) {
  const opts = { input, encoding: 'utf8', cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
  let r = spawnSync(cmd, args, opts);
  if (r.error && r.error.code === 'ENOENT') {
    const real = resolveCommand(cmd, args);
    if (real.file !== cmd) r = spawnSync(real.file, real.args, opts);
  }
  return r;
}
export function detectEngines() {
  const ok = (cmd) => cli(cmd, ['--version'], '', process.cwd(), VERSION_PROBE_MS).status === 0;
  return { claude: ok('claude'), codex: ok('codex'), openai: loop.openaiReady(), ollama: ollamaAlive(config().agent.ollamaUrl), echo: true };
}
export function ollamaAlive(url) {
  try {
    const u = new URL('/api/tags', url);
    const mod = u.protocol === 'https:' ? 'node:https' : 'node:http';
    const probe = `const http=require(${JSON.stringify(mod)});const q=http.get(${JSON.stringify(u.href)},{timeout:1500},(r)=>process.exit(r.statusCode===200?0:1));q.on('error',()=>process.exit(1));q.on('timeout',()=>{q.destroy();process.exit(1)});`;
    return spawnSync(process.execPath, ['-e', probe], { timeout: 5000, windowsHide: true }).status === 0;
  } catch { return false; }
}
// Claude Code's --session-id takes a UUID and nothing else, so the host gets
// state.hostSid while atlias keeps its own prefixed id for its own files.
export function claudeArgs(state) {
  const base = ['-p', '--output-format', 'text'];
  return state.started ? [...base, '--resume', state.hostSid] : [...base, '--session-id', state.hostSid];
}
export function claudeTurn(state, prompt, deps = {}) {
  const exec = deps.run || cli;
  let r = exec('claude', claudeArgs(state), prompt, state.cwd);
  // A first turn can fail because the host will not take a pinned session at
  // all; a later one can fail because the session is gone. Both recover by
  // asking for the most recent conversation instead.
  if (r.status !== 0 || r.error) r = exec('claude', ['-p', '--output-format', 'text', ...(state.started ? ['--continue'] : [])], prompt, state.cwd);
  state.started = true;
  if (r.status !== 0 || r.error) return `claude failed: ${clip(((r.stderr || '') + (r.error ? r.error.message : '')).trim(), 500)}`;
  return (r.stdout || '').trim();
}
export function codexTurn(state, prompt) {
  // codex exec is one shot, so atlias carries the continuity in the prompt.
  const history = state.history.slice(-6).map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${clip(h.text, 1200)}`).join('\n');
  const full = history ? `Earlier in this session:\n${history}\n\nNow the user says:\n${prompt}` : prompt;
  let r = cli('codex', ['exec', '-'], full, state.cwd);
  if (r.status !== 0 || r.error) r = cli('codex', ['exec', full], '', state.cwd);
  if (r.status !== 0 || r.error) return `codex failed: ${clip(((r.stderr || '') + (r.error ? r.error.message : '')).trim(), 500)}`;
  return (r.stdout || '').trim();
}
// The two engines atlias drives itself, through its own tool loop.
export function ollamaTurn(state, prompt, ask, say) {
  return loop.runLoop(state, prompt, { chat: loop.ollamaChat(config().agent), ask, say, native: false });
}
export function openaiTurn(state, prompt, ask, say) {
  const cfg = config().agent;
  return loop.runLoop(state, prompt, { chat: loop.openaiChat(cfg), ask, say, native: cfg.nativeTools !== false });
}

// ---------- the loop ----------
export function newState(cwd, engine) {
  const hostSid = crypto.randomUUID();
  const sid = 'atlias-' + hostSid;
  saveSessionMeta(sid, { host: 'atlias', cwd, source: 'startup', started: Date.now(), engine });
  return { sid, hostSid, cwd, engine, started: false, history: [], messages: [] };
}
export async function turn(state, text, ask, say) {
  const routed = router.prompt({ session_id: state.sid, cwd: state.cwd, prompt: text });
  const extraContext = routed && routed.hookSpecificOutput ? routed.hookSpecificOutput.additionalContext : '';
  const prompt = extraContext ? `${extraContext}\n\n${text}` : text;
  const engineTurn = async (input) => {
    if (state.engine === 'claude') return claudeTurn(state, input);
    if (state.engine === 'codex') return codexTurn(state, input);
    if (state.engine === 'openai') return openaiTurn(state, input, ask, say);
    if (state.engine === 'ollama') return ollamaTurn(state, input, ask, say);
    return `echo: ${input}`;
  };
  let reply = await engineTurn(prompt);
  state.history.push({ role: 'user', text }, { role: 'assistant', text: reply });
  const held = gate.stop({ session_id: state.sid, cwd: state.cwd, last_assistant_message: reply });
  if (held && held.decision === 'block' && state.engine !== 'echo') {
    if (say) say(c('gate') + d(': ' + clip(held.reason.split('\n')[0], 110)));
    const second = await engineTurn(held.reason);
    state.history.push({ role: 'user', text: held.reason }, { role: 'assistant', text: second });
    // Say that the first answer was held, so nobody reads its claim as the
    // result: in a live run a 4B model claimed a fix the tests had just refuted.
    reply = `${reply}\n\n[atlias held the answer above: ${clip((held.reason.split('\n').find((l) => /^\d+\. /.test(l)) || held.reason.split('\n')[0]).trim(), 200)}]\n\n${second}`;
  }
  return reply;
}
// ---------- saved sessions ----------
// Every turn is saved, so `atlias resume` (or agent --resume) carries on where
// the last session in this folder stopped, as codex resume does.
const CHATS = () => path.join(STATE_DIR, 'sessions');
export function chatPath(sid) { return path.join(CHATS(), `${safeId(sid)}.chat.json`); }
export function saveChat(state) {
  writeJson(chatPath(state.sid), { sid: state.sid, hostSid: state.hostSid, cwd: state.cwd, engine: state.engine, started: state.started, textTools: Boolean(state.textTools), history: state.history.slice(-60), messages: state.messages, todo: state.todo || [], edited: [...(state.edited || [])], cache: state.cache || null, saved: Date.now() });
}
// Newest first by file time, parsing only as many as it needs: a saved chat
// holds a whole conversation, so reading them all to find the last is slow.
export function listChats(cwd, limit = 20) {
  let files = [];
  try { files = fs.readdirSync(CHATS()).filter((f) => f.endsWith('.chat.json')).map((f) => { const p = path.join(CHATS(), f); let t = 0; try { t = fs.statSync(p).mtimeMs; } catch { /* gone */ } return { p, t }; }); } catch { return []; }
  files.sort((a, b) => b.t - a.t);
  const out = [];
  for (const { p } of files) {
    if (out.length >= limit) break;
    const c = readJson(p);
    if (c && c.sid && (!cwd || path.resolve(c.cwd) === path.resolve(cwd))) out.push(c);
  }
  return out;
}
// which: a session id or any unique part of one, or 'last' for the newest here.
export function loadChat(which, cwd) {
  let c = null;
  if (which && which !== 'last' && which !== true) {
    c = readJson(chatPath(which));
    if (!c) { const hits = listChats(null, Infinity).filter((x) => x.sid.includes(String(which))); c = hits.length === 1 ? hits[0] : null; }
  } else c = listChats(cwd)[0] || null;
  if (!c) return null;
  return { sid: c.sid, hostSid: c.hostSid, cwd: c.cwd, engine: c.engine, started: Boolean(c.started), textTools: Boolean(c.textTools), history: c.history || [], messages: c.messages || [], todo: c.todo || [], edited: new Set(c.edited || []), cache: c.cache || null };
}

// ---------- what the repl can show ----------
export function statusText(state) {
  const sent = loop.view(state.messages, config().agent.keepObservations, config().agent.evictBlock);
  const size = (ms) => Math.round(ms.reduce((n, m) => n + String(m.content || '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0) / 4);
  const plan = state.todo && state.todo.length ? `${state.todo.filter((t) => t.done).length}/${state.todo.length} done` : 'none yet';
  const u = usage.line();
  return [
    `engine ${state.engine}   mode ${settings.mode()}   session ${state.sid}`,
    `project ${state.cwd}`,
    `turns ${Math.floor(state.history.length / 2)}   messages ${state.messages.length}   about ${size(sent)} tokens sent per call (${size(state.messages)} before masking)`,
    `plan ${plan}   files changed ${state.edited ? state.edited.size : 0}   undo steps ${state.undo ? state.undo.length : 0}`,
    // What the provider said it served from cache, or plainly that it said
    // nothing. The claude and codex engines run their own conversations, so
    // atlias never sees their usage and does not pretend to.
    loop.cacheLine(state.cache) || `prompt cache: nothing measured yet${['claude', 'codex'].includes(state.engine) ? `; the ${state.engine} engine makes its own calls, so atlias never sees their token counts` : ''}`,
    u ? `usage ${u} Information only.` : 'usage: no reading from the usage-limits plugin',
  ].join('\n');
}
export function diffText(cwd) {
  const stat = run('git', ['diff', 'HEAD', '--stat'], { cwd, timeout: 15000 });
  if (stat.status !== 0) return 'no diff: this is not a git repository, or git is not installed';
  const body = run('git', ['diff', 'HEAD'], { cwd, timeout: 15000 });
  const fresh = run('git', ['ls-files', '--others', '--exclude-standard'], { cwd, timeout: 15000 });
  const untracked = (fresh.stdout || '').trim();
  const text = `${(stat.stdout || '').trim() || 'no changes to tracked files'}${untracked ? `\nnew files:\n${untracked}` : ''}\n\n${body.stdout || ''}`;
  return loop.elide(text.trim(), 12000);
}
// /review: the engine reads the uncommitted changes as a reviewer, not an author.
export function reviewPrompt(cwd) {
  const d = diffText(cwd);
  if (/^no diff:|^no changes to tracked files$/.test(d.trim())) return null;
  return `Review the uncommitted changes below as a careful code reviewer. Look for bugs, regressions, missing error handling, missing or weakened tests, and anything left unfinished. List each finding with its file and line, most severe first, and say plainly if you find nothing. Do not change any files.\n\n${d}`;
}

export const ENGINE_ORDER = ['claude', 'codex', 'openai', 'ollama'];
export function pickEngine(requested) {
  const want = requested || config().agent.engine;
  const have = detectEngines();
  if (want && want !== 'auto') return have[want] ? want : null;
  for (const e of ENGINE_ORDER) if (have[e]) return e;
  return null;
}
export const NO_ENGINE = 'install Claude Code (claude) or Codex (codex), run Ollama, or point atlias at any OpenAI-compatible endpoint: atlias config set agent.openaiModel <model> with ATLIAS_API_KEY or OPENAI_API_KEY set (and agent.openaiUrl for anything but OpenAI). --engine echo exercises the loop without a model.';
// One prompt, no questions: `atlias exec`. Anything that would need a yes (a
// destructive command, a write outside the project) is refused, because there
// is nobody to ask. The result says what changed and what was checked.
// The sandbox is asked for by a flag or by the setting, and the flag wins
// either way round, so --no-sandbox is a real answer and not a no-op.
export function sandboxWanted(opts = {}, cfg = config().agent) {
  if (opts && opts.sandbox === true) return true;
  if (opts && opts.sandbox === false) return false;
  return cfg.sandbox === true;
}
export async function runOnce(opts = {}) {
  const box = sandboxWanted(opts) ? sandbox.begin(process.cwd()) : null;
  if (box && box.fatal) return { code: 2, text: sandbox.opening(box), json: { error: 'the sandbox refused', sandbox: box.kind } };
  const cwd = box && box.isolated ? box.dir : process.cwd();
  let settled = false;
  try {
    const r = await execOnce(cwd, opts);
    if (!box) return r;
    settled = true;
    // There is nobody to ask in exec, so the answer is no and the patch is
    // kept: taking a diff into the project with no one asked is the thing
    // the rest of this harness refuses to do.
    const f = await sandbox.finish(box, {});
    return { ...r, text: `${r.text}\n\n${sandbox.opening(box)}\n${f.why}`, json: { ...r.json, sandbox: { dir: box.dir, isolated: box.isolated, taken: f.taken, files: f.files, note: f.why } } };
  } finally { if (box && !settled) sandbox.close(box); }
}
async function execOnce(cwd, opts) {
  let state = opts.resume ? loadChat(opts.resume, cwd) : null;
  if (opts.resume && !state) return { code: 2, text: `no saved session matches ${opts.resume}`, json: { error: 'no saved session' } };
  const engine = state && detectEngines()[state.engine] ? state.engine : pickEngine(opts.engine);
  if (!engine) return { code: 2, text: `no engine found: ${NO_ENGINE}`, json: { error: 'no engine' } };
  if (!state) state = newState(cwd, engine);
  // A different engine cannot read the old one's messages (native tool calls
  // in one, text blocks in another), so it starts its own conversation.
  if (state.engine !== engine) { state.engine = engine; state.started = false; state.messages = []; state.textTools = false; }
  const reply = await turn(state, opts.prompt, null, null);
  saveChat(state);
  dream.distil(state.sid, '', cwd);
  const evs = events(state.sid).concat(state.hostSid ? events(state.hostSid) : []);
  const files = [...new Set(evs.filter((e) => e.kind === 'edit').flatMap((e) => e.files || []))];
  const checks = evs.filter((e) => e.kind === 'shell' && e.verify).map((e) => ({ command: e.command, outcome: e.outcome || 'unknown' }));
  return { code: 0, text: reply, json: { reply, engine, session: state.sid, files_changed: files, checks, cache: state.cache || null } };
}

export async function repl(opts = {}) {
  const out = (s) => process.stdout.write(s + '\n');
  const box = sandboxWanted(opts) ? sandbox.begin(process.cwd()) : null;
  if (box) out(sandbox.opening(box));
  if (box && box.fatal) return 2;
  let code = 2;
  try { code = await replIn(box && box.isolated ? box.dir : process.cwd(), opts, out); } finally { if (box) await settleSandbox(box, out); }
  return code;
}
// The take-or-drop question gets a readline of its own, because the repl has
// closed its own by the time the run is over, and because every way out of
// the repl - /exit, end of input, a crash - has to reach this or a worktree
// is left behind.
async function settleSandbox(box, out) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const f = await sandbox.finish(box, { ask: (q) => rl.question(c(q)), say: out });
    if (f.why) out(f.why);
    if (f.closed) out(d(f.closed));
  } finally { rl.close(); }
}
async function replIn(cwd, opts, out) {
  let state = opts.resume ? loadChat(opts.resume, cwd) : null;
  if (opts.resume && !state) out(d('no saved session to resume here; starting a new one'));
  const engine = state && detectEngines()[state.engine] ? state.engine : pickEngine(opts.engine);
  if (!engine) { out(`${c('no engine found')}: ${NO_ENGINE}`); return 2; }
  if (!state) state = newState(cwd, engine);
  if (state.engine !== engine) { state.engine = engine; state.started = false; state.messages = []; state.textTools = false; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => rl.question(q);
  if (opts.once) { out(await turn(state, opts.once, ask, out)); rl.close(); saveChat(state); dream.distil(state.sid, '', cwd); return 0; }
  out(logo());
  out(d(`engine ${engine}   project ${cwd}   memory shared with Claude Code   /help for commands`));
  if (state.history.length) out(d(`resumed session ${state.sid} (${Math.floor(state.history.length / 2)} turns); /status shows where it stands`));
  if (progress.read(cwd)) out(d('a handoff note from earlier work is here; /progress shows it'));
  for (;;) {
    let line;
    try { line = await rl.question(c('you> ')); } catch { break; }
    const t = String(line || '').trim();
    if (!t) continue;
    if (t === '/exit' || t === '/quit') break;
    if (t === '/help') { out(['/engine claude|codex|openai|ollama|echo   switch engine', '/status                            engine, session, context size, plan, prompt cache, usage', '/permissions [workspace|ask|read-only]   what the agent may do without asking', '/diff                              the uncommitted changes', '/review                            have the engine review the uncommitted changes', '/undo                              take back the last change this agent made', '/compact                           drop older messages, keep the plan', '/sessions                          saved sessions in this folder (atlias resume <id>)', '/plan                              the agent\'s current plan', '/graph <question>                  ask the knowledge graph', '/skills [name]                     the skills installed here, or one of them in full', '/recall <query>                    search memory and digests', '/progress [set <next step>]        the handoff note', '/settings                          change any option', '/hosts                             harnesses atlias can see', '/doctor                            harness health', '/exit'].join('\n')); continue; }
    if (t === '/status') { out(statusText(state)); continue; }
    if (t === '/permissions' || t.startsWith('/permissions ')) { const v = t.slice(12).trim(); out(v ? settings.set('agent.permissions', v).text : `permissions ${config().agent.permissions}: workspace (edits in the project run), ask (every edit and command asks first), read-only (plan mode, no edits)`); continue; }
    if (t === '/diff') { out(diffText(cwd)); continue; }
    if (t === '/undo') { out(['ollama', 'openai'].includes(state.engine) || (state.undo && state.undo.length) ? loop.undo(state) : 'undo covers changes made by the ollama and openai engines; claude and codex keep their own history'); saveChat(state); continue; }
    if (t === '/compact') { out(loop.compact(state)); saveChat(state); continue; }
    if (t === '/sessions') { const list = listChats(cwd).slice(0, 10); out(list.length ? list.map((s) => `${s.sid}   ${s.engine}   ${Math.floor((s.history || []).length / 2)} turns   ${new Date(s.saved).toLocaleString()}`).join('\n') : 'no saved sessions in this folder'); continue; }
    if (t === '/review') { const p = reviewPrompt(cwd); if (!p) { out('nothing to review: no uncommitted changes'); continue; } out('\n' + (await turn(state, p, ask, out)) + '\n'); saveChat(state); continue; }
    if (t.startsWith('/engine ')) { const e = t.slice(8).trim(); if (detectEngines()[e]) { state.engine = e; state.started = false; state.messages = []; state.textTools = false; out(d(`engine ${e}; the new engine starts a conversation of its own`)); } else out(c(`engine ${e} is not available here`)); continue; }
    if (t.startsWith('/graph ')) { out(graph.query(cwd, t.slice(7), config().graph.queryBudget) || 'no graph here, or no answer'); continue; }
    if (t === '/skills' || t.startsWith('/skills ')) { const which = t.slice(7).trim(); if (!which) { out(skills.format(skills.discover(cwd))); continue; } const one = skills.body(cwd, which); out(one ? `${one.path}\n\n${one.text}` : `no skill matches ${which}; /skills lists them`); continue; }
    if (t.startsWith('/recall ')) { out(recall(cwd, t.slice(8))); continue; }
    if (t.startsWith('/progress')) { const rest = t.slice(9).trim(); if (rest.startsWith('set ')) progress.setNext(cwd, rest.slice(4)); out(progress.update(cwd, state.sid, null)); continue; }
    if (t === '/plan') { out(state.todo && state.todo.length ? loop.renderTodo(state.todo) : 'no plan yet; the agent writes one with its todo tool'); continue; }
    if (t === '/settings') { await settings.menu(ask, out); continue; }
    if (t === '/hosts') { out(extra.statusLine()); continue; }
    if (t === '/doctor') { out(hosts.formatDoctor(hosts.doctor(cwd).concat(extra.doctorRows()))); continue; }
    out('\n' + (await turn(state, t, ask, out)) + '\n');
    saveChat(state);
  }
  rl.close();
  const row = dream.distil(state.sid, '', cwd);
  out(d(row ? `session distilled to digest cursor ${row.cursor}; consolidate it with \`atlias dream\`` : 'nothing to distil'));
  return 0;
}

// What typing atlias with nothing after it shows. It asks every time; the
// mode setting (atlias mode sub|standalone) is what makes it stop asking.
export async function chooser() {
  const out = (s) => process.stdout.write(s + '\n');
  out(logo());
  out('');
  out(`  ${b('[1] sub-harness')}   ${d('link atlias into every harness on this machine; its hooks and MCP server run inside them')}`);
  out(`  ${b('[2] regular agent')} ${d('fly atlias here, in this terminal, with Claude Code, Codex, an OpenAI-compatible model or Ollama as the engine')}`);
  out(`  ${b('[3] settings')}      ${d('the mode, the engine, the checks and every other option')}`);
  out('');
  out(d('  ' + extra.statusLine()));
  out(d(`  mode ${settings.mode()}: atlias mode sub or standalone makes this screen go straight to one of them`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = String(await rl.question(c('  choose 1, 2 or 3: '))).trim();
  if (answer === '3' || /^set/i.test(answer)) {
    const code = await settings.menu((q) => rl.question(q), out);
    rl.close();
    return code;
  }
  rl.close();
  if (answer === '1' || /^sub/i.test(answer)) {
    out(hosts.installCodex().concat(hosts.installAntigravity(), hosts.installGemini(false), extra.installAll(), hosts.installCompanions()).join('\n'));
    out(hosts.formatDoctor(hosts.doctor(process.cwd()).concat(extra.doctorRows())));
    return 0;
  }
  if (answer === '2' || /^(agent|regular)/i.test(answer)) return repl();
  out(d('nothing chosen; `atlias install` links the harnesses, `atlias agent` flies the ship, `atlias settings` changes options.'));
  return 0;
}
