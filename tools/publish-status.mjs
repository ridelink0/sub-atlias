// Gev's public status uses fresh observations and publishes only this Atlias site.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writePublicStatus, writePublicHistory } from '../lib/evolution-status.mjs';
const source = fileURLToPath(new URL('..', import.meta.url));
const root = path.dirname(source), site = path.join(source, 'site');
const cli = 'C:/Users/OWNER/AppData/Local/npm-cache/_npx/69f9afb961c37556/node_modules/vercel/dist/vc.js';
const claude = 'C:/Users/OWNER/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const project = read(path.join(site, '.vercel', 'project.json'));
if (project?.projectName !== 'atlias' || !project?.orgId || !project?.projectId) throw new Error('Gev publisher requires the CLI-linked Atlias project; unrelated sites are forbidden');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const lock = path.join(root, 'PUBLIC-PUBLISHER.lock');
let descriptor;
try { descriptor = fs.openSync(lock, 'wx'); } catch { throw new Error('Gev publisher already owns a lock; inspect its owner before another launch'); }
fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), project: project.projectId }));
const cleanup = () => { try { fs.closeSync(descriptor); fs.unlinkSync(lock); } catch {} };
process.on('exit', cleanup);
const env = { ...process.env, NO_UPDATE_NOTIFIER: '1', VERCEL_TELEMETRY_DISABLED: '1' };
let previous = null;
function publish() {
  if (fs.existsSync(path.join(root, 'PUBLIC-PUBLISHER.STOP'))) { console.log('Gev publisher stopped cooperatively'); process.exit(0); }
  let registry = read(path.join(root, 'AGENTS-STATUS.json')) || [];
  const list = spawnSync(claude, ['agents', '--json'], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  if (list.status === 0 && !list.error) {
    try {
      const resume = read(path.join(root, 'CLAUDE-RESUME.json'));
      const launch = read(path.join(root, 'CLAUDE-LAUNCH.json'));
      const identity = (resume?.stdout || launch?.stdout || '').match(/backgrounded\s+\S+\s+([a-f0-9]{8})/)?.[1];
      const current = JSON.parse(list.stdout).find(agent => agent.id === identity && agent.cwd?.replaceAll('\\', '/').toLowerCase() === path.join(root, 'claude-runtime').replaceAll('\\', '/').toLowerCase());
      registry = registry.filter(agent => agent.id !== 'claude-runtime');
      if (current) registry.push({ id: 'claude-runtime', name: 'Claude', state: current.state === 'working' || current.status === 'busy' ? 'working' : current.status === 'idle' ? 'idle' : current.state === 'blocked' ? 'blocked' : 'unknown', observedAt: new Date().toISOString(), phase: current.state === 'blocked' ? 'Runtime migration needs attention' : 'OpenCode runtime migration', model: 'Opus5.5 xhigh', processVerified: true });
    } catch { registry = registry.filter(agent => agent.id !== 'claude-runtime'); }
  }
  const status = writePublicStatus({ stateRoot: 'D:/harness-work/atlias-evolve', destination: path.join(site, 'status.json'), agentRegistry: registry });
  const history = writePublicHistory({ stateRoot: 'D:/harness-work/atlias-evolve', destination: path.join(site, 'history.json') });
  const assets = ['index.html', 'site.css', 'app.js', 'favicon.svg', 'vercel.json', 'benchmark.json', 'history.js'].map(name => ({ name, hash: crypto.createHash('sha256').update(fs.readFileSync(path.join(site, name))).digest('hex') }));
  const signature = crypto.createHash('sha256').update(JSON.stringify({ assets, agents: status.agents.map(({ observedAt, ...agent }) => agent), results: status.results, champion: status.champion, completedIterations: status.completedIterations, history: { champion: history.champion, iterations: history.iterations, brokenStreak: history.brokenStreak, variants: history.variants.map(({ status: s, ...v }) => v) } })).digest('hex');
  if (signature === previous) return;
  const args = [cli, 'deploy', '--scope', 'ridelink1', '--yes', '--no-wait', ...(production ? ['--prod'] : [])];
  const deploy = spawnSync(process.execPath, args, { cwd: site, windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, env });
  const receipt = { at: new Date().toISOString(), signature, exit: deploy.status, error: deploy.error?.message || null, stdout: deploy.stdout || '', stderr: deploy.stderr || '', project: project.projectId, source: status.generatedAt };
  fs.writeFileSync(path.join(root, 'PUBLIC-PUBLISHER-LAST.json'), JSON.stringify(receipt, null, 2) + '\n');
  if (deploy.status !== 0 || deploy.error) throw new Error('Gev publisher deployment failed; receipt saved and no retry loop started');
  previous = signature;
  console.log(JSON.stringify({ publishedAt: receipt.at, source: status.generatedAt, signature, project: 'atlias', target: production ? 'production' : 'preview' }));
}
try {
  publish();
  if (watch) setInterval(() => { try { publish(); } catch (error) { console.error(error.message); process.exitCode = 1; process.exit(1); } }, 600000);
} catch (error) { console.error(error.message); process.exitCode = 1; }
