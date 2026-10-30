import { EventEmitter } from 'node:events';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as ui from '../lib/terminal-ui.mjs';
import * as brand from '../lib/terminal-brand.mjs';
import * as mdRender from '../lib/render-markdown.mjs';
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
    const terminal = createUI({ input, output, proc, env: opts.env || { NO_COLOR: '1' }, history: opts.history, keepRawBetweenPrompts: opts.keepRawBetweenPrompts, appearance: { followUp: 'queue', ...opts.appearance }, getCommands: () => opts.rows || rows,
      getInfo: () => ({ engine: 'echo', permission: 'workspace', tokens: 'tokens not recorded' }),
      fallbackQuestion: async () => { fallbackCalls++; return 'plain answer'; }, closeFallback: () => fallbackClosed++ });
    const start = (q) => (q === undefined ? terminal.prompt() : terminal.question(q)).then((text) => ({ text }), (error) => ({ error: error.message }));
    return { input, output, proc, terminal, start, send: (s) => input.emit('data', s), counts: () => ({ fallbackCalls, fallbackClosed }) };
  };

  await asyncSuite('native input expert', 'terminal raw input stays stable across adjacent prompts', async () => {
    const r = rig({ keepRawBetweenPrompts: true });
    let p = r.start(); r.send('/help\r'); await p;
    check('held mode stays raw between prompts and releases the prompt listeners', r.input.isRaw && r.input.listenerCount('data') === 0 && r.input.paused, detail());
    p = r.start(); r.send('/exit\r'); const answer = await p;
    check('the next command submits without another raw mode transition', answer.text === '/exit' && r.input.changes.join(',') === 'true', detail());
    r.terminal.close();
    check('closing restores original raw mode and releases the native read handle', !r.input.isRaw && r.input.paused && r.input.listenerCount('data') === 0 && r.input.changes.join(',') === 'true,false', detail());
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-raw-mutation-'));
    try {
      const source = fs.readFileSync(path.join(ROOT, 'lib/terminal-ui.mjs'), 'utf8');
      const mutated = source.replace('if (!keepRawBetweenPrompts) input.setRawMode(active.wasRaw);', 'input.setRawMode(active.wasRaw);');
      const file = path.join(temp, 'terminal-ui.mjs'); fs.writeFileSync(file, mutated);
      fs.copyFileSync(path.join(ROOT, 'lib/terminal-brand.mjs'), path.join(temp, 'terminal-brand.mjs'));
      for (const dependency of ['terminal-appearance.mjs', 'usage-display.mjs']) fs.copyFileSync(path.join(ROOT, 'lib', dependency), path.join(temp, dependency));
      const impl = await import(pathToFileURL(file).href), broken = rig({ impl, keepRawBetweenPrompts: true });
      const pending = broken.start(); broken.send('/help\r'); await pending;
      check('a planted per-prompt mode reset fails the held-mode contract', mutated !== source && !broken.input.isRaw, detail());
      broken.terminal.close();
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }

  });

  await asyncSuite('draft expert', 'terminal draft stash preserves text and cannot fill permission answers', async () => {
    let r = rig(), p = r.start();
    r.send('first\x01\x1b[C\x13'); r.send('\x13X\r');
    check('restoring keeps the exact draft and cursor', (await p).text === 'fXirst', detail()); r.terminal.close();
    const saved = []; r = rig({ history: { save: lines => saved.push(lines) } }); p = r.start();
    r.send('alpha\x13');
    check('stashing does not submit or save the unsent draft to input history', saved.length === 0 && r.input.listenerCount('data') === 1, detail());
    r.send('beta\x13\r'); const first = await p; p = r.start(); r.send('\x13\r'); const second = await p;
    check('two drafts swap and both remain reachable across prompt boundaries', first.text === 'alpha' && second.text === 'beta', detail()); r.terminal.close();
    const approval = async impl => {
      const editor = rig({ impl }); let pending = editor.start(); editor.send('original\x13\r'); await pending;
      pending = editor.start('Allow this action? [y/N]'); editor.send('n\x13\r'); const answer = await pending;
      pending = editor.start(); editor.send('\x13\r'); const restored = await pending; editor.terminal.close();
      return answer.text === 'n' && restored.text === 'original';
    };
    check('permission answers never swap with user drafts', await approval(ui), detail());
    r = rig(); const controller = new AbortController(); r.terminal.turnStart(controller);
    r.send('later\x13urgent\r\x13');
    const handoff = r.terminal.turnEnd();
    check('coalesced stash keys and Enter preserve a busy draft and its queued message', handoff.draft === 'later' && handoff.queued.join(',') === 'urgent' && !controller.signal.aborted, detail(JSON.stringify(handoff))); r.terminal.close();
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-stash-plant-'));
    try {
      const source = fs.readFileSync(path.join(ROOT, 'lib/terminal-ui.mjs'), 'utf8');
      const mutant = source.replace('if (!a.main && !a.busy) return;', 'if (false) return;');
      const file = path.join(folder, 'terminal-ui.mjs'); fs.writeFileSync(file, mutant);
      for (const dependency of ['terminal-brand.mjs','terminal-appearance.mjs','usage-display.mjs']) fs.copyFileSync(path.join(ROOT,'lib',dependency),path.join(folder,dependency));
      check('a planted missing permission boundary fails the identical scenario', source !== mutant && !await approval(await import(pathToFileURL(file).href)), detail());
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
  });

  suite('appearance expert', 'terminal appearance is optional and respects plain text', () => {
    const custom = rig({ appearance: { accentColor: '#fbbf24', compactWelcome: true, showHints: false }, env: { COLORTERM: 'truecolor' } });
    custom.terminal.welcome('fixture', 'C:/project');
    check('a custom accent reaches truecolor output and compact welcome omits the block header', custom.output.text.includes('38;2;251;191;36m') && custom.output.text.includes('ATLIAS fixture') && !custom.output.text.includes('▄██▄') && !custom.output.text.includes('/help commands'), detail());
    custom.terminal.close();
    const mono = rig({ appearance: { accentColor: 'none' }, env: { COLORTERM: 'truecolor' } }); mono.terminal.welcome('fixture','C:/project');
    check('the plain-text accent preserves content without color escape sequences', mono.output.text.includes('C:/project') && !/\x1b\[[0-9;]*m/.test(mono.output.text), detail()); mono.terminal.close();
    const disabled = rig({ appearance: { accentColor: '#fbbf24' }, env: { NO_COLOR: '1', COLORTERM: 'truecolor' } }); disabled.terminal.welcome('fixture','C:/project');
    check('NO_COLOR takes precedence over a custom color', !/\x1b\[[0-9;]*m/.test(disabled.output.text), detail()); disabled.terminal.close();
  });

  suite('terminal palette expert', 'terminal composer matching, width and exact unknown usage', () => {
    check('Atlo occupies six rows of twelve terminal cells', brand.atloRows().length === 6 && brand.atloRows().every(row => ui.textWidth(row) === 12), detail());
    check('the terminal composer defaults on and describes the explicit opt-out', core.DEFAULTS.ui.terminalEnabled === true && fs.readFileSync(path.join(ROOT, 'lib/settings.mjs'), 'utf8').includes('On by default; set false to opt out.'), detail());
    check('slash lists visible commands once and hidden commands stay hidden', ui.commandMatches('/', rows).length === 4 && !ui.commandMatches('/', rows).some((x) => x.name === 'hidden'), detail());
    check('prefix ranks above fuzzy and exact ranks first', ui.commandMatches('/h', rows)[0].name === 'help' && ui.commandMatches('/hosts', rows)[0].rank === 0, detail());
    check('case and subsequences match custom commands', ui.commandMatches('/PJC', rows)[0].name === 'project:check', detail());
    check('literal slash and arguments do not open a palette', ui.commandMatches('//literal', rows).length === 0 && ui.commandMatches('/help args', rows).length === 0 && ui.commandMatches(' /help', rows).length === 0, detail());
    check('malformed command rows cannot inject a completed command', ui.commandMatches('/', [null, {}, { name: 'a\n/permissions' }, { name: '\u001b[31m' }]).length === 0 && ui.commandMatches('/', null).length === 0, detail());
    check('missing matches are explicit', ui.renderComposer({ text: '/zzzz', commands: rows }).lines.some((x) => x.includes('No matching commands')), detail());
    const approval = 'Allow a reviewer to use chatgpt / gpt-6.1-sol? This uses your other subscription and its billing. [y/N]';
    const questionFrame = ui.renderComposer({ question: approval, text: 'yes', columns: 48, rows: 20 });
    check('approval questions wrap with billing and the default answer visible', questionFrame.lines.map(line => line.replace(/^\| | \|$/g, '').trim()).join(' ').includes('other subscription and its billing. [y/N]') && questionFrame.lines[questionFrame.cursor.row].includes('yes') && questionFrame.lines.every(line => ui.textWidth(line) <= 47), detail(JSON.stringify(questionFrame.lines)));
    const clippedQuestion = ui.renderComposer({ question: approval.repeat(20), columns: 40, rows: 10 });
    check('an oversized question tells the user to resize without overflowing the terminal', clippedQuestion.lines.some(line => line.includes('resize to read full question')) && clippedQuestion.lines.length <= 10 && clippedQuestion.cursor.row < clippedQuestion.lines.length, detail());
    check('the slash menu explains what Enter actually sends', ui.renderComposer({ text: '/h', commands: rows, info: { hint: 'Enter send' }, columns: 80 }).lines.some(line => line.includes('Enter sends typed text')), detail());
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
  check('a frame with tab, CJK and combining text pads to exactly its width (B6)', mixedFrame.startsWith('> a  b界éc') && ui.textWidth(mixedFrame) === 79, detail(JSON.stringify(mixedFrame)));
  // A tab is two cells: 74 letters then a tab fit 76 cells only if counted right, so the tab wraps to a second row (the box is 75 cells inside).
  const wrapped = ui.renderComposer({ text: 'a'.repeat(74) + '\tb', info: {}, columns: 80, rows: 24 }).lines;
  check('a tab counts as two cells when a line wraps (B6)', wrapped[3].startsWith('    b'), detail(JSON.stringify(wrapped[3])));
  // B7: zero-width space, word joiner and BOM take no cell, so the right border of a draft holding them stays in its column.
  const zeroWidth = ui.renderComposer({ text: 'x​y⁠﻿', info: {}, columns: 80, rows: 24 }).lines;
  check('zero-width space, word joiner and BOM are zero cells wide (B7)', ui.textWidth('a​⁠﻿b') === 2 && ui.textWidth(zeroWidth[2]) === ui.textWidth(zeroWidth[0]), detail(JSON.stringify([ui.textWidth('a​b'), ui.textWidth(zeroWidth[2]), ui.textWidth(zeroWidth[0])])));
  // B11: a 12-line draft shows the lines around the caret, with a marker row for the lines out of view.
  const twelve = Array.from({ length: 12 }, (_, i) => 'l' + (i + 1)).join('\n');
  const atEnd = ui.renderComposer({ text: twelve, info: {}, columns: 80, rows: 24 });
  check('a draft taller than the box marks the lines above and keeps the caret row visible (B11)', atEnd.lines[2].trim() === '... 8 more lines above' && atEnd.lines[6].trim() === 'l12' && atEnd.cursor.row === 6, detail(JSON.stringify([atEnd.lines[2], atEnd.lines[6], atEnd.cursor])));
  const atStart = ui.renderComposer({ text: twelve, cursor: 0, info: {}, columns: 80, rows: 24 });
  check('the lines below are marked at the foot of the box (B11)', atStart.lines[6].includes('... 8 more lines below') && atStart.lines[2].includes('l1') && atStart.dim.length === 1, detail(JSON.stringify([atStart.lines[2], atStart.lines[6]])));
  // TUI-B 4: replies are styled only with colour on; code is verbatim; lists hang inside the width; model control codes never reach the screen.
  const md = mdRender;
  check('a plain terminal gets the reply text back unchanged (TUI-B 4)', md.renderMarkdown('**a** `b`\n## c', { color: false }) === '**a** `b`\n## c', detail());
  const styled = md.renderMarkdown('## Plan\n- **one** and `two` and a long line of words to wrap here\n```js\n**literal** `x`\n```\n1. third', { color: true, width: 24 });
  check('bold, code spans, headings and lists are styled (TUI-B 4)', styled.includes(`\u001b[1mPlan\u001b[0m`) && styled.includes(`\u001b[1mone\u001b[0m`) && styled.includes(`\u001b[94mtwo\u001b[0m`) && !styled.includes('##') && styled.includes('1. third'), detail(JSON.stringify(styled)));
  check('fenced code is kept verbatim, with no styling inside (TUI-B 4)', styled.includes('\u001b[2m| \u001b[0m**literal** `x`') || styled.includes('| **literal** `x`'), detail(JSON.stringify(styled)));
  const hanging = styled.split('\n').filter((l) => l.startsWith('  ') || l.startsWith('- '));
  check('a list item wraps with a hanging indent and every line fits the width (TUI-B 4)', hanging.length >= 3 && hanging.slice(1).every((l) => l.startsWith('  ')) && styled.split('\n').every((l) => ui.textWidth(l) <= 24), detail(JSON.stringify(hanging)));
  check('the composer prints a styled reply with its styling kept (TUI-B 4)', (() => { const shown = rig({ env: {} }); shown.terminal.log(md.renderMarkdown('**x**', { color: true }), 'md'); const kept = shown.output.text.includes('\u001b[1mx\u001b[0m'); shown.terminal.close(); return kept; })(), detail());
  check('terminal control sequences in a reply are removed before styling (TUI-B 4)', !md.renderMarkdown('a\u001b[2Jb', { color: true }).includes('\u001b[2J') && md.renderMarkdown('x\u001b[2Jy', { color: true }).includes('xy'), detail());
  // B5: the footer keeps whole segments; a segment that does not fit is dropped, never cut mid-number.
  const footerInfo = { engine: 'echo (dry run)', permission: 'workspace', tokens: ['Claude plan', 'session', 'ctx 1,234', 'in 5,678'] };
  const footerAt = (columns) => ui.renderComposer({ text: 'x', info: footerInfo, columns, rows: 24 }).lines.at(-1);
  check('a wide footer shows every segment (B5)', footerAt(120) === 'echo (dry run)  |  workspace  |  Claude plan  |  session  |  ctx 1,234  |  in 5,678', detail(JSON.stringify(footerAt(120))));
  check('a narrow footer drops whole trailing segments, not the middle of a number (B5)', footerAt(40) === 'echo (dry run)  |  workspace' && footerAt(50) === 'echo (dry run)  |  workspace  |  Claude plan' && footerAt(60) === 'echo (dry run)  |  workspace  |  Claude plan  |  session', detail(JSON.stringify([footerAt(40), footerAt(50), footerAt(60)])));
  check('the token counts follow ui.usageEnabled, which defaults off (B5)', core.DEFAULTS.ui.usageEnabled === false && /config\(\)\.ui\.usageEnabled === true/.test(fs.readFileSync(path.join(ROOT, 'lib/agent.mjs'), 'utf8')), detail());
  // Gev's reference: Atlo stays next to the unchanged pixel wordmark at normal terminal sizes.
  for (const rowCount of [24, 40]) {
    const start = rig(); start.output.rows = rowCount; start.terminal.welcome('4.0.0', 'C:/project');
    const text = start.output.text, above = text.trimEnd().split('\r\n');
    check(`a ${rowCount}-row start screen pairs Atlo with the original wordmark`, text.includes('▄██▄') && text.includes(' ███  █████ █      ███   ███   ████') && above.length <= 9 && text.includes('/help'), detail(JSON.stringify(above)));
    start.terminal.close();
  }
  check('the renderer never starts a shell, model, network or alternate screen',!/child_process|fetch\(|model\.complete|1049h/.test(source), detail());
  });

  await asyncSuite('terminal input expert', 'terminal composer keys, paste, prompts and cleanup', async () => {
    // A prompt that should have closed but did not fails its check instead of hanging the run.
    const settle = (promise, ms = 1000) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve({ error: `still open after ${ms} ms` }), ms))]);
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
      fs.copyFileSync(path.join(ROOT, 'lib/terminal-brand.mjs'), path.join(temp, 'terminal-brand.mjs'));
      for (const dependency of ['terminal-appearance.mjs', 'usage-display.mjs']) fs.copyFileSync(path.join(ROOT, 'lib', dependency), path.join(temp, dependency));
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
    // h4 F1: a multi-line chunk that ends in a typed Enter submits its text without the CR.
    for (const [chunk, typed] of [['ab\r', 'ab'], ['cd\r\n', 'cd'], ['one\r\ntwo\r', 'one\r\ntwo'], ['three\r\ntwo\r\n', 'three\r\ntwo']]) {
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
    // TUI-A item 11: the history loaded at start is walked with Up, and every sent line is handed to the save.
    const saved = []; r = rig({ history: { initial: ['first', 'second'], save: (list) => saved.push(list) } });
    p = r.start(); r.send('\u001b[A'); r.send('\r'); answer = await p;
    check('Up recalls the last line of the history loaded at start (TUI-A item 11)', answer.text === 'second', detail(JSON.stringify(answer)));
    check('each sent line is handed to the save with the history so far', JSON.stringify(saved[0]) === JSON.stringify(['first', 'second', 'second']), detail(JSON.stringify(saved)));
    // The sent line is now the newest entry, so the walk reaches the loaded 'first' on the third Up.
    p = r.start(); r.send('\u001b[A'); r.send('\u001b[A'); r.send('\u001b[A'); r.send('\r'); answer = await p;
    check('Up walks back to the earlier loaded line', answer.text === 'first', detail(JSON.stringify(answer)));
    // TUI-A item 12: Ctrl+R searches the history newest first and shows the match in the box; Enter takes it, Esc cancels.
    r = rig({ history: { initial: ['alpha one', 'beta two', 'alpha three'] } });
    p = r.start(); r.send('\u0012'); r.send('alpha');
    check('Ctrl+R shows the newest match in the box as "(search) query: match" (TUI-A item 12)', r.output.text.includes('(search) alpha: alpha three'), detail());
    r.send('\r'); r.send('\r'); answer = await p;
    check('Enter takes the match into the draft, and the next Enter sends it', answer.text === 'alpha three', detail(JSON.stringify(answer)));
    r = rig({ history: { initial: ['alpha one', 'beta two', 'alpha three'] } });
    p = r.start(); r.send('\u0012'); r.send('alpha'); r.send('\u0012'); r.send('\r'); r.send('\r'); answer = await p;
    check('a second Ctrl+R steps to the next older match', answer.text === 'alpha one', detail(JSON.stringify(answer)));
    r = rig({ history: { initial: ['alpha one'] } });
    // h4 F6: a line break pasted during the search becomes a space in the query, never a second line.
    r = rig({ history: { initial: ['alpha one'] } }); p = r.start(); r.send('\u0012'); r.send('a\nb');
    check('a pasted line break during Ctrl+R becomes a space in the query (h4 F6)', r.output.text.includes('(search) a b: '), detail(JSON.stringify(r.output.text.slice(-80))));
    r.send('\u001b'); await new Promise((resolve) => setTimeout(resolve, 100)); r.send('\r'); await settle(p); r.terminal.close();
    r = rig({ history: { initial: ['alpha one'] } }); p = r.start(); r.send('draft'); r.send('\u0012'); r.send('zz');
    check('history search explicitly says when the query has no matches', r.output.text.includes('(search) zz: No matches'), detail());
    r.send('\u001b'); await new Promise((resolve) => setTimeout(resolve, 100)); r.send('\r'); answer = await p;
    check('Esc cancels the search and keeps the draft (TUI-A item 12)', answer.text === 'draft', detail(JSON.stringify(answer)));
    const searchSaves = []; r = rig({ history: { initial: [], save: list => searchSaves.push(list) } }); p = r.start();
    r.send('original'); r.send('\u0012');
    check('an empty history shows the same explicit no-match state', r.output.text.includes('(search) : No matches'), detail());
    r.send('not in history'); r.send('\r'); r.send(' draft'); r.send('\r'); answer = await p;
    check('Enter on no match returns to editing the original draft before sending', answer.text === 'original draft', detail(JSON.stringify(answer)));
    check('search queries and display labels never enter saved input history', JSON.stringify(searchSaves) === JSON.stringify([['original draft']]), detail(JSON.stringify(searchSaves)));
    r.terminal.close();
    r = rig(); p = r.start(); r.send('draft'); r.send('\u001b[A'); r.send('\u001b[B'); r.send('\r'); answer = await p;
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

    r = rig(); const foreign = () => {}; r.input.on('data', foreign); p = r.start(); r.send('\x04'); r.send('\x04'); answer = await settle(p);
    check('EOF rejects the prompt and preserves foreign listeners', /end of input/.test(answer.error) && !r.input.isRaw && r.input.listeners('data').includes(foreign), detail(JSON.stringify(answer))); r.terminal.close();
    r = rig(); p = r.start(); r.send('edit'); r.send('\x03'); r.send('new'); r.send('\r'); answer = await p;
    check('Ctrl+C clears a draft before exiting', answer.text === 'new', detail());
    // TUI-A item 10: on an empty main prompt the first Ctrl+C only shows the hint; a second one inside two seconds exits.
    r = rig(); p = r.start(); let exited = false; p.then(() => { exited = true; }); r.send('\x03'); await new Promise(setImmediate);
    check('the first Ctrl+C on an empty prompt does not exit and says how to (TUI-A item 10)', !exited && r.output.text.includes('Press Ctrl+C again to exit') && r.input.isRaw, detail(String(exited)));
    r.send('\x03'); answer = await settle(p);
    check('a second Ctrl+C inside two seconds exits cleanly', /cancelled/.test(answer.error) && !r.input.isRaw && r.input.listenerCount('data') === 0, detail(JSON.stringify(answer))); r.terminal.close();
    r = rig(); p = r.start(); exited = false; p.then(() => { exited = true; }); r.send('\x03'); await new Promise((resolve) => setTimeout(resolve, 2100));
    r.send('\x03'); await new Promise(setImmediate);
    check('after two seconds the first press is forgotten: the next press only shows the hint again (TUI-A item 10)', !exited && r.input.isRaw, detail(String(exited)));
    r.send('\x03'); answer = await settle(p); r.terminal.close();
    r = rig(); p = r.start('Allow this action? '); r.send('\x03'); answer = await settle(p);
    check('Ctrl+C at a permission question cancels it at once, with no hint', /cancelled/.test(answer.error) && !r.output.text.slice(r.output.text.lastIndexOf('Allow')).includes('Press Ctrl+C'), detail(JSON.stringify(answer))); r.terminal.close();
    r = rig({ rawFails: true }); answer = await r.start(); const next = await r.start();
    check('a failed raw mode uses one persistent line fallback', answer.text === 'plain answer' && next.text === 'plain answer' && r.counts().fallbackCalls === 2 && r.input.listenerCount('data') === 0, detail()); r.terminal.close();
    check('closing also closes the fallback reader', r.counts().fallbackClosed === 1, detail());
    r = rig({ env: { NO_COLOR: '1' } }); r.terminal.welcome('4.0.0', 'C:/project'); p = r.start(); r.send('x'); r.send('\r'); await p;
    check('NO_COLOR removes SGR but keeps the composer', !/\u001b\[[0-9;]*m/.test(r.output.text) && r.output.text.includes('/help') && r.output.text.includes('Ask about this project'), detail()); r.terminal.close();
    r = rig(); p = r.start(); r.output.emit('error', new Error('closed output')); answer = await p;
    check('output failure also restores raw mode and rejects the question', answer.error === 'closed output' && !r.input.isRaw && r.input.listenerCount('data') === 0, detail()); r.terminal.close();
    r = rig(); r.terminal.close(); answer = await r.start();
    check('a closed editor cannot create another question', answer.error === 'terminal closed', detail());
  });

  // TUI-B 1: Esc or Ctrl+C stops a turn; a permission question during the turn gets the composer back afterwards.
  await asyncSuite('terminal turn expert', 'terminal composer during a turn: Esc and Ctrl+C stop it, questions still ask (TUI-B)', async () => {
    const settle = (promise, ms = 1000) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve({ error: `still open after ${ms} ms` }), ms))]);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let r = rig(); const first = new AbortController();
    check('a turn opens the composer, raw and listening', r.terminal.turnStart(first) === true && r.input.isRaw && r.input.listenerCount('data') === 1, detail());
    r.send('\u001b'); await wait(100);
    check('Esc aborts the turn signal', first.signal.aborted, detail());
    r.send('\x03'); const leftAt = r.terminal.turnEnd();
    check('a second Ctrl+C within two seconds of the interrupt asks to leave', leftAt.exit === true && !r.input.isRaw && r.input.listenerCount('data') === 0, detail(JSON.stringify(leftAt)));
    // TUI-B 2: the footer shows the spinner, the seconds and the stop key, repainted at most ten times a second.
    r = rig(); const ticking = new AbortController(); r.terminal.turnStart(ticking);
    const before = (r.output.text.split('Esc stops').length - 1); await wait(1000);
    const paints = (r.output.text.split('Esc stops').length - 1) - before;
    check('a running turn names the activity and repaints 5 to 12 times a second (TUI-B 2)', before >= 1 && paints >= 5 && paints <= 12 && /[|/\\-] Working \d+s  Esc stops/.test(r.output.text), detail(JSON.stringify({ before, paints })));
    r.terminal.turnEnd();
    // h4 F-h1-C: once the turn ends the spinner stops repainting.
    const stopsAt = r.output.text.length; await new Promise((resolve) => setTimeout(resolve, 300));
    check('the spinner stops repainting when the turn ends (h4 F-h1-C)', !r.output.text.slice(stopsAt).includes('Esc stops'), detail());
    // TUI-B 3: Enter during a turn queues the message (dim "queued: ...") and the turn hands it back; typed text becomes the next draft.
    r = rig(); const queuing = new AbortController(); r.terminal.turnStart(queuing);
    r.send('next one'); r.send('\r'); r.send('half');
    check('Enter during a turn queues the message and shows it as "queued: ..." (TUI-B 3)', r.output.text.includes('queued: next one') && r.output.text.includes('\u001b[2m') === false, detail());
    const ended = r.terminal.turnEnd();
    check('the turn hands back the queued message, and the unsent text as the draft (TUI-B 3)', JSON.stringify(ended.queued) === JSON.stringify(['next one']) && ended.draft === 'half' && !ended.exit, detail(JSON.stringify(ended)));
    const carried = r.terminal.prompt(ended.draft); r.send('\r');
    check('the next prompt starts with that draft (TUI-B 3)', (await settle(carried)) === 'half', detail());
    r = rig({ env: {} }); r.terminal.turnStart(new AbortController()); r.send('kept'); r.send('\r');
    check('queued text is shown dim when colour is on (TUI-B 3)', r.output.text.includes('\u001b[2mqueued: kept\u001b[0m'), detail(JSON.stringify(r.output.text.slice(-120))));
    r.terminal.turnEnd();
    r = rig(); const second = new AbortController(); r.terminal.turnStart(second); r.send('\x03');
    check('the first Ctrl+C stops the turn and Atlias stays open', second.signal.aborted && r.terminal.turnEnd().exit === false, detail());
    r = rig(); const third = new AbortController(); r.terminal.turnStart(third);
    const asked = r.terminal.question('Allow this action? '); r.send('y\r');
    check('a permission question during a turn is answered', (await settle(asked)) === 'y', detail());
    check('the turn gets its composer back after the question', r.input.isRaw && r.input.listenerCount('data') === 1 && !third.signal.aborted, detail());
    r.terminal.turnEnd();
    // The stop reaches a chat call that waits on its signal, and a POST waiting for its reply.
    const agent = await import('../lib/agent.mjs');
    const hang = new AbortController(); const cut = agent.withSignal(() => new Promise(() => {}), hang.signal);
    setTimeout(() => hang.abort(), 30);
    const cutReply = await settle(cut([], null, {}));
    check('a chat call waiting on the turn signal is cut and reports interrupted (TUI-B 1)', cutReply.error === 'interrupted', detail(JSON.stringify(cutReply)));
    const http = await import('node:http');
    const { postJsonAbortable } = await import('../lib/http-abort.mjs');
    const { postJson } = await import('../lib/loop.mjs');
    const bodies = []; const server = http.createServer((req, res) => { let text = ''; req.on('data', (x) => { text += x; }); req.on('end', () => { bodies.push(text); if (req.url === '/hang') return; res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const stop = new AbortController(); setTimeout(() => stop.abort(), 50);
    const hung = await settle(postJsonAbortable(`${base}/hang`, { a: 1 }, {}, 10000, undefined, stop.signal), 2000);
    check('a POST waiting for its reply is cut by the signal (TUI-B 1)', hung.error === 'interrupted' && hung.status === 0, detail(JSON.stringify(hung)));
    const body = { model: 'm', messages: [{ role: 'user', content: 'é"\\\n' }] };
    const plain = await postJson(`${base}/ok`, body, {}); const withSig = await postJsonAbortable(`${base}/ok`, body, {}, undefined, undefined, new AbortController().signal);
    check('a signal does not change the request bytes, and the reply is the same (TUI-B 1)', bodies.at(-2) === bodies.at(-1) && plain.json?.ok === true && withSig.json?.ok === true, detail(JSON.stringify(bodies)));
    server.closeAllConnections(); server.close();
  });

  await asyncSuite('terminal integration expert', 'terminal composer integration stays outside model requests', async () => {
    check('terminal install is discoverable in the real command registry', commands.BUILTINS.some((x) => x.name === 'shortcut') && commands.helpText(ROOT).includes('/shortcut'), detail());
    const lines = []; const state = { cwd: ROOT };
    await commands.dispatch('/shortcut status', { state, cwd: ROOT, out: (x) => lines.push(x) });
    check('terminal status is a direct command without a model turn', lines.some((x) => x.startsWith('terminal command:')), detail(JSON.stringify(lines)));
    const src = fs.readFileSync(path.join(ROOT, 'lib/agent.mjs'), 'utf8');
    check('the interactive module is dynamically loaded only in replIn', src.indexOf("import('./terminal-ui.mjs')") > src.indexOf('async function replIn'), detail());
    // TUI-A item 11: the history file is one per project folder, keeps the last 200 lines, and a damaged file reads as empty.
    const ih = await import('../lib/input-history.mjs');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-input-history-'));
    try {
      const fileA = ih.fileFor(stateDir, ROOT), fileB = ih.fileFor(stateDir, path.join(ROOT, 'other'));
      ih.write(fileA, Array.from({ length: 250 }, (_, i) => `line ${i}`));
      const back = ih.read(fileA);
      check('input history keeps the last 200 lines per project (TUI-A item 11)', back.length === 200 && back[0] === 'line 50' && back.at(-1) === 'line 249', detail(JSON.stringify([back.length, back[0], back.at(-1)])));
      check('each project folder has its own history file (TUI-A item 11)', fileA !== fileB && ih.read(fileB).length === 0 && path.dirname(fileA) === path.join(stateDir, 'input-history'), detail(fileA));
      fs.writeFileSync(fileB, '{ not json');
      check('a damaged history file reads as empty instead of stopping Atlias (TUI-A item 11)', ih.read(fileB).length === 0 && ih.read(path.join(stateDir, 'missing.json')).length === 0, detail());
    } finally { fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    for (const file of ['lib/loop.mjs', 'lib/eval.mjs', 'tools/h2h/atlias_task.mjs']) check(`${file} has no terminal composer import`, !fs.readFileSync(path.join(ROOT, file), 'utf8').includes('terminal-ui'), detail());
  });

  await asyncSuite('terminal input expert', 'esc esc on an empty prompt sends /rewind, as if typed; one Esc, or Esc after text, does not', async () => {
    const pause = (ms) => new Promise((res) => setTimeout(res, ms));
    let r = rig();
    let answer;
    const p = r.start().then((x) => { answer = x; });
    r.send(''); await pause(150);
    check('one Esc on an empty prompt leaves the prompt open', answer === undefined, detail());
    r.send(''); await pause(150);
    await Promise.race([p, pause(800)]);
    check('two Esc on an empty prompt send /rewind, as if typed', answer && answer.text === '/rewind', detail(JSON.stringify(answer)));
    let r2 = rig();
    let answer2;
    const p2 = r2.start().then((x) => { answer2 = x; });
    r2.send('abc'); r2.send(''); await pause(150); r2.send(''); await pause(150);
    check('Esc Esc after text does not send /rewind and keeps the text', answer2 === undefined, detail());
    r2.send('\r'); await Promise.race([p2, pause(800)]);
    check('the text survives and Enter returns it', answer2 && answer2.text === 'abc', detail(JSON.stringify(answer2)));
  });
}
