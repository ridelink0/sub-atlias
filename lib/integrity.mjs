// Integrity: the checks that stop a reply from claiming work that did not
// happen. Each one looks for one specific way an agent says "done" when it is
// not, which is the failure people complain about most in coding agents:
//
//   1. it says a check passed when no check ran this turn
//   2. it says the tests pass when the last test run failed
//   3. it says the work is done but nothing was verified after the last edit
//   4. it left stubs, TODOs or elided code in what it just wrote
//   5. it made a test pass by weakening the test: skip, only, removed asserts
//   6. it added a function or class that nothing calls, so the feature is not
//      wired in and only looks finished
//
// Checks 4 to 6 need a diff, so they read git and stay silent outside a
// repository rather than guess. Every finding says what happened, why it
// matters and how to fix it, and names the way to dismiss a false positive.
import fs from 'node:fs';
import path from 'node:path';
import { run, clip, isCodeFile, config } from './core.mjs';

// ---------- what a reply claims ----------
export const DONE_RE = /\b(done|finished|completed?|implemented|fixed|resolved|all set|ready (to|for) (ship|merge|use|review)|works now|now works|working now|is working|should work now)\b/i;
export const PASS_CLAIM_RE = /\b(all\s+)?(tests?|checks?|suites?|specs?|builds?|lint)\s+(now\s+)?(pass(es|ed|ing)?|succeed(s|ed)?|(are|is)\s+green|green)\b|\b(passing|green)\s+(tests?|checks?|builds?)\b|\bno\s+(test\s+)?failures\b/i;
// A reply that says plainly it could not verify is being honest, not claiming.
export const HONEST_RE = /\b(untested|not (been )?(tested|verified|run)|unverified|could(n't| not) (run|test|verify)|did(n't| not) (run|test|verify)|without (running|testing)|was not able to (run|test|verify)|unable to (run|test|verify))\b/i;

// ---------- what a test run said ----------
// Output that means a check failed, across the runners people actually use.
// "0 failed" must not match, so a count is only a failure when it is 1 or more.
export const FAIL_RE = /^\s*FAIL\b|\b[1-9]\d*\s+(failed|failing|errors?|failures?)\b|\bAssertionError\b|Traceback \(most recent call last\)|npm ERR!|\berror TS\d{3,5}\b|\bpanicked at\b|BUILD FAILED|FAILURES!|^\s*\[FAIL\]|^not ok \d+/m;

export function responseText(payload) {
  const r = payload == null ? null : (payload.tool_response ?? payload.tool_result ?? payload.tool_output ?? payload.response ?? null);
  if (r == null) return { text: '', code: null, interrupted: false };
  if (typeof r === 'string') return { text: r, code: null, interrupted: false };
  const parts = [r.stdout, r.stderr, r.output, r.result, typeof r.content === 'string' ? r.content : null];
  if (Array.isArray(r.content)) for (const c of r.content) if (c && typeof c.text === 'string') parts.push(c.text);
  const text = parts.filter((x) => typeof x === 'string' && x).join('\n');
  const raw = r.exit_code ?? r.exitCode ?? r.returnCode ?? r.return_code ?? r.code;
  const code = Number.isInteger(raw) ? raw : null;
  return { text, code, interrupted: Boolean(r.interrupted) };
}

function failExcerpt(text) {
  const lines = String(text || '').split(/\r?\n/);
  const hit = lines.find((l) => FAIL_RE.test(l));
  return clip((hit || lines.filter((l) => l.trim()).slice(-1)[0] || '').trim(), 200);
}

// pass: the runner said so (exit 0). fail: a non-zero exit, an interrupt, or
// failure output. unknown: nothing to go on, which is never treated as a pass.
export function verdict(payload) {
  const { text, code, interrupted } = responseText(payload);
  if (interrupted) return { outcome: 'fail', excerpt: 'the command was interrupted' };
  if (code !== null && code !== 0) return { outcome: 'fail', excerpt: failExcerpt(text) || `exit code ${code}` };
  if (FAIL_RE.test(text)) return { outcome: 'fail', excerpt: failExcerpt(text) };
  if (code === 0) return { outcome: 'pass' };
  return { outcome: 'unknown' };
}

// ---------- evidence in the turn ----------
export const isVerifyEvent = (e) => (e.kind === 'shell' && e.verify) || (e.kind === 'tool' && /harness_verify/i.test(String(e.tool || '')));

// flags.checkFailDominates (off by default, 2026-10-13): a failed check stays
// failed until the same command runs again and does not fail. Without it any
// later check that exits 0 counts: in trial-02 a print-only `python -c` run
// after a failing check.py let a failed run end (c18 F6, plan-check-2 item 3).
// Callers that pass nothing follow the setting, so the gate and check() agree.
export const failDominates = () => { try { return config().flags.checkFailDominates === true; } catch { return false; } };
// Codex's audit of 2026-10-13 (F1, F2): only an explicit pass of the same check
// clears a failure (an outcome nobody could read is not a pass), and the same
// check means the same command in the same directory. Spaces between words are
// collapsed; text inside quotes is kept byte for byte; a command longer than the
// 300 characters an event keeps is told apart by checkId, the hash of its whole
// text and directory that lib/track.mjs records under this flag.
export function canonicalCommand(command) {
  let out = '', quote = '', escaped = false, gap = false;
  for (const ch of String(command || '').trim()) {
    if (quote) {
      out += ch;
      if (escaped) escaped = false;
      else if (quote === '"' && ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (/\s/.test(ch)) { gap = true; continue; }
    if (gap) { out += ' '; gap = false; }
    if (ch === '"' || ch === "'") quote = ch;
    out += ch;
  }
  return out;
}
const sameCheck = (a, b) => (a.checkId || b.checkId ? Boolean(a.checkId && b.checkId && a.checkId === b.checkId) : canonicalCommand(a.command) === canonicalCommand(b.command));
export function unresolvedFailure(events) {
  const checks = events.filter((e) => e.kind === 'shell' && e.verify);
  for (let i = checks.length - 1; i >= 0; i--) {
    const e = checks[i];
    if (e.outcome === 'fail' && !checks.slice(i + 1).some((l) => sameCheck(l, e) && l.outcome === 'pass')) return e;
  }
  return null;
}
export function verificationAfterLastEdit(turn, dominates = failDominates()) {
  let lastEdit = -1;
  for (let i = turn.length - 1; i >= 0; i--) if (turn[i].kind === 'edit') { lastEdit = i; break; }
  const after = turn.slice(lastEdit + 1);
  if (dominates && unresolvedFailure(after)) return false;
  return after.some((e) => isVerifyEvent(e) && (e.kind === 'tool' || e.outcome === 'pass' || e.outcome === 'fail'));
}
export function lastVerification(turn, dominates = failDominates()) {
  const failed = dominates ? unresolvedFailure(turn) : null;
  if (failed) return failed;
  for (let i = turn.length - 1; i >= 0; i--) if (turn[i].kind === 'shell' && turn[i].verify) return turn[i];
  return null;
}

// A positive claim needs the latest verification's explicit pass, after the
// latest edit. A stale pass or a later result with no outcome is insufficient.
export function passingVerification(turn) {
  if (failDominates() && unresolvedFailure(turn)) return false;
  let latest = -1;
  for (let i = turn.length - 1; i >= 0; i--) {
    if (latest < 0 && isVerifyEvent(turn[i])) latest = i;
    if (turn[i].kind === 'edit') return latest > i && turn[latest].outcome === 'pass';
  }
  return latest >= 0 && turn[latest].outcome === 'pass';
}

// ---------- diffs ----------
// Most directories are not repositories, and a git process per reply costs more
// than the whole check, so look for .git on disk before spawning anything.
const rootMemo = new Map();
export function hasGitAbove(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}
export function repoRoot(cwd, deps = {}) {
  if (!deps.run) {
    if (rootMemo.has(cwd)) return rootMemo.get(cwd);
    if (!hasGitAbove(cwd)) return null;
  }
  const r = (deps.run || run)('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 3000 });
  const root = r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : null;
  // Discovery errors do not prove there is no repository. Do not cache them:
  // one failed Git call must not switch integrity checks off for the session.
  if (r.status === null) { if (deps.why) deps.why.timedOut = true; return null; }
  if (!root) { if (deps.why) deps.why.failed = true; return null; }
  if (!deps.run) rootMemo.set(cwd, root);
  return root;
}

// Parse `git diff --unified=0` into added lines (with their new line numbers)
// and removed lines, keyed by absolute path.
export function parseDiff(text, root) {
  const added = [];
  const removed = [];
  let file = null;
  let line = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) { file = null; continue; }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      file = p === '/dev/null' ? null : path.join(root, p.replace(/^b\//, ''));
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { line = parseInt(hunk[1], 10); continue; }
    if (!file) continue;
    if (raw.startsWith('+')) { added.push({ file, line, text: raw.slice(1) }); line++; }
    else if (raw.startsWith('-')) removed.push({ file, text: raw.slice(1) });
  }
  return { added, removed };
}

// Everything this set of files adds or removes relative to the last commit.
// Untracked files count as wholly added. Returns null outside a repository.
// On macOS the temp directory is a symlink (/var is /private/var) and git
// reports the real path, so both sides are resolved before comparing, or every
// file looks like it sits outside the repository.
export function real(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}
export function diffFor(cwd, files, deps = {}) {
  const exec = deps.run || run;
  const why = {};
  const found = deps.root || repoRoot(cwd, { ...deps, why });
  // An absent repository is an answer; failed or empty Git discovery is not.
  // Keep those checks unfinished rather than reporting a clean diff.
  if (!found && (why.timedOut || why.failed) && files.length) return { root: null, added: [], removed: [], incomplete: true };
  if (!found || !files.length) return null;
  const root = real(found);
  const rels = files.map((f) => path.relative(root, real(f)).split(path.sep).join('/'))
    .filter((r) => r && !r.startsWith('..') && !path.isAbsolute(r));
  if (!rels.length) return null;
  const d = exec('git', ['-c', 'core.quotepath=off', 'diff', 'HEAD', '--unified=0', '--no-color', '--no-ext-diff', '--', ...rels], { cwd: root, timeout: 8000 });
  const parsed = d.status === 0 ? parseDiff(d.stdout, root) : { added: [], removed: [] };
  const u = exec('git', ['-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard', '--', ...rels], { cwd: root, timeout: 5000 });
  // A listed new file that cannot be read was not checked: that leaves the diff unfinished too.
  let unread = false;
  if (u.status === 0) {
    for (const rel of u.stdout.split(/\r?\n/).filter(Boolean)) {
      const full = path.join(root, rel);
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch { unread = true; continue; }
      text.split(/\r?\n/).forEach((t, i) => parsed.added.push({ file: full, line: i + 1, text: t }));
    }
  }
  // A git call that timed out (status null) or failed (any other non-zero exit,
  // such as git diff HEAD in a repository with no commit yet, exit 128) leaves the
  // diff partial: whatever it holds is still checked, and the checks are marked
  // unfinished rather than reading as a clean diff.
  return { root, ...parsed, incomplete: d.status !== 0 || u.status !== 0 || unread };
}

// ---------- 4. stubs ----------
export const STUB_PATTERNS = [
  [/\b(TODO|FIXME)\b/, 'a TODO or FIXME'],
  [/\bnot (yet )?implemented\b|NotImplementedError|unimplemented!\(|todo!\(/i, 'a not-implemented marker'],
  [/^\s*(\/\/|#|\/\*|<!--)\s*\.{3}/, 'elided code (a comment standing in for code)'],
  [/\b(rest|remainder) of (the )?(code|implementation|function|logic|file)\b/i, 'elided code'],
  [/\b(your|the) (code|logic|implementation) (goes )?here\b/i, 'a fill-in-here marker'],
  [/\b(placeholder|dummy|fake|hard-?coded) (data|values?|response|implementation|logic|result|output)\b/i, 'placeholder data'],
  [/lorem ipsum/i, 'lorem ipsum filler'],
];
// A bare test file at the root of a path counts too: test.mjs, tests.js,
// check.mjs and test.py are how a small project and every task in evals/ spell
// their suite, and a detector that only knows tests/ and *.test.js is silent
// about exactly the file a weakened suite is most likely to be.
export const TEST_FILE_RE = /(^|[\\/])(__tests__|tests?|spec)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go|rb)$|(^|[\\/])test_[^\\/]*\.py$|Tests?\.(java|kt|cs)$|(^|[\\/])(tests?|spec|check|verify)\.[cm]?[jt]sx?$|(^|[\\/])(tests?|check)\.py$/i;

export function findStubs(added) {
  const out = [];
  for (const a of added) {
    if (!isCodeFile(a.file) || TEST_FILE_RE.test(a.file) || /\.(md|json|ya?ml|toml)$/i.test(a.file)) continue;
    for (const [re, what] of STUB_PATTERNS) {
      if (re.test(a.text)) { out.push({ file: a.file, line: a.line, what, text: clip(a.text.trim(), 120) }); break; }
    }
  }
  return out;
}

// ---------- 5. weakened tests ----------
export const SKIP_PATTERNS = [
  [/\b(it|test|describe|context|suite)\.(skip|only|todo)\s*\(|\bx(it|test|describe)\s*\(|\bf(it|describe)\s*\(/, 'a skipped or focused test (.only runs one test and silently skips the rest)'],
  [/@pytest\.mark\.(skip|xfail)|pytest\.skip\(|@unittest\.skip|self\.skipTest\(|\bt\.Skip(f|Now)?\(/, 'a skipped test'],
  [/expect\(\s*(true|1)\s*\)\.(toBe|toEqual)\(\s*(true|1)\s*\)|\bassert\s+True\b|\bassert\s+1\s*==\s*1\b|assert\.ok\(\s*true\s*\)/, 'an assertion that cannot fail'],
  // A suite that exits successfully on its own line has stopped deciding
  // anything: this is the shape of a test rewritten to make a check pass.
  [/^\s*process\.exit\(\s*0\s*\)\s*;?\s*$|^\s*(?:sys\.)?exit\(\s*0\s*\)\s*$|^\s*process\.exitCode\s*=\s*0\s*;?\s*$/, 'a test that reports success without checking anything'],
];
// The last clause is how a script-shaped suite fails: no assert call, just a
// non-zero exit. Removing that is removing the only way the suite could fail.
const ASSERT_RE = /\bexpect\(|\bassert(Equal|True|False|Raises|In|Is|That|\.|\s|\()|\.should\b|\bt\.(Error|Fatal)f?\(|\bcheck\(|process\.exit\(\s*[1-9]|process\.exitCode\s*=\s*[1-9]/;

export function findWeakenedTests(added, removed) {
  const out = [];
  for (const a of added) {
    if (!TEST_FILE_RE.test(a.file)) continue;
    for (const [re, what] of SKIP_PATTERNS) {
      if (re.test(a.text)) { out.push({ file: a.file, line: a.line, what, text: clip(a.text.trim(), 120) }); break; }
    }
  }
  const byFile = new Map();
  for (const r of removed) if (TEST_FILE_RE.test(r.file) && ASSERT_RE.test(r.text)) byFile.set(r.file, (byFile.get(r.file) || 0) + 1);
  for (const [file, gone] of byFile) {
    const kept = added.filter((a) => a.file === file && ASSERT_RE.test(a.text)).length;
    if (gone > kept) out.push({ file, line: null, what: `${gone - kept} assertion(s) removed and not replaced`, text: '' });
  }
  return out;
}

// ---------- 6. unwired code ----------
export const DEF_PATTERNS = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/,
];
// Names a framework or runner calls by convention, so no reference is expected.
export const CONVENTION_NAMES = new Set([
  'main', 'constructor', 'render', 'setup', 'teardown', 'setUp', 'tearDown', 'handler', 'middleware', 'loader', 'action',
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'generateMetadata', 'generateStaticParams',
  'getServerSideProps', 'getStaticProps', 'getStaticPaths', 'init', 'run', 'default',
]);

export function newDefinitions(added) {
  const out = [];
  const seen = new Set();
  for (const a of added) {
    if (!isCodeFile(a.file) || TEST_FILE_RE.test(a.file)) continue;
    if (/\bexport\s+default\b/.test(a.text)) continue;
    for (const re of DEF_PATTERNS) {
      const m = re.exec(a.text);
      if (!m) continue;
      const name = m[1];
      if (name.length < 3 || CONVENTION_NAMES.has(name) || /^(test|_)/i.test(name) || /^__\w+__$/.test(name)) break;
      const key = `${a.file}\u0000${name}`;
      if (!seen.has(key)) { seen.add(key); out.push({ file: a.file, line: a.line, name }); }
      break;
    }
  }
  return out;
}

// A new name that appears on no line in the repository other than its own
// definition is not wired in: nothing can reach it.
export function findUnwired(root, defs, deps = {}, status = {}) {
  const exec = deps.run || run;
  const out = [];
  const started = Date.now();
  for (const d of defs.slice(0, 25)) {
    // Out of budget, or a grep that timed out, leaves names unasked: that is
    // an unfinished check, not a clean one, and status.incomplete says so.
    if (Date.now() - started > (deps.budgetMs || 8000)) { status.incomplete = true; break; }
    const r = exec('git', ['grep', '-I', '-w', '-c', '--untracked', '-e', d.name], { cwd: root, timeout: 3000 });
    if (r.status === null) { status.incomplete = true; continue; }
    // grep failed (exit 2 or more): no guess about the name, and the check is unfinished, not clean.
    if (r.status !== 0 && r.status !== 1) { status.incomplete = true; continue; }
    const total = String(r.stdout || '').split(/\r?\n/).filter(Boolean).reduce((n, l) => n + (parseInt(l.split(':').pop(), 10) || 0), 0);
    if (total <= 1) out.push(d);
  }
  return out;
}

// ---------- the report ----------
const rel = (cwd, f) => (path.relative(real(cwd), f) || f).split(path.sep).join('/');

// `incomplete`, when the caller passes an array, collects the checks that could
// not finish ({ flag, what }), so the gate can name them instead of raising
// them later as a second block.
export function check({ cwd, turn, last, files, flags = {}, cfg = {}, deps = {}, incomplete = [] }) {
  const findings = [];
  const code = files.filter(isCodeFile);
  const honest = HONEST_RE.test(last);

  // 1 and 2: what the reply says about checks, against what actually ran.
  if (!flags.passclaim && PASS_CLAIM_RE.test(last) && !honest) {
    const lastRun = lastVerification(turn);
    const anyRun = turn.some(isVerifyEvent);
    if (lastRun && lastRun.outcome === 'fail') {
      findings.push({ flag: 'passclaim', text: `The reply says the checks pass, but the last one that ran failed.\n  Command: ${lastRun.command}\n  Output: ${lastRun.excerpt || '(failure)'}\nWhy it matters: this is the most expensive kind of wrong, because the user stops looking.\nFix: make that command pass and show its result, or say plainly that it still fails.` });
    } else if (!anyRun) {
      findings.push({ flag: 'passclaim', text: `The reply says a check passed, but no check ran this turn.\nWhy it matters: a result that was never produced is a claim, not evidence.\nFix: run the check now and quote its result, or remove the claim.` });
    } else if (!passingVerification(turn)) {
      findings.push({ flag: 'passclaim', text: `The reply says a check passed, but its recorded result is unknown.\nWhy it matters: running a command does not establish that it succeeded.\nFix: inspect its actual result and report the evidence, or mark the outcome unverified.` });
    }
  }

  // 3: done, with nothing verified after the last edit.
  // A pass claim already raised covers this one for the whole prompt, or it
  // would surface as a second block the moment the first one is flagged.
  // cfg.doneClaim false (flags.quietDoneClaim): the gate ran any check it could name itself, so a
  // done reply is never held for the want of one; the model would only write its own (sprint smoke).
  if (cfg.doneClaim !== false && !flags.doneclaim && !flags.passclaim && !findings.some((f) => f.flag === 'passclaim') && code.length && DONE_RE.test(last) && !honest && !verificationAfterLastEdit(turn)) {
    findings.push({ flag: 'doneclaim', text: `The reply says the work is done, but nothing was run to check it after the last edit.\nWhy it matters: an edit made after the last check is an edit nobody checked.\nFix: run the smallest real check of the changed behaviour (the project's tests, a build, a request against it), or say plainly that it is untested.` });
  }

  // 4 to 6 need a diff.
  const wantDiff = (cfg.stubs !== false || cfg.weakenedTests !== false || cfg.unwired !== false) && (!flags.stubs || !flags.weakened || !flags.unwired);
  const diff = wantDiff && files.length ? diffFor(cwd, files, deps) : null;
  const unfinished = (flag, what) => { if (!incomplete.some((c) => c.flag === flag)) incomplete.push({ flag, what }); };
  if (diff && diff.incomplete) {
    if (cfg.stubs !== false && !flags.stubs) unfinished('stubs', 'the placeholder check (git diff did not finish or failed)');
    if (cfg.weakenedTests !== false && !flags.weakened) unfinished('weakened', 'the weakened-test check (git diff did not finish or failed)');
    if (cfg.unwired !== false && !flags.unwired) unfinished('unwired', 'the unwired-code check (git diff did not finish or failed)');
  }
  if (diff && diff.root) {
    if (cfg.stubs !== false && !flags.stubs) {
      const stubs = findStubs(diff.added);
      if (stubs.length) findings.push({ flag: 'stubs', text: `The code this turn added still has placeholders in it:\n${stubs.slice(0, 10).map((s) => `  ${rel(cwd, s.file)}:${s.line}  ${s.what}: ${s.text}`).join('\n')}${stubs.length > 10 ? `\n  and ${stubs.length - 10} more` : ''}\nWhy it matters: a stub that compiles looks finished and is not.\nFix: implement each one, or say in the reply which are deliberate and why.` });
    }
    if (cfg.weakenedTests !== false && !flags.weakened) {
      const weak = findWeakenedTests(diff.added, diff.removed);
      if (weak.length) findings.push({ flag: 'weakened', text: `Tests were weakened this turn:\n${weak.slice(0, 10).map((w) => `  ${rel(cwd, w.file)}${w.line ? ':' + w.line : ''}  ${w.what}${w.text ? ': ' + w.text : ''}`).join('\n')}\nWhy it matters: making a test easier to pass hides the bug it was written to catch, and it is the most common way an agent fakes success.\nFix: restore the test and fix the code instead. If the test itself was wrong, say so in the reply with the reason.` });
    }
    if (cfg.unwired !== false && !flags.unwired) {
      const grep = {};
      const unwired = findUnwired(diff.root, newDefinitions(diff.added), deps, grep);
      if (grep.incomplete) unfinished('unwired', 'the unwired-code check (git grep did not finish or failed)');
      if (unwired.length) findings.push({ flag: 'unwired', text: `New code that nothing calls:\n${unwired.slice(0, 8).map((u) => `  ${rel(cwd, u.file)}:${u.line}  ${u.name}`).join('\n')}\nWhy it matters: a function nothing reaches is a feature that only looks finished.\nFix: wire each one into the code path that needs it, or delete it. If it is a public API called from outside this repository, say so in the reply.` });
    }
  }
  return findings;
}
