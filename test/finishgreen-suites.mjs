// flags.finishOnGreen: once an edit lands and the project's own visible check
// then passes, the run stops there as answered. On the 60-task screen of the
// local evolution (2026-10-10) 5 of 44 solved runs ended rounds-exhausted at
// about 33k prompt tokens each, and every round after the fix re-sent the whole
// context. Every case drives runLoop with a scripted model and checks the same
// script with the flag off, which must be the loop as it was. Loaded by
// test/run.mjs.
import * as loop from '../lib/loop.mjs';
import * as settings from '../lib/settings.mjs';

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
      return { st, reply, calls, said, file: (rel) => fs.readFileSync(path.join(d, rel), 'utf8') };
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
}
