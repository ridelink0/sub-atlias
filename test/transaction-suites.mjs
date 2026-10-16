import { register, invalid, state, SPEC, LIMIT, NAME, DEFERRED, HOT_CORE, ENVELOPE_NOTE, HOT_CORE_DESCRIPTION, unchangedReadResult, unsupportedReadPlan, textReadResult } from '../mods/atlias-transaction/hooks/register.mjs';

function fixture(options = { enabled: true }, overrides = {}) {
  const hooks = [];
  const calls = [];
  const signal = new AbortController();
  const on = (event, matcher, hook) => {
    if (typeof matcher === 'function') hook = matcher;
    hooks.push({ event, hook });
    return { catch(handler) { hook.onError = handler; return this; } };
  };
  register(on, options);
  const api = { tool: {
    list: async () => ['ToolSearch', ...DEFERRED.filter(n => n !== 'PowerShell')].map(name => ({ name })),
    register: async s => { calls.push(['register', s]); },
    check: overrides.check || (async e => {
      if (!e.input || Object.keys(e).some(k => !['tool', 'input'].includes(k))) throw Error('wrong native permission envelope');
      return { decision: 'allow' };
    }),
    call: overrides.call || (async e => { calls.push(['call', e]); return e.tool === 'Read' ? { result: { type: 'text', file: { filePath: '/fixture.txt', content: 'exact diagnostic', numLines: 1, startLine: 1, totalLines: 1 } }, text: 'exact diagnostic' } : { result: { stdout: 'exact diagnostic', stderr: '' }, text: 'exact diagnostic' }; }),
  }, env: { get: async () => 'true' } };
  const next = async e => e;
  next.signal = signal.signal;
  return { hooks, calls, signal, api, next, batch: async operations => JSON.parse((await hooks.find(h => h.event === 'tool.call').hook(api, { operations }, next)).result) };
}

export default async function transactionSuites({ asyncSuite, check }) {
  await asyncSuite('native transaction expert', 'native batches validate before effects and preserve uncertain outcomes', async () => {
    const info = { happened: 'native batch fixture', why: 'Batching must not bypass authority or turn unknown execution into passing evidence.', fix: 'Preserve preflight, full diagnostics, refusal and partial-effect states.' };
    const op = { tool: 'Read', args: { file_path: '/fixture.txt' } };
    check('the registration and bound are explicit', SPEC.name === 'batch' && NAME === 'mcp__atlias-transaction__batch' && LIMIT === 8 && SPEC.isDeferred === false, info);
    check('the model sees the text-only boundary and native route', SPEC.description.includes('text only') && SPEC.description.includes('require-native-read') && SPEC.description.includes('standalone Read through ToolSearch'), info);
    check('the model sees the worker native-tool route', SPEC.description.includes('Workers use standalone native tools through ToolSearch.'), info);
    for (const agentId of ['host-worker-id', '', 123, {}]) {
      const worker = fixture();
      const handler = worker.hooks.find(h => h.event === 'tool.call').hook;
      const response = JSON.parse((await handler(worker.api, { operations: [op], agentId }, worker.next)).result);
      check('native actor metadata stops worker batches before any preflight/effects', response.status === 'require-native-tools' && response.attempted === 0 && worker.calls.length === 0, info);
    }
    const main = fixture();
    const mainHandler = main.hooks.find(h => h.event === 'tool.call').hook;
    const mainResponse = JSON.parse((await mainHandler(main.api, { operations: [op], agentId: null }, main.next)).result);
    check('explicit native main actor keeps text batching', mainResponse.status === 'executed' && mainResponse.attempted === 1, info);
    const off = fixture({ enabled: false });
    await off.hooks.find(h => h.event === 'session.start').hook(off.api, {}, off.next);
    check('off registers no tool', off.calls.length === 0, info);
    const good = fixture();
    const answer = await good.batch(Array(LIMIT).fill(op));
    check('a batch at its bound executes each operation with native arguments', answer.attempted === LIMIT && answer.status === 'executed' && good.calls.every(([, e]) => e.tool === 'Read' && e.file_path === '/fixture.txt'), info);
    check('full native diagnostics are preserved without a passing-test claim', answer.results.every(r => r.native.text === 'exact diagnostic' && r.native.result.type === 'text') && !Object.hasOwn(answer, 'passed'), info);
    check('text Read results keep only the explicit native text shape', answer.results[0].native.result.type === 'text' && answer.results[0].native.result.file.content === 'exact diagnostic' && !Object.hasOwn(answer.results[0].native.result.file, 'data'), info);
    for (const args of [{ file_path: '/fixture/image.png' }, { file_path: '/fixture/report.pdf' }, { file_path: '/fixture/report.pdf', pages: '1' }, { file_path: 'D:\\fixture\\IMAGE.PNG' }, { file_path: '/fixture.txt', pages: '' }]) {
      let preflights = 0; let dispatches = 0;
      const blocked = fixture(undefined, { check: async () => { preflights++; return { decision: 'allow' }; }, call: async () => { dispatches++; return { result: {} }; } });
      const response = await blocked.batch([{ tool: 'Read', args }, { tool: 'Write', args: { file_path: '/must-not-write.txt', content: 'x' } }]);
      check('image, PDF, or page Read plans require native Read before preflight/effects', response.status === 'require-native-read' && response.attempted === 0 && preflights === 0 && dispatches === 0, info);
    }
    let laterCalls = 0;
    const binary = fixture(undefined, { call: async e => { if (e.tool === 'Write') laterCalls++; return { result: { type: 'image', file: { base64: 'OPAQUE_BINARY_SENTINEL', dimensions: '1x1', originalSize: 68, type: 'image/png' } }, text: 'image description' }; } });
    const binaryAnswer = await binary.batch([op, { tool: 'Write', args: { file_path: '/must-not-write.txt', content: 'x' } }]);
    check('mixed image/text native Read halts and omits opaque bytes', binaryAnswer.status === 'require-native-read' && binaryAnswer.attempted === 1 && !JSON.stringify(binaryAnswer).includes('OPAQUE_BINARY_SENTINEL') && laterCalls === 0, info);
    check('only Read plans are restricted', unsupportedReadPlan({ tool: 'Write', args: { file_path: '/fixture.png' } }) === null, info);
    const exact = answer.results[0].native;
    check('valid text envelopes are preserved exactly', textReadResult(exact) === exact, info);
    const empty = { result: { type: 'text', file: { filePath: '', content: '', numLines: 0, startLine: 1, totalLines: 0 } }, text: '' };
    check('an empty text file remains valid', textReadResult(empty) === empty, info);
    for (const flag of [true, false]) {
      const capped = { ...exact, result: { ...exact.result, file: { ...exact.result.file, truncatedByTokenCap: flag } } };
      check('native text truncation metadata is preserved: ' + flag, textReadResult(capped) === capped, info);
    }
    for (const [key, value] of [['filePath', {}], ['content', null], ['numLines', '1'], ['numLines', -1], ['numLines', 1.5], ['startLine', 0], ['totalLines', NaN], ['totalLines', 0], ['truncatedByTokenCap', 'true']]) {
      const malformed = { ...exact, result: { ...exact.result, file: { ...exact.result.file, [key]: value } } };
      check('malformed native text metadata fails closed: ' + key + '/' + String(value), textReadResult(malformed) === null, info);
    }
    for (const value of [undefined, [], { text: 'unknown' }, { ...exact, content: [{ type: 'image', data: 'OPAQUE_BINARY_SENTINEL' }] }, { ...exact, result: { ...exact.result, file: { ...exact.result.file, base64: 'OPAQUE_BINARY_SENTINEL' } } }]) {
      check('unknown or mixed envelopes require native Read', textReadResult(value) === null, info);
    }
    check('invalid and oversized complete plans are refused before any dispatch', invalid([op, { tool: 'Write', args: [] }]) && invalid(Array(LIMIT + 1).fill(op)) && invalid([]), info);
    for (const key of ['tool', 'tool_use_id', 'consent', 'agentId', '__proto__', 'constructor', 'prototype']) {
      const reserved = { tool: 'Write', args: { file_path: '/forbidden.txt' } };
      Object.defineProperty(reserved.args, key, { value: 'untrusted', enumerable: true });
      check('reserved field is refused: ' + key, !!invalid([reserved]), info);
    }
    const denied = fixture(undefined, { check: async e => ({ decision: e.tool === 'Write' ? 'deny' : 'allow', reason: 'policy denial' }) });
    const deniedAnswer = await denied.batch([op, { tool: 'Write', args: { file_path: '/forbidden.txt' } }]);
    check('a later preflight denial prevents all earlier effects', denied.calls.length === 0 && deniedAnswer.attempted === 0 && deniedAnswer.status === 'refused' && deniedAnswer.reason === 'policy denial', info);
    const unknown = fixture(undefined, { check: async () => ({ decision: 'unrecognized' }) });
    check('an unknown permission decision cannot dispatch', (await unknown.batch([op])).status === 'unknown' && unknown.calls.length === 0, info);
    let attempts = 0;
    const failed = fixture(undefined, { call: async () => { attempts++; return { result: { stderr: 'middle assertion failure' }, text: 'middle assertion failure', isError: true }; } });
    const failedAnswer = await failed.batch([op, op]);
    check('tool errors retain text diagnostics and stop dependent operations', attempts === 1 && failedAnswer.status === 'tool-error' && failedAnswer.results[0].native.text === 'middle assertion failure' && failedAnswer.results[0].native.isError === true, info);
    let shellErrors = 0;
    const failedShell = fixture(undefined, { call: async () => { shellErrors++; return { result: { stderr: 'Exact shell failure.' }, text: 'Exact shell failure.', isError: true }; } });
    const shellErrorAnswer = await failedShell.batch([{ tool: 'Bash', args: { command: 'node check.mjs' } }, op]);
    check('non-Read native failures keep their full result and stop later operations', shellErrors === 1 && shellErrorAnswer.status === 'tool-error' && shellErrorAnswer.results[0].native.result.stderr === 'Exact shell failure.', info);
    const errorWithOpaque = fixture(undefined, { call: async () => ({ result: { base64: 'OPAQUE_BINARY_SENTINEL' }, text: 'Exact native error.\nSecond diagnostic line.', isError: true }) });
    const errorAnswer = await errorWithOpaque.batch([op, op]);
    check('native error text is lossless while opaque error payload stays out', errorAnswer.attempted === 1 && errorAnswer.results[0].native.text === 'Exact native error.\nSecond diagnostic line.' && !JSON.stringify(errorAnswer).includes('OPAQUE_BINARY_SENTINEL'), info);
    const aborted = fixture();
    aborted.signal.abort();
    check('cancellation before dispatch produces no effects', (await aborted.batch([op])).status === 'aborted' && aborted.calls.length === 0, info);
    let inFlight;
    inFlight = fixture(undefined, { call: async () => { inFlight.signal.abort(); throw Error('in-flight cancellation'); } });
    const partial = await inFlight.batch([op, op]);
    check('in-flight cancellation reports possible partial effects and never replays', partial.status === 'aborted' && partial.attempted === 1 && partial.results[0].effects === 'unknown', info);
    check('only explicit native result shapes establish execution', state({ deny: 'no' }) === 'refused' && state({ result: {}, isError: true }) === 'tool-error' && state({ result: {} }) === 'executed' && state({ text: 'ok' }) === 'unknown', info);
    for (const malformed of [null, [], 'ok', { result: undefined }, { result: null }, { result: {}, deny: null }, { result: {}, isError: 'true' }, { result: {}, isError: 1 }, { result: {}, text: null }, { result: {}, futureError: true }, Object.assign(Object.create({ isError: true }), { result: {} }), Object.defineProperty({ result: {} }, 'futureError', { value: true }), { result: {}, context: 'invalid' }]) {
      const test = fixture(undefined, { call: async e => { test.calls.push(['call', e]); return malformed; } });
      const answer = await test.batch([{ tool: 'Bash', args: { command: 'check' } }, { tool: 'Write', args: { file_path: '/later.txt', content: 'later' } }]);
      check('malformed native status cannot execute a later operation: ' + JSON.stringify(malformed), state(malformed) === 'unknown' && answer.status === 'unknown' && answer.attempted === 1 && test.calls.length === 1, info);
    }
    const placement = fixture({ enabled: true, deferBuiltins: true });
    await placement.hooks.find(h => h.event === 'session.start').hook(placement.api, {}, placement.next);
    const describe = placement.hooks.find(h => h.event === 'tool.describe').hook;
    const original = { description: 'Full native contract and policy.', isDeferred: false };
    const describeNext = async () => original;
    for (const setup of [api => { api.tool.list = async () => [{ name: 'Read' }]; }, api => { api.tool.list = async () => [null]; }, api => { api.tool.list = async () => [{ name: 'Read' }, { name: 'Read' }]; }, api => { api.tool.list = async () => ({}); }]) {
      const degraded = fixture({ enabled: true, deferBuiltins: true });
      setup(degraded.api);
      await degraded.hooks.find(h => h.event === 'session.start').hook(degraded.api, {}, degraded.next);
      check('unavailable or malformed discovery leaves native Read reachable', !degraded.calls.some(([kind]) => kind === 'register') && await degraded.hooks.find(h => h.event === 'tool.describe').hook(degraded.api, { tool: 'Read', provider: { plugin: 'engine' } }, describeNext) === original, info);
    }
    const search = await describe(placement.api, { tool: 'ToolSearch', provider: { plugin: 'engine' } }, describeNext);
    for (const fail of ['list', 'register', 'missing-search', 'missing-list', 'missing-register']) {
      const restarted = fixture({ enabled: true, deferBuiltins: true });
      const start = restarted.hooks.find(h => h.event === 'session.start').hook;
      await start(restarted.api, {}, restarted.next);
      if (fail === 'missing-search') restarted.api.tool.list = async () => [{ name: 'Read' }];
      else if (fail.startsWith('missing-')) delete restarted.api.tool[fail.slice(8)];
      else restarted.api.tool[fail] = async () => { throw Error('native API unavailable'); };
      try { await start(restarted.api, {}, restarted.next); } catch { await start.onError(restarted.api, {}, restarted.next); }
      check('startup failure clears previously deferred tools: ' + fail, await restarted.hooks.find(h => h.event === 'tool.describe').hook(restarted.api, { tool: 'Read', provider: { plugin: 'engine' } }, describeNext) === original, info);
    }
    check('every available deferred name is discoverable without inventing unavailable tools', search.description.startsWith(original.description) && DEFERRED.filter(n => n !== 'PowerShell').every(n => search.description.includes(n)) && !search.description.includes('PowerShell'), info);
    check('the registered schema only advertises tools available in this profile', !placement.calls.find(([kind]) => kind === 'register')[1].inputSchema.properties.operations.items.properties.tool.enum.includes('PowerShell'), info);
    check('an unknown native tool or external provider passes through unchanged', await describe(placement.api, { tool: 'FutureTool', provider: { plugin: 'engine' } }, describeNext) === original && await describe(placement.api, { tool: 'Read', provider: { plugin: 'external' } }, describeNext) === original, info);
    check('known native tools keep their full text when deferred', (await describe(placement.api, { tool: 'Read', provider: { plugin: 'engine' } }, describeNext)).description === original.description, info);
    for (const value of [undefined, 'false', 'auto']) {
      placement.api.env.get = async () => value;
      check('unsupported tool-search capability passes through: ' + value, await describe(placement.api, { tool: 'Read', provider: { plugin: 'engine' } }, describeNext) === original, info);
    }
    check('default-off description passes through unchanged', await off.hooks.find(h => h.event === 'tool.describe').hook(off.api, { tool: 'Read', provider: { plugin: 'engine' } }, describeNext) === original, info);
  });
  await asyncSuite('native hot core placement', 'hot core keeps the common native tools visible and leaves old placements reproducible', async () => {
    const info = { happened: 'hot core fixture', why: 'Local models wrapped direct native calls in the batch envelope; old placements must stay reproducible for stored runs.', fix: 'Keep hotCoreTools off by default, defer only the other available names, and state the envelope boundary.' };
    const original = { description: 'Full native contract and policy.', isDeferred: false };
    const describeNext = async () => original;
    const profile = ['ToolSearch', ...DEFERRED.filter(n => n !== 'PowerShell')];
    const started = async (options, names = profile) => {
      const f = fixture(options);
      f.api.tool.list = async () => names.map(name => ({ name }));
      await f.hooks.find(h => h.event === 'session.start').hook(f.api, {}, f.next);
      const describe = f.hooks.find(h => h.event === 'tool.describe').hook;
      f.describe = (tool, plugin = 'engine') => describe(f.api, { tool, provider: { plugin } }, describeNext);
      f.registered = f.calls.find(([kind]) => kind === 'register')?.[1];
      return f;
    };
    const oldSearch = original.description + '\nNative tools deferred by this mod: ' + profile.slice(1).join(', ') + '. Load one with select:<name> before calling it directly. Batch operations: Bash, Edit, Read, Write.';
    for (const hotCoreTools of [undefined, false, 'true', 1]) {
      const old = await started({ enabled: true, deferBuiltins: true, hotCoreTools });
      check('deferBuiltins=true without hotCoreTools=true keeps the old ToolSearch text: ' + hotCoreTools, (await old.describe('ToolSearch')).description === oldSearch, info);
      check('deferBuiltins=true without hotCoreTools=true keeps the old batch description: ' + hotCoreTools, old.registered.description === SPEC.description, info);
      for (const tool of ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Skill']) check('old deferral still defers ' + tool + ': ' + hotCoreTools, (await old.describe(tool)).isDeferred === true, info);
    }
    for (const options of [{ enabled: true, deferBuiltins: false, hotCoreTools: true }, { enabled: true, hotCoreTools: true }, { enabled: false, deferBuiltins: true, hotCoreTools: true }]) {
      const native = await started(options);
      const label = JSON.stringify(options);
      check('hotCoreTools without active deferral changes no placement: ' + label, (await Promise.all(['ToolSearch', 'Read', 'Grep', 'Agent'].map(t => native.describe(t)))).every(r => r === original), info);
      check('hotCoreTools without active deferral keeps the old batch description: ' + label, options.enabled ? native.registered.description === SPEC.description : native.registered === undefined, info);
    }
    const hot = await started({ enabled: true, deferBuiltins: true, hotCoreTools: true });
    // deferShell: only with hotCoreTools and only when exactly true; then the shells are deferred and named, the rest unchanged.
    const shells = await started({ enabled: true, deferBuiltins: true, hotCoreTools: true, deferShell: true });
    for (const tool of ['Read', 'Edit', 'Write']) check('deferShell keeps ' + tool + ' natively visible', await shells.describe(tool) === original, info);
    check('deferShell defers Bash and names it in ToolSearch, still as a batch operation', (await shells.describe('Bash')).isDeferred === true && (await shells.describe('ToolSearch')).description.includes('Bash') && shells.registered.inputSchema.properties.operations.items.properties.tool.enum.includes('Bash'), info);
    for (const deferShell of [undefined, false, 'true', 1]) { const plain = await started({ enabled: true, deferBuiltins: true, hotCoreTools: true, deferShell }); check('deferShell other than exactly true keeps Bash hot: ' + deferShell, await plain.describe('Bash') === original, info); }
    const noHot = await started({ enabled: true, deferBuiltins: true, deferShell: true });
    check('deferShell without hotCoreTools keeps the old deferral and text', (await noHot.describe('ToolSearch')).description === oldSearch, info);
    // hotGlob (sprint-lean-r1): only with hotCoreTools and only when exactly true; Glob stays visible and is no longer named as deferred.
    const glob = await started({ enabled: true, deferBuiltins: true, hotCoreTools: true, deferShell: true, hotGlob: true });
    check('hotGlob keeps Glob natively visible and drops it from the deferred names, Grep stays deferred', await glob.describe('Glob') === original
      && !/\bGlob\b/.test((await glob.describe('ToolSearch')).description.split('Native tools deferred by this mod:')[1] || '') && (await glob.describe('Grep')).isDeferred === true && (await glob.describe('Bash')).isDeferred === true, info);
    for (const hotGlob of [undefined, false, 'true', 1]) { const plain = await started({ enabled: true, deferBuiltins: true, hotCoreTools: true, hotGlob }); check('hotGlob other than exactly true keeps Glob deferred: ' + hotGlob, (await plain.describe('Glob')).isDeferred === true, info); }
    // omitBatch (Gev 2026-10-16): only with hotCoreTools and only when exactly true; the deferral is unchanged, no batch is registered.
    const lean = await started({ enabled: true, deferBuiltins: true, hotCoreTools: true, deferShell: true, hotGlob: true, omitBatch: true });
    const leanSearch = (await lean.describe('ToolSearch')).description;
    check('omitBatch registers no batch, keeps the same deferral, and drops the envelope sentence', lean.registered === undefined
      && (await lean.describe('Bash')).isDeferred === true && (await lean.describe('Grep')).isDeferred === true && await lean.describe('Read') === original
      && leanSearch === (await glob.describe('ToolSearch')).description.replace(' ' + ENVELOPE_NOTE.replace('only this batch', 'only the batch'), ''), info);
    for (const omitBatch of [undefined, false, 'true', 1]) { const kept = await started({ enabled: true, deferBuiltins: true, hotCoreTools: true, omitBatch }); check('omitBatch other than exactly true still registers the batch: ' + omitBatch, kept.registered !== undefined, info); }
    const batchNoHot = await started({ enabled: true, deferBuiltins: true, omitBatch: true });
    check('omitBatch without hotCoreTools keeps the old batch and text', batchNoHot.registered?.description === SPEC.description && (await batchNoHot.describe('ToolSearch')).description === oldSearch, info);
    const globNoHot = await started({ enabled: true, deferBuiltins: true, hotGlob: true });
    check('hotGlob without hotCoreTools keeps the old deferral of Glob', (await globNoHot.describe('Glob')).isDeferred === true && (await globNoHot.describe('ToolSearch')).description === oldSearch, info);
    for (const tool of HOT_CORE) check('hot core tool keeps its exact native placement and text: ' + tool, await hot.describe(tool) === original, info);
    const deferred = profile.slice(1).filter(n => !HOT_CORE.includes(n));
    for (const tool of deferred) {
      const r = await hot.describe(tool);
      check('other available built-ins stay deferred with full text: ' + tool, r.isDeferred === true && r.description === original.description, info);
    }
    const search = (await hot.describe('ToolSearch')).description;
    const advertised = search.slice(original.description.length).match(/deferred by this mod: ([^.]*)\./)?.[1].split(', ');
    check('ToolSearch keeps its native text first', search.startsWith(original.description + '\n'), info);
    check('ToolSearch names exactly the deferred available tools, in order', JSON.stringify(advertised) === JSON.stringify(deferred), info);
    check('ToolSearch states the standalone parameter boundary', search.includes("own top-level parameters") && search.includes('only the batch uses the {tool, args} envelope') && !search.includes('Batch operations:'), info);
    check('the batch states the standalone parameter boundary', hot.registered.description === HOT_CORE_DESCRIPTION && HOT_CORE_DESCRIPTION.endsWith(ENVELOPE_NOTE) && ENVELOPE_NOTE.includes('Read {"file_path": "..."}'), info);
    check('the batch no longer routes visible Read through ToolSearch', HOT_CORE_DESCRIPTION.includes('Use standalone native Read for those inputs.') && !HOT_CORE_DESCRIPTION.includes('standalone Read through ToolSearch') && HOT_CORE_DESCRIPTION.includes('Workers use standalone native tools; load deferred ones through ToolSearch.'), info);
    check('the batch keeps every other contract sentence', ['text only', 'require-native-read', 'completion does not establish that a test passed', 'Each operation uses its native argument names and permissions.'].every(s => HOT_CORE_DESCRIPTION.includes(s)), info);
    const plain = await started({ enabled: true });
    check('hot core changes no schema or bound', JSON.stringify(hot.registered.inputSchema) === JSON.stringify(plain.registered.inputSchema) && hot.registered.isDeferred === false && hot.registered.name === SPEC.name, info);
    check('external providers and unknown tools pass through', await hot.describe('Grep', 'external') === original && await hot.describe('FutureTool') === original, info);
    const both = await started({ enabled: true, deferBuiltins: true, hotCoreTools: true, deduplicateTextReads: true });
    check('Read deduplication text is kept after the hot-core text', both.registered.description.startsWith(HOT_CORE_DESCRIPTION + ' Exact numbered Read text is retained;'), info);
    const sparse = await started({ enabled: true, deferBuiltins: true, hotCoreTools: true }, ['ToolSearch', 'Read', 'Bash', 'Glob']);
    check('only tools present in this profile are advertised', (await sparse.describe('ToolSearch')).description.endsWith('deferred by this mod: Glob. Load one with select:<name> before calling it directly. ' + ENVELOPE_NOTE.replace('only this batch', 'only the batch')) && (await sparse.describe('Glob')).isDeferred === true, info);
    const coreOnly = await started({ enabled: true, deferBuiltins: true, hotCoreTools: true }, ['ToolSearch', 'Read', 'Edit']);
    check('nothing deferred adds nothing to ToolSearch', await coreOnly.describe('ToolSearch') === original && await coreOnly.describe('Read') === original, info);
    const noSearch = await started({ enabled: true, deferBuiltins: true, hotCoreTools: true }, ['Read', 'Grep']);
    check('missing ToolSearch defers nothing', noSearch.registered === undefined && await noSearch.describe('Grep') === original, info);
    hot.api.env.get = async () => 'false';
    check('unsupported tool-search capability passes through under hot core', await hot.describe('Grep') === original && await hot.describe('ToolSearch') === original, info);
    const worker = await started({ enabled: true, deferBuiltins: true, hotCoreTools: true });
    const response = JSON.parse((await worker.hooks.find(h => h.event === 'tool.call').hook(worker.api, { operations: [{ tool: 'Read', args: { file_path: '/fixture.txt' } }], agentId: 'host-worker-id' }, worker.next)).result);
    check('worker batches still stop before effects under hot core', response.status === 'require-native-tools' && response.attempted === 0 && !worker.calls.some(([kind]) => kind === 'call') && response.reason.includes('load deferred ones through ToolSearch'), info);
  });
  await asyncSuite('native discovery shapes', 'an unfamiliar native descriptor passes through untouched in every deferral mode', async () => {
    const info = { happened: 'future descriptor fixture (Codex review of 7310f5f)', why: 'A future client may change the descriptor; the mod must not stringify, invent or throw on it.', fix: 'Edit only a plain descriptor object, and ToolSearch only when its description is a string.' };
    class Descriptor { constructor() { this.description = 'native class text'; } }
    for (const options of [{ enabled: true, deferBuiltins: true }, { enabled: true, deferBuiltins: true, hotCoreTools: true }]) {
      const f = fixture(options);
      await f.hooks.find(h => h.event === 'session.start').hook(f.api, {}, f.next);
      const describe = f.hooks.find(h => h.event === 'tool.describe').hook;
      const label = JSON.stringify(options);
      for (const [name, value] of [['object description', { description: { text: 'future native format' }, inputSchema: { future: true } }], ['missing description', { inputSchema: { future: true } }], ['null descriptor', null], ['undefined descriptor', undefined], ['string descriptor', 'future'], ['array descriptor', ['future']], ['class descriptor', new Descriptor()]]) {
        let out, threw = false;
        try { out = await describe(f.api, { tool: 'ToolSearch', provider: { plugin: 'engine' } }, async () => value); } catch { threw = true; }
        check('ToolSearch ' + name + ' passes through: ' + label, !threw && out === value, info);
      }
      for (const [name, value] of [['null descriptor', null], ['string descriptor', 'future'], ['class descriptor', new Descriptor()]]) {
        let out, threw = false;
        try { out = await describe(f.api, { tool: 'Grep', provider: { plugin: 'engine' } }, async () => value); } catch { threw = true; }
        check('deferred tool ' + name + ' passes through: ' + label, !threw && out === value, info);
      }
      const r = { description: 'native text', inputSchema: { opaque: 1 } };
      const searched = await describe(f.api, { tool: 'ToolSearch', provider: { plugin: 'engine' } }, async () => r);
      check('a string ToolSearch description is still extended: ' + label, searched.description.startsWith('native text\n') && searched.inputSchema === r.inputSchema, info);
      const grep = await describe(f.api, { tool: 'Grep', provider: { plugin: 'engine' } }, async () => ({ inputSchema: { future: true } }));
      check('a plain deferred descriptor without text keeps its fields and is deferred: ' + label, grep.isDeferred === true && grep.inputSchema.future === true && !Object.hasOwn(grep, 'description'), info);
    }
  });
  await asyncSuite('native unchanged Read notices', 'an exact unchanged-file Read notice passes only under its own switch', async () => {
    const info = { happened: 'unchanged Read fixture', why: 'Claude Code 2.1.301 answers a re-read of an unchanged file with a native notice; refusing it stops the whole batch.', fix: 'Pass only the exact notice through, behind unchangedReads, and keep every other shape refused.' };
    const notice = () => ({ result: { type: 'file_unchanged', file: { filePath: '/fixture.txt' } }, text: 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.' });
    const plan = [{ tool: 'Read', args: { file_path: '/fixture.txt' } }, { tool: 'Write', args: { file_path: '/later.txt', content: 'later' } }];
    const run = async (options, value) => {
      const writes = [];
      const f = fixture(options, { call: async e => { if (e.tool === 'Write') { writes.push(e); return { result: { type: 'create' }, text: 'written' }; } return value; } });
      return { answer: await f.batch(plan), writes };
    };
    for (const options of [{ enabled: true }, { enabled: true, unchangedReads: 'true' }, { enabled: true, unchangedReads: 1 }, { enabled: true, deferBuiltins: true, hotCoreTools: true }]) {
      const { answer, writes } = await run(options, notice());
      check('without unchangedReads=true the notice still stops the batch: ' + JSON.stringify(options), answer.status === 'require-native-read' && answer.attempted === 1 && writes.length === 0, info);
    }
    for (const options of [{ enabled: true, unchangedReads: true }, { enabled: true, unchangedReads: true, deduplicateTextReads: true }, { enabled: true, deferBuiltins: true, hotCoreTools: true, unchangedReads: true }]) {
      const value = notice();
      const { answer, writes } = await run(options, value);
      check('the exact notice passes through as executed and later operations run: ' + JSON.stringify(options), answer.status === 'executed' && answer.attempted === 2 && writes.length === 1 && answer.results[0].status === 'executed', info);
      check('the notice is passed through byte for byte: ' + JSON.stringify(options), JSON.stringify(answer.results[0].native) === JSON.stringify(notice()), info);
    }
    check('the exact notice shape is recognized', unchangedReadResult(notice()) !== null && textReadResult(notice()) === null, info);
    const variants = {
      'extra file field': v => { v.result.file.content = 'OPAQUE_SENTINEL'; },
      'extra body field': v => { v.result.base64 = 'OPAQUE_SENTINEL'; },
      'extra top-level field': v => { v.content = [{ type: 'image', data: 'OPAQUE_SENTINEL' }]; },
      'missing path': v => { delete v.result.file.filePath; },
      'non-string path': v => { v.result.file.filePath = 7; },
      'non-string text': v => { v.text = null; },
      'other type': v => { v.result.type = 'file_unchanged_v2'; },
      'array file': v => { v.result.file = ['/fixture.txt']; },
      'error marker': v => { v.isError = true; },
      'empty path': v => { v.result.file.filePath = ''; },
      'inherited path with opaque own key': v => { v.result.file = Object.assign(Object.create({ filePath: '/fixture.txt' }), { opaque: 'OPAQUE_SENTINEL' }); },
      'callable file payload': v => { v.result.file = Object.assign(() => 'OPAQUE_SENTINEL', { filePath: '/fixture.txt' }); },
      'class file payload': v => { v.result.file = new (class File { constructor() { this.filePath = '/fixture.txt'; } })(); },
      'accessor path': v => { v.result.file = Object.defineProperty({}, 'filePath', { get: () => '/fixture.txt', enumerable: true }); },
      'symbol key': v => { v.result.file[Symbol('opaque')] = 'OPAQUE_SENTINEL'; },
      'non-enumerable extra key': v => { Object.defineProperty(v.result.file, 'data', { value: 'OPAQUE_SENTINEL' }); },
      'non-enumerable path': v => { v.result.file = Object.defineProperty({}, 'filePath', { value: '/fixture.txt' }); },
      'non-enumerable text': v => { Object.defineProperty(v, 'text', { enumerable: false }); },
      'non-enumerable body type': v => { Object.defineProperty(v.result, 'type', { enumerable: false }); },
      'inherited body type': v => { v.result = Object.assign(Object.create({ type: 'file_unchanged' }), { file: v.result.file, other: 1 }); },
    };
    const nullProto = notice();
    nullProto.result.file = Object.assign(Object.create(null), { filePath: '/fixture.txt' });
    check('a null-prototype native record is still exact', unchangedReadResult(nullProto) === nullProto, info);
    for (const [name, mutate] of Object.entries(variants)) {
      const value = notice();
      mutate(value);
      check('a malformed notice is not accepted: ' + name, unchangedReadResult(value) === null, info);
      const { answer, writes } = await run({ enabled: true, unchangedReads: true }, value);
      check('a malformed notice still stops the batch: ' + name, answer.status !== 'executed' && answer.attempted === 1 && writes.length === 0 && !JSON.stringify(answer).includes('OPAQUE_SENTINEL'), info);
    }
    const off = fixture({ enabled: false, unchangedReads: true });
    const handled = await off.hooks.find(h => h.event === 'tool.call').hook(off.api, { operations: plan }, off.next);
    check('the switch needs the master switch', handled.operations === plan && off.calls.length === 0, info);
  });
}
