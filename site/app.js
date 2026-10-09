const $ = id => document.getElementById(id);
let state = null, suites = [];
const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : 'Unknown';
function freshness() {
  if (!state) return;
  const timestamp = Date.parse(state.generatedAt), seconds = (Date.now() - timestamp) / 1000;
  if (!Number.isFinite(seconds) || seconds < -60) { $('freshness').textContent = 'Timestamp invalid'; return; }
  const age = Math.max(0, Math.floor(seconds / 60));
  $('freshness').textContent = `Published ${new Date(timestamp).toLocaleString()} · ${age} minute${age === 1 ? '' : 's'} old${seconds > 900 ? ' · Stale snapshot' : ''}`;
  $('freshness').classList.toggle('stale', seconds > 900);
}
function showStatus(data) {
  if (data?.schema !== 'atlias.public-status.v1' || !Array.isArray(data.agents) || !Array.isArray(data.results)) throw new Error('Published state is invalid');
  state = data;
  $('engine-status').textContent = data.engine?.verifiedIntegration === true ? 'Integration verified by execution' : 'Migration in progress; integration not yet verified';
  $('agent-list').replaceChildren();
  for (const agent of data.agents) {
    const row = text('article', '', 'agent');
    row.append(text('h3', agent.name), text('span', agent.state, 'state'), text('p', [agent.phase, agent.variant, agent.stage].filter(Boolean).join(' / ') || 'No stage evidence'));
    row.append(text('p', agent.model ? `Model: ${agent.model}` : 'Model identity unknown'), text('p', agent.processVerified === true ? 'Process identity verified' : 'Process identity not verified'));
    $('agent-list').append(row);
  }
  if (!data.agents.length) $('agent-list').append(text('p', 'No agent evidence available.'));
  $('result-list').replaceChildren();
  for (const result of data.results) {
    const row = document.createElement('tr');
    for (const value of [result.variant, result.stage, `${count(result.passed)} / ${count(result.total)}`, count(result.promptTokens), count(result.outputTokens), count(result.providerReportedPeak)]) row.append(text('td', value));
    $('result-list').append(row);
  }
  if (!data.results.length) { const row = document.createElement('tr'), cell = text('td', 'No completed stage evidence available.'); cell.colSpan = 6; row.append(cell); $('result-list').append(row); }
  freshness();
}
function showSuites() {
  const category = $('category').value;
  $('suite-list').replaceChildren();
  for (const suite of suites.filter(s => category === 'all' || s.category === category)) {
    const item = text('details', '', 'suite');
    const summary = document.createElement('summary'); summary.append(text('span', suite.name), text('span', suite.availability.replaceAll('-', ' '), 'availability'));
    item.append(summary, text('p', suite.grading), text('p', `Available tasks: ${count(suite.availableTasks)}. Completed: ${suite.completed === true ? 'Yes' : 'No'}.`));
    $('suite-list').append(item);
  }
}
async function load() {
  try {
    const response = await fetch('/status.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('State returned HTTP ' + response.status);
    showStatus(await response.json()); $('error').hidden = true;
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
await load(); setInterval(load, 30000); setInterval(freshness, 10000);
