// Round five, row 4: the gate runs the project's check (flags.gateRunsCheck).
// When the gate would hold a reply because no check ran after the last edit,
// and the project shows a check it can name, it runs that check itself under
// the watchdog, records it, and holds the reply only if it fails. Each case
// here is a fixture project in the temp tree: a HumanEvalFix-shaped one with
// check.py, a CanItEdit-shaped one with canitedit_check.py (written by the
// converter's own runner), one whose check never returns, and one with no
// check at all. Off, the gate must answer exactly as it did before the flag.
import { spawnSync } from 'node:child_process';
import { pythonRunner } from '../lib/editbench.mjs';

const NL = String.fromCharCode(10);

export default async function ({ suite, check, skip, core, gate, router, track, TMP, fs, path }) {
  const FLAG = 'ATLIAS_FLAG_GATE_RUNS_CHECK';
  const withFlag = (value, fn) => {
    const before = process.env[FLAG];
    if (value == null) delete process.env[FLAG]; else process.env[FLAG] = value;
    try { return fn(); } finally { if (before == null) delete process.env[FLAG]; else process.env[FLAG] = before; }
  };
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const pyOk = (() => { try { return spawnSync(py, ['--version'], { encoding: 'utf8', timeout: 15000 }).status === 0; } catch { return false; } })();
  let n = 0;
  // One fixture project: its files, a fresh session with one prompt, and one
  // edit to main.py recorded the way PostToolUse records it.
  const project = (name, files) => {
    const dir = path.join(TMP, 'gatecheck', `${name}-${++n}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), text);
    return dir;
  };
  const turn = (dir, label) => {
    const s = `gatecheck-${label}-${++n}`;
    router.prompt({ session_id: s, cwd: dir, prompt: 'fix the function in main.py please' });
    track.postTool({ session_id: s, cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'main.py'), old_string: 'a', new_string: 'b' } });
    return s;
  };
  const stop = (dir, s, last, deps) => gate.stop({ session_id: s, cwd: dir, last_assistant_message: last }, 'claude', deps);
  const gateEvents = (s) => core.events(s).filter((e) => e.kind === 'shell' && e.from === 'gate');
  // The check writes a marker when it runs, so a test can tell it ran at all.
  const marker = (dir) => fs.existsSync(path.join(dir, 'ran.txt'));
  const MARK = 'import pathlib; pathlib.Path(__file__).with_name("ran.txt").write_text("ran")';
  const PASS_LINE = 'Fixed. Pass 1: left to atlias. Pass 2: re-read main.py for empty input and off-by-one, nothing found.';
  const DONE = 'Done, the function is fixed.';

  const heFix = (good) => project('humanevalfix', {
    'main.py': good ? 'def add(a, b):\n    return a + b\n' : 'def add(a, b):\n    return a - b\n',
    'tests.py': 'assert add(2, 3) == 5, "add(2, 3) should be 5"\n',
    'check.py': `${MARK}\n${pythonRunner('main.py', 'tests.py')}`,
  });

  suite('gate check expert', 'the gate finds the check a project shows', () => {
    check('the timeout is the 10 seconds the plan sets', gate.GATE_CHECK_MS === 10000, { happened: String(gate.GATE_CHECK_MS), why: 'The Stop hook has 30 seconds before Claude Code cancels it, and git, the syntax check and the diff share them; NEXTGEN-5 row 4 bounds the check at 10.', fix: 'GATE_CHECK_MS in lib/gate.mjs.' });
    const he = project('find-he', { 'solution.py': '', 'tests.py': 'assert True\n', 'check.py': 'print(1)\n' });
    const f1 = gate.visibleCheck(he);
    check('HumanEvalFix: check.py is the check, not tests.py beside it', f1 && f1.name === 'check.py' && f1.command === `${process.platform === 'win32' ? 'python' : 'python3'} check.py` && !f1.shell, { happened: JSON.stringify(f1), why: 'tests.py holds only the asserts; check.py is what runs them against the program.', fix: 'A script whose name says check ranks first in visibleCheck.' });
    const cie = project('find-cie', { 'main.py': '', 'canitedit_tests.py': 'def test_x():\n    assert True\n', 'canitedit_check.py': pythonRunner('main.py', 'canitedit_tests.py') });
    const f2 = gate.visibleCheck(cie);
    check('CanItEdit: canitedit_check.py is the check', f2 && f2.name === 'canitedit_check.py', { happened: JSON.stringify(f2), why: 'That is the file the converter writes and the eval scores with.', fix: 'Check visibleCheck against looksLikeVerification.' });
    const pytestOnly = project('find-pytest', { 'main.py': '', 'test_main.py': 'from main import f\n\ndef test_f():\n    assert f() == 1\n' });
    check('a pytest-shaped test_*.py alone is no check the gate can run', gate.visibleCheck(pytestOnly) === null, { happened: JSON.stringify(gate.visibleCheck(pytestOnly)), why: 'python test_main.py defines the tests and runs none, so it passes whatever the code does: a pass the gate would wave through.', fix: 'A test_*.py counts only when it runs itself (__main__, unittest.main, a top-level assert).' });
    const two = project('find-two', { 'test_a.py': 'assert 1\n', 'test_b.py': 'assert 1\n' });
    check('two checks of the same rank are no check the gate can name', gate.visibleCheck(two) === null, { happened: JSON.stringify(gate.visibleCheck(two)), why: 'Running one of two and calling the project checked is the claim the gate exists to stop.', fix: 'Return null when the best rank has more than one candidate.' });
    const npm = project('find-npm', { 'package.json': '﻿{"scripts":{"test":"node t.js"}}', 'index.js': '' });
    const f3 = gate.visibleCheck(npm);
    check('the package.json test script is a check, run through the shell npm needs on Windows', f3 && f3.command === 'npm test' && f3.shell === true, { happened: JSON.stringify(f3), why: 'npm is npm.cmd on Windows, which Node starts only through a shell; a BOM from a Windows editor must not hide the script.', fix: 'visibleCheck reads scripts.test and marks it shell.' });
    const npmNone = project('find-npm-none', { 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' });
    check('npm init\'s placeholder test script is no check', gate.visibleCheck(npmNone) === null, { happened: JSON.stringify(gate.visibleCheck(npmNone)), why: 'It fails on every project, so the gate would hold every reply over nothing.', fix: 'Skip a test script that says no test specified.' });
    const sh = project('find-sh', { 'run_tests.sh': 'exit 0\n' });
    const onLinux = gate.visibleCheck(sh, { platform: 'linux' });
    check('run_tests.sh runs under sh, and is no check on Windows where there is no sh to find', onLinux && onLinux.command === 'sh run_tests.sh' && gate.visibleCheck(sh, { platform: 'win32' }) === null, { happened: JSON.stringify({ onLinux, win: gate.visibleCheck(sh, { platform: 'win32' }) }), why: 'A check that cannot start is not a check; on Windows it would read as a failure to start every time.', fix: 'scriptRunner returns null for .sh on win32.' });
    const ps = project('find-ps', { 'check.ps1': 'exit 0\n', 'check.py': 'print(1)\n' });
    const psWin = gate.visibleCheck(project('find-ps1', { 'check.ps1': 'exit 0\n' }), { platform: 'win32' });
    check('on Windows check.ps1 runs under PowerShell with -File, and python is looked for as python then py', psWin && psWin.command === 'powershell -File check.ps1' && psWin.args.join(' ') === '-NoProfile -ExecutionPolicy Bypass -File check.ps1' && JSON.stringify(gate.visibleCheck(he, { platform: 'win32' }).programs) === '["python","py"]' && gate.visibleCheck(ps, { platform: 'linux' }).name === 'check.py', { happened: JSON.stringify({ psWin, he: gate.visibleCheck(he, { platform: 'win32' }) }), why: 'Windows has no python3, and a .ps1 is refused by the default execution policy unless it is bypassed for this run.', fix: 'scriptRunner in lib/gate.mjs.' });
    check('a project with no check shows none', gate.visibleCheck(project('find-none', { 'main.py': '', 'checkout.py': '' })) === null && gate.visibleCheck(path.join(TMP, 'gatecheck', 'not-there')) === null, { happened: 'a check was named', why: 'checkout.py is not a check; the classifier already says so, and a missing folder is no project.', fix: 'Only what looksLikeVerification accepts.' });
    // Files the rest of the classifier's words would name (eslint, jest,
    // "node .*test"), an application module named for what it verifies, and a
    // helper module of a test suite: each exits 0 when run and proves nothing.
    const notChecks = { 'eslint.config.js': 'module.exports = [];\n', 'jest.config.js': 'module.exports = {};\n', 'latest.js': 'console.log("latest");\n', 'verify_email.py': 'def send(to):\n    return to\n', 'test-utils.mjs': 'export const helper = () => 1;\n' };
    const named = Object.entries(notChecks).map(([f, text]) => [f, gate.visibleCheck(project('find-not', { 'main.py': '', [f]: text }))]).filter(([, r]) => r);
    const real = [['test.mjs', "import test from 'node:test';\n"], ['verify_all.py', 'if __name__ == "__main__":\n    pass\n'], ['run_checks.sh', 'exit 0\n']].filter(([f, text]) => !gate.visibleCheck(project('find-real', { [f]: text }), { platform: 'linux' }));
    check('a config file, an application module or a test helper is no check, and a test file that runs itself still is', named.length === 0 && real.length === 0 && core.looksLikeCheckScript('python check.py') && !core.looksLikeCheckScript('node eslint.config.js') && core.looksLikeVerification('node eslint.config.js'), { happened: JSON.stringify({ named: named.map(([f, r]) => `${f} -> ${r.command}`), missed: real.map(([f]) => f) }), why: 'node eslint.config.js or python verify_email.py exits 0 whatever the change did; the gate would call that a passing check and let a done reply through that it holds today, after running a script nobody asked it to run.', fix: 'visibleCheck names by looksLikeCheckScript, runs unread only a name ending in check or verify, and reads any other test file for a sign it runs by itself.' });
    const cfgOnly = project('find-cfg', { 'main.py': 'x = 1\n', 'eslint.config.js': 'module.exports = [];\n' });
    const cfgOff = withFlag(null, () => stop(cfgOnly, turn(cfgOnly, 'cfg-off'), DONE));
    const cfgOn = withFlag('1', () => stop(cfgOnly, turn(cfgOnly, 'cfg-on'), DONE));
    check('a project whose only candidate is eslint.config.js is held as it is with the flag off', cfgOff && cfgOn && JSON.stringify(cfgOn) === JSON.stringify(cfgOff), { happened: JSON.stringify({ off: cfgOff && cfgOff.reason.slice(0, 160), on: cfgOn && cfgOn.reason.slice(0, 160) }), why: 'A config file that loads and exits is not a passing check; waving the reply through on it is the false pass the flag must never add.', fix: 'visibleCheck must return null there.' });
  });

  suite('gate check expert', 'when the gate wants a check, and how it runs one', () => {
    const edit = [{ kind: 'edit', files: ['main.py'] }];
    const checked = [...edit, { kind: 'shell', command: 'python check.py', verify: true, outcome: 'pass' }];
    const v = { integrity: true, doublePass: true };
    const want = (turn, last, flags = {}, vv = v) => gate.needsCheck({ turn, last, files: ['main.py'], flags, v: vv });
    check('an unknown result wants a check for a pass claim, but a known pass does not', want([...edit, { ...checked[1], outcome: 'unknown' }], 'All tests pass.') && !want(checked, 'All tests pass.'), { happened: 'unknown suppressed verification or pass repeated it', why: 'Unknown evidence must not bypass the single deterministic gate check.', fix: 'Require explicit pass evidence for a passing-test claim.' });
    check('an earlier pass cannot suppress checking a later edit', want([checked[1], ...edit], 'All tests pass.'), { happened: 'stale result reused', why: 'A passing result belongs to the code that was actually checked.', fix: 'Require passingVerification after the latest edit.' });
    check('a pass claim with only UNKNOWN verification and no edits still requests evidence', gate.needsCheck({ turn: [{ ...checked[1], outcome: 'unknown' }], last: 'All tests pass.', files: [], flags: {}, v: { integrity: true, doublePass: false } }), { happened: 'unknown command suppressed the claim-only path', why: 'A run-tests request may change no files; neither the edit branch nor double-pass branch can supply the missing evidence.', fix: 'Use passingVerification on the pass-claim path independently of edits.' });
    check('a done claim, a pass line or a missing second pass with no check after the edit want one', want(edit, 'Done.') && want(edit, 'Pass 1: left to atlias. Pass 2: nothing found.') && want(edit, 'Here is the change.'), { happened: JSON.stringify([want(edit, 'Done.'), want(edit, 'Pass 1: x. Pass 2: y.'), want(edit, 'Here is the change.')]), why: 'Those are the replies the gate holds today for the want of a check, and the one the brief tells the model atlias will check.', fix: 'Check needsCheck in lib/gate.mjs.' });
    // flags.passLineNeedsCheck (c10 F2): the pass line counts only with a check after the last edit.
    const pe = [{ kind: 'edit', files: ['main.py'] }];
    const pc = [...pe, { kind: 'shell', verify: true, command: 'python check.py', outcome: 'pass' }];
    const PL = 'Done. Pass 1: ran it. Pass 2: re-read it.';
    const pl = (turn, last, ran, on) => gate.passLineWithoutCheck({ turn, last, code: ['main.py'], ran, on });
    check('with passLineNeedsCheck, a pass line with no check after the last edit is held', pl(pe, PL, null, true), { happened: 'not held', why: 'In trial-02 a reply named both passes with no check after the last edit and ended.', fix: 'Check passLineWithoutCheck in lib/gate.mjs.' });
    check('a check after the edit, a check the gate ran, an honest reply, or the flag off lets the pass line through', !pl(pc, PL, null, true) && !pl(pe, PL, { outcome: 'pass' }, true) && !pl(pe, 'Pass 1: read it. Pass 2: re-read it. It is untested: no check exists here.', null, true) && !pl(pe, PL, null, false), { happened: 'held', why: 'Each is evidence or plain honesty, and the flag-off path must stay as trials 02 to 08 ran it.', fix: 'Check passLineWithoutCheck in lib/gate.mjs.' });
    check('a check after the edit, a reply that says it is untested, or the flag spent for this prompt want none', !want(checked, 'Done. Pass 1: ok. Pass 2: ok.') && !want(edit, 'Done, but untested.', {}, { integrity: true, doublePass: false }) && !want(edit, 'Done.', { gatecheck: true }) && !gate.needsCheck({ turn: [], last: 'Here you go.', files: [], flags: {}, v }), { happened: 'needsCheck said yes', why: 'Each of these is a stop the gate lets through today; running a check there would spend up to 10 seconds for nothing, or twice for one prompt.', fix: 'Check needsCheck in lib/gate.mjs.' });
    const js = project('run-js', { 'ok.mjs': 'console.log("fine")\n', 'bad.mjs': 'console.error("expected 3, got 4"); process.exit(1)\n' });
    const node = (name) => ({ programs: ['atlias-no-such-program', process.execPath], args: [name], shell: false });
    const ok = gate.runVisibleCheck(node('ok.mjs'), js);
    const bad = gate.runVisibleCheck(node('bad.mjs'), js);
    check('runVisibleCheck: a program that is not there sends it to the next name, and the exit decides', ok.outcome === 'pass' && /fine/.test(ok.output) && bad.outcome === 'fail' && bad.status === 1 && /expected 3, got 4/.test(bad.output), { happened: JSON.stringify({ ok, bad }), why: 'python3 is missing on Windows and python on some Linux; the gate tries the next name before it calls the check unrunnable, and reads the result the way the hooks read a check the model ran.', fix: 'Check runVisibleCheck in lib/gate.mjs.' });
    const noPm = gate.runVisibleCheck({ command: 'atlias-no-such-pm test', programs: ['atlias-no-such-pm test'], args: [], shell: true }, js);
    const winEnv = { PATH: 'C:\\tools;C:\\node', PATHEXT: '.EXE;.CMD' };
    const winFiles = (p) => p === 'C:\\node\\npm.CMD' || p === 'C:\\tools\\python.EXE';
    const lin = { platform: 'linux', env: { PATH: '/usr/bin:/opt/x/bin' }, isFile: (p) => p === '/opt/x/bin/pnpm' };
    check('onPath finds a program the way the shell will, npm.cmd through PATHEXT on Windows, and not a missing one', gate.onPath('npm', { platform: 'win32', env: winEnv, isFile: winFiles }) && gate.onPath('python', { platform: 'win32', env: winEnv, isFile: winFiles }) && !gate.onPath('atlias-no-such-pm', { platform: 'win32', env: winEnv, isFile: winFiles }) && gate.onPath('pnpm', lin) && !gate.onPath('yarn', lin) && gate.onPath('./run_tests.sh', lin), { happened: JSON.stringify({ npm: gate.onPath('npm', { platform: 'win32', env: winEnv, isFile: winFiles }), missing: gate.onPath('atlias-no-such-pm', { platform: 'win32', env: winEnv, isFile: winFiles }), pnpm: gate.onPath('pnpm', lin), yarn: gate.onPath('yarn', lin) }), why: 'On the Windows runners cmd.exe reported the missing program with exit 1 and an English sentence, not 9009, so a gate that reads the exit called the machine\'s missing tool a failing check.', fix: 'runVisibleCheck asks onPath before it runs a check through a shell.' });
    const asked = [];
    const viaLookup = gate.runVisibleCheck({ command: 'npm test', programs: ['npm test'], args: [], shell: true }, js, { onPathFn: (n) => { asked.push(n); return false; } });
    check('a shell check whose program the lookup cannot find is unfinished before anything runs, on every platform', viaLookup.outcome === 'unfinished' && /no npm on PATH/.test(viaLookup.why) && asked.join() === 'npm', { happened: JSON.stringify({ viaLookup, asked }), why: 'The lookup, not the shell\'s exit, is what makes a missing package manager read the same on Linux, macOS and Windows.', fix: 'runVisibleCheck calls onPathFn(program) first for found.shell.' });
    check('a test script whose package manager is not on PATH could not start; it did not fail', noPm.outcome === 'unfinished' && /no atlias-no-such-pm on PATH/.test(noPm.why), { happened: JSON.stringify(noPm), why: 'Through a shell a missing program is exit 127 (sh) or 9009 (cmd.exe); calling that a failing check holds the reply over the project\'s code for what is the machine\'s fault, and quotes "not found" as the failure.', fix: 'runVisibleCheck reads the shell\'s not-found exit as unfinished.' });
  });

  suite('gate check expert', 'the gate runs the check and holds only on a failure', () => {
    if (!pyOk) { skip('the gate runs check.py and canitedit_check.py', `no ${py} answers here`); return; }
    for (const good of [true, false]) {
      const dir = heFix(good);
      const checkFile = path.join(dir, 'check.py');
      fs.writeFileSync(checkFile, 'with open("count.txt", "a") as f: f.write("run\\n")\n' + fs.readFileSync(checkFile, 'utf8'));
      const s = turn(dir, 'unknown-' + good);
      track.postTool({ session_id: s, cwd: dir, tool_name: 'Bash', tool_input: { command: 'python check.py' }, tool_response: { stdout: 'Tests completed successfully ATLIAS_EXIT_nonce=0' } });
      const reply = 'All tests pass. Pass 1: checked. Pass 2: inspected edge cases.';
      const first = withFlag('1', () => stop(dir, s, reply));
      const second = withFlag('1', () => gate.stop({ session_id: s, cwd: dir, last_assistant_message: reply, stop_hook_active: true }, 'claude'));
      const events = gateEvents(s);
      const runs = fs.readFileSync(path.join(dir, 'count.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
      check('unknown native exit causes exactly one real gate check, explicit result ' + good, events.length === 1 && events[0].outcome === (good ? 'pass' : 'fail') && runs.length === 1 && runs[0] === 'run' && (good ? first === null : first?.decision === 'block' && /exit 1/.test(first.reason)) && second === null, { happened: JSON.stringify({ first, second, events, runs }), why: 'The gate must neither trust spoofed stdout nor repeat the check in a continuation.', fix: 'Run the recognized check once and record its actual exit result.' });
    }
    // Pass: the reply the brief asks for, no check run by the model.
    const good = heFix(true);
    const sGood = turn(good, 'pass');
    const passed = withFlag('1', () => stop(good, sGood, PASS_LINE));
    const evGood = gateEvents(sGood);
    check('a passing check lets the reply through, with no model round', passed === null && marker(good), { happened: JSON.stringify(passed), why: 'That is the round the flag exists to save: about 30k prompt tokens a round in the Claude Code study.', fix: 'gate.stop runs visibleCheck when needsCheck says so, and a pass adds no section.' });
    check('the check the gate ran is recorded as a check that passed', evGood.length === 1 && evGood[0].verify === true && evGood[0].outcome === 'pass' && /check\.py$/.test(evGood[0].command), { happened: JSON.stringify(evGood), why: 'The handoff note, the digest and a later stop read the log; a check that is not in it did not happen for them.', fix: 'recordEvent the run as a shell event with verify and outcome.' });
    const doneDir = heFix(true);
    const done = withFlag('1', () => stop(doneDir, turn(doneDir, 'done'), DONE));
    check('a done claim with no check is not held for want of a check once the gate ran it', done && !/nothing was run to check it/.test(done.reason) && /A check already ran after the last edit \(python3? check\.py\)/.test(done.reason) && /no tool call is needed/.test(done.reason), { happened: done && done.reason.slice(0, 400), why: 'The second pass is still owed, but not the check: asking for it again costs the round the gate just saved.', fix: 'The second-pass fix names the check the gate ran.' });
    // CanItEdit shape: the converter's own runner.
    const cie = project('canitedit', { 'main.py': 'def double(x):\n    return x * 2\n', 'canitedit_tests.py': 'assert double(4) == 8\n', 'canitedit_check.py': `${MARK}\n${pythonRunner('main.py', 'canitedit_tests.py')}` });
    const sCie = turn(cie, 'cie');
    const cieOut = withFlag('1', () => stop(cie, sCie, PASS_LINE));
    check('CanItEdit: canitedit_check.py is run and a pass lets the reply through', cieOut === null && marker(cie) && gateEvents(sCie).length === 1, { happened: JSON.stringify({ cieOut, ran: marker(cie), ev: gateEvents(sCie) }), why: 'CanItEdit is where atlias\'s check cost a round plain Claude Code did not spend.', fix: 'visibleCheck must name canitedit_check.py.' });
    // Fail: the output is quoted and the reply held once.
    const bad = heFix(false);
    const sBad = turn(bad, 'fail');
    const failed = withFlag('1', () => stop(bad, sBad, PASS_LINE));
    check('a failing check holds the reply and quotes the failure', failed && failed.decision === 'block' && /The project's check failed/.test(failed.reason) && /add\(2, 3\) should be 5/.test(failed.reason) && /AssertionError/.test(failed.reason) && /exit 1/.test(failed.reason), { happened: failed && failed.reason, why: 'The model needs the assertion to fix the code without spending a round re-running the check to see it.', fix: 'The failure section quotes the last lines of the check\'s output.' });
    check('the failing run is recorded as a failed check', gateEvents(sBad).length === 1 && gateEvents(sBad)[0].outcome === 'fail', { happened: JSON.stringify(gateEvents(sBad)), why: 'A later "tests pass" must be held against the run that said otherwise.', fix: 'Record the outcome from integrity.verdict.' });
    const sClaim = turn(bad, 'claim');
    const claim = withFlag('1', () => stop(bad, sClaim, 'Done. All tests pass. Pass 1: tests pass. Pass 2: nothing found.'));
    check('a pass claim over the failing check is one finding, not two', claim && (claim.reason.match(/The project's check failed/g) || []).length === 1 && !/the last one that ran failed/.test(claim.reason), { happened: claim && claim.reason.slice(0, 500), why: 'The gate speaks once per prompt; the same failure told twice is noise the model pays for.', fix: 'Pass the integrity check passclaim as spent when the gate\'s own run failed.' });
    const again = withFlag('1', () => gate.stop({ session_id: sBad, cwd: bad, last_assistant_message: PASS_LINE, stop_hook_active: true }, 'claude'));
    check('the continuation after the hold is not checked again', again === null && gateEvents(sBad).length === 1, { happened: JSON.stringify({ again, runs: gateEvents(sBad).length }), why: 'A Stop hook that blocks inside its own continuation loops for ever.', fix: 'Nothing runs when stop_hook_active is set.' });
  });

  suite('gate check expert', 'the check is stopped at its bound, and off changes nothing', () => {
    // Timeout: a check that never returns is ended, tree and all, at the bound,
    // and the reply is held as it was before the flag, with the reason named.
    const loop = project('loop', { 'main.py': 'x = 1\n', 'check.mjs': "import fs from 'node:fs'; fs.writeFileSync(new URL('./pid.txt', import.meta.url), String(process.pid)); setInterval(() => {}, 1000);\n" });
    const sLoop = turn(loop, 'loop');
    const t0 = Date.now();
    const held = withFlag('1', () => stop(loop, sLoop, DONE, { checkMs: 2000 }));
    const ms = Date.now() - t0;
    const pid = Number(fs.existsSync(path.join(loop, 'pid.txt')) ? fs.readFileSync(path.join(loop, 'pid.txt'), 'utf8') : 0);
    let alive = false;
    if (pid) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
    check('a check that never returns is stopped at the bound and its process is gone', pid > 0 && !alive && ms < 2000 + 8000, { happened: JSON.stringify({ pid, alive, ms }), why: 'A model-written loop that never returns would otherwise hold the Stop hook until Claude Code cancels it, and the hold with it.', fix: 'runVisibleCheck goes through proc.runSync, which ends the tree at timeoutMs.' });
    check('then the reply is held as before the flag, and the block says the check ran out of time', held && /nothing was run to check it/.test(held.reason) && /which atlias ran itself and which stopped at 2 s/.test(held.reason) && gateEvents(sLoop).length === 0, { happened: held && held.reason, why: 'An unfinished check is not a passed one, and the model should know it may be its own change that never returns.', fix: 'An unfinished run goes into the incomplete list and nothing is recorded.' });

    // A pass claim in a turn that edited nothing: today "no check ran this
    // turn"; with the flag the gate runs the check and holds only a failure.
    const claimOnly = (good) => {
      const dir = project(good ? 'claim-pass' : 'claim-fail', { 'check.mjs': good ? 'console.log("3 passed")\n' : 'console.error("1 failed: expected 3, got 4"); process.exit(1)\n' });
      const s = `gatecheck-claim-${++n}`;
      router.prompt({ session_id: s, cwd: dir, prompt: 'do the tests pass on this project' });
      return { out: withFlag('1', () => stop(dir, s, 'Yes, all tests pass.')), off: withFlag(null, () => stop(dir, `${s}-off`, 'Yes, all tests pass.')), s };
    };
    const cp = claimOnly(true);
    const cf = claimOnly(false);
    check('a pass claim with nothing edited: the gate runs the check, lets a pass through and holds a failure with its output', cp.off && /no check ran this turn/.test(cp.off.reason) && cp.out === null && gateEvents(cp.s).length === 1 && cf.out && /The project's check failed/.test(cf.out.reason) && /expected 3, got 4/.test(cf.out.reason) && !/no check ran this turn/.test(cf.out.reason), { happened: JSON.stringify({ off: cp.off && cp.off.reason.slice(0, 120), pass: cp.out, fail: cf.out && cf.out.reason.slice(0, 300) }), why: 'The claim is true or false by the check; running it answers the question the hold would have asked the model to answer with a round.', fix: 'The no-files branch of gate.stop adds the failure and drops the pass claim it answers.' });

    // No check the gate can name: today's answer, byte for byte.
    const bare = project('bare', { 'main.py': 'x = 1\n' });
    const off = withFlag(null, () => stop(bare, turn(bare, 'bare-off'), DONE));
    const on = withFlag('1', () => stop(bare, turn(bare, 'bare-on'), DONE));
    check('with no check to run, the flag on holds exactly as it does off', off && on && JSON.stringify(on) === JSON.stringify(off), { happened: JSON.stringify({ off: off && off.reason.slice(0, 200), on: on && on.reason.slice(0, 200) }), why: 'The flag may change only what it names; a project with nothing to run must see today\'s gate.', fix: 'visibleCheck returns null and nothing else in stop changes.' });

    // Off: byte-identical to before, and the check is never run.
    const proj = project('off', { 'main.py': 'x = 1\n', 'check.mjs': "import fs from 'node:fs'; fs.writeFileSync(new URL('./ran.txt', import.meta.url), 'ran');\n" });
    const sUnset = turn(proj, 'off-unset');
    const unset = withFlag(null, () => stop(proj, sUnset, DONE));
    const zero = withFlag('0', () => stop(proj, turn(proj, 'off-zero'), DONE));
    const noCheck = withFlag(null, () => stop(bare, turn(bare, 'bare-off2'), DONE));
    const strip = (r) => r && r.reason.split(proj).join('<P>').split(bare).join('<P>');
    check('off, the gate does not run the check and answers as it does for a project with none', unset && zero && JSON.stringify(unset) === JSON.stringify(zero) && strip(unset) === strip(noCheck) && !marker(proj) && gateEvents(sUnset).length === 0, { happened: JSON.stringify({ unset: strip(unset), noCheck: strip(noCheck), ran: marker(proj) }), why: 'Row 1\'s baseline is the control for every later arm only if a flag left off changes nothing.', fix: 'Nothing under flags.gateRunsCheck runs unless the flag is on.' });
  });
}
