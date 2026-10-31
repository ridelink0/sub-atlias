// flags.finishOnGreen: once an edit lands and the project's own visible check
// then passes, the run stops there as answered. On the 60-task screen of the
// local evolution (2026-10-10) 5 of 44 solved runs ended rounds-exhausted at
// about 33k prompt tokens each, and every round after the fix re-sent the whole
// context. Every case drives runLoop with a scripted model and checks the same
// script with the flag off, which must be the loop as it was. Loaded by
// test/run.mjs.
import * as loop from '../lib/loop.mjs';
import * as settings from '../lib/settings.mjs';
import * as gate from '../lib/gate.mjs';

export default async function finishGreenSuites({ asyncSuite, suite, check, core, agentMod, TMP, fs, path }) {
  const NL = String.fromCharCode(10);
  const FENCE = '`'.repeat(3);
  const blk = (o) => FENCE + 'atlias' + NL + JSON.stringify(o) + NL + FENCE;
  const FLAG = 'ATLIAS_FLAG_FINISH_ON_GREEN';
  let n = 0;
  const dir = (files) => {
    const d = path.join(TMP, 'finishgreen', `p${++n}`);
    fs.mkdirSync(d, { recursive: true });
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(d, rel), text);
    return d;
  };
  // One run of a script in a fresh project, with the flag on ('1'), off ('0')
  // or not set (null). `calls` counts the model calls the run made.
  const run = async (flag, files, replies, limits = { maxToolRounds: 8, maxBadReplies: 3 }) => {
    const d = dir(files);
    const before = process.env[FLAG];
    if (flag == null) delete process.env[FLAG]; else process.env[FLAG] = flag;
    const script = [...replies];
    let calls = 0;
    const chat = async () => { calls++; const r = script.shift(); return { content: r === undefined ? 'out of script' : r, calls: [] }; };
    try {
      const st = agentMod.newState(d, 'ollama');
      const reply = await loop.runLoop(st, 'make two() return 2', { chat, say: () => {}, ask: async () => true, limits });
      const said = st.messages.filter((m) => m.role !== 'system' && m.role !== 'assistant').map((m) => String(m.content || ''));
      return { d, st, reply, calls, said, file: (rel) => fs.readFileSync(path.join(d, rel), 'utf8') };
    } finally { if (before == null) delete process.env[FLAG]; else process.env[FLAG] = before; }
  };
  const SUM = 'export const two = () => 1;' + NL;
  const CHECK = "import { two } from './sum.mjs';" + NL + "if (two() !== 2) { console.error('two() returned ' + two()); process.exit(1); }" + NL + "console.log('ok');" + NL;
  const PROJECT = { 'sum.mjs': SUM, 'check.mjs': CHECK };
  const fix = blk({ tool: 'edit_file', path: 'sum.mjs', old_string: '=> 1', new_string: '=> 2' });
  const wrong = blk({ tool: 'edit_file', path: 'sum.mjs', old_string: '=> 1', new_string: '=> 3' });
  const missed = blk({ tool: 'edit_file', path: 'sum.mjs', old_string: '=> 7', new_string: '=> 2' });
  const own = blk({ tool: 'shell', command: 'node check.mjs' });
  const brief = (r) => JSON.stringify({ stop: r.st.stop, calls: r.calls, green: r.st.greenChecks, reply: String(r.reply).slice(0, 160) }).slice(0, 500);

  suite('finish on green expert', 'the flag is registered like every round-five flag', () => {
    const row = settings.rows().find((r) => r.id === 'flags.finishOnGreen');
    check('flags.finishOnGreen is off by default, described, and switched from the environment', core.DEFAULTS.flags.finishOnGreen === false && row && row.env === FLAG && /visible check/.test(row.about),
      { happened: JSON.stringify(row || null), why: 'Every behaviour change lands off, behind a key a study or the evolution loop can set per arm.', fix: 'DEFAULTS.flags in lib/core.mjs and DESCRIPTIONS in lib/settings.mjs.' });
  });

  await asyncSuite('finish on green expert', 'an edit that turns the visible check green ends the run there', async () => {
    const on = await run('1', PROJECT, [fix, own, 'Done: two() returns 2.']);
    const off = await run('0', PROJECT, [fix, own, 'Done: two() returns 2.']);
    check('with the flag on the run stops after the fixing round, as answered, naming the check', on.calls === 1 && on.st.stop && on.st.stop.reason === 'answered' && on.st.stop.detail === 'check passed after the edit' && /node check\.mjs/.test(on.reply) && on.st.greenChecks === 1 && /=> 2/.test(on.file('sum.mjs')),
      { happened: brief(on), why: 'A green visible check after a landed edit is the task finished; each further round re-sends the whole context.', fix: 'runLoop: after the round, gate.visibleCheck and runTool shell, stopWith answered on exit 0.' });
    check('with the flag off the same script runs every round it did before', off.calls === 3 && off.st.stop && off.st.stop.reason === 'answered' && off.st.greenChecks === undefined,
      { happened: brief(off), why: 'Off must be the loop as it was.', fix: 'Gate everything on flags.finishOnGreen.' });
  });

  await asyncSuite('finish on green expert', 'a failing check adds nothing and the run goes on', async () => {
    const on = await run('1', PROJECT, [wrong, blk({ tool: 'edit_file', path: 'sum.mjs', old_string: '=> 3', new_string: '=> 2' }), own, 'Done.']);
    const off = await run('0', PROJECT, [wrong, blk({ tool: 'edit_file', path: 'sum.mjs', old_string: '=> 3', new_string: '=> 2' }), own, 'Done.']);
    const leaked = on.said.some((s) => /two\(\) returned 3/.test(s));
    check('a red check is run but never enters the context; the next landed fix then ends the run', on.calls === 2 && on.st.greenChecks === 2 && !leaked && on.st.stop.detail === 'check passed after the edit' && JSON.stringify(on.said.slice(0, 2)) === JSON.stringify(off.said.slice(0, 2)),
      { happened: brief(on) + ' leaked=' + leaked, why: 'A failing check would add tokens to every later round, the opposite of the flag\'s point; the model carries on as it would have.', fix: 'Only exit 0 acts; nothing is pushed to messages on a failure.' });
  });

  await asyncSuite('finish on green expert', 'a round whose edit did not land runs no check', async () => {
    const on = await run('1', PROJECT, [missed, fix, own, 'Done.']);
    check('the missed edit is followed by no check; the landed fix is, and ends the run', on.calls === 2 && on.st.greenChecks === 1 && on.st.stop.detail === 'check passed after the edit',
      { happened: brief(on), why: 'Nothing changed, so the check would say what it said before at the cost of a run.', fix: 'Compare state.editedAt with its value at the start of the round.' });
  });

  await asyncSuite('finish on green expert', 'without a visible check, and with the flag off or unset, the loop is the loop it was', async () => {
    const script = [fix, 'Done.'];
    const on = await run('1', { 'sum.mjs': SUM }, script);
    const off = await run('0', { 'sum.mjs': SUM }, script);
    const unset = await run(null, PROJECT, [fix, own, 'Done: two() returns 2.']);
    const offFull = await run('0', PROJECT, [fix, own, 'Done: two() returns 2.']);
    check('no check the gate can name: the flag on changes nothing', on.calls === off.calls && JSON.stringify(on.said) === JSON.stringify(off.said) && JSON.stringify(on.st.stop) === JSON.stringify(off.st.stop) && on.st.greenChecks === undefined,
      { happened: brief(on) + ' vs ' + brief(off), why: 'CanItEdit hides its tests until the run ends; there the flag must be invisible.', fix: 'Run nothing when gate.visibleCheck returns null.' });
    check('unset and off give the same run', unset.calls === offFull.calls && JSON.stringify(unset.said) === JSON.stringify(offFull.said) && unset.st.greenChecks === undefined,
      { happened: brief(unset) + ' vs ' + brief(offFull), why: 'The baseline every archived result was measured on is the flag unset.', fix: 'Default false in DEFAULTS.flags.' });
  });

  // From the ultrareview of d366ac5 (2026-10-10): a red hidden check stood in
  // for the model's own, and the check's file name reached a shell unquoted.
  const same = (a, b) => a.calls === b.calls && JSON.stringify(a.said) === JSON.stringify(b.said) && JSON.stringify(a.st.stop) === JSON.stringify(b.st.stop);
  const nudged = (r) => r.said.some((s) => /ran no check after the last edit/.test(s));

  await asyncSuite('finish on green expert', 'a red check the model never saw does not count as its check', async () => {
    const npm = { ...PROJECT, 'package.json': JSON.stringify({ scripts: { test: 'node check.mjs' } }) };
    const on = await run('1', PROJECT, [wrong, 'Done.']);
    const off = await run('0', PROJECT, [wrong, 'Done.']);
    const onNpm = await run('1', npm, [wrong, 'Done.']);
    const offNpm = await run('0', npm, [wrong, 'Done.']);
    const autoRan = (r) => r.said.some((s) => /ran the project's check after your edits/.test(s));
    check('an answer with no check after a red hidden check is nudged, as it is with the flag off', on.st.greenChecks === 1 && nudged(on) && same(on, off),
      { happened: brief(on) + ' vs ' + brief(off), why: 'The hidden check set verifiedAt, so the loop took "Done." over a failing check without the nudge it gives with the flag off.', fix: 'runLoop: put state.verifiedAt back after a hidden check that did not pass.' });
    check('where the project has a test command the loop still runs it and the model reads the result', onNpm.st.greenChecks === 1 && autoRan(onNpm) && autoRan(offNpm) && onNpm.calls === offNpm.calls && onNpm.st.stop.reason === offNpm.st.stop.reason,
      { happened: brief(onNpm) + ' vs ' + brief(offNpm), why: 'The loop\'s own check after edits is the safety net the flag must leave alone.', fix: 'runLoop: put state.verifiedAt back after a hidden check that did not pass.' });
  });

  await asyncSuite('finish on green adversary', 'the hidden check neither erases nor fakes a check', async () => {
    const paired = await run('1', PROJECT, [wrong + NL + own, 'Done.']);
    const pairedOff = await run('0', PROJECT, [wrong + NL + own, 'Done.']);
    const again = blk({ tool: 'edit_file', path: 'sum.mjs', old_string: '=> 3', new_string: '=> 4' });
    const twice = await run('1', PROJECT, [wrong, again, 'Done.']);
    const twiceOff = await run('0', PROJECT, [wrong, again, 'Done.']);
    check('a check the model ran itself after its edit still counts after a red hidden check', paired.st.greenChecks === 1 && !nudged(paired) && same(paired, pairedOff),
      { happened: brief(paired) + ' vs ' + brief(pairedOff), why: 'Putting verifiedAt back must restore the model\'s own check, not clear it.', fix: 'Keep the value from before the hidden run, not zero.' });
    check('two red hidden checks in a row still leave the answer unchecked', twice.st.greenChecks === 2 && nudged(twice) && same(twice, twiceOff),
      { happened: brief(twice) + ' vs ' + brief(twiceOff), why: 'Each hidden run must put back what it found.', fix: 'Read state.verifiedAt just before each hidden run.' });
  });

  await asyncSuite('finish on green expert', 'a check named with dots and hyphens still runs', async () => {
    const on = await run('1', { 'sum.mjs': SUM, 'my-app.v2_check.mjs': CHECK }, [fix, 'Done.']);
    check('my-app.v2_check.mjs is run and its pass ends the run', on.calls === 1 && on.st.stop.detail === 'check passed after the edit' && /node my-app\.v2_check\.mjs/.test(on.reply),
      { happened: brief(on), why: 'The plain-name rule must keep every name the gate names on a real project.', fix: 'Allow word characters, dots and hyphens.' });
  });

  await asyncSuite('finish on green adversary', 'a file name the shell would read as commands is never run', async () => {
    const evil = process.platform === 'win32' ? 'a&mkdir PWNED&python x_check.py' : 'a$(mkdir${IFS}PWNED)\\x_check.py';
    const files = { 'sum.mjs': SUM, [evil]: 'print("ok")' + NL };
    const named = gate.visibleCheck(dir(files));
    const on = await run('1', files, [fix, 'Done.']);
    const off = await run('0', files, [fix, 'Done.']);
    const pwned = fs.existsSync(path.join(on.d, 'PWNED'));
    check('the gate names the file, and the loop runs nothing: no PWNED, the run is the flag-off run', named && named.name === evil && !pwned && on.st.greenChecks === undefined && same(on, off),
      { happened: `named=${named && named.name} pwned=${pwned} ` + brief(on), why: 'runTool hands the command to a shell, which would run what the name smuggles in.', fix: 'runLoop: run the found check only when its name is word characters, dots and hyphens.' });
    const opt = { 'sum.mjs': SUM, '-h_check.py': 'print("ok")' + NL };
    const optNamed = gate.visibleCheck(dir(opt));
    const optOn = await run('1', opt, [fix, 'Done.']);
    const optOff = await run('0', opt, [fix, 'Done.']);
    check('a name that starts with a hyphen is an option to the interpreter, not a check: nothing runs', optNamed && optNamed.name === '-h_check.py' && optOn.st.greenChecks === undefined && same(optOn, optOff),
      { happened: `named=${optNamed && optNamed.name} ` + brief(optOn), why: 'python -h_check.py prints its help and exits 0, a pass for code nothing checked.', fix: 'The name must not start with a hyphen.' });
  });
}
