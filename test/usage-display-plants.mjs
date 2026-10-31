// Planted breaks for the usage display suites. Copies the repository to a temp folder, plants one
// break at a time, runs only the focused suites there (test/run.mjs "usage display"), and reports
// whether each break was caught. Run: node test/usage-display-plants.mjs
// It never touches the working tree it is run from and runs no benchmark and no full suite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', 'node_modules', 'evals', 'docs', 'assets']);
const PLANTS = [
  ['off still draws', 'lib/usage-display.mjs', 'if (!s.enabled) return NOOP;', ''],
  ['pipe gets colour codes', 'lib/usage-display.mjs', "const mode = tty ? (opts.mode || 'none') : 'none';", "const mode = opts.mode || 'truecolor';"],
  ['NO_COLOR still animates', 'lib/usage-display.mjs', "const animated = tty && mode !== 'none' && s.animation !== 'none';", "const animated = tty && s.animation !== 'none';"],
  ['frame rate floods', 'lib/usage-display.mjs', 'export const FRAME_MS = 160;', 'export const FRAME_MS = 10;'],
  ['stop leaves the timer', 'lib/usage-display.mjs', 'if (timer) { timers.clearInterval(timer); timer = null; }', 'if (timer) { timer = null; }'],
  ['stop leaves the scroll region', 'lib/usage-display.mjs', 'let out = `${ESC}[r${ESC}7`;', 'let out = `${ESC}7`;'],
  ['plain mode paints', 'lib/usage-display.mjs', "if (mode === 'none' || !s) return s;", 'if (!s) return s;'],
  ['narrow terminal keeps the sidebar', 'lib/usage-display.mjs', "s.position === 'sidebar' && cols < SIDEBAR_MIN_COLUMNS ? 'top' : s.position", 's.position'],
  ['colour is not checked on set', 'lib/core.mjs', "if (section === 'ui' && key === 'usageColor') {", 'if (false) {'],
  ['display on by default', 'lib/core.mjs', 'ui: { usageEnabled: false,', 'ui: { usageEnabled: true,'],
  ['silent round counted as zero', 'lib/usage-display.mjs', 'if (known(v)) { total += v; rounds++; last = v; }', 'if (true) { total += Number(v) || 0; rounds++; last = Number(v) || 0; }'],
  ['claude engine shown as zero tokens', 'lib/usage-display.mjs', "else if (m.engine === 'claude' || m.engine === 'codex')", 'else if (false)'],
  ['top repeats down a log', 'lib/usage-display.mjs', "if (s.position === 'top' && shown) return;", ''],
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ud-plants-'));
const copy = path.join(tmp, 'repo');
fs.cpSync(ROOT, copy, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
let caught = 0;
const rows = [];
for (const [name, file, from, to] of PLANTS) {
  const target = path.join(copy, file);
  const original = fs.readFileSync(target, 'utf8');
  const at = original.indexOf(from);
  if (at < 0 || original.indexOf(from, at + 1) >= 0) { rows.push(`ERROR ${name}: the text to break is not there exactly once in ${file}`); continue; }
  fs.writeFileSync(target, original.replace(from, () => to));
  const r = spawnSync(process.execPath, [path.join(copy, 'test', 'run.mjs'), 'usage display'], { cwd: copy, encoding: 'utf8', timeout: 300000, env: { ...process.env, ATLIAS_TEST_NO_PID_KILL: '1' } });
  fs.writeFileSync(target, original);
  const hit = r.status !== 0;
  if (hit) caught++;
  rows.push(`${hit ? 'CAUGHT' : 'MISSED'} ${name}`);
}
// The unbroken copy must pass, or "caught" means nothing.
const clean = spawnSync(process.execPath, [path.join(copy, 'test', 'run.mjs'), 'usage display'], { cwd: copy, encoding: 'utf8', timeout: 300000, env: { ...process.env, ATLIAS_TEST_NO_PID_KILL: '1' } });
rows.push(`${clean.status === 0 ? 'CLEAN PASSES' : 'CLEAN FAILS'} (the unbroken copy)`);
process.stdout.write(rows.join('\n') + `\n${caught}/${PLANTS.length} planted breaks caught\n`);
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch { /* left in the temp folder */ }
process.exit(caught === PLANTS.length && clean.status === 0 ? 0 : 1);
