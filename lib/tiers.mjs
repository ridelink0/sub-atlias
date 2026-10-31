// Benchmark tiers: which corpus a measurement is taken on, and what that corpus
// can and cannot show.
//
// atlias had one corpus that ran by default (nine hand-written tasks) and two
// that could be converted but had to be named by path. That is how poly-A came
// to be the only number anybody quoted, and poly-A scored 0 of 27: at zero
// passes the old arm of an A/B has nothing to lose, so the new arm needs six
// gains on tasks the model has already failed before a p below 0.05 is even
// possible. Three tiers, each with a job:
//
//   smoke  the nine shipped tasks. Minutes, nothing to download. It answers
//          "does the harness still work", not "is it good".
//   main   HumanEvalFix Python and CanItEdit lazy: one-function bug fixes and
//          short instruction edits. Qwen2.5-Coder-7B scored 57.9 per cent on
//          Aider's 133-task Exercism edit benchmark, so this is the band where
//          a change can move a number in either direction.
//   big    Aider's refactor benchmark: one method out of one class in a real
//          source file of a few tens of kilobytes, graded on the AST. The tier
//          that punishes eliding code and a window too small to hold the file.
//
// The main and big corpora are generated from somebody else's dataset and are
// not in git (evals/CORPORA.md says why and how to regenerate them), so every
// function here has to be honest about a tier that is not on this machine
// rather than quietly scoring nothing.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './core.mjs';
import { loadTasks } from './eval.mjs';

export const TIERS = {
  smoke: {
    what: 'the nine tasks written for atlias: minutes, nothing to download, and it proves the plumbing rather than the model',
    dirs: ['evals'],
    generated: false,
    regenerate: [],
  },
  main: {
    what: 'HumanEvalFix Python (164) and CanItEdit lazy (88): one-function bug fixes and short instruction edits, the band where a 7B scores between 30 and 70 per cent',
    dirs: ['evals/humanevalfix/python', 'evals/canitedit/lazy'],
    generated: true,
    expect: 252,
    expectWhy: 'HumanEvalFix Python 164 of 164 and CanItEdit lazy 88 of 105; the other 17 CanItEdit tasks need pandas, torch, z3, sklearn, autograd or vllm, or already pass untouched',
    regenerate: [
      'atlias editbench <humanevalpack-python.jsonl> --bench humanevalfix --lang python',
      'atlias editbench <canitedit.jsonl> --bench canitedit --variant lazy',
    ],
  },
  big: {
    what: "Aider's refactor benchmark: move one method out of its class in a real source file (median 26 KB), graded on the AST with no tests to install",
    dirs: ['evals/refactor'],
    generated: true,
    expect: 57,
    expectWhy: "57 of the benchmark's 89 tasks: 31 source files are over the 40 KB cap the converter applies by default, and 1 cannot be proved because the move cannot be made mechanically",
    regenerate: [
      'git clone https://github.com/Aider-AI/refactor-benchmark',
      'atlias refactorbench refactor-benchmark/refactor-benchmark',
    ],
  },
};

export function tierNames() { return Object.keys(TIERS); }

export function resolveTier(name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return { ok: false, why: `name a tier: ${tierNames().join(', ')}` };
  if (!TIERS[want]) return { ok: false, why: `no tier ${want}; have ${tierNames().join(', ')}` };
  return { ok: true, name: want, tier: TIERS[want] };
}

// A generator seeded by a string, so a sample is the same sample on every
// machine and in every arm of an A/B. Math.random would give the two arms
// different subsets, and compare() would then pair almost nothing.
export function seedRandom(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return function next() {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// N tasks out of the tier, the same N every time. Sorted by id first so the
// order the files happened to be read in cannot change the sample, shuffled with
// the seeded generator, then sorted again so the run order does not depend on
// the seed either.
export function sampleTasks(tasks, n, seed = 'atlias') {
  const all = [...tasks].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const want = Math.floor(Number(n) || 0);
  if (!(want > 0) || want >= all.length) return all;
  const rng = seedRandom(seed);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = all[i]; all[i] = all[j]; all[j] = swap;
  }
  return all.slice(0, want).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

// The tier's tasks, plus what was not there. `load` is injected so a test can
// point a tier at a fixture tree without writing into the repository's own
// evals directory.
export function tierTasks(name, { root = ROOT, load = loadTasks } = {}) {
  const found = resolveTier(name);
  if (!found.ok) return { ok: false, why: found.why, name: '', tasks: [], present: [], missing: [], duplicates: [] };
  const tasks = [], present = [], missing = [];
  for (const rel of found.tier.dirs) {
    const dir = path.join(root, rel);
    const got = load(dir);
    if (!got.length) {
      let why = 'not on this machine';
      try { if (fs.existsSync(dir)) why = 'the folder is there but holds no task files'; } catch { /* treat as absent */ }
      missing.push({ dir: rel, why });
      continue;
    }
    present.push({ dir: rel, count: got.length });
    tasks.push(...got);
  }
  // Two tasks with one id would pair with each other in compare and be counted
  // twice in the score.
  const seen = new Set(), duplicates = [];
  for (const t of tasks) { if (seen.has(t.id)) duplicates.push(t.id); else seen.add(t.id); }
  return {
    ok: tasks.length > 0,
    name: found.name,
    tier: found.tier,
    tasks,
    present,
    missing,
    duplicates,
    why: tasks.length ? '' : `the ${found.name} tier is not on this machine: ${missing.map((m) => `${m.dir} (${m.why})`).join(', ')}`,
  };
}

// What `atlias tiers` prints: for each tier, what it is for, how much of it is
// here, and the command for the part that is not.
export function statusLines({ root = ROOT, load = loadTasks } = {}) {
  const lines = [];
  for (const name of tierNames()) {
    const got = tierTasks(name, { root, load });
    const expect = TIERS[name].expect && got.tasks.length !== TIERS[name].expect ? `, against ${TIERS[name].expect} when this tier was measured` : '';
    lines.push(`${name}: ${TIERS[name].what}`);
    if (got.tasks.length) {
      lines.push(`  ${got.tasks.length} task(s) here${expect} (${got.present.map((p) => `${p.dir} ${p.count}`).join(', ')})`);
      if (TIERS[name].expectWhy) lines.push(`  ${TIERS[name].expectWhy}`);
    } else lines.push('  not on this machine');
    for (const m of got.missing) lines.push(`  missing: ${m.dir} - ${m.why}`);
    if (got.duplicates.length) lines.push(`  two tasks share an id, which would be counted twice: ${got.duplicates.join(', ')}`);
    if (got.missing.length && TIERS[name].regenerate.length) {
      lines.push('  regenerate with:');
      for (const c of TIERS[name].regenerate) lines.push(`    ${c}`);
      lines.push('  evals/CORPORA.md has the dataset URLs and the licence of each.');
    }
    lines.push(`  atlias eval --tier ${name}${TIERS[name].expect ? ' --sample 24' : ''} --engine ollama`);
  }
  return lines.join('\n');
}
