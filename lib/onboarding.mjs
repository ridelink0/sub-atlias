import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config, STATE_DIR, writeJson } from './core.mjs';
import { set } from './settings.mjs';
import { apiUrl } from './provider.mjs';
import { planEngine, prepared as chatgptPrepared, PREPARE_COMMAND } from './chatgpt.mjs';
import * as claudePlanMod from './claude-plan.mjs';
import { hostEnginesAllowed } from './engines.mjs';

const FILE = path.join(STATE_DIR, 'onboarding.json');
const SCHEMA = 'atlias.onboarding.v1';
const METHODS = new Set(['claude-plan', 'chatgpt', 'responses', 'anthropic', 'gemini', 'openai', 'ollama', 'claude', 'codex', 'antigravity', 'later', 'none']);
const rowShape = (x) => x && x.schema === SCHEMA && METHODS.has(x.method)
  && ['complete', 'deferred'].includes(x.status) && typeof x.verification === 'string';
export function onboardingPath() { return FILE; }
export function requiresFirstOpen(row, { engine } = {}) {
  return (!row || row.status === 'deferred') && !engine;
}
export function readOnboarding(file = FILE) {
  try { const row = JSON.parse(fs.readFileSync(file, 'utf8')); return rowShape(row) ? row : null; }
  catch { return null; }
}
function save(file, method, status, verification, details = {}) {
  const row = { schema: SCHEMA, method, status, verification, details, updatedAt: new Date().toISOString() };
  writeJson(file, row);
  return row;
}
const answer = async (ask, question, fallback = '') => {
  const value = await ask(question);
  if (value === null || value === undefined) throw Object.assign(Error('onboarding cancelled'), { code: 'ATLIAS_CANCELLED' });
  return String(value).trim() || fallback;
};
const yes = (x) => /^y(?:es)?$/i.test(String(x || '').trim());

export const CHOICES = [
  { key: '1', method: 'claude-plan', label: 'Use my Claude plan (Pro or Max)', detail: 'Atlias runs its own loop on Claude; you sign in through Anthropic; no API key' },
  { key: '2', method: 'chatgpt', label: 'Sign in with ChatGPT', detail: 'Atlias direct loop; ChatGPT plan authorization; no API-key fallback' },
  { key: '3', method: 'ollama', label: 'I will just use local models using Ollama', detail: 'No account or API key; local inference' },
  { key: '4', method: 'anthropic', label: 'Anthropic API', detail: 'Messages API; separate API billing' },
  { key: '5', method: 'responses', label: 'OpenAI API', detail: 'Responses API; separate API billing' },
  { key: '6', method: 'gemini', label: 'Google Gemini API', detail: 'Gemini API; separate API billing' },
  { key: '7', method: 'openai', label: 'OpenAI-compatible API endpoint', detail: 'Provider API billing may apply' },
  { key: '8', method: 'antigravity', label: 'I use Antigravity', detail: 'Its own sign-in cannot be shared; Atlias sets up the Gemini API instead' },
  { key: '9', method: 'claude', label: 'Claude Code native host', detail: 'Claude Code owns its agent loop, sign-in and billing', host: true },
  { key: '10', method: 'codex', label: 'Codex native host', detail: 'Codex owns its agent loop, sign-in and billing', host: true },
  { key: '0', method: 'later', label: 'Set up later', detail: 'Reopen with /onboarding' },
];
export const visibleChoices = (cfg = config().agent) => CHOICES.filter((row) => !row.host || hostEnginesAllowed(cfg));

// What is already on this computer, so the first screen can offer the route
// that works now. Booleans only: no account name, token or key leaves here.
export async function detectRoutes({ nativeAuthStatus, claudePlan = claudePlanMod, isChatGPTPrepared = chatgptPrepared, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const cfg = config().agent;
  let claudeSignedIn = false;
  try { if (claudePlan.prepared()) claudeSignedIn = claudePlan.planStatus().plan === true; } catch { /* unknown stays false */ }
  if (!claudeSignedIn && typeof nativeAuthStatus === 'function') { try { claudeSignedIn = (await nativeAuthStatus('claude')).subscription === true; } catch { /* unknown */ } }
  const has = (names) => names.some((n) => typeof env[n] === 'string' && env[n].trim());
  const ollama = await checkOllamaTags(cfg.ollamaUrl || 'http://127.0.0.1:11434', fetchImpl).catch(() => ({ ok: false }));
  return { claudePlan: claudeSignedIn, claudeRuntime: Boolean(claudePlan.prepared?.()), chatgpt: Boolean(isChatGPTPrepared()),
    anthropic: has(API.anthropic.keyEnv), responses: has(API.responses.keyEnv), gemini: has(API.gemini.keyEnv), ollama: ollama.ok === true && (ollama.models || []).length > 0 };
}
export function recommended(found = {}) {
  if (found.claudePlan) return '1';
  if (found.chatgpt) return '2';
  if (found.anthropic) return '4';
  if (found.responses) return '5';
  if (found.gemini) return '6';
  if (found.ollama) return '3';
  return '1';
}

export function welcomeText(found = null, cfg = config().agent) {
  const lines = ['Choose how Atlias will reach a model. Provider APIs use their own billing. Atlias does not move subscription tokens between products.'];
  if (found) {
    const ready = [found.claudePlan && 'your Claude sign-in', found.chatgpt && 'the ChatGPT sign-in runtime', found.ollama && 'Ollama with a model',
      found.anthropic && 'an Anthropic API key', found.responses && 'an OpenAI API key', found.gemini && 'a Gemini API key'].filter(Boolean);
    lines.push(ready.length ? `Found on this computer: ${ready.join(', ')}. Press Enter for the recommended choice.` : 'Nothing is set up yet. Press Enter to use your Claude plan, or pick another route.');
  }
  const pick = found ? recommended(found) : null;
  lines.push(...visibleChoices(cfg).map(({ key, label, detail }) => `${key}  ${label} - ${detail}${key === pick ? '  (recommended)' : ''}`));
  return lines.join('\n');
}

function tellOllama(out) {
  out('Ollama local setup: install it from https://ollama.com/download, start the Ollama app or server, then run `ollama pull <model>` (for example `ollama pull qwen3.5:9b`). Atlias will list installed models and check the local connection with GET /api/tags. That check sends no prompt and runs no inference.');
}
export async function checkOllamaTags(endpoint, fetchImpl = globalThis.fetch) {
  let base;
  try { base = new URL(endpoint); } catch { return { ok: false, error: 'endpoint must be an absolute URL' }; }
  if (!['http:', 'https:'].includes(base.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.search || base.hash) return { ok: false, error: 'Ollama needs a localhost endpoint without credentials, query parameters or fragments' };
  const target = new URL('/api/tags', base);
  try {
    const response = await fetchImpl(target, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(2500) });
    if (!response.ok) return { ok: false, error: `Ollama returned HTTP ${response.status}` };
    const body = await response.json();
    if (!body || !Array.isArray(body.models)) return { ok: false, error: 'Ollama returned an unexpected model list' };
    return { ok: true, models: body.models.map((model) => model && (model.name || model.model)).filter((name) => typeof name === 'string') };
  } catch (error) { return { ok: false, error: error?.name === 'TimeoutError' ? 'Ollama did not respond before the 2.5 second limit' : 'Ollama connection failed' }; }
}
async function configureOllama({ ask, out, file, fetchImpl, pull = null }) {
  tellOllama(out);
  const current = config().agent;
  const endpoint = await answer(ask, 'Ollama local endpoint [http://127.0.0.1:11434]:', current.ollamaUrl || 'http://127.0.0.1:11434');
  const model = await answer(ask, `Installed model name [${current.ollamaModel || 'gemma3:4b'}]:`, current.ollamaModel || 'gemma3:4b');
  let url;
  try {
    url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) throw Error('use a localhost endpoint without credentials, query parameters or fragments');
    if (!model || /[\r\n\0]/.test(model)) throw Error('enter one installed model name');
  } catch (error) { out(`Ollama settings were not saved: ${error.message}`); return save(file, 'ollama', 'deferred', 'invalid_selection'); }
  const cleanUrl = url.href.replace(/\/$/, '');
  set('agent.ollamaUrl', cleanUrl);
  set('agent.ollamaModel', model);
  const tags = await checkOllamaTags(cleanUrl, fetchImpl);
  if (!tags.ok) {
    out(`${tags.error}. The endpoint and model are saved, but setup is unverified. Start Ollama, pull a model, and run /onboarding to check again.`);
    return save(file, 'ollama', 'deferred', 'connection_unverified', { endpoint: cleanUrl, model });
  }
  if (!tags.models.includes(model) && pull && /^y/i.test(await answer(ask, `${model} is not installed. Download it now with ollama pull? [Y/n]`, 'y'))) {
    if (pull(model)) { const again = await checkOllamaTags(cleanUrl, fetchImpl); if (again.ok) tags.models = again.models; }
  }
  if (!tags.models.includes(model)) {
    out(`Ollama is connected, but ${model} is not installed. Run ollama pull ${model}, then run /onboarding again. No inference was run.`);
    return save(file, 'ollama', 'deferred', 'model_not_installed', { endpoint: cleanUrl, model, installedModels: tags.models });
  }
  set('agent.engine', 'ollama');
  out(`Ollama connection verified; ${model} is installed. Only GET /api/tags was used; no inference was run.`);
  return save(file, 'ollama', 'complete', 'tags_verified', { endpoint: cleanUrl, model });
}

const API = {
  responses: { keyEnv: ['ATLIAS_RESPONSES_API_KEY', 'OPENAI_API_KEY'], modelKey: 'responsesModel', urlKey: 'responsesUrl', url: 'https://api.openai.com/v1', title: 'OpenAI Responses API' },
  anthropic: { keyEnv: ['ANTHROPIC_API_KEY'], modelKey: 'anthropicModel', urlKey: 'anthropicUrl', url: 'https://api.anthropic.com/v1', title: 'Anthropic Messages API' },
  gemini: { keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], modelKey: 'geminiModel', urlKey: 'geminiUrl', url: 'https://generativelanguage.googleapis.com/v1beta', title: 'Google Gemini API' },
  openai: { keyEnv: ['ATLIAS_API_KEY', 'OPENAI_API_KEY'], modelKey: 'openaiModel', urlKey: 'openaiUrl', url: 'https://api.openai.com/v1', title: 'OpenAI-compatible API' },
};
function keyFor(engine) { const names = API[engine].keyEnv; return names.map((name) => process.env[name]).find((key) => typeof key === 'string' && key.trim()) || ''; }
async function checkApi(engine, endpoint, key, fetchImpl) {
  const base = apiUrl(endpoint);
  const pathPart = base.pathname.replace(/\/$/, '');
  const url = new URL(`${pathPart}/models`, base.origin);
  const headers = engine === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` };
  if (engine === 'gemini') url.searchParams.set('key', key);
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(5000) });
    await response.body?.cancel?.();
    return response.ok ? { ok: true } : { ok: false, status: response.status };
  } catch { return { ok: false, status: null }; }
}
async function configureApi(engine, { ask, out, file, fetchImpl }) {
  const spec = API[engine];
  const cfg = config().agent;
  out(`${spec.title} uses its API credential and billing. Never paste a key here. Set ${spec.keyEnv.join(' or ')} in your environment; Atlias reads it locally and does not save it in chat or config.`);
  const endpoint = engine === 'openai' ? await answer(ask, 'API base URL [https://api.openai.com/v1]:', cfg.openaiUrl || spec.url) : cfg[spec.urlKey] || spec.url;
  const model = await answer(ask, `Model identifier [${cfg[spec.modelKey] || 'enter a model'}]:`, cfg[spec.modelKey] || '');
  if (!model || /[\r\n\0]/.test(model)) { out('A model identifier is required. Run /onboarding to finish setup.'); return save(file, engine, 'deferred', 'model_missing'); }
  let cleanUrl;
  try { cleanUrl = apiUrl(endpoint).href.replace(/\/$/, ''); }
  catch (error) { out(`API settings were not saved: ${error.message}`); return save(file, engine, 'deferred', 'invalid_endpoint'); }
  set(`agent.${spec.urlKey}`, cleanUrl);
  set(`agent.${spec.modelKey}`, model);
  const key = keyFor(engine);
  if (!key) {
    out(`No key is set in ${spec.keyEnv.join(' or ')}. Atlias did not ask for or store a key. Set it in your local environment, then run /onboarding. No inference was run.`);
    return save(file, engine, 'deferred', 'key_missing', { endpoint: cleanUrl, model });
  }
  const check = await answer(ask, 'Check access with GET /models? This does not run inference. [y/N]', 'n');
  if (!yes(check)) {
    out('Provider and model are saved; connection remains unverified. Run /onboarding when you want the non-inference GET /models check.');
    return save(file, engine, 'deferred', 'connection_not_checked', { endpoint: cleanUrl, model });
  }
  const result = await checkApi(engine, cleanUrl, key, fetchImpl);
  if (!result.ok) {
    out(`Provider model-list check failed${result.status ? ` with HTTP ${result.status}` : ''}. No inference was run and no fallback was selected. Check endpoint and credentials, then run /onboarding.`);
    return save(file, engine, 'deferred', 'connection_failed', { endpoint: cleanUrl, model, ...(result.status ? { httpStatus: result.status } : {}) });
  }
  set('agent.engine', engine);
  out('Provider responded to GET /models. No model was called. This checks endpoint access, not the selected model entitlement or inference.');
  return save(file, engine, 'complete', 'models_endpoint_verified', { endpoint: cleanUrl, model });
}

async function configureChatGPT({ ask, out, file, engine = planEngine, isPrepared = chatgptPrepared, prepareRuntime = null }) {
  if (!isPrepared() && prepareRuntime && /^y/i.test(await answer(ask, 'The ChatGPT sign-in runtime is not installed. Install it now? [Y/n]', 'y'))) {
    try { prepareRuntime(); } catch { /* checked below */ }
  }
  if (!isPrepared()) {
    out('ChatGPT personal runtime is not installed. Run ' + PREPARE_COMMAND + ' locally to prepare the separate personal SDK, then run /onboarding. No sign-in was attempted.');
    return save(file, 'chatgpt', 'deferred', 'personal_runtime_missing');
  }
  let session;
  try { session = await engine.session(); }
  catch { session = { status: 'disconnected', sharing: false }; }
  if (!(session.status === 'connected' && session.sharing === true)) {
    out('Sign in uses Atlias Personal’s dedicated ChatGPT OAuth consent flow. Credentials stay in its local protected profile; Atlias does not use Codex/Claude credentials or an API key.');
    if (!yes(await answer(ask, 'Sign in with ChatGPT now? Approve plan usage in the official consent flow. [y/N]', 'n'))) {
      out('ChatGPT sign-in skipped. Run /auth chatgpt login, then /onboarding to check setup again.');
      return save(file, 'chatgpt', 'deferred', 'sign_in_skipped');
    }
    try { session = await engine.login(); }
    catch {
      out('ChatGPT sign-in did not finish. Run /auth chatgpt login to try again; no other provider or billing route was selected.');
      return save(file, 'chatgpt', 'deferred', 'sign_in_cancelled_or_failed');
    }
  }
  try { session = await engine.session(); } catch { session = { status: 'disconnected', sharing: false }; }
  if (!(session.status === 'connected' && session.sharing === true)) {
    out('ChatGPT sign-in is not authorized for plan usage. Run /auth chatgpt login and approve plan usage; setup remains deferred.');
    return save(file, 'chatgpt', 'deferred', 'plan_usage_not_authorized');
  }
  let models;
  try { models = await engine.models(); } catch {
    out('ChatGPT sign-in is recorded, but the model catalogue could not be checked. Run /auth chatgpt models, choose a model explicitly with /auth chatgpt use, then rerun /onboarding.');
    return save(file, 'chatgpt', 'deferred', 'model_catalogue_unavailable');
  }
  const wanted = config().agent.chatgptModel;
  const effort = config().agent.chatgptReasoningEffort;
  if (!models.some((model) => model.slug === wanted)) {
    out(`ChatGPT is signed in, but ${wanted} is not in this account's model catalogue. No model was substituted. Use /auth chatgpt models and select an available model with /auth chatgpt use <model> [effort], then run /onboarding.`);
    return save(file, 'chatgpt', 'deferred', 'requested_model_unavailable', { model: wanted, reasoningEffort: effort });
  }
  try { await engine.validate(wanted, effort); }
  catch {
    out(`ChatGPT lists ${wanted}, but reasoning effort ${effort} is not verified for it. No model or effort was changed. Check /auth chatgpt models and run /auth chatgpt use <model> [effort].`);
    return save(file, 'chatgpt', 'deferred', 'requested_model_effort_unavailable', { model: wanted, reasoningEffort: effort });
  }
  set('agent.engine', 'chatgpt');
  out(`ChatGPT plan sign-in and ${wanted} at ${effort} reasoning are verified. This selected Atlias's own loop; no inference was sent.`);
  return save(file, 'chatgpt', 'complete', 'plan_authorized_model_verified', { model: wanted, reasoningEffort: effort });
}

// Run a program in this terminal for an install the person agreed to; windows
// npm and ollama are .cmd shims or plain executables, resolved by the caller.
function runVisible(command, args, spawn = spawnSync) {
  const r = spawn(command.file, [...command.args, ...args], { stdio: 'inherit', windowsHide: false });
  return !r.error && r.status === 0;
}
async function configureClaudePlan({ ask, out, file, claudePlan = claudePlanMod, resolve = (cmd, args) => ({ file: cmd, args }) }) {
  if (!claudePlan.prepared()) {
    out(`Atlias uses the official Claude Agent SDK to reach your Claude plan. It is a one-time install (${claudePlan.INSTALL_SIZE}) into ${claudePlan.runtimeRoot()}.`);
    if (!/^n/i.test(await answer(ask, 'Install it now? [Y/n]', 'y'))) {
      const done = claudePlan.prepare({ npm: resolve('npm', []) });
      if (!done.ok) { out(`The SDK install did not finish (npm exit ${done.exitCode ?? 'unknown'}). Check your connection and run /onboarding or ${claudePlan.SETUP_COMMAND} again. No other route was selected.`); return save(file, 'claude-plan', 'deferred', 'sdk_install_failed'); }
      out('Claude Agent SDK installed.');
    } else { out(`Skipped. Run ${claudePlan.SETUP_COMMAND} or /onboarding when you want it.`); return save(file, 'claude-plan', 'deferred', 'sdk_install_skipped'); }
  }
  let status = claudePlan.planStatus();
  if (!status.plan) {
    out(status.authenticated ? 'You are signed in to Claude with a Console account, which bills an API account. Atlias needs a Claude plan sign-in (Pro or Max).' : 'Sign in with your Claude account. Anthropic\'s own sign-in opens in your browser; Atlias never sees your password or token.');
    if (!/^n/i.test(await answer(ask, 'Sign in with Claude now? [Y/n]', 'y'))) { try { claudePlan.planLogin(); } catch { /* status below decides */ } status = claudePlan.planStatus(); }
  }
  if (!status.plan) { out(`Claude plan sign-in is not verified. Run ${claudePlan.SETUP_COMMAND} or /onboarding to try again. No API key or other route was used.`); return save(file, 'claude-plan', 'deferred', 'plan_sign_in_unverified'); }
  const cfg = config().agent;
  const model = await answer(ask, `Claude model [${cfg.claudePlanModel || claudePlan.MODELS[0]}] (${claudePlan.MODELS.join(', ')}):`, cfg.claudePlanModel || claudePlan.MODELS[0]);
  if (!/^claude-[a-z0-9-]+$/.test(model)) { out('That is not a Claude model name; nothing was changed. Run /onboarding to choose again.'); return save(file, 'claude-plan', 'deferred', 'invalid_model'); }
  const effort = (await answer(ask, `Reasoning effort [${cfg.claudePlanEffort || 'xhigh'}] (${claudePlan.EFFORTS.join(', ')}):`, cfg.claudePlanEffort || 'xhigh')).toLowerCase();
  if (!claudePlan.EFFORTS.includes(effort)) { out(`Effort must be one of ${claudePlan.EFFORTS.join(', ')}; nothing was changed. Run /onboarding to choose again.`); return save(file, 'claude-plan', 'deferred', 'invalid_effort'); }
  set('agent.claudePlanModel', model);
  set('agent.claudePlanEffort', effort);
  set('agent.engine', 'claude-plan');
  out(`Ready: ${model} at ${effort} effort on your Claude plan. Atlias runs every tool itself. Change it any time with /model and /effort.`);
  return save(file, 'claude-plan', 'complete', 'plan_sign_in_verified', { model, effort });
}

// `atlias setup claude` and /auth claude-plan setup: the same steps outside the first-open menu.
export function setupClaudePlan(opts = {}) { return configureClaudePlan({ file: FILE, ...opts }); }

async function configureNative(method, { ask, out, file, nativeAuthStatus, nativeLogin, nativeLogout }) {
  const meta = method === 'codex'
    ? { program: 'codex', install: 'npm install -g @openai/codex', status: 'codex login status', name: 'Codex' }
    : { program: 'claude', install: 'npm install -g @anthropic-ai/claude-code', status: 'claude auth status --json', name: 'Claude Code' };
  out(`${meta.name} is an explicit native host mode. Its own unmodified CLI owns sign-in, credentials, model loop, tools and billing; Atlias never reads, copies or forwards its token.`);
  let status = typeof nativeAuthStatus === 'function' ? await nativeAuthStatus(method) : { available: false, authenticated: false, subscription: false };
  if (!status.available) {
    out(`${meta.name} is unavailable here. Install it with ${meta.install}, sign in using ${meta.program}, then run /onboarding. For Atlias's own loop choose ChatGPT, an API, or Ollama.`);
    return save(file, method, 'deferred', 'native_cli_missing');
  }
  if (!status.authenticated && yes(await answer(ask, `Run ${meta.program}'s native login in this terminal now? Atlias captures no login output or credentials. [y/N]`, 'n'))) {
    try { await nativeLogin?.(method); } catch { /* native status below decides */ }
    status = typeof nativeAuthStatus === 'function' ? await nativeAuthStatus(method) : status;
  }
  if (!status.authenticated) {
    out(`${meta.name} sign-in is not verified. Complete ${meta.program}'s own login, then run /onboarding. No credentials were captured.`);
    return save(file, method, 'deferred', 'native_sign_in_unverified');
  }
  set('agent.engine', method);
  out(`${meta.name} reports an authenticated native account. Check plan, model access and billing in its own client; Atlias did not inspect credentials.`);
  return save(file, method, 'complete', 'native_authentication_reported_billing_unverified');
}

export async function firstOpen({ ask, out = () => {}, force = false, file = FILE, fetchImpl = globalThis.fetch,
  nativeAuthStatus, nativeLogin, nativeLogout, chatgptEngine = planEngine, isChatGPTPrepared = chatgptPrepared,
  claudePlan = claudePlanMod, resolve, prepareChatGPT = null, pullOllama = null, detect = true } = {}) {
  const previous = readOnboarding(file);
  if (!force && previous) {
    if (previous.status === 'deferred') out(`onboarding remains deferred: ${previous.method} (${previous.verification}); run /onboarding to continue setup.`);
    return previous;
  }
  const found = detect ? await detectRoutes({ nativeAuthStatus, claudePlan, isChatGPTPrepared, fetchImpl }) : null;
  const pick = found ? recommended(found) : '3';
  const shown = visibleChoices();
  out(welcomeText(found));
  try {
    const selected = await answer(ask, `Choose ${shown.filter((r) => r.key !== '0').map((r) => r.key).join(', ')} or 0 [${pick}]:`, pick);
    const choice = shown.find((row) => row.key === selected || row.method === selected.toLowerCase()
      || (row.method === 'ollama' && /^i will just use local models using ollama$/i.test(selected)));
    if (!choice) { out('Selection was not recognized; setup remains deferred. Rerun /onboarding to choose.'); return save(file, 'none', 'deferred', 'invalid_selection'); }
    if (choice.method === 'claude-plan') return await configureClaudePlan({ ask, out, file, claudePlan, resolve });
    if (choice.method === 'ollama') return await configureOllama({ ask, out, file, fetchImpl, pull: pullOllama });
    if (choice.method === 'chatgpt') return await configureChatGPT({ ask, out, file, engine: chatgptEngine, isPrepared: isChatGPTPrepared, prepareRuntime: prepareChatGPT });
    if (API[choice.method]) return await configureApi(choice.method, { ask, out, file, fetchImpl });
    if (choice.method === 'claude' || choice.method === 'codex') return await configureNative(choice.method, { ask, out, file, nativeAuthStatus, nativeLogin, nativeLogout });
    if (choice.method === 'antigravity') {
      out('Atlias cannot embed the Antigravity consumer CLI or route its consumer subscription through Atlias. Use the supported Gemini API with its own key and billing, or launch Antigravity as its own app.');
      if (/^y/i.test(await answer(ask, 'Set up the Gemini API now (free keys at https://aistudio.google.com/apikey)? [Y/n]', 'y'))) return await configureApi('gemini', { ask, out, file, fetchImpl });
      return save(file, 'antigravity', 'deferred', 'consumer_embedding_unsupported');
    }
    out('Setup deferred. Run /onboarding to return to this screen.');
    return save(file, 'later', 'deferred', 'user_deferred');
  } catch (error) {
    if (error?.code !== 'ATLIAS_CANCELLED' && error?.name !== 'AbortError') throw error;
    out('Setup cancelled and remains deferred. Run /onboarding when you want to continue.');
    return save(file, 'none', 'deferred', 'cancelled');
  }
}

export const onboardingText = (file = FILE) => {
  const row = readOnboarding(file);
  return row ? `onboarding ${row.status}: ${row.method}; verification ${row.verification}` : 'onboarding not completed; run /onboarding';
};
