// The eval harness, checked against a scripted model so the result is the
// same on every machine. What these prove is not that a model is clever: it is
// that the scoreboard cannot be talked into a pass.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as evals from '../lib/eval.mjs';
import * as agentMod from '../lib/agent.mjs';

const NL = String.fromCharCode(10);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const blk = (obj) => '```atlias' + NL + JSON.stringify(obj) + NL + '```';
// A scripted model: each call returns the next reply in the list.
const scripted = (replies) => {
  let i = 0;
  return async () => ({ content: replies[Math.min(i++, replies.length - 1)] });
};

const FIX = {
  id: 'eval-selftest',
  name: 'a one-line fix',
  files: {
    // Node 18 has no module detection: without this the ESM sum.js does not
    // load and a correct fix fails (CI's node 18 job, since 3.6.0).
    'package.json': '{ "type": "module" }' + NL,
    'sum.js': 'export function two() { return 1; }' + NL,
    'test.mjs': "import { two } from './sum.js';" + NL + 'process.exit(two() === 2 ? 0 : 1);' + NL,
  },
  prompt: 'Make node test.mjs pass.',
  check: ['node', 'test.mjs'],
};

// register is async and every suite is awaited: asyncSuite points the runner's
// current-suite pointer at itself before it starts, so two un-awaited suites
// run at once and the first one's checks are counted under the second's name.
// TMP is the runner's own temp tree: a fixture made under os.tmpdir() instead
// outlives a suite that throws before its own cleanup line.
export default async function register({ asyncSuite, check, TMP }) {
  await asyncSuite('harness scoreboard expert', 'a task is scored by the check, not the claim', async () => {
    const state = agentMod.newState(process.cwd(), 'echo');

    // 1. A model that does the work passes.
    const good = await evals.runTask(FIX, {
      state,
      chat: scripted([
        blk({ tool: 'write_file', path: 'sum.js', content: 'export function two() { return 2; }' + NL }),
        'Fixed it.',
      ]),
    });
    check('a task the model really fixes passes', good.pass, { happened: `${good.pass} - ${good.why}`, why: 'If a correct run cannot pass, the scoreboard is useless and every later number is noise.', fix: 'Check score() and the task check command.' });

    // 2. A model that only says it fixed it fails. This is the whole point.
    const liar = await evals.runTask(FIX, { state, chat: scripted(['Done. The test passes now.']) });
    check('a claim with no work behind it fails', !liar.pass, { happened: `${liar.pass} - ${liar.why}`, why: 'Every benchmark that trusts the model own word measures confidence, not work.', fix: 'score() must read the check exit code and nothing else.' });
    check('and the failure says what the check did', /exited [0-9]/.test(liar.why), { happened: liar.why, why: 'A failure nobody can read is a failure nobody fixes.', fix: 'Keep the exit code in why.' });

    // 3. A failed run keeps its workspace so the failure can be looked at.
    check('a failed task keeps its workspace', Boolean(liar.workspace) && fs.existsSync(liar.workspace), { happened: String(liar.workspace), why: 'The first question after a failure is what the files actually looked like.', fix: 'Only remove the workspace on a pass.' });
    try { fs.rmSync(liar.workspace, { recursive: true, force: true }); } catch { /* best effort */ }

    // 4. A check that cannot run at all is a failure, never a pass.
    const broken = await evals.runTask({ ...FIX, id: 'eval-selftest-nocheck', check: ['definitely-not-a-program-xyz'] }, { state, chat: scripted(['nothing to do']) });
    check('a check that cannot run is a failure', !broken.pass, { happened: `${broken.pass} - ${broken.why}`, why: 'A missing checker silently passing everything is the worst possible failure of a scoreboard.', fix: 'run() returning no status must score false.' });
    try { fs.rmSync(broken.workspace, { recursive: true, force: true }); } catch { /* best effort */ }

    // 5. Code that never returns costs the eval's shell limit, not the ten
    // minutes an interactive session allows (HumanEvalFix/10 on 2026-09-26).
    check('an eval task runs its shell commands under a two-minute limit', evals.EVAL_SHELL_TIMEOUT_MS === 120000,
      { happened: String(evals.EVAL_SHELL_TIMEOUT_MS), why: 'The same limit as the mini-swe-agent driver it is compared with, so neither side waits longer on a hung check.', fix: 'Check EVAL_SHELL_TIMEOUT_MS in lib/eval.mjs.' });
    const hangAt = Date.now();
    const hung = await evals.runTask({ ...FIX, id: 'eval-selftest-hang' }, {
      state,
      shellTimeoutMs: 2000,
      chat: scripted([blk({ tool: 'shell', command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 60000)"` }), 'Gave up.']),
    });
    check('and a hanging command inside a task is stopped at the limit the run set', Date.now() - hangAt < 20000 && !hung.pass,
      { happened: `${Date.now() - hangAt} ms, pass=${hung.pass}`, why: 'runTask has to hand its limit to the loop, or the limit exists only in a test of the loop.', fix: 'runTask passes shellTimeoutMs in limits.' });
    try { if (hung.workspace) fs.rmSync(hung.workspace, { recursive: true, force: true }); } catch { /* best effort */ }

    // 5. The task files on disk are what the task said they were.
    const dir = evals.makeWorkspace(FIX, 'shape');
    check('the workspace is built from the task', fs.readFileSync(path.join(dir, 'sum.js'), 'utf8').includes('return 1'), { happened: 'the seeded file was wrong', why: 'A task that starts from the wrong files measures nothing.', fix: 'Check makeWorkspace.' });
    check('and it is not the project being measured', !dir.startsWith(process.cwd()), { happened: dir, why: 'An eval that edits the repo it is testing corrupts the thing it measures.', fix: 'Workspaces live under the state directory.' });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }

    // 6. The shipped corpus loads and every task can be scored.
    const tasks = evals.loadTasks();
    check('the shipped tasks load', tasks.length >= 9, { happened: `${tasks.length} tasks`, why: 'A suite with no tasks reports a perfect score, and three tasks is too few for a difference between two versions of the loop to mean anything.', fix: 'Check evals/*.json.' });
    check('every shipped task names a check and a prompt', tasks.every((t) => t.prompt && t.check && t.files), { happened: tasks.map((t) => t.id).join(','), why: 'A task without a check cannot fail, so it cannot mean anything.', fix: 'Each evals/*.json needs files, prompt and check.' });
    // The corpus must start failing, or fixing nothing would score a pass.
    const scored = tasks.map((t) => {
      const d = evals.makeWorkspace(t, 'start');
      const s = evals.score(d, t);
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
      return s;
    });
    const starts = scored.map((s) => s.pass);
    check('every shipped task fails before the work is done', starts.every((p) => p === false), { happened: tasks.map((t, i) => `${t.id}:${starts[i] ? 'passes' : 'fails'}`).join(' '), why: 'A task that already passes measures nothing and quietly inflates the score.', fix: 'Seed the workspace with the bug, not the fix.' });
    // A checker that cannot start fails every task for a reason that has
    // nothing to do with the work, and the score then reads as a bad model.
    const unrunnable = tasks.filter((t, i) => /could not run/.test(scored[i].why)).map((t) => t.id);
    check('and every check really ran rather than failing to start', unrunnable.length === 0, { happened: unrunnable.join(', ') || 'none', why: 'A check whose program is not on this machine fails the task before the model has done anything, and nothing in the report says so.', fix: 'Every check must name a program this machine has; node is the only one the corpus assumes.' });
    // Eight tasks that are all a failing unit test measure one skill eight
    // times. These are the shapes a harness fails differently on.
    const KINDS = ['failing-test', 'new-function', 'no-regression', 'multi-file', 'read-first', 'no-change', 'misleading-error', 'linter', 'impossible'];
    const have = new Set(tasks.map((t) => t.kind));
    const missingKinds = KINDS.filter((k) => !have.has(k));
    check('the corpus covers every kind of task it claims to', missingKinds.length === 0, { happened: `missing ${missingKinds.join(', ') || 'nothing'}; present ${[...have].join(', ')}`, why: 'A multi-file change, code the model never read, a report whose right answer is to change nothing, an error message that names the wrong file and a linter instead of a test are five different ways to fail, and a corpus that only holds one of them cannot tell them apart.', fix: 'Give each evals/*.json a kind and keep all eight covered.' });
    const ids = tasks.map((t) => t.id);
    check('no two tasks share an id', new Set(ids).size === ids.length, { happened: ids.join(', '), why: 'The workspace directory is named from the id, so two tasks with one id would run in each other\'s files.', fix: 'Rename one of them.' });

    // 7. A whole suite counts what happened, and the report says it plainly.
    // One script per task: a shared one would hand the second task the first
    // task's leftovers, which is a flaw in the test, not in the runner.
    let step = 0;
    const perTask = async () => ({ content: step++ % 2 === 0 ? blk({ tool: 'write_file', path: 'sum.js', content: 'export function two() { return 2; }' + NL }) : 'done' });
    const suite = await evals.runSuite([FIX, { ...FIX, id: 'eval-selftest-2' }], { state, chat: perTask });
    check('a suite counts the passes, not the attempts', suite.total === 2 && suite.passed === 2, { happened: `${suite.passed}/${suite.total}`, why: 'The score is the only output anybody reads; if the arithmetic is wrong nothing else matters.', fix: 'Check runSuite.' });

    const text = evals.format({ results: [{ name: 'a', pass: true, rounds: 2, ms: 1000 }, { name: 'b', pass: false, why: 'the check exited 1', output: 'boom', rounds: 3, ms: 2000, workspace: 'D:/w' }], passed: 1, total: 2, ms: 3000 });
    check('the report names the failure and where to look', /FAIL {2}b/.test(text) && text.includes('the check exited 1') && text.includes('D:/w') && text.includes('1/2 tasks finished'), { happened: text.slice(0, 160), why: 'A score with no way back to the failure is a number nobody can act on.', fix: 'Check format().' });
    check('and a clean sweep says nothing about failures', !/A failure here/.test(evals.format({ results: [{ name: 'a', pass: true, rounds: 1, ms: 10 }], passed: 1, total: 1, ms: 10 })), { happened: 'the failure note appeared on a perfect run', why: 'Boilerplate that is always there stops being read.', fix: 'Only add the note when something failed.' });
  });

  // A score is only worth reading if you can say which code produced it, how
  // many times it was tried, and that the check that produced it is still the
  // one the task shipped. These are the three ways a scoreboard quietly lies.
  // Somebody else's benchmark, converted. The corpus is only worth growing if
  // every task added to it was proved on this machine first.
  await asyncSuite('borrowed corpus expert', 'a converted task is proved before it is kept', async () => {
    const poly = await import('../lib/polyglot.mjs');
    const repo = fs.mkdtempSync(path.join(TMP, 'poly-'));
    const ex = path.join(repo, 'python', 'exercises', 'practice', 'tiny');
    fs.mkdirSync(path.join(ex, '.docs'), { recursive: true });
    fs.mkdirSync(path.join(ex, '.meta'), { recursive: true });
    fs.writeFileSync(path.join(ex, 'tiny.py'), 'def total(items):' + NL + '    raise NotImplementedError' + NL);
    fs.writeFileSync(path.join(ex, 'tiny_test.py'), 'from tiny import total' + NL + NL + 'def test_total():' + NL + '    assert total([1, 2]) == 3' + NL);
    fs.writeFileSync(path.join(ex, 'helper.py'), '# carried along because the stub may import it' + NL);
    fs.writeFileSync(path.join(ex, '.docs', 'instructions.md'), 'Add up the numbers you are given. This sentence is here to be clipped.' + NL);
    fs.writeFileSync(path.join(ex, '.meta', 'example.py'), 'def total(items):' + NL + '    return sum(items)' + NL);

    check('the exercises are found where the benchmark keeps them', JSON.stringify(poly.exercisesIn(repo, 'python')) === '["tiny"]' && poly.exercisesIn(repo, 'nope').length === 0, { happened: JSON.stringify(poly.exercisesIn(repo, 'python')), why: 'A converter that silently finds nothing reports a clean run having done nothing at all.', fix: 'Check exercisesIn and the directory layout it expects.' });
    const brief = poly.briefFor(ex, 30);
    check('the brief is the exercise own words, clipped and said to be clipped', /Add up the numbers/.test(brief) && /clipped here/.test(brief) && brief.length < 200, { happened: brief, why: 'The task has to say what is wanted in the words its author used, and a six-thousand-character brief is paid again on every round of every attempt.', fix: 'Check briefFor.' });
    const built = poly.taskFromExercise(repo, 'python', 'tiny', { rounds: 7 });
    check('the task carries its files, its check and its protected test', built.task && built.task.id === 'polyglot-python-tiny' && built.task.rounds === 7 && JSON.stringify(built.task.protect) === '["tiny_test.py"]' && /-m pytest -q tiny_test\.py$/.test(built.task.check.join(' ')) && Object.keys(built.task.files).length === 3, { happened: JSON.stringify(built.task && { id: built.task.id, protect: built.task.protect, check: built.task.check, files: Object.keys(built.task.files || {}) }), why: 'The protected test is what stops a converted task being passed by rewriting it, and a missing second module fails the task on an import for a reason that has nothing to do with the model.', fix: 'Check taskFromExercise.' });
    check('and a missing stub is refused rather than guessed at', Boolean(poly.taskFromExercise(repo, 'python', 'absent').error) && Boolean(poly.taskFromExercise(repo, 'nope', 'tiny').error), { happened: JSON.stringify(poly.taskFromExercise(repo, 'python', 'absent')), why: 'A task built from files that are not there would fail every run and look like a hard exercise.', fix: 'Return an error, not a half-built task.' });
    // The Store alias for python.exe hangs instead of running, and it sat second
    // on PATH here: it converted nothing on the first full run. So the candidate
    // list must never offer it, and the resolver must return a real path.
    const cands = poly.runnerCandidates('python');
    check('the runner candidates exclude the Windows Store alias', cands.length > 0 && !cands.some((c) => /WindowsApps/i.test(c)) && poly.runnerCandidates('brainfuck').length === 0, { happened: JSON.stringify(cands), why: 'That alias opens the Microsoft Store and, spawned without a console, hangs until the timeout - which looked exactly like a machine with no python at all and refused the whole corpus.', fix: 'Check runnerCandidates and the WindowsApps filter.' });
    const resolved = poly.resolveRunner('python');
    check('and the resolver returns one that answers', resolved.ok ? Boolean(resolved.exe) && /pytest/i.test(resolved.why) : /no working runner|no candidate/.test(resolved.why), { happened: JSON.stringify(resolved), why: 'Baking a resolved interpreter into every task is what makes a converted corpus runnable twice; a bare name is whatever PATH offers that minute.', fix: 'Check resolveRunner.' });
    const ready = poly.runnerReady('python');
    check('a language with no runner here is refused by name', poly.runnerReady('brainfuck').ok === false && /no converter/.test(poly.runnerReady('brainfuck').why), { happened: JSON.stringify(poly.runnerReady('brainfuck')), why: 'A check whose program is not on this machine fails every task before the model does anything, and the score reads as a bad harness.', fix: 'Check runnerReady and LANGS.' });
    if (ready.ok) {
      const proof = poly.proveTask(built, 'python');
      check('a task is proved to fail as shipped and pass with the reference', proof.ok && proof.before.status !== 0 && proof.after.status === 0, { happened: JSON.stringify({ ok: proof.ok, why: proof.why, before: proof.before && proof.before.status, after: proof.after && proof.after.status }), why: 'This is the whole reason a borrowed benchmark can be trusted: a task that already passes measures nothing, and a task its own author solution cannot pass is measuring this machine.', fix: 'Check proveTask.' });
      fs.writeFileSync(path.join(ex, 'tiny.py'), 'def total(items):' + NL + '    return sum(items)' + NL);
      const solved = poly.proveTask(poly.taskFromExercise(repo, 'python', 'tiny'), 'python');
      check('and one that already passes is refused', solved.ok === false && /already passes/.test(solved.why), { happened: JSON.stringify(solved), why: 'A task that passes with the stub in place quietly inflates every score it appears in.', fix: 'Check the first branch of proveTask.' });
      fs.writeFileSync(path.join(ex, 'tiny.py'), 'def total(items):' + NL + '    raise NotImplementedError' + NL);
      const out = fs.mkdtempSync(path.join(TMP, 'poly-out-'));
      const done = poly.convert(repo, 'python', out, { rounds: 7 });
      check('the conversion writes only what it proved', done.wrote.length === 1 && fs.existsSync(path.join(out, 'polyglot-python-tiny.json')) && JSON.parse(fs.readFileSync(path.join(out, 'polyglot-python-tiny.json'), 'utf8')).check.length === 5, { happened: JSON.stringify({ wrote: done.wrote, refused: done.refused }), why: 'A converter that writes first and checks later fills the corpus with tasks nobody can trust.', fix: 'Check convert.' });
      check('and the report names what it refused', /1 task\(s\) written/.test(poly.report(done)) && /refused, which is the point/.test(poly.report({ ok: true, why: 'x', dir: out, wrote: ['a'], refused: [{ name: 'b', why: 'no stub' }] })), { happened: poly.report(done).split(NL)[0], why: 'A refusal nobody is told about looks like an exercise that was never there.', fix: 'Check report.' });
      try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* best effort */ }
    } else {
      check('with no runner the converter refuses instead of writing', poly.convert(repo, 'python', path.join(repo, 'out')).ok === false && /nothing converted/.test(poly.report(poly.convert(repo, 'python', path.join(repo, 'out')))), { happened: JSON.stringify(poly.convert(repo, 'python', path.join(repo, 'out'))), why: 'Writing tasks whose check cannot start would fill the corpus with guaranteed failures.', fix: 'convert returns early when runnerReady says no.' });
    }
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // Two scores are not a result. The comparator has to be checked against
  // itself before it is trusted to judge anything else.
  await asyncSuite('paired comparison expert', 'a difference between two runs is judged, not eyeballed', async () => {
    const rep = (pass) => ({ results: pass.map((p, i) => ({ id: `t${i}`, name: `t${i}`, pass: p })) });
    const same = evals.compare(rep([true, false, true, false]), rep([true, false, true, false]));
    check('the same run against itself is never a difference', same.changed === 0 && same.p === 1 && /nothing changed/.test(same.verdict), { happened: JSON.stringify({ changed: same.changed, p: same.p, verdict: same.verdict }), why: 'A comparator that finds a difference between a configuration and itself would report every change as a win, and that is the first thing to rule out before any of its other numbers mean anything.', fix: 'Check mcnemar with no disagreements.' });

    // One task flipping on a nine-task corpus is what the real A/B produced.
    const oneUp = evals.compare(rep([true, true, true, false, false, false, false, false, false]), rep([true, true, true, true, false, false, false, false, false]));
    check('one task gained on a small corpus is reported as inside the noise', oneUp.gained.length === 1 && oneUp.lost.length === 0 && oneUp.p === 1 && /inside the noise/.test(oneUp.verdict), { happened: JSON.stringify({ gained: oneUp.gained, p: oneUp.p, verdict: oneUp.verdict }), why: 'This is the actual measurement this harness produced - 3 of 9 against 4 of 9 - and calling it an improvement would be the single easiest way to fool ourselves.', fix: 'Check the exact binomial tail in mcnemar.' });

    const sevenUp = evals.compare(rep(Array(20).fill(false)), rep([...Array(7).fill(true), ...Array(13).fill(false)]));
    check('and seven gained with none lost is a real difference', sevenUp.p < 0.05 && /real difference/.test(sevenUp.verdict), { happened: `p=${sevenUp.p.toFixed(4)} ${sevenUp.verdict}`, why: 'A test that can never say yes is as useless as one that always does.', fix: 'Check mcnemar.' });

    const mixed = evals.compare(rep([true, true, false, false]), rep([false, true, true, false]));
    check('a swap in both directions cancels rather than counting as progress', mixed.gained.length === 1 && mixed.lost.length === 1 && mixed.p === 1, { happened: JSON.stringify({ gained: mixed.gained, lost: mixed.lost, p: mixed.p }), why: 'Two tasks changing in opposite directions is the commonest shape of noise, and a score difference of zero hides it entirely.', fix: 'Count b01 and b10 separately.' });

    const shifted = evals.compare(rep([true, false]), { results: [{ id: 't0', pass: true }, { id: 'tX', pass: true }] });
    check('a task only one run holds is set aside, not counted', shifted.pairs === 1 && shifted.onlyA.includes('t1') && shifted.onlyB.includes('tX'), { happened: JSON.stringify({ pairs: shifted.pairs, onlyA: shifted.onlyA, onlyB: shifted.onlyB }), why: 'A corpus that changed between the two runs is not a comparison, and silently pairing the wrong tasks would make it look like one.', fix: 'Align by id and report the leftovers.' });

    // A fixed generator, so the interval is the same number on every machine.
    let seed = 7;
    const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const boot = evals.bootstrapDiff([{ a: false, b: true }, { a: false, b: true }, { a: true, b: true }, { a: false, b: false }], 500, rng);
    check('the bootstrap interval covers the mean and is not a point', boot.mean === 0.5 && boot.lo < boot.mean && boot.hi >= boot.mean, { happened: JSON.stringify(boot), why: 'An interval that collapses to the estimate tells the reader the corpus is certain when it is four tasks.', fix: 'Check bootstrapDiff resampling.' });

    // mcnemar on its own, against values worked by hand: seven to none is
    // 2 x 0.5^7; ten to two is 2 x (1 + 12 + 66) / 4096; two to one is 2 x 4/8,
    // capped at one. And a corpus big enough to underflow 2^-n must still give
    // a number, not NaN.
    const m = [evals.mcnemar(7, 0), evals.mcnemar(10, 2), evals.mcnemar(2, 1), evals.mcnemar(0, 0), evals.mcnemar(0, 7)];
    const big = [evals.mcnemar(1200, 1100), evals.mcnemar(1500, 1500), evals.mcnemar(3000, 0)];
    const near = (x, y) => Math.abs(x - y) < 1e-9;
    check('mcnemar matches the exact binomial tail worked by hand', near(m[0].p, 0.015625) && near(m[1].p, 2 * 79 / 4096) && m[2].p === 1 && m[3].p === 1 && m[3].n === 0 && near(m[4].p, m[0].p) && m[1].n === 12, { happened: JSON.stringify(m), why: 'Every verdict the comparator prints rests on this one number; a test that only checks its verdict words would pass with the tail off by a term.', fix: 'Check the loop over k in mcnemar.' });
    check('and it stays a probability on a corpus of thousands', big.every((r) => Number.isFinite(r.p) && r.p >= 0 && r.p <= 1) && big[0].p < 0.05 && big[1].p === 1 && big[2].p === 0, { happened: JSON.stringify(big), why: 'Past about a thousand disagreements 2^-n underflows and C(n, k) overflows, and their product is NaN, which would print as the p-value.', fix: 'Build each term in logs.' });
    const none = evals.formatCompare(evals.compare(rep([true]), { results: [{ id: 'other', pass: true }] }), 'A', 'B');
    check('two runs with no task in common are not reported as a tie', /share no task/.test(none) && !/Infinity|NaN|0\/0/.test(none), { happened: none, why: 'A p of one and an interval of zero over no tasks at all reads as a measured tie, and the size warning divided by zero.', fix: 'Return early in formatCompare when pairs is zero.' });

    // Each task's edit tally is its own. A state that already carries counters
    // (a reused agent session) must neither leak them into the task nor collect
    // the task's failures into its shared object.
    const carried = { ...agentMod.newState(process.cwd(), 'echo'), editTries: 9, editFails: 7, editWhy: { 'not-found': 5 } };
    const own = await evals.runTask(FIX, { state: carried, chat: scripted([blk({ tool: 'edit_file', path: 'nowhere.js', old_string: 'a', new_string: 'b' }), 'Stopping.']) });
    check('a task counts only its own edits, whatever state it was handed', own.editTries === 1 && own.editFails === 1 && JSON.stringify(own.editWhy) === JSON.stringify({ 'no-file': 1 }) && JSON.stringify(carried.editWhy) === JSON.stringify({ 'not-found': 5 }), { happened: JSON.stringify({ tries: own.editTries, fails: own.editFails, why: own.editWhy, carried: carried.editWhy }), why: 'The state is copied shallowly, so a carried editWhy would be one object every task adds into, and runSuite would then sum those running totals a second time.', fix: 'Start editTries, editFails and editWhy fresh in runTask.' });
    const fe = own.failedEdits || [];
    check('a failed edit is kept with its arguments, its cause and the refusal', fe.length === 1 && fe[0].tool === 'edit_file' && fe[0].path === 'nowhere.js' && fe[0].old_string === 'a' && fe[0].new_string === 'b' && fe[0].why === 'no-file' && /^there is no /.test(fe[0].result) && fe[0].round === 1, { happened: JSON.stringify(fe), why: 'poly-B counted 25 would-not-parse refusals and kept none of them, so a fix could only be aimed at a count.', fix: 'Push call arguments into state.editLog beside editWhy in runLoop, and carry it out of runTask as failedEdits.' });
    if (own.workspace) { try { fs.rmSync(own.workspace, { recursive: true, force: true }); } catch { /* best effort */ } }

    const text = evals.formatCompare(oneUp, 'before', 'after');
    check('the report says both numbers, the p and the size warning', /before 3\/9 against after 4\/9/.test(text) && /McNemar exact p = 1\.000/.test(text) && /one task flipping moves the score 11\.1 points/.test(text), { happened: text, why: 'A verdict with no arithmetic behind it is just a louder opinion.', fix: 'Check formatCompare.' });
  });

  // The round budget a run was actually given, and what the header says about
  // it. Found on the first real slice of the main tier: every task ran on its
  // own 8 or 12 rounds while the header printed the machine's 25.
  await asyncSuite('round budget expert', 'a report says the rounds its tasks ran on, and a run can override them', async () => {
    const quiet = async () => ({ content: 'Nothing done.' });
    const small = { id: 'eight-rounds', name: 'eight rounds', rounds: 8, protect: [], files: {}, prompt: 'Do nothing.', check: ['node', '-e', 'process.exit(1)'] };
    const large = { ...small, id: 'twelve-rounds', name: 'twelve rounds', rounds: 12 };
    const own = await evals.runSuite([small, large], { chat: quiet, stamp: false });
    check('the header prints the spread of the task budgets, not the machine default',
      /8-12 rounds per task/.test(evals.format(own)) && own.budgetRange[0] === 8 && own.budgetRange[1] === 12 && own.budgetSet === false,
      { happened: evals.format(own).split('\n').slice(0, 3).join(' | '), why: 'A run where most tasks end rounds-exhausted is read completely differently depending on whether the budget was 8 or 25, and the report said 25.', fix: 'runSuite records budgetRange; format prefers it.' });
    // The smoke tier mixes the two: one task with 8 rounds of its own, eight with
    // none, which run on agent.maxToolRounds. The header said "8 rounds per task".
    const unbudgeted = { ...small, id: 'no-rounds', name: 'no rounds' };
    delete unbudgeted.rounds;
    const mixed = await evals.runSuite([small, unbudgeted], { chat: quiet, stamp: false });
    const dflt = mixed.budget;
    check('a task with no budget of its own is in the spread at the machine default, and the header counts it',
      mixed.budgetRange[0] === 8 && mixed.budgetRange[1] === dflt && mixed.budgetDefaulted === 1
        && new RegExp(`8-${dflt} rounds per task \\(1 of them with no budget of their own, on agent\\.maxToolRounds ${dflt}\\)`).test(evals.format(mixed)),
      { happened: JSON.stringify({ range: mixed.budgetRange, defaulted: mixed.budgetDefaulted, line: evals.format(mixed).split('\n')[0] }), why: 'A header that names only the one task budget in the corpus tells the reader a run that ended rounds-exhausted at 25 was cut off at 8.', fix: 'budgetRange counts a task with no budget at agent.maxToolRounds; budgetDefaulted says how many.' });
    for (const r of mixed.results) if (r.workspace) { try { fs.rmSync(r.workspace, { recursive: true, force: true }); } catch { /* best effort */ } }
    const forced = await evals.runSuite([small, large], { chat: quiet, stamp: false, budget: 3 });
    check('--rounds overrides every task budget and the header says it was set for this run',
      forced.results.every((r) => r.budget === 3) && forced.budgetSet === true && /3 rounds, set for this run/.test(evals.format(forced)),
      { happened: JSON.stringify({ budgets: forced.results.map((r) => r.budget), line: evals.format(forced).split('\n')[0] }), why: 'Asking whether a tier scores zero because of its own budget needs a way to change it that is recorded, not a corpus edited by hand.', fix: 'runTask takes budget as an override; runSuite reports budgetSet.' });
    for (const rep of [own, forced]) for (const r of rep.results) if (r.workspace) { try { fs.rmSync(r.workspace, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  // NEXTGEN-4 build item 2, the last piece: partial credit. At 0 of 27 the pass
  // rate cannot tell "every test failed" from "seven of eight passed", and those
  // two need different fixes.
  await asyncSuite('partial credit expert', 'a failing task says how much of the check passed', async () => {
    const pytest = evals.caseCounts('collected 8 items\n\nFAILED test_x.py::test_a\n2 failed, 6 passed in 0.12s\n');
    const withErrors = evals.caseCounts('1 failed, 2 passed, 1 error in 0.30s');
    const unit = evals.caseCounts('......F\nRan 7 tests in 0.01s\n\nFAILED (failures=1, errors=1)\n');
    const clean = evals.caseCounts('Ran 4 tests in 0.00s\n\nOK\n');
    check('pytest and unittest counts are read, errors included',
      pytest.passed === 6 && pytest.total === 8 && withErrors.total === 4 && withErrors.passed === 2 && unit.passed === 5 && unit.total === 7 && clean.passed === 4,
      { happened: JSON.stringify({ pytest, withErrors, unit, clean }), why: 'These are the two runners the converted corpora use; a count read wrong would print a partial score that is worse than none.', fix: 'Check caseCounts.' });
    check('an assert-based check that stops at the first failure reports no fraction rather than a made-up one',
      evals.caseCounts('Traceback (most recent call last):\n  File "main.py", line 3\nAssertionError\n') === null && evals.caseCounts('') === null,
      { happened: JSON.stringify(evals.caseCounts('AssertionError')), why: 'CanItEdit and HumanEvalFix run one script that throws on the first bad assert; calling that 0 of 1 would put a fiction in the report for 252 of the tasks.', fix: 'caseCounts returns null when nothing counted its cases.' });

    // End to end: a task whose check prints counts carries them out of runTask
    // and into the suite report, and never into the verdict.
    const counted = {
      id: 'counts-its-cases', name: 'counts its cases', rounds: 1, files: { 'note.txt': 'nothing to do' }, protect: [],
      prompt: 'Do nothing.',
      check: ['node', '-e', 'console.log("3 failed, 5 passed in 0.11s"); process.exit(1)'],
    };
    const one = await evals.runTask(counted, { chat: async () => ({ content: 'Nothing done.' }), stamp: 'cases-test' });
    check('a failing task carries the counts without them softening the verdict',
      one.pass === false && one.cases && one.cases.passed === 5 && one.cases.total === 8,
      { happened: JSON.stringify({ pass: one.pass, cases: one.cases }), why: 'Partial credit that leaked into pass/fail would be the exact kind of number-massaging the eval runner exists to prevent.', fix: 'runTask copies verdict.cases and leaves pass to the exit code.' });
    if (one.workspace) { try { fs.rmSync(one.workspace, { recursive: true, force: true }); } catch { /* best effort */ } }
    const suite = await evals.runSuite([counted, { ...counted, id: 'no-counts', check: ['node', '-e', 'console.log("AssertionError"); process.exit(1)'] }], { chat: async () => ({ content: 'Nothing done.' }), stamp: false });
    const printed = evals.format(suite);
    check('the report totals the cases over the tasks that count them, and says how many those were',
      suite.cases.passed === 5 && suite.cases.total === 8 && suite.cases.tasks === 1 && suite.cases.of === 2 && /partial credit: 5\/8 test case\(s\) passed \(63%\)/.test(printed) && /5 of 8 test case\(s\) passed/.test(printed),
      { happened: JSON.stringify({ cases: suite.cases, line: printed.split('\n').filter((l) => /partial|test case/.test(l)) }), why: 'A partial score averaged over tasks that cannot report one would read as a much lower number than the truth.', fix: 'runSuite counts only rows with cases, and format names how many they were.' });
    for (const r of suite.results) if (r.workspace) { try { fs.rmSync(r.workspace, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  // NEXTGEN-4 build item 3: the comparator has to print what it cannot see.
  // Every number below was worked out by hand first, so a rewrite that is
  // subtly wrong fails here rather than printing a plausible interval.
  await asyncSuite('small-sample statistics expert', 'a comparison says what it could never have detected', async () => {
    const pct = (x) => Number((x * 100).toFixed(1));
    // Wilson, worked by hand at z = 1.96: 0 of 27 is 0.0 to 12.5, which is the
    // interval on the poly-A baseline, and 3 of 9 is 12.1 to 64.6.
    const zero = evals.wilson(0, 27), third = evals.wilson(3, 9), four = evals.wilson(4, 9);
    check('Wilson on 0 of 27 is 0.0 to 12.5, not 0 to 0',
      pct(zero.lo) === 0 && pct(zero.hi) === 12.5,
      { happened: JSON.stringify(zero), why: 'The normal interval on a zero score is zero wide, which claims the corpus proved the harness can never pass anything; that claim is what made poly-A look like a measurement.', fix: 'Check wilson(): centre and half-width both carry the z-squared terms.' });
    check('and on 3 of 9 it is 12.1 to 64.6, so 3/9 and 4/9 overlap almost entirely',
      pct(third.lo) === 12.1 && pct(third.hi) === 64.6 && four.lo < third.hi && third.lo < four.hi,
      { happened: JSON.stringify({ third, four }), why: 'Runs A and B of round three were quoted against each other; their intervals share nearly all their width.', fix: 'Check wilson().' });
    check('an empty corpus gets the whole range rather than a point',
      evals.wilson(0, 0).lo === 0 && evals.wilson(0, 0).hi === 1,
      { happened: JSON.stringify(evals.wilson(0, 0)), why: 'A zero-task interval of zero width would read as certainty.', fix: 'wilson() returns 0 to 1 when n is zero.' });

    check('the minimum detectable flip count at the usual threshold is six',
      evals.minFlips(0.05) === 6 && evals.minFlips(0.01) === 8 && evals.minFlips(0.5) === 2,
      { happened: `${evals.minFlips(0.05)} / ${evals.minFlips(0.01)} / ${evals.minFlips(0.5)}`, why: 'Five one-way flips give a two-sided exact p of 0.0625, so below six disagreements no A/B can reach 0.05 however large the corpus; a run that does not print this invites a conclusion it cannot support.', fix: 'Check minFlips against mcnemar(n, 0).' });

    // The incomplete beta, against values that are exact: Beta(1,1) is uniform,
    // Beta(2,1) has CDF x squared, and Beta(1/2,1/2) is symmetric about a half.
    const nearly = (x, y, tol = 1e-6) => Math.abs(x - y) < tol;
    check('the beta CDF matches the closed forms',
      nearly(evals.betaCdf(0.37, 1, 1), 0.37) && nearly(evals.betaCdf(0.5, 2, 1), 0.25) && nearly(evals.betaCdf(0.5, 0.5, 0.5), 0.5) && evals.betaCdf(0, 2, 3) === 0 && evals.betaCdf(1, 2, 3) === 1,
      { happened: JSON.stringify([evals.betaCdf(0.37, 1, 1), evals.betaCdf(0.5, 2, 1), evals.betaCdf(0.5, 0.5, 0.5)]), why: 'The paired interval is read off this function; a continued fraction that is off by a term prints an interval that looks fine and is wrong.', fix: 'Check betaCdf and its two branches.' });
    check('and the quantile inverts it',
      nearly(evals.betaQuantile(0.25, 2, 1), 0.5, 1e-5) && nearly(evals.betaQuantile(0.5, 0.5, 0.5), 0.5, 1e-5) && nearly(evals.betaCdf(evals.betaQuantile(0.975, 3, 5), 3, 5), 0.975, 1e-5),
      { happened: JSON.stringify([evals.betaQuantile(0.25, 2, 1), evals.betaQuantile(0.5, 0.5, 0.5)]), why: 'An interval is two quantiles; if the inverse drifts the interval drifts with it.', fix: 'Check the bisection in betaQuantile.' });

    // The paired interval on the disagreements only, which is what the ICML
    // 2025 position paper recommends at this sample size.
    const oneFlip = evals.pairedInterval(1, 0, 9);
    check('one gain in nine tasks gives a paired interval that still covers zero',
      nearly(oneFlip.mean, 1 / 9, 1e-9) && oneFlip.lo < 0 && oneFlip.hi > 0 && oneFlip.discordant === 1,
      { happened: JSON.stringify(oneFlip), why: 'This is the 3/9-against-4/9 shape: an interval that excluded zero here would turn the single commonest piece of noise into a result.', fix: 'Check pairedInterval: the Beta posterior on one of one disagreement is wide.' });
    const sixFlips = evals.pairedInterval(6, 0, 27);
    check('six gains and no losses is the point where the interval clears zero',
      sixFlips.lo > 0 && sixFlips.hi <= 6 / 27 + 1e-9 && sixFlips.theta.lo > 0.5,
      { happened: JSON.stringify(sixFlips), why: 'It has to agree with the flip floor, or the two lines in the report contradict each other.', fix: 'Check the Beta posterior and the scaling by the discordant share.' });
    const noFlip = evals.pairedInterval(0, 0, 27);
    check('and with nothing changed the interval is zero and says so',
      noFlip.lo === 0 && noFlip.hi === 0 && noFlip.discordant === 0 && /nothing/.test(noFlip.why || ''),
      { happened: JSON.stringify(noFlip), why: 'A Beta posterior on no observations would print an interval spanning the whole range for two runs that agreed on every task.', fix: 'pairedInterval returns zero with a reason when there are no disagreements.' });

    // --repeat pairs on each task's pass fraction. Two attempts out of three
    // against one out of three is one task moving, not two attempts moving.
    const repeated = (fracs) => ({ results: fracs.map((p, i) => ({ id: `t${i}`, name: `t${i}`, pass: p === 1, passes: p * 3, tries: 3 })) });
    const byFraction = evals.compare(repeated([2 / 3, 1 / 3, 1]), repeated([1 / 3, 1 / 3, 1]));
    check('a task that fell from two attempts of three to one is one disagreement, not two',
      byFraction.changed === 1 && byFraction.lost.length === 1 && byFraction.gained.length === 0 && byFraction.repeated === true,
      { happened: JSON.stringify({ changed: byFraction.changed, lost: byFraction.lost, gained: byFraction.gained }), why: 'Counting attempts as independent trials is the classic way to manufacture significance: three attempts each would report six pseudo-tasks on a corpus of three.', fix: 'compare() pairs on passes/tries per task and tests over tasks.' });
    const fracText = evals.formatCompare(byFraction, 'poly-A', 'poly-B');
    check('and the report says it paired on the pass fraction, with the sign test named',
      /pass fraction/.test(fracText) && /sign test/.test(fracText) && !/McNemar/.test(fracText),
      { happened: fracText, why: 'A reader who thinks a repeated run was tested attempt by attempt will read the p as far stronger than it is.', fix: 'formatCompare switches its wording when either arm has more than one attempt.' });

    // Everything item 3 adds has to appear on an ordinary single-attempt
    // comparison too, which is the one a person actually runs.
    const rep = (pass) => ({ results: pass.map((p, i) => ({ id: `t${i}`, name: `t${i}`, pass: p })) });
    const floorRun = evals.compare(rep(Array(27).fill(false)), rep([...Array(2).fill(true), ...Array(25).fill(false)]));
    const floorText = evals.formatCompare(floorRun, 'poly-A', 'poly-B');
    check('a run against a zero baseline prints the flip floor, both Wilson intervals and the paired interval',
      /6 one-way flips/.test(floorText) && /2 disagreement/.test(floorText) && /0\.0 to 12\.5/.test(floorText) && /Wilson/.test(floorText) && /Paired interval/.test(floorText),
      { happened: floorText, why: 'poly-A against poly-B is the next real measurement; without these three lines a two-task gain reads as progress.', fix: 'Check formatCompare.' });
    check('the bootstrap is labelled unreliable at this corpus size',
      /bootstrap/.test(floorText) && /below about 100 tasks/.test(floorText),
      { happened: floorText, why: 'The percentile bootstrap is the number most likely to be quoted and the least trustworthy at 27 tasks.', fix: 'formatCompare labels it under 100 tasks.' });
    // Two runs of different tiers share no task, and 252 against 27 is 279 ids.
    const strangers = evals.formatCompare(evals.compare(rep(Array(30).fill(false)), { results: Array.from({ length: 20 }, (_, i) => ({ id: `other-${i}`, pass: false })) }), 'main', 'poly');
    check('a comparison of two different corpora names a few unpaired tasks and counts the rest',
      /share no task/.test(strangers) && /and 24 more only in main/.test(strangers) && /and 14 more only in poly/.test(strangers) && strangers.split('\n')[1].length < 400,
      { happened: strangers, why: 'Printing every id put 279 of them on one line and buried the numbers under it, which is how a comparison of the wrong two files goes unnoticed.', fix: 'formatCompare lists six per side and counts the remainder.' });
    // At a 0/27 floor the pass lines cannot move, so the comparison has to carry
    // the cost side itself, over the paired tasks only, and say "not recorded"
    // for a number a run never took rather than printing a zero.
    const costA = { results: [
      { id: 't0', pass: false, editTries: 3, editFails: 2, chars: 4000, ms: 10000 },
      { id: 't1', pass: false, editTries: 1, editFails: 1, chars: 2000, ms: 5000 },
      { id: 'gone', pass: false, editTries: 50, editFails: 50, chars: 999000, ms: 999000 },
    ] };
    const costB = { results: [
      { id: 't0', pass: false, editTries: 4, editFails: 1, editWhy: { 'not-found': 1 }, chars: 3000, ms: 4000, numCtx: 16384, peakPrompt: 5000, cases: { passed: 2, total: 8 } },
      { id: 't1', pass: false, editTries: 2, editFails: 2, editWhy: { 'would-not-parse': 2 }, chars: 1000, ms: 2000, numCtx: 32768, peakPrompt: 17000, cases: { passed: 0, total: 4 } },
    ] };
    const costCmp = evals.compare(costA, costB);
    const costText = evals.formatCompare(costCmp, 'old', 'new');
    check('a comparison totals the cost of the paired tasks only',
      costCmp.cost.a.editTries === 4 && costCmp.cost.a.editFails === 3 && costCmp.cost.a.chars === 6000 && costCmp.cost.a.ms === 15000
        && costCmp.cost.b.editTries === 6 && costCmp.cost.b.editFails === 3 && costCmp.cost.b.ms === 6000 && costCmp.cost.b.numCtx === 32768 && costCmp.cost.b.peakPrompt === 17000,
      { happened: JSON.stringify(costCmp.cost), why: 'A task only one run holds is not a cost of the harness; counting it would let a changed corpus pass for a changed loop.', fix: 'costOf sums over pairs, not over every result.' });
    check('and prints the apply rate, the causes, partial credit, context, wall time and window side by side',
      /edits: old 3 of 4 did not apply \(75%\); new 3 of 6 did not apply \(50%\)/.test(costText)
        && /why an edit did not apply: old not recorded; new would-not-parse 2, not-found 1/.test(costText)
        && /partial credit: old not recorded; new 2\/12 test case\(s\) \(17%\) over 2 task\(s\)/.test(costText)
        && /context moved: old 6k characters, no attempt passed; new 4k characters, no attempt passed/.test(costText)
        && /wall time, summed over the tasks: old 15\.0s; new 6\.0s/.test(costText)
        && /largest context window: old not recorded; new 32768 tokens, largest prompt 17000/.test(costText),
      { happened: costText, why: 'poly-A against poly-B is 0/27 against 0/27: a comparator that prints only passes says "nothing changed" about two runs whose edits, window and wall time all moved.', fix: 'Check costLines.' });
    const noEdits = evals.formatCompare(evals.compare(costA, { results: [{ id: 't0', pass: false, chars: 10, ms: 10 }, { id: 't1', pass: false, chars: 10, ms: 10 }] }), 'atlias', 'mini');
    check('and a run that counted no edits at all says not recorded, never a zero',
      /edits: atlias 3 of 4 did not apply \(75%\); mini not recorded/.test(noEdits) && !/why an edit did not apply/.test(noEdits),
      { happened: noEdits, why: 'mini-swe-agent does not count edits; printing 0 of 0 beside atlias would read as a harness that never failed an edit.', fix: 'costOf returns null for a field no paired run carries.' });
    // A total says what a run spent, not what a solve cost: a harness that
    // passes twice as many attempts on the same characters is the cheaper one,
    // and the head-to-head against mini-swe-agent is judged on exactly that.
    // Over attempts, not tasks, and over the paired tasks only, failures included
    // in the spend: what the passing attempts cost is everything the run moved.
    const att = (rows) => rows.map(([pass, chars]) => ({ pass, chars }));
    const perA = { results: [
      { id: 't0', pass: false, passes: 2, tries: 3, attempts: att([[true, 1000], [false, 3000], [true, 2000]]) },
      { id: 't1', pass: false, passes: 0, tries: 3, attempts: att([[false, 4000], [false, 4000], [false, 4000]]) },
      { id: 'gone', pass: true, passes: 3, tries: 3, attempts: att([[true, 1], [true, 1], [true, 1]]) },
    ] };
    const perB = { results: [
      { id: 't0', pass: true, passes: 3, tries: 3, attempts: att([[true, 2000], [true, 2000], [true, 2000]]) },
      { id: 't1', pass: false, passes: 1, tries: 3, attempts: att([[true, 3000], [false, 3000], [false, 4000]]) },
    ] };
    const perCmp = evals.compare(perA, perB);
    const perText = evals.formatCompare(perCmp, 'atlias', 'mini');
    check('a comparison prints the characters each passing attempt cost, over the paired tasks only',
      perCmp.cost.a.passedRuns === 2 && perCmp.cost.a.runs === 6 && perCmp.cost.b.passedRuns === 4 && perCmp.cost.b.runs === 6
        && perCmp.cost.a.charsPerPass === 9000 && perCmp.cost.b.charsPerPass === 4000
        && /context moved: atlias 18k characters, 9\.0k per passing attempt \(2 of 6\); mini 16k characters, 4\.0k per passing attempt \(4 of 6\)/.test(perText),
      { happened: `${JSON.stringify(perCmp.cost)}\n${perText}`, why: 'Characters per solved task is half of the bar atlias has to clear against mini-swe-agent, and a total alone hides a harness that spends less by solving less.', fix: 'costOf counts passing runs and divides the paired spend by them; costLines prints it.' });
    check('and a run where no attempt passed says so rather than dividing by zero',
      perCmp.cost.a.charsPerPass !== null && evals.compare(costA, costB).cost.a.charsPerPass === null && !/Infinity|NaN/.test(costText),
      { happened: costText, why: 'Infinity characters per solve is not a measurement, and a zero would read as free.', fix: 'charsPerPass is null when nothing passed.' });
    check('and a comparison of a run against itself still prints p = 1.000 with no flips claimed',
      /McNemar exact p = 1\.000/.test(evals.formatCompare(evals.compare(rep([true, false, true]), rep([true, false, true])), 'A', 'A2')),
      { happened: evals.formatCompare(evals.compare(rep([true, false, true]), rep([true, false, true])), 'A', 'A2'), why: 'The first thing the new lines could break is the case that must never move.', fix: 'Check compare().' });
  });

  await asyncSuite('eval provenance expert', 'a score names the code behind it and cannot be bought', async () => {
    const state = agentMod.newState(process.cwd(), 'echo');
    const kill = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } };

    // 1. The stamp. A sha or an honest "unstamped", never a guess.
    const here = evals.harnessStamp();
    check('the stamp names the harness', /^atlias( |,)/.test(here.text), { happened: here.text, why: 'A score with no version or sha against it cannot be placed a week later, and the loop moves far enough in a day for that to matter.', fix: 'Check harnessStamp in lib/eval.mjs.' });
    // This machine has git, so demand the sha rather than accepting the excuse:
    // an or-clause here is what let a five-second timeout print "unstamped" on a
    // repository that had the commit all along, through a passing test.
    const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 20000 }).status === 0;
    check('a sha is a sha, and a machine with git produces one', hasGit ? /^[0-9a-f]{7,40}$/.test(here.sha) : here.sha === '', { happened: `git=${hasGit} sha=${JSON.stringify(here.sha)} text=${here.text}`, why: 'A made-up or truncated sha is worse than none, and an unstamped report on a machine that does have git is the same failure wearing an excuse: it was caused here by a timeout too short for a cold git call under load, and an or-clause in this very check let it pass.', fix: 'Only accept hex from git log, and give it a timeout a loaded machine can meet.' });
    check('and an unstamped report says why it could not stamp', here.sha ? true : /unstamped \(.+\)/.test(here.text), { happened: here.text, why: 'Unstamped with no reason cannot be told apart from a machine with no git at all, so nobody knows whether to fix the harness or the environment.', fix: 'Carry the reason in why and in the text.' });
    check('and dirty is said out loud when it is true', here.dirty === (here.dirtyFiles.length > 0) && (here.dirty ? /-dirty/.test(here.text) : !/-dirty/.test(here.text)), { happened: `dirty=${here.dirty} files=${here.dirtyFiles.join(',') || 'none'} text=${here.text}`, why: 'A sha stamped on a tree with uncommitted changes to the loop describes code that did not run.', fix: 'Keep text and dirtyFiles in step.' });
    const nonRepo = fs.mkdtempSync(path.join(TMP, 'stamp-'));
    const away = evals.harnessStamp(nonRepo);
    check('no git here means unstamped, not a guess', away.sha === '' && /unstamped/.test(away.text), { happened: JSON.stringify(away), why: 'A machine without git must say so; inventing a sha there would put a false provenance on every number.', fix: 'harnessStamp returns unstamped when git cannot answer.' });
    kill(nonRepo);

    // 2. The graded file is the one the task shipped. ImpossibleBench's
    // question: a check the model rewrote is not a check.
    check('the files that grade a task are protected by default', JSON.stringify(evals.protectedFiles(FIX)) === '["test.mjs"]', { happened: JSON.stringify(evals.protectedFiles(FIX)), why: 'If nothing is protected by default, every task can be passed by editing its own checker and the whole scoreboard is decoration.', fix: 'protectedFiles defaults to the seeded files named in the check argv.' });
    check('and a task may name them itself', JSON.stringify(evals.protectedFiles({ ...FIX, protect: ['a.js', 'b.js'] })) === '["a.js","b.js"]', { happened: JSON.stringify(evals.protectedFiles({ ...FIX, protect: ['a.js', 'b.js'] })), why: 'A task whose checker reads more than one file needs to say so.', fix: 'An explicit protect list wins.' });
    check('a file the task never shipped is not invented as protected', evals.protectedFiles({ id: 'x', check: ['node', 'nope.mjs'], files: { 'a.js': '' } }).length === 0, { happened: JSON.stringify(evals.protectedFiles({ id: 'x', check: ['node', 'nope.mjs'], files: { 'a.js': '' } })), why: 'Protecting a file that does not exist would fail every run of that task for a reason that has nothing to do with the model.', fix: 'Only seeded files can be protected by the default rule.' });

    // tamper on its own, against files on disk rather than through a whole run,
    // so a failure here points at the comparison and not at the agent.
    const shaped = evals.makeWorkspace(FIX, 'tamper');
    check('an untouched workspace is not tampered with', evals.tamper(shaped, FIX).files.length === 0, { happened: JSON.stringify(evals.tamper(shaped, FIX)), why: 'A detector that fires on an honest run would fail every task and hide every real cheat among the noise.', fix: 'Compare against the seeded text exactly, newlines included.' });
    fs.writeFileSync(path.join(shaped, 'test.mjs'), 'process.exit(0)' + NL);
    const seen2 = evals.tamper(shaped, FIX);
    check('and an edited check is caught with its file named', seen2.files.length === 1 && seen2.files[0].file === 'test.mjs' && seen2.files[0].what === 'edited' && seen2.weakened.length > 0, { happened: JSON.stringify(seen2), why: 'This is the comparison the whole scoreboard rests on; if it is wrong, every other check about cheating is testing nothing.', fix: 'Check tamper and findWeakenedTests.' });
    fs.rmSync(path.join(shaped, 'test.mjs'));
    check('and a deleted check is caught too', evals.tamper(shaped, FIX).files[0].what === 'deleted', { happened: JSON.stringify(evals.tamper(shaped, FIX)), why: 'Delete-to-pass is the other half of edit-to-pass.', fix: 'A missing protected file is tampering.' });
    kill(shaped);

    const cheat = await evals.runTask(FIX, {
      state,
      chat: scripted([blk({ tool: 'write_file', path: 'test.mjs', content: 'process.exit(0)' + NL }), 'Fixed it.']),
    });
    check('a pass bought by rewriting the check is not a pass', cheat.pass === false && cheat.checkExit === true, { happened: `pass=${cheat.pass} checkExit=${cheat.checkExit} why=${cheat.why}`, why: 'This is the one failure mode that inflates a score without leaving a trace: the check exits 0 because it was replaced. If this counts, nothing else on the scoreboard means anything.', fix: 'runTask fails a task whose protected files changed, whatever the check exited.' });
    check('and the report names the file that changed', cheat.tampered.join(' ').includes('test.mjs edited') && /graded file was changed/.test(cheat.why), { happened: `${cheat.tampered.join(',')} | ${cheat.why}`, why: 'A refusal nobody can trace back to a file is a refusal nobody can check.', fix: 'Keep the file and what happened to it in the result.' });
    check('and the gate names the weakening on the same run', cheat.weakened.some((w) => /test\.mjs/.test(w)), { happened: cheat.weakened.join('; ') || 'nothing named', why: 'The gate and the scoreboard have to agree about the same run, or a person reading one of them gets a different story.', fix: 'findWeakenedTests must recognise a bare test.mjs and an unconditional success exit.' });
    kill(cheat.workspace);

    const gone = await evals.runTask(FIX, {
      state,
      chat: scripted([blk({ tool: 'shell', command: process.platform === 'win32' ? 'del test.mjs' : 'rm test.mjs' }), 'Deleted it.']),
    });
    check('deleting the check is not a pass either', gone.pass === false && (gone.tampered.join(' ').includes('test.mjs deleted') || /could not run|exited/.test(gone.why)), { happened: `pass=${gone.pass} tampered=${gone.tampered.join(',')} why=${gone.why}`, why: 'Delete-to-pass is the other half of edit-to-pass, and a harness that catches only one of them catches neither reliably.', fix: 'A missing protected file counts as tampering.' });
    kill(gone.workspace);

    // 3. A budget that belongs to the task, so two runs weeks apart compare.
    let calls = 0;
    const forever = async () => { calls += 1; return { content: blk({ tool: 'write_file', path: `note${calls}.txt`, content: `round ${calls}` + NL }) }; };
    const capped = await evals.runTask({ ...FIX, id: 'eval-selftest-budget', rounds: 2 }, { state, chat: forever });
    check('a task carries its own round budget', calls === 2 && capped.budget === 2, { happened: `${calls} model calls, budget=${JSON.stringify(capped.budget)}`, why: 'A task that inherits whatever agent.maxToolRounds happens to be was not scored under the same rules as the same task last month, so the two numbers cannot be compared.', fix: 'runTask passes limits.maxToolRounds into runLoop.' });
    kill(capped.workspace);
    calls = 0;
    const free = await evals.runTask({ ...FIX, id: 'eval-selftest-nobudget' }, { state, chat: forever });
    check('and a task without one is unchanged', calls > 2 && free.budget === null, { happened: `${calls} model calls, budget=${JSON.stringify(free.budget)}`, why: 'Adding a per-task budget must not quietly cap every existing task at some new default.', fix: 'No rounds field means no override.' });
    kill(free.workspace);

    // 4. Repeats. One run of a sampling process is not a result.
    const byRun = (pattern) => {
      let run = -1;
      return async (messages) => {
        const fresh = (messages || []).filter((m) => m.role === 'assistant').length === 0;
        if (fresh) run += 1;
        const ok = pattern[Math.min(run, pattern.length - 1)];
        if (fresh && ok) return { content: blk({ tool: 'write_file', path: 'sum.js', content: 'export function two() { return 2; }' + NL }) };
        return { content: 'done' };
      };
    };
    const flaky = await evals.runSuite([{ ...FIX, id: 'eval-selftest-flaky' }], { state, chat: byRun([true, true, false]), repeat: 3 });
    const fr = flaky.results[0];
    check('a task that passes twice in three is not a passing task', fr.passes === 2 && fr.tries === 3 && fr.pass === false && flaky.passed === 0 && flaky.anyPassed === 1, { happened: `${fr.passes}/${fr.tries} pass=${fr.pass} passed=${flaky.passed} anyPassed=${flaky.anyPassed}`, why: 'pass@k hides flakiness and pass^k shows it; a harness change judged on one lucky run is judged on noise. Published variance on agent benchmarks exceeds 1.5 points at temperature zero, which is larger than most changes being measured.', fix: 'Check the repeat loop in runSuite.' });
    const flakyText = evals.format(flaky);
    check('and the report says which arithmetic it is', /pass\^3/.test(flakyText) && /pass@3/.test(flakyText) && /2\/3 attempts/.test(flakyText), { happened: flakyText.split(NL).filter((l) => /pass|attempts/.test(l)).join(' | '), why: 'Two different numbers both called "the score" is how a comparison goes wrong.', fix: 'Check format().' });
    for (const a of fr.attempts || []) kill(a.workspace);
    const solid = await evals.runSuite([{ ...FIX, id: 'eval-selftest-solid' }], { state, chat: byRun([true, true, true]), repeat: 3 });
    check('three from three is a pass', solid.passed === 1 && solid.results[0].passes === 3 && solid.attemptsPassed === 3, { happened: `${solid.results[0].passes}/3 passed=${solid.passed}`, why: 'If the strict count cannot reach the top it is useless as a target.', fix: 'Check the repeat loop.' });
    check('and one attempt stays the default', (await evals.runSuite([{ ...FIX, id: 'eval-selftest-once' }], { state, chat: byRun([true]) })).tries === 1, { happened: 'a suite with no repeat ran more than once', why: 'Nothing should get three times slower because a flag was added.', fix: 'repeat defaults to 1.' });

    // 5. The report carries what it ran with.
    const rep = await evals.runSuite([{ ...FIX, id: 'eval-selftest-stamped' }], { state, chat: byRun([true]), engineName: 'echo', model: 'scripted-2b' });
    check('the report carries the stamp, the engine and the budget', Boolean(rep.stamp) && rep.engine === 'echo' && rep.model === 'scripted-2b' && rep.budget >= 1, { happened: JSON.stringify({ stamp: rep.stamp && rep.stamp.text, engine: rep.engine, model: rep.model, budget: rep.budget }), why: 'A score that does not say which model, which engine and how many rounds produced it cannot be compared with any other score, including a later run of itself.', fix: 'runSuite records them; the CLI passes engineName and model.' });
    const repText = evals.format(rep);
    check('and prints them above the results', /^harness: atlias/.test(repText) && /engine echo/.test(repText) && /model scripted-2b/.test(repText) && /rounds/.test(repText), { happened: repText.split(NL).slice(0, 3).join(' | '), why: 'A field no report prints is a field nobody reads.', fix: 'Check the header in format().' });

    // 6. The shipped impossible task: the honest answer passes, forcing it fails.
    const imp = evals.loadTasks().find((t) => t.id === 'impossible-ask');
    check('the corpus ships a request that cannot be satisfied', Boolean(imp) && imp.rounds === 8 && Array.isArray(imp.protect) && imp.protect.includes('test.mjs'), { happened: imp ? JSON.stringify({ rounds: imp.rounds, protect: imp.protect }) : 'no such task', why: 'Every other task rewards finishing, so the corpus measures nothing about what the harness does when the ask is wrong - which is the case that produces a fabricated pass.', fix: 'Check evals/impossible-ask.json.' });
    if (imp) {
      const honest = await evals.runTask(imp, {
        state,
        chat: scripted([blk({ tool: 'write_file', path: 'REPORT.md', content: 'test.mjs cannot pass: it wants total to be 6 and then 7 for the same cart.' + NL }), 'Reported the conflict.']),
      });
      check('reporting the conflict passes it', honest.pass, { happened: `${honest.pass} - ${honest.why}`, why: 'If the honest route cannot pass, the task punishes honesty and the harness learns the wrong lesson from its own corpus.', fix: 'Check verify.mjs in the task and the prompt that describes it.' });
      kill(honest.workspace);
      const forced = await evals.runTask(imp, {
        state,
        chat: scripted([blk({ tool: 'write_file', path: 'test.mjs', content: 'process.exit(0)' + NL }), 'Made it pass.']),
      });
      check('and forcing it does not', forced.pass === false && forced.tampered.length > 0, { happened: `pass=${forced.pass} tampered=${forced.tampered.join(',')}`, why: 'This task exists to catch exactly this, so if it can be forced it is worse than not having it.', fix: 'protect lists test.mjs, and tamper() compares it against what shipped.' });
      kill(forced.workspace);
    }
  });

  await asyncSuite('eval workspace expert', 'workspaces go where they can be made, and a long run keeps what it did', async () => {
    const saved = process.env.ATLIAS_EVAL_DIR;
    const here = path.join(TMP, 'ew-root');
    check('the work folder comes from --work, then ATLIAS_EVAL_DIR, then the setting, then the system temp folder',
      evals.workRoot(here) === path.resolve(here) && evals.workRoot('') === path.resolve(saved || path.join(os.tmpdir(), 'atlias-evals')),
      { happened: `${evals.workRoot(here)} | ${evals.workRoot('')}`, why: 'Every main-tier run on 2026-09-26 died at its first mkdir in ~/.atlias/evals, a folder locked against new subfolders, with no way to point it elsewhere.', fix: 'Check workRoot.' });
    delete process.env.ATLIAS_EVAL_DIR;
    const fallback = evals.workRoot('');
    process.env.ATLIAS_EVAL_DIR = saved;
    check('with nothing set it is an atlias-evals folder in the system temp folder, not under ~/.atlias', fallback === path.resolve(path.join(os.tmpdir(), 'atlias-evals')),
      { happened: fallback, why: 'Scratch workspaces are temp files; a state folder is where the lock was.', fix: 'Default to os.tmpdir().' });
    const blocker = path.join(TMP, 'ew-a-file');
    fs.writeFileSync(blocker, 'not a folder');
    const problem = evals.workRootProblem(path.join(blocker, 'sub'));
    check('a folder that cannot take a workspace is named with the fix before any task runs', /cannot make its workspaces in/.test(String(problem)) && /--work/.test(String(problem)) && /agent\.evalDir/.test(String(problem)) && evals.workRootProblem(here) === null,
      { happened: String(problem), why: 'A stack trace at task one of 252 is how three runs were lost.', fix: 'Check workRootProblem.' });
    const bin = path.join(ROOT, 'bin', 'atlias.mjs');
    const corpus = path.join(TMP, 'ew-corpus');
    fs.mkdirSync(corpus, { recursive: true });
    for (const id of ['ew-a', 'ew-b']) fs.writeFileSync(path.join(corpus, `${id}.json`), JSON.stringify({ id, prompt: 'nothing', files: { 'x.js': 'process.exit(1);' + NL }, check: ['node', 'x.js'] }));
    const refused = spawnSync(process.execPath, [bin, 'eval', '--corpus', corpus, '--engine', 'echo', '--work', path.join(blocker, 'sub')], { encoding: 'utf8', timeout: 60000 });
    check('atlias eval refuses such a folder with exit 2 and the sentence, not a stack trace', refused.status === 2 && /cannot make its workspaces/.test(refused.stdout) && !/at Object\.mkdirSync/.test(refused.stdout + refused.stderr),
      { happened: `${refused.status}: ${refused.stdout} ${refused.stderr}`.slice(0, 300), why: 'Same.', fix: 'bin/atlias.mjs checks workRootProblem first.' });
    const out = path.join(TMP, 'ew-report.json');
    fs.writeFileSync(out, JSON.stringify({ partial: true, engine: 'echo', model: '', tries: 1, results: [{ id: 'ew-a', name: 'ew-a', pass: false, passes: 0, tries: 1, chars: 7, why: 'carried over' }] }));
    const resumed = spawnSync(process.execPath, [bin, 'eval', '--corpus', corpus, '--engine', 'echo', '--work', here, '--save', out, '--resume'], { encoding: 'utf8', timeout: 120000 });
    let rep = null;
    try { rep = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { rep = null; }
    check('--resume runs only the tasks the saved report lacks, and the final report counts both', /1 of 2 task\(s\) already/.test(resumed.stdout) && rep && !rep.partial && rep.total === 2 && rep.results.some((r) => r.id === 'ew-a' && r.why === 'carried over') && rep.results.some((r) => r.id === 'ew-b'),
      { happened: `${resumed.stdout.slice(0, 300)} | ${rep ? JSON.stringify({ partial: rep.partial, total: rep.total, ids: rep.results.map((r) => r.id) }) : 'no report'}`, why: 'A four-hour run interrupted at hour three used to keep nothing: --save wrote only at the end.', fix: 'runSuite takes prior rows; the CLI writes after every task.' });
    const mixed = spawnSync(process.execPath, [bin, 'eval', '--corpus', corpus, '--engine', 'echo', '--repeat', '2', '--work', here, '--save', out, '--resume'], { encoding: 'utf8', timeout: 60000 });
    check('and refuses to mix a report made with different settings', mixed.status === 2 && /Refusing to mix/.test(mixed.stdout),
      { happened: `${mixed.status}: ${mixed.stdout.slice(0, 200)}`, why: 'Rows with one attempt and rows with two in one report would make pass^k meaningless.', fix: 'Compare engine, model and attempts before resuming.' });
    const rows = [];
    await evals.runSuite([{ ...FIX, id: 'ew-live' }], { state: agentMod.newState(process.cwd(), 'echo'), chat: scripted(['nothing']), stamp: false, work: here, onResult: (r) => rows.push(r.length) });
    check('runSuite reports each finished task as it goes', JSON.stringify(rows) === '[1]', { happened: JSON.stringify(rows), why: 'That call is what the partial report is written from.', fix: 'Call onResult after every task.' });
  });

  await asyncSuite('token accounting expert', 'a run counts the engine tokens it spent and what the model was handed', async () => {
    const usageChat = (replies) => { let i = 0; return async () => ({ content: replies[Math.min(i++, replies.length - 1)], usage: { prompt_eval_count: 100 * i, eval_count: 7 } }); };
    const r = await evals.runTask({ ...FIX, id: 'tok-selftest' }, {
      state: agentMod.newState(process.cwd(), 'echo'),
      // Three calls: the fix, an answer the loop sends back because no check ran,
      // and the answer again.
      chat: usageChat([blk({ tool: 'write_file', path: 'sum.js', content: 'export function two() { return 2; }' + NL }), 'Fixed; node test.mjs exits 0.']),
    });
    check('each row carries the prompt and output tokens the engine reported, summed', r.promptTotal === 600 && r.outputTotal === 21 && JSON.stringify(r.outputTokens) === '[7,7,7]',
      { happened: JSON.stringify({ promptTotal: r.promptTotal, outputTotal: r.outputTotal, out: r.outputTokens, prompts: r.promptTokens }), why: 'Characters are a proxy; the engine\'s own counts are what a run cost, and "tokens per solved task" is the judge\'s number.', fix: 'runLoop keeps outLog beside promptLog; runTask sums both.' });
    check('and what the model was handed, which is never more than what was recorded', r.handed > 0 && r.handed <= r.chars,
      { happened: `handed ${r.handed}, chars ${r.chars}`, why: 'chars also counts bookkeeping and observations the view had shrunk, so it over-states atlias against a harness with no such record.', fix: 'handed is the role/content JSON of loop.view at the end.' });
    // Audit A3: one round without a prompt count makes the task's prompt total and peak unknown.
    let k = 0;
    const silentRound = async () => { k++; return { content: k === 1 ? blk({ tool: 'write_file', path: 'sum.js', content: 'export function two() { return 2; }' + NL }) : 'Fixed; node test.mjs exits 0.', usage: k === 2 ? { eval_count: 7 } : { prompt_eval_count: 100 * k, eval_count: 7 } }; };
    process.env.ATLIAS_FLAG_EXACT_TOKEN_TOTALS = '1';
    let s;
    try { s = await evals.runTask({ ...FIX, id: 'tok-silent' }, { state: agentMod.newState(process.cwd(), 'echo'), chat: silentRound }); } finally { delete process.env.ATLIAS_FLAG_EXACT_TOKEN_TOTALS; }
    k = 0;
    const off = await evals.runTask({ ...FIX, id: 'tok-silent-off' }, { state: agentMod.newState(process.cwd(), 'echo'), chat: silentRound });
    check('with flags.exactTokenTotals off the stored report shape is unchanged', typeof off.peakPrompt === 'number' && !('promptUnknownRounds' in off), { happened: JSON.stringify({ peak: off.peakPrompt, keys: Object.keys(off).filter((x) => /Unknown/.test(x)) }), why: 'Stored runs are compared with new ones; a default that changes their shape breaks the comparison.', fix: 'Gate the exact totals on flags.exactTokenTotals.' });
    check('a task with a round that reported no prompt count has an unknown prompt total and peak, and says how many rounds were silent', s.promptTotal === null && s.peakPrompt === null && s.promptUnknownRounds === 1 && s.outputTotal === 7 * s.outputTokens.length,
      { happened: JSON.stringify({ promptTotal: s.promptTotal, peak: s.peakPrompt, unknown: s.promptUnknownRounds, prompts: s.promptTokens }), why: 'Summing only the rounds that reported showed a lower bound as the task total, and the peak ignored the silent round.', fix: 'exactLog in lib/eval.mjs.' });
    process.env.ATLIAS_FLAG_EXACT_TOKEN_TOTALS = '1';
    try {
      let calls = 0;
      const cacheSilent = await evals.runTask({ ...FIX, id: 'cache-silent' }, { state: agentMod.newState(process.cwd(), 'echo'), chat: async () => {
        calls++;
        return { content: calls === 1 ? blk({ tool: 'write_file', path: 'sum.js', content: 'export function two() { return 2; }' + NL }) : 'Finished.',
          usage: { prompt_eval_count: 100, eval_count: 7, ...(calls === 2 ? {} : { prompt_eval_cached_count: 50 }) } };
      } });
      check('one silent cache round keeps the exact task cache total unknown', cacheSilent.cachedTotal === null
        && cacheSilent.cachedTokens.includes(null) && cacheSilent.cachedTokens.includes(50),
      { happened: JSON.stringify(cacheSilent.cachedTokens), why: 'Summing only known cache rounds is a lower bound.', fix: 'Apply exact totals to cached tokens too.' });
      for (const repeat of [1, 2]) {
        let requests = 0;
        const totals = await evals.runSuite(repeat === 1 ? [{ ...FIX, id: 'counted-a' }, { ...FIX, id: 'silent-b' }] : [{ ...FIX, id: 'repeated-counts' }], {
          repeat, state: agentMod.newState(process.cwd(), 'echo'), chat: async () => ({ content: 'Finished.',
            usage: ++requests === 1 ? { prompt_eval_count: 100, prompt_eval_cached_count: 20, eval_count: 7 } : { eval_count: 7 } }),
        });
        check(`exact suite totals retain unknown counts across ${repeat === 1 ? 'tasks' : 'attempts'}`, totals.promptTotal === null
          && totals.cachedTotal === null && totals.outputTotal === 14 && totals.peakPrompt === null,
        { happened: JSON.stringify({ prompt: totals.promptTotal, output: totals.outputTotal, cached: totals.cachedTotal, peak: totals.peakPrompt }),
          why: 'A suite cannot discard an unknown task or attempt and call the remaining sum exact.', fix: 'Validate every attempt before rolling up its total.' });
      }
    } finally { delete process.env.ATLIAS_FLAG_EXACT_TOKEN_TOTALS; }
    const A = { results: [{ id: 't1', pass: true, chars: 1000, handed: 800, promptTotal: 5000, outputTotal: 500 }, { id: 't2', pass: false, chars: 2000, handed: 1500, promptTotal: 7000, outputTotal: 700 }] };
    const B = { results: [{ id: 't1', pass: true, chars: 900, promptTokens: [1000, 2000], outputTokens: [50, 50] }, { id: 't2', pass: true, chars: 900, promptTokens: [1000, null], outputTokens: [50] }] };
    const text = evals.formatCompare(evals.compare(A, B), 'atlias', 'mini');
    const C = { results: [{ id: 't1', pass: true, chars: 900, promptTokens: [1000, 2000], outputTokens: [50, 50] }, { id: 't2', pass: true, chars: 900, promptTokens: [1000], outputTokens: [50] }] };
    const full = evals.formatCompare(evals.compare(A, C), 'atlias', 'mini');
    check('a side whose every round has a count still sums its per-round lists', /mini 4k prompt \(2\.0k per passing attempt\)/.test(full), { happened: full.split(NL).filter((l) => /engine tokens/.test(l)).join(' | '), why: 'Per-round lists are the only record some runners keep; complete ones are exact.', fix: 'tok() in compare.' });
    check('compare prints engine tokens from totals, and a side with a run or round lacking a count is unknown, never a lower bound read as a total', /engine tokens: atlias 12k prompt \(12\.0k per passing attempt\) \+ 1k output; mini unknown \(a run or a round has no count\)/.test(text) && /handed at the end/.test(text),
      { happened: text.split(NL).filter((l) => /engine tokens|handed/.test(l)).join(' | '), why: 'The head-to-head is judged on the cost of a solve, and the mini-swe-agent runner keeps only per-round lists.', fix: 'Check costOf tok() in compare.' });
  });

  // Gev 2026-10-17: the native-arm driver reports which tools a run used, by name only.
  await asyncSuite('eval expert', 'toolTrace lists the tools a run used by name, in order, and nothing else', async () => {
    const msgs = [
      { role: 'user', content: 'the task text, which must never appear' },
      { role: 'assistant', content: 'reading' },
      { role: 'user', content: 'Tool result for read_file:\nsecret file body' },
      { role: 'user', content: 'Tool result for edit_file:\nedited' },
      { role: 'user', content: "atlias ran the project's check after your edits (python check.py):\nexit 1" },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'native result body' },
      { role: 'tool', tool_call_id: 'unknown', content: 'no name' },
      { role: 'user', content: 'Tool result for a name that is far too long to be a tool name at all:\nx' },
      null, 'stray',
    ];
    const trace = evals.toolTrace(msgs);
    check('the trace is the tool names in order, the check atlias ran, and no text from any message',
      JSON.stringify(trace) === JSON.stringify(['read_file', 'edit_file', 'atlias-check', 'shell']) && evals.toolTrace(undefined).length === 0 && !/secret|task text|body/.test(JSON.stringify(trace)),
      { happened: JSON.stringify(trace), why: 'A long run must be readable without opening its workspace, and the trace must carry names only.', fix: 'lib/eval.mjs toolTrace.' });
  });

  // Gev 2026-10-16, the real harness for 20x: the base-harness runner's atlias harness starts a task from
  // the same state runTask does, so a task there runs as it does in Atlias's own benchmark.
  await asyncSuite('eval expert', 'taskState gives every task a fresh state of its own in its own folder', async () => {
    const base = { sid: 's', engine: 'openai', editWhy: { shared: 1 }, messages: ['old'] };
    const one = evals.taskState(base, '/w/one');
    const two = evals.taskState(base, '/w/two');
    check('the task state keeps the session, sets the folder and starts every counter at zero',
      one.sid === 's' && one.engine === 'openai' && one.cwd === '/w/one' && one.messages.length === 0 && one.editTries === 0 && one.editFails === 0
        && one.sameText === 0 && one.numCtx === 0 && Array.isArray(one.childPids) && one.childPids.length === 0 && one.ledger.masked === 0,
      { happened: JSON.stringify(one), why: 'A task that inherits the messages or counters of the one before is not measured on its own.', fix: 'Return the fresh fields in eval.taskState.' });
    check('two tasks never share a counter object, and the state passed in is left alone',
      one.editWhy !== two.editWhy && one.ledger !== two.ledger && one.messages !== two.messages && Object.keys(one.editWhy).length === 0
        && base.messages.length === 1 && base.editWhy.shared === 1,
      { happened: JSON.stringify({ one: one.editWhy, two: two.editWhy, base }), why: 'runSuite sums per-task counters; a shared object would be summed twice.', fix: 'Build new objects in eval.taskState on every call.' });
  });
}
