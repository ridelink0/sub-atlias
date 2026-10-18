import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const MAX_ROUNDS = 10;
const FILE = path.join('.atlias', 'goals.json');
const LOCK = path.join('.atlias', 'goals.lock');
const RUN_LOCK = path.join('.atlias', 'goals.run.lock');
const SCHEMA = 'atlias.goals.v1';
const cleanText = (x, max) => typeof x === 'string' && x.trim() && x.length <= max && !/[\0]/.test(x);

export function goalFile(cwd) { return path.join(path.resolve(cwd), FILE); }
function validGoal(g) {
  return g && typeof g === 'object' && cleanText(g.id, 80) && cleanText(g.objective, 500)
    && ['active', 'paused', 'complete', 'deferred'].includes(g.status)
    && Number.isSafeInteger(g.maxRounds) && g.maxRounds >= 1 && g.maxRounds <= MAX_ROUNDS
    && Number.isSafeInteger(g.roundsUsed) && g.roundsUsed >= 0 && g.roundsUsed <= g.maxRounds
    && (g.revision === undefined || (Number.isSafeInteger(g.revision) && g.revision >= 1))
    && (g.check === null || cleanText(g.check, 500));
}
function readFile(cwd) {
  const file = goalFile(cwd);
  let stat;
  try { stat = fs.statSync(file); } catch (e) { return e.code === 'ENOENT' ? { schema: SCHEMA, cwd: path.resolve(cwd), active: null, history: [] } : { error: e.message }; }
  if (!stat.isFile() || stat.size > 256_000) return { error: 'goal file is not a regular file under 256 KB' };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.schema !== SCHEMA || path.resolve(data.cwd) !== path.resolve(cwd)
      || (data.active !== null && !validGoal(data.active))
      || !Array.isArray(data.history) || data.history.some((g) => !validGoal(g))) return { error: 'goal file has an unsupported or invalid shape' };
    return data;
  } catch { return { error: 'goal file is not valid JSON' }; }
}
function writeFile(cwd, data) {
  const file = goalFile(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try { fs.renameSync(temp, file); }
  catch (e) { try { fs.unlinkSync(temp); } catch { /* keep the original error */ } throw e; }
}
function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}
function acquireGoalLock(cwd) {
  const file = path.join(path.resolve(cwd), LOCK);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const create = () => {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
    finally { fs.closeSync(fd); }
  };
  try { create(); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw Error(`goal operation lock is unreadable; inspect ${file} before removing it`); }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw Error(`goal operation lock has no valid process id; inspect ${file} before removing it`);
    if (processExists(owner.pid)) throw Error(`another goal operation is in progress for this project (process ${owner.pid})`);
    try { fs.unlinkSync(file); } catch (stale) { throw Error(`stale goal lock could not be reclaimed: ${stale.message}`); }
    try { create(); } catch (retry) {
      if (retry.code === 'EEXIST') throw Error(`another goal operation started for this project; inspect ${file}`);
      throw retry;
    }
  }
  return () => { try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
}
function acquireContinuationLease(cwd) {
  const file = path.join(path.resolve(cwd), RUN_LOCK);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const create = () => {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })); }
    finally { fs.closeSync(fd); }
  };
  try { create(); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw Error(`continuation lease is unreadable; inspect ${file} before removing it`); }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw Error(`continuation lease has no valid process id; inspect ${file} before removing it`);
    if (processExists(owner.pid)) throw Error(`a continuation is already running for this project (process ${owner.pid})`);
    try { fs.unlinkSync(file); } catch (unlink) { throw Error(`stale continuation lease could not be reclaimed: ${unlink.message}`); }
    try { create(); } catch (retry) {
      if (retry.code === 'EEXIST') throw Error(`another continuation started for this project; inspect ${file}`);
      throw retry;
    }
  }
  return () => {
    try {
      const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (owner.token === token) fs.unlinkSync(file);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  };
}
export function readGoals(cwd) { return readFile(cwd); }
function saveGoal(cwd, data) { writeFile(cwd, data); return data; }
const revisionOf = (goal) => Number.isSafeInteger(goal?.revision) && goal.revision >= 1 ? goal.revision : 1;
const matchesApproval = (goal, approval) => Boolean(goal && approval && goal.status === 'active'
  && goal.id === approval.id && goal.objective === approval.objective && goal.check === approval.check
  && revisionOf(goal) === approval.revision);
function archiveActive(data) {
  if (data.active) data.history.unshift(data.active);
  data.history = data.history.slice(0, 50);
  data.active = null;
}
export function createGoal(cwd, objective, { check = null, rounds } = {}) {
  const release = acquireGoalLock(cwd);
  try {
  if (!cleanText(objective, 500)) throw Error('goal text must be 1 to 500 characters');
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) throw Error(`set an explicit round limit from 1 to ${MAX_ROUNDS}`);
  if (check !== null && !cleanText(check, 500)) throw Error('check command must be 1 to 500 characters');
  const data = readFile(cwd);
  if (data.error) throw Error(data.error);
  if (data.active && ['active', 'paused'].includes(data.active.status)) throw Error('an active goal already exists; complete, defer, or update it before replacing it');
  archiveActive(data);
  data.active = { id: `goal-${Date.now().toString(36)}`, objective: objective.trim(), check: check ? check.trim() : null, revision: 1,
    status: 'active', maxRounds: rounds, roundsUsed: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastRound: null, lastCheck: null };
  saveGoal(cwd, data);
  return data.active;
  } finally { release(); }
}
export function updateGoal(cwd, objective, { rounds } = {}) {
  const release = acquireGoalLock(cwd);
  try {
  if (!cleanText(objective, 500)) throw Error('updated goal text must be 1 to 500 characters');
  const data = readFile(cwd);
  if (data.error) throw Error(data.error);
  if (!data.active || data.active.status === 'complete') throw Error('there is no active goal to update');
  data.active.objective = objective.trim();
  data.active.revision = revisionOf(data.active) + 1;
  if (rounds !== undefined) {
    if (!Number.isSafeInteger(rounds) || rounds < data.active.roundsUsed || rounds < 1 || rounds > MAX_ROUNDS) throw Error(`new round limit must be from ${data.active.roundsUsed} to ${MAX_ROUNDS}`);
    data.active.maxRounds = rounds;
  }
  // Any prior check was for the old objective. Require fresh verification.
  data.active.lastCheck = null;
  if (data.active.status === 'deferred') data.active.status = 'active';
  data.active.updatedAt = new Date().toISOString();
  saveGoal(cwd, data);
  return data.active;
  } finally { release(); }
}
export function setGoalStatus(cwd, status) {
  const release = acquireGoalLock(cwd);
  try {
  if (!['paused', 'active', 'deferred'].includes(status)) throw Error('invalid goal status');
  const data = readFile(cwd);
  if (data.error) throw Error(data.error);
  if (!data.active || data.active.status === 'complete') throw Error('there is no unfinished goal');
  data.active.status = status;
  data.active.updatedAt = new Date().toISOString();
  saveGoal(cwd, data);
  return data.active;
  } finally { release(); }
}
function finishFromCheck(data, result) {
  data.active.lastCheck = { command: data.active.check, exitCode: result.exitCode, timedOut: Boolean(result.timedOut),
    checkedAt: new Date().toISOString() };
  data.active.updatedAt = new Date().toISOString();
  if (result.exitCode === 0 && !result.timedOut) data.active.status = 'complete';
  return saveGoal(data.cwd, data).active;
}
export function runCheckCommand(command, cwd, { spawnSyncFn = spawnSync, timeout = 120_000 } = {}) {
  const result = spawnSyncFn(command, { cwd, shell: true, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1024 * 1024 });
  const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
  return { exitCode: Number.isInteger(result.status) ? result.status : null, timedOut,
    output: `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}${result.error ? `\n${result.error.message}` : ''}` };
}
async function runGoalCheckLocked(cwd, { run = runCheckCommand, ask = async () => 'n' } = {}) {
  const data = readFile(cwd);
  if (data.error) throw Error(data.error);
  if (!data.active || data.active.status !== 'active') throw Error('resume the goal before running its completion check');
  if (!data.active.check) throw Error('no verification check is set; create a goal with --check "command"');
  const answer = String(await ask(`Run this completion check in ${path.resolve(cwd)}?\n${data.active.check}\n[y/N] `));
  if (!/^y(?:es)?$/i.test(answer.trim())) return { ran: false, goal: data.active, text: 'check was not run; the goal remains unfinished' };
  const release = acquireGoalLock(cwd);
  try {
    const latest = readFile(cwd);
    if (latest.error) throw Error(latest.error);
    if (!latest.active || latest.active.id !== data.active.id || latest.active.objective !== data.active.objective
      || latest.active.check !== data.active.check || latest.active.updatedAt !== data.active.updatedAt || latest.active.status !== 'active') {
      return { ran: false, goal: latest.active, text: 'goal changed after approval; the completion check was not run' };
    }
    const result = run(latest.active.check, cwd);
    const goal = finishFromCheck(latest, result);
    return { ran: true, goal, result, text: result.exitCode === 0 && !result.timedOut ? 'verification check passed; goal marked complete' : `verification did not pass (exit ${result.exitCode === null ? 'unknown' : result.exitCode}${result.timedOut ? ', timed out' : ''}); goal remains ${goal.status}` };
  } finally { release(); }
}
export async function runGoalCheck(cwd, options = {}) {
  return runGoalCheckLocked(cwd, options);
}

async function continueGoalLocked(cwd, { rounds, turn, state, ask = async () => 'n', out = () => {}, run = runCheckCommand, saveState = () => {}, checkApproval = null } = {}) {
  const data = readFile(cwd);
  if (data.error) throw Error(data.error);
  const goal = data.active;
  if (!goal || goal.status !== 'active') throw Error(goal ? `goal is ${goal.status}; resume it before continuing` : 'no goal is set; use /goal create');
  if (checkApproval && !matchesApproval(goal, checkApproval)) throw Error('the approved completion check no longer matches this goal; review it and start again');
  if (goal.roundsUsed >= goal.maxRounds) return { rounds: 0, goal, text: 'the goal reached its round limit and remains active; update it with a new explicit limit to continue' };
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) throw Error(`continue with an explicit --rounds value from 1 to ${MAX_ROUNDS}`);
  const count = Math.min(rounds, goal.maxRounds - goal.roundsUsed);
  if (typeof turn !== 'function') throw Error('no agent turn function is available');
  let completed = 0;
  for (let i = 0; i < count; i++) {
    const release = acquireGoalLock(cwd);
    let current;
    let round;
    try {
      const fresh = readFile(cwd);
      if (fresh.error) throw Error(fresh.error);
      current = fresh.active;
      if (!current || current.status !== 'active' || current.roundsUsed >= current.maxRounds) break;
      if (checkApproval && !matchesApproval(current, checkApproval)) throw Error('the approved completion check changed; continuation stopped');
      round = current.roundsUsed + 1;
      current.roundsUsed = round;
      current.lastRound = { number: round, state: 'running', startedAt: new Date().toISOString(), reply: null };
      current.lastCheck = null;
      current.updatedAt = new Date().toISOString();
      saveGoal(cwd, fresh);
    } finally { release(); }
    if (!current || current.status !== 'active' || !round) break;
    saveState(state);
    const prompt = `Continue this bounded Atlias goal. Round ${round} of ${current.maxRounds}.\n\nGoal: ${current.objective}\n\nCompletion check: ${current.check || 'none configured; do not claim completion'}\n\nAtlias will decide completion only from an explicit user-approved check whose exit code is zero. Your own claim of completion has no effect. Make one useful, reviewable step toward the goal and report what changed.`;
    let reply;
    try { reply = await turn(state, prompt, ask, out); }
    catch (e) {
      const releaseFailure = acquireGoalLock(cwd);
      try {
        const latest = readFile(cwd);
        if (!latest.error && latest.active && latest.active.id === current.id && latest.active.roundsUsed === round) {
          latest.active.lastRound = { ...latest.active.lastRound, state: 'interrupted', error: String(e.message || e).slice(0, 500), endedAt: new Date().toISOString() };
          latest.active.updatedAt = new Date().toISOString();
          saveGoal(cwd, latest);
        }
      } finally { releaseFailure(); }
      saveState(state);
      throw e;
    }
    const releaseFinish = acquireGoalLock(cwd);
    let latest;
    let goalEditedDuringTurn;
    try {
      latest = readFile(cwd);
      if (latest.error || !latest.active || latest.active.id !== current.id) throw Error('goal changed while the round was running; the saved state was not overwritten');
      if (latest.active.roundsUsed !== round) throw Error('goal rounds changed while the turn was running; the saved state was not overwritten');
      goalEditedDuringTurn = latest.active.objective !== current.objective || latest.active.check !== current.check;
      latest.active.lastRound = { number: round, state: 'finished', startedAt: latest.active.lastRound.startedAt, endedAt: new Date().toISOString(), reply: String(reply || '').slice(0, 2000) };
      latest.active.updatedAt = new Date().toISOString();
      saveGoal(cwd, latest);
    } finally { releaseFinish(); }
    saveState(state);
    completed++;
    if (goalEditedDuringTurn) { out('goal changed while this round was running; no completion check was run'); break; }
    if (latest.active.status !== 'active') { out(`goal is ${latest.active.status}; no completion check was run`); break; }
    if (!latest.active.check) { out('no completion check is configured; the goal remains active and cannot be marked complete'); continue; }
    if (checkApproval && !matchesApproval(latest.active, checkApproval)) { out('the approved completion check changed; no check was run and continuation stopped'); break; }
    const checked = await runGoalCheck(cwd, { run, ask: checkApproval ? async () => 'yes' : ask });
    out(checked.text);
    const after = readFile(cwd);
    if (checked.goal?.status === 'complete' || !after.active || after.active.status !== 'active') break;
  }
  const latest = readFile(cwd);
  return { rounds: completed, goal: latest.active, text: `used ${completed} round${completed === 1 ? '' : 's'}; status ${latest.active ? latest.active.status : 'none'}` };
}
export async function continueGoal(cwd, options = {}) {
  const release = acquireContinuationLease(cwd);
  try { return await continueGoalLocked(cwd, options); }
  finally { release(); }
}

export function statusText(cwd) {
  const data = readFile(cwd);
  if (data.error) return `goals unavailable: ${data.error}`;
  const g = data.active;
  if (!g) return `no active goal in ${path.resolve(cwd)}${data.history.length ? `; ${data.history.length} archived` : ''}`;
  const last = g.lastRound;
  const interruption = last?.state === 'running' ? 'last round was interrupted before it recorded a result' : last?.state === 'interrupted' ? `last round was interrupted: ${last.error}` : '';
  const check = g.lastCheck ? `last check: exit ${g.lastCheck.exitCode === null ? 'unknown' : g.lastCheck.exitCode}${g.lastCheck.timedOut ? ', timed out' : ''} at ${g.lastCheck.checkedAt}` : 'no completion check has passed';
  return [`goal ${g.id} (${g.status})`, `project ${path.resolve(cwd)}`, g.objective, `rounds ${g.roundsUsed}/${g.maxRounds}${g.check ? `; check: ${g.check}` : '; no check set'}`, check, interruption].filter(Boolean).join('\n');
}

export function parseCreateArgs(input) {
  const tokens = String(input || '').match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g) || [];
  let rounds = null, check = null;
  const rest = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--rounds') rounds = Number(tokens[++i]);
    else if (tokens[i] === '--check') {
      const raw = tokens[++i];
      if (raw && ((raw[0] === '"' && raw.at(-1) === '"') || (raw[0] === "'" && raw.at(-1) === "'"))) check = raw.slice(1, -1).replace(/\\([\\"'])/g, '$1');
      else check = raw || '';
    } else rest.push(tokens[i].replace(/^("|')(.*)\1$/, '$2'));
  }
  return { rounds, check, objective: rest.join(' ') };
}
