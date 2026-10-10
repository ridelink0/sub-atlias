// Rounds, versus comparisons and earlier history, read from /history.json.
// Every figure comes from the published file; anything missing reads Unknown.
const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v); }
  for (const c of kids) if (c != null) n.append(c);
  return n;
};
const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => { const n = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
const pct = x => Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : 'Unknown';
const num = x => Number.isSafeInteger(x) && x >= 0 ? x.toLocaleString() : 'Unknown';
const pfmt = p => !Number.isFinite(p) ? 'n/a' : p < 0.0001 ? p.toExponential(1) : p.toFixed(4);
const when = s => Number.isFinite(Date.parse(s)) ? new Date(s).toLocaleString() : 'Unknown';
let H = null, sortKey = 'born', sortDir = -1;
const open = new Set();

function stageText(v, s) { const r = v.stages?.[s]; return r ? `${r.passed}/${r.n} (${pct(r.rate)})` : 'not run'; }
function sortValue(v, key) {
  if (key === 'born') return Date.parse(v.born) || 0;
  if (key === 'id') return v.id;
  if (['s1', 's2', 's3'].includes(key)) return v.stages?.[key] ? v.stages[key].rate : -1;
  if (key === 'tpp') { const s = v.stages?.s2 || v.stages?.s1; return Number.isFinite(s?.tokensPerPass) ? s.tokensPerPass : Infinity; }
  return String(v[key] ?? '');
}

function renderHealth() {
  const box = $('evolution-health');
  box.replaceChildren();
  const age = H.current?.at ? (Date.now() - Date.parse(H.current.at)) / 1000 : NaN;
  const live = Number.isFinite(age) && age >= -60 && age <= 180;
  box.append(el('p', { text: H.current?.variant ? `Last heartbeat: ${H.current.variant} ${H.current.stage || ''} ${H.current.phase || ''}, ${when(H.current.at)}${live ? '' : ' (stale: the loop may be backing off or stopped)'}` : 'No heartbeat evidence.' }));
  box.append(el('p', { text: `Champion: ${H.champion || 'Unknown'}. Completed iterations: ${num(H.iterations)}. Archive updated ${when(H.archiveUpdated)}.` }));
  if (H.brokenStreak >= 3) box.append(el('p', { class: 'warn', text: `The last ${H.brokenStreak} variants failed every task with no counted model call. Their model server was unreachable, so these are runtime failures, not capability results.` }));
}

function filtered() {
  const model = $('f-model').value, status = $('f-status').value;
  return H.variants.filter(v => (model === 'all' || v.model === model) && (status === 'all' || v.status === status))
    .sort((a, b) => { const x = sortValue(a, sortKey), y = sortValue(b, sortKey); return (x < y ? -1 : x > y ? 1 : 0) * sortDir; });
}

function detailRow(v) {
  const cell = el('td', { colspan: '8', class: 'detail' });
  const facts = [
    ['Parent', v.parent || 'none (baseline)'], ['Change', v.change || 'none'], ['Proposed by', v.proposedBy || 'Unknown'],
    ['Reason given', v.reason || 'none recorded'], ['Runtime', v.runtime], ['Born', when(v.born)],
  ];
  if (v.broken) facts.push(['Broken', v.broken]);
  const dl = el('dl');
  for (const [k, x] of facts) dl.append(el('dt', { text: k }), el('dd', { text: x }));
  cell.append(dl);
  for (const s of ['s1', 's2', 's3']) {
    const r = v.stages?.[s];
    if (!r) continue;
    const suites = Object.entries(r.suites || {}).map(([k, x]) => `${k} ${x.passed}/${x.n}`).join(', ');
    cell.append(el('p', { text: `${s.toUpperCase()}${r.sealed ? ' (sealed confirmation)' : ''}: ${r.passed}/${r.n} passed, ${pct(r.rate)}, 95% interval ${pct(r.interval?.lower)} to ${pct(r.interval?.upper)}. Prompt tokens ${num(r.promptTokens)}, tokens per pass ${num(r.tokensPerPass)}, largest prompt ${num(r.peakPrompt)}, output tokens Unknown.${r.partial ? ' Partial stage.' : ''}${suites ? ' By suite: ' + suites + '.' : ''}` }));
  }
  return el('tr', { class: 'detail-row' }, cell);
}

function renderRounds() {
  const body = $('round-list');
  body.replaceChildren();
  const rows = filtered();
  for (const v of rows) {
    const toggle = el('button', { type: 'button', class: 'link', 'aria-expanded': String(open.has(v.id)), text: v.id });
    toggle.addEventListener('click', () => { open.has(v.id) ? open.delete(v.id) : open.add(v.id); renderRounds(); });
    const s = v.stages?.s2 || v.stages?.s1;
    body.append(el('tr', {}, el('th', { scope: 'row' }, toggle), el('td', { text: when(v.born) }), el('td', { text: `${v.model || 'Unknown'} / ${num(v.numCtx)}` }),
      el('td', { text: stageText(v, 's1') }), el('td', { text: stageText(v, 's2') }), el('td', { text: stageText(v, 's3') }),
      el('td', { text: num(s?.tokensPerPass) }), el('td', {}, el('span', { class: `pill ${v.status.replace(/\s/g, '-')}`, text: v.status }))));
    if (open.has(v.id)) body.append(detailRow(v));
  }
  if (!rows.length) body.append(el('tr', {}, el('td', { colspan: '8', text: 'No round matches these filters.' })));
  $('round-count').textContent = `${rows.length} of ${H.variants.length} variants shown.`;
  for (const th of document.querySelectorAll('#rounds th[data-sort]')) th.setAttribute('aria-sort', th.dataset.sort === sortKey ? (sortDir > 0 ? 'ascending' : 'descending') : 'none');
  renderChart();
}

function renderChart() {
  const stage = $('f-stage').value;
  const data = filtered().filter(v => v.stages?.[stage]).sort((a, b) => (Date.parse(a.born) || 0) - (Date.parse(b.born) || 0));
  const box = $('chart');
  box.replaceChildren();
  if (!data.length) { box.append(el('p', { text: `No variant has a ${stage.toUpperCase()} result under these filters.` })); return; }
  const W = Math.max(320, data.length * 56 + 60), Hh = 240, top = 16, bottom = 40, left = 44;
  const s = svg('svg', { viewBox: `0 0 ${W} ${Hh}`, role: 'img', 'aria-labelledby': 'chart-title' });
  s.append(Object.assign(svg('title', { id: 'chart-title' }), { textContent: `${stage.toUpperCase()} pass rate per variant with 95% intervals. The table holds the same figures.` }));
  const y = r => top + (1 - r) * (Hh - top - bottom);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    s.append(svg('line', { x1: left, x2: W - 8, y1: y(t), y2: y(t), class: 'grid' }));
    s.append(Object.assign(svg('text', { x: left - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'axis' }), { textContent: `${t * 100}%` }));
  }
  data.forEach((v, i) => {
    const r = v.stages[stage], x = left + 12 + i * 56;
    s.append(svg('rect', { x, y: y(r.rate), width: 32, height: Math.max(1, y(0) - y(r.rate)), class: `bar ${v.status.replace(/\s/g, '-')}` }));
    if (r.interval) s.append(svg('line', { x1: x + 16, x2: x + 16, y1: y(r.interval.upper), y2: y(r.interval.lower), class: 'whisker' }));
    s.append(Object.assign(svg('text', { x: x + 16, y: Hh - bottom + 16, 'text-anchor': 'middle', class: 'axis' }), { textContent: v.id }));
    s.append(Object.assign(svg('text', { x: x + 16, y: Hh - bottom + 30, 'text-anchor': 'middle', class: 'axis small' }), { textContent: `${r.passed}/${r.n}` }));
  });
  box.append(s);
}

function card(v, stage, label) {
  const r = v?.stages?.[stage];
  return el('article', { class: 'versus-card' }, el('h3', { text: `${label}: ${v ? v.id : 'none'}` }),
    el('p', { text: v ? `${v.model || 'Unknown model'} at ${num(v.numCtx)} context, ${v.runtime}` : 'No variant selected' }),
    el('p', { class: 'big', text: r ? `${r.passed}/${r.n} (${pct(r.rate)})` : `No ${stage.toUpperCase()} result` }),
    el('p', { text: r ? `95% interval ${pct(r.interval?.lower)} to ${pct(r.interval?.upper)}. Tokens per pass ${num(r.tokensPerPass)} (prompt side only).` : 'Not run at this stage.' }));
}

function renderCompare() {
  const a = $('c-a').value, b = $('c-b').value, stage = $('c-stage').value;
  const A = H.variants.find(v => v.id === a), B = H.variants.find(v => v.id === b);
  const out = $('compare-out');
  out.replaceChildren(el('div', { class: 'versus' }, card(A, stage, 'Baseline'), card(B, stage, 'Candidate')));
  const c = H.comparisons.find(x => x.a === a && x.b === b && x.stage === stage);
  let verdict;
  if (a === b) verdict = 'Pick two different variants.';
  else if (!c) verdict = `No shared ${stage.toUpperCase()} tasks: there is no winner.`;
  else if (!c.comparable) verdict = `Not comparable (${c.reason}). There is no winner.`;
  else if (Number.isFinite(c.p) && c.p < 0.05) verdict = `${c.bOnly > c.aOnly ? 'Candidate' : 'Baseline'} solved more of the same tasks: exact paired p = ${pfmt(c.p)}, difference ${pct(Math.abs(c.difference))} of ${c.paired} paired tasks.`;
  else verdict = `No significant difference on these tasks (exact paired p = ${pfmt(c.p)}). There is no winner.`;
  out.append(el('p', { class: 'verdict', role: 'status', text: verdict }));
  if (c && a !== b) {
    const t = el('table', {}, el('caption', { text: `Paired outcomes on ${c.paired} shared ${stage.toUpperCase()} tasks` }),
      el('thead', {}, el('tr', {}, ...['Both solved', 'Only baseline', 'Only candidate', 'Neither'].map(h => el('th', { scope: 'col', text: h })))),
      el('tbody', {}, el('tr', {}, ...[c.both, c.aOnly, c.bOnly, c.neither].map(x => el('td', { text: num(x) })))));
    out.append(el('div', { class: 'table-scroll' }, t));
  }
}

function renderLegacy() {
  const box = $('legacy');
  box.replaceChildren();
  for (const g of H.legacy || []) {
    const sec = el('article', { class: 'legacy-group' }, el('h3', { text: g.group }), el('p', { class: 'note', text: g.note }));
    if (!g.rounds?.length) sec.append(el('p', { text: 'No rounds yet.' }));
    else { const ul = el('ul'); for (const r of g.rounds) ul.append(el('li', {}, el('strong', { text: `Round ${r.id}: ` }), r.outcome)); sec.append(ul); }
    box.append(sec);
  }
}

function fillSelect(id, values, keep, label = x => x) {
  const s = $(id), prev = s.value || keep;
  s.replaceChildren(...values.map(v => { const o = el('option', { text: label(v) }); o.value = v; return o; }));
  if (values.includes(prev)) s.value = prev;
}

function show(data) {
  if (data?.schema !== 'atlias.public-history.v1' || !Array.isArray(data.variants) || !Array.isArray(data.comparisons)) throw new Error('History is invalid');
  H = data;
  fillSelect('f-model', ['all', ...new Set(H.variants.map(v => v.model).filter(Boolean))], 'all', v => v === 'all' ? 'All models' : v);
  fillSelect('f-status', ['all', ...new Set(H.variants.map(v => v.status))], 'all', v => v === 'all' ? 'All statuses' : v);
  const ids = H.variants.map(v => v.id);
  fillSelect('c-a', ids, ids.includes('v0000') ? 'v0000' : ids[0]);
  fillSelect('c-b', ids, H.champion && ids.includes(H.champion) ? H.champion : ids[1]);
  $('history-error').hidden = true;
  $('history-time').textContent = `History published ${when(H.generatedAt)}. ${H.tokenScope}`;
  renderHealth(); renderRounds(); renderCompare(); renderLegacy();
}

async function load() {
  try {
    const r = await fetch('/history.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    show(await r.json());
  } catch { $('history-error').textContent = 'Round history could not be loaded. Figures shown may be stale.'; $('history-error').hidden = false; }
}

for (const th of document.querySelectorAll('#rounds th[data-sort]')) {
  const b = el('button', { type: 'button', class: 'link', text: th.textContent });
  th.replaceChildren(b);
  b.addEventListener('click', () => { if (sortKey === th.dataset.sort) sortDir = -sortDir; else { sortKey = th.dataset.sort; sortDir = th.dataset.sort === 'id' ? 1 : -1; } if (H) renderRounds(); });
}
for (const id of ['f-model', 'f-status', 'f-stage']) $(id).addEventListener('change', () => H && renderRounds());
for (const id of ['c-a', 'c-b', 'c-stage']) $(id).addEventListener('change', () => H && renderCompare());
await load();
setInterval(load, 60000);
