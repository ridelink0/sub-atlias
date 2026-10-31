#!/usr/bin/env node
// The Claude Code token study driver: N tasks x K arms, headless, graded by
// each task's own check with its hidden graders written in only after the
// model stops (lib/eval.mjs's rule), one fresh workspace and one fresh HOME per
// task per arm, every run's cost added to a running total that a cap stops.
//
//   node tools/ccstudy/run.mjs --tasks <list.json> --arms plain,atlias@41f9ba6 \
//     --out <dir> [--model claude-sonnet-5] [--effort medium] [--concurrency 3]
//     [--spend <file>] [--cap 35] [--stop-at <dollars>] [--run-budget 3]
//     [--timeout-min 20] [--work <dir>] [--only id,id]
//
// Rows go to <out>/rows.jsonl as each run finishes, and a run that stops can be
// started again with the same arguments: pairs already in rows.jsonl are
// skipped. tools/ccstudy/summary.mjs turns the rows into the report.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as S from './lib.mjs';
import { score, tamper } from '../../lib/eval.mjs';
import { looksLikeVerification } from '../../lib/core.mjs';
import { RUNNER, runsEditedFile } from '../../lib/track.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// atlias's own rule for "this command checked the work", from the checkout the
// driver runs in: a known test runner or check script, or running a file the
// turn edited.
export function isCheck(command, edited) {
  return looksLikeVerification(command) || (RUNNER.test(String(command || '')) && runsEditedFile(command, edited));
}
// The study's wider reading: any interpreter run (node, python, ...) after the
// last edit, whatever atlias's classifier makes of it.
export function isRun(command) { return RUNNER.test(` ${String(command || '')}`); }

function opt(argv, name, dflt = '') {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
}

export function readSpend(file) {
  try { const n = Number(String(fs.readFileSync(file, 'utf8')).trim()); return Number.isFinite(n) ? n : 0; } catch { return 0; }
}
// One number, rewritten after every run. Serialised through a promise chain so
// concurrent runs cannot lose an addition.
let spendChain = Promise.resolve();
export function addSpend(file, usd) {
  spendChain = spendChain.then(() => {
    const now = readSpend(file) + (Number(usd) || 0);
    fs.writeFileSync(file, `${now.toFixed(6)}\n`);
    return now;
  });
  return spendChain;
}

// A checkout of one SHA as a plugin folder, made once per study with git
// archive so the arm runs exactly the committed tree of that SHA.
export function materializeArm(ref, work) {
  const full = spawnSync('git', ['-C', REPO, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' });
  if (full.status !== 0) throw new Error(`no commit ${ref}: ${full.stderr}`);
  const sha = full.stdout.trim();
  const dir = path.join(work, 'arms', sha.slice(0, 12));
  if (!fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) {
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync('sh', ['-c', `git -C "${REPO}" archive ${sha} | tar -x -C "${dir}"`], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`could not export ${sha}: ${r.stderr}`);
  }
  let version = '';
  try { version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { /* unversioned */ }
  return { sha, short: sha.slice(0, 7), dir, version };
}

// The check's interpreter as this machine has it: the committed polyglot tasks
// carry the Windows path of the machine that converted them.
export function portableCheck(check, python = 'python') {
  const argv = Array.isArray(check) ? check.slice() : String(check).split(/\s+/).filter(Boolean);
  const base = String(argv[0] || '').split(/[\\/]/).pop();
  if (/^python[\d.]*(\.exe)?$/i.test(base) && !fs.existsSync(argv[0])) argv[0] = python;
  return argv;
}

export function writeFiles(dir, files) {
  for (const [rel, body] of Object.entries(files || {})) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, String(body));
  }
}

const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_');

function runClaude(argv, { cwd, env, timeoutMs, streamFile, errFile }) {
  return new Promise((resolve) => {
    const out = fs.openSync(streamFile, 'w');
    const err = fs.openSync(errFile, 'w');
    const t0 = Date.now();
    const child = spawn('claude', argv, { cwd, env, stdio: ['ignore', out, err], detached: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      fs.closeSync(out); fs.closeSync(err);
      // Anything the run left behind in its group (a hook's detached worker, a
      // server the model started) ends with it.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      resolve({ code, signal, timedOut, ms: Date.now() - t0 });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, signal: null, timedOut: false, error: String(e), ms: Date.now() - t0 }); });
  });
}

// One task in one arm, end to end.
export async function runOne(task, arm, ctx) {
  const armSlug = slug(arm.kind === 'plain' ? 'plain' : `atlias-${arm.short}${Object.keys(arm.flags).length ? '-flags' : ''}`);
  const base = path.join(ctx.work, 'runs', ctx.study, armSlug, slug(task.id));
  fs.rmSync(base, { recursive: true, force: true });
  const home = path.join(base, 'home');
  const ws = path.join(base, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  writeFiles(ws, task.files);
  const sessionId = crypto.randomUUID();
  const env = S.childEnv(process.env, { home, extra: arm.flags });
  const leaked = S.leakedKeys(env);
  if (leaked.length) throw new Error(`refusing to start: ${leaked.join(', ')} would reach the nested run`);
  const argv = S.claudeArgs({ prompt: task.prompt, sessionId, model: ctx.model, effort: ctx.effort, pluginDir: arm.kind === 'atlias' ? arm.dir : '', maxBudgetUsd: ctx.runBudget });
  const streamFile = path.join(base, 'stream.jsonl');
  const proc = await runClaude(argv, { cwd: ws, env, timeoutMs: ctx.timeoutMs, streamFile, errFile: path.join(base, 'stderr.txt') });

  // Grade: hidden files only now, then the task's own check, then whether the
  // graded files were touched.
  writeFiles(ws, task.hidden);
  const graded = { ...task, check: portableCheck(task.check, ctx.python) };
  const verdict = score(ws, graded);
  const cheat = tamper(ws, graded);
  const solved = Boolean(verdict.pass && cheat.files.length === 0);

  const analysis = analyzeRun({ base, sessionId, arm });
  const spendNow = await addSpend(ctx.spendFile, analysis.costUsd);
  return {
    arm: arm.name, armKind: arm.kind, sha: arm.sha || '', version: arm.version || '', flags: arm.flags,
    task: task.id, source: task.source || '', kind: task.kind || '',
    solved, why: cheat.files.length ? `graded file changed: ${cheat.files.map((f) => `${f.file} ${f.what}`).join(', ')}` : verdict.why,
    checkOutput: String(verdict.output || '').slice(0, 300),
    tampered: cheat.files.map((f) => `${f.file} ${f.what}`),
    ...analysis,
    exitCode: proc.code, timedOut: proc.timedOut,
    ms: proc.ms,
    sessionId,
    base,
    spendAfter: Number(spendNow.toFixed(6)),
    at: new Date().toISOString(),
  };
}

// Everything a row says about a run that is read from its saved files: the
// stream, and the transcripts under the run's own HOME. Separate from runOne so
// a study can be re-analysed (--reanalyze) without running anything again.
export function analyzeRun({ base, sessionId, arm }) {
  const home = path.join(base, 'home');
  const stream = S.readJsonl(path.join(base, 'stream.jsonl'));
  const init = stream.find((r) => r.type === 'system' && r.subtype === 'init') || null;
  const result = [...stream].reverse().find((r) => r.type === 'result') || null;
  const files = S.transcriptFiles(home);
  const mainFile = files.find((f) => path.basename(f) === `${sessionId}.jsonl`) || '';
  const mainRows = mainFile ? S.readJsonl(mainFile) : [];
  const allRows = files.flatMap((f) => S.readJsonl(f).map((r) => (f === mainFile ? r : { ...r, isSidechain: true })));
  const requests = S.requestsOf(allRows);
  let tokens = { ...S.ZERO_TOKENS };
  let subTokens = { ...S.ZERO_TOKENS };
  for (const q of requests) {
    const t = S.tokensOf(q.usage);
    tokens = S.addTokens(tokens, t);
    if (q.sidechain) subTokens = S.addTokens(subTokens, t);
  }
  // The result message's own per-model totals, kept beside the transcript's
  // so a difference between them is visible in the rows.
  let resultTokens = { ...S.ZERO_TOKENS };
  for (const mu of Object.values((result && result.modelUsage) || {})) {
    resultTokens = S.addTokens(resultTokens, S.tokensOf({ input_tokens: mu.inputTokens, cache_read_input_tokens: mu.cacheReadInputTokens, cache_creation_input_tokens: mu.cacheCreationInputTokens, output_tokens: mu.outputTokens }));
  }
  const holds = S.holdsOf(mainRows, isCheck, isRun);
  const hookCalls = S.hookCallsOf(stream);
  const cancelledT = S.cancelledInTranscript(allRows);
  const brief = S.briefOf(stream);
  const gateChecks = S.gateChecksOf(home);
  return {
    promptRaw: tokens.promptRaw, promptBilled: Math.round(tokens.promptBilled),
    input: tokens.input, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite, cacheWrite5m: tokens.cacheWrite5m, cacheWrite1h: tokens.cacheWrite1h, output: tokens.output,
    cacheSplitKnown: tokens.splitKnown,
    subagentPromptRaw: subTokens.promptRaw,
    resultPromptRaw: resultTokens.promptRaw,
    costUsd: result && typeof result.total_cost_usd === 'number' ? result.total_cost_usd : 0,
    rounds: requests.filter((q) => !q.sidechain).length,
    subagentRequests: requests.filter((q) => q.sidechain).length,
    numTurns: result ? result.num_turns ?? null : null,
    holds: holds.length,
    holdsAtlias: holds.filter((h) => h.atlias).length,
    holdsInStream: S.streamHolds(stream),
    holdsNoCheck: holds.filter((h) => h.saysNoCheck).length,
    holdsNoCheckFalse: holds.filter((h) => h.falseNoCheck).length,
    holdsNoCheckFalseBroad: holds.filter((h) => h.falseNoCheckBroad).length,
    holdDetail: holds,
    briefChars: brief ? brief.chars : null,
    briefLean: brief ? brief.lean : null,
    briefSaysGateRunsCheck: brief ? brief.gateRunsCheck : null,
    gateChecks: gateChecks.length,
    gateChecksFailed: gateChecks.filter((c) => c.outcome === 'fail').length,
    gateCheckDetail: gateChecks,
    hookCalls: hookCalls.length,
    hookCallsCancelled: hookCalls.filter((c) => c.cancelled).length,
    hookCancelledByEvent: hookCalls.filter((c) => c.cancelled).reduce((acc, c) => { acc[c.event || c.name] = (acc[c.event || c.name] || 0) + 1; return acc; }, {}),
    cancelledInTranscript: cancelledT.n,
    cancelledInTranscriptKinds: cancelledT.kinds,
    isError: result ? Boolean(result.is_error) : true,
    resultSubtype: result ? result.subtype || '' : 'no result',
    terminalReason: result ? result.terminal_reason || '' : '',
    model: init ? init.model || '' : '',
    modelsUsed: Object.keys((result && result.modelUsage) || {}),
    ccVersion: init ? init.claude_code_version || '' : '',
    initProblems: S.initProblems(init, arm),
    plugins: init ? (init.plugins || []).map((p) => p.name || p) : [],
    mcpServers: init ? (init.mcp_servers || []).map((m) => `${m.name || m}:${m.status || ''}`) : [],
  };
}

export function loadTaskList(file) {
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  return list.tasks.map((t) => {
    const task = JSON.parse(fs.readFileSync(path.resolve(REPO, t.file), 'utf8'));
    return { ...task, source: t.source || '' };
  });
}

async function main(argv) {
  const re = opt(argv, '--reanalyze');
  if (re) {
    const file = path.join(path.resolve(re), 'rows.jsonl');
    const rows = S.readJsonl(file).map((r) => ({ ...r, ...analyzeRun({ base: r.base, sessionId: r.sessionId, arm: { kind: r.armKind } }) }));
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`re-analysed ${rows.length} row(s) in ${file}; grading and spend are unchanged`);
    return;
  }
  const tasksFile = opt(argv, '--tasks');
  const out = path.resolve(opt(argv, '--out'));
  if (!tasksFile || !opt(argv, '--out')) throw new Error('usage: run.mjs --tasks <list.json> --arms plain,atlias@<ref> --out <dir>');
  const work = path.resolve(opt(argv, '--work', path.join(os.tmpdir(), 'ccstudy')));
  const cap = Number(opt(argv, '--cap', '35'));
  const stopAt = Number(opt(argv, '--stop-at', String(cap)));
  const spendFile = path.resolve(opt(argv, '--spend', path.join(out, 'spend.txt')));
  const ctx = {
    work, spendFile,
    study: slug(opt(argv, '--study', path.basename(out))),
    model: opt(argv, '--model', 'claude-sonnet-5'),
    effort: opt(argv, '--effort', 'medium'),
    runBudget: Number(opt(argv, '--run-budget', '3')),
    timeoutMs: Number(opt(argv, '--timeout-min', '20')) * 60000,
    python: opt(argv, '--python', 'python'),
  };
  const concurrency = Math.max(1, Number(opt(argv, '--concurrency', '3')));
  const only = opt(argv, '--only') ? new Set(opt(argv, '--only').split(',')) : null;
  fs.mkdirSync(out, { recursive: true });
  const arms = S.splitArms(opt(argv, '--arms', 'plain')).map((s) => S.parseArm(s));
  for (const a of arms) if (a.kind === 'atlias') Object.assign(a, materializeArm(a.ref, work));
  // A flag the arm's own checkout does not know, or a value it cannot parse,
  // would run that arm as the control and score it as the change: stop first.
  for (const a of arms) {
    if (a.kind !== 'atlias' || !Object.keys(a.flags).length) continue;
    const core = await import(pathToFileURL(path.join(a.dir, 'lib', 'core.mjs')).href);
    const e = core.envFlags(a.flags);
    if (e.unknown.length || e.bad.length) throw new Error(`arm ${a.name}: atlias@${a.short} does not know ${[...e.unknown, ...e.bad.map((b) => b.error)].join('; ')}`);
    a.flagValues = e.values;
  }
  let tasks = loadTaskList(tasksFile);
  if (only) tasks = tasks.filter((t) => only.has(t.id));
  const rowsFile = path.join(out, 'rows.jsonl');
  const done = new Set(S.readJsonl(rowsFile).map((r) => `${r.arm}|${r.task}`));
  const jobs = [];
  for (const t of tasks) for (const a of arms) if (!done.has(`${a.name}|${t.id}`)) jobs.push({ t, a });
  fs.writeFileSync(path.join(out, 'arms.json'), `${JSON.stringify(arms.map((a) => ({ name: a.name, kind: a.kind, ref: a.ref, sha: a.sha || '', version: a.version || '', flags: a.flags, flagValues: a.flagValues || {}, pluginDir: a.dir || '' })), null, 2)}\n`);
  console.log(`${jobs.length} run(s) to do (${done.size} already in ${rowsFile}); spend so far $${readSpend(spendFile).toFixed(4)}, cap $${cap}, stop at $${stopAt}`);
  // The dearest run seen so far; before any, --first-estimate.
  const firstEstimate = Number(opt(argv, '--first-estimate', '1'));
  let dearest = 0;
  let stopped = '';
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !stopped) {
      // Room for every run in flight at the dearest cost seen so far.
      const est = dearest || firstEstimate;
      const need = readSpend(spendFile) + est * concurrency;
      if (need > Math.min(cap, stopAt)) { stopped = `spend $${readSpend(spendFile).toFixed(2)} plus ${concurrency} run(s) at up to $${est.toFixed(2)} would pass $${Math.min(cap, stopAt)}`; break; }
      const { t, a } = jobs[next++];
      let row;
      try { row = await runOne(t, a, ctx); } catch (e) { console.log(`ERROR ${a.name} ${t.id}: ${e && e.stack ? e.stack : e}`); continue; }
      dearest = Math.max(dearest, row.costUsd || 0);
      fs.appendFileSync(rowsFile, `${JSON.stringify(row)}\n`);
      console.log(`${row.solved ? 'PASS' : 'FAIL'} ${a.name} ${t.id}: $${row.costUsd.toFixed(3)} raw ${row.promptRaw} billed ${row.promptBilled} rounds ${row.rounds} holds ${row.holds} cancelled ${row.hookCallsCancelled}/${row.hookCalls}${row.initProblems.length ? ` ISOLATION: ${row.initProblems.join('; ')}` : ''} | total $${row.spendAfter.toFixed(3)}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (stopped) console.log(`STOPPED: ${stopped}`);
  console.log(`spend now $${readSpend(spendFile).toFixed(4)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
}
