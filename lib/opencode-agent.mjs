// Atlias's standalone and eval entry points use the pinned OpenCode process.
// The old text-action loop remains only for historical scripted test fixtures.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config, STATE_DIR } from './core.mjs';
import { runOpenCode, verifySource, OPENCODE_PIN } from './opencode-runtime.mjs';

export const LOCAL_RUNTIME = `opencode/${OPENCODE_PIN.version}@${OPENCODE_PIN.commit}`;
const counter = (v) => Number.isSafeInteger(v) && v >= 0;

// A failed dispatched request can have cost even if the provider sent no
// counters. Retain measured lower bounds without treating them as full totals.
export function nativeAccounting(records) {
  const calls = records.filter((r) => r.kind === 'chat');
  const dispatched = calls.filter((r) => r.dispatched === true);
  const valid = dispatched.filter((r) => counter(r.tokens?.input) && counter(r.tokens?.output));
  const input = valid.reduce((n, r) => n + r.tokens.input, 0);
  const output = valid.reduce((n, r) => n + r.tokens.output, 0);
  const complete = dispatched.length > 0 && valid.length === dispatched.length && counter(input) && counter(output) && counter(input + output);
  return {
    calls: calls.length, dispatched: dispatched.length, counted: valid.length,
    unknown: dispatched.length - valid.length, complete,
    input: complete ? input : null, output: complete ? output : null,
    total: complete ? input + output : null,
    lowerBound: { input: counter(input) ? input : null, output: counter(output) ? output : null, total: counter(input + output) ? input + output : null },
    peakPrompt: complete ? Math.max(...valid.map((r) => r.tokens.input)) : null,
    peakPromptPlusOutput: complete ? Math.max(...valid.map((r) => r.tokens.input + r.tokens.output)) : null,
    // Full native context needs enforcement/allocation evidence, beyond the
    // provider's counters and configured num_ctx.
    fullNativePeakContext: null,
  };
}

export function nativeSuiteAccounting(results) {
  const rows = results.flatMap((r) => r.attempts || [r]);
  const sum = (key) => {
    const values = rows.map((r) => r.nativeAccounting?.lowerBound?.[key]);
    const total = values.reduce((n, v) => n + (v ?? 0), 0);
    return values.some((v) => v != null && !counter(v)) || !counter(total) ? null : total;
  };
  const input = sum('input'), output = sum('output');
  const complete = rows.length > 0 && rows.every((r) => r.nativeAccounting?.complete === true) && counter(input) && counter(output) && counter(input + output);
  return { accountingComplete: complete, knownInputLowerBound: input, knownOutputLowerBound: output,
    promptTotal: complete ? input : null, outputTotal: complete ? output : null,
    totalNativeTokens: complete ? input + output : null,
    peakPrompt: complete ? Math.max(...rows.map((r) => r.nativeAccounting.peakPrompt)) : null,
    fullNativePeakContext: null };
}

export function receiptRecords(receipt) {
  const file = path.join(receipt.stateRoot || '', 'ledger.jsonl');
  const raw = fs.readFileSync(file, 'utf8');
  return raw.split(/\r?\n/).filter((s) => s.trim()).map((s) => JSON.parse(s));
}

export function runtimeOutcome(receipt, records) {
  const reasons = [];
  if (receipt.runtime !== 'opencode-pinned-source') reasons.push('the process was not the pinned OpenCode runtime');
  if (receipt.status !== 'completed' || receipt.exit?.code !== 0) reasons.push(`runtime ${receipt.status || 'unknown'}`);
  if (!(receipt.cli?.events > 0) || !(receipt.cli?.types?.step_finish > 0)) reasons.push('no completed native step was recorded');
  if (receipt.cli?.errors?.length || receipt.cli?.unparsed?.length) reasons.push('native output contains errors or malformed events');
  const sessions = Object.keys(receipt.cli?.sessions || {});
  if (!sessions.length || sessions.some((id) => !id || id === 'undefined' || id === 'null')) reasons.push('completed native session identity is missing');
  if (sessions.some((id) => receipt.reconciliation?.sessions?.[id]?.match !== true)) reasons.push('native session accounting did not reconcile');
  if (receipt.globalProfileUnchanged !== true) reasons.push('global profile preservation was not verified');
  if (records.some((r) => r.kind === 'egress')) reasons.push('the runtime attempted external network access');
  const calls = records.filter((r) => r.kind === 'chat' && r.dispatched);
  if (!calls.length) reasons.push('no native inference was dispatched');
  if (calls.some((r) => typeof r.session?.id !== 'string' || !r.session.id.trim())) reasons.push('provider request has no native session identity');
  if (calls.some((r) => r.status !== 'ok')) reasons.push('a dispatched provider request failed');
  return { executed: reasons.length === 0, reasons, accounting: nativeAccounting(records) };
}

export function sourceReady() {
  const source = verifySource();
  if (!source.ok) return source;
  const diff = spawnSync('git', ['-C', source.root, 'diff', '--exit-code', 'HEAD', '--'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const fresh = spawnSync('git', ['-C', source.root, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (source.commitFrom !== 'git' || diff.status !== 0 || fresh.status !== 0 || fresh.stdout.trim()) {
    source.ok = false;
    source.problems.push('the pinned source must have a verified clean tracked and untracked tree');
  }
  return source;
}

export function localOptions(cfg = config().agent) {
  if (cfg.permissions && cfg.permissions !== 'workspace') throw new Error(`OpenCode migration holds ${cfg.permissions} permissions until native enforcement is implemented; no inference ran`);
  return { model: cfg.ollamaModel, numCtx: cfg.ollamaNumCtx,
    upstream: cfg.ollamaUrl, steps: cfg.maxToolRounds,
    shell: 'deny', subagent: 'allow' };
}

export async function executeLocal(state, prompt, opts = {}, cfg = config().agent) {
  let options;
  try { options = { ...localOptions(cfg), ...opts }; }
  catch (e) { return { executed: false, text: `OpenCode held: ${e.message}`, reasons: [e.message], receipt: null, records: [], accounting: nativeAccounting([]) }; }
  const ready = sourceReady();
  if (!ready.ok) return { executed: false, text: `OpenCode source is not ready: ${ready.problems.join('; ')}`, reasons: ready.problems, receipt: null, records: [], accounting: nativeAccounting([]) };
  // Every attempt gets its own evidence directory; a later turn never
  // overwrites the prior receipt, including failed or unknown-cost attempts.
  const dir = path.join(STATE_DIR, 'opencode-runs');
  fs.mkdirSync(dir, { recursive: true });
  const stateRoot = fs.mkdtempSync(path.join(dir, 'run-'));
  const history = (state.history || []).slice(-6).map((h) => `${h.role}: ${h.text}`).join('\n');
  const fullPrompt = history ? `Earlier Atlias turns:\n${history}\n\nCurrent request:\n${prompt}` : prompt;
  const receipt = await runOpenCode({ ...options, prompt: fullPrompt, taskDir: state.cwd, stateRoot });
  let records = [], readError = null;
  try { records = receiptRecords(receipt); } catch (e) { readError = e.message; }
  const outcome = runtimeOutcome(receipt, records);
  if (readError) { outcome.executed = false; outcome.reasons.push(`ledger evidence unreadable: ${readError}`); }
  state.nativeReceipts ||= [];
  state.nativeReceipts.push({ file: path.join(stateRoot, 'receipt.json'), status: receipt.status, executed: outcome.executed, reasons: outcome.reasons, accounting: outcome.accounting });
  state.nativeRuntime = LOCAL_RUNTIME;
  state.nativeAccounting = outcome.accounting;
  // Continuity is explicit prompt history until durable native resume is
  // independently qualified; this is not full native session equivalence.
  state.nativeContinuity = 'explicit-history';
  return { ...outcome, receipt, records,
    text: outcome.executed ? receipt.cli.text : `OpenCode held: ${outcome.reasons.join('; ')}${receipt.stderrTail ? `\n${receipt.stderrTail}` : ''}` };
}

export async function localTurn(state, prompt) {
  const result = await executeLocal(state, prompt);
  return result.text;
}

export function taskRuntime(cfg) {
  return async (state, prompt, { budget } = {}) => executeLocal(state, prompt, budget ? { steps: budget } : {}, cfg);
}
