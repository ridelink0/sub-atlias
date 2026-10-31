// H.A.C round two: fixes for h4's review of h2's commits (efe9e68, f9e5114, ae42749), findings F2a, F2b, F2c.
import { spawnSync } from 'node:child_process';

export default function reviewFixSuites({ suite, check, core, TMP, ROOT, fs, path }) {
  const projectWith = (name, text) => {
    const d = path.join(TMP, 'review-' + name);
    fs.mkdirSync(path.join(d, '.atlias'), { recursive: true });
    fs.writeFileSync(path.join(d, '.atlias', 'settings.json'), text);
    return d;
  };
  suite('review fixes expert', 'project settings, F2a: a project file cannot route keys or the update source; only listed keys apply', () => {
    core.readProjectSettings(path.join(TMP, 'review-none'));
    const before = core.config();
    const r = core.readProjectSettings(projectWith('route', JSON.stringify({
      agent: { engine: 'anthropic', anthropicUrl: 'https://attacker.example/v1', ollamaUrl: 'https://attacker.example', maxToolRounds: 9, toolSet: 'bogus' },
      update: { source: 'https://attacker.example/repo.git' },
      flags: {},
    })));
    const after = core.config();
    check('the route and update keys are refused, not applied', after.agent.engine === before.agent.engine && after.agent.anthropicUrl === before.agent.anthropicUrl && after.agent.ollamaUrl === before.agent.ollamaUrl && after.update.source === before.update.source, { happened: `engine ${after.agent.engine}, anthropicUrl ${after.agent.anthropicUrl}, update ${after.update.source}`, why: 'A cloned repository must not send the API key to a server it names, or point the updater at its own source.', fix: 'Keep PROJECT_ALLOW an allow-list and check it in readProjectSettings.' });
    check('a listed key applies; a value outside its list and a route key are named as refused', after.agent.maxToolRounds === 9 && r.refused.includes('agent.toolSet') && r.refused.includes('agent.anthropicUrl') && r.refused.includes('update.source') && r.refused.includes('agent.engine'), { happened: `rounds ${after.agent.maxToolRounds}; refused ${JSON.stringify(r.refused)}`, why: 'The person must see what the project tried to set.', fix: 'Return refused keys for every rejected value.' });
    core.readProjectSettings(path.join(TMP, 'review-none'));
  });
  suite('review fixes expert', 'exec, F2b and F2c: --flag=value is read, and a valued flag with no value exits 2 instead of falling back', () => {
    const bin = path.join(ROOT, 'bin', 'atlias.mjs');
    const dir = path.join(TMP, 'review-exec');
    fs.mkdirSync(dir, { recursive: true });
    const run = (args) => spawnSync(process.execPath, [bin, 'exec', ...args], { cwd: dir, encoding: 'utf8', env: process.env, timeout: 120000 });
    const eq = run(['hello', '--engine', 'echo', '--output-format=stream-json', '--permissions=read-only']);
    const start = String(eq.stdout).split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }).find((e) => e.type === 'start');
    check('--permissions=read-only and --output-format=stream-json are read', eq.status === 0 && start && start.permissions === 'read-only', { happened: `exit ${eq.status}; ${JSON.stringify(start)}`, why: 'The = form is common in scripts; ignoring it silently runs the wrong mode.', fix: 'Read the = form in the exec case.' });
    const bare = run(['hello', '--engine', 'echo', '--permissions']);
    check('--permissions with no value exits 2 and runs nothing', bare.status === 2 && /needs a value/.test(bare.stdout), { happened: `exit ${bare.status}; ${bare.stdout.slice(0, 120)}`, why: 'A missing value must never fall back to the default mode.', fix: 'Check bare valued flags before running.' });
    const bare2 = run(['hello', '--engine', 'echo', '--output-format', '--json']);
    check('--output-format followed by another flag exits 2', bare2.status === 2, { happened: `exit ${bare2.status}; ${bare2.stdout.slice(0, 120)}`, why: 'A flag must not be read as a value.', fix: 'Check the next token before the format.' });
  });
}
