// The usage display (Gev, 2026-10-17): what the atlias agent has spent, drawn in the
// terminal, and set in config.json:
//   ui.usageEnabled    false (default) prints nothing new
//   ui.usagePosition   top, bottom or sidebar
//   ui.usageColor      rainbow, a colour name, or a hex colour such as #ffb000
//   ui.usageAnimation  none, pulse, wave or shimmer
// This file imports nothing, so lib/core.mjs can use parseColor to check a value
// without a cycle. Everything that decides a string is a pure function of its
// arguments (metrics, segments, layout, paintLine); createDisplay is the only part
// that writes, and it writes nothing unless the setting is on.
//
// What it shows is what the loop already counts on the session state: the prompt
// and output tokens of every model round (promptLog, outLog), the context window
// (numCtx), the provider's cache counts (state.cache), and the turn count. The
// claude and codex engines run their own conversations, so atlias sees no tokens
// from them and the display says so instead of showing zeros. There is no cost
// figure: atlias keeps no price table and does not invent one.

export const POSITIONS = ['top', 'bottom', 'sidebar'];
export const ANIMATIONS = ['none', 'pulse', 'wave', 'shimmer'];
// About six frames a second: enough to read as motion, little enough to leave a log alone.
export const FRAME_MS = 160;
// The loop keeps its per-round logs to this many rounds.
export const LOG_CAP = 500;
// The sidebar needs room beside the text; a narrower terminal gets the top line instead.
export const SIDEBAR_MIN_COLUMNS = 100;
export const SIDEBAR_WIDTH = 28;

export const NAMED = {
  red: [239, 68, 68], orange: [249, 115, 22], amber: [245, 158, 11], gold: [250, 204, 21], yellow: [234, 179, 8],
  lime: [132, 204, 22], green: [34, 197, 94], teal: [20, 184, 166], cyan: [6, 182, 212], blue: [59, 130, 246],
  indigo: [99, 102, 241], purple: [168, 85, 247], magenta: [217, 70, 239], pink: [236, 72, 153],
  white: [244, 244, 245], gray: [161, 161, 170], grey: [161, 161, 170],
};

// 'rainbow', a name in NAMED, or #rgb / #rrggbb. Anything else is null.
export function parseColor(value) {
  const t = String(value == null ? '' : value).trim().toLowerCase();
  if (t === 'rainbow') return { kind: 'rainbow', name: 'rainbow' };
  if (Object.prototype.hasOwnProperty.call(NAMED, t)) return { kind: 'rgb', rgb: NAMED[t], name: t };
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(t);
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1];
  return { kind: 'rgb', rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), name: '#' + h };
}

// The ui section of the config, read the way the display uses it. A value that
// does not parse falls back to the default rather than stopping the session.
export function normalize(ui) {
  const u = ui && typeof ui === 'object' ? ui : {};
  return {
    enabled: u.usageEnabled === true,
    position: POSITIONS.includes(u.usagePosition) ? u.usagePosition : 'bottom',
    color: parseColor(u.usageColor) || parseColor('rainbow'),
    animation: ANIMATIONS.includes(u.usageAnimation) ? u.usageAnimation : 'none',
  };
}

// ---------- what to show ----------
const known = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function tally(log) {
  let total = 0, rounds = 0, last = null;
  for (const v of Array.isArray(log) ? log : []) if (known(v)) { total += v; rounds++; last = v; }
  return { total, rounds, last, capped: Array.isArray(log) && log.length >= LOG_CAP };
}
export function compact(n) {
  if (!known(n)) return '?';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n < 10000 ? (n / 1000).toFixed(1) : String(Math.round(n / 1000))) + 'k';
  return (n / 1e6).toFixed(1) + 'M';
}

// Numbers only. extra = { turnBase: {in, out}, turnLast: {in, out}, windows: [{label, percent, resets}] }
export function metrics(state, extra = {}) {
  const s = state && typeof state === 'object' ? state : {};
  const p = tally(s.promptLog);
  const o = tally(s.outLog);
  const ctx = known(s.numCtx) && s.numCtx > 0 ? s.numCtx : null;
  const c = s.cache && typeof s.cache === 'object' ? s.cache : {};
  const base = extra.turnBase || null;
  let turn = null;
  if (base) {
    const d = { in: Math.max(0, p.total - base.in), out: Math.max(0, o.total - base.out) };
    turn = d.in || d.out ? d : extra.turnLast || null;
  }
  return {
    engine: String(s.engine || ''),
    turns: Math.floor((Array.isArray(s.history) ? s.history.length : 0) / 2),
    calls: Math.max(p.rounds, o.rounds),
    seen: p.rounds > 0 || o.rounds > 0,
    promptTotal: p.total, outTotal: o.total, capped: p.capped || o.capped,
    lastPrompt: p.last, ctx,
    fill: p.last !== null && ctx ? Math.min(100, Math.round((p.last / ctx) * 100)) : null,
    cache: c.reported && c.prompt ? Math.round((c.cached / c.prompt) * 100) : null,
    turn,
    windows: Array.isArray(extra.windows) ? extra.windows.filter((w) => w && known(w.percent)) : [],
  };
}

// Label and value pairs, most useful first. A window that cannot be known says so.
export function segments(m) {
  const out = [];
  if (m.lastPrompt !== null) out.push(['ctx', m.fill !== null ? `${m.fill}% of ${compact(m.ctx)}` : compact(m.lastPrompt)]);
  if (m.seen) {
    const plus = m.capped ? '+' : '';
    out.push(['in', compact(m.promptTotal) + plus], ['out', compact(m.outTotal) + plus]);
  } else if (m.engine === 'claude' || m.engine === 'codex') out.push(['tokens', `not seen (${m.engine} engine)`]);
  else out.push(['tokens', 'none yet']);
  if (m.turn) out.push(['turn', `${compact(m.turn.in)}/${compact(m.turn.out)}`]);
  if (m.cache !== null) out.push(['cache', `${m.cache}%`]);
  if (m.calls) out.push(['calls', String(m.calls)]);
  for (const w of m.windows) out.push([w.label, `${Math.round(w.percent)}%`]);
  return out;
}

// Plain text lines for a position. Top and bottom are one line that drops
// trailing items before it would be cut; the sidebar is a column of fixed width.
export function layout(m, position, width = 80) {
  const segs = segments(m);
  if (position === 'sidebar') {
    const w = SIDEBAR_WIDTH;
    const rows = ['usage'];
    const add = (label, value) => rows.push(`${label.padEnd(6)}${value}`);
    for (const [label, value] of segs) {
      add(label, value);
      if (label === 'ctx' && m.fill !== null) {
        const on = Math.round(m.fill / 10);
        rows.push(`${''.padEnd(6)}[${'#'.repeat(on)}${'-'.repeat(10 - on)}]`);
      }
      const win = m.windows.find((x) => x.label === label);
      if (win && win.resets) rows.push(`${''.padEnd(6)}${win.resets}`);
    }
    return { lines: rows.map((r) => (r.length > w ? r.slice(0, w) : r.padEnd(w))), width: w };
  }
  const cols = Math.max(20, Number.isFinite(width) ? width : 80);
  const items = segs.map(([l, v]) => `${l} ${v}`);
  let line = 'atlias usage';
  for (const it of items) {
    if ((line + '  ' + it).length > cols) break;
    line += '  ' + it;
  }
  return { lines: [line.length > cols ? line.slice(0, cols) : line], width: Math.min(cols, line.length) };
}

// ---------- colour ----------
function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
const BASIC = [[31, [205, 49, 49]], [32, [13, 188, 121]], [33, [229, 229, 16]], [34, [36, 114, 200]], [35, [188, 63, 188]], [36, [17, 168, 205]], [37, [229, 229, 229]], [90, [128, 128, 128]]];
function nearestBasic(rgb) {
  let best = BASIC[0], bd = Infinity;
  for (const e of BASIC) {
    const d = (e[1][0] - rgb[0]) ** 2 + (e[1][1] - rgb[1]) ** 2 + (e[1][2] - rgb[2]) ** 2;
    if (d < bd) { bd = d; best = e; }
  }
  return best[0];
}

// The style of character i of n in frame f: { rgb, f (brightness 0..1), w (white mix 0..1) }.
export function charStyle(i, n, frame, color, animation) {
  const c = color && color.kind ? color : parseColor('rainbow');
  let rgb = c.kind === 'rainbow' ? hsl(((i * 14) + (animation === 'wave' ? frame * 18 : 0)) % 360, 0.85, 0.62) : c.rgb;
  let f = 1, w = 0;
  if (animation === 'pulse') f = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin((frame * Math.PI * 2) / 16));
  else if (animation === 'wave') f = 0.7 + 0.3 * Math.sin(i * 0.45 - frame * 0.7);
  else if (animation === 'shimmer') {
    const center = ((frame * 1.5) % (n + 12)) - 6;
    w = Math.max(0, 1 - Math.abs(i - center) / 4) * 0.8;
  }
  return { rgb, f, w };
}
const clamp = (x) => Math.max(0, Math.min(255, Math.round(x)));
function sgr(st, mode) {
  if (mode === 'truecolor') {
    const r = clamp(st.rgb[0] * st.f + (255 - st.rgb[0] * st.f) * st.w);
    const g = clamp(st.rgb[1] * st.f + (255 - st.rgb[1] * st.f) * st.w);
    const b = clamp(st.rgb[2] * st.f + (255 - st.rgb[2] * st.f) * st.w);
    return `\u001b[0;38;2;${r};${g};${b}m`;
  }
  const code = nearestBasic(st.rgb);
  const dim = st.f < 0.75 ? '2;' : '';
  const bright = st.w > 0.3 && code < 90 ? `${code + 60}` : `${code}`;
  return `\u001b[0;${dim}${bright}m`;
}
// Colour one line. Mode none returns the text untouched, with no escape code in it.
export function paintLine(text, { color, animation = 'none', mode = 'none', frame = 0 } = {}) {
  const s = String(text);
  if (mode === 'none' || !s) return s;
  let out = '', prev = '';
  const n = s.length;
  for (let i = 0; i < n; i++) {
    if (s[i] === ' ') { out += s[i]; continue; }
    const code = sgr(charStyle(i, n, frame, color, animation), mode);
    if (code !== prev) { out += code; prev = code; }
    out += s[i];
  }
  return out + (prev ? '\u001b[0m' : '');
}

// One frame, ready to print: the plain lines, or the painted ones.
export function render(state, ui, { mode = 'none', frame = 0, width = 80, extra = {}, position } = {}) {
  const s = normalize(ui);
  const m = metrics(state, extra);
  const pos = position || s.position;
  const l = layout(m, pos, width);
  const lines = l.lines.map((x) => paintLine(x, { color: s.color, animation: s.animation, mode, frame }));
  return { lines, plain: l.lines, width: l.width, position: pos };
}

// ---------- the one part that writes ----------
const NOOP = { active: false, start() {}, draw() {}, mark() {}, stop() {} };
const ESC = '\u001b';

// opts: stream (process.stdout or a stand-in), ui (config().ui), mode (colour mode of that stream),
// getState, getExtra, timers ({ setInterval, clearInterval }), proc (for the exit hook).
// Off (the default) this returns an object that does nothing at all.
export function createDisplay(opts = {}) {
  const s = normalize(opts.ui);
  if (!s.enabled) return NOOP;
  const stream = opts.stream;
  if (!stream || typeof stream.write !== 'function') return NOOP;
  const tty = Boolean(stream.isTTY);
  const mode = tty ? (opts.mode || 'none') : 'none';
  const getState = opts.getState || (() => ({}));
  const getExtra = opts.getExtra || (() => ({}));
  const timers = opts.timers || { setInterval, clearInterval };
  const proc = opts.proc || process;
  const animated = tty && mode !== 'none' && s.animation !== 'none';
  const write = (t) => { try { stream.write(t); } catch { /* a closed terminal must not stop the session */ } };

  let frame = 0, timer = null, started = false, stopped = false, shown = false;
  let geometry = null, rowsDrawn = 1, last = null;
  const totals = () => { const m = metrics(getState()); return { in: m.promptTotal, out: m.outTotal }; };
  // A resumed or running session counts its first turn from where the display began.
  let base = totals();
  const plan = () => {
    const cols = stream.columns || 80, rows = stream.rows || 24;
    const position = s.position === 'sidebar' && cols < SIDEBAR_MIN_COLUMNS ? 'top' : s.position;
    return { cols, rows, position };
  };
  const frameLines = () => {
    const g = plan();
    return { g, ...render(getState(), opts.ui, { mode, frame, width: g.cols, position: g.position, extra: { ...getExtra(), turnBase: base, turnLast: last } }) };
  };
  const region = (g) => {
    if (g.position === 'top') return `${ESC}[2;${g.rows}r${ESC}[${g.rows};1H`;
    if (g.position === 'bottom') return `${ESC}[1;${Math.max(1, g.rows - 1)}r${ESC}[${Math.max(1, g.rows - 1)};1H`;
    return '';
  };
  const paint = () => {
    const f = frameLines();
    if (!tty) return f;
    let out = `${ESC}7`;
    if (f.g.position === 'sidebar') {
      const col = Math.max(1, f.g.cols - f.width + 1);
      f.lines.forEach((ln, i) => { if (i + 1 < f.g.rows) out += `${ESC}[${i + 1};${col}H${ln}`; });
    } else out += `${ESC}[${f.g.position === 'top' ? 1 : f.g.rows};1H${ESC}[2K${f.lines[0]}`;
    write(out + `${ESC}8`);
    geometry = f.g;
    rowsDrawn = f.lines.length;
    return f;
  };
  const tick = () => { frame++; try { paint(); } catch { /* drawing must never stop the session */ } };
  const onResize = () => {
    if (stopped || !tty) return;
    const g = plan();
    write(region(g));
    geometry = g;
    try { paint(); } catch { /* as above */ }
  };
  const self = {
    active: true,
    start() {
      if (started || stopped) return;
      started = true;
      if (!tty) { if (s.position === 'top') self.draw(); return; }
      const g = plan();
      // Scroll what is on screen into the scrollback, so the rows the display takes are empty.
      write('\n'.repeat(g.rows) + region(g) + (g.position === 'sidebar' ? `${ESC}[${g.rows};1H` : ''));
      geometry = g;
      paint();
      shown = true;
      if (typeof stream.on === 'function') stream.on('resize', onResize);
      if (animated) { timer = timers.setInterval(tick, FRAME_MS); if (timer && typeof timer.unref === 'function') timer.unref(); }
      if (proc && typeof proc.once === 'function') proc.once('exit', self.stop);
    },
    // Before the prompt: a plain line when there is no terminal, a redraw when there is one.
    draw() {
      if (stopped) return;
      if (!tty) { if (s.position === 'top' && shown) return; shown = true; write(frameLines().lines.join('\n') + '\n'); return; }
      paint();
    },
    // The turn that just finished becomes "last"; the next one counts from here.
    mark() {
      const now = totals();
      if (now.in - base.in || now.out - base.out) last = { in: now.in - base.in, out: now.out - base.out };
      base = now;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) { timers.clearInterval(timer); timer = null; }
      if (!tty || !started) return;
      if (typeof stream.removeListener === 'function') stream.removeListener('resize', onResize);
      if (proc && typeof proc.removeListener === 'function') proc.removeListener('exit', self.stop);
      const g = geometry || plan();
      let out = `${ESC}[r${ESC}7`;
      if (g.position === 'sidebar') {
        const w = SIDEBAR_WIDTH, col = Math.max(1, g.cols - w + 1);
        for (let i = 0; i < rowsDrawn && i + 1 < g.rows; i++) out += `${ESC}[${i + 1};${col}H${' '.repeat(w)}`;
      } else out += `${ESC}[${g.position === 'top' ? 1 : g.rows};1H${ESC}[2K`;
      write(out + `${ESC}8`);
    },
  };
  return self;
}
