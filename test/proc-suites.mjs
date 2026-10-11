// Code that never stops, stopped. Every check here starts a real process that
// would run for a minute or for ever, and then looks, by pid, at whether it and
// what it started are really gone - not at whether a function returned.
//
// The case behind it: on 2026-09-26 a model-written make_palindrome that never
// returned was run by the eval check and by the agent's shell tool. spawnSync's
// timeout ended only the shell, three pythons held a core each for hours, and an
// orphaned runner kept starting more.
//
// Loaded by test/run.mjs, which owns suite(), asyncSuite() and check().
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as proc from '../lib/proc.mjs';
import * as evals from '../lib/eval.mjs';
import * as agentMod from '../lib/agent.mjs';
import * as poly from '../lib/polyglot.mjs';

export default async function procSuites({ asyncSuite, check, skip, TMP, ROOT, fs, path }) {
  const W = path.join(TMP, 'proc-work');
  fs.mkdirSync(W, { recursive: true });
  const NL = String.fromCharCode(10);
  const win = process.platform === 'win32';
  const node = JSON.stringify(process.execPath);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const readPid = (f) => { try { return Number(fs.readFileSync(f, 'utf8')) || 0; } catch { return 0; } };
  // Waits for a pid to go, up to a limit: the OS reaps a killed process a
  // moment after the kill returns.
  const goneWithin = async (pid, ms) => { const end = Date.now() + ms; while (pid && alive(pid) && Date.now() < end) await sleep(100); return pid > 0 && !alive(pid); };
  const waitFor = async (f, ms) => { const end = Date.now() + ms; while (!readPid(f) && Date.now() < end) await sleep(100); return readPid(f); };
  let n = 0;
  const pidFile = () => path.join(W, `pid-${++n}.txt`);
  // A node program that writes its pid and then idles for a minute, started
  // from JavaScript source so no shell quoting differs between platforms.
  const idler = (file) => `${node} -e "require('fs').writeFileSync(${JSON.stringify(file).replace(/"/g, "'")}, String(process.pid)); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000)"`;

  await asyncSuite('process tree expert', 'code that never stops is stopped with everything it started', async () => {
    // 1. The eval check itself, on a candidate that loops for ever and has
    // started a helper process of its own, as python's multiprocessing would.
    const helperPid = pidFile();
    const task = {
      id: 'proc-selftest-loop',
      files: {
        'solution.js': [
          "const { spawn } = require('child_process');",
          `spawn(process.execPath, ['-e', ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(helperPid)}, String(process.pid)); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000)`)}], { stdio: 'ignore' });`,
          'module.exports = function isSimplePower() { for (;;) { /* the bug: never returns */ } };',
        ].join(NL),
        'check.js': "const f = require('./solution.js'); process.exit(f() === true ? 0 : 1);" + NL,
      },
      check: ['node', 'check.js'],
      timeoutMs: 5000,
    };
    const dir = evals.makeWorkspace(task, 'proc');
    const t0 = Date.now();
    const verdict = evals.score(dir, task);
    const took = Date.now() - t0;
    const helper = await waitFor(helperPid, 1000);
    const helperGone = await goneWithin(helper, 8000);
    check('an infinite loop in the graded code fails at its limit, and says it was stopped', !verdict.pass && verdict.timedOut === true && /past its 5 s limit/.test(verdict.why) && took < 30000,
      { happened: `${took} ms: ${verdict.why}`, why: 'A check that waits for ever wedges the whole run; a check that says only "exited 1" hides that the code never returned.', fix: 'score() runs the check through proc.runSync with the task limit.' });
    check('and the process the candidate started is gone too, not left holding a core', helper > 0 && helperGone,
      { happened: `helper pid ${helper}, alive=${helper ? alive(helper) : 'never started'}`, why: 'Ending only the program the check named is what left three pythons spinning for hours on 2026-09-26.', fix: 'The watchdog ends the tree: taskkill /T on Windows, the process group elsewhere.' });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }

    // 2. The same through a shell, synchronously and not.
    const viaShell = pidFile();
    const s0 = Date.now();
    const sync = proc.runSync(idler(viaShell), [], { shell: true, timeoutMs: 1500 });
    const shellChild = await waitFor(viaShell, 1000);
    check('runSync stops a command under a shell, and the program under the shell with it', sync.timedOut === true && sync.status === null && sync.error && sync.error.code === 'ETIMEDOUT' && shellChild > 0 && await goneWithin(shellChild, 8000) && Date.now() - s0 < 30000,
      { happened: JSON.stringify({ ...sync, error: sync.error && sync.error.message, grandchild: shellChild, alive: shellChild ? alive(shellChild) : null }), why: 'Under a shell the program is a grandchild, which is exactly what a plain timeout orphans.', fix: 'Check lib/watchdog.mjs endTree.' });
    const viaAsync = pidFile();
    const a = await proc.runAsync(idler(viaAsync), [], { shell: true, timeoutMs: 1500 });
    const asyncChild = await waitFor(viaAsync, 1000);
    check('runAsync does the same without blocking', a.timedOut === true && asyncChild > 0 && await goneWithin(asyncChild, 8000),
      { happened: JSON.stringify({ ...a, error: a.error && a.error.message, grandchild: asyncChild }), why: 'The agent\'s shell tool uses this one.', fix: 'Check proc.runAsync.' });
    const quick = await proc.runAsync(`${node} -e "process.stdout.write('o'); process.stderr.write('e'); process.exit(3)"`, [], { shell: true, timeoutMs: 30000 });
    const nothing = proc.runSync('definitely-not-a-program-xyz', [], { timeoutMs: 20000 });
    check('a command that finishes keeps its own exit status, output and error, and one that cannot start says so', quick.status === 3 && quick.stdout === 'o' && quick.stderr === 'e' && !quick.timedOut && !quick.error && nothing.status === null && /ENOENT|not recognized|cannot find/i.test(String(nothing.error && nothing.error.message)),
      { happened: JSON.stringify({ quick: { ...quick, error: quick.error && quick.error.message }, nothing: { ...nothing, error: nothing.error && nothing.error.message } }), why: 'Everything downstream (the integrity verdict, the score) reads status and output as spawnSync gave them.', fix: 'Keep spawnSync\'s result shape in proc.' });

    // 2b. A loop that prints for ever. The caller's buffer would overflow, and a
    // spawnSync that overflows ends the watchdog alone, which would orphan the
    // printer; the watchdog caps what it passes on instead.
    const spewPid = pidFile();
    // Synchronous writes: process.stdout.write to a pipe is asynchronous on
    // POSIX, and a loop that never yields would queue its output in memory
    // instead of sending it (CI's Linux and macOS jobs saw 8 KB to 300 KB).
    // EAGAIN from a full pipe is retried, as a printer that never stops would.
    const spew = `${node} -e "const fs = require('fs'); fs.writeFileSync(${JSON.stringify(spewPid).replace(/"/g, "'")}, String(process.pid)); const s = 'x'.repeat(65536); for (;;) { try { fs.writeSync(1, s); } catch (e) { /* EAGAIN: try again */ } }"`;
    const sp = proc.runSync(spew, [], { shell: true, timeoutMs: 3000, maxBuffer: 1024 * 1024 });
    const printer = await waitFor(spewPid, 1000);
    check('a command that prints for ever is capped, stopped at its limit, and gone', sp.timedOut === true && sp.stdout.length <= 1024 * 1024 && /output past \d+ bytes was dropped/.test(sp.stdout) && printer > 0 && await goneWithin(printer, 8000),
      { happened: JSON.stringify({ timedOut: sp.timedOut, bytes: sp.stdout.length, tail: sp.stdout.slice(-80), error: sp.error && sp.error.code, printer, alive: printer ? alive(printer) : null }), why: 'An overflowed buffer ends the watchdog before the tree, and the printer runs on with nobody to stop it.', fix: 'The watchdog passes on at most maxOutput bytes per stream and drops the rest.' });

    // 3. The asking process dies while its command runs. On Windows nothing
    // ends a child with its parent; the watchdog has to notice.
    const orphanPid = pidFile();
    const parentFile = path.join(W, 'parent.mjs');
    fs.writeFileSync(parentFile, [
      `import * as proc from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'lib', 'proc.mjs')).href)};`,
      `proc.runAsync(${JSON.stringify(idler(orphanPid))}, [], { shell: true, timeoutMs: 120000 });`,
      'setInterval(() => {}, 1000);',
    ].join(NL));
    const parent = spawn(process.execPath, [parentFile], { stdio: 'ignore', windowsHide: true });
    const started = await waitFor(orphanPid, 20000);
    try { parent.kill('SIGKILL'); } catch { /* already gone */ }
    const orphanGone = await goneWithin(started, 10000);
    check('when the process that asked for a command is killed, the command is ended within seconds, not left running', started > 0 && orphanGone,
      { happened: `command pid ${started}, alive=${started ? alive(started) : 'never started'} after the parent was killed`, why: 'An orphaned runner is how the 2026-09-26 processes kept coming back after the agent that started them was gone.', fix: 'The watchdog checks its parent every second and ends the tree when it is gone.' });

    // 4. A command that returns but leaves something running behind it.
    const leftPid = pidFile();
    const bg = win
      ? `start "" /b ${idler(leftPid)}`
      : `${idler(leftPid)} &`;
    const since = Date.now();
    const b0 = Date.now();
    const bgRun = await proc.runAsync(bg, [], { shell: true, timeoutMs: 30000 });
    const bgTook = Date.now() - b0;
    const left = await waitFor(leftPid, 10000);
    check('a command that backgrounds a program returns without waiting on it', !bgRun.timedOut && bgTook < 15000,
      { happened: `${bgTook} ms, ${JSON.stringify({ ...bgRun, error: bgRun.error && bgRun.error.message })}`, why: 'The background program holds the output pipe; waiting for the pipe to close would wait the whole limit.', fix: 'The watchdog lets the pipes go a second after the command exits.' });
    const found = proc.leftovers([bgRun.pid], { since, kill: true });
    const leftGone = await goneWithin(left, 10000);
    check('leftovers finds what it left running and ends it', left > 0 && Array.isArray(found) && found.length >= 1 && leftGone,
      { happened: JSON.stringify({ left, found, alive: left ? alive(left) : null }), why: 'Inside an eval nothing a task started may outlive it, and a backgrounded loop is outside the tree the timeout ends.', fix: 'Check proc.leftovers.' });
    check('and asks nothing of a command that left nothing', (() => { const again = proc.leftovers([bgRun.pid], { since }); return Array.isArray(again) && again.length === 0; })() && proc.leftovers([], {}).length === 0,
      { happened: JSON.stringify(proc.leftovers([bgRun.pid], { since })), why: 'A leftover report that is never empty is noise.', fix: 'Check proc.leftovers.' });

    // 5. The Windows listing logic, on a made-up process table: a pid Windows
    // has given to a newcomer must not make the newcomer's children ours.
    const now = 1000000;
    const table = [
      { pid: 50, ppid: 10, created: now + 100 },   // ours: left by pid 10, which is dead
      { pid: 51, ppid: 50, created: now + 200 },   // its child
      { pid: 60, ppid: 11, created: now + 500 },   // 11 was ours, but 11 is alive again, newer:
      { pid: 11, ppid: 1, created: now + 400 },    //   a newcomer holds the pid
      { pid: 61, ppid: 11, created: now + 300 },   // created before the newcomer: ours
      { pid: 70, ppid: 10, created: now - 5000 },  // older than the task: never ours
    ];
    const logic = proc.leftovers([10, 11], { since: now, list: () => table });
    check('a reused pid is told apart by creation time, and nothing older than the task is touched', JSON.stringify(logic.sort((x, y) => x - y)) === JSON.stringify([50, 51, 61]),
      { happened: JSON.stringify(logic), why: 'Ending a process because its parent pid matched a number is ending somebody else\'s program.', fix: 'leftovers walks by creation time, and stops at the newcomer.' });
    const table2 = proc.listProcesses();
    check('the process listing is real on Windows and absent elsewhere', win ? Array.isArray(table2) && table2.some((r) => r.pid === process.pid && r.ppid > 0 && r.created > 0) : table2 === null,
      { happened: JSON.stringify(table2 ? table2.filter((r) => r.pid === process.pid) : table2), why: 'The leftover search on Windows stands on this listing.', fix: 'Check listProcesses.' });

    // 6. endTree, on a process this test started and nothing else.
    const mine = pidFile();
    const own = spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(mine)}, String(process.pid)); setInterval(() => {}, 1000)`], { stdio: 'ignore', windowsHide: true, detached: !win });
    const ownPid = await waitFor(mine, 20000);
    proc.endTree(own.pid);
    check('endTree ends a tree this harness started', ownPid > 0 && await goneWithin(ownPid, 8000),
      { happened: `pid ${ownPid} alive=${ownPid ? alive(ownPid) : null}`, why: 'It is the one call every stop path ends in.', fix: 'Check proc.endTree.' });
  });

  await asyncSuite('process tree expert', 'an eval task ends what its commands left running', async () => {
    const FENCE = '`'.repeat(3);
    const blk = (o) => FENCE + 'atlias' + NL + JSON.stringify(o) + NL + FENCE;
    const scripted = (replies) => { let i = 0; return async () => ({ content: replies[Math.min(i++, replies.length - 1)] }); };
    const leftPid = pidFile();
    const bg = win ? `start "" /b ${idler(leftPid)}` : `${idler(leftPid)} &`;
    const r = await evals.runTask({ id: 'proc-selftest-bg', files: { 'ok.js': 'process.exit(0);' + NL }, check: ['node', 'ok.js'], prompt: 'start it' }, {
      state: agentMod.newState(W, 'echo'),
      reap: true,
      chat: scripted([blk({ tool: 'shell', command: bg }), 'Started.']),
    });
    const left = await waitFor(leftPid, 5000);
    check('the task reports the process its command left behind, and it is gone', r.leftovers >= 1 && left > 0 && await goneWithin(left, 10000),
      { happened: JSON.stringify({ leftovers: r.leftovers, left, alive: left ? alive(left) : null, why: r.why }), why: 'The next task must not share the machine with this one\'s background loop.', fix: 'runTask collects the shell pids (state.childPids) and ends their leftovers after scoring.' });
    try { if (r.workspace) fs.rmSync(r.workspace, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  await asyncSuite('process tree expert', 'the mini-swe-agent head-to-head runner ends its trees too', async () => {
    // tools/h2h/mini_swe_runner.py drives the other arm of the comparison. Its
    // tree helpers import nothing from mini-swe-agent, so they are checked here
    // with a plain interpreter.
    const py = poly.resolveRunner('python', { bare: true });
    if (!py.ok) { skip('the head-to-head runner ends a looping action as a tree', `no Python interpreter answers here (${py.why})`); return; }
    const runner = path.join(ROOT, 'tools', 'h2h', 'mini_swe_runner.py');
    // Importing the runner must not leave a __pycache__ folder in the repository.
    process.env.PYTHONDONTWRITEBYTECODE = '1';
    const gc = pidFile();
    const driver = path.join(W, 'drive_runner.py');
    fs.writeFileSync(driver, [
      'import importlib.util, json, sys, time',
      `spec = importlib.util.spec_from_file_location("r", ${JSON.stringify(runner)})`,
      'r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)',
      `child = ${JSON.stringify(path.join(W, 'loop_child.py'))}`,
      't = time.time()',
      'rc, timed_out = r.run_tree([sys.executable, child], timeout=3)',
      'print(json.dumps({"rc": rc, "timedOut": timed_out, "s": round(time.time() - t, 1), "live": len(r.LIVE)}))',
    ].join(NL));
    fs.writeFileSync(path.join(W, 'gc.py'), `import os, time${NL}open(${JSON.stringify(gc)}, "w").write(str(os.getpid()))${NL}time.sleep(60)${NL}`);
    fs.writeFileSync(path.join(W, 'loop_child.py'), `import subprocess, sys${NL}subprocess.Popen([sys.executable, ${JSON.stringify(path.join(W, 'gc.py'))}])${NL}while True:${NL}    pass${NL}`);
    const out = proc.runSync(py.exe, [driver], { timeoutMs: 90000 });
    let got = {};
    try { got = JSON.parse(String(out.stdout).trim().split(NL).pop()); } catch { got = { raw: out.stdout, err: out.stderr }; }
    const grand = readPid(gc);
    check('a looping action is stopped at its limit, and the process it started is gone', got.timedOut === true && got.rc === -1 && got.live === 0 && grand > 0 && await goneWithin(grand, 8000),
      { happened: JSON.stringify({ got, grand, alive: grand ? alive(grand) : null }), why: 'The old driver ended only bash at its timeout; what bash had started ran on.', fix: 'run_tree starts a session of its own (POSIX) and ends it with taskkill /T or killpg.' });

    // The runner dies with its parent. On Windows the runner is started outside
    // the intermediate's job object, as bash starts it in the real harness.
    const idle = pidFile();
    const pyDriver = path.join(W, 'orphan_runner.py');
    fs.writeFileSync(pyDriver, [
      'import importlib.util, sys',
      `spec = importlib.util.spec_from_file_location("r", ${JSON.stringify(runner)})`,
      'r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)',
      'r.watch_parent(interval=0.5)',
      `r.run_tree([sys.executable, "-c", "import os, time; open(" + repr(${JSON.stringify(idle)}) + ", 'w').write(str(os.getpid())); time.sleep(120)"], timeout=120)`,
    ].join(NL));
    const middle = path.join(W, 'middle.mjs');
    fs.writeFileSync(middle, `import { spawn } from 'node:child_process';\nspawn(${JSON.stringify(py.exe)}, [${JSON.stringify(pyDriver)}], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' });\nsetInterval(() => {}, 1000);\n`);
    const mid = spawn(process.execPath, [middle], { stdio: 'ignore', windowsHide: true });
    const idlePid = await waitFor(idle, 30000);
    try { mid.kill('SIGKILL'); } catch { /* gone */ }
    check('when whatever started the runner is gone, the runner ends its trees and itself', idlePid > 0 && await goneWithin(idlePid, 10000),
      { happened: `action pid ${idlePid}, alive=${idlePid ? alive(idlePid) : 'never started'}`, why: 'An orphaned runner kept starting tasks for hours on 2026-09-26.', fix: 'watch_parent ends every live tree and exits when the parent is gone.' });
  });

  await asyncSuite('process tree expert', 'a command that takes too much memory is stopped, and only when a limit is given', async () => {
    if (!win) { skip('memory limit on a command', 'the limit is enforced on Windows only; nothing here measures a process tree elsewhere'); return; }
    // A node program that takes 32 MiB ten times a second up to a ceiling, holds
    // it, and exits 0 by itself: memory that is written to, as a model-written
    // list over an endless iterator is (2026-10-11, 8 GB inside two minutes).
    const hog = (mb, holdMs, file) => `${node} -e "${file ? `require('fs').writeFileSync(${JSON.stringify(file).replace(/"/g, "'")}, String(process.pid)); ` : ''}const a=[]; const t=setInterval(() => { if (a.length*32 < ${mb}) a.push(Buffer.alloc(32*1024*1024, 1)); }, 100); setTimeout(() => { clearInterval(t); process.exit(0); }, ${holdMs})"`;
    const brief = (r) => JSON.stringify({ status: r.status, overMemory: r.overMemory, timedOut: r.timedOut, code: r.error && r.error.code, error: r.error && r.error.message });

    const overPid = pidFile();
    const t0 = Date.now();
    // Generous clocks: on a PC busy with a benchmark and this whole suite the
    // helper's first reading took 50 s once. What is checked is that memory
    // stopped it, not the time limit; the program holds on longer than that limit.
    const over = await proc.runAsync(hog(640, 300000, overPid), [], { shell: true, timeoutMs: 240000, memoryMB: 300 });
    const took = Date.now() - t0;
    const overChild = readPid(overPid);
    check('a command holding 640 MiB against a 300 MiB limit is stopped before its time limit, and the result says memory', over.overMemory === true && over.timedOut === false && over.status === null && over.error && over.error.code === 'EMEMORY' && /held more than 300 MiB/.test(over.error.message) && took < 200000,
      { happened: `${took} ms: ${brief(over)}`, why: 'Inside its time limit a model-written memory bomb took 8 GB twice and the PC ran out of committed memory; programs that had nothing to do with the run ended.', fix: 'lib/watchdog.mjs watchMemory, started by a memoryMB in the spec.' });
    check('and the program under the shell is gone, not left holding the memory', overChild > 0 && await goneWithin(overChild, 8000),
      { happened: `program pid ${overChild}, alive=${overChild ? alive(overChild) : 'never started'}`, why: 'Ending only the shell would leave the memory held.', fix: 'watchMemory ends the tree with endTree, as the time limit does.' });

    // The memory is held by a process the command started, not by the command.
    const kidPid = pidFile();
    const parent = path.join(W, 'memory-parent.js');
    fs.writeFileSync(parent, [
      "const { spawn } = require('child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(kidPid)}, String(process.pid)); const a=[]; const t=setInterval(() => { if (a.length*32 < 640) a.push(Buffer.alloc(32*1024*1024, 1)); }, 100); setTimeout(() => process.exit(0), 300000)`)}], { stdio: 'ignore' });`,
      'setTimeout(() => process.exit(0), 300000);',
    ].join(NL));
    const tree = await proc.runAsync(process.execPath, [parent], { timeoutMs: 240000, memoryMB: 300 });
    const kid = readPid(kidPid);
    check('memory held by a process the command started counts against the command', tree.overMemory === true && tree.status === null && kid > 0 && await goneWithin(kid, 8000),
      { happened: `${brief(tree)}; child pid ${kid}, alive=${kid ? alive(kid) : 'never started'}`, why: 'A test runner holds little itself; the program it starts is what grows.', fix: 'The helper adds up the whole tree under the command, not the command alone.' });

    const under = await proc.runAsync(hog(96, 7000), [], { shell: true, timeoutMs: 90000, memoryMB: 2000 });
    check('a command under its limit runs to its own end', under.status === 0 && under.overMemory === false && !under.error,
      { happened: brief(under), why: 'A limit that stops ordinary commands is worse than none.', fix: 'Compare the tree against memoryMB in MiB (the listing counts in KB).' });

    const none = await proc.runAsync(hog(640, 6000), [], { shell: true, timeoutMs: 90000 });
    check('with no limit given nothing is measured and nothing is stopped for memory', none.status === 0 && none.overMemory === false && !none.error,
      { happened: brief(none), why: 'A build can rightly hold several GB: the limit is for benchmark runs, which ask for it.', fix: 'memoryLimit() returns 0 unless a limit is given or ATLIAS_COMMAND_MEMORY_MB is set.' });

    const q0 = Date.now();
    const quick = proc.runSync(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 60000, memoryMB: 300 });
    const quickMs = Date.now() - q0;
    check('a command that ends at once never waits for the measuring to start', quick.status === 0 && quick.overMemory === false && quickMs < 2500,
      { happened: `${quickMs} ms: ${brief(quick)}`, why: 'Measuring starts three seconds in; a watchdog that waited for that would add three seconds to every command of a run.', fix: 'finish() clears the timer that starts watchMemory.' });

    const before = process.env.ATLIAS_COMMAND_MEMORY_MB;
    let fromRun, given;
    try {
      process.env.ATLIAS_COMMAND_MEMORY_MB = '300';
      fromRun = proc.runSync(process.execPath, ['-e', 'const a=[]; const t=setInterval(() => { if (a.length*32 < 640) a.push(Buffer.alloc(32*1024*1024, 1)); }, 100); setTimeout(() => process.exit(0), 300000)'], { timeoutMs: 240000 });
      // A limit given for one command wins over the one set for the run.
      given = proc.runSync(process.execPath, ['-e', 'const a=[]; const t=setInterval(() => { if (a.length*32 < 640) a.push(Buffer.alloc(32*1024*1024, 1)); }, 100); setTimeout(() => process.exit(0), 6000)'], { timeoutMs: 90000, memoryMB: 4000 });
    } finally { if (before === undefined) delete process.env.ATLIAS_COMMAND_MEMORY_MB; else process.env.ATLIAS_COMMAND_MEMORY_MB = before; }
    check('ATLIAS_COMMAND_MEMORY_MB sets the limit for every command of a run, synchronous ones too', fromRun.overMemory === true && fromRun.status === null && /held more than 300 MiB/.test(fromRun.error.message),
      { happened: brief(fromRun), why: 'The evolution loop sets one variable for a whole benchmark run; the check that scores a task is synchronous.', fix: 'runSync and runAsync both pass memoryLimit() to the watchdog.' });
    check('and a limit given for one command wins over it', given.status === 0 && given.overMemory === false,
      { happened: brief(given), why: 'A caller that knows its command needs more must be able to say so.', fix: 'memoryLimit(given) reads the variable only when nothing is given.' });

    const junk = [-5, 0, 0.4, NaN, Infinity, 'much', '', {}, []].map((x) => proc.memoryLimit(x));
    const kept = [1, 300, '300', 4096.9].map((x) => proc.memoryLimit(x));
    check('a limit that is not a positive number is no limit', junk.every((x) => x === 0) && JSON.stringify(kept) === '[1,300,300,4096]',
      { happened: JSON.stringify({ junk, kept }), why: 'A mistyped variable must not stop every command at once, and must not pass NaN to the watchdog.', fix: 'memoryLimit() returns a whole number of MiB, or 0.' });
  });

  await asyncSuite('command line expert', 'help runs nothing, and an eval stops when whatever started it is gone', async () => {
    const bin = path.join(ROOT, 'bin', 'atlias.mjs');
    // A dead port: if --help reached the engine, the run would say so here.
    const env = { ATLIAS_HOME: path.join(W, 'cli-home'), ATLIAS_EVAL_DIR: path.join(W, 'cli-evals') };
    const h = proc.runSync(process.execPath, [bin, 'eval', '--help'], { timeoutMs: 60000, env });
    check('atlias eval --help prints the eval usage, exits 0, and starts no eval', h.status === 0 && /usage: atlias eval/.test(h.stdout) && /--outlive-parent/.test(h.stdout) && !/task\(s\) against/.test(h.stdout) && !fs.existsSync(path.join(W, 'cli-evals')),
      { happened: `${h.status}: ${String(h.stdout).slice(0, 200)}`, why: 'The judge typed it and got a real nine-task eval on the default model, with five workspaces left behind.', fix: 'bin/atlias.mjs answers --help and -h before the command runs.' });
    const e = proc.runSync(process.execPath, [bin, 'compare', '-h'], { timeoutMs: 60000, env });
    check('and -h after another command prints that command\'s usage', e.status === 0 && /usage: atlias compare/.test(e.stdout), { happened: `${e.status}: ${e.stdout}`, why: 'Every command, not only eval.', fix: 'Add it to HELP.' });

    // A corpus that keeps an eval busy for minutes with a model that does
    // nothing: many attempts at one quick task.
    const corpus = path.join(W, 'cli-corpus');
    fs.mkdirSync(corpus, { recursive: true });
    fs.writeFileSync(path.join(corpus, 'one.json'), JSON.stringify({ id: 'cli-one', prompt: 'nothing', files: { 'x.js': 'process.exit(1);' + NL }, check: ['node', 'x.js'] }));
    const pidOut = path.join(W, 'eval.pid');
    const middle = path.join(W, 'eval-middle.mjs');
    fs.writeFileSync(middle, [
      "import { spawn } from 'node:child_process';",
      "import fs from 'node:fs';",
      `const c = spawn(process.execPath, [${JSON.stringify(bin)}, 'eval', '--corpus', ${JSON.stringify(corpus)}, '--engine', 'echo', '--repeat', '500'], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32', env: { ...process.env, ATLIAS_HOME: ${JSON.stringify(path.join(W, 'cli-home'))} } });`,
      `fs.writeFileSync(${JSON.stringify(pidOut)}, String(c.pid));`,
      'setInterval(() => {}, 1000);',
    ].join(NL));
    const mid = spawn(process.execPath, [middle], { stdio: 'ignore', windowsHide: true });
    const evalPid = await waitFor(pidOut, 20000);
    await sleep(4000);
    const wasRunning = evalPid > 0 && alive(evalPid);
    try { mid.kill('SIGKILL'); } catch { /* gone */ }
    const stopped = await goneWithin(evalPid, 20000);
    check('an eval whose starter is killed stops by itself instead of running on for hours', wasRunning && stopped,
      { happened: `eval pid ${evalPid}, running before=${wasRunning}, alive after=${evalPid ? alive(evalPid) : null}`, why: 'The orphaned head-to-head runner kept starting tasks for hours on 2026-09-26.', fix: 'atlias eval checks its parent every two seconds unless --outlive-parent is given.' });
    if (evalPid && alive(evalPid)) proc.endTree(evalPid);
  });
}
