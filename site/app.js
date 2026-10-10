import { feed } from './feed.mjs';
const $ = id => document.getElementById(id);
let state = null, suites = [];
const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : 'Unknown';
function freshness() {
  if (!state) return;
  const timestamp = Date.parse(state.generatedAt), seconds = (Date.now() - timestamp) / 1000;
  if (!Number.isFinite(seconds) || seconds < -60) { $('freshness').textContent = 'Timestamp invalid'; return; }
  const age = Math.max(0, Math.floor(seconds / 60));
  $('freshness').textContent = `Data observed ${new Date(timestamp).toLocaleString()} · ${age} minute${age === 1 ? '' : 's'} old${seconds > 180 ? ' · Stale snapshot' : ''}`;
  $('freshness').classList.toggle('stale', seconds > 180);
  for (const node of document.querySelectorAll('#agent-list .agent')) {
    const agentAge = (Date.now() - Date.parse(node.dataset.observed)) / 1000;
    if (node.dataset.state !== 'completed' && (!Number.isFinite(agentAge) || agentAge < -60 || agentAge > 180)) node.querySelector('.state').textContent = 'stale / current state unknown';
  }
  const progressAge=(Date.now()-Date.parse(state.progress?.observedAt))/1000;
  $('live-progress').classList.toggle('stale',!Number.isFinite(progressAge)||progressAge>180||progressAge < -60);
  if (!Number.isFinite(progressAge)||progressAge>180||progressAge < -60) $('live-progress').textContent = 'Current stage status unknown: checkpoint is stale. Last recorded: ' + (state.progress ? `${state.progress.variant} / ${state.progress.stage}, ${count(state.progress.completed)} results.` : 'No checkpoint.');
}
function showStatus(data) {
  if (data?.schema !== 'atlias.public-status.v1' || !Array.isArray(data.agents) || !Array.isArray(data.results)) throw new Error('Published state is invalid');
  state = data;
  $('engine-status').textContent = data.engine?.status === 'active' ? 'Original champion retained; OpenCode rejected after comparison' : data.engine?.verifiedIntegration === true ? 'Integration verified by execution' : 'Integration not yet verified';
  $('agent-list').replaceChildren();
  for (const agent of data.agents) {
    const row = text('article', '', 'agent');
    row.dataset.observed = agent.observedAt;
    row.dataset.state = agent.state;
    row.append(text('h3', agent.name), text('span', agent.state, 'state'), text('p', [agent.phase, agent.variant, agent.stage].filter(Boolean).join(' / ') || 'No stage evidence'));
    row.append(text('p', agent.model ? `Model: ${agent.model}` : 'Model identity unknown'), text('p', agent.processVerified === true ? 'Process identity verified' : 'Process identity not verified'));
    $('agent-list').append(row);
  }
  if (!data.agents.length) $('agent-list').append(text('p', 'No agent evidence available.'));
  const p = data.progress;
  $('live-progress').textContent = p ? `${p.variant || 'Unknown round'} / ${p.stage || 'Unknown stage'}: ${count(p.completed)} of ${count(p.expected)} task results recorded, ${count(p.passed)} passed, ${count(p.failed)} failed.${p.partial ? ' Stage in progress.' : ''} Checkpoint observed ${p.observedAt ? new Date(p.observedAt).toLocaleString() : 'Unknown'}.` : 'No current-stage checkpoint available.';
  const ram = data.resources;
  $('resource-sample').textContent = ram ? `System RAM available: ${(ram.systemFreeRAM / 2 ** 30).toFixed(2)} GiB of ${(ram.systemTotalRAM / 2 ** 30).toFixed(1)} GiB. Guard: ${(ram.RAMFloor / 2 ** 20).toFixed(0)} MiB. GPU usage and historical resource peaks: Unknown. Sampled ${new Date(ram.sampledAt).toLocaleString()}.` : 'Resource evidence unavailable.';
  $('allowance-list').replaceChildren();
  for (const a of data.allowance || []) {
    const age = (Date.now() - Date.parse(a.observedAt)) / 1000;
    $('allowance-list').append(text('p', `${a.host}${a.window ? ' ' + a.window + ' window' : ''}: ${count(a.usedPercent)}% used at ${a.observedAt ? new Date(a.observedAt).toLocaleString() : 'Unknown time'}${age > 180 || !Number.isFinite(age) ? ' (stale; current allowance unknown)' : ''}. Measured reset: ${a.resetsAt ? new Date(a.resetsAt).toLocaleString() : 'Unknown'}.`));
  }
  $('message-list').replaceChildren();
  for (const m of data.communications || []) {
    const item = text('article', '', 'message');
    item.append(text('h3', `${m.sender} to ${m.recipient}`), text('p', `${m.kind}${m.variant ? ' / ' + m.variant : ''} / ${m.at ? new Date(m.at).toLocaleString() : 'Time unknown'}`, 'note'), text('p', m.text));
    $('message-list').append(item);
  }
  if (!(data.communications || []).length) $('message-list').append(text('p', 'No public recorded messages available.'));
  renderModels(data);
  $('result-list').replaceChildren();
  for (const result of data.results) {
    const row = document.createElement('tr');
    for (const value of [result.variant, result.stage, `${count(result.passed)} / ${count(result.total)}`, count(result.promptTokens), count(result.outputTokens), count(result.providerReportedPeak)]) row.append(text('td', value));
    $('result-list').append(row);
  }
  if (!data.results.length) { const row = document.createElement('tr'), cell = text('td', 'No completed stage evidence available.'); cell.colSpan = 6; row.append(cell); $('result-list').append(row); }
  freshness();
}
// What the coder is doing now, and each recent round as the recorded exchange
// between controller, proposer and coder. Open rounds stay open across refreshes.
function renderStats(data) {
  const s = data.liveStats, box = $('live-stats');
  box.replaceChildren();
  if (!s) { box.append(text('p', 'Live statistics unavailable.')); return; }
  const card = (title, ...lines) => { const c = text('article', '', 'stat'); c.append(text('h3', title), ...lines.filter(Boolean).map(l => text('p', l))); box.append(c); };
  const st = s.stage || {};
  const pct = (a, b) => Number.isSafeInteger(a) && Number.isSafeInteger(b) && b > 0 ? ` (${(a / b * 100).toFixed(1)}%)` : '';
  if (st.variant) {
    card('Current stage', `${st.variant} ${st.stage}: ${count(st.done)} of ${count(st.expected)} tasks done`, `${count(st.solved)} solved${pct(st.solved, st.done)}`);
    card('Pace', st.elapsedMinutes != null ? `${count(st.elapsedMinutes)} minutes in` : 'Start time unknown', st.tasksPerHour != null ? `${st.tasksPerHour} tasks per hour` : null, st.finishEstimate ? `Estimated finish ${new Date(st.finishEstimate).toLocaleTimeString()}` : null);
    card('Tokens this stage', `Prompt tokens per solve: ${count(st.promptTokensPerSolve)}`, `Output tokens so far: ${count(st.outputTokens)}`);
    if (!st.sealed) {
      card('How runs ended', ...(Object.entries(st.stopReasons || {}).map(([k, v]) => `${k}: ${count(v)}`)), Object.keys(st.stopReasons || {}).length ? null : 'No finished task yet');
      card('By suite', ...(Object.entries(st.suites || {}).map(([k, v]) => `${k}: ${count(v.solved)} of ${count(v.n)}${pct(v.solved, v.n)}`)), Object.keys(st.suites || {}).length ? null : 'No finished task yet');
    } else card('Sealed stage', 'Per-task results are withheld until the stage ends.');
  } else card('Current stage', 'Between rounds: the controller is choosing the next change.');
  const l = s.loop || {};
  card('Loop pace', `${count(l.screensFinishedLast24h)} paired screens finished in the last 24 hours`, `Median smoke stage ${count(l.medianSmokeMinutes)} min, median screen ${count(l.medianScreenMinutes)} min`, l.modelServerHeld ? 'Holding: the model server is not answering' : null);
  const p = s.proposals || {}, total = ['modelAnswered', 'unusableReply', 'unreachable', 'other'].reduce((n, k) => n + (Number.isSafeInteger(p[k]) ? p[k] : 0), 0);
  card('Proposer replies', `Usable change: ${count(p.modelAnswered)}${pct(p.modelAnswered, total)}`, `No usable CHANGE line: ${count(p.unusableReply)}`, `Model server unreachable: ${count(p.unreachable)}`);
}
function renderGoals(data) {
  const g = data.goals || {};
  for (const [id, goal] of [['goal-tokens', g.totalNativeTokens], ['goal-peak', g.fullNativePeak]]) if ($(id)) $(id).textContent = goal?.proved === true ? 'Proved' : 'Unproved';
}
function renderModels(data) {
  renderStats(data);
  renderGoals(data);
  const a = data.activity;
  $('activity-now').textContent = a ? `${a.coder ? 'Coder ' + a.coder : 'The coder'} is ${a.phase === 'eval' ? 'working on' : 'at'} ${a.variant}, ${a.stageLabel}: ${count(a.completed)} of ${count(a.expected)} tasks done, ${count(a.passed)} solved. Change under test: ${a.change || 'withheld'}.${a.sealed ? ' Sealed stage: per-task results are withheld.' : ''}` : 'No current activity evidence.';
  const body = $('activity-tasks');
  body.replaceChildren();
  for (const t of a?.recent || []) {
    const row = document.createElement('tr');
    for (const value of [count(t.number), t.suite, t.solved === true ? 'solved' : 'not solved', t.stop, count(t.rounds), count(t.promptTokens), count(t.outputTokens)]) row.append(text('td', value));
    body.append(row);
  }
  if (!(a?.recent || []).length) { const row = document.createElement('tr'), cell = text('td', a?.sealed ? 'Sealed stage: per-task results are withheld.' : 'No task results in this stage yet.'); cell.colSpan = 7; row.append(cell); body.append(row); }
  const list = $('conversation-list');
  const wasOpen = new Set([...list.querySelectorAll('details')].filter(d => d.open).map(d => d.dataset.variant));
  const first = !list.childElementCount;
  list.replaceChildren();
  (data.conversations || []).forEach((c, i) => {
    const item = text('details', '', 'talk');
    item.dataset.variant = c.variant;
    item.open = first ? i === 0 : wasOpen.has(c.variant);
    const summary = document.createElement('summary');
    summary.append(text('span', `${c.variant}: ${c.headline || (c.live ? 'running now' : 'outcome unknown')}`), text('span', c.at ? new Date(c.at).toLocaleString() : 'Time unknown', 'availability'));
    const turns = document.createElement('ol');
    for (const t of c.turns || []) { const li = document.createElement('li'); li.append(text('span', t.to ? `${t.from} to ${t.to}` : `${t.from}, decision`, 'who'), text('p', t.text)); turns.append(li); }
    item.append(summary, turns);
    list.append(item);
  });
  if (!(data.conversations || []).length) list.append(text('p', 'No recorded rounds yet.'));
}
function showSuites() {
  const category = $('category').value;
  $('suite-list').replaceChildren();
  for (const suite of suites.filter(s => category === 'all' || s.category === category)) {
    const item = text('details', '', 'suite');
    const summary = document.createElement('summary'); summary.append(text('span', suite.name), text('span', suite.availability.replaceAll('-', ' '), 'availability'));
    item.append(summary, text('p', suite.grading), text('p', `Suite ID: ${suite.id}. Kind: ${suite.kind}. Available tasks: ${count(suite.availableTasks)} of ${count(suite.expected)} expected. Completed: ${suite.completed === true ? 'Yes' : 'No'}.`), text('p', `Corpus hash: ${suite.contentHash || 'Unknown'}. Upstream version: ${suite.upstreamVersion || 'Unknown in this ledger'}. License: ${suite.license || 'Unknown in this ledger; inspect the original corpus notice before use'}. Required evidence: ${suite.requirement || 'Unknown'}.`));
    const runs = state?.historyRuns?.[suite.id] || [];
    for (const run of state?.ultimateRuns || []) if (run.id === suite.id) item.append(text('p', `Full corpus run: ${run.status}; ${count(run.recorded)} of ${count(run.expected)} tasks recorded, ${count(run.solved)} solved. Input tokens ${count(run.inputTokens)}, output tokens ${count(run.outputTokens)}. ${run.scope}`));
    item.append(text('p', runs.length ? 'Observed original-runtime stages: ' + runs.map(r => `${r.variant}/${r.stage}: ${r.passed}/${r.n}`).join('; ') + '. These are subsets, not suite completion.' : 'No mapped original-runtime stage evidence for this suite. Execution remains unproved.'));
    $('suite-list').append(item);
  }
}
async function load() {
  try {
    showStatus(await feed('status')); if (suites.length) showSuites(); $('error').hidden = true;
  } catch { $('error').textContent = 'Current state could not be loaded. Existing results may be stale.'; $('error').hidden = false; }
}
try {
  const response = await fetch('/benchmark.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Suite ledger unavailable');
  const data = await response.json();
  if (data?.schema !== 'atlias.ultimate.v1' || !Array.isArray(data.suites)) throw new Error('Suite ledger invalid');
  suites = data.suites;
  for (const category of [...new Set(suites.map(s => s.category))].sort()) { const option = text('option', category); option.value = category; $('category').append(option); }
  $('suite-summary').textContent = `${suites.length} suites. Every suite keeps its grading contract.`;
  showSuites();
} catch { $('suite-summary').textContent = 'Suite ledger unavailable'; }
$('category').addEventListener('change', showSuites);
await load(); setInterval(load, 90000); setInterval(freshness, 10000);
