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
  fs.writeFileSync(destination, JSON.stringify(status, null, 2) + '\n');
  return status;
}
