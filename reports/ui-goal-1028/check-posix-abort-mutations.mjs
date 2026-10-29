import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

assert.notEqual(process.platform, 'win32', 'run this check on an actual POSIX host');
const root = path.resolve(import.meta.dirname, '../..');
const out = path.join(import.meta.dirname, 'posix-abort-mutations');
fs.mkdirSync(out, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-abort-mutations-'));
const original = fs.readFileSync(path.join(root, 'lib/proc.mjs'), 'utf8').replace(/\r\n/g, '\n');
const replaceOnce = (source, before, after) => {
  assert.equal(source.split(before).length, 2, `exactly one mutation anchor: ${before}`);
  return source.replace(before, after);
};
const runner = `
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import suites from './test/proc-abort-suites.mjs';
const ROOT=process.cwd(),TMP=fs.mkdtempSync(path.join(os.tmpdir(),'atlias-abort-check-'));
let passed=0,failed=0;
await suites({ROOT,TMP,fs,path,asyncSuite:async(_expert,_name,fn)=>{await fn();},check:(name,ok,detail)=>{if(ok){passed++;console.log('PASS '+name);}else{failed++;console.log('FAIL '+name+' '+JSON.stringify(detail));}}});
console.log(JSON.stringify({passed,failed}));
fs.rmSync(TMP,{recursive:true,force:true});process.exit(failed?1:0);
`;
const cases = [
  ['control', original, null],
  ['premature-watchdog-kill', replaceOnce(original, "w.kill('SIGTERM')", 'endTree(w.pid)'), 'interrupt stops simultaneous commands and their descendants'],
  ['missing-command-group-cleanup', replaceOnce(original, 'if (pid) endTree(pid);\n        if (w.exitCode', '/* planted missing child-group cleanup */\n        if (w.exitCode'), 'an unresponsive watchdog is bounded and its recorded command is ended too'],
];
const receipts = [];
for (const [name, source, expectedFailure] of cases) {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'lib/proc.mjs'), source);
  fs.copyFileSync(path.join(root, 'lib/watchdog.mjs'), path.join(dir, 'lib/watchdog.mjs'));
  fs.copyFileSync(path.join(root, 'test/proc-abort-suites.mjs'), path.join(dir, 'test/proc-abort-suites.mjs'));
  const syntax = spawnSync(process.execPath, ['--check', path.join(dir, 'lib/proc.mjs')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(syntax.status, 0, syntax.stderr);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', runner], { cwd: dir, encoding: 'utf8', timeout: 45000 });
  const log = `${result.stdout || ''}${result.stderr || ''}`;
  fs.writeFileSync(path.join(out, `${name}.log`), log);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, expectedFailure ? 1 : 0, `${name}: ${log}`);
  if (expectedFailure) assert.ok(log.includes(`FAIL ${expectedFailure}`), `${name} must fail its behavior assertion`);
  else assert.ok(log.includes('"passed":4,"failed":0'), log);
  receipts.push({ name, syntaxExit: syntax.status, exit: result.status, expectedFailure, log: `${name}.log` });
  console.log(`${name}: expected exit ${result.status}, intended assertion verified`);
}
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ platform: process.platform, receipts }, null, 2));
fs.rmSync(base, { recursive: true, force: true });
