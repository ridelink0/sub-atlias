import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as proc from '../lib/proc.mjs';

export default async function procAbortSuites({ asyncSuite, check, TMP, ROOT, fs, path }) {
  await asyncSuite('process tree expert', 'interrupted commands end their descendants and report failure', async () => {
    const dir = path.join(TMP, 'interrupt-command');
    fs.mkdirSync(dir, { recursive: true });
    const win = process.platform === 'win32';
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const pidAt = file => { try { return Number(fs.readFileSync(file, 'utf8')) || 0; } catch { return 0; } };
    const active = pid => {
      if (!pid) return false;
      try { process.kill(pid, 0); } catch (error) { return error.code === 'EPERM'; }
      if (!win) {
        const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
        if (state.status === 0 && /^Z/.test(state.stdout.trim())) return false;
      }
      return true;
    };
    const wait = async predicate => { const end = Date.now() + 6000; while (!predicate() && Date.now() < end) await sleep(25); return predicate(); };
    const bounded = pending => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('interrupt did not settle within 8 seconds')), 8000);
      pending.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    const own = [];
    const ownFiles = [];
    const detail = happened => ({ happened, why: 'A stopped job must leave no active command or descendant and must never report success.', fix: 'Signal the POSIX watchdog before ending it; force cleanup of its recorded command group if it does not respond.' });
    try {
      const files = [0, 1].map(n => ({ parent: path.join(dir, `parent-${n}`), child: path.join(dir, `child-${n}`) }));
      ownFiles.push(...files.flatMap(file => [file.parent, file.child]));
      const pending = files.map((file, i) => {
        const helper = `require('fs').writeFileSync(${JSON.stringify(file.child)},String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(),60000)`;
        const code = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(file.parent)},String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(),60000)`;
        if (!win && i === 1) {
          const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
          return proc.runAsync('/bin/sh', ['-c', `${quote(process.execPath)} -e ${quote(code)}`], { timeoutMs: 15000 });
        }
        return proc.runAsync(process.execPath, ['-e', code], { timeoutMs: 15000 });
      });
      const ready = await wait(() => files.every(file => pidAt(file.parent) && pidAt(file.child)));
      for (const file of files) own.push(pidAt(file.parent));
      proc.abortRunning();
      proc.abortRunning();
      const results = await bounded(Promise.all(pending));
      const gone = await wait(() => files.every(file => !active(pidAt(file.parent)) && !active(pidAt(file.child))));
      check('interrupt stops simultaneous commands and their descendants, including a POSIX shell', ready && gone, detail(JSON.stringify({ ready, gone, files: files.map(file => ({ parent: pidAt(file.parent), child: pidAt(file.child), parentActive: active(pidAt(file.parent)), childActive: active(pidAt(file.child)) })) })));
      check('an interrupted command has no successful status and reports why it stopped', results.every(result => result.status === null && result.error && (win || /stopped by SIGTERM/.test(result.error.message))), detail(JSON.stringify(results.map(result => ({ status: result.status, error: result.error?.message })))));

      // This private copy has a watchdog that ignores SIGTERM. Its recorded
      // command still needs to be ended before the watchdog is force-killed.
      const fixture = path.join(dir, 'unresponsive');
      fs.mkdirSync(fixture);
      fs.copyFileSync(path.join(ROOT, 'lib', 'proc.mjs'), path.join(fixture, 'proc.mjs'));
      const watchdogPid = path.join(fixture, 'watchdog-pid');
      ownFiles.push(watchdogPid);
      fs.writeFileSync(path.join(fixture, 'watchdog.mjs'), `import {spawn} from 'node:child_process';import fs from 'node:fs';const s=JSON.parse(process.argv[2]);fs.writeFileSync(process.env.ATLIAS_TEST_WATCHDOG_PID,String(process.pid));process.on('SIGTERM',()=>{});const c=spawn(s.cmd,s.args,{detached:process.platform!=='win32',stdio:'ignore'});if(c.pid)fs.writeSync(3,JSON.stringify({pid:c.pid})+'\\n');setInterval(()=>{},1000);`);
      const stubborn = await import(pathToFileURL(path.join(fixture, 'proc.mjs')).href);
      const stubbornPid = path.join(dir, 'stubborn-child');
      ownFiles.push(stubbornPid);
      const stuck = stubborn.runAsync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(stubbornPid)},String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(),60000)`], { timeoutMs: 15000, env: { ATLIAS_TEST_WATCHDOG_PID: watchdogPid } });
      const stuckReady = await wait(() => pidAt(stubbornPid));
      own.push(pidAt(stubbornPid));
      stubborn.abortRunning();
      stubborn.abortRunning();
      const stopped = await bounded(stuck);
      const stuckGone = await wait(() => !active(pidAt(stubbornPid)));
      check('an unresponsive watchdog is bounded and its recorded command is ended too', stuckReady && stuckGone && stopped.status === null && stopped.error, detail(JSON.stringify({ stuckReady, stuckGone, status: stopped.status, error: stopped.error?.message })));

      await sleep(100);
      proc.abortRunning();
      const quick = await proc.runAsync(process.execPath, ['-e', "process.stdout.write('still works')"], { timeoutMs: 5000 });
      proc.abortRunning();
      check('repeated idle interrupts leave the next command and its successful result intact', quick.status === 0 && quick.stdout === 'still works' && !quick.error, detail(JSON.stringify({ status: quick.status, stdout: quick.stdout, error: quick.error?.message })));
    } finally {
      // Only command roots started by this test; never search for or end an
      // unrelated process. Also bound the intentionally broken mutant runs.
      for (const pid of new Set([...own, ...ownFiles.map(pidAt)])) if (pid) proc.endTree(pid);
    }
  });
}
