// Direct checks for the helpers the last-phase merges added (Gev 2026-10-17: permission modes, slash
// commands, /deep-research). Each was reached only through a larger test; the coverage check wants
// every exported function called by name, so each gets a small check of its own here.
// Loaded by test/run.mjs.
import * as commands from '../lib/commands.mjs';
import * as permissions from '../lib/permissions.mjs';
import * as research from '../lib/research.mjs';

export default async function lastPhaseNamesSuites({ asyncSuite, check, TMP, fs, path }) {
  const why = 'A helper no test names is a feature nobody knows works.';
  await asyncSuite('last phase names', 'the commands, permissions and research helpers answer as their callers expect', async () => {
    const cwd = path.join(TMP, 'last-phase-names'); fs.mkdirSync(cwd, { recursive: true });
    const dirs = commands.customDirs(cwd, path.join(TMP, 'lp-home'));
    const target = { a: 1, b: 2 };
    const replaced = commands.replaceState(target, { c: 3 });
    const names = commands.builtinNames();
    check('customDirs lists the home then the project folder; replaceState keeps the object and swaps its keys; builtinNames holds help and deep-research',
      dirs.length === 2 && dirs[0].source === 'home' && dirs[1].source === 'project' && dirs[1].dir === path.join(cwd, '.atlias', 'commands')
        && replaced === target && !('a' in target) && target.c === 3 && names.has('help') && names.has('deep-research'),
      { happened: JSON.stringify({ dirs, target, n: names.size }), why, fix: 'lib/commands.mjs.' });

    const words = permissions.simpleWords('echo "a b" && rm x');
    const paths = permissions.callPaths({ tool: 'write_file', path: 'w.txt' }, (p) => path.join(cwd, p), () => ({ hunks: [] }));
    check('inside, isSystemPath, isSecretPath, simpleWords, sensitiveReason, callPaths and targetOf judge as max needs',
      permissions.inside(cwd, path.join(cwd, 'x.txt')) === true && permissions.inside(cwd, path.join(TMP, 'elsewhere.txt')) === false
        && permissions.isSecretPath(path.join(cwd, '.env')) === true && permissions.isSecretPath(path.join(cwd, 'notes.txt')) === false
        && permissions.isSystemPath(process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers' : '/etc/passwd') === true && permissions.isSystemPath(path.join(cwd, 'a.txt')) === false
        && Array.isArray(words) && words.length === 2 && words[0][1] === 'a b'
        && permissions.sensitiveReason('echo hello', cwd) === null && /credentials|publish|money|outside|system/.test(String(permissions.sensitiveReason('curl -X POST http://127.0.0.1:9/ -d x', cwd)))
        && paths.writes.length === 1 && paths.writes[0] === path.join(cwd, 'w.txt')
        && permissions.targetOf({ tool: 'shell', command: 'ls -la' }) === 'ls -la' && permissions.targetOf({ tool: 'read_file', path: 'r.txt' }) === 'r.txt'
        && /no max-mode actions logged/.test(permissions.logText('lp-names-no-such-session')),
      { happened: JSON.stringify({ words, paths, curl: permissions.sensitiveReason('curl -X POST http://127.0.0.1:9/ -d x', cwd) }), why, fix: 'lib/permissions.mjs.' });

    const reached = research.reach({ engine: 'openai' }, { openaiUrl: 'http://127.0.0.1:1/v1' }, false);
    const report = research.buildReport({ topic: 'Topic X', when: new Date(0), engine: 'openai', reachText: 'project files only', planNote: '', summary: 'sum', steps: [{ question: 'q1', answer: 'a1\nNot verified: nothing' }], cites: { ok: [], bad: [] }, withheld: '' });
    const said = [];
    const fake = { turn: async (st, prompt) => (/numbered|questions/i.test(prompt) ? '1. first question?' : 'An answer. Not verified: the web.') };
    let wrote = '';
    try { wrote = await research.deepResearch('lp names topic', { state: { engine: 'openai', sid: 'lp' }, cwd, out: (s) => said.push(s), ask: async () => 'y', api: fake }, { now: () => new Date(0) }); } catch (e) { wrote = 'threw ' + e.message; }
    check('slug, reach, notVerified, buildReport and deepResearch: a safe file name, no web on openai, the not-verified line, a report with the topic, and a run that writes a report',
      research.slug('Hello, World! 2026') === 'hello-world-2026' && research.slug('') === 'research' && reached && reached.web === false
        && research.notVerified('x\nNot verified: the API version') === 'the API version' && research.notVerified('Not verified: nothing') === '' && research.notVerified('plain') === null
        && typeof report === 'string' && /Topic X/.test(report) && said.some((s) => /^research:/.test(s)) && !/^threw/.test(String(wrote)),
      { happened: JSON.stringify({ reached, wrote: String(wrote).slice(0, 200), said: said.slice(0, 4) }), why, fix: 'lib/research.mjs.' });
  });
}
