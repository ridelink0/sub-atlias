import { planEngine, prepared, USAGE_URL } from './chatgpt.mjs';
import { config } from './core.mjs';
import * as settings from './settings.mjs';
const safe = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 220);
export async function authCommand(args, { out, state, engine = planEngine } = {}) {
  const [provider = '', action = 'status', ...words] = String(args || '').trim().split(/\s+/);
  if (provider !== 'chatgpt') {
    out('usage: /auth chatgpt login|status|logout|cancel|models|use <model> [effort]|profiles|select <id>');
    out('Direct API credentials: responses uses OPENAI_API_KEY; anthropic uses ANTHROPIC_API_KEY; gemini uses GEMINI_API_KEY. Set them in your local environment, never a website or chat message. API billing is separate. Ollama needs no API key.');
    return;
  }
  if (!['status', 'models', 'profiles'].includes(action) && ['plan', 'read-only'].includes(config().agent.permissions)) return out('Authentication changes are disabled in this permission mode.');
  try {
    if (action === 'status') {
      if (engine === planEngine && !prepared()) return out('ChatGPT personal runtime is not installed. node scripts/setup-chatgpt-personal.mjs --personal prepares the separate noncommercial local prototype.');
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
