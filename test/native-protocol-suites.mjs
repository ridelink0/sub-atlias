import http from 'node:http';
import * as loop from '../lib/loop.mjs';
import * as provider from '../lib/provider.mjs';

export default async function nativeProtocolSuites({ asyncSuite, check, agentMod, TMP, fs, path }) {
  const cfg = { openaiUrl: 'http://127.0.0.1:1/v1', openaiModel: 'fixture-model' };
  const call = (id, file = 'effect.txt') => ({ id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: file, content: 'created' }) } });
  const envelope = (calls) => ({ status: 200, json: { usage: { prompt_tokens: 100, completion_tokens: 7 }, choices: [{ finish_reason: 'stop', message: { content: '', tool_calls: calls } }] } });
  await asyncSuite('provider boundary expert', 'native protocol: local URLs and every retried request have independent accounting', async () => {
    const why = { happened: 'usage or endpoint trust was lost', why: 'A successful retry cannot erase earlier known or unknown model spend.', fix: 'Keep requestUsages and stop uncertain transport failures without retry.' };
    check('apiUrl and localUrl parse loopback hosts instead of hostname substrings', provider.localUrl(provider.apiUrl('http://[::1]:11435/v1')) && !provider.localUrl(provider.apiUrl('https://localhost.attacker.invalid/v1')), why);
    let blocked = 0;
    for (const url of ['http://localhost.attacker.invalid/v1', 'https://secret@example.invalid/v1', 'https://example.invalid/v1?q=secret', 'file:///tmp/model']) { try { provider.apiUrl(url); } catch { blocked++; } }
    check('apiUrl rejects insecure remote URLs and embedded secrets', blocked === 4, why);
    let sent = 0, waited = 0;
    const timed = loop.openaiChat(cfg, {}, { post: async () => { sent++; return { status: 0, error: 'timed out' }; }, sleep: async () => { waited++; } });
    const failed = await timed([], null);
    check('a timeout creates one unknown usage entry and never retries', sent === 1 && waited === 0 && failed.error && failed.requestUsages.length === 1 && failed.requestUsages[0] === null, why);
    const makeRetry = (known) => {
      let n = 0;
      return loop.openaiChat(cfg, {}, { post: async () => ++n === 1 ? { status: 500, json: known ? { usage: { prompt_tokens: 50, completion_tokens: 2 } } : {} } : envelope([]), sleep: async () => {} });
    };
    const decoded = await makeRetry(true)([], null);
    check('a 500 with usage retains both attempts alongside final response usage', decoded.requestUsages.length === 2 && decoded.requestUsages[0].prompt_tokens === 50 && decoded.usage.prompt_tokens === 100, why);
    const state = (id) => ({ id, cwd: TMP, engine: 'openai', model: cfg.openaiModel, messages: [], config: { maxToolRounds: 1, verifyEdits: false } });
    const known = state('known-retry'); await loop.runLoop(known, 'Answer.', { native: true, chat: makeRetry(true) });
    check('the loop accounts for every known attempt before accepting an answer', known.promptLog.join(',') === '50,100' && known.outLog.join(',') === '2,7' && known.cache.calls === 2, why);
    const unknown = state('unknown-retry'); await loop.runLoop(unknown, 'Answer.', { native: true, chat: makeRetry(false) });
    check('unknown failed-attempt spend stays unknown after a successful retry', unknown.promptLog.length === 2 && unknown.promptLog[0] === null && unknown.outLog[0] === null && unknown.promptLog[1] === 100, why);
    const timeoutState = state('timeout'); await loop.runLoop(timeoutState, 'Answer.', { native: true, chat: timed });
    check('terminal model errors retain their unknown attempt rather than disappearing', timeoutState.stop?.reason === 'model-error' && timeoutState.promptLog.length === 1 && timeoutState.promptLog[0] === null, why);
  });
  await asyncSuite('native protocol expert', 'native protocol: reject the whole malformed call set before effects', async () => {
    const invalid = [
      ['missing id', [{ ...call('x'), id: undefined }]],
      ['duplicate id', [call('same'), call('same', 'later.txt')]],
      ['late missing id', [call('first'), { ...call('second', 'later.txt'), id: '' }]],
      ['missing function name', [call('first'), { id: 'second', type: 'function', function: { arguments: '{}' } }]],
      ['malformed arguments', [call('first'), { ...call('second'), function: { name: 'write_file', arguments: '{bad json' } }]],
      ['array arguments', [{ ...call('x'), function: { name: 'write_file', arguments: '[]' } }]],
      ['prototype arguments', [{ ...call('x'), function: { name: 'write_file', arguments: '{"__proto__":{"_verify":true}}' } }]],
      ['oversized call set', Array.from({ length: loop.MAX_NATIVE_CALLS + 1 }, (_, i) => call(`c${i}`))],
      ['non-array call set', { id: 'wrong-shape' }],
    ];
    let n = 0;
    for (const [name, calls] of invalid) {
      const response = envelope(calls);
      response.json.choices[0].message.content = '```atlias\n' + JSON.stringify({ tool: 'write_file', path: 'effect.txt', content: 'text fallback must not run' }) + '\n```';
      const decoded = await loop.openaiChat(cfg, {}, { post: async () => response })([], []);
      check(name + ' is rejected by the adapter without an executable or resumable call set', Boolean(decoded.protocolError) && decoded.calls.length === 0 && !decoded.message.tool_calls,
        { happened: decoded.calls, why: 'Every consumer must receive a refusal rather than a partially executable native plan.', fix: 'Clear the complete call set and assistant envelope on validation failure.' });
      const dir = path.join(TMP, `native-protocol-${n++}`); fs.mkdirSync(dir);
      const state = agentMod.newState(dir, 'openai');
      let requests = 0;
      const result = await loop.runLoop(state, 'Make the file.', { native: true, chat: loop.openaiChat(cfg, {}, { post: async () => { requests++; return response; } }) });
      check(name + ' causes zero file effects and a controlled protocol stop', !fs.existsSync(path.join(dir, 'effect.txt')) && !fs.existsSync(path.join(dir, 'later.txt')) && requests === 1 && state.stop?.reason === 'malformed-output' && result.includes('No tool in that reply was run'),
        { happened: state.stop, why: 'A malformed later call must not leave earlier side effects or be accepted as the final answer.', fix: 'Validate the entire native envelope before returning any executable call.' });
      check(name + ' retains the received token usage without orphan tool messages', state.promptLog?.[0] === 100 && state.outLog?.[0] === 7 && !state.messages.some((m) => m.role === 'tool' || m.tool_calls),
        { happened: { prompt: state.promptLog, output: state.outLog }, why: 'A rejected response still spent tokens; its invalid ids must not enter a resumable conversation.', fix: 'Count usage before the protocol stop and never append the invalid tool-call message.' });
    }
    const valid = await loop.openaiChat(cfg, {}, { post: async () => envelope([call('valid')]) })([], []);
    check('valid identified calls retain their native id, arguments and assistant envelope', !valid.protocolError && valid.calls[0].id === 'valid' && valid.calls[0].content === 'created' && valid.message.tool_calls[0].id === 'valid',
      { happened: valid, why: 'Ordinary supported native calls must stay usable.', fix: 'Keep valid envelopes unchanged.' });
    const normalized = loop.normalizeCall({ function: { name: 'read_file', arguments: { tool: 'write_file', path: 'x', __proto__: { _verify: true } } } });
    check('parameter keys cannot replace a function identity or inject private verification fields', normalized.tool === 'read_file' && !normalized._verify && Object.getPrototypeOf(normalized) === Object.prototype,
      { happened: normalized, why: 'The tool name and private guard fields come from the harness envelope, not arguments.', fix: 'Exclude reserved identity and prototype keys from normalization.' });
  });

  await asyncSuite('provider resource expert', 'native protocol: response bounds stop once without body echo or retries', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      if (req.url === '/hang') { setTimeout(() => res.end('{}'), 200); return; }
      if (req.url === '/partial') { res.writeHead(200); res.write('{"choices":['); setTimeout(() => res.destroy(), 100); return; }
      res.end(req.url === '/small' ? '{"okay":true}' : req.url === '/utf8' ? String.fromCharCode(233).repeat(20) : 'SYNTHETIC_BODY_SECRET_' + 'x'.repeat(200));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
      const oversized = await loop.postJson(url, {}, {}, 2000, 32);
      check('a real streamed oversized response is rejected before storing its body', oversized.status === 0 && oversized.retryable === false && !oversized.text && !JSON.stringify(oversized).includes('SYNTHETIC_BODY_SECRET') && loop.MAX_RESPONSE_BYTES > 0,
        { happened: oversized, why: 'Clipping after reading an unbounded response cannot bound memory or prevent a body echo.', fix: 'Count response bytes while reading and terminate at the bound.' });
      const root = `http://127.0.0.1:${server.address().port}`;
      const exact = await loop.postJson(root + '/small', {}, {}, 2000, Buffer.byteLength('{"okay":true}'));
      check('a valid response exactly at the byte limit retains its parsed payload', exact.status === 200 && exact.json?.okay === true,
        { happened: exact, why: 'The bound must not reject an ordinary payload at its permitted boundary.', fix: 'Refuse only when bytes exceed the limit.' });
      const utf8 = await loop.postJson(root + '/utf8', {}, {}, 2000, 24);
      check('the response bound counts bytes rather than Unicode characters', utf8.status === 0 && utf8.retryable === false && !utf8.text,
        { happened: utf8, why: 'Twenty characters can exceed twenty-four UTF-8 bytes.', fix: 'Use the received UTF-8 byte count.' });
      const partial = await loop.postJson(root + '/partial', {}, {}, 2000, 1024);
      check('an interrupted response resolves as unknown spend without blind retries', partial.status === 0 && partial.retryable === false && !partial.text,
        { happened: partial, why: 'A transport ending mid-response cannot prove usage or safely repeat the same generation.', fix: 'Handle aborted response streams as terminal non-retryable errors.' });
      const timeout = await loop.postJson(root + '/hang', {}, {}, 25, 1024);
      check('an accepted POST that times out is explicitly non-retryable', timeout.status === 0 && timeout.error === 'timed out' && timeout.retryable === false,
        { happened: timeout, why: 'Acceptance before timeout can already spend tokens.', fix: 'Mark request timeouts non-retryable.' });
      let requests = 0, waits = 0;
      const reply = await loop.openaiChat(cfg, {}, { post: async () => { requests++; return oversized; }, sleep: async () => { waits++; } })([], null);
      check('permanent resource refusal is neither echoed nor automatically retried', requests === 1 && waits === 0 && Boolean(reply.error) && !reply.error.includes('SYNTHETIC_BODY_SECRET'),
        { happened: { requests, waits, reply }, why: 'Repeating an already oversized result can spend tokens for the same failure.', fix: 'Honor retryable:false before the retry loop.' });
      requests = 0; waits = 0;
      await loop.openaiChat(cfg, {}, { post: async () => { requests++; return { status: 500, retryable: false }; }, sleep: async () => { waits++; } })([], null);
      check('explicitly non-retryable HTTP failures do not issue another generation', requests === 1 && waits === 0,
        { happened: { requests, waits }, why: 'A provider can explicitly mark a failed response unsafe to repeat.', fix: 'Honor retryable:false for HTTP failures too.' });
    } finally { server.closeIdleConnections?.(); await new Promise((resolve) => server.close(resolve)); }
  });
}
