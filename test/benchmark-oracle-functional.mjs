// Gev: software fixtures prove the controller contract, never native model quality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { measure, pairReports, direction, acceptVariant, goalEvidence } from '../lib/benchmark-oracle.mjs';

const row = (id, pass = true, input = 100, output = 10) => ({ id, tries: 1, pass, why: pass ? 'the check passed' : 'the check exited1', checkExit: pass, tampered: [], weakened: [], promptTokens: [input], outputTokens: [output], promptTotal: input, outputTotal: output, peakPrompt: input, numCtx: 8192, stop: 'answered', editFails: 0 });
const report = rows => ({ partial: false, results: rows });
let passed = 0;
function check(name, run) { run(); passed++; console.log('PASS ' + name); }

check('provider input plus output and peak stay separate', () => {
  const result = measure(report([row('a'), row('b', false, 200, 30)]), ['a', 'b']);
  assert.equal(result.totalNativeTokens, 340);
  assert.equal(result.totalTokensPerSolve, 340);
  assert.equal(result.peakNativePrompt, 200);
  assert.equal(result.passed, 1);
});
check('missing output counters remain unknown', () => {
  const value = row('a'); value.outputTokens = []; value.outputTotal = null;
  const result = measure(report([value]), ['a']);
  assert.equal(result.complete, true);
  assert.equal(result.costKnown, false);
  assert.equal(result.totalNativeTokens, null);
  assert.equal(direction(report([value]), { expectedIds: ['a'] }).next.kind, 'native-accounting');
});
check('frozen pairing binds corpus judge and profile', () => {
  const provenance = { corpus: 'a'.repeat(64), judge: 'b'.repeat(64), profile: 'c'.repeat(64), runtime: 'd'.repeat(64), raw: 'e'.repeat(64) };
  const comparison = pairReports(report([row('a', true, 50, 5)]), report([row('a')]), { expectedIds: ['a'], candidateProvenance: provenance, baselineProvenance: { ...provenance, raw: 'f'.repeat(64) } });
  assert.equal(comparison.valid, true);
  assert.equal(comparison.axes.totalNativeTokens.reduction, 2);
  assert.equal(comparison.axes.fullNativePeak.reduction, 2);
});
check('context failure supplies execution based direction', () => {
  const value = row('a', false); value.stop = 'context-full';
  const result = direction(report([value]), { expectedIds: ['a'] });
  assert.equal(result.next.kind, 'budget-and-context');
  assert.deepEqual(result.diagnostics[0].taskIds, ['a']);
  assert.equal(result.continueAfterGoal, true);
});
check('real252-task confirmation can pass finite promotion policy', () => {
  const ids = Array.from({ length: 252 }, (_, index) => 'main-' + index);
  const holdoutIds = Array.from({ length: 10 }, (_, index) => 'holdout-' + index);
  const candidate = measure(report(ids.map(id => row(id))), ids);
  const baseline = measure(report(ids.map((id, index) => row(id, index >= 6))), ids);
  const holdout = measure(report(holdoutIds.map(id => row(id))), holdoutIds);
  const result = acceptVariant(candidate, baseline, { fullTaskIds: ids, holdoutChallenger: holdout, holdoutChampion: holdout, holdoutTaskIds: holdoutIds, receiptsVerified: true });
  assert.equal(result.main.p, 0.03125);
  assert.equal(result.promote, true);
  assert.equal(result.continueAfterGoal, true);
});
check('output token regression blocks a prompt only apparent win', () => {
  const ids = Array.from({ length: 250 }, (_, index) => 'main-' + index);
  const holdoutIds = Array.from({ length: 10 }, (_, index) => 'holdout-' + index);
  const candidate = measure(report(ids.map(id => row(id, true, 100, 200))), ids);
  const baseline = measure(report(ids.map((id, index) => row(id, index >= 6))), ids);
  const holdout = measure(report(holdoutIds.map(id => row(id))), holdoutIds);
  const result = acceptVariant(candidate, baseline, { fullTaskIds: ids, holdoutChallenger: holdout, holdoutChampion: holdout, holdoutTaskIds: holdoutIds, receiptsVerified: true });
  assert.equal(result.promote, false);
  assert.match(result.reason, /total native/);
});
check('software checks cannot grant native20x proof', () => {
  const result = goalEvidence({});
  assert.equal(result.achieved, false);
  assert.equal(result.missing.length, 8);
  assert.equal(result.continueRunning, true);
});
check('original completed benchmark grades are read without changes', () => {
  const path = 'D:/harness-work/atlias-evolve/variants/v0000/s1.json';
  const original = fs.readFileSync(path);
  const value = JSON.parse(original);
  const result = measure(value, value.results.map(row => row.id));
  assert.equal(result.n, 10);
  assert.equal(result.passed, 1);
  assert.deepEqual(fs.readFileSync(path), original);
});
console.log(JSON.stringify({ scope: 'zero inference software fixtures and readonly historical receipt', checks: passed, nativeGoalProved: false }));
