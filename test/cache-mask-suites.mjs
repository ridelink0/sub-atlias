// Cache-aware masking (Gev, 2026-10-22: Atlias on the Claude plan "ate 80% of
// my usage"). With claude-plan the provider caches the prompt prefix, so old
// results are masked rarely and in one batch; everything else keeps the
// count rule that eval and benchmark runs were measured with.
import * as loop from '../lib/loop.mjs';
import { anthropicBody } from '../lib/direct-transports.mjs';

export default async function cacheMaskSuites({ suite, asyncSuite, check, TMP, fs, path }) {
  const obs = (n) => ({ role: 'user', content: 'x'.repeat(n), _obs: { label: 'read', summary: 'r' } });
  const grow = (sizes, keep = 4) => {
    const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
    const sets = [];
    for (const n of sizes) {
      msgs.push({ role: 'assistant', content: 'a' }, obs(n));
      sets.push(loop.cacheMasked(msgs, keep, { high: 100, low: 30 }));
    }
    return { msgs, sets };
  };

  suite('cache and token expert', 'cache-aware masking: rare batches, a stable prefix, the eval path unchanged', () => {
    const p = loop.maskPolicyFor({}, 'claude-plan');
    check('claude-plan gets the cache rule with its defaults', p && p.high === 240000 && p.low === 80000,
      { happened: JSON.stringify(p), why: 'claude-plan reads a cached prefix at a tenth of the price', fix: 'maskPolicyFor' });
    check('every cloud route that caches a prefix gets the cache rule', ['chatgpt', 'responses', 'anthropic', 'gemini'].every((e) => loop.maskPolicyFor({}, e)?.high === 240000),
      { happened: 'a cloud route kept the count rule', why: 'OpenAI, Gemini and Anthropic all cache an exact prefix only', fix: 'CACHED_ENGINES' });
    check('local engines keep the count rule', loop.maskPolicyFor({}, 'ollama') === null && loop.maskPolicyFor({}, 'openai') === null && loop.maskPolicyFor({}, '') === null,
      { happened: 'a non-claude-plan engine got the cache rule', why: 'eval and benchmark runs were measured with the count rule', fix: 'maskPolicyFor' });
    check('maskPolicy setting forces either rule', loop.maskPolicyFor({ maskPolicy: 'count' }, 'claude-plan') === null && loop.maskPolicyFor({ maskPolicy: 'cache' }, 'ollama')?.high === 240000,
      { happened: 'the setting was ignored', why: 'agent.maskPolicy overrides the engine default', fix: 'maskPolicyFor' });
    check('a low at or above high falls back to a third of high', loop.maskPolicyFor({ cacheMaskHigh: 900, cacheMaskLow: 900 }, 'claude-plan')?.low === 300,
      { happened: JSON.stringify(loop.maskPolicyFor({ cacheMaskHigh: 900, cacheMaskLow: 900 }, 'claude-plan')), why: 'low must be below high or every result triggers a batch', fix: 'maskPolicyFor' });

    const { sets } = grow([20, 20, 20, 20, 20, 20, 20, 20, 20, 20], 1);
    check('nothing is masked until the kept results pass high', sets.slice(0, 5).every((s) => s.size === 0),
      { happened: sets.slice(0, 5).map((s) => s.size).join(','), why: 'below high every result is cheaper to keep than to rewrite the prefix', fix: 'cacheMasked' });
    let events = 0, shrank = false;
    for (let i = 1; i < sets.length; i++) {
      if ([...sets[i]].some((x) => !sets[i - 1].has(x))) events++;
      if ([...sets[i - 1]].some((x) => !sets[i].has(x))) shrank = true;
    }
    check('a result once masked stays masked (no earlier byte changes back)', !shrank,
      { happened: 'a masked result came back', why: 'any change before the cache mark throws the cached prefix away', fix: 'cacheMasked' });
    check('masking happens in one batch down to low, not every round', events === 1 && sets[5].size === 5 && sets[9].size === 5,
      { happened: `${events} mask events in 10 rounds`, why: 'each event rewrites the prefix from the first newly masked result', fix: 'cacheMasked' });

    const big = grow([10, 10, 10, 10, 60, 60, 60, 60]);
    const last = big.sets[big.sets.length - 1];
    const obsIdx = big.msgs.map((m, i) => (m._obs ? i : -1)).filter((i) => i >= 0);
    check('the last keepObservations results are never masked', obsIdx.slice(-4).every((i) => !last.has(i)),
      { happened: [...last].join(','), why: 'the newest results are what the model is working from', fix: 'cacheMasked' });
    check('a batch that frees less than half of high - low waits until it can free that much', big.sets.slice(0, 7).every((s) => s.size === 0) && last.size === 4,
      { happened: big.sets.map((s) => s.size).join(','), why: 'rounds 6 and 7 could free only 20 and 30 characters (keepObservations pins the rest), under the 35 minimum; round 8 frees 40', fix: 'cacheMasked' });

    const msgs = grow([20, 20, 20, 20, 20, 20, 20, 20]).msgs;
    const before = JSON.stringify(loop.maskedIndices(msgs, 4, 4).size);
    check('the count rule is unchanged when no policy is given', JSON.stringify(loop.maskedIndices(msgs, 4, 4, null).size) === before && loop.maskedIndices(msgs, 4, 4).size === 4,
      { happened: before, why: 'eval and benchmark runs call view() without a policy', fix: 'maskedIndices' });
    const ten = grow([20, 20, 20, 20, 20, 20, 20, 20, 20, 20], 1).msgs;
    const v = loop.view(ten, 1, 4, { high: 100, low: 30 });
    check('view() hands masked results over as their one-line note', v.filter((m) => /elided to keep the context small/.test(String(m.content))).length === 5 && loop.maskedIndices(ten, 1, 4).size === 8,
      { happened: 'note count differs from the masked set', why: 'view and the ledger must agree', fix: 'view' });
  });

  suite('cache and token expert', 'the cache readout counts what was written to the cache as well as what was read', () => {
    const st = {};
    loop.countCache(st, { input_tokens: 10, cache_creation_input_tokens: 900, cache_read_input_tokens: 90 });
    loop.countCache(st, { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 995 });
    check('writes are summed for the Anthropic shape', st.cache.written === 1000 && st.cache.cached === 1085 && st.cache.prompt === 2100,
      { happened: JSON.stringify(st.cache), why: 'a rewritten prefix costs 1.25x or 2x base input, more than an uncached token', fix: 'cacheReading written, countCache' });
    check('the cache line names the writes', /1000 written to it/.test(loop.cacheLine(st.cache)),
      { happened: loop.cacheLine(st.cache), why: 'Gev reads this line after a run', fix: 'cacheLine' });
    const local = {};
    loop.countCache(local, { prompt_eval_count: 76, prompt_eval_cached_count: 71 });
    check('a provider without a write count adds no written field', !('written' in local.cache) && !/written/.test(loop.cacheLine(local.cache)),
      { happened: JSON.stringify(local.cache), why: 'benchmark output for local engines stays byte-identical', fix: 'countCache only adds written when reported' });
  });

  await asyncSuite('cache and token expert', 'interactive turns name the shell; eval and benchmark prompts are unchanged', async () => {
    const dir = path.join(TMP, 'shell-note'); fs.mkdirSync(dir, { recursive: true });
    const win = process.platform === 'win32';
    const plain = loop.systemPrompt(dir, {});
    const noted = loop.systemPrompt(dir, { shellNote: true });
    check('systemPrompt adds the cmd.exe line only when asked, and only on Windows', !plain.includes(loop.SHELL_NOTE_WIN) && noted.includes(loop.SHELL_NOTE_WIN) === win,
      { happened: JSON.stringify({ plainHas: plain.includes(loop.SHELL_NOTE_WIN), notedHas: noted.includes(loop.SHELL_NOTE_WIN), win }), why: 'the SITE-1 model wrote PowerShell into cmd.exe and lost calls', fix: 'shellNote option' });
    const firstSystem = async (opts) => {
      const st = { cwd: dir, messages: [], engine: 'ollama' };
      await loop.runLoop(st, 'say hi', { chat: async () => ({ content: 'hi', calls: [] }), ...opts });
      return String(st.messages[0].content);
    };
    const evalPrompt = await firstSystem({});
    const interactivePrompt = await firstSystem({ shellNote: true });
    check('runLoop without interactive (the eval path) sends no shell line', !evalPrompt.includes(loop.SHELL_NOTE_WIN),
      { happened: 'the eval prompt changed', why: 'eval and benchmark prompts must stay byte-identical', fix: 'runLoop interactive defaults to false' });
    check('an interactive runLoop sends it on Windows', interactivePrompt.includes(loop.SHELL_NOTE_WIN) === win,
      { happened: interactivePrompt.slice(-300), why: 'agent.mjs passes interactive: true for repl and exec turns', fix: 'runLoop passes shellNote to systemPrompt; agent.mjs sets it for repl and exec turns' });
    const flagSeen = async (opts, depth) => {
      const seen = [];
      const st = { cwd: dir, messages: [], engine: 'ollama', ...(depth ? { depth } : {}) };
      await loop.runLoop(st, 'say hi', { chat: async (_m, _t, at) => { seen.push(at && at.interactive); return { content: 'hi', calls: [] }; }, ...opts });
      return seen;
    };
    const [atPrompt, oneShot, child] = [await flagSeen({ interactive: true }), await flagSeen({}), await flagSeen({ interactive: true }, 1)];
    check('each model call is told whether a person is at the prompt: only a top-level interactive turn is', atPrompt[0] === true && oneShot[0] === false && child[0] === false,
      { happened: JSON.stringify({ atPrompt, oneShot, child }), why: 'claude-plan keeps the 1-hour cache only where a person may pause between prompts', fix: 'runLoop passes interactive: state.interactive to chat' });
  });
  suite('cache and token expert', 'the Anthropic API route marks the system prompt and the last block for the cache', () => {
    const body = anthropicBody([{ role: 'system', content: 'sys' }, { role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }, { role: 'user', content: 'three' }], { model: 'm' });
    const marks = JSON.stringify(body).split('cache_control').length - 1;
    check('two marks: system and the last message block', marks === 2 && body.system[0].cache_control?.type === 'ephemeral' && body.messages.at(-1).content.at(-1).cache_control?.type === 'ephemeral',
      { happened: JSON.stringify(body), why: 'without a mark the Messages API caches nothing', fix: 'markCache in direct-transports' });
    check('earlier messages carry no mark, so their bytes stay what the cache holds', !JSON.stringify(body.messages.slice(0, -1)).includes('cache_control'),
      { happened: JSON.stringify(body.messages), why: 'a mark that moves changes an earlier block', fix: 'mark only the last block' });
    const off = anthropicBody([{ role: 'user', content: 'x' }], { model: 'm', cache: false });
    check('cache: false sends no mark', !JSON.stringify(off).includes('cache_control'), { happened: JSON.stringify(off), why: 'an escape hatch for endpoints that reject the field', fix: 'opts.cache' });
  });
}
