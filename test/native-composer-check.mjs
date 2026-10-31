// Actual Windows ConPTY input/resize/exit, with no model turn. node-pty is an
// external verification tool, not a runtime dependency bundled with Atlias.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const pty = require(process.env.ATLIAS_PTY_MODULE || 'D:/harness-work/atlias-pty-check-1018/node_modules/node-pty');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installed = process.argv.includes('--installed');
const child = pty.spawn(installed ? 'cmd.exe' : process.execPath,
  installed ? ['/d', '/c', 'atlias'] : [path.join(root, 'bin/atlias.mjs'), 'agent', '--engine', 'echo'], {
    name: 'xterm-256color', cols: 100, rows: 30, cwd: root,
    env: { ...process.env, TERM: 'xterm-256color', ATLIAS_HOME: 'C:/Users/OWNER/.atlias-agent' },
  });
let transcript = '', exit;
child.onData(data => { transcript += data; });
const exited = new Promise(resolve => child.onExit(result => { exit = result; resolve(result); }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(text, after = 0) {
  for (let n = 0; n < 200; n++) {
    if (transcript.slice(after).includes(text)) return;
    if (exit) throw Error('PTY exited before ' + text + ': ' + exit.exitCode);
    await pause(50);
  }
  throw Error('PTY did not reach ' + text);
}
const evidence = { command: installed ? 'bare atlias via normal PATH shim' : 'source agent --engine echo diagnostic', source: root, home: 'C:/Users/OWNER/.atlias-agent', steps: [], noModelPromptSent: true };
try {
  await waitFor('Ask about this project'); evidence.steps.push('default composer boot');
  let at = transcript.length; child.write('/'); await waitFor('/clear', at); evidence.steps.push('slash opens live palette');
  child.write('\x1b[B'); child.write('\x1b'); await pause(100);
  // Clear the slash and use a unique prefix, with no pasted newline.
  child.write('\x03'); await pause(100); at = transcript.length; child.write('/he'); await waitFor('/help', at);
  at = transcript.length; child.write('\t'); await waitFor('/help', at); evidence.steps.push('prefix filtering and Tab completion');
  child.resize(42, 15); await pause(150); child.resize(110, 32); await pause(150); evidence.steps.push('native ConPTY resize narrow and wide with draft retained');
  at = transcript.length; child.write('\r'); await waitFor('/permissions', at); evidence.steps.push('Enter dispatches help without model');
  await pause(100); child.write('/exit'); await pause(100); child.write('\r');
  const result = await Promise.race([exited, pause(10000).then(() => { throw Error('PTY did not exit cleanly'); })]);
  assert.equal(result.exitCode, 0); evidence.steps.push('clean native process exit0'); evidence.exitCode = result.exitCode;
  // node-pty 1.1 on Windows can retain its input pipe after the child has exited.
  // Release only this check's pipe handles, after the native exit-code receipt.
  child._agent?.inSocket?.destroy(); child._agent?.outSocket?.destroy();
  fs.writeSync(1, JSON.stringify(evidence, null, 2) + '\n');
  // Exit only this verification runner after the app's own native exit event.
  // node-pty's Windows worker otherwise keeps its parent alive. No app process
  // is terminated here, and its measured exit code above cannot be fabricated.
  process.exit(0);
} catch (error) {
  // Ask this interactive app to exit through input; never terminate a PID.
  if (!exit) { child.write('\x03'); await pause(100); child.write('/exit'); await pause(100); child.write('\r'); }
  console.error(transcript.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-5000));
  throw error;
}
