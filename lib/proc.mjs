// Running code that may never stop, and making sure it does.
//
// Everything atlias runs that a model wrote (the agent's shell tool, the check
// that scores an eval task, a benchmark stub being proved) goes through here.
// spawnSync's own timeout ends only the process it started: under a shell that
// is the shell, and the program it ran is orphaned. On Windows nothing reaps an
// orphan, so a model-written infinite loop holds a core until the machine
// restarts (2026-09-26: HumanEvalFix/10, three pythons, hours).
//
// So the command is started under lib/watchdog.mjs, which ends the whole tree
// at the limit, when the asking process goes away, or on Ctrl+C. The result
// keeps spawnSync's shape (status, signal, stdout, stderr, error) and adds
// timedOut and pid.
//
// What this cannot stop: a program that deliberately leaves the tree (start on
// Windows, setsid or a daemon elsewhere) before the limit. reap() is the second
// net for that inside an eval, where nothing a task started should outlive it.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WATCHDOG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'watchdog.mjs');
const win = process.platform === 'win32';
// On Windows, node puts every child it starts into a job object that dies with
// it, and a child of that child started by anything but node (cmd.exe, python)
// is not in the job. So a watchdog started the ordinary way would die with the
// process that asked for it, and leave exactly the grandchild it exists to end.
// Detached, it is outside that job and outlives its parent long enough to end
// the tree. Elsewhere it stays in the parent's process group, so Ctrl+C at the
// terminal reaches it.
const DETACH = win;
// Past the command's own limit, how long the caller waits for the watchdog
// itself before ending it too. Only a watchdog that could not start its own
// taskkill ever reaches this.
const BACKSTOP_MS = 20000;
const ABORT_GRACE_MS = 1500;

function verdictOf(text) {
  const rows = String(text || '').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const pid = (rows.find((r) => r.pid) || {}).pid || 0;
  const last = rows.filter((r) => 'code' in r).pop() || null;
  return { pid, last };
}

function shape({ out, err, fd3, status, signal, spawnErr, limitMs, backstop, memoryMB }) {
  const { pid, last } = verdictOf(fd3);
  const timedOut = Boolean(last && last.timedOut) || backstop;
  const overMemory = Boolean(last && last.overMemory) && !timedOut;
  let error;
  if (spawnErr) error = spawnErr;
  else if (timedOut) error = Object.assign(new Error(`timed out after ${limitMs} ms; the command and everything it started were stopped`), { code: 'ETIMEDOUT' });
  else if (overMemory) error = Object.assign(new Error(`stopped for memory: the command and what it started held more than ${memoryMB} MiB, so they were all stopped`), { code: 'EMEMORY' });
  else if (last && last.error) error = new Error(last.error);
  else if (last && last.orphaned) error = new Error('the process that started this command went away, so it was stopped');
  else if (last && last.interrupted) error = new Error(`stopped by ${last.interrupted}`);
  else if (!last) error = new Error(`the watchdog ended without a verdict (exit ${status}${signal ? `, ${signal}` : ''})`);
  return {
    // A command that was stopped has no exit status of its own: the number
    // taskkill leaves behind is not the program's answer.
    status: last && !timedOut && !overMemory && !last.orphaned && !last.interrupted ? last.code : null,
    signal: last ? last.signal : signal || null,
    stdout: out,
    stderr: err,
    error,
    timedOut,
    overMemory,
    pid,
  };
}

// The most memory a command and everything it started may hold, in MiB. No
// limit unless one is given, here or for a whole run in
// ATLIAS_COMMAND_MEMORY_MB: a build can rightly hold several GB, the program
// of a benchmark task cannot, so the evolution loop sets it and ordinary use
// does not. Enforced on Windows only (lib/watchdog.mjs).
export function memoryLimit(given) {
  const n = Number(given === undefined || given === null ? process.env.ATLIAS_COMMAND_MEMORY_MB : given);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0;
}

// The watchdog passes on at most half the caller's buffer per stream, so the
// caller never overflows and never ends the watchdog before the tree.
const specFor = (cmd, args, o) => JSON.stringify({ cmd, args: args || [], shell: Boolean(o.shell), cwd: o.cwd || '', timeoutMs: o.timeoutMs, ppid: process.pid, maxOutput: Math.max(1024, Math.floor((o.maxBuffer || 16 * 1024 * 1024) / 2)), memoryMB: o.memoryMB });

// Synchronous, for callers that are (score, proveTask). Blocks the caller, not
// the watchdog: the watchdog keeps its own clock.
export function runSync(cmd, args = [], { cwd, timeoutMs = 60000, env, shell = false, maxBuffer = 16 * 1024 * 1024, memoryMB } = {}) {
  const limitMs = Math.max(1, Number(timeoutMs) || 60000);
  const limitMB = memoryLimit(memoryMB);
  const r = spawnSync(process.execPath, [WATCHDOG, specFor(cmd, args, { cwd, timeoutMs: limitMs, shell, maxBuffer, memoryMB: limitMB })], {
    cwd: cwd || undefined,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer,
    timeout: limitMs + BACKSTOP_MS,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    detached: DETACH,
  });
  const fd3 = r.output ? r.output[3] : '';
  const backstop = Boolean(r.error && r.error.code === 'ETIMEDOUT');
  // The watchdog itself outran the backstop, or was ended for overflowing the
  // buffer (which its own cap should prevent): end what it may have left.
  if (backstop || (r.error && r.error.code === 'ENOBUFS')) { const { pid } = verdictOf(fd3); if (pid) endTree(pid); }
  return shape({ out: r.stdout || '', err: r.stderr || '', fd3, status: r.status, signal: r.signal, spawnErr: r.error && !backstop ? r.error : null, limitMs, backstop, memoryMB: limitMB });
}

// The same, without blocking: the agent's shell tool.
// TUI-B: the shell commands this harness is running now, so an interrupt can end them the way the timeout does.
const running = new Set();
export function abortRunning() { for (const stop of running) stop(); }
export function runAsync(cmd, args = [], { cwd, timeoutMs = 600000, env, shell = false, maxBuffer = 16 * 1024 * 1024, memoryMB } = {}) {
  const limitMs = Math.max(1, Number(timeoutMs) || 600000);
  const limitMB = memoryLimit(memoryMB);
  return new Promise((resolve) => {
    let w;
    try {
      w = spawn(process.execPath, [WATCHDOG, specFor(cmd, args, { cwd, timeoutMs: limitMs, shell, maxBuffer, memoryMB: limitMB })], {
        cwd: cwd || undefined,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        detached: DETACH,
      });
    } catch (e) {
      resolve({ status: null, signal: null, stdout: '', stderr: '', error: e, timedOut: false, overMemory: false, pid: 0 });
      return;
    }
    const out = [], err = [], fd3 = [];
    let size = 0, settled = false, backstop = false, abortGuard = null;
    running.add(stop);
    function stop() {
      if (settled || abortGuard) return;
      if (win) { endTree(w.pid); return; }
      // The watchdog is not a POSIX group leader; SIGKILLing it first would
      // prevent its handler from ending the command's separate process group.
      try { w.kill('SIGTERM'); } catch { /* force cleanup below if still live */ }
      abortGuard = setTimeout(() => {
        if (settled) return;
        const { pid } = verdictOf(Buffer.concat(fd3).toString('utf8'));
        if (pid) endTree(pid);
        if (w.exitCode === null && w.signalCode === null) endTree(w.pid);
      }, ABORT_GRACE_MS);
      abortGuard.unref();
    }
    const take = (list) => (d) => { if (size < maxBuffer) { list.push(d); size += d.length; } };
    w.stdout.on('data', take(out));
    w.stderr.on('data', take(err));
    if (w.stdio[3]) w.stdio[3].on('data', (d) => fd3.push(d));
    const guard = setTimeout(() => {
      backstop = true;
      const { pid } = verdictOf(Buffer.concat(fd3).toString('utf8'));
      if (pid) endTree(pid);
      endTree(w.pid);
      setTimeout(() => done(null, null, null), 3000).unref();
    }, limitMs + BACKSTOP_MS);
    function done(code, signal, spawnErr) {
      if (settled) return;
      settled = true;
      running.delete(stop);
      clearTimeout(guard);
      clearTimeout(abortGuard);
      resolve(shape({ out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8'), fd3: Buffer.concat(fd3).toString('utf8'), status: code, signal, spawnErr, limitMs, backstop, memoryMB: limitMB }));
    }
    w.on('error', (e) => done(null, null, e));
    w.on('close', (code, signal) => done(code, signal, null));
  });
}

// Ends a process and everything under it. Only for processes this harness
// started: a pid is not a window, and a guessed pid is somebody else's program.
export function endTree(pid) {
  if (!pid) return;
  if (win) {
    try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000, stdio: 'ignore' }); } catch { /* already gone */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}

// Is anything still running that one of these commands started? The commands
// themselves have exited; what matters is a process they left behind (a
// backgrounded loop, `start /b` on Windows). Elsewhere each command led its own
// process group, and a group outlives its leader, so the group is asked. On
// Windows an orphan keeps its dead parent's pid as ParentProcessId, so one
// process listing finds them; a pid Windows has since given to a new process is
// told apart by creation time, and nothing started before `since` is touched.
// Returns the pids (or groups) found, or null when Windows would not list its
// processes (so a count of none is never claimed unseen); with kill, ends them.
export function leftovers(pids, { since = 0, kill = false, list = listProcesses } = {}) {
  const roots = [...new Set((pids || []).map(Number).filter((n) => n > 0))];
  if (!roots.length) return [];
  if (!win && list === listProcesses) {
    const found = [];
    for (const pid of roots) {
      try { process.kill(-pid, 0); found.push(pid); if (kill) process.kill(-pid, 'SIGKILL'); } catch { /* no such group */ }
    }
    return found;
  }
  const rows = list();
  if (!rows) return null;
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const kids = new Map();
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); }
  const found = [];
  const seen = new Set();
  const walk = (parentPid, after, before) => {
    for (const c of kids.get(parentPid) || []) {
      if (seen.has(c.pid) || c.created < after || c.created > before) continue;
      seen.add(c.pid);
      found.push(c.pid);
      walk(c.pid, c.created, Infinity);
    }
  };
  for (const root of roots) {
    // Our command is dead. If its pid is in use again, only processes created
    // before that newcomer can have been ours.
    const reused = byPid.get(root);
    walk(root, since - 1000, reused ? reused.created : Infinity);
  }
  if (kill) for (const pid of found) endTree(pid);
  return found;
}

// Every process, its parent, and when it started (ms since the epoch), or null
// when the listing could not be had. Windows only; elsewhere groups are used.
export function listProcesses() {
  if (!win) return null;
  const script = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
  // Asked twice: on a machine busy with two eval runs and the test suite, one
  // listing took longer than its limit and the leftover search came back empty
  // while the process it was looking for was still running.
  let r = null;
  for (let attempt = 0; attempt < 2 && (!r || r.status !== 0); attempt++) {
    try { r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60000 }); } catch { r = null; }
  }
  if (!r || r.status !== 0) return null;
  const rows = [];
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+) (\d+) (\d+)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), created: Number(m[3]) });
  }
  return rows.length ? rows : null;
}
