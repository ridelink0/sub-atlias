// The recording provider between OpenCode v2 and a local Ollama.
//
// OpenCode's Ollama provider speaks OpenAI chat to {baseURL}/chat/completions
// (pinned upstream ai/src/protocols/openai-chat.ts:804-853) and has no way to
// set Ollama's num_ctx. Through Ollama's own /v1 every call would run at the
// server default (4096 on a 12 GiB card) with the front of the prompt cut
// silently, as lib/loop.mjs:1948 measured. This server sits on loopback in
// between. It serves OpenCode's model discovery from the one model the run may
// use, turns each chat call into a native /api/chat with the run's num_ctx and
// truncate:false, turns the answer back into OpenAI stream chunks, and writes
// one ledger line per call: main, child, compaction and title calls alike,
// failures and retries included. Counters come from Ollama's own final chunk;
// a counter Ollama did not send stays null and the summary says it is
// incomplete instead of guessing.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const LEDGER_SCHEMA = 'atlias.opencode.provider-ledger/1';
export const DEFAULT_UPSTREAM = 'http://127.0.0.1:11435';
const MAX_BODY = 32 * 1024 * 1024;
const COUNTERS = ['prompt_eval_count', 'prompt_eval_cached_count', 'eval_count', 'prompt_eval_duration', 'eval_duration', 'load_duration', 'total_duration', 'done_reason'];
// Fields of OpenCode's chat body (openai-chat.ts:174-193) that have a native
// counterpart or are answered by this server itself. Anything else is listed
// on the record as not carried, never dropped unseen.
const CARRIED = new Set(['model', 'messages', 'tools', 'tool_choice', 'stream', 'max_completion_tokens', 'max_tokens', 'temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed', 'stop', 'reasoning_effort']);
const OVERFLOW = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)|exceed_context_size_error|exceeds the available context size/i;

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export class LedgerError extends Error {
  constructor(status, message, code = null) { super(message); this.status = status; this.code = code; }
}

// Only plain http on a loopback name: the provider of a local run never
// leaves this machine, so a cloud URL here is a configuration error.
export function loopbackHttpUrl(u) {
  let x;
  try { x = new URL(String(u)); } catch { return null; }
  if (x.protocol !== 'http:') return null;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname)) return null;
  return x;
}
const loopbackPeer = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';

function textOf(content, images) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new LedgerError(400, 'message content is neither text nor a list of parts');
  const texts = [];
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') { texts.push(part.text); continue; }
    if (part && part.type === 'image_url') {
      const m = /^data:[^;,]+;base64,(.*)$/s.exec(String((part.image_url && part.image_url.url) || ''));
      if (!m) throw new LedgerError(400, 'only inline data: images are accepted; this server never fetches a remote URL');
      images.push(m[1]);
      continue;
    }
    throw new LedgerError(400, `unsupported content part ${part && part.type}`);
  }
  // OpenCode joins system parts with one newline when it sends a string
  // (ai/src/protocols/shared.ts:138), so a list of parts reads the same.
  return texts.join('\n');
}

function parseArgs(args) {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args;
  if (args == null || args === '') return {};
  try { const v = JSON.parse(String(args)); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* reported below */ }
  throw new LedgerError(400, 'a tool call in the history has arguments that are not a JSON object');
}

// OpenAI chat body -> native /api/chat body. The window and the output cap are
// the run's policy; everything else OpenCode sent is carried or listed.
export function toNativeRequest(body, policy) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LedgerError(400, 'the request body is not a JSON object');
  if (body.model !== policy.model) throw new LedgerError(404, `model "${body.model}" is not served here; this run serves "${policy.model}" only`, 'model_not_found');
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new LedgerError(400, 'the request has no messages');
  const names = new Map();
  const messages = [];
  for (const m of body.messages) {
    if (!m || typeof m !== 'object') throw new LedgerError(400, 'a message is not an object');
    const images = [];
    const out = { role: m.role, content: textOf(m.content, images) };
    if (images.length) out.images = images;
    if (m.role === 'assistant') {
      const thinking = [m.reasoning_content, m.reasoning, m.reasoning_text].find((t) => typeof t === 'string' && t.length > 0);
      if (thinking) out.thinking = thinking;
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        out.tool_calls = m.tool_calls.map((c) => {
          const name = c && c.function && c.function.name;
          if (typeof name !== 'string' || !name) throw new LedgerError(400, 'a tool call in the history has no function name');
          if (c.id) names.set(c.id, name);
          return { function: { name, arguments: parseArgs(c.function.arguments) } };
        });
      }
    } else if (m.role === 'tool') {
      if (names.has(m.tool_call_id)) out.tool_name = names.get(m.tool_call_id);
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    } else if (m.role !== 'system' && m.role !== 'user') {
      throw new LedgerError(400, `unknown message role ${m.role}`);
    }
    messages.push(out);
  }
  const requested = [body.max_completion_tokens, body.max_tokens].find((v) => Number.isFinite(v) && v > 0) ?? null;
  const options = { num_ctx: policy.numCtx, num_predict: requested ? Math.min(Math.floor(requested), policy.numPredict) : policy.numPredict };
  for (const k of ['temperature', 'top_p', 'seed', 'frequency_penalty', 'presence_penalty']) if (Number.isFinite(body[k])) options[k] = body[k];
  if (typeof body.stop === 'string') options.stop = [body.stop];
  else if (Array.isArray(body.stop) && body.stop.length) options.stop = body.stop;
  // Upstream always streams; a client that asked for one JSON answer gets the
  // stream gathered here. shift:false stops generation at a full window
  // instead of dropping old tokens to make room.
  const native = { model: policy.model, messages, stream: true, truncate: false, shift: false, options };
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length && body.tool_choice !== 'none') {
    native.tools = tools.map((t) => {
      if (!t || !t.function || typeof t.function.name !== 'string') throw new LedgerError(400, 'a tool definition has no function name');
      return { type: 'function', function: { name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } } };
    });
  }
  if (typeof body.reasoning_effort === 'string') native.think = body.reasoning_effort === 'none' ? false : body.reasoning_effort;
  if (policy.keepAlive != null) native.keep_alive = policy.keepAlive;
  const notCarried = Object.keys(body).filter((k) => !CARRIED.has(k));
  if (body.tool_choice && !['auto', 'none'].includes(body.tool_choice)) notCarried.push('tool_choice');
  return { native, requested, notCarried };
}

export function overflowOf(text) {
  const s = String(text || '');
  if (!OVERFLOW.test(s)) return null;
  const m = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i.exec(s);
  const p = /n_prompt_tokens\W+(\d+)/.exec(s);
  const c = /n_ctx\W+(\d+)/.exec(s);
  return { promptTokens: m ? Number(m[1]) : p ? Number(p[1]) : null, ctx: m ? Number(m[2]) : c ? Number(c[1]) : null };
}

function tokensOf(native) {
  const n = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
  const input = n(native.prompt_eval_count);
  const output = n(native.eval_count);
  return { input, output, cachedInput: n(native.prompt_eval_cached_count), total: input != null && output != null ? input + output : null };
}

// Totals over the ledger. total is native input + output; peakWindow is the
// most the window ever held in one call (prompt plus answer). A call that
// reached the model but left no counters makes every figure a lower bound.
export function summarize(records) {
  const s = { schema: LEDGER_SCHEMA, calls: 0, byStatus: {}, countersExpected: 0, counted: 0, unknown: 0, input: 0, output: 0, cachedInput: 0, total: 0, peakPrompt: null, peakWindow: null, largestRejectedPrompt: null, repeats: 0, complete: true, lowerBound: false, sessions: {}, discovery: 0, egressAttempts: 0, refusedRoutes: 0 };
  for (const r of records) {
    if (r.kind === 'discovery') { s.discovery++; continue; }
    if (r.kind === 'egress') { s.egressAttempts++; continue; }
    if (r.kind !== 'chat') { s.refusedRoutes++; continue; }
    s.calls++;
    s.byStatus[r.status] = (s.byStatus[r.status] || 0) + 1;
    if (r.repeatOf != null) s.repeats++;
    const key = (r.session && r.session.id) || '(no session header)';
    const ss = s.sessions[key] || (s.sessions[key] = { parentId: (r.session && r.session.parentId) || null, calls: 0, counted: 0, unknown: 0, input: 0, output: 0, total: 0, peakPrompt: null });
    ss.calls++;
    if (r.overflow && Number.isFinite(r.overflow.promptTokens)) s.largestRejectedPrompt = Math.max(s.largestRejectedPrompt ?? 0, r.overflow.promptTokens);
    if (!r.countersExpected) continue;
    s.countersExpected++;
    const t = r.tokens || {};
    if (t.input == null || t.output == null) { s.unknown++; ss.unknown++; continue; }
    s.counted++; ss.counted++;
    s.input += t.input; s.output += t.output; s.total += t.input + t.output;
    ss.input += t.input; ss.output += t.output; ss.total += t.input + t.output;
    if (t.cachedInput != null) s.cachedInput += t.cachedInput;
    s.peakPrompt = Math.max(s.peakPrompt ?? 0, t.input);
    s.peakWindow = Math.max(s.peakWindow ?? 0, t.input + t.output);
    ss.peakPrompt = Math.max(ss.peakPrompt ?? 0, t.input);
  }
  s.complete = s.unknown === 0;
  s.lowerBound = !s.complete;
  return s;
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // Stop keeping the body but let it drain, so the 413 can still be read.
      if (size > limit) { req.removeAllListeners('data'); req.resume(); reject(new LedgerError(413, `request body over ${limit} bytes`)); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  try {
    if (res.headersSent) { res.end(); return; }
    const s = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  } catch { /* the client is gone; the ledger line still records the call */ }
}
const openaiError = (message, type = 'invalid_request_error', code = null) => ({ error: { message, type, code } });

export async function startProviderLedger(opts = {}) {
  const upstream = loopbackHttpUrl(opts.upstream || DEFAULT_UPSTREAM);
  if (!upstream) throw new Error(`the provider must be plain http on loopback, not ${opts.upstream}: a local run never calls a remote provider`);
  const policy = { model: String(opts.model || ''), numCtx: Number(opts.numCtx), numPredict: Number(opts.numPredict), keepAlive: opts.keepAlive ?? null };
  if (!policy.model) throw new Error('a model is required');
  if (!Number.isInteger(policy.numCtx) || policy.numCtx < 1024) throw new Error(`numCtx must be an integer of at least 1024, not ${opts.numCtx}`);
  if (!Number.isInteger(policy.numPredict) || policy.numPredict < 1 || policy.numPredict >= policy.numCtx) throw new Error(`numPredict must be a positive integer below numCtx, not ${opts.numPredict}`);
  const idleMs = Number(opts.idleTimeoutMs) > 0 ? Number(opts.idleTimeoutMs) : 10 * 60 * 1000;
  const ledgerFile = opts.ledgerFile ? path.resolve(opts.ledgerFile) : null;
  if (ledgerFile) fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  let hold = opts.hold ? String(opts.hold) : null;
  const records = [];
  const firstSeen = new Map();
  const inflight = new Set();
  let seq = 0;

  const begin = (kind, req, extra = {}) => ({ schema: LEDGER_SCHEMA, seq: ++seq, kind, startedAt: new Date().toISOString(), method: req.method, path: req.url, ...extra });
  const commit = (rec) => {
    rec.endedAt = new Date().toISOString();
    rec.durationMs = Date.parse(rec.endedAt) - Date.parse(rec.startedAt);
    records.push(rec);
    if (ledgerFile) fs.appendFileSync(ledgerFile, JSON.stringify(rec) + '\n');
    return rec;
  };

  // One upstream call; resolves with the status and body text, never throws.
  const upstreamText = (method, p, body, timeoutMs = 10000) => new Promise((resolve) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request(new URL(p, upstream), { method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString('utf8') }));
      res.on('error', (e) => resolve({ status: 0, text: '', error: e.message }));
    });
    r.setTimeout(timeoutMs, () => r.destroy(new Error(`no answer in ${timeoutMs} ms`)));
    r.on('error', (e) => resolve({ status: 0, text: '', error: e.message }));
    if (data) r.write(data);
    r.end();
  });
  const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

  async function discovery(req, res) {
    const rec = begin('discovery', req);
    try {
      if (req.method === 'GET' && req.url === '/api/version') {
        const r = await upstreamText('GET', '/api/version');
        rec.status = r.status === 200 ? 'ok' : 'upstream-error';
        res.writeHead(r.status || 502, { 'content-type': 'application/json' }).end(r.text || JSON.stringify({ error: r.error }));
      } else if (req.method === 'GET' && req.url === '/api/tags') {
        const r = await upstreamText('GET', '/api/tags');
        const j = parse(r.text);
        if (r.status !== 200 || !j || !Array.isArray(j.models)) { rec.status = 'upstream-error'; rec.error = r.error || r.text.slice(0, 300); sendJson(res, r.status || 502, { error: rec.error }); return; }
        const served = j.models.filter((m) => m && (m.model === policy.model || m.name === policy.model));
        rec.status = served.length ? 'ok' : 'model-missing';
        rec.discovery = { upstreamModels: j.models.length, served: served.map((m) => ({ model: m.model, digest: m.digest })) };
        sendJson(res, 200, { models: served });
      } else if (req.method === 'POST' && req.url === '/api/show') {
        const body = parse(await readBody(req, 1024 * 1024));
        if (!body || body.model !== policy.model) { rec.status = 'model-not-served'; sendJson(res, 404, { error: `model "${body && body.model}" is not served here` }); return; }
        const r = await upstreamText('POST', '/api/show', { model: policy.model });
        const j = parse(r.text);
        if (r.status !== 200 || !j) { rec.status = 'upstream-error'; rec.error = r.error || r.text.slice(0, 300); sendJson(res, r.status || 502, { error: rec.error }); return; }
        // The window OpenCode budgets against is the one this server enforces,
        // not the model's trained length; both are on the record.
        const info = j.model_info && typeof j.model_info === 'object' ? j.model_info : {};
        let trained = null;
        for (const [k, v] of Object.entries(info)) if (k.endsWith('.context_length') && Number.isFinite(v)) { trained = v; info[k] = Math.min(v, policy.numCtx); }
        rec.status = 'ok';
        rec.discovery = { trainedContext: trained, presentedContext: trained == null ? null : Math.min(trained, policy.numCtx), capabilities: j.capabilities || null };
        sendJson(res, 200, j);
      } else if (req.method === 'GET' && req.url === '/v1/models') {
        rec.status = 'ok';
        sendJson(res, 200, { object: 'list', data: [{ id: policy.model, object: 'model', owned_by: 'ollama' }] });
      } else {
        rec.kind = 'refused-route';
        rec.status = 'unknown-route';
        sendJson(res, 404, openaiError(`no route ${req.method} ${req.url}`));
      }
    } catch (e) {
      rec.status = 'bad-request'; rec.error = e.message;
      sendJson(res, e.status || 400, openaiError(e.message));
    } finally { commit(rec); }
  }

  async function chat(req, res) {
    const h = req.headers;
    const rec = begin('chat', req, {
      session: { id: h['x-opencode-session-id'] || null, parentId: h['x-opencode-parent-session-id'] || null, affinity: h['x-session-affinity'] || null, project: h['x-opencode-project'] || null, client: h['x-opencode-client'] || null },
      dispatched: false, countersExpected: false, status: null, httpStatus: null, error: null, repeatOf: null, native: null, tokens: { input: null, output: null, cachedInput: null, total: null },
    });
    let raw;
    try { raw = await readBody(req); } catch (e) { rec.status = 'bad-request'; rec.error = e.message; rec.httpStatus = e.status || 400; sendJson(res, rec.httpStatus, openaiError(e.message)); commit(rec); return; }
    const reqSha = sha256(raw);
    rec.request = { sha256: reqSha, bytes: Buffer.byteLength(raw) };
    if (firstSeen.has(reqSha)) rec.repeatOf = firstSeen.get(reqSha); else firstSeen.set(reqSha, rec.seq);
    let body;
    let tr;
    try {
      body = JSON.parse(raw);
      const msgs = Array.isArray(body && body.messages) ? body.messages : [];
      const system = msgs.filter((m) => m && m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
      const toolNames = (Array.isArray(body && body.tools) ? body.tools : []).map((t) => t && t.function && t.function.name);
      rec.request = { ...rec.request, model: body && body.model, stream: !(body && body.stream === false), messages: msgs.length, roles: msgs.reduce((a, m) => ((a[m && m.role] = (a[m && m.role] || 0) + 1), a), {}), systemSha256: system ? sha256(system) : null, toolNames, toolsSha256: toolNames.length ? sha256(JSON.stringify(body.tools)) : null };
      tr = toNativeRequest(body, policy);
    } catch (e) {
      rec.status = e.code === 'model_not_found' ? 'model-not-served' : 'bad-request';
      rec.error = e.message;
      rec.httpStatus = e.status || 400;
      sendJson(res, rec.httpStatus, openaiError(e instanceof SyntaxError ? 'the request body is not JSON' : e.message, 'invalid_request_error', e.code || null));
      commit(rec);
      return;
    }
    rec.request.requestedMaxTokens = tr.requested;
    rec.request.notCarried = tr.notCarried;
    rec.applied = { numCtx: tr.native.options.num_ctx, numPredict: tr.native.options.num_predict, truncate: false, shift: false, think: tr.native.think ?? null, tools: (tr.native.tools || []).length, options: Object.keys(tr.native.options) };
    if (hold) {
      rec.status = 'refused'; rec.httpStatus = 503; rec.error = `inference held: ${hold}`;
      sendJson(res, 503, openaiError(`atlias provider ledger: inference held: ${hold}`, 'server_error'));
      commit(rec);
      return;
    }
    const clientStream = rec.request.stream;
    const id = `chatcmpl-atlias-${rec.seq}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created, model: policy.model, choices: [{ index: 0, delta, finish_reason: finish }] });
    const out = { content: '', reasoning: '', toolCalls: [], finishReason: null, doneReason: null };
    let finished = false;
    let started = false;
    const sse = (obj) => { if (!started) { started = true; res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '' }))}\n\n`); } res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    const done = (status, extra = {}) => {
      if (finished) return;
      finished = true;
      inflight.delete(entry);
      Object.assign(rec, { status }, extra);
      rec.output = { contentChars: out.content.length, reasoningChars: out.reasoning.length, toolCalls: out.toolCalls.map((c) => c.function.name), finishReason: out.finishReason, doneReason: out.doneReason };
      commit(rec);
    };
    const data = JSON.stringify(tr.native);
    const up = http.request(new URL('/api/chat', upstream), { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } });
    const entry = { up, abort: () => { if (!finished) { up.destroy(); done('aborted', { error: 'the ledger closed while the call was running' }); } } };
    inflight.add(entry);
    rec.dispatched = true;
    up.setTimeout(idleMs, () => up.destroy(new Error(`upstream sent nothing for ${idleMs} ms`)));
    res.on('close', () => {
      if (finished) return;
      up.destroy();
      done('aborted', { error: 'the client closed the connection before the answer ended', countersExpected: true });
    });
    up.on('error', (e) => {
      if (finished) return;
      const before = !rec.httpStatus;
      if (before) { rec.httpStatus = 502; sendJson(res, 502, openaiError(`local model server unreachable: ${e.message}`, 'server_error')); }
      else if (clientStream && started) { res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'server_error' } })}\n\n`); res.end(); }
      else sendJson(res, 502, openaiError(e.message, 'server_error'));
      done(before ? 'upstream-unreachable' : 'upstream-error', { error: e.message, countersExpected: !before });
    });
    up.on('response', (ur) => {
      rec.httpStatus = ur.statusCode;
      if (ur.statusCode !== 200) {
        const parts = [];
        ur.on('data', (c) => parts.push(c));
        ur.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          const j = parse(text);
          const message = String((j && j.error) || text || `upstream status ${ur.statusCode}`);
          const over = overflowOf(message);
          sendJson(res, ur.statusCode, openaiError(message, 'invalid_request_error', over ? 'context_length_exceeded' : null));
          done(over ? 'overflow' : 'upstream-error', { error: message.slice(0, 2000), overflow: over, countersExpected: false });
        });
        return;
      }
      rec.countersExpected = true;
      let buf = '';
      const line = (s) => {
        if (!s.trim() || finished) return;
        const j = parse(s);
        if (!j) return;
        if (j.error) {
          if (clientStream) { sse({ error: { message: String(j.error), type: 'server_error' } }); res.end(); } else sendJson(res, 500, openaiError(String(j.error), 'server_error'));
          done('upstream-error', { error: String(j.error).slice(0, 2000) });
          up.destroy();
          return;
        }
        const msg = j.message || {};
        const delta = {};
        if (typeof msg.thinking === 'string' && msg.thinking) { delta.reasoning_content = msg.thinking; out.reasoning += msg.thinking; }
        if (typeof msg.content === 'string' && msg.content) { delta.content = msg.content; out.content += msg.content; }
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
          delta.tool_calls = msg.tool_calls.map((c) => {
            const index = out.toolCalls.length;
            const args = c.function && c.function.arguments;
            const call = { id: c.id || `call_${rec.seq}_${index}`, type: 'function', function: { name: (c.function && c.function.name) || '', arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) } };
            out.toolCalls.push(call);
            return { index, ...call };
          });
        }
        if (clientStream && Object.keys(delta).length) sse(chunk(delta));
        if (!j.done) return;
        const native = {};
        for (const k of COUNTERS) if (k in j) native[k] = j[k];
        rec.native = native;
        rec.tokens = tokensOf(native);
        out.doneReason = j.done_reason ?? null;
        out.finishReason = out.toolCalls.length ? 'tool_calls' : j.done_reason === 'length' ? 'length' : 'stop';
        const t = rec.tokens;
        const usage = t.input != null && t.output != null ? { prompt_tokens: t.input, completion_tokens: t.output, total_tokens: t.input + t.output, ...(t.cachedInput != null ? { prompt_tokens_details: { cached_tokens: t.cachedInput } } : {}) } : null;
        if (clientStream) {
          sse(chunk({}, out.finishReason));
          if (usage) sse({ id, object: 'chat.completion.chunk', created, model: policy.model, choices: [], usage });
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          const message = { role: 'assistant', content: out.content, ...(out.reasoning ? { reasoning_content: out.reasoning } : {}), ...(out.toolCalls.length ? { tool_calls: out.toolCalls } : {}) };
          sendJson(res, 200, { id, object: 'chat.completion', created, model: policy.model, choices: [{ index: 0, message, finish_reason: out.finishReason }], ...(usage ? { usage } : {}) });
        }
        done('ok');
      };
      ur.setEncoding('utf8');
      ur.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const s = buf.slice(0, i); buf = buf.slice(i + 1); line(s); } });
      ur.on('end', () => {
        if (buf) line(buf);
        if (finished) return;
        const message = 'the local model server ended the answer without its final chunk';
        if (clientStream && started) { res.write(`data: ${JSON.stringify({ error: { message, type: 'server_error' } })}\n\n`); res.end(); } else sendJson(res, 502, openaiError(message, 'server_error'));
        done('truncated', { error: message });
      });
    });
    up.end(data);
  }

  const server = http.createServer((req, res) => {
    if (!loopbackPeer(req.socket.remoteAddress)) {
      commit(begin('refused-route', req, { status: 'remote-peer', peer: req.socket.remoteAddress }));
      sendJson(res, 403, openaiError('loopback only', 'permission_error'));
      return;
    }
    // A request in proxy form names a host other than this one: that is the
    // run trying to reach the network through HTTP(S)_PROXY. Recorded, refused.
    if (/^https?:\/\//i.test(req.url)) {
      commit(begin('egress', req, { status: 'refused', target: req.url.slice(0, 500) }));
      sendJson(res, 403, openaiError('network access is not part of a local run', 'permission_error'));
      return;
    }
    if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) { chat(req, res); return; }
    discovery(req, res);
  });
  server.on('connect', (req, socket) => {
    commit(begin('egress', req, { status: 'refused', target: String(req.url).slice(0, 500) }));
    socket.on('error', () => {});
    socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;

  // Before a run: is the model installed, and can it hold the window asked
  // for? Read-only metadata calls; nothing is loaded onto the GPU.
  async function preflight() {
    const tags = await upstreamText('GET', '/api/tags');
    const tj = parse(tags.text);
    const found = tj && Array.isArray(tj.models) ? tj.models.find((m) => m.model === policy.model || m.name === policy.model) : null;
    const result = { ok: false, upstream: upstream.origin, model: policy.model, installed: Boolean(found), digest: found ? found.digest : null, details: found ? found.details : null, trainedContext: null, capabilities: null, problems: [] };
    if (tags.status !== 200) result.problems.push(`GET /api/tags answered ${tags.status || tags.error}`);
    else if (!found) result.problems.push(`${policy.model} is not installed on ${upstream.origin}`);
    if (found) {
      const show = await upstreamText('POST', '/api/show', { model: policy.model });
      const sj = parse(show.text);
      if (show.status !== 200 || !sj) result.problems.push(`POST /api/show answered ${show.status || show.error}`);
      else {
        result.capabilities = sj.capabilities || null;
        for (const [k, v] of Object.entries(sj.model_info || {})) if (k.endsWith('.context_length') && Number.isFinite(v)) result.trainedContext = v;
        if (result.trainedContext == null) result.problems.push('the model does not report a trained context length');
        else if (result.trainedContext < policy.numCtx) result.problems.push(`trained context ${result.trainedContext} is below the ${policy.numCtx} window asked for`);
        if (!(sj.capabilities || []).includes('completion')) result.problems.push('the model does not report the completion capability');
      }
    }
    result.ok = result.problems.length === 0;
    return result;
  }

  return {
    url,
    baseURL: `${url}/v1`,
    port,
    policy: { ...policy },
    upstream: upstream.origin,
    ledgerFile,
    records,
    preflight,
    summary: () => summarize(records),
    setHold: (reason) => { hold = reason ? String(reason) : null; },
    close: () => new Promise((resolve) => {
      for (const e of [...inflight]) e.abort();
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
    }),
  };
}
