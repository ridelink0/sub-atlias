import { register, invalid, state, SPEC, LIMIT, NAME, DEFERRED } from '../mods/atlias-transaction/hooks/register.mjs';

function fixture(options = { enabled: true }, overrides = {}) {
  const hooks = [];
  const calls = [];
  const signal = new AbortController();
  const on = (event, matcher, hook) => {
    if (typeof matcher === 'function') hook = matcher;
    hooks.push({ event, hook });
    return { catch() { return this; } };
  };
  register(on, options);
  const api = { tool: {
    list: async () => DEFERRED.filter(n => n !== 'PowerShell').map(name => ({ name })),
    register: async s => { calls.push(['register', s]); },
    check: overrides.check || (async e => {
      if (!e.input || Object.keys(e).some(k => !['tool', 'input'].includes(k))) throw Error('wrong native permission envelope');
      return { decision: 'allow' };
    }),
    call: overrides.call || (async e => { calls.push(['call', e]); return { result: { stdout: 'exact diagnostic', stderr: '' }, text: 'exact diagnostic' }; }),
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
    const off = fixture({ enabled: false });
    await off.hooks.find(h => h.event === 'session.start').hook(off.api, {}, off.next);
    check('off registers no tool', off.calls.length === 0, info);
    const good = fixture();
    const answer = await good.batch(Array(LIMIT).fill(op));
    check('a batch at its bound executes each operation with native arguments', answer.attempted === LIMIT && answer.status === 'executed' && good.calls.every(([, e]) => e.tool === 'Read' && e.file_path === '/fixture.txt'), info);
    check('full native diagnostics are preserved without a passing-test claim', answer.results.every(r => r.native.text === 'exact diagnostic' && r.native.result.stdout === 'exact diagnostic') && !Object.hasOwn(answer, 'passed'), info);
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
    check('tool errors retain diagnostics and stop dependent operations', attempts === 1 && failedAnswer.status === 'tool-error' && failedAnswer.results[0].native.text === 'middle assertion failure', info);
    const aborted = fixture();
    aborted.signal.abort();
    check('cancellation before dispatch produces no effects', (await aborted.batch([op])).status === 'aborted' && aborted.calls.length === 0, info);
    let inFlight;
    inFlight = fixture(undefined, { call: async () => { inFlight.signal.abort(); throw Error('in-flight cancellation'); } });
    const partial = await inFlight.batch([op, op]);
    check('in-flight cancellation reports possible partial effects and never replays', partial.status === 'aborted' && partial.attempted === 1 && partial.results[0].effects === 'unknown', info);
    check('only explicit native result shapes establish execution', state({ deny: 'no' }) === 'refused' && state({ result: {}, isError: true }) === 'tool-error' && state({ result: {} }) === 'executed' && state({ text: 'ok' }) === 'unknown', info);
    const placement = fixture({ enabled: true, deferBuiltins: true });
    await placement.hooks.find(h => h.event === 'session.start').hook(placement.api, {}, placement.next);
    const describe = placement.hooks.find(h => h.event === 'tool.describe').hook;
    const original = { description: 'Full native contract and policy.', isDeferred: false };
    const describeNext = async () => original;
    const search = await describe(placement.api, { tool: 'ToolSearch', provider: { plugin: 'engine' } }, describeNext);
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
}
