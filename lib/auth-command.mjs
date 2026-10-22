import { planEngine, prepared, USAGE_URL, PREPARE_COMMAND } from './chatgpt.mjs';
import { config } from './core.mjs';
import * as settings from './settings.mjs';
const safe = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 220);
export async function authCommand(args, { out, state, engine = planEngine, api = {} } = {}) {
  const [provider = '', action = 'status', ...words] = String(args || '').trim().split(/\s+/);
  if (['claude', 'codex'].includes(provider)) {
    if (!['status', 'login', 'logout'].includes(action)) return out(`usage: /auth ${provider} status|login${provider === 'claude' ? '|logout' : ''}`);
    if (!['status'].includes(action) && ['plan', 'read-only'].includes(config().agent.permissions)) return out('Authentication changes are disabled in this permission mode.');
    const status = () => api.nativeAuthStatus ? api.nativeAuthStatus(provider) : { available: false, authenticated: false, subscription: false };
    const initial = status();
    if (!initial.available && action !== 'status') return out(`${provider}: native CLI unavailable. Install and sign in using its own CLI, then run /auth ${provider} status.`);
    if (action === 'status') {
      const s = initial;
      if (!s.available) return out(`${provider}: native CLI unavailable; Atlias did not inspect credentials.`);
      return out(`${provider}: ${s.authenticated ? 'authenticated' : 'not signed in'}; ${s.subscription ? 'subscription sign-in reported' : 'billing and account access remain managed by the native CLI'}. Atlias did not read credentials.`);
    }
    if (action === 'logout') {
      if (provider !== 'claude' || !api.nativeLogout) return out(`${provider} sign-out is not exposed by this Atlias native status adapter; use the CLI's own logout command.`);
      const result = api.nativeLogout(provider);
      return out(result.started && result.exitCode === 0 ? 'Claude Code signed out through its own CLI. Atlias did not read credentials.' : 'Claude Code sign-out did not complete; check its native CLI.');
    }
    if (!api.nativeLogin) return out(`${provider} native login is unavailable in this session.`);
    out(`Starting ${provider}'s own login in this terminal. Atlias captures no login output or credentials.`);
    try { api.nativeLogin(provider); } catch { /* check native status below */ }
    const s = status();
    return out(s.authenticated ? `${provider}: authenticated according to its native CLI. Check plan and billing in that CLI; Atlias did not inspect credentials.` : `${provider}: sign-in is not verified. Complete login in its native CLI and run /auth ${provider} status.`);
  }
  if (provider === 'claude-plan') {
    const plan = api.claudePlan || await import('./claude-plan.mjs');
    if (action === 'status') {
      if (!plan.prepared()) return out(`claude-plan: the Claude Agent SDK is not installed. Run ${plan.SETUP_COMMAND} or /onboarding.`);
      const s = plan.planStatus();
      return out(`claude-plan: ${s.plan ? 'signed in with a Claude plan' : s.authenticated ? 'signed in with a Console (API) account, which this route refuses' : 'not signed in'}; model ${config().agent.claudePlanModel}, effort ${config().agent.claudePlanEffort}. Atlias did not read credentials.`);
    }
    if (!['login', 'setup'].includes(action)) return out('usage: /auth claude-plan status|login|setup');
    if (['plan', 'read-only'].includes(config().agent.permissions)) return out('Authentication changes are disabled in this permission mode.');
    if (action === 'login') {
      if (!plan.prepared()) return out(`The Claude Agent SDK is not installed. Run ${plan.SETUP_COMMAND} or /onboarding.`);
      out('Opening Anthropic\'s own Claude sign-in. Atlias captures no login output or credentials.');
      try { plan.planLogin(); } catch { /* status below decides */ }
      return out(plan.planStatus().plan ? 'claude-plan: signed in with a Claude plan.' : 'claude-plan: sign-in not verified. Run /auth claude-plan login again.');
    }
    if (!api.setupClaudePlan || !api.ask) return out(`Run ${plan.SETUP_COMMAND} in a terminal.`);
    const row = await api.setupClaudePlan({ ask: api.ask, out });
    return out(row.status === 'complete' ? 'claude-plan is ready.' : `claude-plan setup is ${row.status} (${row.verification}).`);
  }
  if (provider !== 'chatgpt') {
    out('usage: /auth claude-plan status|login|setup  or  /auth chatgpt login|status|logout|cancel|models|use <model> [effort]|profiles|select <id>');
    out('Direct API credentials: Responses uses OPENAI_API_KEY; Anthropic uses ANTHROPIC_API_KEY; Gemini uses GEMINI_API_KEY or GOOGLE_API_KEY. Set them in your local environment, never in a chat. API billing is separate. Ollama needs no API key. Claude Code and Codex sign-in stay inside their own CLIs.');
    return;
  }
  if (!['status', 'models', 'profiles'].includes(action) && ['plan', 'read-only'].includes(config().agent.permissions)) return out('Authentication changes are disabled in this permission mode.');
  try {
    if (action === 'status') {
      if (engine === planEngine && !prepared()) return out('ChatGPT personal runtime is not installed. ' + PREPARE_COMMAND + ' prepares the separate noncommercial local prototype.');
      const s = await engine.session();
      out(`ChatGPT: ${safe(s.status)}; plan usage ${s.status === 'connected' && s.sharing === true ? 'authorized' : 'not authorized'}${s.profileLabel ? '; profile ' + safe(s.profileLabel) : ''}.`);
      if (s.error) out('Connection needs attention: ' + safe(s.error.code));
      out('Plan usage and app access: ' + USAGE_URL);
    } else if (action === 'login') {
      out('Opening the official ChatGPT consent flow for Atlias Personal. Identity-only sign-in does not authorize model calls. Ctrl+C cancels; no API-key fallback.');
      const cancel = () => { void engine.cancel(); };
      process.once('SIGINT', cancel);
      let s;
      try { s = await engine.login({ ...(words.includes('--new') ? { newProfile: true } : {}) }); }
      finally { process.removeListener('SIGINT', cancel); }
      out(`ChatGPT: ${safe(s.status)}; plan usage ${s.status === 'connected' && s.sharing === true ? 'authorized' : 'not authorized'}.`);
      if (s.status === 'connected' && s.sharing === true) out('Use /auth chatgpt models, then /auth chatgpt use gpt-6.1-sol xhigh if available. No inference has been sent.');
    } else if (action === 'logout') { await engine.logout(); out('Local ChatGPT connection removed.'); }
    else if (action === 'cancel') { await engine.cancel(); out('Pending ChatGPT sign-in cancelled.'); }
    else if (action === 'models') {
      const list = await engine.models(); out(list.length ? list.map(m => `${safe(m.slug)}  ${safe(m.displayName)}`).join('\n') : 'No models returned for this authorized account.');
    } else if (action === 'profiles') {
      const list = await engine.profiles(); out(list.length ? list.map(p => `${safe(p.id)}  ${safe(p.label)}  ${safe(p.status)}  plan usage ${p.sharing ? 'authorized' : 'not authorized'}`).join('\n') : 'No saved ChatGPT profiles.');
    } else if (action === 'select' && words.length === 1) {
      const s = await engine.select(words[0]); out('Selected ChatGPT profile: ' + safe(s.profileLabel || s.profileId) + '; plan usage ' + (s.sharing ? 'authorized' : 'not authorized') + '. Refresh /auth chatgpt models before choosing a model.');
    } else if (action === 'use' && words.length >= 1 && words.length <= 2) {
      const model = words[0], effort = words[1] || config().agent.chatgptReasoningEffort;
      await engine.validate(model, effort);
      for (const [key, value] of [['chatgptModel', model], ['chatgptReasoningEffort', effort], ['engine', 'chatgpt']]) {
        const r = settings.set('agent.' + key, value); if (!r.ok) throw Error(r.text);
      }
      if (state) { state.engine = 'chatgpt'; state.messages = []; state.started = false; state.textTools = false; }
      out(`Selected ChatGPT direct: ${safe(model)}, reasoning ${safe(effort)}. Model access discovered; no inference sent. Uses the ChatGPT plan with Atlias's own loop.`);
    } else out('Unknown auth action or arguments. /auth lists the supported commands.');
  } catch (e) {
    // Never echo provider bodies, tokens or native SDK stack traces.
    const allowed = /^(ChatGPT|Requested |Personal |OS |No |Sign |Your |Could |The |Use |Authentication)/;
    out(allowed.test(e?.message || '') ? safe(e.message) : 'ChatGPT connection operation failed; no fallback or inference was attempted.');
  }
}
