// Optional local personal prototype. Never bundles the noncommercial DevKit in
// Atlias, its public export, or a Max release. No compiler/checker is invoked.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { STATE_DIR } from '../lib/core.mjs';

export const PIN = '0a36fefeb913055c8c7a1a29b63d82b96b2e841a';
const args = process.argv.slice(2);
if (!args.includes('--personal')) throw Error('This optional SDK is for a separate local personal prototype. Read its noncommercial license before using --personal. Commercial development/distribution requires separate OpenAI permission.');
const sourceFlag = args.indexOf('--source');
const base = path.join(STATE_DIR, 'personal-chatgpt');
const source = sourceFlag >= 0 ? path.resolve(args[sourceFlag + 1] || '') : path.join(base, 'source');
const runtime = path.join(base, 'runtime');
fs.mkdirSync(base, { recursive: true });
function git(a) {
  const r = spawnSync('git', a, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw Error('Could not verify/download the official pinned DevKit.');
  return r.stdout.trim();
}
if (!fs.existsSync(source)) git(['clone', '--no-checkout', 'https://github.com/openai/sign-in-with-chatgpt-devkit.git', source]);
if (git(['-C', source, 'rev-parse', 'HEAD']) !== PIN) {
  if (sourceFlag >= 0 || git(['-C', source, 'status', '--porcelain'])) throw Error('Source does not match the reviewed pin; leave it intact.');
  git(['-C', source, 'checkout', '--detach', PIN]);
}
if (git(['-C', source, 'status', '--porcelain'])) throw Error('Use a clean official source checkout.');
if (fs.existsSync(runtime)) throw Error('Personal runtime already exists; review it before replacing it.');
fs.mkdirSync(runtime);
const lock = JSON.parse(fs.readFileSync(path.join(source, 'package-lock.json'), 'utf8'));
const dependencies = Object.fromEntries(['jose', 'openai', 'proper-lockfile'].map(n => [n, lock.packages['node_modules/' + n].version]));
fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ name: 'atlias-chatgpt-personal-runtime', private: true, type: 'module', version: '0.1.0', license: 'SEE LICENSE IN LICENSE', dependencies }, null, 2));
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
  fs.writeFileSync(path.join(runtime, name.replace(/\.ts$/, '.js')), '// Local personal build from official DevKit ' + PIN + '.\n// Modified by RideLink: trusted request callback for native tools/reasoning/usage.\n' + stripTypeScriptTypes(code, { mode: 'transform' }));
}
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(source, name), path.join(runtime, name));
fs.writeFileSync(path.join(runtime, 'PERSONAL-ONLY.json'), JSON.stringify({ sdk: 'https://github.com/openai/sign-in-with-chatgpt-devkit', commit: PIN, personalOnly: true, extension: 'trusted local request callback; OAuth code unchanged' }, null, 2));
const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: runtime, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
if (r.status !== 0) throw Error('Personal SDK dependencies were not installed.');
console.log('Personal ChatGPT SDK prepared at ' + runtime + '. Not signed in. Not included in public/Max distribution.');
