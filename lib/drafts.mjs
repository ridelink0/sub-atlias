// Unsent input, separate from sessions and memory. Reuse the importer's secret rules.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redactInline } from './import.mjs';

export function fileFor(home, cwd) {
  const project = path.resolve(cwd);
  const id = crypto.createHash('sha256').update(process.platform === 'win32' ? project.toLowerCase() : project).digest('hex').slice(0, 24);
  return path.join(home, 'drafts', `${id}.json`);
}
const empty = () => ({ prompt: '', queued: [], steers: [] });
function valid(value) {
  return value && typeof value.prompt === 'string' && ['queued', 'steers'].every(k => Array.isArray(value[k]) && value[k].every(t => typeof t === 'string'));
}
export function read(file) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return valid(value) ? value : empty(); }
  catch { return empty(); }
}
export function createStore(file, { proc = process, delay = 250, onError = () => {} } = {}) {
  let value = read(file), timer = null, maxTimer = null, dirty = false, last = JSON.stringify(value);
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
    if (!dirty) return;
    const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const clean = { prompt: redactInline(value.prompt).text, queued: value.queued.map(t => redactInline(t).text), steers: value.steers.map(t => redactInline(t).text) };
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(clean)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, file);
      dirty = false;
    } catch (error) { try { fs.unlinkSync(temp); } catch {} onError(error); }
  };
  const exit = () => flush();
  // While another listener owns the signal (an /auth sign-in's Ctrl+C cancel), the draft is saved and that listener decides.
  const signalled = (name, code) => () => { flush(); if (proc.listenerCount(name) <= 1) proc.exit(code); };
  const handlers = { exit, SIGINT: signalled('SIGINT', 130), SIGTERM: signalled('SIGTERM', 143), uncaughtExceptionMonitor: exit };
  for (const [name, fn] of Object.entries(handlers)) proc.on(name, fn);
  return {
    initial: structuredClone(value),
    save(next) {
      if (!valid(next)) throw new TypeError('Invalid draft snapshot.');
      const text = JSON.stringify(next);
      if (text === last) return;
      value = structuredClone(next); last = text; dirty = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delay); timer.unref?.();
      if (!maxTimer) { maxTimer = setTimeout(flush, 2000); maxTimer.unref?.(); }
    },
    flush,
    close() { flush(); for (const [name, fn] of Object.entries(handlers)) proc.removeListener(name, fn); },
  };
}
