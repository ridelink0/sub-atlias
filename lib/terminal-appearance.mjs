// Presentation only. No model request, billing or permission decisions.
import { parseColor } from './usage-display.mjs';
const BASIC = [[0,0,0],[205,49,49],[13,188,121],[229,229,16],[36,114,200],[188,63,188],[17,168,205],[229,229,229],[102,102,102],[241,76,76],[35,209,139],[245,245,67],[59,142,234],[214,112,214],[41,184,219],[255,255,255]];
export function terminalTheme(value = 'atlias') {
  const base = { mark: [47,116,245], body: [92,155,244], basic: 94, plain: false };
  if (value === 'none') return { ...base, plain: true };
  if (value === 'atlias') return base;
  const color = parseColor(value);
  if (color?.kind !== 'rgb') return base;
  const distance = rgb => rgb.reduce((n,c,i) => n + (c - color.rgb[i]) ** 2, 0);
  let index = 0;
  for (let i = 1; i < BASIC.length; i++) if (distance(BASIC[i]) < distance(BASIC[index])) index = i;
  return { mark: [...color.rgb], body: [...color.rgb], basic: index < 8 ? 30 + index : 90 + index - 8, plain: false };
}
