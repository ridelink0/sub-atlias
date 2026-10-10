import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { wilsonInterval } from './ultimate-benchmark.mjs';
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
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object -ExpandProperty CommandLine`], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    if (probe.status === 0 && !probe.error) {
      const line = (probe.stdout || '').replaceAll('\\', '/').toLowerCase();
      processAlive = line.includes(path.resolve(root).replaceAll('\\', '/').toLowerCase() + '/evolve.mjs');
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
      results.push({ variant: String(variant.id), stage, passed, total, rate: passed / total, interval: wilsonInterval(passed, total), promptTokens: number(report.tokens), outputTokens: number(report.output), fullNativePeak: null, providerReportedPeak: number(report.peak), scope: 'Original completed stage summary, not independently regraded or native20x proof.' });
    }
  }
  const current = variants.find(v => v?.id === heartbeat?.variant);
  return {
    schema: 'atlias.public-status.v1', generatedAt: now.toISOString(),
    engine: { target: 'OpenCode v2', pin: 'd2905b8ddae8b0353cd2166d68d59795397921db', version: '2.0.26', verifiedIntegration: false },
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
const suiteOf = key => String(key).split('-')[0];
const binom = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; };
// Exact two-sided sign test on the discordant pairs (McNemar exact).
export function exactPairedP(aOnly, bOnly) {
  const n = aOnly + bOnly;
  if (!n) return null;
  let tail = 0;
  for (let i = 0; i <= Math.min(aOnly, bOnly); i++) tail += binom(n, i);
  return Math.min(1, 2 * tail / 2 ** n);
}
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
const LOCAL_PATH = /[A-Za-z]:[\\/][^\s"']*/g;

export function collectHistory({ root, now = new Date() } = {}) {
  if (!root || !Number.isFinite(now.getTime())) throw new Error('Gev history requires an explicit state root and valid time');
  const archive = read(path.join(root, 'ARCHIVE.json'));
  const heartbeat = read(path.join(root, 'HEARTBEAT.json'));
  const variants = Array.isArray(archive?.variants) ? archive.variants : [];
  const hbAge = heartbeat?.at ? now.getTime() - Date.parse(heartbeat.at) : NaN, live = Number.isFinite(hbAge) && hbAge >= -60000 && hbAge <= 180000;
  const promoted = new Set((Array.isArray(archive?.promotions) ? archive.promotions : []).map(p => p?.to));
  const cfg = (v, k) => v?.config?.[`agent.${k}`] ?? v?.config?.agent?.[k] ?? null;
  const text = (v, max = 160) => typeof v === 'string' ? v.replace(LOCAL_PATH, '[local path]').slice(0, max) : null;
  const out = variants.filter(v => typeof v?.id === 'string').map(v => {
    const stages = {};
    for (const stage of ['s1', 's2', 's3']) {
      const r = v[stage];
      const n = number(r?.n), passed = number(r?.passed);
      if (!r || n === null || n === 0 || passed === null || passed > n) continue;
      const suites = {};
      for (const row of Array.isArray(r.rows) ? r.rows : []) { const s = suiteOf(row?.key); suites[s] ||= { n: 0, passed: 0 }; suites[s].n++; if (row?.pass === true) suites[s].passed++; }
      // A broken run's zero is "no counted call", not a measured zero cost.
      const counted = !v.broken && number(r.tokens) > 0;
      stages[stage] = { n, passed, rate: passed / n, interval: wilsonInterval(passed, n), promptTokens: counted ? number(r.tokens) : null, tokensPerPass: counted && passed ? number(r.tokensPerPass) : null, outputTokens: null, peakPrompt: counted ? number(r.peak) : null, partial: r.partial === true, sealed: SEALED_STAGES.has(stage), suites };
    }
    const status = live && v.id === heartbeat?.variant ? 'evaluating' : v.id === archive?.champion ? 'champion' : promoted.has(v.id) ? 'promoted' : v.broken ? 'broken' : v.parent == null ? 'baseline' : 'not promoted';
    const change = v.change && typeof v.change === 'object' ? Object.entries(v.change).map(([k, x]) => `${k} = ${JSON.stringify(x)}`).join(', ') : null;
    return { id: v.id, parent: typeof v.parent === 'string' ? v.parent : null, born: typeof v.born === 'string' && Number.isFinite(Date.parse(v.born)) ? v.born : null, change, proposedBy: text(v.by, 80), reason: text(v.reason), broken: text(v.broken), model: typeof cfg(v, 'ollamaModel') === 'string' ? cfg(v, 'ollamaModel') : null, numCtx: number(cfg(v, 'ollamaNumCtx')), runtime: 'original evolution runtime (pre-OpenCode)', status, stages };
  });
  const comparisons = [];
  for (let i = 0; i < variants.length; i++) for (let j = 0; j < variants.length; j++) {
    if (i === j || typeof variants[i]?.id !== 'string' || typeof variants[j]?.id !== 'string') continue;
    const A = variants[i], B = variants[j];
    for (const stage of ['s1', 's2', 's3']) {
      const ra = Array.isArray(A?.[stage]?.rows) ? A[stage].rows : null, rb = Array.isArray(B?.[stage]?.rows) ? B[stage].rows : null;
      if (!ra || !rb) continue;
      const mb = new Map(rb.map(r => [r?.key, r?.pass === true]));
      let both = 0, aOnly = 0, bOnly = 0, neither = 0;
      for (const r of ra) { if (!mb.has(r?.key)) continue; const a = r?.pass === true, b = mb.get(r.key); if (a && b) both++; else if (a) aOnly++; else if (b) bOnly++; else neither++; }
      const paired = both + aOnly + bOnly + neither;
      const sameSet = paired === ra.length && paired === rb.length;
      const broken = Boolean(A.broken || B.broken);
      comparisons.push({ a: A.id, b: B.id, stage, paired, both, aOnly, bOnly, neither, difference: paired ? (bOnly - aOnly) / paired : null, p: exactPairedP(aOnly, bOnly), comparable: sameSet && paired > 0 && !broken, reason: !paired ? 'no shared tasks' : !sameSet ? 'the task sets differ' : broken ? 'one side was a broken run (its model calls failed), so no capability conclusion' : null });
    }
  }
  let tail = 0;
  for (let k = out.length - 1; k >= 0 && out[k].status === 'broken'; k--) tail++;
  return { schema: 'atlias.public-history.v1', generatedAt: now.toISOString(), champion: typeof archive?.champion === 'string' ? archive.champion : null, iterations: number(archive?.iterations), archiveUpdated: typeof archive?.updated === 'string' ? archive.updated : null, brokenStreak: tail, current: heartbeat ? { variant: typeof heartbeat.variant === 'string' ? heartbeat.variant : null, stage: typeof heartbeat.stage === 'string' ? heartbeat.stage : null, phase: typeof heartbeat.phase === 'string' ? heartbeat.phase : null, at: typeof heartbeat.at === 'string' ? heartbeat.at : null } : null, variants: out, comparisons, legacy: LEGACY, tokenScope: 'Prompt-side counters archived by the original runtime. Output tokens and full native peak were not captured, so they are unknown, not zero.', scope: 'Original results as recorded. Sealed confirmation task identities are withheld; only counts are published.' };
}

export function writePublicHistory({ stateRoot, destination, now } = {}) {
  const history = collectHistory({ root: stateRoot, now });
  const temporary = destination + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(temporary, JSON.stringify(history) + '\n'); fs.renameSync(temporary, destination); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return history;
}
