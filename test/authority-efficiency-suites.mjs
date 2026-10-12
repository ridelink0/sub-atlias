import * as mod from '../mods/atlias-efficiency/hooks/register.mjs';
import * as loop from '../lib/loop.mjs';

export default async function authorityEfficiencySuites({ suite, asyncSuite, check, fs, path, PROJECT }) {
  const long = 'Never change the schema.\r\n' + 'detail '.repeat(800) + 'Keep END_AUTHORITY_1012 exactly.';
  const asks = [long, ...Array.from({ length: 18 }, (_, i) => `Only change item ${i}; preserve constraint ${i}. ` + 'x'.repeat(420)), 'Repeat me', 'Repeat me'];
  const makeState = () => ({ cwd: PROJECT, asks, pinned: ['an obsolete extracted rule'], edited: new Set(),
    messages: [{ role: 'system', content: 'system remains exact' }, ...asks.flatMap((s) => [{ role: 'user', content: s }, { role: 'assistant', content: 'observed' }])] });

  suite('authority expert', 'authority: budgets retire evidence rather than requests', () => {
    const note = loop.askedNote(asks, 40, true);
    check('exact mode retains long text, middle amendments, repeated requests and original newlines', asks.every((s) => note.includes(s)) && note.includes('END_AUTHORITY_1012') && note.split('Repeat me').length === 3 && !note.includes('left out'),
      { happened: note.length, why: 'A clipped or omitted requirement cannot govern the next call.', fix: 'askedNote exact mode must carry every supplied original.' });
    const state = makeState();
    loop.compact(state, 2, true);
    const context = state.messages.map((m) => m.content).join('\n');
    check('compaction retains exact authority in order and does not reinstate obsolete extracted rules', asks.every((s) => context.includes(s)) && context.split('Repeat me').length === 3 && !context.includes('an obsolete extracted rule') && state.messages[0].content === 'system remains exact',
      { happened: context.length, why: 'Repeated requests are ordered authority; a stale pinned fragment can contradict an amendment.', fix: 'compact uses trailing occurrences, not a set of request strings.' });
    loop.compact(state, 2, true);
    const repeated = state.messages.map((m) => m.content).join('\n');
    check('a second compaction keeps every original without multiplying prior ledger text', asks.every((s) => repeated.includes(s)) && repeated.split('Repeat me').length === 3,
      { happened: state.messages.length, why: 'Repeated compaction must not amplify or erase authority.', fix: 'No cut is needed when only the retained exchanges remain.' });
    const dir = path.join(PROJECT, 'authority-files');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '  ' + long + '\r\n');
    const text = loop.projectInstructions(dir, 40, true);
    check('instruction text keeps its exact leading whitespace, tail and newlines beyond the evidence budget', text.includes('  ' + long + '\r\n') && !text.includes('characters of this file cut'),
      { happened: text.length, why: 'Budgeting evidence must not weaken applicable project instructions.', fix: 'projectInstructions exact mode does not trim or clip file contents.' });
    check('off retains the old budgeted representation for stored comparisons', !loop.askedNote(asks, 6000, false).includes('END_AUTHORITY_1012') && !loop.projectInstructions(dir, 40, false).includes('END_AUTHORITY_1012'),
      { happened: 'explicit legacy mode checked', why: 'Stored baseline requests must remain byte comparable.', fix: 'Every new authority behavior is behind the off-by-default flag.' });
  });

  await asyncSuite('efficiency expert', 'efficiency: native placement preserves complete contracts', async () => {
    const event = { tool: 'Workflow', description: 'Never bypass approval. Complete policy.', provider: { plugin: 'engine', tier: 'core' } };
    const result = { description: event.description, extra: 'native property' };
    check('enabled qualified placement changes only deferral', JSON.stringify(mod.placement(event, result, true, true)) === JSON.stringify({ ...result, isDeferred: true }),
      { happened: mod.placement(event, result, true, true), why: 'The complete tool contract must survive discovery.', fix: 'Do not rewrite descriptions or native result properties.' });
    const events = [{ ...event, tool: 'Read' }, { ...event, tool: 'futureTool' }, { ...event, provider: { plugin: 'mcp:test' } }];
    check('off, unqualified endpoints, core tools, future tools and MCP placement are unchanged', mod.placement(event, result, false, true) === result && mod.placement(event, result, true, false) === result && events.every((e) => mod.placement(e, result, true, true) === result),
      { happened: 'placement identities checked', why: 'Unknown capabilities and native MCP deferral are part of the baseline.', fix: 'Only explicitly qualified built-ins may move.' });
    let hook;
    mod.register((event, fn) => { hook = fn; return { catch() {} }; }, { enabled: false });
    let envReads = 0;
    const api = { env: { get: async () => { envReads++; return 'true'; } } };
    const native = await hook(api, event, async (e) => { if (e !== event) throw Error('event altered'); return result; });
    check('off hooks return the native result without environment lookups', native === result && envReads === 0,
      { happened: envReads, why: 'Off must preserve ordinary behavior.', fix: 'Return next result before optional work.' });
    mod.register((event, fn) => { hook = fn; return { catch() {} }; }, { enabled: true });
    const deferred = await hook(api, event, async () => result);
    check('qualified enabled hook retains original policy bytes', deferred.isDeferred === true && deferred.description === event.description && result.isDeferred === undefined,
      { happened: deferred, why: 'The source contract is immutable and full when loaded.', fix: 'Placement copies the result without mutating it.' });
  });
}
