// The Claude Code token study, the pieces that need no model.
//
// NEXTGEN-5's CC protocol runs one task in plain Claude Code and in Claude
// Code with atlias loaded, headless, and compares what each read per solved
// task. Everything here is pure or touches only the local disk, so it can be
// tested without spending a cent: the child environment and argv each arm gets
// (the isolation the comparison stands on), the token arithmetic, the paired
// ratio and its intervals, and what a nested transcript says about gate holds
// and cancelled hook calls.
import fs from 'node:fs';
import path from 'node:path';
import { mcnemar } from '../../lib/eval.mjs';

// ---------- isolation ----------

// The only variables a nested run inherits. A whitelist rather than a list of
// things to remove: the coordinating session carries dozens of CLAUDE_* and
// CLAUDE_CODE_* variables (its session id, its messaging socket, its transcript
// sync, its effort), and any one that leaks makes the nested run write into the
// coordinating session or behave unlike a fresh install. Proxy and CA variables
// are kept because the container reaches the API through a proxy.
export const ENV_KEEP = [
  'PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'SHELL', 'USER', 'LOGNAME',
  'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'PIP_CERT',
];

// Never allowed into a nested run, whatever a caller passes as extra.
export const ENV_FORBIDDEN = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AFTER_LAST_COMPACT|CLAUDE_.*|ANTHROPIC_.*|AI_AGENT|ATLIAS_ROOT)$/;

// The environment of one nested run. HOME is a fresh folder per run, so Claude
// Code's config dir (HOME/.claude), atlias's state (HOME/.atlias) and any
// memory either writes start empty: no run can see another run's memory, and
// neither arm sees the container's own ~/.claude skills, plugins or hooks.
// IS_SANDBOX lets bypassPermissions run as root, which this container is.
export function childEnv(parent, { home, extra = {} } = {}) {
  if (!home) throw new Error('childEnv needs a fresh home folder');
  const env = {};
  for (const k of ENV_KEEP) if (parent[k] != null && parent[k] !== '') env[k] = String(parent[k]);
  env.HOME = home;
  env.IS_SANDBOX = '1';
  for (const [k, v] of Object.entries(extra || {})) {
    if (ENV_FORBIDDEN.test(k) && !/^ATLIAS_/.test(k)) throw new Error(`${k} may not be passed to a nested run`);
    env[k] = String(v);
  }
  return env;
}

// Which env keys a nested run would carry that it must not. Empty when clean.
export function leakedKeys(env) {
  return Object.keys(env).filter((k) => ENV_FORBIDDEN.test(k));
}

// An arm, from its name: `plain`, or `atlias@<sha>` with optional flags after a
// plus, `atlias@abc1234+ATLIAS_FOO=1,ATLIAS_BAR=0`. Flags become environment
// variables of the nested run, which is how NEXTGEN-5 says a flagged arm is
// switched on ("a config key that can also be set from the environment").
// The --arms list: arms are separated by commas, and so are one arm's flags,
// so a comma starts a new arm only where `plain` or `atlias@` follows it.
export function splitArms(list) {
  return String(list || '').split(/,(?=\s*(?:plain\s*(?:,|$)|atlias@))/).map((s) => s.trim()).filter(Boolean);
}

export function parseArm(spec) {
  const s = String(spec || '').trim();
  if (s === 'plain') return { name: 'plain', kind: 'plain', ref: '', flags: {} };
  const m = s.match(/^atlias@([^+\s]+)(?:\+(.*))?$/);
  if (!m) throw new Error(`no arm ${s}: use plain or atlias@<ref>[+KEY=value,...]`);
  const flags = {};
  if (m[2]) {
    for (const pair of m[2].split(',').map((p) => p.trim()).filter(Boolean)) {
      const eq = pair.indexOf('=');
      if (eq < 1) throw new Error(`flag ${pair} in arm ${s} has no value`);
      const k = pair.slice(0, eq), v = pair.slice(eq + 1);
      if (!/^ATLIAS_[A-Z0-9_]+$/.test(k)) throw new Error(`flag ${k} in arm ${s} is not an ATLIAS_ variable`);
      flags[k] = v;
    }
  }
  return { name: s, kind: 'atlias', ref: m[1], flags };
}

// The argv of one headless run. Both arms get the same flags but one: the
// atlias arm adds --plugin-dir, which is how Claude Code loads a plugin for
// one session from a folder (its hooks/hooks.json, skills/ and .mcp.json), the
// same three things a marketplace install enables. stream-json with hook
// events keeps each hook's start and outcome in the run's own output.
export function claudeArgs({ prompt, sessionId, model, effort, pluginDir = '', maxBudgetUsd = 0 }) {
  if (!prompt || !sessionId || !model) throw new Error('claudeArgs needs prompt, sessionId and model');
  const argv = ['-p', prompt,
    '--output-format', 'stream-json', '--verbose', '--include-hook-events',
    '--session-id', sessionId,
    '--model', model,
    '--permission-mode', 'bypassPermissions'];
  if (effort) argv.push('--effort', effort);
  if (maxBudgetUsd > 0) argv.push('--max-budget-usd', String(maxBudgetUsd));
  if (pluginDir) argv.push('--plugin-dir', pluginDir);
  return argv;
}

// What the init message says was loaded, and whether it is what the arm
// should have: the plain arm no atlias plugin, hook, skill or MCP server; the
// atlias arm exactly atlias's.
export function initProblems(init, arm) {
  const problems = [];
  if (!init) return ['the run printed no init message'];
  const plugins = (init.plugins || []).map((p) => String(p.name || p));
  const mcp = (init.mcp_servers || []).map((s) => String(s.name || s));
  const skills = (init.skills || []).map(String);
  const atliasish = (x) => /atlias/i.test(x);
  if (arm.kind === 'plain') {
    if (plugins.some(atliasish)) problems.push(`plain arm loaded plugin ${plugins.filter(atliasish).join(', ')}`);
    if (mcp.length) problems.push(`plain arm loaded MCP server(s) ${mcp.join(', ')}`);
    if (skills.some(atliasish)) problems.push(`plain arm listed atlias skill(s) ${skills.filter(atliasish).join(', ')}`);
  } else {
    if (!plugins.some(atliasish)) problems.push(`atlias arm did not load the atlias plugin (plugins: ${plugins.join(', ') || 'none'})`);
    const others = mcp.filter((n) => !atliasish(n));
    if (others.length) problems.push(`atlias arm loaded MCP server(s) other than atlias: ${others.join(', ')}`);
  }
  return problems;
}

// ---------- tokens ----------

// One request's usage, as the API reports it, in the study's two measures.
// Raw prompt tokens count every token the model read: fresh input, cache
// writes and cache reads alike. Billed-equivalent weights them as the API
// bills them against base input: cache reads 0.1, five-minute cache writes
// 1.25, one-hour writes 2.0. The raw number is the headline; the second is
// reported beside it, never instead of it.
export const CACHE_READ_X = 0.1;
export const CACHE_WRITE_5M_X = 1.25;
export const CACHE_WRITE_1H_X = 2.0;

export function tokensOf(usage) {
  const u = usage || {};
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  const input = n(u.input_tokens);
  const cacheRead = n(u.cache_read_input_tokens);
  const cacheWrite = n(u.cache_creation_input_tokens);
  const cc = u.cache_creation || {};
  let w1h = n(cc.ephemeral_1h_input_tokens);
  let w5m = n(cc.ephemeral_5m_input_tokens);
  // No breakdown: count every write at the five-minute rate and say so.
  const split = w1h + w5m === cacheWrite;
  if (!split) { w5m = cacheWrite; w1h = 0; }
  return {
    input, cacheRead, cacheWrite, cacheWrite5m: w5m, cacheWrite1h: w1h, splitKnown: split,
    output: n(u.output_tokens),
    promptRaw: input + cacheRead + cacheWrite,
    promptBilled: input + CACHE_READ_X * cacheRead + CACHE_WRITE_5M_X * w5m + CACHE_WRITE_1H_X * w1h,
  };
}

export function addTokens(a, b) {
  const out = { ...a };
  for (const k of ['input', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'output', 'promptRaw', 'promptBilled']) out[k] = (a[k] || 0) + (b[k] || 0);
  out.splitKnown = Boolean(a.splitKnown !== false && b.splitKnown !== false);
  return out;
}

export const ZERO_TOKENS = Object.freeze({ input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, promptRaw: 0, promptBilled: 0, splitKnown: true });

// ---------- transcripts ----------

export function readJsonl(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn line is skipped */ }
  }
  return rows;
}

// Every transcript file a run's Claude Code config dir holds, main session and
// subagents alike, found by walking HOME/.claude/projects.
export function transcriptFiles(home) {
  const root = path.join(home, '.claude', 'projects');
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

// Requests to the model, from the transcript: Claude Code writes one row per
// content block, each carrying the message id and the usage so far, so the
// last row of an id holds that request's usage. Sidechain (subagent) rows are
// requests too and are counted, apart.
export function requestsOf(rows) {
  const byId = new Map();
  for (const r of rows) {
    if (!r || r.type !== 'assistant' || !r.message || !r.message.id) continue;
    const id = r.message.id;
    byId.set(id, { id, model: r.message.model || '', usage: r.message.usage || null, sidechain: Boolean(r.isSidechain), synthetic: r.message.model === '<synthetic>' });
  }
  return [...byId.values()].filter((q) => !q.synthetic);
}

const EDIT_TOOL = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
const blocksOf = (r) => (r && r.message && Array.isArray(r.message.content) ? r.message.content : []);
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p && typeof p.text === 'string' ? p.text : typeof p === 'string' ? p : '')).join('\n') : '');

// A hold is a Stop hook that blocked the reply. Claude Code 2.1.284 writes one
// block into the transcript three ways: a user message "Stop hook feedback:
// ...", a system row "stop_hook_summary", and an attachment
// "hook_blocking_error" with hookEvent Stop. The attachment is the one counted,
// once per block; atlias's own reasons start with "atlias gate:". A hold "says
// no check ran" when its text says so in any of the gate's wordings.
export const HOLD_RE = /atlias gate:/;
export const NO_CHECK_RE = /(no check ran this turn|nothing was run to check it after the last edit|Checks run so far: none recorded)/;

export function holdTextOf(row) {
  if (!row || row.isSidechain || row.type !== 'attachment') return '';
  const a = row.attachment || {};
  if (a.type !== 'hook_blocking_error' || a.hookEvent !== 'Stop') return '';
  const be = a.blockingError;
  const text = typeof be === 'string' ? be : be && typeof be.blockingError === 'string' ? be.blockingError : JSON.stringify(be || '');
  return text || '(a Stop hook blocked with no text)';
}

// Stop hooks that blocked, from the run's stream-json output: a hook_response
// for Stop whose output asks to block. A second count of the same thing, from
// a different record, so the two can be checked against each other.
export function streamHolds(stream) {
  let n = 0;
  for (const r of stream) {
    if (!r || r.type !== 'system' || r.subtype !== 'hook_response' || r.hook_event !== 'Stop') continue;
    let out = null;
    try { out = JSON.parse(r.output || r.stdout || 'null'); } catch { out = null; }
    if ((out && out.decision === 'block') || r.exit_code === 2) n += 1;
  }
  return n;
}

// Walk the main transcript in order and say, for every hold, whether a check
// had run after the last edit before it. `isCheck(command, editedFiles)` is
// atlias's own rule, passed in so this file does not pin one version of it:
// a false hold by that rule is one the transcript recovery could have caught.
// `isBroad` is the study's wider reading - any interpreter run after the last
// edit, such as `node lint.mjs`, which atlias's rule does not call a check - so
// a hold that atlias's own classifier made false is counted too.
export function holdsOf(rows, isCheck, isBroad = isCheck) {
  const holds = [];
  const calls = new Map();
  let edited = [];
  let lastEditAt = -1;
  let checkAfterEdit = null;
  let broadAfterEdit = null;
  let seq = 0;
  for (const r of rows) {
    if (!r || r.isSidechain) continue;
    if (r.type === 'assistant') {
      for (const b of blocksOf(r)) {
        if (!b || b.type !== 'tool_use') continue;
        seq += 1;
        calls.set(b.id, { name: b.name, input: b.input || {}, seq });
        if (EDIT_TOOL.test(b.name)) {
          const f = b.input && (b.input.file_path || b.input.notebook_path);
          if (f) edited.push(String(f));
          lastEditAt = seq;
          checkAfterEdit = null;
          broadAfterEdit = null;
        }
      }
      continue;
    }
    for (const b of blocksOf(r)) {
      if (!b || b.type !== 'tool_result') continue;
      const c = calls.get(b.tool_use_id);
      if (!c || c.name !== 'Bash' || c.seq < lastEditAt) continue;
      const cmd = String(c.input.command || '');
      if (cmd && isCheck(cmd, edited)) checkAfterEdit = { command: cmd, failed: Boolean(b.is_error) };
      if (cmd && (isCheck(cmd, edited) || isBroad(cmd, edited))) broadAfterEdit = { command: cmd, failed: Boolean(b.is_error) };
    }
    const text = holdTextOf(r);
    if (text) {
      const saysNoCheck = NO_CHECK_RE.test(text);
      holds.push({
        atlias: HOLD_RE.test(text), saysNoCheck,
        checkShown: Boolean(checkAfterEdit), falseNoCheck: saysNoCheck && Boolean(checkAfterEdit),
        runShown: Boolean(broadAfterEdit), falseNoCheckBroad: saysNoCheck && Boolean(broadAfterEdit),
        check: (checkAfterEdit || broadAfterEdit) ? (checkAfterEdit || broadAfterEdit).command.slice(0, 200) : '',
        text: text.slice(0, 400),
      });
    }
  }
  return holds;
}

// Hook calls, from the stream-json output of a run started with
// --include-hook-events: a hook_started per call, and a hook_response (or
// equivalent) with its outcome. A call counts as cancelled when its outcome
// says so, or when it started and never answered.
export function hookCallsOf(stream) {
  const started = new Map();
  const finished = new Map();
  for (const r of stream) {
    if (!r || r.type !== 'system') continue;
    const st = String(r.subtype || '');
    if (!/^hook_/.test(st)) continue;
    const id = r.hook_id || r.uuid || `${r.hook_event || r.hook_name}-${started.size}`;
    if (st === 'hook_started') started.set(id, { event: r.hook_event || r.hook_name || '', name: r.hook_name || '' });
    else finished.set(id, { subtype: st, outcome: String(r.outcome || r.status || ''), event: r.hook_event || r.hook_name || '', name: r.hook_name || '', exitCode: r.exit_code ?? null });
  }
  const calls = [];
  for (const [id, s] of started) {
    const f = finished.get(id);
    const outcome = f ? f.outcome || f.subtype : 'no answer';
    calls.push({ id, event: s.event, name: s.name, outcome, cancelled: !f || /cancel/i.test(outcome) });
  }
  for (const [id, f] of finished) if (!started.has(id)) calls.push({ id, event: f.event, name: f.name, outcome: f.outcome || f.subtype, cancelled: /cancel/i.test(f.outcome || f.subtype) });
  return calls;
}

// The SessionStart brief a run was given, from its hook_response in the
// stream: its length in characters, and whether it is the lean one
// (flags.leanBrief drops the list of MCP tool names from its first line).
export function briefOf(stream) {
  for (const r of stream || []) {
    if (!r || r.type !== 'system' || r.subtype !== 'hook_response' || !/^SessionStart/.test(String(r.hook_event || r.hook_name || ''))) continue;
    let text = '';
    try { text = String(((JSON.parse(String(r.output || '{}')).hookSpecificOutput) || {}).additionalContext || ''); } catch { text = ''; }
    if (!/\[atlias /.test(text)) continue;
    return { chars: text.length, lean: !/harness_recall, harness_remember/.test(text), gateRunsCheck: /atlias runs `[^`]+` when you finish/.test(text) };
  }
  return null;
}

// Checks atlias's gate ran itself (flags.gateRunsCheck), from the session
// event logs under the run's own HOME: each is a shell event with from 'gate'.
export function gateChecksOf(home) {
  const dir = path.join(home, '.atlias', 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  return names.flatMap((f) => readJsonl(path.join(dir, f)))
    .filter((e) => e && e.kind === 'shell' && e.from === 'gate')
    .map((e) => ({ command: String(e.command || ''), outcome: String(e.outcome || '') }));
}

// Cancelled hook calls the transcript itself records (Claude Code writes an
// attachment or system row for a hook it cancelled). Counted from whichever
// row shape carries the word, so a version change is visible as a zero rather
// than a crash.
export function cancelledInTranscript(rows) {
  let n = 0;
  const kinds = {};
  for (const r of rows) {
    if (!r || r.type === 'assistant') continue;
    const a = r.attachment || null;
    const blob = a && /hook/i.test(String(a.type || '')) ? JSON.stringify(a)
      : r.type === 'system' && /hook/i.test(String(r.subtype || '')) ? JSON.stringify({ subtype: r.subtype, content: r.content, hookErrors: r.hookErrors, level: r.level }) : '';
    if (!blob) continue;
    if (/cancel/i.test(blob)) {
      n += 1;
      const k = (a && (a.hookEvent || a.hookName || a.type)) || r.subtype || 'unknown';
      kinds[k] = (kinds[k] || 0) + 1;
    }
  }
  return { n, kinds };
}

// ---------- statistics ----------

export function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }
export function sd(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

// Two-sided 97.5th percentile of Student's t, for df 1..30, then the normal.
const T975 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
export function t975(df) { return df >= 1 && df <= 30 ? T975[df] : df > 30 ? 1.96 + 2.4 / df : NaN; }

// A seeded generator (mulberry32) so an interval is the same interval on every
// re-run of the summary.
export function rng32(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// The paired ratio of arm B to arm A over tasks both arms solved.
// pairs: [{ a, b }] with a, b > 0 (tokens of each arm on one task).
// - ratioOfSums: sum(b) / sum(a), which is what "tokens per solved task, B
//   over A" means on a common task set, with a paired bootstrap interval
//   (tasks resampled with replacement, both arms together).
// - geoMean: the geometric mean of per-task ratios, with a t interval on the
//   log ratios.
export function pairedRatio(pairs, { rounds = 10000, seed = 1 } = {}) {
  const ok = pairs.filter((p) => p.a > 0 && p.b > 0);
  const n = ok.length;
  if (!n) return { n: 0 };
  const sa = ok.reduce((s, p) => s + p.a, 0), sb = ok.reduce((s, p) => s + p.b, 0);
  const rng = rng32(seed);
  const boots = [];
  for (let i = 0; i < rounds; i++) {
    let xa = 0, xb = 0;
    for (let j = 0; j < n; j++) { const p = ok[Math.floor(rng() * n)]; xa += p.a; xb += p.b; }
    boots.push(xb / xa);
  }
  boots.sort((x, y) => x - y);
  const logs = ok.map((p) => Math.log(p.b / p.a));
  const m = mean(logs), s = sd(logs), t = t975(n - 1);
  const half = n > 1 ? t * s / Math.sqrt(n) : NaN;
  return {
    n,
    ratioOfSums: sb / sa,
    bootLo: quantile(boots, 0.025),
    bootHi: quantile(boots, 0.975),
    geoMean: Math.exp(m),
    tLo: n > 1 ? Math.exp(m - half) : NaN,
    tHi: n > 1 ? Math.exp(m + half) : NaN,
    perTask: ok.map((p) => p.b / p.a),
  };
}

// Is an interval "inside the noise"? For a ratio: when it contains 1.
export function insideNoise(lo, hi) { return !(lo > 1 || hi < 1); }

// Exact two-sided McNemar on one-way flips: lib/eval.mjs's own test.
export function mcnemarP(gained, lost) { return mcnemar(gained, lost).p; }
