import fs from 'node:fs';
import {editionDefaults, claudeOffered, engineOffered, CLAUDE_FOUNDERS_ONLY} from './edition.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config, STATE_DIR, writeJson } from './core.mjs';
import { set } from './settings.mjs';
import { apiUrl } from './provider.mjs';
import { planEngine, prepared as chatgptPrepared, PREPARE_COMMAND } from './chatgpt.mjs';
import * as claudePlanMod from './claude-plan.mjs';
import { hostEnginesAllowed } from './engines.mjs';
import { authFailure } from './auth-command.mjs';

const FILE = path.join(STATE_DIR, editionDefaults()?.onboardingFile || 'onboarding.json');
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
  { key: '1', method: 'claude-plan', label: 'Use my Claude plan (Pro or Max)', detail: 'sign in with your Claude account; no API key needed' },
  { key: '2', method: 'chatgpt', label: 'Sign in with ChatGPT', detail: 'sign in with your ChatGPT account; no API key needed' },
  { key: '3', method: 'ollama', label: 'Local models with Ollama', detail: 'free, runs on this computer; no account needed' },
  { key: '4', method: 'anthropic', label: 'Anthropic API', detail: 'your own Anthropic key, billed by Anthropic' },
  { key: '5', method: 'responses', label: 'OpenAI API', detail: 'your own OpenAI key, billed by OpenAI' },
  { key: '6', method: 'gemini', label: 'Google Gemini API', detail: 'your own Gemini key; free keys at aistudio.google.com' },
  { key: '7', method: 'openai', label: 'OpenAI-compatible API endpoint', detail: 'any service with an OpenAI-style API; your own address and key' },
  { key: '8', method: 'antigravity', label: 'I use Antigravity', detail: 'its own sign-in cannot be shared, so Atlias sets up a Gemini key instead' },
  { key: '9', method: 'claude', label: 'Claude Code native host', detail: 'Claude Code owns its agent loop, sign-in and billing', host: true },
  { key: '10', method: 'codex', label: 'Codex native host', detail: 'Codex owns its agent loop, sign-in and billing', host: true },
  { key: '0', method: 'later', label: 'Set up later', detail: 'come back here any time with /onboarding' },
];
// The release shows no claude-plan, anthropic or claude host row (Gev, 2026-10-29 and 2026-10-30).
export const visibleChoices = (cfg = config().agent, claude = claudeOffered()) => CHOICES.filter((row) => (!row.host || hostEnginesAllowed(cfg)) && engineOffered(row.method, claude));

// What is already on this computer, so the first screen can offer the route
// that works now. Booleans only: no account name, token or key leaves here.
// The release looks for no Claude route: it never asks Claude Code for its sign-in and ignores ANTHROPIC_API_KEY (Gev, 2026-10-30).
export async function detectRoutes({ nativeAuthStatus, claudePlan = claudePlanMod, isChatGPTPrepared = chatgptPrepared, fetchImpl = globalThis.fetch, env = process.env, claude = claudeOffered() } = {}) {
  const cfg = config().agent;
  let claudeSignedIn = false;
  if (claude) {
    try { if (claudePlan.prepared()) claudeSignedIn = claudePlan.planStatus().plan === true; } catch { /* unknown stays false */ }
    if (!claudeSignedIn && typeof nativeAuthStatus === 'function') { try { claudeSignedIn = (await nativeAuthStatus('claude')).subscription === true; } catch { /* unknown */ } }
  }
  const has = (names) => names.some((n) => typeof env[n] === 'string' && env[n].trim());
  const ollama = await checkOllamaTags(cfg.ollamaUrl || 'http://127.0.0.1:11434', fetchImpl).catch(() => ({ ok: false }));
  return { claudePlan: claudeSignedIn, claudeRuntime: claude && Boolean(claudePlan.prepared?.()), chatgpt: Boolean(isChatGPTPrepared()),
    anthropic: claude && Boolean(has(API.anthropic.keyEnv)), responses: has(API.responses.keyEnv), gemini: has(API.gemini.keyEnv), ollama: ollama.ok === true && (ollama.models || []).length > 0 };
}
export function recommended(found = {}, claude = claudeOffered()) {
  if (found.claudePlan && claude) return '1';
  if (found.chatgpt) return '2';
  if (found.anthropic && claude) return '4';
  if (found.responses) return '5';
  if (found.gemini) return '6';
  if (found.ollama) return '3';
  return claude ? '1' : '3';
}

// width: the terminal columns when printing to one. A choice longer than the line is wrapped at a
// space with a hanging indent; left to the terminal, it broke words in half ("(rec" / "ommended)").
export function wrapChoice(line, width, indent = '   ') {
  if (!(width > 20) || line.length < width) return line;
  const out = []; let cur = '';
  for (const word of line.split(' ')) {
    const next = cur ? `${cur} ${word}` : word;
    if (cur && next.length > width - 1) { out.push(cur); cur = `${indent}${word}`; } else cur = next;
  }
  if (cur) out.push(cur);
  return out.join(String.fromCharCode(10));
}
export function welcomeText(found = null, cfg = config().agent, width = 0, full = true, preferred = null, claude = claudeOffered()) {
  const lines = ['Welcome to Atlias. Pick how Atlias reaches an AI model, then describe what you want built.', 'Not sure? Press Enter for the recommended choice. You can change it any time with /onboarding.'];
  if (found) {
    const ready = [claude && found.claudePlan && 'your Claude sign-in', found.chatgpt && 'the ChatGPT sign-in runtime', found.ollama && 'Ollama with a model',
      claude && found.anthropic && 'an Anthropic API key', found.responses && 'an OpenAI API key', found.gemini && 'a Gemini API key'].filter(Boolean);
    lines.push(ready.length ? `Found on this computer: ${ready.join(', ')}.` : (claude ? 'Nothing is set up yet. Press Enter to use your Claude plan, or pick another route.' : 'Nothing is set up yet. Press Enter for local models with Ollama, or pick another route.'));
  }
  const pick = preferred || (found ? recommended(found, claude) : null);
  const intro = lines.map((l) => wrapChoice(l, width, ''));
  // The sign-ins and the local model come first; API keys, which bill the provider directly, sit under their own line.
  const rows = [];
  const shown = visibleChoices(cfg, claude);
  // The heading goes above the first API-key row: 4 in the founders edition, 5 in the release, which has no Anthropic row.
  const firstApi = shown.find((row) => API[row.method])?.key;
  for (const { key, label, detail } of shown) {
    if (!full && !['1', '2', '3', '0', pick].includes(key)) continue;
    if (key === firstApi) rows.push(wrapChoice('Have an API key? These bill your provider account directly:', width, ''));
    rows.push(wrapChoice(`${key}  ${label} - ${detail}${key === pick ? '  (recommended)' : ''}`, width));
  }
  if (!full) rows.push(wrapChoice('a  More connections: API keys and other tools', width));
  return [...intro, ...rows].join('\n');
}

function tellOllama(out) {
  out('Local setup with Ollama');
  out('1. Install Ollama: https://ollama.com/download');
  out('2. Open the Ollama app. If it is not running, start it in another terminal with `ollama serve`.');
  out('3. Download a model with `ollama pull <model>`; for example `ollama pull gemma3:4b`. Pick a model that fits your computer.');
  out('4. Return here to choose an installed model. Atlias checks GET /api/tags only: no inference or prompt is sent.');
}
const modelName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/.test(value);
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
    return { ok: true, models: [...new Set(body.models.map((model) => model && (model.name || model.model)).filter(modelName))].slice(0, 500) };
  } catch (error) { return { ok: false, error: error?.name === 'TimeoutError' ? 'Ollama did not respond before the 2.5 second limit' : 'Ollama connection failed' }; }
}
async function configureOllama({ ask, out, file, fetchImpl, pull = null }) {
  tellOllama(out);
  const current = config().agent;
  const endpoint = await answer(ask, 'Ollama local endpoint [http://127.0.0.1:11434]:', current.ollamaUrl || 'http://127.0.0.1:11434');
  let url;
  try {
    url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) throw Error('use a localhost endpoint without credentials, query parameters or fragments');
  } catch (error) { out(`Ollama settings were not saved: ${error.message}`); return save(file, 'ollama', 'deferred', 'invalid_selection'); }
  const cleanUrl = url.href.replace(/\/$/, '');
  const tags = await checkOllamaTags(cleanUrl, fetchImpl);
  if (tags.ok && tags.models.length) {
    out('Installed models:');
    tags.models.forEach((name, index) => out(`${index + 1}  ${name}`));
  } else if (tags.ok) out('Ollama is running, but no installed models were found. Complete the download step above, then retry.');
  const fallback = tags.ok && tags.models.length ? (tags.models.includes(current.ollamaModel) ? current.ollamaModel : tags.models[0]) : current.ollamaModel || 'gemma3:4b';
  const selected = await answer(ask, `Choose an installed model number or name [${fallback}]:`, fallback);
  const model = tags.ok && /^\d+$/.test(selected) ? tags.models[Number(selected) - 1] || selected : selected;
  if (!modelName(model)) {
    out('Enter one model name without spaces or shell commands. Ollama settings were not changed.');
    return save(file, 'ollama', 'deferred', 'invalid_selection');
  }
  if (!tags.ok) {
    out(`${tags.error}. The endpoint and model are saved as a setup draft; your active connection is unchanged. Start Ollama, pull a model, and run /onboarding to check again.`);
    return save(file, 'ollama', 'deferred', 'connection_unverified', { endpoint: cleanUrl, model });
  }
  if (!tags.models.includes(model) && pull && /^y/i.test(await answer(ask, `${model} is not installed. Download it now with ollama pull? [Y/n]`, 'y'))) {
    if (pull(model)) { const again = await checkOllamaTags(cleanUrl, fetchImpl); if (again.ok) tags.models = again.models; }
  }
  if (!tags.models.includes(model)) {
    out(`Ollama is connected, but ${model} is not installed. Run ollama pull ${model}, then run /onboarding again. No inference was run.`);
    return save(file, 'ollama', 'deferred', 'model_not_installed', { endpoint: cleanUrl, model, installedModels: tags.models });
  }
  set('agent.ollamaUrl', cleanUrl);
  set('agent.ollamaModel', model);
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
// The model names an engine really offers, so a typed name is checked before it is saved (Gev 2026-10-24:
// "atlias lets you type anything to be a model"). Claude plan: the Claude models the plan reaches. Ollama: the
// models pulled on that server. An API: the provider's own model list, read with the key in the environment.
export const CLAUDE_PLAN_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
export async function listModels(engine, { cfg = config().agent, fetchImpl = globalThis.fetch } = {}) {
  if (engine === 'claude-plan') return { ok: true, models: CLAUDE_PLAN_MODELS };
  if (engine === 'ollama') {
    const tags = await checkOllamaTags(cfg.ollamaUrl || 'http://127.0.0.1:11434', fetchImpl).catch(() => ({ ok: false }));
    return tags.ok ? { ok: true, models: tags.models || [] } : { ok: false, reason: `Ollama did not answer at ${cfg.ollamaUrl || 'http://127.0.0.1:11434'}; start it, then try again` };
  }
  const spec = API[engine];
  if (!spec) return { ok: false, reason: `engine ${engine} has no model list` };
  const key = keyFor(engine);
  if (!key) return { ok: false, reason: `no key in ${spec.keyEnv.join(' or ')}, so the model list cannot be read` };
  try {
    const base = apiUrl(cfg[spec.urlKey] || spec.url);
    const url = new URL(`${base.pathname.replace(/\/$/, '')}/models`, base.origin);
    const headers = engine === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` };
    if (engine === 'gemini') url.searchParams.set('key', key);
    const res = await fetchImpl(url, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, reason: `${spec.title} answered ${res.status} for its model list` };
    const body = await res.json();
    const rows = engine === 'gemini' ? (body.models || []).map((m) => String(m.name || '').replace(/^models\//, '')) : (body.data || []).map((m) => String(m.id || ''));
    return { ok: true, models: rows.filter(Boolean) };
  } catch { return { ok: false, reason: `${spec.title} could not be reached for its model list` }; }
}
export async function checkModel(engine, name, opts = {}) {
  const want = String(name || '').trim();
  if (!want || /[\s\0]/.test(want)) return { ok: false, message: 'a model name has no spaces; nothing changed' };
  const list = await listModels(engine, opts);
  if (!list.ok) return { ok: false, message: `could not check that model: ${list.reason}. Nothing changed.` };
  if (list.models.includes(want)) return { ok: true, model: want };
  const close = list.models.filter((m) => m.toLowerCase().includes(want.toLowerCase().split(/[:/-]/)[0])).slice(0, 5);
  const shown = (close.length ? close : list.models.slice(0, 8)).join(', ') || 'none found';
  return { ok: false, message: `${want} is not a model this engine offers. Choose one of: ${shown}. Nothing changed.`, models: list.models };
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
  const key = keyFor(engine);
  if (!key) {
    out(`No key is set in ${spec.keyEnv.join(' or ')}. Atlias did not ask for or store a key. Set it in your local environment, then run /onboarding. No inference was run.`);
    return save(file, engine, 'deferred', 'key_missing', { endpoint: cleanUrl, model });
  }
  const check = await answer(ask, 'Check access with GET /models? This does not run inference. [y/N]', 'n');
  if (!yes(check)) {
    out('Connection draft saved; your active provider settings are unchanged. Run /onboarding when you want the non-inference GET /models check.');
    return save(file, engine, 'deferred', 'connection_not_checked', { endpoint: cleanUrl, model });
  }
  const result = await checkApi(engine, cleanUrl, key, fetchImpl);
  if (!result.ok) {
    out(`Provider model-list check failed${result.status ? ` with HTTP ${result.status}` : ''}. No inference was run and no fallback was selected. Check endpoint and credentials, then run /onboarding.`);
    return save(file, engine, 'deferred', 'connection_failed', { endpoint: cleanUrl, model, ...(result.status ? { httpStatus: result.status } : {}) });
  }
  const listed = await checkModel(engine, model, { cfg: { ...cfg, [spec.urlKey]: cleanUrl }, fetchImpl });
  if (!listed.ok) {
    out(listed.message.replace('Nothing changed.', 'Run /onboarding or /model to pick one.'));
    return save(file, engine, 'deferred', 'model_not_offered', { endpoint: cleanUrl, model });
  }
  set(`agent.${spec.urlKey}`, cleanUrl);
  set(`agent.${spec.modelKey}`, model);
  set('agent.engine', engine);
  out('Provider responded to GET /models and lists that model. No model was called.');
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
    out('Sign in uses Atlias Personal\'s dedicated ChatGPT OAuth consent flow. Credentials stay in its local protected profile; Atlias does not use Codex/Claude credentials or an API key.');
    if (!yes(await answer(ask, 'Sign in with ChatGPT now? Approve plan usage in the official consent flow. [y/N]', 'n'))) {
      out('ChatGPT sign-in skipped. Run /auth chatgpt login, then /onboarding to check setup again.');
      return save(file, 'chatgpt', 'deferred', 'sign_in_skipped');
    }
    out('Keep this terminal open while completing sign-in in your browser. The request expires after 10 minutes. If verification is unavailable, cancel and choose local models or finish later.');
    try { session = await engine.login(); }
    catch (error) {
      out(authFailure(error));
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
  let wanted = config().agent.chatgptModel;
  let effort = config().agent.chatgptReasoningEffort;
  if (!models.some((model) => model.slug === wanted)) {
    out(`ChatGPT is signed in, but ${wanted} is not available to this account.`);
    const available = models.filter(model => modelName(model?.slug));
    available.forEach((model, index) => out(`${index + 1}  ${model.slug}`));
    const selected = await answer(ask, 'Choose an available model number or name, or press Enter to keep setup for later:', '');
    const chosen = /^\d+$/.test(selected) ? available[Number(selected) - 1]?.slug : selected;
    if (!available.some(model => model.slug === chosen)) {
      out('No model was substituted. Run /onboarding whenever you are ready to choose.');
      return save(file, 'chatgpt', 'deferred', 'requested_model_unavailable', { model: wanted, reasoningEffort: effort });
    }
    wanted = chosen;
    effort = await answer(ask, 'Reasoning effort [model = provider default]:', 'model');
  }
  try { await engine.validate(wanted, effort); }
  catch {
    out(`ChatGPT lists ${wanted}, but reasoning effort ${effort} is not verified for it. No model or effort was changed. Check /auth chatgpt models and run /auth chatgpt use <model> [effort].`);
    return save(file, 'chatgpt', 'deferred', 'requested_model_effort_unavailable', { model: wanted, reasoningEffort: effort });
  }
  set('agent.chatgptModel', wanted);
  set('agent.chatgptReasoningEffort', effort);
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
async function configureClaudePlan({ ask, out, file, claudePlan = claudePlanMod }) {
  if (!claudePlan.prepared()) {
    out(`Atlias uses the official Claude Agent SDK to reach your Claude plan. It is a one-time install (${claudePlan.INSTALL_SIZE}) into ${claudePlan.runtimeRoot()}.`);
    if (!/^n/i.test(await answer(ask, 'Install it now? [Y/n]', 'y'))) {
      const done = claudePlan.prepare();
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
export function setupClaudePlan(opts = {}) {
  if (!claudeOffered(opts.edition === undefined ? editionDefaults() : opts.edition)) { (opts.out || (() => {}))(CLAUDE_FOUNDERS_ONLY); return Promise.resolve({ method: 'claude-plan', status: 'unavailable', verification: 'release_edition' }); }
  return configureClaudePlan({ file: FILE, ...opts });
}

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
  claudePlan = claudePlanMod, resolve, prepareChatGPT = null, pullOllama = null, detect = true, edition = editionDefaults() } = {}) {
  const previous = readOnboarding(file);
  if (!force && previous) {
    if (previous.status === 'deferred') out(`onboarding remains deferred: ${previous.method} (${previous.verification}); run /onboarding to continue setup.`);
    return previous;
  }
  const claude = claudeOffered(edition);
  const found = detect && !edition ? await detectRoutes({ nativeAuthStatus, claudePlan, isChatGPTPrepared, fetchImpl, claude }) : null;
  const pick = edition?.preferredEngine === 'claude-plan' ? '1' : found ? recommended(found, claude) : '3';
  const shown = visibleChoices(config().agent, claude);
  try {
    let choice, full = false;
    for (;;) {
      let result;
      if (!choice) {
        out(welcomeText(found, config().agent, process.stdout.isTTY ? process.stdout.columns : 0, full, edition ? pick : null, claude));
        const selected = await answer(ask, `Choose a connection [${pick}], a for more, or 0 to finish later: `, pick);
        if (selected.toLowerCase() === 'a') { full = true; continue; }
        choice = shown.find((row) => row.key === selected || row.method === selected.toLowerCase()
          || (row.method === 'ollama' && /^local models with ollama$/i.test(selected)));
      }
      if (!choice) {
        out('That is not one of the numbers on the list. Choose c to see the list again.');
        result = save(file, 'none', 'deferred', 'invalid_selection');
      } else if (choice.method === 'claude-plan') result = await configureClaudePlan({ ask, out, file, claudePlan });
      else if (choice.method === 'ollama') result = await configureOllama({ ask, out, file, fetchImpl, pull: pullOllama });
      else if (choice.method === 'chatgpt') result = await configureChatGPT({ ask, out, file, engine: chatgptEngine, isPrepared: isChatGPTPrepared, prepareRuntime: prepareChatGPT });
      else if (API[choice.method]) result = await configureApi(choice.method, { ask, out, file, fetchImpl });
      else if (choice.method === 'claude' || choice.method === 'codex') result = await configureNative(choice.method, { ask, out, file, nativeAuthStatus, nativeLogin, nativeLogout });
      else if (choice.method === 'antigravity') {
        out('Atlias cannot embed the Antigravity consumer CLI or route its consumer subscription through Atlias. Use the supported Gemini API with its own key and billing, or launch Antigravity as its own app.');
        if (/^y/i.test(await answer(ask, 'Set up the Gemini API now (free keys at https://aistudio.google.com/apikey)? [Y/n]', 'y'))) result = await configureApi('gemini', { ask, out, file, fetchImpl });
        else result = save(file, 'antigravity', 'deferred', 'consumer_embedding_unsupported');
      } else {
        out('Setup deferred. Run /onboarding to return to this screen, or /auth to add a connection later.');
        return save(file, 'later', 'deferred', 'user_deferred');
      }
      if (result.status === 'complete') {
        out('Connection saved. Try: Explain this project. Or describe what you want built or fixed, then press Enter. /help lists commands.');
        return result;
      }
      const recovery = String(await ask('Setup is not complete. [r] Retry  [c] Choose another connection  [l] Use local models  [Enter] Finish later:') ?? '').trim().toLowerCase();
      if (recovery === 'l') choice = CHOICES.find(row => row.method === 'ollama');
      else if (recovery === 'c') choice = null;
      else if (recovery !== 'r' || !choice) {
        out('Your setup progress is saved. Use /onboarding to continue later.');
        return result;
      }
    }
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
