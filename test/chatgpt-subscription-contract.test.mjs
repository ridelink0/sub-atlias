import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-siwc-contract-'));
process.env.ATLIAS_HOME = path.join(scratch, 'state');
const { createPlanEngine } = await import('../lib/chatgpt.mjs');
const { responsesChat } = await import('../lib/direct-transports.mjs');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const cfg = { chatgptModel: 'gpt-6.1-sol', chatgptReasoningEffort: 'xhigh' };
const tools = [{ type: 'function', function: { name: 'shell', description: 'Synthetic shell fixture', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } } }];
const prompt = [{ role: 'user', content: 'Synthetic fixture only' }];
const call = { type: 'function_call', call_id: 'call_one', name: 'shell', arguments: '{"command":"echo fixture"}' };
const usage = { input_tokens: 13, output_tokens: 4, input_tokens_details: { cached_tokens: 7 } };
const complete = (output, metering = usage) => ({ type: 'response.completed', response: { status: 'completed', output, ...(metering ? { usage: metering } : {}) } });
const sse = (events, headers = {}) => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream', ...headers } });
function fixture(replies, factory = createPlanEngine, sharing = true) {
  const sent = [];
  const sdk = { getSession: async () => ({ status: 'connected', sharing, profileId: 'synthetic' }), listModels: async () => [{ slug: cfg.chatgptModel }], requestAuthorized: async fn => fn('synthetic-oauth', new AbortController().signal) };
  const engine = factory({ getClient: async () => sdk, responsesAdapter: responsesChat, fetchImpl: async (url, options) => { sent.push({ url, ...options, body: JSON.parse(options.body) }); return replies.shift(); } });
  return { engine, sent };
}
async function contract(factory = createPlanEngine) {
  const reasoning = { type: 'reasoning', id: 'reason_one', encrypted_content: 'synthetic-replay', summary: [] };
  const { engine, sent } = fixture([sse([complete([reasoning, call])]), sse([complete([{ type: 'message', content: [{ type: 'output_text', text: 'fixture complete' }] }], null)])], factory);
  const first = await engine.chat(prompt, tools, cfg);
  assert.equal(first.calls[0].tool, 'shell');
  assert.equal(first.usage.prompt_tokens, 13);
  assert.equal(first.usage.prompt_tokens_details.cached_tokens, 7);
  const second = await engine.chat([...prompt, first.message, { role: 'tool', tool_call_id: 'call_one', content: 'fixture output' }], tools, cfg);
  for (const request of sent) {
    assert.equal(request.body.tools, undefined);
    assert.deepEqual(request.body.input[0], { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'shell', description: tools[0].function.description, parameters: tools[0].function.parameters }] });
    assert.equal(request.body.model, cfg.chatgptModel);
    assert.equal(request.body.reasoning.effort, 'xhigh');
    assert.equal(request.body.stream, true);
    assert.equal(request.body.store, false);
  }
  assert.ok(sent[1].body.input.some(item => item.encrypted_content === 'synthetic-replay'));
  assert.ok(sent[1].body.input.some(item => item.type === 'function_call_output' && item.call_id === 'call_one' && item.output === 'fixture output'));
  assert.equal(second.content, 'fixture complete');
  assert.deepEqual(second.requestUsages, [null]);
}
test('SIWC uses additional_tools and preserves reasoning, call pairing, xhigh and unknown usage', () => contract());
test('ordinary Responses API keeps its existing flat tools contract', async () => {
  let body;
  await responsesChat(prompt, { model: cfg.chatgptModel, tools, reasoning: 'xhigh', key: 'synthetic', post: async (_url, payload) => { body = payload; return { status: 200, json: complete([{ type: 'message', content: [{ type: 'output_text', text: 'fixture' }] }]).response }; } });
  assert.equal(body.tools[0].name, 'shell');
  assert.equal(body.input.some(item => item.type === 'additional_tools'), false);
});
for (const [name, output] of [
  ['unknown namespace', [{ ...call, namespace: 'unapproved' }]],
  ['unoffered name', [{ ...call, name: 'bash' }]],
  ['indirect caller', [{ ...call, caller: { type: 'code_execution' } }]],
  ['duplicate call id', [call, call]],
  ['malformed JSON', [{ ...call, arguments: '{command:broken}' }]],
  ['array arguments', [{ ...call, arguments: '[]' }]],
  ['missing required field', [{ ...call, arguments: '{}' }]],
  ['extra dispatch field', [{ ...call, arguments: '{"command":"echo fixture","tool":"write_file"}' }]],
  ['prototype key', [{ ...call, arguments: '{"command":"echo fixture","__proto__":{}}' }]],
  ['hosted tool', [{ type: 'web_search_call', id: 'unexpected' }]],
]) test(`SIWC refuses ${name} before dispatch while retaining known usage`, async () => {
  const { engine } = fixture([sse([complete(output)])]);
  const result = await engine.chat(prompt, tools, cfg);
  assert.ok(result.protocolError);
  assert.equal(result.calls, undefined);
  assert.equal(result.usage.prompt_tokens, 13);
});
test('a previously issued call id cannot execute again', async () => {
  const { engine } = fixture([sse([complete([call])])]);
  const result = await engine.chat([...prompt, { role: 'assistant', content: '', _provider: { responsesOutput: [call] } }], tools, cfg);
  assert.ok(result.protocolError);
});
for (const status of [401, 403, 429, 503]) test(`HTTP ${status} preserves safe code, parameter and request id without response text`, async () => {
  const { engine } = fixture([new Response(JSON.stringify({ detail: { code: 'subscription_sharing_user_not_eligible', param: 'model', message: 'private-fixture-must-not-escape' } }), { status, headers: { 'x-request-id': 'req_fixture' } })]);
  const result = await engine.chat(prompt, tools, cfg);
  assert.match(result.error, /subscription_sharing_user_not_eligible/);
  assert.match(result.error, /req_fixture/);
  assert.match(result.error, /model/);
  assert.deepEqual(result.providerError, { status, code: 'subscription_sharing_user_not_eligible', param: 'model', requestId: 'req_fixture', shape: 'json' });
  assert.equal(JSON.stringify(result).includes('private-fixture-must-not-escape'), false);
  assert.deepEqual(result.requestUsages, [null]);
});
test('oversized and non-JSON failure bodies stay bounded and private', async () => {
  for (const body of ['private-fixture-html', 'x'.repeat(65537)]) {
    const { engine } = fixture([new Response(body, { status: 403, headers: { 'x-request-id': 'Bearer secret' } })]);
    const result = await engine.chat(prompt, tools, cfg);
    assert.match(result.error, /chatgpt_http_403/);
    assert.equal(result.providerError.requestId, undefined);
    assert.ok(['non_json', 'oversized'].includes(result.providerError.shape));
    assert.equal(JSON.stringify(result).includes('private-fixture-html'), false);
  }
});
test('late SSE errors and cut streams cannot return calls', async () => {
  for (const events of [[{ type: 'response.output_text.delta', delta: 'fixture' }], [complete([call]), { type: 'error', code: 'subscription_sharing_usage_limit_exceeded' }]]) {
    const { engine } = fixture([sse(events, { 'x-request-id': 'req_stream' })]);
    const result = await engine.chat(prompt, tools, cfg);
    assert.ok(result.error);
    assert.equal(result.calls, undefined);
    if (events.length > 1) assert.equal(result.providerError?.requestId, 'req_stream');
  }
});
test('secret-shaped stream error codes are never exposed', async () => {
  const { engine } = fixture([sse([{ type: 'error', code: 'sk-private-fixture' }])]);
  const result = await engine.chat(prompt, tools, cfg);
  assert.equal(JSON.stringify(result).includes('sk-private-fixture'), false);
});
test('disconnected sharing never sends a request', async () => {
  const { engine, sent } = fixture([], createPlanEngine, false);
  assert.ok((await engine.chat(prompt, tools, cfg)).error);
  assert.equal(sent.length, 0);
});
test('an arbitrary SDK exception cannot inject diagnostic data', async () => {
  const engine = createPlanEngine({ getClient: async () => { throw Object.assign(Error('untrusted'), { providerError: { token: 'private-fixture' } }); } });
  assert.equal(JSON.stringify(await engine.chat(prompt, tools, cfg)).includes('private-fixture'), false);
});
test('isolated regression plants fail the real request contract', async () => {
  const source = fs.readFileSync(new URL('../lib/chatgpt.mjs', import.meta.url), 'utf8');
  const plants = [
    ['flat-tools', '...payload, store: false', '...payload, tools: definitions, store: false'],
    ['namespace-erasure', 'item.namespace != null', 'false'],
    ['diagnostic-erasure', 'diagnostic = result.diagnostic;', 'diagnostic = undefined;'],
  ];
  for (const [name, from, to] of plants) {
    assert.ok(source.includes(from), name);
    const mutated = source.replace(from, to).replace(/from '(\.\/[^']+)'/g, (_match, rel) => "from '" + new URL('../lib/' + rel.slice(2), import.meta.url).href + "'");
    const file = path.join(scratch, name + '.mjs'); fs.writeFileSync(file, mutated);
    const { createPlanEngine: bad } = await import(pathToFileURL(file).href);
    if (name === 'flat-tools') await assert.rejects(() => contract(bad));
    else if (name === 'namespace-erasure') {
      const { engine } = fixture([sse([complete([{ ...call, namespace: 'unapproved' }])])], bad);
      const result = await engine.chat(prompt, tools, cfg);
      assert.throws(() => assert.ok(result.protocolError));
    } else {
      const { engine } = fixture([new Response('{"error":{"code":"fixture_denial","param":"model"}}', { status: 403 })], bad);
      const result = await engine.chat(prompt, tools, cfg);
      assert.throws(() => assert.equal(result.providerError?.param, 'model'));
    }
  }
});
