// Turning somebody else's benchmark into tasks this machine can actually run.
//
// The measurement front of the round-three research was blunt about the eight
// shipped tasks: at that size the standard error is about sixteen points and one
// task flipping moves the score twelve and a half, so the corpus is a tripwire
// rather than a measurement. It was equally blunt about the fix. Aider's
// polyglot benchmark is 225 Exercism exercises - a stub, a test, and a reference
// solution - and while aider's *harness* needs Docker, the *data* does not. The
// Python half needs python and pytest, both of which are on this machine.
//
// The rule that makes a converted task worth anything is the same rule the eval
// runner already lives by: nothing is taken on trust. Every task is proved to
// fail with the stub in place and to pass with the exercise's own reference
// solution dropped in, on this machine, before it is written out. A task that
// cannot do both is not emitted, and the reason is reported - because a task
// that fails for a missing package measures the machine, not the harness.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, run, STATE_DIR } from './core.mjs';
import * as proc from './proc.mjs';

// One language at a time, and only the ones whose runner is a real program on
// this machine. Adding javascript means installing jest, which is why it is
// listed with its runner rather than assumed.
export const LANGS = {
  python: {
    dir: 'python',
    stub: (name) => `${name.replace(/-/g, '_')}.py`,
    test: (name) => `${name.replace(/-/g, '_')}_test.py`,
    example: 'example.py',
    check: (testFile, exe = 'python') => [exe, '-m', 'pytest', '-q', testFile],
    probe: (exe = 'python') => [exe, '-m', 'pytest', '--version'],
    // The CanItEdit, HumanEvalFix and refactor graders are plain scripts: they
    // need an interpreter, not pytest, and asking for pytest refused them on
    // every machine that has Python without it (every CI runner).
    bareProbe: (exe = 'python') => [exe, '-c', 'import sys; print("python " + sys.version.split()[0])'],
    // Windows ships an App Execution Alias called python.exe under
    // WindowsApps that opens the Store instead of running anything, and when it
    // is spawned without a console it simply hangs until the timeout. It sat
    // second on PATH here, which is why the first full conversion converted
    // nothing. So the interpreter is resolved to a real path and baked into the
    // check rather than left to whichever python PATH offers at the time.
    candidates: ['ATLIAS_PYTHON', 'python', 'py', 'python3'],
    carry: (f) => f.endsWith('.py'),
  },
  javascript: {
    dir: 'javascript',
    stub: (name) => `${name}.js`,
    test: (name) => `${name}.spec.js`,
    example: 'proof.ci.js',
    check: (testFile, exe = 'npx') => [exe, '--no-install', 'jest', testFile],
    probe: (exe = 'npx') => [exe, '--no-install', 'jest', '--version'],
    candidates: ['ATLIAS_NPX', 'npx'],
    carry: (f) => f.endsWith('.js'),
  },
};

// Is the language's test runner really here? A corpus whose check cannot start
// fails every task before the model has done anything, and nothing in the score
// would say so.
// Every real path a runner might have here, most specific first: an override in
// the environment, then whatever `where` or `which` reports, with the Windows
// Store aliases thrown out because they hang rather than run, then the bare
// names as a last resort.
export function runnerCandidates(lang) {
  const spec = LANGS[lang];
  if (!spec) return [];
  const out = [];
  const push = (p) => { if (p && !out.includes(p)) out.push(p); };
  for (const name of spec.candidates) {
    if (/^[A-Z_]+$/.test(name)) { push(process.env[name]); continue; }
    let r = null;
    try { r = run(process.platform === 'win32' ? 'where' : 'which', [name], { timeout: 20000 }); } catch { r = null; }
    if (r && r.status === 0) {
      for (const line of String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)) {
        if (/WindowsApps/i.test(line)) continue;
        push(line);
      }
    }
    push(name);
  }
  return out;
}

// The first candidate that actually answers. Tried twice each, because one cold
// or contended start refusing to answer would otherwise refuse the whole corpus.
// bare: only the interpreter has to answer, for a check that is a plain script.
export function resolveRunner(lang, { bare = false } = {}) {
  const spec = LANGS[lang];
  if (!spec) return { ok: false, why: `no converter for ${lang}; have ${Object.keys(LANGS).join(', ')}` };
  const tried = [];
  for (const exe of runnerCandidates(lang)) {
    const argv = (bare && spec.bareProbe ? spec.bareProbe : spec.probe)(exe);
    let r = null;
    for (let attempt = 0; attempt < 2 && (!r || r.status !== 0); attempt++) {
      try { r = run(argv[0], argv.slice(1), { timeout: 60000 }); } catch (e) { r = { status: null, error: String(e && e.message ? e.message : e), stdout: '', stderr: '' }; }
    }
    if (r && r.status === 0) return { ok: true, exe, why: String(r.stdout || '').trim().split('\n')[0] || `${exe} answered` };
    tried.push(`${exe}: ${String((r && (r.error || r.stderr || r.stdout)) || '').trim().split('\n')[0] || 'no answer'}`);
  }
  return { ok: false, why: tried.length ? `no working runner for ${lang}; tried ${tried.join('; ')}` : `no candidate runner for ${lang} on this machine` };
}

export function runnerReady(lang) {
  return resolveRunner(lang);
}

export function exercisesIn(repo, lang) {
  const spec = LANGS[lang];
  if (!spec) return [];
  const dir = path.join(repo, spec.dir, 'exercises', 'practice');
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; }
}

// The instruction text the exercise ships, kept short. The whole point of
// reading these is that the task says what is wanted in the words its author
// used; the whole point of clipping them is that a 6,000-character brief in
// every prompt is a context cost paid on every round of every attempt.
export function briefFor(exDir, limit = 2200) {
  const parts = [];
  for (const f of ['instructions.md', 'instructions.append.md']) {
    try { parts.push(fs.readFileSync(path.join(exDir, '.docs', f), 'utf8').trim()); } catch { /* not every exercise has both */ }
  }
  const text = parts.filter(Boolean).join('\n\n').replace(/\r\n/g, '\n');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).replace(/\s+\S*$/, '')}\n\n[instructions clipped here; the test file is the specification that decides]`;
}

// The task, built but not yet proved. rounds is deliberately larger than the
// shipped corpus uses: these are whole exercises rather than one-line fixes.
export function taskFromExercise(repo, lang, name, { rounds = 18, briefLimit = 2200, exe = '' } = {}) {
  const spec = LANGS[lang];
  if (!spec) return { error: `no converter for ${lang}` };
  const exDir = path.join(repo, spec.dir, 'exercises', 'practice', name);
  const stubName = spec.stub(name);
  const testName = spec.test(name);
  let stub, test;
  try { stub = fs.readFileSync(path.join(exDir, stubName), 'utf8'); } catch { return { error: `no stub ${stubName}` }; }
  try { test = fs.readFileSync(path.join(exDir, testName), 'utf8'); } catch { return { error: `no test ${testName}` }; }
  const files = { [stubName]: stub, [testName]: test };
  // Some exercises ship more than one module, and a task missing one of them
  // fails on an import for a reason that has nothing to do with the model.
  let extra = [];
  try { extra = fs.readdirSync(exDir).filter((f) => spec.carry(f) && f !== stubName && f !== testName); } catch { extra = []; }
  for (const f of extra) {
    try { files[f] = fs.readFileSync(path.join(exDir, f), 'utf8'); } catch { /* skip what cannot be read */ }
  }
  let reference = null;
  try { reference = fs.readFileSync(path.join(exDir, '.meta', spec.example), 'utf8'); } catch { reference = null; }
  const brief = briefFor(exDir, briefLimit);
  return {
    task: {
      id: `polyglot-${lang}-${name}`,
      kind: `polyglot-${lang}`,
      name: `${name} (${lang})`,
      rounds,
      protect: [testName],
      files,
      prompt: `${brief}\n\nThe file to write is ${stubName}. Make the tests in ${testName} pass; that file is what the check runs to grade this task. Do not change ${testName}: it is the specification, and a run that edits it does not count.`,
      check: spec.check(testName, exe || undefined),
      timeoutMs: 120000,
    },
    reference,
    stubName,
    testName,
  };
}

// Proving a task before it is allowed into the corpus: it must fail as shipped,
// and it must pass with the exercise's own solution in place. Both runs happen
// in a scratch workspace, never in the repo being converted.
export function proveTask(built, lang, { keep = false, beforeRuns = 1 } = {}) {
  const spec = LANGS[lang];
  const dir = path.join(STATE_DIR, 'polyglot-proof', `${built.task.id}-${Date.now()}`);
  const write = (extraFiles = {}) => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* first time through */ }
    ensureDir(dir);
    // Hidden grader files (a benchmark whose tests the model never sees) are
    // written last, exactly as runTask writes them after the model stops.
    for (const [rel, body] of Object.entries({ ...built.task.files, ...extraFiles, ...(built.task.hidden || {}) })) {
      const p = path.join(dir, rel);
      ensureDir(path.dirname(p));
      fs.writeFileSync(p, String(body));
    }
  };
  const argv = built.task.check;
  // A run with no exit status is asked once more before it is judged, because
  // on a loaded machine one cold start can time out. And its error is kept:
  // the first conversion refused seven exercises with "no output" because the
  // spawn error was dropped here, and on 2026-09-25 all seven failed as shipped
  // in the normal way when run alone.
  const go = () => {
    let r = null;
    for (let attempt = 0; attempt < 2 && (!r || r.status === null); attempt++) {
      // Under the watchdog: a stub that never returns is ended with everything
      // it started, not only the program the check named.
      try { r = proc.runSync(argv[0], argv.slice(1), { cwd: dir, timeoutMs: built.task.timeoutMs || 120000, env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }); } catch (e) { r = { status: null, stdout: '', stderr: '', error: String(e && e.message ? e.message : e) }; }
    }
    const text = `${(r && r.stdout) || ''}${(r && r.stderr) || ''}`.trim();
    const errText = r && r.error ? String(r.error.message || r.error) : '';
    const out = [text, r && r.status === null && errText ? errText : ''].filter(Boolean).join('\n').slice(-400);
    return { status: r ? r.status : null, out, timedOut: Boolean(r && r.status === null && (r.timedOut || /ETIMEDOUT|timed out/i.test(errText))) };
  };
  write();
  // A check that decides by timing can pass the untouched stub by chance
  // (CanItEdit 60_unique_number passed 2 of 3 direct runs here on 2026-09-25),
  // so a converter can ask for the stub to fail more than once before it counts.
  let before = go();
  let ran = 1;
  // Repeating the stub is for a check that decides by timing, which can pass by
  // chance; a stub that ran until the timeout did not pass by chance and cannot
  // start doing so, so it is not asked again. Without this, a HumanEvalFix stub
  // that loops forever cost six spawns at a 60-second timeout - six minutes for
  // one task - and made a 164-task conversion look wedged.
  while (before.status !== 0 && !before.timedOut && ran < Math.max(1, beforeRuns)) { before = go(); ran++; }
  if (before.status === 0) {
    if (!keep) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    return { ok: false, why: `the stub already passes${ran > 1 ? ` (on run ${ran} of ${beforeRuns}; a flaky or timing-based check)` : ''}, so the task would measure nothing`, before, after: null };
  }
  if (before.status === null && !before.timedOut) {
    if (!keep) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    return { ok: false, why: `the check could not run here: ${before.out.split('\n')[0] || 'no output'}`, before, after: null };
  }
  if (!built.reference) {
    if (!keep) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    return { ok: false, why: 'no reference solution ships with this exercise, so it cannot be proved solvable', before, after: null };
  }
  write({ [built.stubName]: built.reference });
  const after = go();
  if (!keep) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  if (after.status !== 0) return { ok: false, why: `the exercise's own solution does not pass on this machine: ${after.out.split('\n').slice(-1)[0] || 'no output'}`, before, after };
  return { ok: true, why: 'fails as shipped, passes with the reference solution', before, after };
}

// The whole conversion. Nothing is written until a task has been proved, and
// what was refused is returned with the reason rather than dropped in silence.
export function convert(repo, lang, outDir, { limit = 0, rounds = 18, only = [], write = true } = {}) {
  const ready = resolveRunner(lang);
  if (!ready.ok) return { ok: false, why: ready.why, wrote: [], refused: [] };
  let names = exercisesIn(repo, lang);
  if (only.length) names = names.filter((n) => only.includes(n));
  if (limit > 0) names = names.slice(0, limit);
  if (!names.length) return { ok: false, why: `no exercises found under ${repo} for ${lang}`, wrote: [], refused: [] };
  if (write) ensureDir(outDir);
  const wrote = [], refused = [];
  for (const name of names) {
    const built = taskFromExercise(repo, lang, name, { rounds, exe: ready.exe });
    if (built.error) { refused.push({ name, why: built.error }); continue; }
    const proof = proveTask(built, lang);
    if (!proof.ok) { refused.push({ name, why: proof.why }); continue; }
    if (write) fs.writeFileSync(path.join(outDir, `${built.task.id}.json`), `${JSON.stringify(built.task, null, 2)}\n`);
    wrote.push(built.task.id);
  }
  return { ok: wrote.length > 0, why: ready.why, wrote, refused, dir: outDir };
}

export function report(result) {
  const lines = [];
  if (!result.ok && !result.wrote.length) lines.push(`nothing converted: ${result.why}`);
  else lines.push(`${result.wrote.length} task(s) written to ${result.dir}, each proved to fail as shipped and pass with the exercise's own solution (${result.why}).`);
  if (result.refused.length) {
    lines.push(`${result.refused.length} refused, which is the point of proving them:`);
    for (const r of result.refused) lines.push(`  ${r.name}: ${r.why}`);
  }
  return lines.join('\n');
}
