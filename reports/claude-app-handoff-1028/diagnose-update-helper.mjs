import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-helper-diagnose-'));
// Reproduce the original helper, never the working-tree replacement. No real installer is run.
const baseline = execFileSync('git', ['show', '11f7fac:src/main/updates.mjs'], { cwd: 'D:/atlias-max-app', encoding: 'utf8', windowsHide: true });
const baselineFile = path.join(dir, 'original-updates.mjs');
fs.writeFileSync(baselineFile, baseline);
const { startWindowsInstaller } = await import(pathToFileURL(baselineFile));
const fake = path.join(dir, 'fake-installer.exe');
try { fs.linkSync(process.execPath, fake); } catch { fs.copyFileSync(process.execPath, fake); }
const marker = path.join(dir, 'ran.json');
fs.writeFileSync(path.join(dir, 'marker.cjs'), `require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({at:Date.now(),cwd:process.cwd()}));`);
const deadline = process.argv.includes('--deadline');
const app = spawn(process.execPath, ['-e', `setTimeout(()=>{},${deadline ? 30000 : 3000})`], { stdio: 'ignore' });
await new Promise(resolve => app.once('spawn', resolve));
const exited = new Promise(resolve => app.once('exit', () => resolve(Date.now())));
let helper, helperExit;
const log = path.join(dir, 'helper.log');
const fd = fs.openSync(log, 'w');
const started = await startWindowsInstaller({ file: fake, pid: app.pid, args: ['marker.cjs'], spawnFn: (cmd, args, options) => {
  const script = path.join(dir, 'install-after-exit.cmd');
  let text = fs.readFileSync(script, 'utf8').replace('@echo off', '@echo on');
  if (deadline) text = text.replace('geq 240', 'geq 1');
  if (process.argv.includes('--csv')) text = text.replace(' /NH', ' /FO CSV /NH');
  if (process.argv.includes('--without-pipe')) {
    const line = text.split('\r\n').find(line => line.includes('| find'));
    if (!line) throw new Error('expected one pipeline in the diagnostic fixture');
    text = text.replace(line, `tasklist /FI "PID eq ${app.pid}" /NH > "%~dp0process.txt" 2>nul\r\nfind "${app.pid}" "%~dp0process.txt" >nul\r\nif errorlevel 1 goto run`);
  }
  fs.writeFileSync(script, text);
  helper = spawn(cmd, args, { ...options, stdio: ['ignore', fd, fd] });
  helper.once('exit', (code, signal) => { helperExit = { code, signal }; });
  return helper;
} });
fs.closeSync(fd);
const appExitedAt = deadline ? null : await exited;
const end = Date.now() + (deadline ? 10000 : 20000);
while (!fs.existsSync(marker) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 100));
await new Promise(resolve => setTimeout(resolve, 200));
const probe = fs.readdirSync(dir).find(name => /^wait-/.test(name) || name === 'process.txt');
console.log(JSON.stringify({ dir, started, appExitedAt, appStillRunning: app.exitCode === null, markerExists: fs.existsSync(marker), helperExit, probe: probe ? fs.readFileSync(path.join(dir, probe), 'utf8') : null, log: fs.readFileSync(log, 'utf8'), script: fs.readFileSync(path.join(dir, 'install-after-exit.cmd'), 'utf8') }, null, 2));
// Only the helper created above; prevent a deliberately failing diagnostic
// from leaving its own bounded wait running after the evidence is captured.
if (!helperExit) helper.kill();
if (app.exitCode === null) app.kill();
