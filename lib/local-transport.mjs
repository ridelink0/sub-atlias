// Metered, no-redirect transport for the planner and reporter helper calls.
// It speaks OpenAI-compatible chat completions only. The baseUrl must end in /v1 (as the benchmark's
// metering Door does: POST <baseUrl>/chat/completions is POST /v1/chat/completions on the Door).
// Every attempt appends exactly one ledger row, including refusals; a row with unknown usage is unknown, never zero.
import * as provider from './provider.mjs';

const ROLES = ['planner', 'reporter'];
const FAILED = ['refused', 'redirect-refused', 'http-error', 'timeout', 'aborted', 'network-error', 'invalid-json'];

function attemptError(outcome, message) {
  const error = new Error(message);
  error.outcome = outcome;
  return error;
}

function knownUsage(usage) {
  return usage !== null && typeof usage === 'object'
    && Number.isSafeInteger(usage.totalInput) && Number.isSafeInteger(usage.output) && Number.isSafeInteger(usage.total)
    && usage.total === usage.totalInput + usage.output;
}

async function discard(response) {
  try { await response.body?.cancel(); } catch { /* the body is not needed */ }
}

export function createMeteredTransport({
  profile,
  ledger,
  fetchImpl = fetch,
  now = Date.now,
  allowRemote = false,
  forbidPorts = [11435],
  reasoningEffort,
  maxTokens,
} = {}) {
  const cfg = provider.validate(profile, ['chat']);
  if (cfg.protocol !== 'chat') throw new TypeError('the metered transport needs a profile with protocol chat');
  if (cfg.authHeader !== undefined && cfg.authHeader !== 'bearer') throw new TypeError('the chat transport sends Authorization: Bearer only; authHeader must be bearer or omitted');
  if (!Array.isArray(ledger)) throw new TypeError('ledger must be an array that receives one row per attempt');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof allowRemote !== 'boolean') throw new TypeError('allowRemote must be boolean');
  if (!Array.isArray(forbidPorts) || forbidPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new TypeError('forbidPorts must be an array of port numbers');
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new TypeError('maxTokens is required: a positive integer sent as max_tokens (no default is guessed)');
  if (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || !reasoningEffort.trim())) throw new TypeError('reasoningEffort must be a nonempty string when given');

  const url = new URL(cfg.baseUrl);
  const endpoint = `${cfg.baseUrl}/chat/completions`;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const local = provider.localUrl(url);
  let seq = 0;

  function refusal() {
    if (!local && !allowRemote) return 'baseUrl is not loopback; a remote endpoint needs allowRemote on purpose';
    if (forbidPorts.includes(port)) return `port ${port} is the direct unmetered upstream; call the metering Door instead`;
    return null;
  }

  return async function transport({ role, request, signal, timeoutMs } = {}) {
    if (!ROLES.includes(role)) throw new TypeError('role must be planner or reporter');
    if (!request || typeof request.system !== 'string' || typeof request.user !== 'string') throw new TypeError('request needs string system and user fields');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer');
    const row = { role, seq: ++seq, started: now(), finished: null, httpStatus: null, outcome: null, finishReason: null, usage: null };
    const finish = () => { row.finished = now(); ledger.push(row); };
    const blocked = refusal();
    if (blocked) {
      row.outcome = 'refused';
      finish();
      throw attemptError('refused', blocked);
    }

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const classify = (error) => {
      if (timedOut) return attemptError('timeout', 'the local model call timed out');
      if (signal?.aborted) return attemptError('aborted', 'the local model call was aborted by its caller');
      return attemptError('network-error', `the local model call failed: ${error?.name || 'error'}`);
    };

    const headers = { 'Content-Type': 'application/json', 'X-Atlias-Role': role };
    const key = cfg.keyEnv ? process.env[cfg.keyEnv] : undefined;
    if (typeof key === 'string' && key.length > 0) headers.Authorization = `Bearer ${key}`;
    const body = {
      model: cfg.model,
      messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
      stream: false,
      max_tokens: maxTokens,
    };
    if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort;

    try {
      let response;
      try {
        response = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual', signal: controller.signal });
      } catch (error) {
        throw classify(error);
      }
      row.httpStatus = response.status;
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        await discard(response);
        throw attemptError('redirect-refused', `the endpoint answered ${response.status}; redirects are refused and the target was not requested`);
      }
      if (!response.ok) {
        await discard(response);
        throw attemptError('http-error', `the endpoint answered HTTP ${response.status}`);
      }
      let text;
      try {
        text = await response.text();
      } catch (error) {
        throw classify(error);
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw attemptError('invalid-json', 'the reply body is not JSON');
      }
      row.usage = provider.tokens(parsed?.usage, 'chat');
      const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : undefined;
      row.finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
      const capped = row.finishReason === 'length';
      const content = choice?.message?.content;
      if (typeof content !== 'string' && !(content === null && capped)) {
        throw attemptError('invalid-json', 'the reply has no choices[0].message.content text');
      }
      row.outcome = capped ? 'capped' : 'ok';
      return { text: typeof content === 'string' ? content : '', capped };
    } catch (error) {
      if (!row.outcome) row.outcome = error?.outcome ?? 'network-error';
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      finish();
    }
  };
}

export function summarizeLedger(ledger) {
  if (!Array.isArray(ledger)) throw new TypeError('ledger must be an array of rows');
  const roles = new Map();
  let calls = 0, failures = 0, capped = 0, unknownUsage = 0;
  let TOTAL = 0, fullPEAK = 0, totalKnown = true, peakKnown = true;
  for (const row of ledger) {
    if (!row || typeof row !== 'object') throw new TypeError('each ledger row must be an object');
    const known = knownUsage(row.usage);
    calls++;
    if (!['ok', 'capped'].includes(row.outcome)) failures++;
    if (row.outcome === 'capped') capped++;
    if (!known) unknownUsage++;
    if (!roles.has(String(row.role))) roles.set(String(row.role), { calls: 0, failures: 0, capped: 0, input: 0, output: 0, TOTAL: 0, PEAK: 0, known: true, peakKnown: true });
    const r = roles.get(String(row.role));
    r.calls++;
    if (!['ok', 'capped'].includes(row.outcome)) r.failures++;
    if (row.outcome === 'capped') r.capped++;
    if (!known) {
      totalKnown = peakKnown = r.known = r.peakKnown = false;
      continue;
    }
    const peak = row.usage.totalInput + row.usage.output;
    TOTAL += row.usage.total;
    if (peak > fullPEAK) fullPEAK = peak;
    r.input += row.usage.totalInput;
    r.output += row.usage.output;
    r.TOTAL += row.usage.total;
    if (peak > r.PEAK) r.PEAK = peak;
  }
  const byRole = {};
  for (const [role, r] of roles) {
    byRole[role] = {
      calls: r.calls,
      failures: r.failures,
      capped: r.capped,
      input: r.known ? r.input : null,
      output: r.known ? r.output : null,
      TOTAL: r.known ? r.TOTAL : null,
      PEAK: r.peakKnown ? r.PEAK : null,
    };
  }
  return {
    calls,
    failures,
    capped,
    unknownUsage,
    byRole,
    TOTAL: totalKnown ? TOTAL : null,
    fullPEAK: peakKnown ? fullPEAK : null,
  };
}
