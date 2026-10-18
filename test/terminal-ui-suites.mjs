import { EventEmitter } from 'node:events';
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
    const terminal = ui.createTerminalUI({ input, output, proc, env: opts.env || { NO_COLOR: '1' }, getCommands: () => rows,
      getInfo: () => ({ engine: 'echo', permission: 'workspace', tokens: 'tokens not recorded' }),
      fallbackQuestion: async () => { fallbackCalls++; return 'plain answer'; }, closeFallback: () => fallbackClosed++ });
    const start = (q) => (q === undefined ? terminal.prompt() : terminal.question(q)).then((text) => ({ text }), (error) => ({ error: error.message }));
    return { input, output, proc, terminal, start, send: (s) => input.emit('data', s), counts: () => ({ fallbackCalls, fallbackClosed }) };
  };

  suite('terminal palette expert', 'terminal composer matching, width and exact unknown usage', () => {
    check('the new UI defaults off and is described', core.DEFAULTS.ui.terminalEnabled === false && fs.readFileSync(path.join(ROOT, 'lib/settings.mjs'), 'utf8').includes("'ui.terminalEnabled'"), detail());
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
    check('the renderer never starts a shell, model, network or alternate screen', !/child_process|fetch\(|model\.complete|1049h/.test(source), detail());
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
    p = r.start('Allow this action? '); r.send('/h');
    check('permission and other questions have no command palette', !r.output.text.slice(r.output.text.lastIndexOf('Allow')).includes('/help'), detail());
    r.send('\r'); answer = await p; check('question answers are ordinary text for the existing handler', answer.text === '/h', detail());
    p = r.start(); r.send('\u001b[20'); r.send('0~first\r\nsecond'); r.send('\u001b[20'); r.send('1~');
    let settled = false; p.then(() => { settled = true; }); await Promise.resolve();
    check('split bracketed multiline paste never submits itself', !settled && r.input.isRaw && r.input.listenerCount('data') === 1, detail());
    r.send('\r'); answer = await p; check('paste preserves exact CRLF text on send', answer.text === 'first\r\nsecond', detail(JSON.stringify(answer)));
    p = r.start(); r.send('one\r\ntwo'); await Promise.resolve(); r.send('\r'); answer = await p;
    check('unbracketed multiline paste also remains one draft', answer.text === 'one\r\ntwo', detail(JSON.stringify(answer)));
    p = r.start(); r.send('a'); r.send('\n'); r.send('b'); r.send('\r'); answer = await p;
    check('Ctrl+J inserts a newline', answer.text === 'a\nb', detail(JSON.stringify(answer)));
    p = r.start(); r.send('a\\'); r.send('\r'); r.send('b'); r.send('\r'); answer = await p;
    check('backslash Enter inserts a newline', answer.text === 'a\nb', detail(JSON.stringify(answer)));
    p = r.start(); r.send('e\u0301界'); r.send('\u001b[D'); r.send('\x7f'); r.send('\r'); answer = await p;
    check('backspace deletes a whole combining grapheme', answer.text === '界', detail(JSON.stringify(answer)));
    p = r.start(); const bytes = Buffer.from('界'); r.send(bytes.subarray(0, 1)); r.send(bytes.subarray(1)); r.send('\r'); answer = await p;
    check('split UTF8 input is decoded without replacement characters', answer.text === '界', detail(JSON.stringify(answer)));
    p = r.start(); r.send('draft'); r.send('\u001b[A'); r.send('\u001b[B'); r.send('\r'); answer = await p;
    check('history down restores the current draft', answer.text === 'draft', detail(JSON.stringify(answer)));
    p = r.start(); r.send('/h'); r.output.columns = 32; r.output.rows = 10; r.output.emit('resize'); r.send('\t'); r.send('\r'); answer = await p;
    check('resize retains the draft and palette selection', answer.text === '/help ', detail(JSON.stringify(answer)));
    r.terminal.close(); check('closing removes its own process hook', r.proc.listenerCount('exit') === 0, detail());

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
