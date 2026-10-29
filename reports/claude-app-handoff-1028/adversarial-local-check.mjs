// Isolated semantic mutations. A failing assertion must name the planted defect.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const app = 'D:/atlias-max-app';
const out = path.resolve(import.meta.dirname, '../ui-goal-1028/app-updater-adversarial');
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-update-mutant-'));
fs.mkdirSync(path.join(tmp, 'src/main'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'test/unit'), { recursive: true });
const source = fs.readFileSync(path.join(app, 'src/main/updates.mjs'), 'utf8');
const file = path.join(tmp, 'src/main/updates.mjs');
fs.copyFileSync(path.join(app, 'test/unit/updates.test.mjs'), path.join(tmp, 'test/unit/updates.test.mjs'));
const run = (name, text) => {
  fs.writeFileSync(file, text);
  const r = spawnSync(process.execPath, ['--test', '--test-name-pattern', 'Windows install helper refuses', path.join(tmp, 'test/unit/updates.test.mjs')], { cwd: app, encoding: 'utf8', windowsHide: true, timeout: 35000 });
  fs.writeFileSync(path.join(out, `${name}.log`), `${r.stdout || ''}${r.stderr || ''}`);
  return { status: r.status, signal: r.signal, error: r.error?.message, output: r.stdout || '' };
};
const positive = run('positive', source);
const anchor = "if (error.code !== 'ESRCH') process.exit(1);";
if (source.split(anchor).length !== 2) throw new Error('expected one fail-closed query branch');
const mutant = run('query-error-mutant', source.replace(anchor, '// MUTATION: every query error is treated as an exited app.'));
const receipt = { positive: { ...positive, output: undefined }, mutant: { ...mutant, output: undefined }, rejectedForIntendedReason: mutant.status === 1 && /refused: query failed/.test(mutant.output), sourceUnchanged: source === fs.readFileSync(path.join(app, 'src/main/updates.mjs'), 'utf8') };
fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(receipt);
if (positive.status !== 0 || !receipt.rejectedForIntendedReason || !receipt.sourceUnchanged) process.exitCode = 1;
