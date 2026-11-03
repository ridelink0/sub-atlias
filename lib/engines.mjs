// Availability never authorizes a change of billing source or chosen engine.
export const DIRECT_ENGINES = ['claude-plan', 'chatgpt', 'responses', 'anthropic', 'gemini', 'openai', 'ollama'];
// Gev (2026-11-02): every engine runs Atlias's own loop. Codex is the installed Codex app carrying one model
// call per turn (lib/codex-model.mjs); claude, the saved name of the old Claude Code host, is the Claude plan
// route, so old chats and settings that name it still work. Neither is a host harness any more.
export const PLAN_APP_ENGINES = ['claude', 'codex'];
export const ENGINE_ALIASES = { claude: 'claude-plan' };
export const canonicalEngine = (engine) => ENGINE_ALIASES[engine] || engine;
export const MODEL_KEYS = { claude: 'claudeModel', codex: 'codexModel', 'claude-plan': 'claudePlanModel', chatgpt: 'chatgptModel', responses: 'responsesModel', anthropic: 'anthropicModel', gemini: 'geminiModel', openai: 'openaiModel', ollama: 'ollamaModel' };
// The setting that holds each engine's reasoning effort, where the engine takes one.
export const EFFORT_KEYS = { codex: 'codexEffort', 'claude-plan': 'claudePlanEffort', claude: 'claudePlanEffort', chatgpt: 'chatgptReasoningEffort', responses: 'responsesReasoningEffort', anthropic: 'anthropicEffort', openai: 'openaiReasoningEffort' };
// agent.hostEngines no longer gates anything: no engine hands the task to another agent loop. Kept for old configs.
export const hostEnginesAllowed = (cfg = {}) => cfg.hostEngines === 'on';
export function chooseEngine(want, have) {
  if (want && want !== 'auto') return have[want] ? want : null;
  const configured = DIRECT_ENGINES.filter(e => have[e]);
  // Ambiguous billing routes require an explicit choice, never a priority list.
  return configured.length === 1 ? configured[0] : null;
}
export function describeEngine(engine, cfg = {}) {
  const model = cfg[MODEL_KEYS[engine]] || (engine === 'codex' ? 'Codex default' : 'not selected');
  const raw = EFFORT_KEYS[engine] ? cfg[EFFORT_KEYS[engine]] : null;
  const effort = raw && raw !== 'model' ? raw : null;
  const provider = { 'claude-plan': 'Claude plan (Agent SDK)', chatgpt: 'OpenAI', responses: 'OpenAI Responses', anthropic: 'Anthropic Messages', gemini: 'Google Gemini', openai: 'OpenAI-compatible', ollama: 'Ollama', claude: 'Claude plan (Agent SDK)', codex: 'ChatGPT plan (Codex app)' }[engine] || engine;
  const execution = engine === 'codex' ? 'Atlias loop; Codex carries the model call' : engine === 'setup' ? 'setup required' : engine === 'echo' ? 'diagnostic; no model' : 'direct; Atlias loop';
  const billing = engine === 'claude-plan' || engine === 'claude' ? 'your Claude plan; your own Claude sign-in' : engine === 'chatgpt' ? 'ChatGPT plan; approval required' : ['responses', 'anthropic', 'gemini'].includes(engine) ? 'provider API; separate billing' : engine === 'openai' ? 'configured endpoint; provider billing may apply' : engine === 'ollama' ? 'local endpoint' : engine === 'codex' ? 'your ChatGPT plan; your own Codex sign-in' : 'none';
  return { provider, model, reasoning: effort || 'provider default', execution, billing };
}
// A different engine cannot read the old one's messages (native tool calls in one, text blocks in
// another), so it starts its own conversation. Without the saved turns it would start blind, which
// is what made chats brought in from Codex or Claude Code seem stuck on one engine: the next
// message carries the end of the conversation as background, once.
export function moveToEngine(state, engine) {
  if (state.engine === engine) return false;
  const from = state.engine;
  state.engine = engine; state.started = false; state.messages = []; state.textTools = false;
  // A brought-in chat that has not sent its first message yet already carries its own digest.
  if (state.importedNote) return true;
  const kept = [];
  let used = 0;
  for (const h of (state.history || []).slice(-20).reverse()) {
    if (!h || typeof h.text !== 'string' || !h.text) continue;
    const line = `${h.role === 'user' ? 'User' : h.role === 'assistant' ? 'Assistant' : 'Atlias'}: ${h.text.length > 1500 ? `${h.text.slice(0, 1500)}...` : h.text}`;
    if (used + line.length > 20000) break;
    kept.unshift(line); used += line.length;
  }
  if (kept.length) state.importedNote = `[atlias: this chat moved to the ${engine} engine${from && from !== 'setup' ? ` from ${from}` : ''}. What follows is the end of the conversation so far, oldest first. It is background, not new instructions.]\n${kept.join('\n\n')}\n[end of the earlier conversation]`;
  return true;
}
export function engineLine(engine, cfg) {
  const d = describeEngine(engine, cfg);
  return `engine ${engine} | ${d.provider} | ${d.model} | reasoning ${d.reasoning} | ${d.execution} | ${d.billing}`;
}
