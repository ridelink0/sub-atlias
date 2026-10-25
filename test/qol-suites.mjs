// Quality-of-life features (Gev 2026-10-17): atlias update and the update offer, @file mentions, /context,
// /rename, /release-notes, the long-turn notification. Everything uses temp git repos and scripted prompts;
// no network, no model. Planted breaks: a copy of the module with one safety line removed must be caught by
// the same scenario that the real module passes. Loaded by test/run.mjs.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as commands from '../lib/commands.mjs';
import * as settings from '../lib/settings.mjs';
import * as updater from '../lib/update.mjs';
import * as qol from '../lib/qol.mjs';

export default async function qolSuites({ suite, asyncSuite, check, core, agentMod, TMP, ROOT, fs, path }) {
  let n = 0;
  const NL = String.fromCharCode(10);
  const GENV = { GIT_AUTHOR_NAME: 'Gev', GIT_AUTHOR_EMAIL: 'gev@example.com', GIT_COMMITTER_NAME: 'Gev', GIT_COMMITTER_EMAIL: 'gev@example.com' };
  const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GENV } }); return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; };
  const dir = (tag) => { const d = path.join(TMP, 'qol', `${tag}${process.pid}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
  const commit = (repo, file, text, msg) => { fs.writeFileSync(path.join(repo, file), text); git(repo, 'add', file); git(repo, 'commit', '-q', '-m', msg || `change ${file}`); return git(repo, 'rev-parse', 'HEAD').out; };
  // origin (a bare-ish normal repo) and a clone of it, the way an install is a checkout of a source.
  const pair = () => {
    const origin = dir('origin');
    git(origin, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(origin, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
    commit(origin, 'a.txt', 'one' + NL, 'first');
    git(origin, 'add', '.'); git(origin, 'commit', '-q', '-m', 'pkg');
    const install = dir('install');
    fs.rmSync(install, { recursive: true, force: true });
    git(TMP, 'clone', '-q', origin, install);
    return { origin, install };
  };
  const head = (r) => git(r, 'rev-parse', 'HEAD').out;
  const U = (mod, install, opts = {}) => mod.update({ root: install, source: '', ...opts });

  // A module copy with one line changed, importing the real lib files by absolute URL.
  const mutant = async (file, from, to, tag) => {
    let src = fs.readFileSync(path.join(ROOT, 'lib', file), 'utf8');
    if (!src.includes(from)) throw new Error(`planted break target not found in ${file}: ${from}`);
    src = src.replace(from, to).replace(/from '\.\/([\w-]+)\.mjs'/g, (m, f) => `from '${pathToFileURL(path.join(ROOT, 'lib', f + '.mjs')).href}'`);
    const p = path.join(TMP, 'qol', `mutant-${tag}-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(p, src);
    return import(pathToFileURL(p).href);
  };

  // ---- scenarios: each returns a list of violations; [] means the safety line held ----
  const scDirty = (mod) => {
    const { origin, install } = pair();
    commit(origin, 'b.txt', 'new' + NL, 'second');
    fs.writeFileSync(path.join(install, 'a.txt'), 'my local edit' + NL);
    const before = head(install);
    const r = U(mod, install);
    const v = [];
    if (head(install) !== before) v.push('HEAD moved on a dirty tree');
    if (fs.readFileSync(path.join(install, 'a.txt'), 'utf8') !== 'my local edit' + NL) v.push('the local edit was overwritten');
    if (r.code === 0) v.push('exit code 0 on a dirty tree');
    return v;
  };
  const scDiverged = (mod) => {
    const { origin, install } = pair();
    commit(origin, 'b.txt', 'theirs' + NL, 'remote work');
    const mine = commit(install, 'c.txt', 'mine' + NL, 'local work');
    const r = U(mod, install);
    const v = [];
    if (head(install) !== mine) v.push('HEAD moved although the history diverged (reset or merge)');
    if (!fs.existsSync(path.join(install, 'c.txt'))) v.push('a local commit was lost');
    if (git(install, 'rev-list', '--merges', '--count', 'HEAD').out !== '0') v.push('a merge commit was made');
    if (r.code === 0) v.push('exit code 0 on diverged history');
    return v;
  };
  const scCheck = (mod) => {
    const { origin, install } = pair();
    commit(origin, 'b.txt', 'new' + NL, 'second');
    const before = head(install);
    const r = U(mod, install, { check: true });
    const v = [];
    if (head(install) !== before) v.push('--check moved HEAD');
    if (fs.existsSync(path.join(install, 'b.txt'))) v.push('--check changed the working tree');
    if (!/second/.test(r.text)) v.push('--check did not name the new commit');
    return v;
  };
  const answers = (list) => { const q = [...list]; return async () => { if (!q.length) throw new Error('prompt closed'); return q.shift(); }; };
  const offerRun = async (mod, install, answer, { isTTY = true, now = Date.now(), cfg } = {}) => {
    const out = [];
    const r = await mod.maybeOffer({ ask: answers([answer]), out: (s) => out.push(String(s)), isTTY, root: install, now, cfg: cfg || core.config() });
    return { r, out };
  };
  const clearOffer = () => { try { fs.rmSync(path.join(core.STATE_DIR, 'update-offer.json'), { force: true }); } catch { /* none */ } settings.reset('update.autoPrompt'); };
  const scOfferNonTty = async (mod) => {
    clearOffer();
    const { origin, install } = pair();
    commit(origin, 'b.txt', 'new' + NL, 'second');
    const { r, out } = await offerRun(mod, install, '3', { isTTY: false });
    const v = [];
    if (r.shown || out.length) v.push('the offer was shown with no terminal');
    if (head(install) === head(origin)) v.push('an update was applied with no terminal');
    return v;
  };
  const scOfferNeedsYes = async (mod) => {
    clearOffer();
    const { origin, install } = pair();
    commit(origin, 'b.txt', 'new' + NL, 'second');
    const before = head(install);
    await offerRun(mod, install, '2');
    const v = [];
    if (head(install) !== before) v.push('Maybe Later applied the update');
    clearOffer();
    await offerRun(mod, install, '1');
    if (head(install) !== before) v.push('Never ask me again applied the update');
    clearOffer();
    await offerRun(mod, install, 'what?');
    if (head(install) !== before) v.push('an unclear answer applied the update');
    clearOffer();
    return v;
  };
  const scOfferDirty = async (mod) => {
    clearOffer();
    const { origin, install } = pair();
    commit(origin, 'b.txt', 'new' + NL, 'second');
    fs.writeFileSync(path.join(install, 'a.txt'), 'local' + NL);
    const before = head(install);
    await offerRun(mod, install, '3');
    clearOffer();
    return head(install) !== before ? ['Lets Do It applied the update on a dirty tree'] : [];
  };

  await asyncSuite('update expert', 'atlias update: fast-forward only, never destructive', async () => {
    let { origin, install } = pair();
    let r = U(updater, install);
    check('a checkout that matches its source is up to date and nothing changes', r.code === 0 && /up to date/.test(r.text), { happened: r.text, why: 'Nothing to pull must not be an error.', fix: 'plan() state current.' });
    const c2 = commit(origin, 'b.txt', 'new' + NL, 'add b with a recognizable subject');
    const before = head(install);
    r = U(updater, install, { check: true });
    check('--check names the new commit and changes nothing', r.code === 0 && /recognizable subject/.test(r.text) && /update available/.test(r.text) && head(install) === before && !fs.existsSync(path.join(install, 'b.txt')), { happened: r.text + ' ' + head(install), why: 'Gev asked for a report-only mode.', fix: 'Return before the merge when check is set.' });
    r = U(updater, install);
    check('update fast-forwards to the source and prints what was pulled', r.code === 0 && head(install) === c2 && fs.readFileSync(path.join(install, 'b.txt'), 'utf8') .trim() === 'new' && /recognizable subject/.test(r.text) && /pulled 1 commit/.test(r.text) && /restart/.test(r.text) && /b\.txt/.test(r.text), { happened: r.text, why: 'The update must apply and say what it did.', fix: 'merge --ff-only, then print the log and diff stat.' });
    check('the source repository is untouched by an update (nothing is pushed)', head(origin) === c2 && git(origin, 'status', '--porcelain').out === '', { happened: head(origin), why: 'Gev: never push.', fix: 'update.mjs must not run git push.' });
    r = U(updater, install);
    check('a second update is a no-op', r.code === 0 && /up to date/.test(r.text), { happened: r.text, why: 'Idempotent.', fix: 'state current.' });

    ({ origin, install } = pair());
    const mine = commit(install, 'c.txt', 'mine' + NL, 'my own commit');
    r = U(updater, install);
    check('a branch ahead of its source has nothing to pull and keeps its commit', r.code === 0 && /ahead/.test(r.text) && head(install) === mine && head(origin) !== mine, { happened: r.text, why: 'Ahead is not an error and must not push.', fix: 'state ahead.' });

    ({ origin, install } = pair());
    commit(origin, 'b.txt', 'new' + NL, 'second');
    fs.writeFileSync(path.join(install, 'a.txt'), 'edited' + NL);
    const dirtyHead = head(install);
    r = U(updater, install);
    check('a changed tracked file refuses the update and the edit survives', r.code === 1 && /tracked files are changed/.test(r.text) && /a\.txt/.test(r.text) && head(install) === dirtyHead && fs.readFileSync(path.join(install, 'a.txt'), 'utf8') === 'edited' + NL, { happened: r.text, why: 'Never discard Gev\'s work.', fix: 'plan() refuses on git status --porcelain --untracked-files=no.' });
    check('--check on a dirty tree refuses the same way', U(updater, install, { check: true }).code === 1, { happened: '', why: 'Same rules for the report.', fix: 'plan() before the check branch.' });

    ({ origin, install } = pair());
    commit(origin, 'b.txt', 'theirs' + NL, 'remote');
    const mine2 = commit(install, 'c.txt', 'mine' + NL, 'local');
    r = U(updater, install);
    check('diverged history is refused: no merge, no reset, local commit kept', r.code === 1 && /diverged/.test(r.text) && /fast-forward is impossible/.test(r.text) && head(install) === mine2, { happened: r.text, why: 'A fast-forward is impossible; the answer is a refusal.', fix: 'Refuse when ahead and behind are both non-zero.' });

    ({ origin, install } = pair());
    commit(origin, 'new.txt', 'from origin' + NL, 'adds new.txt');
    fs.writeFileSync(path.join(install, 'new.txt'), 'my untracked file' + NL);
    const keep = head(install);
    r = U(updater, install);
    check('an untracked file that the update would overwrite stops it and survives', r.code === 1 && head(install) === keep && fs.readFileSync(path.join(install, 'new.txt'), 'utf8') === 'my untracked file' + NL, { happened: r.text, why: 'git merge --ff-only aborts rather than clobber; update must not force it.', fix: 'Never pass -f or use reset/checkout.' });

    ({ origin, install } = pair());
    git(install, 'checkout', '-q', '--detach');
    r = U(updater, install);
    check('a detached HEAD is refused', r.code === 1 && /detached/.test(r.text), { happened: r.text, why: 'No branch to fast-forward.', fix: 'symbolic-ref check.' });

    ({ origin, install } = pair());
    git(install, 'branch', '--unset-upstream');
    r = U(updater, install);
    check('no upstream and no update.source: refused, and the message names the setting', r.code === 1 && /update\.source/.test(r.text), { happened: r.text, why: 'The user needs to know how to fix it.', fix: 'resolveSource message.' });
    const c3 = commit(origin, 'b.txt', 'new' + NL, 'second');
    r = U(updater, install, { source: origin });
    check('update.source as a repository path fast-forwards from it', r.code === 0 && head(install) === c3, { happened: r.text, why: 'Gev: a configured source.', fix: 'FETCH_HEAD branch.' });

    ({ origin, install } = pair());
    git(install, 'remote', 'add', 'upstream', origin);
    const c4 = commit(origin, 'b.txt', 'new' + NL, 'second');
    r = U(updater, install, { source: 'upstream' });
    check('update.source as a remote name uses its branch of the same name', r.code === 0 && head(install) === c4, { happened: r.text, why: 'Remote name form.', fix: 'resolveSource remotes.includes.' });
    r = U(updater, install, { source: 'no-such-remote-or-path' });
    check('an unknown source is refused with a reason', r.code === 1 && /could not fetch|no branch|not a/.test(r.text), { happened: r.text, why: 'Never guess.', fix: 'fail() paths.' });

    const plainDir = dir('plain');
    r = updater.update({ root: plainDir, source: '' });
    check('a folder that is not a git checkout is refused and untouched', r.code === 1 && /not a git checkout|inside another repository/.test(r.text) && fs.readdirSync(plainDir).length === 0, { happened: r.text, why: 'Plugin-cache installs update another way.', fix: 'rev-parse --show-toplevel.' });
    ({ origin, install } = pair());
    const sub = path.join(install, 'sub'); fs.mkdirSync(sub);
    r = updater.update({ root: sub, source: '' });
    check('a folder inside some other repository is refused', r.code === 1 && /another repository/.test(r.text), { happened: r.text, why: 'Never touch a repository that is not an Atlias checkout of its own.', fix: 'compare toplevel with root.' });

    ({ origin, install } = pair());
    const pl = updater.plan({ root: install, source: '' });
    check('plan() looks without changing anything: current state, version, and parseArgs / offerDue / versionAt answer', pl.ok && pl.state === 'current' && updater.versionAt(install) === '1.0.0' && updater.parseArgs(['--check']).check === true && updater.parseArgs(['x']).bad[0] === 'x' && updater.offerDue({ isTTY: true, cfg: { update: { autoPrompt: true } }, now: 1, seen: {} }) === true && updater.offerDue({ isTTY: true, cfg: { update: { autoPrompt: true } }, now: 1000, seen: { lastAsked: 900 } }) === false && updater.offerDue({ isTTY: false, cfg: { update: { autoPrompt: true } }, now: 1, seen: {} }) === false, { happened: JSON.stringify(pl), why: 'The pure parts.', fix: 'See update.mjs.' });
    void origin;
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'update.mjs'), 'utf8');
    const banned = /['"](reset|push|checkout|clean|stash|rebase|restore|rm|--hard|--force|-f)['"]|git\(root, \[['"]merge['"], (?!['"]--ff-only['"])/;
    check('update.mjs never names a destructive git operation', !banned.test(src.replace(/^\s*\/\/.*$/gm, '')), { happened: String((banned.exec(src) || [])[0]), why: 'Gev: never reset or discard work, never push.', fix: 'Only fetch, rev-parse, rev-list, log, diff, status and merge --ff-only.' });
    check('the only ref-changing call is merge --ff-only', (src.match(/['"]merge['"]/g) || []).length === 1 && /\['merge', '--ff-only'/.test(src), { happened: '', why: 'One place moves the branch.', fix: 'Keep a single merge --ff-only.' });

    check('the safety scenarios pass on the real module', scDirty(updater).length === 0 && scDiverged(updater).length === 0 && scCheck(updater).length === 0, { happened: JSON.stringify([scDirty(updater), scDiverged(updater), scCheck(updater)]), why: 'Baseline for the planted breaks.', fix: 'See the scenarios.' });
    const m1 = await mutant('update.mjs', 'if (files.length) return fail(', 'if (false) return fail(', 'dirty');
    check('PLANTED BREAK: without the dirty-tree refusal the dirty scenario is caught', scDirty(m1).length > 0, { happened: JSON.stringify(scDirty(m1)), why: 'The test must be able to see the break.', fix: 'Strengthen scDirty.' });
    // both lines removed together: reset --hard over a diverged branch
    let m2both = null;
    {
      let s = fs.readFileSync(path.join(ROOT, 'lib', 'update.mjs'), 'utf8').replace("git(root, ['merge', '--ff-only', '--quiet', p.target], 120000)", "git(root, ['reset', '--hard', p.target], 120000)").replace('if (ahead) return fail(', 'if (false) return fail(').replace("if (p.state !== 'behind') return", "if (false) return").replace(/from '\.\/([\w-]+)\.mjs'/g, (m, f) => `from '${pathToFileURL(path.join(ROOT, 'lib', f + '.mjs')).href}'`);
      const pth = path.join(TMP, 'qol', `mutant-both-${process.pid}-${++n}.mjs`); fs.writeFileSync(pth, s); m2both = await import(pathToFileURL(pth).href);
    }
    check('PLANTED BREAK: reset --hard with the divergence refusal removed loses local work and is caught', scDiverged(m2both).length > 0, { happened: JSON.stringify(scDiverged(m2both)), why: 'The test must be able to see a reset.', fix: 'Strengthen scDiverged.' });
    const m3 = await mutant('update.mjs', 'if (check) return {', 'if (false) return {', 'check');
    check('PLANTED BREAK: without the --check early return the report-only scenario is caught', scCheck(m3).length > 0, { happened: JSON.stringify(scCheck(m3)), why: 'The test must be able to see the break.', fix: 'Strengthen scCheck.' });
  });

  await asyncSuite('update offer expert', 'the update offer at agent start: three answers, once a day, silent otherwise', async () => {
    clearOffer();
    let { origin, install } = pair();
    let { r, out } = await offerRun(updater, install, '2');
    check('with nothing new there is no offer and no output', !r.shown && out.length === 0, { happened: JSON.stringify(out), why: 'Silent when current.', fix: 'maybeOffer returns unless behind.' });
    clearOffer();
    commit(origin, 'b.txt', 'new' + NL, 'a change to offer');
    const before = head(install);
    const t0 = Date.now();
    ({ r, out } = await offerRun(updater, install, '2', { now: t0 }));
    check('the question and the three choices are worded exactly', r.shown && out[0].startsWith('Installed, Wanna Update?') && out[1] === '  1) Never ask me again (you can run update to update)' && out[2] === '  2) Maybe Later' && out[3] === '  3) Lets Do It!', { happened: JSON.stringify(out.slice(0, 4)), why: 'Gev specified the wording.', fix: 'OFFER_QUESTION and OFFER_CHOICES.' });
    check('the offer says how many commits and what the newest is', /1 new commit/.test(out[0]) && /a change to offer/.test(out[0]), { happened: out[0], why: 'The person should know what they are accepting.', fix: 'Build the first line from plan().' });
    check('Maybe Later changes nothing in the install', r.answer === 'later' && head(install) === before, { happened: JSON.stringify(r), why: 'No yes, no update.', fix: 'Apply only on choice 3.' });
    check('the fetch got the update ready without applying it', git(install, 'rev-parse', 'origin/main').out === head(origin) && head(install) === before, { happened: '', why: 'Ready in the background, nothing applied.', fix: 'plan() fetches only.' });
    ({ r } = await offerRun(updater, install, '3', { now: t0 + 60 * 60 * 1000 }));
    check('after Maybe Later it does not ask again within a day', !r.shown && head(install) === before, { happened: JSON.stringify(r), why: 'At most once a day.', fix: 'lastAsked in update-offer.json.' });
    ({ r, out } = await offerRun(updater, install, '3', { now: t0 + 25 * 60 * 60 * 1000 }));
    check('after a day it asks again, and Lets Do It applies the fast-forward and says to restart', r.shown && r.answer === 'update' && r.applied === true && head(install) === head(origin) && fs.existsSync(path.join(install, 'b.txt')) && out.some((l) => /Restart Atlias/.test(l)), { happened: JSON.stringify(out), why: 'Gev: Lets Do It applies and says to restart.', fix: 'maybeOffer pick 2.' });

    clearOffer();
    ({ origin, install } = pair());
    commit(origin, 'b.txt', 'new' + NL, 'second');
    const b2 = head(install);
    ({ r, out } = await offerRun(updater, install, '1'));
    check('Never ask me again stores update.autoPrompt = false and applies nothing', r.answer === 'never' && core.config().update.autoPrompt === false && head(install) === b2, { happened: JSON.stringify(r) + ' ' + JSON.stringify(core.config().update), why: 'Gev: after that only atlias update updates.', fix: 'settings.set update.autoPrompt false.' });
    fs.rmSync(path.join(core.STATE_DIR, 'update-offer.json'), { force: true });
    ({ r } = await offerRun(updater, install, '3', { now: Date.now() + 1e9 }));
    check('with autoPrompt false it never asks again, even long after', !r.shown && head(install) === b2, { happened: JSON.stringify(r), why: 'The setting is the switch.', fix: 'offerDue reads cfg.update.autoPrompt.' });
    check('atlias update still works by hand afterwards', U(updater, install).code === 0 && head(install) === head(origin), { happened: '', why: 'Gev: you can run update to update.', fix: 'The manual path is separate.' });
    check('autoPrompt is settable back with the settings commands and described', settings.set('update.autoPrompt', 'true').ok && core.config().update.autoPrompt === true && settings.rows().find((x) => x.id === 'update.autoPrompt').about.length > 40, { happened: '', why: 'Gev: settable back with atlias config or /settings.', fix: 'DEFAULTS and DESCRIPTIONS.' });
    clearOffer();

    ({ origin, install } = pair());
    commit(origin, 'b.txt', 'new' + NL, 'second');
    const b3 = head(install);
    ({ r, out } = await offerRun(updater, install, '3', { isTTY: false }));
    check('with no terminal (exec, eval, --once, a pipe) nothing is shown, asked or applied', !r.shown && out.length === 0 && head(install) === b3, { happened: JSON.stringify(out), why: 'Gev: never in a non-TTY run.', fix: 'offerDue isTTY.' });
    let asked = 0;
    await updater.maybeOffer({ ask: async () => { asked++; return '3'; }, out: () => {}, isTTY: false, root: install, cfg: core.config() });
    check('and the prompt function is not even called', asked === 0, { happened: String(asked), why: 'Silence.', fix: 'Return before asking.' });
    const quiet = [];
    const bad = await updater.maybeOffer({ ask: async () => '3', out: (s) => quiet.push(s), isTTY: true, root: path.join(TMP, 'qol', 'not-there'), cfg: core.config() });
    const noGit = await updater.maybeOffer({ ask: async () => '3', out: (s) => quiet.push(s), isTTY: true, root: dir('nogit'), cfg: core.config() });
    check('a failed check (missing folder, not a checkout) prints nothing and does not throw', !bad.shown && !noGit.shown && quiet.length === 0, { happened: JSON.stringify(quiet), why: 'Gev: never blocks or breaks startup.', fix: 'catch around the whole offer.' });
    clearOffer();
    const { origin: o2, install: i2 } = pair();
    git(i2, 'remote', 'set-url', 'origin', path.join(TMP, 'qol', 'gone-repo'));
    const t1 = Date.now();
    const slow = await updater.maybeOffer({ ask: async () => '3', out: (s) => quiet.push(s), isTTY: true, root: i2, cfg: core.config() });
    check('an unreachable source is silent and quick', !slow.shown && quiet.length === 0 && Date.now() - t1 < 15000, { happened: `${Date.now() - t1} ms`, why: 'The fetch is capped at a few seconds.', fix: 'CHECK_TIMEOUT_MS.' });
    void o2;
    clearOffer();
    check('the cap on the check is a few seconds', updater.CHECK_TIMEOUT_MS <= 5000 && updater.ASK_AGAIN_MS === 86400000, { happened: String(updater.CHECK_TIMEOUT_MS), why: 'Gev.', fix: 'Constants.' });

    check('the offer scenarios pass on the real module', (await scOfferNonTty(updater)).length === 0 && (await scOfferNeedsYes(updater)).length === 0 && (await scOfferDirty(updater)).length === 0, { happened: JSON.stringify([await scOfferNonTty(updater), await scOfferNeedsYes(updater), await scOfferDirty(updater)]), why: 'Baseline for the planted breaks.', fix: 'See the scenarios.' });
    const p1 = await mutant('update.mjs', 'if (!isTTY) return false;', '', 'tty');
    check('PLANTED BREAK: offer shown in a non-TTY run is caught', (await scOfferNonTty(p1)).length > 0, { happened: JSON.stringify(await scOfferNonTty(p1)), why: 'The test must see it.', fix: 'Strengthen scOfferNonTty.' });
    let p2src = fs.readFileSync(path.join(ROOT, 'lib', 'update.mjs'), 'utf8').replace('if (pick === 0) {', 'if (false) {').replace('if (pick === 1) {', 'if (false) {').replace(/from '\.\/([\w-]+)\.mjs'/g, (m, f) => `from '${pathToFileURL(path.join(ROOT, 'lib', f + '.mjs')).href}'`);
    const p2p = path.join(TMP, 'qol', `mutant-yes-${process.pid}-${++n}.mjs`); fs.writeFileSync(p2p, p2src);
    const p2all = await import(pathToFileURL(p2p).href);
    check('PLANTED BREAK: applying without Lets Do It is caught', (await scOfferNeedsYes(p2all)).length > 0, { happened: JSON.stringify(await scOfferNeedsYes(p2all)), why: 'The test must see it.', fix: 'Strengthen scOfferNeedsYes.' });
    const p3 = await mutant('update.mjs', 'if (files.length) return fail(', 'if (false) return fail(', 'dirtyoffer');
    check('PLANTED BREAK: applying on a dirty tree through the offer is caught', (await scOfferDirty(p3)).length > 0, { happened: JSON.stringify(await scOfferDirty(p3)), why: 'The test must see it.', fix: 'Strengthen scOfferDirty.' });
    clearOffer();
  });

  suite('version expert', 'versions agree and atlias --version shows the real one', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    check('package.json and core.VERSION are 4.0.0', pkg.version === '4.0.0' && core.VERSION === '4.0.0', { happened: `${pkg.version} / ${core.VERSION}`, why: 'Gev: bump to 4.0.0.', fix: 'Bump all manifests.' });
    const line = updater.versionLine(ROOT);
    check('--version prints the version from package.json with the commit of a checkout', line.startsWith('atlias 4.0.0') && /\([0-9a-f]{7,}/.test(line), { happened: line, why: 'The real version, not a guess.', fix: 'versionLine.' });
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'atlias.mjs'), '--version'], { encoding: 'utf8' });
    check('the CLI answers --version and version with it', r.status === 0 && r.stdout.startsWith('atlias 4.0.0'), { happened: r.stdout + r.stderr, why: 'End to end.', fix: 'case version.' });
    const plain = dir('plainv');
    fs.writeFileSync(path.join(plain, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    check('a folder that is not a checkout reports its package version without git details', updater.versionLine(plain) === 'atlias 9.9.9', { happened: updater.versionLine(plain), why: 'No commit to show.', fix: 'toplevel compare.' });
    const cli = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'atlias.mjs'), 'update', '--bogus'], { encoding: 'utf8' });
    check('atlias update with an unknown flag prints usage and exits 2', cli.status === 2 && /usage: atlias update/.test(cli.stdout), { happened: cli.stdout, why: 'No silent guessing.', fix: 'parseArgs bad.' });
  });

  await asyncSuite('mentions expert', '@file mentions: inside the project only', async () => {
    const proj = dir('proj');
    fs.mkdirSync(path.join(proj, 'src'));
    fs.writeFileSync(path.join(proj, 'src', 'main.js'), 'console.log(1);' + NL);
    fs.writeFileSync(path.join(proj, 'README.md'), '# hi' + NL);
    const outside = path.join(path.dirname(proj), `secret-${process.pid}-${++n}.txt`);
    fs.writeFileSync(outside, 'TOP-SECRET-OUTSIDE');
    const rel = '../' + path.basename(outside);
    const ex = (t, d2 = proj) => qol.expandMentions(t, d2);
    let x = ex('please read @src/main.js and @README.md.');
    check('files named with @ are attached with their text', x.files.join() === 'src/main.js,README.md' && x.text.includes('console.log(1);') && x.text.includes('# hi') && x.text.startsWith('please read @src/main.js and @README.md.'), { happened: JSON.stringify(x.files), why: 'The point of the feature; the typed text stays as typed.', fix: 'expandMentions.' });
    x = ex('look at @' + rel);
    check('a path outside the project is never read', !x.text.includes('TOP-SECRET') && x.files.length === 0 && x.notes.some((s) => /outside the project/.test(s)), { happened: x.text + JSON.stringify(x.notes), why: 'Gev: never read outside the allowed folders.', fix: 'inside() check on the real path.' });
    x = ex('look at @' + outside.replace(/\\/g, '/'));
    check('an absolute path outside the project is never read', !x.text.includes('TOP-SECRET') && x.files.length === 0, { happened: x.text, why: 'Same rule.', fix: 'inside().' });
    const link = path.join(proj, 'link.txt');
    let linked = true;
    try { fs.symlinkSync(outside, link); } catch { linked = false; }
    if (linked) {
      x = ex('read @link.txt');
      check('a symlink inside the project that points outside is not followed', !x.text.includes('TOP-SECRET') && x.files.length === 0, { happened: x.text, why: 'The real path decides.', fix: 'realpathSync before the inside check.' });
    } else check('symlink escape (skipped: this account cannot create symlinks)', true, { happened: '', why: '', fix: '' });
    fs.mkdirSync(path.join(proj, '.git'));
    fs.writeFileSync(path.join(proj, '.git', 'config'), 'GITSECRET');
    x = ex('read @.git/config');
    check('the .git folder is never attached', !x.text.includes('GITSECRET') && x.files.length === 0, { happened: x.text, why: 'Credentials can sit there.', fix: '.git filter.' });
    x = ex('mail bob@src/main.js or @nobody or @missing/file.txt');
    check('an email, a name and a missing file are left alone', x.files.length === 0 && x.text === 'mail bob@src/main.js or @nobody or @missing/file.txt', { happened: x.text, why: 'No false positives.', fix: 'MENTION_RE needs whitespace before @.' });
    x = ex('see @src');
    check('a folder is not attached', x.files.length === 0, { happened: JSON.stringify(x), why: 'Files only.', fix: 'isFile.' });
    fs.writeFileSync(path.join(proj, 'big.txt'), 'x'.repeat(qol.MENTION_FILE_BYTES + 1));
    fs.writeFileSync(path.join(proj, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
    x = ex('@big.txt @bin.dat');
    check('a file over the size cap and a binary file are named in notes, not attached', x.files.length === 0 && x.notes.length === 2, { happened: JSON.stringify(x.notes), why: 'Context is the budget.', fix: 'size and NUL checks.' });
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(proj, `f${i}.txt`), `file ${i}`);
    x = ex(Array.from({ length: 10 }, (_, i) => `@f${i}.txt`).join(' '));
    check('at most 8 files per message', x.files.length === 8 && x.notes.length === 2, { happened: x.files.length + ' ' + x.notes.length, why: 'A cap.', fix: 'MENTION_MAX_FILES.' });
    x = ex('@README.md and again @README.md');
    check('the same file twice is attached once', x.files.length === 1, { happened: JSON.stringify(x.files), why: 'No duplicate bytes.', fix: 'seen set.' });
    const scOut = (mod) => mod.expandMentions('look at @' + rel, proj).text.includes('TOP-SECRET') ? ['read a file outside the project'] : [];
    check('the scenario passes on the real module', scOut(qol).length === 0, { happened: '', why: 'Baseline.', fix: '' });
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'qol.mjs'), 'utf8').replace('const inProject = inside(rootReal, real)', 'const inProject = true').replace(/from '\.\/([\w-]+)\.mjs'/g, (m, f) => `from '${pathToFileURL(path.join(ROOT, 'lib', f + '.mjs')).href}'`);
    const mp = path.join(TMP, 'qol', `mutant-mention-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(mp, src);
    const mod = await import(pathToFileURL(mp).href);
    check('PLANTED BREAK: without the inside-the-project check the outside file is read and the test sees it', scOut(mod).length > 0, { happened: '', why: 'The test must see it.', fix: 'Strengthen the scenario.' });
  });

  await asyncSuite('qol commands expert', '/context, /rename, /release-notes, /update and the long-turn notification', async () => {
    const names = commands.BUILTINS.map((b) => b.name);
    for (const w of ['update', 'context', 'rename', 'release-notes']) check(`/${w} is registered and listed`, names.includes(w) && commands.helpText(dir('h'), dir('hh')).includes('/' + w), { happened: names.join(','), why: 'One registry.', fix: 'BUILTINS.' });
    const cwd = dir('ctxproj');
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'x'.repeat(400));
    const out = [];
    const state = agentMod.newState(cwd, 'ollama');
    state.history.push({ role: 'user', text: 'hello there' }, { role: 'assistant', text: 'hi' });
    state.messages.push({ role: 'user', content: 'y'.repeat(9000) });
    const ctx = { state, cwd, out: (s) => out.push(String(s)), ask: async () => 'n', api: agentMod.slashApi, home: dir('hm') };
    await commands.dispatch('/context', ctx);
    const text = out.join(NL);
    check('/context lists the parts with sizes, marks tokens as an estimate and names the biggest message', /instruction files\s+400 chars/.test(text) && /conversation/.test(text) && /estimate/.test(text) && /largest messages/.test(text) && /window/.test(text), { happened: text, why: 'Measured, labelled.', fix: 'contextText.' });
    const claudeState = agentMod.newState(cwd, 'claude');
    check('/context for the claude engine says Atlias never sees its token counts', /never sees/.test(qol.contextText(claudeState, {})), { happened: qol.contextText(claudeState, {}), why: 'Never pretend a count.', fix: 'contextText.' });
    out.length = 0;
    await commands.dispatch('/rename my first run', ctx);
    check('/rename names the session and /sessions shows the name', state.name === 'my first run' && /my first run/.test(out.join(NL)), { happened: out.join(NL), why: 'Naming.', fix: 'rename.' });
    out.length = 0;
    await commands.dispatch('/sessions', ctx);
    check('the name is in the /sessions list', /"my first run"/.test(out.join(NL)), { happened: out.join(NL), why: 'Findable.', fix: 'sessions row.' });
    const loaded = agentMod.loadChat('My First Run', cwd);
    check('a saved session loads by its name, case-insensitively, in its own folder only', loaded && loaded.sid === state.sid && loaded.name === 'my first run' && agentMod.loadChat('my first run', dir('other')) === null, { happened: JSON.stringify(loaded && loaded.sid), why: 'Resume by name.', fix: 'loadChat name fallback.' });
    out.length = 0;
    await commands.dispatch('/rename ' + 'z'.repeat(61), ctx);
    check('a name over 60 characters is refused', state.name === 'my first run', { happened: out.join(NL), why: 'Bounded.', fix: 'rename length.' });
    const unnamed = agentMod.newState(cwd, 'echo');
    agentMod.saveChat(unnamed);
    check('a session never named saves without a name key (byte-identical to before)', (() => { const row = agentMod.listChats(cwd).find((x) => x.sid === unnamed.sid); return Boolean(row) && !('name' in row); })(), { happened: '', why: 'No change for exec.', fix: 'conditional spread.' });

    const root = dir('rn');
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- next thing\n\n## 4.0.0 (2026-10-17)\n\n- big release\n\n## 3.8.1 (2026-09-28)\n\n- old\n');
    const all = qol.releaseNotes('', root);
    check('/release-notes shows Unreleased and the newest release, and names the others', all.includes('next thing') && all.includes('big release') && !all.includes('- old') && /3\.8\.1/.test(all), { happened: all, why: 'Newest first.', fix: 'releaseNotes.' });
    check('/release-notes <version> shows that entry only, with or without a v', qol.releaseNotes('3.8.1', root).includes('- old') && !qol.releaseNotes('v3.8.1', root).includes('big release') && /no entry/.test(qol.releaseNotes('1.2.3', root)), { happened: '', why: 'Pick one.', fix: 'releaseNotes.' });
    check('the real CHANGELOG has a 4.0.0 entry that /release-notes finds', /Permission modes|permission modes/.test(qol.releaseNotes('4.0.0')) && /atlias update/.test(qol.releaseNotes('4.0.0')), { happened: qol.releaseNotes('4.0.0').slice(0, 120), why: 'Gev: changelog for 4.0.0.', fix: 'Write the entry.' });

    out.length = 0;
    await commands.dispatch('/update --check --bogus', ctx);
    check('/update with a bad argument prints usage and pulls nothing', /usage: \/update/.test(out.join(NL)), { happened: out.join(NL), why: 'No guessing.', fix: 'parseArgs.' });

    check('a turn shorter than the setting does not notify; longer does; 0 means off', !qol.shouldNotify(5000, 10) && qol.shouldNotify(10000, 10) && !qol.shouldNotify(99999999, 0) && !qol.shouldNotify(5000, 'x'), { happened: '', why: 'Threshold.', fix: 'shouldNotify.' });
    const calls = [];
    const stream = { isTTY: true, write: (s) => calls.push(['bell', s]) };
    const fakeSpawn = (cmd, args) => { calls.push(['spawn', cmd, args]); return { on() {}, unref() {} }; };
    qol.notify('Atlias', 'done', { stream, platform: 'win32', spawnFn: fakeSpawn });
    check('notify rings the bell on a terminal and starts one desktop command', calls[0][0] === 'bell' && calls[0][1] === '\x07' && calls[1][0] === 'spawn' && calls[1][1] === 'powershell.exe', { happened: JSON.stringify(calls), why: 'Bell plus toast.', fix: 'notify.' });
    const evil = qol.notifyCommand('win32', "x'; Remove-Item C:\\ -Recurse; '", 'a"b`c$d');
    const balloon = /ShowBalloonTip\(5000, '([^']*)', '([^']*)', 'Info'\)/.exec(evil.args[evil.args.length - 1]);
    check('text put in a notification command cannot break out of its quotes', Boolean(balloon) && !/[`$"']/.test(balloon[1] + balloon[2]) && (evil.args[evil.args.length - 1].match(/'/g) || []).length === 6, { happened: evil.args[evil.args.length - 1], why: 'No injection.', fix: 'plain().' });
    check('every platform has a command', qol.notifyCommand('darwin', 'a', 'b').cmd === 'osascript' && qol.notifyCommand('linux', 'a', 'b').cmd === 'notify-send', { happened: '', why: '', fix: '' });
    check('agent.notifyAfterSeconds is a described setting that defaults to off', core.config().agent.notifyAfterSeconds === 0 && settings.rows().find((x) => x.id === 'agent.notifyAfterSeconds').about.length > 40 && settings.set('agent.notifyAfterSeconds', '30').ok && core.config().agent.notifyAfterSeconds === 30 && settings.reset('agent.notifyAfterSeconds').ok, { happened: '', why: 'Off by default.', fix: 'DEFAULTS and DESCRIPTIONS.' });
  });

  suite('interactive-only expert', 'none of this is reachable from exec, eval, runLoop or h2h', () => {
    const files = ['lib/loop.mjs', 'lib/eval.mjs', 'tools/h2h/atlias_task.mjs'].filter((f) => fs.existsSync(path.join(ROOT, f)));
    const hits = files.filter((f) => /update\.mjs|qol\.mjs/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    check('the benchmark path does not import update.mjs or qol.mjs', files.length >= 2 && hits.length === 0, { happened: hits.join(','), why: 'Gev: the benchmark path stays byte-identical.', fix: 'Call these from the repl only.' });
    const agentSrc = fs.readFileSync(path.join(ROOT, 'lib', 'agent.mjs'), 'utf8');
    const execBody = agentSrc.slice(agentSrc.indexOf('async function execOnce'), agentSrc.indexOf('export const slashApi'));
    check('execOnce does not expand mentions, notify or offer an update', !/qol\.|updater\./.test(execBody), { happened: '', why: 'exec is non-interactive.', fix: 'Only replIn uses them.' });
    const replBody = agentSrc.slice(agentSrc.indexOf('async function replIn'));
    const onceAt = replBody.indexOf('if (opts.once)');
    const offerAt = replBody.indexOf('updater.maybeOffer');
    check('the offer comes after the --once branch returns, so --once never offers', onceAt > 0 && offerAt > onceAt, { happened: `${onceAt} ${offerAt}`, why: 'Gev: never in --once.', fix: 'Place the offer after the once branch.' });
  });
}
