// Stop: the verification gate. It speaks only when a reply is about to end
// with unverified changes, at most once per reason per prompt, never when the
// host is already continuing because of a stop hook.
import fs from 'node:fs';
import path from 'node:path';
import { config, events, eventsTail, TURN_TAIL, sessionMeta, saveSessionMeta, run, gitStatusShort, findPython, exists, isCodeFile, clip, looksLikeCheckScript, recordEvent, subagentTag, actorSession } from './core.mjs';
import { runSync } from './proc.mjs';
import * as progress from './progress.mjs';
import * as integrity from './integrity.mjs';
import * as track from './track.mjs';

export const PASS_RE = /(pass\s*2|second\s+pass|two\s+passes|bug[- ]?check(ed)?\s+twice|adversarial\s+(pass|re-?read|check|hunt))/i;

function lastPrompt(evs, actor = null) {
  for (let i = evs.length - 1; i >= 0; i--) if (evs[i].kind === 'prompt' && (actor === null || !evs[i].subagent || evs[i].subagent === actor)) return i;
  return -1;
}
export function turnEvents(sid, actor = '') {
  const apartOn = config().flags.subagentsApart === true;
  const scoped = apartOn ? actor : null;
  let evs = eventsTail(sid, TURN_TAIL);
  let start = lastPrompt(evs, scoped);
  // A turn with thousands of tool calls pushes its own prompt marker out of the
  // tail. Treating the whole window as this turn would drag in files from
  // earlier turns and collapse every per-prompt flag onto one key, so pay for
  // the full read in the rare case that needs it.
  if (start === -1) {
    const all = events(sid);
    const found = lastPrompt(all, scoped);
    if (found !== -1) { evs = all; start = found; }
  }
  const rest = evs.slice(start + 1);
  // flags.subagentsApart (lib/core.mjs subagentTag): a subagent's events are
  // not this session's turn. `since` is the turn's first event whoever fired it,
  // so the git window is unchanged; `apart` is the subagent's edits, which the
  // git check must not count either. Off, the turn is the whole of it.
  // The git check may leave out a subagent's edited file only when the main
  // session ran no shell command this turn: its own shell command can change the
  // same file, and git cannot say which change is whose (f3's review, board 15:48Z).
  const mine = (e) => (e.subagent || '') === actor;
  const mainShell = rest.some((e) => e.kind === 'shell' && mine(e));
  return {
    promptId: start >= 0 ? evs[start].prompt_id : 'none',
    promptAt: start >= 0 ? (evs[start].t || 0) : 0,
    turn: apartOn ? rest.filter(mine) : rest,
    truncated: start === -1,
    since: apartOn && start >= 0 ? (evs[start].t || 0) : rest.length ? (rest[0].t || 0) : 0,
    apart: apartOn && !mainShell ? rest.filter((e) => !mine(e) && e.kind === 'edit') : [],
  };
}

// git status --short, in the shapes it actually comes back in:
//   ' M lib/x.mjs'   modified
//   '?? new.mjs'     untracked
//   'A  added.mjs'   staged add
//   'R  old -> new'  rename, where only the new path still exists
//   ' M "with space.mjs"'  quoted when the path needs it
export function parseGitStatus(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    if (status === '!!') continue; // ignored
    let rest = line.slice(3).trim();
    const arrow = rest.indexOf(' -> ');
    if (arrow !== -1) rest = rest.slice(arrow + 4);
    if (status[0] === 'D' || status[1] === 'D') continue; // deleted: nothing to parse
    if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
    if (rest) out.push(rest);
  }
  return out;
}

// What changed on disk that the harness never saw a tool touch. Bounded by
// the start of this turn so a dirty working tree from yesterday is not
// dragged into today's review.
// Windows file timestamps and Date.now do not advance on the same tick:
// 500 immediate writes here measured mtime up to 13.93ms behind the clock.
// Keep a small conservative window; this is not permission to include old dirt.
export const MTIME_SLOP_MS = process.platform === 'win32' ? 32 : 0;
export function shellChangedFiles(cwd, since, deps = {}) {
  const stat = deps.mtime || ((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } });
  const status = deps.run ? (deps.run('git', ['status', '--short'], { cwd, timeout: 3000 }).stdout || '') : gitStatusShort(cwd);
  if (!status) return [];
  const out = [];
  for (const rel of parseGitStatus(status)) {
    const full = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    if (!isCodeFile(full)) continue;
    if (stat(full) >= since - MTIME_SLOP_MS) out.push(full);
  }
  return out;
}

// The last check that ran after the turn's last edit, or null.
export function lastVerificationAfterEdit(turn) {
  let lastEdit = -1;
  for (let i = turn.length - 1; i >= 0; i--) if (turn[i].kind === 'edit') { lastEdit = i; break; }
  for (let i = turn.length - 1; i > lastEdit; i--) if (turn[i].kind === 'shell' && turn[i].verify) return turn[i].outcome === 'pass' || turn[i].outcome === 'fail' ? turn[i] : null;
  return null;
}

export function changedFiles(turn, cwd) {
  const out = new Set();
  for (const e of turn) if (e.kind === 'edit') for (const f of e.files || []) out.add(path.isAbsolute(f) ? f : path.join(cwd, f));
  return [...out];
}

// What atlias can parse by itself, and what it cannot. Anything not in the
// first list is reported as unchecked rather than quietly passed.
export const PARSEABLE = new Set(['.js', '.mjs', '.cjs', '.json', '.py']);
export function syntaxReport(files) {
  const r = syntaxCheckDetailed(files);
  return r;
}
export function syntaxCheck(files) { return syntaxCheckDetailed(files).failures; }
// A parser that timed out or could not start has not said the file is broken.
// Reporting it as a syntax failure blocked a reply over a file that parses (seen
// under load: node --check past its ten seconds), and in guardedWrite it put
// back an edit that was fine. Such a file is `unchecked`: neither passed nor
// failed, and said so.
export function syntaxCheckDetailed(files, deps = {}) {
  const exec = deps.run || run;
  const failures = [];
  const checked = [];
  const skipped = [];
  const missing = [];
  const unchecked = [];
  let py = null;
  for (const f of files) {
    if (!exists(f)) { missing.push(f); continue; }
    if (!PARSEABLE.has(path.extname(f).toLowerCase())) { skipped.push(f); continue; }
    const ext = path.extname(f).toLowerCase();
    if (['.js', '.mjs', '.cjs'].includes(ext)) {
      const r = exec(process.execPath, ['--check', f], { timeout: 10000 });
      if (r.status === null) { unchecked.push({ file: f, why: clip(r.error || 'the parser did not finish', 200) }); continue; }
      checked.push(f);
      if (r.status !== 0) failures.push({ file: f, error: clip((r.stderr || r.error || '').trim(), 400) });
    } else if (ext === '.json') {
      checked.push(f);
      try { JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch (e) { failures.push({ file: f, error: e.message }); }
    } else if (ext === '.py') {
      py = py || findPython() || (process.platform === 'win32' ? 'python' : 'python3');
      const r = exec(py, ['-m', 'py_compile', f], { timeout: 15000 });
      if (r.status === null) { unchecked.push({ file: f, why: clip(r.error || 'the parser did not finish', 200) }); continue; }
      checked.push(f);
      if (r.status !== 0) failures.push({ file: f, error: clip((r.stderr || '').trim(), 400) });
    }
  }
  return { failures, checked, skipped, missing, unchecked };
}

function block(reason) { return { decision: 'block', reason }; }

// ---------- the gate runs the project's check (flags.gateRunsCheck) ----------
// A reply held because no check ran after the last edit costs one more round,
// and every round re-sends the whole context (about 30k prompt tokens a round in
// the 2026-09-28 Claude Code study). When the project shows its own check, the
// gate can run it instead: a pass is recorded and the reply goes through with
// no round at all, a failure holds the reply with the output quoted.
//
// The check is found the way the hooks already recognise a check script run by
// name (looksLikeCheckScript, the script-name part of looksLikeVerification):
// a script in the project's root whose name says it checks (check.py,
// canitedit_check.py, run_tests.sh, test_parse.py), or the package.json test
// script. The classifier's other words are left out here: they name tools, and
// on a file name they pick eslint.config.js or latest.js, which exit 0. Only
// one unambiguous candidate is run; two of the same rank, a script named for a
// check that does not end in one (verify_email.py), or a test file that does
// nothing when run by itself (a pytest file, a test-utils.mjs of helpers), is
// no check the gate can name, and the gate holds as it did before the flag.
export const GATE_CHECK_MS = 10000;
const NO_NPM_TEST = /no test specified/;
// A test file of pytest's shape defines tests and runs none of them, so running
// it passes whatever the code does. One that runs on its own says so.
const RUNS_ITSELF = /^if\s+__name__\s*==|^\s*unittest\.main\(|^\s*pytest\.main\(|^assert\b|^check\(/m;
// A JavaScript test file that fails by itself: node's test runner, an assert,
// or an exit code of its own.
const RUNS_ITSELF_JS = /\bnode:test\b|\bassert\b|\bprocess\.exit(Code)?\b/;
// Only a name that ends in check or verify is run unread: check.py,
// canitedit_check.py, run_checks.sh. verify_email.py is the application's.
const CHECK_STEM = /(^|[_.-])(checks?|verify)$/i;
function scriptRunner(ext, platform) {
  const win = platform === 'win32';
  if (ext === '.py') return { kind: 'python', programs: win ? ['python', 'py'] : ['python3', 'python'], lead: [] };
  if (['.js', '.mjs', '.cjs'].includes(ext)) return { kind: 'node', programs: [process.execPath], shownAs: 'node', lead: [] };
  // run_tests.sh has no interpreter to find on Windows short of Git's bash,
  // and check.ps1 none elsewhere, so each is a check only where it can run.
  if (ext === '.sh') return win ? null : { kind: 'sh', programs: ['sh'], lead: [] };
  if (ext === '.ps1') return win ? { kind: 'powershell', programs: ['powershell'], lead: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'] } : null;
  return null;
}
// A completion hook must not open an interactive editor as a side effect of
// discovering a project check. Inspect explicit launch commands and referenced
// local scripts before automatic execution. Refusal leaves verification due.
function editorLaunchInCheck(cwd, command, scripts = {}, seen = new Set()) {
  if (/(?:^|[\r\n;&|])\s*(?:&\s*)?["']?(?:[^\s"']*[\\/])?code(?:-insiders)?(?:\.(?:exe|cmd))?["']?(?:\s|$)|vscode(?:-insiders)?:\/\/|\b(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?|Start-Process)\s*\(?\s*["'](?:[^"']*[\\/])?code(?:-insiders)?(?:\.(?:exe|cmd))?["']/i.test(command)) return true;
  if (seen.size >= 32) return true; // cannot establish a headless automatic path
  for (const match of command.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:-]+)/g)) {
    const name = match[1];
    for (const key of [`pre${name}`, name, `post${name}`]) if (typeof scripts[key] === 'string' && !seen.has('script:' + key)) {
      seen.add('script:' + key);
      if (editorLaunchInCheck(cwd, scripts[key], scripts, seen)) return true;
    }
  }
  for (const match of command.matchAll(/(?:^|[\s"'])([\w./\\:-]+\.(?:[mc]?js|py|ps1|sh))(?=[\s"';&|)]|$)/g)) {
    const file = path.resolve(cwd, match[1]);
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      if (fs.statSync(file).size > 512 * 1024) return true;
      if (editorLaunchInCheck(path.dirname(file), fs.readFileSync(file, 'utf8'), scripts, seen)) return true;
    } catch (error) { if (error.code !== 'ENOENT') return true; }
  }
  return false;
}
export function visibleCheck(cwd, { platform = process.platform, uncertainty = null } = {}) {
  const unknown = (reason) => { if (uncertainty) uncertainty.push(reason); };
  let names;
  try { names = fs.readdirSync(cwd); } catch { unknown('project directory could not be read'); return null; }
  const found = [];
  for (const name of names.sort()) {
    const ext = path.extname(name).toLowerCase();
    const runner = scriptRunner(ext, platform);
    // The classifier decides, on the command a model would have typed.
    if (!runner || !looksLikeCheckScript(`${runner.kind} ${name}`)) continue;
    const full = path.join(cwd, name);
    try { if (!fs.statSync(full).isFile()) continue; } catch { unknown(`candidate could not be inspected: ${name}`); continue; }
    const stem = name.slice(0, -ext.length);
    const rank = CHECK_STEM.test(stem) ? 0 : /^tests?_|_tests?$/i.test(stem) ? 3 : 2;
    const itself = ext === '.py' ? RUNS_ITSELF : runner.kind === 'node' ? RUNS_ITSELF_JS : null;
    if (rank > 0 && itself) {
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch { unknown(`candidate could not be read: ${name}`); continue; }
      if (!itself.test(text)) continue;
    }
    const shown = runner.shownAs || runner.programs[0];
    if (editorLaunchInCheck(cwd, `${shown} ${name}`)) { unknown(`automatic check requires an editor or could not be established as headless: ${name}`); continue; }
    found.push({ rank, name, command: `${shown}${runner.kind === 'powershell' ? ' -File' : ''} ${name}`, programs: runner.programs, args: [...runner.lead, name], shell: false });
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
    const t = pkg && pkg.scripts && pkg.scripts.test;
    if (typeof t === 'string' && t.trim() && !NO_NPM_TEST.test(t) && !editorLaunchInCheck(cwd, 'npm test', pkg.scripts)) {
      const has = (f) => exists(path.join(cwd, f));
      const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun run' : 'npm';
      // npm is npm.cmd on Windows, which Node starts only through a shell; the
      // line is fixed text, so the shell is handed nothing a model wrote.
      found.push({ rank: 1, name: 'package.json', command: `${pm} test`, programs: [`${pm} test`], args: [], shell: true });
    } else if (typeof t === 'string' && editorLaunchInCheck(cwd, 'npm test', pkg.scripts)) unknown('automatic package check requires an editor or could not be established as headless');
  } catch (e) { if (e.code !== 'ENOENT') unknown('package metadata could not be read or parsed'); }
  if (!found.length) return null;
  const best = Math.min(...found.map((f) => f.rank));
  const top = found.filter((f) => f.rank === best);
  if (top.length !== 1) unknown('best check candidates are ambiguous');
  return top.length === 1 ? top[0] : null;
}

// Whether a bare program name resolves on PATH the way a shell looks it up
// (PATHEXT on Windows, so npm finds npm.cmd). A name with a path in it is left
// to the run itself. The gate asks before it runs a check through a shell,
// because a shell's not-found answer is neither portable nor readable: sh says
// 127, cmd.exe 9009 or, through the watchdog, 1, and in the machine's language.
export function onPath(name, { env = process.env, platform = process.platform, isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } } } = {}) {
  if (!name || /[\\/]/.test(name)) return true;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const dirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? ['', ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  return dirs.some((d) => exts.some((e) => isFile(join(d, name + e))));
}

// Runs the check under the watchdog, which ends the whole tree at the limit.
// { outcome: 'pass'|'fail', excerpt, output } once it finished, or
// { outcome: 'unfinished', why } when it ran out of time or could not start.
export function runVisibleCheck(found, cwd, { timeoutMs = GATE_CHECK_MS, onPathFn = onPath } = {}) {
  const shownProgram = String(found.command || found.programs[0] || '').split(' ')[0];
  if (found.shell && !onPathFn(shownProgram)) return { outcome: 'unfinished', why: `could not start (no ${shownProgram} on PATH)` };
  let r = null;
  for (const program of found.programs) {
    r = runSync(program, found.args, { cwd, timeoutMs, shell: found.shell, env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, maxBuffer: 2 * 1024 * 1024 });
    // Only a program that is not there sends the gate to the next name. On
    // Windows that includes the Store's python.exe stand-in, which prints
    // "Python was not found" and exits 9009 (cmd.exe's not-found code).
    const absent = (r.status === null && !r.timedOut && r.error && /ENOENT|not found|cannot find/i.test(String(r.error.message || r.error))) || (process.platform === 'win32' && r.status === 9009);
    if (!absent) break;
  }
  // Through a shell (npm test), a program that is not there is the shell's
  // not-found exit, 127 from sh and 9009 from cmd.exe: not a failing check.
  if ((process.platform === 'win32' && r.status === 9009) || (found.shell && process.platform !== 'win32' && r.status === 127)) return { outcome: 'unfinished', why: `could not start (no ${shownProgram} on PATH)` };
  if (r.timedOut) return { outcome: 'unfinished', why: `stopped at ${Math.round(timeoutMs / 1000)} s (a change that never returns, or a check slower than the gate waits for)` };
  if (r.status === null) return { outcome: 'unfinished', why: `could not start (${clip(String(r.error && r.error.message || r.error || 'no exit status'), 120)})` };
  const output = `${r.stdout || ''}${r.stdout && r.stderr ? '\n' : ''}${r.stderr || ''}`;
  const v = integrity.verdict({ tool_response: { stdout: r.stdout || '', stderr: r.stderr || '', exit_code: r.status } });
  return { outcome: v.outcome === 'pass' ? 'pass' : 'fail', excerpt: v.excerpt || '', output, status: r.status };
}

// The last lines of a failing check, where its runner puts the reason.
function tailLines(text, lines = 20, chars = 1500) {
  const kept = String(text || '').replace(/\r\n/g, '\n').trimEnd().split('\n').slice(-lines).join('\n');
  return kept.length > chars ? `\u2026${kept.slice(-(chars - 1))}` : kept;
}

// Whether this stop wants a check it does not have: it would hold the reply for
// the want of one (a done claim, a pass claim with no check at all this turn,
// or the second-pass request, which asks for a check when none ran after the
// edit), or the reply ends on the pass line with no check after the last edit,
// which is the reply the brief tells the model atlias will check for it.
export function needsCheck({ turn, last, files, flags, v, quiet = false }) {
  if (flags.gatecheck) return false;
  const code = files.filter(isCodeFile);
  const honest = integrity.HONEST_RE.test(last);
  const noneAfterEdit = !integrity.verificationAfterLastEdit(turn);
  // flags.quietDoneClaim: the gate checks every code edit left unchecked, whatever the reply says,
  // so a brief that says "atlias runs the check after you finish" is true for every reply.
  if (quiet && code.length && noneAfterEdit) return true;
  if (code.length && noneAfterEdit && !honest && PASS_RE.test(last)) return true;
  if (v.integrity !== false && !honest) {
    if (!flags.passclaim && integrity.PASS_CLAIM_RE.test(last) && !integrity.passingVerification(turn)) return true;
    if (!flags.doneclaim && !flags.passclaim && code.length && integrity.DONE_RE.test(last) && noneAfterEdit) return true;
  }
  return Boolean(v.doublePass && !flags.double && code.length && !PASS_RE.test(last) && noneAfterEdit);
}

// flags.passLineNeedsCheck (off by default, 2026-10-13): the pass line was taken
// on its words, so a reply could name both passes with no check after the last
// edit (7 of 21 gate decisions in trial-02, c10 F2). With the flag the line
// counts only when a check ran after the last edit, the gate ran one itself, or
// the reply says plainly that it could not check.
export function passLineWithoutCheck({ turn, last, code, ran, on }) {
  return Boolean(on && code.length && PASS_RE.test(last) && !ran && !integrity.HONEST_RE.test(last) && !integrity.verificationAfterLastEdit(turn));
}

// The second argument is the host name the dispatcher passes to every handler;
// Claude and Codex recover only their own native transcript records.
// deps.run stands in for the process runner, so a test can make
// one git or parser call time out and prove the gate still speaks once.
export function stop(payload, host, deps = {}) {
  const cfg = config();
  const sid = payload.session_id || 'no-session';
  const cwd = payload.cwd || process.cwd();
  const last = String(payload.last_assistant_message || '');
  const { promptId, promptAt, turn, since, apart } = turnEvents(sid, subagentTag(payload, cfg).subagent);
  const known = changedFiles(turn, cwd);
  // Edits made through the shell never produce an edit event, so ask git. A
  // file a subagent edited is not this session's, even when git lists it.
  const turnStart = since;
  const apartFiles = changedFiles(apart, cwd);
  const unseen = turnStart ? shellChangedFiles(cwd, turnStart).filter((f) => !known.includes(f) && !apartFiles.includes(f)) : [];
  let files = known.concat(unseen);
  if (!payload.stop_hook_active && host === 'codex' && payload.transcript_path && (files.length || integrity.PASS_CLAIM_RE.test(last) || integrity.DONE_RE.test(last))) {
    try {
      track.recoverCodexChecks(payload, turn, { files, promptAt });
      files = [...new Set(files.concat(changedFiles(turn, cwd)))];
    } catch { /* unreadable or unscoped native evidence remains unknown */ }
  }
  // Before saying no check ran after the last edit, ask the transcript: a hook
  // call Claude Code cancelled leaves a check that ran unrecorded.
  if (!payload.stop_hook_active && payload.transcript_path && (!host || host === 'claude') && !lastVerificationAfterEdit(turn) && (files.length || integrity.PASS_CLAIM_RE.test(last))) {
    try { track.recoverChecks(payload, turn); } catch { /* no transcript answer: as before */ }
  }
  // A turn that changed nothing has nothing to hand off, and rewriting the note
  // with an empty one would throw away the last turn that did.
  const worthNoting = files.length || turn.some((e) => e.kind === 'shell' || e.kind === 'deny' || e.kind === 'destructive');
  if (worthNoting) { try { progress.update(cwd, sid, last, subagentTag(payload, cfg).subagent || ''); } catch { /* the note is a convenience */ } }
  if (payload.stop_hook_active) return null;
  const metaSid = actorSession(payload, cfg);
  const meta = sessionMeta(metaSid);
  const flags = (meta.gate && meta.gate[promptId]) || {};
  // Only the current turn is ever consulted, so keep a short tail rather than
  // carrying every prompt of a long session in a file rewritten each reply.
  const KEEP_FLAGS = 25;
  const setFlags = (keys) => {
    if (!keys.length) return;
    const merged = { ...flags };
    for (const k of keys) merged[k] = true;
    const all = { ...(meta.gate || {}), [promptId]: merged };
    const ids = Object.keys(all);
    const kept = {};
    for (const key of ids.slice(-KEEP_FLAGS)) kept[key] = all[key];
    saveSessionMeta(metaSid, { ...meta, gate: kept });
  };
  const v = cfg.verify || {};
  const quiet = Boolean(cfg.flags && cfg.flags.quietDoneClaim === true);
  const integrityCfg = { stubs: v.stubs, weakenedTests: v.weakenedTests, unwired: v.unwired, ...(quiet ? { doneClaim: false } : {}) };

  // flags.gateRunsCheck: the gate runs the project's check itself rather than
  // hold the reply for the want of one. Off, nothing here runs.
  let ran = null;
  let unfinishedRun = null;
  const found = cfg.flags && cfg.flags.gateRunsCheck && needsCheck({ turn, last, files, flags, v, quiet }) ? visibleCheck(cwd) : null;
  if (found) {
    const r = runVisibleCheck(found, cwd, { timeoutMs: deps.checkMs || GATE_CHECK_MS });
    if (r.outcome === 'unfinished') unfinishedRun = { flag: 'gatecheck', what: `the project's check \`${found.command}\`, which atlias ran itself and which ${r.why}` };
    else {
      ran = { kind: 'shell', command: clip(found.command, 300), verify: true, outcome: r.outcome, from: 'gate', ...(r.excerpt ? { excerpt: clip(r.excerpt, 200) } : {}) };
      recordEvent(sid, { ...ran, ...subagentTag(payload, cfg) });
      turn.push({ t: Date.now(), ...ran });
      ran.output = r.output;
      ran.status = r.status;
    }
  }
  const failedRun = ran && ran.outcome === 'fail'
    ? `The project's check failed. The available evidence did not establish the claimed result, so atlias ran it.\n  Command: ${ran.command} (exit ${ran.status})\n  Output:\n    ${(tailLines(ran.output) || ran.excerpt || '(no output)').replace(/\n/g, '\n    ')}\nWhy it matters: the reply was about to end on a change that fails the project's own check.\nFix: correct what the output names, run \`${ran.command}\` again, and finish when it passes.`
    : null;
  // The failure is the one finding about checks; a pass claim is not raised
  // against it a second time.
  const claimFlags = failedRun ? { ...flags, passclaim: true } : flags;

  // A claim that a check passed needs no changed file to be false.
  if (!files.length) {
    if (v.integrity === false) return null;
    const claims = integrity.check({ cwd, turn, last, files: [], flags: claimFlags, cfg: { stubs: false, weakenedTests: false, unwired: false } });
    if (failedRun) claims.unshift({ flag: 'gatecheck', text: failedRun });
    if (!claims.length) return null;
    if (unfinishedRun) claims.push({ flag: 'gatecheck', text: `A check that could not finish: ${unfinishedRun.what}.\nWhy it matters: an unfinished check is not a passed one.\nFix: run it yourself, and say what it printed, before saying it passes.` });
    setFlags(claims.map((c) => c.flag));
    return block(report(claims.map((c) => c.text)));
  }

  // Everything that is wrong goes into ONE block. Once a Stop hook blocks, the
  // host continues with stop_hook_active set and this gate stays silent for
  // the rest of that chain, so a finding held back for later is never heard.
  const sections = [];
  const raised = [];

  // One syntax report serves the syntax check and the second-pass note, and it
  // is never built when both are switched off.
  const wanted = v.syntax || v.doublePass;
  const rep = wanted ? syntaxCheckDetailed(files, deps) : { failures: [], checked: [], skipped: [], missing: [], unchecked: [] };
  if (v.syntax && !flags.syntax && rep.failures.length) {
    raised.push('syntax');
    const list = rep.failures.map((f) => `  ${f.file}\n    ${f.error.replace(/\n/g, '\n    ')}`).join('\n');
    // Raising the flag spends the syntax check for this prompt, so a file whose
    // parser did not finish has to be named now or never.
    const notRun = rep.unchecked.length ? `\nNot checked, because the parser did not finish: ${rep.unchecked.map((u) => u.file).join(', ')}.` : '';
    sections.push(`Syntax: files that do not parse.\n${list}${notRun}\nWhat went wrong: a change was declared finished without the cheapest possible check.\nWhy it matters: a syntax error fails every caller at once, and the user finds it instead of you.\nFix: repair each file, re-run the check (node --check, JSON.parse, py_compile), then finish.`);
  }

  // Checks that could not finish: a git or parser call that timed out. Left
  // alone they are a finding postponed, and a postponed finding is how this
  // gate spoke twice for one prompt on a loaded machine (seen: git grep past its
  // budget on the first stop, then "nothing calls" alone on the second). So
  // they are collected, and if this stop blocks they are named in the block and
  // spent with everything else.
  const incomplete = [];
  if (v.syntax && !flags.syntax && !rep.failures.length && rep.unchecked.length) incomplete.push({ flag: 'syntax', what: `the syntax check of ${rep.unchecked.map((u) => path.relative(cwd, u.file) || u.file).join(', ')}` });
  if (unfinishedRun) incomplete.push(unfinishedRun);
  if (failedRun) { raised.push('gatecheck'); sections.push(failedRun); }

  if (v.integrity !== false) {
    for (const f of integrity.check({ cwd, turn, last, files, flags: claimFlags, cfg: integrityCfg, incomplete, deps })) {
      raised.push(f.flag);
      sections.push(f.text);
    }
  }

  const code = files.filter(isCodeFile);
  if (v.doublePass && !flags.double && passLineWithoutCheck({ turn, last, code, ran, on: Boolean(cfg.flags && cfg.flags.passLineNeedsCheck === true) })) {
    raised.push('double');
    sections.push(`The pass line: ${code.length} file(s) changed this turn and the reply names both passes, but no check ran after the last edit.\nChanged: ${code.map((f) => path.relative(cwd, f) || f).join(', ')}\nWhy it matters: a pass named without a check is a claim, not evidence.\nFix: run the smallest real check now (the project's own check if it has one), correct what it finds, then end with the pass line. If no check can run here, say so in plain words instead.`);
  }
  if (v.doublePass && !flags.double && code.length && !PASS_RE.test(last)) {
    raised.push('double');
    const checks = turn.filter((e) => e.kind === 'shell' && e.verify).map((e) => e.command);
    const viaShell = unseen.length ? `\nChanged without an edit tool, found by git: ${unseen.map((f) => path.relative(cwd, f) || f).join(', ')}. These are the ones nobody reviewed.` : '';
    const floor = rep.checked.length ? '' : rep.unchecked.length
      ? `\nNote: atlias's syntax check did not finish for ${rep.unchecked.length} of these files, so none of them was syntax-checked. The project's own check is the only floor here, so run it rather than assuming one ran.`
      : `\nNote: atlias could not syntax-check any of these files; it parses JavaScript, JSON and Python only. The project's own check is the only floor here, so run it rather than assuming one ran.`;
    // A check that already ran after the last edit and did not fail is pass one
    // done. Asking for it again cost a tool round in Claude Code (measured
    // 2026-09-28: the model re-ran a passing check, then replied), and every
    // round re-sends the whole context.
    // Files changed through the shell leave no edit event, so with any of those
    // the order of edit and check is unknown and the check is asked for again.
    // A check the gate ran itself ran after every edit, those git found included.
    const after = ran ? ran : unseen.length ? null : lastVerificationAfterEdit(turn);
    const fix = after && after.outcome !== 'fail'
      ? `Fix: do that pass now and correct what it finds. A check already ran after the last edit (${clip(after.command, 120)}), so run it again only if this pass changes a file; if the re-read finds nothing, no tool call is needed. End with one line that names both passes and what each found.`
      : 'Fix: do that pass now, correct what it finds, run the smallest real check, then end with one line that names both passes and what each found.';
    sections.push(`The second pass: ${code.length} file(s) changed this turn and the reply names only one bug-check.\nChanged: ${code.map((f) => path.relative(cwd, f) || f).join(', ')}\nChecks run so far: ${checks.length ? checks.join(' | ') : 'none recorded'}\nWhat is missing: the adversarial pass. Re-read each changed file asking where a bug would hide: empty or missing input, Windows paths and encodings, callers that assumed the old behaviour, off-by-one at boundaries, an error path that swallows the failure.${viaShell}${floor}\n${fix}`);
  }

  if (!sections.length) return null;
  const spent = incomplete.filter((c) => !raised.includes(c.flag));
  if (spent.length) {
    sections.push(`Checks that could not finish this time (a git or parser call ran out of time, which a busy machine does): ${spent.map((c) => c.what).join('; ')}.\nWhy it matters: an unfinished check is not a passed one, and this gate will not come back to it for this prompt.\nFix: run the project's own check for these yourself before calling the work done.`);
  }
  setFlags([...raised, ...spent.map((c) => c.flag)]);
  return block(report(sections));
}

// One block, numbered, with the rule for dismissing a false alarm at the end.
export function report(sections) {
  const head = sections.length === 1 ? 'atlias gate: one thing to settle before this reply ends.' : `atlias gate: ${sections.length} things to settle before this reply ends.`;
  const body = sections.map((s, i) => `\n\n${i + 1}. ${s}`).join('');
  return `${head}${body}\n\nThis gate speaks once per prompt. Fix what is real. For anything you checked and found to be a false alarm, say so in the reply with the reason.`;
}
