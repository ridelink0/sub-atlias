// Sampling settings for the local engine, and the terse-request paragraph
// (2026-10-10). The evolution search had only ever varied context numbers,
// every one inside the run-to-run noise. The model's own sampling (qwen3.5
// ships with presence_penalty 1.5 and reasons by default) and what the model
// is told had never been a choice. These checks hold the new choices to two
// things: nothing changes until one is set, and a bad value never reaches the
// server.
//
// Loaded by test/run.mjs, which owns asyncSuite() and check().
import * as loop from '../lib/loop.mjs';
import * as core from '../lib/core.mjs';
import * as settings from '../lib/settings.mjs';
import { newState as agentState } from '../lib/agent.mjs';

export default async function samplingSuites({ asyncSuite, check, TMP, fs, path }) {
  const W = path.join(TMP, 'sampling-work');
  fs.mkdirSync(W, { recursive: true });
  const why = 'A search choice that does nothing, or that changes the baseline while it is off, makes every round measured with it meaningless.';
  const fix = 'Read ollamaChat and systemPrompt in lib/loop.mjs against DEFAULTS in lib/core.mjs.';
  const say = (happened) => ({ happened: typeof happened === 'string' ? happened : JSON.stringify(happened), why, fix });
  const overflowText = JSON.stringify({ error: JSON.stringify({ error: { code: 400, message: 'request (20000 tokens) exceeds the available context size (16384 tokens), try increasing it', type: 'exceed_context_size_error', n_prompt_tokens: 20000, n_ctx: 16384 } }) });
  const overflow = () => ({ status: 400, json: JSON.parse(overflowText), text: overflowText });
  const server = (replies = []) => {
    const bodies = [];
    const post = async (url, body) => {
      if (/\/api\/show$/.test(url)) return { status: 200, json: { model_info: { 'qwen35.context_length': 32768 } } };
      bodies.push(body);
      return replies.shift() || { status: 200, json: { message: { content: 'done' }, done_reason: 'stop', prompt_eval_count: 900, eval_count: 5 } };
    };
    return { post, bodies };
  };
  const cfg = (over = {}) => ({ ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: 'qwen3.5:9b', ollamaNumCtx: 16384, ollamaNumPredict: 2048, ollamaKeepAlive: '', ...over });
  const sent = async (over, replies) => { const s = server(replies); await loop.ollamaChat(cfg(over), { post: s.post })([{ role: 'user', content: 'x' }]); return s.bodies; };
  const first = async (over) => (await sent(over))[0];
  // The request atlias sent before these settings existed, byte for byte.
  const BASE = '{"model":"qwen3.5:9b","messages":[{"role":"user","content":"x"}],"stream":false,"truncate":false,"options":{"temperature":0.2,"num_ctx":16384,"num_predict":2048}}';
  const prompt = (over = {}) => loop.systemPrompt(W, { hasGraph: false, instructions: '', ...over });
  const envName = core.flagEnvName('impliedChanges');

  await asyncSuite('sampling expert', 'sampling and the terse-request paragraph are real choices', async () => {
    const bare = JSON.stringify(await first({}));
    const defaults = JSON.stringify(await first({ ollamaTemperature: core.DEFAULTS.agent.ollamaTemperature, ollamaPresencePenalty: core.DEFAULTS.agent.ollamaPresencePenalty, ollamaThink: core.DEFAULTS.agent.ollamaThink }));
    check('with nothing set, and with every default set, the request is the one the baseline sent', bare === BASE && defaults === BASE, say({ bare, defaults }));

    const warm = await first({ ollamaTemperature: 0.6 }), cold = await first({ ollamaTemperature: 0 }), text = await first({ ollamaTemperature: '1' });
    check('the temperature that is set is the one sent, zero included', warm.options.temperature === 0.6 && cold.options.temperature === 0 && text.options.temperature === 1, say([warm.options, cold.options, text.options]));

    const none = await first({ ollamaPresencePenalty: 0 }), half = await first({ ollamaPresencePenalty: 0.5 });
    check('a presence penalty that is set is sent, zero included', none.options.presence_penalty === 0 && half.options.presence_penalty === 0.5, say([none.options, half.options]));

    const off = await first({ ollamaThink: 'off' }), on = await first({ ollamaThink: 'on' }), spaced = await first({ ollamaThink: ' OFF ' }), model = await first({ ollamaThink: 'model' });
    check('reasoning is switched on or off only when asked, and left to the model otherwise', off.think === false && on.think === true && spaced.think === false && !('think' in model), say([off.think, on.think, spaced.think, Object.keys(model)]));

    const grown = await sent({ ollamaTemperature: 0.6, ollamaPresencePenalty: 0, ollamaThink: 'off' }, [overflow()]);
    check('a request repeated in a bigger window keeps its sampling', grown.length === 2 && grown[1].options.num_ctx === 32768 && grown[1].options.temperature === 0.6 && grown[1].options.presence_penalty === 0 && grown[1].think === false, say(grown.map((b) => ({ options: b.options, think: b.think }))));

    const withIt = prompt({ implied: true }), without = prompt({ implied: false });
    check('the paragraph is in the prompt when asked for, ahead of the tool format, and absent otherwise', withIt.includes(loop.IMPLIED_CHANGES) && !without.includes(loop.IMPLIED_CHANGES) && withIt.indexOf(loop.IMPLIED_CHANGES) < withIt.indexOf('To use a tool'), say({ on: withIt.includes(loop.IMPLIED_CHANGES), off: without.includes(loop.IMPLIED_CHANGES) }));

    const before = process.env[envName];
    let fromFlag = false, fromDefault = true;
    try {
      delete process.env[envName];
      fromDefault = prompt().includes(loop.IMPLIED_CHANGES);
      process.env[envName] = '1';
      fromFlag = prompt().includes(loop.IMPLIED_CHANGES);
    } finally { if (before === undefined) delete process.env[envName]; else process.env[envName] = before; }
    check('the registered flag switches it, and it is off by default', fromFlag === true && fromDefault === false && core.DEFAULTS.flags.impliedChanges === false, say({ envName, fromFlag, fromDefault }));

    const think = core.parseSetting('agent', 'ollamaThink', 'OFF'), heat = core.parseSetting('agent', 'ollamaTemperature', '0.6'), presence = core.parseSetting('agent', 'ollamaPresencePenalty', '0');
    const ids = ['agent.ollamaTemperature', 'agent.ollamaPresencePenalty', 'agent.ollamaThink', 'flags.impliedChanges'];
    const listed = settings.rows().filter((r) => ids.includes(r.id));
    check('each setting is typed, described and listed with its default', think.value === 'off' && heat.value === 0.6 && presence.value === 0 && ids.every((id) => (settings.DESCRIPTIONS[id] || '').length > 40) && listed.length === 4 && listed.every((r) => r.changed === false && r.about), say({ think, heat, presence, listed: listed.map((r) => [r.id, r.def]) }));
  });

  await asyncSuite('sampling adversary', 'a bad sampling value never reaches the server', async () => {
    const badHeat = ['', '   ', null, undefined, 'hot', -1, -0.01, 2.5, 9, NaN, Infinity, true, {}, []];
    const heats = [];
    for (const v of badHeat) heats.push((await first({ ollamaTemperature: v })).options.temperature);
    check('a temperature that is missing, not a number or out of range falls back to the baseline 0.2', heats.every((t) => t === 0.2), say(heats));

    const badPresence = [-1, -0.5, '', null, undefined, 'x', 2.5, 5, NaN, Infinity, true, []];
    const presences = [];
    for (const v of badPresence) presences.push('presence_penalty' in (await first({ ollamaPresencePenalty: v })).options);
    check('a presence penalty that is unset or out of range is not sent at all', presences.every((p) => p === false), say(presences));

    const badThink = ['maybe', 'model', true, false, 1, 0, '', null, undefined, 'constructor', '__proto__', 'toString', ['off']];
    const thinks = [];
    for (const v of badThink) thinks.push('think' in (await first({ ollamaThink: v })));
    check('a reasoning value outside on and off sends no switch', thinks.every((t) => t === false), say(thinks));

    const refused = [core.parseSetting('agent', 'ollamaThink', 'maybe'), core.parseSetting('agent', 'ollamaTemperature', 'hot'), core.parseSetting('agent', 'ollamaPresencePenalty', '')];
    check('the settings command refuses a value it cannot type', refused.every((r) => r.error && r.value === undefined), say(refused));

    // agent.openaiReasoningEffort: the OpenAI-compatible path, which `atlias eval` and the native-arm driver use.
    const oaBodies = [];
    const oaFirst = async (over) => { const n = oaBodies.length; await loop.openaiChat({ openaiUrl: 'http://127.0.0.1:1/v1', openaiModel: 'm', ...over }, {}, { post: async (url, body) => { oaBodies.push(body); return { status: 200, json: { choices: [{ message: { role: 'assistant', content: 'done' } }] } }; } })([{ role: 'user', content: 'x' }], null); return oaBodies[n]; };
    const oaBase = JSON.stringify(await oaFirst({})), oaModel = JSON.stringify(await oaFirst({ openaiReasoningEffort: core.DEFAULTS.agent.openaiReasoningEffort }));
    const efforts = [];
    for (const v of ['none', ' NONE ', 'low', 'medium', 'high']) efforts.push((await oaFirst({ openaiReasoningEffort: v })).reasoning_effort);
    const badEffort = [];
    for (const v of ['model', 'off', 'maybe', '', null, undefined, true, 0, 'constructor', ['none']]) badEffort.push('reasoning_effort' in (await oaFirst({ openaiReasoningEffort: v })));
    const effortSetting = [core.parseSetting('agent', 'openaiReasoningEffort', 'NONE'), core.parseSetting('agent', 'openaiReasoningEffort', 'maybe')];
    check('the OpenAI reasoning effort is off by default (the request as before), sent only as one of none, low, medium, high, and typed by the settings command',
      oaBase === JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 0.2 }) && oaModel === oaBase && core.DEFAULTS.agent.openaiReasoningEffort === 'model'
        && efforts.join() === 'none,none,low,medium,high' && badEffort.every((b) => b === false)
        && effortSetting[0].value === 'none' && effortSetting[1].error && (settings.DESCRIPTIONS['agent.openaiReasoningEffort'] || '').length > 40,
      say({ oaBase, oaModel, efforts, badEffort, effortSetting }));
    // checked: none only where atlias can name a check for the run's directory, and runLoop says which directory that is.
    const withCheck = path.join(W, 'effort-checked'), noCheck = path.join(W, 'effort-bare');
    fs.mkdirSync(withCheck, { recursive: true }); fs.mkdirSync(noCheck, { recursive: true });
    fs.writeFileSync(path.join(withCheck, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }));
    const sentAt = async (at) => { const bodies = []; await loop.openaiChat({ openaiUrl: 'http://127.0.0.1:1/v1', openaiModel: 'm', openaiReasoningEffort: 'checked' }, {}, { post: async (url, body) => { bodies.push(body); return { status: 200, json: { choices: [{ message: { role: 'assistant', content: 'done' } }] } }; } })([{ role: 'user', content: 'x' }], null, at); return bodies[0]; };
    const checkedRows = [await sentAt({ cwd: withCheck }), await sentAt({ cwd: noCheck }), await sentAt(undefined), await sentAt({ cwd: 7 })].map((b) => b.reasoning_effort ?? null);
    const seenAt = [];
    await loop.runLoop(agentState(noCheck), 'say hi', { chat: async (m, t, at) => { seenAt.push(at); return { content: 'hi' }; }, say: () => {}, ask: async () => true, limits: { maxToolRounds: 2 } });
    check('checked sends none only for a directory with a check atlias can name, nothing without one or with no directory, and the loop passes the run directory to chat',
      checkedRows.join() === 'none,,,' && core.parseSetting('agent', 'openaiReasoningEffort', 'checked').value === 'checked' && seenAt.length >= 1 && seenAt.every((a) => a && a.cwd === noCheck),
      say({ checkedRows, seenAt }));

    const withIt = prompt({ implied: true }), without = prompt({ implied: false });
    check('off, the prompt is exactly the prompt without the paragraph', withIt.split('\n').filter((l) => l !== loop.IMPLIED_CHANGES).join('\n') === without && withIt.split('\n').filter((l) => l === loop.IMPLIED_CHANGES).length === 1, say({ on: withIt.length, off: without.length }));

    const native = prompt({ native: true, implied: true }), nativeOff = prompt({ native: true, implied: false });
    check('the native-tools prompt carries it only when asked, too', native.includes(loop.IMPLIED_CHANGES) && !nativeOff.includes(loop.IMPLIED_CHANGES), say({ on: native.includes(loop.IMPLIED_CHANGES), off: nativeOff.includes(loop.IMPLIED_CHANGES) }));

    check('the paragraph stays short: one line, three sentences', loop.IMPLIED_CHANGES.length < 400 && !loop.IMPLIED_CHANGES.includes('\n') && loop.IMPLIED_CHANGES.split(/[.:] /).length <= 5, say({ length: loop.IMPLIED_CHANGES.length }));

    const stamp = core.flagStamp({ flags: { impliedChanges: true } }, {});
    check('a run with the paragraph on says so in its report stamp', stamp.values.impliedChanges === true && stamp.changed.includes('impliedChanges') && core.flagStamp({ flags: {} }, {}).changed.length === 0, say(stamp));
  });
}
