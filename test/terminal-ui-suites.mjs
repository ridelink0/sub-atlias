import { EventEmitter } from 'node:events';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as ui from '../lib/terminal-ui.mjs';
import * as commands from '../lib/commands.mjs';

export default async function terminalUISuites({ suite, asyncSuite, check, core, fs, path, ROOT }) {
  const detail = (happened = '') => ({ happened, why: 'Gev: the terminal must stay usable without changing a model request or granting a permission.', fix: 'Check the terminal composer contract.' });
  const rows = [{ name: 'help', help: 'command list' }, { name: 'hosts', help: 'installed hosts' }, { name: 'history', help: 'messages' }, { name: 'hidden', hidden: true }, { name: 'project:check', help: 'custom check' }];
  const rig = (opts = {}) => {
    const input = new EventEmitter(), output = new EventEmitter(), proc = new EventEmitter();
    input.isTTY = true; input.isRaw = false; input.paused = true; input.changes = [];
    input.setRawMode = (n) => { if (opts.rawFails) throw Error('raw unavailable'); input.isRaw = n; input.changes.push(n); };
    input.isPaused = () => input.paused; input.pause = () => { input.paused = true; }; input.resume = () => { input.paused = false; };
    output.isTTY = true; output.columns = opts.columns || 80; output.rows = opts.rows || 24; output.text = '';
    output.write = (s) => { output.text += s; };
    let fallbackCalls = 0, fallbackClosed = 0;
    const createUI = opts.impl ? opts.impl.createTerminalUI : ui.createTerminalUI;
    const terminal = createUI({ input, output, proc, env: opts.env || { NO_COLOR: '1' }, getCommands: () => opts.rows || rows,
      getInfo: () => ({ engine: 'echo', permission: 'workspace', tokens: 'tokens not recorded' }),
      fallbackQuestion: async () => { fallbackCalls++; return 'plain answer'; }, closeFallback: () => fallbackClosed++ });
    const start = (q) => (q === undefined ? terminal.prompt() : terminal.question(q)).then((text) => ({ text }), (error) => ({ error: error.message }));
    return { input, output, proc, terminal, start, send: (s) => input.emit('data', s), counts: () => ({ fallbackCalls, fallbackClosed }) };
  };

  suite('terminal palette expert', 'terminal composer matching, width and exact unknown usage', () => {
    check('the terminal composer defaults on and describes the explicit opt-out', core.DEFAULTS.ui.terminalEnabled === true && fs.readFileSync(path.join(ROOT, 'lib/settings.mjs'), 'utf8').includes('On by default; set false to opt out.'), detail());
    check('slash lists visible commands once and hidden commands stay hidden', ui.commandMatches('/', rows).length === 4 && !ui.commandMatches('/', rows).some((x) => x.name === 'hidden'), detail());
    check('prefix ranks above fuzzy and exact ranks first', ui.commandMatches('/h', rows)[0].name === 'help' && ui.commandMatches('/hosts', rows)[0].rank === 0, detail());
    check('case and subsequences match custom commands', ui.commandMatches('/PJC', rows)[0].name === 'project:check', detail());
    check('literal slash and arguments do not open a palette', ui.commandMatches('//literal', rows).length === 0 && ui.commandMatches('/help args', rows).length === 0 && ui.commandMatches(' /help', rows).length === 0, detail());
    check('malformed command rows cannot inject a completed command', ui.commandMatches('/', [null, {}, { name: 'a\n/permissions' }, { name: '\u001b[31m' }]).length === 0 && ui.commandMatches('/', null).length === 0, detail());
    check('missing matches are explicit', ui.renderComposer({ text: '/zzzz', commands: rows }).lines.some((x) => x.includes('No matching commands')), detail());
    check('CJK and combining characters use cell widths', ui.textWidth('e\u0301界') === 3 && ui.clipText('界e\u0301x', 3) === '界e\u0301', detail());
    check('terminal control sequences are not painted', ui.textWidth('\u001b[31mred\u001b[0m') === 3 && !ui.renderComposer({ text: '\u001b]0;bad\u0007text', info: { engine: '\u001b[2Jecho' } }).lines.join('').includes('\u001b'), detail());
    check('unknown counts do not become zero and native-host tokens stay unobserved', ui.tokenSummary({ promptLog: [10], outLog: [null] }) === 'tokens not recorded' && ui.tokenSummary({ engine: 'codex', promptLog: [10], outLog: [1] }) === 'tokens not recorded', detail());
    check('valid counts are labelled recorded and overflow stays unknown', ui.tokenSummary({ promptLog: [10], outLog: [2] }) === 'recorded tokens 12' && ui.tokenSummary({ promptLog: [Number.MAX_SAFE_INTEGER], outLog: [1] }) === 'tokens unknown', detail());
    check('TTY support requires both streams, raw input and a useful terminal', ui.supported({ isTTY: true, setRawMode() {} }, { isTTY: true }, {}) && !ui.supported({ isTTY: false }, { isTTY: true }, {}) && !ui.supported({ isTTY: true, setRawMode() {} }, { isTTY: true }, { TERM: 'dumb' }), detail());
    for (const [columns, height] of [[80, 24], [40, 12], [12, 8], [8, 1], [2, 1], [1, 8], [1000, 1000], [Infinity, NaN]]) {
      const f = ui.renderComposer({ text: '界e\u0301'.repeat(60) + '/a', columns, rows: height, selected: NaN, commands: rows });
      check(`rendered frame is bounded at ${columns}x${height}`, f.width <= 239 && (!Number.isFinite(columns) || f.width <= columns) && f.lines.every((x) => ui.textWidth(x) <= f.width) && f.lines.length <= (Number.isFinite(height) ? height : 24) && Number.isFinite(f.cursor.col) && f.cursor.col < f.width, detail(JSON.stringify(f.cursor)));
    }
    const source = fs.readFileSync(path.join(ROOT, 'lib/terminal-ui.mjs'), 'utf8');
    // B6: the frame's cell accounting for a mixed draft (tab, CJK, combining mark) matches the plain width of its text.
  const mixed = 'a\tb界éc';
  const mixedFrame = ui.renderComposer({ text: mixed, info: {}, columns: 80, rows: 24 }).lines[2];
  check('a frame with tab, CJK and combining text pads to exactly its width (B6)', mixedFrame === '| ' + ui.clipText(mixed, 200).replace(/\t/g, '  ') + ' '.repeat(75 - ui.textWidth(mixed.replace(/\t/g, '  '))) + ' |', detail(JSON.stringify(mixedFrame)));
  // A tab is two cells: 74 letters then a tab fit 76 cells only if counted right, so the tab wraps to a second row (the box is 75 cells inside).
  const wrapped = ui.renderComposer({ text: 'a'.repeat(74) + '\tb', info: {}, columns: 80, rows: 24 }).lines;
  check('a tab counts as two cells when a line wraps (B6)', wrapped[3].startsWith('|   b'), detail(JSON.stringify(wrapped[3])));
  // B7: zero-width space, word joiner and BOM take no cell, so the right border of a draft holding them stays in its column.
  const zeroWidth = ui.renderComposer({ text: 'x​y⁠﻿', info: {}, columns: 80, rows: 24 }).lines;
  check('zero-width space, word joiner and BOM are zero cells wide (B7)', ui.textWidth('a​⁠﻿b') === 2 && ui.textWidth(zeroWidth[2]) === ui.textWidth(zeroWidth[0]), detail(JSON.stringify([ui.textWidth('a​b'), ui.textWidth(zeroWidth[2]), ui.textWidth(zeroWidth[0])])));
  // B11: a 12-line draft shows the lines around the caret, with a marker row for the lines out of view.
  const twelve = Array.from({ length: 12 }, (_, i) => 'l' + (i + 1)).join('\n');
  const atEnd = ui.renderComposer({ text: twelve, info: {}, columns: 80, rows: 24 });
  check('a draft taller than the box marks the lines above and keeps the caret row visible (B11)', atEnd.lines[2] === '| ' + ui.clipText('... 8 more lines above', 75).padEnd(75) + ' |' && atEnd.lines[6].includes('l12') && atEnd.cursor.row === 6, detail(JSON.stringify([atEnd.lines[2], atEnd.lines[6], atEnd.cursor])));
  const atStart = ui.renderComposer({ text: twelve, cursor: 0, info: {}, columns: 80, rows: 24 });
  check('the lines below are marked at the foot of the box (B11)', atStart.lines[6].includes('... 8 more lines below') && atStart.lines[2].includes('l1') && atStart.dim.length === 1, detail(JSON.stringify([atStart.lines[2], atStart.lines[6]])));
  // B5: the footer keeps whole segments; a segment that does not fit is dropped, never cut mid-number.
  const footerInfo = { engine: 'echo (dry run)', permission: 'workspace', tokens: ['Claude plan', 'session', 'ctx 1,234', 'in 5,678'] };
  const footerAt = (columns) => ui.renderComposer({ text: 'x', info: footerInfo, columns, rows: 24 }).lines.at(-1);
  check('a wide footer shows every segment (B5)', footerAt(120) === 'echo (dry run)  |  workspace  |  Claude plan  |  session  |  ctx 1,234  |  in 5,678', detail(JSON.stringify(footerAt(120))));
  check('a narrow footer drops whole trailing segments, not the middle of a number (B5)', footerAt(40) === 'echo (dry run)  |  workspace' && footerAt(50) === 'echo (dry run)  |  workspace  |  Claude plan' && footerAt(60) === 'echo (dry run)  |  workspace  |  Claude plan  |  session', detail(JSON.stringify([footerAt(40), footerAt(50), footerAt(60)])));
  check('the token counts follow ui.usageEnabled, which defaults off (B5)', core.DEFAULTS.ui.usageEnabled === false && /config\(\)\.ui\.usageEnabled === true/.test(fs.readFileSync(path.join(ROOT, 'lib/agent.mjs'), 'utf8')), detail());
  // B4: under 30 rows the start screen is three lines with no wordmark and no blank rows; a tall terminal keeps the wordmark.
  for (const rowCount of [24, 40]) {
    const start = rig(); start.output.rows = rowCount; start.terminal.welcome('4.0.0', 'C:/project');
    const text = start.output.text, boxAt = text.indexOf('+');
    const above = text.slice(0, boxAt).replace(/\r\n$/, '').split('\r\n');
    const shortScreen = rowCount < 30;
    check(`a ${rowCount}-row start screen ${shortScreen ? 'is three lines with no wordmark or blank rows' : 'keeps the wordmark'} (B4)`, shortScreen ? above.length === 3 && above.every((x) => x.trim() !== '') && !text.includes('█') : text.includes('█') && above.length > 3, detail(JSON.stringify(above)));
    start.terminal.close();
  }
  check('the renderer never starts a shell, model, network or alternate screen',!/child_process|fetch\(|model\.complete|1049h/.test(source), detail());
  });

  await asyncSuite('terminal input expert', 'terminal composer keys, paste, prompts and cleanup', async () => {
    let r = rig(), p = r.start();
    r.send('/he'); check('slash text paints a live choice list', r.output.text.includes('/help') && r.output.text.includes('command list'), detail());
    r.send('\t'); r.send('\r'); let answer = await p;
    check('Tab completes the selected command and Enter returns it unchanged', answer.text === '/help ', detail(JSON.stringify(answer)));
    check('completed input restores raw mode, paste mode and owned listeners', !r.input.isRaw && r.input.paused && r.input.listenerCount('data') === 0 && r.output.listenerCount('resize') === 0 && r.output.text.includes('\u001b[?2004l'), detail());
    p = r.start(); r.send('/h'); r.send('\u001b[B'); r.send('\t'); r.send('\r'); answer = await p;
    check('arrows select another command without running it', answer.text === '/history ', detail(JSON.stringify(answer)));
    p = r.start(); r.send('/he'); r.send('\r'); answer = await p;
    check('Enter sends only the typed line, never the highlighted command', answer.text === '/he', detail(JSON.stringify(answer)));
    const aliasRows = [{ name: 'goal', help: 'singular alias' }, { name: 'goals', help: 'goal manager' }];
    const coalescedCompletion = async (impl) => {
      const editor = rig({ impl, rows: aliasRows }), pending = editor.start();
      editor.send('/go'); // Populate the old frame's candidates, singular first.
      editor.send('\x15/goals\tstatus'); // Ctrl+U, new prefix, Tab and argument may coalesce.
      editor.send('\r');
      const result = await pending; editor.terminal.close(); return result.text;
    };
    const currentCompletion = await coalescedCompletion(ui);
    check('Tab derives completion from the current draft when clear, prefix and Tab arrive together', currentCompletion === '/goals status', detail(JSON.stringify(currentCompletion)));
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-terminal-tab-mutation-'));
    try {
      const source = fs.readFileSync(path.join(ROOT, 'lib/terminal-ui.mjs'), 'utf8');
      const needle = 'const matches = commandMatches(a.text, a.commands);';
      check('completion mutation has a stable production anchor', source.includes(needle), detail());
      const mutated = source.replace(needle, 'const matches = a.matches || [];');
      const mutantPath = path.join(temp, 'terminal-ui-mutant.mjs'); fs.writeFileSync(mutantPath, mutated);
      const mutant = await import(pathToFileURL(mutantPath).href);
      const mutantCompletion = await coalescedCompletion(mutant);
      check('stale-frame mutation is detected by the coalesced-input regression', mutantCompletion === '/goal status' && mutantCompletion !== currentCompletion, detail(JSON.stringify(mutantCompletion)));
    } finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    p = r.start('Allow this action? '); r.send('/h');
    check('permission and other questions have no command palette', !r.output.text.slice(r.output.text.lastIndexOf('Allow')).includes('/help'), detail());
    r.send('\r'); answer = await p; check('question answers are ordinary text for the existing handler', answer.text === '/h', detail());
    p = r.start(); r.send('\u001b[20'); r.send('0~first\r\nsecond'); r.send('\u001b[20'); r.send('1~');
    let settled = false; p.then(() => { settled = true; }); await Promise.resolve();
    check('split bracketed multiline paste never submits itself', !settled && r.input.isRaw && r.input.listenerCount('data') === 1, detail());
    r.send('\r'); answer = await p; check('paste preserves exact CRLF text on send', answer.text === 'first\r\nsecond', detail(JSON.stringify(answer)));
    p = r.start(); r.send('one\r\ntwo'); await Promise.resolve(); r.send('\r'); answer = await p;
    check('unbracketed multiline paste also remains one draft', answer.text === 'one\r\ntwo', detail(JSON.stringify(answer)));
    for (const [chunk, typed] of [['ab\r', 'ab'], ['cd\r\n', 'cd']]) {
      let early = false; p = r.start(); p.then(() => { early = true; }); r.send(chunk); await new Promise(setImmediate);
      if (!early) r.send('\r'); answer = await p;
      check(`a chunk ${JSON.stringify(chunk)} types its text and submits on the trailing Enter`, early && answer.text === typed, { happened: JSON.stringify({ early, ...answer }), why: 'B1: a fast Enter that shares a read with typed text was swallowed and the CR stayed in the message.', fix: 'Only treat a chunk as a paste when CR/LF appears before its single trailing CR or CRLF.' });
    }
    p = r.start(); r.send('a'); r.send('\n'); r.send('b'); r.send('\r'); answer = await p;
    check('Ctrl+J inserts a newline', answer.text === 'a\nb', detail(JSON.stringify(answer)));
    p = r.start(); r.send('a\\'); r.send('\r'); r.send('b'); r.send('\r'); answer = await p;
    check('backslash Enter inserts a newline', answer.text === 'a\nb', detail(JSON.stringify(answer)));
    p = r.start(); r.send('e\u0301界'); r.send('\u001b[D'); r.send('\x7f'); r.send('\r'); answer = await p;
    check('backspace deletes a whole combining grapheme', answer.text === '界', detail(JSON.stringify(answer)));
    p = r.start(); const bytes = Buffer.from('界'); r.send(bytes.subarray(0, 1)); r.send(bytes.subarray(1)); r.send('\r'); answer = await p;
    check('split UTF8 input is decoded without replacement characters', answer.text === '界', detail(JSON.stringify(answer)));
    // Ctrl+U deletes from the cursor to the start of the line only (Claude Code), not the whole draft.
    p = r.start(); r.send('abc'); r.send('\u001b[D'); r.send('\x15'); r.send('\r'); answer = await p;
    check('Ctrl+U deletes from the cursor back to the start of the line, keeping the rest (TUI-A item 9)', answer.text === 'c', detail(JSON.stringify(answer)));
    p = r.start(); r.send('one two'); r.send('\x15'); r.send('x'); r.send('\r'); answer = await p;
    check('Ctrl+U at the end of a line clears it', answer.text === 'x', detail(JSON.stringify(answer)));
    p = r.start(); r.send('draft'); r.send('\u001b[A'); r.send('\u001b[B'); r.send('\r'); answer = await p;
    check('history down restores the current draft', answer.text === 'draft', detail(JSON.stringify(answer)));
    // B9: ESC O D is the left arrow in application cursor mode, even when its three bytes arrive in three reads;
    // a lone ESC O is held for its last byte, never typed as text.
    p = r.start(); r.send('ab'); r.send('\u001b'); r.send('O'); r.send('D'); r.send('X'); r.send('\r'); answer = await p;
    check('ESC O D moves left across split reads (B9)', answer.text === 'aXb', detail(JSON.stringify(answer)));
    p = r.start(); r.send('ab'); r.send('\u001bO'); r.send('H'); r.send('X'); r.send('\r'); answer = await p;
    check('ESC O H moves to the start and a lone ESC O is not typed (B9)', answer.text === 'Xab', detail(JSON.stringify(answer)));
    p = r.start(); r.send('/h'); r.output.columns = 32; r.output.rows = 10; r.output.emit('resize'); r.send('\t'); r.send('\r'); answer = await p;
    check('resize retains the draft and palette selection', answer.text === '/help ', detail(JSON.stringify(answer)));
    // B2: a 79-cell box line wraps to two rows at 40 columns. The draft's cursor sits on the third
    // line, so the erase must climb over the top border and the title line, 2 rows each (4 in all).
    r = rig(); p = r.start(); r.send('draft'); r.output.columns = 40; r.output.emit('resize');
    const erased = [...r.output.text.matchAll(/\r(?:\x1b\[(\d+)A)?\x1b\[0J/g)].pop();
    check('after the terminal narrows, the erase climbs over every row the old box now wraps to (B2)', Boolean(erased) && Number(erased[1] || 0) === 4, { happened: `last erase: ${JSON.stringify(erased && erased[0])}`, why: 'B2: the erase counted rows at the old width, so the top of the old box stayed on screen after a narrowing resize.', fix: 'erase() must recount each painted line at the new width when the terminal got narrower.' });
    r.send('\r'); await p; r.terminal.close();
    r.terminal.close(); check('closing removes its own process hook', r.proc.listenerCount('exit') === 0, detail());
    r = rig(); r.input.paused = false; p = r.start(); r.send('/exit'); r.send('\r'); await p; r.terminal.close();
    check('closing releases a resumed input handle after the final prompt', r.input.paused && !r.input.isRaw && r.input.listenerCount('data') === 0, detail());

    r = rig(); const foreign = () => {}; r.input.on('data', foreign); p = r.start(); r.send('\x04'); answer = await p;
    check('EOF rejects the prompt and preserves foreign listeners', /end of input/.test(answer.error) && !r.input.isRaw && r.input.listeners('data').includes(foreign), detail(JSON.stringify(answer))); r.terminal.close();
    r = rig(); p = r.start(); r.send('edit'); r.send('\x03'); r.send('new'); r.send('\r'); answer = await p;
    check('Ctrl+C clears a draft before exiting', answer.text === 'new', detail());
    p = r.start(); r.send('\x03'); answer = await p;
    check('Ctrl+C on empty cancels cleanly', /cancelled/.test(answer.error) && !r.input.isRaw, detail()); r.terminal.close();
    r = rig({ rawFails: true }); answer = await r.start(); const next = await r.start();
    check('a failed raw mode uses one persistent line fallback', answer.text === 'plain answer' && next.text === 'plain answer' && r.counts().fallbackCalls === 2 && r.input.listenerCount('data') === 0, detail()); r.terminal.close();
    check('closing also closes the fallback reader', r.counts().fallbackClosed === 1, detail());
    r = rig({ env: { NO_COLOR: '1' } }); r.terminal.welcome('4.0.0', 'C:/project'); p = r.start(); r.send('x'); r.send('\r'); await p;
    check('NO_COLOR removes SGR but keeps the composer', !/\u001b\[[0-9;]*m/.test(r.output.text) && r.output.text.includes('ATLIAS') && r.output.text.includes('Message Atlias'), detail()); r.terminal.close();
    r = rig(); p = r.start(); r.output.emit('error', new Error('closed output')); answer = await p;
    check('output failure also restores raw mode and rejects the question', answer.error === 'closed output' && !r.input.isRaw && r.input.listenerCount('data') === 0, detail()); r.terminal.close();
    r = rig(); r.terminal.close(); answer = await r.start();
    check('a closed editor cannot create another question', answer.error === 'terminal closed', detail());
  });

  await asyncSuite('terminal integration expert', 'terminal composer integration stays outside model requests', async () => {
    check('terminal install is discoverable in the real command registry', commands.BUILTINS.some((x) => x.name === 'shortcut') && commands.helpText(ROOT).includes('/shortcut'), detail());
    const lines = []; const state = { cwd: ROOT };
    await commands.dispatch('/shortcut status', { state, cwd: ROOT, out: (x) => lines.push(x) });
    check('terminal status is a direct command without a model turn', lines.some((x) => x.startsWith('terminal command:')), detail(JSON.stringify(lines)));
    const src = fs.readFileSync(path.join(ROOT, 'lib/agent.mjs'), 'utf8');
    check('the interactive module is dynamically loaded only in replIn', src.indexOf("import('./terminal-ui.mjs')") > src.indexOf('async function replIn'), detail());
    for (const file of ['lib/loop.mjs', 'lib/eval.mjs', 'tools/h2h/atlias_task.mjs']) check(`${file} has no terminal composer import`, !fs.readFileSync(path.join(ROOT, file), 'utf8').includes('terminal-ui'), detail());
  });
}
