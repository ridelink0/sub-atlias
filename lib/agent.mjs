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
import { ROOT, VERSION, config, saveSessionMeta, clip, STATE_DIR, readJson, writeJson, safeId, run, events } from './core.mjs';
import { createDisplay, metrics as usageMetrics, segments as usageSegments } from './usage-display.mjs';
import { logo, colorMode, accent, dim, bold } from './logo.mjs';
import * as router from './router.mjs';
import * as gate from './gate.mjs';
import * as progress from './progress.mjs';
import * as dream from './dream.mjs';
import * as graph from './graph.mjs';
import * as hosts from './hosts.mjs';
import * as extra from './hosts-extra.mjs';
import * as loop from './loop.mjs';
import { abortRunning } from './proc.mjs';
import { postJsonAbortable } from './http-abort.mjs';
import { renderMarkdown, plainText } from './render-markdown.mjs';
import * as settings from './settings.mjs';
import * as sandbox from './sandbox.mjs';
import * as skills from './skills.mjs';
import * as ledger from './authority.mjs';
import * as helpers from './local-helpers.mjs';
import * as permissions from './permissions.mjs';
import { recall } from '../mcp/tools.mjs';
import * as commands from './commands.mjs';
import * as importer from './import.mjs';
import * as updater from './update.mjs';
import * as qol from './qol.mjs';
import * as onboarding from './onboarding.mjs';
import { DIRECT_ENGINES, chooseEngine, engineLine, describeEngine } from './engines.mjs';
import { planEngine, prepared as chatgptPrepared } from './chatgpt.mjs';
import * as claudePlan from './claude-plan.mjs';
import { hostEnginesAllowed } from './engines.mjs';

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
export function detectEngines({ includeHosts = true } = {}) {
  const ok = (cmd) => cli(cmd, ['--version'], '', process.cwd(), VERSION_PROBE_MS).status === 0;
  const cfg = config().agent;
  return { claude: includeHosts && ok('claude'), codex: includeHosts && ok('codex'),
    'claude-plan': claudePlan.prepared(), chatgpt: chatgptPrepared(), responses: Boolean(cfg.responsesModel && (process.env.ATLIAS_RESPONSES_API_KEY || process.env.OPENAI_API_KEY)),
    anthropic: Boolean(cfg.anthropicModel && process.env.ANTHROPIC_API_KEY), gemini: Boolean(cfg.geminiModel && (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)),
    openai: loop.openaiReady(), ollama: ollamaAlive(cfg.ollamaUrl), echo: true };
}
// Native authentication remains inside the official CLI. Only booleans escape
// this parser; provider output, account identifiers and credential text do not.
export function parseNativeAuthStatus(engine, result, available = true) {
  if (!['claude', 'codex'].includes(engine)) return { available: false, authenticated: false, subscription: false };
  if (!result || result.status !== 0 || result.error) return { available, authenticated: false, subscription: false };
  const output = `${String(result.stdout || '')}\n${String(result.stderr || '')}`;
  if (engine === 'codex') {
    const method = (name) => new RegExp(`(?:^|\\r?\\n)\\s*Logged in using ${name}\\b[^\\r\\n]*\\s*$`, 'im').test(output);
    const chatgpt = method('ChatGPT');
    const authenticated = ['ChatGPT', 'an API key', 'workload identity', 'access token', 'personal access token', 'Amazon Bedrock API key', 'Amazon Bedrock AWS access keys'].some(method);
    return { available: true, authenticated, subscription: chatgpt };
  }
  let body;
  for (const candidate of [String(result.stdout || '').trim(), String(result.stderr || '').trim()]) {
    try { body = JSON.parse(candidate); break; } catch { /* the other stream may contain the JSON status */ }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { available: true, authenticated: false, subscription: false };
  const method = typeof body.authMethod === 'string' ? body.authMethod.toLowerCase() : '';
  const explicit = [body.loggedIn, body.authenticated].filter((value) => typeof value === 'boolean');
  const authenticated = explicit.includes(false) ? false : explicit.includes(true) || method === 'claude.ai' || method === 'oauth_token';
  return { available: true, authenticated, subscription: authenticated && method === 'claude.ai' };
}
export function nativeAuthStatus(engine, { run: runCli = cli, available = detectEngines()[engine] === true } = {}) {
  if (!['claude', 'codex'].includes(engine)) return { available: false, authenticated: false, subscription: false };
  if (!available) return { available: false, authenticated: false, subscription: false };
  const args = engine === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'];
  return parseNativeAuthStatus(engine, runCli(engine, args, '', process.cwd(), 5000), available);
}
export function nativeLogin(engine, { cwd = process.cwd(), spawn = spawnSync } = {}) {
  if (!['claude', 'codex'].includes(engine)) return { started: false, exitCode: null };
  const args = engine === 'claude' ? ['auth', 'login'] : ['login'];
  const command = resolveCommand(engine, args);
  const result = spawn(command.file, command.args, { cwd, stdio: 'inherit', windowsHide: false });
  return { started: !result.error, exitCode: Number.isInteger(result.status) ? result.status : null };
}
export function nativeLogout(engine, { cwd = process.cwd(), spawn = spawnSync } = {}) {
  if (engine !== 'claude') return { started: false, exitCode: null, supported: false };
  const args = ['auth', 'logout'];
  const command = resolveCommand(engine, args);
  const result = spawn(command.file, command.args, { cwd, stdio: 'inherit', windowsHide: false });
  return { started: !result.error, exitCode: Number.isInteger(result.status) ? result.status : null, supported: true };
}
// What first-open setup may run, each only after the person says yes, each in
// this terminal: npm for the Claude Agent SDK, the ChatGPT runtime script and
// ollama pull.
export function setupHelpers({ spawn = spawnSync } = {}) {
  const visible = (cmd, args) => { const r = resolveCommand(cmd, args); const x = spawn(r.file, r.args, { stdio: 'inherit', windowsHide: false }); return !x.error && x.status === 0; };
  return { nativeAuthStatus, nativeLogin, resolve: resolveCommand,
    prepareChatGPT: () => visible(process.execPath, [path.join(ROOT, 'scripts', 'setup-chatgpt-personal.mjs'), '--personal']),
    pullOllama: (model) => visible('ollama', ['pull', model]) };
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
  // An unbound --continue can select another session in this project. A failed
  // pinned launch must likewise not create an anonymous, unresumable session.
  const r = exec('claude', claudeArgs(state), prompt, state.cwd);
  if (r.status !== 0 || r.error) return `claude failed: ${clip(((r.stderr || '') + (r.error ? r.error.message : '')).trim(), 500)}`;
  state.started = true;
  return (r.stdout || '').trim();
}
// flags.authorityLedger: codex is one shot, so the prompt itself must carry the
// session's exact requests and selected skills. They come from the authority
// ledger, which router.prompt writes for every turn of every engine, unclipped.
// state.asks is not the source: only the loop's rememberAsk writes it, and a
// codex turn never reaches the loop, so a codex session never fills it.
const GATE_NOW = 'Now Atlias says (generated by Atlias, not by the user; the user\'s requests are listed above):';
const USER_NOW = 'Now the user says:';
// /review's prompt is written by Atlias from the uncommitted diff; the person typed only the command.
const REVIEW_NOW = 'Now Atlias asks for a review (generated by Atlias from the /review command, not typed by the user; the user\'s requests are listed above):';
const GENERATED_ROLES = { gate: 'Atlias gate (generated by Atlias, not the user)', review: 'Atlias review request (generated by Atlias, not the user)' };
// { text, complete }: complete is false when the ledger cannot be read or the
// state says earlier requests were never recorded, and the prompt says so.
function exactAuthorityText(state) {
  let rows;
  try { rows = ledger.read(state.sid); } catch (e) {
    return { text: `[atlias: exact request authority is unavailable for this session (${clip(e.message, 200)}). The recent turns below are the only record of this session, and they may not be complete.]`, complete: false };
  }
  const requests = rows.filter((r) => r.kind === 'request');
  const skills = rows.filter((r) => r.kind === 'skill');
  const out = [];
  if (state.authorityMissing) out.push('[atlias: exact request history is incomplete for this saved session. Requests made before exact recording began are not listed; every request listed below is exact.]');
  else if (!requests.length) out.push('[atlias: exact request history is incomplete for this session: no request rows are available. Recent turns below may be incomplete.]');
  if (requests.length) out.push(`Every request of this session, oldest first, verbatim. Later amendments govern earlier requests. This is retained authority, not a new message.\n\n${requests.map((r, i) => `User request ${i + 1} of ${requests.length}:\n${r.text}`).join('\n\n')}`);
  if (skills.length) out.push(`Selected skill instructions, exact text, in the order they were selected:\n\n${skills.map((r, i) => `Selected skill ${i + 1} of ${skills.length} (${r.file || 'file not recorded'}):\n${r.text}`).join('\n\n')}`);
  return { text: out.join('\n\n'), complete: !state.authorityMissing && requests.length > 0 };
}
export function codexTurn(state, prompt, deps = {}) {
  const exec = deps.run || cli;
  const exact = Boolean(config().flags?.authorityLedger);
  // codex exec is one shot, so atlias carries the continuity in the prompt.
  const history = state.history.slice(-6).map((h) => `${h.role === 'user' ? 'User' : exact && GENERATED_ROLES[h.role] ? GENERATED_ROLES[h.role] : 'Assistant'}: ${clip(h.text, 1200)}`).join('\n');
  let full;
  if (!exact) full = history ? `Earlier in this session:\n${history}\n\nNow the user says:\n${prompt}` : prompt;
  else {
    const exactPart = exactAuthorityText(state);
    const recent = history ? `Earlier in this session (recent turns, each clipped to 1200 characters${exactPart.complete ? '; the exact requests above are complete' : ''}):\n${history}` : '';
    const now = `${deps.generated === 'gate' ? GATE_NOW : deps.generated === 'review' ? REVIEW_NOW : USER_NOW}\n${prompt}`;
    full = [exactPart.text, recent, now].filter(Boolean).join('\n\n');
  }
  let r = exec('codex', ['exec', '-'], full, state.cwd);
  if (r.status !== 0 || r.error) r = exec('codex', ['exec', full], '', state.cwd);
  if (r.status !== 0 || r.error) return `codex failed: ${clip(((r.stderr || '') + (r.error ? r.error.message : '')).trim(), 500)}`;
  return (r.stdout || '').trim();
}
// agent.subagents: interactive and exec turns may hand parts of the work to
// sub-agents. Eval and benchmark runs call loop.runLoop directly and never do.
export const subagentsOn = (cfg = config().agent) => cfg.subagents !== 'off';
// TUI-B: a turn can be stopped. The chat call races the turn's signal, and the HTTP request behind it is cut.
// Without a signal nothing changes: the transports get the same arguments as before.
export const INTERRUPTED = 'Interrupted before the answer was finished.';
export function withSignal(chat, signal) {
  if (!signal) return chat;
  return async (messages, tools, at = {}) => {
    if (signal.aborted) return { error: 'interrupted' };
    let stop;
    const cut = new Promise((resolve) => { stop = () => resolve({ error: 'interrupted' }); signal.addEventListener('abort', stop, { once: true }); });
    try { return await Promise.race([chat(messages, tools, { ...at, signal }), cut]); }
    finally { signal.removeEventListener('abort', stop); }
  };
}
const abortablePost = (signal) => signal ? (url, body, headers, timeout, maxBytes) => postJsonAbortable(url, body, headers, timeout, maxBytes, signal) : undefined;
// The two engines atlias drives itself, through its own tool loop.
export function ollamaTurn(state, prompt, ask, say, signal) {
  return loop.runLoop(state, prompt, { chat: withSignal(loop.ollamaChat(config().agent, { post: abortablePost(signal) }), signal), ask, say, native: false, subagents: subagentsOn() });
}
export function openaiTurn(state, prompt, ask, say, signal) {
  const cfg = config().agent;
  return loop.runLoop(state, prompt, { chat: withSignal(loop.openaiChat(cfg, process.env, { post: abortablePost(signal) }), signal), ask, say, native: cfg.nativeTools !== false, subagents: subagentsOn() });
}
export async function directTurn(state, prompt, ask, say, signal) {
  const cfg = config().agent;
  const native = await import('./direct-transports.mjs');
  const adapters = { responses: native.responsesChat, anthropic: native.anthropicChat, gemini: native.geminiChat };
  const env = process.env;
  const options = {
    responses: { model: cfg.responsesModel, reasoning: cfg.responsesReasoningEffort === 'model' ? undefined : cfg.responsesReasoningEffort, baseURL: cfg.responsesUrl, key: env.ATLIAS_RESPONSES_API_KEY || env.OPENAI_API_KEY },
    anthropic: { model: cfg.anthropicModel, maxTokens: cfg.anthropicMaxTokens, baseURL: cfg.anthropicUrl, key: env.ANTHROPIC_API_KEY, effort: cfg.anthropicEffort },
    gemini: { model: cfg.geminiModel, baseURL: cfg.geminiUrl, key: env.GEMINI_API_KEY || env.GOOGLE_API_KEY },
  };
  // claude-plan: one SDK turn per call with Claude Code's own tools off, so the
  // tools are Atlias's text blocks and Atlias's loop runs every one of them.
  const chat = state.engine === 'claude-plan' ? claudePlan.claudePlanChat(cfg)
    : state.engine === 'chatgpt' ? (messages, tools) => planEngine.chat(messages, tools, cfg)
    : (messages, tools, at) => adapters[state.engine](messages, { ...options[state.engine], tools, cwd: at.cwd, request: signal ? (u, b, h) => postJsonAbortable(u, b, h, 120000, loop.MAX_RESPONSE_BYTES, signal) : undefined });
  const result = await loop.runLoop(state, prompt, { chat: withSignal(chat, signal), ask, say, native: state.engine !== 'claude-plan' && cfg.nativeTools !== false, subagents: subagentsOn() });
  if (state.cache?.reported) state.cache.source = state.engine === 'chatgpt' ? 'responses' : state.engine;
  return result;
}

// ---------- the loop ----------
export function newState(cwd, engine) {
  const hostSid = crypto.randomUUID();
  const sid = 'atlias-' + hostSid;
  saveSessionMeta(sid, { host: 'atlias', cwd, source: 'startup', started: Date.now(), engine });
  return { sid, hostSid, cwd, engine, started: false, history: [], messages: [] };
}
export async function turn(state, text, ask, say, deps = {}) {
  const exact = Boolean(config().flags?.authorityLedger);
  // Detect loss before router.prompt can recreate a ledger containing only the
  // newest follow-up. Keep the incompleteness marker across later turns/saves.
  if (exact && state.history.length) {
    try { if (!ledger.read(state.sid).some(r => r.kind === 'request')) state.authorityMissing = true; }
    catch { state.authorityMissing = true; }
  }
  // deps.generated 'review' marks text Atlias wrote itself. With flags.authorityLedger it is never
  // recorded as the person's request and codex is told who wrote it; off, it is a user turn as before.
  const origin = exact && deps.generated === 'review' ? 'review' : '';
  const routed = router.prompt({ session_id: state.sid, cwd: state.cwd, prompt: text, ...(origin ? { atlias_generated: origin } : {}) });
  const extraContext = routed && routed.hookSpecificOutput ? routed.hookSpecificOutput.additionalContext : '';
  let prompt = extraContext ? `${extraContext}\n\n${text}` : text;
  // A session brought in by `atlias import` carries a digest of the old conversation, sent with its
  // first new turn only. Any other session has no importedNote, so nothing changes for it.
  if (state.importedNote) { prompt = `${state.importedNote}\n\n${prompt}`; delete state.importedNote; }
  // Off (localPipeline.planner not exactly true) this returns at once and the prompt is unchanged.
  // On, the planner reads the exact ledger and its advice follows the person's own text, labelled untrusted.
  const planned = exact && state.authorityMissing ? { ran: false } : await helpers.planTurn({ cfg: config(), sid: state.sid, fetchImpl: deps.fetchImpl });
  if (planned.ran && planned.block) prompt = `${prompt}\n\n${planned.block}`;
  const engineTurn = async (input, generated = '') => {
    if (['claude', 'codex'].includes(state.engine) && !hostEnginesAllowed(config().agent)) return HOST_OFF(state.engine);
    if (state.engine === 'claude') return claudeTurn(state, input);
    if (state.engine === 'codex') return codexTurn(state, input, { ...deps, generated });
    if (state.engine === 'openai') return openaiTurn(state, input, ask, say, deps.signal);
    if (state.engine === 'ollama') return ollamaTurn(state, input, ask, say, deps.signal);
    if (['claude-plan', 'chatgpt', 'responses', 'anthropic', 'gemini'].includes(state.engine)) return directTurn(state, input, ask, say, deps.signal);
    return state.engine === 'echo' ? `echo: ${input}` : `Setup required. ${NO_ENGINE}`;
  };
  let reply = await engineTurn(prompt, origin);
  // Stopped with Esc or Ctrl+C: the stop says so, and the cut answer is not recorded as one (TUI-B 1).
  if (deps.signal?.aborted) { state.stop = { reason: 'interrupted', detail: 'stopped by the person' }; state.history.push({ role: 'user', text }, { role: 'assistant', text: INTERRUPTED }); return INTERRUPTED; }
  state.history.push({ role: origin || 'user', text }, { role: 'assistant', text: reply });
  const held = gate.stop({ session_id: state.sid, cwd: state.cwd, last_assistant_message: reply });
  if (held && held.decision === 'block' && state.engine !== 'echo') {
    if (say) say(c('gate') + d(': ' + clip(held.reason.split('\n')[0], 110)));
    // With flags.authorityLedger the gate's words are Atlias's own, so they keep
    // a role of their own and codex is told they were generated, never that the
    // user said them. Off, they are recorded as a user line, as they always were.
    const generated = config().flags?.authorityLedger ? 'gate' : '';
    const second = await engineTurn(held.reason, generated);
    state.history.push({ role: generated ? 'gate' : 'user', text: held.reason }, { role: 'assistant', text: second });
    // Say that the first answer was held, so nobody reads its claim as the
    // result: in a live run a 4B model claimed a fix the tests had just refuted.
    reply = `${reply}\n\n[atlias held the answer above: ${clip((held.reason.split('\n').find((l) => /^\d+\. /.test(l)) || held.reason.split('\n')[0]).trim(), 200)}]\n\n${second}`;
  }
  // Off, nothing. On, one line for the person's screen, labelled unverified; it is not in the reply,
  // the history or any later prompt, so no model reads it.
  const reported = exact && state.authorityMissing ? { ran: false } : await helpers.reportTurn({ cfg: config(), sid: state.sid, answer: reply, fetchImpl: deps.fetchImpl });
  if (reported.ran && reported.line && say) say(d(reported.line));
  return reply;
}
// ---------- saved sessions ----------
// Every turn is saved, so `atlias resume` (or agent --resume) carries on where
// the last session in this folder stopped, as codex resume does.
const CHATS = () => path.join(STATE_DIR, 'sessions');
export function chatPath(sid) { return path.join(CHATS(), `${safeId(sid)}.chat.json`); }
export function saveChat(state) {
  const exact = Boolean(config().flags?.authorityLedger);
  const pending = state[Symbol.for('atlias.resumeRequests')];
  const asks = pending && Array.isArray(pending.asks) ? [...pending.asks, ...(state.asks || [])] : state.asks;
  // A codex session never fills state.asks (its turns skip the loop); its exact
  // requests live in the authority ledger, so missing asks are not missing authority.
  const authority = exact ? { asks: Array.isArray(asks) ? [...asks] : [], authorityMissing: Boolean(state.authorityMissing || pending?.missing || (!Array.isArray(asks) && state.engine !== 'codex')) } : {};
  writeJson(chatPath(state.sid), { sid: state.sid, hostSid: state.hostSid, cwd: state.cwd, engine: state.engine, started: state.started, textTools: Boolean(state.textTools), history: state.history.slice(-60), messages: state.messages, todo: state.todo || [], edited: [...(state.edited || [])], cache: state.cache || null, ...authority, ...(state.importedNote ? { importedNote: state.importedNote } : {}), ...(state.name ? { name: state.name } : {}), saved: Date.now() });
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
    // A name given with /rename: exact, in this folder, and only when one session has it.
    if (!c && cwd) { const named = listChats(cwd, Infinity).filter((x) => x.name && x.name.toLowerCase() === String(which).toLowerCase()); c = named.length === 1 ? named[0] : null; }
  } else c = listChats(cwd)[0] || null;
  if (!c) return null;
  const exact = Boolean(config().flags?.authorityLedger);
  if (exact && Object.hasOwn(c, 'asks') && (!Array.isArray(c.asks) || c.asks.some((a) => typeof a !== 'string'))) throw Error('Invalid saved request ledger; exact authority is unavailable.');
  const authority = exact ? { asks: c.asks || [], authorityMissing: Boolean(c.authorityMissing || !Array.isArray(c.asks)) } : {};
  const state = { sid: c.sid, hostSid: c.hostSid, cwd: c.cwd, engine: c.engine, started: Boolean(c.started), textTools: Boolean(c.textTools), history: c.history || [], messages: c.messages || [], todo: c.todo || [], edited: new Set(c.edited || []), cache: c.cache || null, ...authority, ...(typeof c.importedNote === 'string' && c.importedNote ? { importedNote: c.importedNote } : {}), ...(typeof c.name === 'string' && c.name ? { name: c.name } : {}) };
  // Private resume metadata does not alter flag-off serialization or prompts.
  // A later setting change can restore a complete ledger or detect missing data.
  if (!exact) {
    const valid = Array.isArray(c.asks) && c.asks.every(a => typeof a === 'string');
    Object.defineProperty(state, Symbol.for('atlias.resumeRequests'), { configurable: true,
      value: { asks: valid ? [...c.asks] : null, missing: Boolean(c.authorityMissing || !valid) } });
  }
  return state;
}

// ---------- what the repl can show ----------
export function statusText(state) {
  const sent = loop.view(state.messages, config().agent.keepObservations, config().agent.evictBlock);
  const size = (ms) => Math.round(ms.reduce((n, m) => n + String(m.content || '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0) / 4);
  const plan = state.todo && state.todo.length ? `${state.todo.filter((t) => t.done).length}/${state.todo.length} done` : 'none yet';
  return [
    `${engineLine(state.engine, config().agent)}   mode ${settings.mode()}   session ${state.sid}`,
    `project ${state.cwd}`,
    `turns ${Math.floor(state.history.length / 2)}   messages ${state.messages.length}   about ${size(sent)} tokens sent per call (${size(state.messages)} before masking)`,
    `plan ${plan}   files changed ${state.edited ? state.edited.size : 0}   undo steps ${state.undo ? state.undo.length : 0}`,
    // What the provider said it served from cache, or plainly that it said
    // nothing. The claude and codex engines run their own conversations, so
    // atlias never sees their usage and does not pretend to.
    loop.cacheLine(state.cache) || `prompt cache: nothing measured yet${['claude', 'codex'].includes(state.engine) ? `; the ${state.engine} engine makes its own calls, so atlias never sees their token counts` : ''}`,
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

export const ENGINE_ORDER = DIRECT_ENGINES;
export function pickEngine(requested) {
  const want = requested || config().agent.engine;
  if (want === 'echo') return 'echo';
  if (['claude', 'codex'].includes(want) && !hostEnginesAllowed(config().agent)) return null;
  if (!['auto', ...DIRECT_ENGINES, 'claude', 'codex'].includes(want)) return null;
  const have = detectEngines({ includeHosts: want === 'claude' || want === 'codex' });
  return chooseEngine(want, have);
}
export function resolveLaunchEngine(state, opts, setupRow, choose = pickEngine) {
  const blocked = onboarding.requiresFirstOpen(setupRow, opts);
  const selected = blocked ? null : choose(state ? state.engine : opts.engine);
  return { selected, engine: blocked ? 'setup' : selected || (state ? state.engine : 'setup'), blocked };
}
// agent.hostEngines off (the default): a saved claude or codex engine is refused, never run.
export const HOST_OFF = (engine) => `Atlias runs the model itself, so the ${engine} host harness is off. Use /engine claude-plan for your Claude plan (Atlias's own loop), /onboarding to choose another route, or atlias config set agent.hostEngines on to allow host harnesses. Nothing was sent.`;
export const NO_ENGINE = 'Choose a direct engine explicitly: /engine claude-plan for your Claude plan (atlias setup claude), /engine chatgpt with /auth chatgpt login (local personal prototype), responses with OPENAI_API_KEY, anthropic with ANTHROPIC_API_KEY, gemini with GEMINI_API_KEY, openai for a compatible endpoint, or ollama for local models. API billing is separate. Auto requires exactly one configured direct engine. claude and codex are explicit host harness modes. /onboarding opens setup; --engine echo makes no model calls.';
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
  const engine = pickEngine(state ? state.engine : opts.engine);
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

// What the repl's slash commands (lib/commands.mjs) call back into. Interactive only.
export const slashApi = { setupHelpers, resolveCommand, turn, statusText, diffText, reviewPrompt, listChats, loadChat, saveChat, newState, detectEngines, nativeAuthStatus, nativeLogin, nativeLogout, pickEngine, distil: (sid, cwd) => dream.distil(sid, '', cwd) };

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
  let setupRow = onboarding.readOnboarding();
  if (!opts.once && opts.engine !== 'echo') {
    if (process.stdin.isTTY && !['read-only', 'plan'].includes(config().agent.permissions)) {
      const setupRl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try { setupRow = await onboarding.firstOpen({ ask: (q) => setupRl.question(q), out, ...setupHelpers() }); }
      finally { setupRl.close(); }
    } else if (!process.stdin.isTTY && !onboarding.readOnboarding()) {
      out('First-open setup needs an interactive terminal. Start `atlias agent` in a terminal and choose a provider, or use --engine echo for a no-model diagnostic.');
    } else if (['read-only', 'plan'].includes(config().agent.permissions) && !onboarding.readOnboarding()) {
      out('Provider setup is read-only in this permission mode. Run /onboarding after switching to workspace or ask mode.');
    }
  }
  const launch = resolveLaunchEngine(state, opts, setupRow);
  if (launch.blocked && opts.once) {
    out('Provider setup is incomplete. Run `atlias agent` in an interactive terminal and choose a provider, or explicitly select a diagnostic engine with --engine echo.');
    return 2;
  }
  const selected = launch.selected;
  const engine = launch.engine;
  if (!selected) out(`${c('setup required')}: ${NO_ENGINE}`);
  if (!state) state = newState(cwd, engine);
  if (state.engine !== engine) { state.engine = engine; state.started = false; state.messages = []; state.textTools = false; }
  let rl, terminal = null, fallback = null;
  if (!opts.once && config().ui.terminalEnabled === true) {
    const ui = await import('./terminal-ui.mjs');
    const inputHistory = await import('./input-history.mjs');
    const historyFile = inputHistory.fileFor(STATE_DIR, cwd);
    if (ui.supported(process.stdin, process.stdout)) {
      terminal = ui.createTerminalUI({ input: process.stdin, output: process.stdout,
        // Up and Down walk this project's last 200 sent lines (TUI-A item 11); each send is saved.
        history: { initial: inputHistory.read(historyFile), save: (list) => inputHistory.write(historyFile, list) },
        getCommands: () => {
          const built = commands.BUILTINS.filter((x) => !x.hidden);
          const names = commands.builtinNames();
          return [...built, ...commands.loadCustom(cwd).list.filter((x) => !names.has(x.name))];
        },
        // Footer: model, permission mode, session name, then context and token counts (unknown stays unknown, never zero).
        getInfo: () => {
          const a = config().agent;
          // ui.usageEnabled (default off) decides whether the counts show at all (B5).
          const counts = config().ui.usageEnabled === true ? usageSegments(usageMetrics(state)).slice(0, 3).map(([k, v]) => `${k} ${v}`) : [];
          const info = describeEngine(state.engine, a);
          const route = ['claude', 'codex'].includes(state.engine) ? 'host' : state.engine === 'echo' ? 'dry run' : state.engine === 'setup' ? 'setup required' : 'direct';
          const model = ['not selected', 'selected by host'].includes(info.model) ? '' : ' ' + info.model;
          const effort = info.reasoning === 'provider default' ? '' : ' ' + info.reasoning;
          const billing = state.engine === 'claude-plan' ? 'Claude plan' : state.engine === 'chatgpt' ? 'ChatGPT plan' : ['responses', 'anthropic', 'gemini', 'openai'].includes(state.engine) ? 'API' : state.engine === 'ollama' ? 'local' : '';
          return { engine: `${state.engine}${model}${effort} (${route})`, permission: a.permissions, tokens: [billing, state.name, ...counts].filter(Boolean) };
        },
        fallbackQuestion: (q) => { fallback ||= readline.createInterface({ input: process.stdin, output: process.stdout }); return fallback.question(q || 'you> '); },
        closeFallback: () => { if (fallback) fallback.close(); },
      });
      terminal.welcome(VERSION, cwd);
      const plainOut = out;
      out = (text) => terminal ? terminal.log(text) : plainOut(text);
    }
  }
  rl = terminal || readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => rl.question(q);
  // First run: say what the other tools left behind and ask once. Not for --once, which is a single scripted turn.
  if (!opts.once) await importer.firstRunOffer({ ask, out });
  if (opts.once) { out(await turn(state, opts.once, ask, out)); rl.close(); saveChat(state); dream.distil(state.sid, '', cwd); return 0; }
  // Offer an update when the source has new commits (update.autoPrompt, terminal only, silent on any failure).
  await updater.maybeOffer({ ask, out });
  // What the composer hands back when a turn ends: queued messages, the draft and whether the person asked to leave (TUI-B).
  let handoff = { queued: [], draft: '', exit: false };
  // A reply in the composer is styled (bold, code, lists) when colour is on; a plain terminal gets the cleaned text (TUI-B 4).
  const showReply = (text) => {
    if (!terminal) { out(text); return; }
    const colour = !process.env.NO_COLOR && process.env.FORCE_COLOR !== '0';
    terminal.log(colour ? renderMarkdown(text, { color: true, width: process.stdout.columns }) : plainText(text), 'md');
  };
  // One typed message: @file mentions expanded, and a notification when the turn was long (agent.notifyAfterSeconds).
  const send = async (text) => {
    const x = qol.expandMentions(text, cwd);
    if (x.files.length) out(d(`attached ${x.files.join(', ')}`));
    for (const n of x.notes) out(d(n));
    const t0 = Date.now();
    // Esc or Ctrl+C in the composer stops the turn and the shell command it runs (TUI-B 1).
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => abortRunning(), { once: true });
    const composed = terminal ? terminal.turnStart(controller) : false;
    let reply;
    try { reply = await turn(state, x.text, ask, out, { signal: controller.signal }); }
    finally { if (composed) handoff = terminal.turnEnd(); }
    if (controller.signal.aborted) { out(d('Interrupted. What should Atlias do instead?')); return ''; }
    if (qol.shouldNotify(Date.now() - t0, config().agent.notifyAfterSeconds)) qol.notify('Atlias', 'The turn has finished');
    return reply;
  };
  // Atlias shows its own provider-reported token counts only. It does not read
  // another plugin's account usage files or imply those limits apply here.
  const makeDisplay = () => terminal ? { start() {}, draw() {}, mark() {}, stop() {} } : createDisplay({ stream: process.stdout, ui: config().ui, mode: MODE(), getState: () => state });
  let display = makeDisplay();
  display.start();
  if (!terminal) out(logo());
  // The composer footer already names the engine, and welcome names the project (B4): the line is for the plain prompt only.
  if (!terminal) out(d(`${engineLine(engine, config().agent)}   project ${cwd}   /help for commands`));
  if (config().agent.permissions === 'max') out(d(permissions.MAX_NOTICE));
  if (state.history.length) out(d(`resumed session ${state.sid} (${Math.floor(state.history.length / 2)} turns); /status shows where it stands`));
  if (progress.read(cwd)) out(d('a handoff note from earlier work is here; /progress shows it'));
  // Messages queued during a turn run in order before the next prompt, and the draft typed during it comes back into the prompt (TUI-B 3).
  let queue = [], draft = '';
  const takeHandoff = () => { if (handoff.exit) return true; queue.push(...handoff.queued); draft = handoff.draft; handoff = { queued: [], draft: '', exit: false }; return false; };
  try {
  for (;;) {
    let line;
    if (queue.length) line = queue.shift();
    else {
      display.mark();
      display.draw();
      try { line = await (terminal ? terminal.prompt(draft) : rl.question(c('you> '))); } catch { break; }
      draft = '';
    }
    const t = String(line || '').trim();
    if (!t) continue;
    if (t.startsWith('/')) {
      const r = await commands.dispatch(t, { state, cwd, out, ask, api: slashApi, onSettings: () => { display.stop(); display = makeDisplay(); display.start(); } });
      if (r.exit) break;
      if (r.handled && r.text === undefined) continue;
      if (r.text !== undefined) { showReply('\n' + (await send(r.text)) + '\n'); saveChat(state); if (takeHandoff()) break; continue; }
    }
    showReply('\n' + (await send(t)) + '\n');
    saveChat(state);
    if (takeHandoff()) break;
  }
  } finally { display.stop(); rl.close(); terminal = null; }
  const row = dream.distil(state.sid, '', cwd);
  out(d(row ? `session distilled to digest cursor ${row.cursor}; consolidate it with \`atlias dream\`` : 'nothing to distil'));
  return 0;
}

// What typing atlias with nothing after it shows. It asks every time; the
// mode setting (atlias mode sub|standalone) is what makes it stop asking.
export async function chooser() {
  const out = (s) => process.stdout.write(s + '\n');
  if (process.stdin.isTTY && !['read-only', 'plan'].includes(config().agent.permissions)) {
    const setupRl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { await onboarding.firstOpen({ ask: (q) => setupRl.question(c(q)), out, ...setupHelpers() }); }
    finally { setupRl.close(); }
  }
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
