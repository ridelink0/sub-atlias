// User-supplied prices are estimates, never a bill. No defaults for paid rates.
import fs from 'node:fs';

const RATE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h'];
const count = (x) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export function apiUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('baseUrl must be an absolute API URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('baseUrl must be an HTTP(S) URL without credentials, query or fragment.');
  if (url.protocol === 'http:' && !localUrl(url)) throw Error('Remote API endpoints require HTTPS.');
  return url;
}
export function localUrl(url) { return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); }
// Host launches take anthropic or responses only. The chat protocol is for the
// local helper transport, which asks for it by name; a host never accepts it.
const HOST_PROTOCOLS = ['anthropic', 'responses'];
export function validate(profile, protocols = HOST_PROTOCOLS) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw Error('A provider profile must be an object.');
  const allowed = ['protocol', 'baseUrl', 'model', 'keyEnv', 'authHeader', 'pricing'];
  if (Object.keys(profile).some((k) => !allowed.includes(k))) throw Error('Unknown profile field. Store credentials in the keyEnv environment variable, never in the profile.');
  if (!protocols.includes(profile.protocol)) throw Error(protocols === HOST_PROTOCOLS ? 'protocol must be anthropic (Claude Code) or responses (Codex).' : `protocol must be ${protocols.join(' or ')}.`);
  const url = apiUrl(profile.baseUrl);
  if (typeof profile.model !== 'string' || !profile.model.trim() || /[\r\n\0]/.test(profile.model)) throw Error('model must be a nonempty model identifier.');
  if (profile.keyEnv !== undefined && (typeof profile.keyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.keyEnv))) throw Error('keyEnv must name an environment variable.');
  if (profile.authHeader !== undefined && !['bearer', 'x-api-key'].includes(profile.authHeader)) throw Error('authHeader must be bearer or x-api-key.');
  if (profile.pricing !== undefined) {
    const p = profile.pricing;
    if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some((k) => ![...RATE_KEYS, 'currency', 'source', 'asOf'].includes(k))) throw Error('Invalid pricing fields.');
    for (const k of RATE_KEYS) if (k in p && (typeof p[k] !== 'number' || !Number.isFinite(p[k]) || p[k] < 0)) throw Error(`pricing.${k} must be a nonnegative number per million tokens.`);
    if (typeof p.currency !== 'string' || !/^[A-Z]{3}$/.test(p.currency)) throw Error('pricing.currency must be a three-letter currency code.');
    for (const k of ['source', 'asOf']) if (k in p && typeof p[k] !== 'string') throw Error(`pricing.${k} must be text.`);
  }
  return { ...profile, baseUrl: url.href.replace(/\/$/, '') };
}
export function load(file) {
  let p;
  try { p = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { throw Error('Cannot read a valid provider profile JSON file.'); }
  return validate(p);
}

// Anthropic's input is uncached; Responses input includes cache reads/writes.
// Reasoning is already in output. Missing mandatory usage is unknown, not zero.
// Chat (OpenAI-compatible /chat/completions): prompt_tokens includes cached_tokens, so cached is split
// out of input and counted as cacheRead; completion_tokens is output. Absent cache detail counts as 0;
// a malformed one is unknown.
function chatTokens(raw) {
  const input = raw.prompt_tokens, output = raw.completion_tokens;
  if (!count(input) || !count(output) || !Number.isSafeInteger(input + output)) return null;
  if ('prompt_tokens_details' in raw && !object(raw.prompt_tokens_details)) return null;
  const detail = raw.prompt_tokens_details || {};
  const cacheRead = 'cached_tokens' in detail ? detail.cached_tokens : 0;
  if (!count(cacheRead) || cacheRead > input) return null;
  return { input: input - cacheRead, output, cacheRead, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, totalInput: input, total: input + output };
}
export function tokens(raw, protocol) {
  if (!['anthropic', 'responses', 'chat'].includes(protocol)) return null;
  if (!raw || typeof raw !== 'object') return null;
  if (protocol === 'chat') return chatTokens(raw);
  for (const k of ['cache_creation', 'input_tokens_details', 'output_tokens_details']) if (k in raw && !object(raw[k])) return null;
  const input = raw.input_tokens, output = raw.output_tokens;
  if (!count(input) || !count(output)) return null;
  let cacheRead = 0, cacheWrite = 0, cacheWrite5m = 0, cacheWrite1h = 0;
  if (protocol === 'anthropic') {
    cacheRead = 'cache_read_input_tokens' in raw ? raw.cache_read_input_tokens : 0;
    cacheWrite = 'cache_creation_input_tokens' in raw ? raw.cache_creation_input_tokens : 0;
    if (!count(cacheRead) || !count(cacheWrite)) return null;
    const detail = raw.cache_creation;
    if (detail) {
      cacheWrite5m = 'ephemeral_5m_input_tokens' in detail ? detail.ephemeral_5m_input_tokens : 0;
      cacheWrite1h = 'ephemeral_1h_input_tokens' in detail ? detail.ephemeral_1h_input_tokens : 0;
      if (!count(cacheWrite5m) || !count(cacheWrite1h) || cacheWrite5m + cacheWrite1h > cacheWrite) return null;
    }
    const totalInput = input + cacheRead + cacheWrite;
    return Number.isSafeInteger(totalInput + output) ? { input, output, cacheRead, cacheWrite: cacheWrite - cacheWrite5m - cacheWrite1h, cacheWrite5m, cacheWrite1h, totalInput, total: totalInput + output } : null;
  }
  const detail = raw.input_tokens_details || {};
  cacheRead = 'cached_tokens' in detail ? detail.cached_tokens : 0;
  cacheWrite = 'cache_write_tokens' in detail ? detail.cache_write_tokens : 0;
  if (!count(cacheRead) || !count(cacheWrite) || cacheRead + cacheWrite > input || !Number.isSafeInteger(input + output)) return null;
  return { input: input - cacheRead - cacheWrite, output, cacheRead, cacheWrite, cacheWrite5m, cacheWrite1h, totalInput: input, total: input + output };
}
export function cost(usage, pricing) {
  if (!usage || !pricing || typeof pricing.currency !== 'string' || !/^[A-Z]{3}$/.test(pricing.currency)) return null;
  let value = 0;
  for (const k of RATE_KEYS) {
    if (!count(usage[k])) return null;
    if (!usage[k]) continue;
    const rate = pricing[k] ?? (k.startsWith('cacheWrite') ? pricing.cacheWrite : undefined);
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) return null;
    value += usage[k] / 1e6 * rate;
  }
  return Number.isFinite(value) ? { value, currency: pricing.currency, kind: 'estimate' } : null;
}
export function summarize(rows) {
  const calls = rows.filter((r) => r.inference);
  const known = calls.filter((r) => r.tokens && r.terminal);
  const currencies = new Set(calls.map((r) => r.cost?.currency).filter(Boolean));
  const total = known.reduce((n, r) => n + r.tokens.total, 0);
  return { calls: calls.length, unknownUsage: calls.length - known.length,
    totalTokens: known.length === calls.length && count(total) ? total : null,
    estimatedCost: calls.length && currencies.size === 1 && calls.every((r) => r.cost) ? { value: calls.reduce((n, r) => n + r.cost.value, 0), currency: [...currencies][0], kind: 'estimate' } : null };
}
