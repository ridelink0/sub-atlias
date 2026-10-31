// Availability never authorizes a change of billing source or chosen engine.
export const DIRECT_ENGINES = ['claude-plan', 'chatgpt', 'responses', 'anthropic', 'gemini', 'openai', 'ollama'];
export const HOST_ENGINES = ['claude', 'codex']; // Saved names stay compatible.
export const MODEL_KEYS = { 'claude-plan': 'claudePlanModel', chatgpt: 'chatgptModel', responses: 'responsesModel', anthropic: 'anthropicModel', gemini: 'geminiModel', openai: 'openaiModel', ollama: 'ollamaModel' };
// The setting that holds each engine's reasoning effort, where the engine takes one.
export const EFFORT_KEYS = { 'claude-plan': 'claudePlanEffort', chatgpt: 'chatgptReasoningEffort', responses: 'responsesReasoningEffort', anthropic: 'anthropicEffort', openai: 'openaiReasoningEffort' };
// Host harnesses run only when agent.hostEngines is on (Gev, 2026-10-19: Atlias runs the model itself).
export const hostEnginesAllowed = (cfg = {}) => cfg.hostEngines === 'on';
export function chooseEngine(want, have) {
  if (want && want !== 'auto') return have[want] ? want : null;
  const configured = DIRECT_ENGINES.filter(e => have[e]);
  // Ambiguous billing routes require an explicit choice, never a priority list.
  return configured.length === 1 ? configured[0] : null;
}
export function describeEngine(engine, cfg = {}) {
  const model = cfg[MODEL_KEYS[engine]] || (HOST_ENGINES.includes(engine) ? 'selected by host' : 'not selected');
  const raw = EFFORT_KEYS[engine] ? cfg[EFFORT_KEYS[engine]] : null;
  const effort = raw && raw !== 'model' ? raw : null;
  const provider = { 'claude-plan': 'Claude plan (Agent SDK)', chatgpt: 'OpenAI', responses: 'OpenAI Responses', anthropic: 'Anthropic Messages', gemini: 'Google Gemini', openai: 'OpenAI-compatible', ollama: 'Ollama', claude: 'Claude Code', codex: 'Codex' }[engine] || engine;
  const execution = HOST_ENGINES.includes(engine) ? 'host harness' : engine === 'setup' ? 'setup required' : engine === 'echo' ? 'diagnostic; no model' : 'direct; Atlias loop';
  const billing = engine === 'claude-plan' ? 'your Claude plan; your own Claude sign-in' : engine === 'chatgpt' ? 'ChatGPT plan; approval required' : ['responses', 'anthropic', 'gemini'].includes(engine) ? 'provider API; separate billing' : engine === 'openai' ? 'configured endpoint; provider billing may apply' : engine === 'ollama' ? 'local endpoint' : HOST_ENGINES.includes(engine) ? 'managed by explicit host' : 'none';
  return { provider, model, reasoning: effort || 'provider default', execution, billing };
}
export function engineLine(engine, cfg) {
  const d = describeEngine(engine, cfg);
  return `engine ${engine} | ${d.provider} | ${d.model} | reasoning ${d.reasoning} | ${d.execution} | ${d.billing}`;
}
