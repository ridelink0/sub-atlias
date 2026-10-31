// Optional local personal prototype. Never bundles the noncommercial DevKit in
// Atlias, its public export, or a Max release. No compiler/checker is invoked.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import { STATE_DIR } from '../lib/core.mjs';

export const PIN = '0a36fefeb913055c8c7a1a29b63d82b96b2e841a';
export function preparePersonalRuntime({ personal = false, sourceDir, baseDir = path.join(STATE_DIR, 'personal-chatgpt'), run = spawnSync } = {}) {
if (!personal) throw Error('This optional SDK is for a separate local personal prototype. Read its noncommercial license before using --personal. Commercial development/distribution requires separate OpenAI permission.');
const base = path.resolve(baseDir);
const source = sourceDir ? path.resolve(sourceDir) : path.join(base, 'source');
const runtime = path.join(base, 'runtime');
fs.mkdirSync(base, { recursive: true });
function git(a) {
  const r = run('git', a, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw Error('Could not verify/download the official pinned DevKit.');
  return r.stdout.trim();
}
if (!fs.existsSync(source)) git(['clone', '--no-checkout', 'https://github.com/openai/sign-in-with-chatgpt-devkit.git', source]);
if (git(['-C', source, 'rev-parse', 'HEAD']) !== PIN) {
  if (sourceDir || git(['-C', source, 'status', '--porcelain'])) throw Error('Source does not match the reviewed pin; leave it intact.');
  git(['-C', source, 'checkout', '--detach', PIN]);
}
if (git(['-C', source, 'status', '--porcelain'])) throw Error('Use a clean official source checkout.');
function smoke(dir) {
  return run(process.execPath, ['--input-type=module', '--eval', `const m = await import(${JSON.stringify(pathToFileURL(path.join(dir, 'index.js')).href)}); if (typeof m.createChatGPT !== 'function') process.exitCode = 1;`], { cwd: dir, encoding: 'utf8', windowsHide: true });
}
if (fs.existsSync(runtime)) {
  // Only this installer's pinned personal runtime is eligible for recovery.
  // Unknown files and linked directories are left for the owner to review.
  let marker;
  try { marker = JSON.parse(fs.readFileSync(path.join(runtime, 'PERSONAL-ONLY.json'), 'utf8')); } catch {}
  if (fs.lstatSync(runtime).isSymbolicLink() || marker?.commit !== PIN || marker.personalOnly !== true) throw Error('Unknown personal runtime already exists; leave it intact for review.');
  if (marker.installComplete === true && smoke(runtime).status === 0) return { runtime, alreadyPrepared: true };
}
const stage = fs.mkdtempSync(path.join(base, 'runtime-install-'));
try {
const lock = JSON.parse(fs.readFileSync(path.join(source, 'package-lock.json'), 'utf8'));
const dependencies = Object.fromEntries(['jose', 'openai', 'proper-lockfile'].map(n => [n, lock.packages['node_modules/' + n].version]));
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'atlias-chatgpt-personal-runtime', private: true, type: 'module', version: '0.1.0', license: 'SEE LICENSE IN LICENSE', dependencies }, null, 2));
for (const name of fs.readdirSync(path.join(source, 'packages/local/src')).filter(n => n.endsWith('.ts'))) {
  let code = fs.readFileSync(path.join(source, 'packages/local/src', name), 'utf8');
  if (name === 'index.ts') {
    const anchor = '    async streamResponse(options) {';
    if (!code.includes(anchor)) throw Error('Reviewed SDK extension point changed.');
    // Trusted local-only callback; the SDK still owns every OAuth check, refresh,
    // account lock and cancellation. No credential is returned to UI or logs.
    code = code.replace(anchor, `    async requestAuthorized(request, options = {}) {
      if (typeof request !== "function") throw new ChatGPTError("invalid_request", "A trusted local request callback is required.");
      return authenticated((accessToken, signal) => request(accessToken, signal), options.signal);
    },\n\n` + anchor);
  }
  fs.writeFileSync(path.join(stage, name.replace(/\.ts$/, '.js')), '// Local personal build from official DevKit ' + PIN + '.\n// Modified by RideLink: trusted request callback for native tools/reasoning/usage.\n' + stripTypeScriptTypes(code, { mode: 'transform' }));
}
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(source, name), path.join(stage, name));
const r = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
if (r.status !== 0) throw Error('Personal SDK dependencies were not installed.');
if (smoke(stage).status !== 0) throw Error('Personal SDK import validation failed. Nothing was marked ready.');
fs.writeFileSync(path.join(stage, 'PERSONAL-ONLY.json'), JSON.stringify({ sdk: 'https://github.com/openai/sign-in-with-chatgpt-devkit', commit: PIN, personalOnly: true, installComplete: true, extension: 'trusted local request callback; OAuth code unchanged' }, null, 2));
let backup;
if (fs.existsSync(runtime)) {
  const latest = JSON.parse(fs.readFileSync(path.join(runtime, 'PERSONAL-ONLY.json'), 'utf8'));
  if (fs.lstatSync(runtime).isSymbolicLink() || latest.commit !== PIN || latest.personalOnly !== true) throw Error('Personal runtime changed during setup; leave it intact for review.');
  backup = path.join(base, 'runtime-incomplete-' + path.basename(stage).slice('runtime-install-'.length));
  if (fs.existsSync(backup)) throw Error('Recovery destination exists; leave the previous runtime intact.');
  fs.renameSync(runtime, backup);
}
try { fs.renameSync(stage, runtime); }
catch (error) { if (backup && !fs.existsSync(runtime)) fs.renameSync(backup, runtime); throw error; }
return { runtime, alreadyPrepared: false, backup };
} finally {
  // Only remove the temporary directory created by this invocation.
  if (path.dirname(path.resolve(stage)) !== base || !path.basename(stage).startsWith('runtime-install-')) throw Error('Invalid personal runtime staging path.');
  fs.rmSync(stage, { recursive: true, force: true });
}
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), sourceFlag = args.indexOf('--source');
  if (sourceFlag >= 0 && (!args[sourceFlag + 1] || args[sourceFlag + 1].startsWith('--'))) throw Error('--source requires a checkout directory.');
  const result = preparePersonalRuntime({ personal: args.includes('--personal'), sourceDir: sourceFlag >= 0 ? args[sourceFlag + 1] : undefined });
  console.log('Personal ChatGPT SDK prepared at ' + result.runtime + '. Not signed in. Not included in public/Max distribution.');
}
