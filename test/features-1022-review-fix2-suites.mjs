// H.A.C round two: fixes for h4's review of h2 commit 3b486b0 and later reviews (F2d, F2e, F3a, F3b).
import { spawnSync } from 'node:child_process';

export default function reviewFix2Suites({ suite, check, core, TMP, ROOT, fs, path }) {
  suite('review fixes round two, F2d and F2e', 'exec, F2d: an empty = value exits 2; project numbers outside their range are refused', () => {
    const bin = path.join(ROOT, 'bin', 'atlias.mjs');
    const dir = path.join(TMP, 'review2-exec');
    fs.mkdirSync(dir, { recursive: true });
    const run = (args) => spawnSync(process.execPath, [bin, 'exec', ...args], { cwd: dir, encoding: 'utf8', env: process.env, timeout: 120000 });
    const emptyPerm = run(['hello', '--engine', 'echo', '--permissions=']);
    check('--permissions= with an empty value exits 2 and runs nothing', emptyPerm.status === 2 && /needs a value/.test(emptyPerm.stdout), { happened: `exit ${emptyPerm.status}; ${emptyPerm.stdout.slice(0, 120)}`, why: 'An empty value must not fall back to the default mode.', fix: 'Treat the = form with no value like a bare flag.' });
    const emptyFmt = run(['hello', '--engine', 'echo', '--output-format=']);
    check('--output-format= with an empty value exits 2', emptyFmt.status === 2, { happened: `exit ${emptyFmt.status}`, why: 'An empty format must not fall back to text.', fix: 'Same check as above.' });
    core.readProjectSettings(path.join(TMP, 'review2-none'));
    const before = core.config().agent.maxToolRounds;
    const zero = core.readProjectSettings(projectWith('zero', JSON.stringify({ agent: { maxToolRounds: 0, keepObservations: -1, notifyAfterSeconds: 1e9 } })));
    check('out-of-range numbers are refused, and the user value stays', core.config().agent.maxToolRounds === before && zero.refused.includes('agent.maxToolRounds') && zero.refused.includes('agent.keepObservations') && zero.refused.includes('agent.notifyAfterSeconds'), { happened: `rounds ${core.config().agent.maxToolRounds}; refused ${JSON.stringify(zero.refused)}`, why: 'Zero or negative rounds change how the loop ends; a huge timeout hides a stuck run.', fix: 'Use min and max in PROJECT_ALLOW.' });
    const inside = core.readProjectSettings(projectWith('inside', JSON.stringify({ agent: { maxToolRounds: 12 } })));
    check('an in-range number still applies', core.config().agent.maxToolRounds === 12 && inside.applied.includes('agent.maxToolRounds'), { happened: `rounds ${core.config().agent.maxToolRounds}`, why: 'Range limits must not refuse ordinary values.', fix: 'Check the min and max comparison.' });
    core.readProjectSettings(path.join(TMP, 'review2-none'));
  });

  function projectWith(name, text) {
    const d = path.join(TMP, 'review2-' + name);
    fs.mkdirSync(path.join(d, '.atlias'), { recursive: true });
    fs.writeFileSync(path.join(d, '.atlias', 'settings.json'), text);
    return d;
  }
}
