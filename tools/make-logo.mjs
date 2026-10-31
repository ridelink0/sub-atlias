#!/usr/bin/env node
// Draws the atlias logo as SVG from the same glyph table the terminal logo
// uses (lib/logo.mjs), so the image and the terminal can never drift apart.
//   node tools/make-logo.mjs      writes assets/atlias-logo.svg (1280x640, the
//                                 GitHub social preview size) and
//                                 assets/atlias-banner.svg (README banner)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wordmark } from '../lib/logo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The terminal ramp, light at the top edge and deep at the base.
const BLUE = ['#93c5fd', '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8'];

// A fixed sequence, so the stars land in the same places on every run.
function stars(w, h, n, seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = (rnd() * w).toFixed(1);
    const y = (rnd() * h).toFixed(1);
    const r = (0.6 + rnd() * 1.6).toFixed(2);
    const o = (0.25 + rnd() * 0.6).toFixed(2);
    out.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="#dbeafe" opacity="${o}"/>`);
  }
  return out.join('');
}

function letters(x0, y0, cell, gap) {
  const rows = wordmark('ATLIAS');
  const out = [];
  rows.forEach((row, r) => {
    [...row].forEach((ch, c) => {
      if (ch !== ' ') out.push(`<rect x="${x0 + c * cell}" y="${y0 + r * cell}" width="${cell - gap}" height="${cell - gap}" rx="${Math.round(cell * 0.12)}" fill="${BLUE[r]}"/>`);
    });
  });
  return { svg: out.join(''), width: rows[0].length * cell, height: 5 * cell };
}

// The ship: a dart with a cockpit, two fins and an exhaust trail, flying left
// toward the wordmark the way the terminal ship's trail runs off to the right.
function ship(x, y, k) {
  const p = (px, py) => `${(x + px * k).toFixed(1)},${(y + py * k).toFixed(1)}`;
  return [
    `<g>`,
    `<path d="M${p(0, 0)} L${p(46, -14)} L${p(70, -10)} L${p(78, 0)} L${p(70, 10)} L${p(46, 14)} Z" fill="url(#hull)"/>`,
    `<path d="M${p(40, -12)} L${p(58, -34)} L${p(68, -32)} L${p(62, -10)} Z" fill="#2563eb"/>`,
    `<path d="M${p(40, 12)} L${p(58, 34)} L${p(68, 32)} L${p(62, 10)} Z" fill="#1d4ed8"/>`,
    `<ellipse cx="${(x + 30 * k).toFixed(1)}" cy="${y.toFixed(1)}" rx="${(11 * k).toFixed(1)}" ry="${(5.5 * k).toFixed(1)}" fill="#dbeafe" opacity="0.9"/>`,
    `<rect x="${(x + 80 * k).toFixed(1)}" y="${(y - 3 * k).toFixed(1)}" width="${(26 * k).toFixed(1)}" height="${(6 * k).toFixed(1)}" rx="${(3 * k).toFixed(1)}" fill="#60a5fa"/>`,
    ...[0, 1, 2].map((i) => `<circle cx="${(x + (116 + i * 14) * k).toFixed(1)}" cy="${y.toFixed(1)}" r="${((3.2 - i * 0.8) * k).toFixed(2)}" fill="#93c5fd" opacity="${(0.9 - i * 0.25).toFixed(2)}"/>`),
    `</g>`,
  ].join('');
}

function svg({ w, h, cell, subtitle, round = true }) {
  const gap = Math.max(2, Math.round(cell * 0.14));
  const L = letters(0, 0, cell, gap);
  const shipScale = cell / 22;
  const shipW = 150 * shipScale;
  const total = L.width + cell * 1.6 + shipW;
  const x0 = Math.round((w - total) / 2);
  const y0 = Math.round(h / 2 - L.height / 2 - (subtitle ? cell * 0.9 : 0));
  const lettersAt = letters(x0, y0, cell, gap).svg;
  const shipX = x0 + L.width + cell * 1.6;
  const shipY = y0 + L.height * 0.38;
  const sub = subtitle ? `<text x="${w / 2}" y="${y0 + L.height + cell * 2.2}" text-anchor="middle" font-family="'JetBrains Mono','Cascadia Code',Consolas,'SFMono-Regular',Menlo,monospace" font-size="${Math.round(cell * 1.05)}" fill="#bfdbfe" letter-spacing="1">${subtitle}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="atlias: a sub-harness, or an agent of its own">
<title>atlias</title>
<defs>
<radialGradient id="sky" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#0b1a3d"/><stop offset="1" stop-color="#030712"/></radialGradient>
<linearGradient id="hull" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#bfdbfe"/><stop offset="1" stop-color="#3b82f6"/></linearGradient>
<filter id="glow" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="${(cell * 0.7).toFixed(1)}"/></filter>
</defs>
<rect width="${w}" height="${h}" rx="${round ? Math.round(h * 0.04) : 0}" fill="url(#sky)"/>
${stars(w, h, Math.round((w * h) / 9000), 7)}
<g filter="url(#glow)" opacity="0.55">${lettersAt}</g>
${lettersAt}
${ship(shipX, shipY, shipScale)}
${sub}
</svg>
`;
}

const out = path.join(ROOT, 'assets');
fs.mkdirSync(out, { recursive: true });
// Full bleed for the social preview, which GitHub rounds itself.
fs.writeFileSync(path.join(out, 'atlias-logo.svg'), svg({ w: 1280, h: 640, cell: 22, subtitle: 'a sub-harness, or an agent of its own', round: false }));
fs.writeFileSync(path.join(out, 'atlias-banner.svg'), svg({ w: 1280, h: 360, cell: 18, subtitle: 'a sub-harness, or an agent of its own' }));
console.log('wrote assets/atlias-logo.svg and assets/atlias-banner.svg');
