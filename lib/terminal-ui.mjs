// Gev's interactive terminal composer. No model, filesystem, network or permission decisions.
// Public Node stream APIs only; line mode remains an explicit opt-out and the unsupported-terminal fallback.
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import { terminalTheme, mixRgb, nearestBasic, subagentColor } from './terminal-appearance.mjs';
import { WORDMARK, atloRows, HAT_RGB } from './terminal-brand.mjs';
import { activeTheme, OCCASIONS } from './seasons.mjs';
import { sceneLines, dotted } from './terminal-scene.mjs';
import { githubWork, GIT_GLYPH } from './github-mark.mjs';
import { wrapChoice } from './onboarding.mjs';

const ESC = '\u001b';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const pieces = (s) => [...segmenter.segment(String(s))];
const bound = (n, fallback, max) => Number.isFinite(n) && n > 0 ? Math.min(max, Math.floor(n)) : fallback;
const clean = (s) => stripVTControlCharacters(String(s ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\t/g, '  ');
const wide = (n) => n >= 0x1100 && (n <= 0x115f || n === 0x2329 || n === 0x232a || (n >= 0x2e80 && n <= 0xa4cf && n !== 0x303f) || (n >= 0xac00 && n <= 0xd7a3) || (n >= 0xf900 && n <= 0xfaff) || (n >= 0xfe10 && n <= 0xfe19) || (n >= 0xfe30 && n <= 0xfe6f) || (n >= 0xff00 && n <= 0xff60) || (n >= 0xffe0 && n <= 0xffe6) || (n >= 0x20000 && n <= 0x3fffd));
// B7: zero-width space, word joiner and byte order mark draw no cell; copied web text carries them.
const cells = (g) => /[\r\n​⁠﻿]/.test(g) ? 0 : /^\p{Mark}+$/u.test(g) ? 0 : /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g) || wide(g.codePointAt(0)) ? 2 : 1;

// "11:42", the local time shown beside what was sent and each reply.
export const clock = (at = Date.now()) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
// The time goes at the end of a reply's first line when it fits there, else on a line of its own, so wrapping holds.
export function stampReply(lines, columns, time) {
  return textWidth(lines[0]) + 2 + textWidth(time) < (columns || 80) ? [`${lines[0]}  ${time}`, ...lines.slice(1)] : [...lines, `  ${time}`];
}
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
export function renderComposer({ text = '', cursor = text.length, selected = 0, commands = [], dismissed = false, question = '', info = {}, status = '', picker = null, pending = [], side = '', sideOffset = 0, columns = 80, rows = 24, fancy = false } = {}) {
  text = String(text); cursor = Number.isSafeInteger(cursor) ? Math.max(0, Math.min(cursor, text.length)) : text.length;
  selected = Number.isSafeInteger(selected) ? selected : 0;
  info = info && typeof info === 'object' ? info : {};
  const width = Math.max(1, bound(columns, 80, 240) - 1), height = bound(rows, 24, 80), inner = Math.max(2, width - 4);
  // Reserve space above the prompt. Oversized queues and side answers stay bounded by the terminal.
  if (!question && !picker && (pending.length || side) && height >= 9) {
    const extra = [];
    if (side) extra.push('Side answer (Esc dismiss; PgUp/PgDn scroll)', ...String(side).split(/\r?\n/).flatMap(line => wrapQuestion(line, width)).slice(sideOffset));
    if (pending.length) extra.push(...pending.map((t, i) => `queued ${i + 1}: ${clean(t).replace(/\n/g, ' ')}`), '/queue edit N text | /queue remove N');
    const count = Math.min(extra.length, Math.max(1, Math.floor(height / 3)));
    const top = extra.slice(0, count).map(t => clipText(t, width));
    if (extra.length > count) top[count - 1] = clipText(side ? '... PgDn for more; Esc dismiss' : '... more pending; /queue lists messages', width);
    const frame = renderComposer({ text, cursor, selected, commands, dismissed, info, status, columns, rows: height - count, fancy });
    return { ...frame, lines: [...top, ...frame.lines], cursor: { ...frame.cursor, row: frame.cursor.row + count }, dim: [...top.keys(), ...(frame.dim || []).map(i => i + count)], inputRows: (frame.inputRows || []).map(i => i + count), accent: (frame.accent || []).map(i => i + count) };
  }
  if (picker) {
    const matches = sessionMatches(picker, text);
    const pick = Math.max(0, Math.min(matches.length - 1, selected));
    const count = Math.max(1, Math.floor((height - 5) / 2));
    const start = Math.max(0, pick - count + 1);
    const lines = [clipText(`Resume session (${matches.length ? pick + 1 : 0} of ${matches.length})`, width), clipText('Search: ' + clean(text), width)];
    const accent = [], dim = [0];
    for (const s of matches.slice(start, start + count)) {
      const title = s.name || s.history?.find(h => h.role === 'user')?.text || 'Untitled session';
      if (s === matches[pick]) accent.push(lines.length);
      lines.push(clipText(`${s === matches[pick] ? '>' : ' '} ${githubWork(s.history) ? `${GIT_GLYPH} ` : ''}${clean(title)}`, width));
      dim.push(lines.length);
      lines.push(clipText(`  ${s.engine} | ${Math.floor((s.history || []).length / 2)} turns | ${Number.isFinite(s.saved) ? new Date(s.saved).toLocaleString() : 'date unknown'} | ${s.sid}`, width));
    }
    if (!matches.length) lines.push(clipText('No matching sessions. Change the search or Esc to cancel.', width));
    lines.push(clipText('Up/Down choose | Enter resume | Esc cancel | Type to search', width));
    return { lines: lines.slice(0, height), cursor: { row: Math.min(1, height - 1), col: Math.min(width - 1, 8 + textWidth(clean(text))) }, matches, selected: pick, width, dim, inputRows: [], accent };
  }
  const usage = !question && Array.isArray(info.usageRows) ? info.usageRows.map(clean).filter(Boolean) : [];
  const usageSize = Math.min(usage.length, Math.max(0, height - 9));
  const all = question || dismissed ? [] : commandMatches(text, commands);
  const pick = all.length ? Math.max(0, Math.min(all.length - 1, selected)) : 0;
  const menuSize = Math.max(0, Math.min(6, all.length, height - 7 - usageSize));
  const start = Math.max(0, pick - menuSize + 1);
  const visible = all.slice(start, start + menuSize);
  // Where the terminal can draw it, the draft sits in a rounded box the way Claude Code and OpenCode draw theirs:
  // "│ ❯ text │", so the text wraps two cells sooner than on the plain band.
  const boxed = fancy && !question;
  const wrapAt = boxed ? Math.max(2, width - 6) : inner;
  const wrapped = [{ text: '', start: 0 }]; let used = 0, caret = { row: 0, col: 0 };
  for (const g of pieces(text)) {
    if (g.index === cursor) caret = { row: wrapped.length - 1, col: used };
    if (/[\r\n]/.test(g.segment)) { wrapped.push({ text: '', start: g.index + g.segment.length }); used = 0; continue; }
    // B6: a grapheme is measured once; textWidth re-segments its input, which made a frame quadratic in the draft.
    // A tab becomes two spaces in clean(), and cells() counts a string of two spaces as one cell, hence the tab branch.
    const safe = clean(g.segment), n = safe ? (/\t/.test(g.segment) ? textWidth(safe) : cells(safe)) : 0;
    if (used + n > wrapAt) { wrapped.push({ text: '', start: g.index }); used = 0; if (g.index === cursor) caret = { row: wrapped.length - 1, col: 0 }; }
    wrapped.at(-1).text += safe; used += n;
  }
  if (cursor >= text.length) caret = { row: wrapped.length - 1, col: used };
  if (height < 7 || width < 8) {
    if (question) return { lines: [clipText('Resize to answer', width)], cursor: { row: 0, col: 0 }, matches: [], selected: 0, width, questionVisible: false };
    const current = wrapped[caret.row]?.text || '';
    const start = Math.max(0, caret.col - Math.max(1, width - 4));
    let skipped = 0, index = 0;
    for (const g of pieces(current)) { const n = cells(g.segment); if (skipped + n > start) break; skipped += n; index = g.index + g.segment.length; }
    const shown = clipText(current.slice(index), width - 2);
    return { lines: [clipText('> ' + shown, width)], cursor: { row: 0, col: Math.min(width - 1, 2 + caret.col - skipped) }, matches: [], selected: 0, width };
  }
  const questionLines = question ? wrapQuestion(question, inner) : [];
  const titleRows = question ? Math.min(questionLines.length, Math.max(1, height - 5)) : 1;
  const inputHeight = Math.max(1, Math.min(5, height - visible.length - 6 - usageSize - (titleRows - 1)));
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
  // Rounded corners where the terminal can draw them, plain ASCII where it may not.
  const [tl, hr, tr, vr, bl, br] = fancy ? ['╭', '─', '╮', '│', '╰', '╯'] : ['+', '-', '+', '|', '+', '+'];
  const lines = question ? [tl + hr.repeat(width - 2) + tr, ...shownQuestion.map(line => `${vr} ` + pad(line, inner) + ` ${vr}`)] : boxed ? [pad('', width), tl + hr.repeat(width - 2) + tr] : [pad('', width), pad('', width)];
  const inputStart = lines.length;
  const dim = [];
  input.forEach((line, i) => {
    if ((above && i === 0) || (below && i === input.length - 1)) dim.push(lines.length);
    const hint = !question && !text && !status ? (typeof info.placeholder === 'string' ? clean(info.placeholder) : 'Ask about this project, or describe a change') : '';
    if (hint) dim.push(lines.length);
    const lead = i === 0 && !above ? '> ' : '  ';
    lines.push(question ? `${vr} ` + pad(line.text, inner) + ` ${vr}` : boxed ? `${vr} ${lead}${pad(line.text || hint, width - 6)} ${vr}` : pad(lead + (line.text || hint), width));
  });
  lines.push(question || boxed ? bl + hr.repeat(width - 2) + br : pad('', width));
  const boxRows = boxed ? Array.from({ length: input.length + 2 }, (_, i) => inputStart - 1 + i) : [];
  const accent = [];
  for (const item of visible) { if (all[pick] === item) accent.push(lines.length); lines.push(clipText(`${all[pick] === item ? '>' : ' '} /${item.name}  ${item.help || ''}`, width)); }
  if (!question && !dismissed && /^\/[^\s/]*$/.test(text) && !all.length) lines.push(clipText('No matching commands. /help lists commands.', width));
  // B5: the footer is whole segments. Trailing segments that do not fit are dropped, never cut mid-number.
  const modelName = (s) => s.replace(/\b(?:claude-)?(opus|sonnet|haiku|fable)-(\d+)-(\d+)\b/i, (_, m, a, b) => `${m[0].toUpperCase()}${m.slice(1).toLowerCase()} ${a}.${b}`).replace(/\s*\[(xhigh|high|medium|low|max)\]/, ' · $1');
  const segments = (status ? [status] : [info.engine, info.permission, ...(Array.isArray(info.tokens) ? info.tokens : [info.tokens])]).map((s) => modelName(clean(s))).filter(Boolean);
  const shown = [];
  // Under the box, the footer is indented to the text.
  const indent = boxed ? '  ' : '', room = width - indent.length;
  for (const s of segments) { if (textWidth([...shown, s].join('  ·  ')) > room) break; shown.push(s); }
  const footer = shown.length ? shown.join('  ·  ') : segments.length ? clipText(segments[0], room) : '';
  if (info.hint && !question && !status) dim.push(lines.length), lines.push(indent + clipText(all.length ? 'Tab completes; Enter sends typed text. Up/Down choose.' : info.hint, room));
  lines.push(indent + (footer || clipText('Enter send  ·  Ctrl+J newline  ·  / commands', room)));
  for (const line of usage.slice(0, usageSize)) lines.push(indent + clipText(line, room));
  if (usageSize < usage.length && usageSize) lines[lines.length - 1] = indent + clipText('More connection usage: /usage', room);
  return { lines, cursor: { row: inputStart + above + caret.row - offset, col: (boxed ? 4 : 2) + caret.col }, matches: all, selected: pick, width, dim, questionVisible: !question || questionLines.length <= titleRows, inputRows: question || boxed ? [] : Array.from({ length: input.length + 3 }, (_, i) => i), box: boxRows, accent };
}

function sessionMatches(sessions, text) {
  const q = clean(text).toLowerCase();
  return sessions.filter(s => [s.sid, s.name, s.engine, s.history?.find(h => h.role === 'user')?.text].some(v => clean(v).toLowerCase().includes(q)));
}

export function createTerminalUI({ input, output, env = process.env, getCommands = () => [], getInfo = () => ({}), fallbackQuestion = () => Promise.reject(new Error('terminal input unavailable')), closeFallback = () => {}, proc = process, history: persisted = {}, keepRawBetweenPrompts = false, appearance = {}, draftStore = null, queue = null, onBtw = null, concurrentBtw = true } = {}) {
  // Windows can lose a pending native read when cooked/raw mode flips between
  // adjacent prompts. The repl holds raw mode and restores the original on close.
  const initialRaw = Boolean(input?.isRaw);
  let heldRaw = false;
  let look = activeTheme(appearance), palette = terminalTheme(look.theme);
  let color = !palette.plain && !env.NO_COLOR && env.FORCE_COLOR !== '0';
  const blue = (s) => color ? `${ESC}[${rgb ? `38;2;${palette.body.join(';')}` : palette.basic}m${s}${ESC}[0m` : s;
  // Atlias blue #2F74F5 for the wordmark, #5C9BF4 for body text (readable on dark grounds); 16-colour terminals get bright blue.
  const rgb = /truecolor|24bit/i.test(env.COLORTERM || '') || Boolean(env.WT_SESSION);
  // Modern terminals get the nicer glyphs; anything else keeps plain ASCII, which draws everywhere.
  const fancy = rgb || /iTerm|vscode|WezTerm|ghostty|Apple_Terminal/i.test(env.TERM_PROGRAM || '');
  const paintRgb = (c, s) => `${ESC}[${rgb ? `38;2;${c.join(';')}` : nearestBasic(c)}m${s}${ESC}[0m`;
  const tone = (kind, s) => !color ? s : Array.isArray(kind) ? paintRgb(kind, s)
    // The wordmark's rows run from a lighter tone at the top to a deeper one at the base.
    : /^mark\d$/.test(kind) ? paintRgb(mixRgb(palette.mark, Number(kind[4]) < 3 ? [255, 255, 255] : [0, 0, 0], Number(kind[4]) < 3 ? 0.3 - Number(kind[4]) * 0.1 : (Number(kind[4]) - 2) * 0.1), s)
    : kind === 'dim' ? `${ESC}[2m${s}${ESC}[0m`
    : kind === 'eye' ? `${ESC}[97m${s}${ESC}[0m`
    : kind === 'hat' && rgb && HAT_RGB[look.hat] ? `${ESC}[38;2;${HAT_RGB[look.hat].join(';')}m${s}${ESC}[0m`
    : rgb ? `${ESC}[${kind === 'mark' ? '1;38;2;' + palette.mark.join(';') : '38;2;' + palette.body.join(';')}m${s}${ESC}[0m` : blue(s);
  // Ctrl+C or Ctrl+D on an empty main prompt (TUI-A item 10): the first press shows a hint for two seconds; a second exits.
  let exitHint = null, busyOwner = null, stashedDraft = null;
  let active = null, closed = false, rowsPainted = 0, cursorRow = 0, cursorCol = 0, paintedLines = [], paintedColumns = 0, escapeTimer = null, rawUnavailable = false;
  const pendingSteers = [], heldBtw = [];
  let side = '', sideOffset = 0, lastDraft = draftStore?.initial?.prompt || '';
  const persist = () => {
    const owner = active?.resume || active;
    if (owner?.main || owner?.busy) lastDraft = owner.text;
    draftStore?.save({ prompt: lastDraft, queued: queue || busyOwner?.turn.queued || [], steers: pendingSteers });
  };
  // persisted: { initial, save } from the caller (lib/input-history.mjs for the project's file). Empty when absent.
  const history = (Array.isArray(persisted.initial) ? persisted.initial : []).filter((x) => typeof x === 'string').slice(-200); let historyIndex = -1, draft = '';
  // A frame goes out as one write inside synchronized-output marks, so the terminal shows it whole and never
  // half-drawn. A terminal without DEC mode 2026 ignores the marks.
  let framing = null;
  const write = (s) => { if (framing === null) output.write(s); else framing += s; };
  const inFrame = (draw) => {
    if (framing !== null) return draw();
    framing = '';
    try { draw(); } finally { const frame = framing; framing = null; if (frame) output.write(`${ESC}[?2026h${frame}${ESC}[?2026l`); }
  };
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
    const mode = appearance.followUp === 'steer' ? 'steer' : 'queue';
    const frames = fancy ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['|', '/', '-', '\\'];
    return `${frames[Math.floor(Date.now() / 100) % frames.length]} Working ${seconds}s  ${turn.interruptedAt ? 'stopping' : 'Esc stops'} | Enter ${mode} | Ctrl+Q ${mode === 'queue' ? 'steer' : 'queue'}`;
  };
  const paint = () => {
    persist();
    if (!active) return;
    inFrame(() => {
    erase();
    // Reverse search (TUI-A item 12) shows its line in the box in place of the draft.
    const view = active.search ? { ...active, text: searchLine(), cursor: searchLine().length, commands: [], dismissed: true } : active;
    const status = exitHint ? `Press ${exitHint.key} again to exit` : busyStatus();
    const f = renderComposer({ ...view, pending: active.question || active.picker ? [] : [...(queue || busyOwner?.turn.queued || []), ...pendingSteers.map(t => `steer pending: ${t}`)], side: active.question ? '' : side, sideOffset, commands: view.commands, info: getInfo(), status, columns: output.columns, rows: output.rows, fancy });
    active.matches = f.matches; active.selected = f.selected;
    // The first cell of a row can be its own accent: the prompt, the choice marker, the spinner.
    const lead = (line, plain, glyph = line[0]) => `${tone('mark', glyph)}${plain(line.slice(1))}`;
    write(f.lines.map((line, i) => {
      const dimmed = (f.dim || []).includes(i) || i === f.lines.length - 1;
      const inBand = (f.inputRows || []).includes(i);
      let shown;
      // The box: its border in the theme colour (dim while a turn runs), the prompt as ❯, the text as typed.
      if ((f.box || []).includes(i)) {
        const edge = (s) => tone(active.busy ? 'dim' : 'body', s);
        if (!line.startsWith('│')) shown = edge(line);
        else {
          const body = line.slice(1, -1), prompt = body.startsWith(' > ');
          const text = prompt ? body.slice(3) : body;
          shown = edge('│') + (prompt ? ` ${tone('mark', '❯')} ` : '') + (dimmed ? tone('dim', text) : text) + edge('│');
        }
      } else if ((f.accent || []).includes(i)) shown = lead(line, (s) => tone('body', s), fancy && line[0] === '>' ? '❯' : line[0]);
      else if (inBand && line.startsWith('> ')) shown = lead(line, (s) => dimmed ? tone('dim', s) : s, fancy ? '❯' : '>');
      else if (i === f.lines.length - 1 && status && !exitHint) shown = lead(line, (s) => tone('dim', s));
      else shown = dimmed ? tone('dim', line) : line;
      // Only this marks GitHub work, and it takes its own colour whatever the row around it is doing.
      if (color && line.includes(GIT_GLYPH)) shown = shown.replace(GIT_GLYPH, `${paintRgb(palette.git, GIT_GLYPH)}${(f.accent || []).includes(i) ? (rgb ? `${ESC}[38;2;${palette.body.join(';')}m` : `${ESC}[${palette.basic}m`) : ''}`);
      // The band is dark on every theme, so it sets its own text colour; a light theme's default text was dark on navy.
      if (color && inBand) { const band = rgb ? `48;2;${palette.band.join(';')};38;2;230;237;250` : '40;97'; shown = `${ESC}[${band}m${shown.replaceAll(`${ESC}[0m`, `${ESC}[0m${ESC}[${band}m`)}${ESC}[0m`; }
      return shown;
    }).join('\r\n'));
    const up = f.lines.length - 1 - f.cursor.row;
    write(`\r${up > 0 ? `${ESC}[${up}A` : ''}${f.cursor.col ? `${ESC}[${f.cursor.col}C` : ''}`);
    rowsPainted = f.lines.length; cursorRow = f.cursor.row; cursorCol = f.cursor.col; paintedLines = f.lines; paintedColumns = bound(output.columns, 80, 240);
    });
  };
  // Plain log text gains colour only where the shape of a line says what it is: a tool call, a diff, a GitHub mark.
  const colourLog = (body) => {
    if (!color) return body;
    const lines = body.split('\r\n');
    const diff = lines.some((l) => /^(diff --git |@@ )/.test(l));
    return lines.map((line) => {
      // A tool call, "● Open(src/app.js)": the dot in the theme colour, the verb bold, its target dim.
      const tool = /^(● |  ▸ )(\S+?)(\(.*\))?$/.exec(line);
      if (tool) return `${tone('mark', tool[1])}${ESC}[1m${tool[2]}${ESC}[0m${tone('dim', tool[3] || '')}`;
      // A subagent's line: the hook dim, the subagent's name in its own colour, then its call or note.
      const sub = /^(  ⎿ )(.+?)( · )(.*)$/.exec(line);
      if (sub) {
        const call = /^(\S+?)(\(.*\))?$/.exec(sub[4]);
        return `${tone('dim', sub[1])}${paintRgb(subagentColor(sub[2]), sub[2])}${tone('dim', sub[3])}${call ? `${ESC}[1m${call[1]}${ESC}[0m${tone('dim', call[2] || '')}` : tone('dim', sub[4])}`;
      }
      if (line.includes(GIT_GLYPH)) line = line.replaceAll(GIT_GLYPH, paintRgb(palette.git, GIT_GLYPH));
      if (!diff) return line;
      if (/^(diff --git |index |--- |\+\+\+ )/.test(line)) return tone('dim', line);
      if (line.startsWith('@@')) return tone('body', line);
      if (line.startsWith('+')) return paintRgb([86, 211, 100], line);
      if (line.startsWith('-')) return paintRgb([248, 113, 113], line);
      return line;
    }).join('\r\n');
  };
  const cleanup = () => {
    if (active?.refreshTimer) clearInterval(active.refreshTimer);
    if (exitHint) { clearTimeout(exitHint.timer); exitHint = null; }
    if (escapeTimer) { clearTimeout(escapeTimer); escapeTimer = null; }
    input.removeListener('data', onData); input.removeListener('end', onEnd); input.removeListener('error', onError); output.removeListener('error', onError); output.removeListener('resize', onResize);
    if (active?.raw) { try { write(`${ESC}[?2004l`); } finally { if (!keepRawBetweenPrompts) input.setRawMode(active.wasRaw); if (active.wasPaused) input.pause(); } }
  };
  const recordInput = (text) => {
    if (!text.trim()) return;
    history.push(text); if (history.length > 200) history.shift();
    try { persisted.save?.(history.slice()); } catch { /* the current session still retains its history */ }
  };
  const finish = (error) => {
    if (!active) return;
    const current = active;
    persist();
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
    else if (current.picker) current.resolve(current.cancelled ? null : sessionMatches(current.picker, current.text)[current.selected]?.sid || null);
    else {
      if (!current.question && current.text.trim() && !/^\/btw(?:\s|$)/.test(current.text)) {
        recordInput(current.text);
      }
      if (current.main) { lastDraft = ''; persist(); draftStore?.flush(); }
      // What was sent stays in the scrollback as "❯ text", in bold, after a blank line (Claude Code's shape).
      try {
        // The first line ends in a dim "11:42", the time it was sent; the wrap leaves room for it.
        const said = clean(current.text).split(/\r?\n/).map((line) => wrapChoice(line, output.columns - 11, '')).join('\n').split('\n');
        write(`\r\n${said.map((line, i) => `${i ? '  ' : `${tone('mark', fancy ? '❯' : '>')} `}${color ? `${ESC}[1m${line}${ESC}[0m` : line}${i ? '' : `  ${tone('dim', clock())}`}`).join('\r\n')}\r\n`);
        current.resolve(current.text);
      } catch (e) { current.reject(e); }
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
  const searchLine = () => `(search) ${active.search.query}: ${active.search.found >= 0 ? history[active.search.found] : 'No matches'}`;
  const insert = (s) => { if (active.search) { active.search.query += s.replace(/\r?\n/g, ' '); refreshSearch(); return; } if (exitHint) { clearTimeout(exitHint.timer); exitHint = null; } active.text = active.text.slice(0, active.cursor) + s + active.text.slice(active.cursor); active.cursor += s.length; active.selected = 0; active.dismissed = false; };
  const left = () => pieces(active.text.slice(0, active.cursor)).at(-1)?.index ?? 0;
  const right = () => active.cursor + (pieces(active.text.slice(active.cursor))[0]?.segment.length || 0);
  const moveHistory = (direction) => {
    if ((!active.main && !active.busy) || !history.length) return;
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
  // Enter and Ctrl+Q submit follow-ups; Ctrl+D leaves the draft alone.
  const busyKey = (name) => {
    const turn = active.turn;
    // Select steer or queue for this message; commands stay out of the model input.
    if (name === 'enter' || name === 'followOther') {
      const text = active.text;
      active.text = ''; active.cursor = 0; active.dismissed = false; active.selected = 0;
      if (/^\/btw(?:\s|$)/.test(text)) { self.btw(text.replace(/^\/btw\s*/, '')); return; }
      if (/^\/queue(?:\s|$)/.test(text)) { self.queueCommand(text.replace(/^\/queue\s*/, '')); return; }
      if (text.trim()) {
        recordInput(text);
        const steer = (appearance.followUp === 'steer') !== (name === 'followOther');
        if (steer && !turn.controller.signal.aborted) { pendingSteers.push(text); self.log('steer pending: ' + text, 'dim'); }
        else { turn.queued.push(text); self.log(`queued: ${text}`, 'dim'); }
      }
      persist(); draftStore?.flush();
      return;
    }
    if (name === 'eof') return;
    if (name === 'interrupt' && turn.interruptedAt && Date.now() - turn.interruptedAt < 2000) { turn.exit = true; return; }
    if (!turn.controller.signal.aborted) { turn.controller.abort(); turn.interruptedAt = Date.now(); }
  };
  const key = (name) => {
    if (!active) return;
    const a = active;
    if (name === 'escape' && side) { side = ''; return; }
    if (side && ['pageUp', 'pageDown'].includes(name)) {
      const length = side.split(/\r?\n/).flatMap(line => wrapQuestion(line, Math.max(1, output.columns - 1))).length;
      sideOffset = Math.max(0, Math.min(length - 1, sideOffset + (name === 'pageUp' ? -1 : 1))); return;
    }
    if (a.picker) {
      if (['escape', 'interrupt', 'eof'].includes(name)) { a.cancelled = true; finish(); return; }
      if (name === 'enter') { if (output.rows < 7 || output.columns < 20) { self.log('Resize the terminal to choose a session. Esc cancels.'); return; } finish(); return; }
      if (name === 'up' || name === 'down') { const n = sessionMatches(a.picker, a.text).length; a.selected = n ? (Math.min(a.selected, n - 1) + (name === 'up' ? -1 : 1) + n) % n : 0; return; }
      if (['search', 'stash', 'tab', 'newline'].includes(name)) return;
    }
    if (name === 'search' && !a.main && !a.busy) return;
    if (name === 'search' && !a.search) { a.search = { query: '', found: -1 }; refreshSearch(); return; }
    if (a.search) {
      if (name === 'search') a.search.found = searchFrom(a.search.query, a.search.found >= 0 ? a.search.found : history.length);
      else if (name === 'backspace') { a.search.query = pieces(a.search.query).slice(0, -1).map((g) => g.segment).join(''); refreshSearch(); }
      else if (name === 'enter') { const found = a.search.found; a.search = null; if (found >= 0) { a.text = history[found]; a.cursor = a.text.length; } }
      else if (name === 'escape' || name === 'interrupt') a.search = null;
      return;
    }
    if (name === 'stash') {
      // A permission answer is never a draft. Keep this memory local to this terminal.
      if (!a.main && !a.busy) return;
      const current = a.text ? { text: a.text, cursor: a.cursor } : null;
      if (!current && !stashedDraft) { self.log('No draft is stashed yet.'); return; }
      const previous = stashedDraft;
      stashedDraft = current;
      a.text = previous?.text || ''; a.cursor = previous?.cursor || 0;
      a.selected = 0; a.dismissed = false;
      self.log(previous ? current ? 'Drafts swapped. Ctrl+S swaps back.' : 'Draft restored.' : 'Draft stashed for this session. Ctrl+S restores it.');
      return;
    }
    if (a.busy && ['enter', 'followOther', 'escape', 'interrupt', 'eof'].includes(name)) { busyKey(name); return; }
    if (name === 'followOther') return;
    if (name === 'enter' && a.question && !renderComposer({ question: a.question, text: a.text, cursor: a.cursor, columns: output.columns, rows: output.rows }).questionVisible) { self.log('Resize the terminal to read the complete question. Ctrl+C cancels.'); return; }
    if (name === 'enter' && a.main && !a.text.trim()) return;
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
      const matches = a.dismissed ? [] : commandMatches(a.text, a.commands);
      a.matches = matches;
      if (matches.length) a.selected = (Math.max(0, Math.min(matches.length - 1, a.selected)) + (name === 'up' ? -1 : 1) + matches.length) % matches.length;
      else vertical(name === 'up' ? -1 : 1);
    } else if (name === 'left') a.cursor = left();
    else if (name === 'right') a.cursor = right();
    // Whitespace-delimited words, so the cursor always lands between graphemes.
    else if (name === 'wordLeft') { let n = a.cursor; while (n > 0 && /\s/.test(a.text[n - 1])) n--; while (n > 0 && !/\s/.test(a.text[n - 1])) n--; a.cursor = n; }
    else if (name === 'wordRight') { let n = a.cursor; while (n < a.text.length && /\s/.test(a.text[n])) n++; while (n < a.text.length && !/\s/.test(a.text[n])) n++; a.cursor = n; }
    else if (name === 'home') a.cursor = a.text.lastIndexOf('\n', a.cursor - 1) + 1;
    else if (name === 'end') { const n = a.text.indexOf('\n', a.cursor); a.cursor = n < 0 ? a.text.length : n; }
    else if (name === 'backspace') { const n = left(); a.text = a.text.slice(0, n) + a.text.slice(a.cursor); a.cursor = n; a.dismissed = false; a.selected = 0; }
    else if (name === 'delete') a.text = a.text.slice(0, a.cursor) + a.text.slice(right());
    else if (name === 'escape') {
      a.dismissed = true;
      // Esc on an empty prompt that a command is asking (a menu, not the main input) backs out, the same as Ctrl+C.
      if (!a.main && !a.text) { finish(new Error('cancelled')); return; }
      // Two Escapes on an empty prompt, close together, send /rewind: the same as typing it (the turn list).
      const now = Date.now();
      if (a.main && !a.text && a.lastEscape && now - a.lastEscape < 600) { a.lastEscape = 0; a.text = '/rewind'; a.cursor = a.text.length; finish(); return; }
      a.lastEscape = now;
    }
    // Ctrl+U (readline kill line): from the cursor back to the start of its line; the rest of the draft stays.
    else if (name === 'killLine') { const start = a.cursor ? a.text.lastIndexOf('\n', a.cursor - 1) + 1 : 0; a.text = a.text.slice(0, start) + a.text.slice(a.cursor); a.cursor = start; a.dismissed = false; a.selected = 0; }
    else if (name === 'interrupt') { if (a.text) { a.text = ''; a.cursor = 0; } else if (!a.main || exitHint) { finish(new Error('cancelled')); return; } else armExit('Ctrl+C'); }
    else if (name === 'eof') { if (!a.text) { if (!a.main || exitHint) { onEnd(); return; } armExit('Ctrl+D'); return; } key('delete'); }
    else if (name === 'clear') { a.text = ''; a.cursor = 0; a.dismissed = false; }
  };
  const keys = new Map([['\r', 'enter'], ['\n', 'newline'], ['\t', 'tab'], ['\x11', 'followOther'], ['\x7f', 'backspace'], ['\b', 'backspace'], ['\x03', 'interrupt'], ['\x04', 'eof'], ['\x01', 'home'], ['\x05', 'end'], ['\x15', 'killLine'], ['\x13', 'stash'], ['', 'search'], ['\x10', 'up'], ['\x0e', 'down'], [`${ESC}[A`, 'up'], [`${ESC}[B`, 'down'], [`${ESC}[C`, 'right'], [`${ESC}[D`, 'left'], [`${ESC}[H`, 'home'], [`${ESC}[F`, 'end'], [`${ESC}[3~`, 'delete'], [`${ESC}[1~`, 'home'], [`${ESC}[4~`, 'end'],
    // B9: application cursor mode (SS3) sends the same keys with ESC O; a lone ESC O waits for its last byte like any prefix.
    [`${ESC}[1;5D`, 'wordLeft'], [`${ESC}[1;5C`, 'wordRight'], [`${ESC}[1;3D`, 'wordLeft'], [`${ESC}[1;3C`, 'wordRight'],
    [`${ESC}OA`, 'up'], [`${ESC}OB`, 'down'], [`${ESC}OC`, 'right'], [`${ESC}OD`, 'left'], [`${ESC}OH`, 'home'], [`${ESC}OF`, 'end'], [`${ESC}[5~`, 'pageUp'], [`${ESC}[6~`, 'pageDown']]);
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
      // A multiline paste without bracketed-paste support stays one unsent draft.
      // Coalesced command controls are keystrokes, not pasted model input.
      // One trailing CR after single-line text is a typed Enter that shared the read (fast typing, key repeat).
      // h4 F1: the paste is the text before that trailing Enter; the Enter itself goes through the key table, so it submits.
      if (!active.pending && !active.pasting && text.length > 1 && /[\r\n]/.test(text.replace(/\r\n?$/, '')) && text !== '\r\n' && !/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/.test(text)) {
        const body = text.replace(/\r\n?$/, '');
        insert(body);
        // A trailing CRLF belongs to the pasted text (Windows clipboard); a typed Enter is a lone CR.
        if (body.length < text.length && !text.endsWith('\n')) { active.pending += text.slice(body.length); parse(); }
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
    if (rawUnavailable || !supported(input, output, env)) return options.picker ? Promise.resolve(undefined) : fallbackQuestion(q);
    return new Promise((resolve, reject) => {
      active = { text: options.draft || '', cursor: (options.draft || '').length, selected: 0, dismissed: false, main: Boolean(main), busy: Boolean(options.busy), turn: options.turn || null, picker: options.picker || null, resume, question: main ? '' : clean(q), commands: main || options.busy ? getCommands() : [], pending: '', pasting: false, decoder: new StringDecoder('utf8'), wasRaw: Boolean(input.isRaw), wasPaused: input.isPaused(), raw: false, resolve, reject };
      historyIndex = -1;
      if (resume) { try { paint(); } catch (e) { finish(e); } return; }
      try { if (!input.isRaw) input.setRawMode(true); active.raw = true; heldRaw ||= keepRawBetweenPrompts; }
      catch { active = null; rawUnavailable = true; write('Terminal input unavailable; using line mode.\r\n'); if (options.picker) { resolve(undefined); return; } Promise.resolve().then(() => fallbackQuestion(q)).then(resolve, reject); return; }
      try { write(`${ESC}[?2004h`); input.on('data', onData); input.once('end', onEnd); input.once('error', onError); output.once('error', onError); output.on('resize', onResize); input.resume(); paint();
        if (!active.busy) { active.refreshTimer = setInterval(() => { try { paint(); } catch (e) { finish(e); } }, 15000); active.refreshTimer.unref?.(); }
      }
      catch (e) { finish(e); }
    });
  };
  const self = {
    steer: { take: () => pendingSteers.splice(0), onApplied(text) { self.log('steer applied: ' + text, 'dim'); persist(); draftStore?.flush(); } },
    queueCommand(args) {
      const pending = queue || busyOwner?.turn.queued || [];
      const m = /^(edit|remove)\s+([1-9]\d*)(?:\s+([\s\S]+))?$/.exec(args.trim());
      if (!args.trim()) { self.log(pending.length ? pending.map((t, i) => `${i + 1}: ${t}`).join('\n') : 'No queued messages.'); return; }
      if (!m || Number(m[2]) > pending.length || (m[1] === 'edit' && !m[3]?.trim())) { self.log('Use /queue edit N text or /queue remove N for a pending message.'); return; }
      if (m[1] === 'remove') pending.splice(Number(m[2]) - 1, 1);
      else pending[Number(m[2]) - 1] = m[3];
      persist(); draftStore?.flush(); paint();
    },
    async btw(question, afterTurn = false) {
      if (!onBtw) { self.log('Side questions are unavailable in this terminal.'); return; }
      if (busyOwner && !(typeof concurrentBtw === 'function' ? concurrentBtw() : concurrentBtw) && !afterTurn) { heldBtw.push(question); side = 'A second request is unavailable for this engine. Side question held until this turn ends.'; paint(); return; }
      sideOffset = 0; side = 'Answering side question...'; paint();
      try { side = await onBtw(question); } catch (error) { side = `Side question failed: ${error.message}`; }
      paint();
    },
    async flushBtw() { for (const question of heldBtw.splice(0)) await self.btw(question, true); },
    inputMode: () => rawUnavailable || !supported(input, output, env) ? 'line' : 'composer',
    question: (q) => question(q), prompt: (draft = '') => question('', true, { draft }),
    selectSession: (sessions) => question('', false, { picker: sessions }),
    // TUI-B: the composer stays open while a turn runs. turnStart returns false when no composer can be drawn.
    turnStart(controller, draft = '') {
      if (closed || active || rawUnavailable || !supported(input, output, env)) return false;
      const turn = { controller, queued: queue || [], exit: false, interruptedAt: 0, started: Date.now(), timer: null };
      question('', false, { busy: true, turn, draft }).catch(() => {});
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
      owner.turn.queued.unshift(...pendingSteers.splice(0));
      const result = { queued: owner.turn.queued.slice(), draft: owner.text, exit: owner.turn.exit };
      if (active === owner) finish(null);
      return result;
    },
    // style 'dim' prints the lines dimmed when colour is on (the queued messages of a turn).
    // style 'md' is a reply already cleaned by lib/render-markdown.mjs, so its own styling is kept.
    // style 'reply' is a styled reply too, set under a ● the way Claude Code marks the assistant: the marker in the
    // theme colour, every line after it indented to the text, a blank line before it.
    log(text, style) {
      if (closed) return;
      inFrame(() => {
        erase();
        const styled = style === 'md' || style === 'reply';
        const body = styled ? String(text).replace(/\r?\n/g, '\r\n') : clean(text).split(/\r?\n/).map((line) => wrapChoice(line, output.columns, '')).join('\n').replace(/\n/g, '\r\n');
        const shown = style === 'dim' ? body.split('\r\n').map((line) => tone('dim', line)).join('\r\n')
          : style === 'reply' ? '\r\n' + stampReply(body.replace(/^(?:[ \t]*\r\n)+|(?:\r\n[ \t]*)+$/g, '').split('\r\n').map((line, i) => `${i ? '  ' : `${tone('mark', fancy ? '●' : '*')} `}${line}`), output.columns, tone('dim', clock())).join('\r\n')
          : styled ? body : colourLog(body);
        write(shown + '\r\n'); paint();
      });
    },
    // Start screen (Gev 2026-10-18: codelia start screen, zoomed out, Atlias blue): pixel wordmark, then version, project and tips.
    // A theme picked with /theme or /settings shows at once, with no restart.
    setTheme(ui) { look = activeTheme(ui); palette = terminalTheme(look.theme); color = !palette.plain && !env.NO_COLOR && env.FORCE_COLOR !== '0'; if (!closed) paint(); },
    welcome(version, project, branch = '') {
      if (branch) project = `${project} (${branch})`;
      const width = Math.max(1, bound(output.columns, 80, 240) - 1), height = bound(output.rows, 24, 240);
      const lines = [], atlo = atloRows((s, kind) => !color && kind === 'eye' ? ' ' : tone(kind, s), look.hat);
      // Tall enough for the sky and still room for the composer: Atlo stands on the horizon, the way Claude Code's crab does.
      const scene = !appearance.compactWelcome && height >= 24 ? sceneLines({ theme: look.theme, hat: look.hat, width, paint: (s, kind) => !color && kind === 'eye' ? ' ' : tone(kind, s) }) : null;
      if (scene) {
        const season = OCCASIONS[look.theme]?.label;
        lines.push(`${tone('mark', 'Welcome to Atlias')} ${tone('dim', `v${version}${season ? `  ·  ${season}` : ''}`)}`, tone('dim', dotted(width)), ...scene, tone('dim', dotted(width)));
        if (look.greeting) lines.push(tone('body', clipText(`  ${look.greeting}`, width)));
        lines.push(tone('dim', clipText(`  ${project.length > width - 2 ? '…' + project.slice(-(width - 3)) : project}`, width)));
      } else if (!appearance.compactWelcome && width >= 52 && height >= 14) {
        for (let i = 0; i < 6; i++) lines.push(' ' + tone('mark', (WORDMARK[i] || '').padEnd(WORDMARK[0].length)) + '   ' + atlo[i]);
        const meta = `  v${version}  ·  ${project}`;
        lines.push('', tone('dim', clipText(meta.length <= width ? meta : `  v${version}`, width)));
      } else if (!appearance.compactWelcome && width >= 30 && height >= 14) {
        for (let i = 0; i < 6; i++) lines.push(' ' + (i === 1 ? tone('mark', clipText('ATLIAS', width - 16).padEnd(12)) : i === 3 ? tone('dim', clipText(`v${String(version).split('-')[0]}`, Math.min(12, width - 16)).padEnd(12)) : ' '.repeat(12)) + '  ' + atlo[i]);
      } else lines.push(tone('body', clipText(`ATLIAS ${version}`, width)));
      // A long path keeps its end, the part that names the project.
      if (!scene && !lines.some((l) => l.includes(project))) lines.push(tone('dim', clipText(`  ${project.length > width - 2 ? '…' + project.slice(-(width - 3)) : project}`, width)));
      if (look.greeting && !scene) lines.push(tone('body', clipText(`  ${look.greeting}`, width)));
      // Claude Code puts its tips in a rounded card under the art; Atlias does the same where the corners draw.
      if (appearance.showHints !== false) {
        const tips = ['/help for commands', '/theme for colours and seasons', '/sessions for every folder'];
        if (fancy && width >= 44) {
          const w = Math.min(width, 64), inside = w - 4, edge = (s) => tone('dim', s);
          lines.push('', edge(`╭${'─'.repeat(w - 2)}╮`));
          // A plain asterisk: ✻ is one cell to us but two in some terminals, which pushed the border out.
          lines.push(`${edge('│')} ${tone('mark', '*')} ${pad('Tips for getting started', inside - 2)} ${edge('│')}`);
          for (const t of tips) lines.push(`${edge('│')}   ${tone('dim', pad(t, inside - 2))} ${edge('│')}`);
          lines.push(edge(`╰${'─'.repeat(w - 2)}╯`));
        } else lines.push(tone('dim', clipText(`  ${tips.join('  ·  ')}`, width)));
      }
      lines.push('');
      erase(); write(lines.join('\r\n') + '\r\n'); paint();
    },
      close() { if (closed) return; persist(); draftStore?.close(); if (active) finish(new Error('terminal closed')); closed = true; stashedDraft = null; if (heldRaw) { input.setRawMode(initialRaw); heldRaw = false; } if (escapeTimer) clearTimeout(escapeTimer); closeFallback(); proc.removeListener('exit', self.close);
        // A native stdin starts neither paused nor flowing. resume() during a
        // prompt makes its handle keep the app alive even after /exit. Release
        // our read handle while preserving any other consumer's data listener.
        if (input.listenerCount('data') === 0) input.pause();
      },
  };
  proc.once('exit', self.close);
  return self;
}
