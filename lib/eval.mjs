// Task evaluation: does the harness actually finish work?
//
// lib/bench.mjs measures what atlias costs. Nothing measured whether a task
// was completed, which is the number every public benchmark reports and the
// one that decides whether a change to the loop helped or hurt. The public
// suites (SWE-bench Lite, Terminal-Bench) each start a prebuilt container per
// instance, and there is no Docker on this machine, so this runs the same idea
// locally: a task writes its own files into a scratch workspace, the agent
// works, and then a command decides.
//
// The rule that makes it worth anything: the model's claim never scores the
// task. Only the check command does, and its exit code is the whole verdict.
//
// Three things guard that rule, because an exit code on its own is easy to
// buy. A score is stamped with the code that produced it, so a number can be
// placed afterwards. A task can be run more than once, because one run of a
// sampling process is not a result. And the files that do the grading are
// compared against what the task shipped, so a pass bought by rewriting the
// checker is reported as what it is rather than counted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ensureDir, run, flagStamp, flagLine, sameFlags } from './core.mjs';
import * as loop from './loop.mjs';
import * as integrity from './integrity.mjs';
import * as proc from './proc.mjs';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TASKS_DIR = path.join(ROOT, 'evals');

export function loadTasks(dir = TASKS_DIR) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (t && t.id && t.prompt && t.check) out.push(t);
    } catch { /* a corrupt task file is skipped, not fatal */ }
  }
  return out;
}

// Where the scratch workspaces go: --work (passed in as a path), then
// ATLIAS_EVAL_DIR, then the agent.evalDir setting, then an atlias-evals folder
// in the system temp folder. It used to be ~/.atlias/evals, a folder that on
// this machine had been locked against new subfolders, and every main-tier run
// died on its first mkdir with a stack trace.
export function workRoot(override = '') {
  const pick = String(override || process.env.ATLIAS_EVAL_DIR || config().agent.evalDir || '').trim();
  return path.resolve(pick || path.join(os.tmpdir(), 'atlias-evals'));
}

// Can a workspace be made there? Asked once before a run starts, so a folder
// that refuses gets one sentence and the fix instead of a crash at task one.
export function workRootProblem(root = workRoot()) {
  const probe = path.join(root, `.probe-${process.pid}-${Date.now()}`);
  try {
    ensureDir(probe);
    fs.writeFileSync(path.join(probe, 'x'), 'x');
    fs.rmSync(probe, { recursive: true, force: true });
    return null;
  } catch (e) {
    try { fs.rmSync(probe, { recursive: true, force: true }); } catch { /* it was never made */ }
    return `atlias eval cannot make its workspaces in ${root} (${e && e.code ? e.code : 'error'}: ${e && e.message ? e.message : e}). Point it somewhere writable with --work <dir>, ATLIAS_EVAL_DIR, or: atlias config set agent.evalDir <dir>`;
  }
}

// One workspace per run, never the user's own tree: an eval that edits the
// project it is measuring would be measuring itself.
export function makeWorkspace(task, stamp, root = workRoot()) {
  const dir = path.join(root, `${task.id}-${stamp}`);
  ensureDir(dir);
  for (const [rel, body] of Object.entries(task.files || {})) {
    const p = path.join(dir, rel);
    ensureDir(path.dirname(p));
    fs.writeFileSync(p, String(body));
  }
  return dir;
}

// Which code produced a score. A number with no sha behind it cannot be
// placed a week later, and the loop moves fast enough that the distinction
// matters within a single day. A tree with uncommitted changes to the files
// that decide how a run behaves is stamped dirty rather than stamped with a
// sha that does not describe what ran, and a machine with no git says
// unstamped rather than guessing.
export const STAMP_FILES = ['lib/eval.mjs', 'lib/loop.mjs'];
export function harnessStamp(root = ROOT, files = STAMP_FILES) {
  let version = '';
  try { version = String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || ''); } catch { version = ''; }
  const name = version ? `atlias ${version}` : 'atlias';
  let r = null;
  // The first git call in a cold process on a loaded machine can take seconds:
  // at a five-second timeout this quietly returned "unstamped" on a machine
  // that has git, which is the failure this whole function exists to prevent.
  // So the budget is generous, and a timeout says so rather than looking like
  // a machine with no git at all.
  try { r = run('git', ['log', '-1', '--format=%h', '--', ...files], { cwd: root, timeout: 20000 }); } catch (e) { r = { status: null, error: e && e.message ? e.message : String(e) }; }
  const sha = r && r.status === 0 ? String(r.stdout || '').trim().split('\n')[0].trim() : '';
  if (!sha) {
    const why = r && r.error ? r.error : r && r.status === null ? 'git did not answer in time' : 'git found no commit for these files';
    return { version, sha: '', dirty: false, dirtyFiles: [], why, text: `${name}, unstamped (${why})` };
  }
  let dirtyFiles = [];
  try {
    const d = run('git', ['status', '--porcelain', '--', ...files], { cwd: root, timeout: 20000 });
    if (d && d.status === 0) dirtyFiles = String(d.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^\S+\s+/, ''));
    else dirtyFiles = ['(git could not say)'];
  } catch { dirtyFiles = ['(git could not say)']; }
  return { version, sha, dirty: dirtyFiles.length > 0, dirtyFiles, text: `${name} @ ${sha}${dirtyFiles.length ? '-dirty' : ''}` };
}

// The files the model must not touch. A task may name them; by default it is
// every seeded file the check command runs, because a harness that lets the
// model rewrite its own checker measures the model's nerve, not its work.
export function protectedFiles(task) {
  if (Array.isArray(task.protect)) return task.protect;
  const argv = Array.isArray(task.check) ? task.check : String(task.check || '').split(/\s+/).filter(Boolean);
  const want = new Set(argv.map((a) => String(a).replace(/^\.[\\/]/, '')));
  return Object.keys(task.files || {}).filter((f) => want.has(f));
}

// A line-level diff by multiset, which is all findWeakenedTests needs: it asks
// which lines appeared and which went away, not where they moved to.
function lineDiff(beforeText, afterText, file) {
  const before = String(beforeText).split('\n');
  const after = String(afterText).split('\n');
  const left = new Map();
  for (const t of before) left.set(t, (left.get(t) || 0) + 1);
  const added = [];
  after.forEach((t, i) => {
    const n = left.get(t) || 0;
    if (n > 0) left.set(t, n - 1);
    else if (t.trim()) added.push({ file, line: i + 1, text: t });
  });
  const removed = [];
  before.forEach((t, i) => {
    const n = left.get(t) || 0;
    if (n > 0 && t.trim()) { left.set(t, n - 1); removed.push({ file, line: i + 1, text: t }); }
  });
  return { added, removed };
}

// Did the pass come from the work or from the grader? ImpossibleBench's
// question, and it has to be part of the verdict rather than a footnote: a
// check that only runs after the checker was rewritten is not a check.
export function tamper(dir, task) {
  const files = [];
  let added = [], removed = [];
  for (const rel of protectedFiles(task)) {
    const seeded = String((task.files || {})[rel] == null ? '' : (task.files || {})[rel]);
    let now = null;
    try { now = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { now = null; }
    if (now === null) {
      files.push({ file: rel, what: 'deleted' });
      removed = removed.concat(lineDiff(seeded, '', rel).removed);
      continue;
    }
    if (now === seeded) continue;
    files.push({ file: rel, what: 'edited' });
    const d = lineDiff(seeded, now, rel);
    added = added.concat(d.added);
    removed = removed.concat(d.removed);
  }
  return { files, weakened: files.length ? integrity.findWeakenedTests(added, removed) : [] };
}

// How much of the check passed, when the check is a runner that says so. The
// verdict stays all-or-nothing - a task is finished or it is not - but on a
// corpus where a small model scores zero, "every test failed" and "seven of
// eight passed" are the difference between a harness that cannot edit and one
// that is one bug away, and the pass rate cannot tell them apart. pytest and
// unittest both report their counts; an assert-based script (CanItEdit,
// HumanEvalFix) stops at the first failure and has none to report, and this
// returns null for it rather than inventing a fraction.
export function caseCounts(output) {
  const text = String(output || '');
  const int = (re) => { const m = text.match(re); return m ? parseInt(m[1], 10) : 0; };
  // pytest's summary line: "2 failed, 3 passed, 1 error in 0.12s".
  const passed = int(/(\d+) passed/);
  const failed = int(/(\d+) failed/) + int(/(\d+) errors?(?![=\w])/);
  if (passed || failed) return { passed, failed, total: passed + failed, from: 'pytest' };
  // unittest: "Ran 7 tests in 0.01s" with "FAILED (failures=2, errors=1)".
  const ran = int(/Ran (\d+) tests?/);
  if (ran) {
    const bad = Math.min(ran, int(/failures=(\d+)/) + int(/errors=(\d+)/));
    return { passed: ran - bad, failed: bad, total: ran, from: 'unittest' };
  }
  return null;
}

// The check decides. A non-zero exit is a failure however confident the model
// sounded, and a check that cannot run at all is a failure too, never a pass.
// The check runs the model's code, so it runs under the watchdog (lib/proc.mjs):
// at its limit the check and everything it started are ended, not only the
// program named in argv.
export function score(dir, task) {
  const started = Date.now();
  let r;
  const limitMs = Math.max(5000, task.timeoutMs || 60000);
  try {
    // The check is argv, not a shell line: no quoting rules, no shell to
    // differ between Windows and the rest.
    const argv = Array.isArray(task.check) ? task.check : String(task.check).split(/\s+/).filter(Boolean);
    r = proc.runSync(argv[0], argv.slice(1), { cwd: dir, timeoutMs: limitMs, env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  } catch (e) {
    return { pass: false, why: `the check could not run: ${e && e.message ? e.message : e}`, ms: Date.now() - started };
  }
  const out = `${(r && r.stdout) || ''}${(r && r.stderr) || ''}`.trim();
  const failed = !r ? 'the check did not run'
    : r.timedOut ? `the check ran past its ${Math.round(limitMs / 1000)} s limit, and it and everything it started were stopped`
      : r.status === null && r.error ? `the check could not run: ${r.error.message || r.error}`
        : `the check exited ${r.status === null ? 'without a status' : r.status}`;
  return {
    pass: Boolean(r) && r.status === 0,
    why: r && r.status === 0 ? 'the check passed' : failed,
    pid: r && r.pid ? r.pid : 0,
    timedOut: Boolean(r && r.timedOut),
    // The counts are read from the whole output, before it is clipped: pytest
    // puts its summary last, and the clip keeps the first 600 characters.
    cases: caseCounts(out),
    output: out.slice(0, 600),
    ms: Date.now() - started,
  };
}

// Runs one task end to end. `chat` is the model: the CLI passes a real engine,
// the tests pass a scripted one, and neither can change how the task is
// scored.
// The shell tool's limit inside an eval task: two minutes, the action timeout of
// the mini-swe-agent driver atlias is compared with, and twice the one-minute
// check timeout the converted tasks carry. The interactive default is ten
// minutes, which on a task whose code loops forever cost ten minutes a check.
export const EVAL_SHELL_TIMEOUT_MS = 120000;
// The file a kept workspace holds the run's messages in.
export const TRANSCRIPT = 'atlias-transcript.json';

// Whether a task ends what its commands left running. On by default; on Windows
// finding those processes costs one process listing (about a second) per task,
// so the test suite, which runs dozens of scripted tasks, turns it off with
// ATLIAS_EVAL_REAP=0 and tests it on its own.
const reapByDefault = () => process.env.ATLIAS_EVAL_REAP !== '0';

export async function runTask(task, { chat, state, stamp = String(Date.now()), keep = false, budget: override = 0, shellTimeoutMs = EVAL_SHELL_TIMEOUT_MS, reap = reapByDefault(), work = '' } = {}) {
  if (!chat) throw new Error('runTask needs a chat function');
  const dir = makeWorkspace(task, stamp, workRoot(work));
  // The edit counters start at zero for every task. The spread is shallow, so a
  // state that already carries an editWhy would hand the same object to every
  // task, each would add into it, and runSuite would then sum the running
  // totals again.
  const st = { ...(state || {}), cwd: dir, messages: [], editTries: 0, editFails: 0, editWhy: {}, editLog: [], editRepaired: 0, sameText: 0, repeatEdits: 0, spared: 0, switches: 0, lastFailedEdit: undefined, channels: undefined, promptLog: [], outLog: [], cacheLog: [], ledger: { masked: 0, rereads: 0 }, numCtx: 0, childPids: [] };
  const t0 = Date.now();
  // A budget in the task file, so two runs weeks apart are comparable instead
  // of inheriting whatever agent.maxToolRounds happened to be set to. An
  // explicit `budget` (atlias eval --rounds N) overrides it for every task in
  // the run and is recorded in the report, which is the only honest way to ask
  // "was the corpus's own budget the thing that was measured?".
  const asked = Number(override) > 0 ? Number(override) : Number(task.rounds);
  const budget = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : null;
  let reply = '', error = null;
  try {
    reply = await loop.runLoop(st, task.prompt, { chat, say: () => {}, ask: async () => true, limits: { ...(budget ? { maxToolRounds: budget } : {}), shellTimeoutMs } });
  } catch (e) {
    error = e && e.message ? e.message : String(e);
  }
  // Grader files the model must never see (CanItEdit hides its tests upstream)
  // reach the workspace only now, after the model has stopped, and they are
  // written over anything of the same name the run left behind.
  for (const [rel, body] of Object.entries(task.hidden || {})) {
    const p = path.join(dir, rel);
    try { ensureDir(path.dirname(p)); fs.writeFileSync(p, String(body)); } catch { /* score() then fails, which is the honest result */ }
  }
  const verdict = score(dir, task);
  const cheat = tamper(dir, task);
  // Anything a command of this task left running in the background (a loop
  // started with & or start /b) is ended now, with the task, and counted: the
  // next task must not share the machine with it.
  const leftover = reap ? proc.leftovers([...(st.childPids || []), verdict.pid], { since: t0, kill: true }) : [];
  // Why the agent stopped, in the harness's own words rather than prose an eval
  // report has to guess at: answered, malformed-output, truncated-output,
  // rounds-exhausted, model-error or context-full. A task that fails because the model could
  // not format an action is a different result from one that ran out of rounds,
  // and a comparison between harnesses needs to be able to tell them apart.
  const stop = error ? { reason: 'crashed', detail: String(error).slice(0, 300) } : st.stop || { reason: 'unknown', detail: '' };
  const rounds = (st.messages || []).filter((m) => m.role === 'assistant').length;
  const chars = JSON.stringify(st.messages || []).length;
  // What the model was actually handed at the end: the masked view, role and
  // content only - the measure the mini-swe-agent runner uses. chars above
  // also counts atlias's bookkeeping and the full text of every observation
  // the view had already shrunk, so it over-states atlias against a harness
  // that keeps no such record.
  const agentCfg = config().agent;
  const handed = JSON.stringify(loop.view(st.messages || [], agentCfg.keepObservations, agentCfg.evictBlock).map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') }))).length;
  const nums = (xs) => (Array.isArray(xs) ? xs.filter((n) => typeof n === 'number' && Number.isFinite(n)) : []);
  const pass = verdict.pass && !error && cheat.files.length === 0;
  const tampered = cheat.files.map((f) => `${f.file} ${f.what}`);
  const why = error ? `the agent stopped: ${error}`
    : cheat.files.length ? `the graded file was changed by the run (${tampered.join(', ')}), so the check no longer grades the task${verdict.pass ? ' - and it exited 0, which is the pass this rule exists to refuse' : ''}`
      : verdict.why;
  if (!keep && pass) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* leave it */ } }
  // A kept workspace also keeps what the model was handed and said, written
  // after scoring so the check never sees it: a failure can then be read
  // instead of re-run, and the context a run moved can be taken apart.
  else { try { fs.writeFileSync(path.join(dir, TRANSCRIPT), JSON.stringify(st.messages || [], null, 1)); } catch { /* the result still stands */ } }
  return {
    id: task.id,
    name: task.name || task.id,
    pass,
    why,
    output: verdict.output || '',
    stop: stop.reason,
    stopDetail: stop.detail,
    tampered,
    weakened: cheat.weakened.map((w) => `${w.file}${w.line ? `:${w.line}` : ''} ${w.what}`),
    checkExit: verdict.pass,
    // Processes the task's commands left running after they returned, ended
    // when the task was scored. Nonzero means the model started something in
    // the background.
    leftovers: leftover === null ? null : leftover.length,
    // How much of the check passed, when it counts its cases. Never part of the
    // verdict: a task with seven of eight cases passing has not been finished.
    cases: verdict.cases || null,
    rounds,
    budget,
    // The apply-failure rate, carried out of the loop. The largest measured
    // harness effect in the field is the share of edits that never land, and
    // it cannot be improved while nothing counts it.
    editTries: st.editTries || 0,
    editFails: st.editFails || 0,
    editWhy: st.editWhy || {},
    // Each edit that did not apply: its arguments (clipped), its cause and the
    // refusal, so a failure can be read instead of re-run to be diagnosed.
    failedEdits: st.editLog || [],
    // Edits that applied only because the parse guard's refusal was repaired by
    // re-indenting new_string. They count as applied, and are counted apart so a
    // run says how much of its apply rate the repair bought.
    editRepaired: st.editRepaired || 0,
    // The ledger round five reads beside the pass rate. Edits that landed, so a
    // harness that counts no failures (mini-swe-agent) can still be set beside
    // this one; tool results the model was handed only as a one-line note; and
    // calls that asked again for what such a note replaced, which is what the
    // masking cost in rounds.
    editsApplied: Math.max(0, (st.editTries || 0) - (st.editFails || 0)),
    masked: (st.ledger && st.ledger.masked) || 0,
    rereads: (st.ledger && st.ledger.rereads) || 0,
    // Row 5's share: failed edits that re-sent their own text unchanged, and
    // that repeated the last failed edit byte for byte, counted in every arm;
    // under flags.sameTextSwitch, the failed edits not counted as a strike and
    // the files switched to a whole def or a whole file.
    sameText: st.sameText || 0,
    repeatEdits: st.repeatEdits || 0,
    spared: st.spared || 0,
    switches: st.switches || 0,
    chars,
    // What the engine read each round, in its own tokens, and the window it read
    // it in (0 when the engine does not say). poly-A kept neither, which is how
    // a 4096-token default went unnoticed through 27 tasks.
    promptTokens: st.promptLog || [],
    // The engine's own counts, summed over the rounds: every prompt it read and
    // every token it wrote. null when the engine reported none.
    promptTotal: nums(st.promptLog).length ? nums(st.promptLog).reduce((n, x) => n + x, 0) : null,
    outputTokens: st.outLog || [],
    outputTotal: nums(st.outLog).length ? nums(st.outLog).reduce((n, x) => n + x, 0) : null,
    // Of those prompt tokens, the ones the engine served from its prompt cache,
    // per round and summed, where the engine reports it (Ollama's
    // prompt_eval_cached_count, and the OpenAI, DeepSeek and Anthropic shapes
    // cacheReading reads). null for a round, or a run, that reported none.
    cachedTokens: st.cacheLog || [],
    cachedTotal: nums(st.cacheLog).length ? nums(st.cacheLog).reduce((n, x) => n + x, 0) : null,
    handed,
    peakPrompt: Math.max(0, ...(st.promptLog || []).filter((n) => typeof n === 'number')),
    numCtx: st.numCtx || 0,
    ms: Date.now() - t0,
    workspace: pass && !keep ? null : dir,
    said: String(reply || '').slice(0, 300),
  };
}

// One run of a sampling process is not a result. `repeat` runs every task that
// many times; a task counts as finished only when every attempt finished,
// which is pass^k, and the report carries pass@k beside it so a flaky task is
// visible rather than averaged away.
export async function runSuite(tasks, opts = {}) {
  const started = Date.now();
  const tries = Math.max(1, Math.floor(Number(opts.repeat) || 1));
  // prior: result rows of an interrupted run of the same suite (atlias eval
  // --resume). Their tasks are not run again, and the totals count them.
  const results = Array.isArray(opts.prior) ? opts.prior.slice() : [];
  const done = new Set(results.map((r) => r.id));
  for (const t of tasks) {
    if (done.has(t.id)) continue;
    const attempts = [];
    for (let i = 0; i < tries; i++) {
      // A caller's check between attempts (atlias eval stops here when whatever
      // started it is gone): a run with a fast engine never yields to a timer.
      if (typeof opts.beforeAttempt === 'function') opts.beforeAttempt();
      attempts.push(await runTask(t, { ...opts, stamp: `${Date.now()}-${results.length}-${i}` }));
    }
    const passes = attempts.filter((a) => a.pass).length;
    // The representative line is the first failure when there is one, because
    // that is the attempt a person needs to look at.
    const face = attempts.find((a) => !a.pass) || attempts[0];
    results.push({ ...face, pass: passes === tries, passes, tries, attempts: tries > 1 ? attempts : undefined });
    // Called after every task with the rows so far, so a run that dies at
    // hour three keeps what it did (atlias eval --save writes them).
    if (typeof opts.onResult === 'function') { try { opts.onResult(results); } catch { /* a failed save must not end the run */ } }
  }
  const cfg = config().agent;
  return {
    results,
    passed: results.filter((r) => r.pass).length,
    anyPassed: results.filter((r) => r.passes > 0).length,
    attemptsPassed: results.reduce((n, r) => n + r.passes, 0),
    attemptsTotal: results.length * tries,
    editTries: results.reduce((n, r) => n + (r.attempts ? r.attempts.reduce((m, a) => m + (a.editTries || 0), 0) : (r.editTries || 0)), 0),
    editFails: results.reduce((n, r) => n + (r.attempts ? r.attempts.reduce((m, a) => m + (a.editFails || 0), 0) : (r.editFails || 0)), 0),
    editRepaired: results.reduce((n, r) => n + (r.attempts ? r.attempts.reduce((m, a) => m + (a.editRepaired || 0), 0) : (r.editRepaired || 0)), 0),
    editsApplied: results.reduce((n, r) => n + (r.attempts || [r]).reduce((m, a) => m + (a.editsApplied || 0), 0), 0),
    masked: results.reduce((n, r) => n + (r.attempts || [r]).reduce((m, a) => m + (a.masked || 0), 0), 0),
    rereads: results.reduce((n, r) => n + (r.attempts || [r]).reduce((m, a) => m + (a.rereads || 0), 0), 0),
    sameText: results.reduce((n, r) => n + (r.attempts || [r]).reduce((m, a) => m + (a.sameText || 0), 0), 0),
    repeatEdits: results.reduce((n, r) => n + (r.attempts || [r]).reduce((m, a) => m + (a.repeatEdits || 0), 0), 0),
    spared: results.reduce((n, r) => n + (r.attempts || [r]).reduce((m, a) => m + (a.spared || 0), 0), 0),
    switches: results.reduce((n, r) => n + (r.attempts || [r]).reduce((m, a) => m + (a.switches || 0), 0), 0),
    editWhy: results.reduce((acc, r) => {
      for (const a of r.attempts || [r]) for (const [k, v] of Object.entries(a.editWhy || {})) acc[k] = (acc[k] || 0) + v;
      return acc;
    }, {}),
    chars: results.reduce((n, r) => n + (r.attempts ? r.attempts.reduce((m, a) => m + (a.chars || 0), 0) : (r.chars || 0)), 0),
    handed: results.reduce((n, r) => n + (r.attempts || [r]).reduce((m, a) => m + (a.handed || 0), 0), 0),
    // Engine-counted, over every attempt; null when the engine reported nothing.
    promptTotal: (() => { const v = results.flatMap((r) => (r.attempts || [r]).map((a) => a.promptTotal)).filter((x) => typeof x === 'number'); return v.length ? v.reduce((n, x) => n + x, 0) : null; })(),
    outputTotal: (() => { const v = results.flatMap((r) => (r.attempts || [r]).map((a) => a.outputTotal)).filter((x) => typeof x === 'number'); return v.length ? v.reduce((n, x) => n + x, 0) : null; })(),
    cachedTotal: (() => { const v = results.flatMap((r) => (r.attempts || [r]).map((a) => a.cachedTotal)).filter((x) => typeof x === 'number'); return v.length ? v.reduce((n, x) => n + x, 0) : null; })(),
    tries,
    // Partial credit, over the tasks whose check reports its cases. A corpus a
    // model scores zero on can still be moving, and this is the only number in
    // the report that can see it.
    cases: (() => {
      const rows = results.map((r) => r.cases).filter((c) => c && c.total > 0);
      if (!rows.length) return null;
      return {
        tasks: rows.length,
        of: results.length,
        passed: rows.reduce((n, c) => n + c.passed, 0),
        total: rows.reduce((n, c) => n + c.total, 0),
      };
    })(),
    numCtx: Math.max(0, ...results.flatMap((r) => (r.attempts || [r]).map((a) => a.numCtx || 0))),
    peakPrompt: Math.max(0, ...results.flatMap((r) => (r.attempts || [r]).map((a) => a.peakPrompt || 0))),
    total: results.length,
    ms: Date.now() - started,
    // Which corpus this score came from: the tier, how much of it ran, and the
    // seed if it was a sample. A saved report that does not carry this cannot be
    // one arm of an A/B, because nothing says the other arm ran the same tasks.
    corpus: opts.corpus || null,
    stamp: opts.stamp === false ? null : harnessStamp(),
    // The round-five flags this run ran with, so every arm names its change and
    // the control says it had none (core.flagStamp; opts.flags for a caller
    // that stamped them itself).
    flags: opts.flags || flagStamp(),
    engine: opts.engineName || (opts.state && opts.state.engine) || '',
    model: opts.model || '',
    budget: Number(opts.budget) > 0 ? Math.floor(Number(opts.budget)) : Math.max(1, cfg.maxToolRounds),
    // Whether that budget was set for this run or came from each task, and the
    // spread of the task budgets. The header used to print agent.maxToolRounds
    // while every task ran on its own smaller budget, which is the number a
    // reader would have used to judge a run that ended out of rounds.
    budgetSet: Number(opts.budget) > 0,
    // A task with no budget of its own ran on agent.maxToolRounds, so it is in
    // the spread at that number. Leaving it out printed "8 rounds per task" over
    // a smoke run where one task had 8 and the other eight ran on 25.
    budgetRange: (() => {
      if (Number(opts.budget) > 0) return null;
      const all = results.map((r) => Number(r.budget) || Math.max(1, cfg.maxToolRounds));
      return all.length && results.some((r) => Number(r.budget) > 0) ? [Math.min(...all), Math.max(...all)] : null;
    })(),
    budgetDefaulted: Number(opts.budget) > 0 ? 0 : results.filter((r) => !(Number(r.budget) > 0)).length,
  };
}

// ---------- comparing two runs ----------
// Two scores are not a result either. At this corpus size the standard error is
// near sixteen points and one task flipping moves it twelve and a half, and
// published variance on agent benchmarks exceeds one and a half points at
// temperature zero, so "4 of 9 beats 3 of 9" is a sentence with no content.
// What has content is the paired question: of the tasks that changed, how many
// went each way, and would a coin have done that as often?
//
// McNemar's exact test, which is the right one here because the pairs are the
// same tasks under two configurations and the counts are tiny: only the
// disagreements carry information, and with n disagreements the two-sided p is
// the binomial tail at one half.
export function mcnemar(gained, lost) {
  const count = (x) => Math.max(0, Math.floor(Number(x) || 0));
  const b01 = count(gained);
  const b10 = count(lost);
  const n = b01 + b10;
  if (!n) return { n: 0, p: 1 };
  // Each term C(n, k) / 2^n is built in logs: past about a thousand
  // disagreements 2^-n underflows to zero and C(n, k) overflows to Infinity,
  // and their product is NaN, which would print as a p-value.
  let tail = 0;
  let logTerm = -n * Math.LN2;
  const lo = Math.min(b01, b10);
  for (let k = 0; k <= lo; k++) {
    tail += Math.exp(logTerm);
    logTerm += Math.log(n - k) - Math.log(k + 1);
  }
  return { n, p: Math.min(1, 2 * tail) };
}

// How many disagreements, all in one direction, this test needs before it could
// reach a given threshold at all. At alpha 0.05 the answer is six and does not
// depend on the corpus size: five one-way flips give a two-sided exact p of
// 2 x 0.5^5 = 0.0625. It matters most against a baseline that scores zero,
// because then only gains are available: the new arm has to fix six tasks the
// model has already failed before any p below 0.05 is even possible.
export function minFlips(alpha = 0.05) {
  const a = Number(alpha);
  if (!(a > 0) || a >= 1) return Infinity;
  for (let n = 1; n <= 200; n++) if (mcnemar(n, 0).p <= a) return n;
  return Infinity;
}

// The Wilson score interval on one arm's pass rate. "Position: Don't Use the
// CLT in LLM Evals With Fewer Than a Few Hundred Datapoints" (ICML 2025,
// arXiv 2503.01747) recommends Wilson or a Bayesian interval at this size, and
// the reason is visible on the number this harness actually produced: the
// normal interval on 0 of 27 is zero wide, which claims the corpus proved
// something it cannot, while Wilson says 0.0 to 12.5 per cent.
export function wilson(passes, n, z = 1.96) {
  const N = Math.max(0, Math.floor(Number(n) || 0));
  if (!N) return { lo: 0, hi: 1, rate: 0, n: 0 };
  const p = Math.min(1, Math.max(0, (Number(passes) || 0) / N));
  const z2 = z * z;
  const denom = 1 + z2 / N;
  const centre = (p + z2 / (2 * N)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / N + z2 / (4 * N * N));
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), rate: p, n: N };
}

// Lanczos, so a Beta posterior can be read without a dependency.
function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  const y = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) a += g[i] / (y + i + 1);
  const t = y + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
}

// Lentz's continued fraction for the incomplete beta, as in Numerical Recipes.
function betaContinued(a, b, x) {
  const TINY = 1e-300, EPS = 3e-16;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

// The regularized incomplete beta: P(X <= x) for X ~ Beta(a, b).
export function betaCdf(x, a, b) {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  // The fraction converges quickly only on one side of the mode, so past it the
  // complement is taken instead.
  return x < (a + 1) / (a + b + 2) ? (front * betaContinued(a, b, x)) / a : 1 - (front * betaContinued(b, a, 1 - x)) / b;
}

// Its inverse by bisection: forty iterations put the answer inside 1e-12, and
// bisection cannot wander off the way Newton can at the ends where these
// posteriors live.
export function betaQuantile(q, a, b) {
  const target = Math.min(1, Math.max(0, Number(q) || 0));
  if (target <= 0) return 0;
  if (target >= 1) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 200 && hi - lo > 1e-12; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// The paired interval the ICML paper recommends in place of a normal one: only
// the tasks that disagreed carry information, so the posterior goes on the
// share of those that went forward - a Beta with the Jeffreys prior, which is
// what bayes_evals uses for a rate - and the difference in pass rate is that
// share read back through how much of the corpus disagreed at all.
export function pairedInterval(gained, lost, tasks, { mass = 0.95 } = {}) {
  const count = (x) => Math.max(0, Math.floor(Number(x) || 0));
  const g = count(gained), l = count(lost), N = count(tasks);
  const m = g + l;
  if (!N) return { lo: 0, hi: 0, mean: 0, theta: null, discordant: 0, tasks: 0, why: 'no task is shared by the two runs' };
  if (!m) return { lo: 0, hi: 0, mean: 0, theta: null, discordant: 0, tasks: N, why: 'nothing went either way on any task, so there is no difference to spread' };
  const edge = (1 - Math.min(0.999999, Math.max(0, Number(mass) || 0.95))) / 2;
  const theta = {
    lo: betaQuantile(edge, g + 0.5, l + 0.5),
    hi: betaQuantile(1 - edge, g + 0.5, l + 0.5),
    mean: (g + 0.5) / (m + 1),
  };
  const share = m / N;
  return { lo: (2 * theta.lo - 1) * share, hi: (2 * theta.hi - 1) * share, mean: (g - l) / N, theta, discordant: m, tasks: N };
}

// A paired bootstrap over the same tasks, for the interval rather than the
// verdict: resample which tasks are in the corpus, not which way they went, so
// what it reports is how much of the difference is the corpus's own luck.
export function bootstrapDiff(pairs, rounds = 2000, rng = Math.random) {
  if (!pairs.length) return { lo: 0, hi: 0, mean: 0 };
  // At least one round, or the percentiles below read an empty list.
  rounds = Math.max(1, Math.floor(Number(rounds) || 0));
  // A pair may be two booleans (one attempt each) or two pass fractions (a
  // --repeat run), and a fraction must not be flattened to true/false here.
  const num = (v) => (typeof v === 'number' ? v : v ? 1 : 0);
  const diffs = pairs.map((x) => num(x.b) - num(x.a));
  const means = [];
  for (let r = 0; r < rounds; r++) {
    let sum = 0;
    for (let i = 0; i < diffs.length; i++) sum += diffs[Math.floor(rng() * diffs.length)];
    means.push(sum / diffs.length);
  }
  means.sort((x, y) => x - y);
  const at = (q) => means[Math.min(means.length - 1, Math.max(0, Math.round(q * (means.length - 1))))];
  return { lo: at(0.025), hi: at(0.975), mean: diffs.reduce((a, b) => a + b, 0) / diffs.length };
}

// Aligns two reports by task id and asks the paired question. A task only one
// of the two runs holds is reported as unpaired rather than counted as a
// difference, because a corpus that changed under the comparison is not a
// comparison.
export function compare(a, b, { rounds = 2000, rng = Math.random, alpha = 0.05 } = {}) {
  const byId = (rep) => new Map((rep && rep.results ? rep.results : []).map((r) => [r.id || r.name, r]));
  const A = byId(a), B = byId(b);
  // With --repeat, a task's result is a fraction, not a boolean, and the pairing
  // is on that fraction: a task that fell from two attempts of three to one is
  // one task moving, not two attempts moving. Testing over attempts would treat
  // correlated samples of the same task as independent trials, which is the
  // cheapest way there is to manufacture significance.
  const triesOf = (r) => Math.max(1, Math.floor(Number(r.tries) || 1));
  const fraction = (r) => {
    const t = triesOf(r);
    const passes = Number(r.passes);
    if (t > 1 && Number.isFinite(passes)) return Math.min(1, Math.max(0, passes / t));
    return r.pass ? 1 : 0;
  };
  const pairs = [], onlyA = [], onlyB = [];
  let triesA = 1, triesB = 1;
  for (const [id, ra] of A) {
    const rb = B.get(id);
    if (!rb) { onlyA.push(id); continue; }
    triesA = Math.max(triesA, triesOf(ra));
    triesB = Math.max(triesB, triesOf(rb));
    pairs.push({ id, a: fraction(ra), b: fraction(rb), aPass: Boolean(ra.pass), bPass: Boolean(rb.pass) });
  }
  for (const id of B.keys()) if (!A.has(id)) onlyB.push(id);
  const gained = pairs.filter((x) => x.b > x.a);
  const lost = pairs.filter((x) => x.a > x.b);
  const test = mcnemar(gained.length, lost.length);
  const boot = bootstrapDiff(pairs, rounds, rng);
  const mean = (get) => (pairs.length ? pairs.reduce((n, x) => n + get(x), 0) / pairs.length : 0);
  const aPassed = pairs.filter((x) => x.aPass).length;
  const bPassed = pairs.filter((x) => x.bPass).length;
  // What each run spent on the tasks both hold. At a 0/27 floor the pass count
  // cannot move, and these are the only numbers that can; they are summed over
  // the paired tasks only, so a corpus that changed under the comparison does
  // not show up as a cost. A number one run never recorded (poly-A has no cause
  // tally and no window; mini-swe-agent counts no edits) is null, printed as
  // "not recorded" - a zero there would be a measurement nobody took.
  const costOf = (map) => {
    const runs = pairs.flatMap((x) => { const r = map.get(x.id); return r.attempts || [r]; });
    const has = (k) => runs.some((r) => r[k] !== undefined && r[k] !== null && Number.isFinite(Number(r[k])));
    const sum = (k) => (has(k) ? runs.reduce((n, r) => n + (Number(r[k]) || 0), 0) : null);
    const most = (k) => (has(k) ? Math.max(0, ...runs.map((r) => Number(r[k]) || 0)) : null);
    const whyRows = runs.filter((r) => r.editWhy && typeof r.editWhy === 'object');
    const caseRows = runs.map((r) => r.cases).filter((c) => c && Number(c.total) > 0);
    // What a solve cost: everything the paired runs moved, failures included,
    // over the attempts that passed. A total alone would let a harness look
    // cheap by solving less; null when nothing passed, never a divide by zero.
    const passedRuns = runs.filter((r) => r.pass === true).length;
    const chars = sum('chars');
    // Engine-counted tokens: a row's own total when it has one, else the sum of
    // its per-round list (the mini-swe-agent runner keeps only the list).
    const tok = (total, list) => {
      const vals = runs.map((r) => (Number.isFinite(Number(r[total])) && r[total] !== null ? Number(r[total]) : Array.isArray(r[list]) && r[list].some((n) => typeof n === 'number') ? r[list].reduce((n, x) => n + (typeof x === 'number' ? x : 0), 0) : null));
      return vals.some((v) => v !== null) ? vals.reduce((n, v) => n + (v || 0), 0) : null;
    };
    const promptT = tok('promptTotal', 'promptTokens');
    const outputT = tok('outputTotal', 'outputTokens');
    // A report from before the ledger has editTries and editFails but no
    // editsApplied; the difference is the same number.
    const applied = runs.some((r) => Number.isFinite(Number(r.editsApplied)) && r.editsApplied !== null) || (has('editTries') && has('editFails'))
      ? runs.reduce((n, r) => n + (Number.isFinite(Number(r.editsApplied)) && r.editsApplied !== null ? Number(r.editsApplied) : Math.max(0, (Number(r.editTries) || 0) - (Number(r.editFails) || 0))), 0)
      : null;
    return {
      runs: runs.length,
      passedRuns,
      charsPerPass: chars !== null && passedRuns > 0 ? chars / passedRuns : null,
      handed: sum('handed'),
      promptTokens: promptT,
      outputTokens: outputT,
      // Prompt tokens only: output counts exist on some runs and not others (the
      // older mini-swe-agent reports kept none), and a per-solve number that
      // adds them on one side only would compare two different things.
      tokensPerPass: promptT !== null && passedRuns > 0 ? promptT / passedRuns : null,
      editTries: sum('editTries'),
      editFails: sum('editFails'),
      editsApplied: applied,
      masked: sum('masked'),
      rereads: sum('rereads'),
      // A report saved before row 5 has no sameText field, but its cause tally
      // counted the same edits; the repeats were never counted, and read null.
      sameText: has('sameText') ? sum('sameText') : whyRows.length ? whyRows.reduce((n, r) => n + (Number(r.editWhy['same-text']) || 0), 0) : null,
      repeatEdits: sum('repeatEdits'),
      spared: sum('spared'),
      switches: sum('switches'),
      cachedTokens: tok('cachedTotal', 'cachedTokens'),
      editWhy: whyRows.length ? whyRows.reduce((acc, r) => { for (const [k, v] of Object.entries(r.editWhy)) acc[k] = (acc[k] || 0) + (Number(v) || 0); return acc; }, {}) : null,
      cases: caseRows.length ? { tasks: caseRows.length, passed: caseRows.reduce((n, c) => n + (Number(c.passed) || 0), 0), total: caseRows.reduce((n, c) => n + Number(c.total), 0) } : null,
      chars,
      ms: sum('ms'),
      numCtx: most('numCtx') || null,
      peakPrompt: most('peakPrompt') || null,
    };
  };
  return {
    pairs: pairs.length,
    aPassed,
    bPassed,
    // The mean pass fraction, which equals the pass count when each task ran
    // once and is the number the pairing above actually used when it did not.
    aRate: mean((x) => x.a),
    bRate: mean((x) => x.b),
    repeated: triesA > 1 || triesB > 1,
    // Both, because two arms run with different --repeat counts must not be
    // described by one number.
    tries: Math.max(triesA, triesB),
    triesA,
    triesB,
    gained: gained.map((x) => x.id),
    lost: lost.map((x) => x.id),
    onlyA, onlyB,
    p: test.p,
    changed: test.n,
    boot,
    alpha,
    // What this corpus could never have shown, printed beside what it did show.
    minFlips: minFlips(alpha),
    wilsonA: wilson(aPassed, pairs.length),
    wilsonB: wilson(bPassed, pairs.length),
    paired: pairedInterval(gained.length, lost.length, pairs.length),
    cost: { a: costOf(A), b: costOf(B) },
    // Which flags each arm ran with. An A/B whose arms name the same flags is
    // two runs of one configuration, whatever the files are called.
    flags: { a: a && a.flags ? a.flags : null, b: b && b.flags ? b.flags : null },
    // The honest wording, and the threshold is stated rather than implied.
    verdict: test.n === 0 ? 'nothing changed on any task'
      : test.p > alpha ? 'inside the noise: a coin lands this way about as often'
        : 'a real difference at the usual threshold',
  };
}

// The cost side of a comparison, one line per measure, each side either a
// number or "not recorded". Totals, not tested: no interval is claimed for them.
function costLines(cost, aName, bName, pairs) {
  const NR = 'not recorded';
  const { a, b } = cost;
  const pct = (n, d) => (d ? ` (${Math.round((n / d) * 100)}%)` : '');
  const edits = (s) => (s.editTries === null ? NR : s.editTries === 0 ? '0 attempted' : `${s.editFails === null ? '?' : s.editFails} of ${s.editTries} did not apply${s.editFails === null ? '' : pct(s.editFails, s.editTries)}`);
  const why = (s) => {
    if (s.editWhy === null) return NR;
    const rows = Object.entries(s.editWhy).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
    return rows.length ? rows.map(([k, v]) => `${k} ${v}`).join(', ') : 'none';
  };
  const cases = (s) => (s.cases === null ? NR : `${s.cases.passed}/${s.cases.total} test case(s)${pct(s.cases.passed, s.cases.total)} over ${s.cases.tasks} task(s)`);
  const chars = (s) => {
    if (s.chars === null) return NR;
    const per = s.charsPerPass === null || s.charsPerPass === undefined ? 'no attempt passed' : `${(s.charsPerPass / 1000).toFixed(1)}k per passing attempt (${s.passedRuns} of ${s.runs})`;
    return `${Math.round(s.chars / 1000)}k characters, ${per}`;
  };
  const wall = (s) => (s.ms === null ? NR : `${(s.ms / 1000).toFixed(1)}s`);
  const win = (s) => (s.numCtx === null ? NR : `${s.numCtx} tokens${s.peakPrompt === null ? '' : `, largest prompt ${s.peakPrompt}`}`);
  const row = (label, f) => `  ${label}: ${aName} ${f(a)}; ${bName} ${f(b)}.`;
  const out = [`What each run spent on the ${pairs} paired task(s) - totals, not tested, and the only numbers that can move when neither run passes anything:`];
  out.push(row('edits', edits));
  if (a.editWhy !== null || b.editWhy !== null) out.push(row('why an edit did not apply', why));
  if (a.cases !== null || b.cases !== null) out.push(row('partial credit', cases));
  out.push(row('context moved', chars));
  if (a.handed !== null || b.handed !== null) out.push(row('what the model was handed at the end (role and content)', (s) => (s.handed === null ? NR : `${Math.round(s.handed / 1000)}k characters`)));
  if (a.promptTokens !== null || b.promptTokens !== null) out.push(row('engine tokens', (s) => (s.promptTokens === null ? NR : `${Math.round(s.promptTokens / 1000)}k prompt (${s.tokensPerPass === null ? 'no attempt passed' : `${(s.tokensPerPass / 1000).toFixed(1)}k per passing attempt`}) + ${s.outputTokens === null ? 'output not recorded' : `${Math.round(s.outputTokens / 1000)}k output`}`)));
  // Cached prompt tokens bill at a fraction of the rest on most engines, so a
  // prompt total alone overstates what a cached prefix costs; the raw total
  // stays the headline and this sits beside it.
  if ((a.cachedTokens !== undefined && a.cachedTokens !== null) || (b.cachedTokens !== undefined && b.cachedTokens !== null)) out.push(row('of the prompt, served from the engine\'s cache', (s) => (s.cachedTokens === null || s.cachedTokens === undefined ? NR : `${Math.round(s.cachedTokens / 1000)}k${s.promptTokens ? pct(s.cachedTokens, s.promptTokens) : ''}`)));
  const ledger = (s) => [s.editsApplied === null || s.editsApplied === undefined ? `edits applied ${NR}` : `${s.editsApplied} edit(s) applied`, s.masked === null || s.masked === undefined ? `masking ${NR}` : `${s.masked} result(s) masked, ${s.rereads === null || s.rereads === undefined ? '?' : s.rereads} asked for again`].join(', ');
  if ([a, b].some((s) => (s.editsApplied !== null && s.editsApplied !== undefined) || (s.masked !== null && s.masked !== undefined))) out.push(row('ledger', ledger));
  // Row 5's share: of the edits that did not apply, how many re-sent their own
  // text, how many repeated the last failed one, and what the flag did with them.
  const known = (v) => v !== null && v !== undefined;
  const same = (s) => {
    if (!known(s.sameText)) return NR;
    const parts = [`${s.sameText} of ${known(s.editFails) ? s.editFails : '?'} failed edit(s) re-sent their own text${known(s.editFails) ? pct(s.sameText, s.editFails) : ''}`];
    parts.push(known(s.repeatEdits) ? `${s.repeatEdits} repeated the last failed edit` : `repeats ${NR}`);
    if (s.spared || s.switches) parts.push(`${s.spared || 0} not counted as a strike, ${s.switches || 0} switched to a whole def or file`);
    return parts.join(', ');
  };
  if ([a, b].some((s) => known(s.sameText))) out.push(row('same text', same));
  out.push(row('wall time, summed over the tasks', wall));
  out.push(row('largest context window', win));
  if (a.ms !== null && b.ms !== null) out.push('  Wall time is the machine as much as the harness: a loaded GPU, a cold model load or a different window moves it with no change to the code.');
  return out;
}

export function formatCompare(c, aName = 'A', bName = 'B') {
  const lines = [];
  // Named, but not all of them: two runs of different tiers share no task at
  // all, and listing 279 ids on one line buries every number under it.
  const SHOW = 6;
  const some = (ids, where) => {
    const head = ids.slice(0, SHOW).map((i) => `${i} only in ${where}`);
    return ids.length > SHOW ? [...head, `and ${ids.length - SHOW} more only in ${where}`] : head;
  };
  const unpaired = () => {
    if (c.onlyA.length || c.onlyB.length) lines.push(`Unpaired and therefore ignored: ${[...some(c.onlyA, aName), ...some(c.onlyB, bName)].join(', ')}.`);
  };
  // No task in common is not a tie: there is nothing to compare, and printing
  // 0/0, a p of one and an interval of zero would dress that up as a result.
  if (!c.pairs) {
    lines.push(`${aName} and ${bName} share no task, so there is nothing to compare.`);
    unpaired();
    return lines.join('\n');
  }
  const pc = (x) => (x * 100).toFixed(1);
  lines.push(`${aName} ${c.aPassed}/${c.pairs} against ${bName} ${c.bPassed}/${c.pairs}, on the ${c.pairs} task(s) both runs hold.`);
  unpaired();
  if (c.flags && (c.flags.a || c.flags.b)) {
    lines.push(`Flags: ${aName} ${flagLine(c.flags.a)}; ${bName} ${flagLine(c.flags.b)}.`);
    const same = sameFlags(c.flags.a, c.flags.b);
    if (same) lines.push('Both runs had the same flags, so whatever differs between them is not a flag.');
  }
  if (c.repeated) lines.push(`Paired on each task's pass fraction over ${c.triesA === c.triesB ? `${c.triesA} attempts` : `${c.triesA} attempts in ${aName} and ${c.triesB} in ${bName}`} (${pc(c.aRate)} against ${pc(c.bRate)} per cent of attempts): a task counts once, whichever way it moved.`);
  lines.push(`${c.gained.length} task(s) gained${c.gained.length ? ` (${c.gained.join(', ')})` : ''}, ${c.lost.length} lost${c.lost.length ? ` (${c.lost.join(', ')})` : ''}.`);
  // The same exact binomial tail either way; on fractions over tasks it is the
  // sign test, and calling it McNemar would invite the reader to think the
  // attempts were the unit.
  lines.push(`${c.repeated ? 'Paired sign test over tasks (exact binomial)' : 'McNemar exact'} p = ${c.p.toFixed(3)} on ${c.changed} disagreement(s): ${c.verdict}.`);
  // What this corpus could never have shown. A 0/27 baseline has only gains
  // available, so without this line a two-task improvement reads as progress.
  if (c.minFlips) {
    const short = c.changed < c.minFlips;
    lines.push(`Minimum detectable: ${c.minFlips} one-way flips are needed for p < ${c.alpha}; this corpus has ${c.pairs} task(s) and ${c.changed} disagreement(s)${short ? `, so no p below ${c.alpha} was reachable however the tasks fell` : ''}.`);
  }
  if (c.wilsonA && c.wilsonB) lines.push(`Wilson 95 per cent interval on the pass rate: ${aName} ${pc(c.wilsonA.lo)} to ${pc(c.wilsonA.hi)}, ${bName} ${pc(c.wilsonB.lo)} to ${pc(c.wilsonB.hi)}${c.repeated ? ' (on tasks finished on every attempt)' : ''}.`);
  if (c.paired) {
    lines.push(c.paired.discordant
      ? `Paired interval on the ${c.paired.discordant} disagreement(s) (Beta posterior, Jeffreys prior): ${pc(c.paired.mean)} points, 95 per cent ${pc(c.paired.lo)} to ${pc(c.paired.hi)}.`
      : `Paired interval: ${pc(c.paired.mean)} points - ${c.paired.why}.`);
  }
  lines.push(`Paired bootstrap on the pass rate: ${pc(c.boot.mean)} points, 95 per cent interval ${pc(c.boot.lo)} to ${pc(c.boot.hi)}.`);
  // The percentile bootstrap is the number most likely to be quoted from this
  // report and the least trustworthy at this size (arXiv 2503.01747).
  if (c.pairs < 100) lines.push(`That bootstrap is unreliable below about 100 tasks (this corpus has ${c.pairs}); the paired interval above is the one to read.`);
  if (c.pairs < 30) lines.push(`A corpus of ${c.pairs} cannot resolve a small difference: one task flipping moves the score ${(100 / c.pairs).toFixed(1)} points, which is larger than most changes worth arguing about.`);
  if (c.cost) lines.push(...costLines(c.cost, aName, bName, c.pairs));
  return lines.join('\n');
}

export function format(report) {
  const lines = [];
  if (report.stamp) lines.push(`harness: ${report.stamp.text}${report.stamp.dirty ? ` (uncommitted: ${report.stamp.dirtyFiles.join(', ')})` : ''}`);
  const bits = [];
  if (report.engine) bits.push(`engine ${report.engine}`);
  if (report.model) bits.push(`model ${report.model}`);
  // The rounds the tasks actually ran on, not the machine's default: a run of
  // the main tier ends at 8 or 12 rounds whatever agent.maxToolRounds says.
  if (report.budgetSet) bits.push(`${report.budget} rounds, set for this run`);
  else if (report.budgetRange) {
    const spread = report.budgetRange[0] === report.budgetRange[1] ? `${report.budgetRange[0]} rounds per task` : `${report.budgetRange[0]}-${report.budgetRange[1]} rounds per task`;
    const n = Number(report.budgetDefaulted) || 0;
    bits.push(n ? `${spread} (${n} of them with no budget of their own, on agent.maxToolRounds ${report.budget})` : spread);
  }
  else if (report.budget) bits.push(`${report.budget} rounds`);
  if (report.numCtx) bits.push(`context ${report.numCtx} tokens, largest prompt ${report.peakPrompt || 0}`);
  if (report.tries > 1) bits.push(`${report.tries} attempts each`);
  if (typeof report.promptTotal === 'number') {
    const solved = Number(report.attemptsPassed) || 0;
    bits.push(`engine tokens ${Math.round(report.promptTotal / 1000)}k prompt${solved ? ` (${(report.promptTotal / solved / 1000).toFixed(1)}k per passing attempt)` : ''}${typeof report.cachedTotal === 'number' ? `, ${Math.round(report.cachedTotal / 1000)}k of it from the engine's cache` : ''} + ${typeof report.outputTotal === 'number' ? `${Math.round(report.outputTotal / 1000)}k` : 'unrecorded'} output`);
  }
  if (bits.length) lines.push(`ran with: ${bits.join(', ')}`);
  if (report.flags) lines.push(`flags: ${flagLine(report.flags)}`);
  if (report.corpus) {
    const c = report.corpus;
    lines.push(`corpus: ${c.tier} tier, ${c.tasks} task(s)${c.of && c.of !== c.tasks ? ` of ${c.of}` : ''}${c.seed ? `, sampled with seed "${c.seed}"` : ''}`);
  }
  if (lines.length) lines.push('');
  for (const r of report.results) {
    const many = r.tries > 1 ? `${r.passes}/${r.tries} attempts, ` : '';
    // On a passing line the stop reason is always "answered", and boilerplate
    // that is always there stops being read. A pass that stopped some other
    // way is exactly the thing worth seeing, so that one is printed.
    const stopped = r.stop && (!r.pass || r.stop !== 'answered') ? `, stopped: ${r.stop}` : '';
    const budget = r.budget ? `/${r.budget}` : '';
    lines.push(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (${many}${r.rounds}${budget} rounds, ${(r.ms / 1000).toFixed(1)}s${stopped})`);
    if (!r.pass) {
      lines.push(`      ${r.why}`);
      if (r.cases && r.cases.total) lines.push(`      ${r.cases.passed} of ${r.cases.total} test case(s) passed`);
      if (r.tampered && r.tampered.length) lines.push(`      graded file changed: ${r.tampered.join(', ')}`);
      if (r.weakened && r.weakened.length) lines.push(`      ${r.weakened.join('; ')}`);
      if (r.output) lines.push(`      ${r.output.split('\n').slice(0, 4).join('\n      ')}`);
      if (r.workspace) lines.push(`      workspace kept: ${r.workspace}`);
    }
  }
  lines.push('');
  const k = report.tries > 1
    ? `${report.passed}/${report.total} tasks finished on every attempt (pass^${report.tries}), ${report.anyPassed}/${report.total} finished at least once (pass@${report.tries}), ${report.attemptsPassed}/${report.attemptsTotal} attempts passed`
    : `${report.passed}/${report.total} tasks finished`;
  lines.push(`${k}, ${(report.ms / 1000).toFixed(1)}s total.`);
  if (report.cases && report.cases.total) {
    const share = Math.round((report.cases.passed / report.cases.total) * 100);
    lines.push(`partial credit: ${report.cases.passed}/${report.cases.total} test case(s) passed (${share}%) across the ${report.cases.tasks} of ${report.cases.of} task(s) whose check counts them. It is not part of the score - a task is finished or it is not - but on a corpus scoring zero it is the only number that can tell a near miss from nothing.`);
  }
  // A score on its own cannot tell two harnesses apart: one measured pair sat
  // inside the noise on pass rate and forty-fold apart on what it cost to get
  // there. So the cost of the score prints beside the score, every time.
  if (report.editTries) {
    const rate = Math.round((report.editFails / report.editTries) * 100);
    lines.push(`edits: ${report.editTries} attempted, ${report.editFails} did not apply (${rate}%).${rate > 10 ? ' Above one in ten, this is the biggest lever available: one adapter took a model from 19.1 to 73.4 per cent on the same benchmark purely by driving apply failures from 69.1 down to under 1.5.' : ''}`);
    // The causes, worst first. The rate alone says there is a problem; only the
    // distribution says which problem, and a near-miss and a missing file have
    // nothing in common as fixes.
    const why = Object.entries(report.editWhy || {}).sort((a, b) => b[1] - a[1]);
    if (why.length) lines.push(`  why: ${why.map(([k, v]) => `${k} ${v}`).join(', ')}`);
    if (report.editRepaired) lines.push(`  applied only after re-indentation: ${report.editRepaired} (counted as applied)`);
    if (report.editFails && (report.sameText || report.repeatEdits)) lines.push(`  re-sent their own text: ${report.sameText || 0} of ${report.editFails}; repeated the last failed edit byte for byte: ${report.repeatEdits || 0}${report.spared || report.switches ? `; not counted as a strike: ${report.spared || 0}; switched to a whole def or file: ${report.switches || 0}` : ''}`);
  }
  if (typeof report.masked === 'number' && (report.masked || report.rereads)) lines.push(`masking: ${report.masked} tool result(s) handed to the model as a one-line note, ${report.rereads} call(s) that asked again for what a note replaced.`);
  if (report.chars) {
    const per = report.passed ? `, ${Math.round(report.chars / 1000 / report.passed)}k per task finished` : '';
    lines.push(`context moved: ${Math.round(report.chars / 1000)}k characters${per} (characters, not tokens; the crude quarter puts it near ${Math.round(report.chars / 4000)}k tokens).`);
  }
  if (report.results.some((r) => r.tampered && r.tampered.length)) lines.push('A run that changed a graded file is not a pass, whatever the check exited: the check is only worth its exit code while it is the one the task shipped.');
  if (report.passed < report.total) lines.push('A failure here is the harness or the model, not the checker: the check command is the one a person would run by hand.');
  return lines.join('\n');
}
