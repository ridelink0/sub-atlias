// The `atlias` command, typed in any terminal the way `claude`, `codex` or
// `agy` are. Two parts:
//
//   ~/.atlias/cli.mjs   a launcher whose own path never changes. It finds the
//                       newest installed copy of atlias at run time, so a
//                       plugin update reaches the command with nothing to redo.
//   the shims           tiny files named atlias in a folder already on PATH:
//                       atlias.cmd for cmd and PowerShell, a bare atlias
//                       script for Git Bash, and ~/.local/bin/atlias on Linux
//                       and macOS.
//
// Every file it writes carries a marker line, and uninstall removes only
// files that carry it, so it can never delete somebody else's atlias.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MARKER = 'written by atlias shortcut';

// The launcher, verbatim: node builtins only, no import from a versioned path.
export const CLI_LAUNCHER_SOURCE = [
  '#!/usr/bin/env node',
  `// ${MARKER}. Runs the newest installed copy of atlias with the arguments given.`,
  "import fs from 'node:fs';",
  "import os from 'node:os';",
  "import path from 'node:path';",
  "import { pathToFileURL } from 'node:url';",
  '',
  'const home = os.homedir();',
  "const state = process.env.ATLIAS_HOME || path.join(home, '.atlias');",
  "const claude = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');",
  'const candidates = [];',
  "const cache = path.join(claude, 'plugins', 'cache', 'atlias', 'atlias');",
  'try {',
  '  const versions = fs.readdirSync(cache).filter((d) => /^\\d+\\.\\d+\\.\\d+$/.test(d));',
  '  versions.sort((a, b) => {',
  "    const A = a.split('.').map(Number);",
  "    const B = b.split('.').map(Number);",
  '    return B[0] - A[0] || B[1] - A[1] || B[2] - A[2];',
  '  });',
  '  for (const v of versions) candidates.push(path.join(cache, v));',
  '} catch { /* not installed as a plugin */ }',
  'try {',
  "  const recorded = JSON.parse(fs.readFileSync(path.join(state, 'root.json'), 'utf8'));",
  "  if (recorded && typeof recorded.root === 'string') candidates.unshift(recorded.root);",
  '} catch { /* no record */ }',
  '// Compare the live app version with cached releases; cache-first used to reopen 3.8.1 after installing 4.0.0.',
  'const release = (dir) => {',
  "  let value = path.basename(dir);",
  "  try { value = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^\\uFEFF/, '')).version || value; } catch { /* cache folder version */ }",
  "  const match = /^(\\d+)\\.(\\d+)\\.(\\d+)(?:-|$)/.exec(String(value));",
  '  return match ? match.slice(1).map(Number) : [0, 0, 0];',
  '};',
  '// Stable ties keep the recorded app first. An explicit override always wins when it exists.',
  'candidates.sort((a, b) => {',
  '  const A = release(a), B = release(b);',
  '  return B[0] - A[0] || B[1] - A[1] || B[2] - A[2];',
  '});',
  'if (process.env.ATLIAS_ROOT) candidates.unshift(process.env.ATLIAS_ROOT);',
  'const root = candidates.find((dir) => {',
  "  try { fs.accessSync(path.join(dir, 'bin', 'atlias.mjs')); return true; } catch { return false; }",
  '});',
  'if (!root) {',
  "  process.stderr.write('atlias: no installed copy found. Install the plugin, or set ATLIAS_ROOT to a checkout.\\n');",
  '  process.exit(1);',
  '}',
  "await import(pathToFileURL(path.join(root, 'bin', 'atlias.mjs')).href);",
  '',
].join('\n');

const onPath = (dir, env, platform) => {
  const sep = platform === 'win32' ? ';' : ':';
  const norm = (d) => {
    const r = path.resolve(String(d)).replace(/[\\/]+$/, '');
    return platform === 'win32' ? r.toLowerCase() : r;
  };
  return String(env.PATH || env.Path || '').split(sep).filter(Boolean).some((d) => norm(d) === norm(dir));
};

// Folders to put the shims in, best first. On Windows the WindowsApps folder
// is on PATH for every user by default, which is what lets this work without
// touching PATH at all; the npm folder comes first when it is on PATH because
// that is where people expect global commands to live.
export function shimDirCandidates(env = process.env, platform = process.platform) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(appData, 'npm'), path.join(local, 'Microsoft', 'WindowsApps'), path.join(home, '.local', 'bin')];
  }
  return [path.join(home, '.local', 'bin'), path.join(home, 'bin')];
}

// The first candidate already on PATH; failing that, the first candidate, with
// a note on how to put it there.
export function chooseShimDir(env = process.env, platform = process.platform) {
  const cands = shimDirCandidates(env, platform);
  const hit = cands.find((d) => onPath(d, env, platform));
  return { dir: hit || cands[0], onPath: Boolean(hit) };
}

export function shimFiles(platform, launcher) {
  const fwd = platform === 'win32' ? launcher.replace(/\\/g, '/') : launcher;
  if (platform === 'win32') {
    return [
      { name: 'atlias.cmd', text: ['@echo off', `rem ${MARKER}`, `node "${launcher}" %*`, ''].join('\r\n') },
      // Git Bash runs extensionless scripts, not .cmd files.
      { name: 'atlias', text: ['#!/bin/sh', `# ${MARKER}`, `exec node "${fwd}" "$@"`, ''].join('\n') },
    ];
  }
  return [{ name: 'atlias', text: ['#!/bin/sh', `# ${MARKER}`, `exec node "${fwd}" "$@"`, ''].join('\n'), mode: 0o755 }];
}

export function launcherPath(env = process.env) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(env.ATLIAS_HOME || path.join(home, '.atlias'), 'cli.mjs');
}

export function installShortcut({ env = process.env, platform = process.platform } = {}) {
  const launcher = launcherPath(env);
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, CLI_LAUNCHER_SOURCE);
  const { dir, onPath: visible } = chooseShimDir(env, platform);
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const skipped = [];
  for (const f of shimFiles(platform, launcher)) {
    const target = path.join(dir, f.name);
    // Never replace an atlias command somebody else put there.
    if (fs.existsSync(target) && !fs.readFileSync(target, 'utf8').includes(MARKER)) { skipped.push(target); continue; }
    fs.writeFileSync(target, f.text);
    if (f.mode) { try { fs.chmodSync(target, f.mode); } catch { /* not supported here */ } }
    written.push(target);
  }
  const lines = [`launcher: ${launcher}`, ...written.map((w) => `command: ${w}`)];
  for (const s of skipped) lines.push(`left alone: ${s} is not one of ours`);
  if (!visible) lines.push(platform === 'win32' ? `note: ${dir} is not on PATH; add it under System Properties, Environment Variables, then open a new terminal` : `note: ${dir} is not on PATH; add this line to ~/.bashrc or ~/.zshrc: export PATH="${dir}:$PATH"`);
  else lines.push('open a new terminal and type: atlias');
  return { launcher, dir, onPath: visible, written, skipped, lines };
}

export function uninstallShortcut({ env = process.env, platform = process.platform } = {}) {
  const removed = [];
  for (const dir of shimDirCandidates(env, platform)) {
    for (const name of ['atlias.cmd', 'atlias']) {
      const target = path.join(dir, name);
      try {
        if (fs.readFileSync(target, 'utf8').includes(MARKER)) { fs.unlinkSync(target); removed.push(target); }
      } catch { /* not there */ }
    }
  }
  const launcher = launcherPath(env);
  try { if (fs.readFileSync(launcher, 'utf8').includes(MARKER)) { fs.unlinkSync(launcher); removed.push(launcher); } } catch { /* not there */ }
  return removed;
}

// What typing atlias would actually run: the first match on PATH, ours or
// anybody's (npm install -g puts its own there). Null when nothing answers.
export function whichAtlias(env = process.env, platform = process.platform) {
  const sep = platform === 'win32' ? ';' : ':';
  const names = platform === 'win32'
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => 'atlias' + e.toLowerCase())
    : ['atlias'];
  for (const dir of String(env.PATH || env.Path || '').split(sep).filter(Boolean)) {
    for (const n of names) {
      const f = path.join(dir, n);
      try {
        if (!fs.statSync(f).isFile()) continue;
        if (platform !== 'win32') fs.accessSync(f, fs.constants.X_OK);
        return f;
      } catch { /* not here, or not executable */ }
    }
  }
  return null;
}

export function shortcutStatus({ env = process.env, platform = process.platform } = {}) {
  const found = [];
  for (const dir of shimDirCandidates(env, platform)) {
    for (const name of ['atlias.cmd', 'atlias']) {
      const target = path.join(dir, name);
      try { if (fs.readFileSync(target, 'utf8').includes(MARKER)) found.push({ file: target, onPath: onPath(dir, env, platform) }); } catch { /* not there */ }
    }
  }
  return { launcher: fs.existsSync(launcherPath(env)) ? launcherPath(env) : null, shims: found };
}
