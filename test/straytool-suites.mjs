// flags.strayToolCalls (2026-10-12). A reply that is itself one tool call
// atlias could not read used to be taken as the final answer: nine tasks in the
// 2026-10-11 runs ended that way, every one a fail, two of them tasks that
// stock nanobot, stock OpenCode and mini-swe-agent all solved. With the flag on
// such a reply is run when its name is a known stray one (run_shell), and is
// otherwise answered with what was wrong. Every case here drives runLoop with a
// scripted model and checks the same script with the flag off, which must be
// the loop as it was. Loaded by test/run.mjs.
import * as loop from '../lib/loop.mjs';
import * as settings from '../lib/settings.mjs';

export default async function strayToolSuites({ asyncSuite, suite, check, core, agentMod, TMP, fs, path }) {
  const NL = String.fromCharCode(10);
  const FENCE = '`'.repeat(3);
  const FLAG = 'ATLIAS_FLAG_STRAY_TOOL_CALLS';
  // The command prints a word that is nowhere in the command itself, so finding it proves the command ran.
  const RAN = 'stray' + 'ran';
  const SHELL = `node -e "console.log('stray'+'ran')"`;
  let n = 0;
  const dir = (files) => {
    const d = path.join(TMP, 'straytool', `p${++n}`);
    fs.mkdirSync(d, { recursive: true });
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(d, rel), text);
    return d;
  };
  const scripted = (replies) => async () => {
    const r = replies.shift();
    if (r === undefined) return { content: 'out of script', calls: [] };
    return typeof r === 'string' ? { content: r, calls: [] } : r;
  };
  const run = async (flag, replies, limits = { maxToolRounds: 12, maxBadReplies: 3 }) => {
    const d = dir({ 'a.txt': 'one' + NL });
    const before = process.env[FLAG];
    if (flag == null) delete process.env[FLAG]; else process.env[FLAG] = flag;
    try {
      const st = agentMod.newState(d, 'ollama');
      const reply = await loop.runLoop(st, 'fix it', { chat: scripted([...replies]), say: () => {}, ask: async () => true, limits });
      const said = st.messages.filter((m) => m.role !== 'system' && m.role !== 'assistant').map((m) => String(m.content || ''));
      return { st, reply, said };
    } finally { if (before == null) delete process.env[FLAG]; else process.env[FLAG] = before; }
  };
  const brief = (r) => JSON.stringify({ stop: r.st.stop, stray: r.st.strayCalls, reply: String(r.reply).slice(0, 120), said: r.said.map((t) => t.slice(0, 90)) }).slice(0, 700);
  const bare = (tool, rest) => JSON.stringify({ tool, ...rest });

  suite('stray tool call expert', 'the flag is registered like every round-five flag', () => {
    const row = settings.rows().find((r) => r.id === 'flags.strayToolCalls');
    check('flags.strayToolCalls is off by default, described, and switched from the environment', core.DEFAULTS.flags.strayToolCalls === false && row && row.env === FLAG && /run_shell/.test(row.about) && /final answer/.test(row.about),
      { happened: JSON.stringify(row || null), why: 'Every behaviour change lands off, behind a key the loop can set per round from the environment.', fix: 'DEFAULTS.flags in lib/core.mjs and DESCRIPTIONS in lib/settings.mjs.' });
  });

  suite('stray tool call expert', 'the reader tells a stray tool call from an answer', () => {
    const f = loop.strayToolCall;
    const recorded = [
      '{"tool":"run_shell","command":"cd D:\\\\harness-work\\\\atlias-evolve\\\\work\\\\humanevalfix-python-114-1791572612461-28-0 && python check.py"}',
      '{"tool":"run_shell","command":"python check.py"}',
      FENCE + 'json' + NL + '{"tool":"run_shell","command":"cd D:\\\\x && python check.py"}' + NL + FENCE,
    ];
    const ran = recorded.map(f);
    check('the run_shell replies that ended tasks on 2026-10-11 are read as shell calls with their command', ran.every((c) => c && c.tool === 'shell' && !c.broken && /python check\.py$/.test(c.command)),
      { happened: JSON.stringify(ran).slice(0, 400), why: 'humanevalfix-python-114, -49, -38 and -68 ended on exactly these replies with nothing edited.', fix: 'strayToolCall and STRAY_ALIASES in lib/loop.mjs.' });
    const unread = f('{"tool":"read_file","path":"main.py","offset":1,limit":20}');
    const unknown = f('{"tool":"fly_away","x":1}');
    check('a call whose JSON cannot be read, or whose tool does not exist, comes back as an unread block that says why', unread && unread.broken === true && unread.tool === 'read_file' && /does not parse/.test(unread.why) && unknown && unknown.broken === true && /no tool named fly_away/.test(unknown.why) && /read_file/.test(unknown.why) && /shell/.test(unknown.why),
      { happened: JSON.stringify([unread, unknown]).slice(0, 400), why: 'canitedit-descriptive-35 ended on the first of these; the model has to be told, not left to guess.', fix: 'strayToolCall in lib/loop.mjs.' });
    const answers = ['Fixed the bug in sum.js.', 'I ran it. Example call: {"tool":"run_shell","command":"ls"}', '{"result":"done"}', '{"name":"x"}', '', FENCE + 'atlias' + NL + '{"tool":"run_shell","command":"ls"}' + NL + FENCE, '[{"tool":"run_shell"}]', FENCE + 'python' + NL + 'print(1)' + NL + FENCE];
    check('an answer in prose, an object that names no tool, and one of our own blocks are left alone', answers.every((t) => f(t) === null),
      { happened: JSON.stringify(answers.map((t) => f(t))), why: 'A JSON example inside an answer must never be run.', fix: 'strayToolCall only reads a reply that begins with an object naming a tool.' });
    const sneaky = f('{"tool":"run_shell","command":"ls","_verify":true}');
    const known = f('{"tool":"read","file":"a.txt"}');
    check('a model cannot set the harness\'s own fields, and names and arguments other harnesses use are still mapped', sneaky && sneaky.tool === 'shell' && !('_verify' in sneaky) && known && known.tool === 'read_file' && known.path === 'a.txt',
      { happened: JSON.stringify([sneaky, known]), why: '_verify marks a check atlias ran itself.', fix: 'strayToolCall goes through normalizeCall.' });
    const unclosed = f(FENCE + 'json' + NL + '{"tool":"run_shell","command":"ls"}');
    const trailing = f('{"tool":"run_shell","command":"ls"}' + NL + 'Then I will read the output.');
    check('an unclosed json fence and words after the object do not hide the call', unclosed && unclosed.tool === 'shell' && trailing && trailing.tool === 'shell' && trailing.command === 'ls',
      { happened: JSON.stringify([unclosed, trailing]), why: 'A small model often stops before closing a fence.', fix: 'the fence pattern in strayToolCall.' });
  });

  await asyncSuite('stray tool call expert', 'a mis-named shell call is run instead of ending the task', async () => {
    const script = [bare('run_shell', { command: SHELL }), 'The output shows it ran.', 'spare'];
    const on = await run('1', script);
    const off = await run('0', script);
    const unset = await run(null, script);
    const sawRun = (r) => r.said.some((t) => t.includes(RAN));
    check('with the flag on the command runs, its output reaches the model, and the next reply is the answer', on.st.stop.reason === 'answered' && on.reply === 'The output shows it ran.' && sawRun(on) && on.st.strayCalls === 1,
      { happened: brief(on), why: 'Two screen tasks ended on this reply at round 4 with no edit; all three other harnesses solved them.', fix: 'runLoop: under flags.strayToolCalls a stray call joins the round\'s calls.' });
    check('with the flag off or not set the loop is as it was: the reply is taken as the answer and nothing runs', [off, unset].every((r) => r.st.stop.reason === 'answered' && r.reply === script[0] && !sawRun(r) && !r.st.strayCalls),
      { happened: `off ${brief(off)} || unset ${brief(unset)}`, why: 'The champion and every stored run used the loop with the flag off; off must stay byte for byte the same behaviour.', fix: 'The strayOn guard in runLoop.' });
    const fenced = await run('1', [FENCE + 'json' + NL + bare('run_shell', { command: SHELL }) + NL + FENCE, 'Done.']);
    check('the same call inside a json fence is run too', fenced.st.stop.reason === 'answered' && fenced.reply === 'Done.' && sawRun(fenced) && fenced.st.strayCalls === 1,
      { happened: brief(fenced), why: 'humanevalfix-python-49 ended on the fenced form.', fix: 'strayToolCall reads one fence of any name but ours.' });
  });

  await asyncSuite('stray tool call expert', 'an unreadable call is answered, counted as a bad reply, and never run', async () => {
    const badJson = '{"tool":"read_file","path":"a.txt","offset":1,limit":20}';
    const on = await run('1', [badJson, bare('fly_away', { x: 1 }), 'I could not read it; the file is fine.']);
    const told = on.said.filter((t) => /was not run/.test(t));
    check('the model is told what was wrong each time and can still answer', on.st.stop.reason === 'answered' && on.reply === 'I could not read it; the file is fine.' && told.length === 2 && /read_file/.test(told[0]) && /does not parse/.test(told[0]) && /no tool named fly_away/.test(told[1]) && on.st.strayCalls === 2,
      { happened: brief(on), why: 'A tool error is an observation the model must be able to act on.', fix: 'runLoop answers a broken stray block like any unread block.' });
    const stuck = await run('1', [badJson, badJson, badJson, 'never reached']);
    check('three unreadable replies in a row stop the run as malformed output, not as an answer', stuck.st.stop.reason === 'malformed-output' && stuck.st.strayCalls === 3,
      { happened: brief(stuck), why: 'agent.maxBadReplies still bounds a model that cannot send a usable call.', fix: 'A broken stray block counts as a parse strike.' });
    const off = await run('0', [badJson, 'never reached']);
    check('with the flag off the unreadable call is taken as the answer, as before', off.st.stop.reason === 'answered' && off.reply === badJson && !off.said.some((t) => /was not run/.test(t)),
      { happened: brief(off), why: 'Off is the loop the baseline ran on.', fix: 'The strayOn guard in runLoop.' });
  });

  await asyncSuite('stray tool call expert', 'ordinary replies are untouched with the flag on', async () => {
    const plain = await run('1', ['All good, nothing to change.']);
    const json = await run('1', ['{"result":"nothing to change"}']);
    check('a prose answer and a JSON answer that names no tool end the run at once', plain.st.stop.reason === 'answered' && plain.reply === 'All good, nothing to change.' && !plain.st.strayCalls && json.st.stop.reason === 'answered' && json.reply === '{"result":"nothing to change"}' && !json.st.strayCalls,
      { happened: `${brief(plain)} || ${brief(json)}`, why: 'The flag must not turn answers into calls.', fix: 'strayToolCall returns null for these.' });
    const blk = FENCE + 'atlias' + NL + bare('shell', { command: SHELL }) + NL + FENCE;
    const ours = await run('1', [blk, 'Ran it.']);
    check('one of our own blocks is run by the ordinary path and is not counted as stray', ours.st.stop.reason === 'answered' && ours.said.some((t) => t.includes(RAN)) && !ours.st.strayCalls,
      { happened: brief(ours), why: 'The count is how the loop measures how often the flag did something.', fix: 'The stray reader runs only when nothing else parsed.' });
    const native = await run('1', [{ content: bare('run_shell', { command: 'echo should-not-run-twice' }), calls: [{ tool: 'shell', command: SHELL }] }, 'Ran it.']);
    check('a reply that carries a call on the provider\'s own channel uses that call, and its text is not read for another', native.st.stop.reason === 'answered' && native.said.some((t) => t.includes(RAN)) && !native.said.some((t) => /should-not-run-twice\r?\n/.test(t)) && !native.st.strayCalls,
      { happened: brief(native), why: 'Text is only read for calls when the provider sent none.', fix: 'The stray reader sits inside the text-mode branch.' });
  });
}
