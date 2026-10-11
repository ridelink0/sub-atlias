import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectCatalog } from '../lib/ultimate-benchmark.mjs';
import { direction } from '../lib/benchmark-oracle.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(file + '.tmp', file); };
export const ORPHANED = 'controller-ended-before-completion';

// The controller awaits each job, so a job still marked running at entry was
// left by a controller that ended mid-corpus: it is held, never counted solved.
export function sweepOrphans(journal) {
  for (const job of journal.jobs) if (job.status === 'running') Object.assign(job, { status: 'held', reason: ORPHANED });
  return journal;
}

// A suite runs once; a suite whose only jobs were orphaned gets one retry, so a
// corpus that ends its controller cannot repeat forever.
// `prefer` names suites to run before the rest, in that order. The evolution
// loop asks first for the corpus its screen tasks come from: a completed
// champion run on those tasks is what its screen is pooled with.
export function nextSuite(catalog, journal, prefer = []) {
  const orphaned = id => journal.jobs.filter(j => j.id === id && j.reason === ORPHANED).length;
  const open = catalog.suites.filter(s => s.kind === 'corpus' && s.availability === 'data-ready-runtime-unverified' && !journal.jobs.some(j => j.id === s.id && j.reason !== ORPHANED) && orphaned(s.id) < 2);
  return (Array.isArray(prefer) ? prefer : []).map(id => open.find(s => s.id === id)).find(Boolean) || open[0];
}

// The evolution controller awaits one full corpus at a round boundary.
// Every run has its own immutable report; unavailable adapters remain held.
export async function runUltimateBoundary({ root, champion, heartbeat = () => {}, stopRequested = () => false, engine = 'ollama', prefer = [] }) {
  if (!root || !champion?.config || engine !== 'ollama') throw Error('Gev boundary benchmark requires the original champion and an explicit root');
  const file = path.join(root, 'ULTIMATE-RUNS.json');
  const catalog = inspectCatalog({ corpusRoot: source });
  const journal = sweepOrphans(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { schema: 'atlias.ultimate.runs/1', jobs: [], unavailable: [] });
  journal.unavailable = catalog.suites.filter(s => s.availability === 'execution-evidence-required' || s.availability === 'corpus-unavailable-or-incomplete').map(s => ({ id: s.id, reason: s.availability }));
  const suite = nextSuite(catalog, journal, prefer);
  if (!suite || stopRequested()) { write(file, journal); return null; }
  const corpus = path.join(source, suite.directory);
  const tasks = fs.readdirSync(corpus).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(corpus, f), 'utf8')));
  const ids = tasks.map(t => t.id);
  const folder = path.join(root, 'ultimate', suite.id, Date.now().toString());
  const home = path.join(folder, 'home');
  const cfg = {};
  for (const [key, value] of Object.entries(champion.config)) { const [section, name] = key.split('.'); (cfg[section] ||= {})[name] = value; }
  write(path.join(home, 'config.json'), cfg);
  write(path.join(folder, 'ids.json'), ids);
  const reportFile = path.join(folder, 'report.json');
  const job = { id: suite.id, champion: champion.id, engine, expected: suite.expected, corpusHash: suite.contentHash, runtimeHash: digest(['bin/atlias.mjs', 'lib/core.mjs', 'lib/loop.mjs', 'lib/eval.mjs'].map(f => digest(fs.readFileSync(path.join(source, f)))).join('\n')), configHash: digest(JSON.stringify(cfg)), report: reportFile, startedAt: new Date().toISOString(), status: 'running' };
  journal.jobs.push(job); write(file, journal);
  heartbeat({ phase: 'ultimate-benchmark', suite: suite.id, expected: suite.expected, champion: champion.id });
  const tick = setInterval(() => heartbeat({ phase: 'ultimate-benchmark', suite: suite.id, expected: suite.expected, champion: champion.id }), 30000);
  const env = { ...process.env, ATLIAS_HOME: home, ATLIAS_EVAL_PARENT_PID: String(process.pid) };
  for (const key of Object.keys(env)) if (key.startsWith('ATLIAS_FLAG_')) delete env[key];
  const fd = fs.openSync(path.join(folder, 'output.log'), 'wx');
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(source, 'bin/atlias.mjs'), 'eval', '--corpus', corpus, '--engine', engine, '--save', reportFile, '--work', path.join(root, 'ultimate-work')], { env, cwd: source, windowsHide: true, stdio: ['ignore', fd, fd] });
      child.once('error', reject); child.once('close', resolve);
    });
  } catch (error) { job.error = error.message; code = null; }
  finally { clearInterval(tick); fs.closeSync(fd); }
  let report;
  try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch { report = null; }
  const rows = report?.results || [];
  const got = rows.map(r => r.id);
  const unchanged = digest(['bin/atlias.mjs', 'lib/core.mjs', 'lib/loop.mjs', 'lib/eval.mjs'].map(f => digest(fs.readFileSync(path.join(source, f)))).join('\n')) === job.runtimeHash && inspectCatalog({ corpusRoot: source }).suites.find(s => s.id === suite.id)?.contentHash === job.corpusHash;
  const complete = [0, 1].includes(code) && unchanged && report?.partial !== true && report?.promptTotal > 0 && Number.isSafeInteger(report?.outputTotal) && got.length === suite.expected && new Set(got).size === ids.length && ids.every(id => got.includes(id));
  Object.assign(job, { status: complete ? 'completed' : 'held', exit: code, recorded: rows.length, solved: rows.filter(r => r.pass === true).length, endedAt: new Date().toISOString(), inputTokens: Number.isSafeInteger(report?.promptTotal) ? report.promptTotal : null, outputTokens: Number.isSafeInteger(report?.outputTotal) ? report.outputTotal : null, ms: Number.isFinite(report?.ms) ? report.ms : null });
  write(file, journal);
  if (report) write(path.join(folder, 'direction.json'), direction(report, { expectedIds: ids }));
  return job;
}
