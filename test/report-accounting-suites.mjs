// Gev: synthetic report metadata; no model, benchmark corpus or process controls.
import * as evals from '../lib/eval.mjs';
import { armView } from '../tools/h2h/base_harness_compare.mjs';

export default function reportAccountingSuites({ suite, check }) {
  suite('report accounting metadata', 'unknown or contradictory requests cannot become exact totals', () => {
    const row = (id = 'synthetic', extra = {}) => ({ id, pass: true, promptTotal: 10, outputTotal: 2,
      cachedTotal: 0, peakPrompt: 6, promptTokens: [6, 4], outputTokens: [2], cachedTokens: [0, 0], ...extra });
    const cost = (rows) => evals.compare({ results: rows }, { results: rows }, { rounds: 20 }).cost.a;
    const legacy = row();
    for (const key of ['promptTokens', 'outputTokens', 'cachedTokens']) delete legacy[key];
    const complete = cost([row()]);
    check('complete per-request counts and legacy aggregate-only reports remain readable', complete.promptTokens === 10
      && complete.outputTokens === 2 && complete.cachedTokens === 0 && complete.peakPrompt === 6
      && cost([legacy]).promptTokens === 10 && armView({ results: [legacy] }, new Set([legacy.id])).tokens === 12,
    { happened: JSON.stringify(complete), why: 'Reject uncertainty without discarding valid older reports that never stored per-request arrays.', fix: 'Check arrays when present and retain whole aggregate-only counts.' });
    const bad = [
      ['missing prompt', { promptTokens: [10, null] }, 'promptTokens'],
      ['conflicting prompt', { promptTotal: 11 }, 'promptTokens'],
      ['negative request', { promptTokens: [-1, 11] }, 'promptTokens'],
      ['fractional request', { promptTokens: [6.5, 3.5] }, 'promptTokens'],
      ['string request', { promptTokens: ['6', 4] }, 'promptTokens'],
      ['malformed aggregate', { promptTotal: '10' }, 'promptTokens'],
      ['empty requests', { promptTokens: [] }, 'promptTokens'],
      ['malformed requests', { promptTokens: null }, 'promptTokens'],
      ['overflowed request sum', { promptTokens: [Number.MAX_SAFE_INTEGER, 1] }, 'promptTokens'],
      ['missing output', { outputTokens: [2, null] }, 'outputTokens'],
      ['conflicting output', { outputTotal: 3 }, 'outputTokens'],
      ['missing cache', { cachedTokens: [0, null] }, 'cachedTokens'],
      ['conflicting cache', { cachedTotal: 1 }, 'cachedTokens'],
    ];
    for (const [name, extra, key] of bad) {
      const actual = cost([row('synthetic', extra)]);
      check(`${name} stays unknown despite a stored total`, actual[key] === null,
      { happened: JSON.stringify(actual), why: 'Historical totals may be lower bounds; a request list must confirm them.', fix: 'Reconcile every count and stored total before calling a sum exact.' });
    }
    const mixed = cost([row('a'), row('b', { peakPrompt: null })]);
    check('an unknown peak in one task holds the paired peak', mixed.peakPrompt === null,
    { happened: JSON.stringify(mixed), why: 'The largest known task is only a lower bound when another peak is unknown.', fix: 'Require every paired peak.' });
    const wrongPeak = cost([row('synthetic', { peakPrompt: 8 })]);
    check('a peak inconsistent with its request log is unknown', wrongPeak.peakPrompt === null,
    { happened: JSON.stringify(wrongPeak), why: 'An aggregate must agree with its retained request evidence.', fix: 'Reconcile peakPrompt against promptTokens.' });
    const zero = row('zero', { promptTotal: 0, outputTotal: 0, cachedTotal: 0, peakPrompt: 0,
      promptTokens: [0], outputTokens: [0], cachedTokens: [0] });
    check('measured zero remains zero', cost([zero]).promptTokens === 0 && cost([zero]).peakPrompt === 0
      && armView({ results: [zero] }, new Set([zero.id])).tokens === 0,
    { happened: JSON.stringify(cost([zero])), why: 'Zero is a valid count when it was actually reported.', fix: 'Distinguish null from zero.' });
    const fallback = row('array-only', { promptTotal: null, outputTotal: undefined });
    check('complete per-request logs can supply an omitted aggregate', cost([fallback]).promptTokens === 10
      && cost([fallback]).outputTokens === 2,
    { happened: JSON.stringify(cost([fallback])), why: 'Some external runners keep complete logs without totals.', fix: 'Sum complete safe logs when an aggregate is absent.' });
    for (const [name, extra] of bad.filter(([, , key]) => key !== 'cachedTokens')) {
      const candidate = row('synthetic', extra);
      check(`base arm refuses ${name}`, armView({ results: [candidate] }, new Set([candidate.id])) === null,
      { happened: JSON.stringify(candidate), why: 'A qualified arm cannot turn missing requests into cheap ones.', fix: 'Validate per-request counts and aggregates before building an arm.' });
    }
    check('base arm refuses an unknown or contradictory peak', [null, 8, -1].every(peakPrompt => {
      const candidate = row('synthetic', { peakPrompt });
      return armView({ results: [candidate] }, new Set([candidate.id])) === null;
    }), { why: 'Unknown and inconsistent peaks cannot establish savings.', fix: 'Require a counted, reconciled peak.' });
    check('legacy aggregate-only rows still require nonnegative totals and a known peak',
      armView({ results: [{ ...legacy, peakPrompt: null }] }, new Set([legacy.id])) === null
      && armView({ results: [{ ...legacy, promptTotal: -1 }] }, new Set([legacy.id])) === null,
    { why: 'The compatibility path must not bypass count validation.', fix: 'Validate legacy fields before accepting an arm.' });
    const mixedLegacy = { ...legacy, id: 'legacy' };
    const mixedArm = armView({ results: [row('counted', { startMs: 100 }), mixedLegacy] }, new Set(['counted', 'legacy']));
    check('missing request and timing metadata does not turn a partial median into an exact one', mixedArm.firstPromptMedian === null
      && mixedArm.callsMedian === null && mixedArm.startSecondsMedian === null,
    { happened: JSON.stringify(mixedArm), why: 'Filtering out unobserved tasks changes the population being summarized.', fix: 'Only report medians when every task contributed.' });
    const big = row('big', { promptTotal: Number.MAX_SAFE_INTEGER, outputTotal: 0, peakPrompt: Number.MAX_SAFE_INTEGER,
      promptTokens: [Number.MAX_SAFE_INTEGER], outputTokens: [0] });
    const one = row('one', { promptTotal: 1, outputTotal: 0, peakPrompt: 1, promptTokens: [1], outputTokens: [0] });
    check('overflow across counted tasks holds the arm and paired total', cost([big, one]).promptTokens === null
      && armView({ results: [big, one] }, new Set([big.id, one.id])) === null,
    { why: 'Individually safe counts can overflow when combined.', fix: 'Validate the full sum too.' });
    const repeated = row('repeated', { attempts: [row('first'), row('second', { promptTokens: [10, null] })] });
    check('an unknown repeated attempt cannot be hidden by its representative row', cost([repeated]).promptTokens === null,
    { why: 'Every attempt was spent, including the failed or uncounted ones.', fix: 'Reconcile all attempts.' });
  });
}
