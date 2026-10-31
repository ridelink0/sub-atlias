// Benchmark tiers that actually run (NEXTGEN-4, build item 2).
//
// The complaint these checks answer is not that atlias had no benchmark. It had
// three, and the only one anybody ran end to end scored 0 of 27, which is a
// score no A/B can be built on. So the tiers have to be nameable from the CLI,
// honest about a corpus that is not on the machine, and reproducible task for
// task between two arms - and the big-file tier needs a grader that decides
// without installing Django.
//
// Loaded by test/run.mjs, which owns suite(), asyncSuite() and check().
import * as tiers from '../lib/tiers.mjs';
import * as rb from '../lib/refactorbench.mjs';
import * as poly from '../lib/polyglot.mjs';
import * as evals from '../lib/eval.mjs';

export default async function tierSuites({ asyncSuite, check, TMP, ROOT, fs, path, spawnSync }) {
  const NL = '\n';

  await asyncSuite('benchmark tier expert', 'a tier is named, reproducible, and honest when it is not here', async () => {
    // A fake tree, so these checks do not depend on which corpora this machine
    // happens to have generated.
    const root = path.join(TMP, 'tier-root');
    const make = (rel, ids) => {
      const dir = path.join(root, rel);
      fs.mkdirSync(dir, { recursive: true });
      for (const id of ids) fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, name: id, prompt: 'do it', check: ['node', '-e', '0'], files: {} }));
    };
    make('evals', ['a', 'b', 'c']);
    make('evals/humanevalfix/python', Array.from({ length: 20 }, (_, i) => `hef-${i}`));
    // The main tier's second folder is deliberately left out: the corpora are
    // generated and not in git, so "half a tier" is the normal case.
    const smoke = tiers.tierTasks('smoke', { root });
    check('the smoke tier is the tasks that ship with atlias',
      smoke.ok && smoke.tasks.length === 3 && smoke.missing.length === 0,
      { happened: JSON.stringify({ n: smoke.tasks.length, missing: smoke.missing }), why: 'The only tier that needs no download has to work on a fresh clone, or nobody can check the harness at all.', fix: 'TIERS.smoke reads evals/*.json.' });
    const main = tiers.tierTasks('main', { root });
    check('a tier with one folder missing runs the half that is here and names the half that is not',
      main.ok && main.tasks.length === 20 && main.missing.length === 1 && /not on this machine/.test(main.missing[0].why),
      { happened: JSON.stringify({ n: main.tasks.length, missing: main.missing }), why: 'Silently scoring 20 tasks and calling it the main tier would make two runs look comparable when one of them scored a different corpus.', fix: 'tierTasks reports present and missing separately.' });
    const big = tiers.tierTasks('big', { root });
    check('a tier that is not on the machine says so instead of scoring nothing',
      big.ok === false && /not on this machine/.test(big.why) && big.tasks.length === 0,
      { happened: JSON.stringify(big.why), why: 'A corpus of no tasks scores 0 of 0, and 0 of 0 prints as a clean run.', fix: 'tierTasks returns ok false with the reason.' });
    check('a tier nobody defined is refused with the list of the ones that exist',
      tiers.resolveTier('enormous').ok === false && /have smoke, main, big/.test(tiers.resolveTier('enormous').why) && tiers.tierNames().length === 3,
      { happened: JSON.stringify(tiers.resolveTier('enormous')), why: 'A typo in a tier name must not fall back to some other corpus.', fix: 'resolveTier checks the name against TIERS.' });

    const status = tiers.statusLines({ root });
    check('atlias tiers prints what each tier is for, what is here, and the command for what is not',
      /smoke:/.test(status) && /main:/.test(status) && /big:/.test(status) && /20 task\(s\) here/.test(status) && /regenerate with:/.test(status) && /atlias refactorbench/.test(status) && /CORPORA\.md/.test(status),
      { happened: status, why: 'A missing corpus that comes with its own command is a five-minute fix; one that just prints zero looks like a broken harness.', fix: 'statusLines prints TIERS[name].regenerate.' });

    // The sample has to be the same subset in both arms of an A/B, or compare()
    // pairs almost nothing and reports the difference between two corpora.
    const twenty = tiers.tierTasks('main', { root }).tasks;
    const first = tiers.sampleTasks(twenty, 6, 'poly');
    const again = tiers.sampleTasks([...twenty].reverse(), 6, 'poly');
    const other = tiers.sampleTasks(twenty, 6, 'other-seed');
    const ids = (ts) => ts.map((t) => t.id).join(',');
    check('the same seed picks the same tasks, whatever order the files were read in',
      ids(first) === ids(again) && first.length === 6,
      { happened: `${ids(first)} / ${ids(again)}`, why: 'Two arms scored on different subsets is not an A/B, and the readdir order is not stable across machines.', fix: 'sampleTasks sorts by id before and after the seeded shuffle.' });
    check('a different seed picks a different subset, and the sample is not just the first N by name',
      ids(other) !== ids(first) && ids(first) !== ids([...twenty].sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, 6)),
      { happened: `${ids(first)} against ${ids(other)}`, why: 'A sample that is always the alphabetical head is a fixed corner of the corpus, and one that ignores the seed cannot be varied when it matters.', fix: 'Check seedRandom and the shuffle.' });
    check('asking for more tasks than the tier holds returns the tier, in id order',
      ids(tiers.sampleTasks(twenty, 999, 'poly')) === ids([...twenty].sort((a, b) => String(a.id).localeCompare(String(b.id)))) && tiers.sampleTasks(twenty, 0).length === 20,
      { happened: `${tiers.sampleTasks(twenty, 999, 'poly').length} / ${tiers.sampleTasks(twenty, 0).length}`, why: 'A sample larger than the corpus must not drop tasks or duplicate them.', fix: 'sampleTasks returns everything when n is not smaller.' });
    const r = tiers.seedRandom('atlias');
    const draws = [r(), r(), r(), r()];
    check('the seeded generator is a generator: in range, not constant, and the same twice',
      draws.every((x) => x >= 0 && x < 1) && new Set(draws).size === 4 && tiers.seedRandom('atlias')() === draws[0],
      { happened: JSON.stringify(draws), why: 'A shuffle driven by a broken generator is either not a shuffle or not reproducible.', fix: 'Check seedRandom.' });

    // Two tasks with one id would be scored twice and would pair with each
    // other in compare, so the tier has to notice.
    make('evals/canitedit/lazy', ['hef-0', 'cie-1']);
    const clash = tiers.tierTasks('main', { root });
    check('two tasks sharing an id are reported rather than counted twice',
      clash.duplicates.includes('hef-0') && /counted twice/.test(tiers.statusLines({ root })),
      { happened: JSON.stringify(clash.duplicates), why: 'compare pairs by id: a duplicate id silently pairs a task with the wrong task.', fix: 'tierTasks collects duplicates.' });
  });

  // A tier nobody can regenerate in an evening is a tier that will not be
  // regenerated. This is the cost that made a 164-task conversion look wedged.
  await asyncSuite('conversion cost expert', 'a stub that hangs is not asked again three times', async () => {
    const tally = path.join(TMP, 'hang-tally.txt');
    const count = () => { try { return fs.readFileSync(tally, 'utf8').length; } catch { return 0; } };
    // Records every spawn; outlives the timeout while the stub is in place, and
    // exits zero once the reference has replaced it - which is the shape of a
    // HumanEvalFix stub whose bug is an endless loop.
    const hanging = [process.execPath, '-e', `const fs=require('fs'); fs.appendFileSync(${JSON.stringify(tally)}, 'x'); if (fs.readFileSync('main.py','utf8').includes('STUB')) setTimeout(() => {}, 600000); else process.exit(0);`];
    const built = (check2) => ({
      task: { id: 'hangs-forever', name: 'hangs forever', rounds: 2, protect: [], files: { 'main.py': '# STUB' }, prompt: 'Do nothing.', check: check2, timeoutMs: 5000 },
      reference: '# fixed',
      stubName: 'main.py',
    });
    const proof = poly.proveTask(built(hanging), 'python', { beforeRuns: 3 });
    const hangSpawns = count();
    check('a stub that runs until the timeout is asked once, not three times, and still counts as failing',
      proof.ok === true && hangSpawns === 3,
      { happened: `${hangSpawns} spawn(s) (want 3: one stub run, its one retry, one reference run), ok=${proof.ok}, why=${proof.why}`, why: 'Three repeats times a retry each, at a sixty-second timeout, is six minutes for one task: with a handful of such stubs a 164-task conversion looks wedged and gets abandoned.', fix: 'The beforeRuns loop stops on a timeout; only a check that could pass by timing is repeated.' });
    try { fs.rmSync(tally, { force: true }); } catch { /* best effort */ }
    // And the guard it was protecting still works: a stub that merely fails is
    // repeated, because a check that decides by timing can pass by chance.
    const failing = [process.execPath, '-e', `const fs=require('fs'); fs.appendFileSync(${JSON.stringify(tally)}, 'x'); process.exit(fs.readFileSync('main.py','utf8').includes('STUB') ? 1 : 0);`];
    const repeated = poly.proveTask(built(failing), 'python', { beforeRuns: 3 });
    check('while a stub that fails quickly is still repeated, which is what catches a flaky check',
      repeated.ok === true && count() === 4,
      { happened: `${count()} spawn(s) (want 4: three stub runs and one reference run), ok=${repeated.ok}`, why: 'CanItEdit 60_unique_number passed 2 of 3 direct runs here; dropping the repeats to save time would let a task like that into the corpus.', fix: 'Only a timeout ends the loop early.' });
    try { fs.rmSync(tally, { force: true }); } catch { /* best effort */ }
  });

  // The big-file tier. The grader is the benchmark's own AST rule, so these
  // checks hold it to that rule in both directions: the file as shipped must
  // fail, and only a real move must pass.
  await asyncSuite('big-file benchmark expert', 'the refactor tier grades the AST and proves every task', async () => {
    const py = poly.resolveRunner('python', { bare: true });
    const dir = path.join(TMP, 'refactor-bench', 'thing_Holder_shout');
    fs.mkdirSync(path.join(dir, '.docs'), { recursive: true });
    // A class with one method that does not use self, which is the shape the
    // benchmark selects for, plus a second method so the class is not empty
    // after the move.
    const source = [
      'class Holder:',
      '    def __init__(self, items):',
      '        self.items = items',
      '',
      '    def shout(text):',
      '        loud = str(text).upper()',
      '        if not loud:',
      '            return "?"',
      '        return loud + "!"',
      '',
      '    def all(self):',
      '        return list(self.items)',
      '',
    ].join(NL);
    fs.writeFileSync(path.join(dir, 'thing.py'), source);
    fs.writeFileSync(path.join(dir, '.docs', 'instructions.md'), '# Refactor Holder.shout' + NL + NL + 'Refactor the `shout` method in the `Holder` class to be a stand alone, top level function.' + NL);
    // The node counts the benchmark would have generated, measured with the
    // same ast.walk the grader uses, so the fixture cannot drift from it.
    const counts = py.ok ? spawnSync(py.exe, ['-c', [
      'import ast,sys',
      'tree=ast.parse(open(sys.argv[1],encoding="utf-8").read())',
      'k=next(n for n in ast.walk(tree) if isinstance(n,ast.ClassDef))',
      'm=next(n for n in k.body if isinstance(n,ast.FunctionDef) and n.name=="shout")',
      'print(sum(1 for _ in ast.walk(k)), sum(1 for _ in ast.walk(m)))',
    ].join(';'), path.join(dir, 'thing.py')], { encoding: 'utf8' }) : null;
    // With no Python here the counts cannot be measured. The parsing checks below
    // still run on stand-in numbers (they only read the file back), and every
    // check that needs the grader to run is replaced by the refusal check.
    const [classChildren, funcChildren] = counts && counts.status === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [50, 20];
    fs.writeFileSync(path.join(dir, 'thing_test.py'), [
      'import unittest',
      'from benchmark.refactor_tools import verify_refactor',
      'from pathlib import Path',
      '',
      'class TheTest(unittest.TestCase):',
      '    def test_shout(self):',
      '        fname = Path(__file__).parent / "thing.py"',
      '        method = "shout"',
      `        method_children = ${funcChildren}`,
      '',
      '        class_name = "Holder"',
      `        class_children = ${classChildren}`,
      '',
      '        verify_refactor(fname, method, method_children, class_name, class_children)',
      '',
    ].join(NL));

    const params = rb.paramsFromTest(fs.readFileSync(path.join(dir, 'thing_test.py'), 'utf8'));
    check('the numbers the grader uses are read out of the test file the benchmark generated',
      params.func === 'shout' && params.className === 'Holder' && params.funcChildren === funcChildren && params.classChildren === classChildren,
      { happened: JSON.stringify(params), why: 'Recomputing them here would let the converter grade a different, easier thing than upstream does.', fix: 'Check paramsFromTest.' });
    check('a test file that does not carry them is refused by name',
      rb.paramsFromTest('import unittest' + NL).error && /method_children/.test(rb.paramsFromTest('import unittest' + NL).error),
      { happened: JSON.stringify(rb.paramsFromTest('import unittest')), why: 'A grader built from missing numbers would divide by zero and pass everything.', fix: 'paramsFromTest returns an error naming what was missing.' });

    const built = rb.refactorTask(dir, { exe: py.ok ? py.exe : 'python' });
    check('the model is given the source file and not the grader or its numbers',
      !built.error && Object.keys(built.task.files).join(',') === 'thing.py' && Object.keys(built.task.hidden).join(',') === 'refactor_check.py' && !built.task.prompt.includes(String(funcChildren)) && !JSON.stringify(built.task.files).includes('refactor_check'),
      { happened: JSON.stringify({ error: built.error, files: Object.keys(built.task.files || {}), hidden: Object.keys(built.task.hidden || {}) }), why: 'A model that can read the node count it is being measured against is being asked a different question.', fix: 'The grader is a hidden file; the prompt says what it checks, not what it counts.' });
    check('a source file over the size cap is skipped with its size, not refused as broken',
      (() => { const small = rb.refactorTask(dir, { maxBytes: 20 }); return small.error && small.oversize === true && /above the 20-byte cap/.test(small.error); })(),
      { happened: JSON.stringify(rb.refactorTask(dir, { maxBytes: 20 })), why: 'The biggest file in this benchmark is 1.1 MB and no local model can hold it; that is a setting, and reporting it as a fault hides the real refusals.', fix: 'refactorTask marks oversize and convert() counts it as skipped.' });
    check('the default cap is the one the tier was measured with',
      rb.DEFAULT_MAX_BYTES === 40960,
      { happened: String(rb.DEFAULT_MAX_BYTES), why: 'The task count of the tier depends on it, so a silent change would change the corpus.', fix: 'DEFAULT_MAX_BYTES stays 40960 unless CORPORA.md is updated with it.' });

    const grader = rb.graderFor({ source: 'thing.py', func: 'shout', funcChildren: 20, className: 'Holder', classChildren: 50 });
    check('the grader expects the class to have lost exactly what the function gained',
      /CLASS_CHILDREN = 30/.test(grader) && /FUNC_CHILDREN = 20/.test(grader) && /SOURCE = "thing\.py"/.test(grader) && /is not a top level function/.test(grader),
      { happened: grader.split(NL).slice(0, 12).join(NL), why: 'Upstream passes class_children minus method_children; a grader that expects the class to keep its method would pass a copy-paste that left the method where it was.', fix: 'Check graderFor.' });

    if (!py.ok) {
      check('with no python the converter refuses instead of writing unproved tasks',
        rb.convert(path.join(TMP, 'refactor-bench'), path.join(TMP, 'refactor-out')).ok === false,
        { happened: py.why, why: 'Writing tasks whose grader cannot start would fill a tier with guaranteed failures.', fix: 'convert returns early when the runner is not there.' });
      return;
    }

    check('the benchmark clone is read as one directory per task, and a path that is not one is empty rather than an error',
      JSON.stringify(rb.tasksIn(path.join(TMP, 'refactor-bench'))) === JSON.stringify(['thing_Holder_shout']) && rb.tasksIn(path.join(TMP, 'no-such-clone')).length === 0,
      { happened: JSON.stringify(rb.tasksIn(path.join(TMP, 'refactor-bench'))), why: 'A converter pointed at the wrong folder has to say it found nothing, not throw; the clone has the benchmark one level down and that is easy to miss.', fix: 'Check tasksIn.' });

    const out = path.join(TMP, 'refactor-out');
    const done = rb.convert(path.join(TMP, 'refactor-bench'), out, {});
    check('the task is proved and written: the file as shipped fails the AST check and the moved method passes it',
      done.wrote.length === 1 && done.wrote[0] === 'refactor-thing_Holder_shout' && fs.existsSync(path.join(out, 'refactor-thing_Holder_shout.json')) && done.refused.length === 0,
      { happened: JSON.stringify({ wrote: done.wrote, refused: done.refused, skipped: done.skipped }), why: 'This is the whole reason a borrowed benchmark can be trusted here: nothing enters the tier that was not run both ways on this machine.', fix: 'Check referenceFor, which builds the reference by moving the method, and proveTask.' });
    check('and the report names what it wrote, what it skipped for size and what it refused',
      /1 task\(s\) written/.test(rb.report(done)) && /skipped for size/.test(rb.report({ wrote: ['x'], why: 'p', dir: out, skipped: [{ name: 'big', why: 'too big' }], refused: [] })) && /refused, which is the point/.test(rb.report({ wrote: ['x'], why: 'p', dir: out, skipped: [], refused: [{ name: 'b', why: 'no numbers' }] })),
      { happened: rb.report(done), why: 'A tier of 58 tasks out of 89 has to say what happened to the other 31.', fix: 'Check report.' });

    // The reference is built, not shipped: this benchmark has no answer key.
    const moved = rb.referenceFor(py.exe, source, 'thing.py', 'Holder', 'shout');
    check('the reference move takes the method out of the class and dedents it to module level',
      moved.ok && /^def shout\(text\):/m.test(moved.text) && !/    def shout/.test(moved.text) && /class Holder:/.test(moved.text),
      { happened: JSON.stringify(moved).slice(0, 400), why: 'The grader counts nodes, so a reference that rewrote the body instead of moving it would prove a different task.', fix: 'Check the MOVER script.' });
    // The case the benchmark actually contains (generator.py, measured
    // 2026-09-25): the method's body holds a triple-quoted string with text at
    // column zero, so there is no common indent to remove and the dedented block
    // is still indented. If that method was the last thing in its class, the
    // moved copy simply rejoins the class - and the file parses, so only a check
    // that the function is a statement of the module can see it.
    const stuck = [
      'class Wrapper:',
      '    def first(self):',
      '        return 1',
      '',
      '    def render(text):',
      '        out = """',
      'flush left, so dedent has nothing in common to remove',
      '"""',
      '        return out + str(text)',
      '',
    ].join(NL);
    const notLifted = rb.referenceFor(py.exe, stuck, 'stuck.py', 'Wrapper', 'render');
    check('a method that dedent cannot lift is refused with that reason, not written as a reference that parses',
      notLifted.ok === false && /did not reach module level/.test(notLifted.why),
      { happened: JSON.stringify(notLifted), why: 'The moved block rejoins the class it came from and the file still parses, so a converter that only checks the parse would write a task whose own reference fails the grader.', fix: 'The mover checks that the function is a statement of the module.' });

    const absent = rb.referenceFor(py.exe, source, 'thing.py', 'Holder', 'whisper');
    check('and a method that is not there gives a reason rather than an empty reference',
      absent.ok === false && /no method whisper/.test(absent.why),
      { happened: JSON.stringify(absent), why: 'An unexplained failure here would show up later as a whole tier that refused every task.', fix: 'The mover exits with the reason and referenceFor keeps its last line.' });

    // What the grader must refuse. A run that deleted the method, or copied it
    // while leaving the original in place, must not score.
    const task = JSON.parse(fs.readFileSync(path.join(out, 'refactor-thing_Holder_shout.json'), 'utf8'));
    const graded = (body) => {
      const work = fs.mkdtempSync(path.join(TMP, 'refactor-grade-'));
      for (const [rel, text] of Object.entries({ ...task.files, ...task.hidden })) fs.writeFileSync(path.join(work, rel), rel === 'thing.py' ? body : text);
      const r = spawnSync(task.check[0], task.check.slice(1), { cwd: work, encoding: 'utf8' });
      try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
      return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
    };
    const shipped = graded(source);
    const copied = graded(source + NL + 'def shout(text):' + NL + '    loud = str(text).upper()' + NL + '    if not loud:' + NL + '        return "?"' + NL + '    return loud + "!"' + NL);
    const truncated = graded('class Holder:' + NL + '    def all(self):' + NL + '        return list(self.items)' + NL + NL + 'def shout(text):' + NL + '    return str(text).upper() + "!"' + NL);
    const real = graded(moved.text);
    check('the grader passes the real move and fails the file as shipped',
      shipped.status !== 0 && /not a top level function/.test(shipped.out) && real.status === 0,
      { happened: JSON.stringify({ shipped, real }), why: 'A grader that passes the untouched file scores the whole tier as solved.', fix: 'Check graderFor.' });
    check('a method copied to the top level while the class keeps its own is refused',
      copied.status !== 0 && /Old class should have/.test(copied.out),
      { happened: JSON.stringify(copied), why: 'Copying is the easy way to satisfy a check that only looks for a top level function, and it is not the refactor that was asked for.', fix: 'The second assertion checks what the class has left.' });
    check('and a function whose body was thrown away instead of moved is refused',
      truncated.status !== 0 && /new function has/.test(truncated.out),
      { happened: JSON.stringify(truncated), why: 'This benchmark exists to provoke lazy coding: a one-line stand-in for a moved method is exactly the failure it was built to catch.', fix: 'The node-count comparison is what refuses it.' });
    check('a file the run left unparseable is a failure with the syntax error, not a crash',
      (() => { const broken = graded('class Holder:' + NL + '  def shout(:' + NL); return broken.status === 1 && /no longer parses/.test(broken.out); })(),
      { happened: JSON.stringify(graded('class Holder:' + NL + '  def shout(:' + NL)), why: 'An exception out of the grader is indistinguishable from a broken harness in an eval report.', fix: 'graderFor catches SyntaxError and returns 1.' });

    // The tier has to be runnable end to end through the eval runner, which is
    // where a hidden grader file and a per-task round budget meet.
    const run = await evals.runTask(task, { chat: async () => ({ content: 'I have decided not to touch the file.' }), stamp: 'tier-test' });
    check('a run that does nothing scores zero through the ordinary eval runner',
      run.pass === false && /not a top level function/.test(run.output || ''),
      { happened: JSON.stringify({ pass: run.pass, why: run.why, out: (run.output || '').slice(0, 200) }), why: 'The tier is only a tier if atlias eval can score it; the grader arriving after the model stops is the part most likely to be wired up wrong.', fix: 'runTask writes task.hidden after the loop and before score().' });
    if (run.workspace) { try { fs.rmSync(run.workspace, { recursive: true, force: true }); } catch { /* best effort */ } }
    try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* best effort */ }
  });
}
