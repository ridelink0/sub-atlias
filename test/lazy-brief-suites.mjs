// Gev, 2026-10-16: Atlias's rules must not cost the model more calls. flags.lazyBrief (a short
// least-work rule set, Atlias's own take on Ponytail) and flags.quietDoneClaim (the stop gate never
// holds a done reply for the want of a check; it runs a check it can name instead). Both are off by
// default and the flag-off golden suite keeps the old bytes. Synthetic fixtures only.
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
  const rules = (text) => text.slice(text.indexOf('## Working rules'));
  const py = process.platform === 'win32' ? 'python' : 'python3';

  suite('lazy brief expert', 'the lazy brief asks for less work and names no check to write', () => {
    const bare = project('bare', { 'main.py': 'def f():\n    return 1\n' });
    const checked = project('checked', { 'main.py': 'def f():\n    return 1\n', 'check.py': 'from main import f\nassert f() == 1\n' });
    for (const [label, extra] of [['full brief', {}], ['hooks-only brief', { hooksOnly: true }]]) {
      const lazy = rules(say(bare, { ...extra, lazyBrief: true }, { doublePass: false }));
      const old = rules(say(bare, { ...extra }, { doublePass: false }));
      check(`${label}: lazy rules replace the old ones and ask for the least work`, /Do the least that fully meets the request/.test(lazy) && /no new files, tests/.test(lazy)
        && !lazy.includes(brief.RULES[1]) && !/re-sends the whole context/.test(lazy),
      { happened: lazy, why: 'The lazy set replaces the rules; adding it on top would cost bytes on every call.', fix: 'Use lazyRules() in place of the rules list in lib/brief.mjs.' });
      check(`${label}: lazy rules ask for no check to write, no re-read and no pass line`, !/smallest real check|re-read each changed file|Pass 1|run it after your last edit/.test(lazy),
      { happened: lazy, why: 'Asked for a check in a project with none, a 9B wrote its own (sprint smoke: base 3 calls, Atlias 9).', fix: 'lazyRules() names a check only when the gate will run it.' });
      check(`${label}: lazy rules are shorter than the rules they replace`, lazy.length < old.length,
      { happened: `${lazy.length} against ${old.length} characters`, why: 'Gev: Atlias rules must not make the model spend more tokens.', fix: 'Keep the lazy set shorter than the old rules.' });
      check(`${label}: off, the rules are the old ones`, old.includes(brief.RULES[1]) && !/Do the least/.test(old),
      { happened: old, why: 'The flag is off by default.', fix: 'Branch on flags.lazyBrief only.' });
    }
    const named = rules(say(checked, { lazyBrief: true, gateRunsCheck: true, quietDoneClaim: true }, { doublePass: false }));
    const notQuiet = rules(say(checked, { lazyBrief: true, gateRunsCheck: true }, { doublePass: false }));
    check('the check is named only when the gate will run it after every unchecked edit', named.includes(`atlias runs \`${py} check.py\``) && !/atlias runs/.test(notQuiet),
    { happened: JSON.stringify({ named, notQuiet }), why: 'Without quietDoneClaim the gate runs the check only for some replies, so "atlias runs it after you finish" would be untrue.', fix: 'Pass the check to lazyRules() only with flags.quietDoneClaim.' });
    check('lazyRules is exactly the three least-work rules without a check, four with one', brief.lazyRules().length === 3 && brief.lazyRules({ check: 'x' }).length === 4,
    { happened: JSON.stringify(brief.lazyRules()), why: 'A rule set that grows by accident costs every call.', fix: 'Keep lazyRules() to its rules.' });
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
    { happened: 'needsCheck answer', why: 'The lazy brief tells the model atlias runs the check after it finishes; that must hold for every reply.', fix: 'needsCheck returns true for quiet with an unchecked code edit.' });
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
