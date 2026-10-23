// H.A.C council round two (2026-10-22, h2), feature 5: background shell (lib/background.mjs). Short commands run
// with the node binary, so no network and no model are used. Nothing is killed by this suite.
import fs from 'node:fs';
import path from 'node:path';
import * as bg from '../lib/background.mjs';

export default async function backgroundSuites({ asyncSuite, check, TMP, ROOT }) {
  const dir = path.join(TMP, 'bg-session');
  const node = `"${process.execPath}"`;
  await asyncSuite('background shell expert', 'background shell: the id and the output file come back at once, and poll reports the finished job', async () => {
    const started = bg.start(`${node} -e "console.log('bg-done')"`, { cwd: ROOT, dir });
    check('start returns an id and a file under the session folder before the command ends', typeof started === 'object' && started.id && started.file.startsWith(dir) && fs.existsSync(started.file), { happened: JSON.stringify(started), why: 'The tool must not hold the loop while the command runs.', fix: 'Check start in lib/background.mjs.' });
    await bg.waitFor(started.id);
    const shown = bg.poll(started.id);
    check('poll shows the exit code and the output', /exited 0/.test(shown) && shown.includes('bg-done'), { happened: shown, why: 'The model must learn that the job ended and what it printed.', fix: 'Check poll.' });
    check('an unknown id is refused, not guessed', /no job nope/.test(bg.poll('nope')), { happened: bg.poll('nope'), why: 'A wrong id must not show another job.', fix: 'Look up the id exactly.' });
    check('an empty command is refused', /give a command/.test(bg.start('   ', { cwd: ROOT, dir })), { happened: bg.start('   ', { cwd: ROOT, dir }), why: 'Nothing to run means nothing to start.', fix: 'Check the empty test in start.' });
  });
  await asyncSuite('background shell expert', 'background shell: poll returns the last 4,000 characters of a long output, and a spawn that fails is reported', async () => {
    const started = bg.start(`${node} -e "process.stdout.write('a'.repeat(9000) + 'END-MARK')"`, { cwd: ROOT, dir });
    await bg.waitFor(started.id);
    const shown = bg.poll(started.id);
    const body = shown.split('\n').slice(1, -1).join('\n');
    check('the last 4,000 characters are shown and they end with the output\'s end', body.length >= 3900 && body.length <= 4000 && body.endsWith('END-MARK') && /9008 bytes/.test(shown), { happened: `body ${body.length} characters; ${shown.slice(-40)}`, why: 'A poll must not flood the context; the end of a log is usually what matters.', fix: 'Check POLL_CHARS in poll.' });
    const failing = bg.start('anything', { cwd: ROOT, dir, spawnImpl: () => { throw new Error('no shell here'); } });
    check('a command that cannot start is reported', /could not start: no shell here/.test(failing), { happened: String(failing), why: 'A failed start must say so, not look like a running job.', fix: 'Check the try around spawnImpl.' });
  });
}
