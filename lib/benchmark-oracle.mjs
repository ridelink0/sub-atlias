// Gev: executable checks give local agents direction; prose never grants a pass.
import { summarizeReport, pairedExact, promotionEvidence } from './benchmark-fitness.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const sum = values => {
  let total = 0;
  for (const value of values) {
    if (!count(value) || !Number.isSafeInteger(total + value)) return null;
    total += value;
  }
  return total;
};

export function measure(report, expectedIds) {
  const result = summarizeReport(report, { expectedIds });
  const total = result.costKnown ? sum([result.tokens, result.output]) : null;
  return {
    ...result,
    totalNativeTokens: total,
    totalTokensPerSolve: total !== null && result.passed > 0 ? total / result.passed : null,
    peakNativePrompt: result.costKnown ? result.peak : null,
    passRate: result.complete ? result.passed / result.n : null,
    scope: 'Executed task checks and provider-reported counters; no subscription or general-capability proof.',
  };
}

export function pairReports(candidate, baseline, { expectedIds, candidateProvenance, baselineProvenance } = {}) {
  const current = measure(candidate, expectedIds);
  const control = measure(baseline, expectedIds);
  const issues = [];
  for (const [label, provenance] of [['candidate', candidateProvenance], ['baseline', baselineProvenance]]) {
    if (!provenance || !['corpus', 'judge', 'runtime', 'profile', 'raw'].every(key => hash(provenance[key]))) issues.push(label + ': missing pinned provenance');
  }
  if (candidateProvenance && baselineProvenance) {
    for (const key of ['corpus', 'judge', 'profile']) {
      if (candidateProvenance[key] !== baselineProvenance[key]) issues.push(key + ': unmatched comparison');
    }
    if (candidateProvenance.raw === baselineProvenance.raw) issues.push('baseline and candidate reuse the same raw run');
  }
  let paired = null;
  try { paired = pairedExact(current, control); }
  catch (error) { issues.push(error.message); }
  const ratio = (before, after) => typeof before === 'number' && Number.isFinite(before) && before > 0 && typeof after === 'number' && Number.isFinite(after) && after > 0 ? before / after : null;
  return {
    valid: issues.length === 0 && paired !== null,
    issues, paired, candidate: current, baseline: control,
    axes: {
      totalNativeTokens: { baseline: control.totalNativeTokens, candidate: current.totalNativeTokens, reduction: ratio(control.totalNativeTokens, current.totalNativeTokens) },
      fullNativePeak: { baseline: control.peakNativePrompt, candidate: current.peakNativePrompt, reduction: ratio(control.peakNativePrompt, current.peakNativePrompt) },
      solves: { baseline: control.passed, candidate: current.passed },
    },
  };
}

export function direction(report, { expectedIds, requiredSuites = [], completedSuites = [], sealedTaskIds = [] } = {}) {
  const rawRows = Array.isArray(report?.results) ? report.results : [];
  if (!Array.isArray(sealedTaskIds) || sealedTaskIds.some(id => typeof id !== 'string' || !id)) throw new Error('Gev sealed task identities must be explicit');
  if (report?.split === 'holdout' || rawRows.some(row => row && sealedTaskIds.includes(row.id))) throw new Error('Gev holdout traces must never enter the proposer direction');
  const measured = measure(report, expectedIds);
  if (!Array.isArray(requiredSuites) || !Array.isArray(completedSuites) || [...requiredSuites, ...completedSuites].some(id => typeof id !== 'string' || !id)) throw new Error('Gev suite identities must be explicit nonempty strings');
  const missing = [...new Set(requiredSuites)].filter(id => !completedSuites.includes(id)).sort();
  const causes = new Map();
  const add = (kind, id) => causes.set(kind, [...(causes.get(kind) || []), id]);
  for (const row of rawRows) {
    if (!row || typeof row !== 'object') continue;
    const attempts = row.tries === 1 ? [row] : Array.isArray(row.attempts) ? row.attempts : [];
    for (const attempt of attempts) {
      if (!attempt || typeof attempt !== 'object') continue;
      if (attempt.tampered?.length || attempt.weakened?.length) add('judge-integrity', row.id);
      else if (['context-full', 'resource-exhausted', 'truncated-output', 'rounds-exhausted', 'check-stalled'].includes(attempt.stop)) add('budget-and-context', row.id);
      else if (['malformed-output', 'model-error', 'crashed'].includes(attempt.stop)) add('transport-and-tool-contract', row.id);
      else if (count(attempt.editFails) && attempt.editFails > 0) add('edit-application', row.id);
      else if (attempt.pass === false) add('correctness', row.id);
    }
  }
  const priorities = ['judge-integrity', 'transport-and-tool-contract', 'budget-and-context', 'edit-application', 'correctness'];
  const advice = {
    'judge-integrity': 'Protect grader files outside the agent workspace; reject tampering using execution receipts.',
    'transport-and-tool-contract': 'Repair the captured provider/tool contract or environment failure using its exact error; do not guess a pass.',
    'budget-and-context': 'Use a bounded fresh retry with the error, explicit context limits and task-token budgets; preserve all consumed tokens.',
    'edit-application': 'Use whole-file writes for the failing edit class and execute the independent check.',
    correctness: 'Use the failing executable counterexample to propose one scoped change and test it on fresh paired tasks.',
  };
  const next = causes.has('judge-integrity') ? { kind: 'judge-integrity', action: advice['judge-integrity'] }
    : !measured.complete ? { kind: 'execution-coverage', action: 'Complete the frozen task set and resolve invalid check receipts without replaying completed tasks.' }
    : !measured.costKnown ? { kind: 'native-accounting', action: 'Capture every provider call, including failures, before asserting token or peak improvement.' }
    : priorities.find(kind => causes.has(kind)) ? { kind: priorities.find(kind => causes.has(kind)), action: advice[priorities.find(kind => causes.has(kind))] }
    : missing.length ? { kind: 'suite-coverage', action: 'Run the next available required suite: ' + missing[0] }
    : { kind: 'efficiency', action: 'Screen one configuration or prompt change against fresh paired execution results; continue after reaching the target.' };
  return {
    schema: 'atlias.direction.v1', measured, missingSuites: missing, next,
    diagnostics: priorities.filter(kind => causes.has(kind)).map(kind => ({ kind, taskIds: [...new Set(causes.get(kind))].sort(), action: advice[kind] })),
    targets: { totalNativeTokens: 20, fullNativePeak: 20 },
    continueAfterGoal: true,
    judge: 'Executable checks only; no model vote or self-awarded completion.',
  };
}

export function acceptVariant(candidate, baseline, options) {
  const result = promotionEvidence(candidate, baseline, options);
  const candidates = [candidate, options?.holdoutChallenger];
  const controls = [baseline, options?.holdoutChampion];
  const totalStable = candidates.every((current, index) => {
    const control = controls[index];
    const now = current?.costKnown ? sum([current.tokens, current.output]) : null;
    const before = control?.costKnown ? sum([control.tokens, control.output]) : null;
    return now !== null && before !== null && current.passed > 0 && control.passed > 0 && now / current.passed <= before / control.passed;
  });
  return { ...result, promote: result.promote && totalStable, reason: result.promote && !totalStable ? 'total native input plus output tokens per solve regressed or remain unknown' : result.reason, continueAfterGoal: true };
}

export function goalEvidence(hostEvidence, { verifyReceipt } = {}) {
  const missing = [];
  for (const host of ['codex', 'claude']) {
    const evidence = hostEvidence?.[host];
    const axes = evidence?.comparison?.axes;
    const reductions = [axes?.totalNativeTokens?.reduction, axes?.fullNativePeak?.reduction];
    if (evidence?.comparison?.valid !== true || reductions.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 20)) missing.push(host + ': measured20x token and full native peak comparisons');
    if (evidence?.qualityNonInferiority?.passed !== true || !hash(evidence.qualityNonInferiority.receipt)) missing.push(host + ': independent matched capability and noninferiority evidence');
    if (evidence?.allowanceCausality?.passed !== true || !hash(evidence.allowanceCausality.receipt)) missing.push(host + ': independently causal subscription allowance evidence');
    if (evidence?.fullNativeContextVerified !== true || !hash(evidence.nativeContextReceipt)) missing.push(host + ': full native context capture evidence');
    if (evidence && (typeof verifyReceipt !== 'function' || ![
      ['quality', evidence.qualityNonInferiority?.receipt],
      ['allowance', evidence.allowanceCausality?.receipt],
      ['context', evidence.nativeContextReceipt],
    ].every(([kind, receipt]) => hash(receipt) && verifyReceipt({ host, kind, receipt, evidence }) === true))) missing.push(host + ': receipts have not passed the independent controller verifier');
  }
  return { achieved: missing.length === 0, missing, continueRunning: true, scope: 'Software checks alone never establish native20x or subscription gains.' };
}
