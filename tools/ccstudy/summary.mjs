#!/usr/bin/env node
// The report of one Claude Code study, from its rows.jsonl, in the words of
// NEXTGEN-5's CC protocol: solves (naming any task one arm solved and another
// did not), prompt tokens per solved task raw and billed-equivalent, the
// per-task paired ratio with its 95 per cent interval, gate holds, cancelled
// hook calls, and holds that said no check ran when the transcript shows one.
// Every number carries its n, and a comparison that cannot tell the arms apart
// says "inside the noise".
//
//   node tools/ccstudy/summary.mjs --rows <rows.jsonl> [--base plain] [--meta meta.json] --json out.json --md out.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './lib.mjs';

// Fewer one-way flips than this is "inside the noise" (NEXTGEN-4's rule, kept
// by NEXTGEN-5's MT protocol): below six, no split can reach p < 0.05.
export const MIN_FLIPS = 6;

export function byArm(rows) {
  const arms = new Map();
  for (const r of rows) {
    if (!arms.has(r.arm)) arms.set(r.arm, new Map());
    arms.get(r.arm).set(r.task, r);
  }
  return arms;
}

export function armStats(rows) {
  const n = rows.length;
  const solved = rows.filter((r) => r.solved);
  const sum = (k, xs = rows) => xs.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const atliasHolds = sum('holdsAtlias');
  return {
    n,
    solved: solved.length,
    costUsd: sum('costUsd'),
    promptRaw: sum('promptRaw'),
    promptBilled: sum('promptBilled'),
    output: sum('output'),
    rawPerSolved: solved.length ? sum('promptRaw') / solved.length : null,
    billedPerSolved: solved.length ? sum('promptBilled') / solved.length : null,
    roundsMean: n ? sum('rounds') / n : null,
    holds: sum('holds'),
    holdsAtlias: atliasHolds,
    holdsInStream: sum('holdsInStream'),
    holdsNoCheck: sum('holdsNoCheck'),
    holdsNoCheckFalse: sum('holdsNoCheckFalse'),
    holdsNoCheckFalseBroad: sum('holdsNoCheckFalseBroad'),
    runsWithHold: rows.filter((r) => r.holds > 0).length,
    hookCalls: sum('hookCalls'),
    hookCallsCancelled: sum('hookCallsCancelled'),
    runsWithCancelled: rows.filter((r) => r.hookCallsCancelled > 0 || r.cancelledInTranscript > 0).length,
    cancelledInTranscript: sum('cancelledInTranscript'),
    errors: rows.filter((r) => r.isError || r.timedOut).length,
    isolationProblems: rows.filter((r) => (r.initProblems || []).length).map((r) => `${r.task}: ${r.initProblems.join('; ')}`),
    tampered: rows.filter((r) => (r.tampered || []).length).map((r) => r.task),
    briefRuns: rows.filter((r) => r.briefChars != null).length,
    briefLean: rows.filter((r) => r.briefLean === true).length,
    briefCharsMean: rows.some((r) => r.briefChars != null) ? rows.filter((r) => r.briefChars != null).reduce((a, r) => a + r.briefChars, 0) / rows.filter((r) => r.briefChars != null).length : null,
    gateChecks: sum('gateChecks'),
    gateChecksFailed: sum('gateChecksFailed'),
    runsWithGateCheck: rows.filter((r) => r.gateChecks > 0).length,
  };
}

// Arm B against arm A on the tasks both ran.
export function comparePair(A, B, { seed = 1 } = {}) {
  const tasks = [...A.keys()].filter((t) => B.has(t)).sort();
  const onlyA = tasks.filter((t) => A.get(t).solved && !B.get(t).solved);
  const onlyB = tasks.filter((t) => B.get(t).solved && !A.get(t).solved);
  const both = tasks.filter((t) => A.get(t).solved && B.get(t).solved);
  const pairs = (k, list) => list.map((t) => ({ task: t, a: Number(A.get(t)[k]) || 0, b: Number(B.get(t)[k]) || 0 }));
  const clean = both.filter((t) => !(A.get(t).hookCallsCancelled > 0 || B.get(t).hookCallsCancelled > 0 || A.get(t).cancelledInTranscript > 0 || B.get(t).cancelledInTranscript > 0));
  const bySource = {};
  for (const t of both) {
    const src = B.get(t).source || A.get(t).source || '';
    (bySource[src] = bySource[src] || []).push(t);
  }
  const ratioOf = (k, list) => { const r = S.pairedRatio(pairs(k, list), { seed }); delete r.perTask; return r; };
  return {
    tasks: tasks.length,
    onlyA, onlyB,
    mcnemarP: S.mcnemarP(onlyB.length, onlyA.length),
    flipsInsideNoise: onlyA.length < MIN_FLIPS && onlyB.length < MIN_FLIPS,
    bothSolved: both.length,
    raw: ratioOf('promptRaw', both),
    billed: ratioOf('promptBilled', both),
    cost: ratioOf('costUsd', both),
    rounds: ratioOf('rounds', both),
    clean: { n: clean.length, raw: ratioOf('promptRaw', clean), billed: ratioOf('promptBilled', clean) },
    bySource: Object.fromEntries(Object.entries(bySource).map(([src, list]) => [src, { n: list.length, raw: ratioOf('promptRaw', list), billed: ratioOf('promptBilled', list) }])),
    perTask: both.map((t) => ({ task: t, source: B.get(t).source || '', aRaw: A.get(t).promptRaw, bRaw: B.get(t).promptRaw, ratioRaw: A.get(t).promptRaw ? B.get(t).promptRaw / A.get(t).promptRaw : null, aBilled: A.get(t).promptBilled, bBilled: B.get(t).promptBilled, aRounds: A.get(t).rounds, bRounds: B.get(t).rounds, bHolds: B.get(t).holds })),
  };
}

// NEXTGEN-5 row 4's bar, on one comparison (B the change, A plain): the
// per-solved-task ratio at or below ratioMax, its 95 per cent interval
// excluding `excludes` (entirely below it), and no task A solved that B did
// not. "pass" when all three hold; "fail" when one fails beyond what the noise
// could explain (the whole interval above ratioMax, the interval reaching
// `excludes`, or at least MIN_FLIPS lost tasks); "inside the noise" otherwise
// (a ratio above ratioMax whose interval still reaches it, or fewer than
// MIN_FLIPS lost tasks). The bootstrap interval is the one judged.
export function barVerdict(c, { ratioMax = 1.05, excludes = 1.25, which = 'raw' } = {}) {
  const r = c && c[which];
  if (!r || !r.n) return { verdict: 'no pairs', reasons: ['no task both arms solved'] };
  const lost = (c.onlyA || []).length;
  const ratioOk = r.ratioOfSums <= ratioMax;
  const intervalOk = r.bootHi < excludes;
  const lostOk = lost === 0;
  const reasons = [
    `ratio ${f2(r.ratioOfSums)} ${ratioOk ? 'at or below' : 'above'} ${ratioMax}`,
    `interval ${f2(r.bootLo)} to ${f2(r.bootHi)} ${intervalOk ? 'excludes' : 'does not exclude'} ${excludes}`,
    `${lost} task(s) lost${lost ? ` (${c.onlyA.join(', ')})` : ''}`,
  ];
  if (ratioOk && intervalOk && lostOk) return { verdict: 'pass', reasons };
  const hardFail = !intervalOk || r.bootLo > ratioMax || lost >= MIN_FLIPS;
  return { verdict: hardFail ? 'fail' : 'inside the noise', reasons };
}

export function summarize(rows, { base = 'plain', pairsOf = null, meta = {} } = {}) {
  const arms = byArm(rows);
  // meta.order when given, else the base arm first and the others in the
  // order they first appear.
  const rank = (a) => (Array.isArray(meta.order) && meta.order.includes(a) ? meta.order.indexOf(a) : a === base ? -1 : 1000);
  const names = [...arms.keys()].sort((x, y) => rank(x) - rank(y));
  const stats = Object.fromEntries(names.map((a) => [a, armStats([...arms.get(a).values()])]));
  const want = pairsOf || names.filter((a) => a !== base).map((a) => [base, a]);
  const comparisons = want.filter(([a, b]) => arms.has(a) && arms.has(b)).map(([a, b]) => ({ a, b, ...comparePair(arms.get(a), arms.get(b)) }));
  // Tasks every arm solved: the one set on which per-solved-task numbers of all
  // arms describe the same work.
  const all = names.length ? [...arms.get(names[0]).keys()].filter((t) => names.every((a) => arms.get(a).has(t) && arms.get(a).get(t).solved)) : [];
  const common = Object.fromEntries(names.map((a) => [a, {
    n: all.length,
    rawPerTask: all.length ? all.reduce((s, t) => s + arms.get(a).get(t).promptRaw, 0) / all.length : null,
    billedPerTask: all.length ? all.reduce((s, t) => s + arms.get(a).get(t).promptBilled, 0) / all.length : null,
  }]));
  const bars = (meta.bar && Array.isArray(meta.bar.pairs) ? meta.bar.pairs : [])
    .map(([a, b]) => comparisons.find((c) => c.a === a && c.b === b))
    .filter(Boolean)
    .map((c) => ({ a: c.a, b: c.b, raw: barVerdict(c, { ...meta.bar, which: 'raw' }), billed: barVerdict(c, { ...meta.bar, which: 'billed' }) }));
  return { meta, arms: names, stats, common, comparisons, bars };
}

const k = (x) => (x == null || !Number.isFinite(x) ? 'n/a' : `${(x / 1000).toFixed(1)}k`);
const f2 = (x) => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(2));
const noise = (lo, hi) => (Number.isFinite(lo) && Number.isFinite(hi) && S.insideNoise(lo, hi) ? ', inside the noise' : '');

export function ratioLine(r, label) {
  if (!r || !r.n) return `${label}: no pairs`;
  return `${label}: ${f2(r.ratioOfSums)} (paired bootstrap 95% ${f2(r.bootLo)} to ${f2(r.bootHi)}${noise(r.bootLo, r.bootHi)}); per-task geometric mean ${f2(r.geoMean)} (t 95% ${f2(r.tLo)} to ${f2(r.tHi)}${noise(r.tLo, r.tHi)}); n=${r.n}`;
}

export function markdown(sum) {
  const L = [];
  const m = sum.meta || {};
  L.push(`# ${m.title || 'Claude Code token study'}`);
  L.push('');
  if (m.lead) { L.push(m.lead); L.push(''); }
  if ((sum.bars || []).length) {
    const b = sum.meta.bar || {};
    L.push(`## ${b.title || 'The bar'}`);
    L.push('');
    if (b.text) { L.push(b.text); L.push(''); }
    for (const x of sum.bars) {
      L.push(`- **${x.b} against ${x.a}: ${x.raw.verdict}** on raw prompt tokens (${x.raw.reasons.join('; ')}). Billed-equivalent: ${x.billed.verdict} (${x.billed.reasons.slice(0, 2).join('; ')}).`);
    }
    L.push('');
  }
  L.push('## Setup');
  L.push('');
  for (const [key, val] of Object.entries(m.setup || {})) L.push(`- **${key}:** ${val}`);
  L.push('');
  L.push('## Per arm');
  L.push('');
  L.push('| Arm | Solved | Prompt tokens per solved task, raw | Billed-equivalent | Mean rounds | Gate holds (runs) | "No check ran" holds / false by atlias rule / false by any run | Hook calls cancelled / total (runs) | Spend |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const a of sum.arms) {
    const s = sum.stats[a];
    L.push(`| ${a} | ${s.solved}/${s.n} | ${k(s.rawPerSolved)} | ${k(s.billedPerSolved)} | ${f2(s.roundsMean)} | ${s.holdsAtlias} (${s.runsWithHold}) | ${s.holdsNoCheck} / ${s.holdsNoCheckFalse} / ${s.holdsNoCheckFalseBroad} | ${s.hookCallsCancelled} / ${s.hookCalls} (${s.runsWithCancelled}) | $${s.costUsd.toFixed(2)} |`);
  }
  L.push('');
  for (const a of sum.arms) {
    const s = sum.stats[a];
    if (!s.briefRuns && !s.gateChecks) continue;
    L.push(`- ${a}: SessionStart brief seen in ${s.briefRuns}/${s.n} runs, lean in ${s.briefLean}, mean ${s.briefCharsMean == null ? 'n/a' : Math.round(s.briefCharsMean)} characters; the gate ran the project's check itself ${s.gateChecks} time(s) in ${s.runsWithGateCheck} run(s), ${s.gateChecksFailed} failed (n=${s.n}).`);
  }
  L.push('');
  const anyArm = sum.arms[0];
  if (anyArm) {
    const c = sum.common[anyArm];
    L.push(`On the ${c.n} task(s) every arm solved, prompt tokens per task: ${sum.arms.map((a) => `${a} ${k(sum.common[a].rawPerTask)} raw, ${k(sum.common[a].billedPerTask)} billed-equivalent`).join('; ')} (n=${c.n}).`);
    L.push('');
  }
  for (const c of sum.comparisons) {
    L.push(`## ${c.b} against ${c.a}`);
    L.push('');
    L.push(`- Solves: ${sum.stats[c.a].solved}/${sum.stats[c.a].n} against ${sum.stats[c.b].solved}/${sum.stats[c.b].n}. Solved by ${c.a} only: ${c.onlyA.length ? c.onlyA.join(', ') : 'none'}. Solved by ${c.b} only: ${c.onlyB.length ? c.onlyB.join(', ') : 'none'}. McNemar exact p=${f2(c.mcnemarP)}${c.flipsInsideNoise ? `; fewer than ${MIN_FLIPS} one-way flips, inside the noise` : ''}.`);
    L.push(`- ${ratioLine(c.raw, 'Prompt tokens, raw, ratio over tasks both solved')}.`);
    L.push(`- ${ratioLine(c.billed, 'Prompt tokens, billed-equivalent (cache reads 0.1x, 5-minute writes 1.25x, 1-hour writes 2x)')}.`);
    L.push(`- ${ratioLine(c.cost, 'Cost in dollars as Claude Code reports it')}.`);
    L.push(`- ${ratioLine(c.rounds, 'Rounds (model requests)')}.`);
    L.push(`- Pairs no cancelled hook call touched (n=${c.clean.n}): ${c.clean.n ? ratioLine(c.clean.raw, 'raw') : 'none'}.`);
    for (const [src, v] of Object.entries(c.bySource)) L.push(`- ${src} (n=${v.n}): ${ratioLine(v.raw, 'raw')}; ${ratioLine(v.billed, 'billed-equivalent')}.`);
    L.push('');
  }
  if (m.notes && m.notes.length) {
    L.push('## Notes');
    L.push('');
    for (const n of m.notes) L.push(`- ${n}`);
    L.push('');
  }
  if (m.tasks && m.tasks.length) {
    L.push('## Task list');
    L.push('');
    L.push(`Seed \`${m.seed || ''}\`, ${m.tasks.length} task(s): ${m.tasks.map((t) => `\`${t}\``).join(', ')}.`);
    L.push('');
  }
  L.push('## Per task');
  L.push('');
  L.push(`| Task | ${sum.arms.map((a) => `${a} solved / raw / rounds / holds`).join(' | ')} |`);
  L.push(`|---|${sum.arms.map(() => '---').join('|')}|`);
  const armRows = byArm(sum.rows || []);
  const tasks = [...new Set((sum.rows || []).map((r) => r.task))].sort();
  for (const t of tasks) L.push(`| ${t} | ${sum.arms.map((a) => { const r = armRows.get(a) && armRows.get(a).get(t); return r ? `${r.solved ? 'yes' : 'NO'} / ${k(r.promptRaw)} / ${r.rounds} / ${r.holds}` : '-'; }).join(' | ')} |`);
  L.push('');
  return L.join('\n');
}

function opt(argv, name, dflt = '') { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const rows = S.readJsonl(opt(argv, '--rows'));
  const meta = opt(argv, '--meta') ? JSON.parse(fs.readFileSync(opt(argv, '--meta'), 'utf8')) : {};
  const pairsOf = meta.pairs || null;
  const sum = summarize(rows, { base: opt(argv, '--base', 'plain'), pairsOf, meta });
  const withRows = { ...sum, rows: rows.map((r) => { const { holdDetail, ...rest } = r; return { ...rest, holdDetail: (holdDetail || []).map((h) => ({ ...h, text: h.text.slice(0, 160) })) }; }) };
  if (opt(argv, '--json')) fs.writeFileSync(opt(argv, '--json'), `${JSON.stringify(withRows, null, 1)}\n`);
  const md = markdown(withRows);
  if (opt(argv, '--md')) fs.writeFileSync(opt(argv, '--md'), `${md}\n`); else process.stdout.write(`${md}\n`);
}
