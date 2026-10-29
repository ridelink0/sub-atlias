import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { accountUsage, recordAccountTokens } from '../lib/account-usage.mjs';
import { renderComposer, createTerminalUI, textWidth } from '../lib/terminal-ui.mjs';

test('accountUsage keeps valid zero, separates engines and rejects invalid/stale windows', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-account-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.mkdirSync(path.join(home, '.codex'));
    const now = 1800000000000, reset = new Date(now + 3600000).toISOString();
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: now, utilization: { five_hour: { utilization: 0, resets_at: reset }, seven_day: { utilization: 99, resets_at: reset } } } }));
    fs.writeFileSync(path.join(home, '.codex/usage-limits-codex-live.json'), JSON.stringify({ at: now, meter: { primary: { used_percent: 24, resets_at: (now + 60000) / 1000 }, secondary: { used_percent: null } } }));
    const connected = { 'claude-plan': true, codex: true, chatgpt: true, responses: true, anthropic: true, gemini: true, openai: true, ollama: true };
    let rows = accountUsage({ connected, home, env: {}, now });
    assert.equal(rows.length, 8);
    assert.match(rows[0].text, /5h 0% used \/ week 99% used/);
    assert.match(accountUsage({ connected, home, env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, now })[0].text, /week 99% used/, 'the default config directory uses the native home snapshot');
    assert.equal(accountUsage({ connected, home, env: { CLAUDE_CONFIG_DIR: path.join(home, 'other-profile') }, now })[0].windows.length, 0, 'custom profiles never borrow the default account reading');
    assert.match(rows.find(r => r.engine === 'codex').text, /5h 24% used/);
    assert.equal(rows.find(r => r.engine === 'codex').windows.length, 1);
    assert.equal(rows.find(r => r.engine === 'chatgpt').text, 'ChatGPT plan: allowance not reported');
    assert.match(rows.find(r => r.engine === 'ollama').text, /local; no plan allowance/);
    rows = accountUsage({ connected, home, env: {}, now: now + 7200000 });
    assert.match(rows[0].text, /refresh needed.*stale/);
    fs.writeFileSync(path.join(home, '.claude/usage-limits-live.json'), JSON.stringify({ fetchedAtMs: now + 1, utilization: { five_hour: { utilization: -1 }, seven_day: { utilization: '99' } } }));
    assert.equal(accountUsage({ connected, home, env: {}, now })[0].windows.length, 0);
    fs.writeFileSync(path.join(home, '.claude.json'), '{broken');
    assert.doesNotThrow(() => accountUsage({ connected, home, env: {}, now }));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('recordAccountTokens separates switched engines and preserves partial provider accounting', () => {
  const state = { engine: 'anthropic', promptLog: [90000], outLog: [90000] };
  recordAccountTokens(state, 'openai', [{ prompt: 100, output: 20 }, { prompt: 0, output: 0 }]);
  recordAccountTokens(state, 'anthropic', [{ prompt: 300, output: 40 }, { prompt: 10 }, {}]);
  const resumed = JSON.parse(JSON.stringify(state));
  const rows = accountUsage({ active: 'anthropic', connected: { openai: true }, state: resumed, home: '/fixture-absent', env: {} });
  assert.match(rows.find(r => r.engine === 'openai').text, /120 reported session tokens/);
  assert.match(rows.find(r => r.engine === 'anthropic').text, /350 reported session tokens \(partial\)/);
  assert.ok(rows.every(r => !r.text.includes('180,000')), 'legacy mixed logs cannot be attributed to a single engine');
  assert.deepEqual(state.connectionUsage.openai, { tokens: 120, calls: 2, reportedParts: 4, unreportedCalls: 0 });
  recordAccountTokens(state, 'chatgpt', [{}]);
  assert.match(accountUsage({ active: 'chatgpt', state, home: '/fixture-absent', env: {} })[0].text, /session tokens not reported/);
});

const sessions = Array.from({ length: 40 }, (_, i) => ({ sid: `session-${i}`, name: `Project ${i}`, engine: 'echo', saved: 1800000000000 - i, history: [{ role: 'user', text: `Build feature ${i}` }] }));
function rig({ rawFails = false } = {}) {
  const input = new EventEmitter(), output = new EventEmitter(), proc = new EventEmitter();
  input.isTTY = output.isTTY = true; input.isRaw = false;
  input.setRawMode = v => { if (rawFails) throw Error('raw unavailable'); input.isRaw = v; }; input.isPaused = () => false; input.pause = () => {}; input.resume = () => {};
  output.columns = 80; output.rows = 24; output.write = () => {};
  return { input, output, ui: createTerminalUI({ input, output, proc, env: { NO_COLOR: '1' } }) };
}
test('a raw-mode failure returns control for a visible numbered picker instead of asking a blank question', async () => {
  const r = rig({ rawFails: true });
  assert.equal(await r.ui.selectSession(sessions), undefined);
  assert.equal(r.ui.inputMode(), 'line');
  assert.equal(inputListeners(r), 0); r.ui.close();
});
test('session picker searches, scrolls, cancels and never submits a search as a model prompt', async () => {
  const r = rig();
  let pending = r.ui.selectSession(sessions); r.input.emit('data', '\x1b[B\r'); assert.equal(await pending, 'session-1');
  pending = r.ui.selectSession(sessions); r.input.emit('data', 'Project 39\r'); assert.equal(await pending, 'session-39');
  pending = r.ui.selectSession(sessions); r.input.emit('data', 'missing\r'); assert.equal(await pending, null);
  pending = r.ui.selectSession(sessions); r.input.emit('data', '\x03'); assert.equal(await pending, null);
  r.output.rows = 3; let settled = false;
  pending = r.ui.selectSession(sessions).then(value => { settled = true; return value; }); r.input.emit('data', '\r');
  await Promise.resolve(); assert.equal(settled, false, 'a hidden selection must not resume');
  r.input.emit('data', '\x03'); assert.equal(await pending, null); r.output.rows = 24;
  pending = r.ui.prompt(); r.input.emit('data', 'still works\r'); assert.equal(await pending, 'still works');
  r.ui.close(); assert.equal(inputListeners(r), 0);
});
function inputListeners(r) { return r.input.listenerCount('data'); }
test('allowances stay beside the model and picker frames fit terminal bounds', () => {
  for (const columns of [20, 40, 80, 160]) for (const rows of [7, 12, 24]) {
    const frame = renderComposer({ columns, rows, text: '/r', commands: [{ name: 'resume' }], info: { engine: 'claude-opus-5-5', usageRows: ['Claude plan: 5h 0% used / week 99% used', 'Codex: 5h 24% used'] } });
    assert.ok(frame.lines.length <= rows, JSON.stringify({ columns, rows, lines: frame.lines }));
    assert.ok(frame.lines.every(l => textWidth(l) < columns));
    const picker = renderComposer({ columns, rows, picker: sessions, selected: 39 });
    assert.ok(picker.lines.length <= rows); assert.equal(picker.selected, 39);
  }
  assert.match(renderComposer({ info: { engine: 'claude-opus-5-5', usageRows: ['Claude plan: 5h 0% used / week 99% used'] } }).lines.join('\n'), /Claude plan: 5h 0% used \/ week 99% used/);
  assert.match(renderComposer({ status: 'Working 3s', info: { usageRows: ['Claude plan: week 99% used'] } }).lines.join('\n'), /Claude plan: week 99% used/);
});
