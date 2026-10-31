import {editionDefaults, claudeOffered, engineOffered, offeredEngines, CLAUDE_FOUNDERS_ONLY} from './edition.mjs';
import { accountUsage } from './account-usage.mjs';
import * as rewind from './rewind.mjs';
// The repl's slash commands, in one registry. Gev (2026-10-17): a command registry with /help
// listing every command from the same table that runs it, so a command cannot be added without
// being listed or listed without existing. Interactive only: nothing here is reached by
// `atlias exec`, `atlias eval`, tools/h2h/atlias_task.mjs or runLoop.
//
// A command is { name, usage, help, run(args, ctx), source }. ctx is { state, cwd, out, ask, api }:
// api carries the few repl functions a command calls (statusText, turn, saveChat, ...), passed in by
// lib/agent.mjs so this file does not import it back.
//
// Custom commands are markdown files (the common command-file format): .atlias/commands/*.md in the project and
// commands/*.md in the Atlias home. A subfolder names a namespace (a/b.md is /a:b). The body is the
// prompt; $ARGUMENTS and $1..$9 are replaced by what follows the command; with no $ARGUMENTS in the
// body, the arguments are appended. A built-in always wins a name, and the project wins over the home.
import fs from 'node:fs';
import * as permissions from './permissions.mjs';
import { MODEL_KEYS, EFFORT_KEYS, DIRECT_ENGINES, engineLine, hostEnginesAllowed } from './engines.mjs';
import { selectSubagentRoute, routeLabel } from './subagent-routing.mjs';
import { CHOICES as SETTING_CHOICES } from './core.mjs';
import { planEngine } from './chatgpt.mjs';
import { authCommand } from './auth-command.mjs';
import * as onboarding from './onboarding.mjs';
import * as goals from './goals.mjs';
import * as relay from './relay.mjs';
import * as selectionCopy from './selection-copy.mjs';
import path from 'node:path';
import { ROOT, writeLauncher, config, STATE_DIR, claudeMemoryDir, readText, clip } from './core.mjs';
import { colorMode, accent, dim } from './logo.mjs';
import * as settings from './settings.mjs';
import * as skills from './skills.mjs';
import * as graph from './graph.mjs';
import * as progress from './progress.mjs';
import * as hosts from './hosts.mjs';
import * as extra from './hosts-extra.mjs';
import * as loop from './loop.mjs';
import * as research from './research.mjs';
import * as importer from './import.mjs';
import * as updater from './update.mjs';
import * as qol from './qol.mjs';
import * as shortcut from './shortcut.mjs';
import { recall } from '../mcp/tools.mjs';

const c = (s) => accent(s, colorMode());
const d = (s) => dim(s, colorMode());

function copyOnSelectConfigLine(hostOptions) {
  const status = selectionCopy.copyOnSelectStatus(hostOptions);
  const value = !status.supported ? 'unsupported' : status.error ? 'unavailable' : JSON.stringify(status.value);
  return `ui.copyOnSelect  ${value}\n      ${status.text}\n      set with /config ui.copyOnSelect true|false; reset with /config reset ui.copyOnSelect`;
}

async function setCopyOnSelect(enabled, { ask, out, api = {} }) {
  if (['plan', 'read-only'].includes(config().agent.permissions)) return out('Terminal settings changes are disabled in this permission mode.');
  const hostOptions = api.copyOnSelectOptions || {};
  const pending = selectionCopy.copyOnSelectStatus(hostOptions);
  if (!pending.supported || pending.error) return out(pending.text);
  const action = enabled ? 'on' : 'off';
  const accepted = String(await ask(`This changes Windows Terminal's host-wide setting for every profile. When on, selecting text copies immediately and right-click pastes. Set it ${action}? [y/N] `) || '').trim();
  if (!/^y(?:es)?$/i.test(accepted)) return out('copy-on-select unchanged.');
  out(selectionCopy.configureCopyOnSelect(enabled, hostOptions).text);
}

export const CUSTOM_MAX_BYTES = 20000;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const LINE_RE = /^\/([A-Za-z][\w:.-]*)(?:\s+([\s\S]*))?$/;

// '/name rest' -> { name, args }. A line that is a path (/usr/bin/x) or not a slash line is null, so it
// goes to the model as the sentence it is. '//text' is handled by the caller as an escape.
export function parseLine(line) {
  const m = LINE_RE.exec(String(line || '').trim());
  return m ? { name: m[1], args: (m[2] || '').trim() } : null;
}

// ---------- custom commands ----------
export function customDirs(cwd, home = STATE_DIR) {
  return [{ dir: path.join(home, 'commands'), source: 'home' }, { dir: path.join(cwd, '.atlias', 'commands'), source: 'project' }];
}
function scan(dir, source, prefix, out, skipped, depth) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth === 0 && NAME_RE.test(e.name)) { scan(p, source, e.name + ':', out, skipped, 1); continue; }
    if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
    const base = e.name.replace(/\.md$/i, '');
    if (!NAME_RE.test(base)) { skipped.push({ file: p, why: 'the file name is not a command name (letters, digits, - and _)' }); continue; }
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.size > CUSTOM_MAX_BYTES) { skipped.push({ file: p, why: `over ${CUSTOM_MAX_BYTES} bytes` }); continue; }
    const text = readText(p);
    if (text == null) continue;
    const front = skills.parseFrontmatter(text);
    const body = text.replace(/^ï»¿/, '').replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '').trim();
    if (!body) { skipped.push({ file: p, why: 'the file has no prompt text' }); continue; }
    out.push({ name: prefix + base, source, file: p, body, help: String(front.description || '').replace(/\s+/g, ' ').trim() || clip(body.split(/\r?\n/)[0], 70), hint: String(front['argument-hint'] || '').trim() });
  }
}
// { list, skipped }: project entries replace home entries of the same name. Read at each call, so an edit
// to a file shows on the next line typed.
export function loadCustom(cwd, home = STATE_DIR) {
  const byName = new Map();
  const skipped = [];
  for (const { dir, source } of customDirs(cwd, home)) {
    const found = [];
    scan(dir, source, '', found, skipped, 0);
    for (const cmd of found) byName.set(cmd.name, cmd);
  }
  return { list: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), skipped };
}
export function expand(body, args) {
  const words = String(args || '').split(/\s+/).filter(Boolean);
  let used = false;
  let text = body.replace(/\$ARGUMENTS|\$([1-9])/g, (m, n) => { used = true; return n ? (words[Number(n) - 1] || '') : args; });
  if (!used && args) text += `\n\nARGUMENTS: ${args}`;
  return text;
}

// ---------- helpers ----------
// Replace what a state object holds without replacing the object, so the repl's variable follows.
export function replaceState(target, source) {
  for (const k of Reflect.ownKeys(target)) delete target[k];
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(source));
  return target;
}
function row(label, value) { return `${label.padEnd(14)} ${value}`; }
function exportText(state) {
  const names = { user: 'You', assistant: 'Atlias', gate: 'Atlias gate (generated)', review: 'Review request (generated)' };
  const L = [`# Atlias session ${state.sid}`, '', `Engine ${state.engine}. Project ${state.cwd}. Exported ${new Date().toISOString()}.`, ''];
  for (const h of state.history || []) L.push(`## ${names[h.role] || h.role}`, '', String(h.text || ''), '');
  return L.join('\n');
}

// ---------- the built-in commands ----------
const prompt = async (text, ctx) => { ctx.out('\n' + (await ctx.api.turn(ctx.state, text, ctx.ask, ctx.out)) + '\n'); ctx.api.saveChat(ctx.state); };

export const BUILTINS = [
  { name: 'btw', usage: '/btw <question>', help: 'ask an ephemeral question about this conversation without tools or history writes', run: async (a, { state, out, api }) => {
    if (!a.trim()) return out('Use /btw <question>.');
    if (api.showBtw) await api.showBtw(a);
    else out(await api.btw(state, a));
  } },
  { name: 'queue', usage: '/queue [edit N text|remove N]', help: 'list, edit or remove pending terminal messages before they start', run: (a, { out, api }) => api.queueCommand ? api.queueCommand(a) : out('Queue controls need the terminal composer.') },
  { name: 'relay', usage: '/relay [on|off|status|cancel <id>|at <ISO time> <next step>|after-reset <ISO reset> <next step>]', help: 'save and automatically continue this task later, with the same session and connection', run: (a, ctx) => {
    try {
      const words = a.trim().split(/\s+/); const action = words.shift() || 'status';
      if (['on','off'].includes(action)) {
        if (['read-only','plan'].includes(config().agent.permissions)) return ctx.out('Relay settings cannot change in this permission mode.');
        settings.set('agent.relay', action); return ctx.out('Relay ' + action + (action === 'on' ? '. The main model can schedule a saved-session continuation. Windows Task Scheduler is required.' : '. Pending wakes will exit without calling a model.'));
      }
      if (!['status','cancel','at','after-reset'].includes(action)) return ctx.out('Use /relay on, off, status, cancel <id>, at <ISO time> <next step>, or after-reset <ISO reset> <next step>.');
      const args = action === 'cancel' ? {action:'cancel',id:words[0]} : ['at','after-reset'].includes(action) ? {action:'schedule',[action === 'at' ? 'at' : 'reset_at']:words.shift(),next_step:words.join(' ')} : {action:'status'};
      let result = relay.relayAction(ctx.cwd, args, {state:ctx.state,save:()=>ctx.api.saveChat(ctx.state)});
      if (args.action === 'schedule') { ctx.state.relayRequested = false; ctx.api.saveChat(ctx.state); result = relay.relayAction(ctx.cwd, {action:'status'}).jobs.find(j => j.id === result.id) || result; }
      ctx.out(JSON.stringify(result,null,2));
    } catch(error) { ctx.out(error.message); }
  } },
  { name: 'shortcut', usage: '/shortcut [status|install]', help: 'install or inspect the terminal command', run: (a, { out }) => {
    if (a && !['status', 'install'].includes(a)) { out('usage: /shortcut [status|install]'); return; }
    if (a === 'install') {
      if (['plan', 'read-only'].includes(config().agent.permissions)) { out('Terminal installation is disabled in this permission mode.'); return; }
      writeLauncher(ROOT);
      for (const line of shortcut.installShortcut().lines) out(line);
    } else out('terminal command: ' + (shortcut.whichAtlias() || 'not installed; /shortcut install adds this copy'));
  } },
  { name: 'help', usage: '/help [command or search]', help: 'find commands, usage and examples', run: (a, { out, cwd, home, inputMode }) => out(helpText(cwd, home || STATE_DIR, a, { inputMode })) },
  { name: 'attachments', usage: '/attachments [clear]', help: 'inspect images in this chat or clear them from future requests', run: (a, { state, out, api = {} }) => {
    if (a && a !== 'clear') return out('Usage: /attachments [clear]. Nothing changed.');
    const images = (state.messages || []).flatMap((m, i) => (m._images || []).map(image => ({ ...image, message: i + 1 })));
    if (a === 'clear') {
      let count = 0;
      for (const m of state.messages || []) {
        count += (m._images || []).length; delete m._images;
        if (Array.isArray(m.content)) { const before = m.content.length; m.content = m.content.filter(p => !['input_image', 'image_url'].includes(p?.type)); count += before - m.content.length; }
      }
      if (api.saveChat) api.saveChat(state);
      return out(`Cleared ${count} image${count === 1 ? '' : 's'} from future requests. Text and reference files remain. This chat is saved with the change.`);
    }
    const cfg = config().attachments;
    out([images.length ? images.map(i => `message ${i.message}: ${i.name || 'image'} (${i.mimeType}, ${Buffer.byteLength(i.data, 'base64')} bytes, detail ${i.detail})`).join('\n') : 'No images attached to this chat.', 'Attach a project image with @image.png or @"image with spaces.png". PNG, JPEG and WebP are supported on direct model connections with vision support.', `Images ${cfg.enabled ? 'enabled' : 'disabled'}; up to ${cfg.maxImages} per message, ${cfg.maxFileBytes} bytes per file. /settings then /attachments finds these options.`, '/attachments clear removes image payloads from future requests. Provider-reported token counts are authoritative.'].join('\n'));
  } },
  { name: 'agents', usage: '/agents [inherit|engine [model]|on|off]', help: 'choose the connection and model used by workers', run: async (a, { out, state, api = {} }) => {
    const cfg = config().agent;
    if (!a) {
      let route;
      try { route = selectSubagentRoute(state.engine, {}, cfg); }
      catch (error) { return out(`Worker setting is invalid: ${error.message} Use /agents inherit to reset it.`); }
      const have = api.detectEngines ? api.detectEngines() : {};
      return out(`Subagents: ${cfg.subagents}\nDefault: ${cfg.subagentEngine === 'inherit' ? 'follow the main connection; ' : ''}${routeLabel(route)}\nConnections: ${DIRECT_ENGINES.filter((e) => have[e]).join(', ') || 'use /auth or /onboarding to connect one'}\n/agents chatgpt <model> chooses a worker default. /agents inherit follows the main agent.\nYou can also request a model and connection in a task. A different connection asks before launch; main /effort max or /permissions max skips that approval. Other permissions still apply.`);
    }
    if (['plan', 'read-only'].includes(cfg.permissions)) return out('Worker settings cannot change in this permission mode.');
    const [engine, model = '', ...extra] = a.trim().split(/\s+/);
    if (extra.length || (!['inherit', 'on', 'off', ...DIRECT_ENGINES].includes(engine)) || (['inherit', 'on', 'off'].includes(engine) && model)) return out('Usage: /agents [inherit|engine [model]|on|off]. Nothing changed.');
    if (!engineOffered(engine)) return out(CLAUDE_FOUNDERS_ONLY);
    if (['on', 'off'].includes(engine)) return out(settings.set('agent.subagents', engine).text);
    if (engine !== 'inherit') {
      if (api.detectEngines && !api.detectEngines()[engine]) return out(`${engine} is not connected. Set it up with /auth or /onboarding first. Nothing changed.`);
      const want = model || cfg[MODEL_KEYS[engine]];
      if (engine === 'chatgpt') {
        try { await planEngine.validate(want, cfg.chatgptReasoningEffort); } catch { return out('ChatGPT model not verified for this account; /auth chatgpt models. Nothing changed.'); }
      } else {
        const checked = await onboarding.checkModel(engine, want, { cfg });
        if (!checked.ok) return out(checked.message);
      }
    }
    out(settings.set('agent.subagentEngine', engine).text);
    out(model ? settings.set('agent.subagentModel', model).text : settings.reset('agent.subagentModel').text);
    out('Worker default saved. The main model is unchanged. Approval is requested when a worker uses a different connection, except at main effort max or permissions max.');
  } },
  { name: 'auth', get usage() { return `/auth [${offeredEngines(['claude-plan', 'chatgpt', 'claude', 'codex']).join('|')}] [action]`; }, help: 'direct provider sign-in and native host authentication status', run: (a, ctx) => authCommand(a, { ...ctx, api: { ...(ctx.api || {}), ask: ctx.ask, setupClaudePlan: (o) => onboarding.setupClaudePlan({ resolve: ctx.api?.resolveCommand, ...o }) } }) },
  { name: 'connect', usage: '/connect', help: 'add or change a model connection, including your own API endpoint', run: (_a, ctx) => BUILTINS.find(command => command.name === 'onboarding').run('', ctx) },
  { name: 'connections', usage: '/connections', help: 'inspect model connections and API-key setup without showing secrets', run: (_a, { out, state }) => {
    const cfg = config().agent;
    // The release lists no Anthropic API and no Claude sign-in (Gev, 2026-10-30).
    const claude = claudeOffered();
    const routes = [
      ['OpenAI API', 'responses', cfg.responsesModel, ['ATLIAS_RESPONSES_API_KEY', 'OPENAI_API_KEY']],
      ['Anthropic API', 'anthropic', cfg.anthropicModel, ['ANTHROPIC_API_KEY']],
      ['Gemini API', 'gemini', cfg.geminiModel, ['GEMINI_API_KEY', 'GOOGLE_API_KEY']],
      ['Custom OpenAI-compatible API', 'openai', cfg.openaiModel, ['ATLIAS_API_KEY', 'OPENAI_API_KEY']],
    ].filter(([, engine]) => engineOffered(engine, claude));
    out([`Current connection: ${state.engine}`, ...routes.map(([title, engine, model, keys]) => `${title}: ${model || 'model not selected'}; ${keys.some(key => Boolean(process.env[key]?.trim())) ? 'key available locally' : 'set ' + keys.join(' or ')}${state.engine === engine ? ' (selected)' : ''}`), `${claude ? 'Claude and ChatGPT subscriptions' : 'ChatGPT subscription'}: /auth checks sign-in. Local models: /connect offers Ollama.`, '/connect opens setup. API keys stay in your local environment; never paste one into this chat.'].join('\n'));
  } },
  { name: 'onboarding', usage: '/onboarding', help: 'reopen first-open provider and local-model setup', run: async (_a, { ask, out, state, api }) => {
    if (['plan', 'read-only'].includes(config().agent.permissions)) return out('Provider setup is disabled in this permission mode. Switch to workspace or ask mode, then run /onboarding.');
    const row = await onboarding.firstOpen({ ask, out, force: true, ...(api.setupHelpers ? api.setupHelpers() : { nativeAuthStatus: api.nativeAuthStatus, nativeLogin: api.nativeLogin }) });
    out(onboarding.onboardingText());
    if (row.status === 'deferred') {
      state.engine = 'setup'; state.started = false; state.messages = []; state.textTools = false;
      if (api.saveChat) api.saveChat(state);
      out('Setup remains deferred or unverified. Finish the listed provider steps, then run /onboarding again; this session will not continue through its previous host engine.');
    }
    if (row.status === 'complete' && row.method !== 'later') {
      const next = config().agent.engine;
      if (next && state.engine !== next) { state.engine = next; state.started = false; state.messages = []; state.textTools = false; if (api.saveChat) api.saveChat(state); out(`New conversation uses ${next}.`); }
    }
  } },
  { name: 'goals', usage: '/goals [status|create|continue --rounds N|update|pause|resume|complete|defer]', help: 'manage this project\'s persistent, check-grounded goal', run: async (a, ctx) => runGoalCommand(a, ctx) },
  { name: 'goal', usage: '/goal [status|create|continue --rounds N|update|pause|resume|complete|defer]', help: 'alias for /goals', run: async (a, ctx) => runGoalCommand(a, ctx) },
  { name: 'copy-on-select', usage: '/copy-on-select [status|on|off]', help: 'configure Windows Terminal copy-on-select for every profile', run: async (a, ctx) => {
    const action = a.trim().toLowerCase() || 'status';
    const { out, api = {} } = ctx;
    const hostOptions = api.copyOnSelectOptions || {};
    if (action === 'status') return out(selectionCopy.copyOnSelectStatus(hostOptions).text);
    if (!['on', 'off'].includes(action)) return out('usage: /copy-on-select [status|on|off]');
    await setCopyOnSelect(action === 'on', ctx);
  } },
  { name: 'engine', get usage() { return `/engine ${offeredEngines(['claude-plan', 'chatgpt', 'responses', 'anthropic', 'gemini', 'openai', 'ollama', 'claude', 'codex', 'echo']).join('|')}`; }, help: 'choose direct model or explicitly labelled host harness', run: (a, { state, out, api }) => {
    if (!a) return out(engineLine(state.engine, config().agent));
    if (!engineOffered(a)) return out(c(CLAUDE_FOUNDERS_ONLY));
    if (['claude', 'codex'].includes(a) && !hostEnginesAllowed(config().agent)) return out(c(`the ${a} host harness is off: Atlias runs the model itself. ${claudeOffered() ? "/engine claude-plan uses your Claude plan in Atlias's own loop; " : ""}atlias config set agent.hostEngines on allows host harnesses. Nothing changed.`));
    const picked = api.pickEngine ? api.pickEngine(a) : api.detectEngines()[a] ? a : null;
    if (picked) { state.engine = picked; state.started = false; state.messages = []; state.textTools = false; out(d(engineLine(picked, config().agent) + '; new conversation')); } else out(c(`engine ${a} is not available or auto is ambiguous; /auth and /onboarding show setup. No fallback was selected.`));
  } },
  { name: 'model', usage: '/model [name]', help: 'show or select the direct engine model', run: async (a, { state, out }) => {
    const cfg = config().agent;
    const key = MODEL_KEYS[state.engine];
    if (!key) return out(a ? `the ${state.engine} engine picks its own model; atlias does not pass one to it` : state.engine === 'echo' ? 'engine echo has no model' : `engine ${state.engine}: the ${state.engine} program picks the model; atlias does not pass one to it`);
    if (!a) return out(`engine ${state.engine}   model ${cfg[key] || '(not set: atlias config set agent.' + key + ' <model>)'}`);
    if (state.engine === 'chatgpt') {
      try { await planEngine.validate(a, cfg.chatgptReasoningEffort); } catch { return out('ChatGPT model/effort not verified for this account; /auth chatgpt models. Nothing changed.'); }
    } else {
      const checked = await onboarding.checkModel(state.engine, a, { cfg });
      if (!checked.ok) return out(checked.message);
    }
    out(settings.set(`agent.${key}`, a.trim()).text + d('   saved in the atlias config, so it applies to every session'));
  } },
  { name: 'effort', usage: '/effort [low|medium|high|xhigh|max|model]', help: 'show or set the reasoning effort of the current engine', run: async (a, { state, out }) => {
    const key = EFFORT_KEYS[state.engine];
    if (!key) return out(`engine ${state.engine} takes no reasoning effort from atlias`);
    const cfg = config().agent;
    const allowed = (SETTING_CHOICES.agent || {})[key] || [];
    if (!a) return out(`engine ${state.engine}   effort ${cfg[key]}   (choices: ${allowed.join(', ')})`);
    const want = a.trim().toLowerCase();
    if (!allowed.includes(want)) return out(`effort ${want} is not one of ${allowed.join(', ')}; nothing changed`);
    if (state.engine === 'chatgpt') {
      try { await planEngine.validate(cfg.chatgptModel, want); } catch { return out('ChatGPT model/effort not verified for this account; /auth chatgpt models. Nothing changed.'); }
    }
    out(settings.set(`agent.${key}`, want).text + d('   saved in the atlias config, so it applies to every session'));
  } },
  { name: 'usage', usage: '/usage', help: 'connected engine allowances and provider-reported session tokens', run: (_a, { state, out, api }) => {
    const rows = accountUsage({ active: state.engine, connected: api.detectEngines({ includeHosts: hostEnginesAllowed(config().agent) }), state });
    out([...rows.map(r => r.text), 'Account allowances are separate from session tokens. Cached readings can lag; unreported means unknown. Claude and Codex account caches are read locally; no credentials are read or sent.', 'Use /cost for this conversation and /connections to manage providers.'].join('\n'));
  } },
  { name: 'status', usage: '/status', help: 'engine, session, context size, plan, prompt cache, usage', run: (a, { state, out, api }) => out(api.statusText(state)) },
  { name: 'cost', usage: '/cost', help: 'tokens this session has used, as far as the engine reported them', run: (a, { state, out }) => {
    if (['claude', 'codex', 'echo'].includes(state.engine)) return out(`cost: the ${state.engine} engine makes its own calls, so atlias never sees their token counts${state.engine === 'echo' ? ' (the echo engine uses none)' : ''}. Its own program reports them.`);
    const cache = state.cache;
    if (!cache || !cache.calls) return out('cost: no model call yet in this session');
    const prompts = (state.promptLog || []).filter((n) => n !== null);
    const outs = (state.outLog || []).filter((n) => n !== null);
    const lines = [row('model calls', String(cache.calls)), row('prompt tokens', cache.reported ? `${cache.prompt} over ${cache.reported} reporting call${cache.reported === 1 ? '' : 's'}${cache.silent ? `, ${cache.silent} reported nothing` : ''}` : 'none reported by the endpoint')];
    if (outs.length) lines.push(row('output tokens', `${outs.reduce((n, v) => n + v, 0)} over ${outs.length} call${outs.length === 1 ? '' : 's'} (this run of the repl only)`));
    if (prompts.length) lines.push(row('largest prompt', String(Math.max(...prompts))));
    for (const worker of (state.subagentUsage || []).slice(-10)) lines.push(row('worker', `${worker.name}: ${worker.engine} / ${worker.model || 'configured model'}; ${worker.cache?.calls ?? 'unknown'} calls`));
    lines.push(loop.cacheLine(cache), 'no price table: atlias does not turn tokens into money');
    out(lines.join('\n'));
  } },
  { name: 'permissions', usage: '/permissions [mode|next|log]', help: 'what the agent may do without asking (workspace, ask, read-only, auto-accept, plan, auto, max)', run: (a, { out, state }) => out(permissions.command(a ? ' ' + a : '', { current: config().agent.permissions, set: (m) => settings.set('agent.permissions', m), sid: state.sid })) },
  { name: 'config', usage: '/config [id [value] | reset <id> | all]', help: 'show or change a setting; ui.copyOnSelect controls Windows Terminal after confirmation', run: async (a, ctx) => {
    const { out, api = {} } = ctx;
    const rows = settings.rows();
    const hostOptions = api.copyOnSelectOptions || {};
    if (!a) { const ch = rows.filter((r) => r.changed); return out((ch.length ? settings.format(ch) : 'every setting is at its default') + '\n' + copyOnSelectConfigLine(hostOptions) + '\n' + d('/config all lists them all; /config <id> <value> sets one; /settings opens the menu')); }
    if (a === 'all') return out(settings.format(rows) + '\n' + copyOnSelectConfigLine(hostOptions));
    const [first, second, ...rest] = a.split(/\s+/);
    if (first === 'reset') {
      if (second === 'ui.copyOnSelect') {
        if (rest.length) return out('usage: /config reset ui.copyOnSelect');
        return setCopyOnSelect(false, ctx);
      }
      out(second ? settings.reset(second).text : 'usage: /config reset <id>'); return;
    }
    if (first === 'ui.copyOnSelect') {
      if (second === undefined) return out(copyOnSelectConfigLine(hostOptions));
      const value = [second, ...rest].join(' ').toLowerCase();
      if (!['true', 'false'].includes(value)) return out('ui.copyOnSelect is true or false; no setting was changed.');
      return setCopyOnSelect(value === 'true', ctx);
    }
    const found = rows.find((r) => r.id === first);
    if (!found) return out(`no setting named ${first}; /config all lists them`);
    if (second === undefined) return out(settings.format([found]));
    out(settings.set(first, [second, ...rest].join(' ')).text);
  } },
  { name: 'diff', usage: '/diff', help: 'the uncommitted changes', run: (a, { out, cwd, api }) => out(api.diffText(cwd)) },
  { name: 'review', usage: '/review', help: 'have the engine review the uncommitted changes', run: async (a, { state, out, ask, cwd, api }) => {
    const p = api.reviewPrompt(cwd);
    if (!p) return out('nothing to review: no uncommitted changes');
    out('\n' + (await api.turn(state, p, ask, out, { generated: 'review' })) + '\n');
    api.saveChat(state);
  } },
  { name: 'undo', usage: '/undo', help: 'take back the last change this agent made', run: (a, { state, out, api }) => { out(['ollama', 'openai'].includes(state.engine) || (state.undo && state.undo.length) ? loop.undo(state) : ['claude', 'codex'].includes(state.engine) ? 'The host harness keeps its own file history. Use its native undo or /rewind for Atlias checkpoints.' : 'No file change to undo in this conversation. /rewind lists saved turn checkpoints.'); api.saveChat(state); } },
  { name: 'rewind', usage: '/rewind [turn] [--code|--no-code]', help: 'go back to before a turn: the last twenty are listed; --code also undoes the file edits made since', run: async (a, { state, out, ask, api }) => {
    const words = String(a || '').trim().split(/\s+/).filter(Boolean);
    if (!(state.checkpoints || []).length) return out('nothing to rewind yet: no turn has been sent in this session');
    let num = words.find((w) => /^\d+$/.test(w));
    if (!num) {
      out(rewind.formatTurns(state));
      if (!ask) return;
      num = String(await ask('rewind to which turn? (Enter to cancel) ')).trim();
      if (!/^\d+$/.test(num)) return out('no rewind');
    }
    let code = words.includes('--code') ? true : words.includes('--no-code') ? false : null;
    if (code === null) code = ask ? /^y(es)?$/i.test(String(await ask('code too? [y/N] ')).trim()) : false;
    const r = rewind.rewindTurn(state, Number(num), { code });
    out(r.text);
    api.saveChat(state);
  } },
  { name: 'compact', usage: '/compact [focus]', help: 'drop older messages, keep the plan', run: (a, { state, out, api }) => {
    // lib/loop.mjs is pinned by the benchmark-path freeze (test/import-suites.mjs), so the focus is written
    // into the note that compaction leaves here, after loop.compact has made it.
    const focus = String(a || '').trim();
    rewind.linkCheckpoints(state);
    const msg = loop.compact(state);
    if (/^compacted /.test(msg)) rewind.afterCompact(state);
    if (focus && /^compacted /.test(msg) && state.messages[1]) state.messages[1] = { ...state.messages[1], content: `${state.messages[1].content}\nFocus for this compaction, word for word: ${focus}` };
    out(msg); api.saveChat(state);
  } },
  { name: 'clear', usage: '/clear', help: 'save this conversation and start a new one', run: (a, { state, out, cwd, api }) => {
    if (!state.history.length && !state.messages.length) return out('this conversation is already empty');
    const old = state.sid;
    api.saveChat(state);
    api.distil(old, cwd);
    replaceState(state, api.newState(cwd, state.engine));
    out(d(`saved ${old}; new session ${state.sid}. /resume ${old} brings the old one back`));
  } },
  { name: 'sessions', usage: '/sessions', help: 'saved sessions in this folder', run: (a, { out, cwd, api }) => { const list = api.listChats(cwd).slice(0, 10); out(list.length ? list.map((s) => `${s.sid}   ${s.name ? `"${s.name}"   ` : ''}${s.engine}   ${Math.floor((s.history || []).length / 2)} turns   ${new Date(s.saved).toLocaleString()}`).join('\n') : 'no saved sessions in this folder'); } },
  { name: 'rename', usage: '/rename <name>', help: 'name this session; /resume <name> brings it back', run: (a, { state, out, api }) => {
    const name = a.replace(/\s+/g, ' ').trim();
    if (!name) return out(state.name ? `this session is named "${state.name}"; /rename <name> changes it` : 'this session has no name; /rename <name> gives it one');
    if (name.length > 60) return out('a session name is at most 60 characters');
    state.name = name;
    api.saveChat(state);
    out(d(`session ${state.sid} is now named "${name}"; /resume ${name} brings it back`));
  } },
  { name: 'context', usage: '/context', help: 'what fills the context: instruction files, conversation, tool results, plan', run: (a, { state, out, cwd }) => {
    const instructionFiles = loop.INSTRUCTION_FILES.filter((f) => fs.existsSync(path.join(cwd, f))).map((f) => ({ name: f, bytes: fs.statSync(path.join(cwd, f)).size }));
    const window = state.engine === 'ollama' ? Number(config().agent.ollamaNumCtx) || 0 : 0;
    out(qol.contextText(state, { window, instructionFiles }));
  } },
  { name: 'update', usage: '/update [--check]', help: 'fast-forward this git checkout of atlias from its update source; --check only reports', run: (a, { out }) => {
    const o = updater.parseArgs(a.split(/\s+/).filter(Boolean));
    if (o.bad.length) return out(`usage: /update [--check] [--no-fetch]; not understood: ${o.bad.join(' ')}`);
    out(updater.update({ check: o.check, fetch: o.fetch }).text);
  } },
  { name: 'release-notes', usage: '/release-notes [version]', help: 'the changelog of this atlias: the newest entries, or one version', run: (a, { out }) => out(qol.releaseNotes(a)) },
  { name: 'resume', usage: '/resume [id or name]', help: 'search and choose a saved session of this folder', run: async (a, { state, out, ask, cwd, api }) => {
    let loaded;
    let pick = a;
    if (!pick) {
      const sessions = api.listChats(cwd, Infinity).filter(x => x.sid !== state.sid);
      if (!sessions.length) return out('No other saved sessions in this folder.');
      if (api.selectSession) pick = await api.selectSession(sessions);
      if (!api.selectSession || pick === undefined) {
        let matches = sessions;
        for (;;) {
          out(['Resume session', ...matches.map((s, i) => `${i + 1}. ${s.name || s.history?.find(h => h.role === 'user')?.text?.replace(/\s+/g, ' ').slice(0, 70) || 'Untitled session'} | ${s.engine} | ${s.sid}`)].join('\n'));
          if (!ask) return;
          const answer = String(await ask('Number, session id/name, or search text (Enter cancels): ') || '').trim();
          if (!answer) break;
          if (/^\d+$/.test(answer)) { if (matches[Number(answer) - 1]) { pick = matches[Number(answer) - 1].sid; break; } out('Choose a number from the list.'); continue; }
          const exact = sessions.filter(s => s.sid === answer || s.name?.toLowerCase() === answer.toLowerCase());
          if (exact.length === 1) { pick = exact[0].sid; break; }
          matches = sessions.filter(s => [s.sid, s.name, s.engine, s.history?.find(h => h.role === 'user')?.text].some(v => String(v || '').toLowerCase().includes(answer.toLowerCase())));
          if (!matches.length) out('No matching sessions. Try another search.');
        }
      }
      if (!pick) return out('Resume cancelled. Your current session is unchanged.');
    }
    try { loaded = pick ? api.loadChat(pick, cwd) : null; } catch (e) { return out(`cannot resume: ${e.message}`); }
    if (!loaded) return out(a ? `no saved session matches ${a}; /sessions lists them` : 'no other saved session in this folder');
    if (loaded.sid === state.sid) return out('that is the session already open');
    if (path.resolve(loaded.cwd) !== path.resolve(cwd)) return out(`that session belongs to ${loaded.cwd}; start atlias there to resume it`);
    const engine = api.pickEngine ? api.pickEngine(loaded.engine) : api.detectEngines()[loaded.engine] ? loaded.engine : null;
    if (!engine) return out('cannot resume: the saved engine is unavailable. Configure it explicitly; no other harness or billing source was selected.');
    if (state.history.length || state.messages.length || state.name) api.saveChat(state);
    if (loaded.engine !== engine) { loaded.engine = engine; loaded.started = false; loaded.messages = []; loaded.textTools = false; }
    replaceState(state, loaded);
    out(d(`resumed ${state.sid} (${Math.floor(state.history.length / 2)} turns, engine ${state.engine}); the session you left is saved`));
  } },
  { name: 'export', usage: '/export [file]', help: 'write this conversation to a markdown file in the project', run: (a, { state, out, cwd }) => {
    if (!state.history.length) return out('nothing to export yet');
    const target = path.resolve(cwd, a || path.join('.atlias', 'exports', `${state.sid}.md`));
    if (!loop.insideProject(cwd, target)) return out('export writes inside the project only');
    if (fs.existsSync(target)) return out(`${path.relative(cwd, target)} exists; give another name`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, exportText(state));
    out(`wrote ${path.relative(cwd, target)}`);
  } },
  { name: 'plan', usage: '/plan', help: 'the agent\'s current plan', run: (a, { state, out }) => out(state.todo && state.todo.length ? loop.renderTodo(state.todo) : 'no plan yet; the agent writes one with its todo tool') },
  { name: 'init', usage: '/init', help: 'have the engine write (or update) AGENTS.md for this project', run: (a, ctx) => {
    const have = fs.existsSync(path.join(ctx.cwd, 'AGENTS.md'));
    return prompt(`Look at this project and ${have ? 'update its AGENTS.md' : 'write AGENTS.md at its root'} for future coding sessions: how to build, test and run it, what the main folders hold, and the conventions you can confirm in the code. Read files first and state only what you saw in them. Keep it under 60 lines.${have ? ' AGENTS.md already exists: read it and keep what is still true.' : ''}`, ctx);
  } },
  { name: 'memory', usage: '/memory [words]', help: 'the instruction files and saved notes atlias reads here; with words, search them', run: (a, { out, cwd }) => {
    if (a) return out(recall(cwd, a));
    const files = loop.INSTRUCTION_FILES.filter((f) => fs.existsSync(path.join(cwd, f)));
    const dir = claudeMemoryDir(cwd);
    let notes = [];
    try { notes = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort(); } catch { /* no memory folder */ }
    out([`instruction files in ${cwd}: ${files.length ? files.map((f) => `${f} (${fs.statSync(path.join(cwd, f)).size} bytes)`).join(', ') : 'none (/init writes AGENTS.md)'}`,
      `saved notes in ${dir}: ${notes.length ? notes.length : 'none'}`, ...notes.slice(0, 30).map((f) => { const front = skills.parseFrontmatter(readText(path.join(dir, f)) || ''); return `  ${f}${front.description ? ' - ' + clip(front.description, 90) : ''}`; }),
      notes.length > 30 ? `  ... ${notes.length - 30} more` : '', d('edit these files directly; /memory <words> searches them')].filter(Boolean).join('\n'));
  } },
  { name: 'import', usage: '/import [--dry-run] [--from tool] [--sessions] [--undo]', help: 'bring in memory, skills, commands and sessions from Claude Code, Codex, Gemini CLI, Antigravity; --undo takes it back', run: async (a, { out, ask }) => { await importer.runImport(a.split(/\s+/).filter(Boolean), { ask, out }); } },
  { name: 'graph', usage: '/graph <question>', help: 'ask the knowledge graph', run: (a, { out, cwd }) => out(a ? graph.query(cwd, a, config().graph.queryBudget) || 'no graph here, or no answer' : 'usage: /graph <question>') },
  { name: 'skills', usage: '/skills [name]', help: 'the skills installed here, or one of them in full', run: (a, { out, cwd }) => { if (!a) return out(skills.format(skills.discover(cwd))); const one = skills.body(cwd, a); out(one ? `${one.path}\n\n${one.text}` : `no skill matches ${a}; /skills lists them`); } },
  { name: 'recall', usage: '/recall <query>', help: 'search memory and digests', run: (a, { out, cwd }) => out(a ? recall(cwd, a) : 'usage: /recall <query>') },
  { name: 'progress', usage: '/progress [set <next step>]', help: 'the handoff note', run: (a, { state, out, cwd }) => { if (a.startsWith('set ')) progress.setNext(cwd, a.slice(4)); out(progress.update(cwd, state.sid, null)); } },
  { name: 'deep-research', usage: '/deep-research <topic>', help: 'plan questions, gather, and write a cited report under .atlias/research', run: async (a, ctx) => {
    if (!a) return ctx.out('usage: /deep-research <topic>');
    const r = await research.deepResearch(a, ctx);
    ctx.api.saveChat(ctx.state);
    ctx.out(`\nreport: ${path.relative(ctx.cwd, r.file)}\n${r.questions} question${r.questions === 1 ? '' : 's'}, ${r.turns} model turns; citations: ${r.cites.ok.length} found, ${r.cites.bad.length} not found. The report lists what could not be verified.\n`);
  } },
  { name: 'settings', usage: '/settings', help: 'change any option (menu)', run: async (a, { ask, out, onSettings }) => { await settings.menu(ask, out); if (onSettings) onSettings(); } },
  { name: 'hosts', usage: '/hosts', help: 'harnesses atlias can see', run: (a, { out }) => out(extra.statusLine()) },
  { name: 'doctor', usage: '/doctor', help: 'harness health', run: (a, { out, cwd }) => out(hosts.formatDoctor(hosts.doctor(cwd).concat(extra.doctorRows()))) },
  { name: 'exit', usage: '/exit', help: 'leave (also /quit)', exit: true, run: () => {} },
  { name: 'quit', usage: '/quit', help: 'same as /exit', exit: true, hidden: true, run: () => {} },
];

async function goalError(out, fn) {
  try { return await fn(); } catch (error) { out(`goal: ${error.message}`); return null; }
}
function parseContinueOptions(args) {
  const tokens = String(args || '').trim().split(/\s+/).filter(Boolean);
  let rounds = null, allowCheck = false;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--rounds' && rounds === null) rounds = Number(tokens[++i]);
    else if (tokens[i] === '--allow-check' && !allowCheck) allowCheck = true;
    else return null;
  }
  return Number.isSafeInteger(rounds) ? { rounds, allowCheck } : null;
}
async function runGoalCommand(input, ctx) {
  const raw = String(input || '').trim();
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(raw);
  const action = match ? match[1].toLowerCase() : 'status';
  const rest = match ? (match[2] || '').trim() : '';
  const { cwd, out, ask, state, api } = ctx;
  if (action === 'status' || action === 'list') return out(goals.statusText(cwd));
  if (action === 'create') {
    const parsed = goals.parseCreateArgs(rest);
    if (!parsed.check) return out('usage: /goal create --rounds N --check "project verification command" <objective>');
    return await goalError(out, () => { const goal = goals.createGoal(cwd, parsed.objective, { check: parsed.check, rounds: parsed.rounds }); out(`goal ${goal.id} active; limit ${goal.maxRounds} rounds; completion check: ${goal.check}`); });
  }
  if (action === 'update') {
    const updated = /^--rounds\s+(\d+)\s+([\s\S]+)$/.exec(rest);
    if (updated) return await goalError(out, () => { const goal = goals.updateGoal(cwd, updated[2], { rounds: Number(updated[1]) }); out(`updated goal ${goal.id}; status ${goal.status}; limit ${goal.maxRounds} rounds`); });
    if (!rest) return out('usage: /goal update [--rounds N] <new objective>');
    return await goalError(out, () => { const goal = goals.updateGoal(cwd, rest); out(`updated goal ${goal.id}; status ${goal.status}`); });
  }
  if (action === 'pause' || action === 'resume' || action === 'defer') {
    return await goalError(out, () => { const goal = goals.setGoalStatus(cwd, { pause: 'paused', resume: 'active', defer: 'deferred' }[action]); out(`goal ${goal.id} is ${goal.status}; ${goal.roundsUsed}/${goal.maxRounds} rounds used`); });
  }
  if (action === 'complete') return await goalError(out, async () => {
    const result = await goals.runGoalCheck(cwd, { ask }); out(result.text); if (api.saveChat) api.saveChat(state);
  });
  if (action === 'continue') {
    const options = parseContinueOptions(rest);
    if (!options) return out('usage: /goal continue --rounds N [--allow-check] (1-10; also bounded by the goal\'s stored limit)');
    return await goalError(out, async () => {
      let checkApproval = null;
      if (options.allowCheck) {
        const before = goals.readGoals(cwd);
        if (before.error) throw Error(before.error);
        if (!before.active || before.active.status !== 'active') throw Error('there is no active goal to continue');
        if (!before.active.check) throw Error('no completion check is set; update the goal with an explicit check first');
        const promptText = `Run this exact completion check after each work round, up to ${options.rounds} rounds (also capped by the stored goal limit)?\nProject: ${path.resolve(cwd)}\n${before.active.check}\n[y/N] `;
        if (!/^y(?:es)?$/i.test(String(await ask(promptText)).trim())) return out('continuation was not started; no check was approved');
        const after = goals.readGoals(cwd);
        if (after.error) throw Error(after.error);
        if (!after.active || after.active.id !== before.active.id || after.active.objective !== before.active.objective
          || after.active.check !== before.active.check || (after.active.revision || 1) !== (before.active.revision || 1) || after.active.status !== 'active') {
          throw Error('the goal changed while approval was pending; review it and start again');
        }
        checkApproval = { id: before.active.id, objective: before.active.objective, check: before.active.check, revision: before.active.revision || 1 };
      }
      const result = await goals.continueGoal(cwd, { rounds: options.rounds, checkApproval, turn: api.turn, state, ask, out, saveState: api.saveChat });
      out(result.text); if (api.saveChat) api.saveChat(state);
    });
  }
  return out('usage: /goals [status|create|continue|update|pause|resume|complete|defer]');
}

export function builtinNames() { return new Set(BUILTINS.map((b) => b.name)); }

// Everything /help shows: the built-ins, then the custom commands that are not hidden by one.
export function helpText(cwd, home = STATE_DIR, query = '', { inputMode = 'line', compact = Boolean(editionDefaults()) } = {}) {
  const shown = BUILTINS.filter((b) => !b.hidden);
  const { list, skipped } = loadCustom(cwd, home);
  const names = builtinNames();
  const custom = list.filter((x) => !names.has(x.name));
  const hidden = list.filter((x) => names.has(x.name));
  const width = 30;
  const format = (usage, help) => usage.length >= width ? `${usage}\n  ${help}` : usage.padEnd(width) + help;
  let q = String(query).trim().toLowerCase().replace(/^\//, '');
  const allRequested = q === 'all';
  if (allRequested) q = '';
  if (compact && !q && !allRequested) {
    const common = new Set(['connect','help','model','settings','permissions','diff','undo','exit']);
    return ['Tell Atlias what you want to build, or ask it to explain this project.', '', ...shown.filter(x=>common.has(x.name)).map(x=>format(x.usage,x.help)), '', '/help all lists every command; /help agents explains worker models.', '/help keys shows editing controls.'].join('\n');
  }
  if (q) {
    const all = [...shown, ...custom.map(x => ({ ...x, usage: `/${x.name}${x.hint ? ' ' + x.hint : ''}` }))];
    const exact = all.find(x => x.name.toLowerCase() === q);
    if (!exact && ['keys', 'keyboard'].includes(q)) return inputMode === 'composer'
      ? 'Composer keys\nEnter sends; Ctrl+J adds a newline. During work, Enter follows ui.followUp (queue by default); Ctrl+Q sends the other kind.\nTab completes a slash command; Up/Down choose commands or history.\n/queue lists, edits or removes pending messages; /btw asks a side question; Esc dismisses its answer.\nCtrl+R searches submitted input history; Enter accepts a match into the draft.\nCtrl+S stashes, restores or swaps unsent drafts for this session.\nCtrl+U removes text to the start of the current line.\nEsc or Ctrl+C interrupts active work. Ctrl+C clears idle input; a second press on an empty prompt exits.\n/undo covers file edits; /rewind covers conversation turns.'
      : 'Line input is active. Editing keys are provided by your terminal. Atlias slash commands remain available. Use atlias agent --plain for append-only output without the composer.';
    const found = exact ? [exact] : all.filter(x => `${x.name} ${x.help} ${x.usage}`.toLowerCase().includes(q));
    if (!found.length) return `No command matches ${JSON.stringify(query)}. Try /help model, /help settings or /help to browse.`;
    const examples = { help: '/help model', settings: '/settings', config: '/config attachments.detail high', agents: '/agents inherit', attachments: '/attachments', model: '/model', permissions: '/permissions', resume: '/resume', context: '/context', effort: '/effort' };
    return found.map(x => `${format(x.usage, x.help)}${examples[x.name] ? `\n  Example: ${examples[x.name]}` : ''}`).join('\n\n') + '\n\n/help shows every command.';
  }
  const common = new Set(['help', 'onboarding', 'model', 'agents', 'resume', 'diff', 'review', 'undo', 'permissions', 'exit']);
  const L = ['Describe a task in plain words. For example:', '  Explain this project', '  Find the cause of the failing test', '', 'Start, review and continue', ...shown.filter((b) => common.has(b.name)).map((b) => format(b.usage, b.help)), '', 'More tools and settings', ...shown.filter((b) => !common.has(b.name)).map((b) => format(b.usage, b.help))];
  if (custom.length) L.push('', 'custom commands (markdown files in .atlias/commands here and in the atlias home):', ...custom.map((x) => format(`/${x.name}${x.hint ? ' ' + x.hint : ''}`, `${x.help} (${x.source})`)));
  for (const x of hidden) L.push(d(`custom /${x.name} (${x.file}) is hidden by the built-in command of that name`));
  for (const s of skipped) L.push(d(`ignored ${s.file}: ${s.why}`));
  L.push('', inputMode === 'composer' ? 'Keyboard controls: /help keys. Ctrl+R searches history; Ctrl+S stashes a draft for this session.' : 'Line input is active; /help keys explains the available input mode.');
  L.push('', d('a line that starts with // is sent to the model as a message that starts with one slash'));
  return L.join('\n');
}

// Runs one line if it is a slash command. { handled: false } means the repl treats it as a message.
// { handled: true, text } is a '//' line to send as a message. { handled: true, exit: true } ends the repl.
export async function dispatch(line, ctx) {
  const t = String(line || '').trim();
  if (t.startsWith('//')) return { handled: true, text: t.slice(1) };
  const parsed = parseLine(t);
  if (!parsed) return { handled: false };
  const built = BUILTINS.find((b) => b.name === parsed.name);
  if (built) {
    await built.run(parsed.args, ctx);
    return built.exit ? { handled: true, exit: true } : { handled: true };
  }
  const custom = loadCustom(ctx.cwd, ctx.home || STATE_DIR).list.find((x) => x.name === parsed.name);
  if (custom) {
    await prompt(expand(custom.body, parsed.args), ctx);
    return { handled: true };
  }
  ctx.out(`unknown command /${parsed.name}; /help lists the commands`);
  return { handled: true };
}
