import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { chooseEngine, engineLine } from '../lib/engines.mjs';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-engine-contract-'));
process.env.ATLIAS_HOME = path.join(scratch, 'state');
const chatgpt = await import('../lib/chatgpt.mjs');
test.after(() => { assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(scratch, { recursive: true, force: true }); });
const known = [{ slug: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' }];
test('auto never chooses hosts and never changes an explicit billing source', () => {
  assert.equal(chooseEngine('auto', { codex: true, claude: true }), null);
  assert.equal(chooseEngine('auto', { responses: true, codex: true }), 'responses');
  assert.equal(chooseEngine('auto', { responses: true, anthropic: true }), null);
  assert.equal(chooseEngine('gemini', { responses: true }), null);
  assert.equal(chooseEngine('codex', { codex: true, responses: true }), 'codex');
  assert.match(engineLine('codex', {}), /host harness/);
  assert.match(engineLine('chatgpt', { chatgptModel: 'gpt-6.1-sol', chatgptReasoningEffort: 'xhigh' }), /xhigh.*direct; Atlias loop.*ChatGPT plan/);
});
test('model discovery and documented reasoning capability both gate selection', () => {
  assert.equal(chatgpt.validateSelection(known, 'gpt-6.1-sol', 'xhigh').effort, 'xhigh');
  assert.throws(() => chatgpt.validateSelection([], 'gpt-6.1-sol', 'xhigh'), /unavailable/);
  assert.throws(() => chatgpt.validateSelection(known, 'gpt-6.1-sol', 'none'), /not verified/);
  assert.throws(() => chatgpt.validateSelection([{ slug: 'other' }], 'other', 'xhigh'), /not verified/);
});
function sse(events, tail = '') { return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\r\n\r\n').join('') + tail, { headers: { 'content-type': 'text/event-stream' } }); }
test('plan SSE requires completed and rejects cut, malformed or late error streams', async () => {
  const raw = { status: 'completed', output: [{ type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"fixture.txt"}' }], usage: { input_tokens: 9, output_tokens: 4 } };
  assert.deepEqual((await chatgpt.readPlanResponse(sse([{ type: 'response.completed', response: raw }]))).json, raw);
  await assert.rejects(() => chatgpt.readPlanResponse(sse([{ type: 'response.output_text.delta', delta: 'done' }])), /without a complete/);
  await assert.rejects(() => chatgpt.readPlanResponse(sse([{ type: 'response.incomplete' }])), /failed/);
  await assert.rejects(() => chatgpt.readPlanResponse(sse([{ type: 'response.completed', response: raw }, { type: 'error', code: 'subscription_sharing_usage_limit_exceeded' }])), /usage_limit/);
  await assert.rejects(() => chatgpt.readPlanResponse(sse([], 'data: broken\n\n')), /malformed/);
});
test('identity-only and disconnected profiles cannot discover models or infer', async () => {
  let requests = 0;
  const engine = chatgpt.createPlanEngine({ getClient: async () => ({ getSession: async () => ({ status: 'connected', sharing: false }), listModels: () => { requests++; }, requestAuthorized: () => { requests++; } }), fetchImpl: () => { requests++; } });
  await assert.rejects(() => engine.models(), /not authorized/);
  assert.match((await engine.chat([], [], { chatgptModel: 'gpt-6.1-sol', chatgptReasoningEffort: 'xhigh' })).error, /not authorized/);
  assert.equal(requests, 0);
  assert.deepEqual((await engine.chat([], [], {})).requestUsages, []);
});
test('authorized plan route preserves xhigh and sends only dedicated OAuth to public streaming Responses', async () => {
  let posted, authCalls = 0;
  const sdk = { getSession: async () => ({ status: 'connected', sharing: true, profileId: 'synthetic' }), listModels: async () => known, requestAuthorized: async fn => { authCalls++; return fn('synthetic-dedicated-oauth', new AbortController().signal); } };
  const engine = chatgpt.createPlanEngine({ getClient: async () => sdk,
    responsesAdapter: async (messages, opts) => {
      assert.equal(opts.reasoning, 'xhigh');
      const result = await opts.post('https://api.openai.com/v1/responses', { model: opts.model, input: messages, tools: opts.tools, reasoning: { effort: opts.reasoning } });
      return { content: result.json.output[0].content[0].text, usage: result.json.usage };
    },
    fetchImpl: async (url, opts) => { posted = { url, ...opts, body: JSON.parse(opts.body) }; return sse([{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'fixture reply' }] }], usage: { input_tokens: 8, output_tokens: 3 } } }]); },
  });
  assert.equal((await engine.chat([{ role: 'user', content: 'fixture' }], [], { chatgptModel: 'gpt-6.1-sol', chatgptReasoningEffort: 'xhigh' })).content, 'fixture reply');
  assert.equal(authCalls, 1); assert.equal(posted.body.stream, true); assert.equal(posted.body.store, false);
  assert.equal(posted.redirect, 'error'); assert.equal(posted.headers.authorization, 'Bearer synthetic-dedicated-oauth');
  assert.equal(posted.headers['openai-organization'], undefined); assert.equal(posted.body.reasoning.effort, 'xhigh');
  assert.equal(posted.body.temperature, undefined);
});
test('old host-preference and missing SSE-terminal mutation plants are detected', async () => {
  const source = fs.readFileSync(new URL('../lib/engines.mjs', import.meta.url), 'utf8');
  const mutant = path.join(scratch, 'host-policy-mutant.mjs');
  fs.writeFileSync(mutant, source.replace("const configured = DIRECT_ENGINES.filter(e => have[e]);", "if (have.codex) return 'codex'; const configured = DIRECT_ENGINES.filter(e => have[e]);"));
  const bad = await import(pathToFileURL(mutant).href);
  assert.throws(() => assert.equal(bad.chooseEngine('auto', { codex: true }), null));
  const good = await chatgpt.readPlanResponse(sse([{ type: 'response.completed', response: { status: 'completed', output: [] } }]));
  assert.equal(good.status, 200);
  await assert.rejects(() => chatgpt.readPlanResponse(sse([{ type: 'response.output_text.delta', delta: 'completion claim without terminal' }])), /without a complete/);
});
test('removing the sharing-scope guard is caught by the identity-only expectation', async () => {
  let source = fs.readFileSync(new URL('../lib/chatgpt.mjs', import.meta.url), 'utf8');
  const anchor = "if (s.status !== 'connected' || s.sharing !== true)";
  assert.ok(source.includes(anchor)); source = source.replace(anchor, 'if (false)');
  source = source.replace(/from '(.\/[^']+)'/g, (_, rel) => "from '" + new URL('../lib/' + rel.slice(2), import.meta.url).href + "'");
  const mutant = path.join(scratch, 'sharing-mutant.mjs'); fs.writeFileSync(mutant, source);
  const { createPlanEngine: badFactory } = await import(pathToFileURL(mutant).href);
  const bad = badFactory({ getClient: async () => ({ getSession: async () => ({ status: 'connected', sharing: false }), listModels: async () => known }) });
  await assert.rejects(() => assert.rejects(() => bad.models(), /not authorized/), /Missing expected rejection/);
});
