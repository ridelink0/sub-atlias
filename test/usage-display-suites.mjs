// The usage display (Gev, 2026-10-17): ui.usageEnabled, ui.usagePosition, ui.usageColor and
// ui.usageAnimation draw what the agent has spent in its terminal. The render functions are pure, so
// they are checked here as exact strings; the writer is checked against a stand-in terminal and fake
// timers, so no test waits on a clock. Off is the default and must print nothing new. Loaded by test/run.mjs.
import { spawnSync } from 'node:child_process';
import * as ud from '../lib/usage-display.mjs';
import * as settings from '../lib/settings.mjs';

export default async function usageDisplaySuites({ suite, check, core, ROOT, TMP, fs, path }) {
  const ESC = String.fromCharCode(27);
  const SGR = new RegExp(ESC + '\\[[0-9;]*m', 'g');
  const ANY_ESC = new RegExp(ESC);
  const STATE = { engine: 'ollama', history: [1, 2, 3, 4], promptLog: [1000, 2048, null], outLog: [100, 200, null], numCtx: 16384, cache: { calls: 3, reported: 2, silent: 1, prompt: 3048, cached: 2000 } };
  const WIN = [{ label: '5h', percent: 59.4, resets: 'resets in 2h 10m' }, { label: 'wk', percent: 20, resets: 'resets in 5 days' }];
  const term = (o = {}) => {
    const writes = [];
    const handlers = {};
    return { isTTY: true, columns: 120, rows: 24, ...o, writes, handlers, write(t) { writes.push(t); return true; }, on(ev, fn) { handlers[ev] = fn; }, removeListener(ev) { delete handlers[ev]; }, text: () => writes.join('') };
  };
  const clock = () => { const c = { set: [], cleared: 0, fn: null }; c.setInterval = (fn, ms) => { c.fn = fn; c.set.push(ms); return { unref() {} }; }; c.clearInterval = () => { c.cleared++; }; return c; };
  const proc = () => { const p = { exit: 0, once() { p.exit++; }, removeListener() { p.exit--; } }; return p; };
  const make = (ui, stream, extra = {}) => { const k = clock(), p = proc(); return { k, p, stream, d: ud.createDisplay({ ui, stream, mode: 'truecolor', getState: () => extra.state || STATE, getExtra: () => ({ windows: WIN }), timers: k, proc: p, ...extra.opts }) }; };

  suite('usage display', 'usage display:the keys are registered off, described, checked, and settable', () => {
    // Appearance and composer settings share this section; this contract covers the four usage keys.
    const rows = settings.rows().filter((r) => r.section === 'ui' && r.id.startsWith('ui.usage'));
    const ids = rows.map((r) => r.id).sort().join(',');
    check('ui has four usage keys, each described, with enabled off by default',
      ids === 'ui.usageAnimation,ui.usageColor,ui.usageEnabled,ui.usagePosition' && rows.every((r) => r.about.length > 40) && core.DEFAULTS.ui.usageEnabled === false && core.DEFAULTS.ui.usageAnimation === 'none',
      { happened: ids, why: 'A setting nobody can see or read about is not a setting; off keeps today\'s output.', fix: 'DEFAULTS.ui in lib/core.mjs and DESCRIPTIONS in lib/settings.mjs.' });
    const a = settings.set('ui.usagePosition', 'sidebar'), b = settings.set('ui.usagePosition', 'left'), c = settings.set('ui.usageAnimation', 'Shimmer'), e = settings.set('ui.usageAnimation', 'spin');
    check('position and animation take their lists only, case folded, and refuse the rest with the list',
      a.ok && a.text === 'ui.usagePosition = "sidebar"' && !b.ok && /top, bottom, sidebar/.test(b.text) && c.ok && core.config().ui.usageAnimation === 'shimmer' && !e.ok && /none, pulse, wave, shimmer/.test(e.text),
      { happened: JSON.stringify([a, b, c, e]), why: 'A typo would otherwise quietly mean the default.', fix: 'CHOICES.ui in lib/core.mjs.' });
    const h = settings.set('ui.usageColor', '#FFB000'), n = settings.set('ui.usageColor', 'Teal'), stored = core.config().ui.usageColor, r = settings.set('ui.usageColor', 'rainbow'), bad = settings.set('ui.usageColor', 'blurple'), bad2 = settings.set('ui.usageColor', '#12345');
    check('colour takes rainbow, a name or a hex colour, stored lower case, and refuses anything else',
      h.ok && h.text === 'ui.usageColor = "#ffb000"' && n.ok && stored === 'teal' && r.ok && !bad.ok && /rainbow, a colour name/.test(bad.text) && !bad2.ok,
      { happened: JSON.stringify([h, n, r, bad, bad2]), why: 'An unreadable colour would draw nothing or crash the repaint.', fix: 'The ui.usageColor branch of parseSetting in lib/core.mjs.' });
    const on = settings.set('ui.usageEnabled', 'true'), off = settings.set('ui.usageEnabled', 'maybe');
    check('enabled is a boolean', on.ok && core.config().ui.usageEnabled === true && !off.ok, { happened: JSON.stringify([on, off]), why: 'The master switch.', fix: 'DEFAULTS.ui.usageEnabled is a boolean.' });
    for (const k of ['usageEnabled', 'usagePosition', 'usageColor', 'usageAnimation']) settings.reset('ui.' + k);
    check('reset returns every key to its default', JSON.stringify(core.config().ui) === JSON.stringify(core.DEFAULTS.ui), { happened: JSON.stringify(core.config().ui), why: 'The tests must leave no setting behind.', fix: 'settings.reset.' });
  });

  suite('usage display', 'usage display:colours parse', () => {
    const p = ud.parseColor;
    check('rainbow, names and hex parse; anything else does not',
      p('rainbow').kind === 'rainbow' && p(' Gold ').name === 'gold' && JSON.stringify(p('#f80').rgb) === '[255,136,0]' && JSON.stringify(p('#FFB000').rgb) === '[255,176,0]'
      && p('blurple') === null && p('#12') === null && p('') === null && p(null) === null && p('ff0000') === null,
      { happened: JSON.stringify(['rainbow', 'Gold', '#f80', '#FFB000', 'blurple', '#12', '', 'ff0000'].map((x) => p(x))), why: 'The config is typed by hand.', fix: 'parseColor in lib/usage-display.mjs.' });
    const n = ud.normalize({ usageEnabled: 'yes', usagePosition: 'left', usageColor: 'nope', usageAnimation: 'spin' });
    check('a bad stored value falls back to the default instead of stopping the session', n.enabled === false && n.position === 'bottom' && n.color.kind === 'rainbow' && n.animation === 'none',
      { happened: JSON.stringify(n), why: 'A hand-edited config.json must not break the agent.', fix: 'normalize in lib/usage-display.mjs.' });
  });

  suite('usage display', 'usage display:the numbers come from what the loop already counts', () => {
    const m = ud.metrics(STATE, { windows: WIN });
    check('totals skip silent rounds, the last prompt fills the window, the cache rate uses reported calls',
      m.promptTotal === 3048 && m.outTotal === 300 && m.lastPrompt === 2048 && m.fill === 13 && m.cache === 66 && m.calls === 2 && m.turns === 2 && m.seen && !m.capped,
      { happened: JSON.stringify(m), why: 'A silent round is unknown, not zero.', fix: 'metrics in lib/usage-display.mjs.' });
    const empty = ud.metrics({}, {});
    check('an empty or missing state is no tokens seen, not a crash', !empty.seen && empty.fill === null && empty.cache === null && ud.metrics(null).turns === 0 && ud.metrics(undefined, { windows: [{ label: 'x', percent: 'a' }] }).windows.length === 0,
      { happened: JSON.stringify(empty), why: 'The display draws before the first call.', fix: 'metrics defaults.' });
    check('numbers compact', [0, 999, 1000, 3048, 16384, 999999, 1500000].map(ud.compact).join(' ') === '0 999 1.0k 3.0k 16k 1000k 1.5M' && ud.compact(NaN) === '?' && ud.compact(-1) === '?',
      { happened: [0, 999, 1000, 3048, 16384, 999999, 1500000].map(ud.compact).join(' '), why: 'The line is narrow.', fix: 'compact.' });
    const log = new Array(500).fill(10);
    check('a log at the loop\'s cap shows its totals with a plus', ud.segments(ud.metrics({ promptLog: log, outLog: log })).some(([l, v]) => l === 'in' && v === '5.0k+'),
      { happened: JSON.stringify(ud.segments(ud.metrics({ promptLog: log, outLog: log }))), why: 'The loop keeps 500 rounds; beyond that the sum is a floor.', fix: 'tally and segments.' });
  });

  suite('usage display', 'usage display:the lines are exact strings', () => {
    const m = ud.metrics(STATE, { windows: WIN });
    check('bottom and top are one line', ud.layout(m, 'bottom', 120).lines.join('|') === 'atlias usage  ctx 13% of 16k  in 3.0k  out 300  cache 66%  calls 2  5h 59%  wk 20%' && ud.layout(m, 'top', 120).lines.length === 1,
      { happened: ud.layout(m, 'bottom', 120).lines.join('|'), why: 'The format is the contract.', fix: 'layout in lib/usage-display.mjs.' });
    check('a narrow line drops whole items from the end, never half of one', ud.layout(m, 'bottom', 40).lines[0] === 'atlias usage  ctx 13% of 16k  in 3.0k' && ud.layout(m, 'bottom', 5).lines[0].length <= 20,
      { happened: ud.layout(m, 'bottom', 40).lines[0], why: 'A cut value reads as a different number.', fix: 'layout width loop.' });
    const side = ud.layout(m, 'sidebar');
    check('the sidebar is a fixed-width column with a bar and the reset times',
      side.width === 28 && side.lines.every((x) => x.length === 28) && side.lines.map((x) => x.trimEnd()).join('|') === 'usage|ctx   13% of 16k|      [#---------]|in    3.0k|out   300|cache 66%|calls 2|5h    59%|      resets in 2h 10m|wk    20%|      resets in 5 days',
      { happened: side.lines.map((x) => x.trimEnd()).join('|'), why: 'The column is drawn over the right edge, so every row must be the same width to cover what was there.', fix: 'layout sidebar branch.' });
    const claude = ud.layout(ud.metrics({ engine: 'claude', history: [] }), 'bottom', 80).lines[0];
    const fresh = ud.layout(ud.metrics({ engine: 'ollama' }), 'bottom', 80).lines[0];
    check('claude and codex engines say their tokens are not seen; a new local session says none yet', claude === 'atlias usage  tokens not seen (claude engine)' && fresh === 'atlias usage  tokens none yet',
      { happened: claude + ' | ' + fresh, why: 'Those engines run their own conversations; a zero would be a made-up number.', fix: 'segments.' });
    const t = ud.metrics(STATE, { turnBase: { in: 1000, out: 100 }, turnLast: { in: 7, out: 8 } });
    const t0 = ud.metrics(STATE, { turnBase: { in: 3048, out: 300 }, turnLast: { in: 7, out: 8 } });
    check('the turn is what was spent since the turn began, or the last finished turn when nothing is running', JSON.stringify(t.turn) === '{"in":2048,"out":200}' && JSON.stringify(t0.turn) === '{"in":7,"out":8}',
      { happened: JSON.stringify([t.turn, t0.turn]), why: 'Tokens per turn.', fix: 'metrics turn.' });
  });

  suite('usage display', 'usage display:colour and animation are exact, and plain when asked', () => {
    const text = 'atlias usage  ctx 13%';
    const strip = (s) => s.replace(SGR, '');
    check('mode none returns the text untouched for every colour and animation',
      ['none', 'pulse', 'wave', 'shimmer'].every((a) => ['rainbow', 'red', '#ffb000'].every((c) => ud.paintLine(text, { color: ud.parseColor(c), animation: a, mode: 'none', frame: 3 }) === text)),
      { happened: 'differs', why: 'NO_COLOR and a pipe get plain text with no escape code.', fix: 'paintLine mode none.' });
    check('the solid colour code is exact', ud.paintLine('ab', { color: ud.parseColor('#ff0000'), mode: 'truecolor' }) === ESC + '[0;38;2;255;0;0mab' + ESC + '[0m',
      { happened: JSON.stringify(ud.paintLine('ab', { color: ud.parseColor('#ff0000'), mode: 'truecolor' })), why: 'The exact bytes are the contract.', fix: 'paintLine and sgr.' });
    check('a space is never painted', ud.paintLine('a b', { color: ud.parseColor('#00ff00'), mode: 'truecolor' }) === ESC + '[0;38;2;0;255;0ma b' + ESC + '[0m',
      { happened: JSON.stringify(ud.paintLine('a b', { color: ud.parseColor('#00ff00'), mode: 'truecolor' })), why: 'Same style runs stay one escape.', fix: 'paintLine.' });
    const rb = ud.paintLine('abcdef', { color: ud.parseColor('rainbow'), mode: 'truecolor' });
    check('rainbow gives neighbouring letters different colours and still reads as the text', (rb.match(/38;2/g) || []).length === 6 && strip(rb) === 'abcdef',
      { happened: JSON.stringify(rb), why: 'That is what rainbow means.', fix: 'charStyle.' });
    const frames = (a, c = 'rainbow') => [0, 1, 4, 16].map((f) => ud.paintLine(text, { color: ud.parseColor(c), animation: a, mode: 'truecolor', frame: f }));
    const none = frames('none'), pulse = frames('pulse', 'gold'), wave = frames('wave'), shim = frames('shimmer', 'cyan');
    check('none never changes; pulse, wave and shimmer change from frame to frame',
      none[0] === none[1] && none[0] === none[3] && pulse[0] !== pulse[2] && wave[0] !== wave[1] && shim[1] !== shim[2] && shim[0] !== shim[2],
      { happened: JSON.stringify({ none: none.length, pulse: pulse[0] === pulse[2], wave: wave[0] === wave[1], shim: shim[1] === shim[2] }), why: 'An animation that does not move is a bug; none that moves floods the log.', fix: 'charStyle.' });
    check('pulse repeats every 16 frames and every frame keeps the text', pulse[0] === pulse[3] && [pulse, wave, shim].every((set) => set.every((s) => strip(s) === text)),
      { happened: 'no', why: 'A loop of known length; the text never changes.', fix: 'charStyle pulse period.' });
    const s0 = ud.charStyle(0, 10, 0, ud.parseColor('#102030'), 'none'), sp = ud.charStyle(0, 10, 4, ud.parseColor('#102030'), 'pulse');
    check('charStyle: no animation keeps the colour at full brightness with no white; pulse at its peak is full brightness too',
      JSON.stringify(s0) === '{"rgb":[16,32,48],"f":1,"w":0}' && sp.f === 1 && ud.charStyle(0, 10, 0, ud.parseColor('#102030'), 'pulse').f < 1,
      { happened: JSON.stringify([s0, sp]), why: 'The per-letter style is the whole animation.', fix: 'charStyle.' });
    const basic = ud.paintLine('ab', { color: ud.parseColor('red'), mode: 'basic' });
    check('a 16-colour terminal gets a 16-colour code and no truecolor one', basic === ESC + '[0;31mab' + ESC + '[0m' && !/38;2/.test(ud.paintLine(text, { color: ud.parseColor('rainbow'), animation: 'wave', mode: 'basic', frame: 2 })),
      { happened: JSON.stringify(basic), why: 'colorMode returns basic on terminals without truecolor.', fix: 'sgr basic branch.' });
    const r = ud.render(STATE, { usageEnabled: true, usageColor: 'teal', usageAnimation: 'none', usagePosition: 'top' }, { mode: 'none', width: 80, extra: { windows: WIN } });
    check('render ties config, numbers and colour together', r.position === 'top' && r.lines[0] === r.plain[0] && r.plain[0].startsWith('atlias usage  ctx 13% of 16k'),
      { happened: JSON.stringify(r), why: 'The one call the writer makes.', fix: 'render.' });
  });

  suite('usage display', 'usage display:the writer draws only when asked, and only as much as is safe', () => {
    const off = make({}, term());
    off.d.start(); off.d.mark(); off.d.draw(); off.d.stop();
    check('off (the default) writes nothing, sets no timer, hooks nothing', off.stream.writes.length === 0 && off.k.set.length === 0 && off.p.exit === 0 && off.d.active === false,
      { happened: JSON.stringify(off.stream.writes), why: 'Default output must be exactly today\'s.', fix: 'createDisplay returns NOOP when ui.usageEnabled is not true.' });
    const dflt = ud.createDisplay({ ui: core.config().ui, stream: term() });
    check('the shipped default config gives the inert display', dflt.active === false, { happened: String(dflt.active), why: 'No settings, no change.', fix: 'DEFAULTS.ui.usageEnabled false.' });

    const pipe = make({ usageEnabled: true, usagePosition: 'bottom', usageColor: 'rainbow', usageAnimation: 'wave' }, term({ isTTY: false }));
    pipe.d.start(); pipe.d.draw(); pipe.d.mark(); pipe.d.draw(); pipe.d.stop();
    const line = 'atlias usage  ctx 13% of 16k  in 3.0k  out 300  cache 66%  calls 2  5h 59%  wk 20%\n';
    check('without a terminal it is a plain line before each prompt: no escape code, no timer, no hook', pipe.stream.text() === line + line && pipe.k.set.length === 0 && pipe.p.exit === 0,
      { happened: JSON.stringify(pipe.stream.text()), why: 'Logs must not fill with frames or control codes.', fix: 'createDisplay non-TTY branch.' });
    const top = make({ usageEnabled: true, usagePosition: 'top' }, term({ isTTY: false }));
    top.d.start(); top.d.draw(); top.d.draw();
    check('top without a terminal prints once, at the start', top.stream.text() === line, { happened: JSON.stringify(top.stream.text()), why: 'A top line repeated down a log is noise.', fix: 'start/draw top.' });

    const nocolor = make({ usageEnabled: true, usagePosition: 'bottom', usageAnimation: 'shimmer' }, term(), { opts: { mode: 'none' } });
    nocolor.d.start(); nocolor.d.draw(); nocolor.d.stop();
    check('NO_COLOR on a terminal pins the line plain: no colour code, no timer', nocolor.stream.text().replace(SGR, '') === nocolor.stream.text() && nocolor.k.set.length === 0 && /atlias usage/.test(nocolor.stream.text()),
      { happened: JSON.stringify(nocolor.stream.text()), why: 'NO_COLOR forbids colour, and a plain line has nothing to animate.', fix: 'animated needs mode !== none.' });

    const live = make({ usageEnabled: true, usagePosition: 'bottom', usageColor: 'gold', usageAnimation: 'shimmer' }, term());
    live.d.start();
    const afterStart = live.stream.writes.length;
    live.k.fn(); live.k.fn();
    const f1 = live.stream.writes[afterStart], f2 = live.stream.writes[afterStart + 1];
    check('an animation runs one timer at about six frames a second, each tick one write, frames differ', live.k.set.length === 1 && live.k.set[0] === ud.FRAME_MS && ud.FRAME_MS >= 100 && live.stream.writes.length === afterStart + 2 && f1 !== f2 && live.p.exit === 1,
      { happened: JSON.stringify({ timers: live.k.set, writes: live.stream.writes.length - afterStart }), why: 'Modest rate, no flood.', fix: 'createDisplay timer.' });
    const s0 = live.stream.writes.length;
    live.d.stop(); live.d.stop();
    live.d.draw(); live.d.mark();
    check('stop clears the timer once, resets the scroll region, removes the exit hook, and later calls write nothing more',
      live.k.cleared === 1 && live.p.exit === 0 && live.stream.writes.length === s0 + 1 && live.stream.writes[s0].startsWith(ESC + '[r') && !live.stream.handlers.resize,
      { happened: JSON.stringify({ cleared: live.k.cleared, exit: live.p.exit, writes: live.stream.writes.length - s0 }), why: 'A terminal left with a shrunk scroll region is broken for the next program.', fix: 'stop.' });

    const place = (pos, o = {}) => { const m = make({ usageEnabled: true, usagePosition: pos }, term(o)); m.d.start(); return m.stream.text(); };
    check('top reserves row 1 and bottom the last row, with the cursor left in the text area',
      place('top').includes(ESC + '[2;24r' + ESC + '[24;1H') && place('bottom').includes(ESC + '[1;23r' + ESC + '[23;1H') && place('top').includes(ESC + '[1;1H') && place('bottom').includes(ESC + '[24;1H' + ESC + '[2K'),
      { happened: JSON.stringify(place('top')), why: 'The text must scroll inside the region and never over the display.', fix: 'region and paint.' });
    const sb = place('sidebar');
    check('the sidebar is drawn at the right edge in a wide terminal and is the top line in a narrow one', sb.includes(ESC + '[1;93H') && !sb.includes('r' + ESC + '[24;1H') && place('sidebar', { columns: 80 }).includes(ESC + '[2;24r'),
      { happened: JSON.stringify(sb.slice(0, 200)), why: 'Under 100 columns the column would sit on the text.', fix: 'plan.' });
    const rz = make({ usageEnabled: true, usagePosition: 'bottom' }, term());
    rz.d.start(); rz.stream.rows = 40; const before = rz.stream.writes.length; rz.stream.handlers.resize();
    check('a resize moves the region to the new height', rz.stream.writes.slice(before).join('').includes(ESC + '[1;39r'), { happened: JSON.stringify(rz.stream.writes.slice(before)), why: 'The reserved row follows the window.', fix: 'onResize.' });

    const grow = { engine: 'ollama', history: [], promptLog: [100], outLog: [10], numCtx: 1000 };
    const tr = make({ usageEnabled: true, usagePosition: 'bottom' }, term({ isTTY: false }), { state: grow });
    tr.d.mark();
    grow.promptLog.push(300); grow.outLog.push(40);
    tr.d.draw();
    check('the turn counts from the last mark', /turn 300\/40/.test(tr.stream.text()), { happened: tr.stream.text(), why: 'Tokens per turn.', fix: 'mark and getExtra.' });
    const bad = make({ usageEnabled: true }, { isTTY: false, write() { throw new Error('closed'); } });
    let threw = false; try { bad.d.start(); bad.d.draw(); bad.d.stop(); } catch { threw = true; }
    check('a stream that throws on write does not stop the session', !threw, { happened: String(threw), why: 'A closed terminal is not the agent\'s failure.', fix: 'write try/catch.' });
  });

  suite('usage display', 'usage display:the agent prints nothing new unless it is on', () => {
    const bin = path.join(ROOT, 'bin', 'atlias.mjs');
    const cwd = fs.mkdtempSync(path.join(TMP, 'ud-cwd-'));
    const run = (cfg) => {
      const home = fs.mkdtempSync(path.join(TMP, 'ud-home-'));
      if (cfg) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
      const env = { ...process.env, ATLIAS_HOME: home, ATLIAS_NO_DETACH: '1' };
      delete env.NO_COLOR;
      return spawnSync(process.execPath, [bin, 'agent', '--engine', 'echo'], { cwd, env, input: 'hello\n', encoding: 'utf8', timeout: 30000 });
    };
    const a = run(null);
    const b = run({ ui: { usageEnabled: true, usagePosition: 'bottom', usageColor: 'teal', usageAnimation: 'shimmer' } });
    const strip = (s) => s.split(/\r?\n/).filter((l) => !l.startsWith('atlias usage')).join('\n');
    check('default: no usage line at all', !/atlias usage/.test(a.stdout) && /echo: hello/.test(a.stdout), { happened: `${a.status} ${a.stdout.slice(0, 300)} ${a.stderr.slice(0, 200)}`, why: 'Default behaviour is unchanged.', fix: 'replIn wiring.' });
    check('on, piped: plain usage lines before the prompts, no escape code, and everything else identical to off',
      /atlias usage  tokens none yet/.test(b.stdout) && !ANY_ESC.test(b.stdout) && strip(b.stdout) === strip(a.stdout),
      { happened: `${b.status} on: ${JSON.stringify(strip(b.stdout).slice(-200))} off: ${JSON.stringify(strip(a.stdout).slice(-200))}`, why: 'A pipe is a log; only the new lines may differ.', fix: 'createDisplay non-TTY branch.' });
  });
}
