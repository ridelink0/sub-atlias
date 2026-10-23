// H.A.C council round two (2026-10-22, h2), feature 5 with fixes B1 and B2 (lib/background.mjs). Short commands run
// with the node binary; no network and no model. Every job here stops by itself or is killed by this suite.
import fs from 'node:fs';
import path from 'node:path';
import * as bg from '../lib/background.mjs';

export default async function backgroundSuites({ asyncSuite, check, TMP, ROOT }) {
  // Tests never end a process by PID: these jobs are stopped through their own handle.
  const shellOnly = (pid, child) => child.kill();
  const dir = path.join(TMP, 'bg-session');
  const node = `"${process.execPath}"`;
  const sleep30 = `${node} -e "setTimeout(() => {}, 30000)"`;
  await asyncSuite('background shell expert', 'background shell: the id and the output file come back at once, and poll reports the finished job', async () => {
    const started = bg.start(`${node} -e "console.log('bg-done')"`, { cwd: ROOT, dir, treeStop: shellOnly });
    check('start returns an id and a file under the session folder before the command ends', typeof started === 'object' && started.id && started.file.startsWith(dir) && fs.existsSync(started.file), { happened: JSON.stringify(started), why: 'The tool must not hold the loop while the command runs.', fix: 'Check start in lib/background.mjs.' });
    await bg.waitFor(started.id);
    const shown = bg.poll(started.id);
    check('poll shows the exit code and the output', /exited 0/.test(shown) && shown.includes('bg-done'), { happened: shown, why: 'The model must learn that the job ended and what it printed.', fix: 'Check poll.' });
    check('an unknown id is refused, not guessed', /no job nope/.test(bg.poll('nope')) && /no job nope/.test(bg.kill('nope')), { happened: bg.poll('nope'), why: 'A wrong id must not show or stop another job.', fix: 'Look up the id exactly.' });
    check('an empty command is refused', /give a command/.test(bg.start('   ', { cwd: ROOT, dir, treeStop: shellOnly })), { happened: bg.start('   ', { cwd: ROOT, dir, treeStop: shellOnly }), why: 'Nothing to run means nothing to start.', fix: 'Check the empty test in start.' });
  });
  await asyncSuite('background shell expert', 'background shell: poll returns the last 4,000 characters of a long output, and a spawn that fails is reported', async () => {
    const started = bg.start(`${node} -e "process.stdout.write('a'.repeat(9000) + 'END-MARK')"`, { cwd: ROOT, dir, treeStop: shellOnly });
    await bg.waitFor(started.id);
    const shown = bg.poll(started.id);
    const body = shown.split('\n').slice(1, -1).join('\n');
    check('the last 4,000 characters are shown and they end with the output\'s end', body.length >= 3900 && body.length <= 4000 && body.endsWith('END-MARK') && /9008 bytes/.test(shown), { happened: `body ${body.length} characters; ${shown.slice(-40)}`, why: 'A poll must not flood the context; the end of a log is usually what matters.', fix: 'Check POLL_CHARS in poll.' });
    const failing = bg.start('anything', { cwd: ROOT, dir, treeStop: shellOnly, spawnImpl: () => { throw new Error('no shell here'); } });
    check('a command that cannot start is reported', /could not start: no shell here/.test(failing), { happened: String(failing), why: 'A failed start must say so, not look like a running job.', fix: 'Check the try around spawnImpl.' });
  });
  await asyncSuite('background shell expert', 'background shell, B1: a command the guard refuses is never started, and no job is counted', async () => {
    const before = bg.running();
    const refused = bg.start(`${node} -e "1"`, { cwd: ROOT, dir, treeStop: shellOnly, gate: () => 'it deletes everything under the project' });
    check('a refused command is not started and says why', /refused: it deletes everything/.test(refused) && bg.running() === before, { happened: `${refused} | running ${bg.running()} (was ${before})`, why: 'A background job has no one to confirm it; the guard decides, before anything runs.', fix: 'Check the gate call at the top of start.' });
  });
  await asyncSuite('background shell expert', 'background shell, B2: at most four jobs run at once; kill stops a job; the time limit and the output cap stop a job', async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(bg.start(sleep30, { cwd: ROOT, dir, treeStop: shellOnly }).id);
    const fifth = bg.start(sleep30, { cwd: ROOT, dir, treeStop: shellOnly });
    check('a fifth job is refused while four run', /4 jobs are already running/.test(fifth), { happened: String(fifth).slice(0, 120), why: 'Unbounded jobs fill the process table and the disk.', fix: 'Check maxRunning in start.' });
    const reply = bg.kill(ids[0]);
    check('kill sends the stop from the job handle', /stop sent/.test(reply), { happened: reply, why: 'A job that cannot be stopped holds the machine.', fix: 'Call child.kill in kill.' });
    await bg.waitFor(ids[0]);
    check('after kill, poll reports it stopped by request', /stopped \(killed by request\)/.test(bg.poll(ids[0])), { happened: bg.poll(ids[0]).slice(0, 80), why: 'The model must see that the job was stopped, not that it exited.', fix: 'Check the status in poll.' });
    for (const id of ids.slice(1)) bg.kill(id);
    await Promise.all(ids.slice(1).map((id) => bg.waitFor(id)));
    check('the slots come back when jobs end', bg.running() === 0 && /exited|stopped/.test(bg.poll(ids[1])), { happened: `running ${bg.running()}`, why: 'Finished jobs must not hold a slot.', fix: 'running() counts jobs without an exit.' });
    check('killing a finished job says so', /already finished/.test(bg.kill(ids[1])), { happened: bg.kill(ids[1]), why: 'A stop sent to a finished job must not look like it did something.', fix: 'Check job.exit in kill.' });
    const timed = bg.start(sleep30, { cwd: ROOT, dir, treeStop: shellOnly, wallMs: 300 });
    await bg.waitFor(timed.id);
    check('the time limit stops a job and says so', /stopped \(time limit of 0\.3 s reached\)/.test(bg.poll(timed.id)), { happened: bg.poll(timed.id).slice(0, 90), why: 'A runaway job must end without anyone asking.', fix: 'Check the wall timer in start.' });
    const capped = bg.start(`${node} -e "let n=0;const t=setInterval(()=>{process.stdout.write('z'.repeat(200));if(++n>2000){clearInterval(t)}},2)"`, { cwd: ROOT, dir, treeStop: shellOnly, logCap: 3000, watchMs: 50 });
    await bg.waitFor(capped.id);
    check('the output cap stops a job that writes without end', /stopped \(output cap of 3000 bytes reached\)/.test(bg.poll(capped.id)), { happened: bg.poll(capped.id).slice(0, 90), why: 'A job that writes forever fills the disk.', fix: 'Check the watch interval in start.' });
  });
}
