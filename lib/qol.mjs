// Quality-of-life helpers for the atlias repl, from the terminal feature research (research-qol.md):
// @file mentions, /context, long-turn notifications, /release-notes, session names.
// Interactive only: lib/agent.mjs calls these from the repl loop; atlias exec, eval, runLoop and
// tools/h2h never reach this file.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, readText, config } from './core.mjs';
import { imageMime, normalizeImages } from './media-input.mjs';

// ---------- @file mentions ----------
export const MENTION_MAX_FILES = 8;
export const MENTION_FILE_BYTES = 20000;
export const MENTION_TOTAL_BYTES = 60000;
// @ at the start or after whitespace, then a path; a trailing . , ; : ) is punctuation, not the path.
const MENTION_RE = /(^|\s)@(?:"([^"\r\n]+)"|'([^'\r\n]+)'|((?:[\w.~-]+[\\/])*[\w.~-]*[\w~-]))(?=[\s.,;:!?)\]]*(?:\s|$))/g;

// A real path is inside the folder (symlinks followed) and not inside .git.
function inside(rootReal, target) {
  const r = path.relative(rootReal, target);
  return r !== '' && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r);
}
// Project-only text and image mentions; raw user instructions remain separate from reference data.
// Anything else is left as typed and, when it looked like a path, named in notes.
export function expandMentions(text, cwd, imageOptions = config().attachments) {
  const src = String(text || '');
  const files = [];
  const notes = [];
  const images = [], imageErrors = [];
  let total = 0;
  let rootReal;
  try { rootReal = fs.realpathSync(cwd); } catch { return { text: src, files, notes }; }
  const seen = new Set();
  const seenReal = new Set();
  const blocks = [];
  for (const m of src.matchAll(MENTION_RE)) {
    const token = m[2] || m[3] || m[4];
    const imagePath = /\.(png|jpe?g|webp|gif)$/i.test(token);
    const imageError = reason => { const note = `@${token} not attached: ${reason}`; notes.push(note); imageErrors.push(note); };
    if (seen.has(token)) continue;
    seen.add(token);
    const looksLikePath = /[\\/.]/.test(token);
    let real;
    try { real = fs.realpathSync(path.resolve(cwd, token)); } catch { if (imagePath) imageError('image file was not found'); continue; }
    const inProject = inside(rootReal, real), inGit = real.split(path.sep).some(p => p.toLowerCase() === '.git');
    const externalImage = imagePath && imageOptions?.allowExternal === true && path.isAbsolute(token);
    if (inGit || (!inProject && !externalImage)) {
      if (imagePath) imageError(inGit ? 'images inside .git are not attached' : 'image is outside the project; move it into the project, or opt in with /config attachments.allowExternal true and use its absolute path');
      else if (looksLikePath) notes.push(`@${token} is outside the project, so it was not attached`);
      continue;
    }
    const realKey = process.platform === 'win32' ? real.toLowerCase() : real;
    if (seenReal.has(realKey)) continue;
    let st;
    try { st = fs.statSync(real); } catch { if (imagePath) imageError('image file could not be inspected'); continue; }
    if (!st.isFile()) { if (imagePath) imageError('the image path is a folder, not a file'); else if (looksLikePath) notes.push(`@${token} is a folder, not a file`); continue; }
    if (imagePath && imageOptions?.enabled === false) { imageError('image attachments are disabled in /settings'); continue; }
    if (imagePath && imageOptions?.enabled !== false) {
      const rel = inProject ? path.relative(rootReal, real).split(path.sep).join('/') : `external image ${images.length + 1}: ${path.basename(real)}`;
      try {
        const limit = imageOptions?.maxFileBytes ?? 5 * 1024 * 1024;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 7 * 1024 * 1024 || st.size > limit) throw Error(`image exceeds the configured ${limit}-byte limit`);
        if (files.length >= MENTION_MAX_FILES) throw Error(`at most ${MENTION_MAX_FILES} files per message`);
        const fd = fs.openSync(real, 'r'); let body;
        try {
          const current = fs.fstatSync(fd);
          if (!current.isFile() || current.size > limit) throw Error('image changed or exceeded the size limit while reading');
          const buffer = Buffer.alloc(Math.min(current.size, limit) + 1); let count = 0, got;
          while (count < buffer.length && (got = fs.readSync(fd, buffer, count, buffer.length - count, null)) > 0) count += got;
          if (count > limit) throw Error('image exceeded the size limit while reading');
          body = buffer.subarray(0, count);
        } finally { fs.closeSync(fd); }
        const mimeType = imageMime(body);
        if (!mimeType) throw Error('supported image formats are PNG, JPEG and WebP');
        const next = normalizeImages([...images, { mimeType, data: body.toString('base64'), name: rel }], imageOptions || {});
        images.splice(0, images.length, ...next); files.push(rel); seenReal.add(realKey);
        if (!inProject) notes.push(`Using an explicitly selected image outside this project: ${path.basename(real)}`);
      } catch (e) { const note = `@${token} not attached: ${e.message}`; notes.push(note); imageErrors.push(note); }
      continue;
    }
    if (files.length >= MENTION_MAX_FILES) { notes.push(`@${token} not attached: at most ${MENTION_MAX_FILES} files per message`); continue; }
    if (st.size > MENTION_FILE_BYTES) { notes.push(`@${token} not attached: ${st.size} bytes is over ${MENTION_FILE_BYTES}; ask the agent to read it`); continue; }
    if (total + st.size > MENTION_TOTAL_BYTES) { notes.push(`@${token} not attached: the message is already at ${MENTION_TOTAL_BYTES} bytes of files`); continue; }
    let body;
    try { body = fs.readFileSync(real); } catch { continue; }
    if (body.includes(0)) { notes.push(`@${token} not attached: it is a binary file`); continue; }
    total += body.length;
    const rel = path.relative(rootReal, real).split(path.sep).join('/');
    files.push(rel);
    seenReal.add(realKey);
    const label = rel.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    blocks.push(`<file path="${label}">\n${body.toString('utf8')}\n</file>`);
  }
  const fileContext = blocks.join('\n');
  if (!blocks.length && !images.length && !imageErrors.length) return { text: src, files, notes };
  return { text: blocks.length ? `${src}\n\nFiles the user mentioned with @ (their text, read now):\n${fileContext}` : src, request: src, fileContext, files, notes, ...(images.length ? { images } : {}), ...(imageErrors.length ? { imageErrors } : {}) };
}

// ---------- /context ----------
const tok = (chars) => Math.round(chars / 4);
// What Atlias can measure about the conversation. Characters are exact; tokens are chars/4 and labelled as such.
// A token count only appears as reported when the endpoint gave one (state.promptLog).
export function contextText(state, { window = 0, instructionFiles = [] } = {}) {
  const hist = state.history || [];
  const by = {};
  for (const h of hist) by[h.role] = (by[h.role] || 0) + String(h.text || '').length;
  const msgChars = (state.messages || []).reduce((n, m) => n + String(m.content || '').length + String(m._fileContext || '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
  const todo = (state.todo || []).reduce((n, t) => n + String(t.text || '').length, 0);
  const instr = instructionFiles.reduce((n, f) => n + f.bytes, 0);
  const histChars = Object.values(by).reduce((a, b) => a + b, 0);
  const rows = [['instruction files', instr], ['conversation (what was said)', histChars], ['engine messages (tool calls and results)', msgChars], ['plan', todo]];
  const sum = rows.reduce((n, r) => n + r[1], 0);
  const L = [`session ${state.sid}   engine ${state.engine}   ${hist.length} history entries, ${(state.messages || []).length} engine messages`];
  for (const [label, n] of rows) L.push(`${label.padEnd(42)} ${String(n).padStart(8)} chars   about ${String(tok(n)).padStart(6)} tokens (chars / 4, an estimate)`);
  L.push(`${'total'.padEnd(42)} ${String(sum).padStart(8)} chars   about ${String(tok(sum)).padStart(6)} tokens`);
  if ((state.messages || []).some(m => m._images?.length)) L.push('Image tokens are excluded from text estimates; provider-reported usage is authoritative.');
  const reported = (state.promptLog || []).filter((n) => Number.isFinite(n));
  if (reported.length) L.push(`last prompt the endpoint reported: ${reported[reported.length - 1]} tokens (largest ${Math.max(...reported)})`);
  else L.push(`no token count reported yet${['claude', 'codex'].includes(state.engine) ? `; the ${state.engine} engine makes its own calls, so Atlias never sees them` : ''}`);
  if (window > 0) {
    const lastTok = reported.length ? reported[reported.length - 1] : tok(sum);
    const pct = Math.min(100, Math.round((lastTok / window) * 100));
    const cells = 30;
    const fill = Math.round((pct / 100) * cells);
    L.push(`[${'#'.repeat(fill)}${'.'.repeat(cells - fill)}] ${pct}% of a ${window}-token window${reported.length ? '' : ' (estimated)'}`);
    if (pct >= 70) L.push('over 70%: /compact drops older messages and keeps the plan');
  }
  const big = (state.messages || []).map((m, i) => ({ i, n: String(m.content || '').length, role: m.role })).sort((a, b) => b.n - a.n).slice(0, 3).filter((x) => x.n > 2000);
  if (big.length) L.push(`largest messages: ${big.map((x) => `#${x.i} ${x.role} ${x.n} chars`).join(', ')}`);
  return L.join('\n');
}

// ---------- long-turn notification ----------
export function shouldNotify(elapsedMs, seconds) {
  const s = Number(seconds);
  return Number.isFinite(s) && s > 0 && Number.isFinite(elapsedMs) && elapsedMs >= s * 1000;
}
// Text that goes into a shell command is cut to plain characters: no quote, backtick, dollar or control.
const plain = (s) => String(s || '').replace(/[^\w .,:;()/-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
// { cmd, args } for a desktop notification on this platform, or null where there is no tool to ask.
export function notifyCommand(platform, title, message) {
  const t = plain(title), m = plain(message);
  if (platform === 'win32') {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(5000, '${t}', '${m}', 'Info'); Start-Sleep -Seconds 6; $n.Dispose()`;
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps] };
  }
  if (platform === 'darwin') return { cmd: 'osascript', args: ['-e', `display notification "${m}" with title "${t}"`] };
  return { cmd: 'notify-send', args: [t, m] };
}
// Bell on a terminal, then the desktop notification, detached so it never holds the repl. Failures are silent.
export function notify(title, message, { stream = process.stdout, platform = process.platform, spawnFn = spawn } = {}) {
  try { if (stream && stream.isTTY) stream.write('\x07'); } catch { /* no terminal */ }
  const c = notifyCommand(platform, title, message);
  if (!c) return false;
  try {
    const child = spawnFn(c.cmd, c.args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

// ---------- /release-notes ----------
// The changelog of this install. No argument: the newest entries (Unreleased and the latest release). A
// version number: that release's entry.
export function releaseNotes(arg, root = ROOT) {
  const text = readText(path.join(root, 'CHANGELOG.md'));
  if (text == null) return 'no CHANGELOG.md in this copy of atlias';
  const parts = text.split(/^(?=## )/m).filter((p) => p.startsWith('## '));
  const title = (p) => p.split(/\r?\n/)[0].replace(/^##\s*/, '');
  const want = String(arg || '').trim().replace(/^v/i, '');
  if (!want) {
    const picked = parts.slice(0, parts[0] && /^Unreleased/i.test(title(parts[0])) ? 2 : 1);
    return picked.join('\n').trim() + `\n\n(${parts.length} entries; /release-notes <version> shows one: ${parts.slice(0, 6).map(title).map((t) => t.split(' ')[0]).join(', ')})`;
  }
  const hit = parts.find((p) => title(p).split(/\s+/)[0].toLowerCase() === want.toLowerCase());
  return hit ? hit.trim() : `no entry for ${want}; entries: ${parts.slice(0, 12).map((p) => title(p).split(' ')[0]).join(', ')}`;
}
