// Round five, row 5: same-text is not a strike, and a repeat switches format
// (flags.sameTextSwitch). On the main tier 87 of the 246 edits the 7B could not
// land re-sent its own text unchanged, and each one counted against
// agent.maxBadReplies. With the flag on, an edit whose new text is its old text,
// or a byte-for-byte repeat of the last failed edit, is answered with a steer
// and is no strike; a repeat also makes that file's next edit a whole Python
// def or class, found by its header, or the whole file. Every case here drives
// runLoop with a scripted model and checks the same script with the flag off,
// which must be the loop as it was. Loaded by test/run.mjs.
import * as loop from '../lib/loop.mjs';
import * as evals from '../lib/eval.mjs';
import * as settings from '../lib/settings.mjs';

export default async function sameTextSuites({ asyncSuite, suite, check, core, agentMod, TMP, fs, path }) {
  const NL = String.fromCharCode(10);
  const FENCE = '`'.repeat(3);
  const blk = (o) => FENCE + 'atlias' + NL + JSON.stringify(o) + NL + FENCE;
  const FLAG = 'ATLIAS_FLAG_SAME_TEXT_SWITCH';
  let n = 0;
  const dir = (files) => {
    const d = path.join(TMP, 'sametext', `p${++n}`);
    fs.mkdirSync(d, { recursive: true });
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(d, rel), text);
    return d;
  };
  const scripted = (replies) => async () => {
    const r = replies.shift();
    if (r === undefined) return { content: 'out of script', calls: [] };
    return typeof r === 'string' ? { content: r, calls: [] } : r;
  };
  // One run of a script in a fresh project, with the flag on ('1'), off ('0')
  // or not set (null).
  const run = async (flag, files, replies, limits = { maxToolRounds: 12, maxBadReplies: 3 }) => {
    const d = dir(files);
    const before = process.env[FLAG];
    if (flag == null) delete process.env[FLAG]; else process.env[FLAG] = flag;
    try {
      const st = agentMod.newState(d, 'ollama');
      const reply = await loop.runLoop(st, 'fix it', { chat: scripted([...replies]), say: () => {}, ask: async () => true, limits });
      const said = st.messages.filter((m) => m.role !== 'system' && m.role !== 'assistant').map((m) => String(m.content || ''));
      return { st, reply, d, said, file: (rel) => fs.readFileSync(path.join(d, rel), 'utf8') };
    } finally { if (before == null) delete process.env[FLAG]; else process.env[FLAG] = before; }
  };
  const brief = (r) => JSON.stringify({ stop: r.st.stop, spared: r.st.spared, switches: r.st.switches, sameText: r.st.sameText, repeats: r.st.repeatEdits, why: r.st.editWhy }).slice(0, 400);

  suite('same text expert', 'the flag is registered like every round-five flag', () => {
    const row = settings.rows().find((r) => r.id === 'flags.sameTextSwitch');
    check('flags.sameTextSwitch is off by default, described, and switched from the environment', core.DEFAULTS.flags.sameTextSwitch === false && row && row.env === FLAG && /maxBadReplies/.test(row.about) && /whole/.test(row.about),
      { happened: JSON.stringify(row || null), why: 'NEXTGEN-5\'s merge rule: every behaviour change lands off, behind a key the study scripts can set per arm from the environment.', fix: 'DEFAULTS.flags in lib/core.mjs and DESCRIPTIONS in lib/settings.mjs.' });
  });

  await asyncSuite('same text expert', 'an edit that re-sends its own text is steered, not struck', async () => {
    const files = { 'sum.js': 'export function two() { return 1; }' + NL };
    // Three different same-text edits, then the fix: with maxBadReplies 3 the
    // flag-off loop stops on the third.
    const script = [
      blk({ tool: 'edit_file', path: 'sum.js', old_string: 'return 1;', new_string: 'return 1;' }),
      blk({ tool: 'edit_file', path: 'sum.js', old_string: 'function two()', new_string: 'function two()' }),
      blk({ tool: 'edit_file', path: 'sum.js', old_string: 'export function', new_string: 'export function' }),
      blk({ tool: 'edit_file', path: 'sum.js', old_string: 'return 1;', new_string: 'return 2;' }),
      'Fixed.',
      'No check exists here.',
    ];
    const on = await run('1', files, script);
    const off = await run('0', files, script);
    check('with the flag on three same-text edits in a row do not stop the run, and with it off they do', on.st.stop.reason === 'answered' && /return 2;/.test(on.file('sum.js')) && on.st.spared === 3 && off.st.stop.reason === 'malformed-output' && /3 edits that did not apply/.test(off.reply) && off.st.spared === 0,
      { happened: `on ${brief(on)} || off ${brief(off)}`, why: 'Same-text made up 87 of 246 failed edits on the main tier; row 5 says such a no-op is not a strike against agent.maxBadReplies.', fix: 'runLoop: a failed edit of kind same-text is spared under flags.sameTextSwitch.' });
    const steer = on.said.find((t) => /old_string and new_string are the same/.test(t)) || '';
    const offSteer = off.said.find((t) => /old_string and new_string are the same/.test(t)) || '';
    check('the steer says it is not counted and asks for the difference; off, the refusal is as it was', /does not count as a failed reply/.test(steer) && /new_string carries that difference/.test(steer) && !/does not count/.test(offSteer) && /nothing would change\./.test(offSteer),
      { happened: `${steer.slice(0, 300)} || ${offSteer.slice(0, 200)}`, why: 'A no-op answered with only "nothing would change" is how the model came to send it again.', fix: 'sameTextSteer, appended to the tool result in runLoop.' });
    check('both arms count the same-text edits; only the flag spares them', on.st.sameText === 3 && off.st.sameText === 3 && on.st.editWhy['same-text'] === 3 && on.st.editFails === 3 && off.st.spared === 0,
      { happened: `on ${brief(on)} || off ${brief(off)}`, why: 'The share is what row 5 is measured by in both arms; a spared edit still did not apply.', fix: 'Count state.sameText before the flag is read.' });
    // A round with a real failure beside a spared one still counts as a strike.
    const mixed = await run('1', files, [
      blk({ tool: 'edit_file', path: 'sum.js', old_string: 'nope one', new_string: 'x' }),
      blk({ tool: 'edit_file', path: 'sum.js', old_string: 'return 1;', new_string: 'return 1;' }),
      blk({ tool: 'edit_file', path: 'sum.js', old_string: 'nope two', new_string: 'x' }),
      blk({ tool: 'edit_file', path: 'sum.js', old_string: 'nope three', new_string: 'x' }),
      'never reached',
    ]);
    check('a spared edit neither strikes nor clears: three real misses around it still stop the run', mixed.st.stop.reason === 'malformed-output' && mixed.st.spared === 1 && /3 edits that did not apply/.test(mixed.reply),
      { happened: brief(mixed), why: 'Sparing a no-op must not turn it into a round that did something, or a model alternating a no-op with a real miss would never be stopped.', fix: 'A spared edit adds to neither produced nor deadEdits.' });
  });

  await asyncSuite('same text expert', 'a repeat switches a Python file to its whole def', async () => {
    const files = { 'main.py': 'import math' + NL + NL + NL + 'def add(a, b):' + NL + '    """Add two numbers."""' + NL + '    return a - b' + NL + NL + NL + 'def sub(a, b):' + NL + '    return a - b' + NL };
    const miss = blk({ tool: 'edit_file', path: 'main.py', old_string: 'def add(a, b):' + NL + '    return a - b', new_string: 'def add(a, b):' + NL + '    return a + b' });
    const whole = blk({ tool: 'edit_file', path: 'main.py', old_string: '', new_string: 'def add(a, b):' + NL + '    """Add two numbers."""' + NL + '    return a + b' + NL });
    const script = [miss, miss, whole, 'Fixed.', 'No check here.'];
    const on = await run('1', files, script);
    const off = await run('0', files, script);
    const steer = on.said.find((t) => /byte for byte/.test(t)) || '';
    check('the second identical miss is spared and says the next edit of main.py is the whole def add', on.st.repeatEdits === 1 && on.st.switches === 1 && on.st.spared === 1 && /next edit of main\.py changes format: send the whole def add/.test(steer) && /old_string ""/.test(steer),
      { happened: `${brief(on)} || ${steer.slice(-400)}`, why: 'Round four\'s item 5: a repeat should switch the edit channel, and HumanEvalFix\'s channel is a whole function found by name.', fix: 'channelFor and sameTextSteer, called from runLoop on a repeat.' });
    check('the whole def lands in place of the old one, the rest of the file untouched; off, the same edit is refused', on.file('main.py') === files['main.py'].replace('    return a - b' + NL + NL, '    return a + b' + NL + NL) && on.st.stop.reason === 'answered' && off.file('main.py') === files['main.py'] && off.st.editWhy['empty-old'] === 1 && off.st.repeatEdits === 1 && off.st.switches === 0,
      { happened: `${JSON.stringify(on.file('main.py'))} || off ${brief(off)}`, why: 'A whole def found by its header cannot come back as the same no-op span, and old_string, the text the model kept getting wrong, is no longer needed.', fix: 'runTool edit_file: replaceWholeDef under a def channel.' });
    const res = on.said.find((t) => /the whole def add/.test(t) && /was replaced/.test(t)) || '';
    check('the result names the def and its old lines', /edited main\.py: the whole def add \(lines 4-6\) was replaced/.test(res),
      { happened: res.slice(0, 200), why: 'The model should see which block moved, as a plain edit shows its lines.', fix: 'The whole-def branch of edit_file.' });
    // The switch is for the next edit only.
    const once = await run('1', files, [miss, miss, whole, blk({ tool: 'edit_file', path: 'main.py', old_string: '', new_string: 'def sub(a, b):' + NL + '    return a + b' + NL }), 'Done.', 'No check.']);
    check('the switch lasts one edit: the edit after it is read as an ordinary edit again', once.st.editWhy['empty-old'] === 1 && /def sub\(a, b\):\n    return a - b/.test(once.file('main.py')) && /return a \+ b/.test(once.file('main.py').split('def sub')[0]),
      { happened: `${brief(once)} || ${JSON.stringify(once.file('main.py'))}`, why: 'Row 5 switches the channel for the next attempt, not for the rest of the run.', fix: 'takeChannel deletes the entry it returns.' });
    // Under the switch an edit that still names its old text is an ordinary
    // edit, not a whole def: its new_string may hold only the def's first lines.
    const long = { 'main.py': 'def add(a, b):' + NL + '    x = a' + NL + '    y = b' + NL + '    return x - y' + NL };
    const lmiss = blk({ tool: 'edit_file', path: 'main.py', old_string: 'def add(a, b):' + NL + '    return a - b', new_string: 'def add(a, b):' + NL + '    return a + b' });
    const part = await run('1', long, [lmiss, lmiss, blk({ tool: 'edit_file', path: 'main.py', old_string: 'def add(a, b):' + NL + '    x = a', new_string: 'def add(a, b):' + NL + '    x = a + 0' }), 'Done.', 'No check.']);
    check('under a def switch an edit with old_string is an ordinary edit, and the rest of the def stays', part.file('main.py') === long['main.py'].replace('    x = a' + NL, '    x = a + 0' + NL) && part.st.switches === 1,
      { happened: `${brief(part)} || ${JSON.stringify(part.file('main.py'))}`, why: 'Read as a whole def, a new_string that is only the def\'s first lines replaces the whole body, and the syntax guard lets it through.', fix: 'runTool edit_file: a def channel takes a whole def only when old_string is empty.' });
    // The same whole def sent back is the no-op again, and steered as one.
    const same = await run('1', files, [miss, miss, blk({ tool: 'edit_file', path: 'main.py', old_string: '', new_string: 'def add(a, b):' + NL + '    """Add two numbers."""' + NL + '    return a - b' + NL }), 'Gave up.']);
    const sameMsg = same.said.find((t) => /you sent is what main\.py already holds/.test(t)) || '';
    check('a whole def that is the one already there is a same-text edit, and spared', loop.editFailKind(sameMsg.replace(/^Tool result for edit_file:\n/, '')) === 'same-text' && same.st.sameText === 1 && same.st.spared === 2 && /does not count/.test(sameMsg),
      { happened: `${brief(same)} || ${sameMsg.slice(0, 200)}`, why: 'Neither format can land a no-op, and the one that comes back as one is named as what it is.', fix: 'editFailKind reads the whole-def refusal as same-text.' });
  });

  await asyncSuite('same text expert', 'a repeat elsewhere switches to the whole file', async () => {
    const files = { 'sum.js': 'export function two() {' + NL + '  return 1;' + NL + '}' + NL };
    const miss = blk({ tool: 'edit_file', path: 'sum.js', old_string: 'return one;', new_string: 'return 2;' });
    const wholeFile = 'export function two() {' + NL + '  return 2;' + NL + '}' + NL;
    const on = await run('1', files, [miss, miss, blk({ tool: 'edit_file', path: 'sum.js', old_string: '', new_string: wholeFile }), 'Fixed.', 'No check.']);
    const steer = on.said.find((t) => /byte for byte/.test(t)) || '';
    check('a JavaScript file is switched to a whole-file write, and edit_file with an empty old_string then writes it', /send the whole file\. Use write_file with path "sum\.js"/.test(steer) && on.file('sum.js') === wholeFile && on.st.switches === 1 && on.st.stop.reason === 'answered',
      { happened: `${brief(on)} || ${steer.slice(-300)} || ${JSON.stringify(on.file('sum.js'))}`, why: 'CanItEdit\'s short files and anything with no def to name go whole-file, Aider\'s format with the best published well-formed rate for small models.', fix: 'channelFor returns mode file; edit_file with old_string "" writes new_string whole under it.' });
    const wrote = await run('1', files, [miss, miss, blk({ tool: 'write_file', path: 'sum.js', content: wholeFile }), blk({ tool: 'edit_file', path: 'sum.js', old_string: '', new_string: 'x' }), 'Done.', 'No check.']);
    check('write_file takes the switch too, and the edit after it is ordinary', wrote.file('sum.js') === wholeFile && wrote.st.editWhy['empty-old'] === 1 && wrote.st.switches === 1,
      { happened: `${brief(wrote)} || ${JSON.stringify(wrote.file('sum.js'))}`, why: 'The steer asks for write_file; once it is used the file is back on the ordinary channel.', fix: 'write_file calls takeChannel.' });
    // Four identical misses: the guard answers the fourth, and none of them is a
    // strike, so the run ends on its round budget, not as malformed output.
    const spin = await run('1', files, [miss, miss, miss, miss, miss], { maxToolRounds: 5, maxBadReplies: 3 });
    const spinOff = await run('0', files, [miss, miss, miss, miss, miss], { maxToolRounds: 5, maxBadReplies: 3 });
    check('identical misses are spared through the loop guard, and the round budget still ends the run', spin.st.stop.reason === 'rounds-exhausted' && spin.st.repeatEdits === 4 && spin.st.spared === 4 && spin.st.editWhy.repeated === 2 && spin.st.switches === 2 && spinOff.st.stop.reason === 'malformed-output' && spinOff.st.repeatEdits === 2,
      { happened: `${brief(spin)} || off ${brief(spinOff)}`, why: 'A repeat is not a strike, so something else must still end a model that never changes its edit: the round budget does.', fix: 'Repeats are spared in runLoop; the guard\'s answer to the fourth counts as a repeat.' });
  });

  suite('same text expert', 'finding a def by its header', () => {
    const src = [
      'import os',
      '',
      '@cache',
      '@other(1)',
      'def f(a,',
      '      b):',
      '    """Doc.',
      '',
      'no indent inside the docstring',
      '"""',
      '    return a',
      '',
      '',
      'class K:',
      '    def m(self):',
      '        return 1',
      '',
      '    def n(self):',
      '        return 2',
      '',
      'x = 1',
      '',
    ].join(NL);
    const [f] = loop.pyBlocks(src, 'f');
    check('a decorated def with a two-line header and a column-0 docstring line is one block', f && f.line === 5 && f.lastLine === 11 && src.slice(f.decoStart, f.end).startsWith('@cache') && src.slice(f.headStart, f.end).endsWith('    return a' + NL) && loop.pyBlocks(src, 'K')[0].lastLine === 19,
      { happened: JSON.stringify({ f, K: loop.pyBlocks(src, 'K')[0] }), why: 'The whole-def edit replaces exactly this span; a block cut at the docstring would leave half the old function behind.', fix: 'pyBlocks: triple-quoted strings do not end a block, bracket depth carries a header over lines.' });
    const m = loop.replaceWholeDef(src, 'def m(self):' + NL + '    return 10' + NL);
    check('a method sent at column 0 is re-based on its header\'s indentation', m && m.after.includes('    def m(self):' + NL + '        return 10' + NL + NL + '    def n') && m.kind === 'def' && m.name === 'm',
      { happened: JSON.stringify(m && m.after), why: 'A small model restates a method at column 0; written as sent, it would leave the class.', fix: 'replaceWholeDef re-bases every line from the new header\'s indent to the old one\'s.' });
    const deco = loop.replaceWholeDef(src, '@cache' + NL + 'def f(a, b):' + NL + '    return b' + NL);
    check('decorators sent with the def replace the old decorators; a name defined twice or not at all is no whole-def edit', deco && !deco.after.includes('@other(1)') && deco.after.includes('@cache' + NL + 'def f(a, b):' + NL + '    return b' + NL + NL + NL + 'class K') && loop.replaceWholeDef('def g():' + NL + '  pass' + NL + 'def g():' + NL + '  pass' + NL, 'def g():' + NL + '  return 1') === null && loop.replaceWholeDef(src, 'def nowhere():' + NL + '  pass') === null && loop.replaceWholeDef(src, 'return 1') === null,
      { happened: JSON.stringify(deco && deco.after), why: 'An edit that could land in two places, or in none, must fall back to the ordinary edit and its refusals.', fix: 'replaceWholeDef returns null unless exactly one block has the name.' });
    // A bracket or a # in a one-line string of the header is not one; read as
    // one, the block ran to the end of the file, and the whole-def edit put the
    // new def in front of the old one, which then shadowed it.
    const strs = 'def f(a="(", b="#"):' + NL + '    return 1' + NL + NL + NL + 'def g(x=")"):' + NL + '    return (2)' + NL + NL + NL + 'def h():' + NL + '    return 3' + NL;
    const sf = loop.pyBlocks(strs, 'f')[0];
    const sr = loop.replaceWholeDef(strs, 'def f(a="(", b="#"):' + NL + '    return 9' + NL);
    const open = loop.pyBlocks('def u(a,' + NL + '    return 1' + NL + NL + 'def v():' + NL + '    return 2' + NL, 'u');
    check('brackets and # inside the header\'s strings do not stretch a def, and a header that never closes is no block', sf && sf.lastLine === 2 && sr && sr.after === strs.replace('    return 1', '    return 9') && open.length === 0,
      { happened: JSON.stringify({ sf, after: sr && sr.after, open }), why: 'A block that runs past its def makes a whole-def edit drop or shadow the defs after it, and the syntax guard lets both through.', fix: 'pyBlocks: strip one-line strings before counting brackets and dropping a comment; skip a header whose brackets never close.' });
    const crlf = 'def a():\r\n    return 1\r\n\r\ndef b():\r\n    return 2\r\n';
    const cr = loop.replaceWholeDef(crlf, 'def a():\n    return 3\n');
    check('a CRLF file keeps CRLF', cr && cr.after === 'def a():\r\n    return 3\r\n\r\ndef b():\r\n    return 2\r\n',
      { happened: JSON.stringify(cr && cr.after), why: 'Files checked out on Windows are CRLF; a whole-def edit written with LF would mix line endings in one file.', fix: 'replaceWholeDef joins with the file\'s own line ending.' });
    const W = dir({ 'm.py': src, 'n.py': 'def g():' + NL + '    return 1' + NL + 'def g():' + NL + '    return 2' + NL, 'r.txt': 'text' + NL });
    const c1 = loop.channelFor(W, { tool: 'edit_file', path: 'm.py', old_string: '        return 2', new_string: '        return 3' });
    const c2 = loop.channelFor(W, { tool: 'edit_file', path: 'n.py', old_string: '    return 1', new_string: '    return 3' });
    const c3 = loop.channelFor(W, { tool: 'apply_patch', input: '*** Begin Patch' + NL + '*** Update File: r.txt' + NL + '-text' + NL + '+more' + NL + '*** End Patch' });
    const c4 = loop.channelFor(W, { tool: 'edit_file', path: 'missing.py', old_string: 'a', new_string: 'b' });
    check('the channel is the def the old text sits in, the whole file when that name is not unique or the tool is a patch, and none for a missing file', c1 && c1.mode === 'def' && c1.name === 'n' && c2 && c2.mode === 'file' && c3 && c3.mode === 'file' && c3.path === path.join(W, 'r.txt') && c4 === null,
      { happened: JSON.stringify({ c1, c2, c3, c4 }), why: 'A whole-def switch the next edit cannot land would cost the model a round to find out.', fix: 'channelFor checks the name is unique with pyBlocks.' });
    check('the key of an edit ignores the call id and nothing else', loop.editKey({ id: 'a', tool: 'edit_file', path: 'x', old_string: 'o', new_string: 'n' }) === loop.editKey({ id: 'b', tool: 'edit_file', path: 'x', old_string: 'o', new_string: 'n' }) && loop.editKey({ tool: 'edit_file', path: 'x', old_string: 'o', new_string: 'n' }) !== loop.editKey({ tool: 'edit_file', path: 'x', old_string: 'o ', new_string: 'n' }) && loop.pyHeadOf('@d' + NL + '  async def h(x):') && loop.pyHeadOf('@d' + NL + '  async def h(x):').name === 'h' && loop.chanKey('a/../b.py') === loop.chanKey('b.py'),
      { happened: loop.editKey({ id: 'a', tool: 'edit_file', path: 'x' }), why: 'Native calls carry a fresh id every time; byte for byte means the edit, not the envelope.', fix: 'editKey lists the edit fields.' });
    check('the steer without a file to switch asks for a different edit', /Read the part you mean to change and send a different edit\./.test(loop.sameTextSteer(W, { again: true, channel: null })),
      { happened: loop.sameTextSteer(W, { again: true, channel: null }), why: 'An apply_patch with no path, or an edit to a file that does not exist, has no format to switch to.', fix: 'sameTextSteer with no channel.' });
  });

  await asyncSuite('same text expert', 'the eval row and the comparison carry the share', async () => {
    const task = { id: 'st-1', name: 'same text', rounds: 8, files: { 'sum.js': 'export function two() { return 1; }' + NL, 'test.mjs': "import { two } from './sum.js';" + NL + 'process.exit(two() === 2 ? 0 : 1);' + NL, 'package.json': '{ "type": "module" }' + NL }, prompt: 'Make node test.mjs pass.', check: ['node', 'test.mjs'] };
    const replies = [
      blk({ tool: 'edit_file', path: 'sum.js', old_string: 'return 1;', new_string: 'return 1;' }),
      blk({ tool: 'edit_file', path: 'sum.js', old_string: 'return one;', new_string: 'return 2;' }),
      blk({ tool: 'read_file', path: 'test.mjs' }),
      blk({ tool: 'edit_file', path: 'sum.js', old_string: 'return one;', new_string: 'return 2;' }),
      blk({ tool: 'edit_file', path: 'sum.js', old_string: 'return 1;', new_string: 'return 2;' }),
      blk({ tool: 'shell', command: 'node test.mjs' }),
      'Fixed.',
    ];
    const once = async (flag) => {
      const before = process.env[FLAG];
      process.env[FLAG] = flag;
      try { return await evals.runSuite([task], { chat: scripted([...replies]), state: { sid: `sametext-${flag}` }, stamp: false }); } finally { if (before == null) delete process.env[FLAG]; else process.env[FLAG] = before; }
    };
    const off = await once('0');
    const on = await once('1');
    const r0 = off.results[0], r1 = on.results[0];
    check('a row counts same-text edits and repeats in both arms, and what the flag spared and switched', r0.sameText === 1 && r0.repeatEdits === 1 && r0.spared === 0 && r0.switches === 0 && r1.sameText === 1 && r1.repeatEdits === 1 && r1.spared === 2 && r1.switches === 1 && on.sameText === 1 && on.spared === 2 && on.switches === 1 && r1.pass && r0.pass,
      { happened: JSON.stringify({ off: [r0.sameText, r0.repeatEdits, r0.spared, r0.switches, r0.pass], on: [r1.sameText, r1.repeatEdits, r1.spared, r1.switches, r1.pass], report: [on.sameText, on.spared, on.switches] }), why: 'Row 5 is measured by the same-text share beside edits not applied and tokens per solve, in the control arm as much as the flagged one.', fix: 'runTask copies sameText, repeatEdits, spared and switches; runSuite sums them.' });
    const text = evals.formatCompare(evals.compare(off, on, { rng: () => 0.5, rounds: 50 }), 'base', 'arm');
    // A baseline saved before this row has no sameText, but its cause tally has
    // the same number.
    const old = { ...off, results: off.results.map(({ sameText, repeatEdits, spared, switches, ...rest }) => rest) };
    const oldText = evals.formatCompare(evals.compare(old, on, { rng: () => 0.5, rounds: 50 }), 'base', 'arm');
    const line = text.split(NL).find((l) => /same text:/.test(l)) || '';
    const oldLine = oldText.split(NL).find((l) => /same text:/.test(l)) || '';
    check('compare prints the share for both arms, reading an older report\'s cause tally', /base 1 of 3 failed edit\(s\) re-sent their own text \(33%\), 1 repeated the last failed edit;/.test(line) && /arm 1 of 3 failed edit\(s\) re-sent their own text \(33%\), 1 repeated the last failed edit, 2 not counted as a strike, 1 switched/.test(line) && /base 1 of 3 failed edit\(s\) re-sent their own text \(33%\), repeats not recorded/.test(oldLine),
      { happened: `${line} || ${oldLine}`, why: 'Row 1\'s baseline was saved before these fields; its same-text count is in editWhy and must still be set beside the arm.', fix: 'costOf falls back to editWhy[\'same-text\']; costLines prints the same text row.' });
    const summary = evals.format(on);
    check('the run summary says it too', /re-sent their own text: 1 of 3; repeated the last failed edit byte for byte: 1; not counted as a strike: 2; switched to a whole def or file: 1/.test(summary),
      { happened: summary.split(NL).filter((l) => /edit/.test(l)).join(' | '), why: 'A run read on its own should show the share without a comparison.', fix: 'The edits lines of the eval summary.' });
  });
}
