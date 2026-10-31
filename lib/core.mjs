// atlias - shared runtime for every hook, the CLI and the MCP server.
// Zero dependencies. Node 18+. Windows, macOS and Linux.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseColor, NAMED } from './usage-display.mjs';
import { engineOffered, offeredEngines, CLAUDE_FOUNDERS_ONLY } from './edition.mjs';

// One source of truth (Gev 2026-10-17): the version is read from package.json, so an update that
// bumps it can never leave `atlias --version` and the start screen showing the old number.
export const VERSION = (() => {
  for (const rel of ['../package.json', '../.claude-plugin/plugin.json']) {
    try { const v = JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8')).version; if (typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v)) return v; } catch { /* try the next manifest */ }
  }
  return 'unknown';
})();
export const NAME = 'atlias';
export const HOME = os.homedir();
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_DIR = process.env.ATLIAS_HOME || path.join(HOME, '.atlias');
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
export const CODEX_DIR = process.env.CODEX_HOME || path.join(HOME, '.codex');
export const GEMINI_DIR = path.join(HOME, '.gemini');
export const START_MARK = `<!-- ${NAME}:start -->`;
export const END_MARK = `<!-- ${NAME}:end -->`;

export const DEFAULTS = {
  verify: { syntax: true, doublePass: true, integrity: true, stubs: true, weakenedTests: true, unwired: true },
  guard: { loopThreshold: 4, loopWindow: 30, destructive: true },
  graph: { autoBuild: true, autoUpdate: true, maxFilesForAutoBuild: 4000, queryBudget: 600, godNodes: 8, updateDebounceMs: 60000 },
  brief: { memoryChars: 6000, progressChars: 2400 },
  recall: { budgetChars: 2500, bodyChars: 500 },
  dream: { enabled: true, keepHistory: 400 },
  router: { graph: true, companions: true },
  pointer: { nudge: true, minBytes: 4000, perSession: 3 },
  // The usage display in the atlias agent's terminal (lib/usage-display.mjs). Off, nothing new is printed.
  ui: { terminalEnabled: true, followUp: 'queue', accentColor: 'atlias', compactWelcome: false, showHints: true, usageEnabled: false, usagePosition: 'bottom', usageColor: 'rainbow', usageAnimation: 'none' },
  attachments: { enabled: true, allowExternal: false, maxImages: 4, maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, detail: 'auto' },
  // atlias update (lib/update.mjs): where a git checkout fast-forwards from ('' = the upstream of the current branch),
  // and whether the atlias agent offers an update at start.
  update: { source: '', autoPrompt: true },
  // Round five's behaviour flags, one key per change, every one off by default.
  // A flag also reads from the environment (flagEnvName), so a study can switch
  // it per arm on one install. Each change that needs one adds it here and to
  // DESCRIPTIONS in lib/settings.mjs.
  // Off unless localPipeline.enabled is exactly true; lib/local-pipeline.mjs reads and checks it.
  localPipeline: {},
  flags: { leanBrief: false, gateRunsCheck: false, sameTextSwitch: false, finishOnGreen: false, impliedChanges: false, strayToolCalls: false, guardResetOnEdit: false, redCheckNudge: false, authorityLedger: false, hooksOnly: false, checkFailDominates: false, guardCommandPositions: false, briefNoCheckRule: false, briefAllTools: false, passLineNeedsCheck: false, subagentsApart: false, authorityBodiesOnce: false, exactTokenTotals: false, quietDoneClaim: false, noWorkingRules: false, preloadFiles: false, visibleCheck: false, quietNoCheck: false, stallStop: false, greenFailShown: false, verifyStrict: false, looseKeepsLines: false, stallLastLine: false, strayNameArgs: false },
  agent: { mode: 'both', engine: 'auto', hostEngines: 'off', subagents: 'on', relay: 'off', relayMaxRuns: 3, subagentEngine: 'inherit', subagentModel: '', subagentConcurrency: 0, subagentRounds: 20, subagentTokenBudget: 0, subagentHandback: 'text', subagentVerify: 'off', claudePlanModel: 'claude-opus-5-5', claudePlanEffort: 'xhigh', chatgptModel: 'gpt-6.1-sol', chatgptReasoningEffort: 'xhigh', responsesUrl: 'https://api.openai.com/v1', responsesModel: '', responsesReasoningEffort: 'model', anthropicUrl: 'https://api.anthropic.com/v1', anthropicModel: '', anthropicMaxTokens: 8192, anthropicEffort: 'model', geminiUrl: 'https://generativelanguage.googleapis.com/v1beta', geminiModel: '', ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: 'gemma3:4b', ollamaNumCtx: 16384, ollamaNumPredict: 2048, ollamaKeepAlive: '', ollamaTemperature: 0.2, ollamaPresencePenalty: -1, ollamaThink: 'model', openaiUrl: 'https://api.openai.com/v1', openaiModel: '', openaiReasoningEffort: 'model', nativeTools: true, maxToolRounds: 25, maxBadReplies: 3, keepObservations: 4, evictBlock: 4, outputBudget: 10000, testCommand: 'auto', skillIndex: 'off', toolSet: 'all', permissions: 'workspace', sandbox: false, evalDir: '', notifyAfterSeconds: 0 },
  // The Max subscription gate (lib/license.mjs). Off until Max is on sale; the free sub-harness never reads it.
  license: { required: false, url: 'https://atlias-ridelink.netlify.app/.netlify/functions', publicKey: 'MCowBQYDK2VwAyEAPexBU7ROjayKpODUmZ7ynGAKtKvA8ab5vdExYSRIuh8=', recheckHours: 6 },
};
// Settings that take one of a fixed set of values; anything else is refused
// with the list, because a typo here would otherwise quietly mean the default.
export const CHOICES = { agent: { mode: ['both', 'sub', 'standalone'], engine: ['auto', 'claude-plan', 'chatgpt', 'responses', 'anthropic', 'gemini', 'claude', 'codex', 'openai', 'ollama', 'echo'], hostEngines: ['off', 'on'], subagents: ['on', 'off'], relay: ['off', 'on'], subagentHandback: ['text', 'typed'], subagentVerify: ['off', 'check'], subagentEngine: ['inherit', 'claude-plan', 'chatgpt', 'responses', 'anthropic', 'gemini', 'openai', 'ollama'], claudePlanEffort: ['model', 'low', 'medium', 'high', 'xhigh', 'max'], anthropicEffort: ['model', 'low', 'medium', 'high', 'xhigh', 'max'], chatgptReasoningEffort: ['model', 'low', 'medium', 'high', 'xhigh', 'max'], responsesReasoningEffort: ['model', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], permissions: ['workspace', 'ask', 'read-only', 'auto-accept', 'plan', 'auto', 'max'], ollamaThink: ['model', 'on', 'off'], openaiReasoningEffort: ['model', 'none', 'low', 'medium', 'high', 'checked'], skillIndex: ['off', 'relevant', 'all'], toolSet: ['all', 'core'] }, ui: { usagePosition: ['top', 'bottom', 'sidebar'], usageAnimation: ['none', 'pulse', 'wave', 'shimmer'] } };

// ---------- files ----------
export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
export function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
export function readJson(p, fallback = null) {
  const t = readText(p);
  if (t == null) return fallback;
  try { return JSON.parse(t.replace(/^\uFEFF/, '')); } catch { return fallback; }
}
export function writeText(p, text) {
  ensureDir(path.dirname(p));
  // Preserve the exact previous preferences before replacing them. If the
  // backup cannot be written, refuse the replacement rather than lose it.
  if (path.resolve(p) === path.resolve(path.join(STATE_DIR, 'config.json')) && fs.existsSync(p)) {
    const previous = fs.readFileSync(p);
    if (!previous.equals(Buffer.from(String(text)))) {
      const hash = crypto.createHash('sha256').update(previous).digest('hex');
      const backup = path.join(ensureDir(path.join(STATE_DIR, 'config-backups')), hash + '.json');
      try { fs.writeFileSync(backup, previous, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  }
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  try { fs.renameSync(tmp, p); } catch { fs.copyFileSync(tmp, p); fs.unlinkSync(tmp); }
}
export function writeJson(p, obj) { writeText(p, JSON.stringify(obj, null, 2) + '\n'); }
export function appendLine(p, line) { ensureDir(path.dirname(p)); fs.appendFileSync(p, line.replace(/\r?\n/g, ' ') + '\n'); }
export function readLines(p) { const t = readText(p); return t ? t.split(/\r?\n/).filter(Boolean) : []; }
export function readJsonl(p) {
  const out = [];
  for (const l of readLines(p)) { try { out.push(JSON.parse(l)); } catch { /* skip corrupt line */ } }
  return out;
}
export function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }
export function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
export function sha(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16); }
export function clip(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }

// ---------- config and state ----------
// .atlias/settings.json in the project: merged over the user file for the keys in PROJECT_ALLOW only; every other key is refused and named.
// Set only by the repl and exec (lib/agent.mjs replIn and execOnce). Nothing sets it on the eval and
// benchmark path, so config() there is unchanged.
// An allow-list, not a deny-list: a deny-list missed the routes (anthropicUrl and friends) that send keys elsewhere.
CHOICES.ui.followUp = ['queue', 'steer'];
CHOICES.attachments = { detail: ['auto', 'low', 'high', 'original'] };

export const PROJECT_ALLOW = { 'agent.maxToolRounds': { min: 1, max: 200 }, 'agent.keepObservations': { min: 1, max: 50 }, 'agent.notifyAfterSeconds': { min: 0, max: 3600 }, 'agent.toolSet': ['all', 'core'], 'agent.skillIndex': ['off', 'relevant', 'all'] };
let PROJECT_LAYER = null;
let RUN_OVERRIDE = null;
// Set by exec --permissions for one run only: the person's own command line, so it may name any mode.
export function setRunOverride(o) { RUN_OVERRIDE = o || null; }
export function readProjectSettings(cwd) {
  PROJECT_LAYER = null;
  const file = path.join(cwd || process.cwd(), '.atlias', 'settings.json');
  if (!fs.existsSync(file)) return { present: false, applied: [], refused: [] };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { present: true, file, error: `${file} is not valid JSON: ${e.message}`, applied: [], refused: [] }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { present: true, file, error: `${file} must hold one JSON object`, applied: [], refused: [] };
  const layer = {};
  const applied = [];
  const refused = [];
  for (const k of Object.keys(parsed)) {
    if (!(k in DEFAULTS)) { refused.push(k); continue; }
    if (!parsed[k] || typeof parsed[k] !== 'object' || Array.isArray(parsed[k])) continue;
    for (const s of Object.keys(parsed[k])) {
      const dotted = `${k}.${s}`;
      const rule = PROJECT_ALLOW[dotted];
      const value = parsed[k][s];
      const fits = rule && rule.min !== undefined ? typeof value === 'number' && Number.isFinite(value) && value >= rule.min && value <= rule.max : Array.isArray(rule) ? rule.includes(value) : false;
      if (!fits) { refused.push(dotted); continue; }
      (layer[k] ||= {})[s] = parsed[k][s];
      applied.push(dotted);
    }
  }
  PROJECT_LAYER = layer;
  return { present: true, file, applied, refused };
}
export function config() {
  const user = readJson(path.join(STATE_DIR, 'config.json'), {}) || {};
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = { ...DEFAULTS[k], ...(user[k] || {}) };
  if (PROJECT_LAYER) for (const k of Object.keys(PROJECT_LAYER)) out[k] = { ...out[k], ...PROJECT_LAYER[k] };
  if (RUN_OVERRIDE) for (const k of Object.keys(RUN_OVERRIDE)) out[k] = { ...out[k], ...RUN_OVERRIDE[k] };
  // The environment wins over config.json for a flag, and for nothing else.
  out.flags = { ...out.flags, ...envFlags().values };
  return out;
}

// ---------- round five's flags ----------
// Every behaviour change of the round is measured as an arm against one
// baseline, and the study scripts switch arms by environment, not by editing
// config.json between runs: flags.leanBrief is ATLIAS_FLAG_LEAN_BRIEF. Hooks
// read it too, from the environment the host starts them in.
export const FLAG_PREFIX = 'ATLIAS_FLAG_';
export function flagEnvName(key) { return FLAG_PREFIX + String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase(); }
const FLAG_ON = new Set(['1', 'true', 'on', 'yes']);
const FLAG_OFF = new Set(['0', 'false', 'off', 'no', '']);
// What the environment sets. Names are matched without regard to case, since
// Windows keeps an environment's names that way. A value is trimmed and loses
// one pair of surrounding quotes, because cmd's set NAME="1" keeps them and a
// line from a CRLF file keeps its \r. A name that is no flag, or a value that
// does not parse, is reported rather than ignored: an arm with a misspelt flag
// would otherwise run as the control and be scored as the change.
export function envFlags(env = process.env, defs = DEFAULTS.flags) {
  const byEnv = new Map(Object.keys(defs).map((k) => [flagEnvName(k), k]));
  const values = {}, raw = {}, unknown = [], bad = [];
  for (const [name, value] of Object.entries(env || {})) {
    const upper = name.toUpperCase();
    if (!upper.startsWith(FLAG_PREFIX)) continue;
    const key = byEnv.get(upper);
    if (!key) { unknown.push(name); continue; }
    const text = String(value ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
    raw[upper] = text;
    let parsed;
    if (typeof defs[key] === 'boolean') {
      const t = text.toLowerCase();
      parsed = FLAG_ON.has(t) ? { value: true } : FLAG_OFF.has(t) ? { value: false } : { error: `${name} is 1 or 0 (true/false, on/off); got ${JSON.stringify(text)}` };
    } else parsed = parseSetting('flags', key, text);
    if (parsed.error) bad.push({ name, error: parsed.error });
    else values[key] = parsed.value;
  }
  return { values, raw, unknown: unknown.sort(), bad };
}
// The flags a run ran with, for its report: every registered flag's value, the
// ones not at their default, and where each of those came from.
export function flagStamp(cfg = config(), env = process.env, defs = DEFAULTS.flags) {
  const e = envFlags(env, defs);
  const values = {}, changed = [], from = {};
  for (const [key, def] of Object.entries(defs)) {
    const v = cfg.flags && key in cfg.flags ? cfg.flags[key] : def;
    values[key] = v;
    if (JSON.stringify(v) !== JSON.stringify(def)) { changed.push(key); from[key] = key in e.values ? flagEnvName(key) : 'config.json'; }
  }
  return { values, changed, from, env: e.raw, unknown: e.unknown, bad: e.bad };
}
// One line for a report or a comparison. A report written before flags existed
// has no stamp, and says so rather than claiming none were set.
export function flagLine(stamp) {
  if (!stamp || typeof stamp !== 'object') return 'not recorded';
  const on = (stamp.changed || []).map((k) => `${k}=${JSON.stringify(stamp.values[k])}${stamp.from && stamp.from[k] ? ` (${stamp.from[k]})` : ''}`);
  const wrong = [...(stamp.unknown || []).map((n) => `${n} names no flag`), ...(stamp.bad || []).map((b) => b.error)];
  return `${on.length ? on.join(', ') : 'none set, every flag at its default'}${wrong.length ? `; ignored: ${wrong.join('; ')}` : ''}`;
}
// Whether two stamps ran the same configuration. A flag only one of them knows
// was registered in between; off by default, as every flag lands, it is the
// behaviour the older code had, so it differs only where that stamp changed it.
// Comparing the two values maps whole would call the baseline and a later
// flags-off run two arms the moment any flag was registered.
export function sameFlags(a, b) {
  if (!a || !b || typeof a.values !== 'object' || typeof b.values !== 'object' || !a.values || !b.values) return false;
  const keys = new Set([...Object.keys(a.values), ...Object.keys(b.values)]);
  for (const k of keys) {
    const inA = k in a.values, inB = k in b.values;
    if (inA && inB) { if (JSON.stringify(a.values[k]) !== JSON.stringify(b.values[k])) return false; }
    else if ((inA ? a.changed || [] : b.changed || []).includes(k)) return false;
  }
  return true;
}
// A setting has the type its default has. Anything else is refused with the
// reason, rather than stored and quietly misread later.
export function parseSetting(section, key, raw) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, section) || !Object.prototype.hasOwnProperty.call(DEFAULTS[section], key)) return { error: `unknown key ${section}.${key}; sections: ${Object.keys(DEFAULTS).join(', ')}` };
  const want = typeof DEFAULTS[section][key];
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { error: `${section}.${key} needs a value (a ${want})` };
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  if (want === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return { error: `${section}.${key} is a number; got ${JSON.stringify(value)}` };
    if (section === 'agent' && key === 'relayMaxRuns' && (!Number.isSafeInteger(n) || n < 1 || n > 20)) return { error: 'agent.relayMaxRuns must be an integer from 1 to 20.' };
    // Sub-agent caps (subagent-ledger.mjs): 0 means no cap for concurrency and budget.
    const subCap = { subagentConcurrency: [0, 20], subagentRounds: [1, 100], subagentTokenBudget: [0, 100000000] }[section === 'agent' ? key : ''];
    if (subCap && (!Number.isSafeInteger(n) || n < subCap[0] || n > subCap[1])) return { error: `agent.${key} must be an integer from ${subCap[0]} to ${subCap[1]}.` };
    if (section === 'attachments') {
      const ceiling = { maxImages: 8, maxFileBytes: 7 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 }[key];
      if (!['number', 'string'].includes(typeof value) || !Number.isSafeInteger(n) || n < 1 || n > ceiling) return { error: `${section}.${key} must be an integer from 1 to ${ceiling}.` };
    }
    return { value: n };
  }
  if (want === 'boolean') {
    if (value === true || value === 'true') return { value: true };
    if (value === false || value === 'false') return { value: false };
    return { error: `${section}.${key} is true or false; got ${JSON.stringify(value)}` };
  }
  if (section === 'ui' && key === 'accentColor') {
    if (typeof value === 'string' && ['atlias', 'none'].includes(value.toLowerCase())) return { value: value.toLowerCase() };
    const color = typeof value === 'string' ? parseColor(value) : null;
    return color?.kind === 'rgb' ? { value: color.name } : { error: 'ui.accentColor is atlias, none, a color name or a hex color such as #fbbf24. Restart Atlias to apply.' };
  }
  if (section === 'ui' && key === 'usageColor') {
    const color = parseColor(value);
    return color ? { value: color.name } : { error: `ui.usageColor is rainbow, a colour name (${Object.keys(NAMED).join(', ')}) or a hex colour such as #ffb000; got ${JSON.stringify(text)}` };
  }
  if (section === 'attachments' && key === 'detail') {
    return ['auto', 'low', 'high', 'original'].includes(value) ? { value } : { error: 'attachments.detail is auto, low, high or original; provider/model support still applies.' };
  }
  const choices = CHOICES[section] && CHOICES[section][key];
  if (choices) {
    const v = String(value).toLowerCase();
    // atlias config set and /settings: the release refuses a Claude engine and lists none (Gev, 2026-10-30).
    const engineKey = section === 'agent' && (key === 'engine' || key === 'subagentEngine');
    if (engineKey && !engineOffered(v)) return { error: CLAUDE_FOUNDERS_ONLY };
    return choices.includes(v) ? { value: v } : { error: `${section}.${key} is one of ${(engineKey ? offeredEngines(choices) : choices).join(', ')}; got ${JSON.stringify(text)}` };
  }
  return { value: typeof value === typeof DEFAULTS[section][key] ? value : text };
}

export function log(msg) {
  try {
    const p = path.join(STATE_DIR, 'log.txt');
    ensureDir(STATE_DIR);
    if (mtime(p) && fs.statSync(p).size > 1024 * 1024) fs.renameSync(p, p + '.1');
    fs.appendFileSync(p, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* logging must never break a hook */ }
}
// Claude Code names a project folder after its path with every separator replaced by a dash
// (C:\Users\OWNER -> C--Users-OWNER, /home/u/app -> -home-u-app).
export function slug(cwd) { return String(cwd || process.cwd()).replace(/[\\/:]/g, '-'); }
export function projectDir(cwd) { return ensureDir(path.join(STATE_DIR, 'projects', slug(cwd))); }
export function sessionDir() { return ensureDir(path.join(STATE_DIR, 'sessions')); }
export function sessionEvents(id) { return path.join(sessionDir(), `${safeId(id)}.jsonl`); }
export function sessionMetaPath(id) { return path.join(sessionDir(), `${safeId(id)}.json`); }
export function sessionMeta(id) { return readJson(sessionMetaPath(id), {}) || {}; }
export function saveSessionMeta(id, meta) { writeJson(sessionMetaPath(id), meta); }
export function safeId(id) { return String(id || 'no-session').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80); }
// A single append under about four kilobytes lands whole even when several
// processes write at once; a longer one can interleave with another and
// corrupt both lines. Two sessions in one project, or a hook and a
// subagent's hook, are the ordinary case here, not the exotic one.
export const EVENT_MAX = 3500;
export function trimEvent(ev) {
  let out = { ...ev };
  if (Array.isArray(out.files) && out.files.length > 20) out = { ...out, files: out.files.slice(0, 20), moreFiles: out.files.length - 20 };
  let line = JSON.stringify(out);
  if (line.length <= EVENT_MAX) return out;
  if (Array.isArray(out.files)) {
    while (out.files.length > 1 && line.length > EVENT_MAX) {
      out = { ...out, files: out.files.slice(0, out.files.length - 1), moreFiles: (out.moreFiles || 0) + 1 };
      line = JSON.stringify(out);
    }
  }
  if (line.length > EVENT_MAX && typeof out.command === "string") {
    out = { ...out, command: out.command.slice(0, 200), commandTruncated: true };
    line = JSON.stringify(out);
  }
  if (line.length > EVENT_MAX) out = { t: out.t, kind: out.kind, tool: out.tool, key: out.key, ...(out.subagent ? { subagent: out.subagent } : {}), oversized: true };
  return out;
}
export function recordEvent(id, ev) { appendLine(sessionEvents(id), JSON.stringify(trimEvent({ t: Date.now(), ...ev }))); }
// flags.subagentsApart: a hook from a subagent carries agent_id (Claude Code's
// hooks docs, common input fields: "Unique identifier for the subagent or
// in-process teammate the hook fires in"). With the flag on, its events are
// tagged with that id, and the Stop gate's turn leaves them out (lib/gate.mjs).
// Off, nothing is added, so the stored events are the same bytes as before.
export function subagentTag(payload, cfg) {
  if (!cfg.flags || cfg.flags.subagentsApart !== true) return {};
  return typeof payload.agent_id === 'string' && payload.agent_id ? { subagent: payload.agent_id } : {};
}
// Separate exact-authority files without truncating a long session/agent pair.
export function actorSession(payload, cfg = config()) {
  const sid = payload.session_id || 'no-session';
  const tag = subagentTag(payload, cfg);
  return tag.subagent && sid !== 'no-session' ? `actor-${sha(JSON.stringify([sid, tag.subagent]))}` : sid;
}
export function events(id) { return readJsonl(sessionEvents(id)); }
// Read the last `bytes` of a file without pulling the whole thing into
// memory, dropping the first line because it is probably cut in half.
export function readTail(p, bytes) {
  let fd = null;
  try {
    fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    if (start === 0) return text;
    const nl = text.indexOf('\n');
    return nl === -1 ? '' : text.slice(nl + 1);
  } catch { return ''; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* already gone */ } } }
}
// What the guard and the gate need: the recent end of the session, not all
// of it. 64 KB is roughly a thousand events.
export const GUARD_TAIL = 64 * 1024;
export const TURN_TAIL = 256 * 1024;
export function eventsTail(id, bytes = GUARD_TAIL) {
  const out = [];
  for (const line of readTail(sessionEvents(id), bytes).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a half-written line at the edge */ }
  }
  return out;
}
// Where Claude Code keeps its own memory for this project. Every host shares it, so one memory.
export function claudeMemoryDir(cwd) { return path.join(CLAUDE_DIR, 'projects', slug(cwd), 'memory'); }

// ---------- stdin and stdout for hooks ----------
export async function readStdin() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}
export function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
export function contextOutput(eventName, text, extra = {}) {
  if (!text) return null;
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext: text }, ...extra };
}

// ---------- host detection ----------
export function detectHost(argv = process.argv) {
  const i = argv.indexOf('--host');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  if (process.env.CLAUDE_PLUGIN_ROOT || process.env.CLAUDE_PROJECT_DIR || process.env.CLAUDE_CODE_SESSION_ID) return 'claude';
  if (process.env.CODEX_HOME || process.env.CODEX_SANDBOX || process.env.CODEX_THREAD_ID) return 'codex';
  if (process.env.GEMINI_CLI || process.env.GEMINI_SESSION_ID) return 'gemini';
  return 'claude';
}
export const HOST_LABEL = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', antigravity: 'Antigravity' };

// ---------- where this copy lives ----------
// A path that contains a version number is a path that expires. The state
// directory does not, so host configs point there and the launcher finds
// whichever copy is installed now.
export const LAUNCHER = path.join(STATE_DIR, 'server.mjs');
export const ROOT_RECORD = path.join(STATE_DIR, 'root.json');
export function isVersionedPath(dir) {
  return /[\\/](?:\d+\.\d+\.\d+)[\\/]/.test(String(dir) + path.sep);
}
// Every installed copy, newest version first, so a removed one is skipped.
export function installedRoots() {
  const out = [];
  if (process.env.ATLIAS_ROOT) out.push(process.env.ATLIAS_ROOT);
  const cache = path.join(CLAUDE_DIR, 'plugins', 'cache', 'atlias', 'atlias');
  try {
    const versions = fs.readdirSync(cache).filter((d) => /^\d+\.\d+\.\d+$/.test(d));
    versions.sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
    });
    for (const v of versions) out.push(path.join(cache, v));
  } catch { /* no plugin install */ }
  const recorded = readJson(ROOT_RECORD);
  if (recorded && recorded.root) out.push(recorded.root);
  out.push(ROOT);
  return [...new Set(out)].filter((d) => exists(path.join(d, 'mcp', 'server.mjs')));
}
export function writeLauncher(root = ROOT) {
  ensureDir(STATE_DIR);
  writeJson(ROOT_RECORD, { root, version: VERSION, written: new Date().toISOString() });
  writeText(LAUNCHER, LAUNCHER_SOURCE);
  return LAUNCHER;
}
// The hooks get the same treatment as the MCP server. Codex's hooks.json used
// to name lib/hooks.mjs inside the versioned plugin folder, so every hook would
// have died with the next update. The file name ends in hooks.mjs on purpose:
// lib/hooks.mjs runs its main() only when argv[1] does.
export const HOOKS_LAUNCHER = path.join(STATE_DIR, 'hooks.mjs');
export function writeHooksLauncher(root = ROOT) {
  ensureDir(STATE_DIR);
  writeJson(ROOT_RECORD, { root, version: VERSION, written: new Date().toISOString() });
  writeText(HOOKS_LAUNCHER, HOOKS_LAUNCHER_SOURCE);
  return HOOKS_LAUNCHER;
}
// The launcher, verbatim. Kept as data so the tests can read it and assert
// that it imports nothing from a path with a version number in it.
export const LAUNCHER_SOURCE = "#!/usr/bin/env node\n// Written by atlias. Host configs point here because this path never changes\n// while the installed copy moves with every version. Nothing below imports\n// from a versioned path: depending on one is the failure this file exists to\n// prevent.\nimport fs from 'node:fs';\nimport os from 'node:os';\nimport path from 'node:path';\nimport { pathToFileURL } from 'node:url';\n\nconst home = os.homedir();\nconst state = process.env.ATLIAS_HOME || path.join(home, '.atlias');\nconst claude = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');\nconst candidates = [];\nif (process.env.ATLIAS_ROOT) candidates.push(process.env.ATLIAS_ROOT);\n// Newest installed version first, so an update takes effect immediately.\nconst cache = path.join(claude, 'plugins', 'cache', 'atlias', 'atlias');\ntry {\n  const versions = fs.readdirSync(cache).filter((d) => /^\\d+\\.\\d+\\.\\d+$/.test(d));\n  versions.sort((a, b) => {\n    const A = a.split('.').map(Number);\n    const B = b.split('.').map(Number);\n    return B[0] - A[0] || B[1] - A[1] || B[2] - A[2];\n  });\n  for (const v of versions) candidates.push(path.join(cache, v));\n} catch { /* not installed as a plugin */ }\n// Then whichever copy wrote this launcher, which covers a checkout.\ntry {\n  const recorded = JSON.parse(fs.readFileSync(path.join(state, 'root.json'), 'utf8'));\n  if (recorded && recorded.root) candidates.push(recorded.root);\n} catch { /* no record */ }\n\nconst root = candidates.find((dir) => {\n  try { fs.accessSync(path.join(dir, 'mcp', 'server.mjs')); return true; } catch { return false; }\n});\nif (!root) {\n  process.stderr.write('atlias: no installed copy found. Reinstall the plugin, or set ATLIAS_ROOT to a checkout.\\n');\n  process.exit(1);\n}\nawait import(pathToFileURL(path.join(root, 'mcp', 'server.mjs')).href);\n";

// ---------- processes ----------
export function run(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', timeout: opts.timeout || 8000, cwd: opts.cwd || undefined, input: opts.input,
    windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...(opts.env || {}) },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? String(r.error.message || r.error) : null };
}
// Fire-and-forget worker that outlives the hook (SessionEnd only gets 1.5 s).
// ATLIAS_NO_DETACH=1 starts nothing in the background: a test run sets it, so
// no graph worker is left holding a folder the run is about to delete.
export function detach(args, opts = {}) {
  if (process.env.ATLIAS_NO_DETACH === '1') { log(`detach skipped (ATLIAS_NO_DETACH): ${args.join(' ')}`); return false; }
  try {
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: opts.cwd || undefined, env: { ...process.env, ...(opts.env || {}) } });
    child.unref();
    return true;
  } catch (e) { log(`detach failed: ${e.message}`); return false; }
}
// A lock that expires, so a crashed worker never wedges the harness.
export function tryLock(p, ttlMs = 10 * 60 * 1000) {
  try {
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs < ttlMs) return false;
    fs.unlinkSync(p);
  } catch { /* no lock */ }
  try { fs.writeFileSync(p, String(process.pid), { flag: 'wx' }); return true; } catch { return false; }
}
export function unlock(p) { try { fs.unlinkSync(p); } catch { /* gone */ } }

// ---------- python and graphify ----------
// One probe, the whole search, and how long a miss is remembered. These are
// exported because the tests assert that the work fits inside the SessionStart
// timeout the plugin declares.
export const PROBE_MS = 4000;
export const PROBE_BUDGET_MS = 9000;
export const MISS_CACHE_MS = 60 * 60 * 1000;
// graphify installed with pipx or into its own virtual environment is not
// importable from the system Python, so a search that only asked the system
// interpreters missed it, and the companion installer then pip-installed a
// second copy. A graphify launcher on PATH sits beside the interpreter that
// owns it (a venv's Scripts or bin folder), and pipx keeps its venvs in known
// places; both are asked before the system interpreters.
export function graphifyInterpreters(deps = {}) {
  const env = deps.env || process.env;
  const has = deps.exists || exists;
  const real = deps.realpath || ((p) => { try { return fs.realpathSync(p); } catch { return p; } });
  const win = (deps.platform || process.platform) === 'win32';
  const home = deps.home || HOME;
  const py = win ? 'python.exe' : 'python';
  const out = [];
  const push = (p) => { if (p && has(p) && !out.includes(p)) out.push(p); };
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const name of win ? ['graphify.exe', 'graphify.cmd', 'graphify'] : ['graphify']) {
      const launcher = path.join(dir, name);
      if (!has(launcher)) continue;
      const beside = path.dirname(real(launcher));
      push(path.join(beside, py));
      // A global Windows install keeps the launcher in Scripts and python.exe one level up.
      push(path.join(path.dirname(beside), py));
    }
  }
  const venvs = win
    ? [path.join(home, 'pipx', 'venvs'), path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'pipx', 'pipx', 'venvs')]
    : [path.join(home, '.local', 'pipx', 'venvs'), path.join(home, '.local', 'share', 'pipx', 'venvs')];
  if (env.PIPX_HOME) venvs.unshift(path.join(env.PIPX_HOME, 'venvs'));
  for (const v of venvs) push(path.join(v, 'graphifyy', win ? 'Scripts' : 'bin', py));
  return out;
}

// Ultimate Frontend Skills has shipped under four names, and it can also be
// present as a skills-only folder. A check that knew only the current plugin
// name reported a renamed install as missing and offered to install a second
// copy beside it. loaded says whether Claude Code loads that copy: an enabled
// plugin or a folder in its own skills directory does, a copy in
// ~/.agents/skills is for other agents.
export const UFS_NAMES = ['ultimate-frontend-skills', 'ultimate-website-skills', 'ultimate-design-skills', 'cinematic-web-design'];
// Claude Code reads enabledPlugins from the user's settings and then from the
// project's .claude/settings.json and .claude/settings.local.json, the later
// winning, and loads skills from the project's .claude/skills as well. Reading
// only the user's files made a project that enables UFS look like it had none,
// and `atlias install --companions` run there added a second, user-wide copy.
export function ufsCopies(deps = {}) {
  const claudeDir = deps.claudeDir || CLAUDE_DIR;
  const home = deps.home || HOME;
  const has = deps.exists || exists;
  const project = path.join(deps.cwd || process.cwd(), '.claude');
  const same = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
  const scopes = [claudeDir, ...(same(project, claudeDir) ? [] : [project])];
  const enabledMap = Object.assign({}, ...scopes.flatMap((d) => ['settings.json', 'settings.local.json'].map((f) => (readJson(path.join(d, f), {}) || {}).enabledPlugins || {})));
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'), {}) || {};
  const copies = [];
  const seen = new Set();
  for (const key of [...Object.keys(enabledMap), ...Object.keys(installed.plugins || {})]) {
    if (seen.has(key) || !UFS_NAMES.includes(key.split('@')[0])) continue;
    seen.add(key);
    copies.push({ kind: 'plugin', name: key, where: key, loaded: Boolean(enabledMap[key]) });
  }
  const skillDirs = [[path.join(claudeDir, 'skills'), true], ...(same(project, claudeDir) ? [] : [[path.join(project, 'skills'), true]]), [path.join(home, '.agents', 'skills'), false]];
  for (const [dir, loaded] of skillDirs) {
    for (const name of UFS_NAMES) {
      const where = path.join(dir, name);
      if (has(path.join(where, 'SKILL.md'))) copies.push({ kind: 'skills', name, where, loaded });
    }
  }
  return copies;
}
// Never a second copy: any copy Claude Code loads, or an installed plugin that
// is only switched off, means there is nothing to install.
export function ufsInstallPlan(copies) {
  const loaded = copies.filter((c) => c.loaded);
  if (loaded.length > 1) return { install: false, say: `ultimate-frontend-skills: loaded ${loaded.length} times (${loaded.map((c) => c.where).join(', ')}); keep one and remove the rest` };
  if (loaded.length === 1) return { install: false, say: `ultimate-frontend-skills: present (${loaded[0].where})` };
  const off = copies.find((c) => c.kind === 'plugin');
  if (off) return { install: false, say: `ultimate-frontend-skills: installed as ${off.name} but switched off; enable it instead of installing a second copy` };
  return { install: true, say: null };
}

export function findPython(opts = {}) {
  const cachePath = path.join(STATE_DIR, 'python.json');
  // An install decision passes fresh: a cached "not found" must not decide it.
  const cached = opts.fresh ? null : readJson(cachePath);
  if (cached && cached.path && exists(cached.path) && Date.now() - (cached.checked || 0) < 24 * 3600 * 1000) return cached.path;
  // A machine without graphify must not pay for the search on every session.
  if (cached && cached.path === null && Date.now() - (cached.checked || 0) < MISS_CACHE_MS) return null;
  const cands = [];
  if (process.env.ATLIAS_PYTHON) cands.push(process.env.ATLIAS_PYTHON);
  cands.push(...graphifyInterpreters());
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
    for (const v of ['Python314', 'Python313', 'Python312', 'Python311']) cands.push(path.join(local, 'Programs', 'Python', v, 'python.exe'));
    cands.push('python', 'py');
  } else cands.push('python3', 'python');
  const started = Date.now();
  for (const c of cands) {
    if (Date.now() - started > PROBE_BUDGET_MS) break;
    if (path.isAbsolute(c) && !exists(c)) continue; // never spawn what is not on disk
    const args = c === 'py' ? ['-3', '-c', 'import graphify,sys;print(sys.executable)'] : ['-c', 'import graphify,sys;print(sys.executable)'];
    const r = run(c, args, { timeout: PROBE_MS });
    if (r.status === 0 && r.stdout.trim()) {
      const found = r.stdout.trim().split(/\r?\n/).pop();
      writeJson(cachePath, { path: found, checked: Date.now() });
      return found;
    }
  }
  writeJson(cachePath, { path: null, checked: Date.now() });
  return null;
}
export function graphify(args, opts = {}) {
  const py = findPython();
  if (!py) return { status: 127, stdout: '', stderr: 'graphify: no python with graphify installed (pip install graphifyy)', error: 'missing' };
  return run(py, ['-m', 'graphify', ...args], { timeout: opts.timeout || 20000, cwd: opts.cwd });
}
export function graphPath(cwd) { return path.join(cwd || process.cwd(), 'graphify-out', 'graph.json'); }

// Both the handoff note and the search for edits made outside the tools want
// the same git status, in the same process, milliseconds apart. Run it once.
const gitMemo = new Map();
export function gitStatusShort(cwd, deps = {}) {
  const runner = deps.run || run;
  const now = deps.now || Date.now();
  const hit = gitMemo.get(cwd);
  if (hit && now - hit.at < 2000) return hit.text;
  // The repository check applies to the real runner only: a caller that hands
  // in its own runner is explicitly asking for it to be used.
  if (!deps.run && !exists(path.join(cwd, '.git'))) { gitMemo.set(cwd, { at: now, text: '' }); return ''; }
  const r = runner('git', ['status', '--short'], { cwd, timeout: 3000 });
  const text = r.status === 0 ? r.stdout : '';
  gitMemo.set(cwd, { at: now, text });
  return text;
}
export function clearGitMemo() { gitMemo.clear(); }

// ---------- tool payload helpers (Claude Code, Codex, Gemini CLI shapes) ----------
export const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.json', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.dart', '.vue', '.svelte', '.sql', '.sh', '.ps1', '.toml', '.yaml', '.yml', '.html', '.css', '.md']);
export function isCodeFile(p) { return CODE_EXT.has(path.extname(String(p || '')).toLowerCase()); }
export function filesFromTool(toolName, input) {
  if (!input || typeof input !== 'object') return [];
  const out = new Set();
  for (const k of ['file_path', 'notebook_path', 'path', 'filePath', 'target_file']) if (typeof input[k] === 'string') out.add(input[k]);
  if (Array.isArray(input.edits)) for (const e of input.edits) if (e && typeof e.file_path === 'string') out.add(e.file_path);
  // Codex apply_patch. Its hooks receive tool_input {command: "<patch>"}
  // (codex-rs/core/src/tools/handlers/apply_patch.rs); older builds used input
  // or patch. Added, updated and renamed files are edits; deleted ones are not.
  const patch = [input.command, input.input, input.patch].find((v) => typeof v === 'string' && /^\*\*\* (?:Begin Patch|Update File:|Add File:)/m.test(v));
  if (patch) for (const m of patch.matchAll(/^\*\*\* (?:Update File|Add File|Move to): (.+)$/gm)) out.add(m[1].trim());
  return [...out];
}
export function commandFromTool(toolName, input) {
  if (!input || typeof input !== 'object') return null;
  // apply_patch carries its patch in command; it is an edit, not a shell command.
  if (isEditTool(toolName)) return null;
  const c = input.command ?? input.cmd ?? null;
  if (Array.isArray(c)) return c.join(' ');
  return typeof c === 'string' ? c : null;
}
// The tool names the hooks act on, as lists, because hooks/hooks.json narrows
// PostToolUse to exactly these (and the read tools in lib/pointer.mjs) and the
// suite holds the two in step: a name added here and not there would be a
// tool the hooks never see.
export const EDIT_TOOL_NAMES = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'write_file', 'replace', 'edit_file', 'create_file'];
export const SHELL_TOOL_NAMES = ['Bash', 'PowerShell', 'shell', 'exec', 'exec_command', 'run_shell_command', 'run_terminal_cmd', 'local_shell'];
export const toolNameRe = (names) => new RegExp(`^(${names.join('|')})$`, 'i');
const EDIT_TOOL_RE = toolNameRe(EDIT_TOOL_NAMES);
const SHELL_TOOL_RE = toolNameRe(SHELL_TOOL_NAMES);
export function isEditTool(toolName) { return EDIT_TOOL_RE.test(String(toolName || '')); }
export function isShellTool(toolName) { return SHELL_TOOL_RE.test(String(toolName || '')); }
const VERIFY_RE = /\b(node --check|deno (check|test|lint)|bun test|npm test|pnpm test|yarn test|pytest|python -m py_compile|py_compile|go (test|vet|build)|cargo (test|check|clippy)|jest|vitest|mocha|playwright test|cypress run|eslint|biome (check|lint)|ruff|flake8|mypy|pyright|tsc|swift test|xcodebuild|flutter test|dart (test|analyze)|dotnet test|rspec|phpunit|composer test|mvn (test|verify)|gradle(w)? (test|check)|make (test|check)|ctest|npm run (test|lint|check|build|typecheck)|node .*sweeps|node .*test)/i;
// A program given by its path ("C:\Program Files\nodejs\node.exe",
// ./node_modules/.bin/jest) is the same program as its bare name. Only the
// program at the start of each command segment is rewritten; arguments such as
// test/run.mjs are left alone, because the checks above match on them.
const LEAD_PROGRAM = /(^|&&|\|\||[;|(])(\s*)(?:"(?:[^"]*[\\/])?([\w.+-]+?)(?:\.exe|\.cmd|\.bat)?"|(?:[A-Za-z]:)?[^\s"]*[\\/]([\w.+-]+?)(?:\.exe|\.cmd|\.bat)?)(?=\s|$)/gi;
export function programCommand(cmd) {
  return String(cmd || '').replace(LEAD_PROGRAM, (m, lead, space, quoted, unquoted) => lead + space + (quoted || unquoted));
}
// A project's own check script, run by name: python check.py, node test.mjs,
// python .\tests\test_parse.py, sh ./run_tests.sh. Measured in Claude Code on
// 2026-09-28: `python check.py` ran and passed, the gate recorded no check,
// said "no check ran this turn" and held the reply, and the extra turn cost
// 57 per cent more prompt tokens on the task. The interpreter may come by path
// or through PowerShell's & operator. Only the script's own name decides:
// checkout.py and main.py are not checks, check.py and canitedit_check.py are.
const CHECK_SCRIPT = String.raw`(?:(?:tests?|checks?|specs?|verify)(?:[_.-][\w.-]*)?|[\w.-]*[_.-](?:tests?|checks?|specs?))\.(?:py|[mc]?js|sh|ps1)`;
const SCRIPT_CHECK_RE = new RegExp(String.raw`(?:^|[\s;&|(\\/"'])(?:python[\d.]*|py|node|bash|sh|pwsh|powershell)(?:\.exe)?["']?(?:\s+-{1,2}[\w-]+)*\s+(?:"(?:[^"]*[\\/])?${CHECK_SCRIPT}"|'(?:[^']*[\\/])?${CHECK_SCRIPT}'|(?:[^\s"';|&]*[\\/])?${CHECK_SCRIPT}(?=[\s;|&)]|$))`, 'i');
// python -m unittest / doctest, and a one-line assertion script: python -c
// "from main import f; assert f(2) == 3" checks the change as surely as a file.
const INLINE_CHECK_RE = /\b(?:python[\d.]*|py)(?:\.exe)?["']?\s+-m\s+(?:unittest|doctest)\b|\b(?:python[\d.]*|py)(?:\.exe)?["']?\s+-c\s[\s\S]*\bassert\b|\bnode(?:\.exe)?["']?\s+-e\s[\s\S]*\bassert\b/i;
// Codex commonly feeds assertion programs through stdin rather than -e/-c.
// Require both a real heredoc and its interpreter; a printed assertion is not
// a verification command.
const STDIN_CHECK_RE = /@['"]\r?\n[\s\S]*\bassert\b[\s\S]*\r?\n['"]@\s*\|\s*(?:python[\d.]*|py|node)(?:\.exe)?\s+(?:-|--input-type[= ]module)(?=\s|$)|\b(?:python[\d.]*|py|node)(?:\.exe)?\s+(?:-|--input-type[= ]module)\s*<<-?\s*['"]?\w+['"]?\r?\n[\s\S]*\bassert\b/i;
// flags.verifyStrict (off by default; Gev 2026-10-17, HAC-1 item 2): VERIFY_RE has a word boundary in
// front only, so `cat tsconfig.json` (tsc), `cat .eslintrc.json` (eslint) and `node dist/latest.js`
// ("node .*test") count as checks, a failing run is then answered, and the red-check nudge stays
// quiet. Strict: each word stands as a whole token, and the node form needs a test or sweeps path part.
const VERIFY_WORDS = VERIFY_RE.source.slice(3, -1).replace('|node .*sweeps|node .*test', '');
const VERIFY_STRICT_RE = new RegExp(String.raw`(?:^|[\s;&|("'])(?:${VERIFY_WORDS})(?=$|[\s;&|)"'])|\bnode(?:\.exe)?["']?\s(?:[^;&|]*?[\s\\/"'])?(?:tests?|sweeps?)(?:[\\/._-][^\s;&|]*)?(?=$|[\s;&|)"'])`, 'i');
export function looksLikeVerification(cmd) {
  const text = String(cmd || '');
  const re = (config().flags || {}).verifyStrict === true ? VERIFY_STRICT_RE : VERIFY_RE;
  return re.test(text) || re.test(programCommand(text)) || SCRIPT_CHECK_RE.test(text) || INLINE_CHECK_RE.test(text) || STDIN_CHECK_RE.test(text);
}
// The script-name part of that classifier alone: a project's own check script
// run by name. The gate uses it to pick a check to run, where the rest of the
// classifier's words (eslint, jest, "node .*test") would name eslint.config.js
// or latest.js, which exit 0 and prove nothing.
export function looksLikeCheckScript(cmd) { return SCRIPT_CHECK_RE.test(String(cmd || '')); }

// The hooks launcher is the server launcher pointed at lib/hooks.mjs, so the
// two can never drift apart in how they pick the installed copy.
export const HOOKS_LAUNCHER_SOURCE = LAUNCHER_SOURCE.split("'mcp', 'server.mjs'").join("'lib', 'hooks.mjs'");
