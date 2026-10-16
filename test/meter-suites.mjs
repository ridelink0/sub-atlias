// atlias-meter (2026-10-12), the read-only mod in mods/atlias-meter for Claude
// Code 2.1.287 or newer. Both of Codex's reports for Gev put a meter first: what
// skills, tools, context, reminders and tool results cost has to be known before
// anything is cut. These checks drive the hooks module the way Claude Code does
// (register(on), then each hook with the mods API, the event and next) and hold
// it to its one promise: every event goes on exactly as it arrived.
// Loaded by test/run.mjs.
import * as meter from '../mods/atlias-meter/hooks/meter.mjs';
import * as mod from '../mods/atlias-meter/hooks/register.mjs';

export default async function meterSuites({ suite, asyncSuite, check, fs, path, ROOT }) {
  const dir = path.join(ROOT, 'mods', 'atlias-meter');
  const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

  suite('meter expert', 'meter: counting is exact and a table says what was counted', () => {
    const t = meter.newTally();
    meter.add(t, 'attachment:skill_listing', 'abcde');
    meter.add(t, 'attachment:skill_listing', 'fg');
    meter.add(t, 'skill:commit', 12345);
    meter.addChars(t, 'result:Bash', 40);
    meter.addChars(t, 'result:Bash', -5);
    check('pieces and characters are counted by kind, and a piece with no text is a piece of nothing', t.kinds['attachment:skill_listing'].count === 2 && t.kinds['attachment:skill_listing'].chars === 7 && t.kinds['skill:commit'].count === 1 && t.kinds['skill:commit'].chars === 0 && t.kinds['result:Bash'].count === 2 && t.kinds['result:Bash'].chars === 40,
      { happened: JSON.stringify(t.kinds), why: 'A meter that guesses a size for what it could not read reports a number nobody measured.', fix: 'add and addChars in mods/atlias-meter/hooks/meter.mjs.' });
    meter.addUsage(t, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 7, model: 'm' });
    meter.addUsage(t, null, 'a1');
    meter.addUsage(t, { input_tokens: 1, output_tokens: -3, cache_read_input_tokens: Number.NaN }, 'a1');
    check('usage is summed as the API reported it, a request with none is not counted, and a subagent request is told apart', t.requests === 2 && t.subagentRequests === 1 && JSON.stringify(t.usage) === JSON.stringify({ input: 11, output: 5, cacheRead: 90, cacheWrite: 7 }),
      { happened: JSON.stringify({ requests: t.requests, sub: t.subagentRequests, usage: t.usage }), why: 'Input, cache read, cache written and output are four different prices; adding them into one number loses the bill.', fix: 'addUsage.' });
    check('a tool is grouped by its server when it is an MCP tool and by its own name otherwise', meter.toolGroup('mcp__github__create_issue') === 'mcp:github' && meter.toolGroup('Read') === 'Read' && meter.toolGroup(undefined) === 'unknown' && meter.toolGroup('mcp__') === 'mcp:unknown',
      { happened: [meter.toolGroup('mcp__github__create_issue'), meter.toolGroup('mcp__')].join(' '), why: 'Forty tools of one server are one line a person can act on.', fix: 'toolGroup.' });
    const message = { content: [{ type: 'text', text: 'not a result' }, { type: 'tool_result', content: 'r'.repeat(12) }, { type: 'tool_result', content: [{ type: 'text', text: 'sss' }, { type: 'image' }, null] }, null] };
    check('only the text of tool results is counted in a stored row', meter.resultChars(message) === 15 && meter.resultChars(null) === 0 && meter.resultChars({ content: 'x' }) === 0,
      { happened: String(meter.resultChars(message)), why: 'The row also holds blocks that are not results.', fix: 'resultChars.' });
    const text = meter.table(t);
    const fam = meter.families(t);
    check('a missing usage and a request with a count that is not whole are both marked incomplete, and the table calls the sums a lower bound', t.incomplete === 2 && text.includes('INCOMPLETE: 2 requests had no usage or a count that was not a whole number, so the sums above are a lower bound, not a total'),
      { happened: JSON.stringify({ incomplete: t.incomplete }), why: 'The summed line read a missing count as 0 and so showed a lower bound as if it were the total (Codex whole-audit, fa3f7eb).', fix: 'addUsage and table in mods/atlias-meter/hooks/meter.mjs.' });
    const clean = meter.newTally();
    meter.addUsage(clean, { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    meter.addUsage(clean, { input_tokens: 1, output_tokens: 2 });
    check('a request with all four whole counts is complete, a missing cache count is not, and a complete meter prints no warning', clean.incomplete === 1 && !meter.table(meter.newTally()).includes('INCOMPLETE') && meter.table(clean).includes('INCOMPLETE: 1 request had'),
      { happened: JSON.stringify({ incomplete: clean.incomplete }), why: 'A warning on every table would be ignored; none at all hides a lower bound.', fix: 'addUsage and table.' });
    check('the table gives the request count, the four token counts, each family and the largest pieces first', text.includes('requests 2 (1 by subagents)') && text.includes('input 11, cache read 90, cache written 7, output 5') && fam.result.chars === 40 && fam.attachment.count === 2 && text.indexOf('result: 40 characters in 2 pieces') < text.indexOf('attachment: 7 characters in 2 pieces') && text.includes('  result:Bash: 40 characters, 2 times') && text.includes('nothing was changed'),
      { happened: text, why: 'The next cut is chosen from this table.', fix: 'table, rows and families.' });
    const many = meter.newTally();
    for (let i = 0; i < 30; i++) meter.addChars(many, 'k:' + i, i + 1);
    check('an empty meter says so, and a long one names the largest and counts the rest', meter.table(meter.newTally()).includes('nothing counted yet') && meter.table(many).includes('and 5 smaller ones') && meter.rows(many)[0].kind === 'k:29' && meter.table(many, 3).includes('and 27 smaller ones'),
      { happened: meter.table(many, 3), why: 'A table cut short in silence reads as the whole of it.', fix: 'table.' });
  });

  await asyncSuite('meter expert', 'meter: the exact ledger keeps unknown counts unknown and only tool metadata', async () => {
    const info = { happened: 'exact ledger fixture', why: 'Every later efficiency claim is read off this ledger (APPROVED-PLAN-1016 E0): an unknown count read as zero makes an arm look cheaper than it was.', fix: 'addStep, spend, causes and resultErrors in mods/atlias-meter/hooks/meter.mjs.' };
    const t = meter.newTally();
    const usage = (i, o, r, w) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: w, model: 'm' });
    meter.addStep(t, { turnId: 't1', index: 0, answer: 'ANSWER_SENTINEL', stopReason: 'tool_use', toolUses: [{ name: 'Read', input: { file_path: '/VALUE_SENTINEL', limit: 3 } }, { name: 'ToolSearch', input: { query: 'VALUE_SENTINEL' } }], usage: usage(10, 5, 90, 7) });
    meter.addStep(t, { turnId: 't1', index: 1, stopReason: 'end_turn', toolUses: [], usage: usage(1, 2, 0, 0) }, 'agent-1');
    check('a request keeps its four counts, its ids and only tool names and argument key names', JSON.stringify(t.ledger[0]) === JSON.stringify({ role: 'main', agentId: null, turnId: 't1', index: 0, stopReason: 'tool_use', model: 'm', usage: { input: 10, output: 5, cacheRead: 90, cacheWrite: 7 }, tools: [{ name: 'Read', keys: ['file_path', 'limit'] }, { name: 'ToolSearch', keys: ['query'] }] }) && !JSON.stringify(t).includes('SENTINEL'), info);
    const s = meter.spend(t);
    check('spend counts every token once by role and overall, and peak is the largest request', s.main.total === 112 && s.main.peak === 112 && s.subagent.total === 3 && s.all.total === 115 && s.all.peak === 112 && s.all.requests === 2 && s.all.unknown === 0 && s.all.cacheRead === 90, info);
    const cases = { 'no usage': null, 'negative output': usage(1, -3, 0, 0), 'missing cache read': { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0 }, 'fractional input': usage(1.5, 1, 0, 0), 'string count': usage('4', 1, 0, 0), 'NaN cache': usage(1, 1, Number.NaN, 0) };
    for (const [name, u] of Object.entries(cases)) {
      const one = meter.newTally();
      meter.addStep(one, { turnId: 't', index: 0, toolUses: [], usage: usage(3, 3, 0, 0) }, 'agent-2');
      meter.addStep(one, { turnId: 't', index: 1, toolUses: [], stopReason: null, usage: u });
      const r = meter.spend(one);
      check('an unusable count makes its role and the overall figures unknown, never smaller: ' + name, r.main.unknown === 1 && r.main.total === null && r.main.peak === null && r.main.input === null && r.all.total === null && r.all.peak === null && r.subagent.total === 6 && r.subagent.unknown === 0, info);
    }
    // Counts past Number.MAX_SAFE_INTEGER, alone or added up, are not measurements (Codex review 03:11Z).
    const big = meter.newTally();
    meter.addStep(big, { toolUses: [], usage: usage(1e100, 1, 0, 0) });
    const one = meter.newTally();
    meter.addStep(one, { toolUses: [], usage: usage(Number.MAX_SAFE_INTEGER, 1, 0, 0) });
    const across = meter.newTally();
    const half = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
    meter.addStep(across, { toolUses: [], usage: usage(half, 0, 0, 0) }, 'a');
    meter.addStep(across, { toolUses: [], usage: usage(half, 0, 0, 0) });
    meter.addStep(across, { toolUses: [], usage: usage(3, 1, 0, 0) }, 'b');
    const acrossSpend = meter.spend(across);
    check('an unsafe count, an unsafe single request and an unsafe running total all read unknown, never an exact number', big.ledger[0].usage.input === null && meter.spend(big).all.total === null && meter.spend(one).all.total === null && meter.spend(one).all.unknown === 1 && acrossSpend.all.total === null && acrossSpend.all.unknown === 1 && acrossSpend.subagent.total === half + 4 && acrossSpend.main.total === half, { ...info, happened: JSON.stringify({ big: big.ledger[0].usage, one: meter.spend(one).all, across: acrossSpend }) });
    const legacy = meter.newTally();
    meter.addUsage(legacy, { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    meter.addUsage(legacy, { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    const huge = meter.newTally();
    meter.addUsage(huge, { input_tokens: 1e100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    check('the summed line says UNSAFE once its sums pass the exact range, and a huge count is incomplete', legacy.unsafe === true && meter.table(legacy).includes('UNSAFE: the sums above passed the range') && huge.incomplete === 1 && huge.unsafe === true && !meter.table(meter.newTally()).includes('UNSAFE'), { ...info, happened: JSON.stringify({ unsafe: legacy.unsafe, hugeIncomplete: huge.incomplete }) });
    meter.addStep(t, null);
    check('a missing result is still a ledger row, with nothing known about it', t.ledger.length === 3 && t.ledger[2].usage === null && t.ledger[2].turnId === null && meter.spend(t).all.total === null, info);
    const c = meter.newTally();
    meter.addStep(c, { toolUses: [], usage: usage(1, 1, 0, 0) });
    meter.addStep(c, { toolUses: [{ name: 'Read', input: { args: { file_path: '/x' } } }, { name: meter.BATCH_TOOL, input: { args: [] } }, { name: 'mcp__atlias-transaction__batch', input: { operations: [] } }, { name: 'Bash', input: 'not an object' }, { name: 'Edit', input: ['args'] }, null], usage: usage(1, 1, 0, 0) });
    const seen = meter.causes(c);
    check('observed calls are labelled from metadata alone, and only a standalone args-only call is a wrapped call', JSON.stringify(seen) === JSON.stringify({ 'no-tool': 1, 'tool:Read': 1, 'wrapped-args': 1, 'tool:mcp:atlias-transaction': 2, batch: 2, 'tool:Bash': 1, 'tool:Edit': 1, 'tool:unknown': 1 }) && c.ledger[1].tools[3].keys === null && c.ledger[1].tools[4].keys === null, { ...info, happened: JSON.stringify(seen) });
    meter.resultErrors(c, 'Bash', { content: [{ type: 'tool_result', is_error: true }, { type: 'tool_result', is_error: 'true' }, { type: 'tool_result' }, null, { type: 'text', is_error: true }] });
    meter.resultErrors(c, 'Bash', { content: [{ type: 'tool_result', is_error: true }] });
    meter.resultErrors(c, 'Read', null);
    check('only tool results marked is_error true are counted as errors, by tool group', JSON.stringify(c.resultErrors) === JSON.stringify({ Bash: 2 }), info);
    const text = meter.table(t);
    check('the table states the exact ledger and says unknown instead of a number', text.includes('exact ledger all: 3 requests, 1 without a usable count; total unknown, peak unknown') && text.includes('exact ledger subagent: 1 requests, 0 without a usable count; total 3, peak 3') && text.includes('observed calls: ') && text.includes('search 1') && meter.table(c).includes('error results: Bash 2'), { ...info, happened: text });
    const hooks = [];
    mod.register((event, a, b) => { hooks.push({ event, fn: typeof a === 'function' ? a : b }); return { catch() {} }; });
    const hostile = { turnId: 't', index: 0, toolUses: [], get usage() { throw new Error('usage getter failed'); } };
    const gen = hooks.find((h) => h.event === 'turn.step').fn({}, { turnId: 't', index: 0 }, async function* () { return hostile; });
    let it = await gen.next();
    while (!it.done) it = await gen.next();
    check('a result the meter cannot read still goes on exactly as the engine streamed it', it.value === hostile, info);
  });

  await asyncSuite('meter expert', 'meter: every hook passes its event on exactly as it arrived', async () => {
    const hooks = [];
    mod.register((event, a, b) => { hooks.push({ event, matcher: typeof a === 'function' ? null : a, fn: typeof a === 'function' ? a : b }); return { catch() {} }; });
    const find = (event) => hooks.find((h) => h.event === event);
    const specs = [];
    const saved = [];
    const api = { command: { register: async (spec) => { specs.push(spec); } }, store: { set: async (key, value) => { saved.push([key, JSON.parse(JSON.stringify(value))]); } } };
    const events = {
      'session.start': { cwd: 'C:/x', surface: 'terminal', isInteractive: true },
      'prompt.attachment': { type: 'skill_listing', text: '12345', origin: { kind: 'engine' } },
      'skill.prompt': { skill: 'commit', text: 'x'.repeat(40) },
      'tool.describe': { tool: 'mcp__github__create_issue', description: 'e'.repeat(7), isDeferred: true, provider: { plugin: 'mcp:github', tier: 'user' } },
      'prompt.context': { blocks: [{ name: 'claudeMd', text: 'c'.repeat(30) }, { name: 'currentDate', text: '2026' }] },
      'session.append': { door: 'tool-result', uuid: 'u1', origin: { kind: 'tool', tool: 'Bash' }, message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r'.repeat(12) }] } },
      'turn.complete': { turnId: 't', answer: 'done', durationMs: 5, usage: null },
    };
    const bad = [];
    for (const [event, e] of Object.entries(events)) {
      const frozen = JSON.stringify(e);
      const token = { from: event };
      let got = null;
      const result = await find(event).fn(api, e, async (x) => { got = x; return token; });
      if (result !== token || got !== e || JSON.stringify(e) !== frozen) bad.push(event);
    }
    check('each observing hook calls next with the very event it was given and returns what next returned', bad.length === 0 && hooks.length === 9,
      { happened: `changed or swallowed: ${bad.join(', ') || 'none'}; ${hooks.length} hooks`, why: 'This mod is the measuring instrument for every later change. If it altered one event, every number after it would be a number about the meter.', fix: 'Every hook in mods/atlias-meter/hooks/register.mjs ends in return next(e).' });
    const step = { turnId: 't', index: 0, model: 'm', messageCount: 3 };
    const answer = { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 7, model: 'm' } };
    let stepSeen = null;
    const gen = find('turn.step').fn(api, step, async function* (x) { stepSeen = x; yield 'a'; yield 'b'; return answer; });
    const chunks = [];
    let it = await gen.next();
    while (!it.done) { chunks.push(it.value); it = await gen.next(); }
    check('the request hook forwards every streamed piece in order and returns the finished result itself', JSON.stringify(chunks) === JSON.stringify(['a', 'b']) && it.value === answer && stepSeen === step,
      { happened: JSON.stringify({ chunks, same: it.value === answer }), why: 'A hook that held the stream back or copied the result would change what the person sees and what later hooks read.', fix: 'The turn.step generator: const result = yield* next(e); return result.' });
    const failing = { store: { set: async () => { throw new Error('store is full'); } } };
    const kept = { from: 'next' };
    const after = await find('turn.complete').fn(failing, events['turn.complete'], async () => kept);
    check('a save that fails does not fail the turn', after === kept && saved.length === 1 && saved[0][0] === mod.STORE_KEY,
      { happened: JSON.stringify(saved.map((s) => s[0])), why: 'A hook that throws is skipped by Claude Code, and a meter must never be the reason a turn went differently.', fix: 'The try around $.store.set in the turn.complete hook.' });
    const out = await find('command.run').fn(api, { command: mod.COMMAND, args: '' }, async () => { throw new Error('the command answers by itself'); });
    check('the command is registered once at session start and prints the table without a model turn', specs.length === 1 && specs[0].name === 'atlias-meter' && specs[0].immediate === true && find('command.run').matcher.command === 'atlias-meter' && typeof out.text === 'string' && out.text.includes('attachment:skill_listing: 5 characters, 1 time') && out.text.includes('tool-deferred:mcp:github: 7 characters') && out.text.includes('context: 34 characters in 2 pieces') && out.text.includes('result:Bash: 12 characters') && out.text.includes('skill:commit: 40 characters') && out.text.includes('requests 1 (0 by subagents)') && out.text.includes('cache read 90'),
      { happened: out.text, why: 'Reading the meter must not cost a request.', fix: 'The session.start and command.run hooks.' });
    const pairs = hooks.map((h) => h.event + JSON.stringify(h.matcher));
    check('no event is registered twice with the same matcher, and tool results are the only rows watched', new Set(pairs).size === pairs.length && find('session.append').matcher.door === 'tool-result',
      { happened: pairs.join(' | '), why: 'Claude Code refuses to load a module that registers one event twice without a matcher.', fix: 'One on() per event and matcher in register.' });
  });

  suite('meter expert', 'meter: the plugin is declared the way Claude Code reads a mod', () => {
    const manifest = JSON.parse(read('.claude-plugin/plugin.json'));
    const declared = JSON.parse(read('hooks/hooks.json'));
    check('the manifest names it, and hooks.json points at the hooks module and holds no settings hook', manifest.name === 'atlias-meter' && typeof manifest.version === 'string' && manifest.description.includes('changes nothing') && JSON.stringify(declared) === JSON.stringify({ modules: ['./register.mjs'] }) && fs.existsSync(path.join(dir, 'hooks', 'register.mjs')),
      { happened: JSON.stringify(declared), why: 'A mod is found through the modules key of hooks/hooks.json.', fix: 'mods/atlias-meter/hooks/hooks.json.' });
    const source = read('hooks/register.mjs');
    const pure = read('hooks/meter.mjs');
    check('the hooks module uses nothing a mod cannot have: no Node, no require, one import from its own plugin', !source.includes('node:') && !source.includes('require(') && !pure.includes('node:') && !pure.includes('require(') && !pure.split(String.fromCharCode(10)).some((l) => l.startsWith('import ')) && source.split(String.fromCharCode(10)).filter((l) => l.startsWith('import ')).length === 1 && source.includes("from './meter.mjs'"),
      { happened: `${source.split(String.fromCharCode(10)).filter((l) => l.startsWith('import ')).length} import line(s) in register.mjs`, why: 'A hooks module runs with no Node and may import only files of its own plugin; one bad import and it does not load.', fix: 'Keep meter.mjs free of imports and register.mjs importing only it.' });
    check('it is not part of the main plugin: the atlias hooks.json has no modules key', !('modules' in JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'))),
      { happened: 'checked hooks/hooks.json', why: 'What a Claude Code older than 2.1.287 does with a modules key is not known, so the mod must not be able to break the plugin every user has.', fix: 'Keep the mod in mods/atlias-meter until that is tested.' });
  });
}
