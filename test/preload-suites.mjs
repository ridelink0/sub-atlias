// flags.preloadFiles: the first request in a small project carries every file in
// full, numbered as read_file shows them, so the model does not spend its first
// rounds listing, outlining and reading them. On the 60-task screen a task is one
// to three small files and each of those rounds re-sent the whole context. Every
// case drives runLoop with a scripted model; with the flag off the first message
// must be the request alone, byte for byte, as it always was. Loaded by
// test/run.mjs.
import * as loop from '../lib/loop.mjs';
import * as settings from '../lib/settings.mjs';

export default async function preloadSuites({ asyncSuite, suite, check, core, agentMod, TMP, fs, path }) {
  const NL = String.fromCharCode(10);
  const FENCE = '`'.repeat(3);
  const blk = (o) => FENCE + 'atlias' + NL + JSON.stringify(o) + NL + FENCE;
  const FLAG = 'ATLIAS_FLAG_PRELOAD_FILES';
  const ASK = 'make two() return 2';
  let n = 0;
  const dir = (files) => {
    const d = path.join(TMP, 'preload', `p${++n}`);
    fs.mkdirSync(d, { recursive: true });
    for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); }
    return d;
  };
  const withFlag = async (flag, fn) => {
    const before = process.env[FLAG];
    if (flag == null) delete process.env[FLAG]; else process.env[FLAG] = flag;
    try { return await fn(); } finally { if (before == null) delete process.env[FLAG]; else process.env[FLAG] = before; }
  };
  // One run of a script in a fresh project; `firsts` holds the first user message
  // of each request, `calls` the model calls the run made.
  const run = (flag, files, replies, asks = [ASK]) => withFlag(flag, async () => {
    const d = dir(files);
    const script = [...replies];
    let calls = 0;
    const chat = async () => { calls++; const r = script.shift(); return { content: r === undefined ? 'out of script' : r, calls: [] }; };
    const st = agentMod.newState(d, 'ollama');
    const firsts = [];
    for (const a of asks) {
      const at = st.messages.length;
      await loop.runLoop(st, a, { chat, say: () => {}, ask: async () => true, limits: { maxToolRounds: 6, maxBadReplies: 3 } });
      firsts.push(String(st.messages[at === 0 ? 1 : at].content));
    }
    return { d, st, calls, firsts, file: (rel) => fs.readFileSync(path.join(d, rel), 'utf8') };
  });
  const SUM = 'export const two = () => 1;' + NL;
  const CHECK = "import { two } from './sum.mjs';" + NL + "if (two() !== 2) process.exit(1);" + NL;
  const PROJECT = { 'sum.mjs': SUM, 'check.mjs': CHECK };
  const fix = blk({ tool: 'edit_file', path: 'sum.mjs', old_string: '=> 1', new_string: '=> 2' });
  const own = blk({ tool: 'shell', command: 'node check.mjs' });
  const brief = (r) => JSON.stringify({ calls: r.calls, stop: r.st.stop, first: r.firsts[0].slice(0, 300) }).slice(0, 600);

  suite('preload small projects', 'the flag is registered off, described, and switched from the environment', () => {
    const row = settings.rows().find((r) => r.id === 'flags.preloadFiles');
    check('flags.preloadFiles is off by default, described, with its environment name', core.DEFAULTS.flags.preloadFiles === false && row && row.env === FLAG && /small project/.test(row.about) && /Off, the first message is the request alone/.test(row.about),
      { happened: JSON.stringify(row || null), why: 'Every behaviour change lands off, behind a key the evolution loop and the 4x screen can set per arm.', fix: 'DEFAULTS.flags in lib/core.mjs and DESCRIPTIONS in lib/settings.mjs.' });
  });

  await asyncSuite('preload small projects', 'on, the first message carries every file numbered; off, it is the request alone', async () => {
    const on = await run('1', PROJECT, [fix, own, 'Done: two() returns 2.']);
    const off = await run('0', PROJECT, [fix, own, 'Done: two() returns 2.']);
    const unset = await run(null, PROJECT, [fix, own, 'Done: two() returns 2.']);
    const shown = on.firsts[0];
    check('with the flag on the first message is the request, then both files in read_file\'s numbered view, in name order', shown.startsWith(ASK + NL + NL + 'The project is small') && shown.includes('check.mjs lines 1-2 of 2' + NL + '1\t' + "import { two } from './sum.mjs';") && shown.includes('sum.mjs lines 1-1 of 1' + NL + '1\texport const two = () => 1;') && shown.indexOf('check.mjs lines') < shown.indexOf('sum.mjs lines'),
      { happened: brief(on), why: 'The model must see exactly what read_file would have shown it, so an edit copied from it applies.', fix: 'lib/loop.mjs smallProjectFiles and the first push in runLoop.' });
    check('with the flag off or unset the first message is the request byte for byte', off.firsts[0] === ASK && unset.firsts[0] === ASK,
      { happened: JSON.stringify([off.firsts[0], unset.firsts[0]]), why: 'Stored runs were made with the request alone; the default must not move them.', fix: 'Gate the preload on flags.preloadFiles.' });
    check('the ledger keeps the request alone, not the files, in both modes', JSON.stringify(on.st.asks) === JSON.stringify([ASK]) && JSON.stringify(off.st.asks) === JSON.stringify([ASK]),
      { happened: JSON.stringify([on.st.asks, off.st.asks]), why: 'A compaction restates what was asked word for word; file text is not a request.', fix: 'Push the request, not the preloaded message, to state.asks.' });
    check('the same script still fixes the file and ends answered with the flag on', on.st.stop && on.st.stop.reason === 'answered' && /=> 2/.test(on.file('sum.mjs')) && on.calls === off.calls,
      { happened: brief(on), why: 'Showing the files must not change what the loop does with the model\'s replies.', fix: 'Only the first user message may differ.' });
  });

  await asyncSuite('preload small projects', 'only a small project is shown, and only on the first request of a session', async () => {
    const many = {}; for (let i = 0; i < 7; i++) many[`f${i}.txt`] = 'x' + NL;
    const big = { 'a.py': ('x = 1' + NL).repeat(1700) };
    const nested = { 'main.py': 'x = 1' + NL, 'src/b.py': 'y = 2' + NL };
    const binary = { 'main.py': 'x = 1' + NL, 'blob.bin': 'ab' + String.fromCharCode(0) + 'cd' };
    const skipped = { 'main.py': 'x = 1' + NL, 'node_modules/p/index.js': 'z' + NL, '.git/HEAD': 'ref' + NL, '.hidden': 'h' + NL };
    const empty = {};
    const r = {};
    for (const [k, files] of Object.entries({ many, big, nested, binary, skipped, empty })) r[k] = await run('1', files, ['done']);
    const plain = (k) => r[k].firsts[0] === ASK;
    check('seven files, over 8,000 characters, a subfolder, a binary file, or no file at all: the request alone', plain('many') && plain('big') && plain('nested') && plain('binary') && plain('empty'),
      { happened: JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.firsts[0].slice(0, 80)]))), why: 'A larger project shown whole would be paid on every call; only a tiny one pays for itself.', fix: 'smallProjectFiles returns empty past maxFiles, maxChars, a subfolder or a NUL byte.' });
    check('node_modules, .git and dot files are passed over, not a reason to show nothing', r.skipped.firsts[0].includes('main.py lines 1-1 of 1') && !r.skipped.firsts[0].includes('index.js') && !r.skipped.firsts[0].includes('.hidden') && !r.skipped.firsts[0].includes('HEAD'),
      { happened: r.skipped.firsts[0].slice(0, 300), why: 'A tool folder beside the code does not make the project large.', fix: 'Skip SKIP_DIRS and names starting with a dot.' });
    const two = await run('1', PROJECT, ['first done', 'second done'], [ASK, 'now say hello']);
    check('a second request in the same session is sent alone', two.firsts[0].includes('sum.mjs lines') && two.firsts[1] === 'now say hello',
      { happened: JSON.stringify(two.firsts.map((f) => f.slice(0, 80))), why: 'The files are already in the conversation; sending them again would double their cost.', fix: 'Preload only when the system message is the only message.' });
    const crlf = loop.smallProjectFiles(dir({ 'w.py': 'a = 1\r\nb = 2\r\n' }));
    check('Windows line ends are numbered like read_file numbers them, with no carriage return left in a line', crlf.includes('w.py lines 1-2 of 2' + NL + '1\ta = 1' + NL + '2\tb = 2') && !crlf.includes('\r'),
      { happened: JSON.stringify(crlf.slice(-60)), why: 'old_string copied from the shown text must match the file the way read_file text does.', fix: 'Split on CR LF or LF, as read_file does.' });
  });
}
