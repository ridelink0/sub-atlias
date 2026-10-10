// OpenCode v2 as the local-model runtime, launched from the pinned source.
//
// One run is one `opencode run --format json --standalone` process against a
// private state root: its own XDG roots, home, temp and config, no project or
// global config, no model catalogue fetch, no cloud provider, and an Ollama
// provider that is the loopback ledger of lib/opencode-provider-ledger.mjs.
// The ledger, not the CLI's JSON, is the token record: the CLI reports only
// the selected session's steps, while the ledger sees every provider call.
// Guards before anything starts: the window must be a measured 8k or 16k
// profile, the original GPU owner must be gone, this run must win its own
// exclusive GPU lease, free RAM must be above the floor; the same owner, lease
// and RAM checks run again before every inference call. During the run a RAM
// sampler and a wall-clock limit cancel it: the ledger is held first, then the
// child is ended through its own process handle. Nothing is ever ended by PID.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { startProviderLedger, sha256, validCount, readLedgerFile, summarize, DEFAULT_UPSTREAM } from './opencode-provider-ledger.mjs';

export const RUN_SCHEMA = 'atlias.opencode.run/2';
// tree: the commit's tree as the GitHub API reports it (fetched independently
// of the local checkout, 2026-10-09); bunLockSha256: the pinned lockfile.
export const OPENCODE_PIN = Object.freeze({ repository: 'https://github.com/anomalyco/opencode', commit: 'd2905b8ddae8b0353cd2166d68d59795397921db', tree: 'ec2dbc32beca9b7da380eb5105e1af6e40f64ebd', bunLockSha256: '38d87455657200e270ab3e06fc88f0407bdee37c2d980494811efa3342500022', version: '2.0.26', packageManager: 'bun@1.4.2' });
const MAX_STDOUT = 64 * 1024 * 1024;
const ROOT = process.env.ATLIAS_OPENCODE_ROOT || 'D:/harness-work/atlias-opencode-1009';
export const DEFAULTS = Object.freeze({
  sourceRoot: process.env.ATLIAS_OPENCODE_SOURCE || path.join(ROOT, 'upstream'),
  bun: process.env.ATLIAS_OPENCODE_BUN || path.join(ROOT, 'runtime', 'bun-windows-x64', process.platform === 'win32' ? 'bun.exe' : 'bun'),
  upstream: DEFAULT_UPSTREAM,
  // The original evolution's lock and its HEARTBEAT.json: a live pid in either
  // means the original owner is running, locked or between stages.
  gpuLocks: ['D:/harness-work/atlias-evolve/EVOLVE-GPU.lock', 'D:/harness-work/atlias-evolve/HEARTBEAT.json'],
  leaseFile: path.join(ROOT, 'OPENCODE-GPU.lease'),
  ramFloorBytes: 512 * 1024 * 1024,
  agent: 'atlias',
});

// Model and window pairs with a measured fit on this 12 GiB card, and where
// the measurement comes from. Anything else needs allowUnmeasured.
const MEASURED = {
  'qwen2.5-coder:7b@16384': 'read-only /api/ps on 11435, 2026-10-09: loaded at context_length 16384, size_vram 5024964934',
  'qwen2.5-coder:7b@8192': 'smaller than the measured 16384 load of the same model',
  'qwen3.5:9b@8192': 'Codex native55 receipt (WORK-PLAN 2026-10-09): 9B at 8k, VRAM 5502937332',
  'qwen2.5-coder:14b@8192': 'Codex native54 receipt (WORK-PLAN 2026-10-09): 14B Q4 at 8k, VRAM 9524708637',
};
export const MEASURED_PAIRS = Object.keys(MEASURED);

// The window is 8192 or 16384 and nothing else. The output cap leaves room
// for the prompt, and compaction keeps the cap plus 512 tokens of estimate
// error free (OpenCode's ceiling is window - buffer, core/session/compaction.ts:905).
export function contextProfile(model, numCtx, { allowUnmeasured = false } = {}) {
  if (numCtx !== 8192 && numCtx !== 16384) throw new Error(`the window is 8192 or 16384, not ${numCtx}`);
  const evidence = MEASURED[`${model}@${numCtx}`] || null;
  if (!evidence && !allowUnmeasured) throw new Error(`${model} at ${numCtx} has no measured fit on this card; pass allowUnmeasured to run it anyway`);
  const numPredict = numCtx === 8192 ? 2048 : 4096;
  return { model, numCtx, numPredict, compaction: { auto: true, keep: numCtx === 8192 ? 1024 : 2048, buffer: numPredict + 512 }, measured: Boolean(evidence), evidence };
}

// Ordered rules, last match wins (schema/permission.ts). Everything is denied,
// then the file tools are allowed; shell is denied unless asked for, because a
// shell can reach the network; leaving the task directory is always denied.
export function permissionRules({ shell = 'deny', subagent = 'allow' } = {}) {
  return [
    { action: '*', resource: '*', effect: 'deny' },
    ...['read', 'glob', 'grep', 'edit', 'write', 'patch'].map((action) => ({ action, resource: '*', effect: 'allow' })),
    { action: 'subagent', resource: '*', effect: subagent },
    { action: 'shell', resource: '*', effect: shell },
    { action: 'external_directory', resource: '*', effect: 'deny' },
  ];
}

// The whole config, passed as OPENCODE_CONFIG_CONTENT. No system prompt is set
// unless given: an agent system replaces OpenCode's own prompt
// (core/session/model-request.ts baseTranscript), and the default keeps it.
export function opencodeConfig({ model, profile, baseURL, agent = DEFAULTS.agent, system, steps, shell, subagent }) {
  const agentInfo = { mode: 'primary', description: 'Atlias local coding agent', permissions: permissionRules({ shell, subagent }) };
  if (system) agentInfo.system = String(system);
  if (steps) agentInfo.steps = Number(steps);
  return {
    model: `ollama/${model}`,
    default_agent: agent,
    update: 'disable',
    share: 'disabled',
    warming: false,
    snapshots: false,
    lsp: false,
    formatter: false,
    websearch: false,
    compaction: { auto: profile.compaction.auto, keep: { tokens: profile.compaction.keep }, buffer: profile.compaction.buffer },
    providers: { ollama: { settings: { baseURL }, models: { [model]: { limit: { context: profile.numCtx, output: profile.numPredict } } } } },
    agents: { [agent]: agentInfo },
  };
}

const KEEP_ENV = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'TZ']);

// A child environment built from nothing: only the variables a process needs to
// start on this OS are copied, so no provider key, token or OPENCODE_* setting
// of the parent can reach the run. Home, XDG roots, temp and app data all live
// under stateRoot; HTTP(S)_PROXY points at the ledger, which records and
// refuses any request that tries to leave the machine.
export function isolatedEnv({ stateRoot, taskDir, config, proxyUrl, base = process.env }) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (KEEP_ENV.has(k.toUpperCase()) && v != null && !Object.keys(env).some((e) => e.toUpperCase() === k.toUpperCase())) env[k] = v;
  const d = (...p) => { const x = path.join(stateRoot, ...p); fs.mkdirSync(x, { recursive: true }); return x; };
  const home = d('home');
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: d('appdata', 'Roaming'),
    LOCALAPPDATA: d('appdata', 'Local'),
    XDG_DATA_HOME: d('xdg', 'data'),
    XDG_CACHE_HOME: d('xdg', 'cache'),
    XDG_CONFIG_HOME: d('xdg', 'config'),
    XDG_STATE_HOME: d('xdg', 'state'),
    TMP: d('tmp'),
    TEMP: path.join(stateRoot, 'tmp'),
    TMPDIR: path.join(stateRoot, 'tmp'),
    OPENCODE_TEST_HOME: home,
    OPENCODE_CONFIG_PROJECT_DISABLE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_FFF: '1',
    OPENCODE_FILEWATCHER_DISABLE: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
    PWD: taskDir,
    NO_COLOR: '1',
    DO_NOT_TRACK: '1',
  });
  return env;
}

// bun runs the pinned CLI source from packages/cli so its bunfig preload
// applies; PWD (set in the env) is the directory the run works in (run.ts:73).
export function buildCommand({ bun = DEFAULTS.bun, sourceRoot = DEFAULTS.sourceRoot, model, agent = DEFAULTS.agent, thinking = false }) {
  const cli = path.join(sourceRoot, 'packages', 'cli');
  return { file: bun, args: ['run', path.join(cli, 'src', 'index.ts'), 'run', '--format', 'json', '--model', `ollama/${model}`, '--agent', agent, '--standalone', ...(thinking ? ['--thinking'] : [])], cwd: cli };
}

// Is this the pinned source with its dependencies, and the pinned bun?
export function verifySource(sourceRoot = DEFAULTS.sourceRoot, bun = DEFAULTS.bun) {
  const root = path.resolve(sourceRoot);
  const r = { root, ok: false, version: null, packageManager: null, commit: null, commitFrom: null, entry: path.join(root, 'packages', 'cli', 'src', 'index.ts'), depsReady: false, bun: { path: bun, version: null }, problems: [] };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    r.version = pkg.version; r.packageManager = pkg.packageManager;
    if (pkg.version !== OPENCODE_PIN.version) r.problems.push(`package.json version ${pkg.version}, pinned ${OPENCODE_PIN.version}`);
    if (pkg.packageManager !== OPENCODE_PIN.packageManager) r.problems.push(`packageManager ${pkg.packageManager}, pinned ${OPENCODE_PIN.packageManager}`);
  } catch (e) { r.problems.push(`no readable package.json at ${root}: ${e.message}`); }
  if (!fs.existsSync(r.entry)) r.problems.push(`no CLI entry at ${r.entry}`);
  // Identity is the git checkout itself: HEAD and its tree must be the pinned
  // ones and no tracked file may differ from them. A PIN.json is self-written
  // and is not accepted as proof of anything.
  const git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const head = git('rev-parse', 'HEAD', 'HEAD^{tree}');
  const [commit, tree] = head.status === 0 ? head.stdout.trim().split(/\r?\n/) : [];
  if (/^[0-9a-f]{40}$/.test(commit || '')) { r.commit = commit; r.tree = tree || null; r.commitFrom = 'git'; }
  else r.problems.push('the source is not a readable git checkout; a PIN.json is not accepted as its identity');
  if (r.commit && r.commit !== OPENCODE_PIN.commit) r.problems.push(`source commit ${r.commit}, pinned ${OPENCODE_PIN.commit}`);
  if (r.commit && r.tree !== OPENCODE_PIN.tree) r.problems.push(`source tree ${r.tree}, pinned ${OPENCODE_PIN.tree}`);
  if (r.commit) {
    const st = git('status', '--porcelain', '--untracked-files=no');
    r.trackedClean = st.status === 0 && !st.stdout.trim();
    if (!r.trackedClean) r.problems.push(st.status === 0 ? `tracked files differ from the pinned commit: ${st.stdout.trim().split(/\r?\n/).slice(0, 5).join('; ')}` : 'git status did not answer');
  }
  try { r.bunLockSha256 = sha256(fs.readFileSync(path.join(root, 'bun.lock'))); } catch { r.bunLockSha256 = null; }
  if (r.bunLockSha256 !== OPENCODE_PIN.bunLockSha256) r.problems.push(`bun.lock sha256 ${r.bunLockSha256 || 'unreadable'}, pinned ${OPENCODE_PIN.bunLockSha256}`);
  // The installed CLI dependencies, with the versions their manifests declare.
  r.deps = {};
  for (const name of ['@opentui/solid', 'effect']) {
    r.deps[name] = null;
    for (const base of ['packages/cli/node_modules', 'node_modules']) {
      try { const m = JSON.parse(fs.readFileSync(path.join(root, base, name, 'package.json'), 'utf8')); r.deps[name] = { version: m.version || null, base }; break; } catch { /* next base */ }
    }
  }
  r.depsReady = Object.values(r.deps).every(Boolean);
  if (!r.depsReady) r.problems.push('CLI dependencies are not installed (missing @opentui/solid or effect manifests)');
  const v = spawnSync(bun, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  r.bun.version = v.status === 0 ? v.stdout.trim() : null;
  if (`bun@${r.bun.version}` !== OPENCODE_PIN.packageManager) r.problems.push(`bun at ${bun} is ${r.bun.version || 'not runnable'}, pinned ${OPENCODE_PIN.packageManager}`);
  r.ok = r.problems.length === 0;
  return r;
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// A lock held by a live process, or one whose owner cannot be read, means the
// GPU is not this run's to use.
export function gpuOwnership(locks = DEFAULTS.gpuLocks) {
  const found = [];
  for (const file of locks) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let pid = null;
    try { pid = Number(JSON.parse(raw).pid) || null; } catch { /* unreadable owner */ }
    found.push({ file, pid, alive: pid ? pidAlive(pid) : null, sha256: sha256(raw) });
  }
  return { clean: !found.some((l) => l.alive !== false), locks: found };
}

// The run's own exclusive claim on the GPU, separate from the original
// evolution's EVOLVE-GPU.lock, which is never written here. It is created with
// O_EXCL, so two runs cannot both hold it. A lease whose owner process is gone
// (or that stayed unreadable for ten minutes) is moved aside, never deleted
// unread, and the claim is tried once more.
export function acquireGpuLease(file = DEFAULTS.leaseFile, { runId = crypto.randomUUID() } = {}) {
  const held = { pid: process.pid, runId, startedAt: new Date().toISOString(), host: os.hostname() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, JSON.stringify(held)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return { ok: true, file, runId, held };
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, file, problem: `the GPU lease could not be created: ${e.message}` };
      let cur = null;
      let age = 0;
      try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable */ }
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { /* moved meanwhile */ }
      const pid = cur && Number(cur.pid);
      if (pid && pidAlive(pid)) return { ok: false, file, owner: cur, problem: `the GPU lease is held by live process ${pid}` };
      if (!pid && age < 10 * 60 * 1000) return { ok: false, file, owner: cur, problem: 'the GPU lease exists and its owner cannot be read' };
      try { fs.renameSync(file, `${file}.stale-${Date.now()}`); } catch { /* another run moved it first */ }
    }
  }
  return { ok: false, file, problem: 'the GPU lease changed hands while it was being claimed' };
}

export function leaseHeld(lease) {
  if (!lease || !lease.ok) return false;
  try { const cur = JSON.parse(fs.readFileSync(lease.file, 'utf8')); return cur.runId === lease.runId && cur.pid === process.pid; } catch { return false; }
}

export function releaseGpuLease(lease) {
  if (!leaseHeld(lease)) return false;
  try { fs.unlinkSync(lease.file); return true; } catch { return false; }
}

// Read-only: processes the run's child started (any depth) that are still
// running after it ended. Only processes created after the child was spawned
// can descend from it, which keeps a reused parent PID from matching. Nothing
// found here is ended; the receipt reports it and the run is not completed.
export function surveyDescendants(rootPid, spawnedAt, { ramFloorBytes = DEFAULTS.ramFloorBytes } = {}) {
  if (process.platform !== 'win32') return { checked: false, reason: 'the survey is implemented for Windows only', survivors: [] };
  if (!rootPid || !spawnedAt) return { checked: false, reason: 'no child was spawned', survivors: [] };
  if (os.freemem() < ramFloorBytes + 256 * 1024 * 1024) return { checked: false, reason: 'free RAM is too close to the floor to start the survey', survivors: [] };
  const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString(\"yyyy-MM-dd'T'HH:mm:ss.fff'Z'\"), $_.Name }";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) return { checked: false, reason: `the process survey failed: ${String(r.stderr || (r.error && r.error.message) || r.status).slice(0, 200)}`, survivors: [] };
  const t0 = Date.parse(spawnedAt) - 2000;
  const procs = r.stdout.split(/\r?\n/).map((l) => l.split('|')).filter((p) => p.length >= 4).map(([pid, ppid, c, ...n]) => ({ pid: Number(pid), ppid: Number(ppid), createdAt: c, name: n.join('|') }));
  const survivors = [];
  const seen = new Set([rootPid]);
  const frontier = [rootPid];
  while (frontier.length) {
    const p = frontier.shift();
    for (const q of procs) if (q.ppid === p && !seen.has(q.pid) && Date.parse(q.createdAt) >= t0) { seen.add(q.pid); survivors.push(q); frontier.push(q.pid); }
  }
  return { checked: true, survivors };
}

// The CLI's JSON lines: one object per line with type, timestamp, sessionID
// (cli/src/run/noninteractive.ts:93). step_finish carries the selected
// session's step tokens {input, output, reasoning, cache:{read, write}}.
export function parseRunEvents(stdout) {
  const r = { events: 0, unparsed: [], types: {}, sessions: {}, errors: [], text: '' };
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { r.unparsed.push(line.slice(0, 300)); continue; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) { r.unparsed.push(line.slice(0, 300)); continue; }
    r.events++;
    r.types[e.type] = (r.types[e.type] || 0) + 1;
    const sessionOf = (id) => r.sessions[id] || (r.sessions[id] = { steps: 0, started: 0, invalid: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, stepList: [] });
    // A step can start and never print its finish (the CLI ended first), so the
    // starts are counted too: those steps are paid for on the ledger only.
    if (e.type === 'step_start') sessionOf(e.sessionID).started++;
    if (e.type === 'step_finish') {
      // A step whose counters are missing or not whole numbers is counted as
      // invalid, never as zero, and its session cannot reconcile.
      const t = (e.part && e.part.tokens) || {};
      const s = sessionOf(e.sessionID);
      const vals = [t.input, t.output, t.reasoning, t.cache && t.cache.read, t.cache && t.cache.write];
      s.steps++;
      if (!vals.every(validCount)) { s.invalid++; continue; }
      s.input += t.input; s.output += t.output; s.reasoning += t.reasoning;
      s.cacheRead += t.cache.read; s.cacheWrite += t.cache.write;
      s.stepList.push({ input: t.input + t.cache.read + t.cache.write, cached: t.cache.read, output: t.output + t.reasoning });
    }
    if (e.type === 'error') r.errors.push(e.error || null);
    if (e.type === 'text' && e.part && typeof e.part.text === 'string') r.text += e.part.text;
  }
  return r;
}

// What the CLI reported against what the ledger saw. OpenCode's step input is
// the uncached part, so the CLI's native input is input + cache read + cache
// write; any session the CLI never printed (children, titles, compaction of
// another session) shows up only on the ledger side.
// With the ledger's own records, the check is call by call: every step the CLI
// printed must be one real call of that session with the same input, cached
// input and output. OpenCode also pays for calls it never prints as a step (a
// title, a summary, a last step whose finish the CLI did not print before it
// exited); those are named as auxiliary with their counts, not hidden, and the
// ledger total stays the cost of the run.
export function reconcile(cli, ledger, records = null) {
  const sessions = {};
  let cliTotal = 0;
  const calls = Array.isArray(records) ? records.filter((r) => r && r.kind === 'chat' && r.tokens && validCount(r.tokens.input) && validCount(r.tokens.output)) : null;
  for (const [id, s] of Object.entries(cli.sessions || {})) {
    const input = s.input + s.cacheRead + s.cacheWrite;
    const output = s.output + s.reasoning;
    cliTotal += input + output;
    const l = (ledger.sessions || {})[id] || null;
    const invalid = s.invalid || 0;
    const totalsEqual = Boolean(l) && l.input === input && l.output === output;
    const entry = { cli: { input, output, steps: s.steps, started: s.started ?? null, invalid }, ledger: l ? { input: l.input, output: l.output, calls: l.calls, unknown: l.unknown } : null, totalsEqual, match: Boolean(l) && invalid === 0 && l.unknown === 0 && totalsEqual };
    if (calls && l && Array.isArray(s.stepList)) {
      const mine = calls.filter((c) => c.session && c.session.id === id);
      const used = new Set();
      let matched = 0;
      for (const step of s.stepList) {
        const hit = mine.find((c) => !used.has(c.seq) && c.tokens.input === step.input && c.tokens.output === step.output && (c.tokens.cachedInput ?? 0) === step.cached);
        if (hit) { used.add(hit.seq); matched++; }
      }
      const extra = mine.filter((c) => !used.has(c.seq));
      const unfinished = Math.max(0, (s.started ?? s.steps) - s.steps);
      entry.stepsMatched = matched;
      entry.auxiliary = extra.map((c, i) => ({ seq: c.seq, input: c.tokens.input, output: c.tokens.output, kind: i >= extra.length - unfinished ? 'step the CLI did not print' : 'not a printed step (title or summary)' }));
      entry.match = invalid === 0 && l.unknown === 0 && matched === s.stepList.length && matched === s.steps;
    }
    sessions[id] = entry;
  }
  const ledgerOnly = Object.keys(ledger.sessions || {}).filter((id) => !(id in sessions));
  const cliValid = Object.values(sessions).every((x) => x.cli.invalid === 0);
  return { sessions, ledgerOnly, cliTotal: cliValid ? cliTotal : null, ledgerTotal: ledger.total, ledgerComplete: ledger.complete, unreportedByCli: ledger.complete && cliValid && validCount(ledger.total) ? ledger.total - cliTotal : null };
}

// Size and mtime of the real opencode roots in the user's own home, before and
// after: the run must leave them as they were.
export function globalProfileSignature(home = os.homedir()) {
  const out = {};
  for (const p of ['.config/opencode', '.local/share/opencode', '.cache/opencode', '.local/state/opencode']) {
    const f = path.join(home, p);
    try { const s = fs.statSync(f); out[p] = { mtimeMs: s.mtimeMs, entries: s.isDirectory() ? fs.readdirSync(f).length : null }; } catch { out[p] = null; }
  }
  return out;
}

function spawnCollect(cmd, env, input, { timeoutMs, ramFloorBytes, sampleMs = 1000, onCancel = null }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const r = { code: null, signal: null, timedOut: false, ramGuard: false, spawnError: null, stdout: '', stderr: '', stdoutTruncated: false, minFreeRam: os.freemem(), durationMs: 0, pid: null, spawnedAt: null, cancel: null };
    let child;
    try { child = spawn(cmd.file, cmd.args, { cwd: cmd.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { r.spawnError = e.message; resolve(r); return; }
    r.pid = child.pid;
    r.spawnedAt = new Date().toISOString();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { if (r.stdout.length + c.length <= MAX_STDOUT) r.stdout += c; else r.stdoutTruncated = true; });
    child.stderr.on('data', (c) => { r.stderr = (r.stderr + c).slice(-1024 * 1024); });
    child.stdin.on('error', () => {});
    child.stdin.end(input, 'utf8');
    // Cancellation never looks a process up by PID. The ledger is held first,
    // so no new inference can start and a running call is cut at the
    // provider; then the child is ended through the handle Node opened when it
    // spawned it (ChildProcess.kill: libuv's TerminateProcess on that handle on
    // Windows), which cannot reach a process that later reuses the PID.
    // Processes the child started itself are not ended here: the run surveys
    // and reports them afterwards.
    const stop = (why) => {
      if (r.cancel) return;
      r.cancel = { why, at: new Date().toISOString(), method: 'ledger-hold-then-owned-handle', ledgerHeld: false, signalled: false, error: null };
      try { if (onCancel) { onCancel(why); r.cancel.ledgerHeld = true; } } catch (e) { r.cancel.error = `ledger hold: ${e.message}`; }
      try { child.stdin.destroy(); } catch { /* already closed */ }
      try { r.cancel.signalled = child.kill(); } catch (e) { r.cancel.error = e.message; }
    };
    const timer = setTimeout(() => { r.timedOut = true; stop('wall-clock limit'); }, timeoutMs);
    const sampler = setInterval(() => {
      const free = os.freemem();
      r.minFreeRam = Math.min(r.minFreeRam, free);
      if (free < ramFloorBytes && !r.ramGuard) { r.ramGuard = true; stop('RAM floor'); }
    }, sampleMs);
    child.on('error', (e) => { r.spawnError = e.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearInterval(sampler);
      r.code = code; r.signal = signal; r.durationMs = Date.now() - t0;
      resolve(r);
    });
  });
}

// The run's status once the process has ended. Process exit, output parsing,
// isolation, inference and accounting are separate questions (receipt.verdicts);
// 'completed' needs every one of them, and still says nothing about whether
// the task was solved: the execution oracle decides that.
function finalStatus(receipt, hold) {
  const e = receipt.exit, cli = receipt.cli, L = receipt.ledger, rc = receipt.reconciliation;
  if (e.spawnError) return 'spawn-failed';
  if (e.timedOut) return 'timed-out';
  if (e.ramGuard) return 'ram-guard';
  if (hold) return 'held-boot';
  if (e.code !== 0) return 'failed';
  if (!cli.events) return 'no-events';
  if (cli.errors.length) return 'failed';
  if (cli.unparsed.length || e.stdoutTruncated) return 'malformed-output';
  if (L.egressAttempts) return 'egress-attempted';
  if (receipt.globalProfileUnchanged !== true) return 'profile-modified';
  if (!(L.byStatus.ok > 0)) return 'no-successful-inference';
  if (!L.complete) return 'accounting-incomplete';
  const ids = Object.keys(rc.sessions);
  if (!ids.length || ids.some((id) => !rc.sessions[id].match)) return 'accounting-unreconciled';
  if (receipt.descendants && receipt.descendants.survivors.length) return 'left-processes-running';
  return 'completed';
}

function verdictsOf(receipt) {
  const e = receipt.exit, cli = receipt.cli, L = receipt.ledger, rc = receipt.reconciliation;
  const ids = Object.keys(rc.sessions);
  return {
    process: e.spawnError ? 'spawn-failed' : e.timedOut ? 'cancelled: wall-clock limit' : e.ramGuard ? 'cancelled: RAM floor' : `exited ${e.code ?? e.signal}`,
    output: !cli.events ? 'no events' : cli.unparsed.length || e.stdoutTruncated ? 'events with malformed or truncated output' : cli.errors.length ? 'events with errors' : 'events parsed',
    isolation: L.egressAttempts ? 'egress attempted (refused)' : receipt.globalProfileUnchanged === true ? 'held' : 'global profile changed',
    inference: L.byStatus.ok > 0 ? `${L.byStatus.ok} answered of ${L.calls}` : L.calls ? 'only refused or failed calls' : 'none',
    accounting: !L.complete ? 'incomplete (unknown calls stay unknown)' : ids.length && ids.every((id) => rc.sessions[id].match) ? 'complete and reconciled with the CLI' : 'complete on the ledger, not reconciled with the CLI',
    processes: !receipt.descendants ? 'not surveyed' : !receipt.descendants.checked ? `not surveyed: ${receipt.descendants.reason}` : receipt.descendants.survivors.length ? `${receipt.descendants.survivors.length} left running (reported, not ended)` : 'none left running',
    task: 'not judged here: the execution oracle decides task success',
  };
}

// One run. Returns the receipt and writes it to <stateRoot>/receipt.json.
// opts.hold starts everything but refuses every inference call (a boot check
// while another owner holds the GPU; no lease is taken). opts.command replaces
// the bun command (a test seam); the receipt then says the runtime was not
// the pinned CLI.
export async function runOpenCode(opts = {}) {
  const o = { ...DEFAULTS, numCtx: 8192, timeoutMs: 30 * 60 * 1000, ...opts };
  const stateRoot = path.resolve(o.stateRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-opencode-')));
  fs.mkdirSync(stateRoot, { recursive: true });
  const receipt = { schema: RUN_SCHEMA, runId: crypto.randomUUID(), startedAt: new Date().toISOString(), pin: OPENCODE_PIN, runtime: o.command ? 'custom-command' : 'opencode-pinned-source', model: o.model, numCtx: o.numCtx, stateRoot, taskDir: o.taskDir ? path.resolve(o.taskDir) : null, hold: o.hold || null, status: null, problems: [] };
  const finish = (status) => {
    receipt.status = status;
    receipt.endedAt = new Date().toISOString();
    fs.writeFileSync(path.join(stateRoot, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    return receipt;
  };
  if (!receipt.taskDir || !fs.existsSync(receipt.taskDir)) { receipt.problems.push(`task directory ${o.taskDir} does not exist`); return finish('bad-task-dir'); }
  if (typeof o.prompt !== 'string' || !o.prompt.trim()) { receipt.problems.push('the prompt is empty'); return finish('bad-prompt'); }
  receipt.promptSha256 = sha256(o.prompt);
  let profile;
  try { profile = contextProfile(o.model, o.numCtx, { allowUnmeasured: o.allowUnmeasured }); } catch (e) { receipt.problems.push(e.message); return finish('bad-profile'); }
  receipt.profile = profile;
  if (!o.hold) {
    receipt.gpu = gpuOwnership(o.gpuLocks);
    if (!receipt.gpu.clean) { receipt.problems.push('the original GPU owner is live; run with hold for a boot check'); return finish('gpu-busy'); }
  }
  receipt.freeRamAtStart = os.freemem();
  if (receipt.freeRamAtStart < o.ramFloorBytes) { receipt.problems.push(`free RAM ${receipt.freeRamAtStart} is below the floor ${o.ramFloorBytes}`); return finish('ram-floor'); }
  if (!o.command) {
    receipt.source = verifySource(o.sourceRoot, o.bun);
    if (!receipt.source.ok) { receipt.problems.push(...receipt.source.problems); return finish('source-not-ready'); }
  }
  let lease = null;
  if (!o.hold) {
    lease = acquireGpuLease(o.leaseFile, { runId: receipt.runId });
    receipt.lease = { file: lease.file, ok: lease.ok, problem: lease.problem || null, owner: lease.owner || null, released: null };
    if (!lease.ok) { receipt.problems.push(lease.problem); return finish('gpu-lease-busy'); }
  }
  let status;
  try { status = await leasedRun(o, receipt, profile, stateRoot, lease); } finally { if (lease) receipt.lease.released = releaseGpuLease(lease); }
  return finish(status);
}

async function leasedRun(o, receipt, profile, stateRoot, lease) {
  // Rechecked before every inference call, not only at the start.
  const beforeDispatch = o.hold ? null : () => {
    if (!gpuOwnership(o.gpuLocks).clean) return 'the original GPU owner is live';
    if (!leaseHeld(lease)) return 'this run no longer holds its GPU lease';
    const free = os.freemem();
    if (free < o.ramFloorBytes) return `free RAM ${free} is below the floor ${o.ramFloorBytes}`;
    return null;
  };
  const ledgerFile = path.join(stateRoot, 'ledger.jsonl');
  let ledger;
  try {
    ledger = await startProviderLedger({ upstream: o.upstream, model: o.model, numCtx: profile.numCtx, numPredict: profile.numPredict, ledgerFile, hold: o.hold, idleTimeoutMs: o.idleTimeoutMs, beforeDispatch });
  } catch (e) { receipt.problems.push(e.message); return 'ledger-failed'; }
  receipt.ledgerUrl = ledger.url;
  receipt.upstream = ledger.upstream;
  try {
    receipt.preflight = await ledger.preflight();
    if (!receipt.preflight.ok) { receipt.problems.push(...receipt.preflight.problems); return 'preflight-failed'; }
    const config = opencodeConfig({ model: o.model, profile, baseURL: ledger.baseURL, agent: o.agent, system: o.system, steps: o.steps, shell: o.shell, subagent: o.subagent });
    receipt.configSha256 = sha256(JSON.stringify(config));
    fs.writeFileSync(path.join(stateRoot, 'opencode-config.json'), JSON.stringify(config, null, 2) + '\n');
    const env = isolatedEnv({ stateRoot, taskDir: receipt.taskDir, config, proxyUrl: ledger.url });
    receipt.envKeys = Object.keys(env).sort();
    const cmd = o.command || buildCommand({ bun: o.bun, sourceRoot: o.sourceRoot, model: o.model, agent: o.agent, thinking: o.thinking });
    receipt.command = { file: cmd.file, args: cmd.args, cwd: cmd.cwd };
    const before = globalProfileSignature();
    const onCancel = (why) => { ledger.setHold(`run cancelled: ${why}`); ledger.abortInflight(`run cancelled: ${why}`); };
    const run = await spawnCollect(cmd, env, o.prompt, { timeoutMs: o.timeoutMs, ramFloorBytes: o.ramFloorBytes, onCancel });
    receipt.globalProfileUnchanged = JSON.stringify(before) === JSON.stringify(globalProfileSignature());
    receipt.exit = { code: run.code, signal: run.signal, timedOut: run.timedOut, ramGuard: run.ramGuard, spawnError: run.spawnError, durationMs: run.durationMs, minFreeRam: run.minFreeRam, pid: run.pid, spawnedAt: run.spawnedAt, stdoutTruncated: run.stdoutTruncated, cancel: run.cancel };
    receipt.descendants = surveyDescendants(run.pid, run.spawnedAt, { ramFloorBytes: o.ramFloorBytes });
    fs.writeFileSync(path.join(stateRoot, 'stdout.jsonl'), run.stdout);
    fs.writeFileSync(path.join(stateRoot, 'stderr.txt'), run.stderr);
    receipt.stdoutSha256 = sha256(run.stdout);
    receipt.cli = parseRunEvents(run.stdout);
    receipt.stderrTail = run.stderr.slice(-2000);
  } finally {
    await ledger.close();
  }
  // The ledger file is the record of the run: dispatch intents without an
  // answer and malformed lines count there, where memory could miss them.
  const memory = ledger.summary();
  if (ledger.writeErrors?.length) receipt.problems.push(`${ledger.writeErrors.length} ledger record(s) could not be written to the ledger file: ${ledger.writeErrors[0].error}`);
  let fromFile = null, records = null;
  try { records = readLedgerFile(ledgerFile); fromFile = summarize(records); } catch (e) { receipt.problems.push(`the ledger file could not be read back: ${e.message}`); }
  receipt.ledger = fromFile || { ...memory, complete: false, lowerBound: true, input: null, output: null, total: null };
  receipt.ledgerFileMatchesMemory = Boolean(fromFile) && fromFile.calls === memory.calls && fromFile.countedTotal === memory.countedTotal && fromFile.unknown === memory.unknown;
  receipt.reconciliation = reconcile(receipt.cli, receipt.ledger, fromFile ? records : null);
  receipt.verdicts = verdictsOf(receipt);
  return finalStatus(receipt, o.hold);
}
