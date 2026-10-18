// Optional personal ChatGPT-plan engine. Dedicated official OAuth registration;
// never reads a Codex/Claude credential, API-key fallback or hosted agent loop.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { STATE_DIR, config } from './core.mjs';
import { windowsCredentialProtection } from './credential-protection.mjs';
const SDK_PIN = '0a36fefeb913055c8c7a1a29b63d82b96b2e841a';
export const USAGE_URL = 'https://chatgpt.com/settings/usage';
export const MODEL_SOURCE = 'https://developers.openai.com/api/docs/models/gpt-6.1-sol';
const CAPABILITIES = { 'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max'] };
const personalRoot = () => path.join(STATE_DIR, 'personal-chatgpt');
let clientPromise;
export function prepared() {
  try {
    const runtime = path.join(personalRoot(), 'runtime');
    const m = JSON.parse(fs.readFileSync(path.join(runtime, 'PERSONAL-ONLY.json'), 'utf8'));
    return m.commit === SDK_PIN && m.personalOnly === true && m.installComplete === true && fs.statSync(path.join(runtime, 'index.js')).isFile() && fs.statSync(path.join(runtime, 'package.json')).isFile();
  } catch { return false; }
}
async function defaultClient() {
  if (!prepared()) throw Error('Personal ChatGPT SDK is not prepared. Run node scripts/setup-chatgpt-personal.mjs --personal locally; it is excluded from public and Max releases.');
  clientPromise ||= import(pathToFileURL(path.join(personalRoot(), 'runtime/index.js')).href).then(({ createChatGPT }) => createChatGPT({
    appName: 'Atlias Personal', appId: 'atlias-personal', redirectPort: 0,
    sendHostId: true, storageDir: path.join(personalRoot(), 'credentials'),
    credentialEncryption: windowsCredentialProtection(),
  })).catch(error => { clientPromise = undefined; throw error; });
  return clientPromise;
}
export function validateSelection(models, model, effort) {
  if (!models.some(m => m.slug === model)) throw Error('Requested model is unavailable to this ChatGPT account. Use /auth chatgpt models; no replacement was selected.');
  const allowed = CAPABILITIES[model];
  if (effort !== 'model' && (!allowed || !allowed.includes(effort))) throw Error('Requested reasoning effort is not verified for this model. No reasoning or model replacement was selected.');
  return { model, effort, capabilitySource: allowed ? MODEL_SOURCE : 'provider default only' };
}
// Strict SSE completion: partial text/tool deltas never authorize tool execution.
export async function readPlanResponse(response, signal) {
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return { status: response.status, json: { error: { code: 'chatgpt_http_' + response.status } }, text: '' }; }
  const type = response.headers.get('content-type')?.split(';')[0].trim();
  if (!response.body || (type && type !== 'text/event-stream')) throw Error('ChatGPT returned an invalid response stream.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', bytes = 0, completed;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength; if (bytes > 32 * 1024 * 1024) throw Error('ChatGPT response exceeded the local limit.');
      pending += decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const block = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length);
        const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        let event; try { event = JSON.parse(data); } catch { throw Error('ChatGPT returned malformed stream data.'); }
        if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) {
          const code = event.response?.error?.code || event.error?.code || event.code || event.type;
          const error = Error('ChatGPT response failed (' + (/^[a-zA-Z0-9_.-]{1,100}$/.test(code) ? code : 'provider_error') + '). No fallback or retry was made.');
          error.code = /^[a-zA-Z0-9_.-]{1,100}$/.test(code) ? code : 'provider_error';
          throw error;
        }
        if (event.type === 'response.completed') {
          if (completed || !event.response || event.response.status !== 'completed') throw Error('ChatGPT returned an invalid completion event.');
          completed = event.response;
        }
      }
    }
    signal?.throwIfAborted();
    if (!completed || pending.trim()) throw Error('ChatGPT stream ended without a complete terminal response.');
    return { status: 200, json: completed, text: '' };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function createPlanEngine({ getClient = defaultClient, fetchImpl = fetch, responsesAdapter } = {}) {
  let catalogue = null;
  async function session() { return (await getClient()).getSession(); }
  async function requireSharing() {
    const s = await session();
    if (s.status !== 'connected' || s.sharing !== true) throw Error('ChatGPT plan usage is not authorized. Use /auth chatgpt login and approve plan usage. No API-key or host fallback was selected.');
    return s;
  }
  async function models() { await requireSharing(); return (await getClient()).listModels(); }
  return {
    session, models,
    async login(options = {}) { catalogue = null; return (await getClient()).signIn(options); },
    async cancel() { (await getClient()).cancelSignIn(); },
    async logout() { catalogue = null; return (await getClient()).disconnect(); },
    async profiles() { return (await getClient()).listProfiles(); },
    async select(id) { catalogue = null; return (await getClient()).selectProfile(id); },
    async validate(model, effort) { return validateSelection(await models(), model, effort); },
    async chat(messages, tools, cfg = config().agent) {
      let attempts = 0;
      try {
        const s = await requireSharing();
        if (!catalogue || catalogue.profile !== s.profileId || Date.now() - catalogue.at > 300000) catalogue = { profile: s.profileId, at: Date.now(), models: await models() };
        validateSelection(catalogue.models, cfg.chatgptModel, cfg.chatgptReasoningEffort);
        const sdk = await getClient();
        const adapter = responsesAdapter || (await import('./direct-transports.mjs')).responsesChat;
        // Only the official SDK obtains/refreshed credentials inside this callback.
        // The callback is trusted local code, never exposed to the browser/UI.
        const post = (url, body) => sdk.requestAuthorized(async (token, signal) => {
          if (url !== 'https://api.openai.com/v1/responses') throw Error('ChatGPT plan requests must use the public Responses endpoint.');
          const combined = AbortSignal.any([signal, AbortSignal.timeout(180000)]);
          attempts++;
          const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: combined,
            headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'text/event-stream' },
            body: JSON.stringify({ ...body, store: false, stream: true }),
          });
          return readPlanResponse(response, combined);
        });
        const result = await adapter(messages, { tools, model: cfg.chatgptModel, reasoning: cfg.chatgptReasoningEffort === 'model' ? undefined : cfg.chatgptReasoningEffort,
          baseURL: 'https://api.openai.com/v1', key: 'dedicated-oauth-callback', post });
        return attempts ? result : { ...result, requestUsages: [] };
      } catch (e) {
        // SDK errors are sanitized; arbitrary network error bodies/headers are not.
        const message = typeof e?.message === 'string' && /^(ChatGPT|Requested |Personal |OS |No |Sign |Your |Could |The )/.test(e.message) ? e.message : 'ChatGPT direct request failed. No fallback or retry was made.';
        return { error: message, requestUsages: attempts ? [null] : [] };
      }
    },
  };
}
export const planEngine = createPlanEngine();
