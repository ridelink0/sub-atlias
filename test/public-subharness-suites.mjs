import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import * as provider from '../lib/provider.mjs';
import * as native from '../lib/subharness.mjs';
import * as authority from '../lib/authority.mjs';
import * as progress from '../lib/progress.mjs';

const profile = (protocol = 'responses', extra = {}) => ({ protocol, baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture-model', ...extra });
const prices = { currency: 'USD', input: 2, output: 8, cacheRead: 0.2, cacheWrite: 3, cacheWrite5m: 4, cacheWrite1h: 6 };
const fails = (fn) => { try { fn(); return false; } catch { return true; } };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const parseSSE = (protocol, events) => {
  const reader = native.usageReader(protocol, true);
  const text = events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join('');
  for (let i = 0; i < text.length; i += 7) reader.push(text.slice(i, i + 7));
  return reader.finish();
};
async function server(fn) {
  const s = http.createServer(fn);
  s.listen(0, '127.0.0.1'); await once(s, 'listening');
  return { base: `http://127.0.0.1:${s.address().port}`, close: () => { s.closeIdleConnections?.(); return new Promise((r) => s.close(r)); } };
}
const readBody = async (req) => { const chunks = []; for await (const b of req) chunks.push(b); return Buffer.concat(chunks); };

export default async function publicSubharnessSuites({ suite, asyncSuite, check, core, router, track, brief, fs, path, PROJECT }) {
  const verify = (name, cond, happened, fix) => check(name, cond, { happened: typeof happened === 'object' ? JSON.stringify(happened) : happened, why: 'A public subharness must preserve native authority and report only observed usage without exposing credentials.', fix });

  suite('public provider expert', 'public subharness: profile and pricing contracts', () => {
    const loaded = provider.validate(profile('anthropic', { keyEnv: 'FIXTURE_API_KEY', pricing: prices }));
    verify('a valid profile carries caller-selected endpoint, model and prices', loaded.baseUrl.endsWith('/v1') && loaded.model === 'fixture-model' && loaded.pricing.input === 2, loaded, 'Keep supplied profile fields intact.');
    const bad = [null, [], profile('chat'), profile('responses', { baseUrl: 'http://remote.invalid/v1' }), profile('responses', { baseUrl: 'https://user:secret@remote.invalid/v1' }), profile('responses', { baseUrl: 'https://remote.invalid/v1?key=secret' }), profile('responses', { baseUrl: 'https://remote.invalid/v1#secret' }), profile('responses', { apiKey: 'never-save-me' }), profile('responses', { keyEnv: 'BAD\nNAME' }), profile('responses', { model: 'bad\nmodel' }), profile('responses', { authHeader: 'cookie' })];
    verify('credentials, invalid protocol and unsafe URLs are rejected before launch', bad.every((p) => fails(() => provider.validate(p))), 'invalid profiles checked', 'Validate protocol, HTTPS for remote endpoints, and key environment names.');
    const badRates = [-1, NaN, Infinity, '2', null, true];
    verify('negative, nonfinite and nonnumeric prices are rejected', badRates.every((rate) => fails(() => provider.validate(profile('responses', { pricing: { currency: 'USD', input: rate } })))), badRates.map(String), 'Require finite nonnegative numeric rates per million tokens.');
    verify('pricing metadata and currency are validated', fails(() => provider.validate(profile('responses', { pricing: { currency: 'usd' } }))) && fails(() => provider.validate(profile('responses', { pricing: { currency: 'USD', source: 1 } }))), 'invalid metadata checked', 'Do not invent a currency or publication source.');
    const f = path.join(PROJECT, 'public-provider-profile.json');
    fs.writeFileSync(f, '\uFEFF' + JSON.stringify(profile('responses', { keyEnv: 'FIXTURE_API_KEY' })));
    verify('UTF-8 BOM profiles load without saving secret values', provider.load(f).keyEnv === 'FIXTURE_API_KEY' && !fs.readFileSync(f, 'utf8').includes('secret-value'), provider.load(f), 'Read BOM-prefixed JSON and keep credentials in the environment.');
    const anth = provider.tokens({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 12, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 } }, 'anthropic');
    verify('Anthropic input, cache reads, and TTL writes are disjoint', equal(anth, { input: 10, output: 5, cacheRead: 20, cacheWrite: 5, cacheWrite5m: 3, cacheWrite1h: 4, totalInput: 42, total: 47 }), anth, 'Separate uncached input and each cache category once.');
    const resp = provider.tokens({ input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 }, output_tokens_details: { reasoning_tokens: 12 } }, 'responses');
    verify('Responses cached input and reasoning are not counted twice', resp?.input === 60 && resp.totalInput === 100 && resp.total === 120 && resp.output === 20, resp, 'Subtract cache categories from input and retain reasoning within output.');
    const malformed = [null, { input_tokens: -1, output_tokens: 1 }, { input_tokens: true, output_tokens: 1 }, { input_tokens: '1', output_tokens: 1 }, { input_tokens: 1.5, output_tokens: 1 }, { input_tokens: 1 }, { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }];
    verify('missing or malformed mandatory counts stay unknown', malformed.every((u) => provider.tokens(u, 'responses') === null), 'malformed counts checked', 'Do not coerce invalid token usage to zero.');
    verify('explicit null cache counts stay unknown', provider.tokens({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: null }, 'anthropic') === null && provider.tokens({ input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: null } }, 'responses') === null, 'explicit null optional cache fields checked', 'Default only absent cache fields, never explicit malformed counts.');
    const invalidDetail = [null, true, 1, 'cache-details', []];
    verify('malformed detail containers stay unknown without throwing', invalidDetail.every((detail) => {
      try { return provider.tokens({ input_tokens: 10, output_tokens: 1, input_tokens_details: detail }, 'responses') === null && provider.tokens({ input_tokens: 10, output_tokens: 1, cache_creation: detail }, 'anthropic') === null; } catch { return false; }
    }), 'malformed detail containers checked', 'Validate known usage detail objects before accessing their fields.');
    verify('overlapping cache categories and unknown protocols are refused', provider.tokens({ input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 9, cache_write_tokens: 2 } }, 'responses') === null && provider.tokens({ input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: 3 } }, 'anthropic') === null && provider.tokens({ input_tokens: 1, output_tokens: 1 }, 'unknown') === null, 'category limits checked', 'Validate protocol and category sums before counting.');
    const estimate = provider.cost(anth, prices);
    verify('cost is a labeled estimate with each supplied category rate', estimate?.currency === 'USD' && estimate.kind === 'estimate' && Math.abs(estimate.value - 115 / 1e6) < 1e-12, estimate, 'Price each disjoint token category at its caller-supplied rate.');
    verify('missing active rates or unknown usage produce unknown cost', provider.cost(anth, { currency: 'USD', input: 2, output: 8 }) === null && provider.cost(null, prices) === null && provider.cost(anth, { ...prices, input: -1 }) === null, 'unknown and invalid cost checked', 'Do not invent provider prices or treat missing rates as free.');
    verify('unused categories need no invented rate and explicit zero is valid', provider.cost(provider.tokens({ input_tokens: 10, output_tokens: 0 }, 'responses'), { currency: 'USD', input: 0 })?.value === 0, 'zero-priced category checked', 'Require a rate only for a nonzero observed category.');
    const known = { inference: true, terminal: true, tokens: resp, cost: provider.cost(resp, prices) };
    verify('unknown calls are retained in totals rather than discarded', provider.summarize([known, { inference: true, terminal: false }, { inference: false }]).totalTokens === null && provider.summarize([known, { inference: true, terminal: false }]).unknownUsage === 1, provider.summarize([known, { inference: true, terminal: false }]), 'Any unknown inference makes the aggregate unknown.');
    verify('terminal calls sum once and mixed currencies have no aggregate price', provider.summarize([known, known]).totalTokens === 240 && provider.summarize([known, { ...known, cost: { ...known.cost, currency: 'EUR' } }]).estimatedCost === null, provider.summarize([known, known]), 'Count physical calls once and never sum unlike currencies.');
    verify('unsafe integer aggregate totals remain unknown', provider.summarize([{ ...known, tokens: { total: Number.MAX_SAFE_INTEGER } }, { ...known, tokens: { total: 1 } }]).totalTokens === null, 'aggregate safe-integer limit checked', 'Validate the sum as well as each physical call.');
  });

  suite('public wire expert', 'public subharness: terminal usage parser', () => {
    const raw = { input_tokens: 11, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } };
    const repeated = parseSSE('responses', [{ type: 'response.completed', response: { usage: { input_tokens: 9, output_tokens: 1 } } }, { type: 'response.completed', response: { usage: raw } }]);
    verify('a repeated terminal usage replaces the snapshot rather than adding it', repeated.terminal && repeated.tokens.total === 14 && equal(repeated.rawUsage, raw), repeated, 'Store the final cumulative usage snapshot for one call.');
    for (const type of ['response.incomplete', 'response.failed']) {
      const absent = parseSSE('responses', [{ type, response: { usage: null } }]);
      const charged = parseSSE('responses', [{ type, response: { usage: raw } }]);
      verify(`${type} retains observed charged usage but unknown usage stays unknown`, absent.terminal && absent.tokens === null && charged.tokens?.total === 14, { absent, charged }, 'Failure is not completion, and measured charged tokens still count.');
    }
    const partial = parseSSE('responses', [{ type: 'response.created', response: { usage: raw } }]);
    verify('a stream without a terminal event remains unknown', !partial.terminal && partial.tokens === null, partial, 'Require a terminal provider event before trusting totals.');
    const anthRaw = { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 7 };
    const anth = parseSSE('anthropic', [{ type: 'message_start', message: { usage: anthRaw } }, { type: 'message_delta', usage: { output_tokens: 3 } }, { type: 'message_delta', usage: { output_tokens: 5 } }, { type: 'message_stop' }]);
    verify('Anthropic stream merges cumulative output with the original input categories', anth.tokens?.total === 16 && anth.rawUsage.output_tokens === 5 && anth.rawUsage.cache_read_input_tokens === 7, anth, 'Merge usage snapshots without summing deltas twice.');
    const begin = { type: 'message_start', message: { usage: anthRaw } }, end = { type: 'message_stop' };
    const provisional = parseSSE('anthropic', [begin, end]);
    verify('a stopped stream without final output usage keeps provisional counters but exact cost unknown', provisional.terminal && provisional.tokens === null && equal(provisional.rawUsage, anthRaw), provisional, 'Require message_delta output usage, not the initial zero.');
    const zero = parseSSE('anthropic', [begin, { type: 'message_delta', usage: { output_tokens: 0 } }, end]);
    verify('a final observed zero is valid and distinct from the provisional zero', zero.tokens?.total === 11, zero, 'Accept a real final zero without guessing missing counts.');
    const invalid = [undefined, null, [], {}, { output_tokens: -1 }, { output_tokens: '0' }, { output_tokens: 0.5 }, { output_tokens: Number.MAX_SAFE_INTEGER + 1 }];
    verify('a malformed later output snapshot cannot reuse an earlier valid count', invalid.every(usage => parseSSE('anthropic', [begin, { type: 'message_delta', usage: { output_tokens: 5 } }, { type: 'message_delta', usage }, end]).tokens === null), 'eight malformed later snapshots checked', 'Retain malformed final usage as an unknown condition.');
    const outOfOrder = [[{ type: 'message_delta', usage: { input_tokens: 4, output_tokens: 5 } }, end], [begin, end, { type: 'message_delta', usage: { output_tokens: 5 } }], [begin, { type: 'message_delta', usage: { output_tokens: 5 } }, begin, end]];
    verify('misordered or restarted message envelopes cannot certify a partial request', outOfOrder.every(events => parseSSE('anthropic', events).tokens === null), 'three invalid event orders checked', 'Bind final usage to one started message before its terminal event.');
    // A restart followed by its own valid final delta: only the restart guard rejects it, since the
    // second message alone would otherwise look complete (found when this guard's plant survived).
    const restartedThenFinal = parseSSE('anthropic', [begin, { type: 'message_delta', usage: { output_tokens: 5 } }, begin, { type: 'message_delta', usage: { output_tokens: 3 } }, end]);
    verify('a message restarted mid-stream cannot certify the second message alone', restartedThenFinal.tokens === null && !restartedThenFinal.terminal, restartedThenFinal, 'Treat a second message_start in one stream as broken.');
    const errored = parseSSE('anthropic', [{ type: 'message_start', message: { usage: anthRaw } }, { type: 'error', error: { message: 'fixture failure' } }, { type: 'message_stop' }]);
    verify('a stream error prevents a later stop from certifying partial usage', errored.tokens === null && !errored.terminal, errored, 'Keep the stream error as an unknown-usage condition.');
    const malformed = native.usageReader('responses', true); malformed.push('data: invalid-json\n\ndata: ' + JSON.stringify({ type: 'response.completed', response: { usage: raw } }) + '\n\n');
    verify('malformed stream data does not certify later totals', malformed.finish().tokens === null, 'malformed frame checked', 'Retain the parse failure in the receipt.');
    const nonterminal = native.usageReader('responses', false); nonterminal.push(JSON.stringify({ status: 'in_progress', usage: raw }));
    verify('a nonstreamed in-progress response is not terminal', nonterminal.finish().tokens === null, 'in-progress JSON checked', 'Require the native Responses terminal status for JSON responses.');
  });

  await asyncSuite('public transport expert', 'public subharness: exact transport and credential isolation', async () => {
    const received = [], receipts = [];
    const upstream = await server(async (req, res) => {
      const body = await readBody(req); received.push({ url: req.url, method: req.method, body, headers: req.headers });
      if (req.url.includes('redirect=1')) { res.writeHead(302, { location: upstream.base + '/redirect-target' }); res.end(); return; }
      if (req.url.includes('sse=1')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-fixture': 'preserved' });
        const bytes = Buffer.from('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'caf\u00e9 \u6f22\u5b57' }) + '\n\ndata: ' + JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 13, output_tokens: 4, fixture_label: 'caf\u00e9 \u6f22\u5b57' } } }) + '\n\n');
        for (const b of bytes) { res.write(Buffer.from([b])); await new Promise((r) => setImmediate(r)); }
        res.end(); return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'provider-cookie=secret' });
      res.end(JSON.stringify({ status: 'completed', usage: { input_tokens: 13, output_tokens: 4 } }));
    });
    let gateway;
    try {
      gateway = await native.meter(profile('responses', { baseUrl: upstream.base + '/v1', keyEnv: 'FIXTURE_API_KEY', pricing: prices }), { env: { FIXTURE_API_KEY: 'private-provider-secret' }, onReceipt: (r) => receipts.push(r) });
      const headers = { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json', cookie: 'local-cookie=private', 'x-native-contract': 'preserve-this' };
      const body = '{ "model": "fixture-model", "instructions": "Exact  authority\\nTAIL", "input": [{"role":"user","content":"follow-up"}], "tools":[{"type":"custom","name":"apply_patch","format":{"type":"grammar","definition":"exact"}}] }';
      const answer = await fetch(gateway.base + '/v1/responses', { method: 'POST', headers, body }); const json = await answer.json();
      verify('the meter preserves every original request byte and native header', received[0].body.toString('utf8') === body && received[0].headers['x-native-contract'] === 'preserve-this' && received[0].url === '/v1/responses', received[0].body.toString('utf8'), 'Forward the original body without parsing or rebuilding prompts or tools.');
      verify('upstream receives only the environment credential and receipts contain no key or prompt', received[0].headers.authorization === 'Bearer private-provider-secret' && !received[0].headers.cookie && !JSON.stringify(receipts).includes('private-provider-secret') && !JSON.stringify(receipts).includes('Exact  authority'), receipts, 'Strip local credentials/cookies and never log secret or request content.');
      verify('response bytes and usage survive without leaking provider cookies', json.usage.input_tokens === 13 && !answer.headers.get('set-cookie') && receipts[0].tokens?.total === 17 && receipts[0].cost?.kind === 'estimate', receipts[0], 'Preserve response data while keeping credentials out of downstream headers.');
      const sseResponse = await fetch(gateway.base + '/v1/responses?sse=1', { method: 'POST', headers, body }); const sse = await sseResponse.text();
      verify('split UTF-8 stream bytes are decoded once and forwarded unchanged', sse.includes('caf\u00e9 \u6f22\u5b57') && !sse.includes('\uFFFD') && sseResponse.headers.get('x-fixture') === 'preserved' && receipts[1].tokens?.total === 17 && receipts[1].rawUsage.fixture_label === 'caf\u00e9 \u6f22\u5b57', { sse, receipt: receipts[1] }, 'Use one streaming TextDecoder while relaying original bytes.');
      const beforeRedirect = received.length;
      const redirected = await fetch(gateway.base + '/v1/responses?redirect=1', { method: 'POST', headers, body, redirect: 'manual' }); await redirected.text();
      verify('provider redirects are not followed with credentials and location is not exposed', redirected.status === 302 && !redirected.headers.get('location') && received.length === beforeRedirect + 1, received.slice(beforeRedirect).map((r) => r.url), 'Set redirect=manual and strip provider Location.');
      const beforeBlocked = received.length;
      const denied = await fetch(gateway.base + '/v1/responses', { method: 'POST', body, headers: { authorization: 'Bearer wrong' } }); await denied.text();
      const unsupported = await fetch(gateway.base + '/v1/chat/completions', { method: 'POST', body, headers }); await unsupported.text();
      verify('unauthorized and unsupported inference paths never reach upstream', denied.status === 401 && unsupported.status === 404 && received.length === beforeBlocked, { denied: denied.status, unsupported: unsupported.status }, 'Refuse unknown inference endpoints and authenticate the local gateway.');
      const unknownModel = await fetch(gateway.base + '/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'another-model', input: [] }) }); await unknownModel.text();
      verify('usage for a different native model remains measured but its price is unknown', receipts.at(-1).tokens?.total === 17 && receipts.at(-1).cost === null, receipts.at(-1), 'Never apply one model price to another model.');
      let missingKey = false; try { const g = await native.meter(profile('responses', { keyEnv: 'ABSENT_FIXTURE_KEY' }), { env: {} }); await g.close(); } catch { missingKey = true; }
      verify('a missing credential stops before opening transport', missingKey, 'missing key rejected', 'Require the declared environment key before launch.');
    } finally { if (gateway) await gateway.close(); await upstream.close(); }
  });

  suite('public native launcher expert', 'public subharness: native command and follow-up routing', () => {
    const gateway = { base: 'http://127.0.0.1:12345', token: 'local-only-token' };
    const argv = ['exec', 'resume', 'existing-native-session', '--', 'Apply the follow-up verbatim'];
    const codex = native.nativeOptions('codex', profile(), gateway, argv, { KEEP: 'unchanged', OPENAI_API_KEY: 'ambient-secret' });
    verify('Codex resume and subcommand arguments remain in native order', equal(codex.args.slice(0, 2), ['exec', 'resume']) && codex.args[2] === '-c' && equal(codex.args.slice(-3), argv.slice(-3)) && codex.env.KEEP === 'unchanged' && codex.env.ATLIAS_GATEWAY_TOKEN === gateway.token, codex.args, 'Apply provider configuration within the native subcommand and leave the supplied native arguments in order.');
    verify('Codex receives caller-selected model and Responses endpoint', codex.args.includes('model="fixture-model"') && codex.args.includes('model_providers.atlias_api.wire_api="responses"') && codex.args.includes('model_providers.atlias_api.base_url="http://127.0.0.1:12345/v1"'), codex.args, 'Pass an explicit native Responses provider.');
    const claude = native.nativeOptions('claude', profile('anthropic'), gateway, ['--resume', 'native-session', 'follow-up'], { ANTHROPIC_API_KEY: 'ambient-secret', CLAUDE_CODE_USE_VERTEX: '1', KEEP: 'unchanged' });
    verify('Claude resumes natively with one plugin and selected model routing', equal(claude.args.slice(-3), ['--resume', 'native-session', 'follow-up']) && claude.args[0] === '--plugin-dir' && claude.env.ANTHROPIC_MODEL === 'fixture-model' && claude.env.ANTHROPIC_AUTH_TOKEN === gateway.token && !claude.env.ANTHROPIC_API_KEY && !claude.env.CLAUDE_CODE_USE_VERTEX && claude.env.KEEP === 'unchanged', { args: claude.args, model: claude.env.ANTHROPIC_MODEL }, 'Keep native session semantics while removing conflicting cloud routing.');
    verify('host/protocol mismatches fail before starting a native process', fails(() => native.nativeOptions('claude', profile(), gateway)) && fails(() => native.nativeOptions('codex', profile('anthropic'), gateway)), 'mismatch rejected', 'Require the protocol supported by the selected native host.');
  });

  await asyncSuite('public launcher process expert', 'public subharness: launcher forwards native follow-ups and records calls', async () => {
    const calls = [];
    const upstream = await server(async (req, res) => {
      const body = JSON.parse((await readBody(req)).toString('utf8')); calls.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 }, content: [{ type: 'text', text: 'observed' }] }));
    });
    const fixtureDir = path.join(PROJECT, 'native-process-fixture'); fs.mkdirSync(fixtureDir, { recursive: true });
    const script = path.join(fixtureDir, 'host.mjs');
    fs.writeFileSync(script, `import fs from 'node:fs';
const args = process.argv.slice(2);
const first = {model:process.env.ANTHROPIC_MODEL,messages:[{role:'user',content:'ORIGINAL_NATIVE_REQUEST'}]};
const second = {...first,messages:[...first.messages,{role:'assistant',content:'observed'},{role:'user',content:args.at(-1)}]};
for(const body of [first,second]) { const response = await fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',headers:{authorization:'Bearer '+process.env.ANTHROPIC_AUTH_TOKEN,'content-type':'application/json'},body:JSON.stringify(body)}); await response.text(); }
fs.writeFileSync(process.env.PUBLIC_FIXTURE_OUTPUT,JSON.stringify({args,model:process.env.ANTHROPIC_MODEL}));
process.exitCode=7;
`);
    const command = 'atlias-public-native-fixture';
    let executable;
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(fixtureDir, command + '.cmd'), '@"%dp0%\\host.mjs" %*\r\n'); executable = command;
    } else {
      executable = path.join(fixtureDir, command);
      fs.writeFileSync(executable, '#!/usr/bin/env node\n' + fs.readFileSync(script, 'utf8')); fs.chmodSync(executable, 0o700);
    }
    const output = path.join(fixtureDir, 'native.json'); const log = path.join(fixtureDir, 'usage.jsonl'); const file = path.join(fixtureDir, 'profile.json');
    fs.writeFileSync(file, JSON.stringify(profile('anthropic', { baseUrl: upstream.base + '/v1', pricing: prices })));
    const pathBefore = process.env.PATH; const outputBefore = process.env.PUBLIC_FIXTURE_OUTPUT;
    process.env.PATH = fixtureDir + path.delimiter + (pathBefore || ''); process.env.PUBLIC_FIXTURE_OUTPUT = output;
    try {
      const code = await native.launch({ host: 'claude', file, executable, args: ['--resume', 'native-retained-id', 'EXACT_NATIVE_FOLLOWUP'], logFile: log });
      const observed = JSON.parse(fs.readFileSync(output, 'utf8')); const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      verify('launcher returns native exit status with resume arguments unchanged', code === 7 && equal(observed.args.slice(-3), ['--resume', 'native-retained-id', 'EXACT_NATIVE_FOLLOWUP']) && observed.model === 'fixture-model', { code, observed }, 'Propagate the native child exit and preserve all user argv.');
      verify('one native process carries original request and follow-up to two physical calls', calls.length === 2 && calls[1].messages[0].content === 'ORIGINAL_NATIVE_REQUEST' && calls[1].messages.at(-1).content === 'EXACT_NATIVE_FOLLOWUP', calls, 'Let the native process own one conversation across its follow-up turns.');
      verify('launcher persists two complete receipts and totals both actual calls', rows.length === 2 && rows.every((r) => r.terminal && r.tokens.total === 12 && r.cost?.kind === 'estimate') && provider.summarize(rows).totalTokens === 24, rows, 'Write one observed receipt per physical inference, including later turns.');
    } finally {
      if (pathBefore === undefined) delete process.env.PATH; else process.env.PATH = pathBefore;
      if (outputBefore === undefined) delete process.env.PUBLIC_FIXTURE_OUTPUT; else process.env.PUBLIC_FIXTURE_OUTPUT = outputBefore;
      await upstream.close();
    }
  });

  suite('public authority expert', 'public subharness: exact follow-ups and selected skill retention', () => {
    const envBefore = process.env.ATLIAS_FLAG_AUTHORITY_LEDGER;
    process.env.ATLIAS_FLAG_AUTHORITY_LEDGER = '1';
    try {
      const sid = 'public-authority-session';
      const directSid = 'public-direct-authority';
      authority.record(directSid, 'EXACT_DIRECT_REQUEST', 'direct-id');
      authority.selected({ cwd: PROJECT, session_id: directSid, prompt: 'No skill selected.' });
      verify('direct authority entry points retain a request and clear its session', authority.read(directSid).length === 1 && authority.read(directSid)[0].text === 'EXACT_DIRECT_REQUEST', authority.read(directSid), 'Exercise exact recording without relying on a hook wrapper.');
      authority.clear(directSid);
      verify('direct clear retires only the selected session', authority.read(directSid).length === 0, authority.read(directSid), 'Clear the exact session ledger.');
      const long = '  ORIGINAL_AUTHORITY\r\n' + 'exact instruction '.repeat(1000) + '\r\nEND_ORIGINAL_AUTHORITY  ';
      const requests = [long, ...Array.from({ length: 14 }, (_, i) => `FOLLOWUP_${i}: preserve prior limits. ${'amendment '.repeat(50)}`), 'Repeat the exact request', 'Repeat the exact request'];
      requests.forEach((prompt, i) => router.prompt({ cwd: PROJECT, session_id: sid, prompt, prompt_id: `public-prompt-${i}` }));
      router.prompt({ cwd: PROJECT, session_id: sid, prompt: requests[0], prompt_id: 'public-prompt-0' });
      verify('native prompt retries deduplicate ids while repeated requests remain separate occurrences', authority.read(sid).length === requests.length && authority.read(sid).filter((r) => r.text === 'Repeat the exact request').length === 2, authority.read(sid).length, 'Deduplicate only an identical native prompt id, never request text.');
      const skillFile = path.join(PROJECT, 'selected-public-skill', 'SKILL.md'); fs.mkdirSync(path.dirname(skillFile), { recursive: true });
      const skillText = '---\nname: selected-public-skill\n---\n  EXACT_SKILL_HEAD\r\n' + 'Never alter this instruction. '.repeat(900) + '\r\nEXACT_SKILL_TAIL  ';
      fs.writeFileSync(skillFile, skillText);
      track.postTool({ cwd: PROJECT, session_id: sid, tool_name: 'Read', tool_input: { file_path: skillFile }, tool_response: { content: skillText } });
      track.postTool({ cwd: PROJECT, session_id: sid, tool_name: 'Read', tool_input: { file_path: skillFile }, tool_response: { content: skillText } });
      verify('a successful selected skill read retains complete exact instructions once', authority.read(sid).filter((r) => r.kind === 'skill').length === 1 && authority.read(sid).at(-1).text === skillText, authority.read(sid).map((r) => r.kind), 'Store the entire selected skill, not a pointer or excerpt.');
      const skillSid = 'public-native-skill-session';
      track.postTool({ cwd: PROJECT, session_id: skillSid, tool_name: 'Skill', tool_input: { skill: 'selected-public-skill' }, tool_response: { content: [{ type: 'text', text: `Base directory for this skill: ${path.dirname(skillFile)}\n\n${skillText}` }] } });
      verify('native Skill invocation retains full selected instructions', authority.read(skillSid).length === 1 && authority.read(skillSid)[0].text === skillText, authority.read(skillSid), 'Resolve the native Skill response base directory and retain full source instructions.');
      const shellSid = 'public-native-shell-skill';
      track.postTool({ cwd: PROJECT, session_id: shellSid, tool_name: 'exec_command', tool_input: { command: `cat "${skillFile}"` }, tool_response: { output: 'tool prefix\n' + skillText.replace(/\r\n/g, '\n') + '\ntool suffix', exit_code: 0 } });
      verify('native shell full-file skill read retains original file bytes', authority.read(shellSid).length === 1 && authority.read(shellSid)[0].text === skillText, authority.read(shellSid), 'Recognize named SKILL.md only when complete source bytes occur in the native tool output.');
      const excerptSid = 'public-shell-skill-excerpt';
      track.postTool({ cwd: PROJECT, session_id: excerptSid, tool_name: 'exec_command', tool_input: { command: `cat "${skillFile}"` }, tool_response: { output: skillText.slice(0, 100), exit_code: 0 } });
      verify('a mentioned skill or truncated shell excerpt is not treated as full authority', authority.read(excerptSid).length === 0, authority.read(excerptSid), 'Do not promote an excerpt into the complete selected skill.');
      const amendedSid = 'public-amended-skill';
      authority.skill(amendedSid, skillFile, 'VERSION_A'); authority.skill(amendedSid, skillFile, 'VERSION_A'); authority.skill(amendedSid, skillFile, 'VERSION_B'); authority.skill(amendedSid, skillFile, 'VERSION_A');
      verify('a reverted selected skill is a later ordered amendment rather than global duplicate text', equal(authority.read(amendedSid).map((r) => r.text), ['VERSION_A', 'VERSION_B', 'VERSION_A']), authority.read(amendedSid), 'Deduplicate unchanged successive selections, not an earlier version restored later.');
      const explicitFile = path.join(PROJECT, '.agents', 'skills', 'public-exact-project-skill', 'SKILL.md'); fs.mkdirSync(path.dirname(explicitFile), { recursive: true });
      const explicitText = '---\nname: public-exact-project-skill\ndescription: Exact project authority for the public test.\n---\n  EXPLICIT_SKILL_HEAD\r\n' + 'Preserve every selected instruction. '.repeat(200) + '\r\nEXPLICIT_SKILL_TAIL  ';
      fs.writeFileSync(explicitFile, explicitText);
      const explicitSid = 'public-explicit-project-skill';
      router.prompt({ cwd: PROJECT, session_id: explicitSid, prompt: 'Use $public-exact-project-skill for this request.', prompt_id: 'public-explicit-skill-prompt' });
      const selectedRows = authority.read(explicitSid);
      verify('an explicitly selected project skill is captured before any tool read', selectedRows.length === 2 && selectedRows[0].kind === 'request' && selectedRows[1].kind === 'skill' && selectedRows[1].file === explicitFile && selectedRows[1].text === explicitText && brief.build({ cwd: PROJECT, session_id: explicitSid, source: 'compact' }, 'codex').includes(explicitText), selectedRows.map((r) => ({ kind: r.kind, file: r.file })), 'Resolve exact native skill selection names and retain complete source instructions.');
      const substringSid = 'public-not-selected-skill';
      router.prompt({ cwd: PROJECT, session_id: substringSid, prompt: 'Use $public-exact-project-skill-extra for this request.', prompt_id: 'public-substring-skill' });
      verify('a different explicit name does not select a skill by substring', authority.read(substringSid).every((r) => r.kind === 'request'), authority.read(substringSid).map((r) => r.kind), 'Resolve exact selected names only.');
      const failedSkill = path.join(PROJECT, 'failed-skill', 'SKILL.md'); fs.mkdirSync(path.dirname(failedSkill), { recursive: true }); fs.writeFileSync(failedSkill, 'DO_NOT_PROMOTE_FAILED_READ');
      track.postTool({ cwd: PROJECT, session_id: sid, tool_name: 'Read', tool_input: { file_path: failedSkill }, tool_response: { is_error: true } });
      verify('failed selected skill reads never become session authority', !authority.render(sid).includes('DO_NOT_PROMOTE_FAILED_READ'), 'failed read rejected', 'Require a successful read before retaining skill text.');
      for (const source of ['compact', 'resume']) {
        const text = brief.build({ cwd: PROJECT, session_id: sid, source }, 'claude');
        const positions = requests.map((r, i) => text.indexOf(`User request ${i + 1}:\n${r}`));
        verify(`${source} restores long authority and selected skill exactly in occurrence order`, positions.every((p, i) => p >= 0 && (!i || p > positions[i - 1])) && text.includes(skillText) && text.split('Repeat the exact request').length === 3, text.length, 'Replay the independent authority ledger without evidence clipping.');
      }
      const post = progress.postCompact({ cwd: PROJECT, session_id: sid });
      const compacted = brief.build({ cwd: PROJECT, session_id: sid, source: 'compact' }, 'claude');
      verify('the compact SessionStart retains exact authority beyond the handoff evidence budget and PostCompact prints nothing', post === null && compacted.includes(long) && compacted.includes(skillText), { post, compacted: compacted.length }, 'Append exact authority separately from the clipped handoff in the SessionStart compact brief; PostCompact output reaches only the user.');
      process.env.ATLIAS_FLAG_AUTHORITY_LEDGER = '0';
      verify('off does not replay the added authority representation', authority.render(sid) === '' && !brief.build({ cwd: PROJECT, session_id: sid, source: 'resume' }, 'claude').includes('END_ORIGINAL_AUTHORITY'), 'explicit off mode checked', 'Keep this behavior behind the authority flag.');
      process.env.ATLIAS_FLAG_AUTHORITY_LEDGER = '1';
      verify('new session identity does not inherit another session authority', authority.render('public-new-session') === '', 'new native session checked', 'Scope request and skill authority to the native session.');
      const cleared = brief.build({ cwd: PROJECT, session_id: sid, source: 'clear' }, 'claude');
      router.prompt({ cwd: PROJECT, session_id: sid, prompt: 'NEW_OBJECTIVE_AFTER_CLEAR', prompt_id: 'public-after-clear' });
      const afterClear = brief.build({ cwd: PROJECT, session_id: sid, source: 'compact' }, 'claude');
      verify('clear retires prior authority before a new objective is compacted', !cleared.includes('END_ORIGINAL_AUTHORITY') && !afterClear.includes('END_ORIGINAL_AUTHORITY') && afterClear.includes('NEW_OBJECTIVE_AFTER_CLEAR'), { cleared: cleared.length, afterClear: afterClear.length }, 'Reset session authority on the native clear boundary.');
      const corrupt = 'public-corrupt-ledger'; fs.writeFileSync(authority.ledgerPath(corrupt), '{ invalid');
      verify('corrupt authority fails visibly instead of pretending instructions were retained', fails(() => authority.read(corrupt)), 'malformed ledger checked', 'Treat invalid persisted authority as unavailable.');
    } finally { if (envBefore === undefined) delete process.env.ATLIAS_FLAG_AUTHORITY_LEDGER; else process.env.ATLIAS_FLAG_AUTHORITY_LEDGER = envBefore; }
  });

  await asyncSuite('public concurrent authority expert', 'public subharness: concurrent hooks retain every instruction', async () => {
    const moduleUrl = new URL('../lib/authority.mjs', import.meta.url).href;
    const sid = 'public-concurrent-native-authority';
    const source = `const a=await import(${JSON.stringify(moduleUrl)});const who=process.argv[1];for(let i=0;i<20;i++){a.record(${JSON.stringify(sid)},'WORKER_'+who+'_REQUEST_'+i+' '+('exact concurrent authority '.repeat(100)),who+'-'+i);}a.skill(${JSON.stringify(sid)},'worker-'+who+'-SKILL.md','EXACT_CONCURRENT_SKILL_'+who);`;
    const jobs = Array.from({ length: 6 }, (_, i) => new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, String(i)], { env: { ...process.env }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = ''; child.stderr.on('data', (b) => { stderr += b; });
      child.once('error', (e) => resolve({ code: null, error: e.message })); child.once('exit', (code) => resolve({ code, stderr }));
    }));
    const results = await Promise.all(jobs);
    let rows = null; try { rows = authority.read(sid); } catch { /* surfaced by the check */ }
    verify('six simultaneous hook processes preserve all 120 requests and six selected skills', results.every((r) => r.code === 0) && rows?.length === 126 && new Set(rows.filter((r) => r.kind === 'request').map((r) => r.id)).size === 120 && rows.filter((r) => r.kind === 'skill').length === 6, { results, rows: rows?.length }, 'Serialize read-modify-write authority updates across native hook processes.');
  });
}
