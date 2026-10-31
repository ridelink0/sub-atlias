#!/usr/bin/env node
// The study's task list, picked with atlias's own seeded sampler
// (lib/tiers.mjs sampleTasks) from each source separately, so the mix is fixed
// by the command line and the same seed picks the same tasks on any machine
// that holds the same corpus.
//
//   node tools/ccstudy/select.mjs --seed s --take evals/humanevalfix/python=20,evals/refactor=4 --out list.json
//
// Each source is a folder of task files relative to the repository.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadTasks } from '../../lib/eval.mjs';
import { sampleTasks } from '../../lib/tiers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function parseTake(spec) {
  return String(spec || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const eq = s.lastIndexOf('=');
    if (eq < 1) throw new Error(`--take wants dir=N, got ${s}`);
    return { dir: s.slice(0, eq), n: Number(s.slice(eq + 1)) };
  });
}

// The files are hashed so a list names exactly the task text that ran, not
// only its id: a regenerated corpus that changed a task shows up as a new hash.
export function select(take, seed, { root = REPO } = {}) {
  const tasks = [];
  const sources = [];
  for (const { dir, n } of take) {
    const full = path.join(root, dir);
    const all = loadTasks(full);
    const files = new Map();
    for (const f of fs.readdirSync(full).filter((x) => x.endsWith('.json'))) {
      try { const t = JSON.parse(fs.readFileSync(path.join(full, f), 'utf8')); if (t && t.id) files.set(t.id, f); } catch { /* loadTasks skipped it too */ }
    }
    const picked = sampleTasks(all, n, seed);
    sources.push({ dir, of: all.length, took: picked.length });
    for (const t of picked) {
      const rel = path.join(dir, files.get(t.id));
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
      tasks.push({ id: t.id, file: rel, source: dir, sha256 });
    }
  }
  return { seed, sampler: 'lib/tiers.mjs sampleTasks, per source', sources, tasks };
}

function opt(argv, name, dflt = '') { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const list = select(parseTake(opt(argv, '--take')), opt(argv, '--seed', 'atlias'));
  const out = opt(argv, '--out');
  const text = `${JSON.stringify(list, null, 2)}\n`;
  if (out) fs.writeFileSync(out, text); else process.stdout.write(text);
  for (const s of list.sources) console.error(`${s.dir}: ${s.took} of ${s.of}`);
}
