import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-direct-transport-'));
process.env.ATLIAS_HOME = stateHome;
process.env.OPENAI_API_KEY = 'environment-secret-for-test';
process.env.ANTHROPIC_API_KEY = 'environment-secret-for-test';
process.env.GEMINI_API_KEY = 'environment-secret-for-test';
// The Anthropic API route is founders-only (Gev, 2026-10-30); test/edition-suites.mjs checks the release refuses it.
(await import('../lib/edition.mjs')).offerClaudeForTests(true);
const agent = await import('../lib/agent.mjs');
const loop = await import('../lib/loop.mjs');
const transports = await import('../lib/direct-transports.mjs');
const core = await import('../lib/core.mjs');
const { STATE_DIR } = core;
assert.equal(STATE_DIR, stateHome, 'all session records must stay inside this check’s temporary home');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-direct-project-'));
const toolSchema = [{ type: 'function', function: { name: 'write_file', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } }];
const replies = {
  responses: [
    { id: 'resp-1', status: 'completed', output: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-reasoning' }, { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'write_file', arguments: JSON.stringify({ path: 'responses.mjs', content: "export const marker = 'made';" }) }], usage: { input_tokens: 30, output_tokens: 9, input_tokens_details: { cached_tokens: 4 } } },
    { id: 'resp-2', status: 'completed', output: [{ type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'shell', arguments: JSON.stringify({ command: 'node --check responses.mjs' }) }], usage: { input_tokens: 40, output_tokens: 5, input_tokens_details: { cached_tokens: 8 } } },
    { id: 'resp-3', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Responses finished.' }] }], usage: { input_tokens: 50, output_tokens: 3, input_tokens_details: { cached_tokens: 10 } } },
  ],
  anthropic: [
    { id: 'msg-1', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'private continuation' }, { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'anthropic.mjs', content: "export const marker = 'made';" } }], usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } },
    { id: 'msg-2', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_2', name: 'shell', input: { command: 'node --check anthropic.mjs' } }], usage: { input_tokens: 28, output_tokens: 4, cache_read_input_tokens: 8 } },
    { id: 'msg-3', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Anthropic finished.' }], usage: { input_tokens: 35, output_tokens: 3, cache_read_input_tokens: 10 } },
  ],
  gemini: [
    { responseId: 'gem-1', candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ thoughtSignature: 'opaque-thought-signature', functionCall: { id: 'function-call-1', name: 'write_file', args: { path: 'gemini.mjs', content: "export const marker = 'made';" } } }] } }], usageMetadata: { promptTokenCount: 25, cachedContentTokenCount: 5, candidatesTokenCount: 6, thoughtsTokenCount: 3, totalTokenCount: 34 } },
    { responseId: 'gem-2', candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { id: 'function-call-2', name: 'shell', args: { command: 'node --check gemini.mjs' } } }] } }], usageMetadata: { promptTokenCount: 35, cachedContentTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 41 } },
    { responseId: 'gem-3', candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Gemini finished.' }] } }], usageMetadata: { promptTokenCount: 45, cachedContentTokenCount: 12, candidatesTokenCount: 3, thoughtsTokenCount: 1, totalTokenCount: 49 } },
  ],
};
const seen = { responses: [], anthropic: [], gemini: [] };
const runStates = {};
let step = { responses: 0, anthropic: 0, gemini: 0 };
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const name = req.url.startsWith('/v1/responses') ? 'responses' : req.url.startsWith('/v1/messages') ? 'anthropic' : 'gemini';
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  seen[name].push({ url: req.url, headers: req.headers, body });
  const next = replies[name][step[name]++];
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(next));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${server.address().port}/v1`;

try {
  for (const [name, chat, opts, filename] of [
    ['responses', transports.responsesChat, { model: 'gpt-test', reasoning: 'xhigh', key: '', baseURL }, 'responses.mjs'],
    ['anthropic', transports.anthropicChat, { model: 'claude-test', key: '', baseURL, maxTokens: 100 }, 'anthropic.mjs'],
    ['gemini', transports.geminiChat, { model: 'gemini-test', key: '', baseURL, reasoning: 'high' }, 'gemini.mjs'],
  ]) {
    const state = agent.newState(root, name);
    runStates[name] = state;
    const result = await loop.runLoop(state, 'Create the file and finish.', {
      native: true,
      limits: { maxToolRounds: 3, verifyEdits: false },
      chat: (messages, tools, at) => chat(messages, { ...opts, tools, cwd: at.cwd }),
    });
    assert.ok(fs.existsSync(path.join(root, filename)), `${name}: runLoop should execute the native file tool.`);
    assert.equal(fs.readFileSync(path.join(root, filename), 'utf8'), "export const marker = 'made';");
    assert.equal(state.stop?.reason, 'answered', `${name}: ${JSON.stringify(state.stop)}; result=${result}; requests=${JSON.stringify(seen[name])}`);
    assert.match(result, new RegExp(`${name === 'responses' ? 'Responses' : name === 'anthropic' ? 'Anthropic' : 'Gemini'} finished`));
    assert.equal(seen[name].length, 3);
    assert.equal(seen[name][0].body.tools?.length, name === 'gemini' ? 1 : toolSchema.length + 10);
    const sentToolNames = name === 'gemini'
      ? seen[name][0].body.tools?.flatMap((group) => group.functionDeclarations || []).map((tool) => tool.name)
      : seen[name][0].body.tools?.map((tool) => tool.function?.name || tool.name);
    assert.ok(sentToolNames.includes('write_file'));
    assert.ok(!JSON.stringify(seen[name]).includes('environment-secret-for-test'));
    assert.ok(!seen[name][0].url.includes('key='));
    assert.equal(seen[name][0].headers.authorization, undefined);
    assert.equal(seen[name][0].headers['x-api-key'], undefined);
    assert.equal(seen[name][0].headers['x-goog-api-key'], undefined);
    assert.equal(state.promptLog.length, 3);
    assert.equal(state.outLog.length, 3);
  }

  const responseSecond = seen.responses[1].body.input;
  assert.ok(responseSecond.some((item) => item.type === 'reasoning' && item.encrypted_content === 'opaque-reasoning'));
  assert.ok(responseSecond.some((item) => item.type === 'function_call' && item.call_id === 'call_1'));
  assert.ok(responseSecond.some((item) => item.type === 'function_call_output' && item.call_id === 'call_1' && item.output.length > 0));
  assert.ok(seen.responses[2].body.input.some((item) => item.type === 'function_call_output' && item.call_id === 'call_2' && item.output.includes('exit 0')));
  assert.equal(seen.responses[0].body.reasoning.effort, 'xhigh');
  assert.ok(!('temperature' in seen.responses[0].body) && !('top_p' in seen.responses[0].body));
  assert.ok(seen.responses[0].headers.authorization === undefined);

  const anthropicHistory = seen.anthropic[1].body.messages;
  assert.ok(anthropicHistory.some((item) => item.role === 'assistant' && item.content.some((part) => part.type === 'thinking' && part.thinking === 'private continuation')));
  assert.ok(anthropicHistory.some((item) => item.role === 'user' && Array.isArray(item.content) && item.content.some((part) => part.type === 'tool_result' && part.tool_use_id === 'toolu_1' && String(part.content).length > 0)));
  assert.ok(seen.anthropic[2].body.messages.some((item) => item.role === 'user' && Array.isArray(item.content) && item.content.some((part) => part.type === 'tool_result' && part.tool_use_id === 'toolu_2' && /exit 0/.test(part.content))));
  assert.equal(seen.anthropic[0].body.tools[0].input_schema.type, 'object');

  const geminiHistory = seen.gemini[1].body.contents;
  assert.ok(geminiHistory.some((item) => item.role === 'model' && item.parts.some((part) => part.thoughtSignature === 'opaque-thought-signature')));
  assert.ok(geminiHistory.some((item) => item.role === 'user' && item.parts.some((part) => part.functionResponse?.id === 'function-call-1' && part.functionResponse.name === 'write_file')));
  assert.ok(seen.gemini[2].body.contents.some((item) => item.role === 'user' && item.parts.some((part) => part.functionResponse?.id === 'function-call-2' && part.functionResponse.name === 'shell' && /exit 0/.test(JSON.stringify(part.functionResponse.response)))));
  assert.deepEqual(seen.gemini[0].body.tools[0].functionDeclarations.find((tool) => tool.name === 'write_file').parameters, toolSchema[0].function.parameters);
  assert.equal(seen.gemini[1].body.contents.at(-1).role, 'user');
  assert.deepEqual(runStates.responses.promptLog, [30, 40, 50]);
  assert.deepEqual(runStates.responses.cacheLog, [4, 8, 10]);
  assert.deepEqual(runStates.responses.outLog, [9, 5, 3]);
  assert.deepEqual(runStates.anthropic.promptLog, [25, 36, 45]);
  assert.deepEqual(runStates.anthropic.cacheLog, [3, 8, 10]);
  assert.deepEqual(runStates.anthropic.outLog, [7, 4, 3]);
  assert.deepEqual(runStates.gemini.promptLog, [25, 35, 45]);
  assert.deepEqual(runStates.gemini.cacheLog, [5, 10, 12]);
  assert.deepEqual(runStates.gemini.outLog, [9, 6, 4]);

  const responseSampling = transports.responsesBody([{ role: 'user', content: 'hello' }], { model: 'gpt-test', reasoning: 'xhigh', temperature: 0.2, topP: 0.8 });
  assert.equal(responseSampling.reasoning.effort, 'xhigh');
  assert.ok(!('temperature' in responseSampling) && !('top_p' in responseSampling));
  const modelReasoning = transports.responsesBody([], { model: 'gpt-test', reasoning: 'model', temperature: 0.2, topP: 0.8 });
  assert.ok(!('reasoning' in modelReasoning) && !('temperature' in modelReasoning) && !('top_p' in modelReasoning));
  assert.throws(() => transports.responsesBody([], { model: 'gpt-test', reasoning: 'ultra' }), /unsupported Responses reasoning effort/);
  assert.throws(() => transports.responsesBody([], { model: 'gpt-6.1-sol', reasoning: 'minimal' }), /does not support minimal/);
  assert.throws(() => transports.responsesBody([], { model: 'gpt-6.1-sol', reasoning: 'none' }), /does not support none/);

  const requestFailure = await transports.responsesChat([], { model: 'gpt-test', baseURL, key: '', request: async () => ({ status: 401, json: { error: { message: 'Invalid API key sk-secretvalue12345678' } } }) });
  assert.match(requestFailure.error, /HTTP 401/);
  assert.ok(!requestFailure.error.includes('sk-secretvalue12345678'));
  assert.equal(requestFailure.requestUsages.length, 1);
  assert.equal(requestFailure.requestUsages[0], null);
  const invalidJson = await transports.responsesChat([], { model: 'gpt-test', baseURL, key: '', request: async () => ({ status: 200, json: null, text: 'private response body' }) });
  assert.match(invalidJson.error, /invalid JSON response/);
  assert.ok(!invalidJson.error.includes('private response body'));

  for (const [chat, model, provider, statuses] of [
    [transports.responsesChat, 'gpt-test', 'OpenAI Responses API', [401, 403, 429, 500, 503]],
    [transports.anthropicChat, 'claude-test', 'Anthropic Messages API', [401, 403, 429, 500, 503]],
    [transports.geminiChat, 'gemini-test', 'Gemini API', [401, 403, 429, 500, 503]],
  ]) {
    for (const status of statuses) {
      let attempts = 0;
      const failed = await chat([], { model, baseURL, key: '', request: async () => { attempts++; return { status, json: { error: { message: `provider failure ${status}` } } }; } });
      assert.equal(attempts, 1, `${provider} HTTP ${status} must not retry or silently select another provider`);
      assert.match(failed.error, new RegExp(`${provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} returned HTTP ${status}`));
      assert.deepEqual(failed.requestUsages, [null]);
    }
  }

  const malformed = await transports.anthropicChat([], {
    model: 'claude-test', baseURL, key: '',
    request: async () => ({ status: 200, json: { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'duplicate', name: 'write_file', input: { path: 'x' } },
      { type: 'tool_use', id: 'duplicate', name: 'write_file', input: { path: 'y' } },
    ], usage: { input_tokens: 2, output_tokens: 1 } } }),
  });
  assert.match(malformed.protocolError, /malformed tool call/);
  assert.equal(malformed.calls, undefined);
  assert.equal(malformed.usage.providerUsage.input_tokens, 2);

  const anthroMismatch = await transports.anthropicChat([], {
    model: 'claude-test', baseURL, key: '',
    request: async () => ({ status: 200, json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Finished.' }, { type: 'tool_use', id: 'must-not-run', name: 'write_file', input: {} }] } }),
  });
  assert.match(anthroMismatch.protocolError, /without a tool-use stop reason/);
  assert.equal(anthroMismatch.calls, undefined);

  const failedResponse = await transports.responsesChat([], {
    model: 'gpt-test', baseURL, key: '',
    request: async () => ({ status: 200, json: { status: 'failed', output: [{ type: 'function_call', call_id: 'must-not-run', name: 'write_file', arguments: '{}' }], usage: { input_tokens: 3, output_tokens: 1 } } }),
  });
  assert.match(failedResponse.protocolError, /non-completed response/);
  assert.equal(failedResponse.calls, undefined);
  assert.equal(failedResponse.usage.prompt_tokens, 3);

  const cut = await transports.responsesChat([], {
    model: 'gpt-test', baseURL, key: '',
    request: async () => ({ status: 200, json: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'function_call', call_id: 'cut-call', name: 'write_file', arguments: '{"path":"cut"' }], usage: { input_tokens: 1, output_tokens: 2 } } }),
  });
  assert.equal(cut.truncated, true);
  assert.equal(cut.finish, 'max_output_tokens');
  assert.equal(cut.calls.length, 0);
  assert.equal(loop.isTruncated(cut.finish), false); // the explicit boolean carries Responses' incomplete status.

  const empty = await transports.geminiChat([], {
    model: 'gemini-test', baseURL, key: '',
    request: async () => ({ status: 200, json: { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 0, totalTokenCount: 4 } } }),
  });
  assert.match(empty.protocolError, /empty candidate/);

  const refusal = await transports.geminiChat([], {
    model: 'gemini-test', baseURL, key: '',
    request: async () => ({ status: 200, json: { candidates: [{ finishReason: 'SAFETY', content: { parts: [{ functionCall: { name: 'write_file', args: { path: 'unsafe', content: 'must not run' } } }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1, totalTokenCount: 8 } } }),
  });
  assert.match(refusal.protocolError, /refused/);
  assert.equal(refusal.calls, undefined);

  const unknownFinish = await transports.geminiChat([], {
    model: 'gemini-test', baseURL, key: '',
    request: async () => ({ status: 200, json: { candidates: [{ finishReason: 'OTHER', content: { parts: [{ functionCall: { name: 'write_file', args: { path: 'unsafe', content: 'must not run' } } }] } }] } }),
  });
  assert.match(unknownFinish.protocolError, /unsupported finish reason/);
  assert.equal(unknownFinish.calls, undefined);

  const maliciousFinish = await transports.geminiChat([], {
    model: 'gemini-test', baseURL, key: '',
    request: async () => ({ status: 200, json: { candidates: [{ finishReason: 'private-prompt-text', content: { parts: [{ functionCall: { name: 'write_file', args: { path: 'unsafe', content: 'must not run' } } }] } }] } }),
  });
  assert.ok(!maliciousFinish.protocolError.includes('private-prompt-text'));
  assert.equal(maliciousFinish.calls, undefined);

  for (const [chat, model, response, usagePath] of [
    [transports.responsesChat, 'gpt-test', { status: 'completed', output: [] }, 'usage'],
    [transports.anthropicChat, 'claude-test', { stop_reason: 'end_turn', content: [] }, 'usage'],
    [transports.geminiChat, 'gemini-test', { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'done' }] } }] }, 'usageMetadata'],
  ]) {
    const badUsage = usagePath === 'usage'
      ? (model.startsWith('gpt') ? { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1, input_tokens_details: { cached_tokens: Number.MAX_SAFE_INTEGER } }
        : { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: -1, cache_creation_input_tokens: 0 })
      : { promptTokenCount: 7, cachedContentTokenCount: 8, candidatesTokenCount: Number.MAX_SAFE_INTEGER, thoughtsTokenCount: 1 };
    response[usagePath] = badUsage;
    const malformedUsage = await chat([], { model, baseURL, key: '', request: async () => ({ status: 200, json: response }) });
    assert.equal(malformedUsage.usage._atliasProtocol, model.startsWith('gpt') ? 'responses' : model.startsWith('claude') ? 'anthropic' : 'gemini');
    assert.ok(!('prompt_tokens' in malformedUsage.usage), `${model} malformed usage must not produce a canonical prompt count`);
    assert.ok(!('completion_tokens' in malformedUsage.usage), `${model} malformed usage must not produce a canonical completion count`);
    assert.ok(!('prompt_tokens_details' in malformedUsage.usage), `${model} malformed cache usage must not produce canonical cache counts`);
  }

  const cacheExceedsInput = await transports.responsesChat([], {
    model: 'gpt-test', baseURL, key: '',
    request: async () => ({ status: 200, json: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }], usage: { input_tokens: 7, output_tokens: 2, input_tokens_details: { cached_tokens: 8 } } } }),
  });
  assert.equal(cacheExceedsInput.usage.prompt_tokens, 7);
  assert.ok(!('prompt_tokens_details' in cacheExceedsInput.usage), 'Responses cached tokens greater than prompt tokens must remain unknown');

  const nestedReserved = await transports.responsesChat([], {
    model: 'gpt-test', baseURL, key: '',
    request: async () => ({ status: 200, json: { status: 'completed', output: [{ type: 'function_call', call_id: 'nested-reserved', name: 'write_file', arguments: '{"outer":{"constructor":{"prototype":{"polluted":true}}}}' }] } }),
  });
  assert.match(nestedReserved.protocolError, /malformed tool call/);
  let deepArgs = { path: 'must-not-run' };
  for (let depth = 0; depth < 70; depth++) deepArgs = { nested: deepArgs };
  const deepCall = await transports.responsesChat([], {
    model: 'gpt-6.1-sol', key: '',
    request: async () => ({ status: 200, json: { status: 'completed', output: [{ type: 'function_call', call_id: 'too-deep', name: 'write_file', arguments: JSON.stringify(deepArgs) }] } }),
  });
  assert.match(deepCall.protocolError, /malformed tool call/);
  assert.equal(deepCall.calls, undefined);
  assert.equal(nestedReserved.calls, undefined);
  assert.equal({}.polluted, undefined);

  const unknownCache = await transports.geminiChat([], {
    model: 'gemini-test', baseURL, key: '',
    request: async () => ({ status: 200, json: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'done' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1, totalTokenCount: 8 } } }),
  });
  assert.equal(unknownCache.usage._atliasProtocol, 'gemini');
  assert.equal(unknownCache.usage.prompt_tokens, 7);
  assert.equal(unknownCache.usage.completion_tokens, 1);
  assert.ok(!('prompt_tokens_details' in unknownCache.usage));
  assert.ok(!('cachedContentTokenCount' in unknownCache.usage.providerUsage));

  const uncorrelated = await transports.geminiChat([{ role: 'user', content: 'call a tool' }], {
    model: 'gemini-test', baseURL, key: '',
    request: async () => ({ status: 200, json: { responseId: 'no-id', candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'write_file', args: { path: 'x', content: 'y' } } }] } }] } }),
  });
  const generatedId = uncorrelated.calls[0].id;
  assert.match(generatedId, /^gemini-/);
  let followupBody;
  await transports.geminiChat([{ role: 'user', content: 'call a tool' }, uncorrelated.message, { role: 'tool', tool_call_id: generatedId, content: 'done' }], {
    model: 'gemini-test', baseURL, key: '',
    request: async (_url, body) => { followupBody = body; return { status: 200, json: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'done' }] } }] } }; },
  });
  const generatedResponse = followupBody.contents.at(-1).parts.find((part) => part.functionResponse)?.functionResponse;
  assert.equal(generatedResponse.name, 'write_file');
  assert.ok(!('id' in generatedResponse), 'a local placeholder ID must not masquerade as a provider correlation ID');

  const cutState = agent.newState(root, 'openai');
  const cutRun = await loop.runLoop(cutState, 'Create this only if the response is complete.', {
    native: true, limits: { maxToolRounds: 2, maxBadReplies: 1, verifyEdits: false },
    chat: (messages, tools) => transports.responsesChat(messages, { model: 'gpt-test', baseURL, key: '', tools, request: async () => ({ status: 200, json: {
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'function_call', call_id: 'must-not-run', name: 'write_file', arguments: JSON.stringify({ path: 'must-not-exist.mjs', content: "export const bad = true;" }) }],
      usage: { input_tokens: 11, output_tokens: 5, input_tokens_details: { cached_tokens: 2 } },
    } }) }),
  });
  assert.equal(cutState.stop?.reason, 'truncated-output');
  assert.ok(!fs.existsSync(path.join(root, 'must-not-exist.mjs')));
  assert.deepEqual(cutState.promptLog, [11]);
  assert.deepEqual(cutState.cacheLog, [2]);
  assert.match(cutRun, /cut off at the provider's output limit/);

  // Test the exported application boundary too, not only a manually wired loop.
  const previousKeys = Object.fromEntries(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'].map(k => [k, process.env[k]]));
  try {
    for (const key of Object.keys(previousKeys)) delete process.env[key];
    for (const name of ['responses', 'anthropic', 'gemini']) {
      step[name] = 0; seen[name] = [];
      const cwd = path.join(root, 'application-' + name); fs.mkdirSync(cwd);
      core.writeJson(path.join(STATE_DIR, 'config.json'), { usage: { show: false }, agent: {
        ...core.DEFAULTS.agent, engine: name, maxToolRounds: 3,
        responsesUrl: baseURL, responsesModel: 'gpt-test', responsesReasoningEffort: 'xhigh',
        anthropicUrl: baseURL, anthropicModel: 'claude-test', anthropicMaxTokens: 100,
        geminiUrl: baseURL, geminiModel: 'gemini-test',
      } });
      const state = agent.newState(cwd, name);
      const result = await agent.directTurn(state, 'Create the file and check it.', null, () => {});
      assert.equal(state.stop?.reason, 'answered', name + ': application boundary completed');
      assert.equal(seen[name].length, 3, name + ': exactly three model requests');
      assert.equal(fs.readFileSync(path.join(cwd, name + '.mjs'), 'utf8'), "export const marker = 'made';");
      assert.match(result, /finished/);
      const wire = JSON.stringify(seen[name][2].body);
      assert.match(wire, /exit 0/, name + ': own tool check result reaches provider');
    }
  } finally {
    for (const [key, value] of Object.entries(previousKeys)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }

  console.log('direct transport tests passed: three native own-loop round trips, opaque history, usage, errors and malformed/cut/empty controls');
} finally {
  server.closeIdleConnections?.();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(stateHome, { recursive: true, force: true });
}

