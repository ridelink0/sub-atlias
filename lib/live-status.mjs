// Gev's public feed contains aggregates, recorded typed proposals and reviewed messages.
// Workspace contents, model transcripts, task identities and credentials never enter it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectStatus, collectHistory } from './evolution-status.mjs';
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const count = x => Number.isSafeInteger(x) && x >= 0 ? x : null;
const safeVariant = x => typeof x === 'string' && /^v\d{4,8}$/.test(x);
const stageNames = { has: x => typeof x === 'string' && /^(s[123]|c250|holdout-v\d{4,8})$/.test(x) };
// Confirmation stages are sealed: counts only, never per-task detail.
const SEALED = /^(s3|c250|holdout-v\d{4,8})$/;
const STAGE_LABEL = { s1: 'smoke stage (10 tasks)', s2: 'paired screen (60 tasks)', s3: 'sealed confirmation (120 tasks)', c250: 'sealed confirmation (250 tasks)' };
const stageLabel = s => STAGE_LABEL[s] || (/^holdout-/.test(s) ? 'sealed holdout (10 tasks)' : 'stage');
const STOP_WORDS = { 'answered': 'answered', 'rounds-exhausted': 'ran out of rounds', 'truncated-output': 'reply cut off at its output limit', 'malformed-output': 'sent no usable action', 'model-error': 'model call failed', 'context-full': 'context window full' };
const SUITES = [['humanevalfix-python-', 'HumanEvalFix Python'], ['humanevalfix-js-', 'HumanEvalFix JavaScript'], ['canitedit-lazy-', 'CanItEdit lazy'], ['canitedit-descriptive-', 'CanItEdit descriptive']];
const suiteName = key => (SUITES.find(([p]) => typeof key === 'string' && key.startsWith(p)) || [null, 'other suite'])[1];
const modelName = x => typeof x === 'string' && /^[a-z0-9][a-z0-9.:_-]{0,40}$/i.test(x) ? x : null;
const fmt = x => Number.isSafeInteger(x) && x >= 0 ? x.toLocaleString('en-US') : 'unknown';
function tail(file, maximum = 65536) {
  let fd; try { fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size, bytes = Buffer.alloc(Math.min(size, maximum)); fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length)); return bytes.toString('utf8'); } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
// Every typed setting the evolution controller can change, past and present.
const changeKeys = new Set(['agent.ollamaModel', 'agent.ollamaNumCtx', 'agent.ollamaNumPredict', 'agent.maxToolRounds', 'agent.keepObservations', 'agent.evictBlock', 'agent.outputBudget', 'agent.maxBadReplies', 'agent.nativeTools', 'agent.retry', 'agent.maxTokens', 'agent.maskObservations', 'flags.leanBrief', 'flags.sameTextSwitch', 'flags.finishOnGreen']);
function safeChange(change) {
  return Object.entries(change || {}).filter(([k, v]) => changeKeys.has(k) && (typeof v === 'boolean' || Number.isSafeInteger(v) && v >= 0 || typeof v === 'string' && /^[a-zA-Z0-9_.:\/-]{1,80}$/.test(v) && !v.includes('/') && !/token|secret|key=/i.test(v))).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ');
}
// What the coder model is doing now: the current round and stage, and its last
// task outcomes by suite and stop reason (never task text or identities).
function activityNow(archive, heartbeat, valid, progress) {
  if (!safeVariant(heartbeat?.variant) || !stageNames.has(heartbeat?.stage)) return null;
  const v = archive?.variants?.find(x => x.id === heartbeat.variant);
  const sealed = SEALED.test(heartbeat.stage);
  return {
    variant: heartbeat.variant, stage: heartbeat.stage, stageLabel: stageLabel(heartbeat.stage), sealed,
    phase: typeof heartbeat.phase === 'string' && /^[a-z-]{1,40}$/.test(heartbeat.phase) ? heartbeat.phase : null,
    coder: modelName(v?.config?.['agent.ollamaModel']), change: safeChange(v?.change) || null,
    completed: progress?.completed ?? null, expected: progress?.expected ?? null, passed: progress?.passed ?? null,
    recent: sealed ? [] : valid.slice(-8).map((r, i, a) => ({ number: valid.length - a.length + i + 1, suite: suiteName(r.id ?? r.key), solved: r.pass, stop: STOP_WORDS[r.stop] || 'other', rounds: count(r.rounds), promptTokens: count(r.promptTotal), outputTokens: count(r.outputTotal) })).reverse()
  };
}
// The recorded exchange of each recent round, rebuilt only from the archive and
// the log: the controller's request, the proposer's typed change (its own words
// stay private), each stage the coder ran and the controller's verdict.
function conversations(archive, heartbeat, progress) {
  const variants = Array.isArray(archive?.variants) ? archive.variants : [];
  const byId = new Map(variants.map(v => [v.id, v]));
  const promoted = new Set((Array.isArray(archive?.promotions) ? archive.promotions : []).map(p => p?.to));
  const out = [];
  for (const v of variants.filter(x => safeVariant(x?.id) && safeVariant(x?.parent)).slice(-12).reverse()) {
    const parent = byId.get(v.parent);
    const coder = `Coder (${modelName(v.config?.['agent.ollamaModel']) || 'model unknown'})`;
    const turns = [];
    const ps2 = parent?.s2 && count(parent.s2.n) ? `${fmt(count(parent.s2.passed))} of ${fmt(count(parent.s2.n))} on the paired screen` : 'no screen result yet';
    const d = v.searchDecision;
    const policy = d?.policy === 'champion-anchored-three-round-penalty' ? `Search penalty active (${fmt(Array.isArray(d.completedRoundIds) ? d.completedRoundIds.length : null)} completed rounds without a new champion), so the parent is the champion and only an unseen, least-penalised change is allowed.`
      : d?.policy === 'archive-exploration' ? 'Parent sampled from the archive by score.' : d?.policy === 'champion-anchor' ? 'Parent is the champion.' : 'Parent chosen by the original score-weighted sampling.';
    turns.push({ from: 'Evolution controller', to: 'Proposer', text: `Parent ${v.parent} (${ps2}). ${policy} Propose exactly one setting change.` });
    const change = safeChange(v.change) || 'a change whose contents are withheld';
    const by = typeof v.by === 'string' ? v.by : '';
    const proposer = modelName(by);
    if (proposer) turns.push({ from: `Proposer (${proposer})`, to: 'Evolution controller', text: `CHANGE ${change}` });
    else {
      if (/unavailable/.test(by)) turns.push({ from: 'Proposer', to: 'Evolution controller', text: 'No answer: the model server was unreachable.' });
      else if (/unusable/.test(by)) turns.push({ from: 'Proposer', to: 'Evolution controller', text: 'Answered without a usable CHANGE line.' });
      turns.push({ from: 'Evolution controller', to: null, text: `${/typed exploration/.test(by) ? 'Chose an unseen, least-penalised change itself' : 'Chose a random change itself'}: ${change}.` });
    }
    for (const stage of ['s1', 's2', 's3', 'c250']) {
      const r = v[stage];
      const live = v.id === heartbeat?.variant && heartbeat?.stage === stage && progress;
      if (!r && !live) continue;
      turns.push({ from: 'Evolution controller', to: coder, text: `Run the ${stageLabel(stage)}.` });
      if (!r || r.partial) { turns.push({ from: coder, to: 'Evolution controller', text: `Working: ${fmt(progress?.completed)} of ${fmt(progress?.expected)} tasks done so far, ${fmt(progress?.passed)} solved.` }); continue; }
      const tokens = count((v.originalSummaries?.[stage] ?? r).tokens), passed = count(r.passed), n = count(r.n);
      const perSolve = tokens > 0 && passed > 0 ? Math.round(tokens / passed) : null;
      turns.push({ from: coder, to: 'Evolution controller', text: `${fmt(passed)} of ${fmt(n)} solved${perSolve ? `, ${fmt(perSolve)} prompt tokens per solve` : tokens === 0 ? ', with no counted model call' : ''}.` });
    }
    const outcome = v.roundOutcome?.outcome;
    const vs = v.vsChampionS2;
    let verdict = null;
    if (outcome === 'superseded-before-evaluation') verdict = 'Superseded at a controller handoff; this change was never run.';
    else if (v.id === archive?.champion || promoted.has(v.id)) verdict = 'Promoted: it beat the champion through the sealed confirmation.';
    else if (typeof v.broken === 'string') {
      const s1 = v.originalSummaries?.s1 ?? v.s1, m = v.broken.match(/^s1: (\d+) vs champion (\d+)$/);
      verdict = (s1 && s1.tokens === 0) || /no counted model call/.test(v.broken) ? 'Not a capability result: no model call was counted because the model server was unreachable.'
        : m ? `Rejected at the smoke stage: ${m[1]} solved against the champion's ${m[2]}.` : 'Held: the stage did not produce a complete result.';
    } else if (vs && safeVariant(vs.champion)) {
      verdict = `Against champion ${vs.champion}: ${fmt(count(vs.bOnly))} tasks only this variant solved, ${fmt(count(vs.cOnly))} only the champion solved${Number.isFinite(vs.p) ? `, p = ${vs.p < 0.0001 ? vs.p.toExponential(1) : vs.p.toFixed(4)}` : ''}. ${vs.wins ? 'It leads, so it goes to the sealed confirmation.' : 'Not promoted.'}`;
      const c = v.vsChampionC250 || v.vsChampionS3;
      if (c && vs.wins) verdict += ` Confirmation: ${fmt(count(c.bOnly))} versus ${fmt(count(c.cOnly))}; ${c.wins ? 'held' : 'did not hold'}.`;
    }
    if (verdict) turns.push({ from: 'Evolution controller', to: null, text: verdict });
    const live = v.id === heartbeat?.variant;
    const short = live && !verdict ? 'running now' : !verdict ? 'no verdict recorded' : /^Superseded/.test(verdict) ? 'superseded, never run' : /^Promoted/.test(verdict) ? 'promoted' : /^Not a capability/.test(verdict) ? 'outage, not a result' : /^Rejected/.test(verdict) ? 'rejected at the smoke stage' : /^Held/.test(verdict) ? 'held' : /goes to the sealed confirmation/.test(verdict) ? 'leads, sent to confirmation' : 'not promoted';
    out.push({ variant: v.id, at: Number.isFinite(Date.parse(v.born)) ? v.born : null, live, headline: `${safeChange(v.change) || 'change withheld'}: ${short}`, turns });
  }
  return out;
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
  const starts = entries.map(line => line.match(/^(\S+) (v\d{4,8}) (s[123]|c250|holdout-v\d{4,8}) start \((\d+) tasks\)/)).filter(Boolean);
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
    // Sender and recipient are published too, so they pass the same filter as the text.
    if ([m.sender, m.recipient, m.text].some(x => /[A-Za-z]:[\\/]|(?:api[-_ ]?key|bearer|authorization|gh[pousr]_|sk-[a-z])|[\u{1F000}-\u{1FAFF}]|@[a-z0-9-]+\.[a-z]{2,}/iu.test(x))) continue;
    communications.push({ at: m.at, sender: m.sender.slice(0, 60), recipient: m.recipient.slice(0, 60), kind: 'reviewed collaborator message', text: m.text.slice(0, 600) });
  }
  status.communications = communications.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 40);
  status.communicationScope = 'Actual archived typed proposals and explicitly reviewed delivered collaborator messages. Private conversations and sealed task identities are withheld; absent messages are not invented.';
  status.activity = activityNow(archive, heartbeat, valid, status.progress);
  status.conversations = conversations(archive, heartbeat, status.progress);
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
  // Who proposed and which model ran are published only in known shapes: a model
  // name, or one of the controller's own fallback labels.
  const BY = /^(random|typed exploration) \(proposer (unavailable|reply unusable)\)$/;
  for (const variant of history.variants) {
    const original = archive?.variants?.find(x => x.id === variant.id);
    variant.reason = null;
    variant.change = safeChange(original?.change) || null;
    variant.proposedBy = modelName(original?.by) || (typeof original?.by === 'string' && BY.test(original.by) ? original.by : null);
    variant.model = modelName(variant.model);
  }
  return { schema: 'atlias.live.v1', generatedAt: now.toISOString(), status, history };
}
