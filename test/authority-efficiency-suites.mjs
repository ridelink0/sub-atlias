import * as mod from '../mods/atlias-efficiency/hooks/register.mjs';
import * as loop from '../lib/loop.mjs';

export default async function authorityEfficiencySuites({ suite, asyncSuite, check, fs, path, PROJECT }) {
  const long = 'Never change the schema.\r\n' + 'detail '.repeat(800) + 'Keep END_AUTHORITY_1012 exactly.';
  const asks = [long, ...Array.from({ length: 18 }, (_, i) => `Only change item ${i}; preserve constraint ${i}. ` + 'x'.repeat(420)), 'Repeat me', 'Repeat me'];
  const makeState = () => ({ cwd: PROJECT, asks, pinned: ['an obsolete extracted rule'], edited: new Set(),
    messages: [{ role: 'system', content: 'system remains exact' }, ...asks.flatMap((s) => [{ role: 'user', content: s }, { role: 'assistant', content: 'observed' }])] });

  suite('authority expert', 'authority: every request is kept for the ledger (Codex F3)', () => {
    const many = Array.from({ length: 32 }, (_, i) => (i === 1 ? 'Never touch b.py; this holds for the whole task.' : i === 2 || i === 3 ? 'Same words twice.' : `Follow-up ${i}.`));
    const off = { asks: [] };
    for (const a of many.slice(0, 22)) loop.rememberAsk(off, a, false);
    check('without the ledger, the first request and the newest nineteen are kept (stored runs reproduce)', off.asks.length === 20 && off.asks[0] === many[0] && !off.asks.includes(many[1]), { happened: off.asks.length, why: 'The flag-off loop must not move.', fix: 'Splice to twenty only when exact is false.' });
    const on = { cwd: PROJECT, edited: new Set(), messages: [{ role: 'system', content: 'system' }] };
    for (const a of many) { loop.rememberAsk(on, a, true); on.messages.push({ role: 'user', content: a }, { role: 'assistant', content: 'done' }); }
    loop.compact(on, 8, true);
    on.messages.push(...Array.from({ length: 6 }, (_, i) => [{ role: 'user', content: `Later ${i}.` }, { role: 'assistant', content: 'done' }]).flat());
    for (let i = 0; i < 6; i++) loop.rememberAsk(on, `Later ${i}.`, true);
    loop.compact(on, 8, true);
    const note = String(on.messages[1].content);
    check('with the ledger, 30 and more requests, a middle restriction and both copies of a repeated request survive two compactions', on.asks.length === 38 && note.includes(many[1]) && note.split('Same words twice.').length === 3 && note.includes('Follow-up 31.'), { happened: note.slice(0, 300), why: 'A middle restriction that is dropped before any compaction cannot be restated by the exact note.', fix: 'rememberAsk keeps every request when exact is true.' });
  });
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
    const search = { tool: 'ToolSearch', description: 'Fetches full schema definitions for deferred tools.', provider: { plugin: 'engine', tier: 'core' } };
    const found = { description: search.description };
    const named = mod.placement(search, found, true, true);
    check('a tool the mod moves is named to the model after ToolSearch\'s whole original text', named.description === search.description + mod.NOTE && mod.ANNOUNCE.every((n) => mod.DEFER.includes(n) && named.description.includes(n)) && named.isDeferred === undefined,
      { happened: named.description, why: 'Claude Code 2.1.296 left the tools this mod moved out of its deferred listing, so the model could not find Grep, Glob, Skill or Agent.', fix: 'placement appends NOTE to ToolSearch and keeps the engine text first.' });
    check('off, unqualified, or a ToolSearch from another provider keeps its description', mod.placement(search, found, false, true) === found && mod.placement(search, found, true, false) === found && mod.placement({ ...search, provider: { plugin: 'mcp:x' } }, found, true, true) === found,
      { happened: 'ToolSearch identities checked', why: 'Only the qualified arm may say anything new.', fix: 'The ToolSearch note sits behind the same switch and provider check as the deferral.' });
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

    const long = 'Use this skill whenever a chart is about to be made, in any output medium, ' + 'and read it before the first line of chart code. '.repeat(6);
    const listed = ['Skills available:', '- atlias:double-check', '- dataviz: ' + long, 'TRIGGER when a chart is asked for.', '- init: Initialize a new CLAUDE.md file', '- ' + 'n'.repeat(150) + ': short words'].join('\n');
    const brief = mod.briefListing(listed, true);
    const lines = brief.slice(0, -mod.LISTING_NOTE.length).split('\n');
    check('a brief listing keeps every skill name whole, in order, and cuts only descriptions', brief.endsWith(mod.LISTING_NOTE) && lines.length === 5 && lines[0] === 'Skills available:' && lines[1] === '- atlias:double-check' && lines[2].startsWith('- dataviz: Use this skill') && lines[2].endsWith(' ...') && lines[2].length <= mod.LISTING_CAP + 4 && lines[3] === '- init: Initialize a new CLAUDE.md file' && lines[4] === '- ' + 'n'.repeat(150) + ': ...',
      { happened: lines, why: 'A skill the model cannot name is a skill it cannot call; the listing may lose words, never a skill.', fix: 'Cut after the name, at a word boundary under LISTING_CAP, and drop only continuation lines.' });
    const short = 'Skills available:\n- init: Initialize a new CLAUDE.md file';
    check('off, a listing with nothing to cut, and text that is not a string come back untouched', mod.briefListing(listed, false) === listed && mod.briefListing(short, true) === short && mod.briefListing(undefined, true) === undefined,
      { happened: mod.briefListing(short, true), why: 'Off must be byte for byte the native listing, and the note must not appear where nothing was cut.', fix: 'Return the input itself unless a line was cut.' });
    const hooks = (options) => { const map = {}; mod.register((name, a, b) => { map[name] = b || a; return { catch() {} }; }, options); return map; };
    const listingEvent = { type: 'skill_listing', text: listed, origin: { kind: 'engine' } };
    const through = async (options, e = listingEvent) => (await hooks(options)['prompt.attachment']({}, e, async (x) => ({ text: x.text }))).text;
    const outcomes = [await through({ enabled: true, skillListing: true }), await through({ enabled: true }), await through({ skillListing: true }), await through({}), await through({ enabled: true, skillListing: true }, { ...listingEvent, origin: { kind: 'plugin', event: 'prompt.submit' } })];
    check('the listing is cut only with both switches on, and only the engine\'s own listing', outcomes[0] === brief && outcomes.slice(1).every((text) => text === listed),
      { happened: outcomes.map((text) => text.length), why: 'Each cut is its own switch under the master switch, and another plugin\'s text is not this mod\'s to shorten.', fix: 'Gate on enabled, skillListing and origin.kind === engine.' });
    const dropped = await hooks({ enabled: true, skillListing: true })['prompt.attachment']({}, listingEvent, async () => ({ text: null }));
    check('a listing another hook already left out stays out', dropped.text === null,
      { happened: dropped, why: 'A null text means the attachment is omitted; rewriting it would put it back.', fix: 'Pass a non-string text through.' });

    const mem = { name: 'memory', text: '# Memory\nlong instructions' };
    check('only the named memory section is left out, and only when its switch is on', mod.section({ name: 'memory' }, mem, true).text === null && mod.section({ name: 'memory' }, mem, false) === mem && mod.section({ name: 'env_info_simple' }, mem, true) === mem && mod.section({ name: 'a_future_section' }, mem, true) === mem && mod.section(undefined, mem, true) === mem,
      { happened: mod.OMIT_SECTIONS, why: 'The safety, action and environment sections are not this mod\'s to remove, and a section it does not know must pass.', fix: 'Omit only names in OMIT_SECTIONS.' });
    const bash = { tool: 'Bash', provider: { plugin: 'engine' } };
    const opening = 'Executes a bash command and returns its output.\n\nThis tool runs Git Bash (POSIX sh).\n';
    const bashText = { description: opening + '\n- ' + 'a long note about the shell. '.repeat(60), isDeferred: undefined };
    const small = mod.compactText(bash, bashText, true);
    check('compact tool text keeps the opening of the original, replaces only the notes, and leaves the rest of the result alone', small.description === opening + '\n' + mod.TOOL_TEXT.Bash.tail && small.description.length < bashText.description.length && Object.keys(small).join() === Object.keys(bashText).join() && bashText.description.endsWith('shell. '),
      { happened: small.description.slice(0, 160), why: 'The opening names the shell this build runs, and the schema and placement are not text.', fix: 'Cut at the break the rule names, append its tail, copy the result.' });
    const same = [mod.compactText(bash, bashText, false), mod.compactText({ tool: 'Edit', provider: { plugin: 'engine' } }, bashText, true), mod.compactText({ tool: 'constructor', provider: { plugin: 'engine' } }, bashText, true), mod.compactText({ ...bash, provider: { plugin: 'mcp:x' } }, bashText, true)];
    check('off, a tool not in the table, another provider\'s tool, a text without the expected break and a text that would not get shorter are untouched', same.every((r) => r === bashText) && mod.compactText(bash, { description: 'One line only.' }, true).description === 'One line only.' && mod.compactText(bash, { description: 'Short.\n- note' }, true).description === 'Short.\n- note',
      { happened: same.map((r) => r === bashText), why: 'A changed native text must not be guessed at, and an MCP tool named Bash is not the engine\'s.', fix: 'Return the result itself unless the engine tool is in TOOL_TEXT, the break is found and the text gets shorter.' });
    const wired = hooks({ enabled: true, omitMemorySection: true, compactToolText: true });
    const plain = hooks({ enabled: true });
    const masterOff = hooks({ omitMemorySection: true, compactToolText: true });
    const envApi = { env: { get: async () => 'true' } };
    const searchText = { description: 'Fetches full schema definitions.\n\n' + 'Long explanation. '.repeat(40) };
    const memOf = (h) => h['prompt.section']({}, { name: 'memory' }, async () => mem);
    const bashOf = (h) => h['tool.describe'](envApi, bash, async () => bashText);
    const got = [await memOf(wired), await memOf(plain), await memOf(masterOff), await bashOf(wired), await bashOf(plain), await bashOf(masterOff), await wired['tool.describe'](envApi, { tool: 'ToolSearch', provider: { plugin: 'engine' } }, async () => searchText)];
    check('each cut answers to its own switch under the master switch, and the ToolSearch note still follows the compact text', got[0].text === null && got[1] === mem && got[2] === mem && got[3].description === small.description && got[4] === bashText && got[5] === bashText && got[6].description === 'Fetches full schema definitions.\n' + mod.TOOL_TEXT.ToolSearch.tail + mod.NOTE,
      { happened: [got[0].text, got[3].description.length, got[6].description.length], why: 'Each cut is measured alone, so each must be its own switch, and off must be the native bytes.', fix: 'Gate each handler on enabled and on its own option.' });
  });
}
