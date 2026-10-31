import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import * as ui from '../lib/terminal-ui.mjs';
import * as settings from '../lib/settings.mjs';
import * as commands from '../lib/commands.mjs';
import { plainText } from '../lib/render-markdown.mjs';

export default async function ({ suite, asyncSuite, check, core, fs, path, ROOT, TMP }) {
  const detail = happened => ({ happened: String(happened || ''), why: 'Questions must be readable and unsent text must remain recoverable.', fix: 'Check terminal input boundaries and draft handoff.' });
  const rig = (impl = ui, cols = 80, rows = 24) => {
    const input = new EventEmitter(), output = new EventEmitter(), proc = new EventEmitter(), saved = [];
    Object.assign(input, { isTTY: true, isRaw: false, setRawMode(v) { this.isRaw = v; }, isPaused: () => false, pause() {}, resume() {} });
    Object.assign(output, { isTTY: true, columns: cols, rows, text: '', write(s) { this.text += s; } });
    const terminal = impl.createTerminalUI({ input, output, proc, env: { NO_COLOR: '1' }, history: { initial: ['older task'], save: h => saved.push(h) }, getCommands: () => [{ name: 'help' }, { name: 'history' }] });
    return { terminal, input, output, saved, send: s => input.emit('data', s) };
  };
  const scenario = async impl => {
    const r = rig(impl, 6, 3); let settled = false;
    const p = r.terminal.question('Allow another subscription? This uses that account. [y/N]').then(text => { settled = true; return text; });
    r.send('y\r'); await Promise.resolve(); const blocked = !settled;
    r.output.columns = 100; r.output.rows = 24; r.output.emit('resize'); r.send('\r');
    const answer = await p; r.terminal.close(); return blocked && answer === 'y';
  };
  await asyncSuite('terminal safety expert', 'terminal usability: hidden questions never submit', async () => {
    check('tiny question refuses Enter until the whole question is visible', await scenario(ui), detail());
    const r = rig(ui, 30, 7); let decided = false;
    const pending = r.terminal.question('A long policy question '.repeat(20)).then(() => { decided = true; }, () => {});
    r.send('y\r'); await Promise.resolve();
    check('a clipped multirow question also refuses a decision', !decided && r.output.text.includes('Resize the terminal'), detail());
    r.send('\x03\x03'); await pending;
    check('cancellation of an unreadable question releases listeners without a decision', !decided && r.input.listenerCount('data') === 0, detail()); r.terminal.close();
    const escape = rig(ui, 6, 3); let escaped = false;
    const escapePending = escape.terminal.question('Permission? [y/N]').then(() => { escaped = true; }, () => {});
    escape.send('\x1b'); await new Promise(r => setTimeout(r, 85)); escape.send('\x1b'); await new Promise(r => setTimeout(r, 85));
    check('double Escape cannot submit a command as a question answer', !escaped, detail()); escape.send('\x03'); await escapePending; escape.terminal.close();
    const folder = path.join(TMP, 'hidden-question-plant'); fs.mkdirSync(folder);
    const source = fs.readFileSync(path.join(ROOT, 'lib/terminal-ui.mjs'), 'utf8');
    const changed = source.replace("if (name === 'enter' && a.question && !renderComposer", "if (false && name === 'enter' && a.question && !renderComposer");
    fs.writeFileSync(path.join(folder, 'terminal-ui.mjs'), changed);
    for (const dep of ['terminal-brand.mjs', 'terminal-appearance.mjs', 'usage-display.mjs']) fs.copyFileSync(path.join(ROOT, 'lib', dep), path.join(folder, dep));
    check('the same scenario catches a planted missing question guard', source !== changed && !await scenario(await import(pathToFileURL(path.join(folder, 'terminal-ui.mjs')).href)), detail());
  });
  await asyncSuite('terminal recovery expert', 'terminal usability: queue draft and current key state', async () => {
    const r = rig(); r.terminal.turnStart(new AbortController());
    r.send('queued A\r'); r.send('queued B\r'); r.send('unsent C'); let h = r.terminal.turnEnd();
    check('only submitted queued messages enter input history', h.queued.join('|') === 'queued A|queued B' && h.draft === 'unsent C' && r.saved.at(-1).join('|') === 'older task|queued A|queued B', detail());
    r.terminal.turnStart(new AbortController(), h.draft); h = r.terminal.turnEnd();
    check('an untouched queued turn carries the original draft forward', h.draft === 'unsent C' && h.queued.length === 0, detail());
    r.terminal.turnStart(new AbortController(), h.draft); r.send(' edited'); h = r.terminal.turnEnd();
    check('typing during the next queued turn edits the retained draft', h.draft === 'unsent C edited', detail());
    let p = r.terminal.prompt(); r.send('/he'); r.send('\x15plain\x1b[A\r');
    check('coalesced clear, typing and Up uses current matches and recalls history', await p === 'queued B', detail());
    p = r.terminal.question('Permission? [y/N]'); r.send('\x12\x1b[An\r');
    check('task history and search cannot fill a question field', await p === 'n' && !r.saved.at(-1).includes('n'), detail());
    r.terminal.close();
    const fallback = rig(); fallback.input.isTTY = false;
    check('keyboard mode follows actual stream capabilities', fallback.terminal.inputMode() === 'line', detail()); fallback.terminal.close();
  });
  await asyncSuite('terminal settings expert', 'terminal usability: inspect before changing a boolean', async () => {
    const cfg = path.join(core.STATE_DIR, 'config.json'), before = fs.existsSync(cfg) ? fs.readFileSync(cfg) : null;
    const answers = ['attachments.enabled', '', 'q'], said = [];
    try {
      settings.reset('attachments.enabled');
      await settings.menu(async () => answers.shift(), s => said.push(s));
      check('selecting and leaving a boolean unchanged shows its explanation and values', core.config().attachments.enabled === true && said.some(s => s.includes('1  true')) && said.includes('unchanged'), detail());
    } finally { if (before) fs.writeFileSync(cfg, before); else fs.rmSync(cfg, { force: true }); }
  });
  suite('terminal orientation expert', 'terminal usability: setup hints and honest keyboard help', () => {
    const frame = ui.renderComposer({ info: { placeholder: 'Connect with /onboarding' }, columns: 80, rows: 24 });
    check('setup hints are visible without becoming input', frame.lines.join('\n').includes('Connect with /onboarding') && frame.cursor.col === 2, detail());
    const line = commands.helpText(TMP, TMP, 'keys', { inputMode: 'line' });
    const composer = commands.helpText(TMP, TMP, 'keys', { inputMode: 'composer' });
    check('help describes only controls implemented by the current input mode', !line.includes('Ctrl+S') && line.includes('--plain') && composer.includes('Ctrl+S') && composer.includes('Ctrl+R'), detail());
    check('plain output removes whole OSC commands with spaces and either terminator', plainText('before\x1b]0;bad title\x07after\x1b]8;;https://example.org\x1b\\link\x1b]8;;\x1b\\') === 'beforeafterlink', detail());
  });
}
