// Gev's suite ledger keeps unavailable infrastructure and unknown costs visible.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ULTIMATE_PATH = fileURLToPath(new URL('../benchmarks/ultimate.json', import.meta.url));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

export function catalog(manifestPath = ULTIMATE_PATH) {
  const bytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(bytes);
  if (manifest.schema !== 'atlias.ultimate.v1' || !Array.isArray(manifest.suites) || !manifest.suites.length) throw new Error('Gev Ultimate manifest is invalid');
  const ids = new Set();
  for (const suite of manifest.suites) {
    if (!suite?.id || ids.has(suite.id) || !suite.requirement || !suite.grading) throw new Error('Gev Ultimate suite identity or evidence contract is invalid');
    ids.add(suite.id);
  }
  for (const suite of manifest.suites) {
    if (suite.kind === 'composite' && (!Array.isArray(suite.members) || suite.members.some(id => id === suite.id || !ids.has(id)))) throw new Error('Gev Ultimate composite has unknown members');
  }
  return { ...manifest, manifestHash: sha(bytes) };
}

export function inspectCatalog({ corpusRoot, manifestPath } = {}) {
  if (!corpusRoot) throw new Error('Gev corpus root must be explicit');
  const manifest = catalog(manifestPath);
  const root = path.resolve(corpusRoot);
  const suites = manifest.suites.map(suite => {
    let availableTasks = null, contentHash = null;
    let availability = suite.kind === 'software' ? 'software-checks-ready' : suite.kind === 'preserved' ? 'preserved-history' : 'execution-evidence-required';
    if (suite.kind === 'corpus') {
      const dir = path.resolve(root, suite.directory);
      const relative = path.relative(root, dir);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Gev corpus directory escapes its explicit root');
      let names = [];
      try { names = fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort(); } catch { /* absent means unavailable */ }
      const tasks = names.map(name => ({ name, bytes: fs.readFileSync(path.join(dir, name)) }));
      const rows = tasks.map(task => JSON.parse(task.bytes));
      const identities = new Set(rows.map(row => row?.id));
      const valid = rows.every(row => typeof row?.id === 'string' && row.id && typeof row.prompt === 'string' && row.check) && identities.size === rows.length;
      availableTasks = valid ? rows.length : 0;
      contentHash = valid && rows.length ? sha(tasks.map(task => task.name + '\0' + sha(task.bytes)).join('\n')) : null;
      availability = availableTasks === suite.expected ? 'data-ready-runtime-unverified' : 'corpus-unavailable-or-incomplete';
    }
    return { ...suite, availability, availableTasks, contentHash, completed: false };
  });
  for (const suite of suites.filter(s => s.kind === 'composite')) {
    const members = suite.members.map(id => suites.find(s => s.id === id));
    suite.availableTasks = members.every(m => m.availableTasks !== null) ? members.reduce((n, m) => n + m.availableTasks, 0) : null;
    suite.availability = members.every(m => m.availability === 'data-ready-runtime-unverified') && suite.availableTasks === suite.expected ? 'data-ready-runtime-unverified' : 'corpus-unavailable-or-incomplete';
    suite.contentHash = members.every(m => m.contentHash) ? sha(members.map(m => m.id + ':' + m.contentHash).join('\n')) : null;
  }
  return { schema: manifest.schema, name: manifest.name, manifestHash: manifest.manifestHash, targets: manifest.targets, policy: manifest.policy, suites, scope: 'Availability is not a benchmark pass. No model inference was launched.' };
}

export function runSoftwareContracts({ sourceRoot, manifestPath } = {}) {
  const suite = catalog(manifestPath).suites.find(s => s.id === 'contract-oracle');
  const results = suite.commands.map(([program, ...args]) => {
    if (program !== 'node') throw new Error('Gev oracle permits only pinned Node contract commands');
    const run = spawnSync(process.execPath, args, { cwd: sourceRoot, windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    return { command: [program, ...args], exit: run.status, error: run.error?.message || null, stdout: run.stdout || '', stderr: run.stderr || '', passed: run.status === 0 && !run.error };
  });
  return { suite: suite.id, passed: results.length === 2 && results.every(r => r.passed), results, scope: 'Software fixtures only; no local-model or native capability proof.' };
}

export function wilsonInterval(passed, total, z = 1.959963984540054) {
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(passed) || passed < 0 || passed > total || typeof z !== 'number' || !Number.isFinite(z) || z <= 0) return null;
  const rate = passed / total, square = z * z, denominator = 1 + square / total;
  const middle = (rate + square / (2 * total)) / denominator;
  const radius = z * Math.sqrt(rate * (1 - rate) / total + square / (4 * total * total)) / denominator;
  return { lower: Math.max(0, middle - radius), upper: Math.min(1, middle + radius), scope: 'Binomial interval for this task set; no general capability or adaptive-search guarantee.' };
}
