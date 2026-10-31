#!/usr/bin/env node
// Install atlias into a throwaway home and check what it wrote.
//
// The config shapes for the extra harnesses are marked UNVERIFIED because no
// one here has those tools installed. That is a reason not to claim they are
// accepted; it is not a reason to leave the files unchecked. This installs
// into a sandbox and proves what can be proved without the tools themselves:
// every file it writes is valid, installing twice changes nothing, and
// uninstalling removes exactly what was added and nothing else.
//
//   node test/install-sandbox.mjs            run it
//   node test/install-sandbox.mjs --keep     leave the sandbox for inspection
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-sandbox-'));
const HOME = path.join(SANDBOX, 'home');
const env = {
  ...process.env,
  HOME,
  USERPROFILE: HOME,
  CODEX_HOME: path.join(HOME, '.codex'),
  CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'),
  ATLIAS_HOME: path.join(HOME, '.atlias'),
  XDG_CONFIG_HOME: path.join(HOME, '.config'),
  APPDATA: path.join(HOME, 'AppData', 'Roaming'),
  // The terminal command writes under LOCALAPPDATA on Windows; left unset it
  // would land in the real WindowsApps folder.
  LOCALAPPDATA: path.join(HOME, 'AppData', 'Local'),
};

const failures = [];
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  if (!ok) failures.push(`${name}: ${detail}`);
}

// A harness only gets written to when its directory already exists, so create
// the ones under test and leave one out to prove the skip.
const present = [
  ['.codex'], ['.cursor'], ['.kiro'], ['.trae'], ['.continue'], ['.codebuddy'], ['.hermes'], ['.pi'], ['.aider'],
  ['.codeium', 'windsurf'], ['.config', 'opencode'], ['.config', 'amp'], ['.config', 'zed'], ['.gemini', 'config'], ['.claude'],
];
for (const parts of present) fs.mkdirSync(path.join(HOME, ...parts), { recursive: true });

const atlias = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'atlias.mjs'), ...args], { env, encoding: 'utf8', timeout: 120000 });

const first = atlias('install', '--codex', '--antigravity', '--gemini', '--extras');
check('the installer exits cleanly', first.status === 0, `exit ${first.status}: ${(first.stderr || '').slice(0, 200)}`);
check('it reports what it wrote', /mcp server in/.test(first.stdout || ''), (first.stdout || '').slice(0, 200));
check('and it skipped a harness that is not installed', /not installed here/.test(first.stdout || ''), 'nothing was skipped, so the guard against littering the disk was never exercised');

// Every JSON file it touched has to parse, and hold an atlias entry.
const jsonTargets = [
  [path.join(HOME, '.codex', 'hooks.json'), (d) => Object.values(d.hooks || {}).some((g) => g.some((x) => (x.hooks || []).some((h) => /atlias/.test(h.command))))],
  [path.join(HOME, '.gemini', 'config', 'mcp_config.json'), (d) => d.mcpServers && d.mcpServers.atlias],
  [path.join(HOME, '.gemini', 'settings.json'), (d) => d.mcpServers && d.mcpServers.atlias],
  [path.join(HOME, '.cursor', 'mcp.json'), (d) => d.mcpServers && d.mcpServers.atlias],
  [path.join(HOME, '.kiro', 'settings', 'mcp.json'), (d) => d.mcpServers && d.mcpServers.atlias],
  [path.join(HOME, '.config', 'opencode', 'opencode.json'), (d) => d.mcp && d.mcp.atlias && Array.isArray(d.mcp.atlias.command)],
  [path.join(HOME, '.config', 'amp', 'settings.json'), (d) => d['amp.mcpServers'] && d['amp.mcpServers'].atlias],
  [path.join(HOME, '.config', 'zed', 'settings.json'), (d) => d.context_servers && d.context_servers.atlias],
];
for (const [file, holds] of jsonTargets) {
  let doc = null;
  let err = '';
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { err = e.message; }
  check(`${path.relative(HOME, file)} is valid JSON`, doc !== null, err);
  if (doc) check(`${path.relative(HOME, file)} holds the atlias entry`, Boolean(holds(doc)), JSON.stringify(doc).slice(0, 200));
}

// The TOML is the one that can take a host down when it is malformed, so it
// gets a real parser rather than a regular expression.
const toml = path.join(HOME, '.codex', 'config.toml');
const py = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', `import tomllib;d=tomllib.load(open(${JSON.stringify(toml)},'rb'));print('atlias' in d.get('mcp_servers',{}))`], { encoding: 'utf8', timeout: 30000 });
if (py.status === 0) check('config.toml parses with a real TOML parser', /True/.test(py.stdout || ''), (py.stdout || py.stderr || '').slice(0, 200));
else {
  check('config.toml was written', fs.existsSync(toml), 'no python with tomllib here, and the file is missing too');
  process.stdout.write('  (no python3 with tomllib available, so the TOML was checked for presence only)\n');
}

// Installing twice must change nothing at all.
const snapshot = () => {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(HOME, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(HOME);
  return out;
};
const before = snapshot();
atlias('install', '--codex', '--antigravity', '--gemini', '--extras');
const after = snapshot();
const changed = Object.keys(after).filter((k) => k in before && after[k] !== before[k]);
const added = Object.keys(after).filter((k) => !(k in before));
check('installing twice changes nothing', changed.length === 0 && added.length === 0, `changed: ${changed.join(', ')} added: ${added.join(', ')}`);

// Somebody else's entry must survive an uninstall.
const cursorMcp = path.join(HOME, '.cursor', 'mcp.json');
const withFriend = JSON.parse(fs.readFileSync(cursorMcp, 'utf8'));
withFriend.mcpServers.someone_else = { command: 'node', args: ['theirs.mjs'] };
fs.writeFileSync(cursorMcp, JSON.stringify(withFriend, null, 2));
const out = atlias('uninstall', '--codex', '--antigravity', '--gemini', '--extras');
check('the uninstaller exits cleanly', out.status === 0, `exit ${out.status}: ${(out.stderr || '').slice(0, 200)}`);
const cursorAfter = JSON.parse(fs.readFileSync(cursorMcp, 'utf8'));
check('uninstall removes atlias', !cursorAfter.mcpServers.atlias, JSON.stringify(cursorAfter));
check('uninstall keeps everyone else', Boolean(cursorAfter.mcpServers.someone_else), JSON.stringify(cursorAfter));
check('uninstall clears the codex table', !/\[mcp_servers\.atlias\]/.test(fs.readFileSync(toml, 'utf8')), fs.readFileSync(toml, 'utf8').slice(0, 200));
for (const f of [path.join(HOME, '.codex', 'AGENTS.md'), path.join(HOME, '.cursor', 'rules', 'atlias.mdc')]) {
  const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  check(`${path.relative(HOME, f)} has no atlias block left`, !text.includes('atlias:start'), text.slice(0, 160));
}

// The terminal command, installed and removed inside the sandbox only.
const sc = atlias('install', '--shortcut');
const written = ((sc.stdout || '').match(/^command: (.+)$/gm) || []).map((l) => l.slice(9));
check('the terminal command installs', sc.status === 0 && written.length > 0, `exit ${sc.status}: ${(sc.stdout || '') + (sc.stderr || '')}`.slice(0, 300));
check('and only inside the sandbox home', written.length > 0 && written.every((f) => path.resolve(f).startsWith(HOME)), written.join(', '));
const unsc = atlias('uninstall', '--shortcut');
check('uninstall removes the terminal command', unsc.status === 0 && written.every((f) => !fs.existsSync(f)), (unsc.stdout || '').slice(0, 300));

const passed = checks.filter((c) => c.ok).length;
process.stdout.write(`\n${passed}/${checks.length} install checks passed in a sandbox home\n`);
for (const f of failures) process.stdout.write(`  x ${f}\n`);
if (process.argv.includes('--keep')) process.stdout.write(`sandbox kept at ${SANDBOX}\n`);
else {
  // With retries, as test/run.mjs does: a handle a just-exited child still holds
  // on Windows fails a single attempt, and a silent catch leaked the folder.
  try { fs.rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch { /* reported below */ }
  if (fs.existsSync(SANDBOX)) process.stdout.write(`the sandbox could not be removed: ${SANDBOX}
`);
}
process.exit(failures.length ? 1 : 0);
