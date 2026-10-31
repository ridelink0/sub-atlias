// The git-worktree sandbox. Docker is not installed on this machine, so what is
// tested here is what can actually be demonstrated: a real repository, a real
// worktree, a real diff taken or dropped, and the three refusals that matter
// more than the feature - a dirty tree, a project that is not a repository at
// all, and a failure that must not leave a worktree behind.
// Loaded by test/run.mjs, which owns suite(), asyncSuite() and check().
import * as sandbox from '../lib/sandbox.mjs';

export default async function sandboxSuites({ suite, asyncSuite, check, core, agentMod, TMP, ROOT, fs, path, spawnSync }) {
  const NL = String.fromCharCode(10);
  const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000 });
  const gitHere = git(['--version'], TMP);
  // A fresh repository per case, so no case depends on another one's leftovers.
  let n = 0;
  const repo = (files = { 'a.js': 'export const a = 1;' + NL }) => {
    const dir = path.join(TMP, 'repos', 'r' + ++n);
    fs.mkdirSync(dir, { recursive: true });
    git(['init', '-q', '-b', 'main'], dir);
    for (const [k, v] of [['user.email', 'test@example.com'], ['user.name', 'atlias test'], ['commit.gpgsign', 'false']]) git(['config', k, v], dir);
    for (const [f, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), body);
    }
    return dir;
  };
  const commit = (dir, msg = 'first') => { git(['add', '-A'], dir); git(['commit', '-q', '-m', msg], dir); };
  const committed = (files) => { const d = repo(files); commit(d); return d; };
  const worktrees = (dir) => String(git(['worktree', 'list'], dir).stdout || '').split(/\r?\n/).filter(Boolean);

  suite('sandbox refusal expert', 'the sandbox says no before it pretends', () => {
    check('git is here to test against', gitHere.status === 0, { happened: `git --version exited ${gitHere.status}: ${(gitHere.stderr || '').slice(0, 120)}`, why: 'The whole sandbox is git worktrees; without git nothing below means anything, and a suite that quietly skips is worse than one that fails.', fix: 'Install git, or mark this suite as needing it.' });

    // Not a repository at all: say so, and fall back rather than pretend.
    const plain = path.join(TMP, 'not-a-repo');
    fs.mkdirSync(plain, { recursive: true });
    const outside = sandbox.begin(plain);
    check('a project that is not a git repository is not isolated', outside.ok === false && outside.isolated === false && outside.kind === 'no-repo', { happened: JSON.stringify(outside), why: 'Reporting isolation that does not exist is the exact failure this feature is supposed to prevent; a plain folder has no commit to check a worktree out from.', fix: 'inspect() must detect a missing repository before anything is created.' });
    check('and it is allowed to carry on without isolation', outside.fatal === false && /not inside a git repository/.test(outside.why), { happened: outside.why, why: 'Most folders are not repositories; refusing to run at all there would make the setting unusable.', fix: 'Only a dirty tree and a failed worktree are fatal.' });
    const spoken = sandbox.opening(outside);
    check('the fallback says plainly that nothing is isolated', /Nothing is isolated/.test(spoken) && spoken.includes(path.resolve(plain)), { happened: spoken, why: 'The user asked for a sandbox; if they silently do not get one they will trust a diff that was never isolated.', fix: 'Keep the fallback sentence in opening().' });

    // A repository with no commit has nothing to branch from.
    const fresh = repo();
    const none = sandbox.begin(fresh);
    check('a repository with no commit yet is not isolated either', none.kind === 'no-commit' && none.isolated === false && none.fatal === false, { happened: JSON.stringify(none), why: 'git worktree add needs a commit; without this check the user sees a raw git error instead of a reason.', fix: 'hasCommit() before worktree add.' });
    check('hasCommit tells the two apart', sandbox.hasCommit(fresh) === false && sandbox.hasCommit(committed()) === true, { happened: `${sandbox.hasCommit(fresh)} and ${sandbox.hasCommit(committed())}`, why: 'Everything above rests on it.', fix: 'Check rev-parse --verify HEAD.' });

    // A dirty tree is the one case that refuses to run.
    const dirty = committed();
    fs.writeFileSync(path.join(dirty, 'a.js'), 'export const a = 2;' + NL);
    fs.writeFileSync(path.join(dirty, 'untracked.js'), 'export const b = 3;' + NL);
    const before = worktrees(dirty).length;
    const refused = sandbox.begin(dirty);
    check('a dirty tree is refused', refused.ok === false && refused.fatal === true && refused.kind === 'dirty', { happened: JSON.stringify(refused).slice(0, 300), why: 'A worktree is checked out from the last commit, so uncommitted work is invisible to the agent and the diff could conflict with it coming back. Running anyway would hand the user a diff that quietly ignores half their tree.', fix: 'inspect() returns fatal on a dirty tree.' });
    check('and the refusal says which files and what to do', /uncommitted change/.test(refused.why) && /a\.js/.test(refused.why) && /untracked\.js/.test(refused.why) && /[Cc]ommit or stash/.test(refused.why), { happened: refused.why, why: 'A refusal nobody can act on gets worked around by turning the feature off.', fix: 'Name the files and the two ways forward in the message.' });
    check('a refused run creates no worktree at all', worktrees(dirty).length === before, { happened: worktrees(dirty).join(' | '), why: 'A refusal that still left a worktree behind would be the worst of both.', fix: 'Refuse in inspect(), before worktree add.' });
    check('dirtyFiles sees staged, unstaged and untracked work', sandbox.dirtyFiles(dirty).length === 2 && sandbox.dirtyFiles(committed()).length === 0, { happened: JSON.stringify(sandbox.dirtyFiles(dirty)), why: 'An untracked file is uncommitted work too; missing it would let the sandbox start on a tree it cannot bring changes back into.', fix: 'git status --porcelain counts all three.' });

    // The only delete this module can make is inside its own store.
    check('only a path inside the worktree store may be removed', sandbox.insideStore(path.join(sandbox.STORE(), 'x')) === true && sandbox.insideStore(dirty) === false && sandbox.insideStore(sandbox.STORE()) === false, { happened: `${sandbox.insideStore(path.join(sandbox.STORE(), 'x'))}, ${sandbox.insideStore(dirty)}, ${sandbox.insideStore(sandbox.STORE())}`, why: 'This module calls rm -rf on a directory. A bug that let that reach the project would be the most expensive one in the repository.', fix: 'Compare on path segments against STORE().' });
    const nothing = sandbox.close({ isolated: false });
    check('closing something that was never opened is not an error', nothing.ok === true && /nothing to remove/.test(nothing.why), { happened: JSON.stringify(nothing), why: 'The caller closes in a finally and cannot know whether a worktree was ever made.', fix: 'Return ok for a box that is not isolated.' });
  });

  await asyncSuite('sandbox worktree expert', 'a worktree the agent can work in', async () => {
    const root = committed({ 'a.js': 'export const a = 1;' + NL, 'sub/b.js': 'export const b = 2;' + NL });
    // git names the repository by its real path: the long form of a Windows 8.3
    // temp path (RUNNER~1 on CI), /private/var for macOS's /var. So paths are
    // compared real, and messages are checked for the path git gave.
    const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(String(p)); } };
    check('repoRoot finds the repository from inside it', real(sandbox.repoRoot(path.join(root, 'sub'))) === real(root) && sandbox.repoRoot(path.join(TMP, 'not-a-repo')) === null, { happened: String(sandbox.repoRoot(path.join(root, 'sub'))), why: 'The worktree is added from the repository root, not from wherever the agent was started.', fix: 'git rev-parse --show-toplevel.' });
    check('headSha reads the commit the worktree will come from', /^[0-9a-f]{7,}$/.test(sandbox.headSha(root)), { happened: sandbox.headSha(root), why: 'The opening line tells the user which commit their sandbox is a copy of.', fix: 'git rev-parse --short HEAD.' });
    const seen = sandbox.inspect(root);
    check('a clean repository is reported ready', seen.ok === true && seen.kind === 'clean' && real(seen.root) === real(root), { happened: JSON.stringify(seen), why: 'If the ordinary case cannot start, nothing else matters.', fix: 'Check inspect().' });

    const box = sandbox.begin(root);
    check('a worktree is made', box.ok === true && box.isolated === true && fs.existsSync(box.dir), { happened: JSON.stringify(box).slice(0, 300), why: 'This is the feature.', fix: 'Check begin().' });
    check('it lives outside the project, so git never sees it as untracked files', sandbox.insideStore(box.dir) && !box.dir.startsWith(path.resolve(root)), { happened: `${box.dir} against ${root}`, why: 'A worktree inside the tree it isolates would show up as a hundred untracked files in the tree it is supposed to leave alone.', fix: 'Put worktrees under STATE_DIR.' });
    check('the committed files are there at HEAD', fs.readFileSync(path.join(box.dir, 'a.js'), 'utf8').includes('a = 1') && fs.existsSync(path.join(box.dir, 'sub', 'b.js')), { happened: fs.readdirSync(box.dir).join(','), why: 'An empty sandbox is not a copy of the project.', fix: 'worktree add --detach <dir> HEAD.' });
    check('git knows about it', worktrees(root).length === 2, { happened: worktrees(root).join(' | '), why: 'A worktree git does not know about cannot be removed cleanly later.', fix: 'Use git worktree add, not a copy.' });
    const said = sandbox.opening(box);
    check('the opening line names the worktree, the project and the commit', said.includes(box.dir) && said.includes(box.root) && real(box.root) === real(root) && said.includes(box.head), { happened: said, why: 'The user has to know where the work is happening and what it started from.', fix: 'Check opening().' });
    check('and it admits the two things a worktree does not carry', /ignores/.test(said) && /remembers/.test(said), { happened: said, why: 'node_modules and build output are not in a fresh worktree, and memory is filed under its path; a user who learns that from a broken test run will not trust the feature again.', fix: 'Keep the second line of opening().' });

    // What the agent did in there.
    fs.writeFileSync(path.join(box.dir, 'a.js'), 'export const a = 99;' + NL);
    fs.writeFileSync(path.join(box.dir, 'new.js'), 'export const c = 3;' + NL);
    const ch = sandbox.changes(box);
    check('the diff includes a file the agent created, not only ones it edited', ch.files.some((f) => /a\.js/.test(f)) && ch.files.some((f) => /new\.js/.test(f)), { happened: JSON.stringify(ch.files), why: 'A plain git diff shows no untracked file, so every new file the agent wrote would be silently dropped when the diff was taken.', fix: 'Stage with git add -A before diffing --cached.' });
    check('and the patch carries both changes', /a = 99/.test(ch.patch) && /new\.js/.test(ch.patch), { happened: ch.patch.slice(0, 300), why: 'The patch is the only thing that reaches the project.', fix: 'git diff --cached --binary.' });
    const sum = sandbox.summary(box, ch);
    check('the summary counts the files and shows the patch', /2 files changed/.test(sum) && sum.includes(box.root) && /a = 99/.test(sum), { happened: sum.slice(0, 200), why: 'Take it or drop it is a decision, and nobody can make it without seeing what changed.', fix: 'Check summary().' });
    check('a summary of nothing says nothing changed', /nothing changed/.test(sandbox.summary(box, { files: [], patch: '' })), { happened: sandbox.summary(box, { files: [], patch: '' }), why: 'Showing an empty diff as a change invites a pointless yes.', fix: 'Special-case the empty list.' });
    const saved = sandbox.savePatch(box, ch.patch);
    check('the patch can be written where the user can find it', saved === sandbox.patchPath(box) && fs.readFileSync(saved, 'utf8') === ch.patch, { happened: saved, why: 'A dropped run still has to be recoverable, or drop means lose.', fix: 'Check savePatch and patchPath.' });
    const gone = sandbox.close(box);
    check('closing removes the worktree and tells git it is gone', gone.ok === true && !fs.existsSync(box.dir) && worktrees(root).length === 1, { happened: `${gone.why}; ${worktrees(root).join(' | ')}`, why: 'A throwaway that is not thrown away fills the state directory and leaves stale entries in git worktree list forever.', fix: 'worktree remove --force then worktree prune.' });
  });

  await asyncSuite('sandbox decision expert', 'take it or drop it', async () => {
    // Taken: the change reaches the project.
    const rootA = committed();
    const boxA = sandbox.begin(rootA);
    fs.writeFileSync(path.join(boxA.dir, 'a.js'), 'export const a = 7;' + NL);
    fs.writeFileSync(path.join(boxA.dir, 'added.js'), 'export const d = 4;' + NL);
    const took = await sandbox.finish(boxA, { ask: async () => 'y', say: () => {} });
    check('yes brings the changes into the project', took.taken === true && fs.readFileSync(path.join(rootA, 'a.js'), 'utf8').includes('a = 7') && fs.existsSync(path.join(rootA, 'added.js')), { happened: `${took.taken}: ${took.why}`, why: 'If taking it does not work the sandbox is a way to lose work, not to review it.', fix: 'Check adopt(): git apply from the repository root.' });
    check('and the worktree is gone afterwards', took.ok === true && !fs.existsSync(boxA.dir) && worktrees(rootA).length === 1, { happened: `${took.closed}; ${worktrees(rootA).join(' | ')}`, why: 'Same reason as above, and now with the changes already safe there is nothing left to keep.', fix: 'finish() closes after adopting.' });

    // Dropped: the project is untouched and the patch survives.
    const rootB = committed();
    const boxB = sandbox.begin(rootB);
    fs.writeFileSync(path.join(boxB.dir, 'a.js'), 'export const a = 8;' + NL);
    const dropped = await sandbox.finish(boxB, { ask: async () => 'n', say: () => {} });
    check('no leaves the project exactly as it was', dropped.taken === false && fs.readFileSync(path.join(rootB, 'a.js'), 'utf8').includes('a = 1'), { happened: `${dropped.taken}: ${dropped.why}`, why: 'Drop is the whole reason to run in a sandbox; if it changed anything the isolation was a lie.', fix: 'Only adopt on a yes.' });
    check('but the patch is kept, so a drop is not a loss', fs.existsSync(sandbox.patchPath(boxB)) && /a = 8/.test(fs.readFileSync(sandbox.patchPath(boxB), 'utf8')) && dropped.why.includes(sandbox.patchPath(boxB)), { happened: dropped.why, why: 'A model can be right about something the user rejects in a hurry; throwing the only copy away is not a kindness.', fix: 'savePatch on the no branch and name the path.' });
    check('and it is thrown away too', !fs.existsSync(boxB.dir) && worktrees(rootB).length === 1, { happened: worktrees(rootB).join(' | '), why: 'Same as above.', fix: 'finish() closes on both branches.' });
    check('no answer at all counts as no', (await (async () => { const r = committed(); const b = sandbox.begin(r); fs.writeFileSync(path.join(b.dir, 'a.js'), 'export const a = 9;' + NL); const f = await sandbox.finish(b, {}); return f.taken === false && fs.readFileSync(path.join(r, 'a.js'), 'utf8').includes('a = 1') && !fs.existsSync(b.dir); })()), { happened: 'a run with nobody to ask changed the project', why: 'atlias exec has no terminal to answer in; treating silence as yes would edit the project with nobody asked, which is exactly what the shell guard refuses to do.', fix: 'Default to no when ask is missing.' });

    // A run that changed nothing.
    const rootC = committed();
    const boxC = sandbox.begin(rootC);
    const quiet = await sandbox.finish(boxC, { ask: async () => 'y' });
    check('a run that changed nothing says so and asks nothing', quiet.taken === false && /nothing changed/.test(quiet.why) && quiet.files.length === 0, { happened: quiet.why, why: 'Asking take or drop about an empty diff trains the user to answer without reading.', fix: 'Check the empty patch before asking.' });
    check('and still leaves no worktree', !fs.existsSync(boxC.dir) && worktrees(rootC).length === 1, { happened: worktrees(rootC).join(' | '), why: 'The commonest run is the one that changed nothing, so this is the leak that would grow fastest.', fix: 'Close on every path.' });

    // The failure case: the worktree is gone from under us.
    const rootD = committed();
    const boxD = sandbox.begin(rootD);
    fs.rmSync(boxD.dir, { recursive: true, force: true });
    const lost = await sandbox.finish(boxD, { ask: async () => 'y' });
    check('a worktree that disappeared is still cleaned out of git', lost.ok === true && worktrees(rootD).length === 1, { happened: `${lost.why}; ${lost.closed}; ${worktrees(rootD).join(' | ')}`, why: 'Never leave a worktree behind on failure means the registry too: a stale entry makes every later git worktree command complain.', fix: 'close() prunes whatever remove said, and finish() closes outside its try.' });

    // Audit A7: a git call that fails while reading the worktree is not "nothing changed".
    const rootF = committed();
    const boxF = sandbox.begin(rootF);
    fs.writeFileSync(path.join(boxF.dir, 'a.js'), 'export const a = 12; // AGENT_WORK_SENTINEL' + NL);
    const lockedDiff = (cmd, args, opts) => (args.includes('--binary') ? { status: 128, stdout: '', stderr: 'fatal: Unable to create index.lock', error: null } : core.run(cmd, args, opts));
    const unread = await sandbox.finish(boxF, { ask: async () => 'y', say: () => {} }, { run: lockedDiff });
    check('a worktree whose changes could not be read is kept, not removed as unchanged', unread.ok === false && unread.taken === false && /reading the worktree failed/.test(unread.why) && !/nothing changed/.test(unread.why) && fs.existsSync(boxF.dir) && fs.readFileSync(path.join(boxF.dir, 'a.js'), 'utf8').includes('AGENT_WORK_SENTINEL') && /kept the worktree/.test(unread.closed) && fs.readFileSync(path.join(rootF, 'a.js'), 'utf8').includes('a = 1'), { happened: `${unread.why} | ${unread.closed}`, why: 'A failed git diff read as an empty patch: the user was told nothing changed and the worktree holding the only copy of the work was force-removed.', fix: 'changes() reports a failed git call; finish() keeps an existing worktree it could not read.' });
    sandbox.close(boxF);
    const unknownStatus = sandbox.inspect(rootF, { run: (cmd, args, opts) => (args.includes('status') ? { status: 128, stdout: '', stderr: 'fatal: index file corrupt', error: null } : core.run(cmd, args, opts)) });
    check('a git status that failed refuses the sandbox instead of calling the tree clean', unknownStatus.ok === false && unknownStatus.fatal === true && unknownStatus.kind === 'unknown-status' && sandbox.dirtyFiles(rootF, { run: () => ({ status: 128, stdout: '' }) }) === null, { happened: JSON.stringify({ kind: unknownStatus.kind, fatal: unknownStatus.fatal }), why: 'An empty list from a failed git status let the sandbox start on a tree whose uncommitted work it could not see.', fix: 'dirtyFiles returns null on failure and inspect refuses on null.' });

    // Taking something that cannot be applied must not half-change the project.
    const rootE = committed();
    const boxE = sandbox.begin(rootE);
    fs.writeFileSync(path.join(boxE.dir, 'a.js'), 'export const a = 11;' + NL);
    const patch = sandbox.changes(boxE).patch;
    fs.writeFileSync(path.join(rootE, 'a.js'), 'something else entirely' + NL);
    const clash = sandbox.adopt(boxE, patch);
    check('a patch that no longer applies is refused, not forced', clash.ok === false && /unchanged/.test(clash.why) && fs.readFileSync(path.join(rootE, 'a.js'), 'utf8').includes('something else'), { happened: clash.why, why: 'git apply is all or nothing, and the user has to be told which it was; a half-applied patch is worse than none.', fix: 'Report the git apply failure and keep the patch.' });
    check('and the patch is still on disk with the command to apply it', clash.patch && fs.existsSync(clash.patch) && /git apply/.test(clash.why), { happened: clash.why, why: 'The work has to survive a conflict the harness cannot resolve.', fix: 'Keep the path and the command in the message.' });
    check('an empty patch is reported as nothing to take, not as a failure', sandbox.adopt(boxE, '   ').ok === true && /nothing to take/.test(sandbox.adopt(boxE, '').why), { happened: JSON.stringify(sandbox.adopt(boxE, '')), why: 'An empty diff is a normal outcome.', fix: 'Check the empty case first in adopt().' });
    sandbox.close(boxE);
  });

  await asyncSuite('sandbox wiring expert', 'the setting and the flag', async () => {
    check('the flag wins over the setting in both directions', agentMod.sandboxWanted({ sandbox: true }, { sandbox: false }) === true && agentMod.sandboxWanted({ sandbox: false }, { sandbox: true }) === false, { happened: `${agentMod.sandboxWanted({ sandbox: true }, { sandbox: false })} and ${agentMod.sandboxWanted({ sandbox: false }, { sandbox: true })}`, why: 'A flag that the config can override is not a flag.', fix: 'Check sandboxWanted.' });
    check('with no flag the setting decides', agentMod.sandboxWanted({}, { sandbox: true }) === true && agentMod.sandboxWanted({}, { sandbox: false }) === false, { happened: `${agentMod.sandboxWanted({}, { sandbox: true })} and ${agentMod.sandboxWanted({}, { sandbox: false })}`, why: 'Otherwise the setting does nothing.', fix: 'Same.' });
    check('the setting is off by default and has a description', core.DEFAULTS.agent.sandbox === false && agentMod.sandboxWanted({}) === false, { happened: JSON.stringify(core.DEFAULTS.agent.sandbox), why: 'Isolation costs a worktree and loses ignored files; it has to be asked for, not arrive by surprise.', fix: 'Default agent.sandbox to false.' });

    // End to end through the command line, where a user actually meets it.
    const bin = path.join(ROOT, 'bin', 'atlias.mjs');
    const cli = (args, cwd) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', timeout: 120000, env: process.env });
    const clean = committed();
    const ran = cli(['exec', '--engine', 'echo', '--sandbox', 'ping'], clean);
    check('atlias exec --sandbox runs in a worktree and reports what became of it', ran.status === 0 && /echo: ping/.test(ran.stdout) && /sandbox:/.test(ran.stdout), { happened: `exit ${ran.status}: ${(ran.stdout + ran.stderr).slice(0, 300)}`, why: 'A flag that is accepted and does nothing visible is worse than no flag.', fix: 'Check the sandbox wiring in runOnce and the --sandbox flag in bin/atlias.mjs.' });
    check('and it leaves no worktree behind', worktrees(clean).length === 1 && !fs.existsSync(path.join(clean, 'atlias-sandbox')), { happened: worktrees(clean).join(' | '), why: 'One leaked worktree per run would fill the state directory.', fix: 'runOnce finishes the sandbox before returning and closes it in a finally.' });
    const messy = committed();
    fs.writeFileSync(path.join(messy, 'a.js'), 'export const a = 5;' + NL);
    const stopped = cli(['exec', '--engine', 'echo', '--sandbox', 'ping'], messy);
    check('on a dirty tree the command refuses and exits non-zero', stopped.status === 2 && /uncommitted change/.test(stopped.stdout + stopped.stderr), { happened: `exit ${stopped.status}: ${(stopped.stdout + stopped.stderr).slice(0, 300)}`, why: 'Scripts read the exit code, and a user who asked for isolation must not get an unisolated run instead.', fix: 'Return code 2 when the sandbox refuses.' });
    check('and the refused run did not do the work anyway', !/echo: ping/.test(stopped.stdout), { happened: stopped.stdout.slice(0, 200), why: 'Refusing after running is not refusing.', fix: 'Return before the turn.' });
    const help = cli([], TMP);
    check('the help names the flag', /--sandbox/.test(help.stdout), { happened: help.stdout.slice(-400), why: 'A flag nobody can discover does not exist.', fix: 'Add it to the usage lines.' });
  });
}
