import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const app = 'D:/atlias-max-app';
const file = path.join(app, 'dist/renderer/app.js');
const before = fs.readFileSync(file);
const text = before.toString('utf8');
const anchor = 'minimumContrastRatio: 4.5';
if (text.split(anchor).length !== 2) throw new Error('expected one terminal contrast option');
const out = path.resolve(import.meta.dirname, '../ui-goal-1028/app-terminal-adversarial');
fs.mkdirSync(out, { recursive: true });
let result;
try {
  fs.writeFileSync(file, text.replace(anchor, 'minimumContrastRatio: 1'));
  result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../ui-goal-1028/run-evidence.mjs'), 'app-terminal-contrast-mutant', app, 'test/e2e/run.mjs', '--out', path.join(app, 'reports/codex-terminal-contrast-mutant-1029')], { cwd: app, windowsHide: true, encoding: 'utf8', timeout: 300000 });
} finally { fs.writeFileSync(file, before); }
const log = fs.readFileSync(path.resolve(out, '../app-terminal-contrast-mutant/output.log'), 'utf8');
const receipt = { exit: result.status, error: result.error?.message, intendedFailure: /FAIL terminal ANSI text meets 4.5 contrast.*Light DarkGreen is 3.011:1/.test(log), restored: before.equals(fs.readFileSync(file)), restoredSha256: crypto.createHash('sha256').update(before).digest('hex') };
fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(receipt);
if (receipt.exit !== 1 || !receipt.intendedFailure || !receipt.restored) process.exitCode = 1;
