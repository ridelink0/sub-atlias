// Round five, row 1: what makes the baseline a control. Every behaviour change
// of the round is a flag, off by default, that the environment can switch per
// arm and every report names; the rows carry the ledger the later rows are
// judged on; and with every flag off the eval runner sends the model the same
// bytes and writes the same rows as the code the baseline ran on, which the
// golden fixture pins. Loaded by test/run.mjs.
import * as core from '../lib/core.mjs';
import * as settings from '../lib/settings.mjs';
import * as evals from '../lib/eval.mjs';
import * as loop from '../lib/loop.mjs';
import * as hooksMod from '../lib/hooks.mjs';
import { TASK, REPLIES, GOLDEN } from './golden.mjs';

const NL = String.fromCharCode(10);
const blk = (obj) => '```atlias' + NL + JSON.stringify(obj) + NL + '```';
// The fields the ledger added to a row and to a report. Anything else new in a
// flags-off row is a change the control did not have.
export const LEDGER_ROW = ['editsApplied', 'masked', 'rereads', 'cachedTokens', 'cachedTotal', 'sameText', 'repeatEdits', 'spared', 'switches', 'strayCalls', 'guardResets', 'redNudges'];
export const LEDGER_REPORT = ['editsApplied', 'masked', 'rereads', 'cachedTotal', 'flags', 'sameText', 'repeatEdits', 'spared', 'switches'];

// Registers flags for the length of fn, the way a round-five change will, and
// takes them out again whatever happens.
function withFlags(defs, fn) {
  const before = { ...core.DEFAULTS.flags };
  Object.assign(core.DEFAULTS.flags, defs);
  const env = Object.keys(process.env).filter((k) => k.toUpperCase().startsWith(core.FLAG_PREFIX));
  const saved = Object.fromEntries(env.map((k) => [k, process.env[k]]));
  try { return fn(); } finally {
    for (const k of Object.keys(core.DEFAULTS.flags)) if (!(k in before)) delete core.DEFAULTS.flags[k];
    for (const k of Object.keys(process.env)) if (k.toUpperCase().startsWith(core.FLAG_PREFIX) && !(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
async function withFlagsAsync(defs, fn) {
  const before = { ...core.DEFAULTS.flags };
  Object.assign(core.DEFAULTS.flags, defs);
  try { return await fn(); } finally {
    for (const k of Object.keys(core.DEFAULTS.flags)) if (!(k in before)) delete core.DEFAULTS.flags[k];
    for (const k of Object.keys(process.env)) if (k.toUpperCase().startsWith(core.FLAG_PREFIX)) delete process.env[k];
  }
}
const noFlagEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith(core.FLAG_PREFIX)));

export default async function controlSuites({ suite, asyncSuite, check, TMP, ROOT, fs, path, spawnSync }) {
  suite('flag plumbing expert', 'a round-five flag is a config key the environment can switch per arm', () => {
    withFlags({ probeFlag: false, probeLevel: 2 }, () => {
      check('a flag reads from ATLIAS_FLAG_ and its name in capitals', core.flagEnvName('probeFlag') === 'ATLIAS_FLAG_PROBE_FLAG' && core.flagEnvName('leanBrief') === 'ATLIAS_FLAG_LEAN_BRIEF',
        { happened: `${core.flagEnvName('probeFlag')} ${core.flagEnvName('leanBrief')}`, why: 'The study scripts on the PC set these names per arm; a name they cannot predict is a flag that never switches.', fix: 'flagEnvName turns camelCase into UPPER_SNAKE after ATLIAS_FLAG_.' });
      const e = core.envFlags({ atlias_flag_probe_flag: '"1"\r', ATLIAS_FLAG_PROBE_LEVEL: ' 5 ', ATLIAS_FLAG_PROB_FLAG: '1', PATH: '/bin' });
      check('the environment is read the way Windows hands it over: any case, quoted, with a carriage return', e.values.probeFlag === true && e.values.probeLevel === 5 && e.raw.ATLIAS_FLAG_PROBE_FLAG === '1',
        { happened: JSON.stringify(e), why: 'Windows keeps environment names without regard to case, cmd\'s set NAME="1" keeps the quotes, and a value from a CRLF file keeps its \\r; each would otherwise leave the arm running as the control.', fix: 'envFlags matches names in capitals, trims, and strips one pair of quotes.' });
      check('a misspelt flag is reported, not ignored', JSON.stringify(e.unknown) === JSON.stringify(['ATLIAS_FLAG_PROB_FLAG']),
        { happened: JSON.stringify(e.unknown), why: 'An arm with a misspelt flag runs as the control and is scored as the change.', fix: 'envFlags lists every ATLIAS_FLAG_ name that is no flag.' });
      const bad = core.envFlags({ ATLIAS_FLAG_PROBE_FLAG: 'maybe', ATLIAS_FLAG_PROBE_LEVEL: 'lots' });
      check('a value that does not parse is reported and not applied', bad.bad.length === 2 && !('probeFlag' in bad.values) && !('probeLevel' in bad.values),
        { happened: JSON.stringify(bad), why: 'maybe is neither on nor off; guessing either way runs an arm nobody asked for.', fix: 'envFlags takes 1/0, true/false, on/off, yes/no for a boolean and parseSetting for the rest.' });
      const off = ['0', 'false', 'off', 'no', ''].map((v) => core.envFlags({ ATLIAS_FLAG_PROBE_FLAG: v }).values.probeFlag);
      check('every spelling of off is off', off.every((v) => v === false), { happened: JSON.stringify(off), why: 'The control arm sets its flags off explicitly; any of these must read as off.', fix: 'Check FLAG_OFF in core.' });

      const set = settings.set('flags.probeFlag', 'true');
      const fromConfig = core.config().flags.probeFlag;
      const stampConfig = core.flagStamp();
      process.env.ATLIAS_FLAG_PROBE_FLAG = '0';
      const envWins = core.config().flags.probeFlag;
      process.env.ATLIAS_FLAG_PROBE_FLAG = '1';
      settings.reset('flags.probeFlag');
      const stampEnv = core.flagStamp();
      check('a flag is a config key, and the environment wins over config.json', set.ok && fromConfig === true && envWins === false && core.config().flags.probeFlag === true,
        { happened: JSON.stringify({ set, fromConfig, envWins }), why: 'The PC switches arms by environment on one install; a config.json left over from a hand test must not decide the arm.', fix: 'config() applies envFlags().values over the flags section last.' });
      check('the stamp says which flags are on and where each came from', stampConfig.from.probeFlag === 'config.json' && stampEnv.from.probeFlag === 'ATLIAS_FLAG_PROBE_FLAG' && JSON.stringify(stampEnv.changed) === JSON.stringify(['probeFlag']) && stampEnv.values.probeLevel === 2,
        { happened: JSON.stringify({ stampConfig, stampEnv }), why: 'A report that names its flags is the only way a RESULT can say which arm it measured.', fix: 'Check flagStamp.' });
      check('the one-line form names the flag and its source, and says when nothing was recorded', /probeFlag=true \(ATLIAS_FLAG_PROBE_FLAG\)/.test(core.flagLine(stampEnv)) && core.flagLine(null) === 'not recorded' && /none set/.test(core.flagLine(core.flagStamp({ flags: {} }, {}))) && /ATLIAS_FLAG_X names no flag/.test(core.flagLine({ values: {}, changed: [], unknown: ['ATLIAS_FLAG_X'], bad: [] })),
        { happened: `${core.flagLine(stampEnv)} | ${core.flagLine(null)}`, why: 'Compare and the report header print this line; a report from before flags must not read as "none set".', fix: 'Check flagLine.' });
      const row = settings.rows().find((r) => r.id === 'flags.probeFlag');
      check('atlias settings lists a flag with the variable that sets it for one run', row && row.env === 'ATLIAS_FLAG_PROBE_FLAG' && /for one run: ATLIAS_FLAG_PROBE_FLAG=1/.test(settings.format([{ ...row, about: 'probe' }])),
        { happened: JSON.stringify(row), why: 'A flag nobody can find is switched by editing config.json, which is exactly what an arm must not depend on.', fix: 'rows() carries env for the flags section and format() prints it.' });
    });
    check('no flag is registered without saying what it does', Object.keys(core.DEFAULTS.flags).every((k) => settings.DESCRIPTIONS[`flags.${k}`]) && Object.values(core.DEFAULTS.flags).every((v) => v === false || v === 0 || v === ''),
      { happened: JSON.stringify(core.DEFAULTS.flags), why: 'The merge rule: every behaviour change lands off by default, and every option says what it does.', fix: 'Register the flag off, and describe it in DESCRIPTIONS.' });
  });

  await asyncSuite('flag plumbing expert', 'every report names its flags, and an arm with a bad flag does not start', async () => {
    const quiet = async () => ({ content: 'Nothing done.' });
    const task = { id: 'flag-stamp', name: 'flag stamp', rounds: 2, files: {}, prompt: 'Do nothing.', check: ['node', '-e', 'process.exit(1)'] };
    const rep = await withFlagsAsync({ probeFlag: false }, async () => {
      process.env.ATLIAS_FLAG_PROBE_FLAG = '1';
      return evals.runSuite([task], { chat: quiet, stamp: false });
    });
    for (const r of rep.results) if (r.workspace) { try { fs.rmSync(r.workspace, { recursive: true, force: true }); } catch { /* temp */ } }
    check('a saved report carries the flags its run had, and the header prints them', rep.flags && JSON.stringify(rep.flags.changed) === JSON.stringify(['probeFlag']) && /^flags: probeFlag=true \(ATLIAS_FLAG_PROBE_FLAG\)$/m.test(evals.format(rep)),
      { happened: JSON.stringify(rep.flags) + ' | ' + evals.format(rep).split(NL).filter((l) => /flags/.test(l)).join(' '), why: 'Every row of the round-five plan is an arm named by its flags; a report that does not carry them cannot be one.', fix: 'runSuite stamps flagStamp(); format prints flagLine.' });
    const bin = path.join(ROOT, 'bin', 'atlias.mjs');
    const env = { ...noFlagEnv(), ATLIAS_FLAG_NOT_A_FLAG: '1' };
    const refused = spawnSync(process.execPath, [bin, 'eval', '--engine', 'echo', 'add-function', '--outlive-parent'], { encoding: 'utf8', env, timeout: 60000 });
    check('atlias eval refuses to start an arm whose flag names no flag', refused.status === 2 && /ATLIAS_FLAG_NOT_A_FLAG names no flag/.test(refused.stdout) && /Nothing ran/.test(refused.stdout) && !/bFAILb|bPASSb/.test(refused.stdout),
      { happened: `exit ${refused.status}: ${(refused.stdout || refused.stderr).slice(0, 300)}`, why: 'A typo in a study script would otherwise run hours of the control and file it as the change.', fix: 'The eval command checks flagStamp().unknown and .bad before the first task.' });
    const ran = spawnSync(process.execPath, [bin, 'eval', '--engine', 'echo', 'add-function', '--outlive-parent'], { encoding: 'utf8', env: noFlagEnv(), timeout: 60000 });
    const said = String(ran.stdout || '');
    check('and names the flags of a run it does start, before the first task', ran.status === 1 && /flags: none set, every flag at its default/.test(said) && said.indexOf('flags: ') >= 0 && said.indexOf('flags: ') < said.indexOf('ran with:'),
      { happened: `exit ${ran.status}: ${(ran.stdout || ran.stderr).slice(0, 300)}`, why: 'The control says it had no flag, in words, so a RESULT can quote it.', fix: 'The eval command prints flagLine before the run.' });
    // --resume carries on a saved run; rows another arm wrote are not its rows.
    const saved = path.join(TMP, 'flag-resume.json');
    fs.writeFileSync(saved, JSON.stringify({ partial: true, results: [], engine: 'echo', model: '', tries: 1, flags: { values: { probeFlag: true }, changed: ['probeFlag'], from: { probeFlag: 'ATLIAS_FLAG_PROBE_FLAG' }, env: {}, unknown: [], bad: [] } }));
    const mixed = spawnSync(process.execPath, [bin, 'eval', '--engine', 'echo', 'add-function', '--outlive-parent', '--save', saved, '--resume'], { encoding: 'utf8', env: noFlagEnv(), timeout: 60000 });
    check('--resume will not add rows to a report another arm wrote', mixed.status === 2 && /ran with flags probeFlag=true .*Refusing to mix them/.test(mixed.stdout) && JSON.parse(fs.readFileSync(saved, 'utf8')).results.length === 0,
      { happened: `exit ${mixed.status}: ${(mixed.stdout || mixed.stderr).slice(-300)}`, why: 'A resumed run that mixes two arms\' rows is a report of neither arm.', fix: 'The --resume check compares the saved flags.values with flagStamp().values.' });
    // A flag registered after a run was saved is off in it, so a later run with
    // every flag off is the same arm; here the saved run knew a flag this code
    // no longer has, left at its default.
    const earlier = path.join(TMP, 'flag-resume-earlier.json');
    fs.writeFileSync(earlier, JSON.stringify({ partial: true, results: [], engine: 'echo', model: '', tries: 1, flags: { values: { retiredFlag: false }, changed: [], from: {}, env: {}, unknown: [], bad: [] } }));
    const carried = spawnSync(process.execPath, [bin, 'eval', '--engine', 'echo', 'add-function', '--outlive-parent', '--save', earlier, '--resume'], { encoding: 'utf8', env: noFlagEnv(), timeout: 60000 });
    check('--resume carries on a run whose flags were all at their default, whichever flags each code registered', carried.status !== 2 && !/Refusing to mix/.test(carried.stdout) && /--resume: nothing to carry on from/.test(carried.stdout),
      { happened: `exit ${carried.status}: ${(carried.stdout || carried.stderr).slice(0, 300)}`, why: 'Rows 4 to 8 each register a flag, off; a baseline saved before one of them is still the control, and refusing it says "none set" against "none set".', fix: 'The --resume check uses core.sameFlags, which compares the flags both stamps know and requires any other to be at its default.' });
    // The hooks run inside Claude Code in the environment it was started in; a
    // session says in atlias's log which flags it ran with.
    const home = path.join(TMP, 'flag-hook-home');
    fs.mkdirSync(home, { recursive: true });
    const hook = spawnSync(process.execPath, [path.join(ROOT, 'lib', 'hooks.mjs'), 'session-start'], { input: JSON.stringify({ session_id: 'flag-hook', cwd: TMP, source: 'startup' }), encoding: 'utf8', env: { ...noFlagEnv(), ATLIAS_HOME: home, ATLIAS_FLAG_NOT_A_FLAG: '1' }, timeout: 60000 });
    const logged = fs.existsSync(path.join(home, 'log.txt')) ? fs.readFileSync(path.join(home, 'log.txt'), 'utf8') : '';
    check('a hooked session logs the flags it ran with, a wrong one included', hook.status === 0 && /session-start flag-hook flags: .*ATLIAS_FLAG_NOT_A_FLAG names no flag/.test(logged) && typeof hooksMod.dispatch === 'function',
      { happened: `exit ${hook.status}; log: ${logged.slice(0, 300)}`, why: 'In a Claude Code arm nothing else records which flags the hooks saw; the log is what the PC can check after the run.', fix: 'hooks.mjs logs flagLine(flagStamp()) at session-start when any flag is in play.' });
  });

  await asyncSuite('ledger expert', 'a row counts landed edits, masked results, re-reads and cached tokens', async () => {
    // The view and the ledger agree on what was masked.
    const obs = (i) => ({ role: 'user', content: `r${i}`, _obs: { label: `read_file f${i}`, summary: 's' } });
    const msgs = [{ role: 'system', content: 's' }, ...Array.from({ length: 9 }, (_, i) => obs(i))];
    const idx = loop.maskedIndices(msgs, 4, 4);
    const v = loop.view(msgs, 4, 4);
    const elided = v.map((m, i) => (/elided/.test(m.content) ? i : -1)).filter((i) => i >= 0);
    check('the ledger masks exactly what the view masks', JSON.stringify([...idx]) === JSON.stringify(elided) && elided.length === 4,
      { happened: `${JSON.stringify([...idx])} vs ${JSON.stringify(elided)}`, why: 'A count of masked results taken from a second rule would count a different set from the one the model was handed.', fix: 'view() takes its set from maskedIndices().' });
    const t = (c) => loop.callTarget('/w', c);
    check('asking again means the same file for a read, the same command for the shell, never an edit', t({ tool: 'read_file', path: 'a.js' }) === t({ tool: 'read_file', path: './a.js', offset: 5, limit: 3 }) && t({ tool: 'read_file', path: 'a.js' }) !== t({ tool: 'read_file', path: 'b.js' }) && t({ tool: 'shell', command: 'npm test' }) === t({ tool: 'shell', command: ['npm', 'test'] }) && t({ tool: 'edit_file', path: 'a.js' }) === null && t({ tool: 'grep', pattern: 'x', id: '1' }) === t({ tool: 'grep', pattern: 'x', id: '2' }),
      { happened: JSON.stringify([t({ tool: 'read_file', path: 'a.js' }), t({ tool: 'shell', command: ['npm', 'test'] }), t({ tool: 'edit_file', path: 'a.js' })]), why: 'A re-read of another range of a masked file is the cost masking caused; an edit after it is not.', fix: 'Check callTarget.' });
    const st = { cwd: '/w' };
    const m1 = { role: 'user', content: 'x' };
    loop.ledgerResult(st, m1, t({ tool: 'read_file', path: 'a.js' }));
    const targets = loop.ledgerRound(st, [m1], new Set([0]));
    loop.ledgerRound(st, [m1], new Set([0]));
    loop.ledgerCall(st, targets, t({ tool: 'read_file', path: 'a.js', offset: 2 }));
    loop.ledgerCall(st, targets, t({ tool: 'read_file', path: 'b.js' }));
    loop.ledgerCall(st, targets, t({ tool: 'edit_file', path: 'a.js' }));
    check('a result masked twice counts once, and only a call for what it held is a re-read', st.ledger.masked === 1 && st.ledger.rereads === 1,
      { happened: JSON.stringify(st.ledger), why: 'The count is results the model lost, not rounds it lost them in.', fix: 'ledgerRound keeps the set of results already counted.' });

    // End to end on the golden task: the re-read of a masked sum.js counts; a
    // read of a file no masked result held, or a command whose result was
    // still whole, does not.
    const run = async (replies, usage) => {
      let i = 0;
      const chat = async () => { const n = i++; return { content: replies[Math.min(n, replies.length - 1)], ...(usage ? { usage: usage(n) } : {}) }; };
      const r = await evals.runTask(TASK, { chat, state: {}, stamp: `ledger-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
      if (r.workspace) { try { fs.rmSync(r.workspace, { recursive: true, force: true }); } catch { /* temp */ } }
      return r;
    };
    const cfg = core.config().agent;
    const golden = await run(REPLIES);
    const other = await run(REPLIES.map((r, i) => (i === 8 ? blk({ tool: 'read_file', path: 'missing.js' }) : r)));
    const whole = await run(REPLIES.map((r, i) => (i === 8 ? blk({ tool: 'shell', command: 'node test.mjs' }) : r)));
    const defaults = cfg.keepObservations === 4 && cfg.evictBlock === 4;
    check('the golden task counts one landed edit, four masked results and one re-read', !defaults || (golden.pass && golden.editsApplied === 1 && golden.masked === 4 && golden.rereads === 1 && other.rereads === 0 && whole.rereads === 0),
      { happened: JSON.stringify({ golden: [golden.editsApplied, golden.masked, golden.rereads], other: other.rereads, whole: whole.rereads, keep: cfg.keepObservations }), why: 'These are the numbers row 1 reads beside the pass rate; a count that fires on the wrong call measures nothing.', fix: 'runLoop calls ledgerRound before each request, ledgerCall per call and ledgerResult per result; runTask copies st.ledger.' });

    const shapes = {
      anthropic: () => ({ input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 5 }),
      openai: () => ({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 64 }, completion_tokens: 3 }),
      silent: () => ({ prompt_tokens: 100, completion_tokens: 3 }),
    };
    const once = ['Nothing to do.'];
    const got = {};
    for (const [k, u] of Object.entries(shapes)) got[k] = await run(once, u);
    check('cached prompt tokens are carried in the Anthropic and OpenAI shapes, and silence stays null', JSON.stringify(got.anthropic.cachedTokens) === '[90]' && got.anthropic.cachedTotal === 90 && got.anthropic.promptTotal === 100 && got.openai.cachedTotal === 64 && JSON.stringify(got.silent.cachedTokens) === '[null]' && got.silent.cachedTotal === null,
      { happened: JSON.stringify(Object.fromEntries(Object.entries(got).map(([k, r]) => [k, [r.cachedTokens, r.cachedTotal, r.promptTotal]]))), why: 'A cached token bills at a tenth of the rest on the Claude API, so a prompt total alone overstates the fixed text; and a silent engine counted as zero cached would be a measurement nobody took.', fix: 'runLoop pushes cacheReading().cached (or null) to state.cacheLog; runTask sums it into cachedTotal.' });

    const rep = await evals.runSuite([TASK], { chat: (() => { let i = 0; return async () => ({ content: REPLIES[Math.min(i++, REPLIES.length - 1)], usage: { prompt_eval_count: 100, prompt_eval_cached_count: 50 } }); })(), stamp: false });
    for (const r of rep.results) if (r.workspace) { try { fs.rmSync(r.workspace, { recursive: true, force: true }); } catch { /* temp */ } }
    const text = evals.format(rep);
    check('the report sums the ledger and prints it', rep.editsApplied === rep.results[0].editsApplied && rep.masked === rep.results[0].masked && rep.cachedTotal === 50 * REPLIES.length && /of it from the engine's cache/.test(text) && (!defaults || /^masking: 4 tool result\(s\) handed to the model as a one-line note, 1 call\(s\) that asked again/m.test(text)),
      { happened: text.split(NL).filter((l) => /cache|masking/.test(l)).join(' | '), why: 'A number only in the JSON is a number nobody reads at the end of a run.', fix: 'runSuite sums editsApplied, masked, rereads and cachedTotal; format prints them.' });
  });

  suite('ledger expert', 'compare carries the ledger and the flags of both arms', () => {
    const row = (id, pass, extra) => ({ id, pass, ...extra });
    const old = { results: [row('t1', true, { editTries: 5, editFails: 2, promptTotal: 1000 }), row('t2', false, { editTries: 1, editFails: 1, promptTotal: 500 })] };
    const stamp = { values: { probeFlag: true }, changed: ['probeFlag'], from: { probeFlag: 'ATLIAS_FLAG_PROBE_FLAG' }, env: {}, unknown: [], bad: [] };
    const now = { flags: stamp, results: [row('t1', true, { editTries: 4, editFails: 0, editsApplied: 4, masked: 3, rereads: 1, promptTotal: 1000, cachedTotal: 900 }), row('t2', true, { editTries: 2, editFails: 1, editsApplied: 1, masked: 0, rereads: 0, promptTotal: 800, cachedTotal: 0 })] };
    const c = evals.compare(old, now, { rng: () => 0.5, rounds: 50 });
    check('an old report\'s landed edits are derived, and what it never counted is null', c.cost.a.editsApplied === 3 && c.cost.a.masked === null && c.cost.a.cachedTokens === null && c.cost.b.editsApplied === 5 && c.cost.b.masked === 3 && c.cost.b.rereads === 1 && c.cost.b.cachedTokens === 900,
      { happened: JSON.stringify({ a: c.cost.a, b: c.cost.b }), why: 'Row 1 compares against runs saved before the ledger; a zero where nothing was counted would read as a measurement.', fix: 'costOf derives editsApplied from editTries - editFails and sums the rest with has().' });
    const text = evals.formatCompare(c, 'base', 'arm');
    check('the comparison prints the ledger, the cached share and each arm\'s flags', /ledger: base 3 edit\(s\) applied, masking not recorded; arm 5 edit\(s\) applied, 3 result\(s\) masked, 1 asked for again\./.test(text) && /served from the engine's cache: base not recorded; arm 1k \(50%\)/.test(text) && /Flags: base not recorded; arm probeFlag=true \(ATLIAS_FLAG_PROBE_FLAG\)\./.test(text),
      { happened: text.split(NL).filter((l) => /ledger|cache|Flags/.test(l)).join(' | '), why: 'The comparison is what a RESULT comment quotes; a number it does not print is not in the result.', fix: 'costLines prints the ledger and cache rows; formatCompare prints flagLine for both.' });
    const same = evals.formatCompare(evals.compare({ ...now }, { ...now }, { rng: () => 0.5, rounds: 50 }), 'x', 'y');
    const mini = evals.formatCompare(evals.compare({ results: [row('t1', true, { promptTotal: 5 })] }, { results: [row('t1', true, { promptTotal: 5 })] }, { rng: () => 0.5, rounds: 50 }), 'x', 'y');
    const stampOf = (values, changed) => ({ values, changed, from: {}, env: {}, unknown: [], bad: [] });
    const later = (flags) => evals.formatCompare(evals.compare({ ...now, flags: stampOf({}, []) }, { ...now, flags }, { rng: () => 0.5, rounds: 50 }), 'base', 'arm');
    check('a baseline saved before a flag existed and a later run with it off have the same flags; with it on they do not', /Both runs had the same flags/.test(later(stampOf({ probeFlag: false }, []))) && !/Both runs had the same flags/.test(later(stampOf({ probeFlag: true }, ['probeFlag']))) && core.sameFlags(stampOf({ a: false }, []), stampOf({ b: 0 }, [])) && !core.sameFlags(stampOf({ a: false }, []), stampOf({ a: true }, ['a'])) && !core.sameFlags(null, stampOf({}, [])),
      { happened: later(stampOf({ probeFlag: false }, [])).split(NL).filter((l) => /flags/i.test(l)).join(' | '), why: 'Every later arm is compared with row 1\'s baseline, saved before its flag was registered; the flags-off rerun of that arm must read as the control, not as a different configuration.', fix: 'formatCompare uses core.sameFlags: flags both stamps know must match, and one only a stamp knows must be at its default there.' });
    check('two runs with the same flags say so, and a harness with no ledger prints no ledger row', /Both runs had the same flags/.test(same) && !/ledger:/.test(mini) && !/Flags:/.test(mini),
      { happened: `${same.split(NL).filter((l) => /flags/i.test(l)).join(' | ')} || ${mini.split(NL).filter((l) => /ledger|Flags/.test(l)).join(' | ')}`, why: 'A rerun of the control against itself is the noise floor, and should read as that.', fix: 'formatCompare compares the two stamps\' values.' });
  });

  suite('control expert', 'with every flag off the runner sends and writes what the baseline did', () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    const script = path.join(ROOT, 'test', 'golden.mjs');
    const runIt = (env) => {
      const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
      try { return { out: r.stdout, fp: JSON.parse(r.stdout) }; } catch { return { out: r.stdout, fp: null, err: `exit ${r.status}: ${(r.stderr || '').slice(0, 400)}` }; }
    };
    const plain = runIt(noFlagEnv());
    // The pair below registers goldenProbe (test/golden.mjs), a flag nothing
    // reads, so the zero is parsed even while no real flag exists yet.
    const probeEnv = { ...noFlagEnv(), ATLIAS_GOLDEN_PROBE: '1' };
    const unset = runIt(probeEnv);
    const off = runIt({ ...probeEnv, ...Object.fromEntries([...Object.keys(core.DEFAULTS.flags), 'goldenProbe'].map((k) => [core.flagEnvName(k), '0'])) });
    // The stamp records the variables it was handed, so the explicit zeros show
    // there and nowhere else.
    const sansEnv = (fp) => fp && JSON.stringify(fp, (k, v) => (k === 'env' && v && typeof v === 'object' && !Array.isArray(v) ? undefined : v));
    check('the fingerprint runs', plain.fp && golden.scripted && golden.echo, { happened: plain.err || 'no fixture', why: 'A golden test that cannot run proves nothing.', fix: 'Run node test/golden.mjs and read its error.' });
    if (!plain.fp) return;
    const firstDiff = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
    for (const name of Object.keys(golden)) {
      const want = golden[name];
      const got = plain.fp[name] || { requests: [], row: {}, report: {} };
      const bad = want.requests.map((r, i) => (got.requests[i] === r ? -1 : i)).filter((i) => i >= 0);
      const at = bad.length ? firstDiff(want.requests[bad[0]], got.requests[bad[0]] || '') : 0;
      check(`${name}: every request is byte for byte the baseline's`, got.requests.length === want.requests.length && bad.length === 0,
        { happened: `${got.requests.length} requests against ${want.requests.length}; first differing request ${bad[0]} at character ${at}: baseline ${JSON.stringify((want.requests[bad[0]] || '').slice(Math.max(0, at - 60), at + 80))} now ${JSON.stringify((got.requests[bad[0]] || '').slice(Math.max(0, at - 60), at + 80))}`, why: 'Row 1\'s baseline runs are the control for every later arm only while the code with its flags off asks the model exactly what that code asked. A difference here means a change landed without a flag, and the control is gone.', fix: 'Put the change behind a flag in DEFAULTS.flags. If the change to flags-off behaviour is meant, re-record with node test/golden.mjs --write and say in the commit that the baseline must be re-run.' });
      for (const part of ['row', 'report']) {
        // The report's flag stamp is the same configuration by core.sameFlags,
        // the rule --resume and compare use: a flag registered since the
        // fixture was recorded, left at its default, is no difference.
        const same = (k) => (part === 'report' && k === 'flags' ? core.sameFlags(want[part][k], got[part][k]) : JSON.stringify(want[part][k]) === JSON.stringify(got[part][k]));
        const moved = Object.keys(want[part]).filter((k) => !same(k));
        const allowed = part === 'row' ? LEDGER_ROW : LEDGER_REPORT;
        const added = Object.keys(got[part]).filter((k) => !(k in want[part]) && !allowed.includes(k));
        check(`${name}: the ${part} holds every baseline field unchanged, and nothing new but the ledger`, moved.length === 0 && added.length === 0,
          { happened: `changed ${moved.map((k) => `${k}: ${JSON.stringify(want[part][k]).slice(0, 80)} -> ${JSON.stringify(got[part][k]).slice(0, 80)}`).join('; ') || 'none'}; new ${added.join(', ') || 'none'}`, why: 'compare pairs these rows with the baseline\'s; a field that moved with the flags off is a difference no flag explains.', fix: 'Find the change that moved it and put it behind a flag, or add a new ledger field to LEDGER_ROW or LEDGER_REPORT in test/control-suites.mjs.' });
      }
    }
    const s = plain.fp.scripted.row;
    check('the scripted row carries the ledger', s.editsApplied === 1 && s.masked === 4 && s.rereads === 1 && s.cachedTotal === 17820 && s.cachedTokens.length === 13 && plain.fp.echo.row.cachedTotal === null,
      { happened: JSON.stringify({ editsApplied: s.editsApplied, masked: s.masked, rereads: s.rereads, cachedTotal: s.cachedTotal }), why: 'These are the fields row 1 lands for the later rows to be judged on.', fix: 'Check runTask and the ledger in runLoop.' });
    check('every flag set off from the environment gives the same bytes as no flag at all', Boolean(unset.fp && off.fp) && sansEnv(off.fp) === sansEnv(unset.fp) && Object.keys(off.fp.scripted.report.flags.env).length === Object.keys(core.DEFAULTS.flags).length + 1,
      { happened: `${Object.keys(core.DEFAULTS.flags).length} flag(s) registered and the probe; outputs differ at character ${firstDiff(sansEnv(off.fp) || '', sansEnv(unset.fp) || '')}; ${unset.err || off.err || ''}`, why: 'The control arm on the PC sets its flags to 0 explicitly; that must be the baseline, not a third configuration.', fix: 'A flag set to 0 must take the same path as a flag not set.' });
  });
}
