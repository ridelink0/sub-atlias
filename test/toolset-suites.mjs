// agent.toolSet and flags.redCheckNudge (2026-10-12). The opening block of a
// run (system message, tool list, task) is re-sent on every call: on the
// 60-task screen it was 48.8 percent of all prompt tokens at 8.4 calls a task.
// agent.toolSet = core offers a model seven tools instead of eleven and drops
// the two sentences that name the ones left out; all is every byte as it was.
// flags.redCheckNudge sends an answer back once when the newest check after the
// last edit failed; off, any check at all lets an answer through, as before.
// Every loop case drives runLoop with a scripted model. Loaded by test/run.mjs.
import * as loop from '../lib/loop.mjs';
import * as settings from '../lib/settings.mjs';

export default async function toolSetSuites({ asyncSuite, suite, check, core, agentMod, TMP, fs, path }) {
  const NL = String.fromCharCode(10);
  const FENCE = '`'.repeat(3);
  const LEFT_OUT = ['apply_patch', 'todo', 'recall', 'remember'];
  const names = (list) => list.map((t) => t.function.name);
  const sys = (toolSet, extra = {}) => loop.systemPrompt(TMP, { hasGraph: false, instructions: '', skillIndex: 'off', toolSet, ...extra });

  suite('tool set expert', 'tool set: the setting is registered, defaults to all, and all is the list as it was', () => {
    const row = settings.rows().find((r) => r.id === 'agent.toolSet');
    check('agent.toolSet defaults to all, offers all and core, and is described with its measurements', core.DEFAULTS.agent.toolSet === 'all' && JSON.stringify(core.CHOICES.agent.toolSet) === JSON.stringify(['all', 'core']) && row && row.value === 'all' && /48.8 percent/.test(row.about) && /apply_patch, todo, recall and remember/.test(row.about) && /still runs/.test(row.about),
      { happened: JSON.stringify(row || null), why: 'A change to what every call carries lands off and is measured as a round before it is kept.', fix: 'DEFAULTS.agent and CHOICES.agent in lib/core.mjs, DESCRIPTIONS in lib/settings.mjs.' });
    const all = loop.toolSchemas(false);
    check('with no value, with all, and with anything that is not core, the schemas are every tool in the table, in order', JSON.stringify(loop.toolSchemas(false, 'all')) === JSON.stringify(all) && JSON.stringify(loop.toolSchemas(false, 'maybe')) === JSON.stringify(all) && JSON.stringify(loop.toolSchemas(false, undefined)) === JSON.stringify(all) && JSON.stringify(names(all)) === JSON.stringify(loop.TOOLS.filter((t) => t.name !== 'graph_query').map((t) => t.name)) && names(loop.toolSchemas(true)).includes('graph_query'),
      { happened: names(loop.toolSchemas(false, 'maybe')).join(','), why: 'The champion and every stored run were offered all of them; a typo must not change what a run is offered.', fix: 'offeredTools filters only when toolSet is exactly core.' });
    check('the system message for all is the one for no value, byte for byte, in both modes', sys('all') === sys(undefined) && sys('all', { native: true }) === sys(undefined, { native: true }) && sys('zzz') === sys('all') && /todo tool first/.test(sys('all')) && /apply_patch if you know/.test(sys('all')),
      { happened: `${sys('all').length} against ${sys(undefined).length}`, why: 'All is the control arm; it has to be the message every earlier run was sent.', fix: 'systemPrompt changes its two sentences only when toolSet is core.' });
  });

  suite('tool set expert', 'tool set: core offers seven tools and says nothing about the ones it leaves out', () => {
    const all = loop.toolSchemas(false, 'all');
    const coreSet = loop.toolSchemas(false, 'core');
    check('core leaves out exactly apply_patch, todo, recall and remember, and keeps the rest in order', JSON.stringify(names(coreSet)) === JSON.stringify(names(all).filter((n) => !LEFT_OUT.includes(n))) && coreSet.length === 7 && loop.offeredTools('core', false).length === 7 && loop.offeredTools('all', true).length === loop.TOOLS.length && names(loop.toolSchemas(true, 'core')).includes('graph_query') && coreSet.every((t) => JSON.stringify(t) === JSON.stringify(all.find((a) => a.function.name === t.function.name))),
      { happened: names(coreSet).join(','), why: 'The tools a small model uses to find, read, change and check code stay exactly as they were.', fix: 'CORE_TOOLS in lib/loop.mjs.' });
    const saved = JSON.stringify(all).length - JSON.stringify(coreSet).length;
    check('that is at least a third of the tool list text', saved / JSON.stringify(all).length >= 0.33,
      { happened: `${saved} of ${JSON.stringify(all).length} characters`, why: 'The point of the setting: the list is re-sent on every call.', fix: 'CORE_TOOLS.' });
    const text = sys('core');
    const native = sys('core', { native: true });
    check('the text-mode message lists only the seven and neither message names a tool that is not offered', LEFT_OUT.every((n) => !text.includes(n) && !native.includes(n)) && text.includes('read_file{') && text.includes('shell{') && text.length < sys('all').length && native.length < sys('all', { native: true }).length,
      { happened: LEFT_OUT.filter((n) => text.includes(n) || native.includes(n)).join(',') || 'none named', why: 'A sentence telling the model to plan with a tool it was not given sends it looking for one.', fix: 'The core branches of the two sentences in systemPrompt, and offeredTools in the Tools line.' });
    check('removing those two parts is the whole difference in native mode', sys('all', { native: true }).replace(' For work with more than two steps, write the plan with the todo tool first and keep it current.', '').replace(' (or with apply_patch if you know that patch format)', '') === native,
      { happened: `${native.length} characters`, why: 'Nothing else in the message may move, or the round measures more than the tool set.', fix: 'systemPrompt.' });
  });

  const call = (obj) => FENCE + 'atlias' + NL + JSON.stringify(obj) + NL + FENCE;
  let n = 0;
  const dir = (files) => {
    const d = path.join(TMP, 'toolset', `p${++n}`);
    fs.mkdirSync(d, { recursive: true });
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(d, rel), text);
    return d;
  };
  const scripted = (replies, seenTools) => async (messages, tools) => {
    if (seenTools) seenTools.push(tools ? tools.map((t) => t.function.name) : null);
    const r = replies.shift();
    if (r === undefined) return { content: 'out of script', calls: [] };
    return typeof r === 'string' ? { content: r, calls: [] } : r;
  };
  const withSetting = async (id, value, fn) => { if (value !== undefined) settings.set(id, value); try { return await fn(); } finally { settings.reset(id); } };

  await asyncSuite('tool set expert', 'tool set: the loop offers what the setting says, and a tool that is not offered still runs', async () => {
    // One folder for every run here: the system message names it, and the messages are compared whole.
    const shared = dir({ 'a.txt': 'one' + NL });
    const offered = async (value, native) => {
      const seen = [];
      const st = agentMod.newState(shared, 'ollama');
      await withSetting('agent.toolSet', value, () => loop.runLoop(st, 'hello', { chat: scripted(['Nothing to do.'], seen), native, say: () => {}, ask: async () => true, limits: { maxToolRounds: 2, maxBadReplies: 3 } }));
      return { tools: seen[0], system: st.messages[0].content };
    };
    const dflt = await offered(undefined, true);
    const coreRun = await offered('core', true);
    const allRun = await offered('all', true);
    check('through runLoop in native mode: unset and all send every schema, core sends the seven', JSON.stringify(dflt.tools) === JSON.stringify(allRun.tools) && dflt.tools.length === coreRun.tools.length + 4 && LEFT_OUT.every((t) => dflt.tools.includes(t) && !coreRun.tools.includes(t)) && dflt.system === allRun.system && coreRun.system.length < dflt.system.length,
      { happened: JSON.stringify({ dflt: dflt.tools, core: coreRun.tools }), why: 'The setting has to reach the request of a real run, as the config.json a study writes.', fix: 'runLoop passes cfg.toolSet to toolSchemas and to systemPrompt.' });
    const textRun = await offered('core', false);
    check('in text mode nothing is sent as a schema and the message lists the seven', textRun.tools === null && LEFT_OUT.every((t) => !textRun.system.includes(t)) && textRun.system.includes('Tools: read_file{'),
      { happened: textRun.system.slice(-260), why: 'A text-mode model reads its tools from the message.', fix: 'The Tools line in systemPrompt uses offeredTools.' });
    const d = dir({ 'a.txt': 'one' + NL });
    const st = agentMod.newState(d, 'ollama');
    await withSetting('agent.toolSet', 'core', () => loop.runLoop(st, 'plan it', { chat: scripted([call({ tool: 'todo', items: [{ text: 'first step', done: false }] }), 'Done.']), say: () => {}, ask: async () => true, limits: { maxToolRounds: 4, maxBadReplies: 3 } }));
    check('a todo call made under core is run, not refused', st.todo.length === 1 && st.todo[0].text === 'first step' && st.stop.reason === 'answered',
      { happened: JSON.stringify({ todo: st.todo, stop: st.stop && st.stop.reason }), why: 'A model that knows a tool from habit should not be punished for calling it; the setting only decides what is advertised.', fix: 'runTool does not look at agent.toolSet.' });
  });

  // ---------- flags.redCheckNudge ----------
  const FLAG = 'ATLIAS_FLAG_RED_CHECK_NUDGE';
  // A check that fails until a.txt holds the word two, named so the loop's classifier takes it for a check.
  const CHECK_JS = ["const fs = require('fs');", "const ok = fs.readFileSync('a.txt', 'utf8').includes('two');", "console.log(ok ? 'all good' : 'FAILED: a.txt does not hold two');", 'process.exit(ok ? 0 : 1);'].join(NL);
  const RUN_CHECK = call({ tool: 'shell', command: 'node check.js' });
  const EDIT_WRONG = call({ tool: 'edit_file', path: 'a.txt', old_string: 'one', new_string: 'three' });
  const EDIT_RIGHT = call({ tool: 'edit_file', path: 'a.txt', old_string: 'three', new_string: 'two' });
  const EDIT_GOOD = call({ tool: 'edit_file', path: 'a.txt', old_string: 'one', new_string: 'two' });
  const red = async (flag, replies) => {
    const d = dir({ 'a.txt': 'one' + NL, 'check.js': CHECK_JS + NL });
    const before = process.env[FLAG];
    if (flag == null) delete process.env[FLAG]; else process.env[FLAG] = flag;
    try {
      const st = agentMod.newState(d, 'ollama');
      const reply = await withSetting('agent.testCommand', 'off', () => loop.runLoop(st, 'fix it', { chat: scripted([...replies]), say: () => {}, ask: async () => true, limits: { maxToolRounds: 12, maxBadReplies: 3 } }));
      const said = st.messages.filter((m) => m.role === 'user').map((m) => String(m.content || ''));
      return { st, reply, said, file: fs.readFileSync(path.join(d, 'a.txt'), 'utf8') };
    } finally { if (before == null) delete process.env[FLAG]; else process.env[FLAG] = before; }
  };
  const nudges = (r) => r.said.filter((t) => t.startsWith('atlias: the last check you ran after your edits failed'));
  const brief = (r) => JSON.stringify({ stop: r.st.stop && r.st.stop.reason, red: r.st.redNudges, last: r.st.lastCheck && r.st.lastCheck.outcome, file: r.file, said: r.said.map((t) => t.split(NL)[0].slice(0, 60)) }).slice(0, 900);

  suite('red check expert', 'red check: the flag is registered like every round-five flag', () => {
    const row = settings.rows().find((r) => r.id === 'flags.redCheckNudge');
    check('flags.redCheckNudge is off by default, described, and switched from the environment', core.DEFAULTS.flags.redCheckNudge === false && core.flagEnvName('redCheckNudge') === FLAG && row && row.env === FLAG && row.value === false && /sent back once/.test(row.about) && /11 of the 16 failed runs/.test(row.about),
      { happened: JSON.stringify(row || null), why: 'Every behaviour change lands off, behind a key the loop can set per round from the environment.', fix: 'DEFAULTS.flags in lib/core.mjs and DESCRIPTIONS in lib/settings.mjs.' });
  });

  await asyncSuite('red check expert', 'red check: an answer given while the newest check failed is sent back once, when the flag is on', async () => {
    const SCRIPT = [EDIT_WRONG, RUN_CHECK, 'Done, it works.', EDIT_RIGHT, RUN_CHECK, 'Done, the check passes.'];
    const on = await red('1', SCRIPT);
    check('edit, a check that fails, an answer: the answer is sent back with what the check said, and the fixed run then ends', nudges(on).length === 1 && /FAILED: a.txt does not hold two|exit code 1/.test(nudges(on)[0]) && on.st.redNudges === 1 && on.st.stop.reason === 'answered' && on.reply.includes('the check passes') && on.file === 'two' + NL && on.st.lastCheck.outcome === 'pass',
      { happened: brief(on), why: 'An answer after a failing check is a wrong answer the harness could see coming.', fix: 'The red branch before the final stopWith in runLoop.' });
    const off = await red('0', SCRIPT);
    const unset = await red(null, SCRIPT);
    const asBefore = (r) => nudges(r).length === 0 && !r.st.redNudges && r.st.stop.reason === 'answered' && r.reply.includes('it works') && r.file === 'three' + NL;
    check('with the flag off or not set that answer is final, as before, and nothing is added to the conversation', asBefore(off) && asBefore(unset) && off.said.length === unset.said.length,
      { happened: `off ${brief(off)} || unset ${brief(unset)}`, why: 'The champion and every stored run used the loop with the flag off; off must stay the same behaviour.', fix: 'The redOn guard in runLoop.' });
    const twice = await red('1', [EDIT_WRONG, RUN_CHECK, 'Done, it works.', 'I cannot make it pass here because the file is fixed.', 'x']);
    check('it is sent back once only: a second answer with the check still failing is final', nudges(twice).length === 1 && twice.st.redNudges === 1 && twice.st.stop.reason === 'answered' && twice.reply.includes('cannot make it pass'),
      { happened: brief(twice), why: 'One more round is a fair price for a likely fix; a loop of them is not.', fix: 'redNudged in runLoop.' });
    const green = await red('1', [EDIT_GOOD, RUN_CHECK, 'Done, the check passes.']);
    check('a check that passed lets the answer through with no nudge', nudges(green).length === 0 && !green.st.redNudges && green.st.stop.reason === 'answered' && green.st.lastCheck.outcome === 'pass',
      { happened: brief(green), why: 'The flag must cost nothing on the runs that were already right.', fix: 'The red test reads lastCheck.outcome.' });
    // With flags.finishOnGreen on as well, the loop runs the visible check itself after an edit and keeps a
    // failure to itself. That hidden run is not a check the model ran, so it must not be quoted back as one.
    const GREEN = 'ATLIAS_FLAG_FINISH_ON_GREEN';
    const greenBefore = process.env[GREEN];
    process.env[GREEN] = '1';
    let hidden;
    try { hidden = await red('1', [EDIT_WRONG, 'Done.', 'Done again.', 'x']); } finally { if (greenBefore == null) delete process.env[GREEN]; else process.env[GREEN] = greenBefore; }
    check('a failing check only the loop saw (finishOnGreen) is not sent back as the model\'s own', nudges(hidden).length === 0 && !hidden.st.redNudges && hidden.st.greenChecks >= 1 && hidden.st.stop.reason === 'answered',
      { happened: brief(hidden) + ` green ${hidden.st.greenChecks}`, why: 'Two flags tested in one round must each do only what its own description says.', fix: 'runLoop puts state.lastCheck back after the finishOnGreen check, as it does verifiedAt.' });
    const noEdit = await red('1', [RUN_CHECK, 'It fails and I changed nothing.']);
    check('a failing check with no edit in this run is not a reason to send the answer back', nudges(noEdit).length === 0 && !noEdit.st.redNudges && noEdit.st.stop.reason === 'answered',
      { happened: brief(noEdit), why: 'A question about a failing test is answered by saying it fails.', fix: 'The red test needs an edit in this run.' });
  });

  // ---------- compaction keeps what was asked ----------
  await asyncSuite('context expert', 'compaction: the request survives the cut, word for word', async () => {
    const st = agentMod.newState(dir({ 'a.txt': 'one' + NL }), 'ollama');
    const asks = [];
    const say = async (q, a) => { asks.push(q); await loop.runLoop(st, q, { chat: scripted([a]), say: () => {}, ask: async () => true, limits: { maxToolRounds: 2, maxBadReplies: 3 } }); };
    for (let i = 0; i < 12; i++) await say(`request number ${i}: do the thing called T${i}`, `answer ${i}`);
    check('every request is kept beside the conversation, in order, and none of it rides in a message', JSON.stringify(st.asks) === JSON.stringify(asks) && st.messages.length === 25 && loop.view(st.messages, 4, 4).every((m) => Object.keys(m).every((k) => k === 'role' || k === 'content')),
      { happened: `${(st.asks || []).length} kept, ${st.messages.length} messages`, why: 'The list is bookkeeping for a later cut; sent, it would cost tokens on every call.', fix: 'runLoop pushes the prompt onto state.asks and nowhere else.' });
    const said = loop.compact(st, 8);
    const note = st.messages[1].content;
    check('the note the cut leaves restates every request it removed, numbered, oldest first, and not the ones still in view', /compacted 16 earlier/.test(said) && note.startsWith('atlias: 16 earlier messages were compacted away to keep the context small.' + NL + 'What you were asked, word for word, oldest first:' + NL + `1. ${asks[0]}` + NL) && asks.slice(0, 8).every((a, i) => note.includes(`${i + 1}. ${a}`)) && asks.slice(8).every((a) => !note.includes(a)) && st.messages.filter((m) => m.role === 'user' && asks.slice(8).includes(m.content)).length === 4,
      { happened: note.slice(0, 400), why: 'A cut that keeps the rules picked out of a request and drops the request leaves a model working from a summary of what it was asked.', fix: 'compact adds askedNote for the asks no longer in the kept part.' });
    const bare = { cwd: st.cwd, messages: [{ role: 'system', content: 'sys' }], todo: [], edited: new Set() };
    for (let i = 0; i < 12; i++) bare.messages.push({ role: 'user', content: 'q' + i }, { role: 'assistant', content: 'a' + i });
    loop.compact(bare, 8);
    check('a conversation with no such list is compacted exactly as before', bare.messages[1].content === 'atlias: 16 earlier messages were compacted away to keep the context small.' && loop.askedNote([]) === '' && loop.askedNote(undefined) === '',
      { happened: bare.messages[1].content, why: 'Sessions saved before this change have no list; their note must not gain an empty heading.', fix: 'askedNote returns an empty string for an empty list.' });
    const many = Array.from({ length: 30 }, (_, i) => `ask ${i} ` + 'x'.repeat(990));
    const big = loop.askedNote(many);
    check('with more than fits, the first request and the newest are kept and the note says how many are left out', big.includes('(24 in between left out)') && big.includes('1. ask 0 ') && big.includes('30. ask 29 ') && big.includes('26. ask 25 ') && !big.includes('ask 12 ') && big.length < 6300 && loop.askedNote(['y'.repeat(5000)]).length < 2200,
      { happened: `${big.length} characters`, why: 'The first request sets the task and the newest ones amend it; a note that grew without bound would undo the compaction.', fix: 'The budget and the per-request clip in askedNote.' });
    for (let i = 12; i < 25; i++) await say(`request number ${i}`, `answer ${i}`);
    check('the list itself stops at twenty: the first request and the newest nineteen', st.asks.length === 20 && st.asks[0] === asks[0] && st.asks[19] === asks[24] && st.asks[1] === asks[6],
      { happened: `${st.asks.length} kept; second is ${st.asks[1]}`, why: 'A session can run for days.', fix: 'The splice after the push in runLoop.' });
  });
}
