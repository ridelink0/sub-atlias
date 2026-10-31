import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as drafts from '../lib/drafts.mjs';
import * as ui from '../lib/terminal-ui.mjs';
import * as agent from '../lib/agent.mjs';
import * as commands from '../lib/commands.mjs';
import * as authority from '../lib/authority.mjs';

export default async function ({ suite, asyncSuite, check, core, TMP, ROOT, fs, path }) {
  const detail = happened => ({ happened: JSON.stringify(happened), why: 'Follow-ups must survive turn boundaries, and side questions must leave no session or memory writes.', fix: 'Repair the boundary, queue or atomic draft contract.' });
  const rig = (options = {}, implementation = ui) => {
    const input = new EventEmitter(), output = new EventEmitter(), proc = new EventEmitter();
    Object.assign(input, { isTTY: true, isRaw: false, setRawMode(v) { this.isRaw = v; }, isPaused: () => false, pause() {}, resume() {} });
    Object.assign(output, { isTTY: true, columns: 110, rows: 30, text: '', write(s) { this.text += s; } });
    const terminal = implementation.createTerminalUI({ input, output, proc, env: { NO_COLOR: '1' }, getCommands: () => [{ name: 'btw' }], ...options });
    return { terminal, input, output, proc, send: s => input.emit('data', s) };
  };
  const dir = path.join(TMP, 'followups'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'read.txt'), 'fixture observation');
  const frame = s => '```atlias\n' + JSON.stringify(s) + '\n```';
  await asyncSuite('follow-up expert', 'followups: steer model boundaries and embedder results', async () => {
    core.setRunOverride({ flags: { authorityLedger: true }, agent: { testCommand: 'off', maxToolRounds: 4 } });
    try {
      const state = agent.newState(dir, 'openai'), pending = [], requests = [], notices = [];
      const result = await agent.turn(state, 'Read the fixture.', null, () => {}, {
        steer: { take: () => pending.splice(0), onApplied: t => notices.push(t) },
        chat: async messages => {
          requests.push(structuredClone(messages));
          if (requests.length === 1) { pending.push('Use the exact fixture.', 'Preserve its spelling.'); return { content: frame({ tool: 'read_file', path: 'read.txt' }) }; }
          pending.push('Late follow-up.'); return { content: 'The fixture says observation.' };
        },
      });
      const second = requests[1], index = second.findIndex(m => m.content === 'Use the exact fixture.');
      check('all current tool observations precede steering user messages', index > 0 && second[index - 1].content.startsWith('Tool result for read_file:') && second[index - 1].content.includes('fixture observation') && second[index].role === 'user' && second[index + 1].content === 'Preserve its spelling.', detail(second));
      check('result and onApplied report ordered steers and preserve a final-request arrival', result.appliedSteers.join('|') === notices.join('|') && notices.length === 2 && result.unappliedSteers[0] === 'Late follow-up.', detail(result));
      check('history, exact asks and authority ledger preserve applied user authority', state.history[1].text === notices[0] && state.asks.includes(notices[1]) && authority.read(state.sid).filter(r => r.kind === 'request').map(r => r.text).includes(notices[1]), detail(state.history));
      const controller = new AbortController(), stopped = [], stoppedState = agent.newState(dir, 'openai');
      const stop = await agent.turn(stoppedState, 'Read it.', null, () => {}, { signal: controller.signal, steer: { take: () => stopped.splice(0) }, chat: async () => { stopped.push('Keep me.'); controller.abort(); return { content: frame({ tool: 'read_file', path: 'read.txt' }) }; } });
      check('stop retains every unapplied steer without dispatching another request', stop.appliedSteers.length === 0 && stop.unappliedSteers[0] === 'Keep me.' && stoppedState.stop.reason === 'interrupted', detail(stop));
      const plain = await agent.turn(agent.newState(dir, 'echo'), 'normal call', null, null);
      check('existing turn callers still receive a string', plain === 'echo: normal call', detail(plain));
      let rejected = false;
      try { await agent.turn(agent.newState(dir, 'echo'), 'invalid', null, null, { steer: {} }); } catch { rejected = true; }
      check('invalid steer sources fail before a turn starts', rejected, detail(rejected));
      const failPending = ['first consumed', 'second retained']; let recovery;
      try { await agent.turn(agent.newState(dir, 'openai'), 'Read it.', null, null, { steer: { take: () => failPending.splice(0), onApplied: () => { throw Error('fixture callback failure'); } }, chat: async () => ({ content: 'unused' }) }); }
      catch (error) { recovery = error.steers; }
      check('a delivery callback failure retains the rest of a taken steer batch', recovery?.appliedSteers[0] === 'first consumed' && recovery?.unappliedSteers[0] === 'second retained', detail(recovery));
    } finally { core.setRunOverride(null); }
  });
  await asyncSuite('composer follow-up expert', 'followups: queue editing, settings, stop and side blocks', async () => {
    const queue = [], r = rig({ queue });
    const controller = new AbortController(); r.terminal.turnStart(controller);
    r.send('change direction\x11'); r.send('next task\r'); r.send('third task\r');
    check('Enter queues by default and Ctrl+Q steers while hints name both', r.terminal.steer.take()[0] === 'change direction' && queue.join('|') === 'next task|third task' && r.output.text.includes('Enter queue') && r.output.text.includes('Ctrl+Q steer'), detail(queue));
    r.send('/queue edit 1 revised\r'); r.send('/queue remove 2\r');
    check('queued messages can be edited and removed before starting', queue.join('|') === 'revised' && r.output.text.includes('queued 1: revised'), detail(queue));
    r.send('late steer\x11'); r.send('\x03'); const end = r.terminal.turnEnd();
    check('unapplied steers become the first queued messages on stop', controller.signal.aborted && end.queued.join('|') === 'late steer|revised', detail(end)); r.terminal.close();
    const inverse = rig({ appearance: { followUp: 'steer' } }); inverse.terminal.turnStart(new AbortController());
    inverse.send('queued\x11'); inverse.send('steered\r');
    check('steer setting reverses Enter and the alternate key', inverse.terminal.steer.take()[0] === 'steered' && inverse.terminal.turnEnd().queued[0] === 'queued', detail()); inverse.terminal.close();
    const sideCalls = [], side = rig({ onBtw: async q => { sideCalls.push(q); return 'A private side answer.'; } });
    const control = new AbortController(); side.terminal.turnStart(control); side.send('/btw what happened?\r'); await Promise.resolve(); await Promise.resolve();
    check('a busy side question answers in a dismissible block', sideCalls.length === 1 && side.output.text.includes('A private side answer.') && side.output.text.includes('Esc dismiss'), detail(side.output.text.slice(-700)));
    side.send('\x1b'); await new Promise(r => setTimeout(r, 85));
    check('Esc dismisses the answer without stopping the active turn', !control.signal.aborted, detail()); side.terminal.turnEnd(); side.terminal.close();
    const heldCalls = [], held = rig({ concurrentBtw: false, onBtw: async q => { heldCalls.push(q); return 'later answer'; } });
    held.terminal.turnStart(new AbortController()); held.send('/btw held question\r');
    check('an engine without concurrent requests visibly holds the side question', heldCalls.length === 0 && held.output.text.includes('held until this turn ends'), detail());
    held.terminal.turnEnd(); await held.terminal.flushBtw();
    check('held side questions run when the turn ends', heldCalls[0] === 'held question', detail(heldCalls)); held.terminal.close();
    check('follow-up setting accepts only queue or steer and defaults to queue (research E 4.1)', core.DEFAULTS.ui.followUp === 'queue' && core.parseSetting('ui', 'followUp', 'queue').value === 'queue' && Boolean(core.parseSetting('ui', 'followUp', 'other').error), detail());
    const short = ui.renderComposer({ side: 'line one\nline two\nline three', sideOffset: 1, columns: 30, rows: 9 });
    check('a small side-answer viewport can show the next line without losing the prompt', short.lines.some(t => t.includes('line two')) && short.lines.length <= 9 && short.cursor.row < short.lines.length, detail(short));
  });
  await asyncSuite('side question expert', 'followups: btw leaves session bytes and memory unchanged', async () => {
    const state = agent.newState(dir, 'echo'); state.history.push({ role: 'user', text: 'The fixture is blue.' }, { role: 'assistant', text: 'Understood.' });
    agent.saveChat(state);
    const file = agent.chatPath(state.sid), before = fs.readFileSync(file), stateBefore = JSON.stringify(state);
    const tree = folder => fs.existsSync(folder) ? fs.readdirSync(folder, { withFileTypes: true }).flatMap(e => e.isDirectory() ? tree(path.join(folder, e.name)) : [[path.join(folder, e.name), fs.readFileSync(path.join(folder, e.name)).toString('base64')]]) : [];
    const homeBefore = JSON.stringify(tree(core.STATE_DIR));
    let observed;
    const answer = await agent.btw(state, 'What colour?', { chat: async (messages, tools) => { observed = { messages, tools }; return { content: 'Blue.', calls: [{ tool: 'write_file', path: 'bad.txt', content: 'bad' }] }; } });
    check('side request uses conversation context and offers no tools', answer.startsWith('Blue.') && answer.includes('no tool calls were executed') && observed.tools === null && JSON.stringify(observed.messages).includes('The fixture is blue.'), detail(observed));
    check('side answer ignores tool calls, leaves state and every home file byte-identical', !fs.existsSync(path.join(dir, 'bad.txt')) && JSON.stringify(state) === stateBefore && before.equals(fs.readFileSync(file)) && JSON.stringify(tree(core.STATE_DIR)) === homeBefore, detail());
    const lines = [];
    await commands.dispatch('/btw why?', { state, cwd: dir, out: t => lines.push(t), api: { btw: async () => 'Because.' } });
    check('slash dispatch never saves the side exchange', lines[0] === 'Because.' && before.equals(fs.readFileSync(file)), detail(lines));
  });
  await asyncSuite('draft recovery expert', 'followups: atomic drafts, redaction and crash during typing', async () => {
    const file = drafts.fileFor(dir, dir), proc = new EventEmitter(), exits = []; proc.exit = code => exits.push(code);
    const store = drafts.createStore(file, { proc, delay: 20 });
    store.save({ prompt: 'unsent', queued: ['one', 'two'], steers: ['first'] });
    check('drafts debounce instead of writing every key', !fs.existsSync(file), detail());
    await new Promise(r => setTimeout(r, 60));
    check('drafts restore prompt, queue and pending steer order after atomic rename', drafts.read(file).queued.join('|') === 'one|two' && drafts.read(file).steers[0] === 'first' && !fs.readdirSync(path.dirname(file)).some(f => f.endsWith('.tmp')), detail(drafts.read(file)));
    store.save({ prompt: 'api_key=abcdefghijklm', queued: ['plain'], steers: [] }); proc.emit('uncaughtExceptionMonitor', Error('fixture'));
    check('uncaught errors flush with existing secret-redaction rules', drafts.read(file).prompt === '[redacted]' && !fs.readFileSync(file, 'utf8').includes('abcdefghijklm'), detail());
    store.save({ prompt: 'signal saved', queued: [], steers: [] }); proc.emit('SIGTERM');
    check('SIGTERM flushes the latest draft', drafts.read(file).prompt === 'signal saved', detail());
    check('a signal with no other listener still ends Atlias with its code', exits.join() === '143', detail(exits));
    const cancel = () => {}; proc.once('SIGINT', cancel);
    store.save({ prompt: 'saved during sign-in', queued: [], steers: [] }); proc.emit('SIGINT');
    check('Ctrl+C during a sign-in that listens for it saves the draft and leaves the cancel to that listener', drafts.read(file).prompt === 'saved during sign-in' && exits.join() === '143', detail(exits));
    const beforeFailure = fs.readFileSync(file), rename = fs.renameSync;
    store.save({ prompt: 'retry after disk error', queued: [], steers: [] });
    try { fs.renameSync = () => { throw Error('fixture rename failure'); }; store.flush(); }
    finally { fs.renameSync = rename; }
    check('a failed atomic rename preserves the previous complete draft', beforeFailure.equals(fs.readFileSync(file)), detail());
    store.flush();
    check('the retained dirty draft can be retried successfully', drafts.read(file).prompt === 'retry after disk error', detail());
    if (process.platform !== 'win32') check('POSIX draft file permissions are 0600', (fs.statSync(file).mode & 0o777) === 0o600, detail());
    store.close();
    check('closing a draft store releases signal and crash listeners', ['exit', 'SIGINT', 'SIGTERM', 'uncaughtExceptionMonitor'].every(n => proc.listenerCount(n) === 0), detail());
    const uiFile = path.join(dir, 'ui-draft.json'), uiStore = drafts.createStore(uiFile, { proc: new EventEmitter() });
    const terminal = rig({ draftStore: uiStore }); let prompt = terminal.terminal.prompt(); terminal.send('half typed'); terminal.terminal.close(); await prompt.catch(() => {});
    check('closing the composer flushes unsent typing', drafts.read(uiFile).prompt === 'half typed', detail(drafts.read(uiFile)));
    const clearStore = drafts.createStore(uiFile, { proc: new EventEmitter() }), clear = rig({ draftStore: clearStore });
    prompt = clear.terminal.prompt(clearStore.initial.prompt); clear.send('\r'); await prompt;
    check('sending a restored draft clears it immediately', drafts.read(uiFile).prompt === '', detail(drafts.read(uiFile))); clear.terminal.close();
    const crashFile = path.join(dir, 'crash.json'), script = path.join(dir, 'crash-child.mjs');
    fs.writeFileSync(script, `import {EventEmitter} from 'node:events';\nimport {createTerminalUI} from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'lib/terminal-ui.mjs')).href)};\nimport {createStore} from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'lib/drafts.mjs')).href)};\nconst input=new EventEmitter(), output=new EventEmitter();\nObject.assign(input,{isTTY:true,isRaw:false,setRawMode(v){this.isRaw=v},isPaused:()=>false,pause(){},resume(){}});\nObject.assign(output,{isTTY:true,columns:100,rows:24,write(){}});\nconst ui=createTerminalUI({input,output,draftStore:createStore(${JSON.stringify(crashFile)}),env:{NO_COLOR:'1'}});\nui.prompt().catch(()=>{});\nprocess.on('message',t=>{input.emit('data',t);setTimeout(()=>process.send('saved'),400)});\nprocess.send('ready');\n`);
    const child = spawn(process.execPath, [script], { env: { ...process.env, ATLIAS_HOME: path.join(dir, 'crash-home') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let errors = ''; child.stderr.on('data', b => { errors += b; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const saved = new Promise((resolve, reject) => { child.on('message', m => { if (m === 'ready') child.send('unfinished typing'); if (m === 'saved') resolve(); }); child.once('error', reject); child.once('exit', () => reject(Error(errors || 'child exited before typing'))); });
    await saved;
    // Gev explicitly requested killing this isolated test child mid-typing.
    child.kill('SIGKILL'); const exit = await exited;
    const restored = drafts.createStore(crashFile, { proc: new EventEmitter() });
    check('a killed typing process restores its debounced draft at next start', restored.initial.prompt === 'unfinished typing' && (exit.signal || exit.code !== 0), detail({ exit, errors, initial: restored.initial })); restored.close();
  });
  await asyncSuite('follow-up adversarial expert', 'followups: planted missing queue protection is caught', async () => {
    const folder = path.join(dir, 'plant'); fs.mkdirSync(folder);
    const source = fs.readFileSync(path.join(ROOT, 'lib/terminal-ui.mjs'), 'utf8');
    const broken = source.replace('owner.turn.queued.unshift(...pendingSteers.splice(0));', 'pendingSteers.splice(0);');
    fs.writeFileSync(path.join(folder, 'terminal-ui.mjs'), broken);
    for (const f of ['terminal-appearance.mjs', 'terminal-brand.mjs', 'usage-display.mjs']) fs.copyFileSync(path.join(ROOT, 'lib', f), path.join(folder, f));
    const run = impl => { const r = rig({}, impl); r.terminal.turnStart(new AbortController()); r.send('last steer\x11'); const result = r.terminal.turnEnd(); r.terminal.close(); return result.queued[0] === 'last steer'; };
    check('late-steer recovery check rejects a planted dropped-message bug', source !== broken && run(ui) && !run(await import(pathToFileURL(path.join(folder, 'terminal-ui.mjs')).href)), detail());
    const draftSource = fs.readFileSync(path.join(ROOT, 'lib/drafts.mjs'), 'utf8');
    const draftBroken = draftSource.replace('redactInline(value.prompt).text', 'value.prompt').replace("'./import.mjs'", JSON.stringify(pathToFileURL(path.join(ROOT, 'lib/import.mjs')).href));
    const draftFile = path.join(folder, 'drafts.mjs'); fs.writeFileSync(draftFile, draftBroken);
    const impl = await import(pathToFileURL(draftFile).href), file = path.join(folder, 'broken-secret.json');
    const store = impl.createStore(file, { proc: new EventEmitter() }); store.save({ prompt: 'api_key=abcdefghijklm', queued: [], steers: [] }); store.flush(); store.close();
    check('secret check rejects a planted missing draft redaction', impl.read(file).prompt !== '[redacted]', detail());
  });
}
