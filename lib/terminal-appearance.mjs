// Presentation only. No model request, billing or permission decisions.
import { parseColor } from './usage-display.mjs';
import { themeColor } from './seasons.mjs';
const BASIC = [[0,0,0],[205,49,49],[13,188,121],[229,229,16],[36,114,200],[188,63,188],[17,168,205],[229,229,229],[102,102,102],[241,76,76],[35,209,139],[245,245,67],[59,142,234],[214,112,214],[41,184,219],[255,255,255]];
export const mixRgb = (a, b, t) => a.map((c, i) => Math.round(c + (b[i] - c) * t));
// The nearest colour a 16-colour terminal has, as its SGR code.
export function nearestBasic(rgb) {
  const distance = (row) => row.reduce((n, c, i) => n + (c - rgb[i]) ** 2, 0);
  let index = 0;
  for (let i = 1; i < BASIC.length; i++) if (distance(BASIC[i]) < distance(BASIC[index])) index = i;
  return index < 8 ? 30 + index : 90 + index - 8;
}
// A subagent keeps one of six colours, chosen from its name the way the desktop app chooses it, so the
// same subagent looks the same in the terminal and the app. Bright enough to read on a dark terminal.
export const SUBAGENT_RGB = [[255, 122, 133], [245, 181, 74], [90, 209, 154], [92, 203, 245], [177, 140, 255], [243, 139, 208]];
export function subagentColor(name) {
  // FNV-1a: a plain "h * 31 + c" keeps only the sum of the codes modulo 6, which put most names on one colour.
  let h = 2166136261;
  for (const ch of String(name || '')) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return SUBAGENT_RGB[h % 6];
}
// The GitHub mark stays purple and leans toward the theme. Each is bright enough to read on a dark terminal and the dark composer band.
const GIT_PURPLE = [167, 139, 250];
export function terminalTheme(value = 'atlias') {
  const base = { mark: [47,116,245], body: [92,155,244], basic: 94, plain: false, git: GIT_PURPLE, band: [11,20,40] };
  if (value === 'none') return { ...base, plain: true };
  if (value === 'atlias') return base;
  const color = parseColor(themeColor(value) || value);
  if (color?.kind !== 'rgb') return base;
  return { mark: [...color.rgb], body: [...color.rgb], basic: nearestBasic(color.rgb), plain: false, git: mixRgb(GIT_PURPLE, color.rgb, 0.18), band: mixRgb([9,11,16], color.rgb, 0.13) };
}
