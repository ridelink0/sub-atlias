import http from 'node:http';
import { once } from 'node:events';
import * as localTransport from '../lib/local-transport.mjs';
import * as provider from '../lib/provider.mjs';
import { createPipelineRunner } from '../mods/atlias-pipeline/hooks/runner.mjs';
import { createPacket, createReceipt } from '../mods/atlias-pipeline/hooks/contract.mjs';

// Helper calls must stay metered, loopback only, never redirected, and leave one ledger row per attempt.
const WHY = 'A planner or reporter call must go only to the metered loopback Door, never follow a redirect or reach the direct upstream, and every attempt must be counted.';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const profile = (baseUrl, extra = {}) => ({ protocol: 'chat', baseUrl, model: 'fixture-model', ...extra });
const ask = { packetId: 'fixture-packet', system: 'SYSTEM FIXTURE', user: 'USER FIXTURE' };
const signal = () => new AbortController().signal;
const FULL = { prompt_tokens: 120, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 20 } };
const chat = (content, { finish = 'stop', usage = FULL } = {}) => ({
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
  ...(usage === null ? {} : { usage }),
});
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const fetchSpy = (respond = () => new Response(JSON.stringify(chat('spy reply')), { status: 200, headers: { 'Content-Type': 'application/json' } })) => {
  const spy = { calls: [], fetch: async (url, init) => { spy.calls.push({ url, init }); return respond(url, init); } };
  return spy;
};
const expectFailure = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };

// A loopback server on port 0 that records every request it receives.
async function door(respond) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    await respond(req, res, seen.length);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return { base: `http://127.0.0.1:${port}/v1`, port, seen, close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); }) };
}

export default async function addSuites({ asyncSuite, check }) {
  const info = (happened, fix) => ({ happened, why: WHY, fix });

  await asyncSuite('local transport expert', 'local transport: an ok call is metered with role, usage and a bearer key that never reaches the ledger', async () => {
    const key = 'ATLIAS_P2_FIXTURE_KEY';
    process.env[key] = 'fixture-secret-value';
    const srv = await door((req, res) => json(res, 200, chat('answer text')));
    try {
      const ledger = [];
      const transport = localTransport.createMeteredTransport({ profile: profile(srv.base, { keyEnv: key }), ledger, maxTokens: 64, reasoningEffort: 'none' });
      const planner = await transport({ role: 'planner', request: ask, signal: signal(), timeoutMs: 5000 });
      check('an ok call returns the reply text and capped false', planner.text === 'answer text' && planner.capped === false, info(JSON.stringify(planner), 'Return choices[0].message.content and capped only for finish_reason length.'));
      const sent = srv.seen[0];
      check('the call is one POST to /v1/chat/completions on the Door', sent?.method === 'POST' && sent.url === '/v1/chat/completions', info(JSON.stringify(sent && { m: sent.method, u: sent.url }), 'URL is baseUrl plus /chat/completions.'));
      check('the Door receives the role header for planner', sent?.headers['x-atlias-role'] === 'planner', info(String(sent?.headers['x-atlias-role']), 'Send X-Atlias-Role with the role name.'));
      check('the bearer key is sent when keyEnv names a set variable', sent?.headers.authorization === 'Bearer fixture-secret-value', info('authorization header mismatch', 'Send Authorization: Bearer from process.env[keyEnv] only when it is set.'));
      check('the body is the two-message chat request with max_tokens and reasoning_effort', same(sent?.body, {
        model: 'fixture-model',
        messages: [{ role: 'system', content: 'SYSTEM FIXTURE' }, { role: 'user', content: 'USER FIXTURE' }],
        stream: false,
        max_tokens: 64,
        reasoning_effort: 'none',
      }), info(JSON.stringify(sent?.body), 'Build messages from request.system and request.user; stream false.'));
      const row = ledger[0];
      check('one ledger row records the ok attempt with exact usage', ledger.length === 1 && row.role === 'planner' && row.seq === 1 && row.outcome === 'ok' && row.httpStatus === 200 && row.finishReason === 'stop'
        && same(row.usage, { input: 100, output: 9, cacheRead: 20, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, totalInput: 120, total: 129 }), info(JSON.stringify(ledger), 'Append one row per attempt with provider.tokens(usage, chat).'));
      check('the ledger and the return value never hold the key value', !JSON.stringify(ledger).includes('fixture-secret-value') && !JSON.stringify(planner).includes('fixture-secret-value'), info('key found in ledger or return value', 'Keep credentials out of ledger rows and results.'));
      const reporter = await transport({ role: 'reporter', request: ask, signal: signal(), timeoutMs: 5000 });
      check('the reporter call carries the reporter role header', srv.seen[1]?.headers['x-atlias-role'] === 'reporter' && reporter.text === 'answer text', info(String(srv.seen[1]?.headers['x-atlias-role']), 'Attribute each request by its own role.'));
      const summary = localTransport.summarizeLedger(ledger);
      check('the summary counts both roles and sums their usage', summary.calls === 2 && summary.byRole.planner.calls === 1 && summary.byRole.reporter.calls === 1 && summary.TOTAL === 258 && summary.fullPEAK === 129, info(JSON.stringify(summary), 'Sum totals over ok rows; the peak is the largest totalInput plus output.'));
    } finally {
      delete process.env[key];
      await srv.close();
    }
  });

  await asyncSuite('local transport expert', 'local transport: no key and no reasoning effort are sent when they are not configured', async () => {
    const srv = await door((req, res) => json(res, 200, chat('plain')));
    try {
      const ledger = [];
      const transport = localTransport.createMeteredTransport({ profile: profile(srv.base, { keyEnv: 'ATLIAS_P2_UNSET_KEY' }), ledger, maxTokens: 16 });
      await transport({ role: 'planner', request: ask, signal: signal(), timeoutMs: 5000 });
      const sent = srv.seen[0];
      check('no Authorization header is sent when the keyEnv variable is unset', sent.headers.authorization === undefined, info(String(sent.headers.authorization), 'Send Authorization only when the named variable holds a value.'));
      check('reasoning_effort is absent unless reasoningEffort is given', !('reasoning_effort' in sent.body) && sent.body.max_tokens === 16, info(JSON.stringify(sent.body), 'Add reasoning_effort only when configured.'));
    } finally {
      await srv.close();
    }
  });

  await asyncSuite('local transport expert', 'local transport: a 302 redirect is refused and its target is never requested', async () => {
    const target = await door((req, res) => json(res, 200, chat('target answered')));
    const srv = await door((req, res) => { res.writeHead(302, { Location: `${target.base}/chat/completions` }); res.end(); });
    try {
      const ledger = [];
      const transport = localTransport.createMeteredTransport({ profile: profile(srv.base), ledger, maxTokens: 8 });
      const error = await expectFailure(() => transport({ role: 'planner', request: ask, signal: signal(), timeoutMs: 5000 }));
      check('a 302 rejects with outcome redirect-refused', error?.outcome === 'redirect-refused', info(String(error?.outcome), 'Use redirect manual and refuse every 3xx.'));
      check('the redirect target is never requested', target.seen.length === 0, info(`target saw ${target.seen.length} requests`, 'Do not follow Location; the target must stay untouched.'));
      check('the Door saw exactly one attempt', srv.seen.length === 1, info(`door saw ${srv.seen.length}`, 'One attempt, no retry.'));
      check('the redirect row records 302 and unknown usage', ledger.length === 1 && ledger[0].outcome === 'redirect-refused' && ledger[0].httpStatus === 302 && ledger[0].usage === null, info(JSON.stringify(ledger), 'A refused redirect is an attempt with unknown usage.'));
    } finally {
      await srv.close();
      await target.close();
    }
  });

  await asyncSuite('local transport expert', 'local transport: a 500 is an http-error with unknown usage and no body echo', async () => {
    process.env.ATLIAS_P2_ECHO_KEY = 'fixture-secret-value';
    const srv = await door((req, res) => { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('echo ' + req.headers.authorization); });
    try {
      const ledger = [];
      const transport = localTransport.createMeteredTransport({ profile: profile(srv.base, { keyEnv: 'ATLIAS_P2_ECHO_KEY' }), ledger, maxTokens: 8 });
      const error = await expectFailure(() => transport({ role: 'reporter', request: ask, signal: signal(), timeoutMs: 5000 }));
      check('a 500 rejects with outcome http-error', error?.outcome === 'http-error' && ledger[0]?.outcome === 'http-error' && ledger[0].httpStatus === 500, info(String(error?.outcome), 'Any non-2xx that is not a redirect is http-error.'));
      check('the error and ledger never echo the reply body or key', !String(error?.message).includes('fixture-secret-value') && !JSON.stringify(ledger).includes('fixture-secret-value'), info(String(error?.message), 'Do not copy bodies or credentials into errors or rows.'));
      check('an http-error row has unknown usage', ledger[0].usage === null, info(JSON.stringify(ledger[0]), 'Unknown stays null.'));
    } finally {
      delete process.env.ATLIAS_P2_ECHO_KEY;
      await srv.close();
    }
  });

  await asyncSuite('local transport expert', 'local transport: a caller abort and a timeout each stop the call with their own outcome', async () => {
    const hang = await door(() => {});
    try {
      const ledger = [];
      const transport = localTransport.createMeteredTransport({ profile: profile(hang.base), ledger, maxTokens: 8 });
      const caller = new AbortController();
      setTimeout(() => caller.abort(), 60);
      const aborted = await expectFailure(() => transport({ role: 'planner', request: ask, signal: caller.signal, timeoutMs: 30000 }));
      check('the runner abort signal ends the call as aborted', aborted?.outcome === 'aborted' && ledger[0]?.outcome === 'aborted', info(String(aborted?.outcome), 'Honour the signal the runner passes in.'));
      const timed = await expectFailure(() => transport({ role: 'reporter', request: ask, signal: signal(), timeoutMs: 80 }));
      check('a call past timeoutMs ends as timeout', timed?.outcome === 'timeout' && ledger[1]?.outcome === 'timeout', info(String(timed?.outcome), 'Own a timer for timeoutMs and abort the request when it fires.'));
      check('both hung attempts are counted and have unknown usage', ledger.length === 2 && ledger.every(row => row.usage === null), info(JSON.stringify(ledger), 'Each attempt is one row.'));
    } finally {
      await hang.close();
    }
  });

  await asyncSuite('local transport expert', 'local transport: finish_reason length is capped and still returns its text', async () => {
    const srv = await door((req, res) => json(res, 200, chat('cut off mid', { finish: 'length' })));
    try {
      const ledger = [];
      const transport = localTransport.createMeteredTransport({ profile: profile(srv.base), ledger, maxTokens: 4 });
      const result = await transport({ role: 'planner', request: ask, signal: signal(), timeoutMs: 5000 });
      check('finish_reason length returns capped true with the partial text', result.capped === true && result.text === 'cut off mid', info(JSON.stringify(result), 'capped is finish_reason === length.'));
      const summary = localTransport.summarizeLedger(ledger);
      check('the capped row is counted as capped and not as a failure', ledger[0].outcome === 'capped' && summary.capped === 1 && summary.failures === 0, info(JSON.stringify(summary), 'capped is a completed call that was cut.'));
    } finally {
      await srv.close();
    }
  });

  await asyncSuite('local transport expert', 'local transport: missing usage is unknown and makes TOTAL and the peak null, never zero', async () => {
    let n = 0;
    const srv = await door((req, res) => { n++; json(res, 200, n === 1 ? chat('no usage here', { usage: null }) : chat('with usage')); });
    try {
      const ledger = [];
      const transport = localTransport.createMeteredTransport({ profile: profile(srv.base), ledger, maxTokens: 8 });
      await transport({ role: 'planner', request: ask, signal: signal(), timeoutMs: 5000 });
      await transport({ role: 'reporter', request: ask, signal: signal(), timeoutMs: 5000 });
      const summary = localTransport.summarizeLedger(ledger);
      check('a reply without usage is recorded with usage null', ledger[0].outcome === 'ok' && ledger[0].usage === null, info(JSON.stringify(ledger[0]), 'Missing usage is unknown.'));
      check('one unknown row makes TOTAL and fullPEAK null', summary.unknownUsage === 1 && summary.TOTAL === null && summary.fullPEAK === null && summary.byRole.planner.TOTAL === null && summary.byRole.reporter.TOTAL === 129, info(JSON.stringify(summary), 'TOTAL is null if any row is unknown.'));
      const knownOnly = localTransport.summarizeLedger([ledger[1], ledger[1]]);
      check('rows with usage alone still sum exactly', knownOnly.TOTAL === 258 && knownOnly.fullPEAK === 129 && knownOnly.unknownUsage === 0, info(JSON.stringify(knownOnly), 'Known rows sum without any unknown.'));
    } finally {
      await srv.close();
    }
  });

  await asyncSuite('local transport expert', 'local transport: summarizeLedger counts failures and capped rows and keeps unknown separate', async () => {
    const row = (role, outcome, usage, extra = {}) => ({ role, seq: 1, started: 0, finished: 1, httpStatus: null, outcome, finishReason: null, usage, ...extra });
    const known = { input: 100, output: 9, cacheRead: 20, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, totalInput: 120, total: 129 };
    const rows = [row('planner', 'ok', known), row('reporter', 'capped', known), row('planner', 'http-error', null)];
    const summary = localTransport.summarizeLedger(rows);
    check('failures count every non-ok non-capped row and calls count every row', summary.calls === 3 && summary.failures === 1 && summary.capped === 1 && summary.unknownUsage === 1, info(JSON.stringify(summary), 'Failed rows count as calls.'));
    check('per-role figures keep input, output, TOTAL and PEAK for known rows', same(summary.byRole.planner, { calls: 2, failures: 1, capped: 0, budgetCapped: 0, input: null, output: null, TOTAL: null, PEAK: null })
      && same(summary.byRole.reporter, { calls: 1, failures: 0, capped: 1, budgetCapped: 0, input: 120, output: 9, TOTAL: 129, PEAK: 129 }), info(JSON.stringify(summary.byRole), 'A role with an unknown row is unknown in full.'));
    check('an empty ledger is zero calls and zero peak', same(localTransport.summarizeLedger([]), { calls: 0, failures: 0, capped: 0, budgetCapped: 0, unknownUsage: 0, outputCapUnconfirmed: 0, byRole: {}, TOTAL: 0, fullPEAK: 0 }), info('empty ledger summary differs', 'No rows means no tokens.'));
    let threw = false;
    try { localTransport.summarizeLedger({}); } catch { threw = true; }
    check('a non-array ledger is refused', threw, info('no throw', 'summarizeLedger takes an array of rows.'));
  });

  await asyncSuite('local transport expert', 'local transport: a Door budget cap is budget-capped, a failure with no model spend, never ok or zero-cost success', async () => {
    // Codex review 1015, finding 3: the real Door's budget stop read as outcome ok, capped false, TOTAL 0.
    const capBody = { error: { message: 'budget spent', type: 'atlias_door_budget_capped' }, atlias_door: { outcome: 'budget-capped', modelCalled: false } };
    const legacy = { id: 'chatcmpl-step-limit', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'The step limit for this task has been reached. Stop now.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    let n = 0;
    const srv = await door((req, res) => {
      n++;
      if (n === 1) return json(res, 200, chat('first answer'), { 'X-Atlias-Door-Max-Tokens': '32' });
      if (n === 2) return json(res, 429, capBody, { 'X-Atlias-Door-Outcome': 'budget-capped' });
      if (n === 3) return json(res, 200, legacy);
      if (n === 4) return json(res, 200, chat('looks fine'), { 'X-Atlias-Door-Outcome': 'something-new' });
      if (n === 5) return json(res, 429, capBody);
      return json(res, 200, chat('no cap header'));
    });
    try {
      const ledger = [];
      const transport = localTransport.createMeteredTransport({ profile: profile(srv.base), ledger, maxTokens: 64 });
      const ok = await transport({ role: 'planner', request: ask, signal: signal(), timeoutMs: 5000 });
      const capped = await expectFailure(() => transport({ role: 'planner', request: ask, signal: signal(), timeoutMs: 5000 }));
      const old = await expectFailure(() => transport({ role: 'reporter', request: ask, signal: signal(), timeoutMs: 5000 }));
      const unknown = await expectFailure(() => transport({ role: 'reporter', request: ask, signal: signal(), timeoutMs: 5000 }));
      const plain429 = await expectFailure(() => transport({ role: 'reporter', request: ask, signal: signal(), timeoutMs: 5000 }));
      await transport({ role: 'reporter', request: ask, signal: signal(), timeoutMs: 5000 });
      check('the budget-capped header of the Door rejects the call as budget-capped, model not called', capped?.outcome === 'budget-capped' && ledger[1].outcome === 'budget-capped' && ledger[1].httpStatus === 429 && ledger[1].doorOutcome === 'budget-capped' && ledger[1].modelCalled === false,
        info(JSON.stringify(ledger[1]), 'Read X-Atlias-Door-Outcome before the status and reject budget-capped.'));
      check('the 200 stop reply of an older Door is budget-capped too, never ok text', old?.outcome === 'budget-capped' && ledger[2].doorOutcome === 'legacy-stop-reply' && ledger[2].modelCalled === false,
        info(JSON.stringify(ledger[2]), 'Recognise the legacy chatcmpl-step-limit id.'));
      check('an outcome the transport does not know fails closed with unknown usage', unknown?.outcome === 'door-outcome-unknown' && ledger[3].usage === null && ledger[3].modelCalled === null,
        info(JSON.stringify(ledger[3]), 'Unknown Door outcomes are failures; never read the body as an answer.'));
      check('a 429 without the Door header is an ordinary http-error with unknown usage', plain429?.outcome === 'http-error' && ledger[4].usage === null,
        info(JSON.stringify(ledger[4]), 'Only the header makes a cap; anything else is an error.'));
      check('the sent output cap the Door confirms is kept, and a reply without the header leaves it null (unconfirmed)', ok.text === 'first answer' && same(ledger[0].maxTokens, { asked: 64, sent: 32 }) && same(ledger[5].maxTokens, { asked: 64, sent: null }),
        info(JSON.stringify([ledger[0].maxTokens, ledger[5].maxTokens]), 'Record asked and the X-Atlias-Door-Max-Tokens value.'));
      const summary = localTransport.summarizeLedger(ledger);
      check('the summary counts both caps as budgetCapped failures that spent nothing, and the unknown outcome keeps TOTAL unknown', summary.calls === 6 && summary.budgetCapped === 2 && summary.failures === 4 && summary.capped === 0
        && summary.unknownUsage === 2 && summary.TOTAL === null && summary.outputCapUnconfirmed === 1
        && summary.byRole.planner.budgetCapped === 1 && summary.byRole.planner.TOTAL === 129 && summary.byRole.reporter.budgetCapped === 1 && summary.byRole.reporter.TOTAL === null,
        info(JSON.stringify(summary), 'budget-capped with modelCalled false is a known zero, a call and a failure.'));
      const capsOnly = localTransport.summarizeLedger([ledger[0], ledger[1], ledger[2]]);
      check('with only caps besides a known call, TOTAL is the known call alone and not unknown', capsOnly.TOTAL === 129 && capsOnly.fullPEAK === 129 && capsOnly.unknownUsage === 0 && capsOnly.budgetCapped === 2,
        info(JSON.stringify(capsOnly), 'A Door-answered cap spends no tokens.'));
      const forged = localTransport.summarizeLedger([{ ...ledger[1], modelCalled: null }]);
      check('a budget-capped row without modelCalled false is unknown, not zero', forged.unknownUsage === 1 && forged.TOTAL === null,
        info(JSON.stringify(forged), 'Zero spend needs the word of the Door itself.'));
    } finally {
      await srv.close();
    }
  });

  await asyncSuite('local transport expert', 'local transport: port 11435 and forbidPorts are refused with zero network and a refused row', async () => {
    const spy = fetchSpy();
    const ledger = [];
    const transport = localTransport.createMeteredTransport({ profile: profile('http://127.0.0.1:11435/v1'), ledger, maxTokens: 8, fetchImpl: spy.fetch });
    const error = await expectFailure(() => transport({ role: 'planner', request: ask, signal: signal(), timeoutMs: 5000 }));
    check('the direct upstream port 11435 is refused before any fetch', error?.outcome === 'refused' && spy.calls.length === 0, info(`outcome ${error?.outcome}, fetch calls ${spy.calls.length}`, 'Check the port before the request is built.'));
    check('the refusal leaves a refused row with unknown usage', ledger.length === 1 && ledger[0].outcome === 'refused' && ledger[0].role === 'planner' && ledger[0].usage === null, info(JSON.stringify(ledger), 'Every refusal still appends a row.'));

    const live = await door((req, res) => json(res, 200, chat('must not be reached')));
    try {
      const ledger2 = [];
      const listed = localTransport.createMeteredTransport({ profile: profile(live.base), ledger: ledger2, maxTokens: 8, forbidPorts: [live.port] });
      const refused = await expectFailure(() => listed({ role: 'reporter', request: ask, signal: signal(), timeoutMs: 5000 }));
      check('a listed forbidden port refuses a real loopback server, which sees zero requests', refused?.outcome === 'refused' && live.seen.length === 0, info(`outcome ${refused?.outcome}, server saw ${live.seen.length}`, 'forbidPorts is checked before any socket opens.'));
      const allowed = localTransport.createMeteredTransport({ profile: profile(live.base), ledger: [], maxTokens: 8, forbidPorts: [] });
      const reply = await allowed({ role: 'planner', request: ask, signal: signal(), timeoutMs: 5000 });
      check('with the list emptied the same loopback Door answers', reply.text === 'must not be reached' && live.seen.length === 1, info(JSON.stringify(reply), 'Only the listed ports are refused.'));
    } finally {
      await live.close();
    }
  });

  await asyncSuite('local transport expert', 'local transport: non-loopback endpoints are refused unless allowRemote is set, and plain http is never accepted', async () => {
    let threw = false;
    const httpSpy = fetchSpy();
    try { localTransport.createMeteredTransport({ profile: profile('http://remote.invalid/v1'), ledger: [], maxTokens: 8, fetchImpl: httpSpy.fetch }); } catch { threw = true; }
    check('plain http to a remote host is refused at construction, before any fetch', threw && httpSpy.calls.length === 0, info(`threw ${threw}, fetch ${httpSpy.calls.length}`, 'provider.validate refuses remote plain http, whatever allowRemote says.'));

    const ledger = [];
    const remoteSpy = fetchSpy();
    const closed = localTransport.createMeteredTransport({ profile: profile('https://remote.invalid/v1'), ledger, maxTokens: 8, fetchImpl: remoteSpy.fetch });
    const refused = await expectFailure(() => closed({ role: 'planner', request: ask, signal: signal(), timeoutMs: 5000 }));
    check('an https remote endpoint is refused by default with zero fetches', refused?.outcome === 'refused' && remoteSpy.calls.length === 0 && ledger[0]?.outcome === 'refused', info(`outcome ${refused?.outcome}, fetch ${remoteSpy.calls.length}`, 'Remote endpoints need allowRemote true.'));

    const opened = [];
    const allowedSpy = fetchSpy(() => new Response(JSON.stringify(chat('remote reply')), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const remote = localTransport.createMeteredTransport({ profile: profile('https://remote.invalid/v1'), ledger: opened, maxTokens: 8, allowRemote: true, fetchImpl: allowedSpy.fetch });
    const reply = await remote({ role: 'reporter', request: ask, signal: signal(), timeoutMs: 5000 });
    check('allowRemote true sends one request to the https endpoint', reply.text === 'remote reply' && allowedSpy.calls.length === 1 && allowedSpy.calls[0].url === 'https://remote.invalid/v1/chat/completions' && opened[0].outcome === 'ok', info(String(allowedSpy.calls[0]?.url), 'allowRemote only lifts the loopback rule.'));
  });

  await asyncSuite('local transport expert', 'local transport: invalid configuration and role or request misuse throw before any attempt', async () => {
    const spy = fetchSpy();
    const ledger = [];
    const bad = [
      () => localTransport.createMeteredTransport({ profile: profile('http://127.0.0.1:1/v1', { protocol: 'responses' }), ledger, maxTokens: 8, fetchImpl: spy.fetch }),
      () => localTransport.createMeteredTransport({ profile: profile('http://127.0.0.1:1/v1', { authHeader: 'x-api-key' }), ledger, maxTokens: 8, fetchImpl: spy.fetch }),
      () => localTransport.createMeteredTransport({ profile: profile('http://127.0.0.1:1/v1'), ledger, fetchImpl: spy.fetch }),
      () => localTransport.createMeteredTransport({ profile: profile('http://127.0.0.1:1/v1'), ledger: {}, maxTokens: 8, fetchImpl: spy.fetch }),
      () => localTransport.createMeteredTransport({ profile: profile('http://127.0.0.1:1/v1'), ledger, maxTokens: 8, forbidPorts: ['11435'], fetchImpl: spy.fetch }),
      () => localTransport.createMeteredTransport({ profile: profile('http://127.0.0.1:1/v1'), ledger, maxTokens: 8, reasoningEffort: '', fetchImpl: spy.fetch }),
    ];
    const refusedConstruction = bad.filter(make => { try { make(); return false; } catch { return true; } }).length;
    check('every invalid construction option throws', refusedConstruction === bad.length, info(`${refusedConstruction} of ${bad.length} threw`, 'Validate the profile, maxTokens (required), ledger, forbidPorts and reasoningEffort.'));
    const transport = localTransport.createMeteredTransport({ profile: profile('http://127.0.0.1:1/v1'), ledger, maxTokens: 8, fetchImpl: spy.fetch });
    const wrongRole = await expectFailure(() => transport({ role: 'judge', request: ask, signal: signal(), timeoutMs: 5000 }));
    const noRequest = await expectFailure(() => transport({ role: 'planner', request: { packetId: 'x' }, signal: signal(), timeoutMs: 5000 }));
    const noTimeout = await expectFailure(() => transport({ role: 'planner', request: ask, signal: signal() }));
    check('misuse throws TypeError with no row and no fetch', wrongRole instanceof TypeError && noRequest instanceof TypeError && noTimeout instanceof TypeError && ledger.length === 0 && spy.calls.length === 0, info(`ledger ${ledger.length}, fetch ${spy.calls.length}`, 'Only real attempts are rows.'));
  });

  await asyncSuite('local transport expert', 'local transport: an invalid or non-JSON reply is invalid-json with unknown usage', async () => {
    let n = 0;
    const srv = await door((req, res) => { n++; if (n === 1) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('not json at all'); } else json(res, 200, { choices: [] }); });
    try {
      const ledger = [];
      const transport = localTransport.createMeteredTransport({ profile: profile(srv.base), ledger, maxTokens: 8 });
      const first = await expectFailure(() => transport({ role: 'planner', request: ask, signal: signal(), timeoutMs: 5000 }));
      const second = await expectFailure(() => transport({ role: 'planner', request: ask, signal: signal(), timeoutMs: 5000 }));
      check('a body that is not JSON is invalid-json', first?.outcome === 'invalid-json' && ledger[0].outcome === 'invalid-json' && ledger[0].usage === null, info(String(first?.outcome), 'Unreadable replies are not text.'));
      check('a reply with no choices text is invalid-json too', second?.outcome === 'invalid-json' && ledger[1].outcome === 'invalid-json', info(String(second?.outcome), 'Require choices[0].message.content text.'));
    } finally {
      await srv.close();
    }
  });

  await asyncSuite('local transport expert', 'local transport: an unreachable endpoint is network-error', async () => {
    const spy = fetchSpy(async () => { throw new TypeError('fetch failed'); });
    const ledger = [];
    const transport = localTransport.createMeteredTransport({ profile: profile('http://127.0.0.1:1/v1'), ledger, maxTokens: 8, fetchImpl: spy.fetch });
    const error = await expectFailure(() => transport({ role: 'planner', request: ask, signal: signal(), timeoutMs: 5000 }));
    check('a failed connection is network-error with one attempt', error?.outcome === 'network-error' && ledger.length === 1 && spy.calls.length === 1 && ledger[0].httpStatus === null, info(String(error?.outcome), 'No retry on any failure.'));
  });

  await asyncSuite('local transport expert', 'local transport: the runner drives the metered transport for both roles with full authority and counts them', async () => {
    const packet = await createPacket({
      sessionId: 'fixture-session', actorId: 'fixture-actor', scopeVersion: 'fixture-scope',
      original: 'Fix the parser bug', followups: ['also add a regression test'],
      skills: [{ name: 'fixture-skill', version: '1.0.0', body: 'FIXTURE SKILL BODY' }], advisory: '',
    });
    const srv = await door((req, res) => {
      if (req.headers['x-atlias-role'] === 'planner') return json(res, 200, chat(JSON.stringify({ advisory: 'Check the parser boundary first.' })));
      return json(res, 200, chat(JSON.stringify({ text: 'The visible answer was read.', receiptIds: [] })));
    });
    try {
      const ledger = [];
      const transport = localTransport.createMeteredTransport({ profile: profile(srv.base), ledger, maxTokens: 256 });
      const runner = createPipelineRunner({ enabled: true, transport, timeoutMs: 5000, maxOutputChars: 4096 });
      const planned = await runner.runPlanner(packet);
      check('the planner advisory is attached as untrusted text and the call is ok', planned.enabled === true && planned.value.localPlanner.text === 'Check the parser boundary first.' && planned.receipts[0].outcome === 'ok', info(JSON.stringify(planned.receipts), 'The runner validates the advisory and attaches it.'));
      const plannerUser = JSON.parse(srv.seen[0].body.messages[1].content);
      check('the planner request carries the exact original, follow-up and selected skill body', plannerUser.authority.original.text === 'Fix the parser bug' && plannerUser.authority.followups[0].text === 'also add a regression test' && plannerUser.authority.skills[0].body === 'FIXTURE SKILL BODY', info(srv.seen[0].body.messages[1].content, 'Full authority goes to every helper request.'));
      const receipt = await createReceipt(packet, { eventKey: 'fixture-check-1', actorId: 'fixture-actor', kind: 'check', exitCode: 1 });
      const reported = await runner.runReporter(planned.value, [receipt], { answer: 'Done.', isAborted: false });
      check('the reporter line begins with the uncertainty prefix and the call is ok', reported.enabled === true && reported.receipts[0].outcome === 'ok' && reported.value.uiLine.startsWith('Interpretation uncertain: '), info(JSON.stringify(reported.receipts), 'Reporter output is advisory only.'));
      check('the Door saw planner then reporter with their role headers', srv.seen.length === 2 && srv.seen[0].headers['x-atlias-role'] === 'planner' && srv.seen[1].headers['x-atlias-role'] === 'reporter', info(JSON.stringify(srv.seen.map(s => s.headers['x-atlias-role'])), 'Attribution per role.'));
      const summary = localTransport.summarizeLedger(ledger);
      check('the ledger counts both roles, the total and the peak', summary.calls === 2 && summary.failures === 0 && summary.byRole.planner.calls === 1 && summary.byRole.reporter.calls === 1 && summary.TOTAL === 258 && summary.fullPEAK === 129, info(JSON.stringify(summary), 'Count every helper request by role.'));

      const failing = createPipelineRunner({ enabled: true, transport: localTransport.createMeteredTransport({ profile: profile('http://127.0.0.1:11435/v1'), ledger, maxTokens: 8 }), timeoutMs: 5000, maxOutputChars: 4096 });
      const kept = await failing.runPlanner(packet);
      check('a refused helper leaves the packet and the primary path unchanged', kept.value === packet && kept.receipts[0].outcome === 'transport_failure' && ledger.at(-1).outcome === 'refused', info(JSON.stringify(kept.receipts), 'A failed helper never alters the user text.'));
    } finally {
      await srv.close();
    }
  });

  await asyncSuite('local transport expert', 'local transport: runner off stays a pass-through and never calls the transport', async () => {
    const packet = await createPacket({ sessionId: 's', actorId: 'a', scopeVersion: 'v', original: 'Do it', followups: [], skills: [], advisory: '' });
    const spy = fetchSpy();
    const ledger = [];
    const transport = localTransport.createMeteredTransport({ profile: profile('http://127.0.0.1:1/v1'), ledger, maxTokens: 8, fetchImpl: spy.fetch });
    const runner = createPipelineRunner({ enabled: false, transport });
    const planned = await runner.runPlanner(packet);
    const reported = await runner.runReporter(packet, [], { answer: 'x', isAborted: false });
    check('with the runner off nothing is sent, recorded or changed', planned.enabled === false && planned.value === packet && reported.value.answer === 'x' && planned.receipts.length === 0 && spy.calls.length === 0 && ledger.length === 0, info(JSON.stringify([planned.enabled, reported.enabled]), 'Off is the old behaviour: no call, no row.'));
  });

  await asyncSuite('local transport expert', 'local transport: provider chat usage splits cache out of input and never invents zero for missing counts', async () => {
    const chatUsage = (extra) => provider.tokens({ prompt_tokens: 100, completion_tokens: 10, ...extra }, 'chat');
    check('cached prompt tokens are counted as cacheRead and not as input', same(chatUsage({ prompt_tokens_details: { cached_tokens: 40 } }), { input: 60, output: 10, cacheRead: 40, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, totalInput: 100, total: 110 }), info(JSON.stringify(chatUsage({ prompt_tokens_details: { cached_tokens: 40 } })), 'input = prompt_tokens minus cached_tokens; total = prompt + completion.'));
    check('usage without cache detail counts every prompt token as input', same(provider.tokens({ prompt_tokens: 7, completion_tokens: 2 }, 'chat'), { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, totalInput: 7, total: 9 }), info('absent cache detail changed the split', 'Absent cache detail is 0 cached tokens.'));
    const unknown = [
      null, 'text', [], {}, { completion_tokens: 1 }, { prompt_tokens: 1 }, { prompt_tokens: '1', completion_tokens: 1 },
      { prompt_tokens: 1.5, completion_tokens: 1 }, { prompt_tokens: -1, completion_tokens: 1 }, { prompt_tokens: true, completion_tokens: 1 },
      { prompt_tokens: 1, completion_tokens: null }, { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: null },
      { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: [] }, { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: null } },
      { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 11 } }, { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 },
    ];
    check('missing, malformed or contradictory chat counts are unknown (null), never zero', unknown.every(raw => provider.tokens(raw, 'chat') === null), info(JSON.stringify(unknown.map(raw => provider.tokens(raw, 'chat'))), 'Unknown is null.'));
    check('the chat cost uses the profile rates and refuses a missing rate', (() => {
      const usage = chatUsage({ prompt_tokens_details: { cached_tokens: 40 } });
      const cost = provider.cost(usage, { currency: 'USD', input: 2, output: 8, cacheRead: 0.2 });
      return cost && cost.currency === 'USD' && Math.abs(cost.value - 208e-6) < 1e-12 && provider.cost(usage, { currency: 'USD', input: 2 }) === null;
    })(), info('chat cost mismatch', 'Price each category at the profile rate; no default paid rate.'));
  });

  await asyncSuite('local transport expert', 'local transport: the chat protocol validates and anthropic and responses results are unchanged', async () => {
    const chatProfile = provider.validate(profile('http://127.0.0.1:11435/v1/', { pricing: { currency: 'USD', input: 1 } }), ['chat']);
    check('a chat profile validates and its baseUrl loses the trailing slash', chatProfile.protocol === 'chat' && chatProfile.baseUrl === 'http://127.0.0.1:11435/v1', info(JSON.stringify(chatProfile), 'Same URL normalisation as the other protocols.'));
    let message = '';
    try { provider.validate(profile('https://x.invalid/v1', { protocol: 'openai' })); } catch (error) { message = error.message; }
    check('the host protocol error is unchanged', message === 'protocol must be anthropic (Claude Code) or responses (Codex).', info(message, 'Host launches keep their exact old refusal.'));
    let hostChat = '';
    try { provider.validate(profile('http://127.0.0.1:8080/v1')); } catch (error) { hostChat = error.message; }
    check('a host launch never accepts a chat profile', hostChat === 'protocol must be anthropic (Claude Code) or responses (Codex).', info(hostChat || 'accepted', 'Claude Code and Codex cannot speak chat completions; only the helper transport asks for it.'));
    let helperOther = '';
    try { provider.validate(profile('http://127.0.0.1:8080/v1', { protocol: 'anthropic' }), ['chat']); } catch (error) { helperOther = error.message; }
    check('the helper transport accepts chat only', helperOther === 'protocol must be chat.', info(helperOther || 'accepted', 'The transport speaks chat completions only.'));
    // Expected values were captured from lib/provider.mjs before the chat change (lane P2 baseline).
    check('anthropic usage with cache reads and TTL writes is unchanged', same(provider.tokens({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 12, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 } }, 'anthropic'), { input: 10, output: 5, cacheRead: 20, cacheWrite: 5, cacheWrite5m: 3, cacheWrite1h: 4, totalInput: 42, total: 47 }), info('anthropic result changed', 'Protocol anthropic must stay byte-identical.'));
    check('anthropic plain usage is unchanged', same(provider.tokens({ input_tokens: 10, output_tokens: 5 }, 'anthropic'), { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, totalInput: 10, total: 15 }), info('anthropic plain changed', 'Protocol anthropic must stay byte-identical.'));
    check('anthropic usage without input_tokens stays unknown',provider.tokens({ input_tokens: 100, output_tokens: 20 }, 'anthropic') !== null && provider.tokens({ output_tokens: 20 }, 'anthropic') === null, info('anthropic unknown behaviour changed', 'Protocol anthropic must stay byte-identical.'));
    check('responses cached input and write split is unchanged', same(provider.tokens({ input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 }, output_tokens_details: { reasoning_tokens: 12 } }, 'responses'), { input: 60, output: 20, cacheRead: 30, cacheWrite: 10, cacheWrite5m: 0, cacheWrite1h: 0, totalInput: 100, total: 120 }), info('responses result changed', 'Protocol responses must stay byte-identical.'));
    check('responses plain usage is unchanged', same(provider.tokens({ input_tokens: 10, output_tokens: 5 }, 'responses'), { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, totalInput: 10, total: 15 }), info('responses plain changed', 'Protocol responses must stay byte-identical.'));
    check('responses overlapping cache is still refused', provider.tokens({ input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 9, cache_write_tokens: 2 } }, 'responses') === null, info('responses overlap accepted', 'Protocol responses must stay byte-identical.'));
    check('an unknown protocol still yields unknown usage', provider.tokens({ input_tokens: 1, output_tokens: 1 }, 'unknown') === null && provider.tokens({ prompt_tokens: 1, completion_tokens: 1 }, 'openai') === null, info('unknown protocol accepted', 'Only anthropic, responses and chat are known.'));
    check('anthropic and responses profiles still validate to the same object shape', same(provider.validate(profile('https://api.anthropic.com/v1', { protocol: 'anthropic', keyEnv: 'K_ENV', pricing: { currency: 'USD', input: 2, output: 8, cacheRead: 0.2, cacheWrite: 3 } })), { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'fixture-model', keyEnv: 'K_ENV', pricing: { currency: 'USD', input: 2, output: 8, cacheRead: 0.2, cacheWrite: 3 } }), info('anthropic profile shape changed', 'Protocol anthropic must stay byte-identical.'));
  });
}
