// Gev's live data is updated separately from Vercel deployments, with existing
// GitHub CLI authentication. Only this reviewed Atlias aggregate is published.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectLive } from '../lib/live-status.mjs';
const source = fileURLToPath(new URL('..', import.meta.url)), root = path.dirname(source);
const gh = 'C:/Program Files/GitHub CLI/gh.exe';
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const description = 'Atlias by Gev: reviewed live benchmark aggregates and recorded typed proposals';
const configFile = path.join(source, 'site/live-config.json'), receiptFile = path.join(root, 'LIVE-PUBLISHER-LAST.json');
const lockFile = path.join(root, 'LIVE-PUBLISHER.lock');
const fd = fs.openSync(lockFile, 'wx');
fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), scope: 'atlias-live' }));
let stopped = false;
const cleanup = () => { if (!stopped) { stopped = true; fs.closeSync(fd); fs.unlinkSync(lockFile); } };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
function api(args, body) {
  const r = spawnSync(gh, ['api', ...args, ...(body ? ['--input', '-'] : [])], { input: body ? JSON.stringify(body) : undefined, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0 || r.error) throw new Error('Atlias live API failed; no retry or second artifact was created. Check CLI authentication/network.');
  return JSON.parse(r.stdout);
}
let config = read(configFile);
let gistId = config?.endpoint?.match(/^https:\/\/api\.github\.com\/gists\/([a-f0-9]{32})$/)?.[1];
if (config?.endpoint && !gistId) throw new Error('Invalid live endpoint; refusing to publish');
if (gistId) {
  const existing = api(['gists/' + gistId]);
  if (existing.owner?.login !== 'ridelink0' || existing.description !== description || !existing.files?.['atlias-live.json']) throw new Error('Refusing to modify an unrelated public artifact');
}
function publish() {
  if (fs.existsSync(path.join(root, 'LIVE-PUBLISHER.STOP'))) { console.log('Atlias live publisher stopped cooperatively'); process.exit(0); }
  const bundle = collectLive({ stateRoot: 'D:/harness-work/atlias-evolve', agentRegistry: read(path.join(root, 'AGENTS-STATUS.json')) || [], allowance: read(path.join(root, 'PUBLIC-ALLOWANCE.json')) || [], messages: read(path.join(root, 'PUBLIC-COMMUNICATIONS.json')) || [] });
  const content = JSON.stringify(bundle);
  if (Buffer.byteLength(content) > 900000 || /[A-Za-z]:[\\/]|gh[pousr]_[a-zA-Z0-9]|sk-[a-zA-Z0-9]{10}|Bearer\s+[a-zA-Z0-9]/.test(content)) throw new Error('Atlias privacy/size gate refused publication');
  const payload = { files: { 'atlias-live.json': { content } } };
  const result = gistId ? api(['gists/' + gistId, '--method', 'PATCH'], payload) : api(['gists', '--method', 'POST'], { ...payload, description, public: true });
  if (!/^[a-f0-9]{32}$/.test(result.id) || result.owner?.login !== 'ridelink0' || result.files?.['atlias-live.json']?.truncated || result.files?.['atlias-live.json']?.content !== content) throw new Error('Atlias live publication could not be reconciled; inspect the receipt before retrying');
  gistId = result.id;
  if (!config?.endpoint) { config = { endpoint: 'https://api.github.com/gists/' + gistId, refreshSeconds: 90 }; fs.writeFileSync(configFile, JSON.stringify(config) + '\n'); }
  for (const kind of ['status', 'history']) fs.writeFileSync(path.join(source, 'site', kind + '.json'), JSON.stringify(bundle[kind]) + '\n');
  fs.writeFileSync(receiptFile, JSON.stringify({ at: new Date().toISOString(), generatedAt: bundle.generatedAt, endpoint: config.endpoint, bytes: Buffer.byteLength(content), variant: bundle.status.progress.variant, stage: bundle.status.progress.stage, completed: bundle.status.progress.completed, verified: true }) + '\n');
  console.log(JSON.stringify({ at: bundle.generatedAt, variant: bundle.status.progress.variant, stage: bundle.status.progress.stage, completed: bundle.status.progress.completed, verified: true }));
}
try { publish(); if (process.argv.includes('--watch')) setInterval(() => { try { publish(); } catch (e) { console.error(e.message); process.exit(1); } }, 90000); } catch (e) { console.error(e.message); process.exitCode = 1; }
