// Background shell (H.A.C round two, 2026-10-22, h2, feature 5; fixes B1 and B2 from h4). A background command
// writes to a file under the session folder; start returns the id and the file at once; poll returns the status
// and the last 4,000 characters; kill stops a job from its own handle. Limits per job and for the whole session:
// at most four running at once, a 30-minute time limit, and a 20 MB output cap (the job is stopped when it is hit).
// The gate passed to start is the shell's guard: a command it refuses is never started, because a background
// job has no one to confirm it. The loop passes the same guard and permission check it runs for the shell tool.
// On Windows, kill ends the shell process by its handle; a child the command started can outlive it (a limit).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { endTree } from './proc.mjs';

export const POLL_CHARS = 4000;
export const MAX_RUNNING = 4;
export const WALL_MS = 30 * 60 * 1000;
export const LOG_CAP = 20 * 1024 * 1024;
export const WATCH_MS = 2000;
const jobs = new Map();
let seq = 0;

export function running() {
  let n = 0;
  for (const j of jobs.values()) if (!j.exit) n++;
  return n;
}

function clearTimers(job) {
  clearTimeout(job.wall);
  clearInterval(job.watch);
}

function stop(job, reason) {
  if (job.exit || job.stopping) return false;
  job.stopping = reason;
  // h4 B3: the whole tree Atlias started, as the shell watchdog does; killing the shell alone left its
  // children writing (a probe kept adding about 8 MB a second after kill).
  try { if (job.child.pid) job.treeStop(job.child.pid, job.child); else job.child.kill(); } catch { /* already gone */ }
  return true;
}

export function start(command, { cwd, dir, gate = null, spawnImpl = spawn, maxRunning = MAX_RUNNING, wallMs = WALL_MS, logCap = LOG_CAP, watchMs = WATCH_MS, treeStop = endTree } = {}) {
  const text = String(command || '').trim();
  if (!text) return 'background: give a command to run in the background';
  const refusal = gate ? gate(text) : null;
  if (refusal) return `background: refused: ${refusal}. A background job cannot be confirmed, so it was not started.`;
  if (running() >= maxRunning) return `background: ${maxRunning} jobs are already running; poll or kill one first`;
  fs.mkdirSync(dir, { recursive: true });
  const id = `bg${++seq}-${Date.now().toString(36)}`;
  const file = path.join(dir, `${id}.log`);
  const fd = fs.openSync(file, 'w');
  let child;
  try { child = spawnImpl(text, { cwd, shell: true, stdio: ['ignore', fd, fd], windowsHide: true }); }
  catch (e) { fs.closeSync(fd); return `background: could not start: ${e && e.message ? e.message : e}`; }
  fs.closeSync(fd);
  const job = { id, command: text, file, child, startedAt: Date.now(), exit: null, stopping: null, wall: null, watch: null, treeStop };
  jobs.set(id, job);
  job.done = new Promise((resolve) => {
    child.on('exit', (code, signal) => { job.exit = { code, signal }; clearTimers(job); resolve(job.exit); });
    child.on('error', (e) => { job.exit = { code: null, signal: null, error: e.message }; clearTimers(job); resolve(job.exit); });
  });
  job.wall = setTimeout(() => stop(job, `time limit of ${wallMs / 1000} s reached`), wallMs);
  job.watch = setInterval(() => {
    try { if (fs.statSync(file).size > logCap) stop(job, `output cap of ${logCap} bytes reached`); } catch { /* no output yet */ }
  }, watchMs);
  job.wall.unref();
  job.watch.unref();
  if (typeof child.unref === 'function') child.unref();
  return { id, file, text: `started ${id}; its output goes to ${file}. Poll it with the background tool and poll "${id}"; stop it with kill "${id}".` };
}

export function waitFor(id) {
  const job = jobs.get(String(id || '').trim());
  if (!job) return null;
  if (job.exit) return Promise.resolve(job.exit);
  // A waiting caller keeps the process alive; a job that nobody waits for does not.
  const keep = setInterval(() => {}, 1000);
  return job.done.then((e) => { clearInterval(keep); return e; });
}

export function kill(id) {
  const job = jobs.get(String(id || '').trim());
  if (!job) return `background: no job ${id}`;
  if (job.exit) return `${id} already finished; poll shows how it ended`;
  stop(job, 'killed by request');
  return `${id}: stop sent; poll shows the final status`;
}

export function poll(id) {
  const job = jobs.get(String(id || '').trim());
  if (!job) return `background: no job ${id}`;
  const status = job.exit
    ? (job.exit.error ? `failed to start: ${job.exit.error}` : job.stopping ? `stopped (${job.stopping})` : `exited ${job.exit.code === null ? `by signal ${job.exit.signal}` : job.exit.code}`)
    : 'running';
  let total = 0;
  let tail = '';
  try {
    total = fs.statSync(job.file).size;
    const n = Math.min(total, POLL_CHARS * 4);
    const buf = Buffer.alloc(n);
    const fd = fs.openSync(job.file, 'r');
    try { fs.readSync(fd, buf, 0, n, total - n); } finally { fs.closeSync(fd); }
    tail = buf.toString('utf8').slice(-POLL_CHARS);
  } catch { /* no output yet */ }
  return `${job.id} ${status}\n${tail}\n[${total} bytes of output so far]`;
}
