// Runs the real tools/publish-live.mjs inside a temporary folder. Its fixed
// paths, the GitHub CLI and the live collector are swapped in a copy, so no
// check publishes anything or reads Gev's own state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const real = fileURLToPath(new URL('../tools/publish-live.mjs', import.meta.url));
export const GIST = 'a'.repeat(32);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function sandbox(name, { endpoint = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-publish-' + name + '-'));
  const at = (...parts) => path.join(dir, ...parts);
  const unix = file => file.replaceAll('\\', '/');
  for (const folder of ['tools', 'lib', 'site', 'root/checks', 'home', 'evolve']) fs.mkdirSync(at(folder), { recursive: true });
  let text = fs.readFileSync(real, 'utf8');
  // Each swap must find its text: a publisher that changed shape fails here
  // loudly instead of quietly running against the real folders.
  const swap = (from, to) => { if (!text.includes(from)) throw new Error('publish-live.mjs no longer contains: ' + from); text = text.replaceAll(from, to); };
  swap("root = 'D:/harness-work/atlias-opencode-1009'", 'root = ' + JSON.stringify(unix(at('root'))));
  swap("const gh = 'C:/Program Files/GitHub CLI/gh.exe';", 'const gh = process.execPath, ghStub = ' + JSON.stringify(unix(at('gh-stub.mjs'))) + ';');
  swap("spawnSync(gh, ['api', ...args,", "spawnSync(gh, [ghStub, 'api', ...args,");
  swap("originalRoot = 'D:/harness-work/atlias-evolve'", 'originalRoot = ' + JSON.stringify(unix(at('evolve'))));
  swap("openCodeRoot = 'D:/harness-work/atlias-evolve-opencode'", 'openCodeRoot = ' + JSON.stringify(unix(at('evolve-opencode'))));
  swap('os.homedir()', JSON.stringify(unix(at('home'))));
  swap('setInterval(cycle, 90000)', 'setInterval(cycle, 400)');
  if (/[A-Za-z]:\/(harness-work|Program Files)/.test(text)) throw new Error('a real path survived in the sandboxed publisher');
  fs.writeFileSync(at('tools', 'publish-live.mjs'), text);
  const description = text.match(/const description = '([^']+)';/)?.[1];
  if (!description) throw new Error('publish-live.mjs no longer names its artifact description');
  // The collector: a fixed public bundle, or one carrying a private path while leak.flag exists.
  fs.writeFileSync(at('lib', 'live-status.mjs'), `import fs from 'node:fs';
const flag = new URL('../leak.flag', import.meta.url);
export function collectLive() {
  return { schema: 'atlias.live.v1', generatedAt: new Date().toISOString(), status: { schema: 'atlias.public-status.v1', progress: { variant: 'v0001', stage: 's1', completed: 1 }, note: fs.existsSync(flag) ? 'C:/Users/private/file' : 'clean' }, history: { schema: 'atlias.public-history.v1', champion: null } };
}
`);
  // The GitHub CLI: records every call, then answers as gh-mode.txt says.
  fs.writeFileSync(at('gh-stub.mjs'), `import fs from 'node:fs';
const file = name => new URL(name, import.meta.url);
let mode = 'ok';
try { mode = fs.readFileSync(file('gh-mode.txt'), 'utf8').trim(); } catch {}
const args = process.argv.slice(2);
const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
const input = args.includes('--input') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(file('gh-calls.jsonl'), JSON.stringify({ method, target: args[1], mode }) + '\\n');
if (mode === 'down') process.exit(1);
const owner = { login: mode === 'foreign' || (mode === 'foreign-patch' && method !== 'GET') ? 'someone-else' : 'ridelink0' };
const content = method === 'GET' ? '{}' : JSON.parse(input).files['atlias-live.json'].content;
console.log(JSON.stringify({ id: ${JSON.stringify(GIST)}, owner, description: ${JSON.stringify(description)}, files: { 'atlias-live.json': { content: mode === 'mangle' ? content + ' ' : content } } }));
`);
  if (endpoint) fs.writeFileSync(at('site', 'live-config.json'), JSON.stringify({ endpoint: 'https://api.github.com/gists/' + GIST, refreshSeconds: 90 }) + '\n');
  const script = at('tools', 'publish-live.mjs'), children = [];
  const json = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const lockFile = at('root', 'LIVE-PUBLISHER.lock'), logFile = at('root', 'checks', 'live-publisher.log');
  return {
    at, lockFile, logFile, stopFile: at('root', 'LIVE-PUBLISHER.STOP'), configFile: at('site', 'live-config.json'),
    mode: value => fs.writeFileSync(at('gh-mode.txt'), value),
    calls: () => { try { return fs.readFileSync(at('gh-calls.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } },
    log: () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } },
    receipt: () => json(at('root', 'LIVE-PUBLISHER-LAST.json')),
    lock: () => json(lockFile),
    once: () => spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true, timeout: 120000 }),
    watch: () => {
      const child = spawn(process.execPath, [script, '--watch'], { stdio: 'ignore', windowsHide: true });
      child.done = new Promise(resolve => child.on('exit', code => resolve(code)));
      children.push(child);
      return child;
    },
    until: async (test, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await sleep(100); } return test(); },
    exit: (child, ms = 30000) => new Promise(resolve => { const timer = setTimeout(() => resolve('still running'), ms); child.done.then(code => { clearTimeout(timer); resolve(code); }); }),
    clean: async () => {
      for (const child of children) if (child.exitCode === null) { child.kill(); await child.done; }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    },
  };
}
