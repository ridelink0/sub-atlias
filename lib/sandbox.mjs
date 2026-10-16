// A sandbox that can be proved on this machine.
//
// OpenHands' whole argument is isolation, and it rests on Docker. There is no
// Docker here, so this builds the isolation that can actually be demonstrated:
// the agent works in a throwaway git worktree of the project at its last
// commit, the diff is shown when it stops, and nothing reaches the project
// until the user says take it.
//
// Three refusals matter more than the feature itself:
//   not a repository  say so and run in the project as usual. Pretending to
//                     isolate is worse than not isolating.
//   a dirty tree      refuse to run, and name the files. A worktree is checked
//                     out from the last commit, so uncommitted work would be
//                     invisible to the agent and the diff could conflict with
//                     it on the way back.
//   any failure       never leave a worktree behind, on disk or in git's own
//                     list of them.
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, ensureDir, exists, writeText, run, clip } from './core.mjs';

// Worktrees live outside the project, or git would see them as untracked files
// in the tree they are meant to leave alone.
export const STORE = () => path.join(STATE_DIR, 'worktrees');
export const PATCHES = () => path.join(STATE_DIR, 'patches');

const git = (args, cwd, deps = {}) => (deps.run || run)('git', args, { cwd, timeout: deps.timeout || 120000 });
const won = (r) => Boolean(r) && r.status === 0;
const said = (r) => String((r && r.stdout) || '').trim();
const oops = (r) => clip(String(`${(r && r.stderr) || ''} ${(r && r.error) || ''}`).trim() || 'git said nothing at all', 300);

export function repoRoot(cwd, deps = {}) {
  const r = git(['rev-parse', '--show-toplevel'], cwd, deps);
  return won(r) && said(r) ? path.resolve(said(r).split(/\r?\n/)[0]) : null;
}
// Uncommitted work as git counts it: staged, unstaged and untracked alike.
// null when git status failed: an unknown tree is not a clean one.
export function dirtyFiles(cwd, deps = {}) {
  const r = git(['status', '--porcelain'], cwd, deps);
  return won(r) ? said(r).split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : null;
}
// A repository with no commit has nothing to check a worktree out from.
export function hasCommit(cwd, deps = {}) {
  return won(git(['rev-parse', '--verify', 'HEAD'], cwd, deps));
}
export function headSha(cwd, deps = {}) {
  const r = git(['rev-parse', '--short', 'HEAD'], cwd, deps);
  return won(r) ? said(r) : '';
}

// Can this project be isolated, and if not, why not? fatal means the caller
// must not run at all: the user asked for isolation and running without it
// anyway is the pretending this exists to stop.
export function inspect(cwd, deps = {}) {
  const probe = git(['rev-parse', '--show-toplevel'], cwd, deps);
  if (probe && probe.error && /ENOENT/i.test(probe.error)) return { ok: false, fatal: false, kind: 'no-git', why: 'git is not on the PATH here, so there is no worktree to make.' };
  if (!won(probe) || !said(probe)) return { ok: false, fatal: false, kind: 'no-repo', why: `${cwd} is not inside a git repository, so there is no commit to check a worktree out from.` };
  const root = path.resolve(said(probe).split(/\r?\n/)[0]);
  if (!hasCommit(root, deps)) return { ok: false, fatal: false, kind: 'no-commit', root, why: `${root} is a git repository with no commit yet, and a worktree is checked out from a commit.` };
  const dirty = dirtyFiles(root, deps);
  if (dirty === null) return { ok: false, fatal: true, kind: 'unknown-status', root, why: `refused: git status failed in ${root}, so whether it has uncommitted work is unknown, and a worktree from the last commit could hide that work or conflict with it on the way back. Run git status there and try again, or run without the sandbox.` };
  if (dirty.length) {
    const names = dirty.slice(0, 5).map((l) => l.replace(/^\S+\s+/, ''));
    return {
      ok: false,
      fatal: true,
      kind: 'dirty',
      root,
      dirty,
      why: `refused: ${root} has ${dirty.length} uncommitted change${dirty.length === 1 ? '' : 's'} (${names.join(', ')}${dirty.length > 5 ? `, and ${dirty.length - 5} more` : ''}). A worktree is checked out from the last commit, so the agent would not see that work and its diff could conflict with it on the way back. Commit or stash first, or run without the sandbox.`,
    };
  }
  return { ok: true, fatal: false, kind: 'clean', root, head: headSha(root, deps) };
}

// A path this module is allowed to delete. Everything that removes a directory
// goes through it, so a bug here can never reach the project itself.
export function insideStore(dir) {
  const r = path.relative(STORE(), path.resolve(String(dir || '')));
  return Boolean(r) && !r.startsWith('..') && !path.isAbsolute(r);
}
function scrub(root, dir, deps) {
  if (exists(dir) && insideStore(dir)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* reported by the caller */ } }
  git(['worktree', 'prune'], root, deps);
  return exists(dir);
}

export function begin(cwd, deps = {}) {
  const seen = inspect(cwd, deps);
  if (!seen.ok) return { ...seen, isolated: false, dir: path.resolve(cwd) };
  const stamp = deps.stamp || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const name = `${path.basename(seen.root).replace(/[^A-Za-z0-9._-]+/g, '-') || 'project'}-${stamp}`;
  const dir = path.join(STORE(), name);
  ensureDir(STORE());
  const r = git(['worktree', 'add', '--detach', dir, 'HEAD'], seen.root, deps);
  if (!won(r) || !exists(path.join(dir, '.git'))) {
    scrub(seen.root, dir, deps);
    return { ok: false, isolated: false, fatal: true, kind: 'failed', root: seen.root, dir: path.resolve(cwd), why: `refused: the worktree could not be made, so nothing is isolated: ${oops(r)}` };
  }
  return { ok: true, isolated: true, fatal: false, kind: 'worktree', root: seen.root, head: seen.head, name, dir };
}

// What the user is told when the agent starts. A fallback says so in plain
// words, including the two things a worktree does not carry.
export function opening(box) {
  if (!box) return '';
  if (box.isolated) {
    return [
      `sandbox: the agent works in a throwaway worktree at ${box.dir}, checked out from ${box.root} at ${box.head}. ${box.root} is not touched until you take the diff.`,
      'sandbox: files git ignores (node_modules, build output) are not in there, and anything this run remembers is filed under the worktree path, not the project.',
    ].join('\n');
  }
  if (box.fatal) return box.why;
  return `sandbox: ${box.why} Nothing is isolated; the agent runs in ${box.dir} exactly as it does without the sandbox.`;
}

// Everything the run changed, staged first so new files count too: a plain
// git diff would miss every file the agent created.
export function changes(box, deps = {}) {
  if (!box || !box.isolated) return { files: [], patch: '', error: null };
  const add = git(['add', '-A'], box.dir, deps);
  const names = git(['diff', '--cached', '--name-status'], box.dir, deps);
  const files = won(names) ? said(names).split(/\r?\n/).filter(Boolean).map((l) => l.replace(/\t+/g, ' ')) : [];
  const body = git(['diff', '--cached', '--binary'], box.dir, deps);
  // A git call that failed has not said the run changed nothing: error says so,
  // and finish() then keeps the worktree instead of removing the only copy.
  const failed = [add, names, body].find((r) => !won(r));
  return { files, patch: won(body) ? String(body.stdout || '') : '', error: failed ? oops(failed) : null };
}

export function summary(box, ch) {
  if (!ch || !ch.files.length) return `sandbox: nothing changed in ${box.dir}.`;
  const shown = ch.files.slice(0, 40).map((f) => `  ${f}`);
  if (ch.files.length > 40) shown.push(`  [${ch.files.length - 40} more]`);
  return [`sandbox: ${ch.files.length} file${ch.files.length === 1 ? '' : 's'} changed in the worktree, against ${box.root}:`, ...shown, '', clip(ch.patch, 6000)].join('\n');
}

export function patchPath(box) { return path.join(PATCHES(), `${(box && box.name) || 'sandbox'}.patch`); }
// The patch is kept whatever the answer, so a dropped run is still recoverable.
export function savePatch(box, patch) { const p = patchPath(box); writeText(p, String(patch || '')); return p; }

export function adopt(box, patch, deps = {}) {
  if (!String(patch || '').trim()) return { ok: true, empty: true, patch: '', why: `nothing to take: the run changed no file git tracks, so ${box.root} is already up to date` };
  const p = savePatch(box, patch);
  const r = (deps.run || run)('git', ['apply', '--whitespace=nowarn', p], { cwd: box.root, timeout: deps.timeout || 120000 });
  if (won(r)) return { ok: true, patch: p, why: `sandbox: took the changes into ${box.root}. The patch is also kept at ${p}.` };
  return { ok: false, patch: p, why: `sandbox: git apply refused the change, so ${box.root} is unchanged: ${oops(r)}. The patch is kept at ${p}; take it by hand with: git -C ${box.root} apply ${p}` };
}

export function close(box, deps = {}) {
  if (!box || !box.isolated) return { ok: true, why: 'no worktree was made, so there is nothing to remove' };
  const r = git(['worktree', 'remove', '--force', '--force', box.dir], box.root, deps);
  if (scrub(box.root, box.dir, deps)) return { ok: false, why: `the worktree at ${box.dir} is still there: ${oops(r)}. Remove it with: git -C ${box.root} worktree remove --force ${box.dir}` };
  return { ok: true, why: `removed the worktree ${box.dir}` };
}

// Show the diff, take it or drop it, and remove the worktree either way. The
// close is outside the try on purpose: a failure reading the worktree must not
// be a reason to leave one behind.
export async function finish(box, { ask, say } = {}, deps = {}) {
  if (!box || !box.isolated) return { ok: true, taken: false, files: [], why: 'no worktree was made, so there is nothing to take back', closed: '' };
  let taken = false;
  let files = [];
  let why = '';
  let unread = false;
  try {
    const ch = changes(box, deps);
    files = ch.files;
    if (ch.error) { unread = true; why = `sandbox: reading the worktree failed (${ch.error}), so nothing was taken and nothing is known about what the run changed. ${box.root} is untouched.`; }
    else if (!ch.patch.trim()) why = `sandbox: nothing changed in the worktree, so there is nothing to take. ${box.root} is untouched.`;
    else {
      if (say) say(summary(box, ch));
      const answer = ask ? String(await ask(`take these ${ch.files.length} change${ch.files.length === 1 ? '' : 's'} into ${box.root}? [y/N] `)).trim().toLowerCase() : 'n';
      if (answer === 'y' || answer === 'yes') { const a = adopt(box, ch.patch, deps); taken = a.ok; why = a.why; }
      else why = `sandbox: dropped, so ${box.root} is unchanged. The patch is kept at ${savePatch(box, ch.patch)}; take it later with: git -C ${box.root} apply ${patchPath(box)}`;
    }
  } catch (e) {
    unread = true;
    why = `sandbox: reading the worktree failed, so nothing was taken: ${clip(e && e.message ? e.message : String(e), 200)}`;
  }
  // A worktree that could not be read may hold the run's only copy of its work:
  // keep it and say where. One that is already gone is still pruned from git.
  if (unread && exists(box.dir)) return { ok: false, taken, files, why, closed: `kept the worktree ${box.dir}, because its changes could not be read; look at it with git -C ${box.dir} status, and remove it with: git -C ${box.root} worktree remove --force ${box.dir}` };
  const c = close(box, deps);
  return { ok: c.ok, taken, files, why, closed: c.why };
}
