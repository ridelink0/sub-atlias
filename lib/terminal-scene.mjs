// The welcome screen's sky: Atlo and the wordmark under a sky that follows the theme. Block characters and plain
// punctuation only, so it needs no font, image protocol or library. Presentation only.
import { WORDMARK, atloCells } from './terminal-brand.mjs';

const WHITE = [235, 240, 250], GREY = [148, 163, 184], CLOUD = [100, 116, 139];
const NIGHT = { body: 'crescent', bodyRgb: [226, 232, 240], clouds: true, density: 0.1, deco: [['*', WHITE], ['·', GREY], ['*', GREY]] };
const SKIES = {
  spring: { body: 'disc', bodyRgb: [255, 214, 165], clouds: true, density: 0.11, deco: [['*', [247, 143, 179]], ['\'', [247, 143, 179]], ['·', [134, 239, 172]]] },
  summer: { body: 'disc', bodyRgb: [255, 183, 3], clouds: true, density: 0.05, deco: [['·', [255, 214, 102]]] },
  autumn: { body: 'disc', bodyRgb: [232, 160, 70], clouds: true, density: 0.1, deco: [[',', [200, 132, 47]], ['\'', [222, 110, 40]], ['~', [181, 101, 29]]] },
  winter: { ...NIGHT, bodyRgb: [214, 236, 252], density: 0.2, deco: [['*', WHITE], ['·', [124, 198, 242]], ['.', WHITE]] },
  halloween: { body: 'disc', bodyRgb: [255, 117, 24], clouds: true, density: 0.05, deco: [['·', GREY], ['*', [138, 92, 214]]], sprites: [['^v^'], ['^v^'], ['^v^']], spriteRgb: [[138, 92, 214]] },
  christmas: { ...NIGHT, density: 0.16, deco: [['*', WHITE], ['·', WHITE], ['o', [224, 50, 63]], ['o', [46, 204, 113]]] },
  newyear: { body: null, clouds: false, density: 0.08, deco: [['*', WHITE], ['·', GREY]], sprites: [['\\|/', '-*-', '/|\\'], ['\\|/', '-*-', '/|\\'], ['\\|/', '-*-', '/|\\']], spriteRgb: [[232, 197, 71], [255, 92, 138], [77, 163, 255]] },
  birthday: { body: null, clouds: true, density: 0.17, deco: [['*', [255, 92, 138]], ['+', [232, 197, 71]], ['·', [77, 163, 255]], ['o', [61, 220, 132]], ['*', [199, 125, 255]]], sprites: [['(_)', ' | '], ['(_)', ' | ']], spriteRgb: [[255, 92, 138], [108, 140, 255]] },
  valentines: { ...NIGHT, bodyRgb: [255, 200, 215], density: 0.08, deco: [['♥', [255, 92, 138]], ['·', [255, 180, 200]]] },
  stpatricks: { body: 'disc', bodyRgb: [232, 197, 71], clouds: true, density: 0.08, deco: [['♣', [46, 204, 113]], ['o', [232, 197, 71]]] },
  easter: { body: 'disc', bodyRgb: [255, 236, 170], clouds: true, density: 0.08, deco: [['0', [196, 167, 255]], ['0', [247, 143, 179]], ['0', [134, 239, 172]], ['·', WHITE]] },
  thanksgiving: { body: 'disc', bodyRgb: [214, 140, 60], clouds: true, density: 0.1, deco: [[',', [181, 101, 29]], ['\'', [222, 110, 40]], ['~', [200, 132, 47]]] },
};
const CLOUD_ROWS = ['    ░░░░░     ', ' ░░░░░░░░░░░  ', '░░░░░░░░░░░░░░'];
const SKY_ROWS = 8, BODY_ROWS = 5, BODY_COLS = 10;

// The same sky all day, a different one tomorrow.
const random = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// A disc, or a crescent with a bite out of its right side. Terminal cells are twice as tall as they are wide.
function bodyCells(kind) {
  const r = 2.5, cx = (BODY_COLS - 1) / 2, cy = (BODY_ROWS - 1) / 2, rows = [];
  for (let y = 0; y < BODY_ROWS; y++) {
    let row = '';
    for (let x = 0; x < BODY_COLS; x++) {
      const dx = (x - cx) / 2, dy = y - cy, edge = r - Math.hypot(dx, dy);
      const bite = kind === 'crescent' ? r * 0.82 - Math.hypot(dx - r * 0.55, dy) : -1;
      row += edge <= 0 || bite > 0 ? ' ' : bite > -0.3 || edge < 0.25 ? '░' : edge < 0.6 ? '▓' : '█';
    }
    rows.push(row);
  }
  return rows;
}

// Rows of painted text. paint(text, kind) gets 'mark0' to 'mark4' for the wordmark's rows, 'mark', 'eye' or 'hat'
// for Atlo, and [r, g, b] for the sky. Returns null when the width cannot hold it.
export function sceneLines({ theme = 'atlias', hat = null, width = 80, date = new Date(), paint = (s) => s } = {}) {
  const columns = Math.min(width, 78);
  const wordmarkAt = 15;
  if (columns < wordmarkAt + WORDMARK[0].length + 2) return null;
  const sky = SKIES[theme] || NIGHT;
  const cells = Array.from({ length: SKY_ROWS }, () => Array(columns).fill(null));
  const free = Array.from({ length: SKY_ROWS }, () => Array(columns).fill(true));
  const claim = (x, y, w, h) => { for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) if (free[r]?.[c] !== undefined) free[r][c] = false; };
  const stamp = (x, y, rows, kind) => rows.forEach((row, r) => [...row].forEach((ch, c) => { if (ch !== ' ' && cells[y + r]?.[x + c] !== undefined) cells[y + r][x + c] = { ch, kind }; }));
  // The brand comes first and keeps a margin, so nothing in the sky ever touches it.
  atloCells(hat).forEach((row, r) => row.forEach((cell, c) => { if (cell) cells[r + 2][c + 1] = cell; }));
  claim(0, 1, 14, 7);
  WORDMARK.forEach((row, r) => { stamp(wordmarkAt, r + 2, [row], `mark${r}`); });
  claim(wordmarkAt - 1, 1, WORDMARK[0].length + 2, 7);
  if (sky.clouds) { stamp(wordmarkAt + 8, 0, CLOUD_ROWS.slice(1), CLOUD); claim(wordmarkAt + 7, 0, CLOUD_ROWS[0].length + 2, 2); }
  if (sky.body && columns >= 66) { stamp(columns - BODY_COLS - 1, 0, bodyCells(sky.body), sky.bodyRgb); claim(columns - BODY_COLS - 2, 0, BODY_COLS + 2, BODY_ROWS + 1); }
  const next = random(date.getFullYear() * 1000 + date.getMonth() * 40 + date.getDate());
  if (sky.clouds && columns >= 72) { stamp(columns - 24, SKY_ROWS - 3, CLOUD_ROWS, CLOUD); claim(columns - 25, SKY_ROWS - 3, CLOUD_ROWS[0].length + 2, 3); }
  (sky.sprites || []).forEach((rows, i) => {
    for (let tries = 0; tries < 40; tries++) {
      const w = rows[0].length, h = rows.length, x = Math.floor(next() * (columns - w)), y = Math.floor(next() * (SKY_ROWS - h + 1));
      let clear = true;
      for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) if (!free[r][c]) clear = false;
      if (!clear) continue;
      stamp(x, y, rows, sky.spriteRgb[i % sky.spriteRgb.length]);
      claim(x - 1, y, w + 2, h);
      break;
    }
  });
  const count = Math.round(columns * SKY_ROWS * sky.density * 0.45);
  for (let i = 0; i < count; i++) {
    const x = Math.floor(next() * columns), y = Math.floor(next() * SKY_ROWS);
    if (!free[y][x] || cells[y][x]) continue;
    const [ch, rgb] = sky.deco[Math.floor(next() * sky.deco.length)];
    cells[y][x] = { ch, kind: rgb };
  }
  return cells.map((row) => {
    let line = '', run = '', kind = null;
    const flush = () => { if (run) line += kind === null ? run : paint(run, kind); run = ''; };
    for (const cell of row) {
      const k = cell ? cell.kind : null;
      if (k !== kind) { flush(); kind = k; }
      run += cell ? cell.ch : ' ';
    }
    flush();
    return line.trimEnd();
  });
}
export const dotted = (width) => '·'.repeat(Math.max(1, Math.min(width, 78)));
