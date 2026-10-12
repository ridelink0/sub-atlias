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
    check('the table gives the request count, the four token counts, each family and the largest pieces first', text.includes('requests 2 (1 by subagents)') && text.includes('input 11, cache read 90, cache written 7, output 5') && fam.result.chars === 40 && fam.attachment.count === 2 && text.indexOf('result: 40 characters in 2 pieces') < text.indexOf('attachment: 7 characters in 2 pieces') && text.includes('  result:Bash: 40 characters, 2 times') && text.includes('nothing was changed'),
      { happened: text, why: 'The next cut is chosen from this table.', fix: 'table, rows and families.' });
    const many = meter.newTally();
    for (let i = 0; i < 30; i++) meter.addChars(many, 'k:' + i, i + 1);
    check('an empty meter says so, and a long one names the largest and counts the rest', meter.table(meter.newTally()).includes('nothing counted yet') && meter.table(many).includes('and 5 smaller ones') && meter.rows(many)[0].kind === 'k:29' && meter.table(many, 3).includes('and 27 smaller ones'),
      { happened: meter.table(many, 3), why: 'A table cut short in silence reads as the whole of it.', fix: 'table.' });
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
