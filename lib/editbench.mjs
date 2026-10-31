// Two published edit benchmarks, converted into tasks this machine can run.
//
// poly-A scored 0/27 with a 7B, and at zero passes an A/B cannot show anything:
// the old arm has nothing to lose, so the new one needs six gains on tasks the
// model has already shown it cannot do. The tiers here are the ones a small
// model can score on, so a change to the harness has room to move a number
// both ways.
//
// - CanItEdit (nuprl, arXiv 2312.12450): an instruction edit to existing
//   Python code, in a lazy and a descriptive wording. Upstream the model sees
//   the code and the instruction, never the tests, and the grader runs the
//   program and its tests as one file. Both rules are kept: the tests are
//   task.hidden, written into the workspace only after the model stops, and
//   the runner executes main.py and the tests as one module.
// - HumanEvalFix (HumanEvalPack, arXiv 2308.07124): one buggy function and its
//   tests, fix the bug. Upstream the tests are shown, so here they are a
//   visible, protected file. JavaScript's stock tests use console.assert,
//   which in Node only logs; the protected test file starts by making it throw,
//   or most buggy solutions would "pass".
//
// The input is the dataset as JSONL, one row per line, which is what the
// Hugging Face datasets library writes with Dataset.to_json. Every task is
// proved here exactly as the polyglot converter proves its own (proveTask):
// it must fail as shipped and pass with the benchmark's reference, on this
// machine, or it is refused with the reason.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './core.mjs';
import { proveTask, resolveRunner } from './polyglot.mjs';

export function readJsonl(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a corrupt row is skipped; the count in the report shows it */ }
  }
  return rows;
}

// Program and tests in one module, as the upstream graders run them: the tests
// may use names the program keeps private, which `from main import *` would
// hide. The module is registered as __main__ so dataclasses, pickling and
// anything else that looks itself up in sys.modules behave as in a script.
export function pythonRunner(program, tests) {
  return [
    '# Runs the program and its tests as one module, as the benchmark does upstream.',
    'import pathlib, sys, types',
    'here = pathlib.Path(__file__).resolve().parent',
    `src = (here / ${JSON.stringify(program)}).read_text(encoding="utf-8") + "\\n\\n" + (here / ${JSON.stringify(tests)}).read_text(encoding="utf-8")`,
    'sys.path.insert(0, str(here))',
    'mod = types.ModuleType("__main__")',
    `mod.__file__ = str(here / ${JSON.stringify(program)})`,
    'sys.modules["__main__"] = mod',
    `exec(compile(src, ${JSON.stringify(`${program} + ${tests}`)}, "exec"), mod.__dict__)`,
    'print("all tests passed")',
    '',
  ].join('\n');
}

export const JS_ASSERT_PRELUDE = "console.assert = (cond, ...msg) => { if (!cond) throw new Error('assertion failed' + (msg.length ? ': ' + msg.join(' ') : '')) };\n";

export function jsRunner(program, tests) {
  return [
    '// Runs the program and its tests in one scope, as the benchmark does upstream.',
    "const fs = require('fs');",
    "const path = require('path');",
    `const src = fs.readFileSync(path.join(__dirname, ${JSON.stringify(program)}), 'utf8') + '\\n' + fs.readFileSync(path.join(__dirname, ${JSON.stringify(tests)}), 'utf8');`,
    "new Function('require', 'module', 'exports', '__dirname', src)(require, module, exports, __dirname);",
    "console.log('all tests passed');",
    '',
  ].join('\n');
}

export const CANITEDIT_VARIANTS = ['lazy', 'descriptive'];

// One CanItEdit row as a task. rounds is small: these are single-file edits.
export function canItEditTask(row, variant = 'lazy', { exe = 'python', rounds = 12 } = {}) {
  if (!CANITEDIT_VARIANTS.includes(variant)) return { error: `no CanItEdit variant ${variant}; have ${CANITEDIT_VARIANTS.join(', ')}` };
  const instruction = String(row[`instruction_${variant}`] || '').trim();
  if (!instruction) return { error: `row ${row.full_name || row.id} has no instruction_${variant}` };
  const name = String(row.full_name || `${row.id}_${row.name}`);
  return {
    task: {
      id: `canitedit-${variant}-${name}`,
      kind: `canitedit-${variant}`,
      name: `${name} (CanItEdit, ${variant})`,
      rounds,
      protect: [],
      files: { 'main.py': String(row.before) },
      hidden: { 'canitedit_tests.py': String(row.tests), 'canitedit_check.py': pythonRunner('main.py', 'canitedit_tests.py') },
      prompt: `Edit main.py as follows:\n\n${instruction}\n\nHidden tests are run against main.py after you finish; they are not in the workspace. Keep the existing names and signatures unless the instruction changes them.`,
      check: [exe, 'canitedit_check.py'],
      timeoutMs: 60000,
    },
    reference: String(row.after),
    stubName: 'main.py',
  };
}

export const HEFIX_LANGS = {
  python: { ext: 'py', label: 'Python' },
  js: { ext: 'js', label: 'JavaScript' },
};

// One HumanEvalFix row as a task: the buggy function to fix, its tests beside it.
// The round budget was 8 and is 14, measured rather than guessed: on the first
// real slice of the main tier (8 tasks, qwen2.5-coder:7b, 2026-09-25) five of
// eight runs ended rounds-exhausted at 8 while 59 per cent of their edits were
// not applying, so 8 rounds was measuring the budget rather than the work.
export function humanEvalFixTask(row, lang = 'python', { exe = 'python', node = 'node', rounds = 14 } = {}) {
  const spec = HEFIX_LANGS[lang];
  if (!spec) return { error: `no HumanEvalFix language ${lang}; have ${Object.keys(HEFIX_LANGS).join(', ')}` };
  const num = String(row.task_id || '').split('/').pop();
  const head = `${row.import || ''}${row.declaration || ''}`;
  const sol = `solution.${spec.ext}`, tests = `tests.${spec.ext}`, runner = `check.${spec.ext}`;
  const testBody = lang === 'js' ? `${JS_ASSERT_PRELUDE}${row.test_setup || ''}${row.test}` : `${row.test_setup || ''}${row.test}`;
  return {
    task: {
      id: `humanevalfix-${lang}-${num}`,
      kind: `humanevalfix-${lang}`,
      name: `${spec.label}/${num} ${row.entry_point} (HumanEvalFix)`,
      rounds,
      protect: [tests, runner],
      files: {
        [sol]: `${head}${row.buggy_solution}`,
        [tests]: testBody,
        [runner]: lang === 'js' ? jsRunner(sol, tests) : pythonRunner(sol, tests),
      },
      prompt: `Fix the bug in ${row.entry_point} in ${sol}. The tests in ${tests} must pass; run them with: ${lang === 'js' ? 'node' : 'python'} ${runner}. Do not change ${tests} or ${runner}: they grade the task, and a run that edits them does not count.`,
      check: [lang === 'js' ? node : exe, runner],
      timeoutMs: 60000,
    },
    reference: `${head}${row.canonical_solution}`,
    stubName: sol,
  };
}

// Proves every row and writes the ones that hold. `kind` is canitedit or
// humanevalfix; what was refused comes back with the reason.
export function convertRows(rows, kind, outDir, { variant = 'lazy', lang = 'python', limit = 0, only = [], write = true, rounds = 0 } = {}) {
  const needs = kind === 'humanevalfix' && lang === 'js' ? null : 'python';
  const ready = needs ? resolveRunner('python', { bare: true }) : { ok: true, exe: '', why: `node ${process.version}` };
  if (!ready.ok) return { ok: false, why: ready.why, wrote: [], refused: [], dir: outDir };
  let list = rows;
  const key = (r) => String(kind === 'canitedit' ? (r.full_name || r.id) : r.task_id);
  if (only.length) list = list.filter((r) => only.includes(key(r)) || only.includes(String(r.id)));
  if (limit > 0) list = list.slice(0, limit);
  if (!list.length) return { ok: false, why: `no ${kind} rows to convert`, wrote: [], refused: [], dir: outDir };
  if (write) ensureDir(outDir);
  const wrote = [], refused = [];
  for (const row of list) {
    // rounds 0 means "whatever the converter's own default is for this benchmark".
    const budget = rounds > 0 ? { rounds } : {};
    const built = kind === 'canitedit' ? canItEditTask(row, variant, { exe: ready.exe, ...budget })
      : kind === 'humanevalfix' ? humanEvalFixTask(row, lang, { exe: ready.exe, node: process.execPath, ...budget })
        : { error: `no converter for ${kind}; have canitedit, humanevalfix` };
    if (built.error) { refused.push({ name: key(row), why: built.error }); continue; }
    // The stub must fail three times: one CanItEdit check decides by timing.
    const proof = proveTask(built, lang === 'js' ? 'javascript' : 'python', { beforeRuns: 3 });
    if (!proof.ok) { refused.push({ name: key(row), why: proof.why }); continue; }
    if (write) fs.writeFileSync(path.join(outDir, `${built.task.id}.json`), `${JSON.stringify(built.task, null, 2)}\n`);
    wrote.push(built.task.id);
  }
  return { ok: wrote.length > 0, why: ready.why, wrote, refused, dir: outDir };
}

export function report(result) {
  const lines = [];
  if (!result.wrote.length) lines.push(`nothing converted: ${result.why}`);
  else lines.push(`${result.wrote.length} task(s) written to ${result.dir}, each proved to fail as shipped and pass with the benchmark's own reference (${result.why}).`);
  if (result.refused.length) {
    lines.push(`${result.refused.length} refused:`);
    for (const r of result.refused) lines.push(`  ${r.name}: ${r.why}`);
  }
  return lines.join('\n');
}
