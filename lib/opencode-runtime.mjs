// OpenCode v2 as the local-model runtime, launched from the pinned source.
//
// One run is one `opencode run --format json --standalone` process against a
// private state root: its own XDG roots, home, temp and config, no project or
// global config, no model catalogue fetch, no cloud provider, and an Ollama
// provider that is the loopback ledger of lib/opencode-provider-ledger.mjs.
// The ledger, not the CLI's JSON, is the token record: the CLI reports only
// the selected session's steps, while the ledger sees every provider call.
// Guards before anything starts: the window must be a measured 8k or 16k
// profile, the GPU lock of another owner must be free, free RAM must be above
// the floor; during the run a RAM sampler and a wall-clock limit end the whole
// process tree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startProviderLedger, sha256, DEFAULT_UPSTREAM } from './opencode-provider-ledger.mjs';
import { endTree } from './proc.mjs';

export const RUN_SCHEMA = 'atlias.opencode.run/1';
export const OPENCODE_PIN = Object.freeze({ repository: 'https://github.com/anomalyco/opencode', commit: 'd2905b8ddae8b0353cd2166d68d59795397921db', version: '2.0.26', packageManager: 'bun@1.4.2' });
const ROOT = process.env.ATLIAS_OPENCODE_ROOT || 'D:/harness-work/atlias-opencode-1009';
export const DEFAULTS = Object.freeze({
  sourceRoot: process.env.ATLIAS_OPENCODE_SOURCE || path.join(ROOT, 'upstream'),
  bun: process.env.ATLIAS_OPENCODE_BUN || path.join(ROOT, 'runtime', 'bun-windows-x64', process.platform === 'win32' ? 'bun.exe' : 'bun'),
  upstream: DEFAULT_UPSTREAM,
  gpuLocks: ['D:/harness-work/atlias-evolve/EVOLVE-GPU.lock'],
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
  const git = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (git.status === 0 && /^[0-9a-f]{40}$/.test(git.stdout.trim())) { r.commit = git.stdout.trim(); r.commitFrom = 'git'; }
  else {
    try { const pin = JSON.parse(fs.readFileSync(path.join(root, 'PIN.json'), 'utf8')); r.commit = pin.commit || null; r.commitFrom = 'PIN.json'; } catch { /* no pin file */ }
  }
  if (r.commit !== OPENCODE_PIN.commit) r.problems.push(`source commit ${r.commit || 'unknown'}, pinned ${OPENCODE_PIN.commit}`);
  r.depsReady = ['node_modules/@opentui/solid/package.json', 'packages/cli/node_modules/@opentui/solid/package.json'].some((p) => fs.existsSync(path.join(root, p))) && fs.existsSync(path.join(root, 'node_modules', 'effect'));
  if (!r.depsReady) r.problems.push('dependencies are not installed (no node_modules/@opentui/solid or node_modules/effect)');
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

// The CLI's JSON lines: one object per line with type, timestamp, sessionID
// (cli/src/run/noninteractive.ts:93). step_finish carries the selected
// session's step tokens {input, output, reasoning, cache:{read, write}}.
export function parseRunEvents(stdout) {
  const r = { events: 0, unparsed: [], types: {}, sessions: {}, errors: [], text: '' };
  const n = (v) => (Number.isFinite(v) ? v : 0);
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { r.unparsed.push(line.slice(0, 300)); continue; }
    r.events++;
    r.types[e.type] = (r.types[e.type] || 0) + 1;
    if (e.type === 'step_finish' && e.part && e.part.tokens) {
      const t = e.part.tokens;
      const s = r.sessions[e.sessionID] || (r.sessions[e.sessionID] = { steps: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
      s.steps++; s.input += n(t.input); s.output += n(t.output); s.reasoning += n(t.reasoning);
      s.cacheRead += n(t.cache && t.cache.read); s.cacheWrite += n(t.cache && t.cache.write);
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
export function reconcile(cli, ledger) {
  const sessions = {};
  let cliTotal = 0;
  for (const [id, s] of Object.entries(cli.sessions || {})) {
    const input = s.input + s.cacheRead + s.cacheWrite;
    const output = s.output + s.reasoning;
    cliTotal += input + output;
    const l = (ledger.sessions || {})[id] || null;
    sessions[id] = { cli: { input, output, steps: s.steps }, ledger: l ? { input: l.input, output: l.output, calls: l.calls, unknown: l.unknown } : null, match: Boolean(l) && l.unknown === 0 && l.input === input && l.output === output };
  }
  const ledgerOnly = Object.keys(ledger.sessions || {}).filter((id) => !(id in sessions));
  return { sessions, ledgerOnly, cliTotal, ledgerTotal: ledger.total, ledgerComplete: ledger.complete, unreportedByCli: ledger.complete ? ledger.total - cliTotal : null };
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

function spawnCollect(cmd, env, input, { timeoutMs, ramFloorBytes, sampleMs = 1000 }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const r = { code: null, signal: null, timedOut: false, ramGuard: false, spawnError: null, stdout: '', stderr: '', minFreeRam: os.freemem(), durationMs: 0, pid: null };
    let child;
    try { child = spawn(cmd.file, cmd.args, { cwd: cmd.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { r.spawnError = e.message; resolve(r); return; }
    r.pid = child.pid;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { if (r.stdout.length < 64 * 1024 * 1024) r.stdout += c; });
    child.stderr.on('data', (c) => { r.stderr = (r.stderr + c).slice(-1024 * 1024); });
    child.stdin.on('error', () => {});
    child.stdin.end(input, 'utf8');
    const stop = () => endTree(child.pid);
    const timer = setTimeout(() => { r.timedOut = true; stop(); }, timeoutMs);
    const sampler = setInterval(() => {
      const free = os.freemem();
      r.minFreeRam = Math.min(r.minFreeRam, free);
      if (free < ramFloorBytes && !r.ramGuard) { r.ramGuard = true; stop(); }
    }, sampleMs);
    child.on('error', (e) => { r.spawnError = e.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearInterval(sampler);
      r.code = code; r.signal = signal; r.durationMs = Date.now() - t0;
      resolve(r);
    });
  });
}

// One run. Returns the receipt and writes it to <stateRoot>/receipt.json.
// opts.hold starts everything but refuses every inference call (a boot check
// while another owner holds the GPU). opts.command replaces the bun command
// (a test seam); the receipt then says the runtime was not the pinned CLI.
export async function runOpenCode(opts = {}) {
  const o = { ...DEFAULTS, numCtx: 8192, timeoutMs: 30 * 60 * 1000, ...opts };
  const stateRoot = path.resolve(o.stateRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-opencode-')));
  fs.mkdirSync(stateRoot, { recursive: true });
  const receipt = { schema: RUN_SCHEMA, startedAt: new Date().toISOString(), pin: OPENCODE_PIN, runtime: o.command ? 'custom-command' : 'opencode-pinned-source', model: o.model, numCtx: o.numCtx, stateRoot, taskDir: o.taskDir ? path.resolve(o.taskDir) : null, hold: o.hold || null, status: null, problems: [] };
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
    if (!receipt.gpu.clean) { receipt.problems.push('another owner holds the GPU lock; run with hold for a boot check'); return finish('gpu-busy'); }
  }
  receipt.freeRamAtStart = os.freemem();
  if (receipt.freeRamAtStart < o.ramFloorBytes) { receipt.problems.push(`free RAM ${receipt.freeRamAtStart} is below the floor ${o.ramFloorBytes}`); return finish('ram-floor'); }
  if (!o.command) {
    receipt.source = verifySource(o.sourceRoot, o.bun);
    if (!receipt.source.ok) { receipt.problems.push(...receipt.source.problems); return finish('source-not-ready'); }
  }
  let ledger;
  try {
    ledger = await startProviderLedger({ upstream: o.upstream, model: o.model, numCtx: profile.numCtx, numPredict: profile.numPredict, ledgerFile: path.join(stateRoot, 'ledger.jsonl'), hold: o.hold, idleTimeoutMs: o.idleTimeoutMs });
  } catch (e) { receipt.problems.push(e.message); return finish('ledger-failed'); }
  receipt.ledgerUrl = ledger.url;
  receipt.upstream = ledger.upstream;
  try {
    receipt.preflight = await ledger.preflight();
    if (!receipt.preflight.ok) { receipt.problems.push(...receipt.preflight.problems); return finish('preflight-failed'); }
    const config = opencodeConfig({ model: o.model, profile, baseURL: ledger.baseURL, agent: o.agent, system: o.system, steps: o.steps, shell: o.shell, subagent: o.subagent });
    receipt.configSha256 = sha256(JSON.stringify(config));
    fs.writeFileSync(path.join(stateRoot, 'opencode-config.json'), JSON.stringify(config, null, 2) + '\n');
    const env = isolatedEnv({ stateRoot, taskDir: receipt.taskDir, config, proxyUrl: ledger.url });
    receipt.envKeys = Object.keys(env).sort();
    const cmd = o.command || buildCommand({ bun: o.bun, sourceRoot: o.sourceRoot, model: o.model, agent: o.agent, thinking: o.thinking });
    receipt.command = { file: cmd.file, args: cmd.args, cwd: cmd.cwd };
    const before = globalProfileSignature();
    const run = await spawnCollect(cmd, env, o.prompt, { timeoutMs: o.timeoutMs, ramFloorBytes: o.ramFloorBytes });
    receipt.globalProfileUnchanged = JSON.stringify(before) === JSON.stringify(globalProfileSignature());
    receipt.exit = { code: run.code, signal: run.signal, timedOut: run.timedOut, ramGuard: run.ramGuard, spawnError: run.spawnError, durationMs: run.durationMs, minFreeRam: run.minFreeRam, pid: run.pid };
    fs.writeFileSync(path.join(stateRoot, 'stdout.jsonl'), run.stdout);
    fs.writeFileSync(path.join(stateRoot, 'stderr.txt'), run.stderr);
    receipt.stdoutSha256 = sha256(run.stdout);
    receipt.cli = parseRunEvents(run.stdout);
    receipt.stderrTail = run.stderr.slice(-2000);
  } finally {
    await ledger.close();
  }
  receipt.ledger = ledger.summary();
  receipt.reconciliation = reconcile(receipt.cli, receipt.ledger);
  const e = receipt.exit;
  return finish(e.spawnError ? 'spawn-failed' : e.timedOut ? 'timed-out' : e.ramGuard ? 'ram-guard' : e.code === 0 && !receipt.cli.errors.length ? 'completed' : 'failed');
}
