#!/usr/bin/env node
// Tests for the study driver's pieces that need no model: the isolation each
// arm gets, the token arithmetic, the paired ratio and its intervals, what a
// transcript says about holds and cancelled hooks, and the task sampler.
//   node tools/ccstudy/test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './lib.mjs';
import { isCheck, isRun, portableCheck } from './run.mjs';
import { comparePair, byArm, summarize, markdown, barVerdict } from './summary.mjs';
import { select, parseTake } from './select.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`PASS ${name}`); } catch (e) { failed += 1; console.log(`FAIL ${name}\n  ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n  ') : e}`); }
}

// ---------- isolation ----------

const PARENT = {
  PATH: '/usr/bin', HOME: '/root', HTTPS_PROXY: 'http://127.0.0.1:1', NODE_EXTRA_CA_CERTS: '/ca.crt',
  CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'coord', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s.sock',
  CLAUDE_AFTER_LAST_COMPACT: 'true', CLAUDE_EFFORT: 'high', CLAUDE_CODE_REMOTE_SESSION_ID: 'x', ANTHROPIC_BASE_URL: 'https://api', AI_AGENT: 'cc',
  ATLIAS_HOME: '/root/.atlias', ATLIAS_ROOT: '/somewhere', SOME_SECRET: 'no',
};

test('a nested run inherits no session variable of the coordinating session', () => {
  const env = S.childEnv(PARENT, { home: '/tmp/h' });
  for (const k of Object.keys(env)) assert.ok(!/^CLAUDE|^ANTHROPIC|^AI_AGENT/.test(k), `${k} leaked`);
  assert.deepEqual(S.leakedKeys(env), []);
  assert.equal(env.HOME, '/tmp/h');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:1');
  assert.equal(env.IS_SANDBOX, '1');
  assert.equal(env.SOME_SECRET, undefined, 'only whitelisted variables pass');
  assert.equal(env.ATLIAS_HOME, undefined, 'atlias state follows the fresh HOME, not the parent');
  assert.equal(env.ATLIAS_ROOT, undefined);
});

test('a nested run needs a fresh home and refuses a CLAUDE_ variable passed as a flag', () => {
  assert.throws(() => S.childEnv(PARENT, {}), /fresh home/);
  assert.throws(() => S.childEnv(PARENT, { home: '/tmp/h', extra: { CLAUDE_CODE_SESSION_ID: 'x' } }), /may not be passed/);
  const env = S.childEnv(PARENT, { home: '/tmp/h', extra: { ATLIAS_LEAN_BRIEF: '1' } });
  assert.equal(env.ATLIAS_LEAN_BRIEF, '1');
});

test('leakedKeys names every forbidden variable', () => {
  assert.deepEqual(S.leakedKeys({ CLAUDECODE: '1', PATH: '/', CLAUDE_CODE_X: '1', CLAUDE_AFTER_LAST_COMPACT: '1' }).sort(), ['CLAUDECODE', 'CLAUDE_AFTER_LAST_COMPACT', 'CLAUDE_CODE_X']);
});

test('arms parse: plain, atlias at a ref, atlias with flags', () => {
  assert.deepEqual(S.parseArm('plain'), { name: 'plain', kind: 'plain', ref: '', flags: {} });
  const a = S.parseArm('atlias@41f9ba6');
  assert.equal(a.kind, 'atlias'); assert.equal(a.ref, '41f9ba6'); assert.deepEqual(a.flags, {});
  const f = S.parseArm('atlias@abc+ATLIAS_LEAN_BRIEF=1,ATLIAS_GATE_RUNS_CHECK=1');
  assert.deepEqual(f.flags, { ATLIAS_LEAN_BRIEF: '1', ATLIAS_GATE_RUNS_CHECK: '1' });
  assert.throws(() => S.parseArm('atlias@abc+FOO=1'), /not an ATLIAS_/);
  assert.throws(() => S.parseArm('mini'), /no arm/);
});

test('an arm list splits between arms, not between one arm\'s flags', () => {
  assert.deepEqual(S.splitArms('plain,atlias@abc,atlias@abc+ATLIAS_FLAG_A=1,ATLIAS_FLAG_B=1'),
    ['plain', 'atlias@abc', 'atlias@abc+ATLIAS_FLAG_A=1,ATLIAS_FLAG_B=1']);
  assert.deepEqual(S.splitArms('atlias@abc+ATLIAS_FLAG_A=1,ATLIAS_FLAG_B=0,plain'), ['atlias@abc+ATLIAS_FLAG_A=1,ATLIAS_FLAG_B=0', 'plain']);
  assert.deepEqual(S.splitArms('plain'), ['plain']);
  assert.deepEqual(S.parseArm(S.splitArms('plain,atlias@x+ATLIAS_FLAG_A=1,ATLIAS_FLAG_B=1')[1]).flags, { ATLIAS_FLAG_A: '1', ATLIAS_FLAG_B: '1' });
});

test('the two arms get the same argv except the plugin folder', () => {
  const common = { prompt: 'fix it', sessionId: '00000000-0000-4000-8000-000000000000', model: 'claude-sonnet-5', effort: 'medium', maxBudgetUsd: 3 };
  const plain = S.claudeArgs(common);
  const atl = S.claudeArgs({ ...common, pluginDir: '/tmp/arms/abc' });
  assert.ok(!plain.includes('--plugin-dir'));
  const i = atl.indexOf('--plugin-dir');
  assert.equal(atl[i + 1], '/tmp/arms/abc');
  assert.deepEqual([...atl.slice(0, i), ...atl.slice(i + 2)], plain);
  for (const flag of ['--session-id', '--model', '--effort', '--output-format', '--include-hook-events', '--permission-mode']) assert.ok(plain.includes(flag), flag);
  assert.equal(plain[plain.indexOf('--model') + 1], 'claude-sonnet-5');
  assert.equal(plain[plain.indexOf('--effort') + 1], 'medium');
});

test('the init message is checked against the arm', () => {
  const plainInit = { plugins: [{ name: 'agents-md' }], mcp_servers: [], skills: ['debug'] };
  const atlInit = { plugins: [{ name: 'atlias' }, { name: 'agents-md' }], mcp_servers: [{ name: 'plugin:atlias:atlias' }], skills: ['atlias:double-check'] };
  assert.deepEqual(S.initProblems(plainInit, { kind: 'plain' }), []);
  assert.deepEqual(S.initProblems(atlInit, { kind: 'atlias' }), []);
  assert.equal(S.initProblems(atlInit, { kind: 'plain' }).length, 3, 'atlias in the plain arm is three problems');
  assert.equal(S.initProblems(plainInit, { kind: 'atlias' }).length, 1);
  assert.equal(S.initProblems({ plugins: [{ name: 'atlias' }], mcp_servers: [{ name: 'gmail' }] }, { kind: 'atlias' }).length, 1);
  assert.equal(S.initProblems(null, { kind: 'plain' }).length, 1);
});

// ---------- tokens ----------

test('raw prompt tokens count every read token; billed weights cache by its multiplier', () => {
  const t = S.tokensOf({ input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300, cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 100 }, output_tokens: 7 });
  assert.equal(t.promptRaw, 1310);
  assert.equal(t.promptBilled, 10 + 100 + 1.25 * 100 + 2 * 200);
  assert.equal(t.output, 7);
  assert.ok(t.splitKnown);
});

test('cache writes with no breakdown are billed at the five-minute rate and flagged', () => {
  const t = S.tokensOf({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 400 });
  assert.equal(t.cacheWrite5m, 400);
  assert.equal(t.promptBilled, 500);
  assert.equal(t.splitKnown, false);
  assert.equal(S.addTokens(S.ZERO_TOKENS, t).splitKnown, false);
});

test('requests are counted once per message id, the last row carrying the usage', () => {
  const rows = [
    { type: 'assistant', message: { id: 'm1', model: 'x', usage: { input_tokens: 1 } } },
    { type: 'assistant', message: { id: 'm1', model: 'x', usage: { input_tokens: 5 } } },
    { type: 'assistant', message: { id: 'm2', model: 'x', usage: { input_tokens: 2 } } },
    { type: 'assistant', message: { id: 'm3', model: '<synthetic>', usage: { input_tokens: 0 } } },
    { type: 'user', message: { content: 'hi' } },
  ];
  const q = S.requestsOf(rows);
  assert.equal(q.length, 2);
  assert.equal(q[0].usage.input_tokens, 5);
});

// ---------- holds and hooks ----------

const hold = (text, uuid) => ({ type: 'attachment', uuid, attachment: { type: 'hook_blocking_error', hookEvent: 'Stop', hookName: 'Stop', blockingError: { blockingError: text } } });
const NOCHECK = 'atlias gate: one thing to settle before this reply ends.\n\n1. The reply says the work is done, but nothing was run to check it after the last edit.';
function transcript({ checkAfterEdit }) {
  const rows = [
    { type: 'user', message: { role: 'user', content: 'fix it' } },
    { type: 'assistant', message: { id: 'a1', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/ws/main.py' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  ];
  if (checkAfterEdit) {
    rows.push({ type: 'assistant', message: { id: 'a2', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'python check.py' } }] } });
    rows.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'all tests passed' }] } });
  }
  rows.push({ type: 'assistant', message: { id: 'a3', content: [{ type: 'text', text: 'Done.' }] } });
  // The same block, written three ways; only the attachment counts.
  rows.push({ type: 'user', message: { role: 'user', content: `Stop hook feedback:\n${NOCHECK}` } });
  rows.push({ type: 'system', subtype: 'stop_hook_summary', hookErrors: [NOCHECK] });
  rows.push(hold(NOCHECK, 'h1'));
  return rows;
}

test('one gate hold is counted once though the transcript writes it three ways', () => {
  const h = S.holdsOf(transcript({ checkAfterEdit: false }), isCheck);
  assert.equal(h.length, 1);
  assert.ok(h[0].atlias && h[0].saysNoCheck);
  assert.equal(h[0].falseNoCheck, false, 'no check ran, so the hold told the truth');
});

test('a hold that says no check ran when the transcript shows one is flagged', () => {
  const h = S.holdsOf(transcript({ checkAfterEdit: true }), isCheck);
  assert.equal(h.length, 1);
  assert.ok(h[0].falseNoCheck);
  assert.equal(h[0].check, 'python check.py');
});

test('a hold after `node lint.mjs` is false by any run though atlias does not call it a check', () => {
  const PASSCLAIM = 'atlias gate: one thing to settle before this reply ends.\n\n1. The reply says a check passed, but no check ran this turn.';
  const rows = [
    { type: 'assistant', message: { id: 'a1', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/ws/src.js' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'assistant', message: { id: 'a2', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'node lint.mjs' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'lint clean' }] } },
    hold(PASSCLAIM, 'h'),
  ];
  assert.equal(isCheck('node lint.mjs', ['/ws/src.js']), false);
  assert.equal(isRun('node lint.mjs'), true);
  assert.equal(isRun('cat src.js'), false);
  const [h] = S.holdsOf(rows, isCheck, isRun);
  assert.ok(h.saysNoCheck);
  assert.equal(h.falseNoCheck, false);
  assert.equal(h.falseNoCheckBroad, true);
  assert.equal(h.check, 'node lint.mjs');
});

test('a check before the last edit does not count as a check after it', () => {
  const rows = [
    { type: 'assistant', message: { id: 'a1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'python -m pytest -q' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '1 passed' }] } },
    { type: 'assistant', message: { id: 'a2', content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/ws/x.py' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } },
    hold(NOCHECK, 'h'),
  ];
  const h = S.holdsOf(rows, isCheck);
  assert.equal(h[0].falseNoCheck, false);
});

test('running the edited file counts as a check (atlias rule), printing it does not', () => {
  assert.ok(isCheck('python main.py', ['/ws/main.py']));
  assert.ok(isCheck('python -m pytest -q wordy_test.py', []));
  assert.ok(!isCheck('cat main.py', ['/ws/main.py']));
});

test('holds are also read from the stream, and a non-blocking Stop is not one', () => {
  const stream = [
    { type: 'system', subtype: 'hook_response', hook_event: 'Stop', output: JSON.stringify({ decision: 'block', reason: 'atlias gate: x' }) },
    { type: 'system', subtype: 'hook_response', hook_event: 'Stop', output: '', exit_code: 0 },
    { type: 'system', subtype: 'hook_response', hook_event: 'PostToolUse', output: JSON.stringify({ decision: 'block' }) },
  ];
  assert.equal(S.streamHolds(stream), 1);
});

test('a hook call is cancelled when its outcome says so or it never answered', () => {
  const stream = [
    { type: 'system', subtype: 'hook_started', hook_id: 'a', hook_event: 'PostToolUse' },
    { type: 'system', subtype: 'hook_response', hook_id: 'a', hook_event: 'PostToolUse', outcome: 'success' },
    { type: 'system', subtype: 'hook_started', hook_id: 'b', hook_event: 'PostToolUse' },
    { type: 'system', subtype: 'hook_response', hook_id: 'b', hook_event: 'PostToolUse', outcome: 'cancelled' },
    { type: 'system', subtype: 'hook_started', hook_id: 'c', hook_event: 'PreToolUse' },
  ];
  const calls = S.hookCallsOf(stream);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.filter((c) => c.cancelled).map((c) => c.id).sort(), ['b', 'c']);
});

test('cancelled hooks in the transcript are counted from hook rows only', () => {
  const rows = [
    { type: 'attachment', attachment: { type: 'hook_cancelled', hookEvent: 'PostToolUse' } },
    { type: 'attachment', attachment: { type: 'skill_listing', content: 'a hook you can cancel' } },
    { type: 'system', subtype: 'stop_hook_summary', hookErrors: [] },
  ];
  const c = S.cancelledInTranscript(rows);
  assert.equal(c.n, 1);
  assert.deepEqual(c.kinds, { PostToolUse: 1 });
});

// ---------- statistics ----------

test('the paired ratio is the ratio of sums, with intervals around it', () => {
  const pairs = [{ a: 100, b: 120 }, { a: 200, b: 250 }, { a: 100, b: 110 }, { a: 150, b: 180 }];
  const r = S.pairedRatio(pairs, { rounds: 2000, seed: 7 });
  assert.equal(r.n, 4);
  assert.ok(Math.abs(r.ratioOfSums - 660 / 550) < 1e-12);
  assert.ok(r.bootLo <= r.ratioOfSums && r.ratioOfSums <= r.bootHi);
  const g = Math.exp((Math.log(1.2) + Math.log(1.25) + Math.log(1.1) + Math.log(1.2)) / 4);
  assert.ok(Math.abs(r.geoMean - g) < 1e-12);
  assert.ok(r.tLo < r.geoMean && r.geoMean < r.tHi);
  assert.ok(r.tLo > 1, 'every task went up, so the interval excludes 1');
  assert.equal(S.insideNoise(r.tLo, r.tHi), false);
});

test('the same seed gives the same bootstrap interval, and identical arms give 1', () => {
  const pairs = [{ a: 10, b: 12 }, { a: 20, b: 15 }, { a: 30, b: 33 }];
  assert.deepEqual(S.pairedRatio(pairs, { seed: 3 }), S.pairedRatio(pairs, { seed: 3 }));
  const same = S.pairedRatio([{ a: 5, b: 5 }, { a: 9, b: 9 }]);
  assert.equal(same.ratioOfSums, 1); assert.equal(same.bootLo, 1); assert.equal(same.bootHi, 1);
  assert.ok(S.insideNoise(0.9, 1.1));
  assert.equal(S.pairedRatio([]).n, 0);
});

test('t quantiles match the table and McNemar is lib/eval.mjs\'s', () => {
  assert.equal(S.t975(1), 12.706);
  assert.equal(S.t975(10), 2.228);
  assert.ok(Math.abs(S.t975(1000) - 1.96) < 0.01);
  assert.ok(Math.abs(S.mcnemarP(5, 0) - 0.0625) < 1e-12);
  assert.ok(Math.abs(S.mcnemarP(36, 18) - 0.0198) < 0.001);
  assert.equal(S.mcnemarP(0, 0), 1);
});

test('the comparison names tasks solved by one arm only and says inside the noise', () => {
  const row = (arm, task, solved, raw, extra = {}) => ({ arm, task, solved, promptRaw: raw, promptBilled: raw / 4, costUsd: raw / 1e6, rounds: 4, holds: 0, hookCallsCancelled: 0, cancelledInTranscript: 0, source: 's', ...extra });
  const rows = [
    row('plain', 't1', true, 100), row('atlias@x', 't1', true, 120),
    row('plain', 't2', true, 100), row('atlias@x', 't2', false, 300),
    row('plain', 't3', false, 100), row('atlias@x', 't3', true, 90, { hookCallsCancelled: 2 }),
    row('plain', 't4', true, 200), row('atlias@x', 't4', true, 220, { hookCallsCancelled: 1 }),
  ];
  const arms = byArm(rows);
  const c = comparePair(arms.get('plain'), arms.get('atlias@x'));
  assert.deepEqual(c.onlyA, ['t2']);
  assert.deepEqual(c.onlyB, ['t3']);
  assert.ok(c.flipsInsideNoise);
  assert.equal(c.bothSolved, 2);
  assert.ok(Math.abs(c.raw.ratioOfSums - 340 / 300) < 1e-12);
  assert.equal(c.clean.n, 1, 't4 had a cancelled hook, so only t1 is clean');
  const sum = summarize(rows);
  assert.deepEqual(sum.arms, ['plain', 'atlias@x']);
  assert.equal(sum.stats.plain.rawPerSolved, 500 / 3, "every task's tokens over the solved count, as atlias eval reports it");
  const md = markdown({ ...sum, rows });
  assert.match(md, /Solved by plain only: t2/);
  assert.match(md, /inside the noise/);
  assert.match(md, /n=2/);
});

// ---------- tasks ----------

test('a Windows python path in a committed task becomes this machine\'s python', () => {
  assert.deepEqual(portableCheck(['C:\\Users\\OWNER\\Python313\\python.exe', '-m', 'pytest', '-q', 'x_test.py'], 'python3'), ['python3', '-m', 'pytest', '-q', 'x_test.py']);
  assert.deepEqual(portableCheck(['node', 'test.mjs']), ['node', 'test.mjs']);
});

test('the sampler picks the same tasks for the same seed, per source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstudy-test-'));
  try {
    for (const d of ['a', 'b']) {
      fs.mkdirSync(path.join(root, d));
      for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(root, d, `${d}${i}.json`), JSON.stringify({ id: `${d}-${i}`, prompt: 'p', check: ['true'] }));
    }
    const take = parseTake('a=3,b=2');
    const one = select(take, 'seed-1', { root });
    const two = select(take, 'seed-1', { root });
    assert.deepEqual(one, two);
    assert.equal(one.tasks.filter((t) => t.source === 'a').length, 3);
    assert.equal(one.tasks.filter((t) => t.source === 'b').length, 2);
    assert.ok(one.tasks.every((t) => /^[0-9a-f]{64}$/.test(t.sha256)));
    const other = select(take, 'seed-2', { root });
    assert.notDeepEqual(one.tasks.map((t) => t.id), other.tasks.map((t) => t.id));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the brief and the gate\'s own checks are read from a run\'s files', () => {
  const hr = (text) => ({ type: 'system', subtype: 'hook_response', hook_event: 'SessionStart', output: JSON.stringify({ hookSpecificOutput: { additionalContext: text } }) });
  const full = S.briefOf([hr('[atlias 3.8.1] Tools: MCP server "atlias" (harness_recall, harness_remember, x)')]);
  assert.equal(full.lean, false); assert.equal(full.gateRunsCheck, false);
  const lean = S.briefOf([{ type: 'system', subtype: 'init' }, hr('[atlias 3.8.1] its tools are the MCP server. atlias runs `python3 check.py` when you finish')]);
  assert.equal(lean.lean, true); assert.equal(lean.gateRunsCheck, true);
  assert.equal(S.briefOf([{ type: 'system', subtype: 'init' }]), null);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstudy-gate-'));
  try {
    assert.deepEqual(S.gateChecksOf(home), []);
    fs.mkdirSync(path.join(home, '.atlias', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.atlias', 'sessions', 'a.jsonl'), [
      { kind: 'shell', command: 'python check.py', verify: true, outcome: 'unknown' },
      { kind: 'shell', command: 'python3 check.py', verify: true, outcome: 'pass', from: 'gate' },
      { kind: 'shell', command: 'python3 check.py', verify: true, outcome: 'fail', from: 'gate' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    assert.deepEqual(S.gateChecksOf(home).map((c) => c.outcome), ['pass', 'fail']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('row 4\'s bar: pass, fail, or inside the noise', () => {
  const c = (ratioOfSums, bootLo, bootHi, onlyA = []) => ({ onlyA, raw: { n: 50, ratioOfSums, bootLo, bootHi } });
  assert.equal(barVerdict(c(1.00, 0.94, 1.06)).verdict, 'pass');
  assert.equal(barVerdict(c(1.05, 0.99, 1.12)).verdict, 'pass');
  assert.equal(barVerdict(c(1.08, 1.01, 1.16)).verdict, 'inside the noise');
  assert.equal(barVerdict(c(1.12, 1.07, 1.18)).verdict, 'fail');
  assert.equal(barVerdict(c(1.00, 0.80, 1.30)).verdict, 'fail');
  assert.equal(barVerdict(c(1.00, 0.94, 1.06, ['t1'])).verdict, 'inside the noise');
  assert.equal(barVerdict(c(1.00, 0.94, 1.06, ['1', '2', '3', '4', '5', '6'])).verdict, 'fail');
  assert.equal(barVerdict({ onlyA: [], raw: { n: 0 } }).verdict, 'no pairs');
});

console.log(`\n${passed}/${passed + failed} ccstudy checks passed.`);
process.exitCode = failed ? 1 : 0;
