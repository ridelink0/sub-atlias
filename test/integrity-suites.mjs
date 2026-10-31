// The integrity suites: every way a reply can claim work that did not happen,
// each with its own expert. Loaded by test/run.mjs, which owns suite() and
// check(); every failure says what happened, why it matters and how to fix it.
import * as integrity from '../lib/integrity.mjs';

export default async function integritySuites({ suite, check, core, gate, track, router, PROJECT, TMP, spawnSync, fs, path }) {
  const NL = String.fromCharCode(10);
  const sid = (n) => 'integrity-' + n;

  suite('claims expert', 'what a reply claims', () => {
    check('a finished-work reply is recognised as a claim', ['Done.', 'I implemented the export.', 'Fixed the parser.', 'It works now.'].every((t) => integrity.DONE_RE.test(t)), { happened: ['Done.', 'I implemented the export.', 'Fixed the parser.', 'It works now.'].filter((t) => !integrity.DONE_RE.test(t)).join(' | ') || 'all recognised', why: 'A claim the gate cannot see is a claim it cannot hold to evidence.', fix: 'Extend DONE_RE.' });
    check('a passing-tests reply is recognised as a claim', ['All tests pass.', 'The build succeeded.', 'Tests are green.', 'No test failures.'].every((t) => integrity.PASS_CLAIM_RE.test(t)), { happened: ['All tests pass.', 'The build succeeded.', 'Tests are green.', 'No test failures.'].filter((t) => !integrity.PASS_CLAIM_RE.test(t)).join(' | ') || 'all recognised', why: 'This is the claim users trust most and check least.', fix: 'Extend PASS_CLAIM_RE.' });
    check('an honest reply is not treated as a claim', integrity.HONEST_RE.test('I made the change but could not run the tests.') && integrity.HONEST_RE.test('This is untested.'), { happened: 'honest wording was not recognised', why: 'Saying plainly that something is unverified is the behaviour the gate wants, and punishing it teaches the opposite.', fix: 'Extend HONEST_RE.' });
  });

  suite('test result expert', 'reading what a check said', () => {
    const cases = [
      [{ tool_response: { stdout: 'Tests: 1 failed, 3 passed', stderr: '' } }, 'fail'],
      [{ tool_response: { stdout: 'all good', exit_code: 0 } }, 'pass'],
      [{ tool_response: { stdout: 'ok', exitCode: 2 } }, 'fail'],
      [{ tool_response: 'Traceback (most recent call last):' + NL + '  File "x.py"' }, 'fail'],
      [{ tool_response: { stdout: 'Tests: 0 failed, 12 passed' } }, 'unknown'],
      [{ tool_response: { stdout: 'running', interrupted: true } }, 'fail'],
      [{ tool_response: { content: [{ type: 'text', text: 'FAIL src/app.test.js' }] } }, 'fail'],
      [{}, 'unknown'],
      [null, 'unknown'],
    ];
    for (const [payload, want] of cases) {
      const got = integrity.verdict(payload).outcome;
      check('verdict ' + want + ' for ' + JSON.stringify(payload).slice(0, 60), got === want, { happened: 'got ' + got, why: 'Whether a claim of passing tests is true depends entirely on reading the last run correctly. "0 failed" must never read as a failure, and silence must never read as a pass.', fix: 'Check FAIL_RE and verdict() in lib/integrity.mjs.' });
    }
    check('a failure carries the line that says so', /1 failed/.test(integrity.verdict({ tool_response: { stdout: 'x' + NL + 'Tests: 1 failed, 3 passed' + NL + 'done' } }).excerpt || ''), { happened: JSON.stringify(integrity.verdict({ tool_response: { stdout: 'Tests: 1 failed' } })), why: 'The gate quotes it back, and a failure with no detail sends the model looking for it.', fix: 'Return the first failing line as the excerpt.' });
    const text = integrity.responseText({ tool_result: { stdout: 'a', stderr: 'b', exit_code: 3 } });
    check('the older tool_result field is read too', text.code === 3 && /a/.test(text.text) && /b/.test(text.text), { happened: JSON.stringify(text), why: 'Hosts name this field differently and the first one to change it would silently disable the check.', fix: 'Keep the fallbacks in responseText.' });
    const s = sid('track');
    track.postTool({ session_id: s, cwd: PROJECT, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'FAIL src/x.test.js', exit_code: 1 } });
    const ev = core.events(s).filter((e) => e.kind === 'shell').pop();
    check('a failed test run is recorded as failed', ev && ev.outcome === 'fail' && /FAIL/.test(ev.excerpt || ''), { happened: JSON.stringify(ev), why: 'The gate can only catch "tests pass" after a failing run if the failure was written down when it happened.', fix: 'track.postTool records verdict() for verification commands.' });
    track.postToolFailure({ session_id: s, cwd: PROJECT, tool_name: 'Bash', tool_input: { command: 'pytest' }, error: 'Command exited with code 1' });
    const ev2 = core.events(s).filter((e) => e.kind === 'shell').pop();
    check('a tool failure event on a check is recorded as a failed check', ev2 && ev2.outcome === 'fail' && ev2.verify === true, { happened: JSON.stringify(ev2), why: 'Some hosts report a non-zero exit as a failed tool call rather than a result.', fix: 'track.postToolFailure records the command with outcome fail.' });
  });

  suite('evidence expert', 'claims against evidence', () => {
    const edit = { kind: 'edit', files: ['a.mjs'] };
    const ran = { kind: 'shell', verify: true, command: 'npm test', outcome: 'pass' };
    check('a check after the last edit counts', integrity.verificationAfterLastEdit([edit, ran]), { happened: 'not counted', why: 'That is the order that proves the final code was checked.', fix: 'Check verificationAfterLastEdit.' });
    check('a check before the last edit does not', !integrity.verificationAfterLastEdit([ran, edit]), { happened: 'counted', why: 'An edit made after the last check is an edit nobody checked.', fix: 'Look only after the last edit.' });
    check('the atlias verify tool counts as a check', integrity.verificationAfterLastEdit([edit, { kind: 'tool', tool: 'mcp__plugin_atlias_atlias__harness_verify' }]), { happened: 'not counted', why: 'It is a real check, and ignoring it would punish using it.', fix: 'isVerifyEvent accepts harness_verify.' });
    const noRun = integrity.check({ cwd: PROJECT, turn: [edit], last: 'Done. All tests pass.', files: [], flags: {} });
    for (const output of ['Tests completed successfully', 'ATLIAS_EXIT_fresh_nonce=0', '', undefined]) {
      const unknown = { ...ran, ...integrity.verdict({ tool_response: { stdout: output } }) };
      const held = integrity.check({ cwd: PROJECT, turn: [edit, unknown], last: 'All tests pass.', files: [], flags: {} });
      check('a pass claim requires a known exit, including positive-looking output ' + String(output), held.some(f => f.flag === 'passclaim' && /result is unknown/.test(f.text)) && !integrity.verificationAfterLastEdit([edit, unknown]), { happened: JSON.stringify(held), why: 'Neither stdout, a nonce, nor command completion establishes a passing result.', fix: 'Unknown outcomes cannot satisfy verification or pass claims.' });
    }
    const latestUnknown = integrity.check({ cwd: PROJECT, turn: [ran, { ...ran, outcome: 'unknown' }], last: 'All tests pass.', files: [], flags: {} });
    for (const history of [[ran, edit], [ran, edit, { kind: 'tool', tool: 'harness_verify' }], [ran, { kind: 'tool', tool: 'harness_verify' }]]) {
      const stale = integrity.check({ cwd: PROJECT, turn: history, last: 'All tests pass.', files: [], flags: {} });
      check('stale or unknown tool verification cannot lend an earlier pass', stale.some(f => f.flag === 'passclaim') && !integrity.passingVerification(history), { happened: JSON.stringify(stale), why: 'A check of older bytes or an unreported tool outcome cannot establish a fresh positive result.', fix: 'Use the latest verification after the latest edit.' });
    }
    check('a later unknown result cannot borrow an earlier pass', latestUnknown.some(f => f.flag === 'passclaim'), { happened: JSON.stringify(latestUnknown), why: 'The latest run did not establish the claimed result.', fix: 'Check the latest verification outcome.' });
    check('claiming tests pass with no run is caught', noRun.some((f) => f.flag === 'passclaim' && /no check ran/.test(f.text)), { happened: JSON.stringify(noRun).slice(0, 200), why: 'A result that was never produced is a claim, not evidence.', fix: 'Check the anyRun branch in check().' });
    const failed = integrity.check({ cwd: PROJECT, turn: [edit, { kind: 'shell', verify: true, command: 'npm test', outcome: 'fail', excerpt: 'Tests: 2 failed' }], last: 'All tests pass now.', files: [], flags: {} });
    check('claiming tests pass after a failing run is caught, with the failure quoted', failed.some((f) => f.flag === 'passclaim' && /2 failed/.test(f.text)), { happened: JSON.stringify(failed).slice(0, 200), why: 'This is the most expensive wrong answer, because the user stops looking.', fix: 'Compare the claim with lastVerification().outcome.' });
    const done = integrity.check({ cwd: PROJECT, turn: [ran, edit], last: 'Done, the feature is implemented.', files: [path.join(PROJECT, 'a.mjs')], flags: {}, cfg: { stubs: false, weakenedTests: false, unwired: false } });
    check('saying done with nothing checked after the last edit is caught', done.some((f) => f.flag === 'doneclaim'), { happened: JSON.stringify(done).slice(0, 200), why: 'The false done is the complaint people make most about coding agents.', fix: 'Check the doneclaim branch.' });
    const honest = integrity.check({ cwd: PROJECT, turn: [edit], last: 'I changed it, but it is untested because the suite needs a database.', files: [path.join(PROJECT, 'a.mjs')], flags: {}, cfg: { stubs: false, weakenedTests: false, unwired: false } });
    check('an honest untested reply is left alone', honest.length === 0, { happened: JSON.stringify(honest).slice(0, 200), why: 'Punishing honesty teaches the model to stop being honest.', fix: 'HONEST_RE suppresses the claim checks.' });
    const flagged = integrity.check({ cwd: PROJECT, turn: [edit], last: 'Done.', files: [path.join(PROJECT, 'a.mjs')], flags: { doneclaim: true }, cfg: { stubs: false, weakenedTests: false, unwired: false } });
    // flags.checkFailDominates: a failed check stays failed until the same command passes again (c18 F6).
    const failedCheck = { kind: 'shell', verify: true, command: 'python check.py', outcome: 'fail', excerpt: 'AssertionError' };
    const printOnly = { kind: 'shell', verify: true, command: 'python -c "from main import f; print(f(2))"', outcome: 'pass' };
    const t06 = [edit, failedCheck, printOnly];
    check('with checkFailDominates off, a later different passing command still counts (stored runs reproduce)', integrity.verificationAfterLastEdit(t06, false) && integrity.lastVerification(t06, false) === printOnly, { happened: 'the flag-off reading changed', why: 'Trials 02 to 08 ran with this reading; changing it with the flag off would make their receipts unreproducible.', fix: 'Apply the failure rule only when dominates is true.' });
    check('with checkFailDominates, a print-only command after a failed check does not verify the edit', !integrity.verificationAfterLastEdit(t06, true) && integrity.lastVerification(t06, true) === failedCheck, { happened: JSON.stringify(integrity.lastVerification(t06, true)), why: 'In trial-02 this let a run whose check.py failed end as if verified.', fix: 'unresolvedFailure must keep a failed check until the same command passes.' });
    check('with checkFailDominates, the same check passing again clears the failure', integrity.verificationAfterLastEdit([...t06, { ...failedCheck, outcome: 'pass', command: ' python  check.py ' }], true), { happened: 'still held', why: 'A fixed check must be able to close the gate, or the gate becomes a loop.', fix: 'Compare commands with whitespace collapsed and accept a later non-failing run of the same one.' });
    check('unresolvedFailure names the failed check a later different command did not clear, and nothing once the same command passes', integrity.unresolvedFailure(t06) === failedCheck && integrity.unresolvedFailure([...t06, { ...failedCheck, outcome: 'pass' }]) === null, { happened: JSON.stringify(integrity.unresolvedFailure(t06)), why: 'Both claim checks rest on this one reading.', fix: 'Check unresolvedFailure in lib/integrity.mjs.' });
    check('with checkFailDominates, the same check with an outcome nobody could read does not clear a failure (Codex F1)', integrity.unresolvedFailure([...t06, { ...failedCheck, outcome: 'unknown' }]) === failedCheck && !integrity.verificationAfterLastEdit([edit, failedCheck, { ...failedCheck, outcome: 'unknown' }], true), { happened: JSON.stringify(integrity.unresolvedFailure([...t06, { ...failedCheck, outcome: 'unknown' }])), why: 'A check whose result could not be read has not passed; letting it clear a failure opens the gate on nothing.', fix: 'Clear a failure only on an explicit pass of the same check.' });
    const quoted = { kind: 'shell', verify: true, command: `python -c "assert f('a  b')"`, outcome: 'fail' };
    check('a check whose quoted text differs only in spacing is another check and does not clear a failure (Codex F2)', integrity.unresolvedFailure([edit, quoted, { ...quoted, command: `python -c "assert f('a b')"`, outcome: 'pass' }]) === quoted && integrity.canonicalCommand(' python   check.py ') === 'python check.py', { happened: integrity.canonicalCommand(quoted.command), why: 'Spaces inside quotes are part of the program; collapsing them let a different command clear the failure.', fix: 'canonicalCommand collapses spaces only outside quotes.' });
    check('two long checks with the same first 300 characters, or one command in two directories, are told apart by checkId', integrity.unresolvedFailure([edit, { ...failedCheck, checkId: 'one' }, { ...failedCheck, checkId: 'two', outcome: 'pass' }])?.checkId === 'one' && integrity.unresolvedFailure([edit, { ...failedCheck, checkId: 'one' }, { ...failedCheck, checkId: 'one', outcome: 'pass' }]) === null, { happened: 'checkId ignored', why: 'An event keeps 300 characters of the command; only the hash of the whole command and directory tells two such checks apart.', fix: 'sameCheck compares checkId when both events carry one.' });
    const identified = { ...failedCheck, checkId: 'cwd-and-command' };
    const recovered = { ...failedCheck, outcome: 'pass', from: 'transcript' };
    check('an ID-less recovered pass cannot clear an identified failure, in either provenance order', integrity.unresolvedFailure([identified, recovered]) === identified && integrity.unresolvedFailure([failedCheck, { ...identified, outcome: 'pass' }]) === failedCheck && integrity.unresolvedFailure([identified, { ...identified, outcome: 'pass' }]) === null,
      { happened: JSON.stringify(integrity.unresolvedFailure([identified, recovered])), why: 'Missing check identity cannot prove that a later pass ran the same command in the same directory.', fix: 'If either event carries checkId, require both matching IDs before clearing.' });
    {
      const before = process.env.ATLIAS_FLAG_CHECK_FAIL_DOMINATES;
      const tail = 'x'.repeat(320);
      const ids = [];
      try {
        for (const [flag, cwd, extra] of [[null, PROJECT, 'a'], ['1', PROJECT, 'a'], ['1', PROJECT, 'b'], ['1', path.join(PROJECT, 'sub'), 'a']]) {
          if (flag == null) delete process.env.ATLIAS_FLAG_CHECK_FAIL_DOMINATES; else process.env.ATLIAS_FLAG_CHECK_FAIL_DOMINATES = flag;
          const sid = `checkid-${ids.length}-${process.pid}-${Date.now()}`;
          track.postTool({ session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: `npm test -- ${tail}${extra}` }, tool_response: { stdout: 'FAIL x', exit_code: 1 } });
          ids.push(core.eventsTail(sid).filter((e) => e.kind === 'shell').pop()?.checkId);
        }
      } finally { if (before == null) delete process.env.ATLIAS_FLAG_CHECK_FAIL_DOMINATES; else process.env.ATLIAS_FLAG_CHECK_FAIL_DOMINATES = before; }
      check('with checkFailDominates the hook records a checkId from the whole command and directory, and without it records none', ids[0] === undefined && ids[1] && ids[2] && ids[3] && new Set(ids.slice(1)).size === 3, { happened: JSON.stringify(ids), why: 'Flag off must record what it always did; flag on must tell apart commands that differ after character 300 or run elsewhere.', fix: 'track.mjs adds checkId(payload, command) to check events when failDominates() is true.' });
    }
    const envBefore = process.env.ATLIAS_FLAG_CHECK_FAIL_DOMINATES;
    process.env.ATLIAS_FLAG_CHECK_FAIL_DOMINATES = '1';
    let held = [];
    try { held = integrity.check({ cwd: PROJECT, turn: t06, last: 'All tests pass now.', files: [], flags: {} }); }
    finally { if (envBefore == null) delete process.env.ATLIAS_FLAG_CHECK_FAIL_DOMINATES; else process.env.ATLIAS_FLAG_CHECK_FAIL_DOMINATES = envBefore; }
    check('with the flag set per arm, "tests pass" after a failed check.py and a print-only command is caught', held.some((f) => f.flag === 'passclaim' && /AssertionError/.test(f.text)), { happened: JSON.stringify(held).slice(0, 200), why: 'A study switches the flag per arm through the environment; the claim check must read it there.', fix: 'Callers that pass no dominates argument read config().flags.checkFailDominates.' });
    check('a check that already spoke this prompt stays quiet', flagged.length === 0, { happened: JSON.stringify(flagged), why: 'Each finding is raised once per prompt, or the gate becomes a loop.', fix: 'Honour the flags passed to check().' });
  });

  suite('diff expert', 'reading what changed', () => {
    const root = path.join(TMP, 'fake-root');
    const text = ['diff --git a/src/app.js b/src/app.js', '--- a/src/app.js', '+++ b/src/app.js', '@@ -2,0 +3,2 @@', '+export function added() {}', '+// TODO later', '@@ -8 +10 @@', '-  expect(x).toBe(1);', '+  expect(x).toBe(2);', 'diff --git a/gone.js b/gone.js', '--- a/gone.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-old'].join(NL);
    const parsed = integrity.parseDiff(text, root);
    const first = parsed.added[0];
    check('added lines carry their new line numbers', first && first.line === 3 && parsed.added[1].line === 4 && parsed.added[2].line === 10, { happened: JSON.stringify(parsed.added.map((a) => a.line)), why: 'A finding that points at the wrong line is a finding the model cannot act on.', fix: 'Take the start from the +c,d part of the hunk header and count up.' });
    check('removed lines are kept for the assertion count', parsed.removed.some((r) => /toBe\(1\)/.test(r.text)), { happened: JSON.stringify(parsed.removed), why: 'A removed assertion is only visible on the minus side.', fix: 'Collect lines starting with a minus.' });
    check('a deleted file adds nothing', !parsed.added.some((a) => /gone/.test(a.file)), { happened: JSON.stringify(parsed.added.map((a) => a.file)), why: 'A file that no longer exists has nothing to check.', fix: 'Treat +++ /dev/null as no file.' });
    check('outside a repository there is no diff, and no guessing', integrity.diffFor(path.join(TMP, 'not-a-repo-' + Date.now()), [path.join(TMP, 'x.js')]) === null, { happened: 'a diff was produced', why: 'Without git there is no way to tell new code from old, and flagging old TODOs as new would be noise.', fix: 'Return null when rev-parse fails.' });
  });

  suite('placeholder expert', 'stubs and elided code', () => {
    const f = (text) => ({ file: path.join(PROJECT, 'src', 'x.js'), line: 1, text });
    const stubbed = ['// TODO implement', "throw new Error('not implemented');", 'raise NotImplementedError', '// ... existing code ...', 'const data = placeholder data here', 'return dummy data;', 'lorem ipsum dolor'];
    const missed = stubbed.filter((t) => integrity.findStubs([f(t)]).length === 0);
    check('every common stub is caught', missed.length === 0, { happened: missed.join(' | ') || 'all caught', why: 'A stub that compiles looks finished and is not.', fix: 'Extend STUB_PATTERNS.' });
    const clean = ['<input placeholder="Email">', 'const total = items.reduce((a, b) => a + b, 0);', 'return value;'];
    const noisy = clean.filter((t) => integrity.findStubs([f(t)]).length > 0);
    check('ordinary code, including an HTML placeholder attribute, is left alone', noisy.length === 0, { happened: noisy.join(' | ') || 'none flagged', why: 'A placeholder attribute is not a placeholder implementation; flagging it would teach the model to ignore the gate.', fix: 'Keep the placeholder pattern tied to data, values or implementation.' });
    check('test files are not scanned for stubs', integrity.findStubs([{ file: path.join(PROJECT, 'test', 'x.test.js'), line: 1, text: '// TODO more cases' }]).length === 0, { happened: 'a test file was flagged', why: 'Fixtures and mocks live in tests on purpose.', fix: 'Skip TEST_FILE_RE matches.' });
  });

  suite('test weakening expert', 'weakened tests', () => {
    const t = (text) => ({ file: path.join(PROJECT, 'src', 'app.test.js'), line: 5, text });
    const weak = ["it.skip('works', () => {", "test.only('one', () => {", "xit('x', () => {", '@pytest.mark.skip(reason="flaky")', 'expect(true).toBe(true);', 'assert True'];
    const missed = weak.filter((w) => integrity.findWeakenedTests([t(w)], []).length === 0);
    check('skips, focus and assertions that cannot fail are caught', missed.length === 0, { happened: missed.join(' | ') || 'all caught', why: 'Making the test easier to pass is the most common way an agent fakes success.', fix: 'Extend SKIP_PATTERNS.' });
    const removed = integrity.findWeakenedTests([], [{ file: path.join(PROJECT, 'src', 'app.test.js'), text: '  expect(total).toBe(3);' }]);
    check('a removed assertion is caught', removed.some((w) => /assertion/.test(w.what)), { happened: JSON.stringify(removed), why: 'Deleting the assertion that fails is quieter than skipping the test, and just as false.', fix: 'Count removed assertion lines per test file.' });
    const swapped = integrity.findWeakenedTests([{ file: path.join(PROJECT, 'src', 'app.test.js'), line: 5, text: '  expect(total).toBe(4);' }], [{ file: path.join(PROJECT, 'src', 'app.test.js'), text: '  expect(total).toBe(3);' }]);
    check('an assertion rewritten in place is not counted as removed', swapped.length === 0, { happened: JSON.stringify(swapped), why: 'Updating an expectation is ordinary work, and the gate must not punish it.', fix: 'Compare removed against added assertion counts.' });
    check('assertions in non-test files are ignored', integrity.findWeakenedTests([], [{ file: path.join(PROJECT, 'src', 'app.js'), text: 'assert(x)' }]).length === 0, { happened: 'a source file was flagged', why: 'Only tests guard behaviour this way.', fix: 'Filter by TEST_FILE_RE.' });
  });

  suite('wiring expert', 'code that nothing calls', () => {
    const f = (text) => ({ file: path.join(PROJECT, 'src', 'x.js'), line: 1, text });
    const defs = integrity.newDefinitions([f('export function brandNew(a) {'), f('const helper = (x) => x * 2;'), f('class Widget {'), f('def compute_total(items):'), f('func Serve() {'), f('export default function Page() {'), f('export async function GET(req) {'), f('function main() {')]);
    const names = defs.map((d) => d.name);
    check('definitions are found in JavaScript, Python and Go', ['brandNew', 'helper', 'Widget', 'compute_total', 'Serve'].every((n) => names.includes(n)), { happened: names.join(', '), why: 'A definition the check cannot see is a feature it cannot hold to being wired.', fix: 'Extend DEF_PATTERNS.' });
    check('names a framework calls by convention are skipped', !names.includes('Page') && !names.includes('GET') && !names.includes('main'), { happened: names.join(', '), why: 'A route handler or a default export is reached by the framework, not by a call in this repository.', fix: 'Keep CONVENTION_NAMES and the export default skip.' });
    let calls = 0;
    const fakeGrep = (cmd, args) => { calls++; const name = args[args.length - 1]; return { status: 0, stdout: name === 'lonely' ? 'src/x.js:1' + NL : 'src/x.js:1' + NL + 'src/y.js:3' + NL, stderr: '' }; };
    const unwired = integrity.findUnwired(PROJECT, [{ file: 'x', line: 1, name: 'lonely' }, { file: 'x', line: 2, name: 'popular' }], { run: fakeGrep });
    check('a name found only at its own definition is reported', unwired.length === 1 && unwired[0].name === 'lonely' && calls === 2, { happened: JSON.stringify(unwired), why: 'A function nothing reaches is a feature that only looks finished.', fix: 'Sum the per-file counts from git grep -c and flag a total of one or less.' });
    const broken = integrity.findUnwired(PROJECT, [{ file: 'x', line: 1, name: 'anything' }], { run: () => ({ status: 128, stdout: '', stderr: 'fatal' }) });
    check('a failing grep reports nothing rather than guessing', broken.length === 0, { happened: JSON.stringify(broken), why: 'A false "nothing calls this" sends the model to wire in code that was already wired.', fix: 'Skip the name when git grep fails.' });
  });

  suite('end to end integrity expert', 'the gate on a real repository', () => {
    const repo = path.join(TMP, 'integrity-repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
    const git = (...args) => spawnSync('git', ['-c', 'user.email=atlias@example.com', '-c', 'user.name=atlias test', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
    if (git('init', '-q').status !== 0) {
      check('git is available for the diff checks', false, { happened: 'git init failed', why: 'Checks four to six read git; without it they are silent by design, and this suite cannot prove them.', fix: 'Install git on the machine running the tests.' });
      return;
    }
    const app = path.join(repo, 'src', 'app.js');
    const spec = path.join(repo, 'test', 'app.test.js');
    fs.writeFileSync(app, ['export function usedHelper(x) { return x + 1; }', 'export function start() { return usedHelper(1); }'].join(NL) + NL);
    fs.writeFileSync(spec, ["import { start } from '../src/app.js';", "test('start', () => {", '  expect(start()).toBe(2);', "  expect(typeof start).toBe('function');", '});'].join(NL) + NL);
    const stagedBase = git('add', '-A');
    if (!check('the integrity fixture stages its baseline', stagedBase.status === 0, { happened: JSON.stringify({ status: stagedBase.status, error: stagedBase.error?.message, stderr: stagedBase.stderr }), why: 'A missing baseline makes later diff failures ambiguous.', fix: 'Resolve the actual git setup failure before checking the gate.' })) return;
    const committedBase = git('commit', '-q', '-m', 'base');
    if (!check('the integrity fixture commits its baseline', committedBase.status === 0, { happened: JSON.stringify({ status: committedBase.status, error: committedBase.error?.message, stderr: committedBase.stderr }), why: 'A failed commit cannot establish a meaningful comparison.', fix: 'Resolve the actual git commit failure before checking the gate.' })) return;
    fs.writeFileSync(app, ['export function usedHelper(x) { return x + 1; }', 'export function start() { return usedHelper(1); }', 'export function wiredNew() { return 3; }', 'start.also = wiredNew;', 'export function unusedFeature() { return 42; }', '// TODO wire this into start', '// ... existing code ...'].join(NL) + NL);
    fs.writeFileSync(spec, ["import { start } from '../src/app.js';", "test.skip('start', () => {", '  expect(start()).toBe(2);', '});'].join(NL) + NL);
    const extra = path.join(repo, 'src', 'extra.js');
    fs.writeFileSync(extra, 'export function brandNewModule() { return 1; }' + NL);

    const diff = integrity.diffFor(repo, [app, spec, extra]);
    if (process.platform === 'win32') {
      const otherDrive = path.parse(repo).root.toLowerCase().startsWith('c:') ? 'D:/foreign/app.js' : 'C:/foreign/app.js';
      const mixed = integrity.diffFor(repo, [app, spec, extra, otherDrive]);
      check('another Windows volume cannot make this repository diff incomplete', mixed && !mixed.incomplete && mixed.added.some(a => /unusedFeature/.test(a.text)), { happened: JSON.stringify(mixed && { incomplete: mixed.incomplete }), why: 'Windows returns an absolute relative-path result across volumes; passing it to git aborts every local integrity check.', fix: 'Exclude absolute cross-volume paths from this repository diff.' });
    }
    check('the diff sees tracked edits and untracked files', diff && diff.added.some((a) => /unusedFeature/.test(a.text)) && diff.added.some((a) => /brandNewModule/.test(a.text)), { happened: diff ? diff.added.length + ' added lines' : 'no diff', why: 'A new file written this turn is the easiest place for an unwired feature to hide.', fix: 'Check diffFor: git diff HEAD plus ls-files --others.' });
    const s = sid('e2e');
    router.prompt({ session_id: s, cwd: repo, prompt: 'add the feature and make the tests pass' });
    for (const file of [app, spec, extra]) track.postTool({ session_id: s, cwd: repo, tool_name: 'Write', tool_input: { file_path: file } });
    const held = gate.stop({ session_id: s, cwd: repo, last_assistant_message: 'Done. All tests pass.' });
    const reason = held ? held.reason : '';
    check('one block names every problem at once', Boolean(held) && /no check ran/.test(reason) && /placeholders/.test(reason) && /weakened/.test(reason) && /nothing calls/.test(reason), { happened: reason.slice(0, 400) || 'not held', why: 'After a Stop hook blocks the host sets stop_hook_active and the gate never speaks again in that chain, so every finding has to be in the first block.', fix: 'Collect integrity.check() findings into the single block in gate.stop.' });
    check('the unwired list names the right functions', /unusedFeature/.test(reason) && /brandNewModule/.test(reason) && !/wiredNew\b/.test(reason.replace(/brandNewModule/g, '')), { happened: reason.split(NL).filter((l) => /unused|brandNew|wiredNew/.test(l)).join(' | '), why: 'Flagging a function that is called would send the model to wire in code that is already wired.', fix: 'Count references with git grep -w across the repository.' });
    const again = gate.stop({ session_id: s, cwd: repo, last_assistant_message: 'Done. All tests pass.' });
    check('and it does not speak twice for the same prompt', again === null, { happened: `it held a second time: ${again ? again.reason.split(NL).filter((l) => /^\d+\. /.test(l)).join(' | ') : ''}`, why: 'An unbounded gate is a loop.', fix: 'Set every raised flag at once.' });

    // The same prompt on a loaded machine. Measured before this fix: 7 of 240
    // replays of the scenario above held twice when six ran at once, because a
    // git grep or git diff that timed out on the first stop silently skipped its
    // check, and the second stop then raised it alone; a node --check that timed
    // out was reported as a file that does not parse. Here one git grep is made
    // to time out on purpose.
    const slowGrep = (cmd, args, opts) => (cmd === 'git' && args[0] === 'grep' ? { status: null, stdout: '', stderr: '', error: 'spawnSync git ETIMEDOUT' } : core.run(cmd, args, opts));
    const s3 = sid('e2e-slow');
    router.prompt({ session_id: s3, cwd: repo, prompt: 'add the feature and make the tests pass' });
    for (const file of [app, spec, extra]) track.postTool({ session_id: s3, cwd: repo, tool_name: 'Write', tool_input: { file_path: file } });
    const slow = gate.stop({ session_id: s3, cwd: repo, last_assistant_message: 'Done. All tests pass.' }, 'claude', { run: slowGrep });
    const slowReason = slow ? slow.reason : '';
    check('a check that timed out is named in the one block, not saved for a second', Boolean(slow) && /could not finish/.test(slowReason) && /git grep did not finish/.test(slowReason) && !/nothing calls/.test(slowReason) && /placeholders/.test(slowReason), { happened: slowReason.slice(0, 500) || 'not held', why: 'An unfinished check is not a passed one, and left unsaid it comes back on the next stop as a second block for the same prompt.', fix: 'Collect incomplete checks in integrity.check and name them in gate.stop.' });
    const slowAgain = gate.stop({ session_id: s3, cwd: repo, last_assistant_message: 'Done. All tests pass.' });
    check('and when git is quick again the gate stays quiet for that prompt', slowAgain === null, { happened: slowAgain ? slowAgain.reason.split(NL).filter((l) => /^\d+\. /.test(l)).join(' | ') : '', why: 'This is the exact shape that failed the suite under load: nothing calls, alone, on the second stop.', fix: 'Spend the incomplete flags with the raised ones in gate.stop.' });

    const timedOut = () => ({ status: null, stdout: '', stderr: '', error: 'spawnSync ETIMEDOUT' });
    const syn = gate.syntaxCheckDetailed([app], { run: timedOut });
    check('a parser that timed out leaves the file unchecked, not broken', syn.failures.length === 0 && syn.unchecked.length === 1 && syn.checked.length === 0, { happened: JSON.stringify({ failures: syn.failures.length, unchecked: syn.unchecked, checked: syn.checked }), why: 'Reporting a timeout as a syntax error held a reply over a file that parses, and in the editor it would put back an edit that was fine.', fix: 'Check r.status === null in syntaxCheckDetailed.' });
    const partial = integrity.diffFor(repo, [app, spec, extra], { run: (cmd, args, opts) => (args.includes('diff') ? timedOut() : core.run(cmd, args, opts)) });
    const grepOut = {};
    const none = integrity.findUnwired(repo, [{ file: 'x', line: 1, name: 'anything' }], { run: timedOut }, grepOut);
    check('and a git call that timed out marks its check unfinished', partial && partial.incomplete === true && partial.added.some((a) => /brandNewModule/.test(a.text)) && none.length === 0 && grepOut.incomplete === true, { happened: JSON.stringify({ incomplete: partial && partial.incomplete, added: partial ? partial.added.length : null, grep: grepOut }), why: 'Silence from a check that never finished reads exactly like a clean result, which is the bug that let the gate speak twice.', fix: 'Set incomplete in diffFor and findUnwired when status is null.' });
    // A git call that ran and failed is no more a clean answer than one that timed out (audit A5).
    const failed = (code) => () => ({ status: code, stdout: '', stderr: 'fatal: failed', error: null });
    for (const [label, discovery] of [['failed', failed(128)()], ['empty', { status: 0, stdout: '', stderr: '', error: null }]]) {
      const unknown = integrity.diffFor(repo, [app], { run: (cmd, args, opts) => args[0] === 'rev-parse' ? discovery : core.run(cmd, args, opts) });
      check('root discovery that ' + label + ' leaves the integrity check unfinished', unknown?.incomplete === true && unknown.root === null, { happened: JSON.stringify(unknown), why: 'A Git discovery error is not proof that changed files are outside a repository.', fix: 'Record failed root discovery as incomplete and do not cache the failure.' });
    }
    const diffFailed = integrity.diffFor(repo, [app, spec, extra], { run: (cmd, args, opts) => (args.includes('diff') ? failed(128)() : core.run(cmd, args, opts)) });
    const listFailed = integrity.diffFor(repo, [app, spec, extra], { run: (cmd, args, opts) => (args.includes('ls-files') ? failed(1)() : core.run(cmd, args, opts)) });
    const grepFailed = {};
    integrity.findUnwired(repo, [{ file: 'x', line: 1, name: 'anything' }], { run: failed(2) }, grepFailed);
    const grepNoMatch = {};
    integrity.findUnwired(repo, [{ file: 'x', line: 1, name: 'anything' }], { run: failed(1) }, grepNoMatch);
    check('a git diff, ls-files or grep that failed marks its check unfinished, while grep finding nothing does not', diffFailed && diffFailed.incomplete === true && listFailed && listFailed.incomplete === true && grepFailed.incomplete === true && !grepNoMatch.incomplete, { happened: JSON.stringify({ diff: diffFailed && diffFailed.incomplete, list: listFailed && listFailed.incomplete, grep: grepFailed, noMatch: grepNoMatch }), why: 'A failed git call read as an empty diff, so placeholders and weakened tests in it were never looked at, and the reply passed as if checked.', fix: 'diffFor and findUnwired: any status other than 0 (or 1 for grep) is incomplete.' });
    const listsGhost = (cmd, args, opts) => (args.includes('ls-files') ? { status: 0, stdout: 'ghost-file-that-cannot-be-read.js\n', stderr: '', error: null } : core.run(cmd, args, opts));
    const ghost = integrity.diffFor(repo, [app, spec, extra], { run: listsGhost });
    check('a new file git lists but nobody can read leaves the diff unfinished', ghost && ghost.incomplete === true, { happened: JSON.stringify(ghost && { incomplete: ghost.incomplete, added: ghost.added.length }), why: 'Skipping an unreadable new file in silence reported a diff that never looked at it as complete (Codex review 03:11Z).', fix: 'diffFor: an unreadable listed file sets incomplete.' });
    const fresh = fs.mkdtempSync(path.join(TMP, 'no-commit-'));
    core.run('git', ['init', '-q'], { cwd: fresh });
    const staged = path.join(fresh, 'calc.py');
    fs.writeFileSync(staged, 'def add(a, b):\n    pass\n');
    core.run('git', ['add', 'calc.py'], { cwd: fresh });
    const noCommit = integrity.diffFor(fresh, [staged]);
    check('in a repository with no commit yet, a staged file is not reported as a clean, complete diff', noCommit && (noCommit.incomplete === true || noCommit.added.some((a) => /pass/.test(a.text))), { happened: JSON.stringify(noCommit && { incomplete: noCommit.incomplete, added: noCommit.added.length }), why: 'git diff HEAD exits 128 before the first commit; the staged placeholder was invisible and the check said complete.', fix: 'diffFor: incomplete when git diff fails.' });
    const initializedLater = fs.mkdtempSync(path.join(TMP, 'init-later-'));
    const beforeInit = integrity.repoRoot(initializedLater);
    const initResult = core.run('git', ['init', '-q'], { cwd: initializedLater });
    const afterInit = integrity.repoRoot(initializedLater);
    check('a folder initialized as a repository later is discovered without restarting', beforeInit === null && initResult.status === 0 && afterInit && integrity.real(afterInit) === integrity.real(initializedLater), { happened: JSON.stringify({ beforeInit, init: initResult.status, afterInit }), why: 'A new project can gain a repository during the same chat.', fix: 'Do not memoize a missing repository for the lifetime of the process.' });
    const s2 = sid('e2e-honest');
    router.prompt({ session_id: s2, cwd: repo, prompt: 'try the change' });
    track.postTool({ session_id: s2, cwd: repo, tool_name: 'Write', tool_input: { file_path: app } });
    const honest = gate.stop({ session_id: s2, cwd: repo, last_assistant_message: 'I made the change, but it is untested: the suite needs a browser. Pass 2: adversarial re-read done.' });
    check('an honest reply is held only for the code itself, not for its words', honest && !/no check ran/.test(honest.reason) && !/says the work is done/.test(honest.reason) && /placeholders/.test(honest.reason), { happened: honest ? honest.reason.slice(0, 300) : 'not held', why: 'The placeholders are still real; the claim is not there to hold.', fix: 'HONEST_RE suppresses the claim checks only.' });
  });
}
