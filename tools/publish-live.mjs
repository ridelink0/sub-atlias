// Gev's live data is updated separately from Vercel deployments, with existing
// GitHub CLI authentication. Only this reviewed Atlias aggregate is published.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectLive } from '../lib/live-status.mjs';
const source = fileURLToPath(new URL('..', import.meta.url)), root = 'D:/harness-work/atlias-opencode-1009';
const gh = 'C:/Program Files/GitHub CLI/gh.exe';
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const description = 'Atlias by Gev: reviewed live benchmark aggregates and recorded typed proposals';
const configFile = path.join(source, 'site/live-config.json'), receiptFile = path.join(root, 'LIVE-PUBLISHER-LAST.json');
const lockFile = path.join(root, 'LIVE-PUBLISHER.lock'), logFile = path.join(root, 'checks', 'live-publisher.log');
const watch = process.argv.includes('--watch');
// A launch with no window has no console to read, so every line is also kept
// on disk. Logging never stops a publication.
function note(line, error = false) {
  (error ? console.error : console.log)(line);
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1048576) fs.renameSync(logFile, logFile + '.1');
    fs.appendFileSync(logFile, line + '\n');
  } catch {}
}
// A failure that the next cycle cannot repair. Everything else in --watch is
// held and tried again, so a network pause never ends the publisher.
class Fatal extends Error {}
// true: a running publisher owns the lock. false: its owner is gone, or the
// pid now belongs to another program. null: unknown, treated as owned.
function lockOwned() {
  const pid = read(lockFile)?.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) { try { return Date.now() - fs.statSync(lockFile).mtimeMs < 60000 ? null : false; } catch { return null; } }
  try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return false; }
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop).CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status !== 0 || r.error) return null;
  return /publish-live\.mjs/i.test(r.stdout);
}
// Another running publisher keeps its lock. A lock left by one that was ended
// without cleaning up is taken over, so a relaunch never waits for a person.
let fd;
try { fd = fs.openSync(lockFile, 'wx'); }
catch (e) {
  if (e.code !== 'EEXIST') throw e;
  if (lockOwned() !== false) { note(`Atlias live publisher: ${lockFile} belongs to a running or unknown publisher; inspect its owner before another launch`, true); process.exit(1); }
  note(JSON.stringify({ at: new Date().toISOString(), staleLock: read(lockFile)?.pid ?? null, takenOverBy: process.pid }));
  try { fs.unlinkSync(lockFile); } catch (gone) { if (gone.code !== 'ENOENT') throw gone; }
  try { fd = fs.openSync(lockFile, 'wx'); }
  catch (taken) { if (taken.code !== 'EEXIST') throw taken; note('Atlias live publisher: another launch took the lock first', true); process.exit(1); }
}
fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), scope: 'atlias-live' }));
const mine = () => read(lockFile)?.pid === process.pid;
let stopped = false;
const cleanup = () => { if (!stopped) { stopped = true; try { fs.closeSync(fd); if (mine()) fs.unlinkSync(lockFile); } catch {} } };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
let config = read(configFile);
let gistId = config?.endpoint?.match(/^https:\/\/api\.github\.com\/gists\/([a-f0-9]{32})$/)?.[1];
if (config?.endpoint && !gistId) throw new Error('Invalid live endpoint; refusing to publish');
function api(args, body) {
  const r = spawnSync(gh, ['api', ...args, ...(body ? ['--input', '-'] : [])], { input: body ? JSON.stringify(body) : undefined, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  // Updating the one known artifact is safe to repeat. Creating one is not: a
  // lost reply followed by a second attempt would leave two.
  if (r.status !== 0 || r.error) throw new (gistId ? Error : Fatal)('Atlias live API failed; no second artifact was created. Check CLI authentication/network.');
  return JSON.parse(r.stdout);
}
let ownerChecked = false;
function checkOwner() {
  if (ownerChecked || !gistId) return;
  const existing = api(['gists/' + gistId]);
  if (existing.owner?.login !== 'ridelink0' || existing.description !== description || !existing.files?.['atlias-live.json']) throw new Fatal('Refusing to modify an unrelated public artifact');
  ownerChecked = true;
}
// Claude's own latest provider reading, kept by the usage-limits plugin. Only
// the two windows' percentages and reset times, and whether a Claude Code
// session was active in the last three minutes, leave this machine.
function claudeLive(now = Date.now()) {
  const sessions = Object.values(read(path.join(os.homedir(), '.claude', 'usage-limits-feed.json')) || {}).filter(e => e && Number.isFinite(e.headersAt) && e.rateLimits && typeof e.rateLimits === 'object');
  const best = sessions.sort((a, b) => b.headersAt - a.headersAt)[0];
  if (!best) return { allowance: [], agents: [] };
  const at = new Date(best.headersAt).toISOString();
  const allowance = [['five_hour', '5-hour'], ['seven_day', 'weekly']].map(([key, window]) => {
    const w = best.rateLimits[key];
    return w && Number.isFinite(w.used_percentage) ? { host: 'claude', window, usedPercent: w.used_percentage, observedAt: at, resetsAt: Number.isFinite(w.resets_at) ? new Date(w.resets_at * 1000).toISOString() : null, source: 'actual-provider' } : null;
  }).filter(Boolean);
  const lastSeen = Math.max(...sessions.map(e => Number.isFinite(e.at) ? e.at : 0));
  const model = typeof best.modelName === 'string' && /^[A-Za-z0-9 .]{1,30}$/.test(best.modelName) ? best.modelName : 'model unknown';
  const agents = [{ id: 'claude-code', name: `Claude Code (${model})`, state: now - lastSeen <= 180000 ? 'working' : 'idle', observedAt: new Date(lastSeen).toISOString() }];
  return { allowance, agents };
}
// Codex's latest reading as the usage-limits plugin recorded it for Codex
// sessions: the two windows' percentages, reset times and when it was read.
function codexLive() {
  const r = read(path.join(os.homedir(), '.codex', 'usage-limits-reading.json'));
  return [['five_hour', '5-hour'], ['seven_day', 'weekly']].map(([key, window]) => {
    const w = r?.[key];
    return w && Number.isFinite(w.percentUsed) && Number.isFinite(w.at) && w.adjusted !== true ? { host: 'codex', window, usedPercent: w.percentUsed, observedAt: new Date(w.at).toISOString(), resetsAt: Number.isFinite(w.resetsAt) ? new Date(w.resetsAt).toISOString() : null, source: 'actual-provider' } : null;
  }).filter(Boolean);
}
function publish() {
  if (fs.existsSync(path.join(root, 'LIVE-PUBLISHER.STOP'))) { note('Atlias live publisher stopped cooperatively'); process.exit(0); }
  if (!mine()) { note('Atlias live publisher: the lock now names another publisher; this one ends', true); process.exit(0); }
  checkOwner();
  const claude = claudeLive(), codex = codexLive();
  const allowance = [...claude.allowance, ...codex, ...(read(path.join(root, 'PUBLIC-ALLOWANCE.json')) || []).filter(a => (a?.host !== 'claude' || !claude.allowance.length) && (a?.host !== 'codex' || !codex.length))];
  const agentRegistry = [...claude.agents, ...(read(path.join(root, 'AGENTS-STATUS.json')) || []).filter(a => a?.id !== 'claude-code' && !(claude.agents.length && a?.id === 'claude-runtime'))];
  const originalRoot = 'D:/harness-work/atlias-evolve', openCodeRoot = 'D:/harness-work/atlias-evolve-opencode';
  const activeRoot = read(path.join(openCodeRoot, 'ARCHIVE.json'))?.engine === 'opencode' ? openCodeRoot : originalRoot;
  const bundle = collectLive({ stateRoot: activeRoot, agentRegistry, allowance, messages: read(path.join(root, 'PUBLIC-COMMUNICATIONS.json')) || [] });
  // Separate history objects: variant numbers are never joined across engines.
  const original = collectLive({ stateRoot: originalRoot });
  const openCode = collectLive({ stateRoot: openCodeRoot });
  bundle.history.series = [
    { id: 'original', name: 'Original runtime', history: original.history },
    { id: 'opencode', name: 'OpenCode v2', history: openCode.history },
  ];
  const ultimate = read(path.join(originalRoot, 'ULTIMATE-RUNS.json'));
  bundle.status.ultimateRuns = (Array.isArray(ultimate?.jobs) ? ultimate.jobs : []).filter(j => /^[a-z0-9-]{1,60}$/.test(j?.id || '') && ['running', 'completed', 'held'].includes(j.status)).map(j => {
    const folder = path.join(originalRoot, 'ultimate');
    const relative = typeof j.report === 'string' ? path.relative(folder, j.report) : '..';
    const report = !relative.startsWith('..') && !path.isAbsolute(relative) ? read(j.report) : null;
    const rows = Array.isArray(report?.results) ? report.results : null;
    return { id: j.id, status: j.status, expected: Number.isSafeInteger(j.expected) ? j.expected : null, recorded: rows ? rows.length : j.recorded ?? null, solved: rows ? rows.filter(r => r.pass === true).length : j.solved ?? null, inputTokens: Number.isSafeInteger(report?.promptTotal) ? report.promptTotal : null, outputTokens: Number.isSafeInteger(report?.outputTotal) ? report.outputTotal : null, scope: 'Real original-runtime corpus execution; full native context and20x gains remain unproved.' };
  });
  const comparison = read(path.join(openCodeRoot, 'v0000', 's1.json'));
  if (Array.isArray(comparison?.results)) {
    const rows = comparison.results;
    bundle.history.openCodeComparison = { partial: comparison.partial === true, n: rows.length, solved: rows.filter(r => r.pass === true).length, expected: 10,
      totalTokens: comparison.accountingComplete === true ? comparison.totalNativeTokens : null,
      seconds: rows.every(r => Number.isFinite(r.ms)) ? rows.reduce((n,r) => n+r.ms,0)/1000 : null };
    const championReport = read(path.join(originalRoot, 'variants', original.history.champion || '', 's1.json'));
    if (Array.isArray(championReport?.results) && rows.length === 10 && championReport.results.length === 10 && rows.every((r,i) => r.id === championReport.results[i].id)) {
      const solved = championReport.results.filter(r => r.pass === true).length;
      const tokens = Number.isSafeInteger(championReport.promptTotal) && Number.isSafeInteger(championReport.outputTotal) ? championReport.promptTotal + championReport.outputTotal : null;
      const seconds = championReport.results.every(r => Number.isFinite(r.ms)) ? championReport.results.reduce((n,r) => n+r.ms,0)/1000 : null;
      bundle.history.openCodeComparison.champion = { id: original.history.champion, solved, n: 10, totalTokens: tokens, seconds };
      bundle.history.openCodeComparison.held = rows.filter(r => r.stop === 'runtime-held').length;
    }
  }
  const content = JSON.stringify(bundle);
  if (Buffer.byteLength(content) > 900000 || /[A-Za-z]:[\\/]|gh[pousr]_[a-zA-Z0-9]|sk-[a-zA-Z0-9]{10}|Bearer\s+[a-zA-Z0-9]/.test(content)) throw new Error('Atlias privacy/size gate refused publication');
  const payload = { files: { 'atlias-live.json': { content } } };
  const result = gistId ? api(['gists/' + gistId, '--method', 'PATCH'], payload) : api(['gists', '--method', 'POST'], { ...payload, description, public: true });
  if (!/^[a-f0-9]{32}$/.test(result.id) || result.owner?.login !== 'ridelink0') throw new Fatal('Atlias live publication reached an artifact that is not Gev\'s; inspect the receipt before retrying');
  if (result.files?.['atlias-live.json']?.truncated || result.files?.['atlias-live.json']?.content !== content) throw new (gistId ? Error : Fatal)('Atlias live publication could not be reconciled; inspect the receipt before retrying');
  gistId = result.id;
  if (!config?.endpoint) { config = { endpoint: 'https://api.github.com/gists/' + gistId, refreshSeconds: 90 }; fs.writeFileSync(configFile, JSON.stringify(config) + '\n'); }
  for (const kind of ['status', 'history']) fs.writeFileSync(path.join(source, 'site', kind + '.json'), JSON.stringify(bundle[kind]) + '\n');
  fs.writeFileSync(receiptFile, JSON.stringify({ at: new Date().toISOString(), generatedAt: bundle.generatedAt, endpoint: config.endpoint, bytes: Buffer.byteLength(content), variant: bundle.status.progress.variant, stage: bundle.status.progress.stage, completed: bundle.status.progress.completed, verified: true }) + '\n');
  note(JSON.stringify({ at: bundle.generatedAt, variant: bundle.status.progress.variant, stage: bundle.status.progress.stage, completed: bundle.status.progress.completed, verified: true }));
}
let held = 0;
function cycle() {
  try { publish(); held = 0; }
  catch (e) {
    if (!watch || e instanceof Fatal) { note(e.message, true); process.exit(1); }
    note(JSON.stringify({ at: new Date().toISOString(), held: e.message, consecutive: ++held, verified: false }), true);
  }
}
cycle();
if (watch) setInterval(cycle, 90000);
