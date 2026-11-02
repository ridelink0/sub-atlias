#!/usr/bin/env node
import fs from 'node:fs';
import { VERSION } from '../lib/core.mjs';
import * as hosts from '../lib/hosts.mjs';
import * as extras from '../lib/hosts-extra.mjs';
import * as provider from '../lib/provider.mjs';
import * as subharness from '../lib/subharness.mjs';
import * as progress from '../lib/progress.mjs';
import * as dream from '../lib/dream.mjs';
import * as graph from '../lib/graph.mjs';
import * as shortcut from '../lib/shortcut.mjs';
import { writeLauncher, ROOT, STATE_DIR } from '../lib/core.mjs';
import { recall } from '../mcp/tools.mjs';

const args = process.argv.slice(2);
const command = args[0] || 'help';
const say = (value) => process.stdout.write(String(value) + '\n');
const help = `atlias ${VERSION} — shared memory, graph, and verification inside your existing coding host.

Commands:
  atlias install [--claude|--codex|--antigravity|--gemini|--extras [ids]|--companions|--shortcut]
  atlias uninstall [--claude|--codex|--antigravity|--gemini|--extras [ids]|--shortcut]
  atlias shortcut [install|uninstall|status]
  atlias status | recall <query> | progress [set <next step>] | dream [ack]
  atlias graph query|affected|explain|update <arg>
  atlias sub --host claude|codex --profile provider.json [--log receipts.jsonl] [--executable cli] -- [native arguments]
  atlias provider check provider.json
  atlias provider usage receipts.jsonl
  atlias doctor
  atlias version`;

const EXTRA_OPTIONS = ['--extras', '--shortcut'];
const extraIds = () => (args.includes('--extras') ? args.slice(args.indexOf('--extras') + 1).filter((a) => !a.startsWith('--')) : []);
function selectedHosts(names) {
  const selected = names.filter((name) => args.includes(`--${name}`));
  const permitted = new Set([...names.map((name) => `--${name}`), ...EXTRA_OPTIONS, ...(command === 'install' ? ['--gemini-hooks', '--companions'] : []), ...extraIds()]);
  const invalid = args.slice(1).filter((arg) => !permitted.has(arg));
  if (invalid.length) throw Error(`Unsupported host option: ${invalid[0]}.`);
  if (!selected.length && !args.slice(1).length) throw Error(`Choose a host: ${names.map((name) => `--${name}`).join(', ')}.`);
  if (args.includes('--gemini-hooks') && !selected.includes('gemini')) throw Error('--gemini-hooks requires --gemini.');
  return selected;
}

try {
  if (['help', '--help', '-h'].includes(command)) say(help);
  else if (command === 'version' || command === '--version' || command === '-v') say(`atlias ${VERSION}`);
  else if (command === 'install') {
    const out = [];
    for (const host of selectedHosts(['claude', 'codex', 'antigravity', 'gemini'])) {
      if (host === 'claude') out.push(...hosts.installClaude());
      if (host === 'codex') out.push(...hosts.installCodex());
      if (host === 'antigravity') out.push(...hosts.installAntigravity());
      if (host === 'gemini') out.push(...hosts.installGemini(args.includes('--gemini-hooks')));
    }
    if (args.includes('--extras')) out.push(...extras.installAll(extraIds()));
    if (args.includes('--companions')) out.push(...hosts.installCompanions());
    if (args.includes('--shortcut')) { writeLauncher(ROOT); out.push(...shortcut.installShortcut().lines); }
    say(out.join('\n'));
  } else if (command === 'uninstall') {
    const out = [];
    for (const host of selectedHosts(['claude', 'codex', 'antigravity', 'gemini'])) {
      if (host === 'claude') out.push('Claude Code plugin: use /plugin uninstall atlias@atlias inside Claude Code.');
      if (host === 'codex') out.push(...hosts.uninstallCodex());
      if (host === 'antigravity') out.push(...hosts.uninstallAntigravity());
      if (host === 'gemini') out.push(...hosts.uninstallGemini());
    }
    if (args.includes('--extras')) out.push(...extras.uninstallAll(extraIds()));
    if (args.includes('--shortcut')) out.push(...shortcut.uninstallShortcut().map((f) => `removed ${f}`));
    say(out.join('\n'));
  } else if (command === 'doctor') {
    say(hosts.formatDoctor(hosts.doctor().concat(extras.doctorRows())));
  } else if (command === 'status') {
    const cwd = process.cwd();
    const g = graph.status(cwd);
    say([`atlias ${VERSION}`, `state: ${STATE_DIR}`, `project: ${cwd}`, `graph: ${g.exists ? `present, updated ${g.age}` : 'none'}`, `dream pending: ${dream.pending(cwd).count}`, `handoff note: ${progress.read(cwd) ? progress.notePath(cwd) : 'none yet'}`].join('\n'));
  } else if (command === 'recall') {
    say(recall(process.cwd(), args.slice(1).join(' ')));
  } else if (command === 'progress') {
    const cwd = process.cwd();
    if (args[1] === 'set') say(progress.applyNext(cwd, args.slice(2).join(' ')) || 'next step recorded; no handoff note yet.');
    else say(progress.read(cwd) || 'no handoff note yet');
  } else if (command === 'dream') {
    const cwd = process.cwd();
    if (args[1] === 'ack') say(`dream: consolidated through cursor ${dream.ack(cwd)}`);
    else { dream.digest(cwd); say(fs.existsSync(dream.digestPath(cwd)) ? fs.readFileSync(dream.digestPath(cwd), 'utf8') : 'no digest yet'); }
  } else if (command === 'graph') {
    const cwd = process.cwd();
    const sub = args[1]; const arg = args.slice(2).join(' ');
    if (sub === 'query') say(graph.query(cwd, arg, 600) || 'no graph, or no answer');
    else if (sub === 'affected' || sub === 'explain') say(graph.sub(cwd, sub, arg) || 'no graph, or no answer');
    else if (sub === 'update') say(graph.updateNow(cwd) ? 'graph updated' : 'graph update failed (see ~/.atlias/log.txt)');
    else throw Error('Use graph query|affected|explain|update <arg>.');
  } else if (command === 'shortcut') {
    const sub = args[1] || 'status';
    if (sub === 'install') { writeLauncher(ROOT); say(shortcut.installShortcut().lines.join('\n')); }
    else if (sub === 'uninstall' || sub === 'remove') { const r = shortcut.uninstallShortcut(); say(r.length ? r.map((f) => `removed ${f}`).join('\n') : 'terminal command: nothing of ours to remove'); }
    else if (sub === 'status') {
      const s = shortcut.shortcutStatus();
      const hit = shortcut.whichAtlias();
      say([`launcher: ${s.launcher || 'not written'}`, ...s.shims.map((x) => `command: ${x.file}${x.onPath ? '' : ' (folder not on PATH)'}`), `typing atlias runs: ${hit || 'nothing yet; run atlias shortcut install'}`].join('\n'));
    } else throw Error('Use shortcut [install|uninstall|status].');
  } else if (command === 'provider') {
    if (args[1] === 'check' && args[2] && args.length === 3) {
      const profile = provider.load(args[2]);
      say(`Valid ${profile.protocol} profile for model ${profile.model}. Pricing ${profile.pricing ? 'configured' : 'unknown'}; no API call made.`);
    } else if (args[1] === 'usage' && args[2] && args.length === 3) {
      const rows = fs.readFileSync(args[2], 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      say(JSON.stringify(provider.summarize(rows), null, 2));
    } else throw Error('Use provider check <file> or provider usage <file>.');
  } else if (command === 'sub') {
    const split = args.indexOf('--');
    const options = split < 0 ? args.slice(1) : args.slice(1, split);
    const allowed = new Set(['--host', '--profile', '--log', '--executable']);
    const opts = {};
    for (let i = 0; i < options.length; i += 2) {
      const key = options[i], value = options[i + 1];
      if (!allowed.has(key) || !value || value.startsWith('--') || key in opts) throw Error('Use sub --help for launcher options; native arguments go after --.');
      opts[key] = value;
    }
    if (!opts['--profile']) throw Error('--profile is required.');
    process.exitCode = await subharness.launch({
      host: opts['--host'], file: opts['--profile'], logFile: opts['--log'],
      executable: opts['--executable'], args: split < 0 ? [] : args.slice(split + 1),
    });
  } else throw Error(`Unknown command: ${command}. Run atlias --help.`);
} catch (error) {
  process.stderr.write(`atlias: ${error.message}\n`);
  process.exitCode = 2;
}
