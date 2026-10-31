// H.A.C council round two (2026-10-22, h2), feature 7: .atlias/settings.json in the project, merged over the
// user file for ordinary keys only. The eval path never calls readProjectSettings, so config() is unchanged there.
export default function projectSettingsSuites({ suite, check, core, TMP, fs, path }) {
  const projectDir = (name, text) => {
    const d = path.join(TMP, 'proj-' + name);
    fs.mkdirSync(path.join(d, '.atlias'), { recursive: true });
    if (text !== null) fs.writeFileSync(path.join(d, '.atlias', 'settings.json'), text);
    return d;
  };
  const noProject = path.join(TMP, 'no-such-project');
  suite('project settings expert', 'project settings: a project file changes ordinary keys and nothing that decides security', () => {
    core.readProjectSettings(noProject);
    const before = core.config().agent;
    const d = projectDir('a', JSON.stringify({ agent: { maxToolRounds: 7, permissions: 'auto-accept', hostEngines: 'off', sandbox: true, mode: 'standalone' } }));
    const r = core.readProjectSettings(d);
    const after = core.config().agent;
    check('an ordinary key from the project file applies', after.maxToolRounds === 7, { happened: `maxToolRounds ${after.maxToolRounds}`, why: 'The project file is for the project: its ordinary settings must take effect.', fix: 'config() must merge PROJECT_LAYER over the user file.' });
    check('permissions, hostEngines, sandbox and mode stay as the user file or the defaults have them', after.permissions === before.permissions && after.hostEngines === before.hostEngines && after.sandbox === before.sandbox && after.mode === before.mode, { happened: `permissions ${after.permissions} (was ${before.permissions}), hostEngines ${after.hostEngines} (was ${before.hostEngines}), sandbox ${after.sandbox} (was ${before.sandbox}), mode ${after.mode} (was ${before.mode})`, why: 'A cloned repository must not be able to raise its own permissions, turn on host harnesses, or switch the sandbox.', fix: 'Keep PROJECT_DENY and check it in readProjectSettings.' });
    check('the refused keys are named, so the person can see them', r.refused.includes('agent.permissions') && r.refused.includes('agent.hostEngines') && r.refused.includes('agent.sandbox') && r.refused.includes('agent.mode'), { happened: JSON.stringify(r.refused), why: 'A silent refusal looks like a setting that did not work.', fix: 'Return refused keys from readProjectSettings.' });
    core.readProjectSettings(noProject);
    check('leaving the project restores the user values', core.config().agent.maxToolRounds === before.maxToolRounds, { happened: `maxToolRounds ${core.config().agent.maxToolRounds} (was ${before.maxToolRounds})`, why: 'A project layer must not leak into the next project or the eval path.', fix: 'readProjectSettings resets PROJECT_LAYER on every call.' });
  });
  suite('project settings expert', 'project settings: a broken or odd file is reported and changes nothing', () => {
    core.readProjectSettings(noProject);
    const before = JSON.stringify(core.config().agent);
    const bad = core.readProjectSettings(projectDir('bad', '{ "agent": { "maxToolRounds": 7, '));
    check('invalid JSON is reported, not thrown, and applies nothing', typeof bad.error === 'string' && /not valid JSON/.test(bad.error) && JSON.stringify(core.config().agent) === before, { happened: String(bad.error) + ' | ' + (JSON.stringify(core.config().agent) === before ? 'unchanged' : 'changed'), why: 'A half-read file must not half-configure the run.', fix: 'Catch the JSON.parse error inside readProjectSettings.' });
    const arr = core.readProjectSettings(projectDir('arr', '[1,2]'));
    check('a file that is not one JSON object is reported', typeof arr.error === 'string' && JSON.stringify(core.config().agent) === before, { happened: String(arr.error), why: 'An array or a number is not settings.', fix: 'Check for a plain object.' });
    const none = core.readProjectSettings(projectDir('none', null));
    check('no file means no project layer', none.present === false && JSON.stringify(core.config().agent) === before, { happened: JSON.stringify(none), why: 'Projects without the file must behave as before.', fix: 'Return present false when the file is missing.' });
  });
}
