// Native ConPTY queue recovery and pipe-captured append-only output.
// Loopback HTTP only. No paid model, production credentials or PID termination.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
const require = createRequire(import.meta.url);
const pty = require(process.env.ATLIAS_PTY_MODULE || 'D:/harness-work/atlias-pty-check-1018/node_modules/node-pty');
const root = path.resolve(import.meta.dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-terminal-usability-'));
const home = path.join(temp, 'home'), project = path.join(temp, 'project');
fs.mkdirSync(home); fs.mkdirSync(project);
const pause = ms => new Promise(r => setTimeout(r, ms));
const requests = [], held = [];
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', s => body += s); req.on('end', () => { requests.push(JSON.parse(body)); held.push(res); });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ agent: { engine: 'openai', openaiUrl: `http://127.0.0.1:${server.address().port}/v1`, openaiModel: 'local-terminal-fixture' }, ui: { usageEnabled: true }, update: { autoPrompt: false }, graph: { autoBuild: false } }));
fs.writeFileSync(path.join(home, 'onboarding.json'), JSON.stringify({ schema: 'atlias.onboarding.v1', method: 'openai', status: 'complete', verification: 'local_fixture' }));
const env = { ...process.env, FORCE_COLOR: '3', COLORTERM: 'truecolor', TERM: 'xterm-256color', ATLIAS_HOME: home, CLAUDE_CONFIG_DIR: path.join(temp, 'claude'), CODEX_HOME: path.join(temp, 'codex'), OPENAI_API_KEY: 'fixture-only', ATLIAS_NO_IMPORT_OFFER: '1', ATLIAS_NO_DETACH: '1' };
delete env.NO_COLOR;
const child = pty.spawn(process.execPath, [path.join(root, 'bin/atlias.mjs'), 'agent', '--engine', 'openai'], { name: 'xterm-256color', cols: 100, rows: 30, cwd: project, env });
let transcript = '', nativeExit, pipe, pipeText = '', pipeExit;
const replay = [];
child.onData(data => { transcript += data; replay.push({ data }); });
const nativeDone = new Promise(r => child.onExit(e => { nativeExit = e; r(e); }));
async function until(test, label) { for (let i = 0; i < 300; i++) { if (test()) return; await pause(50); } throw Error(`Timed out: ${label}`); }
const nativeWord = (word, at = 0) => until(() => stripVTControlCharacters(transcript.slice(at)).includes(word), word);
const pipeWord = (word, at = 0) => until(() => pipeText.slice(at).includes(word), word);
function reply(n, text = `FIXTURE_REPLY_${n}`) { const res = held[n - 1]; assert.ok(res); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } })); }
async function nativeSend(text) { child.write(text); await pause(180); child.write('\r'); await pause(200); }
try {
  await nativeWord('Ask about this project');
  fs.writeFileSync(path.join(temp, 'start-replay.json'), JSON.stringify(replay));
  await nativeSend('initial task'); await until(() => requests.length === 1, 'first request');
  await nativeSend('queued A'); await nativeSend('queued B'); child.write('unsent C'); await pause(200);
  reply(1); await until(() => requests.length === 2, 'queued A request');
  reply(2); await until(() => requests.length === 3, 'queued B request');
  const afterThird = transcript.length; reply(3); await nativeWord('FIXTURE_REPLY_3', afterThird); await nativeWord('unsent C', afterThird);
  fs.writeFileSync(path.join(temp, 'recovered-draft-replay.json'), JSON.stringify(replay));
  child.write('\r'); await until(() => requests.length === 4, 'recovered C request');
  await nativeSend('Describe @"missing image.png"'); child.write('unsent D'); await pause(200);
  const afterFourth = transcript.length; reply(4); await nativeWord('Message not sent.', afterFourth); await nativeWord('unsent D', transcript.indexOf('Message not sent.', afterFourth));
  assert.equal(requests.length, 4, 'invalid queued attachment must not call provider');
  fs.writeFileSync(path.join(temp, 'rejected-queue-replay.json'), JSON.stringify(replay));
  const chatFile = fs.readdirSync(path.join(home, 'sessions')).find(f => f.endsWith('.chat.json'));
  const state = JSON.parse(fs.readFileSync(path.join(home, 'sessions', chatFile), 'utf8'));
  assert.deepEqual(state.history.filter(h => h.role === 'user').map(h => h.text), ['initial task', 'queued A', 'queued B', 'unsent C']);
  assert.equal(state.connectionUsage.openai.tokens, 480, 'four reported calls are attributed to the selected provider');
  assert.equal(state.connectionUsage.openai.calls, 4);
  const historyFile = fs.readdirSync(path.join(home, 'input-history'))[0];
  const inputHistory = JSON.parse(fs.readFileSync(path.join(home, 'input-history', historyFile), 'utf8'));
  assert.ok(inputHistory.includes('queued A') && inputHistory.includes('Describe @"missing image.png"') && !inputHistory.includes('unsent D'));
  child.write('\x15'); await pause(160); await nativeSend('/exit');
  await until(() => Boolean(nativeExit), 'native clean exit'); assert.equal(nativeExit.exitCode, 0);
  child._agent?.inSocket?.destroy(); child._agent?.outSocket?.destroy();
  pipe = spawn(process.execPath, [path.join(root, 'bin/atlias.mjs'), 'agent', '--engine', 'openai', '--plain'], { cwd: project, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  pipe.stdout.on('data', s => pipeText += s); pipe.stderr.on('data', s => fs.appendFileSync(path.join(temp, 'plain-stderr.txt'), s));
  pipe.on('exit', code => { pipeExit = code; });
  await pipeWord('you> '); pipe.stdin.write('plain task\n'); await until(() => requests.length === 5, 'plain request');
  const during = pipeText; await pause(450); assert.equal(pipeText, during, 'no app redraw while request is held');
  reply(5, '**PLAIN_REPLY**\x1b[2J\x1b]0;bad title\x07 safe\x01'); await pipeWord('PLAIN_REPLY'); await pipeWord('you> ', pipeText.indexOf('PLAIN_REPLY'));
  let at = pipeText.length; pipe.stdin.write('/help keys\n'); await pipeWord('Line input is active.', at); await pipeWord('you> ', at);
  at = pipeText.length; pipe.stdin.write('/settings\n'); await pipeWord('select number/key', at);
  at = pipeText.length; pipe.stdin.write('attachments.enabled\n'); await pipeWord('1  true', at);
  at = pipeText.length; pipe.stdin.write('\n'); await pipeWord('unchanged', at); await pipeWord('select number/key', at);
  at = pipeText.length; pipe.stdin.write('q\n'); await pipeWord('you> ', at); pipe.stdin.write('/exit\n');
  await until(() => pipeExit !== undefined, 'plain clean exit'); assert.equal(pipeExit, 0);
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(pipeText), 'application stdout must contain no terminal controls');
  assert.ok(!pipeText.includes('bad title') && !pipeText.includes('▄██▄') && pipeText.includes('Atlias '));
  fs.writeFileSync(path.join(temp, 'plain-stdout.txt'), pipeText);
  fs.writeFileSync(path.join(temp, 'native-transcript.ansi'), transcript);
  const receipt = { source: root, fixture: temp, nativeExitCode: nativeExit.exitCode, plainExitCode: pipeExit, providerCalls: requests.length, externalModelCalls: 0, checks: ['native queue A/B preserves unsent C', 'recovered C submits exact request', 'rejected queued attachment preserves D without provider call', 'submitted queue history excludes unsent draft', 'plain mode has no application terminal controls or periodic redraw', 'plain contextual keyboard help', 'boolean inspection unchanged', 'both clean exits'] };
  fs.writeFileSync(path.join(temp, 'receipt.json'), JSON.stringify(receipt, null, 2));
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
} finally {
  fs.writeFileSync(path.join(temp, 'native-transcript.ansi'), transcript);
  fs.writeFileSync(path.join(temp, 'plain-stdout.txt'), pipeText);
  for (const res of held) if (!res.writableEnded) res.end();
  if (!nativeExit) { child.write('\x03'); await pause(100); child.write('\x15/exit\r'); await Promise.race([nativeDone, pause(2000)]); }
  if (pipe && pipeExit === undefined) { pipe.stdin.write('/exit\n'); pipe.stdin.end(); }
  child._agent?.inSocket?.destroy(); child._agent?.outSocket?.destroy();
  await new Promise(r => server.close(r));
  process.stdout.write(`Fixture: ${temp}\n`);
}
// Windows node-pty can retain a helper handle after the actual child exit above.
process.exit(0);
