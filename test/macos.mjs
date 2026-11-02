// What macOS does differently from Linux and Windows, and the bugs that came from it.
// Runs everywhere: the rules are plain strings, and what needs a Mac says so. No network, no model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// .native, as the code under test uses: on Windows the other form keeps short names like RUNNER~1.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-macos-')));
process.env.ATLIAS_HOME = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const core = await load('lib/core.mjs');
const guard = await load('lib/guard.mjs');
const hosts = await load('lib/hosts.mjs');
const graph = await load('lib/graph.mjs');
const proc = await load('lib/proc.mjs');
const { syntaxReport } = await load('lib/gate.mjs');
const mac = process.platform === 'darwin';
const win = process.platform === 'win32';
let checks = 0;
const ok = (value, message) => { checks++; assert.ok(value, message); };
const eq = (a, b, message) => { checks++; assert.equal(a, b, message); };

try {
  // Claude Code's own project folder name, read from its binary (2.1.261).
  eq(core.claudeSlug('/Users/me/Library/Application Support/my.app_v2'), '-Users-me-Library-Application-Support-my-app-v2', 'a space, a dot and an underscore all become dashes');
  eq(core.claudeSlug('C:\\Users\\OWNER'), 'C--Users-OWNER', 'the Windows form still matches');
  eq(core.claudeSlug('/Users/me/caf\u00e9'), '-Users-me-caf-', 'an accented letter is one dash');
  const long = '/Users/me/' + 'deep-folder/'.repeat(30);
  const longName = core.claudeSlug(long);
  ok(longName.startsWith(long.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200) + '-') && longName.length < 215, 'past 200 characters the name is cut and a hash added');
  // The state folder keeps its old name for ordinary paths, so nobody loses a handoff note.
  eq(core.slug('/home/gev/app'), '-home-gev-app', 'an ordinary state folder name does not change');
  eq(core.slug('/Users/me/Application Support/x'), '-Users-me-Application Support-x', 'nor does one with a space');
  ok(Buffer.byteLength(core.slug('/Users/me/' + 'caf\u00e9-folder/'.repeat(40))) < 255, 'a deep path still fits in one folder name');

  // Memory follows the repository, as Claude Code's does.
  const repo = path.join(tmp, 'Application Support', 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  eq(core.projectRoot(path.join(repo, 'src', 'deep')), repo, 'a subfolder belongs to its repository');
  const wt = path.join(tmp, 'wt');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`);
  eq(core.projectRoot(wt), repo, 'a worktree shares the memory of its main repository');
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain);
  eq(core.projectRoot(plain), plain, 'outside a repository the folder is the project');
  const mem = core.claudeMemoryDir(path.join(repo, 'src'));
  eq(mem, path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', core.claudeSlug(repo), 'memory'), 'the memory folder is the one Claude Code reads');
  // Memory saved under the old name is not stranded.
  const moved = path.join(tmp, 'My Project');
  fs.mkdirSync(moved);
  const oldDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', core.slug(moved), 'memory');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'MEMORY.md'), 'kept\n');
  eq(fs.readFileSync(path.join(core.claudeMemoryDir(moved), 'MEMORY.md'), 'utf8'), 'kept\n', 'old memory moves to the new folder');

  if (!win) {
    const link = path.join(tmp, 'link');
    fs.symlinkSync(plain, link);
    eq(core.realDir(link), plain, 'a symlink resolves');
    eq(core.projectRoot(link), plain, 'so /tmp and /private/tmp are one project');
  }
  if (mac && fs.existsSync(tmp.toUpperCase())) {
    eq(core.realDir(plain.toUpperCase()), plain, 'the case-insensitive disk gives back its own spelling');
    ok(graph.status(os.homedir().toUpperCase()).canBuild === false, 'home in another case is still home');
  }

  // The guard. Each of these runs with no question asked unless it is flagged.
  for (const c of ['rm -r -f /', 'rm -rf ~/Library', 'rm -rf "$HOME/Documents"', 'rm -rf ~/Documents/*', 'rm -rf /Users/me', 'rm -rf /Applications', 'rm -rf /System/Library', 'rm -rf /Library', 'rm -rf /usr/local/bin', 'sudo rm -rf /private/etc', 'rm -rf ./build /Applications', 'rm -rf /applications', 'rm -rf ~/library', 'rm -rf "$HOME"/Library', 'rm -rf /var', 'rm -rf /private/var', 'rm -rf /private',
    'diskutil eraseDisk APFS X /dev/disk2', 'diskutil apfs deleteContainer disk3', 'diskutil partitionDisk disk2 1 GPT APFS X 100%', 'dd of=/dev/rdisk2 bs=1m', 'cat x > /dev/disk2', 'newfs_apfs /dev/disk2s1',
    'csrutil disable', 'spctl --master-disable', 'tmutil deletelocalsnapshots /', 'security delete-keychain login.keychain', 'launchctl bootout system/com.apple.foo', 'nvram -c', 'sudo shutdown -h now']) {
    ok(guard.destructiveReason(c), `the guard must flag: ${c}`);
  }
  for (const c of ['rm -rf node_modules', 'rm -rf ./build', 'rm -rf /tmp/x', 'rm -rf /private/tmp/x', 'rm -rf /var/folders/ab/T/x', 'rm -rf /private/var/folders/ab/T/x', 'rm -rf ~/Library/Caches/x', 'rm -rf ~/code/project/dist', 'git rm -r src', 'rm -rf ./build /tmp/x', 'rm -rf build && ls /', 'dd of=/dev/null',
    'ls -la ~/Library', 'open .', 'brew install jq', 'defaults read com.apple.finder', 'security find-generic-password -s x', 'launchctl list', 'diskutil list', 'tmutil status']) {
    ok(!guard.destructiveReason(c), `the guard must not flag: ${c}`);
  }

  // Our hooks are ours whatever the checkout's folder is called.
  const foreign = { type: 'command', command: 'node other.js' };
  const mine = { type: 'command', command: 'node "/Users/me/src/lib/hooks.mjs" stop --host codex', statusMessage: 'atlias' };
  const stripped = hosts.stripHooksJson({ hooks: { Stop: [{ hooks: [foreign, mine] }] } });
  eq(JSON.stringify(stripped.hooks.Stop[0].hooks), JSON.stringify([foreign]), 'only our hook goes');
  const once = hosts.mergeHooksJson({}, 'codex');
  eq(JSON.stringify(hosts.mergeHooksJson(once, 'codex')), JSON.stringify(once), 'a second install changes nothing');
  eq(core.nodeCommand('darwin', '/Users/me/.nvm/versions/node/v24/bin/node', () => true), '/Users/me/.nvm/versions/node/v24/bin/node', 'an IDE on macOS gets a node it can find');
  eq(core.nodeCommand('darwin', '/opt/homebrew/Cellar/node/24.1/bin/node', () => true), '/opt/homebrew/bin/node', 'and Homebrew\'s link, which survives an upgrade');
  eq(core.nodeCommand('darwin', '/opt/homebrew/Cellar/node/24.1/bin/node', () => false), '/opt/homebrew/Cellar/node/24.1/bin/node', 'unless that link is missing');
  eq(core.nodeCommand('linux'), 'node', 'elsewhere the command stays node');

  // Finder's metadata files are not code.
  const dbl = path.join(tmp, '._a.js');
  fs.writeFileSync(dbl, Buffer.from([0, 5, 22, 7, 0, 2, 0, 0, 77, 97, 99, 32]));
  eq(syntaxReport([dbl]).failures.length, 0, 'an AppleDouble file is not broken code');

  // The watchdog ships with the code that starts it, and ends what passes its limit.
  ok(fs.existsSync(path.join(root, 'lib', 'watchdog.mjs')), 'lib/proc.mjs starts lib/watchdog.mjs');
  const ran = proc.runSync(process.execPath, ['-e', 'console.log("hello")'], { timeoutMs: 10000 });
  ok(ran.status === 0 && /hello/.test(ran.stdout), `a command runs under the watchdog: ${ran.error}`);
  if (!win) {
    const slow = proc.runSync('sleep 30 & sleep 30', [], { timeoutMs: 800, shell: true });
    ok(slow.timedOut === true, 'a command past its limit is stopped');
    ok(!spawnSync('pgrep', ['-g', String(slow.pid)], { encoding: 'utf8' }).stdout.trim(), 'with everything it started');
  }

  // The watchdog's memory count: the tree and the group, and nothing else.
  {
    // watchdog.mjs runs as soon as it is loaded, so its small pure part is read from the source.
    const source = fs.readFileSync(path.join(root, 'lib', 'watchdog.mjs'), 'utf8');
    const file = path.join(tmp, 'treekb.mjs');
    fs.writeFileSync(file, `export ${source.slice(source.indexOf('function treeKB'), source.indexOf('function meterPosix'))}`);
    const { treeKB } = await import(pathToFileURL(file).href);
    const listing = ' 10 1 10 100\n 11 10 10 200\n 12 11 10 300\n 13 1 13 999\n 14 1 10 50\n';
    eq(treeKB(listing, 10), 650, 'the tree and the group count; another process does not');
    eq(treeKB(listing, 77), null, 'a command that has gone is not zero');
  }
  console.log(`macos checks passed (${checks})`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
