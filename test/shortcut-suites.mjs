// The terminal command suites. Loaded by test/run.mjs, which owns suite() and
// check(). The last suite installs the command into a sandbox home and runs
// it, on whichever platform the tests are running on, which is the only proof
// that typing `atlias` actually works.
import * as shortcut from '../lib/shortcut.mjs';

export default async function shortcutSuites({ suite, check, TMP, ROOT, spawnSync, fs, path }) {
  const home = path.join(TMP, 'shortcut-home');
  const winEnv = (withPath) => ({
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    ATLIAS_HOME: path.join(home, '.atlias'),
    PATH: withPath ? path.join(home, 'AppData', 'Local', 'Microsoft', 'WindowsApps') : '',
  });
  const posixEnv = (withPath) => ({
    HOME: home,
    ATLIAS_HOME: path.join(home, '.atlias'),
    PATH: withPath ? path.join(home, '.local', 'bin') + ':/usr/bin:/bin' : '/usr/bin:/bin',
  });

  suite('shortcut planning expert', 'where the command goes', () => {
    const w = shortcut.chooseShimDir(winEnv(true), 'win32');
    check('on Windows it prefers a folder that is already on PATH', w.onPath && /WindowsApps$/.test(w.dir), { happened: JSON.stringify(w), why: 'WindowsApps is on PATH for every Windows user by default, which is what makes the command work without editing PATH.', fix: 'Check chooseShimDir and shimDirCandidates.' });
    const w2 = shortcut.chooseShimDir(winEnv(false), 'win32');
    check('with nothing on PATH it still picks a folder and says so', !w2.onPath && typeof w2.dir === 'string', { happened: JSON.stringify(w2), why: 'The user needs to be told the command will not be found yet, not left to discover it.', fix: 'Return onPath false and let installShortcut add the note.' });
    // Linux-shaped paths: a Windows temp path in a colon-separated PATH loses
    // its drive letter, which only passes where the working drive happens to match.
    const p = shortcut.chooseShimDir({ HOME: '/home/u', PATH: '/home/u/.local/bin:/usr/bin:/bin' }, 'linux');
    check('on Linux and macOS it uses ~/.local/bin when that is on PATH', p.onPath && p.dir.endsWith(path.join('.local', 'bin')), { happened: JSON.stringify(p), why: 'That is where user-level commands live on both platforms.', fix: 'Check shimDirCandidates for posix.' });
    const files = shortcut.shimFiles('win32', 'C:' + String.fromCharCode(92) + 'x' + String.fromCharCode(92) + 'cli.mjs');
    const cmd = files.find((f) => f.name === 'atlias.cmd');
    const sh = files.find((f) => f.name === 'atlias');
    check('Windows gets a .cmd shim that forwards every argument', cmd && cmd.text.includes('%*') && cmd.text.includes(String.fromCharCode(13, 10)), { happened: JSON.stringify(cmd), why: 'cmd and PowerShell both run a .cmd from PATH, and a lost argument means `atlias agent --once` does the wrong thing.', fix: 'Keep %* and CRLF line endings in the .cmd shim.' });
    check('and a script for Git Bash with forward slashes', sh && sh.text.includes('exec node "C:/x/cli.mjs" "$@"'), { happened: sh ? sh.text : 'missing', why: 'Git Bash runs extensionless scripts, not .cmd files, and cannot follow a backslash path.', fix: 'Write the extra shim with the path converted to forward slashes.' });
    const posixShim = shortcut.shimFiles('linux', '/h/.atlias/cli.mjs')[0];
    check('the posix shim is executable', posixShim.mode === 0o755, { happened: String(posixShim.mode), why: 'A shim without the execute bit is found on PATH and then refused.', fix: 'Set mode 0o755.' });
    const imports = shortcut.CLI_LAUNCHER_SOURCE.split(String.fromCharCode(10)).filter((l) => /^import /.test(l));
    check('the launcher imports only node builtins', imports.length > 0 && imports.every((l) => /'node:/.test(l)), { happened: imports.join(' | '), why: 'An import from a versioned plugin directory breaks the command on the next update.', fix: 'Keep CLI_LAUNCHER_SOURCE on node builtins only.' });
  });

  suite('shortcut install expert', 'installing the command', () => {
    const platform = process.platform;
    const env = platform === 'win32' ? winEnv(true) : posixEnv(true);
    const res = shortcut.installShortcut({ env, platform });
    check('the launcher and the shims are written', fs.existsSync(res.launcher) && res.written.length === (platform === 'win32' ? 2 : 1), { happened: JSON.stringify(res.lines), why: 'Either half missing means typing atlias does nothing.', fix: 'Check installShortcut.' });
    const parsed = spawnSync(process.execPath, ['--check', res.launcher], { encoding: 'utf8' });
    check('the launcher is valid JavaScript', parsed.status === 0, { happened: (parsed.stderr || 'ok').slice(0, 200), why: 'It is generated code that nobody reads until the command fails.', fix: 'Check CLI_LAUNCHER_SOURCE.' });
    const again = shortcut.installShortcut({ env, platform });
    check('installing twice rewrites its own files and nothing else', again.written.length === res.written.length && again.skipped.length === 0, { happened: JSON.stringify(again.lines), why: 'Re-running install must be safe.', fix: 'Recognise our own files by the marker line.' });
    const foreign = path.join(res.dir, 'atlias');
    const theirs = '#!/bin/sh' + String.fromCharCode(10) + 'echo someone else' + String.fromCharCode(10);
    fs.writeFileSync(foreign, theirs);
    const third = shortcut.installShortcut({ env, platform });
    check('a command somebody else wrote is never replaced', third.skipped.includes(foreign) && fs.readFileSync(foreign, 'utf8') === theirs, { happened: JSON.stringify(third.lines), why: 'Overwriting another tool\'s command breaks that tool.', fix: 'Skip a target that exists without the marker.' });
    const removed = shortcut.uninstallShortcut({ env, platform });
    check('uninstall removes only files carrying the marker', fs.existsSync(foreign) && !fs.existsSync(res.launcher) && removed.length >= 1, { happened: JSON.stringify(removed), why: 'Uninstall must never delete somebody else\'s atlias.', fix: 'Check the marker before unlinking.' });
    fs.unlinkSync(foreign);
    const status = shortcut.shortcutStatus({ env, platform });
    check('status reports nothing installed after uninstall', status.launcher === null && status.shims.length === 0, { happened: JSON.stringify(status), why: 'A status that lies is worse than none.', fix: 'Check shortcutStatus.' });
    check('with nothing on PATH the lookup says nothing answers', shortcut.whichAtlias({ PATH: path.join(home, 'empty-dir') }, platform) === null, { happened: 'it found something', why: 'A doctor that reports a command that is not there sends the user looking in the wrong place.', fix: 'Return null when no PATH entry holds an atlias.' });
  });

  suite('shortcut resolution expert', 'the terminal command follows current installs without a stale plugin downgrade', () => {
    const base = path.join(TMP, 'shortcut-resolution');
    const state = path.join(base, 'state');
    const claude = path.join(base, 'claude');
    const cache = path.join(claude, 'plugins', 'cache', 'atlias', 'atlias');
    const launcher = path.join(base, 'cli.mjs');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(launcher, shortcut.CLI_LAUNCHER_SOURCE);
    const copy = (root, version, tag) => {
      fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', version }));
      fs.writeFileSync(path.join(root, 'bin', 'atlias.mjs'), `console.log(${JSON.stringify(tag)});`);
      return root;
    };
    const old = copy(path.join(cache, '3.8.1'), '3.8.1', 'old-plugin');
    const app = copy(path.join(base, 'standalone app'), '4.0.0', 'new-app');
    const record = (root) => fs.writeFileSync(path.join(state, 'root.json'), JSON.stringify({ root }));
    const resolve = (extra = {}) => spawnSync(process.execPath, [launcher], {
      env: { ...process.env, ATLIAS_HOME: state, CLAUDE_CONFIG_DIR: claude, ATLIAS_ROOT: '', ...extra },
      encoding: 'utf8', timeout: 10000,
    });
    const expect = (name, tag, extra = {}) => {
      const r = resolve(extra);
      check(name, r.status === 0 && !r.error && r.stdout.trim() === tag, { happened: JSON.stringify({ status: r.status, out: r.stdout, err: r.stderr }), why: 'Gev: installing or updating the app must not reopen an older plugin.', fix: 'Resolve the newest usable CLI, preserving the explicit override and recorded app on ties.' });
    };
    record(app);
    expect('an older cached plugin cannot hide a newer recorded app', 'new-app');
    const newer = copy(path.join(cache, '4.1.0'), '4.1.0', 'newer-plugin');
    expect('a newer installed plugin is picked up without rewriting the shim', 'newer-plugin');
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ type: 'module', version: '4.1.0' }));
    expect('equal release versions preserve the explicitly installed standalone app', 'new-app');
    expect('ATLIAS_ROOT still selects an older explicit copy', 'old-plugin', { ATLIAS_ROOT: old });
    expect('a removed explicit copy falls through to a usable install', 'new-app', { ATLIAS_ROOT: path.join(base, 'removed') });
    record(path.join(base, 'missing app'));
    expect('a deleted recorded app falls through to the newest plugin', 'newer-plugin');
    record(app);
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ type: 'module', version: '4.2.0' }));
    expect('an in-place update is detected from the live package version', 'new-app');
    fs.writeFileSync(path.join(state, 'root.json'), '{bad json');
    expect('a damaged root record does not prevent a valid plugin from launching', 'newer-plugin');
    fs.writeFileSync(path.join(newer, 'package.json'), '{bad json');
    expect('a cache folder version remains usable if its manifest cannot be read', 'newer-plugin');
    fs.rmSync(cache, { recursive: true, force: true });
    const empty = resolve();
    check('no usable install is a diagnostic nonzero exit', empty.status === 1 && /no installed copy found/.test(empty.stderr), { happened: JSON.stringify({ status: empty.status, stderr: empty.stderr }), why: 'A missing install must not pretend to have launched.', fix: 'Keep the launcher error path.' });
  });

  suite('terminal command expert', 'typing atlias actually runs atlias', () => {
    const platform = process.platform;
    const env = platform === 'win32' ? winEnv(true) : posixEnv(true);
    const res = shortcut.installShortcut({ env, platform });
    // A copy of process.env on Windows carries Path, and a second PATH key
    // beside it leaves the child to pick one; drop every spelling first.
    const base = { ...process.env };
    for (const k of Object.keys(base)) if (k.toLowerCase() === 'path') delete base[k];
    const childEnv = { ...base, ...env, ATLIAS_ROOT: ROOT, PATH: res.dir + (platform === 'win32' ? ';' : ':') + (process.env.PATH || '') };
    const found = shortcut.whichAtlias(childEnv, platform);
    check('the doctor\'s lookup finds the command that was just installed', found !== null && path.dirname(found) === res.dir, { happened: String(found), why: 'The doctor row is only worth anything if it finds what typing atlias would run.', fix: 'Check whichAtlias against PATHEXT and the shim names.' });
    const out = platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/c', 'atlias', '--version'], { env: childEnv, encoding: 'utf8', timeout: 30000 })
      : spawnSync('sh', ['-c', 'atlias --version'], { env: childEnv, encoding: 'utf8', timeout: 30000 });
    check('the command prints the atlias version', /atlias \d+\.\d+\.\d+/.test(out.stdout || ''), { happened: 'exit ' + out.status + ': ' + ((out.stdout || '') + (out.stderr || '')).slice(0, 200), why: 'This is the whole feature: a word typed in a terminal that starts atlias.', fix: 'Check the shim, the launcher, and that node is on PATH.' });
    shortcut.uninstallShortcut({ env, platform });
  });
}
