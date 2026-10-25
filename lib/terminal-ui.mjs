// Gev's interactive terminal composer. No model, filesystem, network or permission decisions.
// Public Node stream APIs only; line mode remains an explicit opt-out and the unsupported-terminal fallback.
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import { WORDMARK, atloRows } from './terminal-brand.mjs';

const ESC = '\u001b';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const pieces = (s) => [...segmenter.segment(String(s))];
const bound = (n, fallback, max) => Number.isFinite(n) && n > 0 ? Math.min(max, Math.floor(n)) : fallback;
const clean = (s) => stripVTControlCharacters(String(s ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\t/g, '  ');
const wide = (n) => n >= 0x1100 && (n <= 0x115f || n === 0x2329 || n === 0x232a || (n >= 0x2e80 && n <= 0xa4cf && n !== 0x303f) || (n >= 0xac00 && n <= 0xd7a3) || (n >= 0xf900 && n <= 0xfaff) || (n >= 0xfe10 && n <= 0xfe19) || (n >= 0xfe30 && n <= 0xfe6f) || (n >= 0xff00 && n <= 0xff60) || (n >= 0xffe0 && n <= 0xffe6) || (n >= 0x20000 && n <= 0x3fffd));
// B7: zero-width space, word joiner and byte order mark draw no cell; copied web text carries them.
const cells = (g) => /[\r\n​⁠﻿]/.test(g) ? 0 : /^\p{Mark}+$/u.test(g) ? 0 : /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g) || wide(g.codePointAt(0)) ? 2 : 1;

export function textWidth(text) { return pieces(clean(text)).reduce((n, g) => n + cells(g.segment), 0); }
export function clipText(text, width) {
  if (!Number.isFinite(width) || width < 1) return '';
  let out = '', used = 0;
  for (const g of pieces(clean(text).replace(/[\r\n]/g, ' '))) { const w = cells(g.segment); if (used + w > width) break; out += g.segment; used += w; }
  return out;
}
// The pixel ATLIAS wordmark from the brand (D:/atlias-site/brand/atlias-logo.svg), five rows, 35 cells wide.
const pad = (text, width) => { const s = clipText(text, width); return s + ' '.repeat(Math.max(0, width - textWidth(s))); };
const wrapQuestion = (text, width) => {
  const lines = []; let line = '';
  for (const word of clean(text).replace(/\s+/g, ' ').trim().split(' ')) {
    if (line && textWidth(line + ' ' + word) > width) { lines.push(line); line = ''; }
    let rest = word;
    while (textWidth(rest) > width) { const part = clipText(rest, width); if (!part) break; lines.push(part); rest = rest.slice(part.length); }
    if (rest) line += (line ? ' ' : '') + rest;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
};

export function commandMatches(text, commands = []) {
  if (!/^\/[^\s/]*$/.test(text)) return [];
  if (!Array.isArray(commands)) return [];
  const q = text.slice(1).toLowerCase();
  const score = (name) => {
    const n = name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    let i = 0; for (const c of n) if (c === q[i]) i++;
    return i === q.length ? 3 : 99;
  };
  return commands.filter((c) => c && typeof c.name === 'string' && /^[A-Za-z][\w:.-]*$/.test(c.name) && !c.hidden && score(c.name) < 99)
    .map((c) => ({ ...c, rank: score(c.name) })).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

// Counts must be exact; an absent or invalid round never becomes a cheap zero.
export function tokenSummary(state = {}) {
  const p = state.promptLog, o = state.outLog;
  const valid = (n) => Number.isSafeInteger(n) && n >= 0;
  if (['claude', 'codex'].includes(state.engine) || !Array.isArray(p) || !p.length || !Array.isArray(o) || p.length !== o.length || !p.every(valid) || !o.every(valid)) return 'tokens not recorded';
  const total = [...p, ...o].reduce((a, b) => a + b, 0);
  return Number.isSafeInteger(total) ? `recorded tokens ${total.toLocaleString('en-US')}${p.length >= 500 ? '+ observed' : ''}` : 'tokens unknown';
}

export function supported(input, output, env = process.env) {
  return Boolean(input?.isTTY && output?.isTTY && typeof input.setRawMode === 'function' && env.TERM !== 'dumb');
}

// A pure frame, including the cursor's cell position. It never paints outside its own rows.
export function renderComposer({ text = '', cursor = text.length, selected = 0, commands = [], dismissed = false, question = '', info = {}, status = '', columns = 80, rows = 24 } = {}) {
  text = String(text); cursor = Number.isSafeInteger(cursor) ? Math.max(0, Math.min(cursor, text.length)) : text.length;
  selected = Number.isSafeInteger(selected) ? selected : 0;
  info = info && typeof info === 'object' ? info : {};
  const width = Math.max(1, bound(columns, 80, 240) - 1), height = bound(rows, 24, 80), inner = Math.max(2, width - 4);
  const all = question || dismissed ? [] : commandMatches(text, commands);
  const pick = all.length ? Math.max(0, Math.min(all.length - 1, selected)) : 0;
  const menuSize = Math.max(0, Math.min(6, all.length, height - 7));
  const start = Math.max(0, pick - menuSize + 1);
  const visible = all.slice(start, start + menuSize);
  const wrapped = [{ text: '', start: 0 }]; let used = 0, caret = { row: 0, col: 0 };
  for (const g of pieces(text)) {
    if (g.index === cursor) caret = { row: wrapped.length - 1, col: used };
    if (/[\r\n]/.test(g.segment)) { wrapped.push({ text: '', start: g.index + g.segment.length }); used = 0; continue; }
    // B6: a grapheme is measured once; textWidth re-segments its input, which made a frame quadratic in the draft.
    // A tab becomes two spaces in clean(), and cells() counts a string of two spaces as one cell, hence the tab branch.
    const safe = clean(g.segment), n = safe ? (/\t/.test(g.segment) ? textWidth(safe) : cells(safe)) : 0;
    if (used + n > inner) { wrapped.push({ text: '', start: g.index }); used = 0; if (g.index === cursor) caret = { row: wrapped.length - 1, col: 0 }; }
    wrapped.at(-1).text += safe; used += n;
  }
  if (cursor >= text.length) caret = { row: wrapped.length - 1, col: used };
  if (height < 7 || width < 8) {
    const current = wrapped[caret.row]?.text || '';
    const start = Math.max(0, caret.col - Math.max(1, width - 4));
    let skipped = 0, index = 0;
    for (const g of pieces(current)) { const n = cells(g.segment); if (skipped + n > start) break; skipped += n; index = g.index + g.segment.length; }
    const shown = clipText(current.slice(index), width - 2);
    return { lines: [clipText('> ' + shown, width)], cursor: { row: 0, col: Math.min(width - 1, 2 + caret.col - skipped) }, matches: [], selected: 0, width };
  }
  const questionLines = question ? wrapQuestion(question, inner) : [];
  const titleRows = question ? Math.min(questionLines.length, Math.max(1, height - 5)) : 1;
  const inputHeight = Math.max(1, Math.min(5, height - visible.length - 6 - (titleRows - 1)));
  // B11: a draft taller than the box shows "... N more lines above" in its first row and "... N more lines below"
  // in its last, dimmed. A marker takes a row, so the window moves until the caret's row is inside it.
  const marked = inputHeight >= 3;
  let offset = Math.max(0, caret.row - inputHeight + 1), above = 0, contentRows = inputHeight, below = 0;
  for (;;) {
    above = marked && offset > 0 ? 1 : 0;
    contentRows = inputHeight - above;
    below = marked && offset + contentRows < wrapped.length ? 1 : 0;
    contentRows -= below;
    if (offset >= caret.row || caret.row < offset + contentRows) break;
    offset++;
  }
  const input = [];
  if (above) input.push({ text: `... ${offset} more lines above` });
  input.push(...wrapped.slice(offset, offset + contentRows));
  if (below) input.push({ text: `... ${wrapped.length - offset - contentRows} more lines below` });
  const shownQuestion = questionLines.slice(0, titleRows);
  if (questionLines.length > titleRows) shownQuestion[titleRows - 1] = '... resize to read full question';
  const lines = question ? ['+' + '-'.repeat(width - 2) + '+', ...shownQuestion.map(line => '| ' + pad(line, inner) + ' |')] : [pad('', width), pad('', width)];
  const inputStart = lines.length;
  const dim = [];
  input.forEach((line, i) => {
    if ((above && i === 0) || (below && i === input.length - 1)) dim.push(lines.length);
    const hint = !question && !text && !status ? 'Ask about this project, or describe a change' : '';
    if (hint) dim.push(lines.length);
    lines.push(question ? '| ' + pad(line.text, inner) + ' |' : pad((i === 0 && !above ? '> ' : '  ') + (line.text || hint), width));
  });
  lines.push(question ? '+' + '-'.repeat(width - 2) + '+' : pad('', width));
  for (const item of visible) lines.push(clipText(`${all[pick] === item ? '>' : ' '} /${item.name}  ${item.help || ''}`, width));
  if (!question && !dismissed && /^\/[^\s/]*$/.test(text) && !all.length) lines.push(clipText('No matching commands. /help lists commands.', width));
  // B5: the footer is whole segments. Trailing segments that do not fit are dropped, never cut mid-number.
  const segments = (status ? [status] : [info.engine, info.permission, ...(Array.isArray(info.tokens) ? info.tokens : [info.tokens])]).map((s) => clean(s)).filter(Boolean);
  const shown = [];
  for (const s of segments) { if (textWidth([...shown, s].join('  |  ')) > width) break; shown.push(s); }
  const footer = shown.length ? shown.join('  |  ') : segments.length ? clipText(segments[0], width) : '';
  if (info.hint && !question && !status) lines.push(clipText(all.length ? 'Tab completes; Enter sends typed text. Up/Down choose.' : info.hint, width));
  lines.push(footer || clipText('Enter send  |  Ctrl+J newline  |  / commands', width));
  return { lines, cursor: { row: inputStart + above + caret.row - offset, col: 2 + caret.col }, matches: all, selected: pick, width, dim, inputRows: question ? [] : Array.from({ length: input.length + 3 }, (_, i) => i) };
}

export function createTerminalUI({ input, output, env = process.env, getCommands = () => [], getInfo = () => ({}), fallbackQuestion = () => Promise.reject(new Error('terminal input unavailable')), closeFallback = () => {}, proc = process, history: persisted = {}, keepRawBetweenPrompts = false } = {}) {
  // Windows can lose a pending native read when cooked/raw mode flips between
  // adjacent prompts. The repl holds raw mode and restores the original on close.
  const initialRaw = Boolean(input?.isRaw);
  let heldRaw = false;
  const color = !env.NO_COLOR && env.FORCE_COLOR !== '0';
  const blue = (s) => color ? `${ESC}[94m${s}${ESC}[0m` : s;
  // Atlias blue #2F74F5 for the wordmark, #5C9BF4 for body text (readable on dark grounds); 16-colour terminals get bright blue.
  const rgb = /truecolor|24bit/i.test(env.COLORTERM || '') || Boolean(env.WT_SESSION);
  const tone = (kind, s) => !color ? s : kind === 'dim' ? `${ESC}[2m${s}${ESC}[0m`
    : kind === 'eye' ? `${ESC}[97m${s}${ESC}[0m`
    : rgb ? `${ESC}[${kind === 'mark' ? '1;38;2;47;116;245' : '38;2;92;155;244'}m${s}${ESC}[0m` : blue(s);
  // Ctrl+C or Ctrl+D on an empty main prompt (TUI-A item 10): the first press shows a hint for two seconds; a second exits.
  let exitHint = null, busyOwner = null;
  let active = null, closed = false, rowsPainted = 0, cursorRow = 0, cursorCol = 0, paintedLines = [], paintedColumns = 0, escapeTimer = null, rawUnavailable = false;
  // persisted: { initial, save } from the caller (lib/input-history.mjs for the project's file). Empty when absent.
  const history = (Array.isArray(persisted.initial) ? persisted.initial : []).filter((x) => typeof x === 'string').slice(-200); let historyIndex = -1, draft = '';
  const write = (s) => output.write(s);
  // A terminal that reflows on resize rewraps every painted line at the new width. Painted lines
  // are one cell narrower than the terminal they were painted on, so the plain row count stays
  // exact unless the terminal got narrower; then each line is wrapped again the way the terminal
  // does it, a wide character that does not fit moving whole to the next row.
  // wrapRows(line, columns) is the rows the line takes; with a cell, the row holding that cell.
  const wrapRows = (line, columns, cell = Infinity) => {
    let row = 0, col = 0, offset = 0;
    for (const g of pieces(clean(line))) {
      const n = cells(g.segment);
      if (!n) continue;
      if (col && col + n > columns) { row++; col = 0; }
      if (cell < offset + n) return row;
      col += n; offset += n;
    }
    return cell === Infinity ? row + 1 : row + Math.floor((col + cell - offset) / columns);
  };
  const erase = () => {
    if (!rowsPainted) return;
    const columns = bound(output.columns, 80, 240);
    let up = cursorRow;
    if (columns < paintedColumns) {
      const line = paintedLines[cursorRow] || '';
      up = Math.min(wrapRows(line, columns, cursorCol), wrapRows(line, columns) - 1);
      for (let i = 0; i < cursorRow; i++) up += wrapRows(paintedLines[i] || '', columns);
    }
    write(`\r${up ? `${ESC}[${up}A` : ''}${ESC}[0J`); rowsPainted = 0; cursorRow = 0; cursorCol = 0; paintedLines = []; paintedColumns = 0;
  };
  // TUI-B 2: while a turn runs, the footer shows an ASCII spinner, the elapsed seconds and how to stop it.
  // The spinner frame follows the clock, and the turn repaints it every 100 ms (at most ten times a second).
  const busyStatus = () => {
    if (!active || !active.busy) return '';
    const turn = active.turn;
    const seconds = Math.floor((Date.now() - turn.started) / 1000);
    return `${['|', '/', '-', '\\'][Math.floor(Date.now() / 100) % 4]} Working ${seconds}s  ${turn.interruptedAt ? 'interrupting' : 'esc to interrupt'}`;
  };
  const paint = () => {
    if (!active) return;
    erase();
    // Reverse search (TUI-A item 12) shows its line in the box in place of the draft.
    const view = active.search ? { ...active, text: searchLine(), cursor: searchLine().length, commands: [], dismissed: true } : active;
    const f = renderComposer({ ...view, commands: view.commands, info: getInfo(), status: exitHint ? `Press ${exitHint.key} again to exit` : busyStatus(), columns: output.columns, rows: output.rows });
    active.matches = f.matches; active.selected = f.selected;
    write(f.lines.map((line, i) => {
      let shown = (f.dim || []).includes(i) ? tone('dim', line) : i === f.lines.length - 1 ? tone('dim', line) : line;
      if (color && (f.inputRows || []).includes(i)) shown = `${ESC}[${rgb ? '48;2;30;34;43' : '40'}m${shown.replaceAll(`${ESC}[0m`, `${ESC}[0m${ESC}[${rgb ? '48;2;30;34;43' : '40'}m`)}${ESC}[0m`;
      return shown;
    }).join('\r\n'));
    const up = f.lines.length - 1 - f.cursor.row;
    write(`\r${up > 0 ? `${ESC}[${up}A` : ''}${f.cursor.col ? `${ESC}[${f.cursor.col}C` : ''}`);
    rowsPainted = f.lines.length; cursorRow = f.cursor.row; cursorCol = f.cursor.col; paintedLines = f.lines; paintedColumns = bound(output.columns, 80, 240);
  };
  const cleanup = () => {
    if (exitHint) { clearTimeout(exitHint.timer); exitHint = null; }
    if (escapeTimer) { clearTimeout(escapeTimer); escapeTimer = null; }
    input.removeListener('data', onData); input.removeListener('end', onEnd); input.removeListener('error', onError); output.removeListener('error', onError); output.removeListener('resize', onResize);
    if (active?.raw) { try { write(`${ESC}[?2004l`); } finally { if (!keepRawBetweenPrompts) input.setRawMode(active.wasRaw); if (active.wasPaused) input.pause(); } }
  };
  const finish = (error) => {
    if (!active) return;
    const current = active;
    try { erase(); } catch (e) { error ||= e; }
    if (current.resume) {
      // A permission question taken during a turn gives the composer back to that turn (TUI-B).
      active = current.resume;
      try { paint(); } catch (e) { error ||= e; }
      if (error) current.reject(error); else current.resolve(current.text);
      return;
    }
    try { cleanup(); } catch (e) { error ||= e; }
    active = null;
    if (current.busy) { busyOwner = null; clearInterval(current.turn.timer); }
    if (error) current.reject(error);
    else if (current.busy) current.resolve({ draft: current.text, queued: current.turn.queued.slice(), exit: current.turn.exit });
    else {
      if (!current.question && current.text.trim()) {
        history.push(current.text); if (history.length > 200) history.shift();
        // A failed save keeps the session's own history; the prompt must not fail over a convenience.
        try { persisted.save?.(history.slice()); } catch { /* best effort */ }
      }
      try { write(`${blue('you')} ${clean(current.text).replace(/\r?\n/g, '\r\n')}\r\n`); current.resolve(current.text); } catch (e) { current.reject(e); }
    }
  };
  const onEnd = () => finish(new Error('end of input'));
  const onError = (e) => finish(e);
  const onResize = () => { try { paint(); } catch (e) { finish(e); } };
  const armExit = (keyName) => {
    if (exitHint) clearTimeout(exitHint.timer);
    exitHint = { key: keyName, timer: setTimeout(() => { exitHint = null; if (active) paint(); }, 2000) };
    paint();
  };
  // Newest-first search over the history for the query, looking only before index `from`. Case-insensitive; an empty query matches the newest line.
  const searchFrom = (query, from) => { const q = query.toLowerCase(); for (let i = Math.min(from, history.length) - 1; i >= 0; i--) if (history[i].toLowerCase().includes(q)) return i; return -1; };
  const refreshSearch = () => { active.search.found = searchFrom(active.search.query, history.length); };
  const searchLine = () => `(search) ${active.search.query}: ${active.search.found >= 0 ? history[active.search.found] : ''}`;
  const insert = (s) => { if (active.search) { active.search.query += s.replace(/\r?\n/g, ' '); refreshSearch(); return; } if (exitHint) { clearTimeout(exitHint.timer); exitHint = null; } active.text = active.text.slice(0, active.cursor) + s + active.text.slice(active.cursor); active.cursor += s.length; active.selected = 0; active.dismissed = false; };
  const left = () => pieces(active.text.slice(0, active.cursor)).at(-1)?.index ?? 0;
  const right = () => active.cursor + (pieces(active.text.slice(active.cursor))[0]?.segment.length || 0);
  const moveHistory = (direction) => {
    if (!history.length) return;
    if (historyIndex < 0) draft = active.text;
    historyIndex = Math.max(-1, Math.min(history.length - 1, historyIndex + direction));
    active.text = historyIndex < 0 ? draft : history[history.length - 1 - historyIndex]; active.cursor = active.text.length;
  };
  const vertical = (direction) => {
    const a = active, start = a.text.lastIndexOf('\n', a.cursor - 1) + 1;
    const col = textWidth(a.text.slice(start, a.cursor));
    let target, end;
    if (direction < 0) { end = start - 1; if (end < 0) { moveHistory(1); return; } target = a.text.lastIndexOf('\n', end - 1) + 1; }
    else { const next = a.text.indexOf('\n', a.cursor); if (next < 0) { moveHistory(-1); return; } target = next + 1; end = a.text.indexOf('\n', target); if (end < 0) end = a.text.length; }
    let used = 0; a.cursor = target;
    for (const g of pieces(a.text.slice(target, end))) { const n = cells(g.segment); if (used + n > col) break; used += n; a.cursor = target + g.index + g.segment.length; }
  };
  // TUI-B: keys while a turn runs. Esc or Ctrl+C stops the turn; a second Ctrl+C within two seconds leaves Atlias.
  // Enter and Ctrl+D are handled here too (queueing and the type-ahead come next).
  const busyKey = (name) => {
    const turn = active.turn;
    // Enter queues the typed message; the turn sends it when it ends. Nothing typed is lost (TUI-B 3).
    if (name === 'enter') {
      const text = active.text;
      if (text.trim()) { turn.queued.push(text); self.log(`queued: ${text}`, 'dim'); }
      active.text = ''; active.cursor = 0; active.dismissed = false; active.selected = 0;
      return;
    }
    if (name === 'eof') return;
    if (name === 'interrupt' && turn.interruptedAt && Date.now() - turn.interruptedAt < 2000) { turn.exit = true; return; }
    if (!turn.controller.signal.aborted) { turn.controller.abort(); turn.interruptedAt = Date.now(); }
  };
  const key = (name) => {
    if (!active) return;
    const a = active;
    if (name === 'search' && !a.search) { a.search = { query: '', found: -1 }; refreshSearch(); return; }
    if (a.search) {
      if (name === 'search') a.search.found = searchFrom(a.search.query, a.search.found >= 0 ? a.search.found : history.length);
      else if (name === 'backspace') { a.search.query = pieces(a.search.query).slice(0, -1).map((g) => g.segment).join(''); refreshSearch(); }
      else if (name === 'enter') { const found = a.search.found; a.search = null; if (found >= 0) { a.text = history[found]; a.cursor = a.text.length; } }
      else if (name === 'escape' || name === 'interrupt') a.search = null;
      return;
    }
    if (a.busy && (name === 'enter' || name === 'escape' || name === 'interrupt' || name === 'eof')) { busyKey(name); return; }
    if (name === 'enter') { if (a.text.endsWith('\\')) { a.text = a.text.slice(0, -1); a.cursor = Math.min(a.cursor, a.text.length); insert('\n'); } else finish(); return; }
    if (name === 'newline') insert('\n');
    else if (name === 'tab') {
      // Input can arrive as a coalesced chunk (Ctrl+U, new command, Tab).
      // `a.matches` is refreshed by paint after parsing, so use the current
      // draft here instead of the previous frame's command list.
      const matches = commandMatches(a.text, a.commands);
      if (matches.length) {
        a.matches = matches;
        a.selected = Math.max(0, Math.min(matches.length - 1, a.selected));
        a.text = '/' + matches[a.selected].name + ' '; a.cursor = a.text.length; a.dismissed = true;
      }
    }
    else if (name === 'up' || name === 'down') {
      if (a.matches?.length) a.selected = (a.selected + (name === 'up' ? -1 : 1) + a.matches.length) % a.matches.length;
      else vertical(name === 'up' ? -1 : 1);
    } else if (name === 'left') a.cursor = left();
    else if (name === 'right') a.cursor = right();
    else if (name === 'home') a.cursor = a.text.lastIndexOf('\n', a.cursor - 1) + 1;
    else if (name === 'end') { const n = a.text.indexOf('\n', a.cursor); a.cursor = n < 0 ? a.text.length : n; }
    else if (name === 'backspace') { const n = left(); a.text = a.text.slice(0, n) + a.text.slice(a.cursor); a.cursor = n; a.dismissed = false; a.selected = 0; }
    else if (name === 'delete') a.text = a.text.slice(0, a.cursor) + a.text.slice(right());
    else if (name === 'escape') {
      a.dismissed = true;
      // Two Escapes on an empty prompt, close together, send /rewind: the same as typing it (the turn list).
      const now = Date.now();
      if (!a.text && a.lastEscape && now - a.lastEscape < 600) { a.lastEscape = 0; a.text = '/rewind'; a.cursor = a.text.length; finish(); return; }
      a.lastEscape = now;
    }
    // Ctrl+U (Claude Code): from the cursor back to the start of its line; the rest of the draft stays.
    else if (name === 'killLine') { const start = a.cursor ? a.text.lastIndexOf('\n', a.cursor - 1) + 1 : 0; a.text = a.text.slice(0, start) + a.text.slice(a.cursor); a.cursor = start; a.dismissed = false; a.selected = 0; }
    else if (name === 'interrupt') { if (a.text) { a.text = ''; a.cursor = 0; } else if (!a.main || exitHint) { finish(new Error('cancelled')); return; } else armExit('Ctrl+C'); }
    else if (name === 'eof') { if (!a.text) { if (!a.main || exitHint) { onEnd(); return; } armExit('Ctrl+D'); return; } key('delete'); }
    else if (name === 'clear') { a.text = ''; a.cursor = 0; a.dismissed = false; }
  };
  const keys = new Map([['\r', 'enter'], ['\n', 'newline'], ['\t', 'tab'], ['\x7f', 'backspace'], ['\b', 'backspace'], ['\x03', 'interrupt'], ['\x04', 'eof'], ['\x01', 'home'], ['\x05', 'end'], ['\x15', 'killLine'], ['', 'search'], ['\x10', 'up'], ['\x0e', 'down'], [`${ESC}[A`, 'up'], [`${ESC}[B`, 'down'], [`${ESC}[C`, 'right'], [`${ESC}[D`, 'left'], [`${ESC}[H`, 'home'], [`${ESC}[F`, 'end'], [`${ESC}[3~`, 'delete'], [`${ESC}[1~`, 'home'], [`${ESC}[4~`, 'end'],
    // B9: application cursor mode (SS3) sends the same keys with ESC O; a lone ESC O waits for its last byte like any prefix.
    [`${ESC}OA`, 'up'], [`${ESC}OB`, 'down'], [`${ESC}OC`, 'right'], [`${ESC}OD`, 'left'], [`${ESC}OH`, 'home'], [`${ESC}OF`, 'end']]);
  const parse = () => {
    const a = active; if (!a) return;
    while (a.pending && active === a) {
      if (a.pasting) {
        const end = a.pending.indexOf(`${ESC}[201~`);
        if (end < 0) return;
        insert(a.pending.slice(0, end)); a.pending = a.pending.slice(end + 6); a.pasting = false; continue;
      }
      if (a.pending.startsWith(`${ESC}[200~`)) { a.pending = a.pending.slice(6); a.pasting = true; continue; }
      const sequence = [...keys.keys()].find((s) => a.pending.startsWith(s));
      if (sequence) { a.pending = a.pending.slice(sequence.length); if (sequence === '\r' && a.pending.startsWith('\n')) a.pending = a.pending.slice(1); key(keys.get(sequence)); continue; }
      if (a.pending[0] === ESC) {
        if (a.pending === ESC || [...keys.keys(), `${ESC}[200~`].some((s) => s.startsWith(a.pending))) {
          if (escapeTimer) clearTimeout(escapeTimer);
          escapeTimer = setTimeout(() => { if (active === a) { a.pending = ''; key('escape'); paint(); } }, 60); return;
        }
        const unknown = /^\x1b(?:\[[0-9;?]*[A-Za-z~]|O.)/.exec(a.pending); a.pending = a.pending.slice(unknown ? unknown[0].length : 1); continue;
      }
      const c = String.fromCodePoint(a.pending.codePointAt(0)); a.pending = a.pending.slice(c.length);
      if (c >= ' ' && c !== '\x7f') insert(c);
    }
  };
  const onData = (chunk) => {
    if (!active) return;
    if (escapeTimer) { clearTimeout(escapeTimer); escapeTimer = null; }
    const text = typeof chunk === 'string' ? chunk : active.decoder.write(chunk);
    try {
      // A multiline paste from a terminal without bracketed-paste support stays one unsent draft.
      // One trailing CR after single-line text is a typed Enter that shared the read (fast typing, key repeat).
      // h4 F1: the paste is the text before that trailing Enter; the Enter itself goes through the key table, so it submits.
      if (!active.pending && !active.pasting && text.length > 1 && /[\r\n]/.test(text.replace(/\r\n?$/, '')) && text !== '\r\n' && !text.includes(ESC)) {
        const body = text.replace(/\r\n?$/, '');
        insert(body);
        if (body.length < text.length) { active.pending += text.slice(body.length); parse(); }
      }
      else { active.pending += text; parse(); }
      paint();
    } catch (e) { finish(e); }
  };
  const question = (q = '', main = false, options = {}) => {
    if (closed) return Promise.reject(new Error('terminal closed'));
    // A permission question during a turn takes the composer for itself; the turn gets it back afterwards (TUI-B).
    if (active && !(active.busy && !options.busy)) return Promise.reject(new Error('a terminal question is already active'));
    const resume = active && active.busy ? active : null;
    if (rawUnavailable || !supported(input, output, env)) return fallbackQuestion(q);
    return new Promise((resolve, reject) => {
      active = { text: options.draft || '', cursor: (options.draft || '').length, selected: 0, dismissed: false, main: Boolean(main), busy: Boolean(options.busy), turn: options.turn || null, resume, question: main ? '' : clean(q), commands: main && !options.busy ? getCommands() : [], pending: '', pasting: false, decoder: new StringDecoder('utf8'), wasRaw: Boolean(input.isRaw), wasPaused: input.isPaused(), raw: false, resolve, reject };
      historyIndex = -1;
      if (resume) { try { paint(); } catch (e) { finish(e); } return; }
      try { if (!input.isRaw) input.setRawMode(true); active.raw = true; heldRaw ||= keepRawBetweenPrompts; }
      catch { active = null; rawUnavailable = true; write('Terminal input unavailable; using line mode.\r\n'); Promise.resolve().then(() => fallbackQuestion(q)).then(resolve, reject); return; }
      try { write(`${ESC}[?2004h`); input.on('data', onData); input.once('end', onEnd); input.once('error', onError); output.once('error', onError); output.on('resize', onResize); input.resume(); paint(); }
      catch (e) { finish(e); }
    });
  };
  const self = {
    question: (q) => question(q), prompt: (draft = '') => question('', true, { draft }),
    // TUI-B: the composer stays open while a turn runs. turnStart returns false when no composer can be drawn.
    turnStart(controller) {
      if (closed || active || rawUnavailable || !supported(input, output, env)) return false;
      const turn = { controller, queued: [], exit: false, interruptedAt: 0, started: Date.now(), timer: null };
      question('', false, { busy: true, turn }).catch(() => {});
      busyOwner = active;
      if (!busyOwner) return false;
      turn.timer = setInterval(() => { if (active && active === busyOwner) { try { paint(); } catch (e) { finish(e); } } }, 100);
      return true;
    },
    // Ends the turn's composer. Returns what was typed and queued during the turn, and whether the person asked to leave.
    turnEnd() {
      const owner = busyOwner;
      if (!owner) return { queued: [], draft: '', exit: false };
      while (active && active !== owner) finish(new Error('the turn ended'));
      const result = { queued: owner.turn.queued.slice(), draft: owner.text, exit: owner.turn.exit };
      if (active === owner) finish(null);
      return result;
    },
    // style 'dim' prints the lines dimmed when colour is on (the queued messages of a turn).
    // style 'md' is a reply already cleaned by lib/render-markdown.mjs, so its own styling is kept.
    log(text, style) { if (closed) return; erase(); const body = style === 'md' ? String(text).replace(/\r?\n/g, '\r\n') : clean(text).replace(/\r?\n/g, '\r\n'); write((style === 'dim' ? body.split('\r\n').map((line) => tone('dim', line)).join('\r\n') : body) + '\r\n'); paint(); },
    // Start screen (Gev 2026-10-18: codelia start screen, zoomed out, Atlias blue): pixel wordmark, then version, project and tips.
    welcome(version, project) {
      const width = Math.max(1, bound(output.columns, 80, 240) - 1), height = bound(output.rows, 24, 240);
      const lines = [], atlo = atloRows((s, kind) => !color && kind === 'eye' ? ' ' : tone(kind, s));
      if (width >= 52 && height >= 20) {
        for (let i = 0; i < 6; i++) lines.push(' ' + atlo[i] + '   ' + tone('mark', WORDMARK[i] || ''));
        lines.push(tone('dim', clipText(`  v${version}   ${getInfo().engine || ''}`, width)));
      } else if (width >= 30 && height >= 20) {
        for (let i = 0; i < 6; i++) lines.push(' ' + atlo[i] + '   ' + (i === 1 ? tone('mark', clipText('ATLIAS', width - 16)) : i === 3 ? tone('dim', clipText(`v${version}`, width - 16)) : ''));
      } else lines.push(tone('body', clipText(`ATLIAS ${version}`, width)));
      lines.push(tone('dim', clipText(project, width)));
      lines.push(tone('dim', clipText('/help commands   / setup and tools', width)));
      erase(); write(lines.join('\r\n') + '\r\n'); paint();
    },
      close() { if (closed) return; if (active) finish(new Error('terminal closed')); closed = true; if (heldRaw) { input.setRawMode(initialRaw); heldRaw = false; } if (escapeTimer) clearTimeout(escapeTimer); closeFallback(); proc.removeListener('exit', self.close);
        // A native stdin starts neither paused nor flowing. resume() during a
        // prompt makes its handle keep the app alive even after /exit. Release
        // our read handle while preserving any other consumer's data listener.
        if (input.listenerCount('data') === 0) input.pause();
      },
  };
  proc.once('exit', self.close);
  return self;
}
