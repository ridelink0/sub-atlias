// atlias update: bring a git checkout of Atlias up to date, and nothing else.
// Gev (2026-10-17): Atlias installs on this PC are git checkouts, so an update is a fast-forward of the
// checkout from a configured source. It never resets, never discards, never pushes, never merges, and it
// refuses rather than guess: a dirty tracked file, a detached HEAD, no source, a history that has
// diverged. `--check` reports and changes nothing in the working tree (a fetch only updates the
// remote-tracking ref). Interactive and CLI only: nothing in the benchmark path imports this file.
import path from 'node:path';
import { config, ROOT, VERSION, STATE_DIR, readJson, writeJson, run } from './core.mjs';
import * as settings from './settings.mjs';

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };
const git = (root, args, timeout = 30000) => run('git', args, { cwd: root, timeout, env: GIT_ENV });
const norm = (p) => path.resolve(String(p || '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const first = (s) => String(s || '').trim().split(/\r?\n/)[0].trim();
const fail = (reason, extra = {}) => ({ ...extra, ok: false, reason });

// The version a checkout's package.json says; this file's own VERSION when it cannot be read.
export function versionAt(root = ROOT) {
  const pkg = readJson(path.join(root, 'package.json'), null);
  return pkg && pkg.version ? String(pkg.version) : VERSION;
}

// What `atlias --version` prints: the version, and for a git checkout the commit and branch it is on.
export function versionLine(root = ROOT) {
  const v = versionAt(root);
  const top = git(root, ['rev-parse', '--show-toplevel'], 5000);
  if (top.status !== 0 || norm(first(top.stdout)) !== norm(root)) return `atlias ${v}`;
  const sha = first(git(root, ['rev-parse', '--short=9', 'HEAD'], 5000).stdout);
  const branch = first(git(root, ['symbolic-ref', '--short', '-q', 'HEAD'], 5000).stdout);
  return `atlias ${v}${sha ? ` (${sha}${branch ? ' on ' + branch : ', detached'})` : ''}`;
}

// Works out where the update would come from. Returns { ok, ref, label } or { ok: false, reason }.
// source '' means the upstream of the current branch. Otherwise it is, in this order: a remote name
// (its branch of the same name as ours), remote/branch, a local ref, or a path or URL of a repository
// (fetched into FETCH_HEAD, branch of the same name as ours).
function resolveSource(root, source, branch, fetch, fetchTimeout = 120000) {
  const src = String(source || '').trim();
  const remotes = git(root, ['remote'], 5000).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const fetchFrom = (...args) => { if (!fetch) return null; const f = git(root, ['fetch', '--quiet', ...args], fetchTimeout); return f.status === 0 ? null : fail(`could not fetch from ${args[0]}: ${first(f.stderr) || f.error || 'git fetch failed'}`); };
  const sha = (ref) => { const r = git(root, ['rev-parse', '--verify', '-q', ref + '^{commit}'], 5000); return r.status === 0 ? first(r.stdout) : ''; };
  if (!src) {
    const up = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 5000);
    if (up.status !== 0) return fail(`branch ${branch} has no upstream, so there is nothing to update from. Set one with: atlias config set update.source <remote, remote/branch, or a repository path>`);
    const label = first(up.stdout);
    const remote = remotes.find((r) => label.startsWith(r + '/'));
    if (remote) { const bad = fetchFrom(remote); if (bad) return bad; }
    const s = sha(label);
    return s ? { ok: true, sha: s, label } : fail(`the upstream ${label} cannot be resolved`);
  }
  if (remotes.includes(src)) {
    const bad = fetchFrom(src); if (bad) return bad;
    const s = sha(`refs/remotes/${src}/${branch}`);
    return s ? { ok: true, sha: s, label: `${src}/${branch}` } : fail(`remote ${src} has no branch ${branch}`);
  }
  const slash = src.indexOf('/');
  const asRemote = slash > 0 ? remotes.find((r) => src.startsWith(r + '/')) : null;
  if (asRemote) {
    const bad = fetchFrom(asRemote); if (bad) return bad;
    const s = sha(`refs/remotes/${src}`);
    return s ? { ok: true, sha: s, label: src } : fail(`${src} is not a branch of remote ${asRemote}`);
  }
  const local = sha(src);
  if (local && git(root, ['check-ref-format', '--allow-onelevel', src], 5000).status === 0 && !/[\\:]/.test(src)) return { ok: true, sha: local, label: src };
  // A repository path or URL. It is fetched only when the first lines of git say it is a repository.
  if (!fetch) return fail(`${src} is not a remote or a local ref, and --no-fetch was given`);
  const bad = fetchFrom(src, branch); if (bad) return bad;
  const head = first(git(root, ['rev-parse', '--verify', '-q', 'FETCH_HEAD^{commit}'], 5000).stdout);
  return head ? { ok: true, sha: head, label: `${src} (${branch})` } : fail(`${src} has no branch ${branch}`);
}

// plan(): look, change nothing in the working tree. { ok: true, state: 'current'|'behind'|'ahead', ... }
// or { ok: false, reason }.
export function plan({ root = ROOT, source = config().update.source, fetch = true, fetchTimeout = 120000 } = {}) {
  if (git(root, ['--version'], 5000).status !== 0) return fail('git is not installed, so this copy of Atlias cannot be updated here');
  const top = git(root, ['rev-parse', '--show-toplevel'], 5000);
  if (top.status !== 0) return fail(`${root} is not a git checkout. This copy was not installed from git; update it the way it was installed (for the Claude Code plugin: /plugin update atlias@atlias)`);
  if (norm(first(top.stdout)) !== norm(root)) return fail(`${root} sits inside another repository (${first(top.stdout)}), not a checkout of Atlias of its own; refusing to touch that repository`);
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no'], 15000);
  if (dirty.status !== 0) return fail(`git status failed: ${first(dirty.stderr)}`);
  const files = dirty.stdout.split(/\r?\n/).filter(Boolean);
  if (files.length) return fail(`tracked files are changed here, so nothing is pulled (${files.length}): ${files.slice(0, 8).map((l) => l.trim()).join('; ')}${files.length > 8 ? '; ...' : ''}. Commit or stash them yourself, then run atlias update again`, { dirty: files });
  const branch = first(git(root, ['symbolic-ref', '--short', '-q', 'HEAD'], 5000).stdout);
  if (!branch) return fail('HEAD is detached (no branch is checked out), so there is no branch to fast-forward. Check out a branch first');
  const head = first(git(root, ['rev-parse', 'HEAD'], 5000).stdout);
  const src = resolveSource(root, source, branch, fetch, fetchTimeout);
  if (!src.ok) return src;
  const count = (range) => parseInt(first(git(root, ['rev-list', '--count', range], 15000).stdout), 10) || 0;
  const behind = count(`${head}..${src.sha}`);
  const ahead = count(`${src.sha}..${head}`);
  const base = { ok: true, root, branch, head, source: src.label, target: src.sha, behind, ahead, from: versionAt(root) };
  if (!behind) return { ...base, state: ahead ? 'ahead' : 'current', log: [] };
  const log = git(root, ['log', '--oneline', '--no-decorate', '-n', '40', `${head}..${src.sha}`], 15000).stdout.split(/\r?\n/).filter(Boolean);
  if (ahead) return fail(`${branch} and ${src.label} have diverged: ${ahead} commit(s) here are not in the source and ${behind} commit(s) there are not here. A fast-forward is impossible, and atlias update never merges, rebases or resets. Resolve it yourself`, { ...base, state: 'diverged', log });
  return { ...base, state: 'behind', log };
}

function describe(p) {
  const L = [`checkout ${p.root}`, `branch ${p.branch} at ${p.head.slice(0, 9)}, version ${p.from}`, `source ${p.source} at ${p.target.slice(0, 9)}`];
  if (p.state === 'current') L.push('up to date: nothing to pull');
  else if (p.state === 'ahead') L.push(`up to date: this branch is ${p.ahead} commit(s) ahead of the source, nothing to pull`);
  else L.push(`${p.behind} new commit(s):`, ...p.log.map((l) => '  ' + l), ...(p.behind > p.log.length ? [`  ... ${p.behind - p.log.length} more`] : []));
  return L;
}

// update(): plan, then (unless check) fast-forward. Always `git merge --ff-only <sha>`; nothing else changes a ref.
// { code, text }: 0 current or updated or --check reported, 1 refused or failed.
export function update({ root = ROOT, source = config().update.source, check = false, fetch = true } = {}) {
  const p = plan({ root, source, fetch });
  if (!p.ok) return { code: 1, text: ['atlias update: ' + p.reason, ...(p.log && p.log.length ? ['would have pulled:', ...p.log.map((l) => '  ' + l)] : [])].join('\n') };
  const L = describe(p);
  if (p.state !== 'behind') return { code: 0, text: L.join('\n') };
  if (check) return { code: 0, text: [...L, 'update available: run atlias update to pull it (--check changed nothing)'].join('\n') };
  const merged = git(root, ['merge', '--ff-only', '--quiet', p.target], 120000);
  if (merged.status !== 0) return { code: 1, text: [...L, `fast-forward refused by git, nothing was changed: ${first(merged.stderr) || merged.error || 'git merge --ff-only failed'}`].join('\n') };
  const now = first(git(root, ['rev-parse', 'HEAD'], 5000).stdout);
  const stat = git(root, ['diff', '--stat', '--no-color', `${p.head}..${now}`], 15000).stdout.trim().split(/\r?\n/);
  const to = versionAt(root);
  return { code: 0, text: [...L, `pulled ${p.behind} commit(s): ${p.head.slice(0, 9)} -> ${now.slice(0, 9)}, version ${p.from}${to !== p.from ? ' -> ' + to : ' (unchanged)'}`, ...stat.slice(-6), 'restart any running atlias, hook host or agent to use the new code'].join('\n') };
}

// Arguments of `atlias update` and `/update`: --check, --no-fetch (only what is already fetched is compared).
export function parseArgs(words) {
  const o = { check: false, fetch: true, bad: [] };
  for (const w of words) { if (w === '--check') o.check = true; else if (w === '--no-fetch') o.fetch = false; else o.bad.push(w); }
  return o;
}

// ---------- the offer at the start of the atlias agent ----------
// Gev (2026-10-17): when the agent starts in a terminal, look at the update source; if there are new
// commits (the fetch is the "getting it ready": nothing in the working tree changes), ask once with the
// three answers below. Lets Do It applies update() with every rule above; Maybe Later asks again after a
// day; Never ask me again writes update.autoPrompt = false. Any failure or timeout is silent.
export const OFFER_QUESTION = 'Installed, Wanna Update?';
export const OFFER_CHOICES = ['Never ask me again (you can run update to update)', 'Maybe Later', 'Lets Do It!'];
export const ASK_AGAIN_MS = 24 * 60 * 60 * 1000;
export const CHECK_AGAIN_MS = 30 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 4000;
const offerFile = () => path.join(STATE_DIR, 'update-offer.json');

// Whether the offer may be shown or even looked for. Pure: no git, no network.
export function offerDue({ isTTY, cfg = config(), now = Date.now(), seen = readJson(offerFile(), {}) || {} } = {}) {
  if (!isTTY) return false;
  if (!cfg.update || cfg.update.autoPrompt !== true) return false;
  if (Number.isFinite(seen.lastAsked) && now - seen.lastAsked < ASK_AGAIN_MS) return false;
  if (Number.isFinite(seen.lastChecked) && now - seen.lastChecked < CHECK_AGAIN_MS) return false;
  return true;
}
const remember = (patch) => { try { writeJson(offerFile(), { ...(readJson(offerFile(), {}) || {}), ...patch }); } catch { /* a state file that cannot be written must not break startup */ } };

// Returns { shown, answer?, applied?, text? }. ask(question) returns the typed answer.
export async function maybeOffer({ ask, out, isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY), root = ROOT, now = Date.now(), cfg = config() } = {}) {
  try {
    if (typeof ask !== 'function' || !offerDue({ isTTY, cfg, now })) return { shown: false };
    remember({ lastChecked: now });
    const p = plan({ root, source: cfg.update.source, fetch: true, fetchTimeout: CHECK_TIMEOUT_MS });
    if (!p.ok || p.state !== 'behind') return { shown: false };
    out(`${OFFER_QUESTION}  (${p.behind} new commit${p.behind === 1 ? '' : 's'} on ${p.source}: ${p.log[0] ? p.log[0].replace(/^[0-9a-f]+ /, '') : 'see atlias update --check'})`);
    OFFER_CHOICES.forEach((c, i) => out(`  ${i + 1}) ${c}`));
    let raw = '';
    try { raw = String(await ask('choose 1, 2 or 3 (anything else is Maybe Later): ')).trim().toLowerCase(); } catch { raw = ''; }
    remember({ lastAsked: now });
    const pick = raw === '1' || raw.startsWith('never') ? 0 : raw === '3' || raw.startsWith('lets') || raw.startsWith("let's") ? 2 : 1;
    if (pick === 0) {
      const r = settings.set('update.autoPrompt', 'false');
      out(r.ok ? 'Not asking again. atlias update updates; atlias config set update.autoPrompt true brings the question back.' : 'could not save that choice: ' + r.text);
      return { shown: true, answer: 'never' };
    }
    if (pick === 1) { out('Maybe later: asking again in a day.'); return { shown: true, answer: 'later' }; }
    const u = update({ root, source: cfg.update.source });
    out(u.text);
    if (u.code === 0) out('Updated. Restart Atlias to use the new version.');
    return { shown: true, answer: 'update', applied: u.code === 0, text: u.text };
  } catch { return { shown: false }; }
}
