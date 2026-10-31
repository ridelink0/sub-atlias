// A typed model name is checked against what the engine offers before it is saved (Gev 2026-10-24).
import * as onboarding from '../lib/onboarding.mjs';

export default async function modelCheckSuites({ asyncSuite, check }) {
  await asyncSuite('model check expert', 'a model must be one the engine offers; anything else is refused with real choices', async () => {
    const tags = (names) => async () => ({ ok: true, status: 200, json: async () => ({ models: names.map((name) => ({ name })) }), body: { cancel: async () => {} } });
    const cfg = { ollamaUrl: 'http://127.0.0.1:11434' };
    const good = await onboarding.checkModel('ollama', 'qwen3.5:9b', { cfg, fetchImpl: tags(['qwen3.5:9b', 'gemma3:4b']) });
    const typo = await onboarding.checkModel('ollama', 'qwen9', { cfg, fetchImpl: tags(['qwen3.5:9b', 'gemma3:4b']) });
    const junk = await onboarding.checkModel('ollama', 'banana phone', { cfg, fetchImpl: tags(['qwen3.5:9b']) });
    const down = await onboarding.checkModel('ollama', 'qwen3.5:9b', { cfg, fetchImpl: async () => { throw Error('refused'); } });
    check('an installed Ollama model passes; a typo is refused with the real names; spaces and an unreachable server change nothing',
      good.ok && !typo.ok && /qwen3\.5:9b/.test(typo.message) && !junk.ok && /no spaces/.test(junk.message) && !down.ok && /Nothing changed/.test(down.message),
      { happened: JSON.stringify({ good, typo, junk, down }), why: 'Atlias used to save any text as the model.', fix: 'checkModel in lib/onboarding.mjs.' });
    const plan = await onboarding.checkModel('claude-plan', 'claude-opus-5-5');
    const planList = await onboarding.listModels('claude-plan');
    const planBad = await onboarding.checkModel('claude-plan', 'gpt-4');
    check('the Claude plan accepts its Claude models only', plan.ok && planList.models.includes('claude-haiku-5-5') && !planBad.ok && /claude-opus-5-5/.test(planBad.message),
      { happened: JSON.stringify({ plan, planBad, planList }), why: 'A wrong name only failed later, mid-task.', fix: 'CLAUDE_PLAN_MODELS.' });
    const old = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const listed = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-opus-5-5' }] }) });
      const api = await onboarding.checkModel('anthropic', 'claude-opus-5-5', { cfg: {}, fetchImpl: listed });
      const apiBad = await onboarding.checkModel('anthropic', 'claude-opus-9', { cfg: {}, fetchImpl: listed });
      check('an API engine checks the provider\'s own model list', api.ok && !apiBad.ok, { happened: JSON.stringify({ api, apiBad }), why: 'Same.', fix: 'listModels.' });
    } finally { if (old === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = old; }
  });
}
