// The big-file tier: Aider's refactoring benchmark, converted into tasks this
// machine can run.
//
// The two main-tier benchmarks are single-file edits of a few dozen lines, which
// is the band a 7B can score in but not the shape most real work has. This one
// is the opposite end: 89 real source files from Django, Spyder and TensorFlow -
// median 26 KB, largest 1.1 MB - each asking for one method to be moved out of
// its class and made a top-level function of the same name. It was built to
// provoke lazy coding, and it is the tier that punishes a harness for eliding
// code, for rewriting a file it only half read, and for a context window that
// cannot hold what it is editing.
//
// Two things make it runnable here where the main tiers need packages installed:
// the grader is the benchmark's own AST check and no tests are run, so nothing
// depends on Django or TensorFlow being importable; and the check is inlined
// into one Python file, so the `aider` package is not needed either (upstream
// the generated test file does `from benchmark.refactor_tools import
// verify_refactor`).
//
// Source: github.com/Aider-AI/refactor-benchmark, Apache-2.0. The AST rules
// below are that repository's `refactor_tools.py`, kept the same: the named
// function must exist at module level with a subtree size within 10 per cent of
// the method's, and the class must have lost exactly that much.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, run, STATE_DIR } from './core.mjs';
import { proveTask, resolveRunner } from './polyglot.mjs';

// A source file this size or larger is skipped by default. The reason is the
// window, not the disk: the tier exists to stress a harness on a file it cannot
// hold all at once, and a 1.1 MB file cannot be held by any local model at all,
// so it would measure nothing but the truncation. --max-bytes raises it.
export const DEFAULT_MAX_BYTES = 40960;

export function tasksIn(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch { return []; }
}

// The numbers the benchmark generated for this task live in the test file it
// ships. They are read rather than recomputed, because they are what upstream
// grades against: recomputing them here would let a converter quietly grade a
// different, easier thing.
export function paramsFromTest(text) {
  const src = String(text || '');
  const str = (k) => { const m = src.match(new RegExp(`${k}\\s*=\\s*["']([^"']+)["']`)); return m ? m[1] : ''; };
  const num = (k) => { const m = src.match(new RegExp(`${k}\\s*=\\s*(\\d+)`)); return m ? Number(m[1]) : 0; };
  // Only the four numbers the grader needs. The source file is found by
  // listing the directory, not parsed out of here, and it must not appear in
  // this object: graderFor is given the name from the listing and a key of the
  // same name here would overwrite it.
  const out = { func: str('method'), funcChildren: num('method_children'), className: str('class_name'), classChildren: num('class_children') };
  const missing = [];
  if (!out.func) missing.push('method');
  if (!out.funcChildren) missing.push('method_children');
  if (!out.className) missing.push('class_name');
  if (!out.classChildren) missing.push('class_children');
  return missing.length ? { error: `the benchmark's test file does not say ${missing.join(', ')}` } : out;
}

// The grader, as one self-contained Python file. It is a hidden task file: it
// reaches the workspace only after the model has stopped, so the numbers it
// checks against are not in front of the model while it works.
export function graderFor({ source, func, funcChildren, className, classChildren }) {
  const q = (s) => JSON.stringify(String(s));
  return [
    '# The AST check from Aider\'s refactor benchmark (Apache-2.0, Aider-AI/refactor-benchmark,',
    '# benchmark/refactor_tools.py), inlined so a task can be graded without the aider package.',
    'import ast, pathlib, sys',
    '',
    `SOURCE = ${q(source)}`,
    `FUNC = ${q(func)}`,
    `FUNC_CHILDREN = ${Math.floor(funcChildren)}`,
    `CLASS_NAME = ${q(className)}`,
    // Upstream passes class_children - func_children: the class is expected to
    // have lost the method it gave away.
    `CLASS_CHILDREN = ${Math.floor(classChildren) - Math.floor(funcChildren)}`,
    '',
    '',
    'class Parented(ast.NodeTransformer):',
    '    def generic_visit(self, node):',
    '        for child in ast.iter_child_nodes(node):',
    '            child.parent = node',
    '        return super(Parented, self).generic_visit(node)',
    '',
    '',
    'def main():',
    '    text = (pathlib.Path(__file__).parent / SOURCE).read_text(encoding="utf-8")',
    '    try:',
    '        tree = ast.parse(text)',
    '    except SyntaxError as e:',
    '        print("%s no longer parses: %s" % (SOURCE, e), file=sys.stderr)',
    '        return 1',
    '    Parented().visit(tree)',
    '    named = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == FUNC]',
    '    if not named:',
    '        print("Function %s not found" % FUNC, file=sys.stderr)',
    '        return 1',
    '    top = next((n for n in named if isinstance(getattr(n, "parent", None), ast.Module)), None)',
    '    if top is None:',
    '        print("%s is not a top level function" % FUNC, file=sys.stderr)',
    '        return 1',
    '    children = sum(1 for _ in ast.walk(top))',
    '    if abs(children - FUNC_CHILDREN) * 100 / FUNC_CHILDREN >= 10:',
    '        print("Old method had %d children, new function has %d" % (FUNC_CHILDREN, children), file=sys.stderr)',
    '        return 1',
    '    klass = next((n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == CLASS_NAME), None)',
    '    if klass is None:',
    '        print("Old class %s not found" % CLASS_NAME, file=sys.stderr)',
    '        return 1',
    '    left = sum(1 for _ in ast.walk(klass))',
    '    if abs(left - CLASS_CHILDREN) * 100 / CLASS_CHILDREN >= 10:',
    '        print("Old class should have %d children after the move, it has %d" % (CLASS_CHILDREN, left), file=sys.stderr)',
    '        return 1',
    '    print("%s is a top level function with %d nodes, and %s kept %d" % (FUNC, children, CLASS_NAME, left))',
    '    return 0',
    '',
    '',
    'sys.exit(main())',
    '',
  ].join('\n');
}

// The reference solution, built rather than shipped: this benchmark ships no
// answer. The move is mechanical and it is the same move the grader asks for -
// take the method's own source lines out of the class, dedent them, and put them
// at module level - so the node counts come out identical rather than within the
// ten per cent the grader allows. A file the move cannot be made in (a class
// left with an empty body, a method whose body holds text at column zero) fails
// to parse here and the task is refused with that reason rather than written out
// unproved.
export const MOVER = [
  'import ast, pathlib, sys, textwrap',
  '',
  'src_path, class_name, method, out_path = sys.argv[1:5]',
  'text = pathlib.Path(src_path).read_text(encoding="utf-8")',
  'tree = ast.parse(text)',
  'klass = next((n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == class_name), None)',
  'if klass is None:',
  '    sys.exit("no class %s in %s" % (class_name, src_path))',
  'target = next((i for i in klass.body if isinstance(i, ast.FunctionDef) and i.name == method), None)',
  'if target is None:',
  '    sys.exit("no method %s in class %s" % (method, class_name))',
  'lines = text.splitlines(keepends=True)',
  'start = min([target.lineno] + [d.lineno for d in target.decorator_list]) - 1',
  'end = target.end_lineno',
  'moved = textwrap.dedent("".join(lines[start:end]))',
  'rest = "".join(lines[:start] + lines[end:])',
  'out = rest.rstrip("\\n") + "\\n\\n\\n" + moved.rstrip("\\n") + "\\n"',
  'try:',
  '    moved_tree = ast.parse(out)',
  'except SyntaxError as e:',
  '    sys.exit("the mechanical move does not parse: %s" % e)',
  // Dedent removes the *common* leading whitespace, and a method whose body
  // holds a triple-quoted string with text at column zero has none: the block
  // comes out still indented, and if the method was the last thing in its class
  // the moved copy simply rejoins that class. It parses, so the parse check
  // above cannot see it. This one can: the function has to be a statement of the
  // module itself. (Measured on generator.py in the benchmark, 2026-09-25.)
  'if not any(isinstance(n, ast.FunctionDef) and n.name == method for n in moved_tree.body):',
  '    sys.exit("the mechanical move did not reach module level: %s stayed inside a block, which is what happens when its body holds text at column zero and dedent has no common indent to remove" % method)',
  'pathlib.Path(out_path).write_text(out, encoding="utf-8")',
  'print("moved %s out of %s" % (method, class_name))',
  '',
].join('\n');

// Runs the mover in a scratch directory. Never in the benchmark clone: a
// converter that writes into the corpus it is reading has changed the corpus.
export function referenceFor(exe, sourceText, sourceName, className, method, { keep = false } = {}) {
  const dir = path.join(STATE_DIR, 'refactor-proof', `move-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    ensureDir(dir);
    const src = path.join(dir, sourceName);
    const out = path.join(dir, `moved-${sourceName}`);
    const mover = path.join(dir, 'atlias_move.py');
    fs.writeFileSync(src, String(sourceText));
    fs.writeFileSync(mover, MOVER);
    let r = null;
    try { r = run(exe, [mover, src, className, method, out], { timeout: 60000 }); } catch (e) { r = { status: null, stdout: '', stderr: String(e && e.message ? e.message : e) }; }
    if (!r || r.status !== 0) {
      const why = `${(r && r.stderr) || ''}${(r && r.stdout) || ''}`.trim().split('\n').filter(Boolean).slice(-1)[0] || 'the mover gave no reason';
      return { ok: false, why: `no reference could be built: ${why}` };
    }
    return { ok: true, text: fs.readFileSync(out, 'utf8') };
  } catch (e) {
    return { ok: false, why: `no reference could be built: ${e && e.message ? e.message : e}` };
  } finally {
    if (!keep) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

// One benchmark directory as a task, or the reason it cannot be one.
export function refactorTask(dir, { exe = 'python', rounds = 16, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.py')); } catch { return { error: `${dir} cannot be read` }; }
  const testName = names.find((f) => f.endsWith('_test.py'));
  const sources = names.filter((f) => !f.endsWith('_test.py'));
  const sourceName = sources[0];
  // Exactly one source file, or the converter would be picking one by readdir
  // order and grading a file the instruction may not be about.
  if (!testName || sources.length !== 1) return { error: `expected one source and one _test.py, found ${names.join(', ') || 'nothing'}` };
  let testText = '', sourceText = '';
  try { testText = fs.readFileSync(path.join(dir, testName), 'utf8'); } catch { return { error: `${testName} cannot be read` }; }
  try { sourceText = fs.readFileSync(path.join(dir, sourceName), 'utf8'); } catch { return { error: `${sourceName} cannot be read` }; }
  const params = paramsFromTest(testText);
  if (params.error) return { error: params.error };
  // The grader divides by what the class is expected to have left, so a task
  // whose method is most of its class cannot be graded by this rule at all.
  if (params.classChildren - params.funcChildren <= 0) return { error: `${params.className} has ${params.classChildren} nodes and ${params.func} has ${params.funcChildren}, so the class would have nothing left to check against` };
  const bytes = Buffer.byteLength(sourceText, 'utf8');
  if (maxBytes > 0 && bytes > maxBytes) return { error: `${sourceName} is ${bytes} bytes, above the ${maxBytes}-byte cap; --max-bytes raises it`, oversize: true };
  let brief = '';
  try { brief = fs.readFileSync(path.join(dir, '.docs', 'instructions.md'), 'utf8').trim(); } catch { brief = ''; }
  if (!brief) {
    brief = `# Refactor ${params.className}.${params.func}\n\nRefactor the \`${params.func}\` method in the \`${params.className}\` class to be a stand alone, top level function.\nName the new function \`${params.func}\`, exactly the same name as the existing method.\nUpdate any existing \`self.${params.func}\` calls to work with the new \`${params.func}\` function.`;
  }
  return {
    task: {
      id: `refactor-${path.basename(dir)}`,
      kind: 'refactor',
      name: `${params.className}.${params.func} (refactor-benchmark, ${Math.round(bytes / 1024)} KB)`,
      rounds,
      protect: [],
      files: { [sourceName]: sourceText },
      hidden: { 'refactor_check.py': graderFor({ source: sourceName, ...params }) },
      prompt: `${brief}\n\nThe file to edit is ${sourceName} (${bytes} bytes). Nothing else in the workspace is graded, and no tests are run: after you stop, a check parses ${sourceName} and requires that \`${params.func}\` is a top level function with the same body it had as a method, and that \`${params.className}\` no longer holds it. Move the code rather than rewriting it, and do not elide any part of the file.`,
      check: [exe, 'refactor_check.py'],
      timeoutMs: 60000,
    },
    reference: null,
    stubName: sourceName,
    params,
    bytes,
  };
}

// Proves every task and writes the ones that hold: the file as shipped must
// fail the AST check (the method is still in the class) and the mechanical move
// must pass it.
export function convert(dir, outDir, { limit = 0, only = [], rounds = 16, maxBytes = DEFAULT_MAX_BYTES, write = true } = {}) {
  const ready = resolveRunner('python', { bare: true });
  if (!ready.ok) return { ok: false, why: ready.why, wrote: [], refused: [], skipped: [], dir: outDir };
  let names = tasksIn(dir);
  if (only.length) names = names.filter((n) => only.includes(n));
  if (limit > 0) names = names.slice(0, limit);
  if (!names.length) return { ok: false, why: `no task directories under ${dir}`, wrote: [], refused: [], skipped: [], dir: outDir };
  if (write) ensureDir(outDir);
  const wrote = [], refused = [], skipped = [];
  for (const name of names) {
    const built = refactorTask(path.join(dir, name), { exe: ready.exe, rounds, maxBytes });
    if (built.error) { (built.oversize ? skipped : refused).push({ name, why: built.error }); continue; }
    const ref = referenceFor(ready.exe, built.task.files[built.stubName], built.stubName, built.params.className, built.params.func);
    if (!ref.ok) { refused.push({ name, why: ref.why }); continue; }
    built.reference = ref.text;
    const proof = proveTask(built, 'python');
    if (!proof.ok) { refused.push({ name, why: proof.why }); continue; }
    if (write) fs.writeFileSync(path.join(outDir, `${built.task.id}.json`), `${JSON.stringify(built.task, null, 2)}\n`);
    wrote.push(built.task.id);
  }
  return { ok: wrote.length > 0, why: ready.why, wrote, refused, skipped, dir: outDir };
}

export function report(result) {
  const lines = [];
  if (!result.wrote.length) lines.push(`nothing converted: ${result.why}`);
  else lines.push(`${result.wrote.length} task(s) written to ${result.dir}, each proved to fail the AST check as shipped and pass it after the method is moved (${result.why}).`);
  if (result.skipped && result.skipped.length) {
    lines.push(`${result.skipped.length} skipped for size, which is a setting rather than a fault:`);
    for (const s of result.skipped) lines.push(`  ${s.name}: ${s.why}`);
  }
  if (result.refused && result.refused.length) {
    lines.push(`${result.refused.length} refused, which is the point of proving them:`);
    for (const r of result.refused) lines.push(`  ${r.name}: ${r.why}`);
  }
  return lines.join('\n');
}
