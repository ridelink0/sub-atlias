// One suite per module for the exported functions nothing else calls by name:
// the small helpers every feature leans on. The coverage suite fails if any
// exported function is left out, so this file is where a new one gets its test.
// Loaded by test/run.mjs after it has pointed ATLIAS_HOME, CLAUDE_CONFIG_DIR
// and CODEX_HOME at a temp directory, so nothing here touches a real home.
import http from 'node:http';
import * as core from '../lib/core.mjs';
import * as gate from '../lib/gate.mjs';
import * as graph from '../lib/graph.mjs';
import * as dream from '../lib/dream.mjs';
import * as progress from '../lib/progress.mjs';
import * as brief from '../lib/brief.mjs';
import * as hooksMod from '../lib/hooks.mjs';
import * as hosts from '../lib/hosts.mjs';
import * as extras from '../lib/hosts-extra.mjs';
import * as integrity from '../lib/integrity.mjs';
import * as logoMod from '../lib/logo.mjs';
import * as loop from '../lib/loop.mjs';
import * as settings from '../lib/settings.mjs';
import * as shortcut from '../lib/shortcut.mjs';
import * as track from '../lib/track.mjs';

export default async function unitSuites({ suite, asyncSuite, check, PROJECT, TMP, fs, path }) {
  const U = path.join(TMP, 'unit');
  const NL = String.fromCharCode(10);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await asyncSuite('file helper expert', 'the file and process helpers', async () => {
    const dir = core.ensureDir(path.join(U, 'a', 'b'));
    check('ensureDir makes the whole path and returns it', dir === path.join(U, 'a', 'b') && fs.statSync(dir).isDirectory(), { happened: dir, why: 'Every state write starts here.', fix: 'mkdirSync recursive.' });
    const t = path.join(dir, 't.txt');
    core.writeText(t, 'hello');
    check('writeText and readText round-trip, and a missing file reads as null', core.readText(t) === 'hello' && core.readText(path.join(dir, 'missing')) === null && !fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), { happened: String(core.readText(t)), why: 'writeText goes through a temp file and a rename so a crash never leaves half a file; the temp must not be left behind.', fix: 'Check writeText.' });
    const j = path.join(dir, 'j.json');
    core.writeJson(j, { a: 1 });
    check('writeJson writes JSON that reads back, ending in a newline', core.readJson(j).a === 1 && fs.readFileSync(j, 'utf8').endsWith(NL), { happened: fs.readFileSync(j, 'utf8'), why: 'Config files are edited by hand as well.', fix: 'Check writeJson.' });
    const l = path.join(dir, 'l.jsonl');
    core.appendLine(l, 'one' + NL + 'two');
    core.appendLine(l, 'three');
    check('appendLine keeps one record per line even when the text has newlines', JSON.stringify(core.readLines(l)) === JSON.stringify(['one two', 'three']), { happened: JSON.stringify(core.readLines(l)), why: 'A newline inside an event would split it into two broken records.', fix: 'appendLine flattens newlines.' });
    check('mtime and exists report a file and its absence', core.mtime(t) > 0 && core.mtime(path.join(dir, 'missing')) === 0 && core.exists(t) && !core.exists(path.join(dir, 'missing')), { happened: 'wrong', why: 'Freshness checks all over the harness read these.', fix: 'Check mtime and exists.' });
    const h = core.sha('abc');
    check('sha is short, stable and sensitive', /^[0-9a-f]{16}$/.test(h) && h === core.sha('abc') && h !== core.sha('abd'), { happened: h, why: 'Cache keys depend on it.', fix: 'Check sha.' });
    check('clip keeps short text and marks cut text', core.clip('abcdef', 4) === 'abc…' && core.clip('ab', 4) === 'ab' && core.clip(null, 3) === '', { happened: core.clip('abcdef', 4), why: 'Every message budget goes through it.', fix: 'Check clip.' });
    core.log('unit-log-marker-7781');
    check('log appends to the state log', (core.readText(path.join(process.env.ATLIAS_HOME, 'log.txt')) || '').includes('unit-log-marker-7781'), { happened: 'marker missing', why: 'The log is the only trace a failed hook leaves.', fix: 'Check log.' });
    check('the session files live under the state directory with safe names', core.sessionDir() === path.join(process.env.ATLIAS_HOME, 'sessions') && core.sessionEvents('a/b').endsWith('a_b.jsonl') && core.sessionMetaPath('x').endsWith(path.join('sessions', 'x.json')), { happened: core.sessionEvents('a/b'), why: 'A session id with a slash must not write outside the directory.', fix: 'Check safeId and the path helpers.' });
    let captured = '';
    const orig = process.stdout.write;
    process.stdout.write = (s) => { captured += s; return true; };
    try { core.emit({ ok: 1 }); } finally { process.stdout.write = orig; }
    check('emit writes one JSON line', captured === JSON.stringify({ ok: 1 }) + NL, { happened: JSON.stringify(captured), why: 'Hosts parse the last line of hook output as JSON.', fix: 'Check emit.' });
    const ctx = core.contextOutput('SessionStart', 'note');
    check('contextOutput is silent without text and shaped for the host with it', core.contextOutput('SessionStart', '') === null && ctx.hookSpecificOutput.hookEventName === 'SessionStart' && ctx.hookSpecificOutput.additionalContext === 'note', { happened: JSON.stringify(ctx), why: 'Silence on the common path is what keeps the harness cheap.', fix: 'Check contextOutput.' });
    check('detectHost honours an explicit --host', core.detectHost(['node', 'hooks.mjs', 'stop', '--host', 'gemini']) === 'gemini', { happened: core.detectHost(['node', 'hooks.mjs', 'stop', '--host', 'gemini']), why: 'The output shape depends on the host.', fix: 'Check detectHost.' });
    const ran = core.run(process.execPath, ['-e', 'process.stdout.write("hi")']);
    const none = core.run('atlias-no-such-program-xyz', []);
    check('run returns output, and a missing program returns an error instead of throwing', ran.status === 0 && ran.stdout === 'hi' && Boolean(none.error), { happened: JSON.stringify({ out: ran.stdout, err: String(none.error) }), why: 'A hook that throws breaks the host.', fix: 'Check run.' });
    const flag = path.join(U, 'detached.flag');
    const script = path.join(U, 'detached.mjs');
    fs.writeFileSync(script, 'import fs from "node:fs"; fs.writeFileSync(' + JSON.stringify(flag) + ', "ok");');
    // The runner sets ATLIAS_NO_DETACH for the whole suite; this check is the
    // one place that wants a real background process, so it lifts it briefly.
    const refused = core.detach([script]);
    check('with ATLIAS_NO_DETACH=1 nothing is started in the background', process.env.ATLIAS_NO_DETACH === '1' && refused === false && !fs.existsSync(flag), { happened: `env ${process.env.ATLIAS_NO_DETACH}, detach returned ${refused}`, why: 'A graph worker the suite started kept its cwd in the temp tree, which then could not be deleted.', fix: 'detach returns false when ATLIAS_NO_DETACH is 1.' });
    delete process.env.ATLIAS_NO_DETACH;
    const started = core.detach([script]);
    process.env.ATLIAS_NO_DETACH = '1';
    let seen = false;
    // Up to 15 s: a process start on a loaded Windows machine can take several.
    for (let i = 0; i < 150 && !seen; i++) { await sleep(100); seen = fs.existsSync(flag); }
    check('detach starts a background process that really runs', started && seen, { happened: 'started ' + started + ', ran ' + seen, why: 'Dream and the graph refresh run this way; a detach that does nothing loses them silently.', fix: 'Check detach.' });
    const lock = path.join(U, 'x.lock');
    const first = core.tryLock(lock);
    const second = core.tryLock(lock);
    core.unlock(lock);
    const third = core.tryLock(lock);
    // A lock left by a crashed worker: its mtime is well past the TTL.
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(lock, past, past);
    const stale = core.tryLock(lock, 30000);
    core.unlock(lock);
    check('a lock is held once, freed by unlock, and a stale one is taken over', first && !second && third && stale && !fs.existsSync(lock), { happened: JSON.stringify([first, second, third, stale]), why: 'Two graph workers at once corrupt the graph; a crashed worker must not block forever.', fix: 'Check tryLock and unlock.' });
    const g = core.graphify(['query', 'x', '--graph', path.join(U, 'no-graph.json')], { timeout: 15000 });
    check('graphify answers with a result object even when it fails', g && g.status !== 0 && (typeof g.status === 'number' || Boolean(g.error)), { happened: JSON.stringify({ status: g && g.status, error: g && g.error }), why: 'No python, or no graph, must read as a failure, not a crash.', fix: 'Check graphify.' });
    check('graphPath points at graphify-out/graph.json', core.graphPath(U) === path.join(U, 'graphify-out', 'graph.json'), { happened: core.graphPath(U), why: 'Every graph feature reads this path.', fix: 'Check graphPath.' });
    check('edit and shell tools are recognised across hosts', core.isEditTool('Edit') && core.isEditTool('apply_patch') && !core.isEditTool('Read') && core.isShellTool('Bash') && core.isShellTool('PowerShell') && core.isShellTool('exec_command') && !core.isShellTool('Read'), { happened: 'a tool name was misread', why: 'The gate only checks edits it recognises.', fix: 'Check isEditTool and isShellTool.' });
  });

  suite('gate helper expert', 'the gate report and syntax report', () => {
    fs.mkdirSync(U, { recursive: true });
    const good = path.join(U, 'good.mjs');
    const bad = path.join(U, 'bad.mjs');
    const txt = path.join(U, 'note.txt');
    fs.writeFileSync(good, 'export const a = 1;' + NL);
    fs.writeFileSync(bad, 'export const = 1;' + NL);
    fs.writeFileSync(txt, 'plain');
    const r = gate.syntaxReport([good, bad, txt, path.join(U, 'gone.mjs')]);
    check('syntaxReport sorts files into checked, failed, skipped and missing', r.checked.length === 2 && r.failures.length === 1 && r.failures[0].file === bad && r.skipped.length === 1 && r.missing.length === 1, { happened: JSON.stringify({ c: r.checked.length, f: r.failures.length, s: r.skipped.length, m: r.missing.length }), why: 'The gate says which files it could and could not check; lumping them together hides unchecked ones.', fix: 'Check syntaxCheckDetailed.' });
    const one = gate.report(['fix the thing']);
    const two = gate.report(['a', 'b']);
    check('the gate report counts and numbers its sections', /one thing to settle/.test(one) && /1\. fix the thing/.test(one) && /2 things to settle/.test(two) && /2\. b/.test(two) && /speaks once per prompt/.test(two), { happened: two.slice(0, 120), why: 'Every finding has to arrive in the one block the host lets the gate send.', fix: 'Check report.' });
  });

  await asyncSuite('graph helper expert', 'the graph helpers', async () => {
    const now = Date.now();
    check('age reads like a person would say it', graph.age(now) === 'in the last minute' && graph.age(now - 30 * 60000) === '30 minutes ago' && graph.age(now - 5 * 3600000) === '5 hours ago' && graph.age(now - 72 * 3600000) === '3 days ago', { happened: [graph.age(now - 30 * 60000), graph.age(now - 5 * 3600000), graph.age(now - 72 * 3600000)].join(' | '), why: 'The brief tells the model how fresh the graph is.', fix: 'Check age.' });
    const empty = path.join(U, 'no-graph-project');
    fs.mkdirSync(empty, { recursive: true });
    check('a project with no graph is reported as having none', graph.status(empty).exists === false && graph.query(empty, 'where is x') === null && graph.sub(empty, 'explain', 'x') === null, { happened: JSON.stringify(graph.status(empty)), why: 'A missing graph must mean no answer, never an invented one.', fix: 'Check status, query and sub.' });
    check('godNodes on a project with no graph answers with nothing', graph.godNodes(empty, 3) === '', { happened: JSON.stringify(graph.godNodes(empty, 3)), why: 'The brief prints whatever this returns.', fix: 'Return an empty string when graphify fails.' });
    check('the dirty flag lives in the project state and starts clear', graph.dirtyPath(empty).endsWith('.graph_dirty') && !graph.isDirty(empty), { happened: graph.dirtyPath(empty), why: 'The refresh worker keys off it.', fix: 'Check dirtyPath and isDirty.' });
    const lock = path.join(core.projectDir(empty), '.graph.lock');
    fs.writeFileSync(lock, String(process.pid));
    const queued = graph.scheduleUpdate(empty);
    check('scheduling marks the graph dirty and leaves a running worker alone', queued === true && graph.isDirty(empty) && fs.existsSync(lock), { happened: 'queued ' + queued + ', dirty ' + graph.isDirty(empty), why: 'Edits in quick succession must not start a worker each.', fix: 'Check scheduleUpdate.' });
    core.unlock(lock);
    const updated = graph.updateNow(empty);
    check('updateNow clears the dirty flag and reports how it went', typeof updated === 'boolean' && !graph.isDirty(empty), { happened: 'returned ' + updated + ', dirty ' + graph.isDirty(empty), why: 'A flag left set would refresh forever.', fix: 'Check updateNow.' });
  });

  suite('dream helper expert', 'the dream helpers', () => {
    const cwd = path.join(U, 'dream-project');
    fs.mkdirSync(cwd, { recursive: true });
    check('the cursor lives in the project state', dream.cursorPath(cwd).endsWith('.dream_cursor'), { happened: dream.cursorPath(cwd), why: 'Consolidation resumes from it.', fix: 'Check cursorPath.' });
    settings.set('dream.enabled', 'false');
    const off = dream.sessionEnd({ session_id: 'unit-dream', cwd });
    settings.reset('dream.enabled');
    check('with Dream switched off, a session end starts nothing', off === null && dream.pending(cwd).count === 0, { happened: String(off), why: 'Off has to mean off.', fix: 'Check the enabled test in sessionEnd.' });
    settings.set('dream.keepHistory', '2');
    fs.writeFileSync(dream.historyPath(cwd), [1, 2, 3, 4, 5].map((n) => JSON.stringify({ cursor: n })).join(NL) + NL);
    fs.writeFileSync(dream.cursorPath(cwd), '5');
    const removed = dream.prune(cwd);
    settings.reset('dream.keepHistory');
    const left = core.readJsonl(dream.historyPath(cwd)).map((r) => r.cursor);
    check('prune keeps the newest rows up to the limit', removed === 3 && JSON.stringify(left) === '[4,5]', { happened: removed + ' removed, left ' + JSON.stringify(left), why: 'The history would grow forever.', fix: 'Check prune.' });
  });

  suite('handoff helper expert', 'the handoff note helpers', () => {
    const cwd = path.join(U, 'progress-project');
    fs.mkdirSync(cwd, { recursive: true });
    check('the next step lives beside the note', progress.nextPath(cwd).endsWith('next.md'), { happened: progress.nextPath(cwd), why: 'Both are read at session start.', fix: 'Check nextPath.' });
    const bare = progress.applyNext(cwd, 'first step');
    check('with no note yet, the next step is still recorded', bare === null && (core.readText(progress.nextPath(cwd)) || '').includes('first step'), { happened: String(core.readText(progress.nextPath(cwd))), why: 'The first session has no note but still has a next step.', fix: 'Check applyNext.' });
    fs.writeFileSync(progress.notePath(cwd), '# note' + NL + NL + '## Files' + NL + 'a.js' + NL + '## Next' + NL + 'old step' + NL);
    const updated = progress.applyNext(cwd, 'new step');
    check('with a note, only its Next section changes', updated.includes('## Next' + NL + 'new step') && !updated.includes('old step') && updated.includes('a.js'), { happened: updated, why: 'Setting the next step must not cost the rest of the note.', fix: 'Check applyNext.' });
  });

  suite('brief helper expert', 'the session brief helpers', () => {
    const settingsPath = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
    const before = core.readText(settingsPath);
    fs.writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { 'usage-limits@x': true, 'ultimate-frontend-skills@y': false } }));
    const c = brief.companions();
    if (before === null) fs.unlinkSync(settingsPath); else fs.writeFileSync(settingsPath, before);
    check('Atlias does not read plugin account-usage state', !Object.hasOwn(c, 'usageLimits') && c.ufs === false, { happened: JSON.stringify(c), why: 'Atlias provider usage belongs to Atlias; it does not inspect another plugin’s account limits.', fix: 'Keep companion discovery separate from account usage.' });
    const out = brief.sessionStart({ session_id: 'unit-brief', cwd: PROJECT, source: 'startup' }, 'claude');
    check('sessionStart returns the brief and records the session', out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext.length > 0 && core.sessionMeta('unit-brief').host === 'claude', { happened: JSON.stringify(out).slice(0, 160), why: 'This is the first thing every session sees.', fix: 'Check sessionStart.' });
  });

  suite('companion expert', 'one copy of each companion, never two', () => {
    const base = path.join(process.env.CLAUDE_CONFIG_DIR, 'companion-case');
    fs.rmSync(base, { recursive: true, force: true });
    const win = process.platform === 'win32';
    const exe = win ? '.exe' : '';
    const venvBin = path.join(base, 'venv', win ? 'Scripts' : 'bin');
    fs.mkdirSync(venvBin, { recursive: true });
    fs.writeFileSync(path.join(venvBin, 'graphify' + exe), '');
    fs.writeFileSync(path.join(venvBin, 'python' + exe), '');
    const fromPath = core.graphifyInterpreters({ env: { PATH: venvBin, LOCALAPPDATA: path.join(base, 'nolocal') }, home: path.join(base, 'nohome') });
    // macOS keeps temp folders behind a symlink (/var is /private/var), and the
    // launcher is followed to its real path, so compare real paths.
    const wantPy = fs.realpathSync(path.join(venvBin, 'python' + exe));
    check('graphify in its own venv is found through its launcher on PATH', fromPath.some((p) => fs.realpathSync(p) === wantPy), { happened: JSON.stringify(fromPath), why: 'A graphify the system Python cannot import was invisible, and the companion installer then pip-installed a second copy.', fix: 'graphifyInterpreters reads PATH for a graphify launcher and returns the interpreter beside it.' });
    const pipxHome = path.join(base, 'home');
    const pipxPy = win ? path.join(pipxHome, 'pipx', 'venvs', 'graphifyy', 'Scripts', 'python.exe') : path.join(pipxHome, '.local', 'pipx', 'venvs', 'graphifyy', 'bin', 'python');
    fs.mkdirSync(path.dirname(pipxPy), { recursive: true });
    fs.writeFileSync(pipxPy, '');
    const fromPipx = core.graphifyInterpreters({ env: { PATH: '', LOCALAPPDATA: path.join(base, 'nolocal') }, home: pipxHome });
    check('graphify installed with pipx is found in pipx\'s venvs', fromPipx.includes(pipxPy), { happened: JSON.stringify(fromPipx), why: 'pipx is the documented way to install a Python CLI, and its venv is invisible to the system Python.', fix: 'graphifyInterpreters lists the pipx venv interpreters.' });
    const none = core.graphifyInterpreters({ env: { PATH: path.join(base, 'empty'), LOCALAPPDATA: path.join(base, 'nolocal') }, home: path.join(base, 'nohome') });
    check('nothing is invented when graphify is nowhere', none.length === 0, { happened: JSON.stringify(none), why: 'A candidate that is not on disk would be spawned for nothing.', fix: 'graphifyInterpreters returns only paths that exist.' });
    const cdir = path.join(base, 'claude');
    const otherHome = path.join(base, 'agents-home');
    fs.mkdirSync(path.join(cdir, 'skills', 'ultimate-frontend-skills'), { recursive: true });
    fs.writeFileSync(path.join(cdir, 'skills', 'ultimate-frontend-skills', 'SKILL.md'), '# UFS');
    fs.writeFileSync(path.join(cdir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'ultimate-website-skills@old': true } }));
    const twice = core.ufsCopies({ claudeDir: cdir, home: otherHome });
    const twicePlan = core.ufsInstallPlan(twice);
    check('UFS under an old name plus a skills-only copy is two loaded copies, and nothing is installed', twice.filter((x) => x.loaded).length === 2 && !twicePlan.install && /keep one/.test(twicePlan.say), { happened: JSON.stringify({ twice, twicePlan }), why: 'Only the current plugin name was recognised, so a renamed install or a skills folder was reported missing and a second copy was installed beside it.', fix: 'ufsCopies knows every name and folder; ufsInstallPlan never installs when a copy loads.' });
    fs.rmSync(path.join(cdir, 'skills'), { recursive: true, force: true });
    fs.writeFileSync(path.join(cdir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'ultimate-frontend-skills@m': false } }));
    const off = core.ufsInstallPlan(core.ufsCopies({ claudeDir: cdir, home: otherHome }));
    check('an installed but switched-off UFS is enabled, not installed a second time', !off.install && /enable it/.test(off.say), { happened: JSON.stringify(off), why: 'Installing over a disabled copy leaves two once it is switched back on.', fix: 'ufsInstallPlan treats an installed plugin as present.' });
    fs.writeFileSync(path.join(cdir, 'settings.json'), JSON.stringify({}));
    fs.mkdirSync(path.join(otherHome, '.agents', 'skills', 'ultimate-frontend-skills'), { recursive: true });
    fs.writeFileSync(path.join(otherHome, '.agents', 'skills', 'ultimate-frontend-skills', 'SKILL.md'), '# UFS');
    const other = core.ufsCopies({ claudeDir: cdir, home: otherHome });
    check('a copy only other agents load is listed but does not block the Claude Code install', core.ufsInstallPlan(other).install && other.length === 1 && other[0].loaded === false, { happened: JSON.stringify(other), why: 'Claude Code does not load ~/.agents/skills, so refusing would leave it without UFS.', fix: 'Only loaded copies and installed plugins block the install.' });
    // Project scope: <cwd>/.claude/settings.json, then settings.local.json, and
    // <cwd>/.claude/skills, as Claude Code reads them inside that project.
    const proj = path.join(base, 'a-project');
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.rmSync(path.join(otherHome, '.agents'), { recursive: true, force: true });
    fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'ultimate-frontend-skills@ultimate-frontend-skills': true } }));
    const inProject = core.ufsCopies({ claudeDir: cdir, home: otherHome, cwd: proj });
    check('UFS enabled only in the project .claude/settings.json counts as loaded there, so --companions installs nothing', inProject.filter((x) => x.loaded).length === 1 && !core.ufsInstallPlan(inProject).install,
      { happened: JSON.stringify(inProject), why: 'Reading only the user settings, `atlias install --companions` inside such a project added a second, user-wide copy.', fix: 'ufsCopies merges <cwd>/.claude/settings.json and settings.local.json into the enabled map.' });
    fs.writeFileSync(path.join(proj, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'ultimate-frontend-skills@ultimate-frontend-skills': false } }));
    const localOff = core.ufsCopies({ claudeDir: cdir, home: otherHome, cwd: proj });
    check('settings.local.json wins over settings.json, as it does in Claude Code', localOff.length === 1 && localOff[0].loaded === false && /enable it/.test(core.ufsInstallPlan(localOff).say),
      { happened: JSON.stringify(localOff), why: 'The local file is the one a user edits to switch a plugin off for themselves.', fix: 'Merge the scopes in order: user, user local, project, project local.' });
    fs.rmSync(path.join(proj, '.claude', 'settings.local.json'));
    fs.rmSync(path.join(proj, '.claude', 'settings.json'));
    fs.mkdirSync(path.join(proj, '.claude', 'skills', 'ultimate-frontend-skills'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.claude', 'skills', 'ultimate-frontend-skills', 'SKILL.md'), '# UFS');
    const projSkills = core.ufsCopies({ claudeDir: cdir, home: otherHome, cwd: proj });
    check('a project skills folder is a loaded copy too', projSkills.length === 1 && projSkills[0].kind === 'skills' && projSkills[0].loaded && !core.ufsInstallPlan(projSkills).install,
      { happened: JSON.stringify(projSkills), why: 'Claude Code loads <project>/.claude/skills; a user-wide install beside it is the second copy.', fix: 'ufsCopies looks in the project skills folder.' });
    const atHome = core.ufsCopies({ claudeDir: path.join(proj, '.claude'), home: otherHome, cwd: proj });
    check('run from the folder whose .claude is the user settings, nothing is counted twice', atHome.length === 1,
      { happened: JSON.stringify(atHome), why: 'In the home folder the project scope and the user scope are one folder; counting it twice reports two copies of one.', fix: 'ufsCopies skips the project scope when it is the user scope.' });
    const settingsPath = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
    const before = core.readText(settingsPath);
    fs.writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { 'ultimate-website-skills@x': true } }));
    const c = brief.companions();
    if (before === null) fs.unlinkSync(settingsPath); else fs.writeFileSync(settingsPath, before);
    check('the brief counts UFS enabled under an older name as on', c.ufs === true, { happened: JSON.stringify({ ufs: c.ufs, copies: c.ufsCopies }), why: 'A renamed install reported as off makes the router offer a second copy.', fix: 'companions reads ufsCopies.' });
    fs.rmSync(base, { recursive: true, force: true });
  });

  suite('hook dispatch expert', 'the hook dispatcher', () => {
    check('an unknown event is ignored, not thrown', hooksMod.dispatch('no-such-event', {}, 'claude') === null, { happened: 'returned something', why: 'A new host event must not break the host.', fix: 'Keep the default branch.' });
    const r = hooksMod.dispatch('subagent-stop', { session_id: 'unit-dispatch', agent_type: 'reviewer', last_assistant_message: 'looked fine' }, 'claude');
    check('a known event reaches its handler', r === null && core.events('unit-dispatch').some((e) => e.kind === 'subagent'), { happened: JSON.stringify(core.events('unit-dispatch')), why: 'A dispatcher that drops events drops the whole harness.', fix: 'Check dispatch.' });
  });

  suite('subagent expert', 'subagent results are recorded', () => {
    const r = track.subagentStop({ session_id: 'unit-sub', agent_type: 'code-reviewer', last_assistant_message: 'x'.repeat(500) });
    const ev = core.events('unit-sub').find((e) => e.kind === 'subagent');
    check('a finished subagent is recorded with its type and a clipped summary', r === null && ev && ev.agent === 'code-reviewer' && ev.summary.length <= 200, { happened: JSON.stringify(ev), why: 'Opaque subagents were one of the nanobot issues atlias exists to fix.', fix: 'Check subagentStop.' });
  });

  suite('host config expert', 'Codex install round trip and the doctor', () => {
    const lines = hosts.installCodex();
    const toml = core.readText(path.join(process.env.CODEX_HOME, 'config.toml')) || '';
    check('installCodex writes the MCP server into the sandboxed Codex config', Array.isArray(lines) && /\[mcp_servers\.atlias\]/.test(toml), { happened: toml.slice(0, 160), why: 'Codex gets its tools from this table.', fix: 'Check installCodex.' });
    hosts.uninstallCodex();
    check('uninstallCodex takes it out again', !/\[mcp_servers\.atlias\]/.test(core.readText(path.join(process.env.CODEX_HOME, 'config.toml')) || ''), { happened: 'table still there', why: 'Uninstall has to leave the config as it found it.', fix: 'Check uninstallCodex.' });
    const rows = hosts.doctor(PROJECT);
    check('the doctor reports node and the terminal command', rows.some((r) => r.name === 'node 18+' && r.ok) && rows.some((r) => r.name === 'terminal command'), { happened: rows.map((r) => r.name).join(', '), why: 'These are the two rows every user needs first.', fix: 'Check doctor.' });
    const text = hosts.formatDoctor([{ name: 'thing', ok: false, detail: 'broken', fix: 'do this' }, { name: 'other', ok: true, detail: 'fine', fix: '' }]);
    check('formatDoctor shows the fix under a failing row only', /FIX  thing: broken/.test(text) && /-> do this/.test(text) && /ok   other: fine/.test(text) && text.split('->').length === 2, { happened: text, why: 'A fix line under a passing row is noise.', fix: 'Check formatDoctor.' });
  });

  suite('extra harness helper expert', 'the extra harness helpers', () => {
    check('a harness whose folder is absent is not installed', extras.installed({ dir: path.join(U, 'nope-harness') }) === false, { happened: 'reported installed', why: 'atlias only writes where a harness really is.', fix: 'Check installed.' });
    check('byId finds a harness and says null for an unknown one', (extras.byId('cursor') || {}).id === 'cursor' && extras.byId('no-such-harness') === null, { happened: JSON.stringify(extras.byId('cursor')), why: 'atlias install --extras <id> depends on it.', fix: 'Check byId.' });
    const rows = extras.doctorRows();
    check('doctorRows gives a named, fixable row per detected harness', Array.isArray(rows) && rows.every((r) => r.name && typeof r.ok === 'boolean' && /atlias install --extras/.test(r.fix)), { happened: JSON.stringify(rows).slice(0, 160), why: 'The doctor adds these to its report.', fix: 'Check doctorRows.' });
    check('statusLine says what it found in one line', /extra harnesses detected|no extra harnesses detected/.test(extras.statusLine()) && !extras.statusLine().includes(NL), { happened: extras.statusLine(), why: 'The chooser and /hosts print it.', fix: 'Check statusLine.' });
  });

  suite('integrity helper expert', 'the integrity helpers', () => {
    const turn = [{ kind: 'shell', verify: true, command: 'npm test' }, { kind: 'edit' }, { kind: 'shell', verify: false, command: 'ls' }];
    check('lastVerification finds the latest check, skipping plain commands', integrity.lastVerification(turn).command === 'npm test' && integrity.lastVerification([]) === null, { happened: JSON.stringify(integrity.lastVerification(turn)), why: 'The gate compares it with the last edit.', fix: 'Check lastVerification.' });
    const repo = path.join(U, 'fake-repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
    check('hasGitAbove finds a repository from a folder deep inside it, and none at the root of the disk', integrity.hasGitAbove(path.join(repo, 'src', 'deep')) && !integrity.hasGitAbove(path.parse(TMP).root), { happened: 'wrong', why: 'It is what saves a git process per reply outside repositories.', fix: 'Check hasGitAbove.' });
    const found = integrity.repoRoot(repo, { run: () => ({ status: 0, stdout: repo + NL }) });
    const failed = integrity.repoRoot(repo, { run: () => ({ status: 128, stdout: '' }) });
    check('repoRoot trusts git and says null when git refuses', found === path.resolve(repo) && failed === null, { happened: JSON.stringify([found, failed]), why: 'Every diff check is relative to this root.', fix: 'Check repoRoot.' });
    check('real resolves a path that does not exist without throwing', integrity.real(path.join(U, 'nope', 'x')) === path.resolve(path.join(U, 'nope', 'x')) && path.isAbsolute(integrity.real(TMP)), { happened: integrity.real(path.join(U, 'nope', 'x')), why: 'macOS temp paths are symlinks; diffs compare real paths.', fix: 'Check real.' });
  });

  suite('logo helper expert', 'the logo helpers', () => {
    check('paint colours for each terminal and leaves plain text alone', logoMod.paint('x', [1, 2, 3], 'none') === 'x' && logoMod.paint('x', [1, 2, 3], 'truecolor').includes('38;2;1;2;3') && logoMod.paint('x', [100, 150, 250], 'basic').includes('[94m'), { happened: JSON.stringify(logoMod.paint('x', [100, 150, 250], 'basic')), why: 'NO_COLOR and old terminals must not get raw escapes they cannot show.', fix: 'Check paint.' });
    check('banner carries its subtitle under the logo', logoMod.banner('engine test').includes('engine test'), { happened: logoMod.banner('engine test').slice(-60), why: 'The agent prints its engine this way.', fix: 'Check banner.' });
  });

  await asyncSuite('loop helper expert', 'the tool loop helpers', async () => {
    const withGraph = loop.toolSchemas(true).map((t) => t.function.name);
    const withoutGraph = loop.toolSchemas(false).map((t) => t.function.name);
    check('the tool schemas offer graph_query only where there is a graph', withGraph.includes('graph_query') && !withoutGraph.includes('graph_query') && withoutGraph.includes('edit_file'), { happened: withoutGraph.join(','), why: 'A tool that cannot answer wastes a round.', fix: 'Check toolSchemas.' });
    check('renderTodo draws checkboxes', loop.renderTodo([{ text: 'a', done: true }, { text: 'b', done: false }]) === '[x] a' + NL + '[ ] b', { happened: loop.renderTodo([{ text: 'a', done: true }]), why: '/plan prints it.', fix: 'Check renderTodo.' });
    const server = http.createServer((req, res) => { let b = ''; req.on('data', (x) => { b += x; }); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ echoed: JSON.parse(b), path: req.url })); }); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const r = await loop.postJson(`http://127.0.0.1:${server.address().port}/v1/x?y=1`, { hi: 1 });
      check('postJson sends JSON and reads JSON back, keeping the query string', r.status === 200 && r.json.echoed.hi === 1 && r.json.path === '/v1/x?y=1', { happened: JSON.stringify(r).slice(0, 160), why: 'Both engines talk through it.', fix: 'Check postJson.' });
    } finally { server.close(); }
    const bad = await loop.postJson('not a url', {});
    check('postJson reports a bad url instead of throwing', bad.status === 0 && /not a url/.test(bad.error), { happened: JSON.stringify(bad), why: 'The url comes from a config a human edits.', fix: 'Check postJson.' });
    const ok = await loop.ollamaChat({ ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: 'm' }, { post: async () => ({ status: 200, json: { message: { content: 'hello' } } }) })([{ role: 'user', content: 'x' }]);
    const down = await loop.ollamaChat({ ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: 'm' }, { post: async () => ({ status: 0, error: 'connect ECONNREFUSED' }) })([]);
    check('ollamaChat returns the content, or the error when Ollama is down', ok.content === 'hello' && /ECONNREFUSED/.test(down.error), { happened: JSON.stringify([ok, down]), why: 'A stopped Ollama must say so, not hang or crash.', fix: 'Check ollamaChat.' });
  });

  suite('settings helper expert', 'the settings helpers', () => {
    check('mode reads the configured mode', settings.mode({ agent: { mode: 'standalone' } }) === 'standalone' && settings.mode({ agent: {} }) === 'both', { happened: settings.mode({ agent: { mode: 'standalone' } }), why: 'The hooks and the bare command both ask it.', fix: 'Check mode.' });
    const listed = settings.format(settings.rows());
    check('format numbers every setting and says what it does', /^ 1  verify\.syntax/.test(listed) && listed.includes('hold a reply whose edited files do not parse'), { happened: listed.slice(0, 120), why: 'The menu and settings list print it.', fix: 'Check format.' });
    check('describeMode marks the current mode', /\* sub/.test(settings.describeMode({ agent: { mode: 'sub' } })), { happened: settings.describeMode({ agent: { mode: 'sub' } }), why: 'The user needs to see which one is on.', fix: 'Check describeMode.' });
  });

  suite('shortcut path expert', 'the terminal command paths', () => {
    const win = shortcut.shimDirCandidates({ USERPROFILE: path.join(U, 'h'), APPDATA: path.join(U, 'h', 'r'), LOCALAPPDATA: path.join(U, 'h', 'l') }, 'win32');
    const posix = shortcut.shimDirCandidates({ HOME: path.join(U, 'h') }, 'linux');
    check('the candidate folders are the npm folder, WindowsApps, then ~/.local/bin on Windows, and ~/.local/bin then ~/bin elsewhere', win.length === 3 && win[0] === path.join(U, 'h', 'r', 'npm') && win[1].endsWith(path.join('Microsoft', 'WindowsApps')) && posix[0] === path.join(U, 'h', '.local', 'bin') && posix[1] === path.join(U, 'h', 'bin'), { happened: JSON.stringify([win, posix]), why: 'The command has to land in a folder already on PATH.', fix: 'Check shimDirCandidates.' });
    check('the launcher lives in the atlias state folder', shortcut.launcherPath({ ATLIAS_HOME: path.join(U, 's') }) === path.join(U, 's', 'cli.mjs'), { happened: shortcut.launcherPath({ ATLIAS_HOME: path.join(U, 's') }), why: 'A path that never changes is the point of the launcher.', fix: 'Check launcherPath.' });
  });

  await asyncSuite('compaction expert', 'after a compaction the model is told what the summary left out', async () => {
    const C = path.join(TMP, 'compact-audit');
    fs.mkdirSync(C, { recursive: true });
    const note = [
      '# atlias handoff for ' + C,
      '', '## Objective (latest prompts)', '- make the parser strict',
      '', '## Files changed this session', '- src/parse.mjs', '- src/lexer.mjs',
      '', '## Checks run', '- node test/parse-test.mjs',
      '', '## Next', 'wire strictMode into the tokenizer and rerun parse-test',
      '',
    ].join('\n');
    const summaryText = 'Summary:\n1. Primary Request: make the parser strict.\n2. Files: src/parse.mjs was changed; node test/parse-test.mjs passes.\n';
    const transcript = path.join(C, 'session.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'earlier' } }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto' } }),
      JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued. ' + summaryText } }),
      '',
    ].join('\n'));
    const got = progress.compactSummary(transcript);
    check('the summary is read from the transcript: the isCompactSummary message after the boundary', got.includes('make the parser strict') && got.includes('src/parse.mjs'),
      { happened: got.slice(0, 200), why: 'The hooks documentation gives PostCompact no summary field and no say in the result; the transcript is where the summary can be checked.', fix: 'Check compactSummary.' });
    check('a transcript with no compaction, or none at all, gives nothing rather than a guess', progress.compactSummary(path.join(C, 'nope.jsonl')) === '' && (() => { const p = path.join(C, 'plain.jsonl'); fs.writeFileSync(p, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n'); return progress.compactSummary(p) === ''; })(),
      { happened: 'a summary was invented', why: 'An audit against nothing would report everything missing.', fix: 'Return an empty string.' });
    const audit = progress.auditSummary(note, got);
    check('the audit names the file and the next step the summary dropped, and not what it kept', audit.checked === 4 && audit.missing.length === 2 && audit.missing.some((m) => /src\/lexer\.mjs/.test(m)) && audit.missing.some((m) => /^next step: wire strictMode/.test(m)) && !audit.missing.some((m) => /^file changed: src\/parse\.mjs|^check run/.test(m)),
      { happened: JSON.stringify(audit), why: 'Re-sending what the summary kept is noise; what it dropped is the point.', fix: 'Check auditSummary.' });
    const notePath = progress.notePath(C);
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, note);
    const sid = 'compact-audit-session';
    const b = brief.build({ cwd: C, session_id: sid, source: 'compact', transcript_path: transcript }, 'claude');
    const plain = brief.build({ cwd: C, session_id: sid + '-2', source: 'startup', transcript_path: transcript }, 'claude');
    const ev = core.eventsTail(sid).find((e) => e.kind === 'compact-audit');
    check('the brief after a compaction carries a section naming what was left out, and the loss is counted', /## What the compaction summary left out/.test(b) && /kept 2 of 4/.test(b) && /src\/lexer\.mjs/.test(b) && ev && ev.missing === 2 && !/left out/.test(plain),
      { happened: `${(b.match(/## What the compaction summary left out[\s\S]{0,300}/) || ['(no section)'])[0]} | event ${JSON.stringify(ev)} | plain has it: ${/left out/.test(plain)}`, why: 'PreCompact "keep in the summary" text goes through a channel Claude Code does not document as delivered; this is the part that can be proved.', fix: 'brief.build audits at source compact.' });
    fs.rmSync(notePath, { force: true });
  });
}
