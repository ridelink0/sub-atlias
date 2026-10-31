import { hasAttachmentInput, mediaBlocks, validateImageHistory } from './media-input.mjs';
// Native provider transports for Atlias's own runLoop. These deliberately use
// HTTP only: credentials come from the caller and are never read from CLI
// sessions or copied into request URLs.
import { apiUrl } from './provider.mjs';
import { MAX_NATIVE_CALLS, normalizeCall, repairJson, postJson, MAX_RESPONSE_BYTES } from './loop.mjs';

const DEFAULTS = {
  responses: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};
const REASONING = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

function cleanBase(value, fallback) {
  const url = apiUrl(value || fallback);
  return url.href.replace(/\/+$/, '');
}

function usageOf(value, key) {
  return value && typeof value === 'object' && value[key] && typeof value[key] === 'object' ? value[key] : null;
}

function responsesUsage(raw) {
  if (!raw || typeof raw !== 'object') return raw || null;
  const usage = { _atliasProtocol: 'responses', providerUsage: raw };
  const input = raw.input_tokens, output = raw.output_tokens;
  const inputValid = Number.isSafeInteger(input) && input >= 0;
  const outputValid = Number.isSafeInteger(output) && output >= 0;
  const totalsValid = inputValid && outputValid && Number.isSafeInteger(input + output);
  if (totalsValid) {
    usage.prompt_tokens = input;
    usage.completion_tokens = output;
  }
  const details = raw.input_tokens_details;
  if (details && typeof details === 'object' && inputValid && totalsValid && Number.isSafeInteger(details.cached_tokens) && details.cached_tokens >= 0 && details.cached_tokens <= input) {
    usage.prompt_tokens_details = { cached_tokens: details.cached_tokens };
  }
  return usage;
}

function anthropicUsage(raw) {
  if (!raw || typeof raw !== 'object') return raw || null;
  const usage = { _atliasProtocol: 'anthropic', providerUsage: raw };
  const input = raw.input_tokens, output = raw.output_tokens;
  const read = raw.cache_read_input_tokens ?? 0;
  const write = raw.cache_creation_input_tokens ?? 0;
  const readValid = Number.isSafeInteger(read) && read >= 0;
  const writeValid = Number.isSafeInteger(write) && write >= 0;
  const inputValid = Number.isSafeInteger(input) && input >= 0;
  const outputValid = Number.isSafeInteger(output) && output >= 0;
  let creationDetailsValid = true;
  if (raw.cache_creation !== undefined) {
    const creation = raw.cache_creation;
    creationDetailsValid = !!creation && typeof creation === 'object' && !Array.isArray(creation);
    if (creationDetailsValid) {
      const values = ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'].filter((key) => creation[key] !== undefined).map((key) => creation[key]);
      creationDetailsValid = values.every((value) => Number.isSafeInteger(value) && value >= 0) && (!values.length || values.reduce((sum, value) => sum + value, 0) === write);
    }
  }
  const prompt = input + read + write;
  const valid = inputValid && outputValid && readValid && writeValid && creationDetailsValid && Number.isSafeInteger(prompt) && Number.isSafeInteger(prompt + output);
  if (valid) {
    // The unchanged loop understands this validated Anthropic shape. Keep
    // unvalidated/provider-specific fields inside providerUsage only.
    Object.assign(usage, { input_tokens: input, output_tokens: output,
      cache_read_input_tokens: read, cache_creation_input_tokens: write });
    usage.prompt_tokens = prompt;
    usage.completion_tokens = output;
    if (raw.cache_read_input_tokens !== undefined) usage.prompt_tokens_details = { cached_tokens: read };
  } else {
    delete usage.prompt_tokens;
    delete usage.completion_tokens;
    delete usage.prompt_tokens_details;
  }
  return usage;
}

function apiError(status, json, provider) {
  const code = json?.error?.code ?? json?.error?.type ?? json?.code;
  const requestId = json?.request_id ?? json?.error?.request_id;
  const safeCode = typeof code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? `, code ${code}` : '';
  const safeRequestId = typeof requestId === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(requestId) ? `, request ${requestId}` : '';
  return `${provider} returned HTTP ${status}${safeCode}${safeRequestId}.`;
}

async function send(url, body, headers, opts, provider) {
  try {
    const request = opts.request || opts.post || ((target, data, requestHeaders) => postJson(
      target,
      data,
      requestHeaders,
      Number.isSafeInteger(opts.timeoutMs) && opts.timeoutMs > 0 ? Math.min(opts.timeoutMs, 120000) : 120000,
      Number.isSafeInteger(opts.maxResponseBytes) && opts.maxResponseBytes > 0 ? Math.min(opts.maxResponseBytes, MAX_RESPONSE_BYTES) : MAX_RESPONSE_BYTES,
    ));
    const result = await request(url, body, headers);
    if (result?.error) {
      const code = typeof result.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(result.code) ? ` (${result.code})` : '';
      return { error: `${provider} request failed${code}.`, requestUsages: [null] };
    }
    if (!result || !Number.isInteger(result.status)) return { error: `${provider} request returned an invalid response.`, requestUsages: [null] };
    if (result.status < 200 || result.status >= 300) {
      const usageKey = provider.startsWith('Gemini') ? 'usageMetadata' : 'usage';
      const usage = usageOf(result.json, usageKey);
      return { error: apiError(result.status, result.json, provider), requestUsages: [usage] };
    }
    if (!result.json || typeof result.json !== 'object' || Array.isArray(result.json)) {
      return { error: `${provider} returned an invalid JSON response.`, requestUsages: [null] };
    }
    const usageKey = provider.startsWith('Gemini') ? 'usageMetadata' : 'usage';
    return { response: result.json, requestUsages: [usageOf(result.json, usageKey)] };
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(error.code) ? ` (${error.code})` : '';
    return { error: `${provider} request failed${code}.`, requestUsages: [null] };
  }
}

function textContent(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter((part) => part && (part.type === 'text' || typeof part.text === 'string')).map((part) => String(part.text || '')).join('');
}

function functionSchemas(tools, kind) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const tool of tools) {
    const fn = tool?.function;
    if (tool?.type !== 'function' || !fn || typeof fn.name !== 'string' || !fn.name.trim() || !fn.parameters || typeof fn.parameters !== 'object') continue;
    if (kind === 'responses') out.push({ type: 'function', name: fn.name, description: fn.description || '', parameters: fn.parameters });
    else if (kind === 'anthropic') out.push({ name: fn.name, description: fn.description || '', input_schema: fn.parameters });
    else out.push({ name: fn.name, description: fn.description || '', parameters: fn.parameters });
  }
  return out;
}

function argsObject(value) {
  let args = value;
  if (typeof args === 'string') args = repairJson(args);
  if (args === undefined || args === null) args = {};
  const safe = (item, seen = new Set(), depth = 0) => {
    if (depth > 64) return false;
    if (!item || typeof item !== 'object') return item === null || typeof item !== 'function';
    if (seen.has(item)) return false;
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) return false;
    seen.add(item);
    for (const key of Object.keys(item)) {
      if (RESERVED.has(key) || !safe(item[key], seen, depth + 1)) return false;
    }
    seen.delete(item);
    return true;
  };
  if (!args || typeof args !== 'object' || Array.isArray(args) || !safe(args)) return null;
  return args;
}

function normalizedCalls(rawCalls, provider) {
  if (!Array.isArray(rawCalls) || rawCalls.length > MAX_NATIVE_CALLS) return { calls: [], error: `${provider} returned an invalid or oversized tool-call list.` };
  const ids = new Set(), calls = [], generic = [];
  for (const raw of rawCalls) {
    const id = raw?.id;
    const name = raw?.name;
    const args = argsObject(raw?.arguments ?? raw?.input ?? raw?.args);
    if (typeof id !== 'string' || !id.trim() || ids.has(id) || typeof name !== 'string' || !name.trim() || !args) {
      return { calls: [], error: `${provider} returned a malformed tool call; no tools in that reply were run.` };
    }
    ids.add(id);
    const call = normalizeCall({ function: { name, arguments: args } });
    calls.push({ ...call, id });
    generic.push({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  }
  return { calls, generic, error: null };
}

function assistantMessage(content, calls, providerMeta) {
  return {
    role: 'assistant',
    content,
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(providerMeta ? { _provider: providerMeta } : {}),
  };
}

function messagesForResponses(messages) {
  const instructions = [];
  const input = [];
  for (const message of messages || []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'system' || message.role === 'developer') {
      if (typeof message.content === 'string' && message.content) instructions.push(message.content);
      continue;
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: String(message.content || '') });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message._provider?.responsesOutput)) {
      input.push(...message._provider.responsesOutput);
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const fn = call?.function;
        if (!fn || typeof call.id !== 'string') continue;
        input.push({ type: 'function_call', call_id: call.id, name: fn.name, arguments: String(fn.arguments || '{}') });
      }
      if (message.content) input.push({ role: 'assistant', content: [{ type: 'output_text', text: String(message.content) }] });
      continue;
    }
    if (message.role === 'user' || message.role === 'assistant') {
      input.push({ role: message.role, content: hasAttachmentInput(message) ? mediaBlocks(message, 'responses') : [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: String(message.content || '') }] });
    }
  }
  return { instructions: instructions.join('\n\n'), input };
}

function responseBody(messages, opts = {}) {
  if (typeof opts.model !== 'string' || !opts.model.trim()) throw new TypeError('model is required.');
  validateImageHistory(messages);
  const converted = messagesForResponses(messages);
  const body = { model: opts.model, input: converted.input };
  if (converted.instructions) body.instructions = converted.instructions;
  const tools = functionSchemas(opts.tools, 'responses');
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
  const effort = typeof opts.reasoning === 'string' ? opts.reasoning.trim().toLowerCase() : opts.reasoning?.effort;
  if (effort !== undefined && effort !== null && effort !== '') {
    if (effort === 'model') {
      // Let the selected model apply its own default reasoning behavior.
    } else {
      if (!REASONING.has(effort)) throw new TypeError(`unsupported Responses reasoning effort: ${String(effort)}`);
      if (/^gpt-6\.1-sol(?:-|$)/i.test(opts.model) && ['none', 'minimal'].includes(effort)) throw new TypeError(`Responses model ${opts.model} does not support ${effort} reasoning effort.`);
      body.reasoning = { effort };
    }
  } else {
    if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
    if (typeof opts.topP === 'number') body.top_p = opts.topP;
  }
  return body;
}

export function responsesBody(messages, opts = {}) { return responseBody(messages, opts); }

function parseResponses(response) {
  if (response.status !== 'completed' && response.status !== 'incomplete') return { protocolError: 'Responses API returned a non-completed response.' };
  const output = response.output;
  if (!Array.isArray(output)) return response.status === 'incomplete'
    ? { content: '', calls: [], generic: [], finish: response.incomplete_details?.reason || 'incomplete', truncated: true, output: [] }
    : { protocolError: 'Responses API returned no output list.' };
  const text = output.filter((item) => item?.type === 'message').flatMap((item) => item.content || [])
    .filter((part) => part?.type === 'output_text' || part?.type === 'text').map((part) => String(part.text || '')).join('');
  if (response.status === 'incomplete' || response.incomplete_details) return { content: text, calls: [], generic: [], finish: response.incomplete_details?.reason || 'incomplete', truncated: true, output };
  const rawCalls = output.filter((item) => item?.type === 'function_call').map((item) => ({ id: item.call_id, name: item.name, arguments: item.arguments }));
  const parsed = normalizedCalls(rawCalls, 'Responses API');
  if (parsed.error) return { protocolError: parsed.error };
  if (!text && !parsed.calls.length) return { protocolError: 'Responses API returned an empty response with no text or tool calls.' };
  return { content: text, calls: parsed.calls, generic: parsed.generic, finish: response.status || 'completed', truncated: false, output };
}

export async function responsesChat(messages, opts = {}) {
  let body, base;
  try { body = responseBody(messages, opts); base = cleanBase(opts.baseURL, DEFAULTS.responses); }
  catch (error) { return { error: error.message, requestUsages: [] }; }
  const key = opts.key ?? opts.env?.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
  const headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
  const result = await send(`${base}/responses`, body, headers, opts, 'OpenAI Responses API');
  if (result.error) return { ...result, requestUsages: result.requestUsages?.map(responsesUsage) || [] };
  const usage = responsesUsage(result.requestUsages[0]);
  result.requestUsages = [usage];
  const parsed = parseResponses(result.response);
  if (parsed.protocolError) return { protocolError: parsed.protocolError, usage, requestUsages: result.requestUsages };
  return {
    content: parsed.content,
    calls: parsed.calls,
    message: assistantMessage(parsed.content, parsed.generic, { responsesOutput: parsed.output }),
    usage, requestUsages: result.requestUsages,
    finish: parsed.finish, truncated: parsed.truncated,
  };
}

function messagesForAnthropic(messages) {
  let system = '';
  const result = [];
  for (const message of messages || []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'system' || message.role === 'developer') { if (message.content) system += `${system ? '\n\n' : ''}${String(message.content)}`; continue; }
    if (message.role === 'tool') {
      result.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: String(message.content || '') }] });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message._provider?.anthropicContent)) {
      result.push({ role: 'assistant', content: message._provider.anthropicContent });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const content = [];
      if (message.content) content.push({ type: 'text', text: String(message.content) });
      for (const call of message.tool_calls) {
        try { content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || '{}') }); } catch { /* invalid historical entry is omitted */ }
      }
      result.push({ role: 'assistant', content });
    } else if (message.role === 'user' || message.role === 'assistant') {
      result.push({ role: message.role, content: hasAttachmentInput(message) ? mediaBlocks(message, 'anthropic') : String(message.content || '') });
    }
  }
  return { system, messages: coalesceAnthropic(result) };
}

function coalesceAnthropic(messages) {
  const out = [];
  for (const item of messages) {
    const last = out[out.length - 1];
    if (last?.role === item.role) {
      const content = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content || '') }];
      const next = Array.isArray(item.content) ? item.content : [{ type: 'text', text: String(item.content || '') }];
      last.content = [...content, ...next];
    } else out.push({ ...item });
  }
  return out;
}

function anthropicBody(messages, opts = {}) {
  if (typeof opts.model !== 'string' || !opts.model.trim()) throw new TypeError('model is required.');
  validateImageHistory(messages);
  const converted = messagesForAnthropic(messages);
  const body = { model: opts.model, max_tokens: Number.isInteger(opts.maxTokens) && opts.maxTokens > 0 ? opts.maxTokens : 4096, messages: converted.messages };
  if (converted.system) body.system = converted.system;
  const tools = functionSchemas(opts.tools, 'anthropic');
  if (tools?.length) body.tools = tools;
  const reasoning = opts.reasoning;
  const thinking = typeof reasoning === 'object' && reasoning !== null ? reasoning : opts.thinking;
  if (thinking !== undefined && thinking !== null) {
    if (thinking.type !== 'enabled' || !Number.isSafeInteger(thinking.budget_tokens) || thinking.budget_tokens < 1024 || thinking.budget_tokens >= body.max_tokens) throw new TypeError('Anthropic reasoning must be { type: "enabled", budget_tokens } with a budget from 1024 up to maxTokens - 1.');
    body.thinking = { type: 'enabled', budget_tokens: thinking.budget_tokens };
  } else if (typeof reasoning === 'string' && reasoning.trim().toLowerCase() !== 'none') {
    throw new TypeError('Anthropic reasoning uses a thinking budget, not a scalar effort; pass { type: "enabled", budget_tokens } or "none".');
  }
  // agent.anthropicEffort: sent only when chosen, so the model's own default stays otherwise.
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(opts.effort)) body.output_config = { effort: opts.effort };
  if (opts.cache !== false) markCache(body);
  return body;
}

// The Messages API caches only up to a block marked with cache_control, and
// this route sent none, so every call paid full price for the whole
// conversation. Two of the four allowed marks, the layout Claude Code uses:
// the system prompt (which also covers the tools before it) and the last
// block of the last message, so the next call, the same prefix plus new
// turns, reads everything up to here from the cache
// (platform.claude.com/docs/en/build-with-claude/prompt-caching).
function markCache(body) {
  const mark = { type: 'ephemeral' };
  if (typeof body.system === 'string' && body.system) body.system = [{ type: 'text', text: body.system, cache_control: mark }];
  const last = body.messages[body.messages.length - 1];
  if (!last) return;
  if (typeof last.content === 'string') {
    if (last.content) last.content = [{ type: 'text', text: last.content, cache_control: mark }];
    return;
  }
  if (!Array.isArray(last.content) || !last.content.length) return;
  const i = last.content.length - 1;
  const block = last.content[i];
  if (block && !['thinking', 'redacted_thinking'].includes(block.type) && !(block.type === 'text' && !block.text)) last.content = [...last.content.slice(0, i), { ...block, cache_control: mark }];
}

function parseAnthropic(response) {
  const content = response.content;
  if (!Array.isArray(content)) return { protocolError: 'Anthropic Messages API returned no content blocks.' };
  const text = textContent(content.filter((part) => part?.type === 'text'));
  if (response.stop_reason === 'max_tokens') return { content: text, calls: [], generic: [], finish: response.stop_reason, truncated: true, blocks: content };
  if (!['tool_use', 'end_turn', 'stop_sequence', 'refusal'].includes(response.stop_reason)) return { protocolError: 'Anthropic Messages API returned an unsupported stop reason.' };
  if (response.stop_reason === 'refusal') return { protocolError: 'Anthropic refused the request.', usage: response.usage };
  const rawCalls = content.filter((part) => part?.type === 'tool_use').map((part) => ({ id: part.id, name: part.name, input: part.input }));
  if (rawCalls.length && response.stop_reason !== 'tool_use') return { protocolError: 'Anthropic returned tool calls without a tool-use stop reason.' };
  if (response.stop_reason === 'tool_use' && !rawCalls.length) return { protocolError: 'Anthropic returned a tool-use stop reason without a tool call.' };
  const parsed = normalizedCalls(rawCalls, 'Anthropic Messages API');
  if (parsed.error) return { protocolError: parsed.error };
  if (!text && !parsed.calls.length) return { protocolError: response.stop_reason === 'refusal' ? 'Anthropic refused the request without a text explanation.' : 'Anthropic Messages API returned an empty response with no text or tool calls.' };
  return { content: text, calls: parsed.calls, generic: parsed.generic, finish: response.stop_reason || '', truncated: false, blocks: content };
}

export { anthropicUsage, anthropicBody };
export async function anthropicChat(messages, opts = {}) {
  let body, base;
  try { body = anthropicBody(messages, opts); base = cleanBase(opts.baseURL, DEFAULTS.anthropic); }
  catch (error) { return { error: error.message, requestUsages: [] }; }
  const key = opts.key ?? opts.env?.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '';
  const headers = { 'content-type': 'application/json', 'anthropic-version': opts.apiVersion || '2023-06-01', ...(key ? { 'x-api-key': key } : {}) };
  const result = await send(`${base}/messages`, body, headers, opts, 'Anthropic Messages API');
  if (result.error) return { ...result, requestUsages: result.requestUsages?.map(anthropicUsage) || [] };
  const usage = anthropicUsage(result.requestUsages[0]);
  result.requestUsages = [usage];
  const parsed = parseAnthropic(result.response);
  if (parsed.protocolError) return { protocolError: parsed.protocolError, usage, requestUsages: result.requestUsages };
  return { content: parsed.content, calls: parsed.calls, message: assistantMessage(parsed.content, parsed.generic, { anthropicContent: parsed.blocks }), usage, requestUsages: result.requestUsages, finish: parsed.finish, truncated: parsed.truncated };
}

function geminiContents(messages) {
  let system = '';
  const contents = [];
  const toolNames = new Map();
  for (const message of messages || []) {
    for (const call of message?.tool_calls || []) if (call?.id && call.function?.name) toolNames.set(call.id, call.function.name);
    for (const [id, name] of Object.entries(message?._provider?.geminiToolNames || {})) toolNames.set(id, name);
  }
  for (const message of messages || []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'system' || message.role === 'developer') { if (message.content) system += `${system ? '\n\n' : ''}${String(message.content)}`; continue; }
    if (message.role === 'tool') {
      let response = { result: String(message.content || '') };
      try { const parsed = JSON.parse(message.content); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) response = parsed; } catch { /* text result remains structured */ }
      const name = toolNames.get(message.tool_call_id);
      if (!name) throw new TypeError(`Gemini tool result has no matching function call: ${String(message.tool_call_id || '')}`);
      const functionResponse = { name, response };
      const providerId = messages.find((m) => m.role === 'assistant' && m._provider?.geminiCallIds?.[message.tool_call_id])?._provider?.geminiCallIds?.[message.tool_call_id];
      if (providerId) functionResponse.id = providerId;
      contents.push({ role: 'user', parts: [{ functionResponse }] });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message._provider?.geminiParts)) {
      contents.push({ role: 'model', parts: message._provider.geminiParts });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const parts = [];
      if (message.content) parts.push({ text: String(message.content) });
      for (const call of message.tool_calls) {
        try { parts.push({ functionCall: { id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments || '{}') } }); } catch { /* invalid historical entry is omitted */ }
      }
      contents.push({ role: 'model', parts });
    } else if (message.role === 'user' || message.role === 'assistant') {
      contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: hasAttachmentInput(message) ? mediaBlocks(message, 'gemini') : [{ text: String(message.content || '') }] });
    }
  }
  return { system, contents: coalesceGemini(contents) };
}

function coalesceGemini(contents) {
  const out = [];
  for (const item of contents) {
    const last = out[out.length - 1];
    if (last?.role === item.role) last.parts.push(...item.parts);
    else out.push({ role: item.role, parts: [...item.parts] });
  }
  return out;
}

function geminiBody(messages, opts = {}) {
  if (typeof opts.model !== 'string' || !opts.model.trim()) throw new TypeError('model is required.');
  validateImageHistory(messages);
  const converted = geminiContents(messages);
  const body = { contents: converted.contents };
  if (converted.system) body.systemInstruction = { parts: [{ text: converted.system }] };
  const tools = functionSchemas(opts.tools, 'gemini');
  if (tools?.length) body.tools = [{ functionDeclarations: tools }];
  const effort = typeof opts.reasoning === 'string' ? opts.reasoning.trim().toLowerCase() : opts.reasoning?.effort;
  if (effort && !['minimal', 'low', 'medium', 'high'].includes(effort)) throw new TypeError(`unsupported Gemini reasoning effort: ${String(effort)}`);
  if (opts.temperature !== undefined || effort) body.generationConfig = { ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}), ...(effort ? { thinkingConfig: { thinkingLevel: effort.toUpperCase() } } : {}) };
  return body;
}

function parseGemini(response) {
  const candidate = response.candidates?.[0];
  if (!candidate) {
    const reason = response.promptFeedback?.blockReason;
    const suffix = typeof reason === 'string' && /^[A-Z_]{1,64}$/.test(reason) ? ` (${reason})` : '';
    return { protocolError: `Gemini blocked the request or returned no candidate${suffix}.` };
  }
  if (candidate.finishReason === 'MAX_TOKENS') {
    const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
    const text = textContent(parts.filter((part) => typeof part?.text === 'string'));
    return { content: text, calls: [], generic: [], finish: candidate.finishReason, truncated: true, parts, rawCalls: [] };
  }
  const parts = candidate.content?.parts;
  if (!Array.isArray(parts)) return { protocolError: 'Gemini returned no candidate parts.' };
  if (candidate.finishReason !== 'STOP') {
    const refusal = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'MODEL_ARMOR']);
    const finish = typeof candidate.finishReason === 'string' && candidate.finishReason ? candidate.finishReason : 'missing';
    return { protocolError: refusal.has(finish) ? `Gemini refused the response (${finish}).` : 'Gemini returned an unsupported finish reason.' };
  }
  const text = textContent(parts.filter((part) => typeof part?.text === 'string'));
  const responseId = response.responseId || 'response';
  const rawCalls = parts.filter((part) => part?.functionCall).map((part, index) => ({ id: part.functionCall.id || `gemini-${responseId}-${index}`, providerId: part.functionCall.id || null, name: part.functionCall.name, args: part.functionCall.args }));
  const parsed = normalizedCalls(rawCalls, 'Gemini API');
  if (parsed.error) return { protocolError: parsed.error };
  if (!text && !parsed.calls.length) return { protocolError: 'Gemini returned an empty candidate with no text or tool calls.' };
  return { content: text, calls: parsed.calls, generic: parsed.generic, finish: candidate.finishReason || '', truncated: false, parts, rawCalls };
}

function geminiUsage(raw) {
  if (!raw || typeof raw !== 'object') return raw || null;
  const prompt = raw.promptTokenCount;
  const cached = raw.cachedContentTokenCount;
  const total = raw.totalTokenCount;
  const candidate = raw.candidatesTokenCount;
  const thoughts = raw.thoughtsTokenCount;
  const mapped = { _atliasProtocol: 'gemini', providerUsage: raw };
  const promptValid = Number.isSafeInteger(prompt) && prompt >= 0;
  const cacheValid = cached === undefined || (Number.isSafeInteger(cached) && cached >= 0 && promptValid && cached <= prompt);
  let completion;
  if (total !== undefined) {
    if (Number.isSafeInteger(total) && promptValid && total >= prompt) completion = total - prompt;
  } else if (Number.isSafeInteger(candidate) && candidate >= 0 && Number.isSafeInteger(thoughts) && thoughts >= 0 && Number.isSafeInteger(candidate + thoughts)) {
    completion = candidate + thoughts;
  }
  if (promptValid && cacheValid && Number.isSafeInteger(completion) && Number.isSafeInteger(prompt + completion)) {
    mapped.prompt_tokens = prompt;
    mapped.completion_tokens = completion;
    if (cached !== undefined) mapped.prompt_tokens_details = { cached_tokens: cached };
  }
  return mapped;
}

export async function geminiChat(messages, opts = {}) {
  let body, base;
  try { body = geminiBody(messages, opts); base = cleanBase(opts.baseURL, DEFAULTS.gemini); }
  catch (error) { return { error: error.message, requestUsages: [] }; }
  const key = opts.key ?? opts.env?.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ?? '';
  const model = encodeURIComponent(opts.model.startsWith('models/') ? opts.model.slice(7) : opts.model);
  const headers = { 'content-type': 'application/json', ...(key ? { 'x-goog-api-key': key } : {}) };
  const result = await send(`${base}/models/${model}:generateContent`, body, headers, opts, 'Gemini API');
  if (result.error) return { ...result, requestUsages: result.requestUsages?.map(geminiUsage) || [] };
  const usage = geminiUsage(result.requestUsages[0]);
  result.requestUsages = [usage];
  const parsed = parseGemini(result.response);
  if (parsed.protocolError) return { protocolError: parsed.protocolError, usage, requestUsages: result.requestUsages };
  const nameById = new Map(parsed.calls.map((call) => [call.id, call.tool]));
  const providerIds = Object.fromEntries(parsed.rawCalls.map((call) => [call.id, call.providerId]));
  return {
    content: parsed.content,
    calls: parsed.calls.map((call) => ({ ...call, _toolName: nameById.get(call.id) })),
    message: assistantMessage(parsed.content, parsed.generic, { geminiParts: parsed.parts, geminiToolNames: Object.fromEntries(nameById), geminiCallIds: providerIds }),
    usage, requestUsages: result.requestUsages,
    finish: parsed.finish, truncated: parsed.truncated,
  };
}
