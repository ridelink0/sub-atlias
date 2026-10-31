// Gev, 2026-10-16: Atlias's rules must not cost the model more calls. flags.noWorkingRules (the
// brief carries no working rules) and flags.quietDoneClaim (the stop gate never holds a done reply
// for the want of a check; it runs a check it can name instead). Both are off by default and the
// flag-off golden suite keeps the old bytes. Synthetic fixtures only. (flags.lazyBrief, a least-work
// rule set and Atlias's take on Ponytail, was removed at Gev's word the same day.)
import * as brief from '../lib/brief.mjs';
import * as integrity from '../lib/integrity.mjs';

export default async function lazyBriefSuites({ suite, check, core, gate, router, track, TMP, fs, path }) {
  let n = 0;
  const project = (name, files) => {
    const dir = path.join(TMP, 'lazy-brief', `${name}-${process.pid}-${++n}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), text);
    return dir;
  };
  const withFlags = (flags, verify = {}) => ({ ...core.config(), flags: { ...core.config().flags, ...flags }, verify: { ...core.config().verify, ...verify } });
  const say = (dir, flags, verify) => brief.build({ cwd: dir, source: 'startup', session_id: `lazy-${process.pid}-${++n}` }, 'claude', withFlags(flags, verify));

  suite('no working rules expert', 'the brief can carry no working rules at all', () => {
    const checked = project('norules', { 'main.py': 'def f():\n    return 1\n', 'check.py': 'from main import f\nassert f() == 1\n' });
    const arm = { gateRunsCheck: true, quietDoneClaim: true };
    for (const [label, extra] of [['full brief', {}], ['hooks-only brief', { hooksOnly: true }]]) {
      const none = say(checked, { ...extra, ...arm, noWorkingRules: true }, { doublePass: false });
      const ruled = say(checked, { ...extra, ...arm }, { doublePass: false });
      check(`${label}: no working rules section and no rule text`, !none.includes('## Working rules') && !/Do the least|Done means verified|atlias runs/.test(none) && !none.includes(brief.RULES[1]),
      { happened: none, why: 'Gev: Atlias rules must not make the model spend more tokens; a least-work rule set cost the 9B quality (sprint-lean-s1).', fix: 'Return before the working rules when flags.noWorkingRules is on.' });
      check(`${label}: the brief still says it is Atlias, and only the rules go`, /^\[atlias /.test(none) && none.length < ruled.length && ruled.startsWith(none),
      { happened: `${none.length} against ${ruled.length} characters`, why: 'Only the rules go; the rest of the brief stays as it was.', fix: 'Leave every other brief section alone.' });
    }
    const off = say(checked, arm, { doublePass: false });
    check('off by default, and off the rules are as before', core.config().flags.noWorkingRules === false && off.includes('## Working rules') && off.includes(brief.RULES[1]),
    { happened: off, why: 'New behaviour is a default-off switch, so stored runs stay comparable.', fix: 'Default flags.noWorkingRules to false in lib/core.mjs.' });
  });

  suite('quiet done claim expert', 'the gate never holds a done reply for the want of a check', () => {
    const edited = [{ t: 1, kind: 'prompt' }, { t: 2, kind: 'edit', file: 'main.py' }];
    const done = 'Done, the function is fixed.';
    const held = integrity.check({ cwd: TMP, turn: edited, last: done, files: ['main.py'], cfg: { stubs: false, weakenedTests: false, unwired: false } });
    const quiet = integrity.check({ cwd: TMP, turn: edited, last: done, files: ['main.py'], cfg: { stubs: false, weakenedTests: false, unwired: false, doneClaim: false } });
    check('with doneClaim false the done claim is not raised; by default it is', held.some((f) => f.flag === 'doneclaim') && !quiet.some((f) => f.flag === 'doneclaim'),
    { happened: JSON.stringify({ held: held.map((f) => f.flag), quiet: quiet.map((f) => f.flag) }), why: 'Held for a check it could not run, a 9B wrote its own test and spent six calls (sprint smoke).', fix: 'integrity.check skips doneclaim when cfg.doneClaim is false.' });
    const claim = integrity.check({ cwd: TMP, turn: edited, last: 'All tests pass.', files: ['main.py'], cfg: { stubs: false, weakenedTests: false, unwired: false, doneClaim: false } });
    check('a claim that tests pass, with none run, is still raised when quiet', claim.some((f) => f.flag === 'passclaim'),
    { happened: JSON.stringify(claim.map((f) => f.flag)), why: 'A pass that never ran is a false statement; quiet only stops asking for extra work.', fix: 'Leave passclaim alone.' });
    const v = { integrity: true, doublePass: false };
    check('quiet makes the gate want its check after any unchecked code edit, whatever the reply says', gate.needsCheck({ turn: edited, last: 'Changed main.py.', files: ['main.py'], flags: {}, v, quiet: true })
      && !gate.needsCheck({ turn: edited, last: 'Changed main.py.', files: ['main.py'], flags: {}, v }),
    { happened: 'needsCheck answer', why: 'A brief that tells the model atlias runs the check after it finishes must hold for every reply.', fix: 'needsCheck returns true for quiet with an unchecked code edit.' });
    check('quiet wants no check once one ran after the edit, or when the gate already checked', !gate.needsCheck({ turn: [...edited, { t: 3, kind: 'shell', command: 'python check.py', verify: true, outcome: 'pass' }], last: 'Changed.', files: ['main.py'], flags: {}, v, quiet: true })
      && !gate.needsCheck({ turn: edited, last: 'Changed.', files: ['main.py'], flags: { gatecheck: true }, v, quiet: true }),
    { happened: 'needsCheck answer', why: 'A second run of a check that already ran costs time and proves nothing new.', fix: 'Keep the gatecheck and after-edit guards ahead of the quiet branch.' });

    const FLAGS = ['ATLIAS_FLAG_QUIET_DONE_CLAIM', 'ATLIAS_FLAG_GATE_RUNS_CHECK'];
    // The arm this is for runs with verify.doublePass off, so the second-pass request is not in play.
    const configFile = path.join(core.STATE_DIR, 'config.json');
    const run = (env, files, last) => {
      const before = FLAGS.map((k) => process.env[k]);
      const priorConfig = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null;
      for (const k of FLAGS) delete process.env[k];
      Object.assign(process.env, env);
      fs.mkdirSync(core.STATE_DIR, { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify({ ...(priorConfig ? JSON.parse(priorConfig) : {}), verify: { doublePass: false } }));
      try {
        const dir = project('stop', files);
        const s = `lazy-stop-${process.pid}-${++n}`;
        router.prompt({ session_id: s, cwd: dir, prompt: 'change main.py please' });
        track.postTool({ session_id: s, cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'main.py'), old_string: 'a', new_string: 'b' } });
        const out = gate.stop({ session_id: s, cwd: dir, last_assistant_message: last }, 'claude');
        return { out, ran: core.events(s).some((e) => e.kind === 'shell' && e.from === 'gate') };
      } finally {
        FLAGS.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i]; });
        if (priorConfig === null) fs.rmSync(configFile, { force: true }); else fs.writeFileSync(configFile, priorConfig);
      }
    };
    const noCheck = { 'main.py': 'def f():\n    return 1\n' };
    const off = run({}, noCheck, done);
    const on = run({ ATLIAS_FLAG_QUIET_DONE_CLAIM: '1', ATLIAS_FLAG_GATE_RUNS_CHECK: '1' }, noCheck, done);
    check('at the stop hook, a project with no check: held by default, let through when quiet', off.out && /nothing was run to check it/.test(JSON.stringify(off.out)) && !on.out,
    { happened: JSON.stringify({ off: Boolean(off.out), on: on.out }), why: 'The hold asked the model to write and run a check of its own, the calls base never spends.', fix: 'gate.stop passes doneClaim false to integrity.check under flags.quietDoneClaim.' });
    const failing = { 'main.py': 'def f():\n    return 2\n', 'check.py': 'from main import f\nassert f() == 1, "f() should be 1"\n' };
    const caught = run({ ATLIAS_FLAG_QUIET_DONE_CLAIM: '1', ATLIAS_FLAG_GATE_RUNS_CHECK: '1' }, failing, 'Changed main.py.');
    check('quiet still runs a check it can name, after a reply with no done words, and holds when it fails', caught.ran && caught.out && /check failed/.test(JSON.stringify(caught.out)),
    { happened: JSON.stringify({ ran: caught.ran, out: caught.out && JSON.stringify(caught.out).slice(0, 300) }), why: 'Quiet trades the model\'s extra calls for the gate\'s own run of the check; dropping both would be verification removed.', fix: 'needsCheck gets quiet from gate.stop.' });
    const passing = { 'main.py': 'def f():\n    return 1\n', 'check.py': 'from main import f\nassert f() == 1\n' };
    const clean = run({ ATLIAS_FLAG_QUIET_DONE_CLAIM: '1', ATLIAS_FLAG_GATE_RUNS_CHECK: '1' }, passing, 'Changed main.py.');
    check('quiet with a passing check lets the reply through after running it', clean.ran && !clean.out,
    { happened: JSON.stringify(clean), why: 'A passing check is the evidence; nothing is left to ask for.', fix: 'Return null when the gate\'s run passed and nothing else was raised.' });
  });
}
