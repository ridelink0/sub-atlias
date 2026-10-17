// flags.visibleCheck (Gev 2026-10-16, the real harness for 20x): with agent.testCommand auto, a project
// whose only check is a script at its top (a HumanEvalFix workspace's check.py) gets that script run
// after an edit, named as the stop gate names it, so the model need not spend a call to run it. Off by
// default, so every stored run stays comparable. Scripted model only. Loaded by test/run.mjs.
import * as loop from '../lib/loop.mjs';
import * as gate from '../lib/gate.mjs';
import * as settings from '../lib/settings.mjs';

export default async function visibleCheckSuites({ asyncSuite, suite, check, core, agentMod, TMP, fs, path }) {
  const NL = String.fromCharCode(10);
  const FENCE = '`'.repeat(3);
  const blk = (o) => FENCE + 'atlias' + NL + JSON.stringify(o) + NL + FENCE;
  const FLAGS = ['ATLIAS_FLAG_VISIBLE_CHECK', 'ATLIAS_FLAG_FINISH_ON_GREEN'];
  let n = 0;
  const dir = (files) => {
    const d = path.join(TMP, 'visible-check', `v${process.pid}-${++n}`);
    fs.mkdirSync(d, { recursive: true });
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(d, rel), text);
    return d;
  };
  const withFlags = async (on, fn) => {
    const before = FLAGS.map((k) => process.env[k]);
    for (const k of FLAGS) delete process.env[k];
    for (const k of on) process.env[k] = '1';
    try { return await fn(); } finally { FLAGS.forEach((k, i) => { if (before[i] == null) delete process.env[k]; else process.env[k] = before[i]; }); }
  };
  const PROJECT = { 'sum.py': 'def two():' + NL + '    return 1' + NL, 'check.py': 'import sys' + NL + 'from sum import two' + NL + 'sys.exit(0 if two() == 2 else 1)' + NL };
  const fix = blk({ tool: 'edit_file', path: 'sum.py', old_string: 'return 1', new_string: 'return 2' });
  const run = (on, replies) => withFlags(on, async () => {
    const d = dir(PROJECT);
    const script = [...replies];
    let calls = 0;
    const seen = [];
    const chat = async (messages) => { calls++; seen.push(JSON.stringify(messages)); const r = script.shift(); return { content: r === undefined ? 'out of script' : r, calls: [] }; };
    const st = agentMod.newState(d, 'ollama');
    await loop.runLoop(st, 'make two() return 2', { chat, say: () => {}, ask: async () => true, limits: { maxToolRounds: 6, maxBadReplies: 3 } });
    return { d, st, calls, seen, file: fs.readFileSync(path.join(d, 'sum.py'), 'utf8') };
  });

  suite('visible check', 'the flag is registered off, described, and switched from the environment', () => {
    const row = settings.rows().find((r) => r.id === 'flags.visibleCheck');
    check('flags.visibleCheck is off by default, described, with its environment name',
      core.DEFAULTS.flags.visibleCheck === false && row && row.env === 'ATLIAS_FLAG_VISIBLE_CHECK' && /check script/.test(row.about),
      { happened: JSON.stringify(row || null), why: 'Every behaviour change lands off, behind a key an arm can set.', fix: 'DEFAULTS.flags in lib/core.mjs and DESCRIPTIONS in lib/settings.mjs.' });
  });

  await asyncSuite('visible check', 'with the flag a top-level check script is the project check; without it there is none', async () => {
    const d = dir(PROJECT);
    const named = gate.visibleCheck(d).command;
    const auto = { testCommand: 'auto' };
    const off = await withFlags([], async () => loop.checkCommand(d, auto));
    const on = await withFlags(['ATLIAS_FLAG_VISIBLE_CHECK'], async () => loop.checkCommand(d, auto));
    check('off, a project with only check.py has no check; on, it is the script the gate names', off === '' && on === named && /check\.py$/.test(on),
      { happened: JSON.stringify({ off, on, named }), why: 'Off must leave stored runs as they were; on must run what the gate would run.', fix: 'lib/loop.mjs checkCommand, behind flags.visibleCheck.' });
    const npm = dir({ ...PROJECT, 'package.json': JSON.stringify({ scripts: { test: 'node t.js' } }) });
    const none = dir({ 'sum.py': 'x = 1' + NL });
    const kept = await withFlags(['ATLIAS_FLAG_VISIBLE_CHECK'], async () => [loop.checkCommand(npm, auto), loop.checkCommand(none, auto), loop.checkCommand(d, { testCommand: 'off' }), loop.checkCommand(d, { testCommand: 'make check' })]);
    check('the detector still wins, off still means off, an explicit command is kept, and no script means no check', kept[0] === 'npm test' && kept[1] === '' && kept[2] === '' && kept[3] === 'make check',
      { happened: JSON.stringify(kept), why: 'The script is a fallback for a project the detector finds nothing in, never an override.', fix: 'Return the detector, off and explicit values before the fallback.' });
  });

  await asyncSuite('visible check', 'on, the loop runs the check after an edit, so a passing fix ends in one call with finishOnGreen', async () => {
    const both = await run(['ATLIAS_FLAG_VISIBLE_CHECK', 'ATLIAS_FLAG_FINISH_ON_GREEN'], [fix, 'Done: two() returns 2.']);
    const neither = await run([], [fix, 'Done: two() returns 2.']);
    check('with visibleCheck and finishOnGreen a correct edit is checked by atlias and the task ends after one model call',
      both.calls === 1 && /return 2/.test(both.file) && both.st.stop && both.st.stop.reason === 'answered' && /check passed/.test(both.st.stop.detail) && neither.calls > 1 && /return 2/.test(neither.file),
      { happened: JSON.stringify({ both: [both.calls, both.st.stop], neither: [neither.calls, neither.st.stop] }), why: 'Each call re-sends the whole context; a check atlias can run itself needs no model call (20x needs about two calls a task).', fix: 'checkCommand under flags.visibleCheck, and finishOnGreen in runLoop.' });
    const red = await run(['ATLIAS_FLAG_VISIBLE_CHECK'], [blk({ tool: 'edit_file', path: 'sum.py', old_string: 'return 1', new_string: 'return 3' }), 'Done.', 'Done.']);
    const shown = red.seen.slice(1).some((m) => /check\.py/.test(m));
    check('on, a failing check after an edit reaches the model in its next request without a call of its own', shown,
      { happened: JSON.stringify({ calls: red.calls, stop: red.st.stop }), why: 'A failure the model never sees cannot be fixed; one it must run itself costs a call.', fix: 'The loop runs checkCommand after an edit and adds its result.' });
  });

  // flags.quietNoCheck: a project with no check atlias can name is not asked for one.
  const QUIET = 'ATLIAS_FLAG_QUIET_NO_CHECK';
  const withQuiet = async (on, fn) => {
    const before = process.env[QUIET];
    if (on) process.env[QUIET] = '1'; else delete process.env[QUIET];
    try { return await fn(); } finally { if (before == null) delete process.env[QUIET]; else process.env[QUIET] = before; }
  };
  const BARE = { 'sum.py': 'def two():' + NL + '    return 1' + NL };
  await asyncSuite('quiet no check', 'with no check atlias can name, the prompt asks for none and the answer is not sent back', async () => {
    const bare = dir(BARE);
    const checked = dir(PROJECT);
    const offPrompt = await withQuiet(false, async () => loop.systemPrompt(bare, { hasGraph: false, instructions: '' }));
    const onPrompt = await withQuiet(true, async () => loop.systemPrompt(bare, { hasGraph: false, instructions: '' }));
    const onChecked = await withQuiet(true, async () => loop.systemPrompt(checked, { hasGraph: false, instructions: '' }));
    const offChecked = await withQuiet(false, async () => loop.systemPrompt(checked, { hasGraph: false, instructions: '' }));
    check('on, a project with no check gets a prompt that asks for none and says to report that it could not be checked; off, and any project with a check, keep the prompt as it was',
      /run the smallest real check/.test(offPrompt) && !/run the smallest real check/.test(onPrompt) && /could not be checked here/.test(onPrompt)
        && /Never say something works unless a check/.test(onPrompt) && onChecked === offChecked,
      { happened: JSON.stringify({ off: offPrompt.length, on: onPrompt.length, checkedSame: onChecked === offChecked }), why: 'Asked for a check it cannot have, a 9B writes its own (CanItEdit: 4 to 12 calls on harness-n2c); the honesty rule must stay.', fix: 'lib/loop.mjs systemPrompt behind quietNoCheckHere.' });
    const here = await withQuiet(true, async () => [loop.quietNoCheckHere(bare), loop.quietNoCheckHere(checked)]);
    const hereOff = await withQuiet(false, async () => loop.quietNoCheckHere(bare));
    check('quietNoCheckHere is true only with the flag on and no check atlias can name',
      here[0] === true && here[1] === false && hereOff === false,
      { happened: JSON.stringify({ here, hereOff }), why: 'The prompt and the nudge both rest on this one answer.', fix: 'lib/loop.mjs quietNoCheckHere.' });
    const runQuiet = (on) => withQuiet(on, async () => {
      const d = dir(BARE);
      const script = [fix, 'Done: two() returns 2; no check could be run here.', 'Done.'];
      let calls = 0;
      const chat = async () => { calls++; const r = script.shift(); return { content: r === undefined ? 'out of script' : r, calls: [] }; };
      const st = agentMod.newState(d, 'ollama');
      await loop.runLoop(st, 'make two() return 2', { chat, say: () => {}, ask: async () => true, limits: { maxToolRounds: 6, maxBadReplies: 3 } });
      return { calls, st };
    });
    const on = await runQuiet(true);
    const off = await runQuiet(false);
    check('on, an answer after an edit in a project with no check ends the run; off, it is sent back once for a check',
      on.calls === 2 && on.st.stop && on.st.stop.reason === 'answered' && off.calls === 3,
      { happened: JSON.stringify({ on: [on.calls, on.st.stop], off: [off.calls, off.st.stop] }), why: 'Every call re-sends the whole context; a check that cannot exist is not worth one.', fix: 'Skip the unchecked nudge when quietNoCheckHere is true.' });
  });
}
