// Gev's public feed contains aggregates, recorded typed proposals and reviewed messages.
// Workspace contents, model transcripts, task identities and credentials never enter it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectStatus, collectHistory } from './evolution-status.mjs';
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const count = x => Number.isSafeInteger(x) && x >= 0 ? x : null;
const safeVariant = x => typeof x === 'string' && /^v\d{4,8}$/.test(x);
const stageNames = new Set(['s1', 's2', 's3']);
function tail(file, maximum = 65536) {
  let fd; try { fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size, bytes = Buffer.alloc(Math.min(size, maximum)); fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length)); return bytes.toString('utf8'); } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
const changeKeys = new Set(['agent.ollamaModel', 'agent.ollamaNumCtx', 'agent.maxToolRounds', 'agent.keepObservations', 'agent.retry', 'agent.maxTokens', 'agent.maskObservations']);
function safeChange(change) {
  return Object.entries(change || {}).filter(([k, v]) => changeKeys.has(k) && (typeof v === 'boolean' || Number.isSafeInteger(v) && v >= 0 || typeof v === 'string' && /^[a-zA-Z0-9_.:\/-]{1,80}$/.test(v) && !v.includes('/') && !/token|secret|key=/i.test(v))).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ');
}
export function collectLive({ stateRoot, now = new Date(), processProbe, agentRegistry = [], allowance = [], messages = [] } = {}) {
  const archive = read(path.join(stateRoot, 'ARCHIVE.json'));
  const status = collectStatus({ root: stateRoot, now, processProbe, agentRegistry });
  const history = collectHistory({ root: stateRoot, now });
  const heartbeat = read(path.join(stateRoot, 'HEARTBEAT.json'));
  let report = null;
  if (safeVariant(heartbeat?.variant) && stageNames.has(heartbeat?.stage)) report = read(path.join(stateRoot, 'variants', heartbeat.variant, heartbeat.stage + '.json'));
  const rows = Array.isArray(report?.results) ? report.results : [];
  const valid = rows.filter(r => typeof r?.pass === 'boolean');
  const entries = tail(path.join(stateRoot, 'evolve.log')).split(/\r?\n/);
  const starts = entries.map(line => line.match(/^(\S+) (v\d{4,8}) (s[123]) start \((\d+) tasks\)/)).filter(Boolean);
  const start = starts.findLast(m => m[2] === heartbeat?.variant && m[3] === heartbeat?.stage);
  status.progress = {
    variant: safeVariant(heartbeat?.variant) ? heartbeat.variant : null, stage: stageNames.has(heartbeat?.stage) ? heartbeat.stage : null,
    completed: valid.length, passed: valid.filter(r => r.pass).length, failed: valid.filter(r => !r.pass).length,
    expected: start ? count(Number(start[4])) : null, partial: report?.partial === true, observedAt: status.agents[0].observedAt,
    startedAt: start && Number.isFinite(Date.parse(start[1])) ? start[1] : null,
    scope: 'Current original-runtime stage checkpoint. Counts are observed task results, not an OpenCode or general capability claim.'
  };
  status.resources = { sampledAt: now.toISOString(), systemFreeRAM: os.freemem(), systemTotalRAM: os.totalmem(), RAMFloor: 512 * 1024 * 1024, fullPeakRAM: null, GPU: null, scope: 'Current system RAM sample; historical peak and GPU usage unknown.' };
  status.allowance = allowance.filter(a => ['codex', 'claude'].includes(a?.host)).map(a => ({ host: a.host, usedPercent: typeof a.usedPercent === 'number' && a.usedPercent >= 0 && a.usedPercent <= 100 ? a.usedPercent : null, observedAt: Number.isFinite(Date.parse(a.observedAt)) ? a.observedAt : null, resetsAt: Number.isFinite(Date.parse(a.resetsAt)) ? a.resetsAt : null, source: a.source === 'actual-provider' ? a.source : 'unknown' }));
  const communications = history.variants.filter(v => safeVariant(v.id) && v.change).slice(-30).map(v => {
    const original = archive?.variants?.find(x => x.id === v.id);
    const change = safeChange(original?.change);
    const model = typeof v.proposedBy === 'string' && /^[a-zA-Z0-9 .:()-]{1,80}$/.test(v.proposedBy) ? v.proposedBy : 'proposer';
    return { at: v.born, sender: model, recipient: 'Evolution controller', kind: 'recorded typed proposal', variant: v.id, text: change || 'A proposal was recorded; its contents are withheld.' };
  });
  // Only messages explicitly marked reviewed-public can be published by collaborators.
  for (const m of messages.filter(m => m?.visibility === 'reviewed-public').slice(-20)) {
    if (![m.sender, m.recipient, m.text].every(x => typeof x === 'string') || !Number.isFinite(Date.parse(m.at))) continue;
    if (/[A-Za-z]:[\\/]|(?:api[-_ ]?key|bearer|authorization|gh[pousr]_|sk-[a-z])|[\u{1F000}-\u{1FAFF}]/iu.test(m.text)) continue;
    communications.push({ at: m.at, sender: m.sender.slice(0, 60), recipient: m.recipient.slice(0, 60), kind: 'reviewed collaborator message', text: m.text.slice(0, 600) });
  }
  status.communications = communications.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 40);
  status.communicationScope = 'Actual archived typed proposals and explicitly reviewed delivered collaborator messages. Private conversations and sealed task identities are withheld; absent messages are not invented.';
  status.historyRuns = {};
  const corpusPrefixes = { 'canitedit-lazy': 'canitedit-lazy-', 'canitedit-descriptive': 'canitedit-descriptive-', 'humanevalfix-python': 'humanevalfix-python-', 'humanevalfix-js': 'humanevalfix-js-' };
  for (const variant of archive?.variants || []) for (const stage of ['s1', 's2']) {
    const r = variant?.[stage];
    if (!safeVariant(variant?.id) || !Array.isArray(r?.rows) || r.partial) continue;
    for (const [suite, prefix] of Object.entries(corpusPrefixes)) {
      const items = r.rows.filter(row => typeof row?.key === 'string' && row.key.startsWith(prefix) && typeof row.pass === 'boolean');
      if (items.length) (status.historyRuns[suite] ||= []).push({ variant: variant.id, stage, n: items.length, passed: items.filter(row => row.pass).length, broken: Boolean(variant.broken) });
    }
  }
  // Raw proposer reasoning can include task traces. Only the extracted typed
  // change is public; the full original remains on disk for its owners.
  for (const variant of history.variants) { variant.reason = null; variant.change = safeChange(archive?.variants?.find(x => x.id === variant.id)?.change) || null; }
  return { schema: 'atlias.live.v1', generatedAt: now.toISOString(), status, history };
}
