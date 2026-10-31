// A corpus where the baseline is off the floor (NEXTGEN-4, build item 2).
//
// poly-A scored 0/27, and at zero passes an A/B has nothing to lose, so no
// change can show up as anything but noise. CanItEdit (instruction edits to
// existing code) and HumanEvalFix (one-function bug fixes) are the tiers a 7B
// can score on. These checks hold the converters to the rule the polyglot
// converter lives by: a task is proved to fail as shipped and pass with its
// own reference on this machine, or it is refused with the reason. And they
// hold CanItEdit to its upstream protocol, where the model never sees the
// tests: the tests reach the workspace only after the model has stopped.
//
// Loaded by test/run.mjs, which owns suite(), asyncSuite() and check().
import * as bench from '../lib/editbench.mjs';
import * as poly from '../lib/polyglot.mjs';
import * as evals from '../lib/eval.mjs';

export default async function editbenchSuites({ asyncSuite, check, skip, TMP, fs, path }) {
  const W = path.join(TMP, 'editbench-work');
  fs.mkdirSync(W, { recursive: true });
  // The graders are plain scripts, so an interpreter is enough; pytest is not.
  const py = poly.resolveRunner('python', { bare: true });
  const exe = py.ok ? py.exe : 'python';
  const cie = {
    id: 10, name: 'csv_parser', full_name: '10_csv_parser',
    before: 'def header(csv):\n    return []\n',
    after: 'def header(csv):\n    return csv.split("\\n")[0].split(",")\n',
    tests: '### START TESTS ###\nif True:  # pragma: no cover\n    assert header("a,b\\n1,2") == ["a", "b"]\n    assert _secret() == 7\n',
    instruction_descriptive: 'Make header return the first row as a list of column names.',
    instruction_lazy: 'fix header',
    taxonomy: { change_kind: 'corrective' },
  };
  // The upstream runner puts the program and its tests in one file, so the
  // tests may use a private helper the program defines. A separate test file
  // with `from main import *` would not see it; the converter must not break
  // a task the benchmark itself accepts.
  cie.before += 'def _secret():\n    return 7\n';
  cie.after += 'def _secret():\n    return 7\n';

  await asyncSuite('benchmark expert', 'CanItEdit converter keeps the tests hidden and proves each task', async () => {
    const lazy = bench.canItEditTask(cie, 'lazy', { exe });
    const desc = bench.canItEditTask(cie, 'descriptive', { exe });
    check('the task id names the benchmark, the variant and the upstream name',
      lazy.task.id === 'canitedit-lazy-10_csv_parser' && desc.task.id === 'canitedit-descriptive-10_csv_parser',
      { happened: `${lazy.task.id} / ${desc.task.id}`, why: 'Two variants of one task must pair by id in compare, and a stranger must find the upstream row.', fix: 'id = canitedit-<variant>-<full_name>.' });
    check('the model is given main.py and nothing that contains the tests',
      Object.keys(lazy.task.files).join(',') === 'main.py' && !JSON.stringify(lazy.task.files).includes('START TESTS') && !lazy.task.prompt.includes('START TESTS'),
      { happened: JSON.stringify(Object.keys(lazy.task.files)), why: 'CanItEdit hides its tests upstream; a model that can read them is taking a different, easier benchmark.', fix: 'Put the tests in task.hidden, not task.files or the prompt.' });
    check('the tests travel as hidden files',
      Object.values(lazy.task.hidden || {}).some((b) => b.includes('START TESTS')),
      { happened: JSON.stringify(Object.keys(lazy.task.hidden || {})), why: 'The check needs the tests after the run.', fix: 'task.hidden carries the tests and the runner.' });
    check('each variant carries its own instruction',
      lazy.task.prompt.includes('fix header') && desc.task.prompt.includes('first row as a list') && !lazy.task.prompt.includes('first row as a list'),
      { happened: lazy.task.prompt.slice(0, 200), why: 'The lazy/descriptive gap is the harness-sensitive signal; mixing them destroys it.', fix: 'Use instruction_lazy for lazy and instruction_descriptive for descriptive.' });
    const proof = poly.proveTask(lazy, 'python');
    check('a sound task is proved: fails with before, passes with after, private helper included',
      proof.ok === true,
      { happened: `${proof.why} ${JSON.stringify(proof.after || proof.before)}`, why: 'The benchmark runs program and tests in one namespace; a converter that cannot pass the reference refuses good tasks.', fix: 'The runner must execute main.py and the tests as one module, as upstream does.' });
    const already = poly.proveTask(bench.canItEditTask({ ...cie, before: cie.after }, 'lazy', { exe }), 'python');
    check('a task whose before-code already passes is refused by name (the 60_unique_number case)',
      already.ok === false && /already passes/.test(already.why),
      { happened: already.why, why: 'A task that passes untouched measures nothing.', fix: 'proveTask refuses it.' });
    const broken = poly.proveTask(bench.canItEditTask({ ...cie, after: 'import no_such_module_here\n' }, 'lazy', { exe }), 'python');
    check('a task whose reference fails here is refused and the reason names the missing module',
      broken.ok === false && /no_such_module_here|ModuleNotFoundError/.test(broken.why),
      { happened: broken.why, why: '16 CanItEdit tasks need pandas, torch, z3, sklearn, autograd or vllm; the refusal must say which, not "no output".', fix: 'Carry the last meaningful line of the check output into the reason.' });
  });

  await asyncSuite('benchmark expert', 'hidden grader files reach the workspace only after the model stops', async () => {
    const built = bench.canItEditTask(cie, 'lazy', { exe });
    const seen = [];
    const dir = evals.makeWorkspace(built.task, `hid-${Date.now()}`);
    seen.push(...fs.readdirSync(dir));
    check('makeWorkspace writes only task.files',
      seen.join(',') === 'main.py',
      { happened: seen.join(','), why: 'A hidden test the model can list is not hidden.', fix: 'Only task.files are seeded; task.hidden is written by runTask after the loop.' });
    fs.rmSync(dir, { recursive: true, force: true });
    const echo = async () => ({ content: 'echo: no work done' });
    const fail = await evals.runTask(built.task, { chat: echo, state: {}, stamp: `e-${Date.now()}` });
    check('the echo model fails a CanItEdit task, on the hidden tests',
      fail.pass === false && /AssertionError|assert/i.test(fail.output),
      { happened: `${fail.pass} ${fail.why} ${fail.output}`, why: 'Nothing passes without work, and the failure must come from the hidden tests actually running.', fix: 'runTask writes task.hidden before score().' });
    const solved = await evals.runTask({ ...built.task, files: { 'main.py': cie.after } }, { chat: echo, state: {}, stamp: `s-${Date.now()}` });
    check('the same task passes when main.py already holds the reference',
      solved.pass === true,
      { happened: `${solved.why} ${solved.output}`, why: 'Proves the hidden tests grade the workspace, not a stale copy.', fix: 'Write hidden files into the workspace dir right before score().' });
    const cheat = await evals.runTask({ ...built.task, files: { 'main.py': cie.before, 'canitedit_tests.py': 'pass\n' } }, { chat: echo, state: {}, stamp: `c-${Date.now()}` });
    check('a same-named file in the workspace cannot replace the hidden tests',
      cheat.pass === false,
      { happened: cheat.why, why: 'A model that writes its own canitedit_tests.py would otherwise grade itself.', fix: 'Hidden files are written last and overwrite.' });
  });

  await asyncSuite('benchmark expert', 'HumanEvalFix converter: visible tests, throwing console.assert, both languages', async () => {
    const pyRow = {
      task_id: 'Python/0', entry_point: 'add', import: '', declaration: 'def add(a, b):\n',
      buggy_solution: '    return a - b\n', canonical_solution: '    return a + b\n',
      test: '\n\ndef check(add):\n    assert add(2, 3) == 5\n\ncheck(add)', instruction: 'Write add',
    };
    const p = bench.humanEvalFixTask(pyRow, 'python', { exe });
    check('the Python task id and files',
      p.task.id === 'humanevalfix-python-0' && p.task.files['solution.py'].includes('a - b') && p.task.files['tests.py'].includes('check(add)'),
      { happened: `${p.task.id} ${Object.keys(p.task.files)}`, why: 'HumanEvalFix gives the model the buggy function and its tests.', fix: 'solution.py = import + declaration + buggy_solution; tests.py = test.' });
    check('the tests and the runner are protected',
      ['tests.py', 'check.py'].every((f) => p.task.protect.includes(f)) && !p.task.protect.includes('solution.py'),
      { happened: JSON.stringify(p.task.protect), why: 'A pass bought by editing the tests is refused by tamper(), which only looks at protected files.', fix: 'protect tests and runner.' });
    const pp = poly.proveTask(p, 'python');
    check('the Python task proves', pp.ok === true, { happened: `${pp.why} ${JSON.stringify(pp.after || pp.before)}`, why: 'buggy fails, canonical passes.', fix: 'Runner concatenates solution and tests as upstream does.' });
    const jsRow = {
      task_id: 'JavaScript/0', entry_point: 'add', import: '', declaration: '\nconst add = (a, b) => {\n',
      buggy_solution: '  return a - b\n}\n', canonical_solution: '  return a + b\n}\n',
      test: 'const testAdd = () => {\n  console.assert(add(2, 3) === 5)\n}\n\ntestAdd()\n',
    };
    const j = bench.humanEvalFixTask(jsRow, 'js', { node: process.execPath });
    check('the JS test file starts with the throwing console.assert prelude',
      j.task.id === 'humanevalfix-js-0' && /^console\.assert = /.test(j.task.files['tests.js']),
      { happened: j.task.files['tests.js'].slice(0, 80), why: "Node's console.assert only logs, so the stock tests pass most buggy solutions.", fix: 'Prepend the prelude to tests.js.' });
    check('the runners name the program and the tests they join',
      bench.pythonRunner('solution.py', 'tests.py').includes('"tests.py"') && bench.jsRunner('solution.js', 'tests.js').includes('"tests.js"'),
      { happened: 'runner text lacks a file name', why: 'A runner that reads the wrong file grades nothing.', fix: 'Interpolate both names.' });
    const out = path.join(W, 'hef-out');
    const conv = bench.convertRows([pyRow, { ...pyRow, task_id: 'Python/1', buggy_solution: '    return a + b\n' }], 'humanevalfix', out, { lang: 'python' });
    const text = bench.report(conv);
    check('convertRows writes the sound row, refuses the one that already passes, and report says both',
      conv.wrote.join(',') === 'humanevalfix-python-0' && conv.refused.length === 1 && conv.refused[0].name === 'Python/1'
        && fs.existsSync(path.join(out, 'humanevalfix-python-0.json')) && /1 task\(s\) written/.test(text) && /Python\/1: the stub already passes/.test(text),
      { happened: text, why: 'The converter must keep what proves and name what it refused.', fix: 'convertRows + report.' });
    const jp = poly.proveTask(j, 'js');
    check('the JS task proves: the buggy code fails only because the assert now throws',
      jp.ok === true,
      { happened: `${jp.why} ${JSON.stringify(jp.after || jp.before)}`, why: 'Without the prelude the before-run would exit 0 and the task would be refused as already passing.', fix: 'Keep the prelude.' });
  });

  await asyncSuite('benchmark expert', 'a proof that cannot run says why instead of "no output"', async () => {
    const built = { task: { id: 'x', files: { 'a.py': '' }, check: ['atlias-no-such-runner-xyz', 'a.py'], timeoutMs: 5000 }, reference: '', stubName: 'a.py' };
    const r = poly.proveTask(built, 'python');
    check('the spawn error is in the reason',
      r.ok === false && !/no output/.test(r.why) && /ENOENT|not found|could not run/i.test(r.why) && /ENOENT|spawn/i.test(r.why),
      { happened: r.why, why: 'Seven polyglot exercises were refused with "no output" in the first conversion; on 2026-09-25 all seven fail as shipped normally, so the refusal hid a transient error it had been given.', fix: 'Carry run().error into the proof output.' });
    // A check that fails the stub once and passes it the second time, the
    // shape of CanItEdit 60_unique_number's timing assert.
    // The counter lives outside the proof workspace, which is rebuilt between
    // the stub run and the reference run.
    const flakyFor = (tag) => `import pathlib\np = pathlib.Path(${JSON.stringify(path.join(W, `flaky-${tag}.txt`).replace(/\\/g, '/'))})\nn = int(p.read_text()) if p.exists() else 0\np.write_text(str(n + 1))\nraise SystemExit(1 if n == 0 else 0)\n`;
    const flaky = (tag) => ({ task: { id: `flaky-${tag}`, files: { 'f.py': flakyFor(tag) }, check: [exe, 'f.py'], timeoutMs: 30000 }, reference: flakyFor(tag), stubName: 'x.py' });
    const once = poly.proveTask(flaky('once'), 'python');
    const thrice = poly.proveTask(flaky('thrice'), 'python', { beforeRuns: 3 });
    check('a stub that passes on a later run is refused when beforeRuns asks for repeats',
      thrice.ok === false && /already passes \(on run 2 of 3/.test(thrice.why) && once.ok === true,
      { happened: `once: ${once.why} | thrice: ${thrice.why}`, why: '60_unique_number decides by timing and passed its untouched stub 2 of 3 times here; the soundness probe had it as broken, one proof run let it in.', fix: 'proveTask runs the stub beforeRuns times and refuses on any pass.' });
    const rows = bench.readJsonl(path.join(W, 'none.jsonl'));
    check('a missing JSONL file reads as no rows', Array.isArray(rows) && rows.length === 0, { happened: String(rows), why: 'The CLI reports it rather than crashing.', fix: 'readJsonl returns [].' });
    fs.writeFileSync(path.join(W, 'two.jsonl'), '{"a":1}\n\n{"a":2}\n');
    check('blank lines are skipped', bench.readJsonl(path.join(W, 'two.jsonl')).length === 2, { happened: 'wrong count', why: 'datasets writes a trailing newline.', fix: 'Skip blank lines.' });
  });
}
