import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-workers-'));
process.env.ATLIAS_HOME = path.join(root, 'home');
process.env.ATLIAS_NO_DETACH = '1';
// Workers on claude-plan and anthropic are founders-only (Gev, 2026-10-30); test/edition-suites.mjs checks the release refuses them.
(await import('../lib/edition.mjs')).offerClaudeForTests(true);
const core = await import('../lib/core.mjs');
const loop = await import('../lib/loop.mjs');
const agent = await import('../lib/agent.mjs');
const commands = await import('../lib/commands.mjs');
const routes = await import('../lib/subagent-routing.mjs');
const cfg = { ...core.DEFAULTS.agent, claudePlanModel: 'claude-opus-5-5', chatgptModel: 'gpt-6.1-sol' };
const set = (more = {}) => core.writeJson(path.join(process.env.ATLIAS_HOME, 'config.json'), { agent: { ...cfg, ...more } });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('routes inherit, isolate worker model, and require approval for another connection', () => {
  assert.equal(routes.selectSubagentRoute('claude-plan', {}, cfg).engine, 'claude-plan');
  const route = routes.selectSubagentRoute('claude-plan', { engine: 'chatgpt', model: 'gpt-worker' }, cfg);
  assert.equal(route.approval, true); assert.equal(route.cfg.chatgptModel, 'gpt-worker');
  assert.equal(cfg.chatgptModel, 'gpt-6.1-sol');
  assert.equal(routes.selectSubagentRoute('claude-plan', { model: 'claude-haiku-5-5' }, cfg).approval, false);
  assert.equal(routes.selectSubagentRoute('claude-plan', { engine: 'chatgpt' }, { ...cfg, claudePlanEffort: 'max' }).approval, false);
  assert.equal(routes.selectSubagentRoute('claude-plan', { engine: 'chatgpt' }, { ...cfg, permissions: 'max' }).approval, false);
  for (const engine of ['auto', 'codex', 'unknown', {}, 'chatgpt\n']) assert.throws(() => routes.selectSubagentRoute('claude-plan', { engine }, cfg));
  for (const model of ['bad name', '\x1b[2J', {}]) assert.throws(() => routes.selectSubagentRoute('claude-plan', { model }, cfg));
});

test('concurrent worker approvals serialize, default to no, and never share approval', async () => {
  const route = routes.selectSubagentRoute('claude-plan', { engine: 'chatgpt' }, cfg);
  let live = 0, peak = 0, count = 0;
  const sub = { ask: async q => { assert.match(q, /ChatGPT plan/); count++; peak = Math.max(peak, ++live); await new Promise(r => setTimeout(r, 5)); live--; return count === 1 ? 'y' : ''; } };
  assert.deepEqual(await Promise.all([routes.approveSubagentRoute(sub, route, 'one'), routes.approveSubagentRoute(sub, route, 'two')]), [true, false]);
  assert.equal(peak, 1); assert.equal(count, 2);
  assert.match(routes.routeLabel(route), /chatgpt.*gpt-6.1-sol/);
  assert.equal(await routes.askSubagent({ask:async()=> 'yes'}, 'Allow?'), 'yes');
  assert.equal(await routes.approveSubagentRoute({}, route, 'headless'), false);
});

test('denied or unavailable route cannot run a worker or silently fall back', async () => {
  set(); let resolved = 0, ran = 0;
  const state = { engine: 'claude-plan', subagent: { ask: async () => 'n', resolve: async () => { resolved++; } } };
  const answer = await loop.runSubagent(state, { task: 'review', engine: 'chatgpt' }, { runLoop: async () => ran++ });
  assert.match(answer, /not granted/); assert.equal(resolved, 0); assert.equal(ran, 0);
  state.subagent.ask = async () => 'yes'; state.subagent.resolve = async () => { throw Error('not connected'); };
  assert.match(await loop.runSubagent(state, { task: 'review', engine: 'chatgpt' }), /not connected.*no fallback/);
});

test('max effort skips connection approval but selects the requested transport', async () => {
  set({ claudePlanEffort: 'max' }); let asked = 0;
  const state = { sid: 'max-worker', cwd: root, engine: 'claude-plan', subagent: { ask: async () => { asked++; return 'n'; }, resolve: async r => ({ chat: () => r.model, native: true }) } };
  const result = await loop.runSubagent(state, { task: 'review', engine: 'chatgpt', model: 'gpt-worker' }, { runLoop: async (child, _brief, options) => { assert.equal(child.engine, 'chatgpt'); assert.equal(options.native, true); return options.chat(); } });
  assert.match(result, /gpt-worker/); assert.equal(asked, 0); assert.equal(state.engine, 'claude-plan');
});

test('unknown worker measurements stay absent and mixed provider accounting keeps its label', async () => {
  set();
  const state = { sid: 'unknown-worker', cwd: root, engine: 'claude-plan', subagent: { chat: () => {} } };
  await loop.runSubagent(state, { task: 'review' }, { runLoop: async child => {
    child.cache = { calls: 1, reported: 0, silent: 1, prompt: 0, cached: 0, source: '' }; return 'no usage reported';
  } });
  assert.equal(Object.hasOwn(state.cache, 'costUsd'), false);
  assert.equal(Object.hasOwn(state.cache, 'output'), false);
  loop.countCache(state, { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 5 } });
  loop.countCache(state, { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 2 });
  loop.countCache(state, { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 5 } });
  assert.equal(state.cache.source, 'mixed providers');
});

test('actual loop delegates to a different engine over HTTP and accounts for the worker', async () => {
  set(); const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    requests.push(JSON.parse(body));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: { content: 'worker reviewed the file' }, done: true, prompt_eval_count: 12, eval_count: 4 }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    let calls = 0, approvals = 0;
    const state = agent.newState(root, 'claude-plan');
    const answer = await loop.runLoop(state, 'review in a worker', {
      chat: async () => ({ content: calls++ ? 'review received' : '```atlias\n{"tool":"agent","task":"review a file","engine":"ollama","model":"local-worker"}\n```', calls: [] }),
      ask: async () => { approvals++; return 'yes'; }, subagents: true,
      resolveSubagent: r => agent.chatRoute(r.engine, { ...r.cfg, ollamaUrl: `http://127.0.0.1:${server.address().port}` }),
    });
    assert.equal(answer, 'review received'); assert.equal(approvals, 1); assert.equal(requests.filter(r => r.messages).length, 1); // /api/show is metadata only
    assert.equal(requests[0].model, 'local-worker'); assert.equal(state.engine, 'claude-plan');
    assert.equal(state.subagentUsage[0].engine, 'ollama'); assert.equal(state.subagentUsage[0].cache.calls, 1); assert.equal(state.cache.calls, 3);
    assert.ok(state.promptLog.includes(12)); assert.ok(state.outLog.includes(4));
    assert.equal(core.config().agent.ollamaModel, cfg.ollamaModel);
  } finally { await new Promise(r => server.close(r)); }
});

test('worker commands configure defaults and do not change the main engine or model', async () => {
  set(); const lines = [], state = agent.newState(root, 'claude-plan');
  const ctx = { state, cwd: root, out: x => lines.push(x), api: { detectEngines: () => ({ 'claude-plan': true }) } };
  await commands.dispatch('/agents claude-plan claude-haiku-5-5', ctx);
  assert.equal(core.config().agent.subagentModel, 'claude-haiku-5-5');
  assert.equal(core.config().agent.claudePlanModel, cfg.claudePlanModel);
  await commands.dispatch('/agents inherit', ctx);
  assert.equal(core.config().agent.subagentEngine, 'inherit'); assert.equal(core.config().agent.subagentModel, '');
  await commands.dispatch('/agents', ctx); assert.match(lines.join('\n'), /skips that approval/);
  set({ subagentModel: 'bad name' });
  await commands.dispatch('/agents', ctx); assert.match(lines.join('\n'), /Worker setting is invalid/);
});

test('interrupting the parent closes the worker provider request', async () => {
  set(); const controller = new AbortController(); let sawChat, sawClose;
  const started = new Promise(r => sawChat = r), closed = new Promise(r => sawClose = r);
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume this test request */ }
    if (req.url === '/api/chat') { res.once('close', sawClose); sawChat(); return; }
    res.setHeader('content-type', 'application/json'); res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const state = { sid: 'cancel-worker', cwd: root, engine: 'claude-plan', subagent: { ask: async () => 'yes', resolve: r => agent.chatRoute(r.engine, { ...r.cfg, ollamaUrl: `http://127.0.0.1:${server.address().port}` }, controller.signal) } };
    const pending = loop.runSubagent(state, { task: 'review', engine: 'ollama', model: 'local-worker' });
    const deadline = promise => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Error('worker did not stop')), 3000))]);
    await deadline(started); controller.abort(); await deadline(pending); await deadline(closed);
    assert.equal(state.engine, 'claude-plan');
    await assert.rejects(agent.chatRoute('ollama', cfg, controller.signal), /interrupted/);
  } finally { await new Promise(r => server.close(r)); }
});

test('a planted missing-measurement regression is detected', async () => {
  set(); const copy = path.join(root, 'mutation'); fs.mkdirSync(copy);
  const sourceRoot = path.resolve(import.meta.dirname, '..');
  for (const dir of ['lib', 'mcp']) fs.cpSync(path.join(sourceRoot, dir), path.join(copy, dir), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, 'package.json'), path.join(copy, 'package.json'));
  const file = path.join(copy, 'lib', 'loop.mjs');
  const source = fs.readFileSync(file, 'utf8');
  const anchor = "for (const k of ['output', 'written', 'costUsd']) if (Number.isFinite(child.cache[k])) c[k] = (c[k] || 0) + child.cache[k];";
  assert.ok(source.includes(anchor));
  fs.writeFileSync(file, source.replace(anchor, "for (const k of ['output', 'written', 'costUsd']) c[k] = (c[k] || 0) + (child.cache[k] || 0);"));
  const mutant = await import(pathToFileURL(file).href);
  const observe = async mod => {
    const state = { sid: 'plant-worker', cwd: root, engine: 'claude-plan', subagent: { chat: () => {} } };
    await mod.runSubagent(state, { task: 'review' }, { runLoop: async child => { child.cache = { calls: 1 }; return 'answer'; } });
    return Object.hasOwn(state.cache, 'costUsd');
  };
  assert.equal(await observe(loop), false); assert.equal(await observe(mutant), true);
});
