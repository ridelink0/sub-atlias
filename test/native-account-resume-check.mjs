// Actual ConPTY entry points, isolated cache/session fixtures, no model requests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
const require = createRequire(import.meta.url);
const pty = require(process.env.ATLIAS_PTY_MODULE || 'D:/harness-work/atlias-pty-check-1018/node_modules/node-pty');
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-account-resume-'));
const home = path.join(temp, 'home'), project = path.join(temp, 'project'), claude = path.join(temp, 'claude');
for (const dir of [home, project, claude, path.join(home, 'sessions')]) fs.mkdirSync(dir, { recursive: true });
const runtime = path.join(home, 'claude-plan/runtime/node_modules/@anthropic-ai/claude-agent-sdk');
fs.mkdirSync(runtime, { recursive: true });
fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ version: '0.3.303' })); fs.writeFileSync(path.join(runtime, 'sdk.mjs'), '// fixture, never imported');
fs.writeFileSync(path.join(claude, '.claude.json'), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now(), utilization: { five_hour: { utilization: 0, resets_at: new Date(Date.now() + 3600000).toISOString() }, seven_day: { utilization: 99, resets_at: new Date(Date.now() + 3600000).toISOString() } } } }));
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ update: { autoPrompt: false }, graph: { autoBuild: false } }));
for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(home, 'sessions', `session-${i}.chat.json`), JSON.stringify({ sid: `session-${i}`, cwd: project, engine: 'echo', name: `Project ${i}`, saved: Date.now() - i * 60000, history: i === 39 ? [] : [{ role: 'user', text: `task ${i}` }, { role: 'assistant', text: 'saved reply' }], messages: [] }));
fs.writeFileSync(path.join(home, 'sessions', 'malformed.chat.json'), '{broken');
const env = { ...process.env, ATLIAS_HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: path.join(temp, 'codex'), ATLIAS_NO_IMPORT_OFFER: '1', ATLIAS_NO_DETACH: '1', NO_COLOR: '1', TERM: 'xterm-256color' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run(args, manual = false) {
  const child = pty.spawn(process.execPath, [path.join(root, 'bin/atlias.mjs'), ...args], { cols: 110, rows: 30, cwd: project, env });
  let transcript = '', exit; const replay = [], checks = [];
  child.onData(data => { transcript += data; replay.push({ data }); }); child.onExit(event => { exit = event; });
  const until = async (predicate, label) => { for (let i = 0; i < 400; i++) { if (predicate()) return; await delay(50); } throw Error('Timed out: ' + label); };
  const word = (text, at = 0) => until(() => typeof text === 'string' ? stripVTControlCharacters(transcript.slice(at)).includes(text) : text.test(stripVTControlCharacters(transcript.slice(at))), String(text));
  const capture = name => fs.writeFileSync(path.join(temp, name + '.json'), JSON.stringify(replay));
  const send = async (text, expected) => { const at = transcript.length; child.write(text); await delay(90); child.write('\r'); await word(expected, at); await delay(90); checks.push(text || '(cancel)'); };
  try {
    if (args[0] === 'agent') { await word('Claude plan: 5h 0% used / week 99% used'); if (manual) capture('footer'); child.write('/resume'); await delay(100); child.write('\r'); }
    await word('Resume session (1 of 40)');
    if (manual) capture('picker');
    const searchAt = transcript.length;
    child.write('Project 39'); await word('Resume session (1 of 1)', searchAt); await word('Search: Project 39', searchAt);
    if (manual) capture('picker-search'); child.write('\r'); await word('resumed session-39');
    if (manual) {
      const configBefore = fs.readFileSync(path.join(home, 'config.json'));
      for (const [command, expected] of [['/help all', '/resume [id or name]'], ['/help keys', 'Ctrl+J'], ['/usage', 'Account allowances are separate'], ['/connections', 'Current connection: echo'], ['/status', 'session session-39'], ['/cost', 'cost: the echo engine'], ['/model', 'engine echo has no model'], ['/effort', 'takes no reasoning effort'], ['/permissions', 'workspace'], ['/config ui.showHints', 'ui.showHints'], ['/agents', 'Default:'], ['/attachments', /image/i], ['/context', /context/i], ['/sessions', 'session-'], ['/help resume', 'search and choose'], ['/command-that-does-not-exist', /unknown command/i]]) await send(command, expected);
      capture('help');
      await send('/settings', 'select number/key'); capture('settings'); await send('q', 'Ask about this project');
      assert.ok(fs.readFileSync(path.join(home, 'config.json')).equals(configBefore), 'inspection commands do not change preferences');
      await send('/rename Beginner review', 'now named'); await send('Hello from the UI review', 'echo:');
      await send('/clear', 'new session'); await send('/resume Beginner review', 'resumed session-39');
      await send('/rewind', 'rewind to which turn'); await send('', 'no rewind');
      await send('/export ui-review-export.md', 'wrote ui-review-export.md'); assert.ok(fs.readFileSync(path.join(project, 'ui-review-export.md'), 'utf8').includes('Hello from the UI review'));
      capture('session-recovered');
      replay.push({ cols: 42, rows: 15 }); child.resize(42, 15); await delay(160); capture('narrow');
      replay.push({ cols: 110, rows: 30 }); child.resize(110, 30); await delay(160);
    }
    await delay(100); assert.equal(exit, undefined, 'the selected empty session stays open'); child.write('/exit'); await delay(100); child.write('\r');
    await until(() => Boolean(exit), 'clean exit'); assert.equal(exit.exitCode, 0);
    fs.writeFileSync(path.join(temp, (manual ? 'manual' : args[0]) + '.txt'), stripVTControlCharacters(transcript));
    return { command: args.join(' '), exit: exit.exitCode, selected: 'session-39', sessionCount: 40, ...(manual ? { manualCommands: checks } : {}) };
  } finally {
    if (!exit) child.write('\x03\x03');
    // node-pty's output worker can outlive its already-exited child on Windows.
    // Dispose only this fixture's worker; no Windows process is terminated.
    if (exit) child._agent?._conoutSocketWorker?.dispose();
    child._agent?.inSocket?.destroy(); child._agent?.outSocket?.destroy();
  }
}
const results = [await run(['agent', '--engine', 'echo']), await run(['resume'])];
if (process.env.ATLIAS_NATIVE_MANUAL === '1') results.push(await run(['agent', '--engine', 'echo'], true));
const report = { results, fixture: temp, externalModelCalls: 0, accountCacheWritten: false };
fs.writeFileSync(path.join(temp, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
