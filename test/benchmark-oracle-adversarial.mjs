// Gev: separate attacks on false completion, unknown accounting and holdout leakage.
import assert from 'node:assert/strict';
import { measure, pairReports, direction, acceptVariant, goalEvidence } from '../lib/benchmark-oracle.mjs';

const row = (id = 'a') => ({ id, tries: 1, pass: true, checkExit: true, tampered: [], weakened: [], promptTokens: [100], outputTokens: [10], promptTotal: 100, outputTotal: 10, peakPrompt: 100, numCtx: 8192, stop: 'answered' });
const report = (results = [row()]) => ({ partial: false, results });
let passed = 0;
function check(name, run) { run(); passed++; console.log('PASS ' + name); }

for (const invalid of [null, undefined, {}, { results: {} }, { results: [null] }, { results: [row(), row()] }]) {
  check('invalid or duplicate result never grants coverage', () => {
    assert.equal(measure(invalid, ['a']).complete, false);
    assert.equal(direction(invalid, { expectedIds: ['a'] }).next.kind, 'execution-coverage');
  });
}
for (const value of [null, undefined, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
  check('invalid native count remains unknown: ' + String(value), () => {
    const attempt = row(); attempt.promptTokens = [value]; attempt.promptTotal = value; attempt.peakPrompt = value;
    assert.equal(measure(report([attempt]), ['a']).totalNativeTokens, null);
  });
}
check('summation overflow remains unknown', () => {
  const attempt = row(); attempt.promptTokens = [Number.MAX_SAFE_INTEGER, 1]; attempt.promptTotal = Number.MAX_SAFE_INTEGER; attempt.outputTokens = [1, 1]; attempt.outputTotal = 2; attempt.peakPrompt = Number.MAX_SAFE_INTEGER; attempt.numCtx = Number.MAX_SAFE_INTEGER;
  assert.equal(measure(report([attempt]), ['a']).costKnown, false);
});
check('an unexecuted check cannot be a pass', () => {
  const attempt = row(); attempt.checkExit = false;
  assert.equal(measure(report([attempt]), ['a']).complete, false);
});
check('judge tampering directs protection before more tasks', () => {
  const attempt = row(); attempt.tampered = ['tests.py edited'];
  assert.equal(direction(report([attempt]), { expectedIds: ['a'] }).next.kind, 'judge-integrity');
});
check('protected holdout report cannot enter direction', () => {
  assert.throws(() => direction({ ...report(), split: 'holdout' }), /holdout/);
  assert.throws(() => direction(report(), { sealedTaskIds: ['a'] }), /holdout/);
});
check('model configurable targets cannot lower the actual goal', () => {
  assert.deepEqual(direction(report(), { target: { totalNativeTokens: 1, fullNativePeak: 1 } }).targets, { totalNativeTokens: 20, fullNativePeak: 20 });
});
const provenance = { corpus: 'a'.repeat(64), judge: 'b'.repeat(64), profile: 'c'.repeat(64), runtime: 'd'.repeat(64), raw: 'e'.repeat(64) };
check('copied raw run cannot act as independent control', () => {
  assert.equal(pairReports(report(), report(), { candidateProvenance: provenance, baselineProvenance: provenance }).valid, false);
});
check('mismatched judge/profile/corpus cannot be paired proof', () => {
  for (const key of ['judge', 'profile', 'corpus']) assert.equal(pairReports(report(), report(), { candidateProvenance: provenance, baselineProvenance: { ...provenance, [key]: '0'.repeat(64), raw: 'f'.repeat(64) } }).valid, false);
});
check('different task sets cannot be paired proof', () => {
  assert.equal(pairReports(report(), report([row('b')]), { candidateProvenance: provenance, baselineProvenance: { ...provenance, raw: 'f'.repeat(64) } }).valid, false);
});
check('exact tie and cost-only win cannot promote', () => {
  const ids = Array.from({ length: 250 }, (_, index) => 'main-' + index);
  const holdoutIds = Array.from({ length: 10 }, (_, index) => 'held-' + index);
  const main = measure(report(ids.map(id => row(id))), ids);
  const holdout = measure(report(holdoutIds.map(id => row(id))), holdoutIds);
  assert.equal(acceptVariant(main, main, { fullTaskIds: ids, holdoutTaskIds: holdoutIds, holdoutChallenger: holdout, holdoutChampion: holdout, receiptsVerified: true }).promote, false);
});
check('malformed comparison cannot crash or prove20x', () => {
  const invalid = { comparison: { valid: true }, qualityNonInferiority: { passed: true, receipt: 'a'.repeat(64) }, allowanceCausality: { passed: true, receipt: 'b'.repeat(64) }, fullNativeContextVerified: true, nativeContextReceipt: 'c'.repeat(64) };
  assert.equal(goalEvidence({ codex: invalid, claude: invalid }).achieved, false);
});
for (const reduction of [undefined, null, NaN, Infinity, '20', 19.999]) {
  check('invalid or insufficient goal ratio cannot prove20x: ' + String(reduction), () => {
    const forged = { comparison: { valid: true, axes: { totalNativeTokens: { reduction }, fullNativePeak: { reduction } } }, qualityNonInferiority: { passed: true, receipt: 'a'.repeat(64) }, allowanceCausality: { passed: true, receipt: 'b'.repeat(64) }, fullNativeContextVerified: true, nativeContextReceipt: 'c'.repeat(64) };
    assert.equal(goalEvidence({ codex: forged, claude: forged }, { verifyReceipt: () => true }).achieved, false);
  });
}
check('JSON self-awarded proofs require an independent verifier', () => {
  const forged = { comparison: { valid: true, axes: { totalNativeTokens: { reduction: 20 }, fullNativePeak: { reduction: 20 } } }, qualityNonInferiority: { passed: true, receipt: 'a'.repeat(64) }, allowanceCausality: { passed: true, receipt: 'b'.repeat(64) }, fullNativeContextVerified: true, nativeContextReceipt: 'c'.repeat(64) };
  assert.equal(goalEvidence({ codex: forged, claude: forged }).achieved, false);
  assert.equal(goalEvidence({ codex: forged, claude: forged }, { verifyReceipt: () => false }).achieved, false);
});
console.log(JSON.stringify({ scope: 'separate zero inference adversarial controls', checks: passed, nativeGoalProved: false }));
