// flags.visibleCheck (Gev 2026-10-16, the real harness for 20x): with agent.testCommand auto, a project
// whose only check is a script at its top (a HumanEvalFix workspace's check.py) gets that script run
// after an edit, named as the stop gate names it, so the model need not spend a call to run it. Off by
// default, so every stored run stays comparable. Scripted model only. Loaded by test/run.mjs.
import * as loop from '../lib/loop.mjs';
import * as gate from '../lib/gate.mjs';
import * as settings from '../lib/settings.mjs';
import * as evals from '../lib/eval.mjs';

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

  // flags.stallStop: the same check failure after three edits in a row ends the run.
  await asyncSuite('visible check', 'with stallStop, the same check failure after three edits in a row stops the run; changing failures and the flag off do not', async () => {
    const STALL = 'ATLIAS_FLAG_STALL_STOP';
    const edit = (a, b) => blk({ tool: 'edit_file', path: 'sum.py', old_string: `return ${a}`, new_string: `return ${b}` });
    const edits = [edit(1, 3), edit(3, 4), edit(4, 5), edit(5, 6), edit(6, 7), 'Done.'];
    const stallRun = (stall, files) => withFlags(['ATLIAS_FLAG_VISIBLE_CHECK', 'ATLIAS_FLAG_FINISH_ON_GREEN'], async () => {
      const before = process.env[STALL];
      if (stall) process.env[STALL] = '1'; else delete process.env[STALL];
      try {
        const d = dir(files);
        const script = [...edits];
        let calls = 0;
        const chat = async () => { calls++; const r = script.shift(); return { content: r === undefined ? 'out of script' : r, calls: [] }; };
        const st = agentMod.newState(d, 'ollama');
        await loop.runLoop(st, 'make two() return 2', { chat, say: () => {}, ask: async () => true, limits: { maxToolRounds: 8, maxBadReplies: 3 } });
        return { calls, stop: st.stop };
      } finally { if (before == null) delete process.env[STALL]; else process.env[STALL] = before; }
    });
    const PRINTING = { ...PROJECT, 'check.py': 'import sys' + NL + 'from sum import two' + NL + 'print(two())' + NL + 'sys.exit(0 if two() == 2 else 1)' + NL };
    const same = await stallRun(true, PROJECT), off = await stallRun(false, PROJECT), changing = await stallRun(true, PRINTING);
    check('on, three edits that leave the check failing the same way end the run as check-stalled after the third; off, and with a failure that changes each time, the run goes on',
      same.calls === 3 && same.stop && same.stop.reason === 'check-stalled' && loop.STOP_REASONS.includes('check-stalled') && loop.STALL_REPEATS === 3
        && off.calls > 3 && off.stop.reason !== 'check-stalled' && changing.calls > 3 && changing.stop.reason !== 'check-stalled'
        && core.DEFAULTS.flags.stallStop === false && (settings.DESCRIPTIONS['flags.stallStop'] || '').length > 40,
      { happened: JSON.stringify({ same, off, changing }), why: 'On harness-n3 to n6 the runs that ran out of rounds held a third of Atlias tokens and passed 1 of 25; a run whose edits do not change the failure is not converging, but one whose failure changes may be.', fix: 'lib/loop.mjs, the finishOnGreen block, behind flags.stallStop.' });
  });

  // flags.greenFailShown: a failure of the check atlias runs after an edit reaches the model.
  await asyncSuite('visible check', 'with greenFailShown, a failing check after an edit reaches the model in its next request; off, it does not', async () => {
    const SHOWN = 'ATLIAS_FLAG_GREEN_FAIL_SHOWN';
    const shownRun = (shown) => withFlags(['ATLIAS_FLAG_VISIBLE_CHECK', 'ATLIAS_FLAG_FINISH_ON_GREEN'], async () => {
      const before = process.env[SHOWN];
      if (shown) process.env[SHOWN] = '1'; else delete process.env[SHOWN];
      try {
        const d = dir({ ...PROJECT, 'check.py': 'import sys' + NL + 'from sum import two' + NL + 'print("got", two())' + NL + 'sys.exit(0 if two() == 2 else 1)' + NL });
        const script = [blk({ tool: 'edit_file', path: 'sum.py', old_string: 'return 1', new_string: 'return 3' }), blk({ tool: 'edit_file', path: 'sum.py', old_string: 'return 3', new_string: 'return 2' }), 'Done.'];
        const seen = [];
        const chat = async (messages) => { seen.push(JSON.stringify(messages)); const r = script.shift(); return { content: r === undefined ? 'out of script' : r, calls: [] }; };
        const st = agentMod.newState(d, 'ollama');
        await loop.runLoop(st, 'make two() return 2', { chat, say: () => {}, ask: async () => true, limits: { maxToolRounds: 6, maxBadReplies: 3 } });
        return { calls: seen.length, second: seen[1] || '', stop: st.stop, trace: evals.toolTrace(st.messages) };
      } finally { if (before == null) delete process.env[SHOWN]; else process.env[SHOWN] = before; }
    });
    const on = await shownRun(true), off = await shownRun(false);
    check('on, the second request carries the failed check and its output and the run ends on the passing check; off, the second request has neither',
      /atlias ran the project's check after your edit/.test(on.second) && /got 3/.test(on.second) && on.calls === 2 && on.stop && /check passed/.test(on.stop.detail) && on.trace.includes('atlias-check')
        && !/got 3/.test(off.second) && !/check after your edit/.test(off.second) && off.calls === 2
        && core.DEFAULTS.flags.greenFailShown === false && (settings.DESCRIPTIONS['flags.greenFailShown'] || '').length > 40,
      { happened: JSON.stringify({ on: { calls: on.calls, stop: on.stop, trace: on.trace }, off: { calls: off.calls, stop: off.stop } }), why: 'harness-n9: the model ran the check itself after nearly every edit, a call each time, because the failure atlias saw was kept from it.', fix: 'lib/loop.mjs, the finishOnGreen block, behind flags.greenFailShown.' });
  });

  // flags.verifyStrict (HAC-1 item 2): a check word must stand as a whole token.
  await asyncSuite('visible check', 'with verifyStrict, cat tsconfig.json and node dist/latest.js are not checks; real checks still are; off, the older match stands', async () => {
    const STRICT = 'ATLIAS_FLAG_VERIFY_STRICT';
    const q = String.fromCharCode(34), bs = String.fromCharCode(92);
    const winNode = q + 'C:' + bs + 'Program Files' + bs + 'nodejs' + bs + 'node.exe' + q + ' --check x.js';
    const notChecks = ['cat tsconfig.json', 'cat .eslintrc.json', 'node dist/latest.js', 'type tsconfig.json'];
    const checks = ['npx tsc --noEmit', 'node --check a.js', 'python -m pytest -q', 'node test/run.mjs', 'npm test', 'go test ./...', 'make test', 'eslint .', winNode, 'node tools/sweeps/run.mjs', 'python check.py', 'node ./test/x.mjs'];
    const before = process.env[STRICT];
    let on, off;
    try {
      process.env[STRICT] = '1';
      on = { no: notChecks.map((c) => core.looksLikeVerification(c)), yes: checks.map((c) => core.looksLikeVerification(c)) };
      delete process.env[STRICT];
      off = notChecks.map((c) => core.looksLikeVerification(c));
    } finally { if (before == null) delete process.env[STRICT]; else process.env[STRICT] = before; }
    check('on, none of the look-alikes is a check and every real check still is; off, the look-alikes match as before',
      on.no.every((v) => v === false) && on.yes.every((v) => v === true) && off.every((v) => v === true)
        && core.DEFAULTS.flags.verifyStrict === false && (settings.DESCRIPTIONS['flags.verifyStrict'] || '').length > 40,
      { happened: JSON.stringify({ on, off }), why: 'A look-alike counted as a passing check lets a failing run be answered and silences the red-check nudge (HAC-1, core.mjs VERIFY_RE).', fix: 'lib/core.mjs looksLikeVerification behind flags.verifyStrict.' });
  });

  // flags.looseKeepsLines (HAC-1 item 3): a loose span may not hide lines the model never named.
  await asyncSuite('visible check', 'with looseKeepsLines, a loose match whose span holds unnamed lines is refused; a drifted line is still accepted', async () => {
    const KEEP = 'ATLIAS_FLAG_LOOSE_KEEPS_LINES';
    const file = ['def a():', '    y = 2', '    z = 3', '    return x'].join(NL);
    const old = ['def a():', '    x = 1', '    return x'].join(NL);
    const drifted = ['def a():', '    x = 1  # note', '    return x'].join(NL);
    const before = process.env[KEEP];
    let on, off, drift;
    try {
      process.env[KEEP] = '1';
      on = loop.looseMatch(file, old);
      drift = loop.looseMatch(drifted, old);
      delete process.env[KEEP];
      off = loop.looseMatch(file, old);
    } finally { if (before == null) delete process.env[KEEP]; else process.env[KEEP] = before; }
    check('on, the span holding y and z (never named) is refused and a one-line drift still matches; off, the span is matched whole as before',
      on === null && drift && drift.start === 0 && !drift.many && off && off.start === 0 && /first and last line/.test(off.how)
        && core.DEFAULTS.flags.looseKeepsLines === false && (settings.DESCRIPTIONS['flags.looseKeepsLines'] || '').length > 40,
      { happened: JSON.stringify({ on, drift, off }), why: 'Rung two replaces its whole span: matched by its ends, an edit could delete code the model never named (HAC-1, loop.mjs looseMatch).', fix: 'lib/loop.mjs looseMatch behind flags.looseKeepsLines.' });
  });

  // flags.stallLastLine (HAC-1 item 8): a traceback that changes above the same last line still stalls.
  await asyncSuite('visible check', 'with stallLastLine, a failure whose output changes but whose last line does not stops the run; raw stallStop does not', async () => {
    const ENV = ['ATLIAS_FLAG_STALL_STOP', 'ATLIAS_FLAG_STALL_LAST_LINE'];
    const edit = (a, b) => blk({ tool: 'edit_file', path: 'sum.py', old_string: `return ${a}`, new_string: `return ${b}` });
    const ASSERTING = 'from sum import two' + NL + 'print("got", two())' + NL + 'assert two() == 2' + NL;
    const CHANGING = 'import sys' + NL + 'from sum import two' + NL + 'print("got " + "x" * two())' + NL + 'sys.exit(0 if two() == 2 else 1)' + NL;
    const lastRun = (lastLine, checkText = ASSERTING) => withFlags(['ATLIAS_FLAG_VISIBLE_CHECK', 'ATLIAS_FLAG_FINISH_ON_GREEN'], async () => {
      const before = ENV.map((k) => process.env[k]);
      process.env[ENV[0]] = '1';
      if (lastLine) process.env[ENV[1]] = '1'; else delete process.env[ENV[1]];
      try {
        const d = dir({ ...PROJECT, 'check.py': checkText });
        const script = [edit(1, 3), edit(3, 4), edit(4, 5), edit(5, 6), edit(6, 7), 'Done.'];
        let calls = 0;
        const chat = async () => { calls++; const r = script.shift(); return { content: r === undefined ? 'out of script' : r, calls: [] }; };
        const st = agentMod.newState(d, 'ollama');
        await loop.runLoop(st, 'make two() return 2', { chat, say: () => {}, ask: async () => true, limits: { maxToolRounds: 8, maxBadReplies: 3 } });
        return { calls, stop: st.stop };
      } finally { ENV.forEach((k, i) => { if (before[i] == null) delete process.env[k]; else process.env[k] = before[i]; }); }
    });
    const on = await lastRun(true), raw = await lastRun(false), moving = await lastRun(true, CHANGING);
    check('on, three edits ending in the same AssertionError stop the run as check-stalled although the printed value changes; raw stallStop goes on; a last line that changes does not stall',
      on.calls === 3 && on.stop && on.stop.reason === 'check-stalled' && raw.calls > 3 && raw.stop.reason !== 'check-stalled'
        && moving.calls > 3 && moving.stop.reason !== 'check-stalled'
        && core.DEFAULTS.flags.stallLastLine === false && (settings.DESCRIPTIONS['flags.stallLastLine'] || '').length > 40,
      { happened: JSON.stringify({ on, raw }), why: 'harness-n8: stallStop never fired, because a traceback changes with every edit even when the failure does not.', fix: 'lib/loop.mjs, the stall block, behind flags.stallLastLine.' });
  });

  // flags.strayNameArgs (HAC-1 item 9): the {"name", "arguments"} shape written as text is read as a call.
  await asyncSuite('visible check', 'with strayNameArgs, a whole-reply name and arguments object is a tool call; plain JSON data is still an answer', async () => {
    const ENV = 'ATLIAS_FLAG_STRAY_NAME_ARGS';
    const shellObj = JSON.stringify({ name: 'run_shell', arguments: { command: 'python check.py' } });
    const strArgs = JSON.stringify({ name: 'read_file', arguments: JSON.stringify({ path: 'a.py' }) });
    const fenced = FENCE + 'json' + NL + JSON.stringify({ name: 'read_file', parameters: { path: 'b.py' } }) + NL + FENCE;
    const unknown = JSON.stringify({ name: 'teleport', arguments: {} });
    const data = JSON.stringify({ name: 'Alice', age: 3 });
    const before = process.env[ENV];
    let on, off;
    try {
      process.env[ENV] = '1';
      on = [shellObj, strArgs, fenced, unknown, data].map((t) => loop.strayToolCall(t));
      delete process.env[ENV];
      off = [shellObj, strArgs, data].map((t) => loop.strayToolCall(t));
    } finally { if (before == null) delete process.env[ENV]; else process.env[ENV] = before; }
    check('on, run_shell becomes shell with its command, string arguments and a fenced parameters form are read, an unknown name is answered as broken, and plain JSON data stays an answer; off, none of them is a call',
      on[0] && on[0].tool === 'shell' && on[0].command === 'python check.py' && on[1] && on[1].tool === 'read_file' && on[1].path === 'a.py'
        && on[2] && on[2].tool === 'read_file' && on[2].path === 'b.py' && on[3] && on[3].broken === true && /teleport/.test(on[3].why) && on[4] === null
        && off.every((v) => v === null) && core.DEFAULTS.flags.strayNameArgs === false && (settings.DESCRIPTIONS['flags.strayNameArgs'] || '').length > 40,
      { happened: JSON.stringify({ on, off }), why: 'A reply that is a tool call atlias cannot read is taken as the final answer (RESEARCH-FIRST 0b, H3); HAC-1 found the name and arguments shape uncovered.', fix: 'lib/loop.mjs strayToolCall behind flags.strayNameArgs.' });
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
