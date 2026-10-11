import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { wilsonInterval } from './ultimate-benchmark.mjs';
import { exactPairedP, comparePair } from '../site/compare.mjs';
import { plateauState } from './evolution-search.mjs';
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function collectStatus({ root, now = new Date(), processProbe, agentRegistry = [] } = {}) {
  if (!root || !Number.isFinite(now.getTime())) throw new Error('Gev status requires an explicit state root and valid time');
  const heartbeat = read(path.join(root, 'HEARTBEAT.json'));
  const lock = read(path.join(root, 'EVOLVE-GPU.lock'));
  const archive = read(path.join(root, 'ARCHIVE.json'));
  const at = heartbeat?.at ? Date.parse(heartbeat.at) : NaN;
  const elapsed = Number.isFinite(at) ? (now.getTime() - at) / 1000 : null;
  const ageSeconds = elapsed !== null && elapsed >= -60 ? Math.max(0, elapsed) : null;
  const pid = number(heartbeat?.pid);
  let processAlive = null;
  if (pid && typeof processProbe === 'function') processAlive = processProbe(pid, root);
  else if (pid && process.platform === 'win32') {
    // Windows PowerShell ships with Windows. PowerShell 7 does not: a publisher
    // started outside an agent session found no pwsh.exe and reported unknown.
    for (const shell of ['powershell.exe', 'pwsh.exe']) {
      const probe = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object -ExpandProperty CommandLine`], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
      if (probe.status !== 0 || probe.error) continue;
      const line = (probe.stdout || '').replaceAll('\\', '/').toLowerCase();
      processAlive = line.includes(path.resolve(root).replaceAll('\\', '/').toLowerCase() + '/evolve.mjs');
      break;
    }
  }
  const lockOwned = Boolean(pid && lock?.pid === pid && lock?.variant === heartbeat?.variant && lock?.stage === heartbeat?.stage);
  const fresh = ageSeconds !== null && ageSeconds <= 180;
  const state = processAlive === false ? 'stopped' : processAlive === true && fresh ? 'running' : 'unknown';
  const variants = Array.isArray(archive?.variants) ? archive.variants : [];
  const results = [];
  for (const variant of variants) {
    for (const stage of ['s1', 's2', 's3']) {
      const report = variant?.[stage];
      if (!report) continue;
      const total = number(report.n), passed = number(report.passed);
      if (total === null || total === 0 || passed === null || passed > total) continue;
      const counted = number(report.tokens) > 0;
      results.push({ variant: String(variant.id), stage, passed, total, rate: passed / total, interval: wilsonInterval(passed, total), promptTokens: counted ? number(report.tokens) : null, outputTokens: counted ? number(report.output) : null, fullNativePeak: null, providerReportedPeak: counted ? number(report.peak) : null, scope: 'Original completed stage summary, not independently regraded or native20x proof.' });
    }
  }
  const current = variants.find(v => v?.id === heartbeat?.variant);
  return {
    schema: 'atlias.public-status.v1', generatedAt: now.toISOString(),
    engine: { target: 'Original champion runtime', status: 'active', rejectedEngine: 'OpenCode v2', verifiedIntegration: false },
    agents: [{ id: 'local-evolution', name: 'Local evolution', state, observedAt: Number.isFinite(at) ? new Date(at).toISOString() : null, phase: typeof heartbeat?.phase === 'string' ? heartbeat.phase : null, variant: current?.id || null, stage: typeof heartbeat?.stage === 'string' ? heartbeat.stage : null, model: current?.config?.agent?.ollamaModel || current?.config?.['agent.ollamaModel'] || null, inferenceLock: lockOwned, processVerified: processAlive }, ...agentRegistry.filter(agent => agent?.id !== 'local-evolution' && typeof agent?.id === 'string' && typeof agent?.name === 'string').map(agent => ({ id: agent.id, name: agent.name, state: ['working', 'running', 'completed', 'idle', 'failed', 'blocked'].includes(agent.state) && Number.isFinite(Date.parse(agent.observedAt)) && (agent.state === 'completed' || now.getTime() - Date.parse(agent.observedAt) <= 900000) && now.getTime() - Date.parse(agent.observedAt) >= -60000 ? agent.state : 'unknown', observedAt: Number.isFinite(Date.parse(agent.observedAt)) ? agent.observedAt : null, phase: typeof agent.phase === 'string' ? agent.phase : null, model: typeof agent.model === 'string' ? agent.model : null, processVerified: agent.processVerified === true ? true : null }))],
    champion: typeof archive?.champion === 'string' ? archive.champion : null,
    completedIterations: number(archive?.iterations), results,
    goals: { totalNativeTokens: { target: 20, proved: false }, fullNativePeak: { target: 20, proved: false }, capability: 'unproved', allowance: 'unproved', continueAfterGoal: true },
    scope: 'Published snapshot of measured local state. Missing, stale and unknown evidence never means completion.'
  };
}

export function writePublicStatus({ stateRoot, destination, now, processProbe, agentRegistry } = {}) {
  const status = collectStatus({ root: stateRoot, now, processProbe, agentRegistry });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = destination + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(status, null, 2) + '\n');
    fs.renameSync(temporary, destination);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return status;
}

// Round history for the public site: every original evolution variant with
// its stages, paired comparisons computed here from per-task rows, and the
// earlier production and native rounds as recorded in their original notes.
// Task keys of sealed stages (s3 confirmation) are never written out; their
// comparisons are published as counts only. Nothing is rerun or regraded.
const SEALED_STAGES = new Set(['s3']);
const OUTCOMES = new Set(['promoted', 'not-promoted', 'screen-rejected', 'infrastructure-held', 'superseded-before-evaluation']);
const suiteOf = key => String(key).split('-')[0];
const binom = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; };
// Exact two-sided sign test on the discordant pairs (McNemar exact).
export { exactPairedP };
const LEGACY = [
  { group: 'Legacy production rounds (V30 controller)', note: 'Summaries of the original local reports. Immutable; not rerun or regraded.', rounds: [
    { id: '46', outcome: 'Held: the coder response failed with HTTP 500. Its cost is unknown and it was never retried.' },
    { id: '47', outcome: 'Failed. The original result is preserved.' },
    { id: '48', outcome: 'Failed. The original result is preserved.' },
    { id: '49', outcome: 'Failed with three sealed failures. V30 production round 49 remains held.' } ] },
  { group: 'Native studies', note: 'Summaries of the original local reports. Immutable; not rerun or regraded.', rounds: [
    { id: '50', outcome: 'Strict result 3 of 4. Immutable.' },
    { id: '52', outcome: 'Failed and sealed.' },
    { id: '53', outcome: 'Diagnostics sealed at 4 of 6.' },
    { id: '54', outcome: '14B code round failed 1 of 2.' },
    { id: '55', outcome: 'Full council held at research, with exact costs recorded.' },
    { id: '56', outcome: 'Pre-code target plans passed software checks; independent package checks were pending.' } ] },
  { group: 'OpenCode rounds', note: 'The OpenCode v2 runtime is not yet qualified for inference, so no OpenCode round has run.', rounds: [] },
];
// What a published variant may carry. Raw proposer reasoning can include task
// traces, and any proposer-written value can hold a path or a credential, so
// only a typed change in a known shape, a model name or a controller label,
// and a broken note in the controller's own shape are published. The
// originals stay on disk for their owners.
export const changeKeys = new Set(['agent.ollamaModel', 'agent.ollamaNumCtx', 'agent.ollamaNumPredict', 'agent.maxToolRounds', 'agent.keepObservations', 'agent.evictBlock', 'agent.outputBudget', 'agent.maxBadReplies', 'agent.nativeTools', 'agent.retry', 'agent.maxTokens', 'agent.maskObservations', 'flags.leanBrief', 'flags.sameTextSwitch', 'flags.finishOnGreen', 'agent.ollamaTemperature', 'agent.ollamaPresencePenalty', 'agent.ollamaThink', 'flags.impliedChanges']);
// A number cannot carry a path or a credential, so any finite one from zero up
// is shown as it is (a temperature of 0.6 is not a whole number).
export function safeChange(change) {
  return Object.entries(change || {}).filter(([k, v]) => changeKeys.has(k) && (typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v) && v >= 0 || typeof v === 'string' && /^[a-zA-Z0-9_.:\/-]{1,80}$/.test(v) && !v.includes('/') && !/token|secret|key=/i.test(v))).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ');
}
export const modelName = x => typeof x === 'string' && /^[a-z0-9][a-z0-9.:_-]{0,40}$/i.test(x) ? x : null;
const PROPOSER_LABEL = /^(random|typed exploration) \(proposer (unavailable|reply unusable)\)$/;
// The notes evolve.mjs itself writes when it marks a run broken.
const BROKEN_NOTE = /^(s[123]|c250|holdout-v\d{4,8}): (partial|no report|exit (-?\d{1,10}|null)|\d{1,4} vs champion \d{1,4}|no counted model call \(model server unreachable\)|too slow for the screen \(\d{1,5} of \d{1,5} min\)|this PC ran out of committed memory \(\d{1,7} MiB left\)|saved task coverage differs[a-z0-9 ,;()'-]{0,120})$/;
const publicBroken = x => !x ? null : typeof x === 'string' && BROKEN_NOTE.test(x) ? x : 'details withheld';

export function collectHistory({ root, now = new Date() } = {}) {
  if (!root || !Number.isFinite(now.getTime())) throw new Error('Gev history requires an explicit state root and valid time');
  const archive = read(path.join(root, 'ARCHIVE.json'));
  const heartbeat = read(path.join(root, 'HEARTBEAT.json'));
  const variants = Array.isArray(archive?.variants) ? archive.variants : [];
  const hbAge = heartbeat?.at ? now.getTime() - Date.parse(heartbeat.at) : NaN, live = Number.isFinite(hbAge) && hbAge >= -60000 && hbAge <= 180000;
  const promoted = new Set((Array.isArray(archive?.promotions) ? archive.promotions : []).map(p => p?.to));
  const cfg = (v, k) => v?.config?.[`agent.${k}`] ?? v?.config?.agent?.[k] ?? null;
  const out = variants.filter(v => typeof v?.id === 'string').map(v => {
    const stages = {};
    for (const stage of ['s1', 's2', 's3']) {
      const r = v[stage];
      const n = number(r?.n), passed = number(r?.passed);
      if (!r || n === null || n === 0 || passed === null || passed > n) continue;
      const suites = {};
      for (const row of Array.isArray(r.rows) ? r.rows : []) { const s = suiteOf(row?.key); suites[s] ||= { n: 0, passed: 0 }; suites[s].n++; if (row?.pass === true) suites[s].passed++; }
      // A broken run's zero is "no counted call", not a measured zero cost.
      const counted = number(r.tokens) > 0;
      // Per-solve figures come from the counts themselves: the next controller
      // stores an unrounded ratio, which must not read as missing. Output
      // tokens appear only where the runtime counted them.
      const output = counted ? number(r.output) : null;
      stages[stage] = { n, passed, rate: passed / n, interval: wilsonInterval(passed, n), promptTokens: counted ? number(r.tokens) : null, tokensPerPass: counted && passed ? Math.round(r.tokens / passed) : null, outputTokens: output, totalPerPass: output !== null && passed ? Math.round((r.tokens + output) / passed) : null, secondsPerPass: Number.isFinite(r.msPerPass) && r.msPerPass >= 0 ? Math.round(r.msPerPass / 1000) : null, peakPrompt: counted ? number(r.peak) : null, partial: r.partial === true, sealed: SEALED_STAGES.has(stage), suites };
    }
    const outcome = OUTCOMES.has(v.roundOutcome?.outcome) ? v.roundOutcome.outcome : null;
    const status = live && v.id === heartbeat?.variant ? 'evaluating' : v.id === archive?.champion ? 'champion' : promoted.has(v.id) ? 'promoted' : outcome === 'superseded-before-evaluation' ? 'superseded' : v.broken ? 'broken' : v.parent == null ? 'baseline' : 'not promoted';
    const searchPolicy = typeof v.searchDecision?.policy === 'string' && /^[a-z0-9-]{1,60}$/.test(v.searchDecision.policy) ? v.searchDecision.policy : null;
    // What decided the paired screen. Only the pooled rule leaves a record
    // (the champion's mean over its runs), and only its numbers are published.
    const pool = v.vsChampionS2?.rule === 'pooled champion runs' ? v.vsChampionS2.pooled : null, real = x => typeof x === 'number' && Number.isFinite(x);
    const screen = pool && real(pool.championMean) && pool.championMean >= 0 && real(pool.net) && real(pool.p) && pool.p >= 0 && pool.p <= 1 && Array.isArray(pool.runsPerTask) && pool.runsPerTask.length === 2 && pool.runsPerTask.every(n => Number.isSafeInteger(n) && n >= 1 && n <= 1000) && pool.runsPerTask[0] <= pool.runsPerTask[1]
      ? { rule: 'pooled', championMean: Math.round(pool.championMean * 10) / 10, net: Math.round(pool.net * 10) / 10, p: pool.p, runsPerTask: [...pool.runsPerTask], leads: v.vsChampionS2.wins === true } : null;
    return { id: v.id, parent: typeof v.parent === 'string' ? v.parent : null, born: typeof v.born === 'string' && Number.isFinite(Date.parse(v.born)) ? v.born : null, change: safeChange(v.change) || null, proposedBy: modelName(v.by) || (typeof v.by === 'string' && PROPOSER_LABEL.test(v.by) ? v.by : null), reason: null, broken: publicBroken(v.broken), model: modelName(cfg(v, 'ollamaModel')), numCtx: number(cfg(v, 'ollamaNumCtx')), runtime: archive?.engine === 'opencode' ? 'OpenCode v2' : 'original evolution runtime (pre-OpenCode)', status, outcome, searchPolicy, screen, stages };
  });
  // Each variant's outcomes per stage as one character per task, in a fixed
  // order hidden behind a hash ('1' solved, '0' not solved, '-' not run). The
  // page pairs any two variants from these, so the file grows with the
  // archive rather than with its square; task identities stay withheld.
  const pairing = {};
  for (const stage of ['s1', 's2', 's3']) {
    const own = variants.filter(v => typeof v?.id === 'string' && Array.isArray(v?.[stage]?.rows));
    const keys = [...new Set(own.flatMap(v => v[stage].rows.map(r => r?.key).filter(k => typeof k === 'string')))];
    const order = new Map(keys.map(k => [crypto.createHash('sha256').update(`${stage}\n${k}`).digest('hex'), k]).sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([, k], i) => [k, i]));
    pairing[stage] = {};
    for (const v of own) {
      const rows = v[stage].rows, bits = Array(order.size).fill('-');
      for (const r of rows) if (typeof r?.key === 'string' && typeof r.pass === 'boolean') bits[order.get(r.key)] = r.pass ? '1' : '0';
      const valid = rows.every(r => typeof r?.key === 'string' && typeof r.pass === 'boolean') && new Set(rows.map(r => r.key)).size === rows.length;
      pairing[stage][v.id] = { bits: bits.join(''), complete: valid && !v[stage].partial, broken: Boolean(v.broken) };
    }
  }
  // The champion's pairs stay precomputed for pages published before the
  // pairing data; the page computes every other pair itself.
  const comparisons = [];
  const champion = typeof archive?.champion === 'string' ? archive.champion : null;
  for (const v of variants) {
    if (!champion || typeof v?.id !== 'string' || v.id === champion) continue;
    for (const stage of ['s1', 's2', 's3']) for (const [a, b] of [[champion, v.id], [v.id, champion]]) {
      const c = comparePair(a, b, stage, pairing[stage][a], pairing[stage][b]);
      if (c) comparisons.push(c);
    }
  }
  let tail = 0;
  for (let k = out.length - 1; k >= 0 && out[k].status === 'broken'; k--) tail++;
  // The three-round penalty as the controller computes it; null when the
  // archive has no dated champion yet.
  let search = null;
  try { const p = plateauState(archive); search = { penaltyActive: p.penalty.active, measuredWithoutPromotion: p.measuredUnpromoted, threshold: p.threshold, nextParent: p.penalty.nextParent, outages: p.infrastructureFailures, rule: 'After three completed measured rounds without a new champion, every new variant starts from the champion and tries only unseen, least-penalised single changes; a promotion resets the count. Outages and unfinished rounds do not count.' }; } catch { search = null; }
  const promotions = (Array.isArray(archive?.promotions) ? archive.promotions : []).filter(p => typeof p?.to === 'string' && Number.isFinite(Date.parse(p?.at))).map(p => ({ at: p.at, from: typeof p.from === 'string' ? p.from : null, to: p.to, route: ['quality', 'cost'].includes(p.route) ? p.route : null }));
  return { schema: 'atlias.public-history.v1', generatedAt: now.toISOString(), champion: typeof archive?.champion === 'string' ? archive.champion : null, iterations: number(archive?.iterations), archiveUpdated: typeof archive?.updated === 'string' ? archive.updated : null, brokenStreak: tail, search, promotions, current: heartbeat ? { variant: typeof heartbeat.variant === 'string' ? heartbeat.variant : null, stage: typeof heartbeat.stage === 'string' ? heartbeat.stage : null, phase: typeof heartbeat.phase === 'string' ? heartbeat.phase : null, at: typeof heartbeat.at === 'string' ? heartbeat.at : null } : null, variants: out, comparisons, pairing, legacy: LEGACY, tokenScope: 'Prompt-side counters archived by the evolution runtime. Output tokens appear where its reports counted them and are Unknown elsewhere, never zero. Full native peak context was not captured.', scope: 'Original results as recorded. Sealed confirmation task identities are withheld; only counts are published.' };
}

export function writePublicHistory({ stateRoot, destination, now } = {}) {
  const history = collectHistory({ root: stateRoot, now });
  const temporary = destination + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(temporary, JSON.stringify(history) + '\n'); fs.renameSync(temporary, destination); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return history;
}
