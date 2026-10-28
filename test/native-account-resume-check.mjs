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
for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(home, 'sessions', `session-${i}.chat.json`), JSON.stringify({ sid: `session-${i}`, cwd: project, engine: 'echo', name: `Project ${i}`, saved: Date.now() - i * 60000, history: [{ role: 'user', text: `task ${i}` }, { role: 'assistant', text: 'saved reply' }], messages: [] }));
fs.writeFileSync(path.join(home, 'sessions', 'malformed.chat.json'), '{broken');
const env = { ...process.env, ATLIAS_HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: path.join(temp, 'codex'), ATLIAS_NO_IMPORT_OFFER: '1', ATLIAS_NO_DETACH: '1', NO_COLOR: '1', TERM: 'xterm-256color' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run(args) {
  const child = pty.spawn(process.execPath, [path.join(root, 'bin/atlias.mjs'), ...args], { cols: 110, rows: 30, cwd: project, env });
  let transcript = '', exit;
  child.onData(data => { transcript += data; }); child.onExit(event => { exit = event; });
  const until = async (predicate, label) => { for (let i = 0; i < 400; i++) { if (predicate()) return; await delay(50); } throw Error('Timed out: ' + label); };
  const word = text => until(() => stripVTControlCharacters(transcript).includes(text), text);
  try {
    if (args[0] === 'agent') { await word('Claude plan: 5h 0% used / week 99% used'); child.write('/resume'); await delay(100); child.write('\r'); }
    await word('Resume session (1 of 40)');
    child.write('Project 39'); await delay(100); child.write('\r'); await word('resumed session-39');
    await delay(100); child.write('/exit'); await delay(100); child.write('\r');
    await until(() => Boolean(exit), 'clean exit'); assert.equal(exit.exitCode, 0);
    fs.writeFileSync(path.join(temp, args[0] + '.txt'), stripVTControlCharacters(transcript));
    return { command: args.join(' '), exit: exit.exitCode, selected: 'session-39', sessionCount: 40 };
  } finally { if (!exit) child.write('\x03\x03'); child._agent?.inSocket?.destroy(); child._agent?.outSocket?.destroy(); }
}
const results = [await run(['agent', '--engine', 'echo']), await run(['resume', '--engine', 'echo'])];
const report = { results, fixture: temp, externalModelCalls: 0, accountCacheWritten: false };
fs.writeFileSync(path.join(temp, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
