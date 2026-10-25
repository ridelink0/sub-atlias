// Assistant replies for the composer (TUI-B item 4). A pure function: text in, styled text out.
// Without colour the text comes back unchanged. The model's text is cleaned of terminal control
// sequences before any styling is added, so the only escapes in the output are the ones written here.
import { stripVTControlCharacters } from 'node:util';
import { textWidth } from './terminal-ui.mjs';

const ESC = '\u001b';
const on = (code, s) => `${ESC}[${code}m${s}${ESC}[0m`;
const BOLD = '1', DIM = '2', ACCENT = '94';

// Code spans take the accent colour and **bold** is bold. Nothing else is interpreted.
function inline(text) {
  return text.split(/(`[^`\n]+`)/).map((part, i) => i % 2 ? on(ACCENT, part.slice(1, -1)) : part.replace(/\*\*([^*\n]+)\*\*/g, (_, s) => on(BOLD, s))).join('');
}

// Words wrapped to the width. The first line starts with `first`, the rest with `rest` (a hanging indent).
function wrap(text, width, first, rest) {
  const words = text.split(' ').filter((w) => w !== '');
  const lines = [];
  let line = null;
  for (const w of words) {
    if (line === null) { line = first + w; continue; }
    if (textWidth(`${line} ${w}`) > width) { lines.push(line); line = rest + w; }
    else line += ` ${w}`;
  }
  lines.push(line === null ? first.trimEnd() : line);
  return lines;
}

// The reply with every terminal control sequence removed: what a plain terminal prints.
export function plainText(text) {
  // Node's VT stripper can leave OSC payload text containing spaces behind.
  const withoutOSC = String(text ?? '').replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)/g, '');
  return stripVTControlCharacters(withoutOSC).replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}

export function renderMarkdown(text, { color = false, width = 80 } = {}) {
  const source = String(text ?? '');
  if (!color) return source;
  const columns = Math.max(20, Math.min(240, Number(width) || 80));
  const normal = plainText(source);
  const out = [];
  let fence = false;
  for (const line of normal.split('\n')) {
    // Fenced code: the fence lines are dim, and the code inside is kept verbatim with no styling.
    if (/^\s*```/.test(line)) { fence = !fence; out.push(on(DIM, line.trimEnd())); continue; }
    if (fence) { out.push(on(DIM, '| ') + line); continue; }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) { out.push(...wrap(heading[1], columns, '', '').map((l) => on(BOLD, l))); continue; }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const first = `${item[1]}${item[2]} `;
      out.push(...wrap(item[3], columns, first, ' '.repeat(first.length)).map(inline));
      continue;
    }
    out.push(inline(line));
  }
  return out.join('\n');
}
