// The OpenCode v2 runtime and its recording provider, checked without a model.
// A fake Ollama speaks the native API the ledger calls; a fake CLI stands in
// for `opencode run` where a test is about the orchestration around it. No
// check here loads a model or touches the GPU.
//
// Loaded by test/run.mjs, which owns asyncSuite() and check(); also runnable
// alone: node test/opencode-runtime-suites.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startProviderLedger, toNativeRequest, summarize, overflowOf, loopbackHttpUrl, readLedgerFile } from '../lib/opencode-provider-ledger.mjs';
import { runOpenCode, opencodeConfig, isolatedEnv, buildCommand, contextProfile, gpuOwnership, parseRunEvents, reconcile, verifySource, acquireGpuLease, leaseHeld, releaseGpuLease, OPENCODE_PIN, DEFAULTS } from '../lib/opencode-runtime.mjs';

const MODEL = 'qwen2.5-coder:7b';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function fakeOllama(chatScript) {
  const seen = { chat: [], show: [], tags: 0 };
  const json = (res, s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    const details = { format: 'gguf', family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' };
    if (req.url === '/api/version') return json(res, 200, { version: 'fake' });
    if (req.url === '/api/tags') { seen.tags++; return json(res, 200, { models: [{ name: MODEL, model: MODEL, digest: 'dae161e2', size: 1, modified_at: 'x', details }, { name: 'other:1b', model: 'other:1b', digest: 'ffff', size: 1, modified_at: 'x', details }] }); }
    if (req.url === '/api/show') { seen.show.push(body); return json(res, 200, { capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768 }, details }); }
    if (req.url === '/api/chat') { seen.chat.push(body); return chatScript(body, res, seen.chat.length); }
    json(res, 404, { error: 'no route' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) })));
}
const ndjson = (res, lines, end = true) => { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); for (const l of lines) res.write(JSON.stringify(l) + '\n'); if (end) res.end(); };
const FINAL = { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 812, prompt_eval_cached_count: 100, eval_count: 64, total_duration: 5, load_duration: 1, prompt_eval_duration: 2, eval_duration: 2 };
const standard = (body, res) => ndjson(res, [
  { message: { role: 'assistant', content: '', thinking: 'plan it' }, done: false },
  { message: { role: 'assistant', content: 'Hel' }, done: false },
  { message: { role: 'assistant', content: 'lo' }, done: false },
  { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write', arguments: { path: 'a.txt', content: 'x' } } }] }, done: false },
  FINAL,
]);
const opencodeBody = (extra = {}) => ({
  model: MODEL,
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'You are OpenCode.' }, { type: 'text', text: 'Env: win32' }] },
    { role: 'user', content: 'make a.txt' },
    { role: 'assistant', content: null, reasoning_content: 'look first', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'read', arguments: '{"path":"b.txt"}' } }] },
    { role: 'tool', tool_call_id: 'call_9', content: 'B' },
  ],
  tools: [{ type: 'function', function: { name: 'write', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
  stream: true, stream_options: { include_usage: true }, store: false, max_completion_tokens: 32000,
  ...extra,
});
async function post(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text();
  const events = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).map((s) => (s === '[DONE]' ? s : JSON.parse(s)));
  return { status: r.status, text, events, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
// Raw requests a proxy client would make; CONNECT answers through 'connect'.
const rawRequest = (port, opts) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ status: -1, text: 'no answer' }), 5000);
  const done = (v) => { clearTimeout(timer); resolve(v); };
  const r = http.request({ host: '127.0.0.1', port, ...opts }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => done({ status: res.statusCode, text: t })); });
  r.on('connect', (res, sock) => { sock.destroy(); done({ status: res.statusCode, text: '' }); });
  r.on('error', (e) => done({ status: 0, text: e.message }));
  r.end();
});

export default async function opencodeRuntimeSuites({ asyncSuite, check, TMP }) {
  const W = fs.mkdtempSync(path.join(TMP || os.tmpdir(), 'opencode-rt-'));
  const c = (test, cond, happened, why) => check(test, cond, { happened: String(happened), why, fix: 'See lib/opencode-provider-ledger.mjs and lib/opencode-runtime.mjs; docs/OPENCODE-RUNTIME-RECEIPTS.md lists what each check guards.' });

  await asyncSuite('local runtime expert', 'opencode ledger: discovery, translation and the ledger line (functional)', async () => {
    const up = await fakeOllama(standard);
    const ledgerFile = path.join(W, 'f1', 'ledger.jsonl');
    const L = await startProviderLedger({ upstream: up.url, model: MODEL, numCtx: 8192, numPredict: 2048, ledgerFile });
    try {
      const tags = await (await fetch(`${L.url}/api/tags`)).json();
      c('discovery serves only the run\'s model', tags.models.length === 1 && tags.models[0].model === MODEL, JSON.stringify(tags.models.map((m) => m.model)), 'OpenCode would otherwise list, show and maybe pick every installed model.');
      const show = await (await fetch(`${L.url}/api/show`, { method: 'POST', body: JSON.stringify({ model: MODEL }) })).json();
      c('the shown context length is the enforced window', show.model_info['qwen2.context_length'] === 8192, show.model_info['qwen2.context_length'], 'OpenCode budgets compaction against this number (local.ts:75); the trained 32768 would let it overfill an 8192 window.');
      const other = await fetch(`${L.url}/api/show`, { method: 'POST', body: JSON.stringify({ model: 'other:1b' }) });
      c('another model is not shown', other.status === 404, other.status, 'Only the run\'s model may be discovered.');
      const r = await post(`${L.url}/v1/chat/completions`, opencodeBody(), { 'x-opencode-session-id': 'ses_main', 'x-session-affinity': 'ses_main' });
      const deltas = r.events.filter((e) => e !== '[DONE]' && e.choices && e.choices[0]).map((e) => e.choices[0].delta);
      const text = deltas.map((d) => d.content || '').join('');
      const tc = deltas.flatMap((d) => d.tool_calls || []);
      const fin = r.events.find((e) => e !== '[DONE]' && e.choices && e.choices[0] && e.choices[0].finish_reason);
      const usage = r.events.find((e) => e !== '[DONE]' && e.usage);
      c('the stream is OpenAI chat chunks', r.status === 200 && deltas[0].role === 'assistant' && r.events.at(-1) === '[DONE]', `${r.status} ${JSON.stringify(deltas[0])}`, 'OpenCode parses this framing (openai-chat.ts:203-291).');
      c('text and reasoning arrive', text === 'Hello' && deltas.some((d) => d.reasoning_content === 'plan it'), JSON.stringify(deltas), 'Content and thinking must reach OpenCode unchanged.');
      c('a native tool call becomes an OpenAI tool call with string arguments', tc.length === 1 && tc[0].function.name === 'write' && JSON.parse(tc[0].function.arguments).path === 'a.txt' && tc[0].id && tc[0].index === 0, JSON.stringify(tc), 'OpenCode accumulates arguments as a JSON string per index.');
      c('the finish reason is tool_calls', fin && fin.choices[0].finish_reason === 'tool_calls', JSON.stringify(fin), 'OpenCode runs the tool only on tool-calls.');
      c('usage carries the native counters', usage && usage.usage.prompt_tokens === 812 && usage.usage.completion_tokens === 64 && usage.usage.prompt_tokens_details.cached_tokens === 100, JSON.stringify(usage), 'OpenCode\'s own step tokens then equal the ledger\'s.');
      const n = up.seen.chat[0];
      c('the native call sets the window and refuses to truncate', n.options.num_ctx === 8192 && n.truncate === false && n.shift === false, JSON.stringify({ o: n.options, t: n.truncate, s: n.shift }), 'Without num_ctx Ollama runs 4096 and cuts the prompt front silently (lib/loop.mjs:1948).');
      c('the output cap is the profile\'s, not OpenCode\'s 32000', n.options.num_predict === 2048, n.options.num_predict, 'An 8192 window cannot hold a 32000-token answer.');
      c('history tool calls are objects and tool results carry the tool name', n.messages[2].tool_calls[0].function.arguments.path === 'b.txt' && n.messages[2].thinking === 'look first' && n.messages[3].tool_name === 'read', JSON.stringify(n.messages.slice(2)), 'Native /api/chat wants argument objects and names the tool a result came from.');
      c('system parts are joined the way OpenCode joins them', n.messages[0].content === 'You are OpenCode.\nEnv: win32', JSON.stringify(n.messages[0].content), 'shared.ts:138 joins with one newline.');
      c('tools pass through', n.tools.length === 1 && n.tools[0].function.name === 'write', JSON.stringify(n.tools), 'Capability equivalence: the model sees the same tools.');
      const rec = L.records.find((x) => x.kind === 'chat');
      c('the ledger line has the counters, the session and the request digest', rec.status === 'ok' && rec.tokens.input === 812 && rec.tokens.output === 64 && rec.tokens.total === 876 && rec.session.id === 'ses_main' && /^[0-9a-f]{64}$/.test(rec.request.sha256) && rec.request.toolNames[0] === 'write', JSON.stringify({ s: rec.status, t: rec.tokens, sess: rec.session.id }), 'This line is the token record of the run.');
      c('fields OpenCode sent but Ollama does not take are listed', ['stream_options', 'store'].every((k) => rec.request.notCarried.includes(k)), JSON.stringify(rec.request.notCarried), 'Nothing is dropped unseen.');
      const r2 = await post(`${L.url}/v1/chat/completions`, opencodeBody(), { 'x-opencode-session-id': 'ses_child', 'x-opencode-parent-session-id': 'ses_main' });
      const s = L.summary();
      c('a child session is its own line and a repeat is flagged', r2.status === 200 && s.sessions.ses_child.parentId === 'ses_main' && s.repeats === 1 && s.calls === 2 && s.total === 1752 && s.peakPrompt === 812 && s.peakWindow === 876 && s.complete, JSON.stringify(s), 'Child and retried calls are exactly what the CLI JSON leaves out.');
      const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const intents = lines.filter((l) => l.kind === 'dispatch-intent');
      c('every record is on disk as JSONL, with one dispatch intent per sent call', lines.length - intents.length === L.records.length && intents.length === L.records.filter((r) => r.dispatched).length && lines.every((l) => l.schema === 'atlias.opencode.provider-ledger/1'), `${lines.length} lines, ${intents.length} intents, ${L.records.length} records`, 'A crash must not lose the calls already made.');
      const ns = await post(`${L.url}/v1/chat/completions`, opencodeBody({ stream: false }));
      c('a non-streaming client gets one chat.completion', ns.status === 200 && ns.json.choices[0].message.content === 'Hello' && ns.json.usage.total_tokens === 876, ns.text.slice(0, 200), 'Some callers do not stream.');
    } finally { await L.close(); await up.close(); }
  });

  await asyncSuite('local runtime expert', 'opencode runtime: profile, config, isolation and CLI events (functional)', async () => {
    const p8 = contextProfile(MODEL, 8192);
    const p16 = contextProfile(MODEL, 16384);
    c('8k and 16k profiles budget output and compaction', p8.numPredict === 2048 && p8.compaction.buffer === 2560 && p16.numPredict === 4096 && p16.compaction.buffer === 4608 && p16.measured, JSON.stringify([p8, p16].map((p) => [p.numPredict, p.compaction])), 'The buffer must hold the answer plus estimate error.');
    const cfg = opencodeConfig({ model: MODEL, profile: p8, baseURL: 'http://127.0.0.1:5/v1' });
    c('the config names only the local ollama provider at the ledger', Object.keys(cfg.providers).join() === 'ollama' && cfg.providers.ollama.settings.baseURL === 'http://127.0.0.1:5/v1' && !('apiKey' in cfg.providers.ollama.settings), JSON.stringify(cfg.providers), 'No cloud provider, no credential.');
    c('updates, sharing, warming, LSP, formatters and web search are off', cfg.update === 'disable' && cfg.share === 'disabled' && cfg.warming === false && cfg.lsp === false && cfg.formatter === false && cfg.websearch === false && cfg.snapshots === false, JSON.stringify(cfg), 'Each of these makes requests or changes files outside the task.');
    const rules = cfg.agents.atlias.permissions;
    c('permissions deny first, allow file tools, deny shell and outside directories', rules[0].effect === 'deny' && rules[0].action === '*' && rules.find((r) => r.action === 'shell').effect === 'deny' && rules.at(-1).action === 'external_directory' && rules.at(-1).effect === 'deny', JSON.stringify(rules), 'Last match wins; an unlisted action must not become an ask that headless runs reject.');
    c('no system prompt replaces OpenCode\'s own unless asked', !('system' in cfg.agents.atlias), JSON.stringify(cfg.agents.atlias), 'An agent system replaces the native prompt and with it the native instructions.');
    const stateRoot = path.join(W, 'env');
    const env = isolatedEnv({ stateRoot, taskDir: W, config: cfg, proxyUrl: 'http://127.0.0.1:7', base: { Path: 'C:/Windows', SystemRoot: 'C:/Windows', OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'a', GITHUB_TOKEN: 'g', OPENCODE_CONFIG: 'C:/other.json', OPENCODE_CONFIG_DIR: 'C:/o', USERPROFILE: 'C:/Users/real' } });
    const under = (v) => path.resolve(v).startsWith(path.resolve(stateRoot));
    c('home, XDG roots and temp are under the state root', ['HOME', 'USERPROFILE', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'TMP', 'TEMP', 'APPDATA', 'LOCALAPPDATA', 'OPENCODE_TEST_HOME'].every((k) => under(env[k])), JSON.stringify(env), 'Nothing the run writes may land in the real profile.');
    c('no key, token or outside OpenCode setting survives', !['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR'].some((k) => k in env) && env.Path === 'C:/Windows', JSON.stringify(Object.keys(env)), 'A cloud credential in a local run is the one thing that must never happen.');
    c('project config and the model catalogue fetch are off; config comes inline', env.OPENCODE_CONFIG_PROJECT_DISABLE === '1' && env.OPENCODE_DISABLE_MODELS_FETCH === '1' && JSON.parse(env.OPENCODE_CONFIG_CONTENT).default_agent === 'atlias' && env.PWD === W && env.HTTPS_PROXY === 'http://127.0.0.1:7', JSON.stringify({ p: env.OPENCODE_CONFIG_PROJECT_DISABLE, m: env.OPENCODE_DISABLE_MODELS_FETCH }), 'server-process.ts:106-117 reads exactly these.');
    const cmd = buildCommand({ bun: 'B', sourceRoot: 'S', model: MODEL });
    c('the command runs the pinned CLI source from packages/cli', cmd.file === 'B' && cmd.cwd === path.join('S', 'packages', 'cli') && cmd.args.join(' ') === `run ${path.join('S', 'packages', 'cli', 'src', 'index.ts')} run --format json --model ollama/${MODEL} --agent atlias --standalone`, JSON.stringify(cmd), 'bunfig preload applies only from packages/cli.');
    const ev = parseRunEvents(['{"type":"step_start","sessionID":"s1"}', '{"type":"text","sessionID":"s1","part":{"text":"ok"}}', '{"type":"step_finish","sessionID":"s1","part":{"tokens":{"input":700,"output":60,"reasoning":4,"cache":{"read":100,"write":0}}}}', 'not json'].join('\n'));
    c('CLI JSON lines are counted per session', ev.events === 3 && ev.sessions.s1.input === 700 && ev.sessions.s1.cacheRead === 100 && ev.text === 'ok' && ev.unparsed.length === 1, JSON.stringify(ev), 'The CLI side of the reconciliation.');
    const rc = reconcile(ev, summarize([{ kind: 'chat', status: 'ok', countersExpected: true, session: { id: 's1' }, tokens: { input: 800, output: 64, cachedInput: 100 } }, { kind: 'chat', status: 'ok', countersExpected: true, session: { id: 'title' }, tokens: { input: 50, output: 5 } }]));
    c('reconciliation matches the main session and surfaces ledger-only calls', rc.sessions.s1.match && rc.ledgerOnly.join() === 'title' && rc.unreportedByCli === 55, JSON.stringify(rc), 'The difference is what the CLI never reported.');
    // The shape of the first real run (2026-10-10): three printed steps, a title call and a last step whose finish the CLI never printed, all on one session.
    const realLike = parseRunEvents([
      '{"type":"step_start","sessionID":"r"}', '{"type":"step_finish","sessionID":"r","part":{"tokens":{"input":2440,"output":65,"reasoning":0,"cache":{"read":0,"write":0}}}}',
      '{"type":"step_start","sessionID":"r"}', '{"type":"step_finish","sessionID":"r","part":{"tokens":{"input":39,"output":116,"reasoning":0,"cache":{"read":2504,"write":0}}}}',
      '{"type":"step_start","sessionID":"r"}', '{"type":"step_finish","sessionID":"r","part":{"tokens":{"input":23,"output":61,"reasoning":0,"cache":{"read":2658,"write":0}}}}',
      '{"type":"step_start","sessionID":"r"}'].join('\n'));
    const realRecs = [[3, 558, 927, 0], [4, 2440, 65, 0], [6, 2543, 116, 2504], [7, 2681, 61, 2658], [8, 2780, 63, 2741]].map(([seq, input, output, cachedInput]) => ({ kind: 'chat', seq, status: 'ok', countersExpected: true, dispatched: true, session: { id: 'r' }, tokens: { input, output, cachedInput } }));
    const rr = reconcile(realLike, summarize(realRecs), realRecs).sessions.r;
    c('call-level reconciliation: every printed step is a real call; the title and the unprinted last step are named, not hidden', rr.match === true && rr.stepsMatched === 3 && rr.cli.started === 4 && rr.totalsEqual === false && rr.auxiliary.map((a) => `${a.seq}:${a.kind}`).join('|') === '3:not a printed step (title or summary)|8:step the CLI did not print', JSON.stringify(rr), 'OpenCode pays for calls it never prints as steps; the ledger total stays the cost.');
    if (fs.existsSync(DEFAULTS.sourceRoot)) {
      const src = verifySource();
      c('the pinned upstream checkout is 2.0.26 at the pinned commit', src.version === OPENCODE_PIN.version && src.commit === OPENCODE_PIN.commit && src.ok === (src.problems.length === 0), JSON.stringify(src), 'The runtime must run the source it claims.');
    }
  });

  await asyncSuite('local runtime expert', 'opencode runtime: one orchestrated run with a stand-in CLI (functional)', async () => {
    const up = await fakeOllama(standard);
    const cli = path.join(W, 'fake-cli.mjs');
    fs.writeFileSync(cli, `
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const base = cfg.providers.ollama.settings.baseURL; const root = base.replace(/\\/v1$/, '');
let prompt = ''; for await (const c of process.stdin) prompt += c;
const model = cfg.model.slice('ollama/'.length);
await fetch(root + '/api/tags'); await fetch(root + '/api/show', { method: 'POST', body: JSON.stringify({ model }) });
const call = async (h) => { const t = await (await fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true }) })).text();
  return t.split('\\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6))).find((e) => e.usage).usage; };
const u = await call({ 'x-opencode-session-id': 'ses_main' });
await call({ 'x-opencode-session-id': 'ses_child', 'x-opencode-parent-session-id': 'ses_main' });
if (prompt.includes('egress')) { const p = new URL(process.env.HTTP_PROXY);
await new Promise((r) => { const q = http.request({ host: p.hostname, port: p.port, method: 'GET', path: 'http://example.com/' }, (res) => { res.resume(); res.on('end', r); }); q.on('error', r); q.end(); }); }
fs.writeFileSync(path.join(process.env.PWD, 'env-seen.json'), JSON.stringify({ keys: Object.keys(process.env), home: process.env.HOME, key: process.env.OPENAI_API_KEY ?? null }));
const cached = u.prompt_tokens_details ? u.prompt_tokens_details.cached_tokens : 0;
for (const e of [{ type: 'step_start', sessionID: 'ses_main', part: {} }, { type: 'text', sessionID: 'ses_main', part: { text: 'done' } }, { type: 'step_finish', sessionID: 'ses_main', part: { tokens: { input: u.prompt_tokens - cached, output: u.completion_tokens, reasoning: 0, cache: { read: cached, write: 0 } }, cost: 0 } }]) console.log(JSON.stringify({ timestamp: Date.now(), ...e }));
`);
    const task = fs.mkdtempSync(path.join(W, 'task-'));
    const stateRoot = path.join(W, 'run1');
    process.env.OPENAI_API_KEY = 'sk-should-not-pass';
    let rc;
    let rcE;
    const run = { taskDir: task, model: MODEL, numCtx: 8192, upstream: up.url, gpuLocks: [], leaseFile: path.join(W, 'run1.lease'), ramFloorBytes: 1, command: { file: process.execPath, args: [cli], cwd: W }, timeoutMs: 60000 };
    try {
      rc = await runOpenCode({ ...run, prompt: 'write a.txt', stateRoot });
      rcE = await runOpenCode({ ...run, prompt: 'write a.txt egress', stateRoot: path.join(W, 'run1e') });
    } finally { delete process.env.OPENAI_API_KEY; await up.close(); }
    const seenFile = path.join(task, 'env-seen.json');
    const seen = fs.existsSync(seenFile) ? JSON.parse(fs.readFileSync(seenFile, 'utf8')) : { keys: ['(missing)'], key: '(missing)', home: '' };
    c('the run completes and says it was not the pinned CLI', rc.status === 'completed' && rc.runtime === 'custom-command' && rc.exit.code === 0, JSON.stringify({ s: rc.status, e: rc.exit, p: rc.problems, err: rc.stderrTail }), 'A stand-in run must never read as an OpenCode run.');
    c('the parent\'s provider key never reaches the run', seen.key === null && !seen.keys.includes('OPENAI_API_KEY') && path.resolve(seen.home).startsWith(path.resolve(stateRoot)), JSON.stringify(seen).slice(0, 400), 'No cloud credential in a local run.');
    c('the ledger has both sessions, the CLI only the main one', rc.ledger && rc.ledger.calls === 2 && rc.ledger.total === 1752 && rc.reconciliation.sessions.ses_main && rc.reconciliation.sessions.ses_main.match && rc.reconciliation.ledgerOnly.join() === 'ses_child' && rc.reconciliation.unreportedByCli === 876, JSON.stringify(rc.reconciliation), 'The capture the CLI JSON cannot give.');
    c('a clean run has separate verdicts and leaves task success to the oracle', rc.ledger && rc.ledger.egressAttempts === 0 && rc.verdicts && rc.verdicts.accounting === 'complete and reconciled with the CLI' && /not judged here/.test(rc.verdicts.task) && rc.lease && rc.lease.ok && rc.lease.released === true && rc.ledgerFileMatchesMemory === true, JSON.stringify({ v: rc.verdicts, l: rc.lease, m: rc.ledgerFileMatchesMemory }), 'Process exit, accounting and task success are different questions.');
    c('an egress attempt through the proxy env is recorded, refused, and the run is not completed', rcE && rcE.ledger.egressAttempts === 1 && rcE.status === 'egress-attempted' && rcE.exit.code === 0, JSON.stringify({ s: rcE && rcE.status, e: rcE && rcE.ledger && rcE.ledger.egressAttempts }), 'Exit 0 with a network attempt is not a clean run.');
    c('preflight saw the model installed with a trained length above the window', rc.preflight && rc.preflight.ok && rc.preflight.trainedContext === 32768 && rc.preflight.digest === 'dae161e2', JSON.stringify(rc.preflight), 'The run checks the model before it starts.');
    c('the receipt, config, ledger and CLI output are on disk; the real profile is unchanged', ['receipt.json', 'opencode-config.json', 'ledger.jsonl', 'stdout.jsonl'].every((f) => fs.existsSync(path.join(stateRoot, f))) && rc.globalProfileUnchanged === true, JSON.stringify(fs.readdirSync(stateRoot)), 'Receipts are the evidence; the user\'s own opencode roots must not move.');
  });

  await asyncSuite('local runtime adversary', 'opencode ledger: refusals, failures and unknown counters (adversarial)', async () => {
    for (const bad of ['http://10.0.0.5:11435', 'https://api.openai.com', 'http://example.com:11434', 'ftp://127.0.0.1:1']) {
      let threw = false;
      try { const L = await startProviderLedger({ upstream: bad, model: MODEL, numCtx: 8192, numPredict: 2048 }); await L.close(); } catch { threw = true; }
      c(`a non-loopback provider is refused: ${bad}`, threw && !loopbackHttpUrl(bad), threw, 'A local run never calls a remote provider.');
    }
    let mode = 'overflow';
    let hangRes = null;
    const up = await fakeOllama((body, res) => {
      if (mode === 'overflow') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'request (9100 tokens) exceeds the available context size (8192 tokens)' })); return; }
      if (mode === 'hang') { hangRes = res; ndjson(res, [{ message: { role: 'assistant', content: 'par' }, done: false }], false); return; }
      if (mode === 'cut') { ndjson(res, [{ message: { role: 'assistant', content: 'par' }, done: false }]); return; }
      if (mode === 'nocount') { ndjson(res, [{ message: { role: 'assistant', content: 'x' }, done: true, done_reason: 'stop' }]); return; }
      standard(body, res);
    });
    const L = await startProviderLedger({ upstream: up.url, model: MODEL, numCtx: 8192, numPredict: 2048 });
    try {
      const o = await post(`${L.url}/v1/chat/completions`, opencodeBody());
      const orec = L.records.at(-1);
      c('an overflow comes back as context_length_exceeded with Ollama\'s words', o.status === 400 && o.json.error.code === 'context_length_exceeded' && /exceeds the available context size/.test(o.json.error.message), o.text, 'OpenCode compacts and retries only on a recognised overflow (provider-error.ts:36,251).');
      c('the overflow is a sent call of unknown cost; its rejected size is only a lower bound', orec.status === 'overflow' && orec.overflow.promptTokens === 9100 && orec.dispatched === true && orec.countersExpected === true && orec.tokens.input === null && L.summary().largestRejectedPrompt === 9100 && L.summary().unknownInputLowerBound === 9100 && L.summary().total === null, JSON.stringify({ r: orec.status, s: L.summary() }), 'What the server spent on a rejected call is unknown; zero would be fabrication.');
      mode = 'nocount';
      await post(`${L.url}/v1/chat/completions`, opencodeBody());
      const nrec = L.records.at(-1);
      c('a final chunk without counters leaves them null and the totals incomplete', nrec.status === 'ok' && nrec.tokens.input === null && L.summary().complete === false && L.summary().lowerBound === true, JSON.stringify({ t: nrec.tokens, s: L.summary().unknown }), 'Unknown counters stay unknown.');
      mode = 'cut';
      const cut = await post(`${L.url}/v1/chat/completions`, opencodeBody());
      c('a stream that ends without its final chunk is a truncated call', L.records.at(-1).status === 'truncated' && /error/.test(cut.text), L.records.at(-1).status, 'A half answer must not read as a finished one.');
      mode = 'hang';
      const ac = new AbortController();
      const pending = fetch(`${L.url}/v1/chat/completions`, { method: 'POST', body: JSON.stringify(opencodeBody()), signal: ac.signal }).then((r) => r.text()).catch(() => 'aborted');
      for (let i = 0; i < 100 && !hangRes; i++) await sleep(20);
      await sleep(100);
      ac.abort();
      await pending;
      for (let i = 0; i < 100 && L.records.at(-1).status !== 'aborted'; i++) await sleep(20);
      const arec = L.records.at(-1);
      c('a client that hangs up mid-answer leaves an aborted call with unknown counters', arec.status === 'aborted' && arec.countersExpected === true && arec.tokens.input === null, JSON.stringify({ s: arec.status, e: arec.countersExpected }), 'The tokens were spent even though nobody counted them.');
      if (hangRes) hangRes.destroy();
      mode = 'ok';
      const before = up.seen.chat.length;
      const wrong = await post(`${L.url}/v1/chat/completions`, opencodeBody({ model: 'other:1b' }));
      c('another model is refused before Ollama sees it', wrong.status === 404 && up.seen.chat.length === before && L.records.at(-1).status === 'model-not-served', wrong.text, 'A run must not silently switch models.');
      const notJson = await post(`${L.url}/v1/chat/completions`, '{nope');
      c('a body that is not JSON is a recorded bad request', notJson.status === 400 && L.records.at(-1).status === 'bad-request', notJson.text, 'Every call is on the ledger, failures included.');
      const remoteImg = opencodeBody();
      remoteImg.messages[1] = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] };
      const ri = await post(`${L.url}/v1/chat/completions`, remoteImg);
      c('a remote image URL is refused, never fetched', ri.status === 400 && up.seen.chat.length === before, ri.text, 'Fetching it would be network egress.');
      const badArgs = opencodeBody();
      badArgs.messages[2].tool_calls[0].function.arguments = '{broken';
      const ba = await post(`${L.url}/v1/chat/completions`, badArgs);
      c('broken history arguments are an explicit error, not a silent drop', ba.status === 400 && /not a JSON object/.test(ba.text), ba.text, 'Dropping the call would change what the model sees.');
      const big = await post(`${L.url}/v1/chat/completions`, 'x'.repeat(33 * 1024 * 1024)).catch(() => ({ status: 0 }));
      const bigRec = L.records.at(-1);
      c('an oversized body is refused and recorded', (big.status === 413 || big.status === 0) && bigRec.status === 'bad-request' && bigRec.httpStatus === 413 && up.seen.chat.length === before, `${big.status} ${bigRec.status} ${bigRec.httpStatus}`, 'Bounded memory in the proxy.');
      const conn = await rawRequest(L.port, { method: 'CONNECT', path: 'api.anthropic.com:443' });
      const abs = await rawRequest(L.port, { method: 'GET', path: 'http://example.com/' });
      c('CONNECT and proxy-form requests are refused and recorded as egress', conn.status === 403 && abs.status === 403 && L.summary().egressAttempts === 2, `${conn.status} ${abs.status} ${L.summary().egressAttempts}`, 'Cloud calls through HTTP(S)_PROXY must be visible and blocked.');
      L.setHold('GPU owned by evolve 41764');
      const held = await post(`${L.url}/v1/chat/completions`, opencodeBody());
      c('hold refuses inference without calling Ollama', held.status === 503 && up.seen.chat.length === before && L.records.at(-1).status === 'refused', held.text, 'A boot check must not load a model while another owner holds the GPU.');
      const unknown = await rawRequest(L.port, { method: 'GET', path: '/api/pull' });
      c('unknown routes, including pull, are refused', unknown.status === 404 && L.records.at(-1).kind === 'refused-route', unknown.text, 'No model download through the ledger.');
      c('overflow parsing reads both Ollama wordings', overflowOf('request (100 tokens) exceeds the available context size (64 tokens)').promptTokens === 100 && overflowOf('exceed_context_size_error n_prompt_tokens: 70 n_ctx: 64').ctx === 64 && overflowOf('fine') === null, 'parsed', 'lib/loop.mjs:1960 saw both forms.');
      let threw = 0;
      for (const p of [{ numCtx: 8192, numPredict: 8192 }, { numCtx: 512, numPredict: 100 }, { numCtx: 8192, numPredict: 0 }]) { try { await (await startProviderLedger({ upstream: up.url, model: MODEL, ...p })).close(); } catch { threw++; } }
      c('impossible windows are refused at start', threw === 3, threw, 'An output cap at or above the window leaves no room for a prompt.');
      c('toNativeRequest refuses an unknown role', (() => { try { toNativeRequest({ model: MODEL, messages: [{ role: 'developer', content: 'x' }] }, { model: MODEL, numCtx: 8192, numPredict: 2048 }); return false; } catch (e) { return e.status === 400; } })(), 'no throw', 'Unknown roles are not guessed.');
    } finally { await L.close(); await up.close(); }
  });

  await asyncSuite('local runtime adversary', 'opencode runtime: guards stop a run before it starts (adversarial)', async () => {
    const task = fs.mkdtempSync(path.join(W, 'guard-'));
    const base = { prompt: 'x', taskDir: task, model: MODEL, upstream: 'http://127.0.0.1:9', ramFloorBytes: 1, leaseFile: path.join(W, 'guard.lease'), command: { file: process.execPath, args: ['-e', ''], cwd: W } };
    const lock = path.join(W, 'GPU.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    const g = await runOpenCode({ ...base, stateRoot: path.join(W, 'g1'), gpuLocks: [lock] });
    c('a live GPU lock stops the run before the ledger starts', g.status === 'gpu-busy' && !g.ledgerUrl, JSON.stringify(g.problems), 'No duplicate inference while evolve owns the GPU.');
    fs.writeFileSync(lock, 'not json');
    c('an unreadable lock counts as held', gpuOwnership([lock]).clean === false, JSON.stringify(gpuOwnership([lock])), 'An owner that cannot be read is not proof of a free GPU.');
    fs.writeFileSync(lock, JSON.stringify({ pid: 2147483646 }));
    c('a lock of a dead process is stale, not held', gpuOwnership([lock]).clean === true, JSON.stringify(gpuOwnership([lock])), 'A crashed owner must not block forever.');
    const r = await runOpenCode({ ...base, stateRoot: path.join(W, 'g2'), gpuLocks: [], ramFloorBytes: Number.MAX_SAFE_INTEGER });
    c('the RAM floor stops the run before it starts', r.status === 'ram-floor', r.status, 'Gev\'s RAM guard.');
    const p = await runOpenCode({ ...base, stateRoot: path.join(W, 'g3'), gpuLocks: [], numCtx: 32768 });
    c('a window other than 8k or 16k is refused', p.status === 'bad-profile', p.status, 'Bounded contexts only.');
    const u = await runOpenCode({ ...base, stateRoot: path.join(W, 'g4'), gpuLocks: [], model: 'qwen2.5:7b', numCtx: 16384 });
    c('an unmeasured model and window pair is refused', u.status === 'bad-profile' && /no measured fit/.test(u.problems.join()), JSON.stringify(u.problems), 'VRAM fit is evidence, not an assumption.');
    const pf = await runOpenCode({ ...base, stateRoot: path.join(W, 'g5'), gpuLocks: [], hold: 'test' });
    c('an unreachable Ollama fails preflight; nothing is spawned', pf.status === 'preflight-failed' && !pf.exit, JSON.stringify(pf.problems), 'A run with no model server must not start a CLI that would wait on it.');
    const up = await fakeOllama(standard);
    const hang = path.join(W, 'hang.mjs');
    const pidFile = path.join(W, 'hang.pid');
    fs.writeFileSync(hang, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const t = await runOpenCode({ ...base, stateRoot: path.join(W, 'g6'), gpuLocks: [], upstream: up.url, command: { file: process.execPath, args: [hang], cwd: W }, timeoutMs: 1500 });
    await up.close();
    const hp = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
    for (let i = 0; i < 50 && hp && alive(hp); i++) await sleep(100);
    c('the wall-clock limit ends the whole tree and closes the ledger', t.status === 'timed-out' && hp > 0 && !alive(hp) && t.ledger && t.ledger.calls === 0, JSON.stringify({ s: t.status, hp, alive: hp && alive(hp) }), 'A hung run must not hold the GPU or a port.');
  });

  await asyncSuite('local runtime adversary', 'opencode ledger: sent calls without counters stay unknown; gate and durable intent (adversarial)', async () => {
    let mode = 'e500';
    const lf = path.join(W, 'corr-ledger.jsonl');
    let intentFirst = null;
    const up = await fakeOllama((body, res) => {
      // The intent line must already be on disk when the model server sees the call.
      intentFirst = fs.existsSync(lf) && readLedgerFile(lf).some((r) => r && r.kind === 'dispatch-intent');
      if (mode === 'e500') { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'runner crashed' })); return; }
      if (mode === 'garbage') { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.write(JSON.stringify({ message: { role: 'assistant', content: 'a' }, done: false }) + '\n'); res.end('<html>oops</html>\n'); return; }
      if (mode === 'negative') { ndjson(res, [{ ...FINAL, prompt_eval_count: -5 }]); return; }
      if (mode === 'fraction') { ndjson(res, [{ ...FINAL, eval_count: 12.5 }]); return; }
      standard(body, res);
    });
    let gateWhy = null;
    let gateThrows = false;
    const L = await startProviderLedger({ upstream: up.url, model: MODEL, numCtx: 8192, numPredict: 2048, ledgerFile: lf, beforeDispatch: () => { if (gateThrows) throw new Error('lock unreadable'); return gateWhy; } });
    try {
      const r500 = await post(`${L.url}/v1/chat/completions`, opencodeBody());
      const a = L.records.at(-1);
      c('an HTTP 500 after dispatch is unknown, not zero', r500.status === 500 && a.dispatched === true && a.tokens.input === null && L.summary().unknown === 1 && L.summary().total === null && L.summary().complete === false, JSON.stringify({ st: a.status, s: L.summary() }), 'A failed call may still have evaluated the prompt (routes.go:2956-2963 sends no counters).');
      c('the dispatch intent is on disk before the model server sees the call', intentFirst === true, intentFirst, 'Append before dispatch: a crash after sending cannot lose the call.');
      mode = 'garbage';
      const g = await post(`${L.url}/v1/chat/completions`, opencodeBody());
      c('a stream line that is not JSON fails the call as malformed-stream with unknown cost', L.records.at(-1).status === 'malformed-stream' && L.records.at(-1).tokens.input === null && /not a JSON object/.test(g.text), `${L.records.at(-1).status} ${g.text.slice(0, 200)}`, 'A broken stream must not read as a finished answer.');
      mode = 'negative';
      await post(`${L.url}/v1/chat/completions`, opencodeBody());
      const neg = L.records.at(-1);
      mode = 'fraction';
      await post(`${L.url}/v1/chat/completions`, opencodeBody());
      const fr = L.records.at(-1);
      c('negative and fractional counters are invalid and not counted', neg.tokens.input === null && neg.tokens.invalid.includes('prompt_eval_count') && fr.tokens.output === null && fr.tokens.invalid.includes('eval_count') && L.summary().invalidCounters === 2 && L.summary().unknown === 4, JSON.stringify({ n: neg.tokens, f: fr.tokens, s: L.summary() }), 'A counter that is not a whole number is not a count.');
      mode = 'ok';
      const before = up.seen.chat.length;
      gateWhy = 'the original GPU owner is live';
      const gated = await post(`${L.url}/v1/chat/completions`, opencodeBody());
      gateWhy = null; gateThrows = true;
      const thrown = await post(`${L.url}/v1/chat/completions`, opencodeBody());
      gateThrows = false;
      c('the dispatch gate refuses before anything is sent, also when it throws', gated.status === 503 && thrown.status === 503 && up.seen.chat.length === before && L.records.at(-1).dispatched === false && /gate failed/.test(L.records.at(-1).error) && L.summary().refusedBeforeDispatch === 2, JSON.stringify({ g: gated.status, t: thrown.status, s: L.summary().refusedBeforeDispatch }), 'The owner, lease and RAM are rechecked through every inference.');
      await post(`${L.url}/v1/chat/completions`, opencodeBody());
      const s = summarize(readLedgerFile(lf));
      c('the ledger file read back agrees with memory', s.calls === L.summary().calls && s.countedTotal === L.summary().countedTotal && s.countedTotal === 876 && s.unknown === L.summary().unknown && s.interrupted === 0 && s.malformed === 0, JSON.stringify({ file: s, mem: L.summary() }), 'The file is the durable record.');
    } finally { await L.close(); await up.close(); }
    const crashed = summarize([{ kind: 'dispatch-intent', runId: 'r1', seq: 1, session: { id: 's' } }, { kind: 'chat', runId: 'r1', seq: 2, dispatched: true, status: 'ok', session: { id: 's' }, tokens: { input: 10, output: 2 } }]);
    c('an intent without its answer line is an interrupted call of unknown cost', crashed.interrupted === 1 && crashed.unknown === 1 && crashed.counted === 1 && crashed.total === null && crashed.countedTotal === 12 && crashed.lowerBound, JSON.stringify(crashed), 'Crash recovery never turns a sent call into zero.');
    const mal = summarize([null, { kind: 'chat', dispatched: true, status: 'ok', tokens: { input: 1, output: 1 } }]);
    c('a malformed ledger line makes the totals incomplete', mal.malformed === 1 && mal.complete === false && mal.total === null && mal.countedTotal === 2, JSON.stringify(mal), 'A line that cannot be read may have been a call.');
    const legacy = summarize([{ kind: 'chat', status: 'upstream-error', countersExpected: false, tokens: {} }]);
    c('a record that does not say it was refused is treated as sent', legacy.unknown === 1 && legacy.total === null && legacy.refusedBeforeDispatch === 0, JSON.stringify(legacy), 'A missing field must not hide a cost.');
    const lie = summarize([{ kind: 'chat', dispatched: true, status: 'ok', tokens: { input: 5, output: -1 } }, { kind: 'chat', dispatched: true, status: 'ok', tokens: { input: '7', output: 1 } }, { kind: 'chat', dispatched: true, status: 'ok', tokens: { input: Infinity, output: 1 } }]);
    c('summarize rejects negative, string and infinite counters at its own boundary', lie.invalidCounters === 3 && lie.unknown === 3 && lie.counted === 0 && lie.total === null && lie.peakPrompt === null, JSON.stringify(lie), 'Records read back from disk are validated again.');
    const bad = parseRunEvents([JSON.stringify({ type: 'step_finish', sessionID: 's', part: { tokens: { input: -1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } }), JSON.stringify({ type: 'step_finish', sessionID: 's', part: {} }), '[1,2]'].join('\n'));
    const rcb = reconcile(bad, summarize([{ kind: 'chat', dispatched: true, status: 'ok', session: { id: 's' }, tokens: { input: 0, output: 0 } }]));
    c('CLI steps with bad or missing counters are invalid and cannot reconcile', bad.sessions.s.invalid === 2 && bad.unparsed.length === 1 && rcb.sessions.s.match === false && rcb.cliTotal === null && rcb.unreportedByCli === null, JSON.stringify({ b: bad.sessions, r: rcb }), 'Missing CLI metadata is never counted as zero.');
    // Call-level matching cannot be fooled: a printed step with no real call, two identical printed steps against one call, or a call from another session.
    const step = (input, output, read) => JSON.stringify({ type: 'step_finish', sessionID: 'x', part: { tokens: { input, output, reasoning: 0, cache: { read, write: 0 } } } });
    const rec = (seq, input, output, cachedInput, id = 'x') => ({ kind: 'chat', seq, status: 'ok', countersExpected: true, dispatched: true, session: { id }, tokens: { input, output, cachedInput } });
    const phantom = [rec(1, 500, 10, 0)];
    const twice = [rec(1, 500, 10, 0), rec(2, 900, 20, 0)];
    const other = [rec(1, 500, 10, 0, 'y'), rec(2, 900, 20, 0)];
    const p1 = reconcile(parseRunEvents([step(500, 10, 0), step(700, 30, 0)].join('\n')), summarize(phantom), phantom).sessions.x;
    const p2 = reconcile(parseRunEvents([step(500, 10, 0), step(500, 10, 0)].join('\n')), summarize(twice), twice).sessions.x;
    const p3 = reconcile(parseRunEvents([step(500, 10, 0)].join('\n')), summarize(other), other).sessions.x;
    c('a printed step with no real call, a step counted twice or a call from another session never reconciles', p1.match === false && p1.stepsMatched === 1 && p2.match === false && p2.stepsMatched === 1 && p3.match === false && p3.stepsMatched === 0, JSON.stringify({ p1, p2, p3 }), 'Each printed step must be one distinct call of its own session.');
  });

  await asyncSuite('local runtime adversary', 'opencode runtime: exclusive lease, PID-free cancellation and source identity (adversarial)', async () => {
    const lf = path.join(W, 'gpu.lease');
    const a = acquireGpuLease(lf, { runId: 'A' });
    const b = acquireGpuLease(lf, { runId: 'B' });
    c('the GPU lease is exclusive', a.ok && !b.ok && /live process/.test(b.problem) && leaseHeld(a) && !leaseHeld(b), JSON.stringify({ a: a.ok, b }), 'Two runs must never both own the GPU.');
    c('only the holder can release the lease', !releaseGpuLease({ ...a, runId: 'X' }) && releaseGpuLease(a) && !fs.existsSync(lf), fs.existsSync(lf), 'Another run cannot drop a lease it does not hold.');
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
    fs.writeFileSync(lf, JSON.stringify({ pid: deadPid, runId: 'old' }));
    const s2 = acquireGpuLease(lf, { runId: 'C' });
    c('a lease whose owner is gone is moved aside, not deleted, and taken', s2.ok && fs.readdirSync(W).some((f) => f.startsWith('gpu.lease.stale-')), JSON.stringify(s2), 'A crashed run must not block forever, and its lease stays readable.');
    releaseGpuLease(s2);
    fs.writeFileSync(lf, 'not json');
    const s3 = acquireGpuLease(lf, { runId: 'D' });
    c('a fresh unreadable lease is not taken', !s3.ok && /cannot be read/.test(s3.problem), JSON.stringify(s3), 'An owner that cannot be read is not proof of a free GPU.');
    fs.unlinkSync(lf);
    const task = fs.mkdtempSync(path.join(W, 'lease-task-'));
    let mode = 'ok';
    let hangRes = null;
    const up = await fakeOllama((body, res) => { if (mode === 'hang') { hangRes = res; ndjson(res, [{ message: { role: 'assistant', content: 'par' }, done: false }], false); return; } standard(body, res); });
    const base = { prompt: 'x', taskDir: task, model: MODEL, numCtx: 8192, upstream: up.url, ramFloorBytes: 1, leaseFile: lf };
    try {
      fs.writeFileSync(lf, JSON.stringify({ pid: process.pid, runId: 'someone-else' }));
      const busy = await runOpenCode({ ...base, stateRoot: path.join(W, 'lb'), gpuLocks: [], command: { file: process.execPath, args: ['-e', ''], cwd: W } });
      c('a run that cannot win the lease does not start', busy.status === 'gpu-lease-busy' && !busy.ledgerUrl && fs.existsSync(lf), JSON.stringify({ s: busy.status, p: busy.problems }), 'No second owner, and the other lease is left alone.');
      fs.unlinkSync(lf);
      // The original owner appears after the run started: the next call is refused before dispatch.
      const ownerLock = path.join(W, 'late-owner.lock');
      const late = path.join(W, 'late.mjs');
      fs.writeFileSync(late, `import fs from 'node:fs';
const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT); const base = cfg.providers.ollama.settings.baseURL;
fs.writeFileSync(${JSON.stringify(ownerLock)}, JSON.stringify({ pid: process.pid }));
const r = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-opencode-session-id': 'ses_main' }, body: JSON.stringify({ model: cfg.model.slice(7), messages: [{ role: 'user', content: 'x' }], stream: true }) });
await r.text();
console.log(JSON.stringify({ type: 'step_start', sessionID: 'ses_main', part: {} }));`);
      const before = up.seen.chat.length;
      const lr = await runOpenCode({ ...base, stateRoot: path.join(W, 'late'), gpuLocks: [ownerLock], command: { file: process.execPath, args: [late], cwd: W } });
      c('an original owner that appears mid-run blocks the next call before dispatch', lr.ledger && lr.ledger.refusedBeforeDispatch === 1 && lr.ledger.dispatched === 0 && up.seen.chat.length === before && lr.status === 'no-successful-inference' && lr.lease.released === true, JSON.stringify({ s: lr.status, l: lr.ledger && lr.ledger.byStatus, p: lr.problems }), 'Ownership is rechecked through every inference, not only at start.');
      // Cancellation: a hung CLI with a call in flight and a grandchild of its own.
      mode = 'hang';
      const pids = path.join(W, 'hang2.json');
      const hang = path.join(W, 'hang2.mjs');
      fs.writeFileSync(hang, `import fs from 'node:fs'; import { spawn } from 'node:child_process';
// detached: a non-detached Node child sits in libuv's kill-on-close job and
// ends with its parent, which would hide what the survey is for.
const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore', windowsHide: true, detached: true });
gc.unref();
fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ child: process.pid, grandchild: gc.pid }));
const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
fetch(cfg.providers.ollama.settings.baseURL + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-opencode-session-id': 'ses_main' }, body: JSON.stringify({ model: cfg.model.slice(7), messages: [{ role: 'user', content: 'x' }], stream: true }) }).then((r) => r.text()).catch(() => {});
setInterval(() => {}, 1000);`);
      const t = await runOpenCode({ ...base, stateRoot: path.join(W, 'cancel'), gpuLocks: [], command: { file: process.execPath, args: [hang], cwd: W }, timeoutMs: 2500 });
      const ids = fs.existsSync(pids) ? JSON.parse(fs.readFileSync(pids, 'utf8')) : {};
      for (let i = 0; i < 50 && ids.child && alive(ids.child); i++) await sleep(100);
      const gcAliveAfter = ids.grandchild ? alive(ids.grandchild) : null;
      const reported = t.descendants && t.descendants.checked && t.descendants.survivors.some((p) => p.pid === ids.grandchild);
      c('a timed-out run is cancelled by ledger hold then its own handle, never by PID', t.status === 'timed-out' && t.exit.cancel && t.exit.cancel.method === 'ledger-hold-then-owned-handle' && t.exit.cancel.ledgerHeld === true && t.exit.cancel.signalled === true && ids.child > 0 && !alive(ids.child), JSON.stringify({ s: t.status, c: t.exit && t.exit.cancel, ids }), 'Gev: never end a Windows process by PID.');
      c('the call in flight at cancellation is aborted and stays unknown', t.ledger.byStatus.aborted === 1 && t.ledger.unknown === 1 && t.ledger.total === null, JSON.stringify(t.ledger.byStatus), 'Tokens spent on a cut call are not zero.');
      if (process.platform === 'win32') c('a grandchild is surveyed and reported, not ended', reported && gcAliveAfter === true && /left running/.test(t.verdicts.processes), JSON.stringify({ d: t.descendants, gcAliveAfter, v: t.verdicts && t.verdicts.processes }), 'Only the owned handle is ended; anything else is reported for a person to judge.');
      const srcText = fs.readFileSync(fileURLToPath(new URL('../lib/opencode-runtime.mjs', import.meta.url)), 'utf8');
      c('the runtime has no PID-based kill path', !/taskkill|endTree|process\.kill\(\s*-/.test(srcText), 'source scan', 'The rule holds in the code, not only in this test.');
      for (let i = 0; i < 70 && ids.grandchild && alive(ids.grandchild); i++) await sleep(100);
    } finally { if (hangRes) hangRes.destroy(); await up.close(); }
    const fake = fs.mkdtempSync(path.join(W, 'pinonly-'));
    fs.writeFileSync(path.join(fake, 'package.json'), JSON.stringify({ version: OPENCODE_PIN.version, packageManager: OPENCODE_PIN.packageManager }));
    fs.writeFileSync(path.join(fake, 'PIN.json'), JSON.stringify({ commit: OPENCODE_PIN.commit }));
    const vf = verifySource(fake, process.execPath);
    c('a self-written PIN.json is not accepted as the source identity', !vf.ok && vf.commit === null && vf.problems.some((p) => /not a readable git checkout/.test(p)), JSON.stringify(vf.problems), 'Identity comes from the checkout, not from a file anyone can write.');
    if (fs.existsSync(DEFAULTS.sourceRoot)) {
      const src = verifySource();
      c('the real upstream checkout matches the pinned commit, the GitHub tree and the lockfile, with no tracked change', src.commit === OPENCODE_PIN.commit && src.tree === OPENCODE_PIN.tree && src.trackedClean === true && src.bunLockSha256 === OPENCODE_PIN.bunLockSha256 && src.depsReady, JSON.stringify({ ok: src.ok, p: src.problems, d: src.deps, b: src.bun }), 'The runtime must run exactly the source it claims.');
    }
  });

  try { fs.rmSync(W, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* temp tree */ }
}

// Alone: node test/opencode-runtime-suites.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = [];
  let current = null;
  const asyncSuite = async (expert, name, fn) => { current = { expert, name, passed: 0, failed: [] }; results.push(current); try { await fn(); } catch (e) { current.failed.push({ test: '(suite crashed)', happened: String((e && e.stack) || e) }); } };
  const check = (test, cond, info) => { if (cond) { current.passed++; return true; } current.failed.push({ test, ...info }); return false; };
  await opencodeRuntimeSuites({ asyncSuite, check, TMP: os.tmpdir() });
  let failed = 0;
  for (const r of results) {
    console.log(`${r.failed.length ? 'FAIL' : 'ok  '} ${r.name}: ${r.passed} passed, ${r.failed.length} failed`);
    for (const f of r.failed) { failed++; console.log(`   x ${f.test}\n     happened: ${String(f.happened).slice(0, 600)}`); }
  }
  console.log(`${results.reduce((a, r) => a + r.passed, 0)} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
