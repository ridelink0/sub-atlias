// Background shell (H.A.C round two, 2026-10-22, h2, feature 5). A module only: the shell tool does not yet take
// "background": true, because lib/loop.mjs is pinned by the benchmark-path freeze (test/import-suites.mjs).
// A background command writes to a file under the session folder; the tool returns the id and the file at once,
// and poll returns the status and the last 4,000 characters. Nothing here ends a process: a job runs until it ends.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const POLL_CHARS = 4000;
const jobs = new Map();
let seq = 0;

export function start(command, { cwd, dir, spawnImpl = spawn } = {}) {
  const text = String(command || '').trim();
  if (!text) return 'background: give a command to run in the background';
  fs.mkdirSync(dir, { recursive: true });
  const id = `bg${++seq}-${Date.now().toString(36)}`;
  const file = path.join(dir, `${id}.log`);
  const fd = fs.openSync(file, 'w');
  let child;
  try { child = spawnImpl(text, { cwd, shell: true, stdio: ['ignore', fd, fd], windowsHide: true }); }
  catch (e) { fs.closeSync(fd); return `background: could not start: ${e && e.message ? e.message : e}`; }
  fs.closeSync(fd);
  const job = { id, command: text, file, startedAt: Date.now(), exit: null };
  job.done = new Promise((resolve) => {
    child.on('exit', (code, signal) => { job.exit = { code, signal }; resolve(job.exit); });
    child.on('error', (e) => { job.exit = { code: null, signal: null, error: e.message }; resolve(job.exit); });
  });
  if (typeof child.unref === 'function') child.unref();
  jobs.set(id, job);
  return { id, file, text: `started ${id}; its output goes to ${file}. Poll it with the shell tool and poll "${id}".` };
}

export function waitFor(id) {
  const job = jobs.get(String(id || '').trim());
  if (!job) return null;
  if (job.exit) return Promise.resolve(job.exit);
  // A waiting caller keeps the process alive; a job that nobody waits for does not.
  const keep = setInterval(() => {}, 1000);
  return job.done.then((e) => { clearInterval(keep); return e; });
}

export function poll(id) {
  const job = jobs.get(String(id || '').trim());
  if (!job) return `background: no job ${id}`;
  const status = job.exit
    ? (job.exit.error ? `failed to start: ${job.exit.error}` : `exited ${job.exit.code === null ? `by signal ${job.exit.signal}` : job.exit.code}`)
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
