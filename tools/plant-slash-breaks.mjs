#!/usr/bin/env node
// Planted breaks for the slash commands (Gev 2026-10-17). Copies this repository to a temp folder, changes
// the one line a behaviour rests on, runs only the focused suites against the copy, and says whether a test
// failed. A break that no test notices is printed as MISSED and the script exits 1. The working tree is
// never touched. Run: node tools/plant-slash-breaks.mjs   (set ATLIAS_TEST_NO_PID_KILL=1 on the benchmark PC)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITES = ['slash', 'deep research'];
const SKIP = new Set(['.git', 'node_modules', 'evals', '.claude']);

// file, find (must occur exactly once), replace. prepend adds a line at the top of the file instead.
const BREAKS = [
  ['help leaves a command out', 'lib/commands.mjs', "const shown = BUILTINS.filter((b) => !b.hidden);", "const shown = BUILTINS.filter((b) => !b.hidden && b.name !== 'cost');"],
  ['an unknown command is passed on to the model', 'lib/commands.mjs', "  ctx.out(`unknown command /${parsed.name}; /help lists the commands`);\n  return { handled: true };", '  return { handled: false };'],
  ['the home wins over the project for a custom name', 'lib/commands.mjs', 'for (const cmd of found) byName.set(cmd.name, cmd);', 'for (const cmd of found) if (!byName.has(cmd.name)) byName.set(cmd.name, cmd);'],
  ['arguments are dropped when the body has no placeholder', 'lib/commands.mjs', 'if (!used && args) text +=', 'if (false) text +='],
  ['/export may write outside the project', 'lib/commands.mjs', "if (!loop.insideProject(cwd, target)) return out('export writes inside the project only');", ''],
  ['/clear does not save the old session', 'lib/commands.mjs', '    api.saveChat(state);\n    api.distil(old, cwd);', '    api.distil(old, cwd);'],
  ['/model sets the ollama model while on the claude engine', 'lib/commands.mjs', "state.engine === 'openai' ? 'openaiModel' : null;", "state.engine === 'openai' ? 'openaiModel' : 'ollamaModel';"],
  ['a path is read as a command', 'lib/commands.mjs', "export const LINE_RE = /^\\/([A-Za-z][\\w:.-]*)", "export const LINE_RE = /^\\/([A-Za-z][\\w:./-]*)"],
  ['the // escape is gone', 'lib/commands.mjs', "if (t.startsWith('//')) return", "if (false) return"],
  ['a huge command file is loaded', 'lib/commands.mjs', 'if (st.size > CUSTOM_MAX_BYTES)', 'if (st.size > CUSTOM_MAX_BYTES * 1000)'],
  ['the repl no longer dispatches slash commands', 'lib/agent.mjs', "    if (t.startsWith('/')) {\n      const r = await commands.dispatch", "    if (false) {\n      const r = await commands.dispatch"],
  ['the exec path starts dispatching', 'lib/agent.mjs', 'async function execOnce(cwd, opts) {', 'async function execOnce(cwd, opts) {\n  commands.parseLine(opts.prompt);'],
  ['the benchmark loop imports the command registry', 'lib/loop.mjs', null, "import './commands.mjs';", true],
  ['a citation outside the project is followed', 'lib/research.mjs', "if (!loop.insideProject(cwd, file)) { bad.push({ ref, why: 'outside the project' }); continue; }", ''],
  ['a line past the end of the file counts as found', 'lib/research.mjs', 'to > lines)', 'to > lines + 100000)'],
  ['a "Not verified" line is never carried into the report', 'lib/research.mjs', "return /^(nothing|none|n\\/a)\\.?$/i.test(said) || !said ? '' : said;", "return '';"],
  ['the report is not written under .atlias/research', 'lib/research.mjs', "export const REPORT_DIR = ['.atlias', 'research'];", "export const REPORT_DIR = ['research'];"],
  ['the claude engine is reported as having no web tool', 'lib/research.mjs', "tools: [], web: null,", "tools: [], web: false,"],
  ['the web caveat is dropped for the ollama engine', 'lib/research.mjs', "withheld: r.web === false ?", "withheld: false ?"],
  ['the plan step is skipped', 'lib/research.mjs', 'const planReply = await api.turn(state, PLAN_PROMPT(topic, r), ask, out);', "const planReply = '';"],
];

const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-plant-'));
const fresh = () => { fs.rmSync(copy, { recursive: true, force: true }); fs.cpSync(ROOT, copy, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) || path.dirname(src) !== ROOT }); };

let missed = 0;
for (const [label, file, find, replace, prepend] of BREAKS) {
  fresh();
  const target = path.join(copy, file);
  let text = fs.readFileSync(target, 'utf8');
  if (prepend) text = replace + '\n' + text;
  else {
    const crlf = text.includes('\r\n');
    const norm = text.replace(/\r\n/g, '\n');
    const at = norm.indexOf(find);
    if (at < 0 || norm.indexOf(find, at + 1) >= 0) { console.log(`BAD PLANT  ${label}: the line to change is ${at < 0 ? 'not found' : 'not unique'} in ${file}`); missed++; continue; }
    text = norm.slice(0, at) + replace + norm.slice(at + find.length);
    if (crlf) text = text.replace(/\n/g, '\r\n');
  }
  fs.writeFileSync(target, text);
  const r = spawnSync(process.execPath, ['test/run.mjs', ...SUITES], { cwd: copy, encoding: 'utf8', timeout: 280000, env: { ...process.env, ATLIAS_TEST_NO_PID_KILL: '1' } });
  const failing = (r.stdout || '').split('\n').filter((l) => l.startsWith('  x ')).map((l) => l.slice(4, 90));
  if (r.status === 1 && failing.length) console.log(`CAUGHT     ${label} -> ${failing.length} failing: ${failing[0]}`);
  else { console.log(`MISSED     ${label} (exit ${r.status})${r.status !== 0 ? '\n' + (r.stdout || '').slice(-300) + (r.stderr || '').slice(0, 300) : ''}`); missed++; }
}
fs.rmSync(copy, { recursive: true, force: true });
console.log(missed ? `\n${missed} of ${BREAKS.length} planted breaks were not caught.` : `\nall ${BREAKS.length} planted breaks were caught.`);
process.exit(missed ? 1 : 0);
