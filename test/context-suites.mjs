// Context integrity on Ollama (NEXTGEN-4, build item 1).
//
// atlias sent Ollama no num_ctx, so every local run got the server's default
// window - 4096 tokens on this machine's 12 GiB VRAM tier - and an over-long
// prompt was cut from the front without a word, which drops the task message
// first. Measured here on 2026-09-25 against ollama 0.34.3 and
// qwen2.5-coder:7b at num_ctx 512 (D:/harness-work/runs/probe-truncate.txt):
// with the default a 2137-token prompt came back as a 200 that had evaluated
// 23 tokens and had lost the codeword it was asked for; with truncate:false
// the same request came back as HTTP 400 exceed_context_size_error naming both
// numbers. These checks hold the engine to the second behaviour.
//
// Loaded by test/run.mjs, which owns suite(), asyncSuite() and check().
import * as loop from '../lib/loop.mjs';

export default async function contextSuites({ asyncSuite, check, agentMod, TMP, fs, path }) {
  const W = path.join(TMP, 'context-work');
  fs.mkdirSync(W, { recursive: true });
  // The exact body ollama 0.34.3 returned, as bytes, so the parser is tested
  // against what the server says rather than what someone expected it to say.
  const overflowText = JSON.stringify({ error: JSON.stringify({ error: { code: 400, message: 'request (2137 tokens) exceeds the available context size (512 tokens), try increasing it', type: 'exceed_context_size_error', n_prompt_tokens: 2137, n_ctx: 512 } }) });
  const overflow = (prompt, ctx) => {
    const text = overflowText.replace('2137 tokens', `${prompt} tokens`).replace('512 tokens', `${ctx} tokens`).replace('2137', String(prompt)).replace(':512', `:${ctx}`);
    let json = null; try { json = JSON.parse(text); } catch { /* keep null */ }
    return { status: 400, json, text };
  };
  const show = (max) => ({ status: 200, json: { capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': max } } });
  const ok = (extra = {}) => ({ status: 200, json: { message: { content: 'done' }, done_reason: 'stop', prompt_eval_count: 900, prompt_eval_cached_count: 0, eval_count: 5, ...extra } });
  // A fake server: /api/show answers from `max`, /api/chat from the queue.
  const server = (max, replies) => {
    const bodies = [];
    const post = async (url, body) => {
      if (/\/api\/show$/.test(url)) return max === null ? { status: 404, text: 'not found' } : show(max);
      bodies.push(body);
      const r = replies.shift();
      return typeof r === 'function' ? r(body) : r || ok();
    };
    return { post, bodies };
  };
  const cfg = (over = {}) => ({ ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: 'qwen2.5-coder:7b', ollamaNumCtx: 16384, ollamaNumPredict: 2048, ollamaKeepAlive: '', ...over });

  await asyncSuite('context window expert', 'the model is told how much room it has, and an overflow is an error', async () => {
    check('the overflow parser reads ollama 0.34.3\'s own error body', JSON.stringify(loop.ollamaOverflow(overflow(2137, 512))) === JSON.stringify({ prompt: 2137, ctx: 512 }) && loop.ollamaOverflow({ status: 400, text: 'some other bad request' }) === null && loop.ollamaOverflow({ status: 200, text: '' }) === null, { happened: JSON.stringify([loop.ollamaOverflow(overflow(2137, 512)), loop.ollamaOverflow({ status: 400, text: 'x' })]), why: 'The body is a JSON string inside a JSON string; a parser written against a guess would miss it and file the overflow as a plain model error.', fix: 'Check ollamaOverflow against the measured body.' });
    check('the bucket is the smallest power of two that fits, never below the floor, never above the model', loop.ctxBucket(20000, 16384, 32768) === 32768 && loop.ctxBucket(100, 16384, 32768) === 16384 && loop.ctxBucket(40000, 16384, 32768) === 0 && loop.ctxBucket(17000, 16384, 0) === 32768 && loop.ctxBucket(5000, 4096, 131072) === 8192, { happened: JSON.stringify([loop.ctxBucket(20000, 16384, 32768), loop.ctxBucket(100, 16384, 32768), loop.ctxBucket(40000, 16384, 32768), loop.ctxBucket(17000, 16384, 0), loop.ctxBucket(5000, 4096, 131072)]), why: 'Every distinct num_ctx is a model reload, so the window moves in large steps; and a window past the model\'s trained length is one it was never taught to read.', fix: 'Check ctxBucket.' });

    const s1 = server(32768, [ok()]);
    const r1 = await loop.ollamaChat(cfg(), { post: s1.post })([{ role: 'user', content: 'x' }]);
    const b1 = s1.bodies[0] || {};
    check('every chat request carries num_ctx, num_predict and truncate:false', b1.truncate === false && b1.options && b1.options.num_ctx === 16384 && b1.options.num_predict === 2048 && b1.stream === false && !('keep_alive' in b1), { happened: JSON.stringify(b1), why: 'Without num_ctx Ollama picks its VRAM-tier default (4096 here) and cuts the front of the conversation, which is the task message, and says so only at debug level.', fix: 'Build the body in ollamaChat with options.num_ctx, options.num_predict and truncate:false.' });
    check('the window used is reported back with the usage', r1.usage && r1.usage.num_ctx === 16384 && r1.usage.prompt_eval_count === 900, { happened: JSON.stringify(r1.usage), why: 'A score measured at an unknown window cannot be compared with one measured at a known one.', fix: 'Put num_ctx into the usage ollamaChat returns.' });

    const s2 = server(8192, [ok()]);
    await loop.ollamaChat(cfg(), { post: s2.post })([{ role: 'user', content: 'x' }]);
    check('the window is capped at the model\'s own trained length', s2.bodies[0].options.num_ctx === 8192, { happened: JSON.stringify(s2.bodies[0].options), why: 'Asking for more than the model was trained on buys positions it has never seen.', fix: 'Read context_length from /api/show and cap num_ctx at it.' });

    const s3 = server(null, [ok()]);
    await loop.ollamaChat(cfg({ ollamaKeepAlive: '30m' }), { post: s3.post })([{ role: 'user', content: 'x' }]);
    check('an unknown model length leaves the configured window alone, and keep_alive goes out when set', s3.bodies[0].options.num_ctx === 16384 && s3.bodies[0].keep_alive === '30m', { happened: JSON.stringify(s3.bodies[0]), why: 'A failed /api/show is no reason to guess a smaller window, and an eval run should not pay a model reload between tasks.', fix: 'Treat a missing context_length as no cap; send keep_alive only when configured.' });

    // A /api/show that failed once is asked again, not remembered as "no length".
    let shows = 0;
    const flaky = { bodies: [] };
    flaky.post = async (url, body) => {
      if (/\/api\/show$/.test(url)) { shows++; return shows === 1 ? { status: 0, error: 'connect ECONNREFUSED' } : show(8192); }
      flaky.bodies.push(body);
      return ok();
    };
    const chatFlaky = loop.ollamaChat(cfg(), { post: flaky.post });
    await chatFlaky([{ role: 'user', content: 'x' }]);
    await chatFlaky([{ role: 'user', content: 'x' }]);
    check('a failed /api/show is asked again next call, and its answer still caps later windows', shows === 2 && flaky.bodies[0].options.num_ctx === 16384 && JSON.stringify(flaky.bodies.map((b) => b.options.num_ctx)) === '[16384,8192]', { happened: JSON.stringify({ shows, sent: flaky.bodies.map((b) => b.options.num_ctx) }), why: 'Ollama being down for one call is not evidence the model has no trained length; remembering it would lift the cap for the whole session.', fix: 'Cache the /api/show answer only when it came back 200.' });

    // An overflow the model can still hold: the window grows once and the call is retried.
    const s4 = server(32768, [overflow(20000, 16384), ok({ prompt_eval_count: 20000 })]);
    const r4 = await loop.ollamaChat(cfg(), { post: s4.post })([{ role: 'user', content: 'x' }]);
    check('an overflow that still fits the model grows the window and retries', s4.bodies.length === 2 && s4.bodies[1].options.num_ctx === 32768 && r4.content === 'done' && !r4.contextFull && r4.usage.num_ctx === 32768, { happened: JSON.stringify({ sent: s4.bodies.map((b) => b.options.num_ctx), r4 }), why: 'The model was trained to 32768; stopping at 16384 would throw away room it has.', fix: 'Retry with ctxBucket(prompt + num_predict) when it is larger than the current window.' });

    // One that cannot fit anywhere: a typed context-full, never a cut.
    const s5 = server(32768, [overflow(40000, 16384)]);
    const r5 = await loop.ollamaChat(cfg(), { post: s5.post })([{ role: 'user', content: 'x' }]);
    check('an overflow past the model\'s length comes back as context-full with both numbers', r5.contextFull && r5.contextFull.prompt === 40000 && r5.contextFull.ctx === 16384 && r5.contextFull.max === 32768 && /40000/.test(r5.error) && s5.bodies.length === 1, { happened: JSON.stringify(r5), why: 'This is the case the silent cut used to hide: the only honest answers are a bigger model window or a smaller conversation, and neither is a retry.', fix: 'Return { error, contextFull } from ollamaChat when no bucket fits.' });

    // A prompt that fitted, but left less room than num_predict: the next call gets a bigger window.
    const s6 = server(32768, [ok({ prompt_eval_count: 15000 }), ok()]);
    const chat6 = loop.ollamaChat(cfg(), { post: s6.post });
    await chat6([{ role: 'user', content: 'x' }]);
    await chat6([{ role: 'user', content: 'x' }]);
    check('a prompt that leaves no room for the reply grows the next window', s6.bodies[0].options.num_ctx === 16384 && s6.bodies[1].options.num_ctx === 32768, { happened: JSON.stringify(s6.bodies.map((b) => b.options.num_ctx)), why: 'num_ctx holds the prompt and the reply together; a 15000-token prompt in a 16384 window has 1384 tokens left for a 2048-token reply.', fix: 'After each reply, grow the window when prompt_eval_count + num_predict exceeds it.' });

    // The same chat function serves every task of an eval run. A window grown
    // for one conversation must not carry into the next (poly-B: task 3 grew to
    // 32768 and every later task ran there).
    await chat6([{ role: 'user', content: 'a different task' }]);
    await chat6([{ role: 'user', content: 'a different task' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'go on' }]);
    check('a new conversation starts at the base window again, and keeps it while it lasts', s6.bodies[2].options.num_ctx === 16384 && s6.bodies[3].options.num_ctx === 16384,
      { happened: JSON.stringify(s6.bodies.map((b) => b.options.num_ctx)), why: 'A window that only ever grows makes every later task in a run pay for one task\'s need, and per-task costs stop being comparable.', fix: 'ollamaChat resets numCtx when the opening user message changes.' });

    // The loop types it, and does not call it malformed output or a model error.
    const st = agentMod.newState(W, 'ollama');
    const reply = await loop.runLoop(st, 'fix it', { chat: loop.ollamaChat(cfg(), { post: server(32768, [overflow(40000, 16384)]).post }) });
    check('the run stops as context-full, in the closed set', st.stop && st.stop.reason === 'context-full' && loop.STOP_REASONS.includes('context-full') && /40000 tokens/.test(reply) && /32768/.test(reply), { happened: JSON.stringify(st.stop) + ' | ' + reply.slice(0, 200), why: 'A run that ended because the conversation outgrew the model is not a model that cannot format an action, and an eval row that says so is the difference between fixing the context and fixing the prompt.', fix: 'Check the res.contextFull branch in runLoop.' });

    // Per-round prompt tokens and the window reach the eval row.
    const evalMod = await import('../lib/eval.mjs');
    const task = { id: 'ctx-ledger-probe', name: 'ledger probe', files: { 'x.txt': 'x\n' }, prompt: 'answer', check: [process.execPath, '-e', 'process.exit(0)'] };
    const replies = [ok({ prompt_eval_count: 1200, message: { content: '```atlias\n{"tool":"list_dir","path":"."}\n```' } }), ok({ prompt_eval_count: 1500, message: { content: 'All done.' } })];
    const row = await evalMod.runTask(task, { chat: loop.ollamaChat(cfg(), { post: server(32768, replies).post }), state: agentMod.newState(W, 'ollama') });
    check('the eval row carries each round\'s prompt tokens and the window', JSON.stringify(row.promptTokens) === '[1200,1500]' && row.numCtx === 16384 && row.peakPrompt === 1500, { happened: JSON.stringify({ promptTokens: row.promptTokens, numCtx: row.numCtx, peakPrompt: row.peakPrompt, stop: row.stop }), why: 'poly-A kept no count of what the engine actually read, which is how a 4096 window went unnoticed through 27 tasks.', fix: 'Record usage.prompt_eval_count per round in runLoop and copy it into runTask\'s result.' });
    const rep = { results: [row], passed: 1, total: 1, ms: 10, engine: 'ollama', model: 'qwen2.5-coder:7b', numCtx: 16384, peakPrompt: 1500 };
    check('the report header names the window and the largest prompt', /context 16384 tokens, largest prompt 1500/.test(evalMod.format(rep)), { happened: evalMod.format(rep).split('\n').slice(0, 3).join(' | '), why: 'A number nobody prints is a number nobody checks.', fix: 'Check format in lib/eval.mjs.' });
    if (row.workspace) { try { fs.rmSync(row.workspace, { recursive: true, force: true }); } catch { /* left for inspection */ } }

    check('an openai engine pointed at a local Ollama /v1 is warned that it cannot set the window', /cannot set the context/.test(loop.v1ContextWarning('http://127.0.0.1:11434/v1')) && /cannot set the context/.test(loop.v1ContextWarning('http://localhost:11434/v1/')) && loop.v1ContextWarning('https://api.openai.com/v1') === '' && loop.v1ContextWarning('') === '', { happened: JSON.stringify([loop.v1ContextWarning('http://127.0.0.1:11434/v1'), loop.v1ContextWarning('https://api.openai.com/v1')]), why: 'Ollama\'s OpenAI-compatible endpoint has no num_ctx, so that route is stuck at the default window with the silent front cut.', fix: 'Check v1ContextWarning.' });
  });
}
