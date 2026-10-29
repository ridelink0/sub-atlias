import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
const [name, cwd, ...args] = process.argv.slice(2);
if (!name || !cwd || !args.length) throw new Error('name, cwd, node arguments required');
const out = path.join(import.meta.dirname, name); fs.mkdirSync(out, { recursive: true });
function hashes() {
  const files = [];
  const walk = dir => { if (!fs.existsSync(dir)) return; for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, item.name); if (item.isDirectory()) walk(f); else if (/\.(mjs|js|json|css|html)$/.test(f)) files.push([path.relative(cwd, f), crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]); } };
  for (const dir of ['lib', 'bin', 'mcp', 'server', 'src', 'test']) walk(path.join(cwd, dir));
  return Object.fromEntries(files.sort());
}
const before = hashes(), started = new Date().toISOString();
const log = fs.openSync(path.join(out, 'output.log'), 'w');
const child = spawn(process.execPath, args, { cwd, env: process.env, windowsHide: true, stdio: ['ignore', log, log] });
const result = await new Promise(resolve => { child.once('error', error => resolve({ error: error.message })); child.once('exit', (exit, signal) => resolve({ exit, signal })); });
fs.closeSync(log);
const after = hashes();
const receipt = { command: [process.execPath, ...args], cwd, started, finished: new Date().toISOString(), ...result, sourceUnchanged: JSON.stringify(before) === JSON.stringify(after), before, after };
fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ ...receipt, before: Object.keys(before).length, after: Object.keys(after).length }));
process.exitCode = result.exit === 0 && receipt.sourceUnchanged ? 0 : 1;
