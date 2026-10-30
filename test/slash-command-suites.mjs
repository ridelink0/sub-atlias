// The repl's slash commands (lib/commands.mjs) and /deep-research (lib/research.mjs).
// Gev 2026-10-17: one registry that /help lists from, the commands Claude Code users expect that atlias
// can honour, custom commands from markdown files, and a research pass that says what it could not check.
// Interactive only: the last suite proves exec, eval and runLoop never reach any of it. The model is
// scripted here; no engine, no network. Loaded by test/run.mjs, which owns suite(), asyncSuite() and check().
import { spawn } from 'node:child_process';
import * as commands from '../lib/commands.mjs';
import * as research from '../lib/research.mjs';
import * as settings from '../lib/settings.mjs';
import { offerClaudeForTests } from '../lib/edition.mjs';

export default async function slashCommandSuites({ suite, asyncSuite, check, core, agentMod, TMP, ROOT, fs, path }) {
  const NL = String.fromCharCode(10);
  let n = 0;
  const project = (files = {}) => {
    const d = path.join(TMP, 'slash', `p${process.pid}-${++n}`);
    fs.mkdirSync(d, { recursive: true });
    for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); }
    return d;
  };
  const homeDir = (files = {}) => {
    const d = path.join(TMP, 'slash', `h${process.pid}-${++n}`);
    fs.mkdirSync(d, { recursive: true });
    for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); }
    return d;
  };
  // A context with a scripted model: turn() records what it was asked and answers from the script.
  const ctxFor = (cwd, { engine = 'echo', replies = [], home, detect } = {}) => {
    const out = [];
    const asked = [];
    const engines = detect || (() => ({ claude: false, codex: false, openai: false, ollama: false, echo: true }));
    const api = { ...agentMod.slashApi, detectEngines: engines, pickEngine: (name) => engines()[name] ? name : null, turn: async (st, text) => { asked.push(text); const r = replies.shift(); return r === undefined ? 'out of script' : r; } };
    const state = agentMod.newState(cwd, engine);
    return { ctx: { state, cwd, out: (s) => out.push(String(s)), ask: async () => 'n', api, home: home || homeDir() }, out, asked, state };
  };
  const text = (out) => out.join(NL);

  suite('slash registry expert', 'slash commands: one registry, listed by /help', () => {
    const B = commands.BUILTINS;
    const names = B.map((b) => b.name);
    check('every command has a name, a usage line starting with its name, one line of help and a handler', B.every((b) => /^[a-z][a-z-]*$/.test(b.name) && b.usage.startsWith('/' + b.name) && b.help && !/\n/.test(b.help) && typeof b.run === 'function'), { happened: JSON.stringify(B.filter((b) => !(b.usage || '').startsWith('/' + b.name)).map((b) => b.name)), why: 'A command that /help cannot describe is a command nobody finds.', fix: 'Give each BUILTINS entry name, usage, help and run.' });
    check('command names are unique', new Set(names).size === names.length, { happened: names.join(','), why: 'The first entry would shadow the second silently.', fix: 'Rename one.' });
    const help = commands.helpText(project(), homeDir());
    const missing = B.filter((b) => !b.hidden && !help.includes(b.usage));
    check('/help lists every registered command, taken from the registry', missing.length === 0, { happened: 'missing from /help: ' + missing.map((b) => b.name).join(','), why: 'Gev asked for /help to list every command from the one table that runs them.', fix: 'helpText must map over BUILTINS.' });
    for (const want of ['help', 'engine', 'model', 'status', 'cost', 'permissions', 'config', 'diff', 'review', 'undo', 'compact', 'clear', 'sessions', 'resume', 'export', 'plan', 'init', 'memory', 'graph', 'skills', 'recall', 'progress', 'deep-research', 'settings', 'hosts', 'doctor', 'exit']) {
      check(`/${want} is registered`, names.includes(want), { happened: names.join(','), why: 'It is on the list Gev asked for or already existed.', fix: 'Add it to BUILTINS.' });
    }
    check('/usage exposes labelled connected account allowances separately from session tokens', names.includes('usage'), { happened: names.join(','), why: 'Gev explicitly requested connected engine allowances in the terminal.', fix: 'Keep the read-only allowance command registered.' });
    const p = commands.parseLine;
    check('a slash line splits into a name and its arguments', JSON.stringify(p('/engine ollama')) === '{"name":"engine","args":"ollama"}' && JSON.stringify(p('  /help  ')) === '{"name":"help","args":""}' && p('/a:b x y').name === 'a:b', { happened: JSON.stringify([p('/engine ollama'), p('/help')]), why: 'Everything else rests on it.', fix: 'Check LINE_RE.' });
    check('a path or a sentence is not a command', p('/usr/bin/node why does this fail') === null && p('hello /help') === null && p('/') === null && p('/ x') === null, { happened: JSON.stringify([p('/usr/bin/node why'), p('hello /help')]), why: 'A person pasting a path must not get "unknown command".', fix: 'LINE_RE stops at a second slash.' });
  });

  await asyncSuite('slash behaviour expert', 'slash commands: what each one does', async () => {
    const cwd = project({ 'a.txt': 'one' + NL });
    let r = ctxFor(cwd);
    let res = await commands.dispatch('/help', r.ctx);
    check('/help prints the list and runs nothing else', res.handled && !res.exit && text(r.out).includes('/deep-research <topic>') && r.asked.length === 0, { happened: text(r.out).slice(0, 80), why: 'Help must never reach the model.', fix: 'Check dispatch.' });
    r = ctxFor(cwd);
    res = await commands.dispatch('/exit', r.ctx);
    const quit = await commands.dispatch('/quit', ctxFor(cwd).ctx);
    check('/exit and /quit end the repl', res.exit === true && quit.exit === true, { happened: JSON.stringify([res, quit]), why: 'They were the two ways out before the registry.', fix: 'exit: true on both.' });
    r = ctxFor(cwd);
    res = await commands.dispatch('/nosuchthing now', r.ctx);
    check('an unknown command is refused with a pointer to /help and is not sent to the model', res.handled && /unknown command \/nosuchthing/.test(text(r.out)) && r.asked.length === 0, { happened: text(r.out), why: 'A typo sent to a model as a request is paid for and answered wrongly.', fix: 'dispatch ends with the unknown branch.' });
    r = ctxFor(cwd);
    res = await commands.dispatch('//not a command', r.ctx);
    check('a line starting with // goes to the model with one slash', res.handled && res.text === '/not a command' && r.asked.length === 0, { happened: JSON.stringify(res), why: 'The way to send a message that begins with a slash.', fix: 'dispatch handles //.' });
    r = ctxFor(cwd);
    res = await commands.dispatch('/usr/bin/node broke', r.ctx);
    check('a path typed as a message is left to the model', res.handled === false, { happened: JSON.stringify(res), why: 'It is a sentence, not a command.', fix: 'parseLine returns null.' });

    // /status goes through the api, /plan reads state.
    r = ctxFor(cwd);
    await commands.dispatch('/status', r.ctx);
    await commands.dispatch('/plan', r.ctx);
    check('/status shows the session and /plan says there is no plan yet', text(r.out).includes('engine echo') && text(r.out).includes('no plan yet'), { happened: text(r.out), why: 'Existing commands keep their output.', fix: 'Check the status and plan entries.' });

    // /engine
    r = ctxFor(cwd, { detect: () => ({ echo: true, ollama: true, claude: false }) });
    r.state.messages = [{ role: 'user', content: 'x' }];
    await commands.dispatch('/engine ollama', r.ctx);
    const switched = r.state.engine === 'ollama' && r.state.messages.length === 0;
    // The claude host is founders-only (Gev, 2026-10-30); here it is offered but not detected.
    offerClaudeForTests(true);
    try { await commands.dispatch('/engine claude', r.ctx); } finally { offerClaudeForTests(false); }
    check('/engine switches to an available engine, starts a fresh conversation, and refuses one that is not there', switched && r.state.engine === 'ollama' && /claude is not available/.test(text(r.out)), { happened: r.state.engine + ' ' + text(r.out), why: 'A different engine cannot read the old one\'s messages.', fix: 'Check the engine entry.' });

    // /model
    const before = core.config().agent.ollamaModel;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: 'qwen-test:1b' }] }) });
    try {
      r = ctxFor(cwd, { engine: 'ollama' });
      await commands.dispatch('/model', r.ctx);
      await commands.dispatch('/model qwen-test:1b', r.ctx);
      check('/model shows the ollama model and sets it in the config', text(r.out).includes('model ' + before) && core.config().agent.ollamaModel === 'qwen-test:1b', { happened: text(r.out) + ' / ' + core.config().agent.ollamaModel, why: 'The model is a setting, so /model must change the setting.', fix: 'Check the model entry.' });
    } finally { globalThis.fetch = realFetch; settings.reset('agent.ollamaModel'); }
    r = ctxFor(cwd, { engine: 'claude' });
    await commands.dispatch('/model gpt-x', r.ctx);
    check('/model on the claude engine says the program picks it and changes nothing', /picks its own model/.test(text(r.out)) && core.config().agent.ollamaModel === before && core.config().agent.openaiModel === '', { happened: text(r.out), why: 'Atlias does not pass a model to the claude or codex program, so pretending to set one would be false.', fix: 'The key is null for those engines.' });

    // /permissions, /config
    r = ctxFor(cwd);
    await commands.dispatch('/permissions', r.ctx);
    check('/permissions shows the current mode', /permissions workspace: workspace \(edits/.test(text(r.out)), { happened: text(r.out), why: 'It showed this before the registry.', fix: 'Keep the text.' });
    try {
      r = ctxFor(cwd);
      await commands.dispatch('/config agent.maxToolRounds 9', r.ctx);
      await commands.dispatch('/config agent.maxToolRounds', r.ctx);
      const changed = await commands.dispatch('/config', r.ctx);
      await commands.dispatch('/config nope.nothing', r.ctx);
      await commands.dispatch('/config reset agent.maxToolRounds', r.ctx);
      check('/config sets one setting, shows it, lists changed ones, names an unknown id, and resets', core.config().agent.maxToolRounds === 25 && /agent\.maxToolRounds = 9/.test(text(r.out)) && /no setting named nope\.nothing/.test(text(r.out)) && changed.handled, { happened: text(r.out).slice(0, 400), why: 'A menu is not scriptable and not testable.', fix: 'Check the config entry.' });
    } finally { settings.reset('agent.maxToolRounds'); }

    // /cost keeps Atlias own-provider token accounting; plan limits belong to the provider.
    r = ctxFor(cwd);
    await commands.dispatch('/usage', r.ctx);
    check('/usage explains unknown allowances without making model calls', commands.builtinNames().has('usage') && /Account allowances are separate from session tokens/.test(text(r.out)), { happened: text(r.out).slice(-700), why: 'Account allowance and session spending must stay distinct.', fix: 'Label account snapshots and missing data explicitly.' });
    r = ctxFor(cwd, { engine: 'ollama' });
    await commands.dispatch('/cost', r.ctx);
    r.state.cache = { calls: 3, reported: 2, silent: 1, prompt: 1500, cached: 900, source: 'ollama' };
    r.state.outLog = [120, null, 80];
    r.state.promptLog = [700, null, 800];
    await commands.dispatch('/cost', r.ctx);
    const claude = ctxFor(cwd, { engine: 'claude' });
    await commands.dispatch('/cost', claude.ctx);
    check('/cost reports measured calls and tokens, never money, and says the claude engine\'s counts are not seen', /no model call yet/.test(r.out[0]) && /model calls\s+3/.test(r.out[1]) && /prompt tokens\s+1500 over 2 reporting calls, 1 reported nothing/.test(r.out[1]) && /output tokens\s+200 over 2 calls/.test(r.out[1]) && /largest prompt\s+800/.test(r.out[1]) && /no price table/.test(r.out[1]) && /never sees their token counts/.test(text(claude.out)), { happened: text(r.out) + ' | ' + text(claude.out), why: 'Never pass an estimate off as a measurement.', fix: 'Check the cost entry.' });

    // /compact on an empty session, /diff outside a repo
    r = ctxFor(cwd);
    await commands.dispatch('/compact', r.ctx);
    check('/compact keeps its old answer on a session with nothing to drop', /nothing to compact yet/.test(text(r.out)), { happened: text(r.out), why: 'Existing behaviour.', fix: 'Call loop.compact.' });

    // /clear
    r = ctxFor(cwd);
    const emptyClear = await commands.dispatch('/clear', r.ctx);
    r.state.history.push({ role: 'user', text: 'first' }, { role: 'assistant', text: 'reply' });
    r.state.messages = [{ role: 'user', content: 'first' }];
    const oldSid = r.state.sid;
    const same = r.state;
    await commands.dispatch('/clear', r.ctx);
    const saved = agentMod.loadChat(oldSid, cwd);
    check('/clear saves the old session, then the same state object holds a new empty one', /already empty/.test(r.out[0]) && same === r.ctx.state && r.state.sid !== oldSid && r.state.history.length === 0 && r.state.messages.length === 0 && saved && saved.history.length === 2 && emptyClear.handled, { happened: JSON.stringify({ sid: r.state.sid, old: oldSid, saved: saved && saved.history.length }), why: 'The repl keeps one variable; a copy would leave the repl on the old session.', fix: 'replaceState mutates in place after saveChat.' });

    // /resume
    const rc = ctxFor(cwd);
    rc.state.history.push({ role: 'user', text: 'remember me' }, { role: 'assistant', text: 'ok' });
    agentMod.saveChat(rc.state);
    const target = rc.state.sid;
    const other = ctxFor(cwd);
    await commands.dispatch('/resume nosuchid', other.ctx);
    await commands.dispatch('/resume ' + target, other.ctx);
    check('/resume loads a saved session of this folder into the open state, and names one that is not there', /no saved session matches nosuchid/.test(other.out[0]) && other.state.sid === target && other.state.history[0].text === 'remember me', { happened: text(other.out) + ' ' + other.state.sid, why: 'The repl\'s variable must follow.', fix: 'Check the resume entry.' });
    const bare = ctxFor(cwd);
    const bareSid = bare.state.sid;
    let offered = [];
    bare.ctx.api.selectSession = async rows => { offered = rows; return target; };
    await commands.dispatch('/resume', bare.ctx);
    check('/resume with no id offers saved sessions and resumes the chosen item', bare.state.sid === target && bare.state.sid !== bareSid && offered.some(s => s.sid === target) && !offered.some(s => s.sid === bareSid) && /resumed /.test(text(bare.out)), { happened: bare.state.sid + ' ' + text(bare.out), why: 'Gev requested explicit session selection.', fix: 'Open the picker before changing state.' });
    const cancelled = ctxFor(cwd), cancelledSid = cancelled.state.sid;
    cancelled.ctx.api.selectSession = async () => null;
    await commands.dispatch('/resume', cancelled.ctx);
    check('cancelling the session picker preserves the current conversation', cancelled.state.sid === cancelledSid && /cancelled/.test(text(cancelled.out)), { happened: text(cancelled.out), why: 'Opening a picker grants no session change.', fix: 'Return before load/save when cancelled.' });
    const plain = ctxFor(cwd), answers = ['no match at all', 'remember me', '1'];
    plain.ctx.api.selectSession = async () => undefined;
    plain.ctx.ask = async () => answers.shift() || '';
    await commands.dispatch('/resume', plain.ctx);
    check('unavailable raw input falls back to a numbered searchable list', plain.state.sid === target && /Resume session/.test(text(plain.out)) && /No matching sessions/.test(text(plain.out)), { happened: text(plain.out), why: 'A raw-mode failure must not hide the choices.', fix: 'Use the plain picker when selectSession returns undefined.' });
    const corrupt = { sid: 'corrupt-saved-chat', cwd, engine: 'echo', history: [null], messages: [] };
    fs.writeFileSync(agentMod.chatPath(corrupt.sid), JSON.stringify(corrupt));
    check('corrupt nested history is skipped by the list and direct resume', !agentMod.listChats(cwd, Infinity).some(s => s.sid === corrupt.sid) && agentMod.loadChat(corrupt.sid, cwd) === null, { happened: corrupt.sid, why: 'An unreadable session must not crash the picker.', fix: 'Validate a saved conversation before listing or loading.' });
    rc.state.connectionUsage = { openai: { tokens: 120, calls: 1, reportedParts: 2, unreportedCalls: 0 } };
    agentMod.saveChat(rc.state);
    check('per-engine session token accounting survives saved-session resume', agentMod.loadChat(rc.state.sid, cwd).connectionUsage.openai.tokens === 120, { happened: JSON.stringify(rc.state.connectionUsage), why: 'The bar must not lose accounting on resume.', fix: 'Persist connectionUsage with the conversation.' });
    const away = ctxFor(project());
    const foreign = ctxFor(cwd);
    foreign.state.history.push({ role: 'user', text: 'x' }, { role: 'assistant', text: 'y' });
    agentMod.saveChat(foreign.state);
    await commands.dispatch('/resume ' + foreign.state.sid, away.ctx);
    check('/resume refuses a session that belongs to another folder', /belongs to/.test(away.out[0]) && away.state.sid !== foreign.state.sid, { happened: text(away.out), why: 'The tools are bound to the folder the repl started in.', fix: 'Compare cwd before replacing.' });

    // /export
    r = ctxFor(cwd);
    await commands.dispatch('/export', r.ctx);
    r.state.history.push({ role: 'user', text: 'question one' }, { role: 'assistant', text: 'answer one' });
    await commands.dispatch('/export notes/talk.md', r.ctx);
    await commands.dispatch('/export notes/talk.md', r.ctx);
    await commands.dispatch('/export ../outside.md', r.ctx);
    const written = fs.existsSync(path.join(cwd, 'notes', 'talk.md')) ? fs.readFileSync(path.join(cwd, 'notes', 'talk.md'), 'utf8') : '';
    check('/export writes the conversation inside the project, never overwrites, never leaves the project', /nothing to export/.test(r.out[0]) && written.includes('question one') && written.includes('answer one') && /exists; give another name/.test(r.out[2]) && /inside the project only/.test(r.out[3]) && !fs.existsSync(path.join(path.dirname(cwd), 'outside.md')), { happened: text(r.out), why: 'A command that writes where it likes is a hole.', fix: 'insideProject check in the export entry.' });

    // /init and /review prompts
    r = ctxFor(cwd, { replies: ['done'] });
    await commands.dispatch('/init', r.ctx);
    const initFirst = r.asked[0];
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'old' + NL);
    const r2 = ctxFor(cwd, { replies: ['done'] });
    await commands.dispatch('/init', r2.ctx);
    check('/init asks the engine to write AGENTS.md, or to update the one that exists', /write AGENTS\.md at its root/.test(initFirst) && /update its AGENTS\.md/.test(r2.asked[0]) && /already exists/.test(r2.asked[0]) && /done/.test(text(r.out)), { happened: initFirst, why: 'The model does the reading; the command only asks.', fix: 'Check the init entry.' });
    const noRepo = ctxFor(project());
    await commands.dispatch('/review', noRepo.ctx);
    check('/review with nothing to review sends nothing to the model', /nothing to review/.test(text(noRepo.out)) && noRepo.asked.length === 0, { happened: text(noRepo.out), why: 'Existing behaviour.', fix: 'reviewPrompt null path.' });

    // /memory
    const mem = project({ 'AGENTS.md': 'rules' + NL });
    const memDir = core.claudeMemoryDir(mem);
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'note_one.md'), '---' + NL + 'name: note one' + NL + 'description: the deploy trick' + NL + '---' + NL + 'body' + NL);
    r = ctxFor(mem);
    await commands.dispatch('/memory', r.ctx);
    check('/memory lists the instruction files and the saved notes with their descriptions', /AGENTS\.md \(\d+ bytes\)/.test(text(r.out)) && /note_one\.md - the deploy trick/.test(text(r.out)), { happened: text(r.out), why: 'It shows what atlias reads before it works.', fix: 'Check the memory entry.' });
    r = ctxFor(mem);
    await commands.dispatch('/memory deploy', r.ctx);
    check('/memory with words searches the notes', /note_one/.test(text(r.out)), { happened: text(r.out), why: 'Same search as /recall.', fix: 'Delegate to recall.' });
  });

  await asyncSuite('slash custom commands expert', 'slash commands: custom commands from markdown files', async () => {
    const cwd = project({
      '.atlias/commands/fix.md': '---' + NL + 'description: Fix an issue' + NL + 'argument-hint: <issue>' + NL + '---' + NL + 'Fix issue $1 carefully. All words: $ARGUMENTS.' + NL,
      '.atlias/commands/plain.md': 'Summarise the project.' + NL,
      '.atlias/commands/team/ship.md': 'Ship it.' + NL,
      '.atlias/commands/help.md': 'I try to shadow the built-in help.' + NL,
      '.atlias/commands/bad name.md': 'x' + NL,
      '.atlias/commands/empty.md': '---' + NL + 'description: nothing' + NL + '---' + NL,
      '.atlias/commands/big.md': 'x'.repeat(commands.CUSTOM_MAX_BYTES + 1),
      '.atlias/commands/notes.txt': 'not markdown',
    });
    const home = homeDir({ 'commands/fix.md': 'HOME fix' + NL, 'commands/homeonly.md': 'From home.' + NL });
    const loaded = commands.loadCustom(cwd, home);
    const byName = Object.fromEntries(loaded.list.map((x) => [x.name, x]));
    check('commands load from the project folder, the atlias home and one level of subfolder', ['fix', 'plain', 'team:ship', 'homeonly', 'help'].every((k) => byName[k]), { happened: loaded.list.map((x) => x.name).join(','), why: 'Claude Code loads custom commands from both places and namespaces folders.', fix: 'Check customDirs and scan.' });
    check('the project\'s copy of a name wins over the home\'s', byName.fix.source === 'project' && byName.homeonly.source === 'home', { happened: JSON.stringify(byName.fix), why: 'The nearest definition is the person\'s intent.', fix: 'Load home first, project second.' });
    check('a bad file name, an empty body, a file over the size cap and a non-markdown file are skipped, and said so', loaded.skipped.length === 3 && !byName['bad name'] && !byName.empty && !byName.big && !byName.notes, { happened: JSON.stringify(loaded.skipped.map((s) => path.basename(s.file) + ': ' + s.why)), why: 'A prompt file nobody can read or that is huge should not be sent silently.', fix: 'Check scan.' });
    check('frontmatter gives the help line and the argument hint; no description falls back to the first line', byName.fix.help === 'Fix an issue' && byName.fix.hint === '<issue>' && byName.plain.help === 'Summarise the project.', { happened: JSON.stringify(byName.fix), why: '/help shows them.', fix: 'Use parseFrontmatter.' });
    check('$ARGUMENTS and $1 are replaced; with no placeholder the arguments are appended', commands.expand('Fix $1 now. All: $ARGUMENTS.', 'a b c') === 'Fix a now. All: a b c.' && commands.expand('Do it', 'extra words') === 'Do it' + NL + NL + 'ARGUMENTS: extra words' && commands.expand('Do it', '') === 'Do it' && commands.expand('x $2', 'one') === 'x ', { happened: commands.expand('Fix $1 now. All: $ARGUMENTS.', 'a b c'), why: 'The same rules as Claude Code\'s custom commands.', fix: 'Check expand.' });
    const help = commands.helpText(cwd, home);
    check('/help lists custom commands with their source and notes a built-in hiding one', /\/fix <issue>\s+Fix an issue \(project\)/.test(help) && /\/team:ship/.test(help) && /\/homeonly\s+From home\. \(home\)/.test(help) && /is hidden by the built-in command of that name/.test(help) && /ignored .*big\.md/.test(help), { happened: help.slice(-900), why: 'A command that exists must be findable; one that cannot run must say why.', fix: 'Check helpText.' });

    const r = ctxFor(cwd, { home, replies: ['custom answer', 'second'] });
    await commands.dispatch('/fix 42 and more', r.ctx);
    await commands.dispatch('/team:ship', r.ctx);
    const builtin = await commands.dispatch('/help', r.ctx);
    check('running a custom command sends its expanded text to the model as a message', r.asked[0] === 'Fix issue 42 carefully. All words: 42 and more.' && r.asked[1] === 'Ship it.' && /custom answer/.test(text(r.out)) && r.asked.length === 2 && builtin.handled, { happened: JSON.stringify(r.asked), why: 'That is what a custom command is.', fix: 'Check dispatch.' });
    check('a built-in name cannot be taken over by a file', !text(r.out).includes('I try to shadow'), { happened: text(r.out).slice(0, 100), why: 'A project file must not redefine /help or /exit.', fix: 'Built-ins are matched first.' });
    const edit = ctxFor(cwd, { home, replies: ['ok'] });
    fs.writeFileSync(path.join(cwd, '.atlias', 'commands', 'plain.md'), 'Changed text.' + NL);
    await commands.dispatch('/plain', edit.ctx);
    check('an edited command file is picked up on the next line, with no restart', edit.asked[0] === 'Changed text.', { happened: JSON.stringify(edit.asked), why: 'Files are read at each dispatch.', fix: 'Do not cache loadCustom.' });
  });

  await asyncSuite('deep research expert', 'deep research: plan, gather, cite, say what is unverified', async () => {
    const cwd = project({ 'src/app.js': ['one', 'two', 'three'].join(NL) + NL });
    const plan = '1. What does app.js do?' + NL + '2. Where is the entry point?' + NL + 'noise' + NL + '3. Is there a web API?';
    const replies = [
      plan,
      'It holds three lines. See src/app.js:2 and src/app.js:1-3. Not verified: whether it runs.',
      'No entry point found; src/missing.js:5 may be it, and src/app.js:99 too. Not verified: nothing',
      'No web API in the files. memory:note_one covers it, memory:ghost does not exist.',
      'Summary: app.js is tiny, see src/app.js:3.',
    ];
    const r = ctxFor(cwd, { engine: 'ollama', replies });
    const seenPrompts = [];
    const innerTurn = r.ctx.api.turn;
    r.ctx.api.turn = async (...a) => { seenPrompts.push(a[1]); return innerTurn(...a); };
    const memDir = core.claudeMemoryDir(cwd);
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'note_one.md'), 'x');
    const res = await commands.dispatch('/deep-research how does the app start', r.ctx);
    const file = fs.readdirSync(path.join(cwd, '.atlias', 'research'))[0];
    const report = fs.readFileSync(path.join(cwd, '.atlias', 'research', file), 'utf8');
    check('the pass is plan, one turn per question, then a summary', res.handled && seenPrompts.length === 5 && /Step 1, plan/.test(seenPrompts[0]) && /Question: What does app\.js do\?/.test(seenPrompts[1]) && /Question: Is there a web API\?/.test(seenPrompts[3]) && /Final step, summarise/.test(seenPrompts[4]) && /Step 2 of 3/.test(seenPrompts[2]), { happened: seenPrompts.map((p) => p.slice(0, 60)).join(' | '), why: 'This is the multi-step shape Gev asked for.', fix: 'Check deepResearch.' });
    check('the plan is parsed from numbered lines only, at most five', research.parseQuestions(plan).length === 3 && research.parseQuestions('1. a question one' + NL + '2. a question two' + NL + '3. a question three' + NL + '4. a question four' + NL + '5. a question five' + NL + '6. a question six').length === 5 && research.parseQuestions('just prose').length === 0, { happened: JSON.stringify(research.parseQuestions(plan)), why: 'A model that rambles must not become a dozen model turns.', fix: 'Check parseQuestions.' });
    check('the report is a file under .atlias/research inside the project, named from the topic', /^how-does-the-app-start-\d{8}-\d{6}\.md$/.test(file) && report.startsWith('# Research: how does the app start'), { happened: file + ' ' + report.slice(0, 60), why: 'Gev asked for a report file under the project.', fix: 'Check REPORT_DIR and slug.' });
    check('the report states from the tool table that there is no web tool, and names the tools', /It has no web tool: nothing here was looked up on the internet/.test(report) && /Tools: read_file, outline/.test(report) && /Nothing was checked against the internet/.test(report), { happened: report.slice(0, 700), why: 'Atlias has no web tool and must not pretend to browse.', fix: 'reach() builds the sentence from offeredTools.' });
    check('citations are checked against the files: real ones found, a missing file, an out-of-range line and a missing note are listed as not found', /Checked and found: 4 \(src\/app\.js:2, src\/app\.js:1-3, src\/app\.js:3, memory:note_one\)/.test(report) && /src\/missing\.js:5: no such file/.test(report) && /src\/app\.js:99: the file has 3 lines/.test(report) && /memory:ghost: no such memory note/.test(report), { happened: report.slice(report.indexOf('## Citation check')), why: 'A cited report is only worth the citations that exist.', fix: 'Check checkCitations.' });
    check('what the model said it could not verify is carried into the report, and a step with no such line is called out', /Question 1: whether it runs\./.test(report) && !/Question 2: /.test(report) && /Question 3 gave no "Not verified" line/.test(report), { happened: report.slice(report.indexOf('## What could not be verified'), report.indexOf('## Citation check')), why: 'The report must say plainly what is unverified.', fix: 'Check notVerified and buildReport.' });
    check('the command prints the report path and the citation counts', /report: \.atlias[\\/]research[\\/]how-does-the-app-start/.test(text(r.out)) && /citations: 4 found, 3 not found/.test(text(r.out)), { happened: text(r.out).slice(-300), why: 'The person should not have to hunt for the file.', fix: 'Check the deep-research entry.' });

    const noPlan = ctxFor(cwd, { engine: 'ollama', replies: ['I would just look around.', 'Answer. Not verified: nothing', 'Short summary.'] });
    await commands.dispatch('/deep-research the lone topic', noPlan.ctx);
    const files = fs.readdirSync(path.join(cwd, '.atlias', 'research')).filter((f) => f.startsWith('the-lone-topic'));
    const lone = fs.readFileSync(path.join(cwd, '.atlias', 'research', files[0]), 'utf8');
    check('a plan with no numbered questions researches the topic as one question and the report says so', noPlan.asked.length === 3 && /gave no numbered questions/.test(lone) && /No finding carried a path:line citation/.test(lone), { happened: lone.slice(0, 500), why: 'Say what happened instead of hiding the fallback.', fix: 'planNote.' });

    const claude = ctxFor(cwd, { engine: 'claude', replies: ['1. only question here', 'A. Not verified: x', 'S'] });
    await commands.dispatch('/deep-research claude topic', claude.ctx);
    const cf = fs.readdirSync(path.join(cwd, '.atlias', 'research')).find((f) => f.startsWith('claude-topic'));
    const crep = fs.readFileSync(path.join(cwd, '.atlias', 'research', cf), 'utf8');
    check('on the claude engine the report says whether it browsed is not known to atlias, and does not claim no web', /Atlias cannot see which of them it used/.test(crep) && /not visible to atlias/.test(crep) && !/no web tool/.test(crep), { happened: crep.slice(0, 600), why: 'Atlias can neither confirm nor deny what another program\'s tools did.', fix: 'reach() branches on engine.' });

    const none = ctxFor(cwd);
    await commands.dispatch('/deep-research', none.ctx);
    check('/deep-research with no topic prints usage and runs nothing', /usage: \/deep-research/.test(text(none.out)) && none.asked.length === 0, { happened: text(none.out), why: 'No topic, no spend.', fix: 'Guard on empty args.' });
    const outside = path.join(project(), 'secret.txt');
    fs.writeFileSync(outside, 'line one' + NL);
    const escaped = research.checkCitations(cwd, `see ${outside.replace(/\\/g, '/')}:1 and ../${path.basename(path.dirname(outside))}/secret.txt:1`, path.join(cwd, 'nomem'));
    check('a citation to a real file outside the project is not followed', escaped.ok.length === 0 && escaped.bad.length === 2 && escaped.bad.every((b) => b.why === 'outside the project'), { happened: JSON.stringify(escaped), why: 'A model must not make atlias read arbitrary files by citing them.', fix: 'insideProject in checkCitations.' });
  });

  await asyncSuite('slash repl and benchmark expert', 'slash commands: the repl uses the registry, the benchmark path never does', async () => {
    const cwd = project({ '.atlias/commands/hello.md': 'Say hello to $ARGUMENTS.' + NL });
    const lines = ['/help', '/nosuch', '//slash start', 'plain words', '/hello world', '/exit', 'never read'];
    // readline drops lines that arrive before a question is asked, so each line is written when the prompt shows.
    const res = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'atlias.mjs'), 'agent', '--engine', 'echo'], { cwd, env: { ...process.env, NO_COLOR: '1' } });
      let stdout = '', stderr = '', sent = 0, seen = 0;
      const timer = setTimeout(() => { try { child.stdin.end(); } catch { /* closed */ } }, 60000);
      child.stdout.on('data', (b) => {
        stdout += b;
        const prompts = (stdout.match(/you> /g) || []).length;
        while (seen < prompts && sent < lines.length) { seen++; child.stdin.write(lines[sent++] + NL); }
      });
      child.stderr.on('data', (b) => { stderr += b; });
      child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
    const o = res.stdout || '';
    check('the real repl: /help lists the registry and the custom file, unknown is refused, // and plain text and a custom command reach the engine, /exit ends it', res.status === 0 && o.includes('/deep-research <topic>') && /\/hello\s+Say hello to \$ARGUMENTS\./.test(o) && /unknown command \/nosuch/.test(o) && o.includes('echo: /slash start') && o.includes('echo: plain words') && o.includes('echo: Say hello to world.') && !o.includes('never read'), { happened: String(res.status) + ' ' + o.slice(-700) + (res.stderr || '').slice(0, 300), why: 'The registry is only worth anything if the repl runs on it.', fix: 'replIn calls commands.dispatch.' });

    const st = agentMod.newState(cwd, 'echo');
    const reply = await agentMod.turn(st, '/help', null, null);
    check('exec\'s path (turn) sends a slash line to the engine untouched', reply === 'echo: /help', { happened: reply, why: 'Slash commands are interactive only; atlias exec and eval must behave as before.', fix: 'Dispatch only in replIn.' });
    const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const benchFiles = ['lib/loop.mjs', 'lib/eval.mjs', 'tools/h2h/atlias_task.mjs', 'lib/editbench.mjs', 'lib/bench.mjs'].filter((f) => fs.existsSync(path.join(ROOT, f)));
    const touching = benchFiles.filter((f) => /commands\.mjs|research\.mjs/.test(read(f)));
    check('the loop, the eval, the benchmark task adapter and the bench files do not import the command registry', benchFiles.length >= 3 && touching.length === 0, { happened: touching.join(',') || 'only ' + benchFiles.length + ' files found', why: 'The benchmark path must behave byte for byte as before.', fix: 'Keep commands.mjs imported by agent.mjs alone.' });
    const agentSrc = read('lib/agent.mjs');
    const execOnce = agentSrc.slice(agentSrc.indexOf('async function execOnce'), agentSrc.indexOf('// What the repl'));
    check('execOnce and runOnce never call dispatch', !/commands\./.test(execOnce), { happened: 'dispatch found in the exec path', why: 'Same.', fix: 'Dispatch lives in replIn only.' });
  });
}
